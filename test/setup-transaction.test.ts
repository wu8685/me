import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  acquireVaultLock,
  releaseVaultLock,
} from '../bin/cooperative-lock.ts';
import {
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
} from '../bin/runtime-paths.ts';
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

function setupOperationDirectories(runtime: string): string[] {
  if (!fs.existsSync(runtime)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const entry = fs.lstatSync(absolute);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (name.startsWith('me-setup-')) found.push(absolute);
      visit(absolute);
    }
  };
  visit(runtime);
  return found;
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
          expect(fs.readdirSync(vault).some(name => name.startsWith('.me-setup-')))
            .toBeFalse();
          expect(setupOperationDirectories(runtime).length).toBe(1);
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
    expect(setupOperationDirectories(runtime)).toEqual([]);
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
    expect(setupOperationDirectories(runtime)).toEqual([]);
  });

  test.each([
    ['mkdir', 'vault'],
    ['config link', 'me'],
  ] as const)('records applied %s outcome and rolls it back', (_name, target) => {
    const vault = temporaryDirectory('me-setup-applied-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-applied-root-'), 'runtime');
    const before = manifest(vault);
    let failed = false;

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      atomicHooks: {
        afterAtomicMutation(kind, phase, paths) {
          if (
            !failed
            && target === 'vault'
            && kind === 'mkdir'
            && phase === 'create'
            && paths[0]?.endsWith(`${path.sep}raw`)
          ) {
            failed = true;
            throw new Error('success then error');
          }
        },
      },
      directoryFsync(directory) {
        const shouldFail = target === 'me'
          && directory.endsWith(`${path.sep}.me`);
        if (!failed && shouldFail) {
          failed = true;
          throw new Error('success then error');
        }
        const descriptor = fs.openSync(
          directory,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
        );
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      },
    });

    expect(failed).toBeTrue();
    expect(result).toMatchObject({
      status: 'blocked',
      recoveryState: 'none',
    });
    expect(manifest(vault)).toEqual(before);
    expect(setupOperationDirectories(runtime)).toEqual([]);
  });

  test.each([
    'SIGINT',
    'SIGKILL',
  ] as const)('%s after config publication leaves an active lock before existing fast-path', async signal => {
    const vault = temporaryDirectory('me-setup-kill-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-kill-root-'), 'runtime');
    const moduleUrl = pathToFileURL(path.join(pluginRoot, 'bin/setup.ts')).href;
    const childSource = `
      import { executeFreshSetup } from ${JSON.stringify(moduleUrl)};
      executeFreshSetup({
        vaultDir: ${JSON.stringify(vault)},
        pluginRoot: ${JSON.stringify(pluginRoot)},
        layerDirectories: ["raw", "practices", "cognition"],
        environment: { ...process.env, ME_RUNTIME_ROOT: ${JSON.stringify(runtime)} },
        hooks: {
          afterPublish(relative) {
            if (relative === ".me/config.yaml") process.kill(process.pid, ${JSON.stringify(signal)});
          }
        }
      });
    `;
    const child = Bun.spawn([process.execPath, '-e', childSource], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    expect(exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeTrue();

    const operations = setupOperationDirectories(runtime);
    expect(operations.length).toBe(1);
    const journal = JSON.parse(
      fs.readFileSync(path.join(operations[0], 'journal.json'), 'utf8'),
    ) as {
      state: string;
      pendingMutation?: unknown;
      appliedMutations: Array<{ paths: string[] }>;
    };
    expect(journal.pendingMutation).toBeUndefined();
    expect(journal.appliedMutations.some(item => (
      item.paths.includes('.me/config.yaml')
    ))).toBeTrue();

    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);
    for (const preview of [true, false]) {
      const result = executeFreshSetup({
        ...setupOptions(vault, runtime),
        preview,
      });
      expect(result).toMatchObject({
        status: 'blocked',
        error: { code: 'UPDATE_IN_PROGRESS' },
        recoveryState: 'none',
      });
      expect(manifest(vault)).toEqual(beforeVault);
      expect(manifest(runtime)).toEqual(beforeRuntime);
    }
  });

  test('preserves a foreign replacement and retains recovery journal', () => {
    const vault = temporaryDirectory('me-setup-foreign-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-foreign-root-'), 'runtime');

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      hooks: {
        afterPublish(relative) {
          if (relative !== 'SCHEMA.md') return;
          fs.renameSync(path.join(vault, 'SCHEMA.md'), path.join(vault, 'owned-schema'));
          fs.writeFileSync(path.join(vault, 'SCHEMA.md'), 'foreign replacement\n');
          throw new Error('force rollback');
        },
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
    });
    expect(fs.readFileSync(path.join(vault, 'SCHEMA.md'), 'utf8'))
      .toBe('foreign replacement\n');
    expect(setupOperationDirectories(runtime).length).toBe(1);
    expect(executeFreshSetup({
      ...setupOptions(vault, runtime),
      preview: true,
    })).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
    });
  });

  test('lock replacement after config returns structured recovery and keeps committed journal', () => {
    const vault = temporaryDirectory('me-setup-lock-replace-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-lock-replace-root-'), 'runtime');
    const foreign = 'foreign lock replacement\n';

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      hooks: {
        beforeLockRelease(lockPath) {
          fs.renameSync(lockPath, `${lockPath}.previous-owner`);
          fs.writeFileSync(lockPath, foreign);
        },
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
      recoveryActions: [{
        path: '<ME_RUNTIME>/locks/vault.lock',
      }],
      preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
    });
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeTrue();
    expect(setupOperationDirectories(runtime).length).toBe(1);

    const layout = resolveRuntimeLayout(vault, {
      ...process.env,
      ME_RUNTIME_ROOT: runtime,
    });
    expect(fs.readFileSync(path.join(layout.lockDir, 'vault.lock'), 'utf8'))
      .toBe(foreign);
    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);

    const retry = executeFreshSetup({
      ...setupOptions(vault, runtime),
      preview: true,
    });
    expect(retry).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
      recoveryActions: [{
        path: '<ME_RUNTIME>/locks/vault.lock',
      }],
    });
    expect(manifest(vault)).toEqual(beforeVault);
    expect(manifest(runtime)).toEqual(beforeRuntime);
    expect(fs.readFileSync(path.join(layout.lockDir, 'vault.lock'), 'utf8'))
      .toBe(foreign);
  });

  test('lock replacement during locked recheck reports durable lock recovery', () => {
    const vault = temporaryDirectory('me-setup-locked-replacement-vault-');
    const runtime = path.join(
      temporaryDirectory('me-setup-locked-replacement-root-'),
      'runtime',
    );
    let publishAttempts = 0;
    let foreignLockPath = '';
    const beforeVault = manifest(vault);

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      hooks: {
        afterLockAcquired(lockPath) {
          foreignLockPath = lockPath;
          fs.renameSync(lockPath, `${lockPath}.previous-owner`);
          fs.writeFileSync(lockPath, '{"foreign":true}\n', { mode: 0o600 });
        },
        beforePublish() {
          publishAttempts += 1;
        },
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
      recoveryActions: [{
        path: '<ME_RUNTIME>/locks/vault.lock',
      }],
      preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
    });
    expect(publishAttempts).toBe(0);
    expect(manifest(vault)).toEqual(beforeVault);
    expect(fs.readFileSync(foreignLockPath, 'utf8')).toBe('{"foreign":true}\n');
    expect(setupOperationDirectories(runtime)).toEqual([]);

    const beforeRetryVault = manifest(vault);
    const beforeRetryRuntime = manifest(runtime);
    const retry = executeFreshSetup({
      ...setupOptions(vault, runtime),
      preview: true,
    });
    expect(retry).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
      recoveryActions: [{
        path: '<ME_RUNTIME>/locks/vault.lock',
      }],
      preservedPaths: ['<ME_RUNTIME>/locks/vault.lock'],
    });
    expect(manifest(vault)).toEqual(beforeRetryVault);
    expect(manifest(runtime)).toEqual(beforeRetryRuntime);
  });

  test.each([
    'vault-write',
    'me-update',
    'unknown',
  ] as const)('shared inspector blocks malformed %s transaction residue before fresh writes', kind => {
    const vault = temporaryDirectory(`me-setup-${kind}-residue-vault-`);
    const runtime = path.join(
      temporaryDirectory(`me-setup-${kind}-residue-root-`),
      'runtime',
    );
    const environment = { ...process.env, ME_RUNTIME_ROOT: runtime };
    const layout = resolveRuntimeLayout(vault, environment);
    bootstrapRuntimeDirectories(layout, [layout.transactionDir]);
    const id = crypto.randomUUID();
    const name = kind === 'unknown' ? `mystery-${id}` : `${kind}-${id}`;
    const operation = path.join(layout.transactionDir, name);
    fs.mkdirSync(operation);
    fs.writeFileSync(path.join(operation, 'journal.json'), '{ malformed');
    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      preview: true,
    });

    expect(result).toMatchObject({
      status: 'blocked',
      error: { code: 'RECOVERY_REQUIRED' },
      recoveryState: 'manual',
      recoveryActions: [{
        path: '<ME_RUNTIME>/transactions',
      }],
    });
    expect(manifest(vault)).toEqual(beforeVault);
    expect(manifest(runtime)).toEqual(beforeRuntime);
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
  });

  test('shared inspector reports a valid active lock without writing', () => {
    const vault = temporaryDirectory('me-setup-active-lock-vault-');
    const runtime = path.join(temporaryDirectory('me-setup-active-lock-root-'), 'runtime');
    const environment = { ...process.env, ME_RUNTIME_ROOT: runtime };
    const layout = resolveRuntimeLayout(vault, environment);
    bootstrapRuntimeDirectories(layout, [layout.lockDir]);
    const lock = acquireVaultLock(layout, {
      operationId: crypto.randomUUID(),
      owner: 'ingest',
    });
    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);
    try {
      const result = executeFreshSetup({
        ...setupOptions(vault, runtime),
        preview: true,
      });
      expect(result).toMatchObject({
        status: 'blocked',
        error: { code: 'UPDATE_IN_PROGRESS' },
        recoveryState: 'none',
      });
      expect(manifest(vault)).toEqual(beforeVault);
      expect(manifest(runtime)).toEqual(beforeRuntime);
    } finally {
      releaseVaultLock(layout, lock);
    }
  });

  test('active setup lock wins over its existing setup operation during preview', () => {
    const vault = temporaryDirectory('me-setup-active-operation-vault-');
    const runtime = path.join(
      temporaryDirectory('me-setup-active-operation-root-'),
      'runtime',
    );
    const environment = { ...process.env, ME_RUNTIME_ROOT: runtime };
    const layout = resolveRuntimeLayout(vault, environment);
    bootstrapRuntimeDirectories(layout, [layout.lockDir, layout.transactionDir]);
    const operationId = crypto.randomUUID();
    const operation = path.join(
      layout.transactionDir,
      `me-setup-${operationId}`,
    );
    fs.mkdirSync(operation, { mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'journal.json'), '{ incomplete', {
      mode: 0o600,
    });
    const lock = acquireVaultLock(layout, {
      operationId,
      owner: 'me-update',
    });
    const beforeVault = manifest(vault);
    const beforeRuntime = manifest(runtime);
    try {
      const result = executeFreshSetup({
        ...setupOptions(vault, runtime),
        preview: true,
      });
      expect(result).toMatchObject({
        status: 'blocked',
        error: { code: 'UPDATE_IN_PROGRESS' },
        recoveryState: 'none',
      });
      expect(manifest(vault)).toEqual(beforeVault);
      expect(manifest(runtime)).toEqual(beforeRuntime);
    } finally {
      releaseVaultLock(layout, lock);
    }
  });

  for (const kind of ['vault-write', 'me-update', 'unknown'] as const) {
    test(`rechecks malformed ${kind} residue after acquiring the lock`, () => {
      const vault = temporaryDirectory(`me-setup-locked-${kind}-vault-`);
      const runtime = path.join(
        temporaryDirectory(`me-setup-locked-${kind}-root-`),
        'runtime',
      );
      const beforeVault = manifest(vault);
      let publishAttempts = 0;

      const result = executeFreshSetup({
        ...setupOptions(vault, runtime),
        hooks: {
          afterLockAcquired() {
            const layout = resolveRuntimeLayout(vault, {
              ...process.env,
              ME_RUNTIME_ROOT: runtime,
            });
            const id = crypto.randomUUID();
            const name = kind === 'unknown' ? `mystery-${id}` : `${kind}-${id}`;
            const operation = path.join(layout.transactionDir, name);
            fs.mkdirSync(operation, { mode: 0o700 });
            fs.writeFileSync(path.join(operation, 'journal.json'), '{ malformed', {
              mode: 0o600,
            });
          },
          beforePublish() {
            publishAttempts += 1;
          },
        },
      });

      expect(result).toMatchObject({
        status: 'blocked',
        error: { code: 'RECOVERY_REQUIRED' },
        recoveryState: 'manual',
        recoveryActions: [{
          path: '<ME_RUNTIME>/transactions',
        }],
      });
      expect(publishAttempts).toBe(0);
      expect(manifest(vault)).toEqual(beforeVault);
      expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
      expect(setupOperationDirectories(runtime)).toEqual([]);
    });
  }

  test('shared inspector ignores a valid committed vault-write journal', () => {
    const vault = temporaryDirectory('me-setup-committed-write-vault-');
    const runtime = path.join(
      temporaryDirectory('me-setup-committed-write-root-'),
      'runtime',
    );
    const environment = { ...process.env, ME_RUNTIME_ROOT: runtime };
    const layout = resolveRuntimeLayout(vault, environment);
    bootstrapRuntimeDirectories(layout, [layout.transactionDir]);
    const id = crypto.randomUUID();
    const operation = path.join(layout.transactionDir, `vault-write-${id}`);
    fs.mkdirSync(operation, { mode: 0o700 });
    fs.writeFileSync(path.join(operation, 'journal.json'), `${JSON.stringify({
      version: 1,
      operationId: id,
      state: 'committed',
      notePath: 'raw/note.md',
      requestDigest: '0'.repeat(64),
      plannedNoteSha256: '1'.repeat(64),
      metadataPolicy:
        'POSIX mode preserved for replaced README; uid/gid/ACL/xattr/timestamps are not preserved.',
    })}\n`, { mode: 0o600 });

    const result = executeFreshSetup({
      ...setupOptions(vault, runtime),
      preview: true,
    });

    expect(result.status).toBe('ready');
    expect(fs.existsSync(path.join(vault, '.me/config.yaml'))).toBeFalse();
  });
});
