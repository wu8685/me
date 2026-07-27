import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MutationFailure,
  type MutationAtomicOperations,
  type FilesystemMutationKind,
  type MutationExecutor,
  type MutationFileOperations,
  type MutationJournalAdapter,
  type MutationPathPolicy,
} from '../bin/mutation/contracts.ts';
import { createMutationExecutor } from '../bin/mutation/executor.ts';
import { createNativeMutationAtomicOperations } from '../bin/mutation/native-at.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(options: {
  journal?: MutationJournalAdapter;
  beforeFilesystemMutation?(
    kind: FilesystemMutationKind,
    paths: readonly string[],
  ): void;
  onWarning?(code: 'DIRECTORY_FSYNC_UNSUPPORTED'): void;
  fileOps?: Partial<MutationFileOperations>;
  atomicOps?: MutationAtomicOperations;
  atomicHooks?: NonNullable<
    Parameters<typeof createMutationExecutor>[0]['atomicHooks']
  >;
  directoryFsync?(directory: string): void;
  retirement?: boolean;
} = {}): {
  root: string;
  executor: MutationExecutor;
  policy: MutationPathPolicy;
  retirementDirectory?: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mutation-executor-'));
  temporaryDirectories.push(root);
  const retirementDirectory = options.retirement !== false
    ? path.join(root, 'retired')
    : undefined;
  if (retirementDirectory) fs.mkdirSync(retirementDirectory, { mode: 0o700 });
  const policy: MutationPathPolicy = {
    assertSafe(candidate) {
      const absolute = path.resolve(candidate);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        throw new Error('unsafe');
      }
      let current = absolute;
      while (current !== root) {
        try {
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error('unsafe');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        current = path.dirname(current);
      }
    },
    display(candidate) {
      return path.relative(root, candidate).split(path.sep).join('/') || '.';
    },
  };
  const defaults: MutationFileOperations = {
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
  return {
    root,
    policy,
    executor: createMutationExecutor({
      pathPolicy: policy,
      journal: options.journal ?? {
        beforeMutation() {},
        afterMutation() {},
      },
      hooks: {
        beforeFilesystemMutation: options.beforeFilesystemMutation,
        onWarning: options.onWarning,
      },
      fileOps: { ...defaults, ...options.fileOps },
      atomicHooks: options.atomicHooks,
      atomicOps: options.atomicOps,
      directoryFsync: options.directoryFsync,
      retirementDirectory,
    } as Parameters<typeof createMutationExecutor>[0]),
    retirementDirectory,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('shared filesystem mutation executor', () => {
  test('records one typed boundary around every checked primitive', () => {
    const boundaries: string[] = [];
    const { root, executor } = fixture({
      journal: {
        beforeMutation: (kind, paths) =>
          boundaries.push(`before:${kind}:${paths.join(',')}`),
        afterMutation: (kind, paths) =>
          boundaries.push(`after:${kind}:${paths.join(',')}`),
      },
      directoryFsync() {},
    });
    const directory = path.join(root, 'created');

    executor.mkdir(directory, 0o700);
    expect(boundaries).toEqual([
      `before:mkdir:${directory}`,
      `after:mkdir:${directory}`,
    ]);
  });

  test('runs typed before and after boundaries for link, rename, unlink, and rmdir', () => {
    const boundaries: string[] = [];
    const { root, executor } = fixture({
      journal: {
        beforeMutation: (kind) => boundaries.push(`before:${kind}`),
        afterMutation: (kind) => boundaries.push(`after:${kind}`),
      },
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    const linked = path.join(root, 'linked.md');
    const moved = path.join(root, 'moved.md');
    const directory = path.join(root, 'directory');
    fs.writeFileSync(source, 'bytes');

    const sourceOwned = executor.captureFile(source);
    const linkedOwned = executor.link(sourceOwned, linked);
    const movedOwned = executor.rename(linkedOwned, moved);
    executor.unlink(movedOwned);
    const directoryOwned = executor.mkdir(directory, 0o700);
    executor.rmdir(directoryOwned);

    expect(boundaries).toEqual([
      'before:link', 'after:link',
      'before:rename', 'after:rename',
      'before:unlink', 'after:unlink',
      'before:mkdir', 'after:mkdir',
      'before:rmdir', 'after:rmdir',
    ]);
  });

  test.each(
    (['link', 'rename'] as const).flatMap(primitive =>
      (['identity', 'content', 'link-count'] as const)
        .map(change => [primitive, change] as const)),
  )(
    'rejects changed source before %s after a %s change',
    (primitive, change) => {
      const { root, executor } = fixture({ directoryFsync() {} });
      const source = path.join(root, 'source.md');
      const destination = path.join(root, 'destination.md');
      fs.writeFileSync(source, 'original');
      const owned = executor.captureFile(source);
      if (change === 'identity') {
        fs.unlinkSync(source);
        fs.writeFileSync(source, 'original');
      } else if (change === 'content') {
        fs.writeFileSync(source, 'changed');
      } else {
        fs.linkSync(source, path.join(root, 'extra.md'));
      }

      expect(() => executor[primitive](owned, destination))
        .toThrow(new MutationFailure('SOURCE_CHANGED'));
      expect(fs.existsSync(destination)).toBeFalse();
    },
  );

  test('never overwrites an occupied link or rename destination', () => {
    const { root, executor } = fixture({ directoryFsync() {} });
    const source = path.join(root, 'source.md');
    const destination = path.join(root, 'destination.md');
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(destination, 'destination');

    expect(() => executor.link(executor.captureFile(source), destination))
      .toThrow(new MutationFailure('TARGET_EXISTS'));
    expect(() => executor.rename(executor.captureFile(source), destination))
      .toThrow(new MutationFailure('TARGET_EXISTS'));
    expect(fs.readFileSync(destination, 'utf8')).toBe('destination');
    expect(fs.readFileSync(source, 'utf8')).toBe('source');
  });

  test.each(['link', 'rename'] as const)(
    '%s publishes exact bytes and mode to an independent inode',
    primitive => {
      const { root, executor, retirementDirectory } = fixture({
        directoryFsync() {},
      });
      const source = path.join(root, 'source.md');
      const destination = path.join(root, 'destination.md');
      fs.writeFileSync(source, 'private source bytes', { mode: 0o640 });
      const sourceOwned = executor.captureFile(source);

      const published = executor[primitive](sourceOwned, destination);

      expect(fs.readFileSync(destination, 'utf8')).toBe('private source bytes');
      expect(fs.statSync(destination).mode & 0o777).toBe(0o640);
      expect(published.inode).not.toBe(sourceOwned.inode);
      if (primitive === 'link') {
        expect(fs.readFileSync(source, 'utf8')).toBe('private source bytes');
        expect(fs.statSync(source, { bigint: true }).nlink).toBe(1n);
      } else {
        expect(fs.existsSync(source)).toBeFalse();
        const tombstones = fs.readdirSync(retirementDirectory!);
        expect(tombstones.length).toBeGreaterThan(0);
        expect(tombstones.some(name =>
          fs.statSync(path.join(retirementDirectory!, name)).isFile()
          && fs.statSync(path.join(retirementDirectory!, name)).size === 0
        )).toBeTrue();
      }
    },
  );

  test('rename remains no-clobber when the destination appears inside the primitive', () => {
    let logicalDestination = '';
    const injectDestination = (): void => {
      if (!fs.existsSync(logicalDestination)) {
        fs.writeFileSync(logicalDestination, 'foreign');
      }
    };
    const { root, executor } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'rename' && phase === 'publish') injectDestination();
        },
      },
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    logicalDestination = path.join(root, 'destination.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.rename(
      executor.captureFile(source),
      logicalDestination,
    )).toThrow(new MutationFailure('TARGET_EXISTS'));
    expect(fs.readFileSync(logicalDestination, 'utf8')).toBe('foreign');
    expect(fs.readFileSync(source, 'utf8')).toBe('owned');
  });

  test('link cannot escape when the destination parent is replaced inside the primitive', () => {
    let replaced = false;
    let logicalParent = '';
    let outside = '';
    const { root, executor } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'link' && phase === 'publish' && !replaced) {
            replaced = true;
            fs.rmdirSync(logicalParent);
            fs.symlinkSync(outside, logicalParent);
          }
        },
      },
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    logicalParent = path.join(root, 'destination');
    outside = path.join(root, 'outside');
    fs.writeFileSync(source, 'owned');
    fs.mkdirSync(logicalParent);
    fs.mkdirSync(outside);

    expect(() => executor.link(
      executor.captureFile(source),
      path.join(logicalParent, 'published.md'),
    )).toThrow();
    expect(fs.existsSync(path.join(outside, 'published.md'))).toBeFalse();
  });

  test('rejects lost file and directory ownership before destructive cleanup', () => {
    const { root, executor } = fixture({ directoryFsync() {} });
    const file = path.join(root, 'owned.md');
    const directory = path.join(root, 'owned-dir');
    fs.writeFileSync(file, 'owned');
    fs.mkdirSync(directory);
    const ownedFile = executor.captureFile(file);
    const ownedDirectory = executor.captureDirectory(directory);
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'foreign');
    fs.rmdirSync(directory);
    fs.mkdirSync(directory);

    expect(() => executor.unlink(ownedFile))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    expect(() => executor.rmdir(ownedDirectory))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    expect(fs.readFileSync(file, 'utf8')).toBe('foreign');
    expect(fs.statSync(directory).isDirectory()).toBeTrue();
  });

  test('retires and preserves a foreign file replacement instead of unlinking it', () => {
    let source = '';
    let replaced = false;
    const replaceSource = (): void => {
      if (replaced) return;
      replaced = true;
      fs.unlinkSync(source);
      fs.writeFileSync(source, 'foreign');
    };
    const { root, executor, retirementDirectory } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'unlink' && phase === 'retirement') replaceSource();
        },
      },
      directoryFsync() {},
      retirement: true,
    });
    source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'owned');
    const owned = executor.captureFile(source);

    expect(() => executor.unlink(owned))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    const preserved = fs.readdirSync(retirementDirectory!);
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(retirementDirectory!, preserved[0]), 'utf8'))
      .toBe('foreign');
  });

  test('retires and preserves a foreign directory replacement instead of removing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mutation-rmdir-race-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'owned');
    const retirement = path.join(root, 'retired');
    fs.mkdirSync(source);
    fs.mkdirSync(retirement, { mode: 0o700 });
    let replaced = false;
    const replaceSource = (): void => {
      if (replaced) return;
      replaced = true;
      fs.rmdirSync(source);
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'foreign.txt'), 'foreign');
    };
    const guarded = createMutationExecutor({
      pathPolicy: {
        assertSafe(candidate) {
          const absolute = path.resolve(candidate);
          if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
            throw new Error('unsafe');
          }
        },
        display: candidate => path.relative(root, candidate),
      },
      journal: { beforeMutation() {}, afterMutation() {} },
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'rmdir' && phase === 'retirement') replaceSource();
        },
      },
      fileOps: {
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
      },
      directoryFsync() {},
      retirementDirectory: retirement,
    } as Parameters<typeof createMutationExecutor>[0]);
    const owned = guarded.captureDirectory(source);

    expect(() => guarded.rmdir(owned))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    const [preserved] = fs.readdirSync(retirement);
    expect(fs.readFileSync(path.join(retirement, preserved, 'foreign.txt'), 'utf8'))
      .toBe('foreign');
  });

  test('rejects symlinks and special files at capture', () => {
    const { root, executor } = fixture();
    const target = path.join(root, 'target.md');
    const link = path.join(root, 'link.md');
    const fifo = path.join(root, 'pipe');
    fs.writeFileSync(target, 'target');
    fs.symlinkSync(target, link);
    Bun.spawnSync(['mkfifo', fifo]);

    expect(() => executor.captureFile(link))
      .toThrow(new MutationFailure('UNSAFE_PATH'));
    expect(() => executor.captureFile(fifo))
      .toThrow(new MutationFailure('UNSAFE_PATH'));
  });

  test('never follows a symlink substituted between path validation and descriptor open', () => {
    let swapped = false;
    let source = '';
    let outside = '';
    const { root, executor } = fixture({
      fileOps: {
        lstatSync(candidate, options?: fs.StatSyncOptions) {
          const stat = fs.lstatSync(candidate, options as never);
          if (candidate === source && !swapped) {
            swapped = true;
            fs.unlinkSync(source);
            fs.symlinkSync(outside, source);
          }
          return stat;
        },
      } as Partial<MutationFileOperations>,
    });
    source = path.join(root, 'source.md');
    outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    temporaryDirectories.push(outside);
    fs.writeFileSync(source, 'safe');
    fs.writeFileSync(outside, 'outside');

    expect(() => executor.captureFile(source))
      .toThrow(new MutationFailure('UNSAFE_PATH'));
  });

  test.each(['link', 'rename'] as const)(
    'maps cross-filesystem %s failures to UNSUPPORTED_FILESYSTEM',
    primitive => {
      const { root, executor } = fixture({
        atomicHooks: {
          beforeAtomicMutation(kind, phase) {
            if (kind === primitive && phase === 'publish') throw errno('EXDEV');
          },
        },
        directoryFsync() {},
      });
      const source = path.join(root, 'source.md');
      const destination = path.join(root, 'destination.md');
      fs.writeFileSync(source, 'source');
      const owned = executor.captureFile(source);

      expect(() => executor[primitive](owned, destination))
        .toThrow(new MutationFailure('UNSUPPORTED_FILESYSTEM'));
      expect(fs.existsSync(destination)).toBeFalse();
    },
  );

  test('fails closed when retirement rename is unsupported', () => {
    const { root, executor, retirementDirectory } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'unlink' && phase === 'retirement') throw errno('ENOTSUP');
        },
      },
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.unlink(executor.captureFile(source)))
      .toThrow(new MutationFailure('UNSUPPORTED_FILESYSTEM'));
    expect(fs.readFileSync(source, 'utf8')).toBe('owned');
    expect(fs.readdirSync(retirementDirectory!)).toEqual([]);
  });

  test.each(['file', 'directory'] as const)(
    'native retirement no-replace preserves a colliding foreign %s',
    entryType => {
      const native = createNativeMutationAtomicOperations();
      let collisionName = '';
      let injected = false;
      const renameNames: string[] = [];
      const atomicOps: MutationAtomicOperations = {
        ...native,
        renameNoReplaceAt(sourceParent, sourceName, destinationParent, destinationName) {
          renameNames.push(destinationName);
          if (!injected) {
            injected = true;
            collisionName = destinationName;
            if (entryType === 'file') {
              const descriptor = native.openAt(
                destinationParent,
                destinationName,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
                0o600,
              );
              fs.writeSync(descriptor, 'foreign');
              fs.fchmodSync(descriptor, 0o600);
              fs.closeSync(descriptor);
            } else {
              native.mkdirAt(destinationParent, destinationName, 0o700);
            }
          }
          native.renameNoReplaceAt(
            sourceParent,
            sourceName,
            destinationParent,
            destinationName,
          );
        },
      };
      const { root, executor, retirementDirectory } = fixture({
        atomicOps,
        directoryFsync() {},
      });
      const source = path.join(root, entryType === 'file' ? 'owned.md' : 'owned-dir');
      if (entryType === 'file') fs.writeFileSync(source, 'owned');
      else fs.mkdirSync(source);

      if (entryType === 'file') executor.unlink(executor.captureFile(source));
      else executor.rmdir(executor.captureDirectory(source));

      expect(renameNames).toHaveLength(2);
      expect(renameNames[0]).not.toBe(renameNames[1]);
      expect(renameNames.every(name => /^\.me-retired-[a-f0-9]{32}$/.test(name)))
        .toBeTrue();
      const collision = path.join(retirementDirectory!, collisionName);
      if (entryType === 'file') expect(fs.readFileSync(collision, 'utf8')).toBe('foreign');
      else expect(fs.statSync(collision).isDirectory()).toBeTrue();
    },
  );

  test('native rename-no-replace never overwrites an existing entry', () => {
    const native = createNativeMutationAtomicOperations();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-native-rename-exclusive-'));
    temporaryDirectories.push(root);
    fs.writeFileSync(path.join(root, 'source'), 'owned');
    fs.writeFileSync(path.join(root, 'destination'), 'foreign');
    const descriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    let error: NodeJS.ErrnoException | undefined;
    try {
      try {
        native.renameNoReplaceAt(descriptor, 'source', descriptor, 'destination');
      } catch (caught) {
        error = caught as NodeJS.ErrnoException;
      }
    } finally {
      fs.closeSync(descriptor);
    }

    expect(error?.code).toBe('EEXIST');
    expect(fs.readFileSync(path.join(root, 'source'), 'utf8')).toBe('owned');
    expect(fs.readFileSync(path.join(root, 'destination'), 'utf8')).toBe('foreign');
  });

  test('native unlinkat removes an empty directory with the platform flag', () => {
    const native = createNativeMutationAtomicOperations();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-native-rmdir-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'empty'));
    const descriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      native.unlinkAt(descriptor, 'empty', true);
    } finally {
      fs.closeSync(descriptor);
    }

    expect(fs.existsSync(path.join(root, 'empty'))).toBeFalse();
  });

  test.each([
    ['link', 'publish'],
    ['rename', 'publish'],
    ['unlink', 'retirement'],
    ['mkdir', 'create'],
    ['rmdir', 'retirement'],
  ] as const)(
    'maps %s success followed by a post-success hook failure to ownership recovery',
    (primitive, failurePhase) => {
      const boundaries: string[] = [];
      const { root, executor, retirementDirectory } = fixture({
        journal: {
          beforeMutation: kind => boundaries.push(`before:${kind}`),
          afterMutation: kind => boundaries.push(`after:${kind}`),
        },
        atomicHooks: {
          afterAtomicMutation(kind, phase) {
            if (kind === primitive && phase === failurePhase) throw errno('ENOTSUP');
          },
        },
        directoryFsync() {},
      });
      const source = path.join(root, 'source');
      const destination = path.join(root, 'destination');
      if (primitive === 'rmdir') fs.mkdirSync(source);
      else if (primitive !== 'mkdir') fs.writeFileSync(source, 'owned');

      const action = (): void => {
        if (primitive === 'mkdir') executor.mkdir(destination, 0o700);
        else if (primitive === 'rmdir') executor.rmdir(executor.captureDirectory(source));
        else if (primitive === 'unlink') executor.unlink(executor.captureFile(source));
        else executor[primitive](executor.captureFile(source), destination);
      };

      expect(action).toThrow(new MutationFailure('OWNERSHIP_LOST'));
      expect(boundaries).toEqual([`before:${primitive}`]);
      if (primitive === 'link' || primitive === 'rename' || primitive === 'mkdir') {
        expect(fs.existsSync(destination)).toBeTrue();
      }
      if (primitive === 'rename') expect(fs.existsSync(source)).toBeTrue();
      if (primitive === 'unlink' || primitive === 'rmdir') {
        expect(fs.existsSync(source)).toBeFalse();
        expect(fs.readdirSync(retirementDirectory!)).toHaveLength(1);
      }
    },
  );

  test('maps descriptor-relative ENOTSUP during capture to UNSUPPORTED_FILESYSTEM', () => {
    const native = createNativeMutationAtomicOperations();
    const { root, executor } = fixture({
      atomicOps: {
        ...native,
        openAt() {
          throw errno('ENOTSUP');
        },
      },
    });
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.captureFile(source))
      .toThrow(new MutationFailure('UNSUPPORTED_FILESYSTEM'));
  });

  test('closes the source parent when opening the destination parent fails', () => {
    let failDirectory = '';
    let opened = 0;
    let closed = 0;
    const { root, executor } = fixture({
      fileOps: {
        openSync(candidate, flags, mode) {
          if (candidate === failDirectory) throw errno('EACCES');
          opened += 1;
          return fs.openSync(candidate, flags, mode);
        },
        closeSync(descriptor) {
          closed += 1;
          fs.closeSync(descriptor);
        },
      } as Partial<MutationFileOperations>,
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    failDirectory = path.join(root, 'destination-parent');
    fs.writeFileSync(source, 'owned');
    fs.mkdirSync(failDirectory);
    const owned = executor.captureFile(source);
    opened = 0;
    closed = 0;

    expect(() => executor.link(owned, path.join(failDirectory, 'destination.md')))
      .toThrow(new MutationFailure('UNSAFE_PATH'));
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  test('fsyncs source and retirement roots immediately after retirement rename', () => {
    const native = createNativeMutationAtomicOperations();
    const events: string[] = [];
    let source = '';
    let replaced = false;
    const { root, executor, retirementDirectory } = fixture({
      atomicOps: {
        ...native,
        renameNoReplaceAt(sourceParent, sourceName, destinationParent, destinationName) {
          events.push('rename');
          native.renameNoReplaceAt(
            sourceParent,
            sourceName,
            destinationParent,
            destinationName,
          );
        },
      },
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'unlink' && phase === 'retirement' && !replaced) {
            replaced = true;
            fs.unlinkSync(source);
            fs.writeFileSync(source, 'foreign');
          }
        },
      },
      directoryFsync(directory) {
        events.push(`fsync:${directory}`);
      },
    });
    source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.unlink(executor.captureFile(source)))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    expect(events.slice(0, 3)).toEqual([
      'rename',
      `fsync:${root}`,
      `fsync:${retirementDirectory}`,
    ]);
  });

  test('requires a 0700 owned retirement directory', () => {
    const { root, executor, retirementDirectory } = fixture({
      directoryFsync() {},
    });
    fs.chmodSync(retirementDirectory!, 0o755);
    const source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.unlink(executor.captureFile(source)))
      .toThrow(new MutationFailure('UNSAFE_PATH'));
    expect(fs.readFileSync(source, 'utf8')).toBe('owned');
  });

  test('never directly removes the retirement root', () => {
    const { executor, retirementDirectory } = fixture({
      directoryFsync() {},
    });
    const owned = executor.captureDirectory(retirementDirectory!);

    expect(() => executor.rmdir(owned))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    expect(fs.statSync(retirementDirectory!).isDirectory()).toBeTrue();
  });

  test.each(['file', 'directory'] as const)(
    'never calls final native unlinkat for a retired %s',
    entryType => {
      const native = createNativeMutationAtomicOperations();
      let unlinkCalls = 0;
      const { root, executor, retirementDirectory } = fixture({
        atomicOps: {
          ...native,
          unlinkAt(parentDescriptor, name, directory) {
            unlinkCalls += 1;
            native.unlinkAt(parentDescriptor, name, directory);
          },
        },
        directoryFsync() {},
      });
      const source = path.join(root, entryType === 'file' ? 'owned.md' : 'owned-dir');
      if (entryType === 'file') fs.writeFileSync(source, 'owned');
      else fs.mkdirSync(source);

      const action = (): void => {
        if (entryType === 'file') executor.unlink(executor.captureFile(source));
        else executor.rmdir(executor.captureDirectory(source));
      };
      expect(action).not.toThrow();
      expect(fs.existsSync(source)).toBeFalse();
      expect(unlinkCalls).toBe(0);
      expect(fs.readdirSync(retirementDirectory!)).toHaveLength(1);
    },
  );

  test.each(['file', 'directory'] as const)(
    'native retired-name replacement preserves both foreign and owned %s entries',
    entryType => {
      const native = createNativeMutationAtomicOperations();
      let retirementDirectory = '';
      let displaced = '';
      let injected = false;
      const built = fixture({
        atomicOps: {
          ...native,
          openAt(parentDescriptor, name, flags, mode) {
            const descriptor = native.openAt(parentDescriptor, name, flags, mode);
            if (!injected && name.startsWith('.me-retired-')) {
              injected = true;
              const retired = path.join(retirementDirectory, name);
              displaced = path.join(retirementDirectory, `.owned-displaced-${name}`);
              fs.renameSync(retired, displaced);
              if (entryType === 'file') fs.writeFileSync(retired, 'foreign');
              else fs.mkdirSync(retired, { mode: 0o700 });
            }
            return descriptor;
          },
        },
        directoryFsync() {},
      });
      retirementDirectory = built.retirementDirectory!;
      const source = path.join(
        built.root,
        entryType === 'file' ? 'owned.md' : 'owned-dir',
      );
      if (entryType === 'file') fs.writeFileSync(source, 'owned');
      else fs.mkdirSync(source);

      const action = (): void => {
        if (entryType === 'file') built.executor.unlink(built.executor.captureFile(source));
        else built.executor.rmdir(built.executor.captureDirectory(source));
      };
      expect(action).toThrow(new MutationFailure('OWNERSHIP_LOST'));
      expect(fs.existsSync(displaced)).toBeTrue();
      const foreign = fs.readdirSync(retirementDirectory)
        .find(name => name.startsWith('.me-retired-'))!;
      expect(foreign).toBeDefined();
      if (entryType === 'file') {
        expect(fs.readFileSync(path.join(retirementDirectory, foreign), 'utf8'))
          .toBe('foreign');
        expect(fs.readFileSync(displaced, 'utf8')).toBe('owned');
      } else {
        expect(fs.statSync(path.join(retirementDirectory, foreign)).isDirectory())
          .toBeTrue();
        expect(fs.statSync(displaced).isDirectory()).toBeTrue();
      }
    },
  );

  test('sanitizes a retired file through its owned descriptor and fsyncs it', () => {
    const truncated: Array<{ descriptor: number; length: number; inode: bigint }> = [];
    const fileFsyncs: bigint[] = [];
    const { root, executor, retirementDirectory } = fixture({
      fileOps: {
        ftruncateSync(descriptor: number, length?: number) {
          truncated.push({
            descriptor,
            length: length ?? 0,
            inode: fs.fstatSync(descriptor, { bigint: true }).ino,
          });
          fs.ftruncateSync(descriptor, length);
        },
        fsyncSync(descriptor) {
          fileFsyncs.push(fs.fstatSync(descriptor, { bigint: true }).ino);
          fs.fsyncSync(descriptor);
        },
      } as Partial<MutationFileOperations>,
      directoryFsync() {},
    });
    const source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'sensitive bytes', { mode: 0o640 });
    const owned = executor.captureFile(source);

    executor.unlink(owned);

    const [tombstoneName] = fs.readdirSync(retirementDirectory!);
    const tombstone = path.join(retirementDirectory!, tombstoneName);
    const stat = fs.statSync(tombstone, { bigint: true });
    expect(stat.size).toBe(0n);
    expect(Number(stat.mode & 0o777n)).toBe(0o640);
    expect(truncated).toHaveLength(1);
    expect(truncated[0].length).toBe(0);
    expect(truncated[0].inode).toBe(owned.inode);
    expect(fileFsyncs).toContain(owned.inode);
  });

  test('retains recovery bytes when owned-descriptor sanitization is ambiguous', () => {
    const { root, executor, retirementDirectory } = fixture({
      fileOps: {
        ftruncateSync() {
          throw errno('EIO');
        },
      } as Partial<MutationFileOperations>,
      directoryFsync() {},
    });
    const source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'recovery bytes');

    expect(() => executor.unlink(executor.captureFile(source)))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    expect(fs.existsSync(source)).toBeFalse();
    const [retired] = fs.readdirSync(retirementDirectory!);
    expect(fs.readFileSync(path.join(retirementDirectory!, retired), 'utf8'))
      .toBe('recovery bytes');
  });

  test.each(['link', 'rename', 'unlink', 'rmdir'] as const)(
    'maps an ambiguous native %s result to ownership recovery',
    primitive => {
      const { root, executor } = fixture({
        atomicHooks: {
          beforeAtomicMutation(kind, phase) {
            if (
              kind === primitive
              && (phase === 'publish' || phase === 'retirement')
            ) throw errno('EIO');
          },
        },
        directoryFsync() {},
      });
      const source = path.join(root, 'owned');
      const destination = path.join(root, 'destination');
      if (primitive === 'rmdir') fs.mkdirSync(source);
      else fs.writeFileSync(source, 'owned');

      const action = (): void => {
        if (primitive === 'unlink') executor.unlink(executor.captureFile(source));
        else if (primitive === 'rmdir') executor.rmdir(executor.captureDirectory(source));
        else executor[primitive](executor.captureFile(source), destination);
      };
      expect(action).toThrow(new MutationFailure('OWNERSHIP_LOST'));
    },
  );

  test('retains an empty directory tombstone and rejects a non-empty source', () => {
    const { root, executor, retirementDirectory } = fixture({
      directoryFsync() {},
    });
    const empty = path.join(root, 'empty');
    const nonEmpty = path.join(root, 'non-empty');
    fs.mkdirSync(empty, { mode: 0o750 });
    fs.mkdirSync(nonEmpty);
    fs.writeFileSync(path.join(nonEmpty, 'keep'), 'owned');

    executor.rmdir(executor.captureDirectory(empty));
    expect(() => executor.rmdir(executor.captureDirectory(nonEmpty)))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));

    const tombstones = fs.readdirSync(retirementDirectory!);
    expect(tombstones).toHaveLength(1);
    const tombstone = path.join(retirementDirectory!, tombstones[0]);
    expect(fs.readdirSync(tombstone)).toEqual([]);
    expect(fs.statSync(tombstone).mode & 0o777).toBe(0o750);
    expect(fs.readFileSync(path.join(nonEmpty, 'keep'), 'utf8')).toBe('owned');
  });

  test.each(['link', 'rename'] as const)(
    'checks source and destination devices before %s',
    primitive => {
      let destinationParent = '';
      let destinationDescriptor: number | undefined;
      const onOtherDevice = (stat: fs.BigIntStats): fs.BigIntStats =>
        new Proxy(stat, {
          get(target, property) {
            if (property === 'dev') return target.dev + 1n;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const { root, executor } = fixture({
        fileOps: {
          openSync(candidate, flags, mode) {
            const descriptor = fs.openSync(candidate, flags, mode);
            if (candidate === destinationParent) destinationDescriptor = descriptor;
            return descriptor;
          },
          lstatSync(candidate, options?: fs.StatSyncOptions) {
            const stat = fs.lstatSync(candidate, options as never);
            if (candidate === destinationParent) {
              return onOtherDevice(stat as unknown as fs.BigIntStats);
            }
            return stat;
          },
          fstatSync(descriptor, options?: fs.StatSyncOptions) {
            const stat = fs.fstatSync(descriptor, options as never);
            if (descriptor === destinationDescriptor) {
              return onOtherDevice(stat as unknown as fs.BigIntStats);
            }
            return stat;
          },
        } as Partial<MutationFileOperations>,
        directoryFsync() {},
      });
      const source = path.join(root, 'source.md');
      destinationParent = path.join(root, 'destination');
      fs.writeFileSync(source, 'source');
      fs.mkdirSync(destinationParent);

      expect(() => executor[primitive](
        executor.captureFile(source),
        path.join(destinationParent, 'destination.md'),
      )).toThrow(new MutationFailure('UNSUPPORTED_FILESYSTEM'));
    },
  );

  test('reports unsupported directory fsync once but propagates real failures', () => {
    const warnings: string[] = [];
    const unsupported = fixture({
      onWarning: code => warnings.push(code),
      directoryFsync() {
        throw errno('ENOTSUP');
      },
    });
    unsupported.executor.mkdir(path.join(unsupported.root, 'first'), 0o700);
    unsupported.executor.mkdir(path.join(unsupported.root, 'second'), 0o700);
    expect(warnings).toEqual(['DIRECTORY_FSYNC_UNSUPPORTED']);

    const failing = fixture({
      directoryFsync() {
        throw errno('EIO');
      },
    });
    expect(() => failing.executor.mkdir(path.join(failing.root, 'created'), 0o700))
      .toThrow('EIO');
  });

  test('fsyncs parent directories before recording the after boundary', () => {
    const events: string[] = [];
    const { root, executor } = fixture({
      journal: {
        beforeMutation: kind => events.push(`before:${kind}`),
        afterMutation: kind => events.push(`after:${kind}`),
      },
      beforeFilesystemMutation: kind => events.push(`primitive:${kind}`),
      directoryFsync: directory => events.push(`fsync:${directory}`),
    });
    const target = path.join(root, 'created');

    executor.mkdir(target, 0o700);
    expect(events).toEqual([
      'before:mkdir',
      'primitive:mkdir',
      `fsync:${root}`,
      'after:mkdir',
    ]);
  });

  test('does not record afterMutation when directory fsync fails', () => {
    const events: string[] = [];
    const { root, executor } = fixture({
      journal: {
        beforeMutation: kind => events.push(`before:${kind}`),
        afterMutation: kind => events.push(`after:${kind}`),
      },
      directoryFsync() {
        events.push('fsync');
        throw errno('EIO');
      },
    });

    expect(() => executor.mkdir(path.join(root, 'created'), 0o700)).toThrow('EIO');
    expect(events).toEqual(['before:mkdir', 'fsync']);
  });

  test.each(
    (['link', 'rename', 'unlink', 'mkdir', 'rmdir'] as const).flatMap(primitive =>
      (['before', 'after'] as const).map(phase => [primitive, phase] as const)),
  )(
    'surfaces failure %s %s with honest boundary state',
    (primitive, phase) => {
      const boundaries: string[] = [];
      const { root, executor } = fixture({
        journal: {
          beforeMutation(kind) {
            boundaries.push(`before:${kind}`);
            if (phase === 'before') throw new Error('before injected');
          },
          afterMutation(kind) {
            boundaries.push(`after:${kind}`);
            if (phase === 'after') throw new Error('after injected');
          },
        },
        directoryFsync() {},
      });
      const source = path.join(root, 'source');
      const target = path.join(root, 'target');
      if (primitive === 'rmdir') fs.mkdirSync(source);
      else if (primitive !== 'mkdir') fs.writeFileSync(source, 'source');
      const action = (): void => {
        if (primitive === 'mkdir') {
          executor.mkdir(target, 0o700);
        } else if (primitive === 'rmdir') {
          executor.rmdir(executor.captureDirectory(source));
        } else if (primitive === 'unlink') {
          executor.unlink(executor.captureFile(source));
        } else {
          executor[primitive](executor.captureFile(source), target);
        }
      };

      expect(action).toThrow(`${phase} injected`);
      expect(boundaries).toEqual(
        phase === 'before'
          ? [`before:${primitive}`]
          : [`before:${primitive}`, `after:${primitive}`],
      );
      if (primitive === 'mkdir' || primitive === 'link' || primitive === 'rename') {
        expect(fs.existsSync(target)).toBe(phase === 'after');
      }
      if (primitive === 'unlink' || primitive === 'rmdir' || primitive === 'rename') {
        expect(fs.existsSync(source)).toBe(phase === 'before');
      }
    },
  );
});
