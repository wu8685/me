import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import {
  planVaultUpdate,
} from '../bin/update/planner.ts';
import type {
  ContentTransformIntent,
  MigrationMutation,
  VaultMigration,
} from '../bin/update/registry.ts';
import { validatePlannedMutations } from '../bin/mutation/contracts.ts';
import { UpdateError } from '../bin/update/contracts.ts';

const repositoryPluginRoot = path.resolve(import.meta.dir, '..');
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

function makeVault(config = [
  '# preserve this comment',
  'paths:',
  '  raw: knowledge/raw',
  '  practices: knowledge/practices',
  '  cognition: knowledge/cognition',
  '',
].join('\n')): string {
  const vault = path.join(temporaryDirectory('me-update-plan-'), 'vault');
  fs.mkdirSync(vault);
  writeFile(vault, '.me/config.yaml', config, 0o640);
  writeFile(
    vault,
    'SCHEMA.md',
    fs.readFileSync(path.join(
      repositoryPluginRoot,
      'templates/migration-history/0000/SCHEMA.md',
    )),
  );
  return vault;
}

function copyPlugin(): string {
  const plugin = path.join(temporaryDirectory('me-update-plugin-'), 'plugin');
  fs.cpSync(repositoryPluginRoot, plugin, {
    recursive: true,
    filter(source) {
      return !source.includes(`${path.sep}.git`)
        && !source.includes(`${path.sep}node_modules`)
        && !source.includes(`${path.sep}graphify-out`);
    },
  });
  return plugin;
}

function copyRunnablePlugin(): string {
  const plugin = copyPlugin();
  fs.symlinkSync(
    path.join(repositoryPluginRoot, 'node_modules'),
    path.join(plugin, 'node_modules'),
    'dir',
  );
  return plugin;
}

function manifest(root: string): Array<{
  path: string;
  type: string;
  mode: number;
  sha256?: string;
}> {
  const result: Array<{
    path: string;
    type: string;
    mode: number;
    sha256?: string;
  }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort(codeUnitCompare)) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        result.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
        visit(absolute);
      } else if (stat.isFile()) {
        result.push({
          path: relative,
          type: 'file',
          mode: stat.mode & 0o777,
          sha256: crypto.createHash('sha256')
            .update(fs.readFileSync(absolute))
            .digest('hex'),
        });
      } else {
        result.push({ path: relative, type: 'special', mode: stat.mode & 0o777 });
      }
    }
  };
  visit(root);
  return result;
}

function mutationFor(
  plan: ReturnType<typeof planVaultUpdate>,
  relativePath: string,
) {
  return plan.mutations.find(
    mutation => mutation.vaultRelativePath === relativePath,
  );
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateError);
    return (error as UpdateError).code;
  }
  return undefined;
}

function configOnlyMigration(
  contentTransforms: ReturnType<VaultMigration['plan']>['contentTransforms'] = [],
): VaultMigration {
  return {
    id: 'fixture-0000-to-0001',
    fromVersion: 0,
    toVersion: 1,
    describe: () => 'Fixture migration',
    plan: () => ({
      configEdits: [{
        kind: 'set',
        path: ['vault_schema_version'],
        value: 1,
      }],
      managedAssets: [],
      contentTransforms,
      mutations: [],
    }),
  };
}

function migrationWithPaths(
  mutations: readonly MigrationMutation[],
): VaultMigration {
  return {
    ...configOnlyMigration(),
    plan: () => ({
      configEdits: [{
        kind: 'set',
        path: ['vault_schema_version'],
        value: 1,
      }],
      managedAssets: [],
      contentTransforms: [],
      mutations,
    }),
  };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function managedTemplate(label: string): string {
  return [
    '<!-- me:managed:start configuration -->',
    '## Configuration',
    '',
    label,
    '<!-- me:managed:end configuration -->',
    '',
  ].join('\n');
}

describe('pure vault update planning', () => {
  test('plans legacy zero to current one without writing and config is last', () => {
    const vault = makeVault();
    writeFile(vault, 'Profiles/private.yaml', 'decision_context:\n  owner: user\n');
    writeFile(vault, 'knowledge/raw/source.md', '# Source\n\nKeep me.\n');
    const before = manifest(vault);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });

    expect(plan.status).toBe('preview');
    expect(plan.conflicts).toEqual([]);
    expect(plan.currentVaultSchemaVersion).toBe(0);
    expect(plan.targetVaultSchemaVersion).toBe(1);
    expect(plan.migrations.map(item => item.id)).toEqual(['0000-to-0001']);
    expect(plan.mutations.at(-1)?.vaultRelativePath).toBe('.me/config.yaml');
    expect(plan.plannedPaths).toEqual(
      plan.mutations
        .map(mutation => mutation.vaultRelativePath)
        .sort(codeUnitCompare),
    );
    expect(plan.diffs.some(item => item.path === '.me/config.yaml')).toBeTrue();
    expect(plan.plannedPaths).not.toContain('Profiles/private.yaml');
    expect(plan.plannedPaths).not.toContain('knowledge/raw/source.md');
    expect(manifest(vault)).toEqual(before);

    const configMutation = mutationFor(plan, '.me/config.yaml');
    expect(configMutation).toMatchObject({
      kind: 'write-file',
      desiredMode: 0o640,
      source: { type: 'file', mode: 0o640 },
    });
    expect(configMutation?.kind === 'write-file'
      && parseDocument(configMutation.desiredBytes.toString('utf8'))
        .get('vault_schema_version')).toBe(1);
  });

  test('returns up_to_date for current vault and refuses a future vault exactly', () => {
    const current = makeVault('vault_schema_version: 1\n');
    const plan = planVaultUpdate({
      vaultDir: current,
      pluginRoot: repositoryPluginRoot,
    });
    expect(plan).toMatchObject({
      status: 'up_to_date',
      currentVaultSchemaVersion: 1,
      targetVaultSchemaVersion: 1,
      migrations: [],
      mutations: [],
      plannedPaths: [],
      diffs: [],
    });

    const future = makeVault('vault_schema_version: 2\n');
    expect(errorCode(() => planVaultUpdate({
      vaultDir: future,
      pluginRoot: repositoryPluginRoot,
    }))).toBe('VAULT_NEWER_THAN_PLUGIN');
  });

  test('rejects malformed config before producing a plan', () => {
    for (const config of [
      'paths: [\n',
      'vault_schema_version: 0\nvault_schema_version: 1\n',
      'vault_schema_version: "0"\n',
    ]) {
      const vault = makeVault(config);
      expect([
        'INVALID_CONFIG',
        'INVALID_VAULT_SCHEMA_VERSION',
      ]).toContain(errorCode(() => planVaultUpdate({
        vaultDir: vault,
        pluginRoot: repositoryPluginRoot,
      })));
    }
  });

  test('creates absent CLAUDE and AGENTS files from their current templates', () => {
    const vault = makeVault();
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    for (const [target, template] of [
      ['AGENTS.md', 'templates/AGENTS-template.md'],
      ['CLAUDE.md', 'templates/CLAUDE-template.md'],
    ] as const) {
      const mutation = mutationFor(plan, target);
      expect(mutation).toMatchObject({
        kind: 'write-file',
        source: { type: 'missing' },
        desiredMode: 0o644,
      });
      expect(mutation?.kind === 'write-file'
        && mutation.desiredBytes.equals(
          fs.readFileSync(path.join(repositoryPluginRoot, template)),
        )).toBeTrue();
    }
  });

  test('merges marked Agent files and preserves bytes outside owned sections', () => {
    const vault = makeVault();
    const current = [
      '# User Rules',
      '',
      'keep before',
      '',
      '<!-- me:managed:start configuration -->',
      '## Configuration',
      '',
      'outdated',
      '<!-- me:managed:end configuration -->',
      '',
      'keep after',
      '',
    ].join('\n');
    writeFile(vault, 'AGENTS.md', current, 0o600);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    const mutation = mutationFor(plan, 'AGENTS.md');
    expect(mutation).toMatchObject({ kind: 'write-file', desiredMode: 0o600 });
    if (!mutation || mutation.kind !== 'write-file') throw new Error('expected AGENTS mutation');
    const desired = mutation.desiredBytes.toString('utf8');
    expect(desired).toContain('# User Rules\n\nkeep before\n');
    expect(desired).toContain('\nkeep after\n');
    expect(desired).not.toContain('outdated');
    expect(desired.match(/me:managed:start/g)?.length).toBe(8);
  });

  test('appends a marked block to unrelated unmarked Agent files byte-for-byte', () => {
    const vault = makeVault();
    const user = Buffer.from('# User Rules\r\n\r\nkeep exact\r\n');
    writeFile(vault, 'AGENTS.md', user, 0o600);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    const mutation = mutationFor(plan, 'AGENTS.md');
    if (!mutation || mutation.kind !== 'write-file') throw new Error('expected AGENTS mutation');
    expect(mutation.desiredBytes.subarray(0, user.length).equals(user)).toBeTrue();
    expect(mutation.desiredBytes.subarray(user.length).toString('utf8')).toBe(
      `\n${fs.readFileSync(
        path.join(repositoryPluginRoot, 'templates/AGENTS-template.md'),
        'utf8',
      )}`,
    );
  });

  test('adopts exact historical CLAUDE bytes but rejects modified legacy ownership', () => {
    const legacy = fs.readFileSync(path.join(
      repositoryPluginRoot,
      'templates/migration-history/0000/CLAUDE-template.md',
    ));
    const vault = makeVault();
    writeFile(vault, 'CLAUDE.md', legacy);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    const mutation = mutationFor(plan, 'CLAUDE.md');
    expect(mutation?.kind === 'write-file'
      && mutation.desiredBytes.equals(fs.readFileSync(path.join(
        repositoryPluginRoot,
        'templates/CLAUDE-template.md',
      )))).toBeTrue();

    fs.appendFileSync(
      path.join(vault, 'CLAUDE.md'),
      '\n## Project Rules\n\nkeep\n',
    );
    const blocked = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.conflicts).toEqual([{
      path: 'CLAUDE.md',
      reason: 'MIGRATION_CONFLICT',
    }]);
  });

  test('explicit Codex-only legacy adoption marks AGENTS and never touches CLAUDE', () => {
    const vault = makeVault();
    const legacy = fs.readFileSync(path.join(
      repositoryPluginRoot,
      'templates/migration-history/0000/CLAUDE-template.md',
    ), 'utf8').replaceAll('/me:', '$me:');
    const projectRules = '\n## Project Rules\n\nKeep exactly.\n';
    writeFile(vault, 'AGENTS.md', `${legacy}${projectRules}`, 0o600);
    fs.mkdirSync(path.join(vault, 'CLAUDE.md'));

    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      managedAgents: ['codex'],
    });

    expect(plan.status).toBe('preview');
    expect(plan.conflicts).toEqual([]);
    expect(plan.plannedPaths).not.toContain('CLAUDE.md');
    expect(plan.warnings).toEqual([
      'LEGACY_AGENT_SECTIONS_ADOPTED: AGENTS.md',
    ]);
    const agents = mutationFor(plan, 'AGENTS.md');
    expect(agents?.kind === 'write-file'
      && agents.desiredBytes.toString('utf8').endsWith(projectRules)).toBeTrue();
    expect(agents?.kind === 'write-file'
      && agents.desiredBytes.toString('utf8').match(/me:managed:start/g)?.length)
      .toBe(8);
    const config = mutationFor(plan, '.me/config.yaml');
    expect(config?.kind === 'write-file'
      && parseDocument(config.desiredBytes.toString('utf8'))
        .toJS().managed_agents).toEqual(['codex']);
  });

  test('explicit legacy adoption still blocks partial or reordered owned sections', () => {
    const vault = makeVault();
    const partial = fs.readFileSync(path.join(
      repositoryPluginRoot,
      'templates/migration-history/0000/CLAUDE-template.md',
    ), 'utf8').replace('## Commands', '## User Commands');
    writeFile(vault, 'AGENTS.md', partial);

    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      managedAgents: ['codex'],
    });

    expect(plan.status).toBe('blocked');
    expect(plan.conflicts).toEqual([{
      path: 'AGENTS.md',
      reason: 'MIGRATION_CONFLICT',
    }]);
  });

  test('replaces SCHEMA only from known historical bytes and preserves its mode', () => {
    const plugin = copyPlugin();
    fs.appendFileSync(
      path.join(plugin, 'templates/SCHEMA.md'),
      '\n<!-- schema v1 -->\n',
    );
    const vault = makeVault();
    fs.chmodSync(path.join(vault, 'SCHEMA.md'), 0o600);
    const plan = planVaultUpdate({ vaultDir: vault, pluginRoot: plugin });
    expect(mutationFor(plan, 'SCHEMA.md')).toMatchObject({
      kind: 'write-file',
      desiredMode: 0o600,
      source: { type: 'file', mode: 0o600 },
    });

    fs.appendFileSync(path.join(vault, 'SCHEMA.md'), '\nuser bytes\n');
    const blocked = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: plugin,
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.conflicts).toEqual([{
      path: 'SCHEMA.md',
      reason: 'MIGRATION_CONFLICT',
    }]);
  });

  test('is idempotent after applying the exact desired file bytes', () => {
    const vault = makeVault();
    const first = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    for (const mutation of first.mutations) {
      if (mutation.kind !== 'write-file') throw new Error('unexpected mutation');
      writeFile(
        vault,
        mutation.vaultRelativePath,
        mutation.desiredBytes,
        mutation.desiredMode,
      );
    }
    const second = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(second.status).toBe('up_to_date');
    expect(second.mutations).toEqual([]);
  });

  test('digest is stable and covers both Agent source and desired bytes', () => {
    const vault = makeVault();
    writeFile(vault, 'AGENTS.md', '# User\n');
    writeFile(vault, 'CLAUDE.md', '# User\n');
    const first = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    const second = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(second.planDigest).toBe(first.planDigest);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);

    fs.appendFileSync(path.join(vault, 'AGENTS.md'), 'agent source change\n');
    const agentSourceChanged = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(agentSourceChanged.planDigest).not.toBe(first.planDigest);
    fs.appendFileSync(path.join(vault, 'CLAUDE.md'), 'claude source change\n');
    const claudeSourceChanged = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(claudeSourceChanged.planDigest).not.toBe(agentSourceChanged.planDigest);

    const plugin = copyPlugin();
    fs.appendFileSync(
      path.join(plugin, 'templates/AGENTS-template.md'),
      '\n<!-- desired AGENTS change -->\n',
    );
    const agentDesiredChanged = planVaultUpdate({ vaultDir: vault, pluginRoot: plugin });
    expect(agentDesiredChanged.planDigest).not.toBe(claudeSourceChanged.planDigest);
    fs.appendFileSync(
      path.join(plugin, 'templates/CLAUDE-template.md'),
      '\n<!-- desired CLAUDE change -->\n',
    );
    const claudeDesiredChanged = planVaultUpdate({ vaultDir: vault, pluginRoot: plugin });
    expect(claudeDesiredChanged.planDigest).not.toBe(agentDesiredChanged.planDigest);
  });

  test('expands content transforms to one closed fingerprinted file list', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'notes/one.md', 'one\n', 0o600);
    writeFile(vault, 'notes/two.md', 'two\n');
    const migration = configOnlyMigration([{
      vaultRelativePaths: ['notes/one.md'],
      transform(relativePath, currentBytes) {
        return Buffer.concat([
          currentBytes,
          Buffer.from(`migrated:${relativePath}\n`),
        ]);
      },
    }]);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [migration],
    });
    expect(plan.plannedPaths).toEqual(['.me/config.yaml', 'notes/one.md']);
    expect(mutationFor(plan, 'notes/one.md')).toMatchObject({
      kind: 'write-file',
      desiredMode: 0o600,
      source: {
        vaultRelativePath: 'notes/one.md',
        type: 'file',
        mode: 0o600,
      },
    });
    expect(mutationFor(plan, 'notes/two.md')).toBeUndefined();

    writeFile(vault, 'notes/added-after-preview.md', 'late\n');
    expect(plan.plannedPaths).toEqual(['.me/config.yaml', 'notes/one.md']);
    expect(plan.mutations.some(mutation => (
      mutation.vaultRelativePath === 'notes/added-after-preview.md'
    ))).toBeFalse();
  });

  test('rejects duplicate transform targets and conflicting operation paths', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'note.md', 'one\n');
    const duplicate = configOnlyMigration([{
      vaultRelativePaths: ['note.md', 'note.md'],
      transform(_relativePath, bytes) {
        return Buffer.concat([bytes, Buffer.from('x')]);
      },
    }]);
    expect(errorCode(() => planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [duplicate],
    }))).toBe('INVALID_MIGRATION_REGISTRY');
  });

  test('rejects unsafe paths, symlinks, and special content targets', () => {
    const outside = path.join(temporaryDirectory('me-update-outside-'), 'config.yaml');
    fs.writeFileSync(outside, 'vault_schema_version: 0\n');
    const symlinkVault = makeVault();
    fs.unlinkSync(path.join(symlinkVault, '.me/config.yaml'));
    fs.symlinkSync(outside, path.join(symlinkVault, '.me/config.yaml'));
    expect(errorCode(() => planVaultUpdate({
      vaultDir: symlinkVault,
      pluginRoot: repositoryPluginRoot,
    }))).toBe('UNSAFE_PATH');

    const transformVault = makeVault('vault_schema_version: 0\n');
    const unsafe = configOnlyMigration([{
      vaultRelativePaths: ['../outside.md'],
      transform(_relativePath, bytes) {
        return bytes;
      },
    }]);
    expect(errorCode(() => planVaultUpdate({
      vaultDir: transformVault,
      pluginRoot: repositoryPluginRoot,
      registry: [unsafe],
    }))).toBe('INVALID_MIGRATION_REGISTRY');

    if (process.platform !== 'win32') {
      const fifo = path.join(transformVault, 'special');
      const result = Bun.spawnSync(['mkfifo', fifo]);
      expect(result.exitCode).toBe(0);
      const special = configOnlyMigration([{
        vaultRelativePaths: ['special'],
        transform(_relativePath, bytes) {
          return bytes;
        },
      }]);
      expect(errorCode(() => planVaultUpdate({
        vaultDir: transformVault,
        pluginRoot: repositoryPluginRoot,
        registry: [special],
      }))).toBe('UNSAFE_PATH');
    }
  });

  test('emits exact unified diffs with only vault-relative paths', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [configOnlyMigration()],
    });
    expect(plan.diffs).toEqual([{
      path: '.me/config.yaml',
      diff: [
        'Index: .me/config.yaml',
        '===================================================================',
        '--- .me/config.yaml\tbefore',
        '+++ .me/config.yaml\tafter',
        '@@ -1,1 +1,1 @@',
        '-vault_schema_version: 0',
        '+vault_schema_version: 1',
        '',
      ].join('\n'),
    }]);
    expect(JSON.stringify(plan)).not.toContain(vault);
    expect(JSON.stringify(plan)).not.toContain(repositoryPluginRoot);
  });

  test('composes a 0-to-1-to-2 chain on one virtual desired view', () => {
    const plugin = copyPlugin();
    writeFile(
      plugin,
      'templates/fixture-agent-v1.md',
      managedTemplate('stage one'),
    );
    writeFile(
      plugin,
      'templates/fixture-agent-v2.md',
      managedTemplate('stage two'),
    );
    const vault = makeVault([
      'vault_schema_version: 0',
      'shared: original',
      '',
    ].join('\n'));
    writeFile(vault, 'notes/shared.md', 'base\n', 0o600);
    writeFile(vault, 'notes/z-stage-zero.md', 'z\n');
    writeFile(vault, 'notes/a-stage-one.md', 'a\n');

    const append = (label: string) => ({
      vaultRelativePaths: ['notes/shared.md'],
      transform(_relativePath: string, currentBytes: Buffer) {
        return Buffer.concat([currentBytes, Buffer.from(`${label}\n`)]);
      },
    });
    const migrations: VaultMigration[] = [
      {
        id: 'fixture-0000-to-0001',
        fromVersion: 0,
        toVersion: 1,
        describe: () => 'stage one',
        plan: () => ({
          configEdits: [
            { kind: 'set', path: ['shared'], value: 'stage-one' },
            { kind: 'set', path: ['vault_schema_version'], value: 1 },
          ],
          managedAssets: [{
            vaultRelativePath: 'AGENTS.md',
            desiredTemplatePath: 'templates/fixture-agent-v1.md',
            strategy: 'merge-owned-sections',
            onAbsent: 'create',
            onUnmarked: 'append-marked-block',
          }],
          contentTransforms: [
            append('stage-one'),
            {
              vaultRelativePaths: ['notes/z-stage-zero.md'],
              transform(_relativePath, currentBytes) {
                return Buffer.concat([currentBytes, Buffer.from('zero\n')]);
              },
            },
          ],
          mutations: [],
        }),
      },
      {
        id: 'fixture-0001-to-0002',
        fromVersion: 1,
        toVersion: 2,
        describe: () => 'stage two',
        plan: () => ({
          configEdits: [
            { kind: 'set', path: ['shared'], value: 'stage-two' },
            { kind: 'set', path: ['vault_schema_version'], value: 2 },
          ],
          managedAssets: [{
            vaultRelativePath: 'AGENTS.md',
            desiredTemplatePath: 'templates/fixture-agent-v2.md',
            strategy: 'merge-owned-sections',
            onAbsent: 'create',
            onUnmarked: 'append-marked-block',
          }],
          contentTransforms: [
            append('stage-two'),
            {
              vaultRelativePaths: ['notes/a-stage-one.md'],
              transform(_relativePath, currentBytes) {
                return Buffer.concat([currentBytes, Buffer.from('one\n')]);
              },
            },
          ],
          mutations: [],
        }),
      },
    ];

    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: plugin,
      registry: migrations,
    });
    expect(plan).toMatchObject({
      status: 'preview',
      currentVaultSchemaVersion: 0,
      targetVaultSchemaVersion: 2,
      migrations: [
        { id: 'fixture-0000-to-0001', description: 'stage one' },
        { id: 'fixture-0001-to-0002', description: 'stage two' },
      ],
      conflicts: [],
    });
    expect(plan.mutations.filter(mutation => (
      mutation.vaultRelativePath === 'notes/shared.md'
    ))).toHaveLength(1);

    const config = mutationFor(plan, '.me/config.yaml');
    if (!config || config.kind !== 'write-file') throw new Error('expected config');
    const configDocument = parseDocument(config.desiredBytes.toString('utf8'));
    expect(configDocument.get('shared')).toBe('stage-two');
    expect(configDocument.get('vault_schema_version')).toBe(2);

    const shared = mutationFor(plan, 'notes/shared.md');
    expect(shared?.kind === 'write-file'
      && shared.desiredBytes.toString('utf8')).toBe(
        'base\nstage-one\nstage-two\n',
      );
    expect(shared).toMatchObject({ desiredMode: 0o600 });

    const agent = mutationFor(plan, 'AGENTS.md');
    expect(agent?.kind === 'write-file'
      && agent.desiredBytes.toString('utf8')).toContain('stage two');
    expect(agent?.kind === 'write-file'
      && agent.desiredBytes.toString('utf8')).not.toContain('stage one');

    const orderedPaths = plan.mutations.map(item => item.vaultRelativePath);
    expect(orderedPaths.indexOf('notes/z-stage-zero.md')).toBeLessThan(
      orderedPaths.indexOf('notes/a-stage-one.md'),
    );
    expect(orderedPaths.at(-1)).toBe('.me/config.yaml');
    expect(plan.mutations.map(item => item.publishOrder)).toEqual(
      plan.mutations.map((_item, index) => index),
    );

    const renamedIds = migrations.map((migration, index) => ({
      ...migration,
      id: `${migration.id}-revision-${index}`,
    }));
    expect(planVaultUpdate({
      vaultDir: vault,
      pluginRoot: plugin,
      registry: renamedIds,
    }).planDigest).not.toBe(plan.planDigest);
  });

  test('collects all ownership conflicts and retains safe preview diffs', () => {
    const vault = makeVault();
    writeFile(vault, 'SCHEMA.md', '# user schema\n');
    writeFile(vault, 'CLAUDE.md', '# Knowledge Base\n\nuser-owned collision\n');
    writeFile(vault, 'AGENTS.md', '## Configuration\n\nuser-owned collision\n');

    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    });
    expect(plan.status).toBe('blocked');
    expect(plan.conflicts).toEqual([
      { path: 'AGENTS.md', reason: 'MIGRATION_CONFLICT' },
      { path: 'CLAUDE.md', reason: 'MIGRATION_CONFLICT' },
      { path: 'SCHEMA.md', reason: 'MIGRATION_CONFLICT' },
    ]);
    expect(plan.plannedPaths).toEqual(['.me/config.yaml']);
    expect(plan.diffs.map(item => item.path)).toEqual(['.me/config.yaml']);
    expect(mutationFor(plan, '.me/config.yaml')).toBeDefined();
  });

  test('orders same-stage paths by explicit UTF-16 code units', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'Z.md', 'Z\n');
    writeFile(vault, 'a.md', 'a\n');
    const migration = configOnlyMigration([{
      vaultRelativePaths: ['a.md', 'Z.md'],
      transform(_relativePath, bytes) {
        return Buffer.concat([bytes, Buffer.from('changed\n')]);
      },
    }]);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [migration],
    });
    expect(plan.mutations.map(item => item.vaultRelativePath)).toEqual([
      'Z.md',
      'a.md',
      '.me/config.yaml',
    ]);
    expect([...plan.plannedPaths].sort(codeUnitCompare)).toEqual(
      plan.plannedPaths,
    );
  });

  test('lowers mkdir and rename declarations into shared transaction mutations', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'notes/old.md', 'preserve exact\n', 0o600);
    const migration = migrationWithPaths([
      {
        kind: 'mkdir',
        vaultRelativePath: 'Z-directory',
        desiredMode: 0o750,
      },
      {
        kind: 'rename',
        vaultRelativePath: 'notes/old.md',
        destinationVaultRelativePath: 'notes/new.md',
      },
    ]);
    const plan = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [migration],
    });

    expect(plan.status).toBe('preview');
    expect(plan.mutations).toHaveLength(3);
    expect(plan.mutations[0]).toMatchObject({
      kind: 'mkdir',
      vaultRelativePath: 'Z-directory',
      source: { vaultRelativePath: 'Z-directory', type: 'missing' },
      desiredMode: 0o750,
      publishOrder: 0,
    });
    expect(plan.mutations[1]).toMatchObject({
      kind: 'rename',
      vaultRelativePath: 'notes/old.md',
      destinationVaultRelativePath: 'notes/new.md',
      source: {
        vaultRelativePath: 'notes/old.md',
        type: 'file',
        mode: 0o600,
      },
      destinationSource: {
        vaultRelativePath: 'notes/new.md',
        type: 'missing',
      },
      publishOrder: 1,
    });
    expect(plan.mutations.at(-1)).toMatchObject({
      kind: 'write-file',
      vaultRelativePath: '.me/config.yaml',
      publishOrder: 2,
    });
    expect(plan.plannedPaths).toEqual([
      '.me/config.yaml',
      'Z-directory',
      'notes/new.md',
      'notes/old.md',
    ]);
    expect(() => validatePlannedMutations(plan.mutations)).not.toThrow();
  });

  test('executes planner-produced mkdir and rename through the real transaction CLI', () => {
    const plugin = copyRunnablePlugin();
    const migrationPath = path.join(
      plugin,
      'bin/update/migrations/0000-to-0001.ts',
    );
    const migrationSource = fs.readFileSync(migrationPath, 'utf8');
    const fixtureMutations = [
      'mutations: [',
      '      {',
      "        kind: 'mkdir',",
      "        vaultRelativePath: 'archive',",
      '        desiredMode: 0o750,',
      '      },',
      '      {',
      "        kind: 'rename',",
      "        vaultRelativePath: 'notes/old.md',",
      "        destinationVaultRelativePath: 'notes/new.md',",
      '      },',
      '    ],',
    ].join('\n');
    expect(migrationSource.match(/    mutations: \[\],/g)).toHaveLength(1);
    fs.writeFileSync(
      migrationPath,
      migrationSource.replace('    mutations: [],', `    ${fixtureMutations}`),
    );

    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'notes/old.md', 'preserve exact\n', 0o600);
    const environment = {
      ...process.env,
      ME_RUNTIME_ROOT: path.join(temporaryDirectory(
        'me-update-structural-runtime-',
      ), 'runtime'),
    };
    const cli = path.join(plugin, 'bin/update.ts');
    const previewProcess = Bun.spawnSync(
      [process.execPath, 'run', cli, 'preview', '--vault-dir', vault],
      { cwd: plugin, env: environment },
    );
    expect(previewProcess.exitCode).toBe(0);
    const preview = JSON.parse(
      previewProcess.stdout.toString('utf8'),
    ) as { status: string; planDigest: string; plannedPaths: string[] };
    expect(preview).toMatchObject({
      status: 'preview',
      plannedPaths: [
        '.me/config.yaml',
        'AGENTS.md',
        'CLAUDE.md',
        'archive',
        'notes/new.md',
        'notes/old.md',
      ],
    });

    const applyProcess = Bun.spawnSync([
      process.execPath,
      'run',
      cli,
      'apply',
      '--vault-dir',
      vault,
      '--expected-plan-digest',
      preview.planDigest,
    ], { cwd: plugin, env: environment });
    expect(applyProcess.exitCode).toBe(0);
    const result = JSON.parse(
      applyProcess.stdout.toString('utf8'),
    ) as { status: string; changedPaths: string[] };
    expect(result.status).toBe('committed');
    expect(result.changedPaths.at(-1)).toBe('.me/config.yaml');
    expect(fs.existsSync(path.join(vault, 'notes/old.md'))).toBeFalse();
    expect(fs.readFileSync(path.join(vault, 'notes/new.md'), 'utf8'))
      .toBe('preserve exact\n');
    expect(fs.statSync(path.join(vault, 'notes/new.md')).mode & 0o777)
      .toBe(0o600);
    expect(fs.statSync(path.join(vault, 'archive')).mode & 0o777)
      .toBe(0o750);
  });

  test('composes independent structural declarations across migration stages and digests source bytes', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    writeFile(vault, 'first.md', 'first\n', 0o600);
    const migrations: VaultMigration[] = [
      {
        ...migrationWithPaths([]),
        plan: () => ({
          configEdits: [{
            kind: 'set',
            path: ['vault_schema_version'],
            value: 1,
          }],
          managedAssets: [],
          contentTransforms: [],
          mutations: [{
            kind: 'mkdir',
            vaultRelativePath: 'directory',
            desiredMode: 0o700,
          }],
        }),
      },
      {
        id: 'fixture-0001-to-0002',
        fromVersion: 1,
        toVersion: 2,
        describe: () => 'Fixture migration stage two',
        plan: () => ({
          configEdits: [{
            kind: 'set',
            path: ['vault_schema_version'],
            value: 2,
          }],
          managedAssets: [],
          contentTransforms: [],
          mutations: [{
            kind: 'rename',
            vaultRelativePath: 'first.md',
            destinationVaultRelativePath: 'second.md',
          }],
        }),
      },
    ];
    const first = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: migrations,
    });
    const repeated = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: migrations,
    });
    expect(first.mutations.map(item => item.kind)).toEqual([
      'mkdir',
      'rename',
      'write-file',
    ]);
    expect(first.mutations.map(item => item.publishOrder)).toEqual([0, 1, 2]);
    expect(first.planDigest).toBe(repeated.planDigest);

    fs.appendFileSync(path.join(vault, 'first.md'), 'changed\n');
    expect(planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: migrations,
    }).planDigest).not.toBe(first.planDigest);
  });

  test('keeps existing directories and aggregates structural precondition conflicts', () => {
    const vault = makeVault('vault_schema_version: 0\n');
    fs.mkdirSync(path.join(vault, 'existing'), { mode: 0o755 });
    writeFile(vault, 'occupied.md', 'occupied\n');
    const satisfied = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [migrationWithPaths([{
        kind: 'mkdir',
        vaultRelativePath: 'existing',
        desiredMode: 0o700,
      }])],
    });
    expect(mutationFor(satisfied, 'existing')).toBeUndefined();

    const blocked = planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
      registry: [migrationWithPaths([{
        kind: 'rename',
        vaultRelativePath: 'missing.md',
        destinationVaultRelativePath: 'occupied.md',
      }])],
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.conflicts).toEqual([
      { path: 'missing.md', reason: 'MIGRATION_CONFLICT' },
      { path: 'occupied.md', reason: 'MIGRATION_CONFLICT' },
    ]);
  });

  test('rejects malformed and cross-intent overlapping path mutations', () => {
    const malformed: MigrationMutation[] = [
      { kind: 'mkdir', vaultRelativePath: '../outside', desiredMode: 0o700 },
      { kind: 'mkdir', vaultRelativePath: 'directory', desiredMode: 0o1000 },
      {
        kind: 'rename',
        vaultRelativePath: 'same.md',
        destinationVaultRelativePath: 'same.md',
      },
      {
        kind: 'rename',
        vaultRelativePath: 'source.md',
        destinationVaultRelativePath: '/absolute.md',
      },
    ];
    for (const pathMutation of malformed) {
      const vault = makeVault('vault_schema_version: 0\n');
      expect(errorCode(() => planVaultUpdate({
        vaultDir: vault,
        pluginRoot: repositoryPluginRoot,
        registry: [migrationWithPaths([pathMutation])],
      }))).toBe('INVALID_MIGRATION_REGISTRY');
    }

    const unknownKeyVault = makeVault('vault_schema_version: 0\n');
    expect(errorCode(() => planVaultUpdate({
      vaultDir: unknownKeyVault,
      pluginRoot: repositoryPluginRoot,
      registry: [migrationWithPaths([{
        kind: 'mkdir',
        vaultRelativePath: 'directory',
        desiredMode: 0o700,
        extra: true,
      } as never])],
    }))).toBe('INVALID_MIGRATION_REGISTRY');

    const overlapVault = makeVault('vault_schema_version: 0\n');
    writeFile(overlapVault, 'notes/file.md', 'note\n');
    const overlap: VaultMigration = {
      ...configOnlyMigration(),
      plan: () => ({
        configEdits: [{
          kind: 'set',
          path: ['vault_schema_version'],
          value: 1,
        }],
        managedAssets: [],
        contentTransforms: [{
          vaultRelativePaths: ['notes/file.md'],
          transform(_relativePath, bytes) {
            return bytes;
          },
        }],
        mutations: [{
          kind: 'mkdir',
          vaultRelativePath: 'notes',
          desiredMode: 0o700,
        }],
      }),
    };
    expect(errorCode(() => planVaultUpdate({
      vaultDir: overlapVault,
      pluginRoot: repositoryPluginRoot,
      registry: [overlap],
    }))).toBe('INVALID_MIGRATION_REGISTRY');
  });

  test('maps every malformed nested migration declaration to INVALID_MIGRATION_REGISTRY', () => {
    const fixtures: Array<() => VaultMigration> = [
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [],
          managedAssets: [],
          contentTransforms: [],
        } as never),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [],
          managedAssets: [],
          contentTransforms: [],
          mutations: [],
          extra: true,
        } as never),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [{
            kind: 'set',
            path: ['vault_schema_version'],
            value: 1,
            extra: true,
          } as never],
          managedAssets: [],
          contentTransforms: [],
          mutations: [],
        }),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [],
          managedAssets: [{
            vaultRelativePath: 'AGENTS.md',
            desiredTemplatePath: 'templates/AGENTS-template.md',
            strategy: 'invented',
            onAbsent: 'create',
            onUnmarked: 'append-marked-block',
          } as never],
          contentTransforms: [],
          mutations: [],
        }),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [],
          managedAssets: [],
          contentTransforms: [{
            vaultRelativePaths: ['../outside.md'],
            transform: (_path, bytes) => bytes,
          }],
          mutations: [],
        }),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => ({
          configEdits: [{
            kind: 'set',
            path: ['vault_schema_version'],
            value: 1,
          }],
          managedAssets: [],
          contentTransforms: [{
            vaultRelativePaths: ['SCHEMA.md'],
            transform: () => 'not bytes' as never,
          }],
          mutations: [],
        }),
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => {
          throw new UpdateError('UNSAFE_PATH');
        },
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => {
          const contentTransforms: ContentTransformIntent[] = [];
          (contentTransforms as ContentTransformIntent[] & { extra: boolean })
            .extra = true;
          return {
            configEdits: [{
              kind: 'set',
              path: ['vault_schema_version'],
              value: 1,
            }],
            managedAssets: [],
            contentTransforms,
            mutations: [],
          };
        },
      }),
      () => ({
        ...configOnlyMigration(),
        plan: () => {
          const mutations: MigrationMutation[] = [];
          (mutations as MigrationMutation[] & { extra: boolean }).extra = true;
          return {
            configEdits: [{
              kind: 'set',
              path: ['vault_schema_version'],
              value: 1,
            }],
            managedAssets: [],
            contentTransforms: [],
            mutations,
          };
        },
      }),
    ];

    for (const fixture of fixtures) {
      const vault = makeVault('vault_schema_version: 0\n');
      expect(errorCode(() => planVaultUpdate({
        vaultDir: vault,
        pluginRoot: repositoryPluginRoot,
        registry: [fixture()],
      }))).toBe('INVALID_MIGRATION_REGISTRY');
    }
  });
});
