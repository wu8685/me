import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  MutationFailure,
  type FilesystemMutationKind,
  type MutationExecutor,
  type MutationFileOperations,
  type MutationPathPolicy,
  type OwnedDirectoryFingerprint,
  type OwnedFileFingerprint,
} from './contracts';

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function failure(code: ConstructorParameters<typeof MutationFailure>[0]): never {
  throw new MutationFailure(code);
}

function defaultFileOperations(): MutationFileOperations {
  return {
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    fsyncSync: fs.fsyncSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    linkSync: fs.linkSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
    mkdirSync: fs.mkdirSync,
    rmdirSync: fs.rmdirSync,
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameOpenFile(
  entry: fs.BigIntStats,
  opened: fs.BigIntStats,
): boolean {
  return entry.isFile()
    && !entry.isSymbolicLink()
    && opened.isFile()
    && entry.dev === opened.dev
    && entry.ino === opened.ino
    && entry.mode === opened.mode
    && entry.size === opened.size
    && entry.nlink === opened.nlink;
}

function stableDescriptor(
  before: fs.BigIntStats,
  after: fs.BigIntStats,
): boolean {
  return sameOpenFile(before, after)
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function assertSafe(policy: MutationPathPolicy, candidate: string): void {
  try {
    policy.assertSafe(candidate);
  } catch (error) {
    if (error instanceof MutationFailure) throw error;
    failure('UNSAFE_PATH');
  }
}

function sameFile(
  operations: MutationFileOperations,
  expected: OwnedFileFingerprint,
): boolean {
  try {
    const stat = operations.lstatSync(expected.path, { bigint: true }) as fs.BigIntStats;
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.dev === expected.device
      && stat.ino === expected.inode
      && Number(stat.mode & 0o777n) === expected.mode
      && stat.nlink === expected.linkCount
      && sha256(operations.readFileSync(expected.path) as Buffer) === expected.sha256;
  } catch {
    return false;
  }
}

function sameDirectory(
  operations: MutationFileOperations,
  expected: OwnedDirectoryFingerprint,
): boolean {
  try {
    const stat = operations.lstatSync(expected.path, { bigint: true }) as fs.BigIntStats;
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.dev === expected.device
      && stat.ino === expected.inode
      && Number(stat.mode & 0o777n) === expected.mode;
  } catch {
    return false;
  }
}

function destinationAbsent(
  operations: MutationFileOperations,
  destination: string,
): void {
  try {
    operations.lstatSync(destination);
    failure('TARGET_EXISTS');
  } catch (error) {
    if (error instanceof MutationFailure) throw error;
    if (errno(error) !== 'ENOENT') failure('UNSAFE_PATH');
  }
}

export function createMutationExecutor(options: {
  pathPolicy: MutationPathPolicy;
  journal: {
    beforeMutation(kind: FilesystemMutationKind, paths: readonly string[]): void;
    afterMutation(kind: FilesystemMutationKind, paths: readonly string[]): void;
  };
  hooks?: {
    beforeFilesystemMutation?(
      kind: FilesystemMutationKind,
      paths: readonly string[],
    ): void;
    onWarning?(code: 'DIRECTORY_FSYNC_UNSUPPORTED'): void;
  };
  fileOps?: MutationFileOperations;
  directoryFsync?(directory: string): void;
}): MutationExecutor {
  const operations = options.fileOps ?? defaultFileOperations();
  let warnedDirectoryFsync = false;

  const captureFile = (candidate: string): OwnedFileFingerprint => {
    assertSafe(options.pathPolicy, candidate);
    let descriptor: number | undefined;
    try {
      const entryBefore = operations.lstatSync(
        candidate,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) failure('UNSAFE_PATH');
      descriptor = operations.openSync(
        candidate,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const openedBefore = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!sameOpenFile(entryBefore, openedBefore)) failure('UNSAFE_PATH');
      const bytes = operations.readFileSync(descriptor) as Buffer;
      const openedAfter = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      const entryAfter = operations.lstatSync(
        candidate,
        { bigint: true },
      ) as fs.BigIntStats;
      if (
        !sameOpenFile(entryAfter, openedAfter)
        || !stableDescriptor(openedBefore, openedAfter)
      ) failure('UNSAFE_PATH');
      return {
        path: candidate,
        device: openedAfter.dev,
        inode: openedAfter.ino,
        mode: Number(openedAfter.mode & 0o777n),
        linkCount: openedAfter.nlink,
        sha256: sha256(bytes),
      };
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      failure('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) {
        try {
          operations.closeSync(descriptor);
        } catch {
          // A failed close cannot change the captured ownership proof.
        }
      }
    }
  };

  const captureDirectory = (candidate: string): OwnedDirectoryFingerprint => {
    assertSafe(options.pathPolicy, candidate);
    let stat: fs.BigIntStats;
    try {
      stat = operations.lstatSync(candidate, { bigint: true }) as fs.BigIntStats;
    } catch {
      failure('UNSAFE_PATH');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) failure('UNSAFE_PATH');
    return {
      path: candidate,
      device: stat.dev,
      inode: stat.ino,
      mode: Number(stat.mode & 0o777n),
    };
  };

  const syncDirectory = (directory: string): void => {
    let descriptor: number | undefined;
    try {
      if (options.directoryFsync) {
        options.directoryFsync(directory);
      } else {
        descriptor = operations.openSync(directory, 'r');
        operations.fsyncSync(descriptor);
      }
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(errno(error) ?? '')) throw error;
      if (!warnedDirectoryFsync) {
        warnedDirectoryFsync = true;
        options.hooks?.onWarning?.('DIRECTORY_FSYNC_UNSUPPORTED');
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          operations.closeSync(descriptor);
        } catch {
          // The mutation already completed; callers retain their journal.
        }
      }
    }
  };

  const boundary = <T>(
    kind: FilesystemMutationKind,
    paths: readonly string[],
    mutate: () => T,
  ): T => {
    options.journal.beforeMutation(kind, paths);
    options.hooks?.beforeFilesystemMutation?.(kind, paths);
    for (const candidate of paths) assertSafe(options.pathPolicy, candidate);
    const result = mutate();
    options.journal.afterMutation(kind, paths);
    for (const directory of new Set(paths.map(candidate => path.dirname(candidate)))) {
      syncDirectory(directory);
    }
    return result;
  };

  const executor: MutationExecutor = {
    captureFile,
    captureDirectory,

    mkdir(candidate, mode) {
      return boundary('mkdir', [candidate], () => {
        destinationAbsent(operations, candidate);
        try {
          operations.mkdirSync(candidate, { mode });
        } catch (error) {
          if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
          throw error;
        }
        return captureDirectory(candidate);
      });
    },

    link(source, destination) {
      return boundary('link', [source.path, destination], () => {
        if (!sameFile(operations, source)) failure('SOURCE_CHANGED');
        destinationAbsent(operations, destination);
        const sourceStat = operations.statSync(
          source.path,
          { bigint: true },
        ) as fs.BigIntStats;
        const destinationParent = operations.statSync(
          path.dirname(destination),
          { bigint: true },
        ) as fs.BigIntStats;
        if (sourceStat.dev !== destinationParent.dev) failure('UNSUPPORTED_FILESYSTEM');
        try {
          operations.linkSync(source.path, destination);
        } catch (error) {
          if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
          if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(errno(error) ?? '')) {
            failure('UNSUPPORTED_FILESYSTEM');
          }
          throw error;
        }
        const expectedLinkCount = source.linkCount + 1n;
        const updatedSource = { ...source, linkCount: expectedLinkCount };
        if (!sameFile(operations, updatedSource)) failure('OWNERSHIP_LOST');
        const destinationOwned = captureFile(destination);
        if (
          destinationOwned.device !== source.device
          || destinationOwned.inode !== source.inode
          || destinationOwned.linkCount !== expectedLinkCount
          || destinationOwned.sha256 !== source.sha256
        ) failure('OWNERSHIP_LOST');
        return destinationOwned;
      });
    },

    rename(source, destination) {
      return boundary('rename', [source.path, destination], () => {
        if (!sameFile(operations, source)) failure('SOURCE_CHANGED');
        destinationAbsent(operations, destination);
        const sourceStat = operations.statSync(
          source.path,
          { bigint: true },
        ) as fs.BigIntStats;
        const destinationParent = operations.statSync(
          path.dirname(destination),
          { bigint: true },
        ) as fs.BigIntStats;
        if (sourceStat.dev !== destinationParent.dev) failure('UNSUPPORTED_FILESYSTEM');
        try {
          operations.renameSync(source.path, destination);
        } catch (error) {
          if (errno(error) === 'EEXIST' || errno(error) === 'ENOTEMPTY') {
            failure('TARGET_EXISTS');
          }
          if (errno(error) === 'EXDEV') failure('UNSUPPORTED_FILESYSTEM');
          throw error;
        }
        const moved = captureFile(destination);
        if (
          moved.device !== source.device
          || moved.inode !== source.inode
          || moved.mode !== source.mode
          || moved.linkCount !== source.linkCount
          || moved.sha256 !== source.sha256
        ) failure('OWNERSHIP_LOST');
        return moved;
      });
    },

    unlink(source) {
      boundary('unlink', [source.path], () => {
        if (!sameFile(operations, source)) failure('OWNERSHIP_LOST');
        operations.unlinkSync(source.path);
      });
    },

    rmdir(source) {
      boundary('rmdir', [source.path], () => {
        if (
          !sameDirectory(operations, source)
          || (operations.readdirSync(source.path) as string[]).length !== 0
        ) failure('OWNERSHIP_LOST');
        operations.rmdirSync(source.path);
      });
    },
  };
  return executor;
}
