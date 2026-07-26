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
});
