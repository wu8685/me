import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeVaultWrite,
  type VaultWriteHooks,
} from '../bin/vault-write/transaction.ts';
import type { VaultWriteRequestV1 } from '../bin/vault-write/contracts.ts';
import { resolveVaultLayout } from '../bin/vault-write/path-safety.ts';
import { bootstrapRuntimeDirectories } from '../bin/runtime-paths.ts';

const temporaryDirectories: string[] = [];
const pluginRoot = path.resolve(import.meta.dir, '..');

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

function makeVault(readme?: string): string {
  const fixture = temporaryDirectory('me-vault-transaction-');
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  fs.mkdirSync(path.join(vault, '.me'));
  for (const layer of ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer));
  }
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  fs.writeFileSync(path.join(vault, 'raw/source.md'), '# Source\n');
  if (readme !== undefined) {
    fs.writeFileSync(path.join(vault, 'practices/README.md'), readme, { mode: 0o640 });
  }
  return vault;
}

function transactionRoot(vault: string): string {
  return resolveVaultLayout(vault).transactionDir;
}

function writerLockPath(vault: string): string {
  return path.join(resolveVaultLayout(vault).lockDir, 'vault-write.lock');
}

function prepareRuntime(vault: string): ReturnType<typeof resolveVaultLayout> {
  const layout = resolveVaultLayout(vault);
  bootstrapRuntimeDirectories(layout, [layout.transactionDir, layout.lockDir]);
  return layout;
}

function absoluteDisplayPath(vault: string, displayPath: string): string {
  const runtimePrefix = '<ME_RUNTIME>/';
  return displayPath.startsWith(runtimePrefix)
    ? path.join(resolveVaultLayout(vault).runtimeRoot, ...displayPath.slice(runtimePrefix.length).split('/'))
    : path.join(vault, ...displayPath.split('/'));
}

function request(secret = 'orchid-body'): VaultWriteRequestV1 {
  return {
    version: 1,
    layer: 'practices',
    relativePath: 'decisions/2026-07-26-orchid-choice.md',
    markdown: [
      '---',
      'title: Orchid Choice',
      'created: 2026-07-26',
      'tags: [decision]',
      'type: reflection',
      'source: "[[raw/source]]"',
      'project: ""',
      '---',
      '',
      `# ${secret}`,
      '',
    ].join('\n'),
    index: { mode: 'auto' },
  };
}

function requestAt(
  relativePath: string,
  title: string,
  secret = 'body',
): VaultWriteRequestV1 {
  const created = path.posix.basename(relativePath).slice(0, 10);
  return {
    ...request(secret),
    relativePath,
    markdown: request(secret).markdown
      .replace('title: Orchid Choice', `title: ${title}`)
      .replace('created: 2026-07-26', `created: ${created}`),
  };
}

function manifest(root: string): Array<{ path: string; type: string; sha?: string }> {
  const result: Array<{ path: string; type: string; sha?: string }> = [];
  function walk(directory: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        result.push({ path: relative, type: 'directory' });
        walk(absolute);
      } else if (stat.isSymbolicLink()) {
        result.push({ path: relative, type: 'symlink' });
      } else {
        result.push({
          path: relative,
          type: 'file',
          sha: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
        });
      }
    }
  }
  walk(root);
  return result;
}

function write(vault: string, hooks?: VaultWriteHooks) {
  return executeVaultWrite(vault, request(), {
    pluginRoot,
    mode: 'write',
    hooks,
  });
}

function operation(
  vault: string,
  operationId: string,
  state: string,
  overrides: Record<string, unknown> = {},
): string {
  const layout = prepareRuntime(vault);
  const directory = path.join(layout.transactionDir, `vault-write-${operationId}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'journal.json'), JSON.stringify({
    version: 1,
    operationId,
    state,
    ...overrides,
  }));
  return directory;
}

function isOpaqueRecoveryId(value: string): boolean {
  return /^recovery-[a-f0-9]{12}$/.test(value);
}

describe('preview and successful journaled create', () => {
  test('preview is byte-for-byte read-only and deterministic apart from operationId', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    const before = manifest(vault);
    const first = executeVaultWrite(vault, request(), { pluginRoot, mode: 'preview' });
    const second = executeVaultWrite(vault, request(), { pluginRoot, mode: 'preview' });

    expect(manifest(vault)).toEqual(before);
    expect(first.status).toBe('preview');
    expect(first.commitModel).toBe('preview-only');
    expect(first.changedPaths).toEqual([]);
    expect(first.operationId).not.toBe(second.operationId);
    expect({ ...first, operationId: '' }).toEqual({ ...second, operationId: '' });
    expect(fs.existsSync(path.join(vault, '.me/tmp'))).toBeFalse();
    expect(fs.existsSync(layout.runtimeRoot)).toBeFalse();
  });

  test('publishes a note and a new README through staged hard links then detaches staging', () => {
    const vault = makeVault();
    const mutations: string[] = [];
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        mutations.push(`${kind}:${paths.length}`);
      },
    });

    expect(result.status).toBe('committed');
    expect(result.commitModel).toBe('journaled-cooperative');
    expect(result.notePath).toBe('practices/decisions/2026-07-26-orchid-choice.md');
    expect(result.changedPaths).toEqual([
      'practices/decisions/2026-07-26-orchid-choice.md',
      'practices/README.md',
    ]);
    expect(mutations.some(item => item.startsWith('link:2'))).toBeTrue();
    const operation = path.join(transactionRoot(vault), `vault-write-${result.operationId}`);
    expect(fs.statSync(operation).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(operation).sort()).toEqual(['journal.json']);
    const journal = JSON.parse(fs.readFileSync(path.join(operation, 'journal.json'), 'utf8'));
    expect(journal.state).toBe('committed');
    expect(JSON.stringify(journal)).not.toContain('orchid-body');
    expect(fs.statSync(path.join(operation, 'journal.json')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(vault, '.me/tmp'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, '.me/locks'))).toBeFalse();
  });

  test('preserves an existing README inode and permission bits when replacing it', () => {
    const vault = makeVault('# Existing\n');
    const before = fs.statSync(path.join(vault, 'practices/README.md'));
    const result = write(vault);

    expect(result.status).toBe('committed');
    expect(result.recoveryState).toBe('retained-originals');
    expect(result.recoveries).toHaveLength(1);
    const original = path.join(
      transactionRoot(vault),
      `vault-write-${result.operationId}`,
      'originals/README.md',
    );
    expect(fs.readFileSync(original, 'utf8')).toBe('# Existing\n');
    expect(fs.statSync(original).ino).toBe(before.ino);
    expect(fs.statSync(path.join(vault, 'practices/README.md')).mode & 0o777).toBe(0o640);
    expect(result.warnings.join(' ')).toContain('uid/gid');
    expect(result.recoveries[0].actions.map(action => action.kind)).toEqual([
      'inspect',
      'compare',
      'remove-owned',
    ]);
    expect(result.recoveries[0].directory)
      .toBe(`<ME_RUNTIME>/transactions/vault-write-${result.operationId}`);
  });
});

describe('lock precedence and operation discovery', () => {
  test('an existing lock wins over every incomplete or malformed operation', () => {
    const vault = makeVault();
    const layout = prepareRuntime(vault);
    fs.mkdirSync(path.join(layout.transactionDir, 'vault-write-old'), { recursive: true });
    fs.writeFileSync(path.join(layout.lockDir, 'vault-write.lock'), 'foreign');
    fs.writeFileSync(path.join(layout.transactionDir, 'vault-write-old/journal.json'), '{bad');

    const result = write(vault);
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('LOCK_HELD');
    expect(result.recoveries).toEqual([]);
  });

  test('non-empty vault-local v1.5 state blocks before external runtime mutation', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/tmp/vault-write-old'), { recursive: true });

    const result = write(vault);

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('LEGACY_RUNTIME_STATE');
    expect(fs.existsSync(resolveVaultLayout(vault).runtimeRoot)).toBeFalse();
    expect(fs.existsSync(path.join(vault, '.me/tmp/vault-write-old'))).toBeTrue();
  });

  test('aggregates every no-lock incomplete and unrecognized operation', () => {
    const vault = makeVault();
    const tmp = prepareRuntime(vault).transactionDir;
    fs.mkdirSync(path.join(tmp, 'vault-write-valid'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vault-write-valid/journal.json'), JSON.stringify({
      version: 1,
      operationId: 'valid',
      state: 'staged',
    }));
    fs.mkdirSync(path.join(tmp, 'vault-write-missing'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vault-write-file'), 'not-directory');
    fs.symlinkSync(path.join(vault, 'raw'), path.join(tmp, 'vault-write-link'));

    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('INCOMPLETE_OPERATION');
    expect(result.recoveryState).toBe('incomplete');
    expect(result.recoveries.map(item => item.directory)).toEqual([
      '<ME_RUNTIME>/transactions',
      '<ME_RUNTIME>/transactions',
      '<ME_RUNTIME>/transactions',
      '<ME_RUNTIME>/transactions',
    ]);
    expect(result.recoveries.every(item => isOpaqueRecoveryId(item.operationId))).toBeTrue();
    expect(new Set(result.recoveries.map(item => item.operationId)).size).toBe(4);
    expect(result.recoveries.every(item => item.journal === undefined)).toBeTrue();
    expect(result.recoveries.some(item => item.state === 'incomplete-operation')).toBeTrue();
  });

  test('scans startup recoveries before attempting exclusive lock acquisition', () => {
    const vault = makeVault();
    operation(vault, 'crashed-before-lock', 'staged');
    let opens = 0;
    let releases = 0;

    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      hooks: {
        beforeLockRelease() {
          releases += 1;
        },
      },
      lockOps: {
        openSync(...args: unknown[]) {
          opens += 1;
          return (fs.openSync as (...values: unknown[]) => number)(...args);
        },
      },
    });

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('INCOMPLETE_OPERATION');
    expect(result.recoveries).toHaveLength(1);
    expect(isOpaqueRecoveryId(result.recoveries[0].operationId)).toBeTrue();
    expect(result.recoveries[0].directory).toBe('<ME_RUNTIME>/transactions');
    expect(opens).toBe(0);
    expect(releases).toBe(0);
    expect(fs.existsSync(writerLockPath(vault))).toBeFalse();
  });

  test.each([
    'write',
    'fsync',
    'fchmod',
    'lstat',
    'ownership',
  ] as const)('closes the acquisition descriptor and safely handles an injected %s failure', stage => {
    const vault = makeVault();
    const lockPath = writerLockPath(vault);
    let closes = 0;
    const injected = () => {
      const error = new Error(`injected ${stage}`) as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    };

    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      lockOps: {
        ...(stage === 'write' ? { writeFileSync: injected } : {}),
        ...(stage === 'fsync' ? { fsyncSync: injected } : {}),
        ...(stage === 'fchmod' ? { fchmodSync: injected } : {}),
        ...(stage === 'lstat' ? { lstatSync: injected } : {}),
        ...(stage === 'ownership' ? { readFileSync: injected } : {}),
        closeSync(descriptor: number) {
          closes += 1;
          fs.closeSync(descriptor);
        },
      },
    });

    expect(closes).toBe(1);
    if (stage === 'write') {
      expect(result.status).toBe('manual_recovery');
      expect(result.error?.code).toBe('RECOVERY_REQUIRED');
      expect(result.recoveries.map(item => item.state)).toEqual(['ownership-conflict']);
      expect(fs.existsSync(lockPath)).toBeTrue();
    } else {
      expect(result.status).toBe('validation_failed');
      expect(result.error?.code).toBe('INTERNAL_ERROR');
      expect(result.recoveries).toEqual([]);
      expect(fs.existsSync(lockPath)).toBeFalse();
    }
  });

  test('preserves a lock replacement introduced between acquisition identity checks', () => {
    const vault = makeVault();
    const lockPath = writerLockPath(vault);
    let inspected = false;
    let closes = 0;

    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      lockOps: {
        lstatSync(candidate: fs.PathLike, options?: fs.StatOptions) {
          const stat = fs.lstatSync(candidate, options as never);
          if (candidate === lockPath && !inspected) {
            inspected = true;
            fs.unlinkSync(lockPath);
            fs.writeFileSync(lockPath, 'foreign replacement');
          }
          return stat as never;
        },
        closeSync(descriptor: number) {
          closes += 1;
          fs.closeSync(descriptor);
        },
      },
    });

    expect(closes).toBe(1);
    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(result.recoveries.map(item => item.state)).toEqual(['ownership-conflict']);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign replacement');
  });

  test('aggregates a racing startup operation with acquisition cleanup recovery', () => {
    const vault = makeVault();
    const lockPath = writerLockPath(vault);

    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      lockOps: {
        writeFileSync() {
          operation(vault, 'raced-startup', 'staged');
          const error = new Error('injected acquisition write failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    });

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(result.recoveries.map(item => item.operationId)).toContain(result.operationId);
    expect(result.recoveries.some(item => isOpaqueRecoveryId(item.operationId))).toBeTrue();
    expect(result.recoveries.map(item => item.state).sort()).toEqual([
      'incomplete-operation',
      'ownership-conflict',
    ]);
    expect(fs.existsSync(lockPath)).toBeTrue();
  });

  test('aggregates a racing startup operation with lock release recovery', () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, 'SCHEMA.md'), 'unsupported schema');

    const result = write(vault, {
      beforeLockRelease(lockPath) {
        operation(vault, 'raced-release', 'staged');
        fs.writeFileSync(lockPath, 'foreign release replacement');
      },
    });

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(result.recoveries.map(item => item.operationId)).toContain(result.operationId);
    expect(result.recoveries.some(item => isOpaqueRecoveryId(item.operationId))).toBeTrue();
    expect(result.recoveries.map(item => item.state).sort()).toEqual([
      'incomplete-operation',
      'ownership-conflict',
    ]);
  });

  test('aggregates a racing startup operation with final lock release recovery', () => {
    const vault = makeVault();
    const result = write(vault, {
      beforeLockRelease(lockPath) {
        operation(vault, 'raced-final-release', 'staged');
        fs.writeFileSync(lockPath, 'foreign final release replacement');
      },
    });

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(result.recoveries.map(item => item.operationId)).toContain(result.operationId);
    expect(result.recoveries.some(item => isOpaqueRecoveryId(item.operationId))).toBeTrue();
    expect(result.recoveries.map(item => item.state).sort()).toEqual([
      'incomplete-operation',
      'ownership-conflict',
    ]);
  });

  test('a minimal committed marker without exact committed content is unrecognized', () => {
    const vault = makeVault();
    const tmp = prepareRuntime(vault).transactionDir;
    fs.mkdirSync(path.join(tmp, 'vault-write-done'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vault-write-done/journal.json'), JSON.stringify({
      version: 1,
      operationId: 'done',
      state: 'committed',
    }));
    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries[0].state).toBe('unrecognized-operation');
  });

  test.each([
    'locked',
    'staged',
    'note-published',
    'index-preserved',
    'index-published',
    'validated',
  ])('recognizes %s as an incomplete no-lock journal without deleting it', state => {
    const vault = makeVault();
    const directory = operation(vault, `state-${state}`, state);
    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries).toHaveLength(1);
    expect(result.recoveries[0].state).toBe('incomplete-operation');
    expect(fs.existsSync(directory)).toBeTrue();
  });

  test('classifies malformed, unknown, mismatched, symlink and non-file journals', () => {
    const vault = makeVault();
    const tmp = prepareRuntime(vault).transactionDir;
    operation(vault, 'unknown-state', 'future');
    operation(vault, 'unknown-version', 'staged', { version: 2 });
    const mismatch = operation(vault, 'directory-id', 'staged', { operationId: 'journal-id' });
    const malformed = path.join(tmp, 'vault-write-malformed');
    fs.mkdirSync(malformed);
    fs.writeFileSync(path.join(malformed, 'journal.json'), '{bad');
    const symlink = path.join(tmp, 'vault-write-journal-link');
    fs.mkdirSync(symlink);
    fs.symlinkSync(path.join(vault, 'raw/source.md'), path.join(symlink, 'journal.json'));
    const nonfile = path.join(tmp, 'vault-write-journal-dir');
    fs.mkdirSync(path.join(nonfile, 'journal.json'), { recursive: true });

    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries).toHaveLength(6);
    expect(result.recoveries.every(item => item.state === 'unrecognized-operation')).toBeTrue();
    expect(result.recoveries.filter(item =>
      ['unknown-state', 'unknown-version', 'directory-id']
        .some(name => item.directory.endsWith(name)))
      .every(item => item.journal?.endsWith('/journal.json'))).toBeTrue();
    expect(result.recoveries.filter(item =>
      ['malformed', 'journal-link', 'journal-dir']
        .some(name => item.directory.endsWith(name)))
      .every(item => item.journal === undefined)).toBeTrue();
    expect(fs.existsSync(mismatch)).toBeTrue();
  });

  test('uses injected read failures rather than permission assumptions', () => {
    const vault = makeVault();
    const directory = operation(vault, 'unreadable', 'staged');
    const journal = path.join(directory, 'journal.json');
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      fileOps: {
        readFileSync(candidate, ...args: unknown[]) {
          if (candidate === journal) {
            const error = new Error('injected') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }
          return (fs.readFileSync as (...values: unknown[]) => unknown)(candidate, ...args) as never;
        },
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries[0].state).toBe('unrecognized-operation');
    expect(result.recoveries[0].journal).toBeUndefined();
  });

  test('marks every entry that shares a duplicate journal operationId', () => {
    const vault = makeVault();
    operation(vault, 'duplicate', 'staged');
    operation(vault, 'other-directory', 'staged', { operationId: 'duplicate' });
    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries).toHaveLength(2);
    expect(result.recoveries.every(item =>
      isOpaqueRecoveryId(item.operationId)
      && item.state === 'unrecognized-operation'
      && item.directory === '<ME_RUNTIME>/transactions')).toBeTrue();
    expect(new Set(result.recoveries.map(item => item.operationId)).size).toBe(2);
  });

  test('rejects a journal whose path metadata contradicts vault containment', () => {
    const vault = makeVault();
    operation(vault, 'unsafe-path', 'staged', { notePath: '../../outside.md' });
    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries[0].state).toBe('unrecognized-operation');
    expect(isOpaqueRecoveryId(result.recoveries[0].operationId)).toBeTrue();
    expect(result.recoveries[0].directory).toBe('<ME_RUNTIME>/transactions');
    expect(result.recoveries[0].journal).toBeUndefined();
  });

  test('a lock replaced before release is preserved and reported for recovery', () => {
    const vault = makeVault();
    const result = write(vault, {
      beforeLockRelease(lockPath) {
        fs.writeFileSync(lockPath, 'foreign lock bytes');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.readFileSync(writerLockPath(vault), 'utf8'))
      .toBe('foreign lock bytes');
  });

  test('a final lock descriptor close failure preserves the lock and skips unlink', () => {
    const vault = makeVault();
    const lockPath = writerLockPath(vault);
    const unlinks: string[] = [];
    let closes = 0;
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      hooks: {
        beforeFsMutation(kind, paths) {
          if (kind === 'unlink') unlinks.push(...paths);
        },
      },
      lockOps: {
        closeSync(descriptor: number) {
          closes += 1;
          fs.closeSync(descriptor);
          const error = new Error('injected final close failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      },
    });

    expect(closes).toBe(1);
    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.existsSync(lockPath)).toBeTrue();
    expect(unlinks).not.toContain(lockPath);
    expect(result.recoveries.flatMap(item => item.preservedPaths))
      .toContain('<ME_RUNTIME>/locks/vault-write.lock');
  });

  test('a nested cooperative writer observes LOCK_HELD while the owner completes', () => {
    const vault = makeVault();
    let nested: ReturnType<typeof write> | undefined;
    const outer = write(vault, {
      afterLock() {
        nested = write(vault);
      },
    });
    expect(nested?.status).toBe('conflict');
    expect(nested?.error?.code).toBe('LOCK_HELD');
    expect(outer.status).toBe('committed');
  });

  test('LOCK_HELD precedes schema, target, graph, and recovery planning failures', () => {
    const vault = makeVault();
    const layout = prepareRuntime(vault);
    fs.mkdirSync(path.join(layout.transactionDir, 'vault-write-bad'), { recursive: true });
    fs.writeFileSync(path.join(layout.transactionDir, 'vault-write-bad/journal.json'), '{bad');
    fs.writeFileSync(path.join(layout.lockDir, 'vault-write.lock'), 'foreign lock');
    fs.writeFileSync(path.join(vault, 'SCHEMA.md'), 'unsupported schema');
    fs.mkdirSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ), { recursive: true });

    const result = write(vault);
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('LOCK_HELD');
    expect(result.recoveries).toEqual([]);
  });

  test('a committed journal with pending mutation or leftover staging blocks a new write', () => {
    const vault = makeVault();
    const first = write(vault);
    expect(first.status).toBe('committed');
    const directory = path.join(transactionRoot(vault), `vault-write-${first.operationId}`);
    const journalPath = path.join(directory, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.pendingMutation = { kind: 'unlink', paths: ['staging/note.md'] };
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    fs.mkdirSync(path.join(directory, 'staging'));
    fs.writeFileSync(path.join(directory, 'staging/note.md'), 'leftover');

    const second = executeVaultWrite(
      vault,
      requestAt('decisions/2026-07-27-lotus-choice.md', 'Lotus Choice'),
      { pluginRoot, mode: 'write' },
    );
    expect(second.status).toBe('manual_recovery');
    expect(second.error?.code).toBe('INCOMPLETE_OPERATION');
    expect(second.recoveries[0].state).toBe('unrecognized-operation');
  });

  test('a valid committed operation does not block a different target', () => {
    const vault = makeVault();
    expect(write(vault).status).toBe('committed');
    const second = executeVaultWrite(
      vault,
      requestAt('decisions/2026-07-27-lotus-choice.md', 'Lotus Choice'),
      { pluginRoot, mode: 'write' },
    );
    expect(second.status).toBe('committed');
  });
});

describe('journal acquisition and phase ownership', () => {
  test.each([
    'afterLock',
    'afterStaging',
    'afterNotePublish',
    'afterIndexPublish',
    'beforePostValidation',
    'beforeCommitCleanup',
    'beforeLockRelease',
  ] as const)('preserves a foreign journal replacement at %s', hookName => {
    const vault = makeVault();
    let replacement = '';
    const hooks: VaultWriteHooks = {
      [hookName]: (...args: string[]) => {
        const operationDirectory = hookName === 'beforeCommitCleanup'
          ? args[0]
          : path.join(
            transactionRoot(vault),
            fs.readdirSync(transactionRoot(vault))
              .find(name => name.startsWith('vault-write-'))!,
          );
        const journal = path.join(operationDirectory, 'journal.json');
        if (!fs.existsSync(journal)) return;
        fs.unlinkSync(journal);
        replacement = `foreign-journal-${hookName}`;
        fs.writeFileSync(journal, replacement);
      },
    };
    const result = write(vault, hooks);
    // afterLock now fires before journal creation → no journal to corrupt
    if (hookName === 'afterLock') {
      // Hook may throw because no operationDir exists yet, but the write
      // should still succeed (committed or non-manual_recovery).
      expect(result.status).not.toBe('manual_recovery');
      return;
    }
    expect(result.status).toBe('manual_recovery');
    const journal = result.recoveries.flatMap(item => item.preservedPaths)
      .find(item => item.endsWith('/journal.json'))!;
    expect(fs.readFileSync(absoluteDisplayPath(vault, journal), 'utf8')).toBe(replacement);
  });

  test('never follows or truncates a symlink substituted for the journal', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-journal-outside-');
    const foreign = path.join(outside, 'foreign');
    fs.writeFileSync(foreign, 'outside-bytes');
    const result = write(vault, {
      afterStaging() {
        const operationName = fs.readdirSync(transactionRoot(vault))
          .find(name => name.startsWith('vault-write-'))!;
        const journal = path.join(transactionRoot(vault), operationName, 'journal.json');
        fs.unlinkSync(journal);
        fs.symlinkSync(foreign, journal);
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(fs.readFileSync(foreign, 'utf8')).toBe('outside-bytes');
  });
});

describe('fingerprint, no-clobber, and rollback windows', () => {
  test.each(['afterLock', 'afterStaging'] as const)(
    '%s detects config changes before first publish',
    hookName => {
      const vault = makeVault();
      const hooks: VaultWriteHooks = {
        [hookName]: () => {
          fs.writeFileSync(path.join(vault, '.me/config.yaml'), '# concurrent edit\n');
        },
      };
      const result = write(vault, hooks);
      expect(result.status).toBe('conflict');
      expect(result.error?.code).toBe('INPUT_CHANGED');
      expect(fs.existsSync(path.join(
        vault,
        'practices/decisions/2026-07-26-orchid-choice.md',
      ))).toBeFalse();
    },
  );

  test('a clean pre-publish conflict removes its journal and does not poison the next write', () => {
    const vault = makeVault();
    const config = path.join(vault, '.me/config.yaml');
    const first = write(vault, {
      afterLock() {
        fs.writeFileSync(config, '# external snapshot change\n');
      },
    });
    expect(first.status).toBe('conflict');
    expect(fs.readdirSync(transactionRoot(vault))
      .filter(name => name.startsWith('vault-write-'))).toEqual([]);
    fs.unlinkSync(config);
    expect(write(vault).status).toBe('committed');
  });

  test('preserves a foreign target created in beforeNotePublish', () => {
    const vault = makeVault();
    const target = path.join(vault, 'practices/decisions/2026-07-26-orchid-choice.md');
    const result = write(vault, {
      beforeNotePublish(notePath) {
        fs.mkdirSync(path.dirname(notePath), { recursive: true });
        fs.writeFileSync(notePath, 'foreign target');
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('TARGET_EXISTS');
    expect(fs.readFileSync(target, 'utf8')).toBe('foreign target');
    expect(fs.existsSync(path.join(vault, 'practices/README.md'))).toBeFalse();
  });

  test('accepts post-publish hard-link churn that returns to the expected lineage state', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-lineage-churn-');
    const result = write(vault, {
      afterNotePublish(notePath) {
        const transient = path.join(outside, 'transient-link.md');
        fs.linkSync(notePath, transient);
        fs.unlinkSync(transient);
      },
    });

    expect(result.status).toBe('committed');
    expect(result.error).toBeUndefined();
  });

  test('rejects a persistent post-publish extra hard link outside the vault', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-lineage-extra-');
    const extra = path.join(outside, 'extra-link.md');
    const result = write(vault, {
      afterNotePublish(notePath) {
        fs.linkSync(notePath, extra);
      },
    });

    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.existsSync(extra)).toBeTrue();
  });

  test('detects target-parent metadata changes in the final pre-publish window', () => {
    const vault = makeVault();
    const result = write(vault, {
      beforeNotePublish(notePath) {
        fs.chmodSync(path.dirname(notePath), 0o755);
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
  });

  test.each(['EXDEV', 'EPERM'])('fails closed when hard links return %s', code => {
    const vault = makeVault();
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      fileOps: {
        linkSync() {
          const error = new Error(code) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        },
      },
    });
    expect(result.status).toBe('unsupported');
    expect(result.error?.code).toBe('UNSUPPORTED_FILESYSTEM');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
  });

  test('rolls back an owned note after post-validation input change', () => {
    const vault = makeVault();
    const result = write(vault, {
      beforePostValidation() {
        fs.writeFileSync(path.join(vault, 'raw/source.md'), '# Changed\n');
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
    expect(fs.existsSync(path.join(vault, 'practices/README.md'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, 'practices/decisions'))).toBeFalse();
  });

  test('preserves an externally edited published note and requires recovery', () => {
    const vault = makeVault();
    const target = path.join(vault, 'practices/decisions/2026-07-26-orchid-choice.md');
    const result = write(vault, {
      afterNotePublish() {
        fs.writeFileSync(target, 'external note bytes');
        fs.writeFileSync(path.join(vault, 'raw/source.md'), '# Changed\n');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.readFileSync(target, 'utf8')).toBe('external note bytes');
    expect(result.recoveries.some(item =>
      item.preservedPaths.includes('practices/decisions/2026-07-26-orchid-choice.md')))
      .toBeTrue();
  });

  test('fingerprint transient contains deterministic sorted graph and decimal metadata', () => {
    const vault = makeVault();
    let fingerprint: Record<string, unknown> | undefined;
    const result = write(vault, {
      afterStaging() {
        const tmp = transactionRoot(vault);
        const operationName = fs.readdirSync(tmp).find(name => name.startsWith('vault-write-'))!;
        fingerprint = JSON.parse(fs.readFileSync(
          path.join(tmp, operationName, 'fingerprint.json'),
          'utf8',
        ));
      },
    });
    expect(result.status).toBe('committed');
    const inputs = fingerprint?.graphInputs as Array<{ path: string; identity: string }>;
    expect(inputs.map(item => item.path)).toEqual([...inputs.map(item => item.path)].sort());
    const identity = JSON.parse(inputs[0].identity);
    expect(Object.keys(identity)).toEqual(['entry', 'target', 'canonicalPath']);
    expect(identity.entry.dev).toMatch(/^\d+$/);
    expect(identity.target.ino).toMatch(/^\d+$/);
  });

  test.each([
    ['schema document', 'afterLock', 'SCHEMA.md'],
    ['graph input', 'afterStaging', 'raw/source.md'],
  ] as const)('detects changed %s before first publish', (_name, hook, relative) => {
    const vault = makeVault();
    const result = write(vault, {
      [hook]: () => fs.appendFileSync(path.join(vault, relative), '\nexternal\n'),
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
  });

  test('detects same-byte schema inode replacement before publish', () => {
    const vault = makeVault();
    const schema = path.join(vault, 'SCHEMA.md');
    const bytes = fs.readFileSync(schema);
    const result = write(vault, {
      afterStaging() {
        const replacement = path.join(vault, 'replacement-schema');
        fs.writeFileSync(replacement, bytes);
        fs.renameSync(replacement, schema);
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
  });

  test('detects plugin template drift through a private plugin fixture', () => {
    const vault = makeVault();
    const isolatedPlugin = temporaryDirectory('me-plugin-transaction-');
    fs.cpSync(path.join(pluginRoot, 'templates'), path.join(isolatedPlugin, 'templates'), {
      recursive: true,
    });
    const result = executeVaultWrite(vault, request(), {
      pluginRoot: isolatedPlugin,
      mode: 'write',
      hooks: {
        afterLock() {
          fs.appendFileSync(path.join(isolatedPlugin, 'templates/practices-template.md'), '\n');
        },
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
  });

  test.each(['transactions', 'locks'] as const)(
    'fingerprints external runtime %s metadata after lock acquisition',
    internal => {
      const vault = makeVault();
      const result = write(vault, {
        afterLock() {
          const layout = resolveVaultLayout(vault);
          fs.chmodSync(
            internal === 'transactions' ? layout.transactionDir : layout.lockDir,
            0o755,
          );
        },
      });
      expect(result.status).toBe('conflict');
      expect(result.error?.code).toBe('INPUT_CHANGED');
    },
  );

  test('fingerprints every existing target-prefix directory', () => {
    const vault = makeVault();
    const parent = path.join(vault, 'practices/decisions');
    fs.mkdirSync(parent);
    const result = write(vault, {
      afterLock() {
        fs.chmodSync(parent, 0o700);
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
  });
});

describe('README concurrency and cleanup ownership', () => {
  test('ordinary README edit before preserve is not overwritten', () => {
    const vault = makeVault('# Original\n');
    const result = write(vault, {
      beforeIndexPreserve(readme) {
        fs.writeFileSync(readme, '# Foreign edit\n');
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    expect(fs.readFileSync(path.join(vault, 'practices/README.md'), 'utf8'))
      .toBe('# Foreign edit\n');
  });

  test('foreign README create after preserve and retained original are both preserved', () => {
    const vault = makeVault('# Original\n');
    const result = write(vault, {
      afterIndexPreserve() {
        fs.writeFileSync(path.join(vault, 'practices/README.md'), '# Foreign create\n');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(fs.readFileSync(path.join(vault, 'practices/README.md'), 'utf8'))
      .toBe('# Foreign create\n');
    const original = path.join(
      transactionRoot(vault),
      `vault-write-${result.operationId}`,
      'originals/README.md',
    );
    expect(fs.readFileSync(original, 'utf8')).toBe('# Original\n');
  });

  test('an external write through the moved README inode is retained for inspection', () => {
    const vault = makeVault('# Original\n');
    const result = write(vault, {
      afterIndexPreserve(original) {
        fs.writeFileSync(original, '# Open editor write\n');
      },
    });
    expect(result.status).toBe('manual_recovery');
    const original = result.recoveries.flatMap(item => item.preservedPaths)
      .find(item => item.endsWith('/originals/README.md'))!;
    expect(fs.readFileSync(absoluteDisplayPath(vault, original), 'utf8'))
      .toBe('# Open editor write\n');
  });

  test('an externally edited published README and original are both preserved', () => {
    const vault = makeVault('# Original\n');
    const readme = path.join(vault, 'practices/README.md');
    const result = write(vault, {
      afterIndexPublish() {
        fs.writeFileSync(readme, '# External published edit\n');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(fs.readFileSync(readme, 'utf8')).toBe('# External published edit\n');
    expect(result.recoveries.flatMap(item => item.preservedPaths)
      .some(item => item.endsWith('/originals/README.md'))).toBeTrue();
  });

  test('foreign staging bytes at commit cleanup are retained without being echoed', () => {
    const vault = makeVault();
    const result = write(vault, {
      beforeCommitCleanup(operationDir) {
        const staged = path.join(operationDir, 'staging/note.md');
        fs.unlinkSync(staged);
        fs.writeFileSync(staged, 'cleanup-secret');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(JSON.stringify(result)).not.toContain('cleanup-secret');
    expect(result.recoveries.some(item =>
      item.preservedPaths.some(itemPath => itemPath.endsWith('/staging/note.md'))))
      .toBeTrue();
  });

  test('all five mutation kinds pass exact ordered paths to the universal hook', () => {
    const vault = makeVault('# Existing\n');
    const seen = new Map<string, string[][]>();
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        seen.set(kind, [...(seen.get(kind) ?? []), paths]);
      },
    });
    expect(result.status).toBe('committed');
    for (const kind of ['link', 'rename', 'unlink', 'mkdir', 'rmdir']) {
      expect(seen.has(kind)).toBeTrue();
      for (const paths of seen.get(kind) ?? []) {
        expect(paths).toHaveLength(kind === 'link' || kind === 'rename' ? 2 : 1);
      }
    }
  });

  test('generic link window preserves a concurrently created destination', () => {
    const vault = makeVault();
    let injected = false;
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        if (kind !== 'link' || injected || !paths[1].endsWith('orchid-choice.md')) return;
        injected = true;
        fs.writeFileSync(paths[1], 'foreign link destination');
      },
    });
    expect(result.status).toBe('conflict');
    expect(fs.readFileSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ), 'utf8')).toBe('foreign link destination');
  });

  test('generic rename window never overwrites a foreign original destination', () => {
    const vault = makeVault('# Original\n');
    let injected = false;
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        if (kind !== 'rename' || injected) return;
        injected = true;
        fs.writeFileSync(paths[1], 'foreign original destination');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(fs.readFileSync(path.join(vault, 'practices/README.md'), 'utf8'))
      .toBe('# Original\n');
    expect(result.recoveries.flatMap(item => item.preservedPaths)
      .some(item => item.endsWith('/originals/README.md'))).toBeTrue();
  });

  test('generic mkdir window rejects an escaping symlink without touching outside', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-transaction-outside-');
    let injected = false;
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        if (kind !== 'mkdir' || injected || !paths[0].endsWith('transactions')) return;
        injected = true;
        fs.symlinkSync(outside, paths[0]);
      },
    });
    expect(result.status).toBe('validation_failed');
    expect(result.error?.code).toBe('UNSAFE_PATH');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('generic rmdir window rejects a replaced staging directory symlink', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-transaction-rmdir-outside-');
    fs.writeFileSync(path.join(outside, 'keep'), 'outside');
    let injected = false;
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        if (kind !== 'rmdir' || injected || !paths[0].endsWith('/staging')) return;
        injected = true;
        fs.rmdirSync(paths[0]);
        fs.symlinkSync(outside, paths[0]);
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('outside');
  });

  test('generic unlink window preserves a replaced staging file', () => {
    const vault = makeVault();
    let injected = false;
    const result = write(vault, {
      beforeFsMutation(kind, paths) {
        if (kind !== 'unlink' || injected || !paths[0].endsWith('/staging/note.md')) return;
        injected = true;
        fs.unlinkSync(paths[0]);
        fs.writeFileSync(paths[0], 'foreign unlink bytes');
      },
    });
    expect(result.status).toBe('manual_recovery');
    expect(injected).toBeTrue();
    const staged = result.recoveries.flatMap(item => item.preservedPaths)
      .find(item => item.endsWith('/staging/note.md'))!;
    expect(fs.readFileSync(absoluteDisplayPath(vault, staged), 'utf8'))
      .toBe('foreign unlink bytes');
  });

  test.each(['replace', 'edit', 'hardlink'] as const)(
    'revalidates staged note source after the universal link hook: %s',
    mutation => {
      const vault = makeVault();
      const extra = path.join(vault, 'staged-extra');
      let injected = false;
      const result = write(vault, {
        beforeFsMutation(kind, paths) {
          if (
            kind !== 'link'
            || injected
            || !paths[1].endsWith('/2026-07-26-orchid-choice.md')
          ) return;
          injected = true;
          if (mutation === 'replace') {
            fs.unlinkSync(paths[0]);
            fs.writeFileSync(paths[0], 'foreign staged replacement');
          } else if (mutation === 'edit') {
            fs.writeFileSync(paths[0], 'foreign staged edit');
          } else {
            fs.linkSync(paths[0], extra);
          }
        },
      });
      expect(result.status).not.toBe('committed');
      expect(fs.existsSync(path.join(
        vault,
        'practices/decisions/2026-07-26-orchid-choice.md',
      ))).toBeFalse();
      if (mutation === 'hardlink') {
        expect(fs.readFileSync(extra, 'utf8')).toContain('Orchid Choice');
      }
    },
  );

  test.each(['staging', 'target-parent'] as const)(
    'does not rmdir a contained directory substituted for owned %s',
    target => {
      const vault = makeVault();
      let injected = false;
      const result = write(vault, {
        beforePostValidation() {
          fs.writeFileSync(path.join(vault, 'raw/source.md'), '# force rollback\n');
        },
        beforeFsMutation(kind, paths) {
          if (kind !== 'rmdir' || injected) return;
          const matches = target === 'staging'
            ? paths[0].endsWith('/staging')
            : paths[0].endsWith('/practices/decisions');
          if (!matches) return;
          injected = true;
          fs.rmdirSync(paths[0]);
          fs.mkdirSync(paths[0]);
        },
      });
      expect(result.status).toBe('manual_recovery');
      const replaced = result.recoveries.flatMap(item => item.preservedPaths)
        .find(item => target === 'staging'
          ? item.endsWith('/staging')
          : item.endsWith('practices/decisions'))!;
      expect(fs.statSync(absoluteDisplayPath(vault, replaced)).isDirectory()).toBeTrue();
    },
  );

  test('compares a moved README against the pre-rename snapshot', () => {
    const vault = makeVault('# Original\n');
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      fileOps: {
        renameSync(source, destination) {
          fs.renameSync(source, destination);
          fs.writeFileSync(destination, '# Changed after rename\n');
        },
      },
    });
    expect(result.status).toBe('manual_recovery');
    const recovery = result.recoveries.find(item =>
      item.preservedPaths.some(itemPath => itemPath.endsWith('/originals/README.md')))!;
    expect(recovery.actions.map(action => action.kind)).toEqual([
      'inspect',
      'compare',
      'remove-owned',
    ]);
  });

  test('preflights both links before publishing the note', () => {
    const vault = makeVault('# Existing\n');
    let links = 0;
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      fileOps: {
        linkSync(source, destination) {
          links += 1;
          if (links === 2) {
            const error = new Error('second link unsupported') as NodeJS.ErrnoException;
            error.code = 'EXDEV';
            throw error;
          }
          fs.linkSync(source, destination);
        },
      },
    });
    expect(result.status).toBe('unsupported');
    expect(result.error?.code).toBe('UNSUPPORTED_FILESYSTEM');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
    expect(fs.readFileSync(path.join(vault, 'practices/README.md'), 'utf8'))
      .toBe('# Existing\n');
  });

  test('treats directory fsync EIO as a safe failure, never a warning-only commit', () => {
    const vault = makeVault();
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      ...({
        directoryFsync(directory: string) {
          if (directory.endsWith('/decisions')) {
            const error = new Error('disk failure') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
        },
      } as object),
    } as Parameters<typeof executeVaultWrite>[2]);
    expect(result.status).not.toBe('committed');
    expect(fs.existsSync(path.join(
      vault,
      'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
  });

  test('downgrades a known unsupported directory fsync errno to a warning', () => {
    const vault = makeVault();
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      ...({
        directoryFsync() {
          const error = new Error('unsupported') as NodeJS.ErrnoException;
          error.code = 'ENOTSUP';
          throw error;
        },
      } as object),
    } as Parameters<typeof executeVaultWrite>[2]);
    expect(result.status).toBe('committed');
    expect(result.warnings).toContain('Directory fsync is not supported on this filesystem.');
  });

  // ── afterAuthoritativePlan callback ──────────────────────────────────

  test('invokes afterAuthoritativePlan with the confirmed plan after lock', () => {
    const vault = makeVault();
    let capturedPlan: unknown = null;
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      afterAuthoritativePlan(plan) {
        capturedPlan = {
          layer: plan.request.layer,
          relativePath: plan.request.relativePath,
          notePath: plan.target.vaultRelativePath,
        };
      },
    });
    expect(result.status).toBe('committed');
    expect(capturedPlan).toEqual({
      layer: 'practices',
      relativePath: 'decisions/2026-07-26-orchid-choice.md',
      notePath: 'practices/decisions/2026-07-26-orchid-choice.md',
    });
  });

  test('afterAuthoritativePlan throwing aborts with INPUT_CHANGED and releases lock', () => {
    const vault = makeVault();
    const lockPath = writerLockPath(vault);
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      afterAuthoritativePlan() {
        throw new Error('distill digest mismatch');
      },
    });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    // Lock must be released
    expect(fs.existsSync(lockPath)).toBeFalse();
    // No note written
    expect(fs.existsSync(path.join(
      vault, 'practices/decisions/2026-07-26-orchid-choice.md',
    ))).toBeFalse();
  });

  test('afterAuthoritativePlan fires before operationDir is created', () => {
    const vault = makeVault();
    let dirExisted = false;
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      afterAuthoritativePlan() {
        // Check that no operation directory exists yet
        const txDir = transactionRoot(vault);
        const children = fs.readdirSync(txDir).filter(n => n.startsWith('vault-write-'));
        dirExisted = children.length > 0;
      },
    });
    expect(result.status).toBe('committed');
    expect(dirExisted).toBeFalse();
  });

  test('afterAuthoritativePlan failure leaves no operationDir or journal', () => {
    const vault = makeVault();
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      afterAuthoritativePlan() {
        throw new Error('callback abort');
      },
    });
    expect(result.status).toBe('conflict');
    // No operation directory left behind
    const txDir = transactionRoot(vault);
    const children = fs.readdirSync(txDir).filter(n => n.startsWith('vault-write-'));
    expect(children.length).toBe(0);
  });

  test('afterAuthoritativePlan has access to full plan fingerprint', () => {
    const vault = makeVault();
    let fingerprintValid = false;
    const result = executeVaultWrite(vault, request(), {
      pluginRoot,
      mode: 'write',
      afterAuthoritativePlan(plan) {
        fingerprintValid =
          typeof plan.fingerprint.requestDigest === 'string'
          && plan.fingerprint.requestDigest.length === 64
          && typeof plan.fingerprint.plannedNoteSha256 === 'string';
      },
    });
    expect(result.status).toBe('committed');
    expect(fingerprintValid).toBeTrue();
  });
});
