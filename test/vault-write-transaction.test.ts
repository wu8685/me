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
  const vault = temporaryDirectory('me-vault-transaction-');
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
  const directory = path.join(vault, '.me/tmp', `vault-write-${operationId}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'journal.json'), JSON.stringify({
    version: 1,
    operationId,
    state,
    ...overrides,
  }));
  return directory;
}

describe('preview and successful journaled create', () => {
  test('preview is byte-for-byte read-only and deterministic apart from operationId', () => {
    const vault = makeVault();
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
    const operation = path.join(vault, '.me/tmp', `vault-write-${result.operationId}`);
    expect(fs.statSync(operation).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(operation).sort()).toEqual(['journal.json']);
    const journal = JSON.parse(fs.readFileSync(path.join(operation, 'journal.json'), 'utf8'));
    expect(journal.state).toBe('committed');
    expect(JSON.stringify(journal)).not.toContain('orchid-body');
    expect(fs.statSync(path.join(operation, 'journal.json')).mode & 0o777).toBe(0o600);
  });

  test('preserves an existing README inode and permission bits when replacing it', () => {
    const vault = makeVault('# Existing\n');
    const before = fs.statSync(path.join(vault, 'practices/README.md'));
    const result = write(vault);

    expect(result.status).toBe('committed');
    expect(result.recoveryState).toBe('retained-originals');
    expect(result.recoveries).toHaveLength(1);
    const original = path.join(
      vault,
      '.me/tmp',
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
  });
});

describe('lock precedence and operation discovery', () => {
  test('an existing lock wins over every incomplete or malformed operation', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/locks'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.me/tmp/vault-write-old'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.me/locks/vault-write.lock'), 'foreign');
    fs.writeFileSync(path.join(vault, '.me/tmp/vault-write-old/journal.json'), '{bad');

    const result = write(vault);
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('LOCK_HELD');
    expect(result.recoveries).toEqual([]);
  });

  test('aggregates every no-lock incomplete and unrecognized operation', () => {
    const vault = makeVault();
    const tmp = path.join(vault, '.me/tmp');
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
      '.me/tmp/vault-write-file',
      '.me/tmp/vault-write-link',
      '.me/tmp/vault-write-missing',
      '.me/tmp/vault-write-valid',
    ]);
    expect(result.recoveries.find(item => item.directory.endsWith('missing'))?.journal).toBeUndefined();
    expect(result.recoveries.find(item => item.directory.endsWith('valid'))?.state)
      .toBe('incomplete-operation');
  });

  test('recognized committed operations do not block another writer', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/tmp/vault-write-done'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.me/tmp/vault-write-done/journal.json'), JSON.stringify({
      version: 1,
      operationId: 'done',
      state: 'committed',
    }));
    expect(write(vault).status).toBe('committed');
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
    const tmp = path.join(vault, '.me/tmp');
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
      item.operationId === 'duplicate' && item.state === 'unrecognized-operation')).toBeTrue();
  });

  test('rejects a journal whose path metadata contradicts vault containment', () => {
    const vault = makeVault();
    operation(vault, 'unsafe-path', 'staged', { notePath: '../../outside.md' });
    const result = write(vault);
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveries[0].state).toBe('unrecognized-operation');
    expect(result.recoveries[0].journal).toBe('.me/tmp/vault-write-unsafe-path/journal.json');
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
    expect(fs.readFileSync(path.join(vault, '.me/locks/vault-write.lock'), 'utf8'))
      .toBe('foreign lock bytes');
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
    expect(fs.readdirSync(path.join(vault, '.me/tmp'))
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
        const tmp = path.join(vault, '.me/tmp');
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
      vault,
      '.me/tmp',
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
    expect(fs.readFileSync(path.join(vault, ...original.split('/')), 'utf8'))
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
        if (kind !== 'mkdir' || injected || !paths[0].endsWith('.me/tmp')) return;
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
    const staged = result.recoveries.flatMap(item => item.preservedPaths)
      .find(item => item.endsWith('/staging/note.md'))!;
    expect(fs.readFileSync(path.join(vault, ...staged.split('/')), 'utf8'))
      .toBe('foreign unlink bytes');
  });
});
