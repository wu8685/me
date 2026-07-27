import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeFreshSetup } from '../bin/setup.ts';

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

function setupOptions(vault: string, runtime: string) {
  return {
    vaultDir: vault,
    pluginRoot,
    layerDirectories: ['raw', 'practices', 'cognition'] as const,
    environment: { ...process.env, ME_RUNTIME_ROOT: runtime },
  };
}

function manifest(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const entry = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        entries.push(`d:${relative}:${entry.mode & 0o777}`);
        visit(absolute);
      } else {
        entries.push(`f:${relative}:${entry.mode & 0o777}:${
          crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
        }`);
      }
    }
  };
  visit(root);
  return entries;
}

describe('fresh setup transaction', () => {
  test('executes managed setup with config published last', () => {
    const vault = temporaryDirectory('me-setup-transaction-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-transaction-root-'), 'runtime');
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# user claude\n');
    fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# user codex\n');
    const order: string[] = [];

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      hooks: {
        beforePublish(relative) {
          order.push(relative);
          if (relative === '.me/config.yaml') {
            expect(fs.existsSync(path.join(vault, 'SCHEMA.md'))).toBeTrue();
            expect(fs.existsSync(path.join(vault, 'raw/.gitkeep'))).toBeTrue();
            expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'))
              .toContain('# user claude');
            expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'))
              .toContain('# user codex');
          } else {
            expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
          }
        },
      },
    });

    expect(result.status).toBe('initialized');
    expect(order.at(-1)).toBe('.me/config.yaml');
    expect(fs.readFileSync(path.join(vault, '.me/config.yaml'), 'utf8'))
      .toContain('vault_schema_version: 1');
    expect(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'))
      .toContain('<!-- me:managed:start knowledge-base -->');
    expect(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'))
      .toContain('<!-- me:managed:start knowledge-base -->');
    expect(fs.readdirSync(vault).some(name => name.startsWith('.me-setup-')))
      .toBeFalse();
  });

  test('existing config returns before any vault or runtime write', () => {
    const vault = temporaryDirectory('me-setup-existing-vault-');
    const runtimeParent = temporaryDirectory('me-setup-existing-root-');
    const runtime = path.join(runtimeParent, 'must-not-exist');
    fs.mkdirSync(path.join(vault, '.me'));
    fs.writeFileSync(path.join(vault, '.me/config.yaml'), 'vault_schema_version: 1\n');
    const before = manifest(vault);

    const result = executeFreshSetup(setupOptions(vault, runtime));

    expect(result.status).toBe('already_initialized');
    expect(manifest(vault)).toEqual(before);
    expect(fs.existsSync(runtime)).toBeFalse();
  });

  test('preflight failure returns before runtime bootstrap', () => {
    const vault = temporaryDirectory('me-setup-readonly-vault-');
    const runtimeParent = temporaryDirectory('me-setup-readonly-root-');
    const runtime = path.join(runtimeParent, 'must-not-exist');
    fs.chmodSync(vault, 0o555);
    try {
      const result = executeFreshSetup(setupOptions(vault, runtime));
      expect(result).toMatchObject({
        status: 'blocked',
        error: { code: 'UNSAFE_PATH' },
        recoveryState: 'none',
      });
      expect(fs.existsSync(runtime)).toBeFalse();
    } finally {
      fs.chmodSync(vault, 0o755);
    }
  });

  test('rolls back all vault mutations when publication fails before config', () => {
    const vault = temporaryDirectory('me-setup-rollback-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-rollback-root-'), 'runtime');
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# user claude\n');
    fs.writeFileSync(path.join(vault, '.gitignore'), '# user ignore\n');
    const before = manifest(vault);

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      hooks: {
        beforePublish(relative) {
          if (relative === 'AGENTS.md') throw new Error('injected failure');
        },
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      recoveryState: 'none',
    });
    expect(manifest(vault)).toEqual(before);
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
    expect(fs.readdirSync(vault).some(name => name.startsWith('.me-setup-')))
      .toBeFalse();
  });
});
