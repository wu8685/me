import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { createTwoFilesPatch } from 'diff';
import {
  MutationFailure,
  fingerprintMutationSource,
  validatePlannedMutations,
  type MutationPathPolicy,
  type PlannedMutation,
  type SourceFingerprint,
} from '../mutation/contracts.ts';
import {
  readVaultSchemaVersion,
  renderConfigBytes,
  type ConfigEdit,
} from './config-document.ts';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UpdateError,
  type UpdatePlan,
} from './contracts.ts';
import {
  renderManagedAssetBytes,
  type ManagedAssetCurrent,
  type ManagedAssetIntent,
} from './managed-assets.ts';
import {
  MIGRATION_REGISTRY,
  validateMigrationRegistry,
  type ContentTransformIntent,
  type MigrationIntent,
  type MigrationMutation,
  type VaultMigration,
} from './registry.ts';

const CONFIG_PATH = '.me/config.yaml';

interface VirtualFile {
  path: string;
  source: SourceFingerprint;
  sourceBytes?: Buffer;
  exists: boolean;
  bytes?: Buffer;
  mode: number;
  lastStage: number;
}

interface PluginResource {
  path: string;
  bytes: Buffer;
  sha256: string;
}

interface StagedPathMutation {
  declaration: MigrationMutation;
  source: SourceFingerprint;
  destinationSource?: SourceFingerprint;
  lastStage: number;
  ordinal: number;
  outcome: 'changed' | 'unchanged' | 'conflict';
}

type DigestMaterial = Record<string, unknown>;

function fail(
  code:
    | 'MIGRATION_CONFLICT'
    | 'NOT_A_ME_VAULT'
    | 'UNSAFE_PATH'
    | 'UNSUPPORTED_FILESYSTEM',
): never {
  throw new UpdateError(code);
}

function invalidRegistry(): never {
  throw new UpdateError('INVALID_MIGRATION_REGISTRY');
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256')
    .update(typeof bytes === 'string' ? bytes : Uint8Array.from(bytes))
    .digest('hex');
}

function bytesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length
    && left.every((byte, index) => right[index] === byte);
}

function safeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value
    || value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some(
    component => !component || component === '.' || component === '..',
  );
}

function safeMode(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= 0o777;
}

function overlaps(left: string, right: string): boolean {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function canonicalDirectory(candidate: string): string {
  const lexical = path.resolve(candidate);
  try {
    const stat = fs.lstatSync(lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
    return fs.realpathSync.native(lexical);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function inspectPathComponents(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isWithin(root, absolute)) fail('UNSAFE_PATH');
  const relative = path.relative(root, absolute);
  if (!relative) return;
  let current = root;
  const components = relative.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      fail('UNSAFE_PATH');
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail('UNSAFE_PATH');
    }
  }
}

function pathPolicy(root: string): MutationPathPolicy {
  return {
    assertSafe(candidate) {
      inspectPathComponents(root, candidate);
    },
    display(candidate) {
      const absolute = path.resolve(candidate);
      if (!isWithin(root, absolute)) return '<unsafe>';
      return path.relative(root, absolute).split(path.sep).join('/') || '.';
    },
  };
}

function translateMutationFailure(error: MutationFailure): never {
  if (error.code === 'UNSUPPORTED_FILESYSTEM') {
    fail('UNSUPPORTED_FILESYSTEM');
  }
  if (
    error.code === 'TARGET_EXISTS'
    || error.code === 'SOURCE_CHANGED'
    || error.code === 'OWNERSHIP_LOST'
  ) {
    fail('MIGRATION_CONFLICT');
  }
  fail('UNSAFE_PATH');
}

function fingerprint(
  root: string,
  vaultRelativePath: string,
): SourceFingerprint {
  if (!safeRelativePath(vaultRelativePath)) fail('UNSAFE_PATH');
  try {
    return fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath,
      pathPolicy: pathPolicy(root),
    });
  } catch (error) {
    if (error instanceof MutationFailure) {
      return translateMutationFailure(error);
    }
    throw error;
  }
}

function readRegularFile(
  root: string,
  relativePath: string,
  expected?: SourceFingerprint,
): { bytes: Buffer; fingerprint: SourceFingerprint } {
  const source = expected ?? fingerprint(root, relativePath);
  if (source.type !== 'file') fail('UNSAFE_PATH');
  const absolute = path.resolve(root, ...relativePath.split('/'));
  inspectPathComponents(root, absolute);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail('UNSAFE_PATH');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolute, { bigint: true });
    if (
      !after.isFile()
      || !named.isFile()
      || named.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.size !== before.size
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || named.dev !== after.dev
      || named.ino !== after.ino
      || named.mode !== after.mode
      || named.size !== after.size
      || named.nlink !== after.nlink
      || Number(after.mode & 0o777n) !== source.mode
      || sha256(bytes) !== source.sha256
    ) {
      fail('UNSAFE_PATH');
    }
    return { bytes, fingerprint: source };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Closing cannot make an untrusted read safe.
      }
    }
  }
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(bytes));
  } catch {
    return fail('MIGRATION_CONFLICT');
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => (
      typeof key === 'string' && expected.includes(key)
    ));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1
    && keys.every(key => (
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

function validConfigPath(value: unknown): value is readonly string[] {
  return denseArray(value)
    && value.length > 0
    && value.every(component => (
      typeof component === 'string'
      && component.length > 0
      && !component.includes('\u0000')
    ));
}

function validSetValue(value: unknown): boolean {
  return typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || (
      denseArray(value)
      && value.every(item => typeof item === 'string')
    );
}

function validateConfigEdit(value: unknown): asserts value is ConfigEdit {
  if (!plainRecord(value)) invalidRegistry();
  const record = value;
  if (record.kind === 'set') {
    if (
      !hasExactKeys(record, ['kind', 'path', 'value'])
      || !validConfigPath(record.path)
      || !validSetValue(record.value)
    ) {
      invalidRegistry();
    }
    if (
      record.path.length === 1
      && record.path[0] === 'vault_schema_version'
      && (
        typeof record.value !== 'number'
        || !Number.isSafeInteger(record.value)
        || record.value < 0
      )
    ) {
      invalidRegistry();
    }
    return;
  }
  if (record.kind === 'remove') {
    if (
      !hasExactKeys(record, ['kind', 'path'])
      || !validConfigPath(record.path)
    ) {
      invalidRegistry();
    }
    return;
  }
  if (record.kind === 'rename') {
    if (
      !hasExactKeys(record, ['kind', 'from', 'to'])
      || !validConfigPath(record.from)
      || !validConfigPath(record.to)
    ) {
      invalidRegistry();
    }
    return;
  }
  invalidRegistry();
}

function validateManagedAsset(
  value: unknown,
): asserts value is ManagedAssetIntent {
  if (!plainRecord(value)) invalidRegistry();
  const record = value as unknown as ManagedAssetIntent;
  const expected = [
    'vaultRelativePath',
    'desiredTemplatePath',
    'strategy',
    'onAbsent',
    'onUnmarked',
    ...(Object.hasOwn(record, 'knownTemplatePaths')
      ? ['knownTemplatePaths']
      : []),
  ];
  if (
    !hasExactKeys(record, expected)
    || !safeRelativePath(record.vaultRelativePath)
    || !safeRelativePath(record.desiredTemplatePath)
    || ![
      'create-if-absent',
      'replace-known-template',
      'merge-owned-sections',
    ].includes(record.strategy)
    || !['create', 'skip'].includes(record.onAbsent)
    || ![
      'adopt-known-legacy',
      'append-marked-block',
      'conflict',
    ].includes(record.onUnmarked)
    || (
      record.knownTemplatePaths !== undefined
      && (
        !denseArray(record.knownTemplatePaths)
        || record.knownTemplatePaths.some(item => !safeRelativePath(item))
      )
    )
  ) {
    invalidRegistry();
  }
}

function validateContentTransform(
  value: unknown,
): asserts value is ContentTransformIntent {
  if (
    !plainRecord(value)
    || !hasExactKeys(value, ['vaultRelativePaths', 'transform'])
  ) {
    invalidRegistry();
  }
  const record = value as unknown as ContentTransformIntent;
  if (
    !denseArray(record.vaultRelativePaths)
    || record.vaultRelativePaths.some(item => !safeRelativePath(item))
    || typeof record.transform !== 'function'
  ) {
    invalidRegistry();
  }
}

function validatePathMutation(
  value: unknown,
): asserts value is MigrationMutation {
  if (!plainRecord(value)) invalidRegistry();
  if (value.kind === 'mkdir') {
    if (
      !hasExactKeys(value, ['kind', 'vaultRelativePath', 'desiredMode'])
      || !safeRelativePath(value.vaultRelativePath)
      || !safeMode(value.desiredMode)
    ) {
      invalidRegistry();
    }
    return;
  }
  if (value.kind === 'rename') {
    if (
      !hasExactKeys(value, [
        'kind',
        'vaultRelativePath',
        'destinationVaultRelativePath',
      ])
      || !safeRelativePath(value.vaultRelativePath)
      || !safeRelativePath(value.destinationVaultRelativePath)
      || value.vaultRelativePath === value.destinationVaultRelativePath
    ) {
      invalidRegistry();
    }
    return;
  }
  invalidRegistry();
}

function validateIntent(value: unknown): asserts value is MigrationIntent {
  if (
    !plainRecord(value)
    || !hasExactKeys(value, [
      'configEdits',
      'managedAssets',
      'contentTransforms',
      'mutations',
    ])
  ) {
    invalidRegistry();
  }
  const intent = value as unknown as MigrationIntent;
  if (
    !denseArray(intent.configEdits)
    || !denseArray(intent.managedAssets)
    || !denseArray(intent.contentTransforms)
    || !denseArray(intent.mutations)
  ) {
    invalidRegistry();
  }
  intent.configEdits.forEach(validateConfigEdit);
  intent.managedAssets.forEach(validateManagedAsset);
  intent.contentTransforms.forEach(validateContentTransform);
  intent.mutations.forEach(validatePathMutation);
}

function resolveMigrations(options: {
  registry: readonly VaultMigration[];
  currentVersion: number;
  vaultDir: string;
  pluginRoot: string;
}): Array<{
  migration: VaultMigration;
  description: string;
  intent: MigrationIntent;
}> {
  return options.registry.slice(options.currentVersion).map(migration => {
    let description: unknown;
    let intent: unknown;
    try {
      description = migration.describe();
      intent = migration.plan(Object.freeze({
        vaultDir: options.vaultDir,
        pluginRoot: options.pluginRoot,
        currentVaultSchemaVersion: migration.fromVersion,
      }));
    } catch {
      return invalidRegistry();
    }
    if (
      typeof description !== 'string'
      || /[\u0000-\u001f\u007f]/.test(description)
    ) {
      invalidRegistry();
    }
    validateIntent(intent);
    return { migration, description, intent };
  });
}

function loadVirtualFile(
  files: Map<string, VirtualFile>,
  vaultDir: string,
  relativePath: string,
  allowMissing: boolean,
): VirtualFile {
  const existing = files.get(relativePath);
  if (existing) {
    if (!existing.exists && !allowMissing) fail('UNSAFE_PATH');
    return existing;
  }
  const source = fingerprint(vaultDir, relativePath);
  if (source.type === 'directory') fail('UNSAFE_PATH');
  if (source.type === 'missing') {
    if (!allowMissing) fail('UNSAFE_PATH');
    const file: VirtualFile = {
      path: relativePath,
      source,
      exists: false,
      mode: 0o644,
      lastStage: -1,
    };
    files.set(relativePath, file);
    return file;
  }
  const sourceBytes = readRegularFile(
    vaultDir,
    relativePath,
    source,
  ).bytes;
  const file: VirtualFile = {
    path: relativePath,
    source,
    sourceBytes,
    exists: true,
    bytes: Buffer.from(Uint8Array.from(sourceBytes)),
    mode: source.mode ?? 0o644,
    lastStage: -1,
  };
  files.set(relativePath, file);
  return file;
}

function virtualFingerprint(file: VirtualFile): SourceFingerprint {
  if (!file.exists || !file.bytes) {
    return { vaultRelativePath: file.path, type: 'missing' };
  }
  return {
    vaultRelativePath: file.path,
    type: 'file',
    sha256: sha256(file.bytes),
    mode: file.mode,
  };
}

function managedCurrent(file: VirtualFile): ManagedAssetCurrent {
  if (!file.exists || !file.bytes) return { type: 'missing' };
  return {
    type: 'file',
    bytes: Buffer.from(Uint8Array.from(file.bytes)),
    mode: file.mode,
  };
}

function readPluginResource(
  pluginRoot: string,
  resources: Map<string, PluginResource>,
  relativePath: string,
): Buffer {
  const cached = resources.get(relativePath);
  if (cached) return Buffer.from(Uint8Array.from(cached.bytes));
  const bytes = readRegularFile(pluginRoot, relativePath).bytes;
  resources.set(relativePath, {
    path: relativePath,
    bytes: Buffer.from(Uint8Array.from(bytes)),
    sha256: sha256(bytes),
  });
  return Buffer.from(Uint8Array.from(bytes));
}

function assertStableInputs(
  vaultDir: string,
  pluginRoot: string,
  files: ReadonlyMap<string, VirtualFile>,
  resources: ReadonlyMap<string, PluginResource>,
  pathMutations: readonly StagedPathMutation[],
): void {
  for (const file of files.values()) {
    if (
      canonicalStringify(fingerprint(vaultDir, file.path))
      !== canonicalStringify(file.source)
    ) {
      fail('UNSAFE_PATH');
    }
  }
  for (const resource of resources.values()) {
    const reread = readRegularFile(pluginRoot, resource.path).bytes;
    if (sha256(reread) !== resource.sha256) fail('UNSAFE_PATH');
  }
  for (const item of pathMutations) {
    if (
      canonicalStringify(fingerprint(
        vaultDir,
        item.declaration.vaultRelativePath,
      )) !== canonicalStringify(item.source)
    ) {
      fail('UNSAFE_PATH');
    }
    if (
      item.declaration.kind === 'rename'
      && canonicalStringify(fingerprint(
        vaultDir,
        item.declaration.destinationVaultRelativePath,
      )) !== canonicalStringify(item.destinationSource)
    ) {
      fail('UNSAFE_PATH');
    }
  }
}

function renderMigrationStages(options: {
  vaultDir: string;
  pluginRoot: string;
  files: Map<string, VirtualFile>;
  resources: Map<string, PluginResource>;
  resolved: ReturnType<typeof resolveMigrations>;
  conflicts: Map<string, string>;
  blockedPaths: Set<string>;
  materials: DigestMaterial[];
  pathMutations: StagedPathMutation[];
}): void {
  const structuralPaths = new Set<string>();
  const fileIntentPaths = new Set<string>();
  const claimFileIntentPath = (relativePath: string): void => {
    if ([...structuralPaths].some(candidate => overlaps(
      candidate,
      relativePath,
    ))) {
      invalidRegistry();
    }
    fileIntentPaths.add(relativePath);
  };
  const claimStructuralPath = (relativePath: string): void => {
    if (
      overlaps(relativePath, CONFIG_PATH)
      || [...structuralPaths].some(candidate => overlaps(
        candidate,
        relativePath,
      ))
      || [...fileIntentPaths].some(candidate => overlaps(
        candidate,
        relativePath,
      ))
    ) {
      invalidRegistry();
    }
    structuralPaths.add(relativePath);
  };

  for (let stage = 0; stage < options.resolved.length; stage += 1) {
    const { migration, intent } = options.resolved[stage];
    const stageTargets = new Set<string>();

    if (intent.configEdits.length > 0) {
      stageTargets.add(CONFIG_PATH);
      const config = loadVirtualFile(
        options.files,
        options.vaultDir,
        CONFIG_PATH,
        false,
      );
      if (!config.bytes) fail('UNSAFE_PATH');
      const source = virtualFingerprint(config);
      let rendered;
      try {
        rendered = renderConfigBytes(config.bytes, intent.configEdits);
      } catch (error) {
        if (
          error instanceof UpdateError
          && (
            error.code === 'INVALID_REQUEST'
            || error.code === 'INVALID_VAULT_SCHEMA_VERSION'
          )
        ) {
          return invalidRegistry();
        }
        throw error;
      }
      if (
        rendered.currentVersion !== migration.fromVersion
        || readVaultSchemaVersion(utf8(rendered.desiredBytes))
          !== migration.toVersion
      ) {
        invalidRegistry();
      }
      options.materials.push({
        kind: 'config',
        stage,
        path: CONFIG_PATH,
        source,
        desiredSha256: rendered.desiredSha256,
        desiredMode: config.mode,
      });
      config.exists = true;
      config.bytes = Buffer.from(Uint8Array.from(rendered.desiredBytes));
      config.lastStage = stage;
    } else {
      invalidRegistry();
    }

    for (
      let ordinal = 0;
      ordinal < intent.managedAssets.length;
      ordinal += 1
    ) {
      const managed = intent.managedAssets[ordinal];
      if (stageTargets.has(managed.vaultRelativePath)) invalidRegistry();
      stageTargets.add(managed.vaultRelativePath);
      claimFileIntentPath(managed.vaultRelativePath);
      const file = loadVirtualFile(
        options.files,
        options.vaultDir,
        managed.vaultRelativePath,
        true,
      );
      const source = virtualFingerprint(file);
      const desiredTemplateBytes = readPluginResource(
        options.pluginRoot,
        options.resources,
        managed.desiredTemplatePath,
      );
      const knownTemplateSha256 = [...(managed.knownTemplatePaths ?? [])]
        .map(relativePath => sha256(readPluginResource(
          options.pluginRoot,
          options.resources,
          relativePath,
        )))
        .sort(codeUnitCompare);
      let rendered;
      try {
        rendered = renderManagedAssetBytes({
          intent: managed,
          current: managedCurrent(file),
          readPluginResource(relativePath) {
            return readPluginResource(
              options.pluginRoot,
              options.resources,
              relativePath,
            );
          },
        });
      } catch (error) {
        if (
          error instanceof UpdateError
          && error.code === 'MIGRATION_CONFLICT'
        ) {
          options.conflicts.set(
            managed.vaultRelativePath,
            'MIGRATION_CONFLICT',
          );
          options.blockedPaths.add(managed.vaultRelativePath);
          options.materials.push({
            kind: 'managed-asset',
            stage,
            ordinal,
            path: managed.vaultRelativePath,
            source,
            desiredTemplateSha256: sha256(desiredTemplateBytes),
            knownTemplateSha256,
            outcome: 'conflict',
          });
          continue;
        }
        throw error;
      }
      const desiredSha256 = rendered
        ? sha256(rendered.desiredBytes)
        : source.type === 'file'
          ? source.sha256
          : undefined;
      options.materials.push({
        kind: 'managed-asset',
        stage,
        ordinal,
        path: managed.vaultRelativePath,
        source,
        desiredTemplateSha256: sha256(desiredTemplateBytes),
        knownTemplateSha256,
        desiredSha256,
        desiredMode: rendered?.desiredMode ?? file.mode,
        outcome: rendered ? 'changed' : 'unchanged',
      });
      if (rendered) {
        file.exists = true;
        file.bytes = Buffer.from(Uint8Array.from(rendered.desiredBytes));
        file.mode = rendered.desiredMode;
        file.lastStage = stage;
      }
    }

    let transformOrdinal = 0;
    for (const transform of intent.contentTransforms) {
      const paths = [...transform.vaultRelativePaths].sort(codeUnitCompare);
      for (const relativePath of paths) {
        if (stageTargets.has(relativePath)) invalidRegistry();
        stageTargets.add(relativePath);
        claimFileIntentPath(relativePath);
        const file = loadVirtualFile(
          options.files,
          options.vaultDir,
          relativePath,
          false,
        );
        if (!file.bytes) fail('UNSAFE_PATH');
        const source = virtualFingerprint(file);
        let desired: unknown;
        try {
          desired = transform.transform(
            relativePath,
            Buffer.from(Uint8Array.from(file.bytes)),
          );
        } catch {
          return invalidRegistry();
        }
        if (!Buffer.isBuffer(desired)) invalidRegistry();
        const desiredBytes = Buffer.from(Uint8Array.from(desired));
        options.materials.push({
          kind: 'content-transform',
          stage,
          ordinal: transformOrdinal,
          path: relativePath,
          source,
          desiredSha256: sha256(desiredBytes),
          desiredMode: file.mode,
        });
        if (!bytesEqual(file.bytes, desiredBytes)) {
          file.bytes = desiredBytes;
          file.lastStage = stage;
        }
        transformOrdinal += 1;
      }
    }

    for (
      let ordinal = 0;
      ordinal < intent.mutations.length;
      ordinal += 1
    ) {
      const declaration = intent.mutations[ordinal];
      const affected = declaration.kind === 'rename'
        ? [
            declaration.vaultRelativePath,
            declaration.destinationVaultRelativePath,
          ]
        : [declaration.vaultRelativePath];
      for (const relativePath of affected) {
        if (stageTargets.has(relativePath)) invalidRegistry();
        stageTargets.add(relativePath);
        claimStructuralPath(relativePath);
      }

      const source = fingerprint(
        options.vaultDir,
        declaration.vaultRelativePath,
      );
      if (declaration.kind === 'mkdir') {
        const outcome = source.type === 'missing'
          ? 'changed'
          : source.type === 'directory'
            ? 'unchanged'
            : 'conflict';
        options.materials.push({
          kind: declaration.kind,
          stage,
          ordinal,
          path: declaration.vaultRelativePath,
          source,
          desiredMode: declaration.desiredMode,
          outcome,
        });
        options.pathMutations.push({
          declaration,
          source,
          lastStage: stage,
          ordinal,
          outcome,
        });
        if (outcome === 'conflict') {
          options.conflicts.set(
            declaration.vaultRelativePath,
            'MIGRATION_CONFLICT',
          );
          options.blockedPaths.add(declaration.vaultRelativePath);
        }
        continue;
      }

      const destinationSource = fingerprint(
        options.vaultDir,
        declaration.destinationVaultRelativePath,
      );
      const outcome = source.type === 'file'
        && destinationSource.type === 'missing'
        ? 'changed'
        : 'conflict';
      options.materials.push({
        kind: declaration.kind,
        stage,
        ordinal,
        path: declaration.vaultRelativePath,
        destinationPath: declaration.destinationVaultRelativePath,
        source,
        destinationSource,
        outcome,
      });
      options.pathMutations.push({
        declaration,
        source,
        destinationSource,
        lastStage: stage,
        ordinal,
        outcome,
      });
      if (outcome === 'conflict') {
        if (source.type !== 'file') {
          options.conflicts.set(
            declaration.vaultRelativePath,
            'MIGRATION_CONFLICT',
          );
          options.blockedPaths.add(declaration.vaultRelativePath);
        }
        if (destinationSource.type !== 'missing') {
          options.conflicts.set(
            declaration.destinationVaultRelativePath,
            'MIGRATION_CONFLICT',
          );
          options.blockedPaths.add(
            declaration.destinationVaultRelativePath,
          );
        }
      }
    }
  }
}

function mutationDigestRecord(mutation: PlannedMutation): unknown {
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

function finalMutations(
  files: ReadonlyMap<string, VirtualFile>,
  blockedPaths: ReadonlySet<string>,
  pathMutations: readonly StagedPathMutation[],
): PlannedMutation[] {
  const fileCandidates = [...files.values()]
    .filter(file => {
      if (
        blockedPaths.has(file.path)
        || !file.exists
        || !file.bytes
        || file.lastStage < 0
      ) {
        return false;
      }
      return file.source.type === 'missing'
        || (
          file.source.type === 'file'
          && file.sourceBytes !== undefined
          && !bytesEqual(file.sourceBytes, file.bytes)
        );
    })
    .sort((left, right) => {
      const leftConfig = left.path === CONFIG_PATH ? 1 : 0;
      const rightConfig = right.path === CONFIG_PATH ? 1 : 0;
      if (leftConfig !== rightConfig) return leftConfig - rightConfig;
      return left.lastStage - right.lastStage
        || codeUnitCompare(left.path, right.path);
    });
  const candidates: Array<{
    lastStage: number;
    primaryPath: string;
    secondaryPath: string;
    mutation: PlannedMutation;
  }> = [
    ...fileCandidates.map(file => ({
      lastStage: file.lastStage,
      primaryPath: file.path,
      secondaryPath: '',
      mutation: {
        kind: 'write-file' as const,
        vaultRelativePath: file.path,
        source: file.source,
        desiredBytes: Buffer.from(Uint8Array.from(file.bytes as Buffer)),
        desiredSha256: sha256(file.bytes as Buffer),
        desiredMode: file.mode,
        publishOrder: 0,
      },
    })),
    ...pathMutations
      .filter(item => item.outcome === 'changed' && !(
        blockedPaths.has(item.declaration.vaultRelativePath)
        || (
          item.declaration.kind === 'rename'
          && blockedPaths.has(
            item.declaration.destinationVaultRelativePath,
          )
        )
      ))
      .map(item => ({
        lastStage: item.lastStage,
        primaryPath: item.declaration.vaultRelativePath,
        secondaryPath: item.declaration.kind === 'rename'
          ? item.declaration.destinationVaultRelativePath
          : '',
        mutation: item.declaration.kind === 'mkdir'
          ? {
              kind: 'mkdir' as const,
              vaultRelativePath: item.declaration.vaultRelativePath,
              source: item.source,
              desiredMode: item.declaration.desiredMode,
              publishOrder: 0,
            }
          : {
              kind: 'rename' as const,
              vaultRelativePath: item.declaration.vaultRelativePath,
              destinationVaultRelativePath:
                item.declaration.destinationVaultRelativePath,
              source: item.source,
              destinationSource: item.destinationSource as SourceFingerprint,
              publishOrder: 0,
            },
      })),
  ].sort((left, right) => {
    const leftConfig = left.primaryPath === CONFIG_PATH ? 1 : 0;
    const rightConfig = right.primaryPath === CONFIG_PATH ? 1 : 0;
    if (leftConfig !== rightConfig) return leftConfig - rightConfig;
    return left.lastStage - right.lastStage
      || codeUnitCompare(left.primaryPath, right.primaryPath)
      || codeUnitCompare(left.mutation.kind, right.mutation.kind)
      || codeUnitCompare(left.secondaryPath, right.secondaryPath);
  });
  return candidates.map(({ mutation }, publishOrder) => ({
    ...mutation,
    publishOrder,
  }));
}

function makeDiff(
  relativePath: string,
  sourceBytes: Buffer,
  desiredBytes: Buffer,
): string {
  return createTwoFilesPatch(
    relativePath,
    relativePath,
    utf8(sourceBytes),
    utf8(desiredBytes),
    'before',
    'after',
    { context: 3 },
  );
}

export function planVaultUpdate(options: {
  vaultDir: string;
  pluginRoot: string;
  registry?: readonly VaultMigration[];
}): UpdatePlan {
  const vaultDir = canonicalDirectory(options.vaultDir);
  const pluginRoot = canonicalDirectory(options.pluginRoot);
  const registry = options.registry ?? MIGRATION_REGISTRY;
  const targetVersion = options.registry
    ? registry.length
    : CURRENT_VAULT_SCHEMA_VERSION;
  validateMigrationRegistry(registry, targetVersion);

  const configSource = fingerprint(vaultDir, CONFIG_PATH);
  if (configSource.type === 'missing') fail('NOT_A_ME_VAULT');
  if (configSource.type !== 'file') fail('UNSAFE_PATH');
  const configBytes = readRegularFile(
    vaultDir,
    CONFIG_PATH,
    configSource,
  ).bytes;
  const currentVersion = readVaultSchemaVersion(utf8(configBytes));
  if (currentVersion > targetVersion) {
    throw new UpdateError('VAULT_NEWER_THAN_PLUGIN');
  }

  const resolved = resolveMigrations({
    registry,
    currentVersion,
    vaultDir,
    pluginRoot,
  });
  const files = new Map<string, VirtualFile>();
  files.set(CONFIG_PATH, {
    path: CONFIG_PATH,
    source: configSource,
    sourceBytes: configBytes,
    exists: true,
    bytes: Buffer.from(Uint8Array.from(configBytes)),
    mode: configSource.mode ?? 0o644,
    lastStage: -1,
  });
  const resources = new Map<string, PluginResource>();
  const conflictMap = new Map<string, string>();
  const blockedPaths = new Set<string>();
  const materials: DigestMaterial[] = [];
  const pathMutations: StagedPathMutation[] = [];

  if (resolved.length === 0) {
    materials.push({
      kind: 'config',
      stage: -1,
      path: CONFIG_PATH,
      source: configSource,
      desiredSha256: sha256(configBytes),
      desiredMode: configSource.mode ?? 0o644,
    });
  } else {
    renderMigrationStages({
      vaultDir,
      pluginRoot,
      files,
      resources,
      resolved,
      conflicts: conflictMap,
      blockedPaths,
      materials,
      pathMutations,
    });
  }
  assertStableInputs(
    vaultDir,
    pluginRoot,
    files,
    resources,
    pathMutations,
  );

  const mutations = finalMutations(files, blockedPaths, pathMutations);
  try {
    validatePlannedMutations(mutations);
  } catch (error) {
    if (error instanceof MutationFailure) translateMutationFailure(error);
    throw error;
  }
  const plannedPaths = mutations
    .flatMap(mutation => (
      mutation.kind === 'rename'
        ? [
            mutation.vaultRelativePath,
            mutation.destinationVaultRelativePath,
          ]
        : [mutation.vaultRelativePath]
    ))
    .sort(codeUnitCompare);
  const diffs = mutations
    .filter((mutation): mutation is Extract<
      PlannedMutation,
      { kind: 'write-file' }
    > => mutation.kind === 'write-file')
    .map(mutation => {
      const file = files.get(mutation.vaultRelativePath);
      if (!file) fail('UNSAFE_PATH');
      return {
        path: mutation.vaultRelativePath,
        diff: makeDiff(
          mutation.vaultRelativePath,
          file.sourceBytes ?? Buffer.alloc(0),
          mutation.desiredBytes,
        ),
      };
    })
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  const conflicts = [...conflictMap]
    .map(([path, reason]) => ({ path, reason }))
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  const registryRevision = sha256(canonicalStringify(
    registry.map(migration => ({
      id: migration.id,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    })),
  ));
  const planDigest = sha256(canonicalStringify({
    registryRevision,
    sourceVersion: currentVersion,
    targetVersion,
    migrationIds: resolved.map(item => item.migration.id),
    plannedPaths,
    materials,
    mutations: mutations.map(mutationDigestRecord),
    conflicts,
  }));

  return {
    status: conflicts.length > 0
      ? 'blocked'
      : mutations.length > 0
        ? 'preview'
        : 'up_to_date',
    currentVaultSchemaVersion: currentVersion,
    targetVaultSchemaVersion: targetVersion,
    migrations: resolved.map(item => ({
      id: item.migration.id,
      description: item.description,
    })),
    mutations,
    plannedPaths,
    diffs,
    warnings: [],
    conflicts,
    planDigest,
  };
}
