import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MutationFailure,
  type FilesystemMutationKind,
  type MutationExecutor,
  type MutationFileOperations,
  type MutationJournalAdapter,
  type MutationPathPolicy,
} from '../bin/mutation/contracts.ts';
import { createMutationExecutor } from '../bin/mutation/executor.ts';

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
  atomicHooks?: NonNullable<
    Parameters<typeof createMutationExecutor>[0]['atomicHooks']
  >;
  directoryFsync?(directory: string): void;
  quarantine?: boolean;
} = {}): {
  root: string;
  executor: MutationExecutor;
  policy: MutationPathPolicy;
  quarantineDirectory?: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mutation-executor-'));
  temporaryDirectories.push(root);
  const quarantineDirectory = options.quarantine !== false
    ? path.join(root, 'quarantine')
    : undefined;
  if (quarantineDirectory) fs.mkdirSync(quarantineDirectory, { mode: 0o700 });
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
      directoryFsync: options.directoryFsync,
      quarantineDirectory,
    } as Parameters<typeof createMutationExecutor>[0]),
    quarantineDirectory,
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

  test('quarantines and preserves a foreign file replacement instead of unlinking it', () => {
    let source = '';
    let replaced = false;
    const replaceSource = (): void => {
      if (replaced) return;
      replaced = true;
      fs.unlinkSync(source);
      fs.writeFileSync(source, 'foreign');
    };
    const { root, executor, quarantineDirectory } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'unlink' && phase === 'quarantine') replaceSource();
        },
      },
      directoryFsync() {},
      quarantine: true,
    });
    source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'owned');
    const owned = executor.captureFile(source);

    expect(() => executor.unlink(owned))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    const preserved = fs.readdirSync(quarantineDirectory!);
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantineDirectory!, preserved[0]), 'utf8'))
      .toBe('foreign');
  });

  test('quarantines and preserves a foreign directory replacement instead of removing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mutation-rmdir-race-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'owned');
    const quarantine = path.join(root, 'quarantine');
    fs.mkdirSync(source);
    fs.mkdirSync(quarantine, { mode: 0o700 });
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
          if (kind === 'rmdir' && phase === 'quarantine') replaceSource();
        },
      },
      fileOps: {
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
        rmdirSync: fs.rmdirSync,
      },
      directoryFsync() {},
      quarantineDirectory: quarantine,
    } as Parameters<typeof createMutationExecutor>[0]);
    const owned = guarded.captureDirectory(source);

    expect(() => guarded.rmdir(owned))
      .toThrow(new MutationFailure('OWNERSHIP_LOST'));
    const [preserved] = fs.readdirSync(quarantine);
    expect(fs.readFileSync(path.join(quarantine, preserved, 'foreign.txt'), 'utf8'))
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

  test('fails closed when quarantine rename is unsupported', () => {
    const { root, executor, quarantineDirectory } = fixture({
      atomicHooks: {
        beforeAtomicMutation(kind, phase) {
          if (kind === 'unlink' && phase === 'quarantine') throw errno('ENOTSUP');
        },
      },
      directoryFsync() {},
    });
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'owned');

    expect(() => executor.unlink(executor.captureFile(source)))
      .toThrow(new MutationFailure('UNSUPPORTED_FILESYSTEM'));
    expect(fs.readFileSync(source, 'utf8')).toBe('owned');
    expect(fs.readdirSync(quarantineDirectory!)).toEqual([]);
  });

  test.each(['link', 'rename'] as const)(
    'checks source and destination devices before %s',
    primitive => {
      const { root, executor } = fixture({
        fileOps: {
          statSync(candidate, options?: fs.StatSyncOptions) {
            const stat = fs.statSync(candidate, options as never);
            if (
              typeof candidate === 'string'
              && fs.statSync(candidate).isDirectory()
            ) {
              return { ...stat, dev: (stat as fs.BigIntStats).dev + 1n } as fs.BigIntStats;
            }
            return stat;
          },
        } as Partial<MutationFileOperations>,
        directoryFsync() {},
      });
      const source = path.join(root, 'source.md');
      fs.writeFileSync(source, 'source');

      expect(() => executor[primitive](
        executor.captureFile(source),
        path.join(root, 'destination.md'),
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
