import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseVaultWriteRequest,
  type VaultWriteRecovery,
  type VaultWriteRequestV1,
  type VaultWriteResultV1,
  type WriterErrorCode,
  VaultWriterError,
  WRITER_ERROR_CATALOG,
} from './contracts';
import {
  assertSafeWriterPath,
  detectLegacyVaultWriterState,
  resolveVaultLayout,
  resolveWriteTarget,
  type ResolvedVaultLayout,
  type ResolvedWriteTarget,
  vaultRelative,
} from './path-safety';
import { snapshotVaultGraph, type VaultGraphInput, type VaultGraphSnapshot } from './graph';
import {
  planIndexUpdate,
  validatePostWriteGraph,
  type IndexPlan,
  type LinkSuggestions,
} from './index';
import {
  loadLayerSchema,
  validateNoteMarkdown,
  type ValidatedNote,
} from './schema';
import {
  assertSafeRuntimePath,
  bootstrapRuntimeDirectories,
  RuntimePathError,
  runtimeLexicalDisplayPath,
} from '../runtime-paths';

export interface VaultWriteHooks {
  beforeFsMutation?(
    kind: 'link' | 'rename' | 'unlink' | 'mkdir' | 'rmdir',
    paths: string[],
  ): void;
  afterLock?(): void;
  afterStaging?(): void;
  beforeNotePublish?(path: string): void;
  afterNotePublish?(path: string): void;
  beforeIndexPreserve?(path: string): void;
  afterIndexPreserve?(original: string): void;
  afterIndexPublish?(path: string): void;
  beforePostValidation?(): void;
  beforeCommitCleanup?(operationDir: string): void;
  beforeLockRelease?(path: string): void;
}

export interface PlanFingerprintV1 {
  requestDigest: string;
  config: { identity: string; sha256: string };
  schemaProfile: { identity: string; sha256: string };
  schemaDocument: { identity: string; sha256: string };
  template: { identity: string; sha256: string };
  graphInputs: Array<{ path: string; identity: string; sha256: string }>;
  pathIdentities: Array<{
    path: string;
    state: 'absent' | 'file' | 'directory';
    identity?: string;
  }>;
  readme: { state: 'absent' | 'file'; identity?: string; sha256?: string };
  plannedNoteSha256: string;
  plannedIndexSha256?: string;
}

export interface VaultWriterOptions {
  pluginRoot: string;
  mode: 'preview' | 'write';
  hooks?: VaultWriteHooks;
  fileOps?: Partial<{
    readdirSync: typeof fs.readdirSync;
    lstatSync: typeof fs.lstatSync;
    realpathSync: typeof fs.realpathSync;
    readFileSync: typeof fs.readFileSync;
    linkSync: typeof fs.linkSync;
    renameSync: typeof fs.renameSync;
    unlinkSync: typeof fs.unlinkSync;
    mkdirSync: typeof fs.mkdirSync;
    rmdirSync: typeof fs.rmdirSync;
  }>;
  /** Test-only injection for exclusive cooperative-lock acquisition. */
  lockOps?: Partial<LockOperations>;
  /** Test-only injection. Production callers omit this. */
  directoryFsync?(directory: string): void;
  /**
   * Additive callback invoked after exclusive lock acquisition and the
   * authoritative post-lock replan, before any transaction/journal mutations.
   *
   * The callback receives the confirmed plan (with verified fingerprint).
   * If it throws, the lock is safely released and the write aborts with
   * INPUT_CHANGED — no mutations reach disk.
   *
   * This is the integration point for callers (e.g. distill) that must
   * re-verify external state under the vault-write lock to close the
   * TOCTOU window between their pre-lock check and the actual write.
   */
  afterAuthoritativePlan?(plan: PlannedWrite): void;
}

type MutationKind = 'link' | 'rename' | 'unlink' | 'mkdir' | 'rmdir';
type JournalState =
  | 'planned'
  | 'locked'
  | 'staged'
  | 'note-published'
  | 'index-preserved'
  | 'index-published'
  | 'validated'
  | 'committed';

export interface PlannedWrite {
  request: VaultWriteRequestV1;
  layout: ResolvedVaultLayout;
  target: ResolvedWriteTarget;
  note: ValidatedNote;
  graph: VaultGraphSnapshot;
  index: IndexPlan;
  suggestions: LinkSuggestions;
  fingerprint: PlanFingerprintV1;
}

interface OwnedFile {
  path: string;
  identity: string;
  sha256: string;
}

interface OwnedDirectory {
  path: string;
  identity: string;
}

interface OwnedLock {
  file: OwnedFile;
  descriptor: number;
  closeDescriptor(descriptor: number): void;
}

interface LockOperations {
  openSync(file: string, flags: string, mode: number): number;
  writeFileSync(descriptor: number, bytes: Buffer): void;
  fsyncSync(descriptor: number): void;
  fchmodSync(descriptor: number, mode: number): void;
  fstatSync(descriptor: number): fs.BigIntStats;
  lstatSync(file: string): fs.BigIntStats;
  statSync(file: string): fs.BigIntStats;
  realpathSync(file: string): string;
  readFileSync(file: string): Buffer;
  closeSync(descriptor: number): void;
}

interface FileOperations {
  readdirSync: typeof fs.readdirSync;
  lstatSync: typeof fs.lstatSync;
  realpathSync: typeof fs.realpathSync;
  readFileSync: typeof fs.readFileSync;
  linkSync: typeof fs.linkSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  mkdirSync: typeof fs.mkdirSync;
  rmdirSync: typeof fs.rmdirSync;
}

interface Journal {
  version: 1;
  operationId: string;
  state: JournalState;
  notePath: string;
  indexPath?: string;
  requestDigest: string;
  plannedNoteSha256: string;
  plannedIndexSha256?: string;
  pendingMutation?: { kind: MutationKind; paths: string[] };
  metadataPolicy?: string;
}

const STATES = new Set<JournalState>([
  'planned',
  'locked',
  'staged',
  'note-published',
  'index-preserved',
  'index-published',
  'validated',
  'committed',
]);
const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const METADATA_POLICY =
  'POSIX mode preserved for replaced README; uid/gid/ACL/xattr/timestamps are not preserved.';

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requestDigest(request: VaultWriteRequestV1): string {
  return sha256(Buffer.from(JSON.stringify(request), 'utf8'));
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function displayRelative(layout: ResolvedVaultLayout, absolute: string): string {
  const candidate = path.resolve(absolute);
  if (isInside(layout.lexicalVault, candidate)) {
    return path.relative(layout.lexicalVault, candidate).split(path.sep).join('/') || '.';
  }
  if (isInside(layout.runtimeRoot, candidate)) {
    return runtimeLexicalDisplayPath(layout, candidate);
  }
  throw new VaultWriterError('UNSAFE_PATH');
}

function assertSafeMutationPath(
  layout: ResolvedVaultLayout,
  candidate: string,
  label: string,
): void {
  if (isInside(layout.runtimeRoot, path.resolve(candidate))) {
    try {
      assertSafeRuntimePath(layout, candidate);
      return;
    } catch {
      throw new VaultWriterError('UNSAFE_PATH');
    }
  }
  assertSafeWriterPath(layout, candidate, label);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function bigStatFingerprint(stat: fs.BigIntStats): string {
  const type = stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : 'other';
  return JSON.stringify({
    type,
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  });
}

function ownedStatFingerprint(stat: fs.BigIntStats): Record<string, string> {
  const type = stat.isFile()
    ? 'file'
    : stat.isDirectory()
      ? 'directory'
      : stat.isSymbolicLink()
        ? 'symlink'
        : 'other';
  return {
    type,
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
  };
}

function fileIdentity(file: string): string {
  const entry = fs.lstatSync(file, { bigint: true });
  const target = fs.statSync(file, { bigint: true });
  return JSON.stringify({
    entry: JSON.parse(bigStatFingerprint(entry)),
    target: JSON.parse(bigStatFingerprint(target)),
    canonicalPath: fs.realpathSync(file),
  });
}

function ownedFileIdentity(file: string): string {
  const entry = fs.lstatSync(file, { bigint: true });
  const target = fs.statSync(file, { bigint: true });
  return JSON.stringify({
    entry: ownedStatFingerprint(entry),
    target: ownedStatFingerprint(target),
    /*
     * Do not use realpath here. On APFS, realpath of a hard-linked inode can
     * transiently report another link to that inode. The lexical pathname is
     * stable, while entry/target dev+ino still prove which inode it names.
     */
    lexicalPath: path.resolve(file),
  });
}

function ownedFile(file: string): OwnedFile {
  return {
    path: file,
    identity: ownedFileIdentity(file),
    sha256: sha256(fs.readFileSync(file)),
  };
}

function ownedDirectory(directory: string): OwnedDirectory {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultWriterError('UNSAFE_PATH');
  return {
    path: directory,
    identity: JSON.stringify({ type: 'directory', dev: stat.dev.toString(), ino: stat.ino.toString() }),
  };
}

function sameOwnedDirectory(expected: OwnedDirectory): boolean {
  try {
    const stat = fs.lstatSync(expected.path, { bigint: true });
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && JSON.stringify({ type: 'directory', dev: stat.dev.toString(), ino: stat.ino.toString() })
        === expected.identity;
  } catch {
    return false;
  }
}

function sameOwnedFile(expected: OwnedFile): boolean {
  try {
    return ownedFileIdentity(expected.path) === expected.identity
      && sha256(fs.readFileSync(expected.path)) === expected.sha256;
  } catch {
    return false;
  }
}

function sameOwnedLineage(expected: OwnedFile): boolean {
  try {
    const recorded = JSON.parse(expected.identity) as {
      target: { dev: string; ino: string; mode: string; size: string; type: string };
    };
    const current = fs.statSync(expected.path, { bigint: true });
    return current.dev.toString() === recorded.target.dev
      && current.ino.toString() === recorded.target.ino
      && current.mode.toString() === recorded.target.mode
      && current.size.toString() === recorded.target.size
      && current.isFile()
      && recorded.target.type === 'file'
      && sha256(fs.readFileSync(expected.path)) === expected.sha256;
  } catch {
    return false;
  }
}

function sameOwnedFileAtLinkCount(expected: OwnedFile, expectedLinkCount: bigint): boolean {
  try {
    return sameOwnedFile(expected)
      && fs.statSync(expected.path, { bigint: true }).nlink === expectedLinkCount;
  } catch {
    return false;
  }
}

function sameMovedFile(expected: OwnedFile, destination: string): boolean {
  try {
    const recorded = JSON.parse(expected.identity) as {
      target: {
        dev: string;
        ino: string;
        mode: string;
        size: string;
        type: string;
      };
    };
    const current = fs.statSync(destination, { bigint: true });
    return current.isFile()
      && recorded.target.type === 'file'
      && current.dev.toString() === recorded.target.dev
      && current.ino.toString() === recorded.target.ino
      && current.mode.toString() === recorded.target.mode
      && current.size.toString() === recorded.target.size
      && sha256(fs.readFileSync(destination)) === expected.sha256;
  } catch {
    return false;
  }
}

function sameInode(first: string, second: string): boolean {
  try {
    const left = fs.statSync(first, { bigint: true });
    const right = fs.statSync(second, { bigint: true });
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function snapshotRequiredFile(file: string): { identity: string; sha256: string } {
  const bytes = fs.readFileSync(file);
  return { identity: fileIdentity(file), sha256: sha256(bytes) };
}

function snapshotOptionalFile(
  file: string,
): { state: 'absent' | 'file'; identity?: string; sha256?: string } {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new VaultWriterError('UNSAFE_PATH');
    const bytes = fs.readFileSync(file);
    return { state: 'file', identity: fileIdentity(file), sha256: sha256(bytes) };
  } catch (error) {
    if (errno(error) === 'ENOENT') return { state: 'absent' };
    throw error;
  }
}

function snapshotConfig(file: string): { identity: string; sha256: string } {
  const snapshot = snapshotOptionalFile(file);
  return snapshot.state === 'absent'
    ? { identity: 'absent', sha256: EMPTY_SHA }
    : { identity: snapshot.identity as string, sha256: snapshot.sha256 as string };
}

function pathState(
  layout: ResolvedVaultLayout,
  absolute: string,
): PlanFingerprintV1['pathIdentities'][number] {
  const relative = displayRelative(layout, absolute);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() && !stat.isDirectory()) throw new VaultWriterError('UNSAFE_PATH');
    return {
      path: relative,
      state: stat.isDirectory() ? 'directory' : 'file',
      identity: fileIdentity(absolute),
    };
  } catch (error) {
    if (errno(error) === 'ENOENT') return { path: relative, state: 'absent' };
    throw error;
  }
}

function makeFingerprint(
  request: VaultWriteRequestV1,
  pluginRoot: string,
  layout: ResolvedVaultLayout,
  target: ResolvedWriteTarget,
  graphInputs: VaultGraphInput[],
  index: IndexPlan,
): PlanFingerprintV1 {
  const profile = path.join(pluginRoot, 'templates/schema-profiles/me-schema-v1.json');
  const template = path.join(pluginRoot, `templates/${request.layer}-template.md`);
  const config = path.join(layout.meDir, 'config.yaml');
  const readme = snapshotOptionalFile(target.indexPath);
  const directPaths = [
    ...Object.values(layout.layers),
    layout.meDir,
    layout.transactionDir,
    layout.lockDir,
    path.join(layout.lockDir, 'vault-write.lock'),
    path.dirname(target.notePath),
    target.notePath,
    target.indexPath,
  ];
  const allPaths = new Set<string>(directPaths);
  for (const candidate of directPaths) {
    let current = path.resolve(candidate);
    const root = isInside(layout.runtimeRoot, current)
      ? layout.runtimeRoot
      : layout.lexicalVault;
    while (current !== root) {
      allPaths.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const identities = [...allPaths].map(item => pathState(layout, item))
    .sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
  return {
    requestDigest: requestDigest(request),
    config: snapshotConfig(config),
    schemaProfile: snapshotRequiredFile(profile),
    schemaDocument: snapshotRequiredFile(layout.schemaPath),
    template: snapshotRequiredFile(template),
    graphInputs: graphInputs
      .map(input => ({ ...input }))
      .sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0),
    pathIdentities: identities,
    readme,
    plannedNoteSha256: sha256(Buffer.from(request.markdown, 'utf8')),
    ...(index.digest ? { plannedIndexSha256: index.digest } : {}),
  };
}

function planWrite(
  vaultDir: string,
  requestValue: VaultWriteRequestV1,
  pluginRoot: string,
): PlannedWrite {
  const request = parseVaultWriteRequest(requestValue);
  const layout = resolveVaultLayout(vaultDir);
  const target = resolveWriteTarget(layout, request);
  const contract = loadLayerSchema(layout, pluginRoot, request.layer);
  const note = validateNoteMarkdown(layout, target.notePath, request.markdown, contract);
  const graph = snapshotVaultGraph(layout);
  const { index, suggestions } = planIndexUpdate(
    layout,
    request.layer,
    target,
    note.title,
  );
  const fingerprint = makeFingerprint(
    request,
    pluginRoot,
    layout,
    target,
    graph.inputs,
    index,
  );
  return { request, layout, target, note, graph, index, suggestions, fingerprint };
}

function replanAfterLock(
  vaultDir: string,
  request: VaultWriteRequestV1,
  pluginRoot: string,
): PlannedWrite {
  try {
    return planWrite(vaultDir, request, pluginRoot);
  } catch {
    /*
     * The same request was valid immediately before lock acquisition.  Any
     * config/schema/template/graph/path failure in this window is snapshot
     * drift, not a newly discovered caller validation error.
     */
    throw new VaultWriterError('INPUT_CHANGED');
  }
}

function codeResult(
  operationId: string,
  digest: string,
  code: WriterErrorCode,
  indexAction: IndexPlan['action'] = 'none',
  recoveries: VaultWriteRecovery[] = [],
  plannedPaths: string[] = [],
): VaultWriteResultV1 {
  const definition = WRITER_ERROR_CATALOG[code];
  const publicRecoveries = recoveries.map(publicRecovery);
  return {
    version: 1,
    status: definition.status,
    operationId,
    commitModel: 'journaled-cooperative',
    requestDigest: digest,
    changedPaths: [],
    plannedPaths,
    indexAction,
    backlinks: [],
    unlinkedMentions: [],
    warnings: [],
    error: { code, message: definition.message },
    recoveryState: publicRecoveries.length === 0 ? 'none' : 'incomplete',
    recoveries: publicRecoveries,
  };
}

function previewResult(operationId: string, plan: PlannedWrite): VaultWriteResultV1 {
  const plannedPaths = [
    plan.target.vaultRelativePath,
    ...(plan.index.action === 'none' ? [] : [plan.index.path]),
  ];
  return {
    version: 1,
    status: 'preview',
    operationId,
    commitModel: 'preview-only',
    requestDigest: plan.fingerprint.requestDigest,
    notePath: plan.target.vaultRelativePath,
    changedPaths: [],
    plannedPaths,
    indexAction: plan.index.action,
    backlinks: plan.suggestions.backlinks,
    unlinkedMentions: plan.suggestions.unlinkedMentions,
    warnings: ['Preview is a point-in-time plan and does not reserve the target.'],
    recoveryState: 'none',
    recoveries: [],
  };
}

function recoveryAction(
  operationId: string,
  directory: string,
  state: VaultWriteRecovery['state'],
  preservedPaths: string[],
  remainingMutations: string[],
  journal?: string,
): VaultWriteRecovery {
  return {
    operationId,
    state,
    directory,
    ...(journal ? { journal } : {}),
    preservedPaths,
    remainingMutations,
    actions: [
      {
        kind: 'inspect',
        path: preservedPaths[0] ?? directory,
        condition: 'Inspect preserved content before taking any recovery action.',
      },
    ],
  };
}

const PUBLIC_OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function publicRecovery(recovery: VaultWriteRecovery): VaultWriteRecovery {
  if (
    recovery.operationId === 'legacy-v1.5'
    && recovery.directory === '.me'
    && recovery.journal === undefined
    && recovery.preservedPaths.every(item =>
      item.startsWith('.me/tmp/') || item.startsWith('.me/locks/'))
  ) {
    return recovery;
  }
  const generatedDirectory = `<ME_RUNTIME>/transactions/vault-write-${recovery.operationId}`;
  const trustedDirectory = recovery.directory === '<ME_RUNTIME>/transactions'
    || recovery.directory === '<ME_RUNTIME>/locks'
    || recovery.directory === generatedDirectory;
  const trustedJournal = recovery.journal === undefined
    || (
      recovery.directory === generatedDirectory
      && recovery.journal === `${generatedDirectory}/journal.json`
    );
  if (
    PUBLIC_OPERATION_ID.test(recovery.operationId)
    && trustedDirectory
    && trustedJournal
  ) return recovery;
  const operationId =
    `recovery-${sha256(Buffer.from(JSON.stringify(recovery), 'utf8')).slice(0, 12)}`;
  const directory = recovery.directory.startsWith('<ME_RUNTIME>/locks')
    ? '<ME_RUNTIME>/locks'
    : '<ME_RUNTIME>/transactions';
  return {
    operationId,
    state: recovery.state,
    directory,
    preservedPaths: [directory],
    remainingMutations: recovery.remainingMutations.length === 0
      ? []
      : ['Inspect local recovery state for this operation.'],
    actions: [{
      kind: 'inspect',
      path: directory,
      condition: 'Inspect local recovery state using the opaque recovery identifier.',
    }],
  };
}

function safeJournalRelativePath(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return !value.split('/').some(component =>
    !component || component === '.' || component === '..' || /[\u0000-\u001f\u007f]/.test(component));
}

function journalHasContradictoryPaths(value: Record<string, unknown>): boolean {
  for (const key of ['notePath', 'indexPath']) {
    if (value[key] !== undefined && !safeJournalRelativePath(value[key])) return true;
  }
  if (
    typeof value.notePath === 'string'
    && typeof value.indexPath === 'string'
    && value.notePath === value.indexPath
  ) return true;
  if (value.pendingMutation !== undefined) {
    const mutation = value.pendingMutation;
    if (
      typeof mutation !== 'object'
      || mutation === null
      || Array.isArray(mutation)
      || !['link', 'rename', 'unlink', 'mkdir', 'rmdir']
        .includes((mutation as { kind?: unknown }).kind as string)
      || !Array.isArray((mutation as { paths?: unknown }).paths)
      || !(mutation as { paths: unknown[] }).paths.every(safeJournalRelativePath)
    ) return true;
  }
  return false;
}

function validCommittedOperation(
  directory: string,
  value: Record<string, unknown>,
  operations: FileOperations,
): boolean {
  const allowed = new Set([
    'version',
    'operationId',
    'state',
    'notePath',
    'indexPath',
    'requestDigest',
    'plannedNoteSha256',
    'plannedIndexSha256',
    'metadataPolicy',
  ]);
  if (
    value.state !== 'committed'
    || Object.keys(value).some(key => !allowed.has(key))
    || typeof value.notePath !== 'string'
    || typeof value.requestDigest !== 'string'
    || typeof value.plannedNoteSha256 !== 'string'
    || value.metadataPolicy !== METADATA_POLICY
    || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || !/^[a-f0-9]{64}$/.test(value.plannedNoteSha256)
    || (value.indexPath === undefined) !== (value.plannedIndexSha256 === undefined)
    || (value.plannedIndexSha256 !== undefined
      && (typeof value.plannedIndexSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.plannedIndexSha256)))
  ) return false;
  let entries: string[];
  try {
    entries = (operations.readdirSync(directory) as string[]).sort();
  } catch {
    return false;
  }
  if (
    entries.some(entry => entry !== 'journal.json' && entry !== 'originals')
    || !entries.includes('journal.json')
  ) return false;
  if (entries.includes('originals')) {
    const originals = path.join(directory, 'originals');
    try {
      const stat = operations.lstatSync(originals) as fs.Stats;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const children = operations.readdirSync(originals) as string[];
      if (children.length !== 1 || children[0] !== 'README.md') return false;
      const original = operations.lstatSync(path.join(originals, 'README.md')) as fs.Stats;
      if (!original.isFile() || original.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function scanRecoveries(
  layout: ResolvedVaultLayout,
  operations: FileOperations,
): VaultWriteRecovery[] {
  let names: string[];
  try {
    names = (operations.readdirSync(layout.transactionDir) as string[])
      .filter(name => name.startsWith('vault-write-'))
      .sort();
  } catch (error) {
    if (errno(error) === 'ENOENT') return [];
    return [recoveryAction(
      'unrecognized',
      '<ME_RUNTIME>/transactions',
      'unrecognized-operation',
      ['<ME_RUNTIME>/transactions'],
      ['Inspect the unreadable operation directory.'],
    )];
  }

  type Candidate = {
    name: string;
    operationId: string;
    recovery?: VaultWriteRecovery;
    committed?: boolean;
  };
  const candidates: Candidate[] = [];
  for (const name of names) {
    const directory = path.join(layout.transactionDir, name);
    const relativeDirectory = `<ME_RUNTIME>/transactions/${name}`;
    const fallbackId = name.slice('vault-write-'.length) || 'unrecognized';
    let stat: fs.Stats;
    try {
      stat = operations.lstatSync(directory) as fs.Stats;
    } catch {
      candidates.push({
        name,
        operationId: fallbackId,
        recovery: recoveryAction(
          fallbackId,
          relativeDirectory,
          'unrecognized-operation',
          [relativeDirectory],
          ['Inspect the unreadable operation entry.'],
        ),
      });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      candidates.push({
        name,
        operationId: fallbackId,
        recovery: recoveryAction(
          fallbackId,
          relativeDirectory,
          'unrecognized-operation',
          [relativeDirectory],
          ['Inspect the non-directory operation entry.'],
        ),
      });
      continue;
    }

    const journalPath = path.join(directory, 'journal.json');
    const relativeJournal = `${relativeDirectory}/journal.json`;
    let journalStat: fs.Stats;
    let value: unknown;
    try {
      journalStat = operations.lstatSync(journalPath) as fs.Stats;
      if (journalStat.isSymbolicLink() || !journalStat.isFile()) throw new Error('unsafe journal');
      value = JSON.parse(operations.readFileSync(journalPath, 'utf8') as string);
    } catch {
      candidates.push({
        name,
        operationId: fallbackId,
        recovery: recoveryAction(
          fallbackId,
          relativeDirectory,
          'unrecognized-operation',
          [relativeDirectory],
          ['Inspect the missing or unreadable journal.'],
        ),
      });
      continue;
    }
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || (value as { version?: unknown }).version !== 1
      || typeof (value as { operationId?: unknown }).operationId !== 'string'
      || typeof (value as { state?: unknown }).state !== 'string'
      || !STATES.has((value as { state: JournalState }).state)
      || name !== `vault-write-${(value as { operationId: string }).operationId}`
      || journalHasContradictoryPaths(value as Record<string, unknown>)
    ) {
      const parsedOperationId = typeof (value as { operationId?: unknown }).operationId === 'string'
        ? (value as { operationId: string }).operationId
        : fallbackId;
      candidates.push({
        name,
        operationId: parsedOperationId,
        recovery: recoveryAction(
          parsedOperationId,
          relativeDirectory,
          'unrecognized-operation',
          [relativeDirectory],
          ['Inspect the unrecognized operation metadata.'],
          relativeJournal,
        ),
      });
      continue;
    }
    const operationId = (value as { operationId: string }).operationId;
    const state = (value as { state: JournalState }).state;
    if (
      state === 'committed'
      && !validCommittedOperation(directory, value as Record<string, unknown>, operations)
    ) {
      candidates.push({
        name,
        operationId,
        recovery: recoveryAction(
          operationId,
          relativeDirectory,
          'unrecognized-operation',
          [relativeDirectory],
          ['Inspect the contradictory committed operation.'],
          relativeJournal,
        ),
      });
      continue;
    }
    candidates.push({
      name,
      operationId,
      committed: state === 'committed',
      ...(state === 'committed' ? {} : {
        recovery: recoveryAction(
          operationId,
          relativeDirectory,
          'incomplete-operation',
          [relativeDirectory],
          ['Inspect the incomplete operation journal.'],
          relativeJournal,
        ),
      }),
    });
  }

  const counts = new Map<string, number>();
  for (const item of candidates) counts.set(item.operationId, (counts.get(item.operationId) ?? 0) + 1);
  for (const item of candidates) {
    if ((counts.get(item.operationId) ?? 0) <= 1) continue;
    const directory = `<ME_RUNTIME>/transactions/${item.name}`;
    item.committed = false;
    item.recovery = recoveryAction(
      item.operationId,
      directory,
      'unrecognized-operation',
      [directory],
      ['Compare duplicate operation identifiers.'],
      `${directory}/journal.json`,
    );
  }
  return candidates
    .filter(item => !item.committed && item.recovery)
    .map(item => item.recovery as VaultWriteRecovery)
    .sort((first, second) => first.directory < second.directory ? -1 : 1);
}

class Transaction {
  readonly operations: FileOperations;
  readonly hooks: VaultWriteHooks;
  readonly warnings: string[] = [];
  readonly createdDirectories: OwnedDirectory[] = [];
  journal?: Journal;
  journalPath?: string;
  journalDescriptor?: number;
  journalOwned?: OwnedFile;
  journalConflict = false;
  readonly directoryFsync?: (directory: string) => void;

  constructor(
    public plan: PlannedWrite,
    readonly operationId: string,
    options: VaultWriterOptions,
  ) {
    this.hooks = options.hooks ?? {};
    this.directoryFsync = options.directoryFsync;
    this.operations = makeFileOperations(options);
  }

  private relative(file: string): string {
    return displayRelative(this.plan.layout, file);
  }

  private validateMutation(kind: MutationKind, paths: string[]): void {
    this.hooks.beforeFsMutation?.(kind, paths);
    for (const candidate of paths) {
      assertSafeMutationPath(this.plan.layout, candidate, `${kind} boundary`);
    }
  }

  private syncDirectory(directory: string): void {
    let descriptor: number | undefined;
    try {
      if (this.directoryFsync) {
        this.directoryFsync(directory);
        return;
      }
      descriptor = fs.openSync(directory, 'r');
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(errno(error) ?? '')) throw error;
      if (!this.warnings.includes('Directory fsync is not supported on this filesystem.')) {
        this.warnings.push('Directory fsync is not supported on this filesystem.');
      }
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* best effort */ }
      }
    }
  }

  private beforeMutation(kind: MutationKind, paths: string[]): void {
    if (!this.journal || !this.journalPath) return;
    this.journal.pendingMutation = { kind, paths: paths.map(item => this.relative(item)) };
    this.writeJournal();
  }

  private afterMutation(paths: string[]): void {
    if (this.journal) delete this.journal.pendingMutation;
    this.writeJournal();
    for (const candidate of paths) this.syncDirectory(path.dirname(candidate));
  }

  mkdir(directory: string): void {
    this.beforeMutation('mkdir', [directory]);
    this.validateMutation('mkdir', [directory]);
    try {
      this.operations.lstatSync(directory);
      throw new VaultWriterError('INPUT_CHANGED');
    } catch (error) {
      if (error instanceof VaultWriterError) throw error;
      if (errno(error) !== 'ENOENT') throw error;
    }
    this.operations.mkdirSync(directory, { mode: 0o700 });
    this.createdDirectories.push(ownedDirectory(directory));
    this.afterMutation([directory]);
  }

  mkdirParents(directory: string): void {
    const missing: string[] = [];
    let current = directory;
    while (true) {
      try {
        const stat = this.operations.lstatSync(current) as fs.Stats;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultWriterError('UNSAFE_PATH');
        break;
      } catch (error) {
        if (error instanceof VaultWriterError) throw error;
        if (errno(error) !== 'ENOENT') throw error;
        missing.push(current);
        const parent = path.dirname(current);
        if (parent === current) throw new VaultWriterError('UNSAFE_PATH');
        current = parent;
      }
    }
    for (const candidate of missing.reverse()) this.mkdir(candidate);
  }

  ownedDirectoryFor(directory: string): OwnedDirectory {
    const found = this.createdDirectories.find(item => item.path === directory);
    if (!found) throw new VaultWriterError('RECOVERY_REQUIRED');
    return found;
  }

  link(
    source: string,
    destination: string,
    expectedSource: OwnedFile,
    expectedLinkCount: bigint,
  ): void {
    this.beforeMutation('link', [source, destination]);
    this.validateMutation('link', [source, destination]);
    let sourceStat: fs.BigIntStats;
    try {
      sourceStat = fs.lstatSync(source, { bigint: true });
    } catch {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    if (
      !sourceStat.isFile()
      || sourceStat.isSymbolicLink()
      || !sameOwnedLineage(expectedSource)
      || sourceStat.nlink !== expectedLinkCount
    ) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    try {
      fs.lstatSync(destination);
      throw new VaultWriterError('TARGET_EXISTS');
    } catch (error) {
      if (error instanceof VaultWriterError) throw error;
      if (errno(error) !== 'ENOENT') throw error;
    }
    const sourceDevice = fs.statSync(source, { bigint: true }).dev;
    const destinationDevice = fs.statSync(path.dirname(destination), { bigint: true }).dev;
    if (sourceDevice !== destinationDevice) throw new VaultWriterError('UNSUPPORTED_FILESYSTEM');
    try {
      this.operations.linkSync(source, destination);
    } catch (error) {
      if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(errno(error) ?? '')) {
        throw new VaultWriterError('UNSUPPORTED_FILESYSTEM');
      }
      if (errno(error) === 'EEXIST') throw new VaultWriterError('TARGET_EXISTS');
      throw error;
    }
    const nextLinkCount = expectedLinkCount + 1n;
    if (
      !sameOwnedFileAtLinkCount(expectedSource, nextLinkCount)
      || !sameInode(source, destination)
    ) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    const destinationOwned = ownedFile(destination);
    if (!sameOwnedFileAtLinkCount(destinationOwned, nextLinkCount)) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    this.afterMutation([source, destination]);
  }

  rename(source: string, destination: string, expected: OwnedFile): void {
    this.beforeMutation('rename', [source, destination]);
    this.validateMutation('rename', [source, destination]);
    if (!sameOwnedFile(expected)) throw new VaultWriterError('INPUT_CHANGED');
    try {
      fs.lstatSync(destination);
      throw new VaultWriterError('RECOVERY_REQUIRED');
    } catch (error) {
      if (error instanceof VaultWriterError) throw error;
      if (errno(error) !== 'ENOENT') throw error;
    }
    this.operations.renameSync(source, destination);
    this.afterMutation([source, destination]);
  }

  unlink(expected: OwnedFile): void {
    this.beforeMutation('unlink', [expected.path]);
    this.validateMutation('unlink', [expected.path]);
    if (!sameOwnedFile(expected)) throw new VaultWriterError('RECOVERY_REQUIRED');
    this.operations.unlinkSync(expected.path);
    this.afterMutation([expected.path]);
  }

  rmdir(expected: OwnedDirectory): void {
    this.beforeMutation('rmdir', [expected.path]);
    this.validateMutation('rmdir', [expected.path]);
    if (
      !sameOwnedDirectory(expected)
      || (fs.readdirSync(expected.path) as string[]).length !== 0
    ) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    this.operations.rmdirSync(expected.path);
    this.afterMutation([expected.path]);
  }

  startJournal(journalPath: string, journal: Journal): void {
    this.journalPath = journalPath;
    this.journal = journal;
    try {
      this.journalDescriptor = fs.openSync(journalPath, 'wx', 0o600);
    } catch {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    this.writeJournal();
  }

  verifyJournalOwnership(): boolean {
    if (!this.journalPath || this.journalDescriptor === undefined || !this.journalOwned) return false;
    try {
      assertSafeMutationPath(this.plan.layout, this.journalPath, 'journal ownership');
      const entry = fs.lstatSync(this.journalPath, { bigint: true });
      const opened = fs.fstatSync(this.journalDescriptor, { bigint: true });
      return entry.isFile()
        && !entry.isSymbolicLink()
        && entry.dev === opened.dev
        && entry.ino === opened.ino
        && sameOwnedFile(this.journalOwned)
        && JSON.parse(fs.readFileSync(this.journalPath, 'utf8')).operationId === this.operationId;
    } catch {
      return false;
    }
  }

  writeJournal(): void {
    if (!this.journalPath || !this.journal || this.journalDescriptor === undefined) return;
    if (this.journalOwned && !this.verifyJournalOwnership()) {
      this.journalConflict = true;
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    const bytes = Buffer.from(`${JSON.stringify(this.journal, null, 2)}\n`);
    fs.ftruncateSync(this.journalDescriptor, 0);
    fs.writeSync(this.journalDescriptor, bytes, 0, bytes.length, 0);
    fs.fsyncSync(this.journalDescriptor);
    fs.fchmodSync(this.journalDescriptor, 0o600);
    this.journalOwned = ownedFile(this.journalPath);
  }

  closeJournal(): OwnedFile | undefined {
    const owned = this.journalOwned;
    if (this.journalDescriptor !== undefined) {
      fs.closeSync(this.journalDescriptor);
      this.journalDescriptor = undefined;
    }
    this.journalPath = undefined;
    this.journal = undefined;
    this.journalOwned = undefined;
    return owned;
  }

  state(state: JournalState): void {
    if (!this.journal) return;
    this.journal.state = state;
    this.writeJournal();
  }
}

function compareFingerprints(first: PlanFingerprintV1, second: PlanFingerprintV1): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function snapshotFingerprintPaths(plan: PlannedWrite): PlanFingerprintV1['pathIdentities'] {
  return plan.fingerprint.pathIdentities.map(item => {
    const runtimePrefix = '<ME_RUNTIME>/';
    const absolute = item.path === '<ME_RUNTIME>'
      ? plan.layout.runtimeRoot
      : item.path.startsWith(runtimePrefix)
        ? path.join(plan.layout.runtimeRoot, ...item.path.slice(runtimePrefix.length).split('/'))
        : path.join(plan.layout.lexicalVault, ...item.path.split('/'));
    return pathState(plan.layout, absolute);
  });
}

function assertBoundaryPaths(
  expected: PlanFingerprintV1['pathIdentities'],
  current: PlanFingerprintV1['pathIdentities'],
  excluded: Set<string>,
): void {
  const keep = (item: PlanFingerprintV1['pathIdentities'][number]) => !excluded.has(item.path);
  if (JSON.stringify(expected.filter(keep)) !== JSON.stringify(current.filter(keep))) {
    throw new VaultWriterError('INPUT_CHANGED');
  }
}

function stableExternalInputs(
  graph: VaultGraphSnapshot,
  plan: PlannedWrite,
): VaultGraphInput[] {
  return graph.inputs.filter(input =>
    input.path !== plan.target.vaultRelativePath && input.path !== plan.index.path);
}

function verifyStaticInputs(plan: PlannedWrite, pluginRoot: string): void {
  const current = {
    config: snapshotConfig(path.join(plan.layout.meDir, 'config.yaml')),
    schemaProfile: snapshotRequiredFile(
      path.join(pluginRoot, 'templates/schema-profiles/me-schema-v1.json'),
    ),
    schemaDocument: snapshotRequiredFile(plan.layout.schemaPath),
    template: snapshotRequiredFile(
      path.join(pluginRoot, `templates/${plan.request.layer}-template.md`),
    ),
  };
  const expected = {
    config: plan.fingerprint.config,
    schemaProfile: plan.fingerprint.schemaProfile,
    schemaDocument: plan.fingerprint.schemaDocument,
    template: plan.fingerprint.template,
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new VaultWriterError('INPUT_CHANGED');
}

function verifyExternalGraph(plan: PlannedWrite): void {
  const current = stableExternalInputs(snapshotVaultGraph(plan.layout), plan);
  const expected = plan.fingerprint.graphInputs.filter(input =>
    input.path !== plan.target.vaultRelativePath && input.path !== plan.index.path);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new VaultWriterError('INPUT_CHANGED');
  }
}

function errorCode(error: unknown, mutationStarted: boolean): WriterErrorCode {
  if (error instanceof VaultWriterError) {
    if (mutationStarted && error.code === 'INTERNAL_ERROR') return 'RECOVERY_REQUIRED';
    return error.code;
  }
  return mutationStarted ? 'RECOVERY_REQUIRED' : 'INTERNAL_ERROR';
}

function lockExists(
  lockPath: string,
  operations: Transaction['operations'],
): boolean {
  try {
    operations.lstatSync(lockPath);
    return true;
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw new VaultWriterError('UNSAFE_PATH');
  }
}

function makeLockOperations(options: VaultWriterOptions): LockOperations {
  return {
    openSync: options.lockOps?.openSync ?? ((file, flags, mode) => fs.openSync(file, flags, mode)),
    writeFileSync: options.lockOps?.writeFileSync
      ?? ((descriptor, bytes) => fs.writeFileSync(descriptor, bytes)),
    fsyncSync: options.lockOps?.fsyncSync ?? fs.fsyncSync,
    fchmodSync: options.lockOps?.fchmodSync ?? fs.fchmodSync,
    fstatSync: options.lockOps?.fstatSync
      ?? (descriptor => fs.fstatSync(descriptor, { bigint: true })),
    lstatSync: options.lockOps?.lstatSync ?? (file => fs.lstatSync(file, { bigint: true })),
    statSync: options.lockOps?.statSync ?? (file => fs.statSync(file, { bigint: true })),
    realpathSync: options.lockOps?.realpathSync ?? fs.realpathSync,
    readFileSync: options.lockOps?.readFileSync ?? (file => fs.readFileSync(file)),
    closeSync: options.lockOps?.closeSync ?? fs.closeSync,
  };
}

function captureAcquiredLock(
  lockPath: string,
  descriptor: number,
  expectedBytes: Buffer,
  operationId: string,
  lockOps: LockOperations,
): OwnedFile {
  const opened = lockOps.fstatSync(descriptor);
  const entry = lockOps.lstatSync(lockPath);
  const target = lockOps.statSync(lockPath);
  const actualBytes = lockOps.readFileSync(lockPath);
  const parsed = JSON.parse(actualBytes.toString('utf8')) as { operationId?: unknown };
  if (
    !opened.isFile()
    || !entry.isFile()
    || entry.isSymbolicLink()
    || !target.isFile()
    || opened.dev !== entry.dev
    || opened.ino !== entry.ino
    || opened.dev !== target.dev
    || opened.ino !== target.ino
    || !actualBytes.equals(expectedBytes)
    || parsed.operationId !== operationId
  ) {
    throw new VaultWriterError('RECOVERY_REQUIRED');
  }
  return {
    path: lockPath,
    identity: JSON.stringify({
      entry: ownedStatFingerprint(entry),
      target: ownedStatFingerprint(target),
      lexicalPath: path.resolve(lockPath),
    }),
    sha256: sha256(expectedBytes),
  };
}

function failedAcquisitionStillOwned(
  lockPath: string,
  descriptor: number,
  expectedBytes: Buffer,
  operationId: string,
): boolean {
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const entry = fs.lstatSync(lockPath, { bigint: true });
    const actualBytes = fs.readFileSync(lockPath);
    const parsed = JSON.parse(actualBytes.toString('utf8')) as { operationId?: unknown };
    return opened.isFile()
      && entry.isFile()
      && !entry.isSymbolicLink()
      && opened.dev === entry.dev
      && opened.ino === entry.ino
      && actualBytes.equals(expectedBytes)
      && parsed.operationId === operationId;
  } catch {
    return false;
  }
}

type LockAcquisition =
  | { lock: OwnedLock }
  | {
    error: unknown;
    opened: boolean;
    recovery?: VaultWriteRecovery;
  };

function acquireLock(
  layout: ResolvedVaultLayout,
  lockPath: string,
  operationId: string,
  options: VaultWriterOptions,
  operations: FileOperations,
): LockAcquisition {
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    operationId,
    startedAt: new Date().toISOString(),
  })}\n`);
  const lockOps = makeLockOperations(options);
  let descriptor: number | undefined;
  let acquired = false;
  let failure: unknown;
  let removed = false;
  let closed = false;
  try {
    descriptor = lockOps.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    return {
      error: errno(error) === 'EEXIST' ? new VaultWriterError('LOCK_HELD') : error,
      opened: false,
    };
  }
  try {
    lockOps.writeFileSync(descriptor, bytes);
    lockOps.fsyncSync(descriptor);
    lockOps.fchmodSync(descriptor, 0o600);
    const file = captureAcquiredLock(lockPath, descriptor, bytes, operationId, lockOps);
    acquired = true;
    return { lock: { file, descriptor, closeDescriptor: lockOps.closeSync } };
  } catch (error) {
    failure = error;
    if (failedAcquisitionStillOwned(lockPath, descriptor, bytes, operationId)) {
      try {
        options.hooks?.beforeFsMutation?.('unlink', [lockPath]);
        assertSafeMutationPath(layout, lockPath, 'failed lock acquisition cleanup');
        if (failedAcquisitionStillOwned(lockPath, descriptor, bytes, operationId)) {
          operations.unlinkSync(lockPath);
          removed = true;
        }
      } catch {
        removed = false;
      }
    }
  } finally {
    if (!acquired && descriptor !== undefined) {
      try {
        lockOps.closeSync(descriptor);
        closed = true;
      } catch {
        closed = false;
      }
    }
  }
  return {
    error: failure,
    opened: true,
    ...(!removed || !closed ? {
      recovery: recoveryAction(
        operationId,
        '<ME_RUNTIME>/locks',
        'ownership-conflict',
        ['<ME_RUNTIME>/locks/vault-write.lock'],
        ['Inspect the failed cooperative-lock acquisition and remove only owned content.'],
      ),
    } : {}),
  };
}

function makeFileOperations(options: VaultWriterOptions): FileOperations {
  return {
    readdirSync: options.fileOps?.readdirSync ?? fs.readdirSync,
    lstatSync: options.fileOps?.lstatSync ?? fs.lstatSync,
    realpathSync: options.fileOps?.realpathSync ?? fs.realpathSync,
    readFileSync: options.fileOps?.readFileSync ?? fs.readFileSync,
    linkSync: options.fileOps?.linkSync ?? fs.linkSync,
    renameSync: options.fileOps?.renameSync ?? fs.renameSync,
    unlinkSync: options.fileOps?.unlinkSync ?? fs.unlinkSync,
    mkdirSync: options.fileOps?.mkdirSync ?? fs.mkdirSync,
    rmdirSync: options.fileOps?.rmdirSync ?? fs.rmdirSync,
  };
}

function bootstrapDirectory(
  layout: ResolvedVaultLayout,
  directory: string,
  options: VaultWriterOptions,
  operations: FileOperations,
): void {
  try {
    const stat = operations.lstatSync(directory) as fs.Stats;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultWriterError('UNSAFE_PATH');
    return;
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    if (errno(error) !== 'ENOENT') throw error;
  }
  options.hooks?.beforeFsMutation?.('mkdir', [directory]);
  assertSafeMutationPath(layout, directory, 'bootstrap directory');
  try {
    operations.lstatSync(directory);
    throw new VaultWriterError('INPUT_CHANGED');
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    if (errno(error) !== 'ENOENT') throw error;
  }
  operations.mkdirSync(directory, { mode: 0o700 });
}

function bootstrapRuntimeRoot(layout: ResolvedVaultLayout): void {
  try {
    bootstrapRuntimeDirectories(layout, []);
  } catch (error) {
    if (error instanceof RuntimePathError) {
      throw new VaultWriterError(
        error.code === 'UNSUPPORTED_FILESYSTEM' ? 'UNSUPPORTED_FILESYSTEM' : 'UNSAFE_PATH',
      );
    }
    throw error;
  }
}

function releaseOwnedLockEarly(
  layout: ResolvedVaultLayout,
  lock: OwnedLock,
  options: VaultWriterOptions,
  operations: FileOperations,
): boolean {
  options.hooks?.beforeLockRelease?.(lock.file.path);
  try { lock.closeDescriptor(lock.descriptor); } catch { return false; }
  if (!sameOwnedFile(lock.file)) return false;
  options.hooks?.beforeFsMutation?.('unlink', [lock.file.path]);
  try {
    assertSafeMutationPath(layout, lock.file.path, 'lock release');
  } catch {
    return false;
  }
  if (!sameOwnedFile(lock.file)) return false;
  try {
    operations.unlinkSync(lock.file.path);
    return true;
  } catch {
    return false;
  }
}

function writeTransient(file: string, bytes: Buffer | string): OwnedFile {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  return ownedFile(file);
}

function recoveryForOwnership(
  plan: PlannedWrite,
  operationId: string,
  operationDir: string,
  preserved: string[],
  remaining: string[],
): VaultWriteRecovery {
  const recovery = recoveryAction(
    operationId,
    displayRelative(plan.layout, operationDir),
    'ownership-conflict',
    [...new Set(preserved)].sort(),
    [...new Set(remaining)],
    `${displayRelative(plan.layout, operationDir)}/journal.json`,
  );
  const original = recovery.preservedPaths.find(item => item.endsWith('/originals/README.md'));
  if (original) {
    recovery.actions = [
      {
        kind: 'inspect',
        path: original,
        condition: 'Inspect the retained original README for edits that may still need merging.',
      },
      {
        kind: 'compare',
        path: plan.index.path,
        from: original,
        condition: 'Compare the current README with the retained original.',
      },
      {
        kind: 'remove-owned',
        path: original,
        condition: 'Only after confirming the current README contains all required content.',
      },
    ];
  }
  return recovery;
}

export function executeVaultWrite(
  vaultDir: string,
  requestValue: VaultWriteRequestV1,
  options: VaultWriterOptions,
): VaultWriteResultV1 {
  const operationId = crypto.randomUUID();
  let digest = '';
  let parsed: VaultWriteRequestV1;
  let minimalLayout: ResolvedVaultLayout;
  try {
    parsed = parseVaultWriteRequest(requestValue);
    digest = requestDigest(parsed);
    minimalLayout = resolveVaultLayout(vaultDir);
  } catch (error) {
    const code = errorCode(error, false);
    return codeResult(operationId, digest, code);
  }
  if (options.mode === 'preview') {
    try {
      return previewResult(operationId, planWrite(vaultDir, parsed, options.pluginRoot));
    } catch (error) {
      return codeResult(operationId, digest, errorCode(error, false));
    }
  }

  try {
    const legacyPaths = detectLegacyVaultWriterState(minimalLayout);
    if (legacyPaths.length > 0) {
      return codeResult(operationId, digest, 'LEGACY_RUNTIME_STATE', 'none', [{
        operationId: 'legacy-v1.5',
        state: 'unrecognized-operation',
        directory: '.me',
        preservedPaths: legacyPaths,
        remainingMutations: [],
        actions: legacyPaths.map(legacyPath => ({
          kind: 'inspect' as const,
          path: legacyPath,
          condition: 'Inspect legacy vault-local runtime state before removing it.',
        })),
      }]);
    }
  } catch (error) {
    return codeResult(operationId, digest, errorCode(error, false));
  }

  const operations = makeFileOperations(options);
  const layout = minimalLayout;
  const lockPath = path.join(layout.lockDir, 'vault-write.lock');
  let lockOwned: OwnedLock | undefined;
  try {
    bootstrapRuntimeRoot(layout);
    bootstrapDirectory(layout, layout.lockDir, options, operations);
    bootstrapDirectory(layout, layout.transactionDir, options, operations);
    assertSafeMutationPath(layout, lockPath, 'lock');
    if (lockExists(lockPath, operations)) {
      return codeResult(operationId, digest, 'LOCK_HELD');
    }
    const startupRecoveries = scanRecoveries(layout, operations);
    if (startupRecoveries.length > 0) {
      return codeResult(
        operationId,
        digest,
        'INCOMPLETE_OPERATION',
        'none',
        startupRecoveries,
      );
    }
    const acquisition = acquireLock(layout, lockPath, operationId, options, operations);
    if ('error' in acquisition) {
      if (acquisition.error instanceof VaultWriterError
        && acquisition.error.code === 'LOCK_HELD') {
        return codeResult(operationId, digest, 'LOCK_HELD');
      }
      const racedRecoveries = acquisition.opened ? scanRecoveries(layout, operations) : [];
      const recoveries = [
        ...racedRecoveries,
        ...(acquisition.recovery ? [acquisition.recovery] : []),
      ];
      if (recoveries.length > 0) {
        return codeResult(
          operationId,
          digest,
          acquisition.recovery ? 'RECOVERY_REQUIRED' : 'INCOMPLETE_OPERATION',
          'none',
          recoveries,
        );
      }
      return codeResult(operationId, digest, errorCode(acquisition.error, false));
    }
    lockOwned = acquisition.lock;
  } catch (error) {
    if (lockOwned) releaseOwnedLockEarly(layout, lockOwned, options, operations);
    return codeResult(operationId, digest, errorCode(error, false));
  }

  let initialPlan: PlannedWrite;
  try {
    initialPlan = planWrite(vaultDir, parsed, options.pluginRoot);
  } catch (error) {
    const released = releaseOwnedLockEarly(layout, lockOwned, options, operations);
    const racedRecoveries = scanRecoveries(layout, operations);
    if (!released) {
      const recovery = recoveryAction(
        operationId,
        '<ME_RUNTIME>/transactions',
        'ownership-conflict',
        ['<ME_RUNTIME>/locks/vault-write.lock'],
        ['Inspect the changed cooperative lock.'],
      );
      return codeResult(
        operationId,
        digest,
        'RECOVERY_REQUIRED',
        'none',
        [...racedRecoveries, recovery],
      );
    }
    if (racedRecoveries.length > 0) {
      return codeResult(
        operationId,
        digest,
        'INCOMPLETE_OPERATION',
        'none',
        racedRecoveries,
      );
    }
    return codeResult(operationId, digest, errorCode(error, false));
  }

  let plannedPaths = [
    initialPlan.target.vaultRelativePath,
    ...(initialPlan.index.action === 'none' ? [] : [initialPlan.index.path]),
  ];
  const tx = new Transaction(initialPlan, operationId, options);
  let operationDir = path.join(layout.transactionDir, `vault-write-${operationId}`);
  let stagingDir = path.join(operationDir, 'staging');
  let originalsDir = path.join(operationDir, 'originals');
  let noteStaged: OwnedFile | undefined;
  let indexStaged: OwnedFile | undefined;
  let requestCopy: OwnedFile | undefined;
  let renderedCopy: OwnedFile | undefined;
  let fingerprintCopy: OwnedFile | undefined;
  let notePublished: OwnedFile | undefined;
  let indexPublished: OwnedFile | undefined;
  let originalReadme: OwnedFile | undefined;
  let originalSnapshot: OwnedFile | undefined;
  let targetMutationStarted = false;
  let indexPreserved = false;
  let completed = false;
  let mainCode: WriterErrorCode | undefined;
  const preserved: string[] = [];
  const remaining: string[] = [];
  const recoveries: VaultWriteRecovery[] = [];
  const lateRecoveries: VaultWriteRecovery[] = [];
  let lockReleaseConflict = false;

  const markPreserved = (absolute: string, mutation: string): void => {
    preserved.push(displayRelative(layout, absolute));
    remaining.push(mutation);
  };

  const cleanupOwnedTransient = (owned: OwnedFile | undefined): void => {
    if (!owned) return;
    if (!sameOwnedLineage(owned)) {
      markPreserved(owned.path, `Inspect changed transient ${displayRelative(layout, owned.path)}.`);
      return;
    }
    try {
      tx.unlink(ownedFile(owned.path));
    } catch {
      markPreserved(owned.path, `Remove owned transient ${displayRelative(layout, owned.path)}.`);
    }
  };

  const rollback = (): void => {
    if (indexPublished) {
      if (sameOwnedFile(indexPublished)) {
        try { tx.unlink(indexPublished); } catch {
          markPreserved(indexPublished.path, 'Remove or compare the published README.');
        }
      } else {
        markPreserved(indexPublished.path, 'Compare the externally changed README.');
      }
    }
    if (indexPreserved && originalReadme) {
      const indexExists = (() => {
        try { fs.lstatSync(initialPlan.target.indexPath); return true; } catch { return false; }
      })();
      if (indexExists) {
        markPreserved(initialPlan.target.indexPath, 'Restore README only after resolving the current path.');
        markPreserved(originalReadme.path, 'Compare retained original README.');
      } else {
        try {
          tx.link(
            originalReadme.path,
            initialPlan.target.indexPath,
            originalReadme,
            fs.statSync(originalReadme.path, { bigint: true }).nlink,
          );
        } catch {
          markPreserved(originalReadme.path, 'Restore retained original README with no-clobber create.');
        }
      }
    }
    if (notePublished) {
      if (sameOwnedFile(notePublished)) {
        try { tx.unlink(notePublished); } catch {
          markPreserved(notePublished.path, 'Remove the operation-owned note.');
        }
      } else {
        markPreserved(notePublished.path, 'Compare the externally changed note.');
      }
    }
  };

  try {
    /*
     * Post-lock authoritative replan before any mutations.
     * The callback (afterAuthoritativePlan) fires here so that callers
     * like distill can re-verify external state under the lock. If the
     * callback fails, no operation directory or journal is left on disk.
     */
    initialPlan = planWrite(vaultDir, requestValue, options.pluginRoot);
    tx.plan = initialPlan;
    plannedPaths = [
      initialPlan.target.vaultRelativePath,
      ...(initialPlan.index.action === 'none' ? [] : [initialPlan.index.path]),
    ];
    tx.hooks.afterLock?.();
    const afterLockPlan = replanAfterLock(vaultDir, requestValue, options.pluginRoot);
    if (!compareFingerprints(initialPlan.fingerprint, afterLockPlan.fingerprint)) {
      throw new VaultWriterError('INPUT_CHANGED');
    }

    // Invoke caller's post-lock verification callback before any mutations.
    // Callback failure → lock released safely, no operationDir/journal on disk.
    if (options.afterAuthoritativePlan) {
      try {
        options.afterAuthoritativePlan(initialPlan);
      } catch (error) {
        throw new VaultWriterError('INPUT_CHANGED');
      }
    }

    // Now safe to create operation directory and journal.
    tx.mkdir(operationDir);
    const journalPath = path.join(operationDir, 'journal.json');
    tx.startJournal(journalPath, {
      version: 1,
      operationId,
      state: 'locked',
      notePath: initialPlan.target.vaultRelativePath,
      ...(initialPlan.index.action === 'none' ? {} : { indexPath: initialPlan.index.path }),
      requestDigest: digest,
      plannedNoteSha256: initialPlan.fingerprint.plannedNoteSha256,
      ...(initialPlan.fingerprint.plannedIndexSha256
        ? { plannedIndexSha256: initialPlan.fingerprint.plannedIndexSha256 }
        : {}),
      metadataPolicy: METADATA_POLICY,
    });
    /*
     * Bootstrap (mkdir of operationDir) changes runtime directory metadata.
     * Replan to capture the updated fingerprint for subsequent verification.
     */
    const postBootstrapPlan = planWrite(vaultDir, requestValue, options.pluginRoot);
    tx.plan = postBootstrapPlan;
    plannedPaths = [
      postBootstrapPlan.target.vaultRelativePath,
      ...(postBootstrapPlan.index.action === 'none' ? [] : [postBootstrapPlan.index.path]),
    ];
    const verifyBootstrapPlan = replanAfterLock(vaultDir, requestValue, options.pluginRoot);
    if (!compareFingerprints(postBootstrapPlan.fingerprint, verifyBootstrapPlan.fingerprint)) {
      throw new VaultWriterError('INPUT_CHANGED');
    }
    initialPlan = postBootstrapPlan;

    tx.mkdir(stagingDir);
    requestCopy = writeTransient(
      path.join(operationDir, 'request.json'),
      Buffer.from(JSON.stringify(requestValue), 'utf8'),
    );
    renderedCopy = writeTransient(
      path.join(operationDir, 'rendered.md'),
      Buffer.from(requestValue.markdown, 'utf8'),
    );
    fingerprintCopy = writeTransient(
      path.join(operationDir, 'fingerprint.json'),
      Buffer.from(JSON.stringify(initialPlan.fingerprint), 'utf8'),
    );
    noteStaged = writeTransient(path.join(stagingDir, 'note.md'), requestValue.markdown);
    fs.chmodSync(noteStaged.path, 0o666 & ~process.umask());
    noteStaged = ownedFile(noteStaged.path);
    if (initialPlan.index.action !== 'none') {
      indexStaged = writeTransient(
        path.join(stagingDir, 'README.md'),
        initialPlan.index.after as Buffer,
      );
      if (initialPlan.index.action === 'replace') {
        const mode = fs.statSync(initialPlan.target.indexPath).mode & 0o777;
        fs.chmodSync(indexStaged.path, mode);
      } else {
        fs.chmodSync(indexStaged.path, 0o666 & ~process.umask());
      }
      indexStaged = ownedFile(indexStaged.path);
    }
    tx.state('staged');
    tx.hooks.afterStaging?.();
    const afterStagingPlan = replanAfterLock(vaultDir, requestValue, options.pluginRoot);
    if (!compareFingerprints(initialPlan.fingerprint, afterStagingPlan.fingerprint)) {
      throw new VaultWriterError('INPUT_CHANGED');
    }

    tx.mkdirParents(path.dirname(initialPlan.target.notePath));
    const preflightLink = (
      staged: OwnedFile,
      destinationParent: string,
      label: string,
    ): OwnedFile => {
      const probe = path.join(
        destinationParent,
        `.me-vault-write-${operationId}-${label}.probe`,
      );
      try {
        tx.link(staged.path, probe, staged, 1n);
        const probeOwned = ownedFile(probe);
        tx.unlink(probeOwned);
      } catch (error) {
        try {
          if (fs.existsSync(probe) && sameInode(staged.path, probe)) {
            tx.unlink(ownedFile(probe));
          } else if (fs.existsSync(probe)) {
            markPreserved(probe, 'Inspect the conflicting hard-link preflight path.');
          }
        } catch {
          markPreserved(probe, 'Remove the operation-owned hard-link preflight path.');
        }
        throw error;
      }
      if (!sameOwnedLineage(staged) || fs.statSync(staged.path, { bigint: true }).nlink !== 1n) {
        throw new VaultWriterError('RECOVERY_REQUIRED');
      }
      return ownedFile(staged.path);
    };
    noteStaged = preflightLink(
      noteStaged,
      path.dirname(initialPlan.target.notePath),
      'note',
    );
    if (indexStaged) {
      indexStaged = preflightLink(
        indexStaged,
        path.dirname(initialPlan.target.indexPath),
        'index',
      );
    }
    const expectedAfterParentCreation = snapshotFingerprintPaths(initialPlan);
    tx.hooks.beforeNotePublish?.(initialPlan.target.notePath);
    /* Recheck all inputs immediately before the first publish. */
    const beforePublishPlan = planWrite(vaultDir, requestValue, options.pluginRoot);
    const expectedBeforePublish = {
      ...initialPlan.fingerprint,
      pathIdentities: expectedAfterParentCreation,
    };
    if (!compareFingerprints(expectedBeforePublish, beforePublishPlan.fingerprint)) {
      throw new VaultWriterError('INPUT_CHANGED');
    }
    targetMutationStarted = true;
    tx.link(noteStaged.path, initialPlan.target.notePath, noteStaged, 1n);
    notePublished = ownedFile(initialPlan.target.notePath);
    tx.state('note-published');
    let boundaryPaths = snapshotFingerprintPaths(initialPlan);
    tx.hooks.afterNotePublish?.(initialPlan.target.notePath);
    assertBoundaryPaths(
      boundaryPaths,
      snapshotFingerprintPaths(initialPlan),
      new Set([initialPlan.target.vaultRelativePath]),
    );
    if (!sameOwnedFileAtLinkCount(notePublished, 2n)) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    verifyStaticInputs(initialPlan, options.pluginRoot);
    verifyExternalGraph(initialPlan);

    if (initialPlan.index.action === 'replace') {
      tx.hooks.beforeIndexPreserve?.(initialPlan.target.indexPath);
      assertBoundaryPaths(
        boundaryPaths,
        snapshotFingerprintPaths(initialPlan),
        new Set([initialPlan.target.vaultRelativePath]),
      );
      const currentReadme = snapshotOptionalFile(initialPlan.target.indexPath);
      if (JSON.stringify(currentReadme) !== JSON.stringify(initialPlan.fingerprint.readme)) {
        throw new VaultWriterError('RECOVERY_REQUIRED');
      }
      tx.mkdir(originalsDir);
      originalSnapshot = ownedFile(initialPlan.target.indexPath);
      const originalPath = path.join(originalsDir, 'README.md');
      tx.rename(initialPlan.target.indexPath, originalPath, originalSnapshot);
      indexPreserved = true;
      if (!sameMovedFile(originalSnapshot, originalPath)) {
        originalReadme = ownedFile(originalPath);
        markPreserved(originalPath, 'Compare moved README with its pre-rename snapshot.');
        throw new VaultWriterError('RECOVERY_REQUIRED');
      }
      originalReadme = ownedFile(originalPath);
      tx.state('index-preserved');
      boundaryPaths = snapshotFingerprintPaths(initialPlan);
      tx.hooks.afterIndexPreserve?.(originalPath);
      assertBoundaryPaths(
        boundaryPaths,
        snapshotFingerprintPaths(initialPlan),
        new Set([initialPlan.target.vaultRelativePath]),
      );
      if (!sameOwnedFile(originalReadme)) {
        markPreserved(originalPath, 'Compare externally changed retained original README.');
        throw new VaultWriterError('RECOVERY_REQUIRED');
      }
    }

    if (initialPlan.index.action !== 'none') {
      tx.link(indexStaged!.path, initialPlan.target.indexPath, indexStaged!, 1n);
      indexPublished = ownedFile(initialPlan.target.indexPath);
      tx.state('index-published');
      boundaryPaths = snapshotFingerprintPaths(initialPlan);
      tx.hooks.afterIndexPublish?.(initialPlan.target.indexPath);
      assertBoundaryPaths(
        boundaryPaths,
        snapshotFingerprintPaths(initialPlan),
        new Set([initialPlan.target.vaultRelativePath, initialPlan.index.path]),
      );
    }

    tx.hooks.beforePostValidation?.();
    assertBoundaryPaths(
      boundaryPaths,
      snapshotFingerprintPaths(initialPlan),
      new Set([initialPlan.target.vaultRelativePath, initialPlan.index.path]),
    );
    verifyStaticInputs(initialPlan, options.pluginRoot);
    verifyExternalGraph(initialPlan);
    if (!sameOwnedFileAtLinkCount(notePublished, 2n)) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    if (
      initialPlan.index.action !== 'none'
      && !sameOwnedFileAtLinkCount(indexPublished!, 2n)
    ) {
      throw new VaultWriterError('RECOVERY_REQUIRED');
    }
    validatePostWriteGraph(initialPlan.graph, layout, initialPlan.target, initialPlan.index);
    tx.state('validated');

    tx.hooks.beforeCommitCleanup?.(operationDir);
    const cleanupStagedLink = (staged: OwnedFile | undefined, published: OwnedFile | undefined) => {
      if (!staged || !published) return;
      let links = 0n;
      try { links = fs.statSync(staged.path, { bigint: true }).nlink; } catch { /* handled below */ }
      if (
        !sameOwnedLineage(staged)
        || !sameOwnedFile(published)
        || !sameInode(staged.path, published.path)
        || links !== 2n
      ) {
        markPreserved(staged.path, `Inspect changed staging link ${displayRelative(layout, staged.path)}.`);
        return;
      }
      try {
        const publishedBefore = fs.statSync(published.path, { bigint: true });
        tx.unlink(ownedFile(staged.path));
        const publishedAfter = fs.statSync(published.path, { bigint: true });
        if (
          publishedBefore.dev !== publishedAfter.dev
          || publishedBefore.ino !== publishedAfter.ino
          || publishedBefore.nlink !== 2n
          || publishedAfter.nlink !== 1n
          || sha256(fs.readFileSync(published.path)) !== published.sha256
        ) {
          markPreserved(published.path, 'Verify published target after staging cleanup.');
        }
      } catch {
        markPreserved(staged.path, `Remove operation-owned staging link ${displayRelative(layout, staged.path)}.`);
      }
    };
    cleanupStagedLink(noteStaged, notePublished);
    cleanupStagedLink(indexStaged, indexPublished);
    cleanupOwnedTransient(requestCopy);
    cleanupOwnedTransient(renderedCopy);
    cleanupOwnedTransient(fingerprintCopy);
    try {
      if (fs.existsSync(stagingDir) && fs.readdirSync(stagingDir).length === 0) {
        tx.rmdir(tx.ownedDirectoryFor(stagingDir));
      }
    } catch {
      markPreserved(stagingDir, 'Inspect the non-empty staging directory.');
    }
    if (remaining.length > 0) throw new VaultWriterError('RECOVERY_REQUIRED');

    tx.state('committed');
    completed = true;
  } catch (error) {
    mainCode = errorCode(error, targetMutationStarted);
    if (targetMutationStarted && !completed) rollback();
    if (tx.journalConflict && tx.journalPath) {
      markPreserved(tx.journalPath, 'Inspect the replaced or modified journal.');
    }
    if (mainCode === 'RECOVERY_REQUIRED' && remaining.length === 0) {
      const foreignOriginal = path.join(originalsDir, 'README.md');
      if (fs.existsSync(foreignOriginal)) {
        markPreserved(foreignOriginal, 'Inspect the conflicting README recovery destination.');
      } else {
        markPreserved(operationDir, 'Inspect the operation directory before recovery.');
      }
    }
    if (remaining.length > 0) mainCode = 'RECOVERY_REQUIRED';
  } finally {
    if (!completed && remaining.length === 0) {
      cleanupOwnedTransient(noteStaged);
      cleanupOwnedTransient(indexStaged);
      cleanupOwnedTransient(requestCopy);
      cleanupOwnedTransient(renderedCopy);
      cleanupOwnedTransient(fingerprintCopy);
      try {
        if (fs.existsSync(stagingDir) && fs.readdirSync(stagingDir).length === 0) {
          tx.rmdir(tx.ownedDirectoryFor(stagingDir));
        }
      } catch {
        markPreserved(stagingDir, 'Inspect the replaced staging directory.');
      }
      if (originalReadme && fs.existsSync(originalReadme.path)) {
        try {
          if (
            fs.existsSync(initialPlan.target.indexPath)
            && sameOwnedLineage(originalReadme)
            && sameInode(originalReadme.path, initialPlan.target.indexPath)
            && fs.statSync(originalReadme.path, { bigint: true }).nlink >= 2n
          ) {
            tx.unlink(ownedFile(originalReadme.path));
          } else {
            markPreserved(originalReadme.path, 'Inspect the retained original README.');
          }
        } catch {
          markPreserved(originalReadme.path, 'Inspect the retained original README.');
        }
      }
      try {
        if (fs.existsSync(originalsDir) && fs.readdirSync(originalsDir).length === 0) {
          tx.rmdir(tx.ownedDirectoryFor(originalsDir));
        }
      } catch {
        markPreserved(originalsDir, 'Inspect the replaced originals directory.');
      }

      for (const directory of [...tx.createdDirectories].reverse()) {
        if (
          directory.path === operationDir
          || directory.path === stagingDir
          || directory.path === originalsDir
          || directory.path === layout.transactionDir
          || directory.path === layout.lockDir
          || directory.path === layout.meDir
        ) continue;
        const relative = path.relative(initialPlan.target.layerRoot, directory.path);
        if (
          relative
          && relative !== '..'
          && !relative.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relative)
        ) {
          try {
            if (fs.existsSync(directory.path) && fs.readdirSync(directory.path).length === 0) {
              tx.rmdir(directory);
            }
          } catch {
            markPreserved(directory.path, 'Inspect the replaced operation-created directory.');
          }
        }
      }

      if (remaining.length === 0 && tx.journalPath) {
        try {
          if (!tx.verifyJournalOwnership()) {
            throw new VaultWriterError('RECOVERY_REQUIRED');
          }
          const journalOwned = tx.closeJournal();
          if (!journalOwned) throw new VaultWriterError('RECOVERY_REQUIRED');
          tx.unlink(journalOwned);
        } catch {
          markPreserved(path.join(operationDir, 'journal.json'), 'Inspect the changed journal.');
        }
      }
      if (remaining.length === 0) {
        try {
          if (fs.existsSync(operationDir) && fs.readdirSync(operationDir).length === 0) {
            tx.rmdir(tx.ownedDirectoryFor(operationDir));
          }
        } catch {
          markPreserved(operationDir, 'Inspect the operation directory.');
        }
      }
    }

    if (lockOwned) {
      tx.hooks.beforeLockRelease?.(lockPath);
      if (tx.journalDescriptor !== undefined) {
        if (!tx.verifyJournalOwnership()) {
          markPreserved(
            path.join(operationDir, 'journal.json'),
            'Inspect the changed journal before any cleanup.',
          );
        }
        tx.closeJournal();
      }
      let lockDescriptorClosed = false;
      try {
        lockOwned.closeDescriptor(lockOwned.descriptor);
        lockDescriptorClosed = true;
      } catch {
        lockReleaseConflict = true;
        markPreserved(lockPath, 'Inspect the lock whose acquisition descriptor could not close.');
      }
      if (lockDescriptorClosed && sameOwnedFile(lockOwned.file)) {
        try { tx.unlink(lockOwned.file); } catch {
          lockReleaseConflict = true;
          markPreserved(lockPath, 'Remove the lock only if it still belongs to this operation.');
        }
      } else if (lockDescriptorClosed) {
        lockReleaseConflict = true;
        markPreserved(lockPath, 'Inspect the changed lock before removing it.');
      }
      if (lockReleaseConflict) {
        lateRecoveries.push(
          ...scanRecoveries(layout, operations)
            .filter(recovery => recovery.operationId !== operationId),
        );
      }
    }
  }

  if (remaining.length > 0) {
    recoveries.push(...lateRecoveries);
    recoveries.push(recoveryForOwnership(
      initialPlan,
      operationId,
      operationDir,
      preserved,
      remaining,
    ));
    return {
      ...codeResult(
        operationId,
        digest,
        'RECOVERY_REQUIRED',
        initialPlan.index.action,
        recoveries,
        plannedPaths,
      ),
      notePath: initialPlan.target.vaultRelativePath,
      changedPaths: [
        ...(notePublished ? [initialPlan.target.vaultRelativePath] : []),
        ...(indexPublished ? [initialPlan.index.path] : []),
      ],
      warnings: tx.warnings,
      recoveryState: 'incomplete',
    };
  }

  if (!completed) {
    return {
      ...codeResult(
        operationId,
        digest,
        mainCode ?? 'INTERNAL_ERROR',
        initialPlan.index.action,
        [],
        plannedPaths,
      ),
      warnings: tx.warnings,
    };
  }

  if (originalReadme) {
    const originalRelative = displayRelative(layout, originalReadme.path);
    const directory = displayRelative(layout, operationDir);
    recoveries.push({
      operationId,
      state: 'retained-original',
      directory,
      journal: `${directory}/journal.json`,
      preservedPaths: [originalRelative],
      remainingMutations: [],
      actions: [
        {
          kind: 'inspect',
          path: originalRelative,
          condition: 'Inspect the retained original README for edits that may still need merging.',
        },
        {
          kind: 'compare',
          path: initialPlan.index.path,
          from: originalRelative,
          condition: 'Compare the current README with the retained original.',
        },
        {
          kind: 'remove-owned',
          path: originalRelative,
          condition: 'Only after confirming the current README contains all required content.',
        },
      ],
    });
  }

  return {
    version: 1,
    status: 'committed',
    operationId,
    commitModel: 'journaled-cooperative',
    requestDigest: digest,
    notePath: initialPlan.target.vaultRelativePath,
    changedPaths: [
      initialPlan.target.vaultRelativePath,
      ...(initialPlan.index.action === 'none' ? [] : [initialPlan.index.path]),
    ],
    plannedPaths,
    indexAction: initialPlan.index.action,
    backlinks: initialPlan.suggestions.backlinks,
    unlinkedMentions: initialPlan.suggestions.unlinkedMentions,
    warnings: [
      ...tx.warnings,
      ...(originalReadme ? [METADATA_POLICY] : []),
    ],
    recoveryState: originalReadme ? 'retained-originals' : 'none',
    recoveries,
  };
}
