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

interface OpenedFile {
  descriptor: number;
  fingerprint: OwnedFileFingerprint;
  bytes: Buffer;
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
    fchmodSync: fs.fchmodSync,
    fstatSync: fs.fstatSync,
    ftruncateSync: fs.ftruncateSync,
    fsyncSync: fs.fsyncSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
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
  retirementDirectory?: string;
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

  const openFileAt = (
    parent: OpenedDirectory,
    name: string,
    logicalPath: string,
    flags: number,
  ): OpenedFile => {
    let descriptor: number | undefined;
    try {
      descriptor = atomic.openAt(
        parent.descriptor,
        name,
        flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
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
      const named = operations.lstatSync(
        logicalPath,
        { bigint: true },
      ) as fs.BigIntStats;
      if (
        !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== after.dev
        || named.ino !== after.ino
        || named.mode !== after.mode
        || named.nlink !== after.nlink
      ) failure('UNSAFE_PATH');
      return {
        descriptor,
        bytes,
        fingerprint: {
          path: logicalPath,
          device: after.dev,
          inode: after.ino,
          mode: Number(after.mode & 0o777n),
          linkCount: after.nlink,
          sha256: sha256(bytes),
        },
      };
    } catch (error) {
      if (descriptor !== undefined) closeDescriptor(descriptor);
      if (error instanceof MutationFailure) throw error;
      if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
      failure('UNSAFE_PATH');
    }
  };

  const captureFileAt = (
    parent: OpenedDirectory,
    name: string,
    logicalPath: string,
  ): OwnedFileFingerprint => {
    const opened = openFileAt(parent, name, logicalPath, fs.constants.O_RDONLY);
    try {
      return opened.fingerprint;
    } finally {
      closeDescriptor(opened.descriptor);
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
      const named = operations.lstatSync(
        logicalPath,
        { bigint: true },
      ) as fs.BigIntStats;
      if (
        !named.isDirectory()
        || named.isSymbolicLink()
        || named.dev !== stat.dev
        || named.ino !== stat.ino
        || named.mode !== stat.mode
      ) failure('UNSAFE_PATH');
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

  const requireRetirement = (): string => {
    if (!options.retirementDirectory) failure('UNSUPPORTED_FILESYSTEM');
    assertSafe(options.pathPolicy, options.retirementDirectory);
    return options.retirementDirectory;
  };

  const openRetirement = (): OpenedDirectory => {
    const retirement = openDirectory(requireRetirement());
    if (retirement.mode !== 0o700) {
      closeDescriptor(retirement.descriptor);
      failure('UNSAFE_PATH');
    }
    return retirement;
  };

  const retirementName = (): string =>
    `.me-retired-${crypto.randomBytes(16).toString('hex')}`;

  const moveToRetirement = (
    kind: FilesystemMutationKind,
    sourceParent: OpenedDirectory,
    sourcePath: string,
    retirement: OpenedDirectory,
    additionallySync?: OpenedDirectory,
  ): { name: string; logicalPath: string } => {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const name = retirementName();
      const logicalPath = path.join(retirement.path, name);
      try {
        aroundAtomic(
          kind,
          'retirement',
          [sourcePath, logicalPath],
          () => atomic.renameNoReplaceAt(
            sourceParent.descriptor,
            entryName(sourcePath),
            retirement.descriptor,
            name,
          ),
          () => {
            const opened = additionallySync
              ? [sourceParent, retirement, additionallySync]
              : [sourceParent, retirement];
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
        failure('OWNERSHIP_LOST');
      }
    }
    failure('OWNERSHIP_LOST');
  };

  const retireFile = (
    kind: FilesystemMutationKind,
    sourceParent: OpenedDirectory,
    source: OwnedFileFingerprint,
    additionallySync?: OpenedDirectory,
  ): void => {
    if (source.linkCount !== 1n) failure('OWNERSHIP_LOST');
    const retirement = openRetirement();
    let opened: OpenedFile | undefined;
    try {
      try {
        opened = openFileAt(
          sourceParent,
          entryName(source.path),
          source.path,
          fs.constants.O_RDWR,
        );
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (!sameOwnedFile(opened.fingerprint, source)) failure('OWNERSHIP_LOST');
      const { name, logicalPath } = moveToRetirement(
        kind,
        sourceParent,
        source.path,
        retirement,
        additionallySync,
      );
      let retired: OwnedFileFingerprint;
      try {
        retired = captureFileAt(retirement, name, logicalPath);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sameOwnedFile(retired, source)
        || !directoryStillNamed(sourceParent)
        || !directoryStillNamed(retirement)
      ) failure('OWNERSHIP_LOST');
      try {
        operations.ftruncateSync(opened.descriptor, 0);
        operations.fsyncSync(opened.descriptor);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      let sanitized: fs.BigIntStats;
      let named: fs.BigIntStats;
      try {
        sanitized = operations.fstatSync(
          opened.descriptor,
          { bigint: true },
        ) as fs.BigIntStats;
        named = operations.lstatSync(logicalPath, { bigint: true }) as fs.BigIntStats;
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sanitized.isFile()
        || sanitized.dev !== source.device
        || sanitized.ino !== source.inode
        || sanitized.nlink !== 1n
        || sanitized.size !== 0n
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== sanitized.dev
        || named.ino !== sanitized.ino
        || named.size !== 0n
        || !directoryStillNamed(retirement)
      ) failure('OWNERSHIP_LOST');
    } finally {
      if (opened) closeDescriptor(opened.descriptor);
      closeDescriptor(retirement.descriptor);
    }
  };

  const retireDirectory = (
    sourceParent: OpenedDirectory,
    source: OwnedDirectoryFingerprint,
  ): void => {
    const retirementPath = requireRetirement();
    if (path.resolve(source.path) === path.resolve(retirementPath)) {
      failure('OWNERSHIP_LOST');
    }
    try {
      if ((operations.readdirSync(source.path) as string[]).length !== 0) {
        failure('OWNERSHIP_LOST');
      }
    } catch (error) {
      if (error instanceof MutationFailure) throw error;
      failure('OWNERSHIP_LOST');
    }
    const retirement = openRetirement();
    try {
      const { name, logicalPath } = moveToRetirement(
        'rmdir',
        sourceParent,
        source.path,
        retirement,
      );
      let retired: OwnedDirectoryFingerprint;
      try {
        retired = captureDirectoryAt(retirement, name, logicalPath);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      let remainsEmpty: boolean;
      try {
        remainsEmpty = (operations.readdirSync(logicalPath) as string[]).length === 0;
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sameOwnedDirectory(retired, source)
        || !remainsEmpty
        || !directoryStillNamed(sourceParent)
        || !directoryStillNamed(retirement)
      ) failure('OWNERSHIP_LOST');
    } finally {
      closeDescriptor(retirement.descriptor);
    }
  };

  const publishCopy = (
    kind: 'link' | 'rename',
    sourceParent: OpenedDirectory,
    source: OwnedFileFingerprint,
    destinationParent: OpenedDirectory,
    destination: string,
  ): OwnedFileFingerprint => {
    let openedSource: OpenedFile;
    try {
      openedSource = openFileAt(
        sourceParent,
        entryName(source.path),
        source.path,
        fs.constants.O_RDONLY,
      );
    } catch (error) {
      if (
        error instanceof MutationFailure
        && error.code === 'UNSUPPORTED_FILESYSTEM'
      ) throw error;
      failure('SOURCE_CHANGED');
    }
    let temporaryDescriptor: number | undefined;
    let temporaryName: string | undefined;
    let temporaryPath: string | undefined;
    let temporaryDevice: bigint | undefined;
    let temporaryInode: bigint | undefined;
    let published = false;
    const inspectOwnedTemporary = (): fs.BigIntStats => {
      if (
        temporaryDescriptor === undefined
        || temporaryDevice === undefined
        || temporaryInode === undefined
      ) failure('OWNERSHIP_LOST');
      let stat: fs.BigIntStats;
      try {
        stat = operations.fstatSync(
          temporaryDescriptor,
          { bigint: true },
        ) as fs.BigIntStats;
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !stat.isFile()
        || stat.dev !== temporaryDevice
        || stat.ino !== temporaryInode
      ) failure('OWNERSHIP_LOST');
      return stat;
    };
    const temporaryNameStillOwned = (): boolean => {
      if (
        temporaryPath === undefined
        || temporaryDevice === undefined
        || temporaryInode === undefined
      ) return false;
      try {
        const named = operations.lstatSync(
          temporaryPath,
          { bigint: true },
        ) as fs.BigIntStats;
        return named.isFile()
          && !named.isSymbolicLink()
          && named.dev === temporaryDevice
          && named.ino === temporaryInode;
      } catch {
        return false;
      }
    };
    const sanitizeOwnedTemporary = (): OwnedFileFingerprint => {
      if (temporaryDescriptor === undefined || temporaryPath === undefined) {
        failure('OWNERSHIP_LOST');
      }
      try {
        operations.ftruncateSync(temporaryDescriptor, 0);
        operations.fsyncSync(temporaryDescriptor);
      } catch {
        failure('OWNERSHIP_LOST');
      }
      const sanitized = inspectOwnedTemporary();
      if (sanitized.size !== 0n) failure('OWNERSHIP_LOST');
      return {
        path: temporaryPath,
        device: sanitized.dev,
        inode: sanitized.ino,
        mode: Number(sanitized.mode & 0o777n),
        linkCount: sanitized.nlink,
        sha256: sha256(Buffer.alloc(0)),
      };
    };
    try {
      if (!sameOwnedFile(openedSource.fingerprint, source)) {
        failure('SOURCE_CHANGED');
      }
      if (openedSource.fingerprint.device !== destinationParent.device) {
        failure('UNSUPPORTED_FILESYSTEM');
      }

      for (let attempt = 0; attempt < 128; attempt += 1) {
        temporaryName = `.me-publish-${crypto.randomBytes(16).toString('hex')}`;
        temporaryPath = path.join(destinationParent.path, temporaryName);
        try {
          temporaryDescriptor = atomic.openAt(
            destinationParent.descriptor,
            temporaryName,
            fs.constants.O_RDWR
              | fs.constants.O_CREAT
              | fs.constants.O_EXCL
              | fs.constants.O_NOFOLLOW,
            0o600,
          );
          const created = operations.fstatSync(
            temporaryDescriptor,
            { bigint: true },
          ) as fs.BigIntStats;
          if (
            !created.isFile()
            || created.dev !== destinationParent.device
            || created.nlink !== 1n
          ) failure('OWNERSHIP_LOST');
          temporaryDevice = created.dev;
          temporaryInode = created.ino;
          break;
        } catch (error) {
          if (errno(error) === 'EEXIST') continue;
          if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
          throw error;
        }
      }
      if (
        temporaryDescriptor === undefined
        || temporaryName === undefined
        || temporaryPath === undefined
      ) failure('OWNERSHIP_LOST');

      try {
        operations.fchmodSync(temporaryDescriptor, source.mode);
        operations.writeFileSync(
          temporaryDescriptor,
          Uint8Array.from(openedSource.bytes),
        );
        operations.fsyncSync(temporaryDescriptor);
      } catch {
        failure('OWNERSHIP_LOST');
      }

      const temporary = inspectOwnedTemporary();
      if (
        temporary.dev !== source.device
        || Number(temporary.mode & 0o777n) !== source.mode
        || temporary.nlink !== 1n
        || temporary.size !== BigInt(openedSource.bytes.length)
        || !temporaryNameStillOwned()
      ) failure('OWNERSHIP_LOST');

      try {
        aroundAtomic(
          kind,
          'publish',
          [source.path, destination],
          () => {
            if (!temporaryNameStillOwned()) failure('OWNERSHIP_LOST');
            atomic.renameNoReplaceAt(
              destinationParent.descriptor,
              temporaryName!,
              destinationParent.descriptor,
              entryName(destination),
            );
            published = true;
          },
          () => syncOpenedDirectory(destinationParent),
        );
      } catch (error) {
        if (error instanceof MutationFailure) throw error;
        if (errno(error) === 'EEXIST') failure('TARGET_EXISTS');
        if (unsupportedAtomicError(error)) failure('UNSUPPORTED_FILESYSTEM');
        failure('OWNERSHIP_LOST');
      }

      let currentSource: OwnedFileFingerprint;
      let copied: OwnedFileFingerprint;
      try {
        currentSource = captureFileAt(
          sourceParent,
          entryName(source.path),
          source.path,
        );
        copied = captureFileAt(
          destinationParent,
          entryName(destination),
          destination,
        );
      } catch {
        failure('OWNERSHIP_LOST');
      }
      if (
        !sameOwnedFile(currentSource, source)
        || copied.device !== source.device
        || copied.inode !== temporaryInode
        || copied.inode === source.inode
        || copied.mode !== source.mode
        || copied.linkCount !== 1n
        || copied.sha256 !== source.sha256
        || !directoryStillNamed(sourceParent)
        || !directoryStillNamed(destinationParent)
      ) failure('OWNERSHIP_LOST');
      return copied;
    } catch (error) {
      if (
        !published
        && temporaryDescriptor !== undefined
        && temporaryName !== undefined
        && temporaryPath !== undefined
      ) {
        try {
          const sanitized = sanitizeOwnedTemporary();
          if (!temporaryNameStillOwned()) failure('OWNERSHIP_LOST');
          retireFile(kind, destinationParent, sanitized);
        } catch {
          failure('OWNERSHIP_LOST');
        }
      }
      throw error;
    } finally {
      if (temporaryDescriptor !== undefined) closeDescriptor(temporaryDescriptor);
      closeDescriptor(openedSource.descriptor);
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
          return publishCopy(
            'link',
            sourceParent,
            source,
            destinationParent,
            destination,
          );
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
          const copied = publishCopy(
            'rename',
            sourceParent,
            source,
            destinationParent,
            destination,
          );
          retireFile('rename', sourceParent, source, destinationParent);
          const published = captureFileAt(
            destinationParent,
            entryName(destination),
            destination,
          );
          if (!sameOwnedFile(published, copied)) {
            failure('OWNERSHIP_LOST');
          }
          return published;
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
          retireFile('unlink', parent, source);
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
          retireDirectory(parent, source);
        } finally {
          closeDescriptor(parent.descriptor);
        }
      });
    },
  };
  return executor;
}
