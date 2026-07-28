import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireVaultLock,
  CooperativeLockError,
  inspectOwnedVaultLock,
  inspectVaultLock,
  releaseVaultLock,
  type OwnedCooperativeLock,
} from '../cooperative-lock.ts';
import {
  MutationFailure,
  fingerprintMutationSource,
  type AtomicMutationPhase,
  type FilesystemMutationKind,
  type MutationExecutor,
  type MutationPathPolicy,
  type OwnedDirectoryFingerprint,
  type OwnedFileFingerprint,
  type PlannedMutation,
  type SourceFingerprint,
} from '../mutation/contracts.ts';
import { createMutationExecutor } from '../mutation/executor.ts';
import {
  assertSafeRuntimePath,
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
  RuntimePathError,
  runtimeDisplayPath,
  type RuntimeLayout,
} from '../runtime-paths.ts';
import { readVaultSchemaVersion } from './config-document.ts';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UPDATE_ERROR_CATALOG,
  UpdateError,
  sanitizePublicUpdateResult,
  type UpdateErrorCode,
  type UpdatePlan,
  type UpdateResultV1,
} from './contracts.ts';
import {
  planVaultUpdate,
  type ManagedAgent,
} from './planner.ts';

const CONFIG_PATH = '.me/config.yaml';
const DIGEST = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIGRATION_ID = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/;
const VAULT_WRITE_METADATA_POLICY =
  'POSIX mode preserved for replaced README; uid/gid/ACL/xattr/timestamps are not preserved.';
const MUTATION_KINDS = new Set<FilesystemMutationKind>([
  'link',
  'rename',
  'unlink',
  'mkdir',
  'rmdir',
]);

type JournalState =
  | 'locked'
  | 'staging'
  | 'staged'
  | 'mutating'
  | 'validating'
  | 'validated'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'recovery-required';

interface UpdateJournalV1 {
  version: 1;
  operationId: string;
  state: JournalState;
  planDigest: string;
  sourceVaultSchemaVersion: number;
  targetVaultSchemaVersion: number;
  migrationIds: string[];
  mutations: Array<{
    kind: PlannedMutation['kind'];
    path: string;
    destinationPath?: string;
    source: SourceFingerprint;
    destinationSource?: SourceFingerprint;
    desiredSha256?: string;
    desiredMode?: number;
    publishOrder: number;
  }>;
  staged: Array<{
    path: string;
    desiredSha256: string;
    desiredMode: number;
  }>;
  completedMutations: Array<{
    kind: FilesystemMutationKind;
    paths: string[];
  }>;
  pendingMutation?: {
    kind: FilesystemMutationKind;
    paths: string[];
  };
}

export interface UpdateTransactionOptions {
  pluginRoot: string;
  managedAgents?: readonly ManagedAgent[];
  environment?: NodeJS.ProcessEnv;
  hooks?: {
    beforeMutation?(
      kind: FilesystemMutationKind,
      paths: readonly string[],
    ): void;
    afterMutation?(
      kind: FilesystemMutationKind,
      paths: readonly string[],
    ): void;
    afterLock?(): void;
    afterStaging?(): void;
    beforePostValidation?(): void;
    beforeLockRelease?(path: string): void;
  };
  atomicHooks?: {
    beforeAtomicMutation?(
      kind: FilesystemMutationKind,
      phase: AtomicMutationPhase,
      paths: readonly string[],
    ): void;
    afterAtomicMutation?(
      kind: FilesystemMutationKind,
      phase: AtomicMutationPhase,
      paths: readonly string[],
    ): void;
  };
  directoryFsync?(directory: string): void;
  operationIdFactory?: () => string;
  signal?: AbortSignal;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256')
    .update(Uint8Array.from(bytes))
    .digest('hex');
}

function sameFingerprint(
  left: SourceFingerprint,
  right: SourceFingerprint,
): boolean {
  return left.vaultRelativePath === right.vaultRelativePath
    && left.type === right.type
    && left.sha256 === right.sha256
    && left.mode === right.mode;
}

function operationId(options: UpdateTransactionOptions): string {
  let value: string;
  try {
    value = (options.operationIdFactory ?? crypto.randomUUID)();
  } catch {
    throw new UpdateError('INTERNAL_ERROR');
  }
  if (!safeOperationId(value)) {
    throw new UpdateError('INTERNAL_ERROR');
  }
  return value;
}

function safeOperationId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '.'
    && value !== '..'
    && OPERATION_ID.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => (
      typeof key === 'string' && expected.includes(key)
    ));
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return Reflect.ownKeys(value).every(key => (
    key === 'length'
    || (
      typeof key === 'string'
      && Number.isSafeInteger(Number(key))
      && String(Number(key)) === key
      && Number(key) >= 0
      && Number(key) < value.length
    )
  ));
}

function safeMode(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= 0o777;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeVaultRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value
    || value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  return !value.split('/').some(
    component => !component || component === '.' || component === '..',
  );
}

function safeJournalDisplayPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  if (value === '<ME_RUNTIME>') return true;
  if (value.startsWith('<ME_RUNTIME>/')) {
    return safeVaultRelativePath(value.slice('<ME_RUNTIME>/'.length));
  }
  return safeVaultRelativePath(value);
}

function validSourceFingerprint(
  value: unknown,
  expectedPath: string,
): value is SourceFingerprint {
  if (!plainRecord(value) || value.vaultRelativePath !== expectedPath) {
    return false;
  }
  if (value.type === 'missing') {
    return exactKeys(value, ['vaultRelativePath', 'type']);
  }
  if (value.type === 'file') {
    return exactKeys(value, [
      'vaultRelativePath',
      'type',
      'sha256',
      'mode',
    ])
      && DIGEST.test(value.sha256 as string)
      && safeMode(value.mode);
  }
  if (value.type === 'directory') {
    return exactKeys(value, ['vaultRelativePath', 'type', 'mode'])
      && safeMode(value.mode);
  }
  return false;
}

function validCompletedMutation(value: unknown): boolean {
  if (
    !plainRecord(value)
    || !exactKeys(value, ['kind', 'paths'])
    || !MUTATION_KINDS.has(value.kind as FilesystemMutationKind)
    || !denseArray(value.paths)
    || value.paths.length === 0
  ) return false;
  const expectedArity = value.kind === 'link' || value.kind === 'rename'
    ? 2
    : 1;
  return value.paths.length === expectedArity
    && value.paths.every(safeJournalDisplayPath);
}

function emptyResult(
  id: string,
  code: UpdateErrorCode,
): UpdateResultV1 {
  const definition = UPDATE_ERROR_CATALOG[code];
  return {
    version: 1,
    status: definition.status,
    operationId: id,
    currentVaultSchemaVersion: 0,
    targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
    migrations: [],
    plannedPaths: [],
    changedPaths: [],
    diffs: [],
    warnings: [],
    conflicts: [],
    recoveryState: definition.status === 'rolled_back'
      ? 'rolled_back'
      : definition.status === 'recovery_required'
        ? 'manual'
        : 'none',
    recoveryActions: [],
    preservedPaths: [],
    error: { code, message: definition.message },
  };
}

function resultFromPlan(
  id: string,
  plan: UpdatePlan,
  status: UpdateResultV1['status'],
  options: {
    code?: UpdateErrorCode;
    changedPaths?: string[];
    warnings?: string[];
    recoveryState?: UpdateResultV1['recoveryState'];
    recoveryActions?: UpdateResultV1['recoveryActions'];
    preservedPaths?: string[];
  } = {},
): UpdateResultV1 {
  const result: UpdateResultV1 = {
    version: 1,
    status,
    operationId: id,
    currentVaultSchemaVersion: plan.currentVaultSchemaVersion,
    targetVaultSchemaVersion: plan.targetVaultSchemaVersion,
    migrations: plan.migrations.map(item => ({ ...item })),
    planDigest: plan.planDigest,
    plannedPaths: [...plan.plannedPaths],
    changedPaths: [...(options.changedPaths ?? [])],
    diffs: plan.diffs.map(item => ({ ...item })),
    warnings: [...plan.warnings, ...(options.warnings ?? [])],
    conflicts: plan.conflicts.map(item => ({ ...item })),
    recoveryState: options.recoveryState ?? 'none',
    recoveryActions: [...(options.recoveryActions ?? [])],
    preservedPaths: [...(options.preservedPaths ?? [])],
  };
  if (options.code) {
    result.error = {
      code: options.code,
      message: UPDATE_ERROR_CATALOG[options.code].message,
    };
  }
  return result;
}

function inspectVaultPath(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isInside(root, absolute)) throw new MutationFailure('UNSAFE_PATH');
  const relative = path.relative(root, absolute);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new MutationFailure('UNSAFE_PATH');
      if (current !== absolute && !stat.isDirectory()) {
        throw new MutationFailure('UNSAFE_PATH');
      }
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      if (errno(error) === 'ENOENT') return;
      throw new MutationFailure('UNSAFE_PATH');
    }
  }
}

function mutationPathPolicy(layout: RuntimeLayout): MutationPathPolicy {
  return {
    assertSafe(candidate) {
      const absolute = path.resolve(candidate);
      if (isInside(layout.runtimeRoot, absolute)) {
        try {
          assertSafeRuntimePath(layout, absolute);
          return;
        } catch (error) {
          if (
            error instanceof RuntimePathError
            && error.code === 'UNSUPPORTED_FILESYSTEM'
          ) {
            throw new MutationFailure('UNSUPPORTED_FILESYSTEM');
          }
          throw new MutationFailure('UNSAFE_PATH');
        }
      }
      inspectVaultPath(layout.canonicalVault, absolute);
    },
    display(candidate) {
      const absolute = path.resolve(candidate);
      if (isInside(layout.runtimeRoot, absolute)) {
        return runtimeDisplayPath(layout, absolute);
      }
      if (!isInside(layout.canonicalVault, absolute)) {
        throw new MutationFailure('UNSAFE_PATH');
      }
      return path.relative(layout.canonicalVault, absolute)
        .split(path.sep)
        .join('/') || '.';
    },
  };
}

function absoluteVaultPath(layout: RuntimeLayout, relativePath: string): string {
  const candidate = path.resolve(
    layout.canonicalVault,
    ...relativePath.split('/'),
  );
  inspectVaultPath(layout.canonicalVault, candidate);
  return candidate;
}

function currentFingerprint(
  layout: RuntimeLayout,
  relativePath: string,
  policy: MutationPathPolicy,
): SourceFingerprint {
  return fingerprintMutationSource({
    vaultRoot: layout.canonicalVault,
    vaultRelativePath: relativePath,
    pathPolicy: policy,
  });
}

function desiredFingerprint(
  mutation: Extract<PlannedMutation, { kind: 'write-file' }>,
): SourceFingerprint {
  return {
    vaultRelativePath: mutation.vaultRelativePath,
    type: 'file',
    sha256: mutation.desiredSha256,
    mode: mutation.desiredMode,
  };
}

function legacyRuntimeState(layout: RuntimeLayout): boolean {
  for (const relative of ['.me/locks', '.me/tmp']) {
    const directory = path.join(
      layout.canonicalVault,
      ...relative.split('/'),
    );
    inspectVaultPath(layout.canonicalVault, directory);
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UpdateError('UNSAFE_PATH');
      }
      if (fs.readdirSync(directory).length > 0) return true;
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      if (errno(error) !== 'ENOENT') throw new UpdateError('UNSAFE_PATH');
    }
  }
  return false;
}

function validJournalMutation(value: unknown): boolean {
  if (!plainRecord(value) || !safeVaultRelativePath(value.path)) return false;
  if (!safeNonNegativeInteger(value.publishOrder)) return false;
  if (!validSourceFingerprint(value.source, value.path)) return false;
  if (value.kind === 'write-file') {
    return exactKeys(value, [
      'kind',
      'path',
      'source',
      'desiredSha256',
      'desiredMode',
      'publishOrder',
    ])
      && (value.source.type === 'missing' || value.source.type === 'file')
      && typeof value.desiredSha256 === 'string'
      && DIGEST.test(value.desiredSha256)
      && safeMode(value.desiredMode);
  }
  if (value.kind === 'mkdir') {
    return exactKeys(value, [
      'kind',
      'path',
      'source',
      'desiredMode',
      'publishOrder',
    ])
      && value.source.type === 'missing'
      && safeMode(value.desiredMode);
  }
  if (value.kind === 'rename') {
    return exactKeys(value, [
      'kind',
      'path',
      'destinationPath',
      'source',
      'destinationSource',
      'publishOrder',
    ])
      && value.source.type === 'file'
      && safeVaultRelativePath(value.destinationPath)
      && value.destinationPath !== value.path
      && validSourceFingerprint(
        value.destinationSource,
        value.destinationPath,
      )
      && value.destinationSource.type === 'missing';
  }
  return false;
}

function validStagedRecord(value: unknown): boolean {
  return plainRecord(value)
    && exactKeys(value, [
      'path',
      'desiredSha256',
      'desiredMode',
    ])
    && safeVaultRelativePath(value.path)
    && typeof value.desiredSha256 === 'string'
    && DIGEST.test(value.desiredSha256)
    && safeMode(value.desiredMode);
}

function expectedUpdaterOriginals(
  mutations: readonly Record<string, unknown>[],
): Map<string, { sha256: string; mode: number }> {
  const originals = new Map<string, { sha256: string; mode: number }>();
  for (const mutation of mutations) {
    if (
      mutation.kind !== 'write-file'
      || !plainRecord(mutation.source)
      || mutation.source.type !== 'file'
    ) continue;
    originals.set(
      `${String(mutation.publishOrder).padStart(6, '0')}.original`,
      {
        sha256: mutation.source.sha256 as string,
        mode: mutation.source.mode as number,
      },
    );
  }
  return originals;
}

function expectedUpdaterCompletedMutations(
  operationDirectory: string,
  mutations: readonly Record<string, unknown>[],
): Array<{ kind: FilesystemMutationKind; paths: string[] }> {
  const operation = `<ME_RUNTIME>/transactions/${path.basename(operationDirectory)}`;
  const staging = `${operation}/staged`;
  const originals = `${operation}/originals`;
  const completed: Array<{
    kind: FilesystemMutationKind;
    paths: string[];
  }> = [
    { kind: 'mkdir', paths: [staging] },
    { kind: 'mkdir', paths: [originals] },
  ];

  for (const mutation of mutations) {
    const order = String(mutation.publishOrder).padStart(6, '0');
    if (mutation.kind === 'write-file') {
      if (
        plainRecord(mutation.source)
        && mutation.source.type === 'file'
      ) {
        completed.push({
          kind: 'rename',
          paths: [
            mutation.path as string,
            `${originals}/${order}.original`,
          ],
        });
      }
      completed.push({
        kind: 'link',
        paths: [
          `${staging}/${order}.stage`,
          mutation.path as string,
        ],
      });
    } else if (mutation.kind === 'mkdir') {
      completed.push({
        kind: 'mkdir',
        paths: [mutation.path as string],
      });
    } else {
      completed.push({
        kind: 'rename',
        paths: [
          mutation.path as string,
          mutation.destinationPath as string,
        ],
      });
    }
  }

  for (const mutation of mutations) {
    if (mutation.kind !== 'write-file') continue;
    const order = String(mutation.publishOrder).padStart(6, '0');
    completed.push({
      kind: 'unlink',
      paths: [`${staging}/${order}.stage`],
    });
  }
  completed.push({ kind: 'rmdir', paths: [staging] });
  if (expectedUpdaterOriginals(mutations).size === 0) {
    completed.push({ kind: 'rmdir', paths: [originals] });
  }
  return completed;
}

function stableRegularFileMatches(
  candidate: string,
  expected?: { sha256: string; mode: number },
): boolean {
  let descriptor: number | undefined;
  try {
    const namedBefore = fs.lstatSync(candidate, { bigint: true });
    if (
      !namedBefore.isFile()
      || namedBefore.isSymbolicLink()
    ) return false;
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile()
      || openedBefore.dev !== namedBefore.dev
      || openedBefore.ino !== namedBefore.ino
      || openedBefore.mode !== namedBefore.mode
      || openedBefore.size !== namedBefore.size
      || openedBefore.nlink !== namedBefore.nlink
    ) return false;
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(candidate, { bigint: true });
    if (
      !openedAfter.isFile()
      || !namedAfter.isFile()
      || namedAfter.isSymbolicLink()
      || openedAfter.dev !== openedBefore.dev
      || openedAfter.ino !== openedBefore.ino
      || openedAfter.mode !== openedBefore.mode
      || openedAfter.size !== openedBefore.size
      || openedAfter.nlink !== openedBefore.nlink
      || openedAfter.mtimeNs !== openedBefore.mtimeNs
      || openedAfter.ctimeNs !== openedBefore.ctimeNs
      || namedAfter.dev !== openedAfter.dev
      || namedAfter.ino !== openedAfter.ino
      || namedAfter.mode !== openedAfter.mode
      || namedAfter.size !== openedAfter.size
      || namedAfter.nlink !== openedAfter.nlink
    ) return false;
    return !expected || (
      Number(openedAfter.mode & 0o777n) === expected.mode
      && sha256(bytes) === expected.sha256
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        return false;
      }
    }
  }
}

function exactDirectoryEntries(
  directory: string,
  expected: readonly string[],
  mode = 0o700,
): boolean {
  try {
    const stat = fs.lstatSync(directory);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || (stat.mode & 0o777) !== mode
    ) return false;
    const entries = fs.readdirSync(directory).sort();
    return entries.length === expected.length
      && entries.every((entry, index) => entry === [...expected].sort()[index]);
  } catch {
    return false;
  }
}

function validUpdaterCommittedOperation(
  operationDirectory: string,
  value: Record<string, unknown>,
): boolean {
  const requiredKeys = [
    'version',
    'operationId',
    'state',
    'planDigest',
    'sourceVaultSchemaVersion',
    'targetVaultSchemaVersion',
    'migrationIds',
    'mutations',
    'staged',
    'completedMutations',
  ];
  if (
    !exactKeys(value, requiredKeys)
    || value.version !== 1
    || value.state !== 'committed'
    || !safeOperationId(value.operationId)
    || typeof value.planDigest !== 'string'
    || !DIGEST.test(value.planDigest)
    || !safeNonNegativeInteger(value.sourceVaultSchemaVersion)
    || !safeNonNegativeInteger(value.targetVaultSchemaVersion)
    || value.targetVaultSchemaVersion <= value.sourceVaultSchemaVersion
    || !denseArray(value.migrationIds)
    || value.migrationIds.length
      !== value.targetVaultSchemaVersion - value.sourceVaultSchemaVersion
    || !value.migrationIds.every(item => (
      typeof item === 'string' && MIGRATION_ID.test(item)
    ))
    || new Set(value.migrationIds).size !== value.migrationIds.length
    || !denseArray(value.mutations)
    || value.mutations.length === 0
    || !value.mutations.every(validJournalMutation)
    || !denseArray(value.staged)
    || !value.staged.every(validStagedRecord)
    || !denseArray(value.completedMutations)
    || value.completedMutations.length === 0
    || !value.completedMutations.every(validCompletedMutation)
  ) return false;

  const mutations = value.mutations as Record<string, unknown>[];
  const publishOrders = mutations.map(item => item.publishOrder as number);
  if (
    publishOrders.some((item, index) => item !== index)
    || mutations.at(-1)?.kind !== 'write-file'
    || mutations.at(-1)?.path !== CONFIG_PATH
    || (mutations.at(-1)?.source as SourceFingerprint).type !== 'file'
  ) return false;

  const affectedPaths: string[] = [];
  for (const mutation of mutations) {
    const candidates = mutation.kind === 'rename'
      ? [
          mutation.path as string,
          mutation.destinationPath as string,
        ]
      : [mutation.path as string];
    for (const candidate of candidates) {
      if (affectedPaths.some(existing => (
        existing === candidate
        || existing.startsWith(`${candidate}/`)
        || candidate.startsWith(`${existing}/`)
      ))) return false;
      affectedPaths.push(candidate);
    }
  }

  const stagedExpected = mutations
    .filter(item => item.kind === 'write-file')
    .map(item => ({
      path: item.path,
      desiredSha256: item.desiredSha256,
      desiredMode: item.desiredMode,
    }));
  if (JSON.stringify(value.staged) !== JSON.stringify(stagedExpected)) {
    return false;
  }
  const completedExpected = expectedUpdaterCompletedMutations(
    operationDirectory,
    mutations,
  );
  if (
    JSON.stringify(value.completedMutations)
    !== JSON.stringify(completedExpected)
  ) return false;

  const originals = expectedUpdaterOriginals(mutations);
  const expectedEntries = originals.size > 0
    ? ['journal.json', 'originals']
    : ['journal.json'];
  if (!exactDirectoryEntries(operationDirectory, expectedEntries)) return false;
  if (originals.size === 0) return true;

  const originalsDirectory = path.join(operationDirectory, 'originals');
  if (
    !exactDirectoryEntries(
      originalsDirectory,
      [...originals.keys()].sort(),
    )
  ) return false;
  return [...originals].every(([name, expected]) => (
    stableRegularFileMatches(
      path.join(originalsDirectory, name),
      expected,
    )
  ));
}

function validVaultWriteCommittedOperation(
  operationDirectory: string,
  value: Record<string, unknown>,
): boolean {
  const hasIndex = Object.hasOwn(value, 'indexPath')
    || Object.hasOwn(value, 'plannedIndexSha256');
  const expectedKeys = [
    'version',
    'operationId',
    'state',
    'notePath',
    'requestDigest',
    'plannedNoteSha256',
    'metadataPolicy',
    ...(hasIndex ? ['indexPath', 'plannedIndexSha256'] : []),
  ];
  if (
    !exactKeys(value, expectedKeys)
    || value.version !== 1
    || value.state !== 'committed'
    || typeof value.operationId !== 'string'
    || !UUID_V4.test(value.operationId)
    || !safeVaultRelativePath(value.notePath)
    || typeof value.requestDigest !== 'string'
    || !DIGEST.test(value.requestDigest)
    || typeof value.plannedNoteSha256 !== 'string'
    || !DIGEST.test(value.plannedNoteSha256)
    || value.metadataPolicy !== VAULT_WRITE_METADATA_POLICY
    || (
      hasIndex
      && (
        !safeVaultRelativePath(value.indexPath)
        || value.indexPath === value.notePath
        || typeof value.plannedIndexSha256 !== 'string'
        || !DIGEST.test(value.plannedIndexSha256)
      )
    )
  ) return false;

  let entries: string[];
  try {
    entries = fs.readdirSync(operationDirectory).sort();
  } catch {
    return false;
  }
  if (
    entries.length < 1
    || entries.length > 2
    || entries[0] !== 'journal.json'
    || (entries.length === 2 && entries[1] !== 'originals')
  ) return false;
  if (!exactDirectoryEntries(operationDirectory, entries)) return false;
  if (entries.length === 1) return true;
  if (!hasIndex) return false;

  const originalsDirectory = path.join(operationDirectory, 'originals');
  return exactDirectoryEntries(originalsDirectory, ['README.md'])
    && stableRegularFileMatches(
      path.join(originalsDirectory, 'README.md'),
    );
}

function validCommittedJournal(
  operationDirectory: string,
  name: string,
): boolean {
  const journalPath = path.join(operationDirectory, 'journal.json');
  let descriptor: number | undefined;
  try {
    const directory = fs.lstatSync(operationDirectory, { bigint: true });
    const journal = fs.lstatSync(journalPath, { bigint: true });
    if (
      directory.isSymbolicLink()
      || !directory.isDirectory()
      || journal.isSymbolicLink()
      || !journal.isFile()
      || journal.size > 1024n * 1024n
      || Number(journal.mode & 0o777n) !== 0o600
    ) return false;
    descriptor = fs.openSync(
      journalPath,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile()
      || openedBefore.dev !== journal.dev
      || openedBefore.ino !== journal.ino
      || openedBefore.size > 1024n * 1024n
    ) return false;
    const bytes = fs.readFileSync(descriptor);
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(journalPath, { bigint: true });
    if (
      !openedAfter.isFile()
      || !namedAfter.isFile()
      || namedAfter.isSymbolicLink()
      || openedAfter.dev !== openedBefore.dev
      || openedAfter.ino !== openedBefore.ino
      || openedAfter.mode !== openedBefore.mode
      || openedAfter.size !== openedBefore.size
      || openedAfter.nlink !== openedBefore.nlink
      || openedAfter.mtimeNs !== openedBefore.mtimeNs
      || openedAfter.ctimeNs !== openedBefore.ctimeNs
      || namedAfter.dev !== openedAfter.dev
      || namedAfter.ino !== openedAfter.ino
      || namedAfter.mode !== openedAfter.mode
      || namedAfter.size !== openedAfter.size
      || namedAfter.nlink !== openedAfter.nlink
    ) return false;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    const expectedId = name.startsWith('me-update-')
      ? name.slice('me-update-'.length)
      : name.startsWith('vault-write-')
        ? name.slice('vault-write-'.length)
        : undefined;
    if (
      !plainRecord(value)
      || !safeOperationId(expectedId)
      || value.operationId !== expectedId
    ) return false;
    if (name.startsWith('me-update-')) {
      return name === `me-update-${expectedId}`
        && validUpdaterCommittedOperation(operationDirectory, value);
    }
    if (name.startsWith('vault-write-')) {
      return name === `vault-write-${expectedId}`
        && validVaultWriteCommittedOperation(operationDirectory, value);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A failed close cannot make an untrusted startup journal valid.
      }
    }
  }
}

function hasIncompleteRuntimeOperation(layout: RuntimeLayout): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(layout.transactionDir);
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw new UpdateError('UNSAFE_PATH');
  }
  for (const name of names) {
    if (
      !OPERATION_ID.test(name)
      && !name.startsWith('me-update-')
      && !name.startsWith('vault-write-')
    ) return true;
    const directory = path.join(layout.transactionDir, name);
    try {
      assertSafeRuntimePath(layout, directory);
    } catch {
      throw new UpdateError('UNSAFE_PATH');
    }
    if (!validCommittedJournal(directory, name)) return true;
  }
  return false;
}

/**
 * Read-only startup inspection shared by preview and apply. It intentionally
 * does not bootstrap runtime directories, acquire a lock, or create staging.
 */
export function inspectVaultUpdateRecovery(
  vaultDir: string,
  environment?: NodeJS.ProcessEnv,
  ownedLock?: OwnedCooperativeLock,
): {
  code: Extract<
    UpdateErrorCode,
    'LEGACY_RUNTIME_STATE' | 'RECOVERY_REQUIRED' | 'UPDATE_IN_PROGRESS'
  >;
  actions: UpdateResultV1['recoveryActions'];
  preservedPaths: string[];
} | undefined {
  const layout = resolveRuntimeLayout(vaultDir, environment);
  if (legacyRuntimeState(layout)) {
    return {
      code: 'LEGACY_RUNTIME_STATE',
      actions: [{
        kind: 'inspect',
        path: '.me',
        description: 'Inspect legacy vault-local locks and temporary state before updating.',
      }],
      preservedPaths: ['.me/locks', '.me/tmp'],
    };
  }
  if (
    ownedLock
    && inspectOwnedVaultLock(layout, ownedLock) !== 'owned'
  ) {
    return {
      code: 'RECOVERY_REQUIRED',
      actions: [{
        kind: 'inspect',
        path: '<ME_RUNTIME>/locks/vault.lock',
        description: 'Inspect the unrecognized lock entry before retrying.',
      }],
      preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
    };
  }
  const lockState = ownedLock ? 'absent' : inspectVaultLock(layout);
  if (lockState === 'active') {
    return {
      code: 'UPDATE_IN_PROGRESS',
      actions: [],
      preservedPaths: [],
    };
  }
  if (lockState === 'recovery-required') {
    return {
      code: 'RECOVERY_REQUIRED',
      actions: [{
        kind: 'inspect',
        path: '<ME_RUNTIME>/locks/vault.lock',
        description: 'Inspect the unrecognized lock entry before retrying.',
      }],
      preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
    };
  }
  if (!hasIncompleteRuntimeOperation(layout)) return undefined;
  return {
    code: 'RECOVERY_REQUIRED',
    actions: [{
      kind: 'inspect',
      path: '<ME_RUNTIME>/transactions',
      description: 'Inspect the preserved update journal and owned artifacts before retrying.',
    }],
    preservedPaths: ['<ME_RUNTIME>/transactions'],
  };
}

function journalMutation(
  mutation: PlannedMutation,
): UpdateJournalV1['mutations'][number] {
  if (mutation.kind === 'write-file') {
    return {
      kind: mutation.kind,
      path: mutation.vaultRelativePath,
      source: mutation.source,
      desiredSha256: mutation.desiredSha256,
      desiredMode: mutation.desiredMode,
      publishOrder: mutation.publishOrder,
    };
  }
  if (mutation.kind === 'mkdir') {
    return {
      kind: mutation.kind,
      path: mutation.vaultRelativePath,
      source: mutation.source,
      desiredMode: mutation.desiredMode,
      publishOrder: mutation.publishOrder,
    };
  }
  return {
    kind: mutation.kind,
    path: mutation.vaultRelativePath,
    destinationPath: mutation.destinationVaultRelativePath,
    source: mutation.source,
    destinationSource: mutation.destinationSource,
    publishOrder: mutation.publishOrder,
  };
}

class UpdateTransaction {
  readonly policy: MutationPathPolicy;
  readonly executor: MutationExecutor;
  readonly warnings: string[] = [];
  readonly createdDirectories: OwnedDirectoryFingerprint[] = [];
  readonly staged = new Map<number, OwnedFileFingerprint>();
  readonly originals = new Map<number, OwnedFileFingerprint>();
  readonly published = new Map<number, OwnedFileFingerprint>();
  readonly createdVaultDirectories = new Map<number, OwnedDirectoryFingerprint>();
  journal?: UpdateJournalV1;
  journalPath?: string;
  journalDescriptor?: number;
  journalOwned?: OwnedFileFingerprint;
  journalConflict = false;
  vaultMutationOccurred = false;
  private warnedDirectoryFsync = false;

  constructor(
    readonly layout: RuntimeLayout,
    readonly id: string,
    readonly options: UpdateTransactionOptions,
  ) {
    this.policy = mutationPathPolicy(layout);
    this.executor = createMutationExecutor({
      pathPolicy: this.policy,
      journal: {
        beforeMutation: (kind, paths) => this.beforeMutation(kind, paths),
        afterMutation: (kind, paths) => this.afterMutation(kind, paths),
      },
      hooks: {
        beforeFilesystemMutation: (kind, paths) => {
          this.checkAbort();
          this.options.hooks?.beforeMutation?.(kind, paths);
        },
        onWarning: () => {
          this.warnDirectoryFsyncUnsupported();
        },
      },
      atomicHooks: options.atomicHooks,
      retirementDirectory: layout.retirementDir,
      directoryFsync: options.directoryFsync,
    });
  }

  checkAbort(): void {
    if (this.options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');
  }

  display(candidate: string): string {
    return this.policy.display(candidate);
  }

  private warnDirectoryFsyncUnsupported(): void {
    if (this.warnedDirectoryFsync) return;
    this.warnedDirectoryFsync = true;
    this.warnings.push(
      'Directory fsync is not supported on this filesystem.',
    );
  }

  private syncDirectoryEntry(candidate: string): void {
    let descriptor: number | undefined;
    try {
      this.policy.assertSafe(candidate);
      const namedBefore = fs.lstatSync(candidate, { bigint: true });
      if (!namedBefore.isDirectory() || namedBefore.isSymbolicLink()) {
        throw new MutationFailure('UNSAFE_PATH');
      }
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_RDONLY
          | fs.constants.O_DIRECTORY
          | fs.constants.O_NOFOLLOW,
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (
        !opened.isDirectory()
        || opened.dev !== namedBefore.dev
        || opened.ino !== namedBefore.ino
        || opened.mode !== namedBefore.mode
      ) throw new MutationFailure('UNSAFE_PATH');
      try {
        if (this.options.directoryFsync) {
          this.options.directoryFsync(candidate);
        } else {
          fs.fsyncSync(descriptor);
        }
      } catch (error) {
        if (['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(errno(error) ?? '')) {
          this.warnDirectoryFsyncUnsupported();
        } else {
          throw new MutationFailure('UNSAFE_PATH');
        }
      }
      const namedAfter = fs.lstatSync(candidate, { bigint: true });
      if (
        !namedAfter.isDirectory()
        || namedAfter.isSymbolicLink()
        || namedAfter.dev !== opened.dev
        || namedAfter.ino !== opened.ino
        || namedAfter.mode !== opened.mode
      ) throw new MutationFailure('UNSAFE_PATH');
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      throw new MutationFailure('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          throw new MutationFailure('UNSAFE_PATH');
        }
      }
    }
  }

  private beforeMutation(
    kind: FilesystemMutationKind,
    paths: readonly string[],
  ): void {
    if (!this.journal) return;
    this.journal.pendingMutation = {
      kind,
      paths: paths.map(candidate => this.display(candidate)),
    };
    this.writeJournal();
  }

  private afterMutation(
    kind: FilesystemMutationKind,
    paths: readonly string[],
  ): void {
    if (paths.some(candidate => (
      isInside(this.layout.canonicalVault, path.resolve(candidate))
    ))) {
      this.vaultMutationOccurred = true;
    }
    if (this.journal) {
      this.journal.completedMutations.push({
        kind,
        paths: paths.map(candidate => this.display(candidate)),
      });
      delete this.journal.pendingMutation;
      this.writeJournal();
    }
    this.options.hooks?.afterMutation?.(kind, paths);
  }

  mkdir(candidate: string, mode = 0o700): OwnedDirectoryFingerprint {
    const owned = this.executor.mkdir(candidate, mode);
    this.createdDirectories.push(owned);
    return owned;
  }

  captureFile(candidate: string): OwnedFileFingerprint {
    return this.executor.captureFile(candidate);
  }

  captureDirectory(candidate: string): OwnedDirectoryFingerprint {
    return this.executor.captureDirectory(candidate);
  }

  sameFile(expected: OwnedFileFingerprint): boolean {
    try {
      const current = this.captureFile(expected.path);
      return current.device === expected.device
        && current.inode === expected.inode
        && current.mode === expected.mode
        && current.linkCount === expected.linkCount
        && current.sha256 === expected.sha256;
    } catch {
      return false;
    }
  }

  isMissing(candidate: string): boolean {
    try {
      fs.lstatSync(candidate);
      return false;
    } catch (error) {
      return errno(error) === 'ENOENT';
    }
  }

  writeTransient(
    candidate: string,
    bytes: Buffer,
    mode: number,
  ): OwnedFileFingerprint {
    let descriptor: number | undefined;
    try {
      this.policy.assertSafe(candidate);
      descriptor = fs.openSync(
        candidate,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
      fs.writeFileSync(descriptor, Uint8Array.from(bytes));
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      throw new MutationFailure('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    const owned = this.captureFile(candidate);
    if (owned.sha256 !== sha256(bytes) || owned.mode !== mode) {
      throw new MutationFailure('OWNERSHIP_LOST');
    }
    return owned;
  }

  startJournal(candidate: string, journal: UpdateJournalV1): void {
    this.journal = journal;
    this.journalPath = candidate;
    try {
      this.journalDescriptor = fs.openSync(
        candidate,
        fs.constants.O_RDWR
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new MutationFailure('OWNERSHIP_LOST');
    }
    this.writeJournal();
    this.syncDirectoryEntry(path.dirname(candidate));
  }

  verifyJournalOwnership(): boolean {
    if (
      !this.journalPath
      || this.journalDescriptor === undefined
      || !this.journalOwned
    ) return false;
    try {
      const entry = fs.lstatSync(this.journalPath, { bigint: true });
      const opened = fs.fstatSync(this.journalDescriptor, { bigint: true });
      return entry.isFile()
        && !entry.isSymbolicLink()
        && entry.dev === opened.dev
        && entry.ino === opened.ino
        && this.sameFile(this.journalOwned)
        && (
          JSON.parse(fs.readFileSync(this.journalPath, 'utf8')) as {
            operationId?: unknown;
          }
        ).operationId === this.id;
    } catch {
      return false;
    }
  }

  writeJournal(): void {
    if (
      !this.journal
      || !this.journalPath
      || this.journalDescriptor === undefined
    ) return;
    if (this.journalOwned && !this.verifyJournalOwnership()) {
      this.journalConflict = true;
      throw new MutationFailure('OWNERSHIP_LOST');
    }
    const bytes = Buffer.from(`${JSON.stringify(this.journal, null, 2)}\n`);
    try {
      fs.ftruncateSync(this.journalDescriptor, 0);
      fs.writeSync(
        this.journalDescriptor,
        Uint8Array.from(bytes),
        0,
        bytes.length,
        0,
      );
      fs.fsyncSync(this.journalDescriptor);
      fs.fchmodSync(this.journalDescriptor, 0o600);
      this.journalOwned = this.captureFile(this.journalPath);
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      this.journalConflict = true;
      throw new MutationFailure('OWNERSHIP_LOST');
    }
  }

  state(state: JournalState): void {
    if (!this.journal) return;
    this.journal.state = state;
    this.writeJournal();
  }

  closeJournal(): void {
    if (this.journalDescriptor !== undefined) {
      try {
        fs.closeSync(this.journalDescriptor);
      } catch {
        this.journalConflict = true;
      }
      this.journalDescriptor = undefined;
    }
  }
}

function updateErrorCode(error: unknown): UpdateErrorCode {
  if (error instanceof UpdateError) return error.code;
  if (error instanceof RuntimePathError) return error.code;
  if (error instanceof CooperativeLockError) {
    if (error.code === 'LOCK_HELD') return 'UPDATE_IN_PROGRESS';
    if (error.code === 'UNSAFE_PATH') return 'UNSAFE_PATH';
    return 'RECOVERY_REQUIRED';
  }
  if (error instanceof MutationFailure) {
    if (error.code === 'SOURCE_CHANGED' || error.code === 'TARGET_EXISTS') {
      return 'STALE_PREVIEW';
    }
    if (error.code === 'UNSAFE_PATH') return 'UNSAFE_PATH';
    if (error.code === 'UNSUPPORTED_FILESYSTEM') {
      return 'UNSUPPORTED_FILESYSTEM';
    }
    return 'RECOVERY_REQUIRED';
  }
  return 'INTERNAL_ERROR';
}

function assertPlanPublicationOrder(plan: UpdatePlan): PlannedMutation[] {
  const mutations = [...plan.mutations].sort(
    (left, right) => left.publishOrder - right.publishOrder,
  );
  if (
    mutations.length > 0
    && mutations.at(-1)?.vaultRelativePath !== CONFIG_PATH
  ) {
    throw new UpdateError('VALIDATION_FAILED');
  }
  return mutations;
}

function verifyMutationSource(
  tx: UpdateTransaction,
  mutation: PlannedMutation,
): void {
  const source = currentFingerprint(
    tx.layout,
    mutation.vaultRelativePath,
    tx.policy,
  );
  if (!sameFingerprint(source, mutation.source)) {
    throw new MutationFailure('SOURCE_CHANGED');
  }
  if (mutation.kind === 'rename') {
    const destination = currentFingerprint(
      tx.layout,
      mutation.destinationVaultRelativePath,
      tx.policy,
    );
    if (!sameFingerprint(destination, mutation.destinationSource)) {
      throw new MutationFailure('TARGET_EXISTS');
    }
  }
}

function stageMutations(
  tx: UpdateTransaction,
  plan: UpdatePlan,
  stagingDirectory: string,
): void {
  tx.state('staging');
  for (const mutation of plan.mutations) {
    if (mutation.kind !== 'write-file') continue;
    tx.checkAbort();
    const stagedPath = path.join(
      stagingDirectory,
      `${String(mutation.publishOrder).padStart(6, '0')}.stage`,
    );
    const staged = tx.writeTransient(
      stagedPath,
      mutation.desiredBytes,
      mutation.desiredMode,
    );
    tx.staged.set(mutation.publishOrder, staged);
    tx.journal!.staged.push({
      path: mutation.vaultRelativePath,
      desiredSha256: mutation.desiredSha256,
      desiredMode: mutation.desiredMode,
    });
    tx.writeJournal();
  }
  tx.state('staged');
}

function applyMutation(
  tx: UpdateTransaction,
  mutation: PlannedMutation,
  originalsDirectory: string,
): void {
  tx.checkAbort();
  verifyMutationSource(tx, mutation);
  if (mutation.kind === 'write-file') {
    const destination = absoluteVaultPath(
      tx.layout,
      mutation.vaultRelativePath,
    );
    if (mutation.source.type === 'file') {
      const original = tx.executor.captureFile(destination);
      const originalPath = path.join(
        originalsDirectory,
        `${String(mutation.publishOrder).padStart(6, '0')}.original`,
      );
      const preserved = tx.executor.rename(original, originalPath);
      tx.originals.set(mutation.publishOrder, preserved);
    } else if (mutation.source.type !== 'missing') {
      throw new MutationFailure('SOURCE_CHANGED');
    }
    const staged = tx.staged.get(mutation.publishOrder);
    if (!staged || !tx.sameFile(staged)) {
      throw new MutationFailure('SOURCE_CHANGED');
    }
    const published = tx.executor.link(staged, destination);
    tx.published.set(mutation.publishOrder, published);
    return;
  }

  if (mutation.kind === 'mkdir') {
    if (mutation.source.type !== 'missing') {
      throw new MutationFailure('SOURCE_CHANGED');
    }
    tx.createdVaultDirectories.set(
      mutation.publishOrder,
      tx.executor.mkdir(
        absoluteVaultPath(tx.layout, mutation.vaultRelativePath),
        mutation.desiredMode,
      ),
    );
    return;
  }

  if (
    mutation.source.type !== 'file'
    || mutation.destinationSource.type !== 'missing'
  ) {
    throw new MutationFailure('SOURCE_CHANGED');
  }
  const source = tx.executor.captureFile(absoluteVaultPath(
    tx.layout,
    mutation.vaultRelativePath,
  ));
  const destination = absoluteVaultPath(
    tx.layout,
    mutation.destinationVaultRelativePath,
  );
  tx.published.set(
    mutation.publishOrder,
    tx.executor.rename(source, destination),
  );
}

function recordAppliedMutationOutcome(
  tx: UpdateTransaction,
  mutation: PlannedMutation,
  error: unknown,
): boolean {
  if (!(error instanceof MutationFailure) || !error.applied) return false;
  const outcome = error.applied;
  if (outcome.kind === 'mkdir') {
    tx.createdVaultDirectories.set(
      mutation.publishOrder,
      outcome.ownedDirectory,
    );
    if (isInside(tx.layout.canonicalVault, outcome.ownedDirectory.path)) {
      tx.vaultMutationOccurred = true;
    }
    return true;
  }

  const owned = outcome.ownedFile;
  if (mutation.kind === 'write-file') {
    if (isInside(tx.layout.canonicalVault, owned.path)) {
      tx.published.set(mutation.publishOrder, owned);
      tx.vaultMutationOccurred = true;
      return true;
    }
    tx.originals.set(mutation.publishOrder, owned);
    // A completed preserve-rename removed the original vault path even though
    // the returned owned inode now lives below <ME_RUNTIME>.
    tx.vaultMutationOccurred = true;
    return true;
  }
  tx.published.set(mutation.publishOrder, owned);
  tx.vaultMutationOccurred = true;
  return true;
}

function validatePostconditions(
  tx: UpdateTransaction,
  plan: UpdatePlan,
): void {
  tx.state('validating');
  tx.options.hooks?.beforePostValidation?.();
  for (const mutation of plan.mutations) {
    if (mutation.kind === 'write-file') {
      const actual = currentFingerprint(
        tx.layout,
        mutation.vaultRelativePath,
        tx.policy,
      );
      if (!sameFingerprint(actual, desiredFingerprint(mutation))) {
        throw new UpdateError('VALIDATION_FAILED');
      }
    } else if (mutation.kind === 'mkdir') {
      const actual = currentFingerprint(
        tx.layout,
        mutation.vaultRelativePath,
        tx.policy,
      );
      if (
        actual.type !== 'directory'
        || actual.mode !== mutation.desiredMode
      ) throw new UpdateError('VALIDATION_FAILED');
    } else {
      const source = currentFingerprint(
        tx.layout,
        mutation.vaultRelativePath,
        tx.policy,
      );
      const destination = currentFingerprint(
        tx.layout,
        mutation.destinationVaultRelativePath,
        tx.policy,
      );
      if (
        source.type !== 'missing'
        || destination.type !== 'file'
        || destination.sha256 !== mutation.source.sha256
        || destination.mode !== mutation.source.mode
      ) throw new UpdateError('VALIDATION_FAILED');
    }
  }
  const config = fs.readFileSync(
    absoluteVaultPath(tx.layout, CONFIG_PATH),
    'utf8',
  );
  if (
    readVaultSchemaVersion(config)
    !== plan.targetVaultSchemaVersion
  ) throw new UpdateError('VALIDATION_FAILED');
  tx.state('validated');
}

function cleanupFile(
  tx: UpdateTransaction,
  owned: OwnedFileFingerprint,
): boolean {
  if (!tx.sameFile(owned)) return false;
  try {
    tx.executor.unlink(owned);
    return true;
  } catch {
    return false;
  }
}

function cleanupDirectory(
  tx: UpdateTransaction,
  candidate: string,
): boolean {
  try {
    if (fs.readdirSync(candidate).length !== 0) return false;
    const owned = tx.createdDirectories.find(item => item.path === candidate);
    if (!owned) return false;
    tx.executor.rmdir(owned);
    return true;
  } catch {
    return false;
  }
}

function cleanupFileIfPresent(
  tx: UpdateTransaction,
  owned: OwnedFileFingerprint,
): boolean {
  if (tx.isMissing(owned.path)) return true;
  return cleanupFile(tx, owned);
}

function cleanupDirectoryIfPresent(
  tx: UpdateTransaction,
  candidate: string,
): boolean {
  if (tx.isMissing(candidate)) return true;
  return cleanupDirectory(tx, candidate);
}

function cleanupRolledBackOperation(
  tx: UpdateTransaction,
  operationDirectory: string,
  stagingDirectory: string,
  originalsDirectory: string,
): boolean {
  for (const staged of tx.staged.values()) {
    if (!cleanupFileIfPresent(tx, staged)) return false;
  }
  for (const original of tx.originals.values()) {
    if (!cleanupFileIfPresent(tx, original)) return false;
  }
  if (!cleanupDirectoryIfPresent(tx, stagingDirectory)) return false;
  if (!cleanupDirectoryIfPresent(tx, originalsDirectory)) return false;

  if (
    !tx.journalOwned
    || !tx.verifyJournalOwnership()
  ) return false;
  const journal = tx.journalOwned;
  tx.closeJournal();
  if (!cleanupFileIfPresent(tx, journal)) return false;
  return cleanupDirectoryIfPresent(tx, operationDirectory);
}

function rollback(
  tx: UpdateTransaction,
  mutations: readonly PlannedMutation[],
): boolean {
  try {
    tx.state('rolling-back');
  } catch {
    return false;
  }
  for (const mutation of [...mutations].reverse()) {
    try {
      if (mutation.kind === 'write-file') {
        const target = absoluteVaultPath(
          tx.layout,
          mutation.vaultRelativePath,
        );
        const published = tx.published.get(mutation.publishOrder);
        if (published) {
          if (!tx.sameFile(published)) return false;
          tx.executor.unlink(published);
        } else {
          const actual = currentFingerprint(
            tx.layout,
            mutation.vaultRelativePath,
            tx.policy,
          );
          if (
            sameFingerprint(actual, desiredFingerprint(mutation))
            && !sameFingerprint(actual, mutation.source)
          ) {
            return false;
          }
        }

        if (mutation.source.type === 'file') {
          const current = currentFingerprint(
            tx.layout,
            mutation.vaultRelativePath,
            tx.policy,
          );
          if (sameFingerprint(current, mutation.source)) continue;
          if (current.type !== 'missing') return false;
          const original = tx.originals.get(mutation.publishOrder);
          if (!original || !tx.sameFile(original)) return false;
          tx.executor.link(original, target);
        }
      } else if (mutation.kind === 'mkdir') {
        const created = tx.createdVaultDirectories.get(
          mutation.publishOrder,
        );
        if (!created) {
          const current = currentFingerprint(
            tx.layout,
            mutation.vaultRelativePath,
            tx.policy,
          );
          if (!sameFingerprint(current, mutation.source)) return false;
          continue;
        }
        const candidate = absoluteVaultPath(
          tx.layout,
          mutation.vaultRelativePath,
        );
        if (fs.readdirSync(candidate).length !== 0) return false;
        tx.executor.rmdir(created);
      } else {
        const destination = absoluteVaultPath(
          tx.layout,
          mutation.destinationVaultRelativePath,
        );
        const published = tx.published.get(mutation.publishOrder);
        if (!published || !tx.sameFile(published)) return false;
        const sourceState = currentFingerprint(
          tx.layout,
          mutation.vaultRelativePath,
          tx.policy,
        );
        if (sourceState.type !== 'missing') return false;
        tx.executor.rename(
          published,
          absoluteVaultPath(tx.layout, mutation.vaultRelativePath),
        );
        const destinationState = currentFingerprint(
          tx.layout,
          mutation.destinationVaultRelativePath,
          tx.policy,
        );
        if (destinationState.type !== 'missing') return false;
      }
    } catch {
      return false;
    }
  }

  for (const mutation of mutations) {
    try {
      const source = currentFingerprint(
        tx.layout,
        mutation.vaultRelativePath,
        tx.policy,
      );
      if (!sameFingerprint(source, mutation.source)) return false;
      if (mutation.kind === 'rename') {
        const destination = currentFingerprint(
          tx.layout,
          mutation.destinationVaultRelativePath,
          tx.policy,
        );
        if (!sameFingerprint(destination, mutation.destinationSource)) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  try {
    tx.state('rolled-back');
    return true;
  } catch {
    return false;
  }
}

function cleanupStaged(
  tx: UpdateTransaction,
  stagingDirectory: string,
): boolean {
  for (const staged of tx.staged.values()) {
    if (!cleanupFile(tx, staged)) return false;
  }
  return cleanupDirectory(tx, stagingDirectory);
}

function changedPathsForRecovery(
  tx: UpdateTransaction,
  plan: UpdatePlan,
): string[] {
  const changed: string[] = [];
  for (const mutation of plan.mutations) {
    try {
      const current = currentFingerprint(
        tx.layout,
        mutation.vaultRelativePath,
        tx.policy,
      );
      if (!sameFingerprint(current, mutation.source)) {
        changed.push(mutation.vaultRelativePath);
      }
      if (mutation.kind === 'rename') {
        const destination = currentFingerprint(
          tx.layout,
          mutation.destinationVaultRelativePath,
          tx.policy,
        );
        if (!sameFingerprint(destination, mutation.destinationSource)) {
          changed.push(mutation.destinationVaultRelativePath);
        }
      }
    } catch {
      changed.push(mutation.vaultRelativePath);
    }
  }
  return [...new Set(changed)];
}

/**
 * Apply only the deterministic plan represented by `expectedPlanDigest`.
 *
 * The preview remains read-only. Apply creates private runtime state only
 * after acquiring the shared writer lock and matching a fresh locked replan.
 */
export function executeVaultUpdate(
  vaultDir: string,
  expectedPlanDigest: string,
  options: UpdateTransactionOptions,
): UpdateResultV1 {
  let id = 'unavailable';
  try {
    id = operationId(options);
  } catch (error) {
    return sanitizePublicUpdateResult(
      emptyResult(id, updateErrorCode(error)),
    );
  }
  if (!DIGEST.test(expectedPlanDigest)) {
    return sanitizePublicUpdateResult(emptyResult(id, 'INVALID_REQUEST'));
  }

  let layout: RuntimeLayout;
  try {
    layout = resolveRuntimeLayout(vaultDir, options.environment);
    if (legacyRuntimeState(layout)) {
      const result = emptyResult(id, 'LEGACY_RUNTIME_STATE');
      result.recoveryActions = [{
        kind: 'inspect',
        path: '.me',
        description: 'Inspect legacy vault-local locks and temporary state before updating.',
      }];
      result.preservedPaths = ['.me/locks', '.me/tmp'];
      return sanitizePublicUpdateResult(
        result,
      );
    }
    bootstrapRuntimeDirectories(layout, [
      layout.lockDir,
      layout.transactionDir,
      layout.retirementDir,
    ]);
  } catch (error) {
    return sanitizePublicUpdateResult(
      emptyResult(id, updateErrorCode(error)),
    );
  }

  let lock: OwnedCooperativeLock | undefined;
  let plan: UpdatePlan | undefined;
  let tx: UpdateTransaction | undefined;
  let operationDirectory: string | undefined;
  let stagingDirectory: string | undefined;
  let originalsDirectory: string | undefined;
  let ownershipAmbiguous = false;
  let lockOwnershipAmbiguous = false;
  let completed = false;
  let primaryError: unknown;
  let finalResult: UpdateResultV1 | undefined;

  try {
    const startupLock = inspectVaultLock(layout);
    if (startupLock === 'active') throw new UpdateError('UPDATE_IN_PROGRESS');
    if (startupLock === 'recovery-required') {
      throw new UpdateError('RECOVERY_REQUIRED');
    }
    lock = acquireVaultLock(layout, { operationId: id, owner: 'me-update' });
    if (hasIncompleteRuntimeOperation(layout)) {
      throw new UpdateError('RECOVERY_REQUIRED');
    }
    options.hooks?.afterLock?.();
    if (options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');

    plan = planVaultUpdate({
      vaultDir: layout.canonicalVault,
      pluginRoot: options.pluginRoot,
      managedAgents: options.managedAgents,
    });
    if (plan.status === 'up_to_date') {
      completed = true;
      finalResult = resultFromPlan(id, plan, 'up_to_date');
    } else if (plan.status === 'blocked') {
      completed = true;
      finalResult = resultFromPlan(id, plan, 'blocked', {
        code: 'MIGRATION_CONFLICT',
      });
    } else if (plan.planDigest !== expectedPlanDigest) {
      completed = true;
      finalResult = resultFromPlan(id, plan, 'blocked', {
        code: 'STALE_PREVIEW',
      });
    } else {
      const mutations = assertPlanPublicationOrder(plan);
      tx = new UpdateTransaction(layout, id, options);
      operationDirectory = path.join(
        layout.transactionDir,
        `me-update-${id}`,
      );
      stagingDirectory = path.join(operationDirectory, 'staged');
      originalsDirectory = path.join(operationDirectory, 'originals');
      tx.mkdir(operationDirectory);
      tx.startJournal(path.join(operationDirectory, 'journal.json'), {
        version: 1,
        operationId: id,
        state: 'locked',
        planDigest: plan.planDigest,
        sourceVaultSchemaVersion: plan.currentVaultSchemaVersion,
        targetVaultSchemaVersion: plan.targetVaultSchemaVersion,
        migrationIds: plan.migrations.map(item => item.id),
        mutations: mutations.map(journalMutation),
        staged: [],
        completedMutations: [],
      });
      tx.mkdir(stagingDirectory);
      tx.mkdir(originalsDirectory);
      stageMutations(tx, plan, stagingDirectory);
      options.hooks?.afterStaging?.();

      /*
       * Revalidate every closed input after staging. No migration transform is
       * called again: the desired bytes are the locked plan's staged bytes.
       */
      for (const mutation of mutations) verifyMutationSource(tx, mutation);

      tx.state('mutating');
      for (const mutation of mutations) {
        try {
          applyMutation(tx, mutation, originalsDirectory);
        } catch (error) {
          if (
            error instanceof MutationFailure
            && error.code === 'OWNERSHIP_LOST'
            && !recordAppliedMutationOutcome(tx, mutation, error)
          ) ownershipAmbiguous = true;
          throw error;
        }
      }

      validatePostconditions(tx, plan);
      if (!cleanupStaged(tx, stagingDirectory)) {
        throw new UpdateError('VALIDATION_FAILED');
      }
      if (tx.originals.size === 0) {
        if (!cleanupDirectory(tx, originalsDirectory)) {
          throw new UpdateError('VALIDATION_FAILED');
        }
      }
      tx.state('committed');
      completed = true;
      finalResult = resultFromPlan(id, plan, 'committed', {
        changedPaths: mutations.flatMap(mutation => (
          mutation.kind === 'rename'
            ? [
                mutation.vaultRelativePath,
                mutation.destinationVaultRelativePath,
              ]
            : [mutation.vaultRelativePath]
        )),
        warnings: tx.warnings,
      });
    }
  } catch (error) {
    primaryError = error;
    if (
      error instanceof MutationFailure
      && error.code === 'OWNERSHIP_LOST'
      && !error.applied
    ) ownershipAmbiguous = true;
  } finally {
    if (!completed && tx && plan) {
      const rolledBack = ownershipAmbiguous
        ? false
        : tx.vaultMutationOccurred
          ? rollback(tx, plan.mutations)
          : true;
      if (!rolledBack) ownershipAmbiguous = true;

      if (ownershipAmbiguous && tx.journal) {
        try {
          tx.state('recovery-required');
        } catch {
          tx.journalConflict = true;
        }
      } else if (
        operationDirectory
        && stagingDirectory
        && originalsDirectory
        && tx.journal
      ) {
        try {
          if (tx.journal.state !== 'rolled-back') tx.state('rolled-back');
          if (!cleanupRolledBackOperation(
            tx,
            operationDirectory,
            stagingDirectory,
            originalsDirectory,
          )) {
            ownershipAmbiguous = true;
          }
        } catch {
          ownershipAmbiguous = true;
        }
      }
    }
    if (lock) {
      try {
        options.hooks?.beforeLockRelease?.(lock.path);
      } catch {
        ownershipAmbiguous = true;
      }
      if (
        tx?.journal
        && tx.journalDescriptor !== undefined
        && !tx.verifyJournalOwnership()
      ) {
        ownershipAmbiguous = true;
      }
    }
    tx?.closeJournal();
    if (lock) {
      try {
        releaseVaultLock(layout, lock);
      } catch {
        lockOwnershipAmbiguous = true;
      }
    }
  }

  if (finalResult && !ownershipAmbiguous && !lockOwnershipAmbiguous) {
    return sanitizePublicUpdateResult(finalResult);
  }

  if (!plan) {
    const code = updateErrorCode(primaryError);
    const result = emptyResult(id, code);
    if (code === 'RECOVERY_REQUIRED') {
      const lockState = inspectVaultLock(layout);
      const lockRecovery = lockOwnershipAmbiguous
        || lockState === 'recovery-required';
      const recoveryPath = lockRecovery
        ? '<ME_RUNTIME>/locks/vault.lock'
        : '<ME_RUNTIME>/transactions';
      result.warnings.push(recoveryPath);
      result.recoveryActions = [{
        kind: 'inspect',
        path: recoveryPath,
        description: lockRecovery
          ? 'Inspect the unrecognized lock entry before retrying.'
          : 'Inspect the preserved update journal and owned artifacts before retrying.',
      }];
      result.preservedPaths = [recoveryPath];
    }
    return sanitizePublicUpdateResult(
      result,
    );
  }

  const recoveryPath = operationDirectory
    ? runtimeDisplayPath(layout, operationDirectory)
    : '<ME_RUNTIME>/transactions';
  if (lockOwnershipAmbiguous && !ownershipAmbiguous) {
    return sanitizePublicUpdateResult(
      resultFromPlan(id, plan, 'recovery_required', {
        code: 'RECOVERY_REQUIRED',
        changedPaths: finalResult?.changedPaths ?? [],
        warnings: [
          ...(tx?.warnings ?? []),
          '<ME_RUNTIME>/locks/vault.lock',
        ],
        recoveryState: 'manual',
        recoveryActions: [{
          kind: 'inspect',
          path: '<ME_RUNTIME>/locks/vault.lock',
          description: 'Inspect the unrecognized lock entry before retrying.',
        }],
        preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
      }),
    );
  }
  if (ownershipAmbiguous) {
    const preservedOriginals = tx
      ? [...tx.originals.entries()].map(([publishOrder, item]) => ({
          path: runtimeDisplayPath(layout, item.path),
          target: plan.mutations.find(mutation => (
            mutation.publishOrder === publishOrder
          ))?.vaultRelativePath,
        }))
      : [];
    const preservedPaths = [
      recoveryPath,
      ...preservedOriginals.map(item => item.path),
    ];
    return sanitizePublicUpdateResult(
      resultFromPlan(id, plan, 'recovery_required', {
        code: 'RECOVERY_REQUIRED',
        changedPaths: tx ? changedPathsForRecovery(tx, plan) : [],
        warnings: [
          ...(tx?.warnings ?? []),
          recoveryPath,
        ],
        recoveryState: 'manual',
        recoveryActions: [
          {
            kind: 'inspect',
            path: recoveryPath,
            description: 'Inspect the preserved journal and owned artifacts before retrying.',
          },
          ...preservedOriginals.map(item => ({
            kind: 'restore' as const,
            path: item.path,
            description: item.target
              ? `Verify this owned original before restoring ${item.target}.`
              : 'Verify this owned original before restoring its vault target.',
          })),
        ],
        preservedPaths,
      }),
    );
  }

  if (tx?.vaultMutationOccurred) {
    const originalCode = updateErrorCode(primaryError);
    return sanitizePublicUpdateResult(
      resultFromPlan(id, plan, 'rolled_back', {
        code: originalCode === 'RECOVERY_REQUIRED'
          || originalCode === 'INTERNAL_ERROR'
          ? 'VALIDATION_FAILED'
          : originalCode,
        warnings: tx?.warnings,
        recoveryState: 'rolled_back',
      }),
    );
  }

  const code = updateErrorCode(primaryError);
  return sanitizePublicUpdateResult(
    resultFromPlan(id, plan, UPDATE_ERROR_CATALOG[code].status, {
      code,
      warnings: tx?.warnings,
      recoveryState: UPDATE_ERROR_CATALOG[code].status === 'recovery_required'
        ? 'manual'
        : UPDATE_ERROR_CATALOG[code].status === 'rolled_back'
          ? 'rolled_back'
          : 'none',
    }),
  );
}
