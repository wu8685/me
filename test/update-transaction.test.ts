import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import {
  acquireVaultLock,
  releaseVaultLock,
} from '../bin/cooperative-lock.ts';
import { resolveRuntimeLayout } from '../bin/runtime-paths.ts';
import { planVaultUpdate } from '../bin/update/planner.ts';
import { executeVaultUpdate } from '../bin/update/transaction.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
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

function writeFile(
  root: string,
  relativePath: string,
  bytes: string | Buffer,
  mode = 0o644,
): void {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode });
}

function makeVault(): {
  vault: string;
  environment: NodeJS.ProcessEnv;
} {
  const root = temporaryDirectory('me-update-transaction-');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  writeFile(vault, '.me/config.yaml', [
    '# keep this user comment',
    'paths:',
    '  raw: knowledge/raw',
    '  practices: knowledge/practices',
    '  cognition: knowledge/cognition',
    '',
  ].join('\n'), 0o640);
  writeFile(
    vault,
    'SCHEMA.md',
    fs.readFileSync(path.join(
      pluginRoot,
      'templates/migration-history/0000/SCHEMA.md',
    )),
  );
  return {
    vault,
    environment: { ME_RUNTIME_ROOT: path.join(root, 'runtime') },
  };
}

function configVersion(vault: string): unknown {
  return parseDocument(
    fs.readFileSync(path.join(vault, '.me/config.yaml'), 'utf8'),
  ).get('vault_schema_version');
}

describe('me-update transaction', () => {
  test('replans under the shared lock and commits the confirmed digest with config last', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      operationIdFactory: () => '00000000-0000-4000-8000-000000000601',
    });

    expect(result.status).toBe('committed');
    expect(result.error).toBeUndefined();
    expect(result.changedPaths.at(-1)).toBe('.me/config.yaml');
    expect(configVersion(vault)).toBe(1);
    expect(planVaultUpdate({ vaultDir: vault, pluginRoot }).status)
      .toBe('up_to_date');
    expect(executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    }).status).toBe('up_to_date');
  });

  test('rejects a stale preview before staging or vault mutation', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    writeFile(vault, 'AGENTS.md', '# external edit\n');

    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });

    expect(result.error?.code).toBe('STALE_PREVIEW');
    expect(result.changedPaths).toEqual([]);
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'))
      .toBe('# external edit\n');
    expect(configVersion(vault)).toBeUndefined();
    const layout = resolveRuntimeLayout(vault, environment);
    expect(fs.existsSync(layout.transactionDir)
      ? fs.readdirSync(layout.transactionDir)
      : []).toEqual([]);
  });

  test('revalidates the closed plan after staging without publishing stale output', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      hooks: {
        afterStaging() {
          writeFile(vault, 'AGENTS.md', '# arrived after staging\n');
        },
      },
    });

    expect(result.error?.code).toBe('STALE_PREVIEW');
    expect(result.changedPaths).toEqual([]);
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'))
      .toBe('# arrived after staging\n');
    expect(fs.existsSync(path.join(vault, 'CLAUDE.md'))).toBeFalse();
    expect(configVersion(vault)).toBeUndefined();
  });

  test('serializes with the vault-wide lock', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    const lock = acquireVaultLock(layout, {
      operationId: '00000000-0000-4000-8000-000000000602',
      owner: 'ingest',
    });
    try {
      const result = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.error?.code).toBe('UPDATE_IN_PROGRESS');
      expect(configVersion(vault)).toBeUndefined();
    } finally {
      releaseVaultLock(layout, lock);
    }
  });

  test('rolls back owned publications when post-validation fails', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      hooks: {
        beforePostValidation() {
          throw new Error('injected validation failure');
        },
      },
    });

    expect(result.status).toBe('rolled_back');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.changedPaths).toEqual([]);
    expect(configVersion(vault)).toBeUndefined();
    expect(fs.existsSync(path.join(vault, 'AGENTS.md'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, 'CLAUDE.md'))).toBeFalse();

    const retry = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });
    expect(retry.status).toBe('committed');
  });

  test('preserves a journal and requires recovery after post-success ownership loss', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    let injected = false;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      atomicHooks: {
        afterAtomicMutation(kind, phase, paths) {
          if (
            !injected
            && kind === 'link'
            && phase === 'publish'
            && paths.some(candidate => candidate.endsWith('AGENTS.md'))
          ) {
            injected = true;
            throw new Error('success then throw');
          }
        },
      },
    });

    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(configVersion(vault)).toBeUndefined();
    expect(result.warnings.some(item => (
      item.startsWith('<ME_RUNTIME>/transactions/me-update-')
    ))).toBeTrue();
    expect(JSON.stringify(result)).not.toContain(environment.ME_RUNTIME_ROOT!);

    const layout = resolveRuntimeLayout(vault, environment);
    const operation = fs.readdirSync(layout.transactionDir)
      .find(name => name.startsWith('me-update-'));
    expect(operation).toBeDefined();
    const journalPath = path.join(
      layout.transactionDir,
      operation!,
      'journal.json',
    );
    const journalBytes = fs.readFileSync(journalPath, 'utf8');
    const journal = JSON.parse(journalBytes) as Record<string, unknown>;
    expect(journal).toMatchObject({
      version: 1,
      state: 'recovery-required',
      planDigest: preview.planDigest,
      sourceVaultSchemaVersion: 0,
      targetVaultSchemaVersion: 1,
      migrationIds: ['0000-to-0001'],
    });
    expect(journalBytes).not.toContain('desiredBytes');
    expect(journalBytes).not.toContain('keep this user comment');
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(journalPath)).mode & 0o777).toBe(0o700);
  });

  test('fails safely before each vault mutation boundary and can retry immediately', () => {
    for (const failAt of [1, 2, 3, 4]) {
      const { vault, environment } = makeVault();
      const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
      const canonicalVault = fs.realpathSync(vault);
      let seen = 0;
      let injected = false;
      const failed = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
        hooks: {
          beforeMutation(_kind, paths) {
            if (!paths.some(candidate => (
              candidate === canonicalVault
              || candidate.startsWith(`${canonicalVault}${path.sep}`)
            ))) return;
            seen += 1;
            if (seen === failAt) {
              injected = true;
              throw new Error(`before vault mutation ${failAt}`);
            }
          },
        },
      });

      expect(injected).toBeTrue();
      expect(['blocked', 'rolled_back']).toContain(failed.status);
      expect(configVersion(vault)).toBeUndefined();
      expect(fs.existsSync(path.join(vault, 'AGENTS.md'))).toBeFalse();
      expect(fs.existsSync(path.join(vault, 'CLAUDE.md'))).toBeFalse();

      const retry = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
      });
      expect(retry.status).toBe('committed');
    }
  });

  test('blocks non-empty legacy vault-local runtime state without applying', () => {
    const { vault, environment } = makeVault();
    writeFile(vault, '.me/tmp/legacy-journal.json', '{}');
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });

    expect(result.error?.code).toBe('LEGACY_RUNTIME_STATE');
    expect(configVersion(vault)).toBeUndefined();
    expect(fs.existsSync(environment.ME_RUNTIME_ROOT!)).toBeFalse();
  });

  test('a held lock takes precedence over an incomplete updater journal', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    const incomplete = path.join(
      layout.transactionDir,
      'me-update-00000000-0000-4000-8000-000000000603',
    );
    fs.mkdirSync(incomplete, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(incomplete, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: '00000000-0000-4000-8000-000000000603',
      state: 'staged',
    }));
    const lock = acquireVaultLock(layout, {
      operationId: '00000000-0000-4000-8000-000000000604',
      owner: 'vault-write',
    });
    try {
      const result = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.error?.code).toBe('UPDATE_IN_PROGRESS');
    } finally {
      releaseVaultLock(layout, lock);
    }
  });

  test('does not report committed when the journal is replaced before lock release', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    let replacement = '';
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      hooks: {
        beforeLockRelease() {
          const operation = fs.readdirSync(layout.transactionDir)
            .find(name => name.startsWith('me-update-'));
          expect(operation).toBeDefined();
          const journal = path.join(
            layout.transactionDir,
            operation!,
            'journal.json',
          );
          replacement = `${journal}.foreign`;
          fs.renameSync(journal, replacement);
          fs.writeFileSync(journal, '{"foreign":true}\n');
        },
      },
    });

    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.readFileSync(path.join(
      path.dirname(replacement),
      'journal.json',
    ), 'utf8')).toBe('{"foreign":true}\n');
    expect(fs.existsSync(replacement)).toBeTrue();
  });

  test('blocks a committed journal that still declares a pending mutation', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    const id = '00000000-0000-4000-8000-000000000605';
    const operation = path.join(layout.transactionDir, `me-update-${id}`);
    fs.mkdirSync(operation, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: id,
      state: 'committed',
      pendingMutation: { kind: 'link', paths: ['AGENTS.md'] },
    }));

    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });
    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(configVersion(vault)).toBeUndefined();
  });
});
