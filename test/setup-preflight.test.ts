import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { preflightFreshSetup } from '../bin/setup-preflight.ts';
import { UpdateError } from '../bin/update/contracts.ts';

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

function makeVault(): { vault: string; runtime: string } {
  const root = temporaryDirectory('me-setup-preflight-');
  const vault = path.join(root, 'vault');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(vault);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'sentinel'), 'runtime-owned\n');
  return { vault, runtime };
}

function manifest(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const entry = fs.lstatSync(absolute);
      if (entry.isSymbolicLink()) {
        entries.push(`l:${relative}:${fs.readlinkSync(absolute)}`);
      } else if (entry.isDirectory()) {
        entries.push(`d:${relative}:${entry.mode & 0o777}`);
        visit(absolute);
      } else {
        const digest = crypto.createHash('sha256')
          .update(fs.readFileSync(absolute))
          .digest('hex');
        entries.push(`f:${relative}:${entry.mode & 0o777}:${digest}`);
      }
    }
  };
  visit(root);
  return entries;
}

function preflight(vault: string): void {
  preflightFreshSetup({
    vaultDir: vault,
    pluginRoot,
    layerDirectories: ['raw', 'practices', 'cognition'],
  });
}

function expectZeroWriteFailure(
  arrange: (vault: string, outside: string) => void,
  expectedCode: 'MIGRATION_CONFLICT' | 'UNSAFE_PATH',
): void {
  const { vault, runtime } = makeVault();
  const outside = path.join(path.dirname(vault), 'outside');
  fs.mkdirSync(outside);
  arrange(vault, outside);
  const beforeVault = manifest(vault);
  const beforeRuntime = manifest(runtime);
  const beforeOutside = manifest(outside);

  let thrown: unknown;
  try {
    preflight(vault);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UpdateError);
  expect((thrown as UpdateError).code).toBe(expectedCode);
  expect(manifest(vault)).toEqual(beforeVault);
  expect(manifest(runtime)).toEqual(beforeRuntime);
  expect(manifest(outside)).toEqual(beforeOutside);
  expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
}

describe('fresh setup preflight', () => {
  test('accepts absent targets and user-authored Agent files without writing', () => {
    const { vault, runtime } = makeVault();
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# User Claude\n');
    fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# User Codex\n');
    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);

    const result = preflightFreshSetup({
      vaultDir: vault,
      pluginRoot,
      layerDirectories: ['raw', 'practices', 'cognition'],
    });

    expect(result.status).toBe('ready');
    expect(result.plannedPaths).toContain('.me/config.yaml');
    expect(result.plannedPaths).toContain('CLAUDE.md');
    expect(result.plannedPaths).toContain('AGENTS.md');
    expect(manifest(vault)).toEqual(beforeVault);
    expect(manifest(runtime)).toEqual(beforeRuntime);
  });

  test.each([
    [
      'duplicate marker',
      (vault: string) => fs.writeFileSync(
        path.join(vault, 'CLAUDE.md'),
        [
          '<!-- me:managed:start configuration -->',
          'one',
          '<!-- me:managed:end configuration -->',
          '<!-- me:managed:start configuration -->',
          'two',
          '<!-- me:managed:end configuration -->',
        ].join('\n'),
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'nested marker',
      (vault: string) => fs.writeFileSync(
        path.join(vault, 'AGENTS.md'),
        [
          '<!-- me:managed:start configuration -->',
          '<!-- me:managed:start layer-map -->',
          '<!-- me:managed:end layer-map -->',
          '<!-- me:managed:end configuration -->',
        ].join('\n'),
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'mismatched marker',
      (vault: string) => fs.writeFileSync(
        path.join(vault, 'CLAUDE.md'),
        [
          '<!-- me:managed:start configuration -->',
          '<!-- me:managed:end layer-map -->',
        ].join('\n'),
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'unknown marker',
      (vault: string) => fs.writeFileSync(
        path.join(vault, 'AGENTS.md'),
        [
          '<!-- me:managed:start unknown -->',
          '<!-- me:managed:end unknown -->',
        ].join('\n'),
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'incomplete marker',
      (vault: string) => fs.writeFileSync(
        path.join(vault, 'CLAUDE.md'),
        '<!-- me:managed:start configuration -->\n',
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'Agent symlink',
      (vault: string, outside: string) => {
        const target = path.join(outside, 'agent');
        fs.writeFileSync(target, 'outside\n');
        fs.symlinkSync(target, path.join(vault, 'AGENTS.md'));
      },
      'UNSAFE_PATH',
    ],
    [
      'gitignore directory',
      (vault: string) => fs.mkdirSync(path.join(vault, '.gitignore')),
      'UNSAFE_PATH',
    ],
    [
      'duplicate effective gitignore entries',
      (vault: string) => fs.writeFileSync(
        path.join(vault, '.gitignore'),
        [
          '# .obsidian/ is only a comment',
          ' .obsidian/ ',
          '.obsidian/\r',
        ].join('\n'),
      ),
      'MIGRATION_CONFLICT',
    ],
    [
      'layer symlink',
      (vault: string, outside: string) => fs.symlinkSync(
        outside,
        path.join(vault, 'raw'),
      ),
      'UNSAFE_PATH',
    ],
  ] as const)('rejects %s before every setup write', (
    _name,
    arrange,
    expectedCode,
  ) => {
    expectZeroWriteFailure(arrange, expectedCode);
  });

  test('defines comment and whitespace semantics for effective gitignore entries', () => {
    const { vault } = makeVault();
    fs.writeFileSync(
      path.join(vault, '.gitignore'),
      '# .obsidian/ is not effective\n   .obsidian/   \n',
    );

    const result = preflightFreshSetup({
      vaultDir: vault,
      pluginRoot,
      layerDirectories: ['raw', 'practices', 'cognition'],
    });

    expect(result.status).toBe('ready');
    expect(result.plannedPaths).not.toContain('.gitignore');
  });
});
