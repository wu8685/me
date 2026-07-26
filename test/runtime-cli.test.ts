import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRuntimeLayout } from '../bin/runtime-paths.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/runtime.ts');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-runtime-cli-'));
  fixtures.push(fixture);
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  return vault;
}

function invoke(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

describe('runtime CLI', () => {
  test('path reports the canonical vault runtime without creating it', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const environment = { ME_RUNTIME_ROOT: runtimeBase };
    const layout = resolveRuntimeLayout(vault, environment);

    const result = invoke(['path', '--vault-dir', vault], environment);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      vaultDir: layout.canonicalVault,
      runtimeRoot: layout.runtimeRoot,
      exists: false,
    });
    expect(fs.existsSync(layout.runtimeBase)).toBeFalse();
  });

  test('prepare-inbox creates only the private runtime namespace and inbox', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const environment = { ME_RUNTIME_ROOT: runtimeBase };
    const layout = resolveRuntimeLayout(vault, environment);

    const result = invoke(['prepare-inbox', '--vault-dir', vault], environment);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      vaultDir: layout.canonicalVault,
      runtimeRoot: layout.runtimeRoot,
      inboxDir: layout.inboxDir,
      exists: true,
    });
    expect(fs.statSync(layout.inboxDir).isDirectory()).toBeTrue();
    expect(fs.statSync(layout.inboxDir).mode & 0o077).toBe(0);
    expect(fs.existsSync(layout.lockDir)).toBeFalse();
    expect(fs.existsSync(layout.transactionDir)).toBeFalse();
    expect(fs.existsSync(layout.ingestLockDir)).toBeFalse();
    expect(fs.existsSync(layout.ingestStagingDir)).toBeFalse();
  });

  test('rejects malformed commands with one stable JSON error', () => {
    const vault = makeVault();
    for (const args of [
      [],
      ['path'],
      ['unknown', '--vault-dir', vault],
      ['path', '--vault-dir', vault, '--extra', 'x'],
    ]) {
      const result = invoke(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        status: 'error',
        error: {
          code: 'INVALID_ARGUMENTS',
          message: 'Usage: runtime path|prepare-inbox --vault-dir DIR',
        },
      });
    }
  });
});
