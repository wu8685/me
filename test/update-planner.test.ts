import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import {
  planVaultUpdate,
} from '../bin/update/planner.ts';
import type { VaultMigration } from '../bin/update/registry.ts';
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
    for (const name of fs.readdirSync(directory).sort()) {
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
    }),
  };
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
    expect(plan.currentVaultSchemaVersion).toBe(0);
    expect(plan.targetVaultSchemaVersion).toBe(1);
    expect(plan.migrations.map(item => item.id)).toEqual(['0000-to-0001']);
    expect(plan.mutations.at(-1)?.vaultRelativePath).toBe('.me/config.yaml');
    expect(plan.plannedPaths).toEqual(
      plan.mutations.map(mutation => mutation.vaultRelativePath).sort(),
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
    expect(errorCode(() => planVaultUpdate({
      vaultDir: vault,
      pluginRoot: repositoryPluginRoot,
    }))).toBe('MIGRATION_CONFLICT');
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
    expect(errorCode(() => planVaultUpdate({
      vaultDir: vault,
      pluginRoot: plugin,
    }))).toBe('MIGRATION_CONFLICT');
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
    }))).toBe('MIGRATION_CONFLICT');
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
    }))).toBe('UNSAFE_PATH');

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
});
