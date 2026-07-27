import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  exitCodeForUpdateResult,
  runUpdateCli,
} from '../bin/update.ts';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UPDATE_ERROR_CATALOG,
  UpdateError,
  serializeUpdateResult,
  type UpdateErrorCode,
  type UpdatePlan,
} from '../bin/update/contracts.ts';
import { resolveRuntimeLayout } from '../bin/runtime-paths.ts';
import { planVaultUpdate } from '../bin/update/planner.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/update.ts');
const temporaryDirectories: string[] = [];
const fixedOperationId = '00000000-0000-4000-8000-000000000005';

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
  '# user comment',
  'paths:',
  '  raw: knowledge/raw',
  '  practices: knowledge/practices',
  '  cognition: knowledge/cognition',
  '',
].join('\n')): string {
  const vault = path.join(temporaryDirectory('me-update-cli-'), 'vault');
  fs.mkdirSync(vault);
  writeFile(vault, '.me/config.yaml', config, 0o640);
  writeFile(
    vault,
    'SCHEMA.md',
    fs.readFileSync(path.join(
      pluginRoot,
      'templates/migration-history/0000/SCHEMA.md',
    )),
  );
  return vault;
}

function manifest(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push(`d:${relative}:${stat.mode & 0o777}`);
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push([
          'f',
          relative,
          stat.mode & 0o777,
          crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
        ].join(':'));
      } else {
        entries.push(`s:${relative}:${stat.mode & 0o777}`);
      }
    }
  };
  visit(root);
  return entries;
}

function invoke(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  cwd = pluginRoot,
) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function parseSingleResult(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith('\n')).toBeTrue();
  expect(stdout.trimEnd().includes('\n')).toBeFalse();
  return JSON.parse(stdout) as Record<string, unknown>;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    pluginRoot,
    operationIdFactory: () => fixedOperationId,
    ...overrides,
  };
}

function publicFailure(
  code: UpdateErrorCode,
  planner: () => UpdatePlan = () => {
    throw new UpdateError(code);
  },
) {
  const vault = makeVault();
  const result = runUpdateCli(
    ['preview', '--vault-dir', vault],
    options({ planUpdate: planner }),
  );
  expect(result).toEqual({
    version: 1,
    status: UPDATE_ERROR_CATALOG[code].status,
    operationId: fixedOperationId,
    currentVaultSchemaVersion: 0,
    targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
    migrations: [],
    plannedPaths: [],
    changedPaths: [],
    diffs: [],
    warnings: [],
    conflicts: [],
    recoveryState: UPDATE_ERROR_CATALOG[code].status === 'rolled_back'
      ? 'rolled_back'
      : UPDATE_ERROR_CATALOG[code].status === 'recovery_required'
        ? 'manual'
        : 'none',
    error: {
      code,
      message: UPDATE_ERROR_CATALOG[code].message,
    },
  });
  expect(exitCodeForUpdateResult(result)).toBe(UPDATE_ERROR_CATALOG[code].exitCode);
}

describe('me-update preview CLI', () => {
  test('returns the exact read-only preview result without creating vault or runtime state', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const environment = { ME_RUNTIME_ROOT: runtimeBase };
    const runtime = resolveRuntimeLayout(vault, environment);
    const before = manifest(vault);

    const result = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({ environment }),
    );

    expect(result).toMatchObject({
      version: 1,
      status: 'preview',
      operationId: fixedOperationId,
      currentVaultSchemaVersion: 0,
      targetVaultSchemaVersion: 1,
      migrations: [{
        id: '0000-to-0001',
        description: 'Adopt versioned vault metadata and Agent-neutral managed assets.',
      }],
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      plannedPaths: [
        '.me/config.yaml',
        'AGENTS.md',
        'CLAUDE.md',
      ],
      changedPaths: [],
      warnings: [],
      conflicts: [],
      recoveryState: 'none',
    });
    expect(Object.keys(result).sort()).toEqual([
      'changedPaths',
      'conflicts',
      'currentVaultSchemaVersion',
      'diffs',
      'migrations',
      'operationId',
      'planDigest',
      'plannedPaths',
      'recoveryState',
      'status',
      'targetVaultSchemaVersion',
      'version',
      'warnings',
    ]);
    expect(result.diffs.map(item => item.path)).toEqual([
      '.me/config.yaml',
      'AGENTS.md',
      'CLAUDE.md',
    ]);
    expect(result.diffs.every(item => (
      !path.isAbsolute(item.path)
      && !item.diff.includes(vault)
      && !item.diff.includes(os.homedir())
    ))).toBeTrue();
    expect(manifest(vault)).toEqual(before);
    expect(fs.existsSync(runtime.runtimeRoot)).toBeFalse();
    expect(fs.existsSync(runtimeBase)).toBeFalse();
    expect(exitCodeForUpdateResult(result)).toBe(0);
  });

  test('returns exact up_to_date result and keeps the operation id per invocation', () => {
    const vault = makeVault('vault_schema_version: 1\n');
    let calls = 0;
    const operationIds = [
      '00000000-0000-4000-8000-000000000051',
      '00000000-0000-4000-8000-000000000052',
    ];
    const invocationOptions = {
      pluginRoot,
      operationIdFactory: () => operationIds[calls++],
    };

    const first = runUpdateCli(['preview', '--vault-dir', vault], invocationOptions);
    const second = runUpdateCli(['preview', '--vault-dir', vault], invocationOptions);

    expect(first).toEqual({
      version: 1,
      status: 'up_to_date',
      operationId: operationIds[0],
      currentVaultSchemaVersion: 1,
      targetVaultSchemaVersion: 1,
      migrations: [],
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      plannedPaths: [],
      changedPaths: [],
      diffs: [],
      warnings: [],
      conflicts: [],
      recoveryState: 'none',
    });
    expect(second).toEqual({ ...first, operationId: operationIds[1] });
    expect(calls).toBe(2);
    expect(exitCodeForUpdateResult(first)).toBe(0);
  });

  test('returns blocked conflicts with public paths, reasons, and safe diffs', () => {
    const vault = makeVault();
    fs.appendFileSync(path.join(vault, 'SCHEMA.md'), '\nuser-owned change\n');

    const result = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options(),
    );

    expect(result.status).toBe('blocked');
    expect(result.error).toEqual({
      code: 'MIGRATION_CONFLICT',
      message: UPDATE_ERROR_CATALOG.MIGRATION_CONFLICT.message,
    });
    expect(result.conflicts).toEqual([{
      path: 'SCHEMA.md',
      reason: 'MIGRATION_CONFLICT',
    }]);
    expect(result.changedPaths).toEqual([]);
    expect(result.diffs.length).toBeGreaterThan(0);
    expect(serializeUpdateResult(result)).not.toContain(vault);
    expect(serializeUpdateResult(result)).not.toContain(os.homedir());
    expect(exitCodeForUpdateResult(result)).toBe(3);
  });

  test('rejects every partial, malformed apply, duplicate, and unknown argument form exactly', () => {
    const vault = makeVault();
    const digest = 'a'.repeat(64);
    const invalid = [
      [],
      ['preview'],
      ['preview', '--vault-dir'],
      ['preview', '--vault-dir', ''],
      ['preview', '--vault-dir', '--unknown'],
      ['apply', '--vault-dir', vault],
      ['apply', '--vault-dir', vault, '--expected-plan-digest', 'A'.repeat(64)],
      ['apply', '--vault-dir', vault, '--expected-plan-digest', 'bad'],
      ['preview', '--vault-dir', vault, '--expected-plan-digest', digest],
      ['preview', '--vault-dir', vault, '--vault-dir', vault],
      ['preview', '--vault', vault],
      ['unknown', '--vault-dir', vault],
      ['preview', '--vault-dir', vault, 'trailing'],
    ];

    for (const argv of invalid) {
      const result = runUpdateCli(argv, options());
      expect(result).toEqual({
        version: 1,
        status: 'blocked',
        operationId: fixedOperationId,
        currentVaultSchemaVersion: 0,
        targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
        migrations: [],
        plannedPaths: [],
        changedPaths: [],
        diffs: [],
        warnings: [],
        conflicts: [],
        recoveryState: 'none',
        error: {
          code: 'INVALID_REQUEST',
          message: UPDATE_ERROR_CATALOG.INVALID_REQUEST.message,
        },
      });
      expect(exitCodeForUpdateResult(result)).toBe(2);
    }
  });

  test('applies only the exact lowercase preview digest', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const environment = { ME_RUNTIME_ROOT: runtimeBase };
    const preview = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({ environment }),
    );
    const result = runUpdateCli([
      'apply',
      '--vault-dir',
      vault,
      '--expected-plan-digest',
      preview.planDigest!,
    ], options({ environment }));

    expect(result.status).toBe('committed');
    expect(result.changedPaths.at(-1)).toBe('.me/config.yaml');
    expect(runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({ environment }),
    ).status).toBe('up_to_date');
  });

  test('maps validation, conflict, recovery, compatibility, and fatal failures to stable exits', () => {
    publicFailure('INVALID_CONFIG');
    publicFailure('MIGRATION_CONFLICT');
    publicFailure('LEGACY_RUNTIME_STATE');
    publicFailure('VALIDATION_FAILED');
    publicFailure('RECOVERY_REQUIRED');
    publicFailure('VAULT_NEWER_THAN_PLUGIN');
    publicFailure('INTERNAL_ERROR', () => {
      const privatePath = path.join(
        path.parse(process.cwd()).root,
        'private',
        'me-update-secret',
      );
      throw new Error(`private failure ${privatePath}`);
    });
  });

  test('maps a real future vault to the compatibility result without leaking its path', () => {
    const vault = makeVault('vault_schema_version: 2\n');
    const result = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options(),
    );

    expect(result.error).toEqual({
      code: 'VAULT_NEWER_THAN_PLUGIN',
      message: UPDATE_ERROR_CATALOG.VAULT_NEWER_THAN_PLUGIN.message,
    });
    expect(serializeUpdateResult(result)).not.toContain(vault);
    expect(exitCodeForUpdateResult(result)).toBe(5);
  });

  test('resolves the installed plugin root by default and accepts a safe relative vault path', () => {
    const vault = makeVault('vault_schema_version: 1\n');
    const relativeVault = path.relative(pluginRoot, vault);
    const result = runUpdateCli(
      ['preview', '--vault-dir', relativeVault],
      {
        operationIdFactory: () => fixedOperationId,
      },
    );

    expect(result.status).toBe('up_to_date');
    expect(result.operationId).toBe(fixedOperationId);
  });

  test('spawned CLI emits one redacted JSON line with a stable UUID-shaped operation id', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const result = invoke(
      ['preview', '--vault-dir', vault],
      { ME_RUNTIME_ROOT: runtimeBase },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const body = parseSingleResult(result.stdout);
    expect(body.status).toBe('preview');
    expect(body.operationId).toEqual(expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ));
    expect(result.stdout).not.toContain(vault);
    expect(result.stdout).not.toContain(runtimeBase);
    expect(result.stdout).not.toContain(os.homedir());
    expect(fs.existsSync(runtimeBase)).toBeFalse();
  });

  test('spawned invalid and future requests use one JSON line and stable exit classes', () => {
    const vault = makeVault('vault_schema_version: 2\n');
    const invalid = invoke(['apply', '--vault-dir', vault]);
    const future = invoke(['preview', '--vault-dir', vault]);

    expect(invalid.status).toBe(2);
    expect(parseSingleResult(invalid.stdout).error).toEqual({
      code: 'INVALID_REQUEST',
      message: UPDATE_ERROR_CATALOG.INVALID_REQUEST.message,
    });
    expect(future.status).toBe(5);
    expect(parseSingleResult(future.stdout).error).toEqual({
      code: 'VAULT_NEWER_THAN_PLUGIN',
      message: UPDATE_ERROR_CATALOG.VAULT_NEWER_THAN_PLUGIN.message,
    });
    expect(`${invalid.stdout}${future.stdout}`).not.toContain(vault);
  });

  test('unexpected planner exceptions and pre-aborted previews do not write vault or runtime state', () => {
    const vault = makeVault();
    const runtimeBase = path.join(path.dirname(vault), 'runtime');
    const before = manifest(vault);
    const controller = new AbortController();
    controller.abort();

    const failed = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({
        environment: { ME_RUNTIME_ROOT: runtimeBase },
        planUpdate() {
          throw new Error('sensitive failure');
        },
      }),
    );
    const aborted = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({
        environment: { ME_RUNTIME_ROOT: runtimeBase },
        signal: controller.signal,
      }),
    );

    expect(failed.error?.code).toBe('INTERNAL_ERROR');
    expect(aborted.error?.code).toBe('INVALID_REQUEST');
    expect(manifest(vault)).toEqual(before);
    expect(fs.existsSync(runtimeBase)).toBeFalse();
  });

  test('returns a recursively sanitized result before serialization', () => {
    const vault = makeVault();
    const privatePath = path.join(
      path.parse(process.cwd()).root,
      'private',
      'me-update',
      'secret.json',
    );
    const basePlan = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const result = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options({
        planUpdate: () => ({
          ...basePlan,
          warnings: [
            `warning ${privatePath}`,
            Buffer.from(privatePath),
          ] as unknown as string[],
          diffs: [{
            path: 'CLAUDE.md',
            diff: `/me:setup\n${privatePath}`,
          }],
          conflicts: [{
            path: 'SCHEMA.md',
            reason: `conflict ${privatePath}`,
          }],
        }),
      }),
    );

    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(result.warnings).toEqual([
      'warning <ABSOLUTE_PATH>',
      '<BINARY_DATA>',
    ]);
    expect(result.diffs).toEqual([{
      path: 'CLAUDE.md',
      diff: '/me:setup\n<ABSOLUTE_PATH>',
    }]);
    expect(result.conflicts[0].reason).toBe('conflict <ABSOLUTE_PATH>');
    expect(Buffer.isBuffer(result.warnings[1])).toBeFalse();
  });

  test('preserves the real Claude migration diff including every ME slash command', () => {
    const vault = makeVault();
    const rawPlan = planVaultUpdate({ vaultDir: vault, pluginRoot });
    const rawClaudeDiff = rawPlan.diffs.find(item => item.path === 'CLAUDE.md')?.diff;
    const result = runUpdateCli(
      ['preview', '--vault-dir', vault],
      options(),
    );
    const publicClaudeDiff = result.diffs.find(item => item.path === 'CLAUDE.md')?.diff;

    expect(publicClaudeDiff).toBe(rawClaudeDiff);
    for (const command of [
      '/me:setup',
      '/me:ingest',
      '/me:checklinks',
      '/me:autolinks',
      '/me:backlinks',
      '/me:move',
      '/me:search',
    ]) {
      expect(publicClaudeDiff).toContain(command);
    }
    expect(publicClaudeDiff).not.toContain('<ABSOLUTE_PATH>');
  });

  test('rejects unsafe operation IDs without reflecting them into the result', () => {
    const vault = makeVault('vault_schema_version: 1\n');
    const invalidIds = [
      '',
      '.',
      '..',
      'with/slash',
      'with\\backslash',
      'with space',
      'with\ncontrol',
      'x'.repeat(129),
    ];

    for (const unsafeId of invalidIds) {
      const result = runUpdateCli(
        ['preview', '--vault-dir', vault],
        {
          pluginRoot,
          operationIdFactory: () => unsafeId,
        },
      );
      expect(result.error?.code).toBe('INTERNAL_ERROR');
      expect(result.operationId).toBe('unavailable');
      if (unsafeId.length > 3) {
        expect(JSON.stringify(result)).not.toContain(unsafeId);
      }
    }

    const safe = runUpdateCli(
      ['preview', '--vault-dir', vault],
      {
        pluginRoot,
        operationIdFactory: () => 'preview.test_1-2',
      },
    );
    expect(safe.status).toBe('up_to_date');
    expect(safe.operationId).toBe('preview.test_1-2');
  });
});
