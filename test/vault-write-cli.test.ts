import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WRITER_ERROR_CATALOG,
  VaultWriterError,
  type VaultWriteResultV1,
  type VaultWriteRequestV1,
} from '../bin/vault-write/contracts.ts';
import {
  exitCodeForResult,
  readContainedRequestFile,
  readLimitedRequest,
} from '../bin/vault-write.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/vault-write.ts');
const temporaryDirectories: string[] = [];
const testPosixFifo = process.platform === 'win32' ? test.skip : test;

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

function makeVault(): string {
  const vault = temporaryDirectory('me-vault-cli-');
  fs.mkdirSync(path.join(vault, '.me'));
  for (const layer of ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer));
  }
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  fs.writeFileSync(path.join(vault, 'raw/source.md'), '# Source\n');
  return vault;
}

function request(
  relativePath = 'decisions/2026-07-26-orchid-choice.md',
): VaultWriteRequestV1 {
  return {
    version: 1,
    layer: 'practices',
    relativePath,
    markdown: [
      '---',
      'title: Orchid Choice',
      'created: 2026-07-26',
      'tags: [decision]',
      'type: reflection',
      'source: "[[raw/source]]"',
      'project: ""',
      '---',
      '',
      '# MARKDOWN-SENTINEL private body',
      '',
    ].join('\n'),
    index: { mode: 'auto' },
  };
}

function invoke(
  args: string[],
  input: string | Buffer = '',
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    input,
    encoding: null,
    env: { ...process.env, ...environment },
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for child state');
    await Bun.sleep(10);
  }
}

function parseSingleResult(result: ReturnType<typeof invoke>): Record<string, unknown> {
  const stdout = result.stdout.toString('utf8');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function expectPublicFailure(
  result: ReturnType<typeof invoke>,
  code: keyof typeof WRITER_ERROR_CATALOG,
): Record<string, unknown> {
  const definition = WRITER_ERROR_CATALOG[code];
  expect(result.status).toBe(definition.exitCode);
  const body = parseSingleResult(result);
  expect(body.status).toBe(definition.status);
  expect(body.error).toEqual({ code, message: definition.message });
  return body;
}

describe('vault-write CLI JSON boundary', () => {
  test('preview reads one stdin JSON object and emits one redacted result', () => {
    const vault = makeVault();
    const result = invoke(['preview', '--vault-dir', vault], JSON.stringify(request()));

    expect(result.status).toBe(0);
    const body = parseSingleResult(result);
    expect(body.status).toBe('preview');
    expect(body.commitModel).toBe('preview-only');
    expect(body.notePath).toBe('practices/decisions/2026-07-26-orchid-choice.md');
    expect(result.stderr.toString('utf8')).toBe('');
    const allOutput = `${result.stdout}${result.stderr}`;
    expect(allOutput).not.toContain('MARKDOWN-SENTINEL');
    expect(allOutput).not.toContain(vault);
    expect(allOutput).not.toContain(os.homedir());
  });

  test('write reads a contained request file without deleting it and commits', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/tmp'));
    const requestPath = path.join(vault, '.me/tmp/request.json');
    const bytes = JSON.stringify(request());
    fs.writeFileSync(requestPath, bytes);

    const result = invoke([
      'write',
      '--vault-dir',
      vault,
      '--request',
      '.me/tmp/request.json',
    ]);

    expect(result.status).toBe(0);
    expect(parseSingleResult(result).status).toBe('committed');
    expect(fs.readFileSync(requestPath, 'utf8')).toBe(bytes);
  });

  test('validation and conflict exits use the fixed public catalog', () => {
    const vault = makeVault();
    expectPublicFailure(
      invoke(['preview', '--vault-dir', vault], '{"version":2}'),
      'INVALID_REQUEST',
    );

    fs.writeFileSync(
      path.join(vault, 'practices/2026-07-26-orchid-choice.md'),
      '# Existing\n',
    );
    expectPublicFailure(
      invoke(['preview', '--vault-dir', vault], JSON.stringify(request(
        '2026-07-26-orchid-choice.md',
      ))),
      'TARGET_EXISTS',
    );
  });

  test('every successful status and catalog error uses its fixed exit code', () => {
    const base: VaultWriteResultV1 = {
      version: 1,
      status: 'preview',
      operationId: 'fixture',
      commitModel: 'preview-only',
      requestDigest: '',
      changedPaths: [],
      plannedPaths: [],
      indexAction: 'none',
      backlinks: [],
      unlinkedMentions: [],
      warnings: [],
      recoveryState: 'none',
      recoveries: [],
    };
    expect(exitCodeForResult(base)).toBe(0);
    expect(exitCodeForResult({ ...base, status: 'committed' })).toBe(0);
    for (const [code, definition] of Object.entries(WRITER_ERROR_CATALOG)) {
      expect(exitCodeForResult({
        ...base,
        status: definition.status,
        error: { code, message: definition.message },
      })).toBe(definition.exitCode);
    }
  });

  test('manual recovery serializes every incomplete and unrecognized operation', () => {
    const vault = makeVault();
    const tmp = path.join(vault, '.me/tmp');
    fs.mkdirSync(path.join(tmp, 'vault-write-first'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vault-write-first/journal.json'), JSON.stringify({
      version: 1,
      operationId: 'first',
      state: 'staged',
    }));
    fs.mkdirSync(path.join(tmp, 'vault-write-second'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'vault-write-second/journal.json'), '{bad');
    fs.mkdirSync(path.join(tmp, 'vault-write-third'), { recursive: true });

    const result = invoke(['write', '--vault-dir', vault], JSON.stringify(request()));
    const body = expectPublicFailure(result, 'INCOMPLETE_OPERATION');
    const recoveries = body.recoveries as Array<Record<string, unknown>>;

    expect(recoveries).toHaveLength(3);
    expect(new Set(recoveries.map(item => item.operationId)).size).toBe(3);
    expect(recoveries.filter(item => item.journal === undefined)).toHaveLength(3);
    for (const recovery of recoveries) {
      expect(recovery.operationId).toMatch(/^recovery-[a-f0-9]{12}$/);
      expect(recovery.directory).toBe('.me/tmp');
      expect(JSON.stringify(recovery)).not.toContain(vault);
      expect(JSON.stringify(recovery)).not.toContain('\\');
    }
  });

  test('rejects malformed command lines and malformed stdin as INVALID_REQUEST', () => {
    const vault = makeVault();
    const cases: Array<{ args: string[]; input?: string | Buffer }> = [
      { args: [] },
      { args: ['preview'] },
      { args: ['preview', '--vault-dir', vault, '--wat'] },
      { args: ['preview', '--vault-dir', vault, '--vault-dir', vault] },
      { args: ['preview', '--vault-dir', vault, '--request', 'a', '--request', 'b'] },
      { args: ['remove', '--vault-dir', vault] },
      { args: ['preview', '--vault-dir', vault], input: '{bad' },
      { args: ['preview', '--vault-dir', vault], input: '{} {}' },
      {
        args: ['preview', '--vault-dir', vault],
        input: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
      },
    ];

    for (const item of cases) {
      expectPublicFailure(invoke(item.args, item.input), 'INVALID_REQUEST');
    }
  });

  test('request files must be real json files directly contained by vault .me/tmp', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-vault-cli-outside-');
    fs.mkdirSync(path.join(vault, '.me/tmp'));
    fs.writeFileSync(path.join(outside, 'request.json'), JSON.stringify(request()));
    fs.symlinkSync(path.join(outside, 'request.json'), path.join(vault, '.me/tmp/escape.json'));
    fs.symlinkSync(path.join(outside, 'missing.json'), path.join(vault, '.me/tmp/dangling.json'));
    fs.mkdirSync(path.join(vault, '.me/tmp/nested'));
    fs.writeFileSync(
      path.join(vault, '.me/tmp/nested/request.json'),
      JSON.stringify(request()),
    );

    for (const requestPath of [
      path.join(outside, 'request.json'),
      '../outside.json',
      '.me/tmp/escape.json',
      '.me/tmp/dangling.json',
      '.me/tmp/nested/request.json',
      '.me/tmp/request.txt',
    ]) {
      expectPublicFailure(invoke([
        'preview',
        '--vault-dir',
        vault,
        '--request',
        requestPath,
      ]), 'UNSAFE_PATH');
    }
  });

  testPosixFifo('rejects a request FIFO without blocking the CLI open boundary', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/tmp'));
    const requestPath = path.join(vault, '.me/tmp/request.json');
    const mkfifo = spawnSync('mkfifo', [requestPath], {
      cwd: pluginRoot,
      encoding: null,
    });
    expect(mkfifo.status).toBe(0);
    expect(mkfifo.error).toBeUndefined();

    const result = spawnSync(
      'bun',
      ['run', cli, 'preview', '--vault-dir', vault, '--request', '.me/tmp/request.json'],
      {
        cwd: pluginRoot,
        encoding: null,
        env: process.env,
        timeout: 1_000,
        killSignal: 'SIGKILL',
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expectPublicFailure(result, 'UNSAFE_PATH');
  });

  test('reads a request from one no-follow descriptor and rejects a checked-path replacement', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, '.me/tmp'));
    const requestPath = path.join(vault, '.me/tmp/request.json');
    const moved = path.join(vault, '.me/tmp/original.json');
    const foreign = path.join(temporaryDirectory('me-vault-cli-foreign-'), 'secret.json');
    fs.writeFileSync(requestPath, JSON.stringify(request()));
    fs.writeFileSync(foreign, '{"secret":"descriptor-race-secret"}');

    expect(() => readContainedRequestFile(vault, '.me/tmp/request.json', {
      afterIdentityValidation() {
        fs.renameSync(requestPath, moved);
        fs.symlinkSync(foreign, requestPath);
      },
    })).toThrow(WRITER_ERROR_CATALOG.UNSAFE_PATH.message);
  });

  test('hard-limits raw stdin and request-file bytes to 4 MiB', () => {
    const oversized = temporaryDirectory('me-vault-cli-limit-');
    const file = path.join(oversized, 'request.json');
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    const descriptor = fs.openSync(file, 'r');
    try {
      expect(() => readLimitedRequest(descriptor)).toThrow(
        WRITER_ERROR_CATALOG.INVALID_REQUEST.message,
      );
    } finally {
      fs.closeSync(descriptor);
    }

    const vault = makeVault();
    const raw = Buffer.concat([
      Buffer.from('{"padding":"'),
      Buffer.alloc(4 * 1024 * 1024, 0x61),
      Buffer.from('"}'),
    ]);
    const result = invoke(['preview', '--vault-dir', vault], raw);
    expectPublicFailure(result, 'INVALID_REQUEST');
    expect(fs.existsSync(path.join(vault, '.me/tmp'))).toBeFalse();
  });

  test('never accepts Markdown through argv and redacts request and exception-looking values', () => {
    const vault = makeVault();
    const absoluteSentinel = path.join(path.parse(vault).root, 'Users', 'private', 'person');
    const injected = [
      `${'Authoriza'}${'tion'}: Bearer cli-secret-value`,
      `INJECTED_EXCEPTION ${absoluteSentinel}`,
      'COMMAND_STDERR_SENTINEL',
    ].join(' ');
    const result = invoke([
      'preview',
      '--vault-dir',
      vault,
      '--markdown',
      injected,
    ]);

    expectPublicFailure(result, 'INVALID_REQUEST');
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain('cli-secret-value');
    expect(output).not.toContain('INJECTED_EXCEPTION');
    expect(output).not.toContain('COMMAND_STDERR_SENTINEL');
    expect(output).not.toContain(absoluteSentinel);
  });

  test('redacts untrusted recovery names and journal operation IDs into opaque public entries', () => {
    const vault = makeVault();
    const secretName = 'alice-secret\\backslash';
    const controlName = `control-${String.fromCharCode(1)}-entry`;
    const forgedUuid = '1be1506d-6b3a-4d1b-9f9a-a551dd66c037';
    const tmp = path.join(vault, '.me/tmp');
    for (const name of [secretName, controlName]) {
      const directory = path.join(tmp, `vault-write-${name}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'journal.json'), JSON.stringify({
        version: 1,
        operationId: `${name}-journal`,
        state: 'staged',
      }));
    }
    const forgedDirectory = path.join(tmp, 'vault-write-alice-secret-forged-uuid');
    fs.mkdirSync(forgedDirectory, { recursive: true });
    fs.writeFileSync(path.join(forgedDirectory, 'journal.json'), JSON.stringify({
      version: 1,
      operationId: forgedUuid,
      state: 'staged',
    }));

    const result = invoke(['write', '--vault-dir', vault], JSON.stringify(request()));
    const body = expectPublicFailure(result, 'INCOMPLETE_OPERATION');
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain('alice-secret');
    expect(output).not.toContain('backslash');
    expect(output).not.toContain('control-');
    expect(output).not.toContain(String.fromCharCode(1));
    expect(output).not.toContain(forgedUuid);
    expect((body.recoveries as Array<Record<string, unknown>>)).toHaveLength(3);
    for (const recovery of body.recoveries as Array<Record<string, unknown>>) {
      expect(recovery.operationId).toMatch(/^recovery-[a-f0-9]{12}$/);
      expect(recovery.directory).toBe('.me/tmp');
      expect(recovery.journal).toBeUndefined();
      expect(JSON.stringify(recovery)).not.toContain('\\');
    }
  });

  test('subprocess maps injected filesystem and internal failures through the public catalog', () => {
    const unsupportedVault = makeVault();
    const unsupported = invoke(
      ['write', '--vault-dir', unsupportedVault],
      JSON.stringify(request()),
      {
        NODE_ENV: 'test',
        ME_VAULT_WRITE_TEST_FAILURE: 'UNSUPPORTED_FILESYSTEM',
      },
    );
    expectPublicFailure(unsupported, 'UNSUPPORTED_FILESYSTEM');

    const internalVault = makeVault();
    const injected = `${'Authoriza'}${'tion'}: Bearer cli-injected-secret`;
    const internal = invoke(
      ['preview', '--vault-dir', internalVault],
      JSON.stringify(request()),
      {
        NODE_ENV: 'test',
        ME_VAULT_WRITE_TEST_FAILURE: `INTERNAL_ERROR:${injected}`,
      },
    );
    expectPublicFailure(internal, 'INTERNAL_ERROR');
    expect(`${internal.stdout}${internal.stderr}`).not.toContain('cli-injected-secret');
    expect(`${internal.stdout}${internal.stderr}`).not.toContain(injected);
  });

  test('SIGINT after a recognizable journal preserves it for manual recovery', async () => {
    const vault = makeVault();
    const preloadDirectory = temporaryDirectory('me-vault-cli-sigint-');
    const preload = path.join(preloadDirectory, 'preload.ts');
    const afterJournalMarker = path.join(preloadDirectory, 'after-journal.marker');
    fs.writeFileSync(preload, [
      "import { createRequire, syncBuiltinESMExports } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs') as typeof import('node:fs');",
      'const original = fs.linkSync;',
      'fs.linkSync = ((source, destination) => {',
      "  if (String(destination).endsWith('.probe')) {",
      `    fs.writeFileSync(${JSON.stringify(afterJournalMarker)}, 'ready');`,
      '    const deadline = Date.now() + 10_000;',
      '    while (Date.now() < deadline) {}',
      '  }',
      '  return original(source, destination);',
      '}) as typeof fs.linkSync;',
      'syncBuiltinESMExports();',
    ].join('\n'));
    const child = spawn(
      'bun',
      ['run', '--preload', preload, cli, 'write', '--vault-dir', vault],
      { cwd: pluginRoot, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    );
    child.stdin.end(JSON.stringify(request()));

    let journalPath: string | undefined;
    try {
      await waitFor(() => {
        const tmp = path.join(vault, '.me/tmp');
        if (!fs.existsSync(afterJournalMarker) || !fs.existsSync(tmp)) return false;
        for (const name of fs.readdirSync(tmp)) {
          const operation = name.match(
            /^vault-write-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
          );
          if (!operation) continue;
          const candidate = path.join(tmp, name, 'journal.json');
          try {
            const journal = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
              version?: unknown;
              operationId?: unknown;
              state?: unknown;
            };
            if (
              journal.version === 1
              && journal.operationId === operation[1]
              && [
                'locked',
                'staged',
                'note-published',
                'index-preserved',
                'index-published',
                'validated',
              ].includes(journal.state as string)
            ) {
              journalPath = candidate;
              return true;
            }
          } catch {
            // The journal is not yet complete enough to justify interruption.
          }
        }
        return false;
      });
      child.kill('SIGINT');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SIGINT child did not exit')), 2_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    expect(journalPath).toBeDefined();
    expect(fs.existsSync(journalPath!)).toBeTrue();

    const staleLock = path.join(vault, '.me/locks/vault-write.lock');
    if (fs.existsSync(staleLock)) fs.unlinkSync(staleLock);
    const recovery = invoke(['write', '--vault-dir', vault], JSON.stringify(request()));
    const body = expectPublicFailure(recovery, 'INCOMPLETE_OPERATION');
    const recoveries = body.recoveries as Array<Record<string, unknown>>;
    expect(recoveries.some(item =>
      item.state === 'incomplete-operation'
      && item.journal === path.relative(vault, journalPath!).split(path.sep).join('/'),
    )).toBeTrue();
    expect(JSON.stringify(body)).not.toContain('MARKDOWN-SENTINEL');
  });

  test('SIGINT before journal creation leaves an unrecognized operation recovery', async () => {
    const vault = makeVault();
    const preloadDirectory = temporaryDirectory('me-vault-cli-pre-journal-sigint-');
    const preload = path.join(preloadDirectory, 'preload.ts');
    const beforeJournalMarker = path.join(preloadDirectory, 'before-journal.marker');
    fs.writeFileSync(preload, [
      "import { createRequire, syncBuiltinESMExports } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs') as typeof import('node:fs');",
      'const original = fs.mkdirSync;',
      'fs.mkdirSync = ((directory, options) => {',
      '  const result = original(directory, options);',
      "  if (/\\/vault-write-[0-9a-f-]+$/.test(String(directory))) {",
      `    fs.writeFileSync(${JSON.stringify(beforeJournalMarker)}, 'ready');`,
      '    const deadline = Date.now() + 10_000;',
      '    while (Date.now() < deadline) {}',
      '  }',
      '  return result;',
      '}) as typeof fs.mkdirSync;',
      'syncBuiltinESMExports();',
    ].join('\n'));
    const child = spawn(
      'bun',
      ['run', '--preload', preload, cli, 'write', '--vault-dir', vault],
      { cwd: pluginRoot, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    );
    child.stdin.end(JSON.stringify(request()));

    let operationDirectory: string | undefined;
    try {
      await waitFor(() => {
        const tmp = path.join(vault, '.me/tmp');
        if (!fs.existsSync(beforeJournalMarker) || !fs.existsSync(tmp)) return false;
        const operation = fs.readdirSync(tmp).find(name =>
          /^vault-write-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            .test(name));
        if (!operation) return false;
        operationDirectory = path.join(tmp, operation);
        return !fs.existsSync(path.join(operationDirectory, 'journal.json'));
      });
      child.kill('SIGINT');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SIGINT child did not exit')), 2_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    expect(operationDirectory).toBeDefined();
    expect(fs.existsSync(path.join(operationDirectory!, 'journal.json'))).toBeFalse();

    const staleLock = path.join(vault, '.me/locks/vault-write.lock');
    if (fs.existsSync(staleLock)) fs.unlinkSync(staleLock);
    const recovery = invoke(['write', '--vault-dir', vault], JSON.stringify(request()));
    const body = expectPublicFailure(recovery, 'INCOMPLETE_OPERATION');
    const recoveries = body.recoveries as Array<Record<string, unknown>>;
    expect(recoveries.some(item =>
      item.state === 'unrecognized-operation'
      && item.directory === path.relative(vault, operationDirectory!).split(path.sep).join('/'),
    )).toBeTrue();
    expect(JSON.stringify(body)).not.toContain('MARKDOWN-SENTINEL');
  });
});
