import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MutationFailure,
  fingerprintMutationSource,
  validatePlannedMutations,
  type FilesystemMutationKind,
  type MutationFailureCode,
  type MutationFileOperations,
  type MutationPathPolicy,
  type PlannedMutation,
} from '../bin/mutation/contracts.ts';
import {
  fingerprintMutationSource as updateFingerprintMutationSource,
  type PlannedMutation as UpdatePlannedMutation,
} from '../bin/update/contracts.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  policy: MutationPathPolicy;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mutation-contracts-'));
  temporaryDirectories.push(root);
  return {
    root,
    policy: {
      assertSafe(candidate) {
        const absolute = path.resolve(candidate);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
          throw new Error('outside fixture');
        }
      },
      display(candidate) {
        return path.relative(root, candidate).split(path.sep).join('/') || '.';
      },
    },
  };
}

function missing(vaultRelativePath: string) {
  return { vaultRelativePath, type: 'missing' as const };
}

function writeMutation(
  vaultRelativePath: string,
  bytes = Buffer.from('desired bytes'),
  overrides: Partial<Extract<PlannedMutation, { kind: 'write-file' }>> = {},
): Extract<PlannedMutation, { kind: 'write-file' }> {
  return {
    kind: 'write-file',
    vaultRelativePath,
    source: missing(vaultRelativePath),
    desiredBytes: bytes,
    desiredSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    desiredMode: 0o644,
    publishOrder: 0,
    ...overrides,
  };
}

describe('shared mutation planning contracts', () => {
  test('accepts exact write bytes, SHA-256, desired mode, and closed union values', () => {
    const kinds: FilesystemMutationKind[] = ['link', 'rename', 'unlink', 'mkdir', 'rmdir'];
    const failures: MutationFailureCode[] = [
      'SOURCE_CHANGED',
      'TARGET_EXISTS',
      'OWNERSHIP_LOST',
      'UNSAFE_PATH',
      'UNSUPPORTED_FILESYSTEM',
    ];
    const mutation = writeMutation('notes/current.md');

    expect(() => validatePlannedMutations([mutation])).not.toThrow();
    expect(kinds).toEqual(['link', 'rename', 'unlink', 'mkdir', 'rmdir']);
    expect(failures).toHaveLength(5);

    const updateMutation: UpdatePlannedMutation = mutation;
    expect(updateMutation).toBe(mutation);
  });

  test('rejects mismatched write hashes and invalid desired modes before mutation', () => {
    expect(() => validatePlannedMutations([
      writeMutation('notes/hash.md', Buffer.from('actual'), {
        desiredSha256: '0'.repeat(64),
      }),
    ])).toThrow(MutationFailure);

    for (const desiredMode of [-1, 0o1000, 1.5]) {
      expect(() => validatePlannedMutations([
        writeMutation('notes/mode.md', undefined, { desiredMode }),
      ])).toThrow(new MutationFailure('UNSAFE_PATH'));
    }
  });

  test('requires rename source and destination fingerprints', () => {
    const valid: PlannedMutation = {
      kind: 'rename',
      vaultRelativePath: 'old.md',
      destinationVaultRelativePath: 'new.md',
      source: {
        vaultRelativePath: 'old.md',
        type: 'file',
        sha256: 'a'.repeat(64),
        mode: 0o640,
      },
      destinationSource: missing('new.md'),
      publishOrder: 0,
    };
    expect(() => validatePlannedMutations([valid])).not.toThrow();

    const withoutDestination = { ...valid } as Record<string, unknown>;
    delete withoutDestination.destinationSource;
    expect(() => validatePlannedMutations([
      withoutDestination as unknown as PlannedMutation,
    ])).toThrow(new MutationFailure('UNSAFE_PATH'));
  });

  test('rejects duplicate and overlapping parent-child targets', () => {
    expect(() => validatePlannedMutations([
      writeMutation('notes/same.md'),
      writeMutation('notes/same.md', Buffer.from('other'), { publishOrder: 1 }),
    ])).toThrow(new MutationFailure('TARGET_EXISTS'));

    expect(() => validatePlannedMutations([
      {
        kind: 'mkdir',
        vaultRelativePath: 'notes/archive',
        source: missing('notes/archive'),
        desiredMode: 0o700,
        publishOrder: 0,
      },
      writeMutation('notes/archive/item.md', undefined, { publishOrder: 1 }),
    ])).toThrow(new MutationFailure('TARGET_EXISTS'));
  });

  test('one fingerprint helper captures portable missing, file, and directory state', () => {
    const { root, policy } = fixture();
    const file = path.join(root, 'note.md');
    const directory = path.join(root, 'folder');
    fs.writeFileSync(file, 'hello', { mode: 0o640 });
    fs.mkdirSync(directory, { mode: 0o750 });

    expect(fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'missing.md',
      pathPolicy: policy,
    })).toEqual(missing('missing.md'));
    expect(fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'note.md',
      pathPolicy: policy,
    })).toEqual({
      vaultRelativePath: 'note.md',
      type: 'file',
      sha256: crypto.createHash('sha256').update('hello').digest('hex'),
      mode: 0o640,
    });
    expect(fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'folder',
      pathPolicy: policy,
    })).toEqual({
      vaultRelativePath: 'folder',
      type: 'directory',
      mode: 0o750,
    });
  });

  test('fingerprinting never follows a symlink substituted between lstat and open', () => {
    const { root, policy } = fixture();
    const source = path.join(root, 'source.md');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.md`);
    temporaryDirectories.push(outside);
    fs.writeFileSync(source, 'safe');
    fs.writeFileSync(outside, 'outside');
    let swapped = false;

    expect(() => fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'source.md',
      pathPolicy: policy,
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
    } as Parameters<typeof fingerprintMutationSource>[0] & {
      fileOps: Partial<MutationFileOperations>;
    })).toThrow(new MutationFailure('UNSAFE_PATH'));
  });

  test('fingerprinting rejects a changed path identity after descriptor read and closes it', () => {
    const { root, policy } = fixture();
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'owned');
    let replaced = false;
    let closes = 0;

    expect(() => fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'source.md',
      pathPolicy: policy,
      fileOps: {
        readFileSync(candidate: fs.PathOrFileDescriptor) {
          const bytes = fs.readFileSync(candidate);
          if (typeof candidate === 'number' && !replaced) {
            replaced = true;
            fs.unlinkSync(source);
            fs.writeFileSync(source, 'foreign');
          }
          return bytes;
        },
        closeSync(descriptor: number) {
          closes += 1;
          fs.closeSync(descriptor);
        },
      } as Partial<MutationFileOperations>,
    } as Parameters<typeof fingerprintMutationSource>[0] & {
      fileOps: Partial<MutationFileOperations>;
    })).toThrow(new MutationFailure('UNSAFE_PATH'));
    expect(closes).toBe(1);
  });

  test('fingerprinting does not block on a FIFO substituted before descriptor open', () => {
    const { root, policy } = fixture();
    const source = path.join(root, 'source.md');
    fs.writeFileSync(source, 'owned');
    let swapped = false;

    expect(() => fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath: 'source.md',
      pathPolicy: policy,
      fileOps: {
        lstatSync(candidate, options?: fs.StatSyncOptions) {
          const stat = fs.lstatSync(candidate, options as never);
          if (candidate === source && !swapped) {
            swapped = true;
            fs.unlinkSync(source);
            Bun.spawnSync(['mkfifo', source]);
          }
          return stat;
        },
      } as Partial<MutationFileOperations>,
    })).toThrow(new MutationFailure('UNSAFE_PATH'));
  });

  test('update re-export and shared helper reject symlinks and special files identically', () => {
    const { root, policy } = fixture();
    fs.writeFileSync(path.join(root, 'target.md'), 'target');
    fs.symlinkSync(path.join(root, 'target.md'), path.join(root, 'link.md'));
    const fifo = path.join(root, 'pipe');
    Bun.spawnSync(['mkfifo', fifo]);

    for (const vaultRelativePath of ['link.md', 'pipe']) {
      for (const helper of [fingerprintMutationSource, updateFingerprintMutationSource]) {
        expect(() => helper({ vaultRoot: root, vaultRelativePath, pathPolicy: policy }))
          .toThrow(new MutationFailure('UNSAFE_PATH'));
      }
    }
  });
});
