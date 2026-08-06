import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeManagedSections,
  classifySchemaState,
  overallState,
  parseDoctorArguments,
  resolveVaultRoot,
} from '../bin/doctor';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/doctor.ts');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-doctor-test-'));
  fixtures.push(fixture);
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  return vault;
}

function setupHealthyVault(vault: string): void {
  fs.mkdirSync(path.join(vault, '.me'));
  fs.mkdirSync(path.join(vault, 'raw'));
  fs.mkdirSync(path.join(vault, 'practices'));
  fs.mkdirSync(path.join(vault, 'cognition'));
  fs.writeFileSync(
    path.join(vault, '.me', 'config.yaml'),
    ['layers:', '  raw: raw', '  practices: practices', '  cognition: cognition'].join('\n') + '\n',
  );
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  fs.copyFileSync(
    path.join(pluginRoot, 'templates/CLAUDE-template.md'),
    path.join(vault, 'CLAUDE.md'),
  );
}

function invoke(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

describe('parseDoctorArguments', () => {
  test('parses vault-dir and defaults plugin-root', () => {
    const args = parseDoctorArguments(['--vault-dir', '/some/vault']);
    expect(args.vaultDir).toBe('/some/vault');
    expect(args.pluginRoot).toBe(pluginRoot);
    expect(args.installedVersion).toBeUndefined();
  });

  test('accepts plugin-root and installed-version overrides', () => {
    const args = parseDoctorArguments([
      '--vault-dir', '/some/vault',
      '--plugin-root', '/some/plugin',
      '--installed-version', '1.5.0',
    ]);
    expect(args.pluginRoot).toBe('/some/plugin');
    expect(args.installedVersion).toBe('1.5.0');
  });

  test('rejects missing or unknown arguments', () => {
    for (const args of [
      [],
      ['--vault-dir'],
      ['--plugin-root', '/p'],
      ['--vault-dir', '/v', '--bogus', 'x'],
    ]) {
      expect(() => parseDoctorArguments(args)).toThrow();
    }
  });
});

describe('analyzeManagedSections', () => {
  const template = [
    '# Knowledge Base',
    '',
    'intro',
    '',
    '## Configuration',
    '',
    'config body',
    '',
    '## Layer Map',
    '',
    'map body',
    '',
    '## Commands',
    '',
    'cmd body',
    '',
    '## Note Templates',
    '',
    'templates body',
    '',
    '## After Creating a Note',
    '',
    'after body',
    '',
    '## Search',
    '',
    'search body',
    '',
    '## Conventions',
    '',
    'conventions body',
    '',
  ].join('\n');

  const headings = [
    'Knowledge Base',
    'Configuration',
    'Layer Map',
    'Commands',
    'Note Templates',
    'After Creating a Note',
    'Search',
    'Conventions',
  ];

  test('identical vault reports every section present and no reorder', () => {
    const result = analyzeManagedSections(template, template);
    expect(result.sections.map(s => s.state)).toEqual(['present', 'present', 'present', 'present', 'present', 'present', 'present', 'present']);
    expect(result.sections.map(s => s.heading)).toEqual(headings);
    expect(result.reordered).toBeFalse();
  });

  test('missing section is reported missing', () => {
    const vault = template.replace('## Commands', '## Renamed Commands');
    const result = analyzeManagedSections(vault, template);
    const commands = result.sections.find(s => s.heading === 'Commands');
    expect(commands?.state).toBe('missing');
  });

  test('duplicated heading is reported duplicated', () => {
    const vault = template.replace('## Commands', '## Commands\n## Commands');
    const result = analyzeManagedSections(vault, template);
    const commands = result.sections.find(s => s.heading === 'Commands');
    expect(commands?.state).toBe('duplicated');
  });

  test('wrong heading level is reported malformed', () => {
    const vault = template.replace('## Commands', '### Commands');
    const result = analyzeManagedSections(vault, template);
    const commands = result.sections.find(s => s.heading === 'Commands');
    expect(commands?.state).toBe('malformed');
  });

  test('reordered sections are flagged at the aggregate level', () => {
    const sections = template.split(/(?=^## )/m);
    const kb = sections.shift();
    const commands = sections.find(s => s.startsWith('## Commands'));
    const rest = sections.filter(s => !s.startsWith('## Commands'));
    const vault = kb + commands + rest.join('');
    const result = analyzeManagedSections(vault, template);
    const commandsSection = result.sections.find(s => s.heading === 'Commands');
    const config = result.sections.find(s => s.heading === 'Configuration');
    expect(commandsSection?.state).toBe('present');
    expect(config?.state).toBe('present');
    expect(result.reordered).toBeTrue();
  });

  test('edited section content is reported customized', () => {
    const vault = template.replace('config body', 'custom body');
    const result = analyzeManagedSections(vault, template);
    const config = result.sections.find(s => s.heading === 'Configuration');
    expect(config?.state).toBe('customized');
  });
});

describe('resolveVaultRoot', () => {
  const directoryStat = { isDirectory: () => true } as unknown as fs.Stats;

  test('resolves an existing directory to its canonical path', () => {
    const vault = makeVault();
    const result = resolveVaultRoot(vault, {
      statSync: () => fs.statSync(vault),
      realpathSync: (p) => fs.realpathSync(p),
    });
    expect(result.resolved).toBeTrue();
    expect(result.canonical).toBe(fs.realpathSync(vault));
  });

  test('emits VAULT_UNSAFE when realpath fails after stat succeeds', () => {
    const result = resolveVaultRoot('/vault', {
      statSync: () => directoryStat,
      realpathSync: () => { throw new Error('simulated realpath failure'); },
    });
    expect(result).toEqual({ resolved: false, canonical: '/vault', errorCode: 'VAULT_UNSAFE' });
  });

  test('emits VAULT_NOT_FOUND when stat fails', () => {
    const result = resolveVaultRoot('/missing', {
      statSync: () => { throw new Error('ENOENT'); },
      realpathSync: (p) => p,
    });
    expect(result).toEqual({ resolved: false, canonical: '/missing', errorCode: 'VAULT_NOT_FOUND' });
  });

  test('emits VAULT_NOT_FOUND when the target is not a directory', () => {
    const result = resolveVaultRoot('/file', {
      statSync: () => ({ isDirectory: () => false }) as unknown as fs.Stats,
      realpathSync: (p) => p,
    });
    expect(result.errorCode).toBe('VAULT_NOT_FOUND');
  });
});

describe('classifySchemaState', () => {
  const pluginSchema = '# me Frontmatter Schema\n\n## Core Fields\n\n## Per-Layer Extensions\n';

  test('identical schema is current', () => {
    expect(classifySchemaState(pluginSchema, pluginSchema)).toBe('current');
  });

  test('structurally valid schema with a higher revision marker is future', () => {
    const future = '# me Frontmatter Schema me-schema-v2\n\n## Core Fields\n\n## Per-Layer Extensions\n';
    expect(classifySchemaState(future, pluginSchema)).toBe('future');
  });

  test('structurally valid schema with a Schema revision marker is future', () => {
    const future = '# me Frontmatter Schema\n\nSchema revision: 2\n\n## Core Fields\n\n## Per-Layer Extensions\n';
    expect(classifySchemaState(future, pluginSchema)).toBe('future');
  });

  test('structurally valid edited schema without a future marker is edited', () => {
    const edited = '# me Frontmatter Schema (customized)\n\n## Core Fields\n\n## Per-Layer Extensions\n';
    expect(classifySchemaState(edited, pluginSchema)).toBe('edited');
  });

  test('same revision marker is not future', () => {
    const same = '# me Frontmatter Schema me-schema-v1\n\n## Core Fields\n\n## Per-Layer Extensions\n';
    expect(classifySchemaState(same, pluginSchema)).toBe('edited');
  });

  test('a revision equal to current is not future', () => {
    const same = '# me Frontmatter Schema\n\nSchema revision: 1\n\n## Core Fields\n\n## Per-Layer Extensions\n';
    expect(classifySchemaState(same, pluginSchema)).toBe('edited');
  });

  test('unrecognizable content is malformed', () => {
    expect(classifySchemaState('garbage', pluginSchema)).toBe('malformed');
  });

  test('absent schema is missing', () => {
    expect(classifySchemaState(null, pluginSchema)).toBe('missing');
  });
});

describe('overallState', () => {
  const finding = (code: string, severity: 'info' | 'warning' | 'error') => ({
    code,
    severity,
    category: 'test',
    message: '',
    recommendedAction: '',
  });

  test('no warnings or errors is healthy', () => {
    expect(overallState([
      finding('CONFIG_VALID', 'info'),
      finding('SCHEMA_CURRENT', 'info'),
    ])).toBe('healthy');
  });

  test('a warning is behind', () => {
    expect(overallState([
      finding('CONFIG_VALID', 'info'),
      finding('PLUGIN_VERSION_MISMATCH', 'warning'),
    ])).toBe('behind');
  });

  test('an edited schema warning is behind, not future-schema', () => {
    expect(overallState([
      finding('SCHEMA_CURRENT', 'info'),
      finding('SCHEMA_EDITED', 'warning'),
    ])).toBe('behind');
  });

  test('an error is malformed', () => {
    expect(overallState([finding('CONFIG_MALFORMED', 'error')])).toBe('malformed');
  });

  test('future-schema wins over errors', () => {
    expect(overallState([
      finding('SCHEMA_FUTURE', 'warning'),
      finding('CONFIG_MALFORMED', 'error'),
    ])).toBe('future-schema');
  });
});

describe('doctor CLI', () => {
  test('produces a versioned healthy report without creating runtime or vault changes', () => {
    const vault = makeVault();
    setupHealthyVault(vault);
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const environment = { ME_RUNTIME_ROOT: runtimeBase };

    const before = fs.readdirSync(vault).sort();
    const result = invoke(['--vault-dir', vault], environment);
    const packageVersion = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'),
    ).version as string;

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.version).toBe(1);
    expect(report.state).toBe('healthy');
    expect(report.plugin.version).toBe(packageVersion);
    expect(report.roots.vault.resolved).toBeTrue();
    expect(report.agents.mode).toBe('claude-only');
    expect(report.schema.state).toBe('current');
    expect(report.config.valid).toBeTrue();
    expect(fs.existsSync(runtimeBase)).toBeFalse();
    expect(fs.readdirSync(vault).sort()).toEqual(before);
  });

  test('rejects malformed arguments with one stable JSON error', () => {
    const result = invoke([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'error',
      error: {
        code: 'INVALID_ARGUMENTS',
        message: 'Usage: doctor --vault-dir DIR [--plugin-root DIR] [--installed-version VERSION]',
      },
    });
  });

  test('reports VAULT_NOT_FOUND for a nonexistent vault directory', () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'me-doctor-missing-')), 'nope');
    const result = invoke(['--vault-dir', missing]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.roots.vault.resolved).toBeFalse();
    expect(report.state).toBe('malformed');
    expect(report.findings.some(f => f.code === 'VAULT_NOT_FOUND')).toBeTrue();
    expect(report.findings.some(f => f.code === 'VAULT_UNSAFE')).toBeFalse();
  });
});
