import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import {
  acquireVaultLock,
  releaseVaultLock,
} from '../bin/cooperative-lock.ts';
import { MutationFailure } from '../bin/mutation/contracts.ts';
import { resolveRuntimeLayout } from '../bin/runtime-paths.ts';
import { planVaultUpdate } from '../bin/update/planner.ts';
import {
  executeVaultUpdate,
  inspectVaultUpdateRecovery,
} from '../bin/update/transaction.ts';

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

  test('maps a first-boundary target race to stale preview and preserves the foreign file', () => {
    const { vault, environment } = makeVault();
    const canonicalVault = fs.realpathSync(vault);
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    let injected = false;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      hooks: {
        beforeMutation(kind, paths) {
          if (
            injected
            || kind !== 'link'
            || !paths.includes(path.join(canonicalVault, 'AGENTS.md'))
          ) return;
          injected = true;
          writeFile(vault, 'AGENTS.md', '# foreign winner\n');
          throw new MutationFailure('TARGET_EXISTS');
        },
      },
    });

    expect(injected).toBeTrue();
    expect(result.status).toBe('blocked');
    expect(result.error?.code).toBe('STALE_PREVIEW');
    expect(result.changedPaths).toEqual([]);
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'))
      .toBe('# foreign winner\n');
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

  test('uses a returned ownership proof to roll back a post-success publication error', () => {
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

    expect(result.status).toBe('rolled_back');
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(configVersion(vault)).toBeUndefined();
    expect(result.recoveryState).toBe('rolled_back');
    expect(JSON.stringify(result)).not.toContain(environment.ME_RUNTIME_ROOT!);

    const layout = resolveRuntimeLayout(vault, environment);
    const operation = fs.readdirSync(layout.transactionDir)
      .find(name => name.startsWith('me-update-'));
    expect(operation).toBeUndefined();
  });

  test('rolls config back when publication succeeds but its directory fsync is ambiguous', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const canonicalVault = fs.realpathSync(vault);
    let configPublished = false;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      atomicHooks: {
        afterAtomicMutation(kind, phase, paths) {
          if (
            kind === 'link'
            && phase === 'publish'
            && paths.some(candidate => candidate.endsWith('.me/config.yaml'))
          ) configPublished = true;
        },
      },
      directoryFsync(directory) {
        if (configPublished && directory === path.join(canonicalVault, '.me')) {
          throw Object.assign(new Error('durability ambiguous'), { code: 'EIO' });
        }
        const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      },
    });

    expect(configPublished).toBeTrue();
    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))
      ? configVersion(vault)
      : undefined).toBeUndefined();
    expect(result.changedPaths).toContain('AGENTS.md');
    expect(result.changedPaths).toContain('CLAUDE.md');
    expect(result.recoveryActions[0]?.path)
      .toStartWith('<ME_RUNTIME>/transactions/me-update-');
    expect(result.preservedPaths.some(candidate => (
      candidate.startsWith('<ME_RUNTIME>/transactions/me-update-')
    ))).toBeTrue();
    expect(inspectVaultUpdateRecovery(vault, environment)?.code)
      .toBe('RECOVERY_REQUIRED');
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

  test('preserves an explicit failure code after an exact rollback', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const canonicalVault = fs.realpathSync(vault);
    let vaultBoundaries = 0;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      hooks: {
        beforeMutation(_kind, paths) {
          if (!paths.some(candidate => (
            candidate === canonicalVault
            || candidate.startsWith(`${canonicalVault}${path.sep}`)
          ))) return;
          vaultBoundaries += 1;
          if (vaultBoundaries === 2) {
            throw new MutationFailure('UNSUPPORTED_FILESYSTEM');
          }
        },
      },
    });

    expect(result.status).toBe('rolled_back');
    expect(result.error?.code).toBe('UNSUPPORTED_FILESYSTEM');
    expect(configVersion(vault)).toBeUndefined();
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

  test('rejects minimal committed journals even when an originals directory is present', () => {
    for (const owner of ['me-update', 'vault-write'] as const) {
      const { vault, environment } = makeVault();
      const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
      const layout = resolveRuntimeLayout(vault, environment);
      const id = owner === 'me-update'
        ? '00000000-0000-4000-8000-000000000606'
        : '00000000-0000-4000-8000-000000000607';
      const operation = path.join(layout.transactionDir, `${owner}-${id}`);
      fs.mkdirSync(path.join(operation, 'originals'), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(
        path.join(operation, 'originals', owner === 'me-update'
          ? '000000.original'
          : 'README.md'),
        'foreign residual bytes',
      );
      fs.writeFileSync(
        path.join(operation, 'journal.json'),
        JSON.stringify({
          version: 1,
          operationId: id,
          state: 'committed',
        }),
        { mode: 0o600 },
      );

      const result = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.status).toBe('recovery_required');
      expect(result.error?.code).toBe('RECOVERY_REQUIRED');
      expect(configVersion(vault)).toBeUndefined();
    }
  });

  test('rejects full-shape updater journals with forged completed mutation history', () => {
    const corruptions: Array<
      (completed: Array<{ kind: string; paths: string[] }>) => void
    > = [
      completed => {
        completed[0] = { kind: 'link', paths: ['AGENTS.md'] };
      },
      completed => {
        completed[0] = {
          kind: 'mkdir',
          paths: ['<ME_RUNTIME>/transactions/foreign/staged'],
        };
      },
      completed => {
        completed.reverse();
      },
    ];

    for (const [index, corrupt] of corruptions.entries()) {
      const { vault, environment } = makeVault();
      const id = `00000000-0000-4000-8000-${String(610 + index).padStart(12, '0')}`;
      const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
      expect(executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
        operationIdFactory: () => id,
      }).status).toBe('committed');

      const layout = resolveRuntimeLayout(vault, environment);
      const journalPath = path.join(
        layout.transactionDir,
        `me-update-${id}`,
        'journal.json',
      );
      const journal = JSON.parse(
        fs.readFileSync(journalPath, 'utf8'),
      ) as {
        completedMutations: Array<{ kind: string; paths: string[] }>;
      };
      corrupt(journal.completedMutations);
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
        mode: 0o600,
      });

      const next = planVaultUpdate({ vaultDir: vault, pluginRoot });
      const result = executeVaultUpdate(vault, next.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.status).toBe('recovery_required');
      expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    }
  });

  test('rejects an impossible successful updater mutation discriminant', () => {
    const { vault, environment } = makeVault();
    const id = '00000000-0000-4000-8000-000000000614';
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    expect(executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      operationIdFactory: () => id,
    }).status).toBe('committed');

    const layout = resolveRuntimeLayout(vault, environment);
    const journalPath = path.join(
      layout.transactionDir,
      `me-update-${id}`,
      'journal.json',
    );
    const journal = JSON.parse(
      fs.readFileSync(journalPath, 'utf8'),
    ) as {
      mutations: Array<{
        kind: string;
        path: string;
        source: { type: string; vaultRelativePath: string; mode?: number };
      }>;
    };
    const create = journal.mutations.find(
      mutation => (
        mutation.kind === 'write-file'
        && mutation.source.type === 'missing'
      ),
    );
    expect(create).toBeDefined();
    create!.source = {
      type: 'directory',
      vaultRelativePath: create!.path,
      mode: 0o755,
    };
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
    });

    const next = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, next.planDigest, {
      pluginRoot,
      environment,
    });
    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
  });

  test('rejects a committed updater that cannot end with a config mkdir', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    const id = '00000000-0000-4000-8000-000000000615';
    const operationName = `me-update-${id}`;
    const operation = path.join(layout.transactionDir, operationName);
    const runtimeOperation = `<ME_RUNTIME>/transactions/${operationName}`;
    fs.mkdirSync(operation, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: id,
      state: 'committed',
      planDigest: '1'.repeat(64),
      sourceVaultSchemaVersion: 0,
      targetVaultSchemaVersion: 1,
      migrationIds: ['0000-to-0001'],
      mutations: [{
        kind: 'mkdir',
        path: '.me/config.yaml',
        source: {
          vaultRelativePath: '.me/config.yaml',
          type: 'missing',
        },
        desiredMode: 0o755,
        publishOrder: 0,
      }],
      staged: [],
      completedMutations: [
        { kind: 'mkdir', paths: [`${runtimeOperation}/staged`] },
        { kind: 'mkdir', paths: [`${runtimeOperation}/originals`] },
        { kind: 'mkdir', paths: ['.me/config.yaml'] },
        { kind: 'rmdir', paths: [`${runtimeOperation}/staged`] },
        { kind: 'rmdir', paths: [`${runtimeOperation}/originals`] },
      ],
    }), { mode: 0o600 });

    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });
    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(configVersion(vault)).toBeUndefined();
  });

  test('rejects duplicate and ancestor-overlapping updater targets', () => {
    for (const [index, forgedPath] of [
      'AGENTS.md',
      'AGENTS.md/child',
    ].entries()) {
      const { vault, environment } = makeVault();
      const id = `00000000-0000-4000-8000-${String(616 + index).padStart(12, '0')}`;
      const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
      expect(executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
        operationIdFactory: () => id,
      }).status).toBe('committed');

      const layout = resolveRuntimeLayout(vault, environment);
      const journalPath = path.join(
        layout.transactionDir,
        `me-update-${id}`,
        'journal.json',
      );
      const journal = JSON.parse(
        fs.readFileSync(journalPath, 'utf8'),
      ) as {
        mutations: Array<{
          path: string;
          source: { vaultRelativePath: string };
        }>;
        staged: Array<{ path: string }>;
        completedMutations: Array<{ paths: string[] }>;
      };
      const mutation = journal.mutations.find(
        item => item.path === 'CLAUDE.md',
      );
      const staged = journal.staged.find(
        item => item.path === 'CLAUDE.md',
      );
      expect(mutation).toBeDefined();
      expect(staged).toBeDefined();
      mutation!.path = forgedPath;
      mutation!.source.vaultRelativePath = forgedPath;
      staged!.path = forgedPath;
      for (const completed of journal.completedMutations) {
        completed.paths = completed.paths.map(
          item => item === 'CLAUDE.md' ? forgedPath : item,
        );
      }
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
        mode: 0o600,
      });

      const next = planVaultUpdate({ vaultDir: vault, pluginRoot });
      const result = executeVaultUpdate(vault, next.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.status).toBe('recovery_required');
      expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    }
  });

  test('rejects overlapping endpoints inside an updater rename', () => {
    const { vault, environment } = makeVault();
    const id = '00000000-0000-4000-8000-000000000618';
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    expect(executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      operationIdFactory: () => id,
    }).status).toBe('committed');

    const layout = resolveRuntimeLayout(vault, environment);
    const journalPath = path.join(
      layout.transactionDir,
      `me-update-${id}`,
      'journal.json',
    );
    const journal = JSON.parse(
      fs.readFileSync(journalPath, 'utf8'),
    ) as {
      mutations: Array<Record<string, unknown>>;
      staged: Array<{ path: string }>;
      completedMutations: Array<{ kind: string; paths: string[] }>;
    };
    const mutationIndex = journal.mutations.findIndex(
      item => item.path === 'CLAUDE.md',
    );
    expect(mutationIndex).toBeGreaterThanOrEqual(0);
    const publishOrder = journal.mutations[mutationIndex]
      .publishOrder as number;
    const stagedSuffix =
      `/${String(publishOrder).padStart(6, '0')}.stage`;
    journal.mutations[mutationIndex] = {
      kind: 'rename',
      path: 'notes',
      destinationPath: 'notes/child',
      source: {
        vaultRelativePath: 'notes',
        type: 'file',
        sha256: '3'.repeat(64),
        mode: 0o644,
      },
      destinationSource: {
        vaultRelativePath: 'notes/child',
        type: 'missing',
      },
      publishOrder,
    };
    journal.staged = journal.staged.filter(
      item => item.path !== 'CLAUDE.md',
    );
    journal.completedMutations = journal.completedMutations.flatMap(
      completed => {
        if (
          completed.kind === 'link'
          && completed.paths[1] === 'CLAUDE.md'
        ) {
          return [{
            kind: 'rename',
            paths: ['notes', 'notes/child'],
          }];
        }
        if (
          completed.kind === 'unlink'
          && completed.paths[0]?.endsWith(stagedSuffix)
        ) return [];
        return [completed];
      },
    );
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
    });

    const next = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = executeVaultUpdate(vault, next.planDigest, {
      pluginRoot,
      environment,
    });
    expect(result.status).toBe('recovery_required');
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
  });

  test('accepts only the full committed vault-write journal contract', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const layout = resolveRuntimeLayout(vault, environment);
    const id = '00000000-0000-4000-8000-000000000608';
    const operation = path.join(layout.transactionDir, `vault-write-${id}`);
    fs.mkdirSync(operation, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: id,
      state: 'committed',
      notePath: 'knowledge/raw/2026-07-28-existing.md',
      requestDigest: '1'.repeat(64),
      plannedNoteSha256: '2'.repeat(64),
      metadataPolicy:
        'POSIX mode preserved for replaced README; uid/gid/ACL/xattr/timestamps are not preserved.',
    }), { mode: 0o600 });

    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
    });
    expect(result.status).toBe('committed');
    expect(configVersion(vault)).toBe(1);
  });

  test('rejects committed vault-write residue with a non-v4 id or non-private operation directory', () => {
    for (const variant of ['id', 'mode'] as const) {
      const { vault, environment } = makeVault();
      const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
      const layout = resolveRuntimeLayout(vault, environment);
      const id = variant === 'id'
        ? 'forged-operation'
        : '00000000-0000-4000-8000-000000000609';
      const operation = path.join(
        layout.transactionDir,
        `vault-write-${id}`,
      );
      fs.mkdirSync(operation, {
        recursive: true,
        mode: variant === 'mode' ? 0o755 : 0o700,
      });
      fs.writeFileSync(path.join(operation, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: id,
        state: 'committed',
        notePath: 'knowledge/raw/2026-07-28-existing.md',
        requestDigest: '1'.repeat(64),
        plannedNoteSha256: '2'.repeat(64),
        metadataPolicy:
          'POSIX mode preserved for replaced README; uid/gid/ACL/xattr/timestamps are not preserved.',
      }), { mode: 0o600 });

      const result = executeVaultUpdate(vault, preview.planDigest, {
        pluginRoot,
        environment,
      });
      expect(result.status).toBe('recovery_required');
      expect(result.error?.code).toBe('RECOVERY_REQUIRED');
      expect(configVersion(vault)).toBeUndefined();
    }
  });

  test('fsyncs the operation directory after the first journal and before vault mutation', () => {
    const { vault, environment } = makeVault();
    const canonicalVault = fs.realpathSync(vault);
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    let journalDirectoryDurable = false;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      directoryFsync(directory) {
        if (
          !journalDirectoryDurable
          &&
          path.basename(directory).startsWith('me-update-')
          && fs.existsSync(path.join(directory, 'journal.json'))
        ) {
          const journal = JSON.parse(
            fs.readFileSync(path.join(directory, 'journal.json'), 'utf8'),
          ) as { version?: unknown; state?: unknown };
          expect(journal).toMatchObject({ version: 1, state: 'locked' });
          journalDirectoryDurable = true;
        }
      },
      hooks: {
        beforeMutation(_kind, paths) {
          if (paths.some(candidate => (
            candidate === canonicalVault
            || candidate.startsWith(`${canonicalVault}${path.sep}`)
          ))) {
            expect(journalDirectoryDurable).toBeTrue();
          }
        },
      },
    });

    expect(result.status).toBe('committed');
    expect(journalDirectoryDurable).toBeTrue();
  });

  test('downgrades unsupported operation-directory fsync to one warning', () => {
    const { vault, environment } = makeVault();
    const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
    let injected = false;
    const result = executeVaultUpdate(vault, preview.planDigest, {
      pluginRoot,
      environment,
      directoryFsync(directory) {
        if (
          !injected
          && path.basename(directory).startsWith('me-update-')
          && fs.existsSync(path.join(directory, 'journal.json'))
        ) {
          injected = true;
          const error = new Error('unsupported') as NodeJS.ErrnoException;
          error.code = 'ENOTSUP';
          throw error;
        }
      },
    });

    expect(result.status).toBe('committed');
    expect(injected).toBeTrue();
    expect(result.warnings.filter(item => (
      item === 'Directory fsync is not supported on this filesystem.'
    ))).toHaveLength(1);
  });
});
