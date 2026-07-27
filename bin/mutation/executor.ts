import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  MutationFailure,
  type AtomicMutationPhase,
  type FilesystemMutationKind,
  type MutationAtomicOperations,
  type MutationExecutor,
  type MutationFileOperations,
  type MutationPathPolicy,
  type OwnedDirectoryFingerprint,
  type OwnedFileFingerprint,
} from './contracts';
import { createNativeMutationAtomicOperations } from './native-at';

interface OpenedDirectory {
  path: string;
  descriptor: number;
  device: bigint;
  inode: bigint;
  mode: number;
}

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
  return crypto.createHash('sha256')
    .update(Uint8Array.from(bytes))
    .digest('hex');
}

function stableDescriptor(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return before.isFile()
    && after.isFile()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.nlink === after.nlink
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function sameOwnedFile(
  actual: OwnedFileFingerprint,
  expected: OwnedFileFingerprint,
): boolean {
  return actual.device === expected.device
    && actual.inode === expected.inode
    && actual.mode === expected.mode
    && actual.linkCount === expected.linkCount
    && actual.sha256 === expected.sha256;
}

function sameOwnedDirectory(
  actual: OwnedDirectoryFingerprint,
  expected: OwnedDirectoryFingerprint,
): boolean {
  return actual.device === expected.device
    && actual.inode === expected.inode
    && actual.mode === expected.mode;
}

function assertSafe(policy: MutationPathPolicy, candidate: string): void {
  try {
    policy.assertSafe(candidate);
  } catch (error) {
    if (error instanceof MutationFailure) throw error;
    failure('UNSAFE_PATH');
  }
}

function entryName(candidate: string): string {
  const name = path.basename(candidate);
  if (!name || name === '.' || name === '..' || name.includes(path.sep)) {
    failure('UNSAFE_PATH');
  }
  return name;
}

function unsupportedAtomicError(error: unknown): boolean {
  return [
    'EXDEV',
    'EPERM',
    'ENOTSUP',
    'EOPNOTSUPP',
    'ENOSYS',
  ].includes(errno(error) ?? '');
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
  /** Test-only hooks placed immediately around descriptor-relative syscalls. */
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
  fileOps?: MutationFileOperations;
  atomicOps?: MutationAtomicOperations;
  quarantineDirectory?: string;
  directoryFsync?(directory: string): void;
}): MutationExecutor {
  const operations = options.fileOps ?? defaultFileOperations();
  const atomic = options.atomicOps ?? createNativeMutationAtomicOperations();
  let warnedDirectoryFsync = false;

  const closeDescriptor = (descriptor: number): void => {
    try {
      operations.closeSync(descriptor);
    } catch {
      // The ownership decision cannot be improved after a close failure.
    }
  };

  const openDirectory = (candidate: string): OpenedDirectory => {
    assertSafe(options.pathPolicy, candidate);
    let descriptor: number | undefined;
    try {
      const entry = operations.lstatSync(
        candidate,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!entry.isDirectory() || entry.isSymbolicLink()) failure('UNSAFE_PATH');
      descriptor = operations.openSync(
        candidate,
        fs.constants.O_RDONLY
          | fs.constants.O_DIRECTORY
          | fs.constants.O_NOFOLLOW,
      );
      const opened = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      if (
        !opened.isDirectory()
        || opened.dev !== entry.dev
        || opened.ino !== entry.ino
        || opened.mode !== entry.mode
      ) failure('UNSAFE_PATH');
      return {
        path: candidate,
        descriptor,
        device: opened.dev,
        inode: opened.ino,
        mode: Number(opened.mode & 0o777n),
      };
    } catch (error) {
      if (descriptor !== undefined) closeDescriptor(descriptor);
      if (error instanceof MutationFailure) throw error;
      failure('UNSAFE_PATH');
    }
  };

  const directoryStillNamed = (opened: OpenedDirectory): boolean => {
    try {
      const current = operations.lstatSync(
        opened.path,
        { bigint: true },
      ) as fs.BigIntStats;
      return current.isDirectory()
        && !current.isSymbolicLink()
        && current.dev === opened.device
        && current.ino === opened.inode
        && Number(current.mode & 0o777n) === opened.mode;
    } catch {
      return false;
    }
  };

  const captureFileAt = (
    parent: OpenedDirectory,
    name: string,
    logicalPath: string,
  ): OwnedFileFingerprint => {
    let descriptor: number | undefined;
    try {
      descriptor = atomic.openAt(
        parent.descriptor,
        name,
        fs.constants.O_RDONLY
          | fs.constants.O_NOFOLLOW
          | fs.constants.O_NONBLOCK,
      );
      const before = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!before.isFile()) failure('UNSAFE_PATH');
      const bytes = operations.readFileSync(descriptor) as Buffer;
      const after = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!stableDescriptor(before, after)) failure('UNSAFE_PATH');
      return {
        path: logicalPath,
        device: after.dev,
        inode: after.ino,
        mode: Number(after.mode & 0o777n),
        linkCount: after.nlink,
        sha256: sha256(bytes),
      };
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
      failure('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) closeDescriptor(descriptor);
    }
  };

  const captureDirectoryAt = (
    parent: OpenedDirectory,
    name: string,
    logicalPath: string,
  ): OwnedDirectoryFingerprint => {
    let descriptor: number | undefined;
    try {
      descriptor = atomic.openAt(
        parent.descriptor,
        name,
        fs.constants.O_RDONLY
          | fs.constants.O_DIRECTORY
          | fs.constants.O_NOFOLLOW,
      );
      const stat = operations.fstatSync(
        descriptor,
        { bigint: true },
      ) as fs.BigIntStats;
      if (!stat.isDirectory()) failure('UNSAFE_PATH');
      return {
        path: logicalPath,
        device: stat.dev,
        inode: stat.ino,
        mode: Number(stat.mode & 0o777n),
      };
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
      failure('UNSAFE_PATH');
    } finally {
      if (descriptor !== undefined) closeDescriptor(descriptor);
    }
  };

  const captureFile = (candidate: string): OwnedFileFingerprint => {
    assertSafe(options.pathPolicy, candidate);
    let entry: fs.BigIntStats;
    try {
      entry = operations.lstatSync(candidate, { bigint: true }) as fs.BigIntStats;
    } catch {
      failure('UNSAFE_PATH');
    }
    if (!entry.isFile() || entry.isSymbolicLink()) failure('UNSAFE_PATH');
    const parent = openDirectory(path.dirname(candidate));
    try {
      const first = captureFileAt(parent, entryName(candidate), candidate);
      const second = captureFileAt(parent, entryName(candidate), candidate);
      if (
        entry.dev !== first.device
        || entry.ino !== first.inode
        || Number(entry.mode & 0o777n) !== first.mode
        || entry.nlink !== first.linkCount
        || !sameOwnedFile(first, second)
        || !directoryStillNamed(parent)
      ) {
        failure('UNSAFE_PATH');
      }
      return second;
    } finally {
      closeDescriptor(parent.descriptor);
    }
  };

  const captureDirectory = (candidate: string): OwnedDirectoryFingerprint => {
    assertSafe(options.pathPolicy, candidate);
    let entry: fs.BigIntStats;
    try {
      entry = operations.lstatSync(candidate, { bigint: true }) as fs.BigIntStats;
    } catch {
      failure('UNSAFE_PATH');
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) failure('UNSAFE_PATH');
    const parent = openDirectory(path.dirname(candidate));
    try {
      const first = captureDirectoryAt(parent, entryName(candidate), candidate);
      const second = captureDirectoryAt(parent, entryName(candidate), candidate);
      if (
        entry.dev !== first.device
        || entry.ino !== first.inode
        || Number(entry.mode & 0o777n) !== first.mode
        || !sameOwnedDirectory(first, second)
        || !directoryStillNamed(parent)
      ) {
        failure('UNSAFE_PATH');
      }
      return second;
    } finally {
      closeDescriptor(parent.descriptor);
    }
  };

  const syncOpenedDirectory = (opened: OpenedDirectory): void => {
    try {
      if (options.directoryFsync) {
        options.directoryFsync(opened.path);
      } else {
        operations.fsyncSync(opened.descriptor);
      }
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(errno(error) ?? '')) throw error;
      if (!warnedDirectoryFsync) {
        warnedDirectoryFsync = true;
        options.hooks?.onWarning?.('DIRECTORY_FSYNC_UNSUPPORTED');
      }
    }
    if (!directoryStillNamed(opened)) failure('UNSAFE_PATH');
  };

  const syncDirectory = (directory: string): void => {
    const opened = openDirectory(directory);
    try {
      syncOpenedDirectory(opened);
    } finally {
      closeDescriptor(opened.descriptor);
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
    for (const directory of new Set(paths.map(candidate => path.dirname(candidate)))) {
      syncDirectory(directory);
    }
    options.journal.afterMutation(kind, paths);
    return result;
  };

  const aroundAtomic = <T>(
    kind: FilesystemMutationKind,
    phase: AtomicMutationPhase,
    paths: readonly string[],
    action: () => T,
    afterSuccess?: () => void,
  ): T => {
    options.atomicHooks?.beforeAtomicMutation?.(kind, phase, paths);
    const result = action();
    try {
      afterSuccess?.();
      options.atomicHooks?.afterAtomicMutation?.(kind, phase, paths);
    } catch {
      failure('OWNERSHIP_LOST');
    }
    return result;
  };

  const requireQuarantine = (): string => {
    if (!options.quarantineDirectory) failure('UNSUPPORTED_FILESYSTEM');
    assertSafe(options.pathPolicy, options.quarantineDirectory);
    return options.quarantineDirectory;
  };

  const openQuarantine = (): OpenedDirectory => {
    const quarantine = openDirectory(requireQuarantine());
    if (quarantine.mode !== 0o700) {
      closeDescriptor(quarantine.descriptor);
      failure('UNSAFE_PATH');
    }
    return quarantine;
  };

  const quarantineName = (): string =>
    `.me-quarantine-${crypto.randomBytes(16).toString('hex')}`;

  const moveToQuarantine = (
    kind: 'rename' | 'unlink' | 'rmdir',
    sourceParent: OpenedDirectory,
    sourcePath: string,
    quarantine: OpenedDirectory,
    additionallySync?: OpenedDirectory,
  ): { name: string; logicalPath: string } => {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const name = quarantineName();
      const logicalPath = path.join(quarantine.path, name);
      try {
        aroundAtomic(
          kind,
          'quarantine',
          [sourcePath, logicalPath],
          () => atomic.renameNoReplaceAt(
            sourceParent.descriptor,
            entryName(sourcePath),
            quarantine.descriptor,
            name,
          ),
          () => {
            const opened = additionallySync
              ? [sourceParent, quarantine, additionallySync]
              : [sourceParent, quarantine];
            for (const directory of new Map(
              opened.map(item => [item.descriptor, item]),
            ).values()) {
              syncOpenedDirectory(directory);
            }
          },
        );
        return { name, logicalPath };
      } catch (error) {
        if (error instanceof MutationFailure) throw error;
        if (errno(error) === 'EEXIST') continue;
        if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errno(error) ?? '')) {
          failure('OWNERSHIP_LOST');
        }
        throw error;
      }
    }
    failure('OWNERSHIP_LOST');
  };

  const quarantineFile = (
    kind: 'rename' | 'unlink',
    sourceParent: OpenedDirectory,
    source: OwnedFileFingerprint,
    additionallySync?: OpenedDirectory,
  ): void => {
    const quarantine = openQuarantine();
    try {
      const { name, logicalPath: logicalQuarantine } = moveToQuarantine(
        kind,
        sourceParent,
        source.path,
        quarantine,
        additionallySync,
      );
      let quarantined: OwnedFileFingerprint;
      try {
        quarantined = captureFileAt(quarantine, name, logicalQuarantine);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sameOwnedFile(quarantined, source)
        || !directoryStillNamed(sourceParent)
        || !directoryStillNamed(quarantine)
      ) failure('OWNERSHIP_LOST');
      try {
        atomic.unlinkAt(quarantine.descriptor, name, false);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      syncDirectory(quarantine.path);
    } finally {
      closeDescriptor(quarantine.descriptor);
    }
  };

  const quarantineDirectory = (
    sourceParent: OpenedDirectory,
    source: OwnedDirectoryFingerprint,
  ): void => {
    const quarantinePath = requireQuarantine();
    if (path.resolve(source.path) === path.resolve(quarantinePath)) {
      failure('OWNERSHIP_LOST');
    }
    const quarantine = openQuarantine();
    try {
      const { name, logicalPath: logicalQuarantine } = moveToQuarantine(
        'rmdir',
        sourceParent,
        source.path,
        quarantine,
      );
      let quarantined: OwnedDirectoryFingerprint;
      try {
        quarantined = captureDirectoryAt(quarantine, name, logicalQuarantine);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sameOwnedDirectory(quarantined, source)
        || !directoryStillNamed(sourceParent)
        || !directoryStillNamed(quarantine)
      ) failure('OWNERSHIP_LOST');
      try {
        atomic.unlinkAt(quarantine.descriptor, name, true);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      syncDirectory(quarantine.path);
    } finally {
      closeDescriptor(quarantine.descriptor);
    }
  };

  const executor: MutationExecutor = {
    captureFile,
    captureDirectory,

    mkdir(candidate, mode) {
      return boundary('mkdir', [candidate], () => {
        const parent = openDirectory(path.dirname(candidate));
        try {
          try {
            aroundAtomic('mkdir', 'create', [candidate], () =>
              atomic.mkdirAt(parent.descriptor, entryName(candidate), mode));
          } catch (error) {
            if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
            if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
            throw error;
          }
          const owned = captureDirectoryAt(parent, entryName(candidate), candidate);
          let named: fs.BigIntStats;
          try {
            named = operations.lstatSync(
              candidate,
              { bigint: true },
            ) as fs.BigIntStats;
          } catch {
            failure('UNSAFE_PATH');
          }
          if (
            !named.isDirectory()
            || named.isSymbolicLink()
            || named.dev !== owned.device
            || named.ino !== owned.inode
            || Number(named.mode & 0o777n) !== owned.mode
            || !directoryStillNamed(parent)
          ) failure('UNSAFE_PATH');
          return owned;
        } finally {
          closeDescriptor(parent.descriptor);
        }
      });
    },

    link(source, destination) {
      return boundary('link', [source.path, destination], () => {
        const sourceParent = openDirectory(path.dirname(source.path));
        let destinationParent: OpenedDirectory | undefined;
        try {
          destinationParent = openDirectory(path.dirname(destination));
          const current = captureFileAt(
            sourceParent,
            entryName(source.path),
            source.path,
          );
          if (!sameOwnedFile(current, source)) failure('SOURCE_CHANGED');
          const sourceStat = operations.statSync(
            source.path,
            { bigint: true },
          ) as fs.BigIntStats;
          const destinationStat = operations.statSync(
            path.dirname(destination),
            { bigint: true },
          ) as fs.BigIntStats;
          if (sourceStat.dev !== destinationStat.dev) failure('UNSUPPORTED_FILESYSTEM');
          try {
            aroundAtomic('link', 'publish', [source.path, destination], () =>
              atomic.linkAt(
                sourceParent.descriptor,
                entryName(source.path),
                destinationParent.descriptor,
                entryName(destination),
              ));
          } catch (error) {
            if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
            if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
            throw error;
          }
          const expected = { ...source, linkCount: source.linkCount + 1n };
          const updatedSource = captureFileAt(
            sourceParent,
            entryName(source.path),
            source.path,
          );
          const linked = captureFileAt(
            destinationParent,
            entryName(destination),
            destination,
          );
          if (
            !sameOwnedFile(updatedSource, expected)
            || !sameOwnedFile(linked, { ...expected, path: destination })
            || !directoryStillNamed(sourceParent)
            || !directoryStillNamed(destinationParent)
          ) failure('OWNERSHIP_LOST');
          return linked;
        } finally {
          closeDescriptor(sourceParent.descriptor);
          if (destinationParent) closeDescriptor(destinationParent.descriptor);
        }
      });
    },

    rename(source, destination) {
      return boundary('rename', [source.path, destination], () => {
        const sourceParent = openDirectory(path.dirname(source.path));
        let destinationParent: OpenedDirectory | undefined;
        try {
          destinationParent = openDirectory(path.dirname(destination));
          const current = captureFileAt(
            sourceParent,
            entryName(source.path),
            source.path,
          );
          if (!sameOwnedFile(current, source)) failure('SOURCE_CHANGED');
          const sourceStat = operations.statSync(
            source.path,
            { bigint: true },
          ) as fs.BigIntStats;
          const destinationStat = operations.statSync(
            path.dirname(destination),
            { bigint: true },
          ) as fs.BigIntStats;
          if (sourceStat.dev !== destinationStat.dev) failure('UNSUPPORTED_FILESYSTEM');
          try {
            aroundAtomic('rename', 'publish', [source.path, destination], () =>
              atomic.linkAt(
                sourceParent.descriptor,
                entryName(source.path),
                destinationParent.descriptor,
                entryName(destination),
              ));
          } catch (error) {
            if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
            if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
            throw error;
          }
          const linkedSource = { ...source, linkCount: source.linkCount + 1n };
          const published = captureFileAt(
            destinationParent,
            entryName(destination),
            destination,
          );
          const sourceAfterLink = captureFileAt(
            sourceParent,
            entryName(source.path),
            source.path,
          );
          if (
            !sameOwnedFile(published, { ...linkedSource, path: destination })
            || !sameOwnedFile(sourceAfterLink, linkedSource)
            || !directoryStillNamed(sourceParent)
            || !directoryStillNamed(destinationParent)
          ) failure('OWNERSHIP_LOST');
          quarantineFile('rename', sourceParent, linkedSource, destinationParent);
          const moved = captureFileAt(
            destinationParent,
            entryName(destination),
            destination,
          );
          if (!sameOwnedFile(moved, { ...source, path: destination })) {
            failure('OWNERSHIP_LOST');
          }
          return moved;
        } finally {
          closeDescriptor(sourceParent.descriptor);
          if (destinationParent) closeDescriptor(destinationParent.descriptor);
        }
      });
    },

    unlink(source) {
      boundary('unlink', [source.path], () => {
        const parent = openDirectory(path.dirname(source.path));
        try {
          const current = captureFileAt(parent, entryName(source.path), source.path);
          if (!sameOwnedFile(current, source)) failure('OWNERSHIP_LOST');
          quarantineFile('unlink', parent, source);
        } finally {
          closeDescriptor(parent.descriptor);
        }
      });
    },

    rmdir(source) {
      boundary('rmdir', [source.path], () => {
        const parent = openDirectory(path.dirname(source.path));
        try {
          const current = captureDirectoryAt(parent, entryName(source.path), source.path);
          if (!sameOwnedDirectory(current, source)) failure('OWNERSHIP_LOST');
          quarantineDirectory(parent, source);
        } finally {
          closeDescriptor(parent.descriptor);
        }
      });
    },
  };
  return executor;
}
