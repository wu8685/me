import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquireVaultLock,
  releaseVaultLock,
  type CooperativeLockHooks,
} from '../bin/cooperative-lock.ts';
import {
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
} from '../bin/runtime-paths.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function preparedRuntime() {
  const fixture = temporaryDirectory('me-cooperative-lock-');
  const vault = path.join(fixture, 'vault');
  const runtimeBase = path.join(fixture, 'runtime');
  fs.mkdirSync(vault);
  const layout = resolveRuntimeLayout(vault, { ME_RUNTIME_ROOT: runtimeBase });
  bootstrapRuntimeDirectories(layout, [layout.lockDir]);
  return layout;
}

describe('vault-wide cooperative lock', () => {
  test('serializes all ME vault writers on one vault.lock', () => {
    const layout = preparedRuntime();
    const first = acquireVaultLock(layout, {
      operationId: 'op-write',
      owner: 'vault-write',
    });

    expect(() => acquireVaultLock(layout, {
      operationId: 'op-update',
      owner: 'me-update',
    })).toThrow(/LOCK_HELD/);

    releaseVaultLock(layout, first);
    const second = acquireVaultLock(layout, {
      operationId: 'op-update',
      owner: 'me-update',
    });
    expect(second.path).toBe(path.join(layout.lockDir, 'vault.lock'));
    expect(JSON.parse(fs.readFileSync(second.path, 'utf8')).owner).toBe('me-update');
    releaseVaultLock(layout, second);
  });

  test('records operation ownership in a private durable lock file', () => {
    const layout = preparedRuntime();
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'ingest',
    });

    const payload = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
    expect(payload).toMatchObject({
      version: 1,
      operationId: 'owned',
      owner: 'ingest',
    });
    expect(typeof payload.startedAt).toBe('string');
    expect(fs.statSync(lock.path).mode & 0o777).toBe(0o600);

    releaseVaultLock(layout, lock);
    expect(fs.existsSync(lock.path)).toBeFalse();
  });

  test('does not unlink a lock whose bytes changed after acquisition', () => {
    const layout = preparedRuntime();
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'ingest',
    });
    fs.writeFileSync(lock.path, '{"version":1,"operationId":"foreign","owner":"ingest"}\n');

    expect(() => releaseVaultLock(layout, lock)).toThrow(/RECOVERY_REQUIRED/);
    expect(fs.existsSync(lock.path)).toBeTrue();
  });

  test('does not unlink a replacement inode with copied ownership bytes', () => {
    const layout = preparedRuntime();
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'vault-write',
    });
    const bytes = fs.readFileSync(lock.path);
    fs.unlinkSync(lock.path);
    fs.writeFileSync(lock.path, bytes, { mode: 0o600 });

    expect(() => releaseVaultLock(layout, lock)).toThrow(/RECOVERY_REQUIRED/);
    expect(fs.existsSync(lock.path)).toBeTrue();
  });

  test('preserves a foreign replacement inserted during the final ownership read', () => {
    const layout = preparedRuntime();
    let releaseStarted = false;
    let replacementInserted = false;
    let descriptorOpenAtMutation = false;
    let lockDescriptor = -1;
    const hooks = {
      beforeMutation(kind: 'create' | 'unlink') {
        if (kind !== 'unlink') return;
        releaseStarted = true;
        try {
          fs.fstatSync(lockDescriptor);
          descriptorOpenAtMutation = true;
        } catch {
          descriptorOpenAtMutation = false;
        }
      },
      __operations: {
        readFileSync(candidate: string) {
          const bytes = fs.readFileSync(candidate);
          if (releaseStarted && !replacementInserted) {
            replacementInserted = true;
            fs.unlinkSync(candidate);
            fs.writeFileSync(candidate, 'foreign replacement');
          }
          return bytes;
        },
      },
    } as CooperativeLockHooks & {
      __operations: { readFileSync(candidate: string): Buffer };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'vault-write',
    }, hooks);
    lockDescriptor = lock.descriptor;

    expect(() => releaseVaultLock(layout, lock, hooks)).toThrow(/RECOVERY_REQUIRED/);
    expect(descriptorOpenAtMutation).toBeTrue();
    expect(fs.readFileSync(lock.path, 'utf8')).toBe('foreign replacement');
    expect(() => fs.fstatSync(lockDescriptor)).toThrow();
    const preservedFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(candidate);
        else preservedFiles.push(candidate);
      }
    };
    walk(layout.lockDir);
    expect(preservedFiles.some(candidate =>
      fs.readFileSync(candidate, 'utf8') === 'foreign replacement')).toBeTrue();
  });

  test('normalizes an unlink hook failure and preserves the lock', () => {
    const layout = preparedRuntime();
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'ingest',
    });

    expect(() => releaseVaultLock(layout, lock, {
      beforeMutation(kind) {
        if (kind === 'unlink') throw new Error('injected unlink hook failure');
      },
    })).toThrow(/RECOVERY_REQUIRED/);
    expect(fs.existsSync(lock.path)).toBeTrue();
  });

  test('never reaches a deletable post-close quarantine ownership read', () => {
    const layout = preparedRuntime();
    let descriptorClosed = false;
    let replacementInserted = false;
    let replacementPath = '';
    const hooks = {
      __operations: {
        closeSync(descriptor: number) {
          fs.closeSync(descriptor);
          descriptorClosed = true;
        },
        readFileSync(candidate: string) {
          const bytes = fs.readFileSync(candidate);
          if (
            descriptorClosed
            && candidate.includes(`${path.sep}.vault-lock-release-`)
            && !replacementInserted
          ) {
            replacementInserted = true;
            replacementPath = candidate;
            fs.unlinkSync(candidate);
            fs.writeFileSync(candidate, 'post-close foreign replacement');
          }
          return bytes;
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        closeSync(descriptor: number): void;
        readFileSync(candidate: string): Buffer;
      };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'vault-write',
    }, hooks);

    expect(() => releaseVaultLock(layout, lock, hooks)).not.toThrow();
    expect(replacementInserted).toBeFalse();
    expect(replacementPath).toBe('');
    expect(fs.existsSync(lock.path)).toBeFalse();
  });

  test('restores vault.lock when rename succeeds before its wrapper throws', () => {
    const layout = preparedRuntime();
    let quarantinePath = '';
    const hooks = {
      __operations: {
        renameSync(source: string, destination: string) {
          fs.renameSync(source, destination);
          quarantinePath = destination;
          throw new Error('injected post-success rename error');
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        renameSync(source: string, destination: string): void;
      };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'ingest',
    }, hooks);
    const ownedBytes = fs.readFileSync(lock.path);

    expect(() => releaseVaultLock(layout, lock, hooks)).toThrow(/RECOVERY_REQUIRED/);
    expect(fs.readFileSync(lock.path)).toEqual(ownedBytes);
    expect(fs.readFileSync(quarantinePath)).toEqual(ownedBytes);
    expect(() => acquireVaultLock(layout, {
      operationId: 'next',
      owner: 'me-update',
    })).toThrow(/LOCK_HELD/);
  });

  test('release preserves a foreign vault.lock replacement created after rename success', () => {
    const layout = preparedRuntime();
    const hooks = {
      __operations: {
        renameSync(source: string, destination: string) {
          fs.renameSync(source, destination);
          fs.writeFileSync(source, 'next owner');
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        renameSync(source: string, destination: string): void;
      };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'ingest',
    }, hooks);

    expect(() => releaseVaultLock(layout, lock, hooks)).not.toThrow();
    expect(fs.readFileSync(lock.path, 'utf8')).toBe('next owner');
  });

  test('completes release without name-only unlink and retains the owned tombstone', () => {
    const layout = preparedRuntime();
    let postSuccessErrorInjected = false;
    const hooks = {
      __operations: {
        unlinkSync(candidate: string) {
          fs.unlinkSync(candidate);
          if (candidate.includes(`${path.sep}.vault-lock-release-`)) {
            postSuccessErrorInjected = true;
            throw new Error('injected post-success unlink error');
          }
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        unlinkSync(candidate: string): void;
      };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'vault-write',
    }, hooks);

    expect(() => releaseVaultLock(layout, lock, hooks)).not.toThrow();
    expect(postSuccessErrorInjected).toBeFalse();
    expect(fs.existsSync(lock.path)).toBeFalse();

    const next = acquireVaultLock(layout, {
      operationId: 'next',
      owner: 'me-update',
    });
    releaseVaultLock(layout, next);
  });

  test('failed acquisition preserves a quarantine replacement inserted during ownership read', () => {
    const layout = preparedRuntime();
    let cleanupStarted = false;
    let replacementInserted = false;
    let replacementPath = '';
    let descriptor = -1;
    const hooks = {
      __operations: {
        fsyncSync() {
          cleanupStarted = true;
          throw new Error('injected acquisition fsync failure');
        },
        readFileSync(candidate: string) {
          const bytes = fs.readFileSync(candidate);
          if (
            cleanupStarted
            && candidate.includes(`${path.sep}.vault-lock-release-`)
            && !replacementInserted
          ) {
            replacementInserted = true;
            replacementPath = candidate;
            fs.unlinkSync(candidate);
            fs.writeFileSync(candidate, 'failed-acquisition foreign replacement');
          }
          return bytes;
        },
        closeSync(candidate: number) {
          descriptor = candidate;
          fs.closeSync(candidate);
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        fsyncSync(descriptor: number): void;
        readFileSync(candidate: string): Buffer;
        closeSync(descriptor: number): void;
      };
    };

    expect(() => acquireVaultLock(layout, {
      operationId: 'failed',
      owner: 'vault-write',
    }, hooks)).toThrow(/RECOVERY_REQUIRED/);
    expect(replacementInserted).toBeTrue();
    expect(fs.readFileSync(replacementPath, 'utf8'))
      .toBe('failed-acquisition foreign replacement');
    expect(fs.readFileSync(path.join(layout.lockDir, 'vault.lock'), 'utf8'))
      .toBe('failed-acquisition foreign replacement');
    expect(() => fs.fstatSync(descriptor)).toThrow();
  });

  test('failed acquisition restores vault.lock after post-success rename error', () => {
    const layout = preparedRuntime();
    let quarantinePath = '';
    const hooks = {
      __operations: {
        fsyncSync() {
          throw new Error('injected acquisition fsync failure');
        },
        renameSync(source: string, destination: string) {
          fs.renameSync(source, destination);
          quarantinePath = destination;
          throw new Error('injected acquisition post-success rename error');
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        fsyncSync(descriptor: number): void;
        renameSync(source: string, destination: string): void;
      };
    };

    expect(() => acquireVaultLock(layout, {
      operationId: 'failed',
      owner: 'ingest',
    }, hooks)).toThrow(/RECOVERY_REQUIRED/);
    expect(fs.existsSync(path.join(layout.lockDir, 'vault.lock'))).toBeTrue();
    expect(fs.existsSync(quarantinePath)).toBeTrue();
    expect(() => acquireVaultLock(layout, {
      operationId: 'next',
      owner: 'me-update',
    })).toThrow(/LOCK_HELD/);
  });

  test('failed acquisition surfaces its original error without name-only unlink', () => {
    const layout = preparedRuntime();
    let postSuccessErrorInjected = false;
    const hooks = {
      __operations: {
        fsyncSync() {
          throw new Error('injected acquisition fsync failure');
        },
        unlinkSync(candidate: string) {
          fs.unlinkSync(candidate);
          if (candidate.includes(`${path.sep}.vault-lock-release-`)) {
            postSuccessErrorInjected = true;
            throw new Error('injected acquisition post-success unlink error');
          }
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        fsyncSync(descriptor: number): void;
        unlinkSync(candidate: string): void;
      };
    };

    expect(() => acquireVaultLock(layout, {
      operationId: 'failed',
      owner: 'vault-write',
    }, hooks)).toThrow(/injected acquisition fsync failure/);
    expect(postSuccessErrorInjected).toBeFalse();
    expect(fs.existsSync(path.join(layout.lockDir, 'vault.lock'))).toBeFalse();

    const next = acquireVaultLock(layout, {
      operationId: 'next',
      owner: 'me-update',
    });
    releaseVaultLock(layout, next);
  });

  test('initial ownership read cannot return while a real second owner is acquired', () => {
    const layout = preparedRuntime();
    let second: ReturnType<typeof acquireVaultLock> | undefined;
    let first: ReturnType<typeof acquireVaultLock> | undefined;
    let firstError: unknown;
    let raced = false;
    const hooks = {
      __operations: {
        readFileSync(candidate: string) {
          const bytes = fs.readFileSync(candidate);
          if (!raced && candidate === path.join(layout.lockDir, 'vault.lock')) {
            raced = true;
            fs.unlinkSync(candidate);
            second = acquireVaultLock(layout, {
              operationId: 'second',
              owner: 'me-update',
            });
          }
          return bytes;
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        readFileSync(candidate: string): Buffer;
      };
    };

    try {
      first = acquireVaultLock(layout, {
        operationId: 'first',
        owner: 'vault-write',
      }, hooks);
    } catch (error) {
      firstError = error;
    }
    const bothAcquired = first !== undefined && second !== undefined;

    if (first) {
      try {
        releaseVaultLock(layout, first, hooks);
      } catch {
        // The real second owner must remain authoritative.
      }
    }
    if (second) releaseVaultLock(layout, second);

    expect(raced).toBeTrue();
    expect(bothAcquired).toBeFalse();
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toMatch(/RECOVERY_REQUIRED/);
  });

  test('release preserves same-inode corruption when rename does not occur', () => {
    const layout = preparedRuntime();
    const hooks = {
      __operations: {
        renameSync(source: string) {
          fs.writeFileSync(source, 'same-inode release corruption');
          throw new Error('injected rename-before-mutation failure');
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        renameSync(source: string, destination: string): void;
      };
    };
    const lock = acquireVaultLock(layout, {
      operationId: 'owned',
      owner: 'vault-write',
    }, hooks);
    const before = fs.statSync(lock.path, { bigint: true });

    expect(() => releaseVaultLock(layout, lock, hooks)).toThrow(/RECOVERY_REQUIRED/);
    const after = fs.statSync(lock.path, { bigint: true });
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(lock.path, 'utf8')).toBe('same-inode release corruption');
  });

  test('failed acquisition preserves same-inode corruption when rename does not occur', () => {
    const layout = preparedRuntime();
    let ownedIdentity: fs.BigIntStats | undefined;
    const hooks = {
      __operations: {
        fsyncSync() {
          ownedIdentity = fs.statSync(
            path.join(layout.lockDir, 'vault.lock'),
            { bigint: true },
          );
          throw new Error('injected acquisition fsync failure');
        },
        renameSync(source: string) {
          fs.writeFileSync(source, 'same-inode acquisition corruption');
          throw new Error('injected acquisition rename-before-mutation failure');
        },
      },
    } as CooperativeLockHooks & {
      __operations: {
        fsyncSync(descriptor: number): void;
        renameSync(source: string, destination: string): void;
      };
    };

    expect(() => acquireVaultLock(layout, {
      operationId: 'failed',
      owner: 'ingest',
    }, hooks)).toThrow(/RECOVERY_REQUIRED/);
    const lockPath = path.join(layout.lockDir, 'vault.lock');
    const after = fs.statSync(lockPath, { bigint: true });
    expect(after.dev).toBe(ownedIdentity?.dev);
    expect(after.ino).toBe(ownedIdentity?.ino);
    expect(fs.readFileSync(lockPath, 'utf8'))
      .toBe('same-inode acquisition corruption');
  });
});
