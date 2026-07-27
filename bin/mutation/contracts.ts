import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface SourceFingerprint {
  vaultRelativePath: string;
  type: 'missing' | 'file' | 'directory';
  sha256?: string;
  mode?: number;
}

export type PlannedMutation =
  | {
      kind: 'write-file';
      vaultRelativePath: string;
      source: SourceFingerprint;
      desiredBytes: Buffer;
      desiredSha256: string;
      desiredMode: number;
      publishOrder: number;
    }
  | {
      kind: 'mkdir';
      vaultRelativePath: string;
      source: SourceFingerprint;
      desiredMode: number;
      publishOrder: number;
    }
  | {
      kind: 'rename';
      vaultRelativePath: string;
      destinationVaultRelativePath: string;
      source: SourceFingerprint;
      destinationSource: SourceFingerprint;
      publishOrder: number;
    };

export type FilesystemMutationKind =
  | 'link'
  | 'rename'
  | 'unlink'
  | 'mkdir'
  | 'rmdir';

export type MutationFailureCode =
  | 'SOURCE_CHANGED'
  | 'TARGET_EXISTS'
  | 'OWNERSHIP_LOST'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_FILESYSTEM';

export class MutationFailure extends Error {
  readonly code: MutationFailureCode;

  constructor(code: MutationFailureCode) {
    super(code);
    this.name = 'MutationFailure';
    this.code = code;
  }
}

export interface OwnedFileFingerprint {
  path: string;
  device: bigint;
  inode: bigint;
  mode: number;
  linkCount: bigint;
  sha256: string;
}

export interface OwnedDirectoryFingerprint {
  path: string;
  device: bigint;
  inode: bigint;
  mode: number;
}

export interface MutationPathPolicy {
  assertSafe(path: string): void;
  display(path: string): string;
}

export interface MutationJournalAdapter {
  beforeMutation(kind: FilesystemMutationKind, paths: readonly string[]): void;
  afterMutation(kind: FilesystemMutationKind, paths: readonly string[]): void;
}

export interface MutationExecutorHooks {
  beforeFilesystemMutation?(
    kind: FilesystemMutationKind,
    paths: readonly string[],
  ): void;
  onWarning?(code: 'DIRECTORY_FSYNC_UNSUPPORTED'): void;
}

export interface MutationFileOperations {
  openSync: typeof fs.openSync;
  closeSync: typeof fs.closeSync;
  fstatSync: typeof fs.fstatSync;
  fsyncSync: typeof fs.fsyncSync;
  lstatSync: typeof fs.lstatSync;
  statSync: typeof fs.statSync;
  readFileSync: typeof fs.readFileSync;
  readdirSync: typeof fs.readdirSync;
  linkSync: typeof fs.linkSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  mkdirSync: typeof fs.mkdirSync;
  rmdirSync: typeof fs.rmdirSync;
}

export interface MutationExecutor {
  captureFile(path: string): OwnedFileFingerprint;
  captureDirectory(path: string): OwnedDirectoryFingerprint;
  mkdir(path: string, mode: number): OwnedDirectoryFingerprint;
  link(
    source: OwnedFileFingerprint,
    destination: string,
  ): OwnedFileFingerprint;
  rename(
    source: OwnedFileFingerprint,
    destination: string,
  ): OwnedFileFingerprint;
  unlink(source: OwnedFileFingerprint): void;
  rmdir(source: OwnedDirectoryFingerprint): void;
}

function fail(code: MutationFailureCode): never {
  throw new MutationFailure(code);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
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
  ) return false;
  const components = value.split('/');
  return !components.some(component => !component || component === '.' || component === '..');
}

function safeMode(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
}

function validFingerprint(
  value: unknown,
  expectedPath: string,
): value is SourceFingerprint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fingerprint = value as Partial<SourceFingerprint>;
  if (
    fingerprint.vaultRelativePath !== expectedPath
    || !safeRelativePath(fingerprint.vaultRelativePath)
  ) return false;
  if (fingerprint.type === 'missing') {
    return fingerprint.sha256 === undefined && fingerprint.mode === undefined;
  }
  if (fingerprint.type === 'file') {
    return /^[a-f0-9]{64}$/.test(fingerprint.sha256 ?? '')
      && safeMode(fingerprint.mode);
  }
  if (fingerprint.type === 'directory') {
    return fingerprint.sha256 === undefined && safeMode(fingerprint.mode);
  }
  return false;
}

function affectedPaths(mutation: PlannedMutation): string[] {
  return mutation.kind === 'rename'
    ? [mutation.vaultRelativePath, mutation.destinationVaultRelativePath]
    : [mutation.vaultRelativePath];
}

function overlaps(first: string, second: string): boolean {
  return first === second
    || first.startsWith(`${second}/`)
    || second.startsWith(`${first}/`);
}

export function fingerprintMutationSource(options: {
  vaultRoot: string;
  vaultRelativePath: string;
  pathPolicy: MutationPathPolicy;
}): SourceFingerprint {
  if (!safeRelativePath(options.vaultRelativePath)) fail('UNSAFE_PATH');
  const absolute = path.resolve(
    options.vaultRoot,
    ...options.vaultRelativePath.split('/'),
  );
  try {
    options.pathPolicy.assertSafe(absolute);
  } catch (error) {
    if (error instanceof MutationFailure) throw error;
    fail('UNSAFE_PATH');
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      return {
        vaultRelativePath: options.vaultRelativePath,
        type: 'missing',
      };
    }
    fail('UNSAFE_PATH');
  }
  if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
  if (stat.isFile()) {
    return {
      vaultRelativePath: options.vaultRelativePath,
      type: 'file',
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      mode: stat.mode & 0o777,
    };
  }
  if (stat.isDirectory()) {
    return {
      vaultRelativePath: options.vaultRelativePath,
      type: 'directory',
      mode: stat.mode & 0o777,
    };
  }
  fail('UNSAFE_PATH');
}

export function validatePlannedMutations(
  mutations: readonly PlannedMutation[],
): void {
  const paths: string[] = [];
  for (const mutation of mutations) {
    if (
      typeof mutation !== 'object'
      || mutation === null
      || !Number.isSafeInteger(mutation.publishOrder)
      || mutation.publishOrder < 0
      || !safeRelativePath(mutation.vaultRelativePath)
      || !validFingerprint(mutation.source, mutation.vaultRelativePath)
    ) fail('UNSAFE_PATH');

    if (mutation.kind === 'write-file') {
      if (
        !Buffer.isBuffer(mutation.desiredBytes)
        || !safeMode(mutation.desiredMode)
        || !/^[a-f0-9]{64}$/.test(mutation.desiredSha256)
        || crypto.createHash('sha256').update(mutation.desiredBytes).digest('hex')
          !== mutation.desiredSha256
      ) fail('UNSAFE_PATH');
    } else if (mutation.kind === 'mkdir') {
      if (!safeMode(mutation.desiredMode)) fail('UNSAFE_PATH');
    } else if (mutation.kind === 'rename') {
      if (
        !safeRelativePath(mutation.destinationVaultRelativePath)
        || !validFingerprint(
          mutation.destinationSource,
          mutation.destinationVaultRelativePath,
        )
        || mutation.vaultRelativePath === mutation.destinationVaultRelativePath
      ) fail('UNSAFE_PATH');
    } else {
      fail('UNSAFE_PATH');
    }

    for (const candidate of affectedPaths(mutation)) {
      if (paths.some(existing => overlaps(existing, candidate))) {
        fail('TARGET_EXISTS');
      }
      paths.push(candidate);
    }
  }
}
