import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { moveCommand } from '../bin/move.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH ?? '';

// Keep the real Obsidian CLI out of the test environment. Tests that
// exercise Obsidian mode prepend their own stub directory explicitly.
const SAFE_PATH = '/usr/bin:/bin';

afterEach(() => {
  process.env.PATH = originalPath;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  process.env.PATH = SAFE_PATH;
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const NESTED_CONFIG = `layers:
  raw: "knowledge/raw"
  practices: "knowledge/practices"
  cognition: "knowledge/cognition"
`;

function makeVault(config: string | null = NESTED_CONFIG): string {
  const vault = temporaryDirectory('me-move-vault-');
  const layers = config
    ? ['knowledge/raw', 'knowledge/practices', 'knowledge/cognition']
    : ['raw', 'practices', 'cognition'];
  fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(vault, '.me', 'config.yaml'), config);
  }
  for (const layer of layers) {
    fs.mkdirSync(path.join(vault, layer), { recursive: true });
  }
  return vault;
}

function writeNote(vault: string, relativePath: string, content: string): void {
  const absolute = path.join(vault, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function readNote(vault: string, relativePath: string): string {
  return fs.readFileSync(path.join(vault, relativePath), 'utf8');
}

const NESTED_NOTE = 'knowledge/raw/records/work/org/2026-07-28-example.md';

function seedNestedVault(): string {
  const vault = makeVault();
  writeNote(vault, NESTED_NOTE, '# Example\n\nContent of the example note.\n');
  writeNote(
    vault,
    'knowledge/practices/referencing.md',
    'See [[2026-07-28-example]] and [[2026-07-28-example|the alias]] and [[2026-07-28-example#details]].\n',
  );
  return vault;
}

describe('me:move native resolution', () => {
  test('renames a root-level note by stem and rewrites wikilink variants', async () => {
    const vault = makeVault(null);
    writeNote(vault, 'raw/note-b.md', '# Note B\n');
    writeNote(
      vault,
      'practices/note-a.md',
      'See [[note-b]] plus [[note-b|alias]] plus [[note-b#section]].\n',
    );

    const result = await moveCommand('note-b', 'note-b-renamed', vault);

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, 'raw/note-b.md'))).toBe(false);
    expect(fs.existsSync(path.join(vault, 'raw/note-b-renamed.md'))).toBe(true);
    const referencing = readNote(vault, 'practices/note-a.md');
    expect(referencing).toContain('[[note-b-renamed]]');
    expect(referencing).toContain('[[note-b-renamed|alias]]');
    expect(referencing).toContain('[[note-b-renamed#section]]');
    expect(referencing).not.toContain('[[note-b]]');
    expect(referencing).not.toContain('[[note-b|');
    expect(referencing).not.toContain('[[note-b#');
  });

  test('renames a nested note by stem', async () => {
    const vault = seedNestedVault();

    const result = await moveCommand('2026-07-28-example', '2026-07-21-example', vault);

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, NESTED_NOTE))).toBe(false);
    const renamed = 'knowledge/raw/records/work/org/2026-07-21-example.md';
    expect(fs.existsSync(path.join(vault, renamed))).toBe(true);
    const referencing = readNote(vault, 'knowledge/practices/referencing.md');
    expect(referencing).toContain('[[2026-07-21-example]]');
    expect(referencing).toContain('[[2026-07-21-example|the alias]]');
    expect(referencing).toContain('[[2026-07-21-example#details]]');
    expect(referencing).not.toContain('2026-07-28-example');
  });

  test('resolves a vault-relative source path', async () => {
    const vault = seedNestedVault();
    const destination = 'knowledge/raw/records/work/org/2026-07-21-example.md';

    const result = await moveCommand(NESTED_NOTE, destination, vault);

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, NESTED_NOTE))).toBe(false);
    expect(fs.existsSync(path.join(vault, destination))).toBe(true);
  });

  test('resolves a layer-relative source path', async () => {
    const vault = seedNestedVault();

    const result = await moveCommand(
      'records/work/org/2026-07-28-example.md',
      '2026-07-21-example',
      vault,
    );

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, NESTED_NOTE))).toBe(false);
    expect(
      fs.existsSync(path.join(vault, 'knowledge/raw/records/work/org/2026-07-21-example.md')),
    ).toBe(true);
  });

  test('moves a nested note across layers', async () => {
    const vault = seedNestedVault();
    const destination = 'knowledge/cognition/2026-07-28-example.md';

    const result = await moveCommand('2026-07-28-example', destination, vault);

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, NESTED_NOTE))).toBe(false);
    expect(fs.existsSync(path.join(vault, destination))).toBe(true);
  });

  test('handles Chinese directory and note names', async () => {
    const vault = makeVault(`layers:
  raw: "调研"
  practices: "实践"
  cognition: "认知"
`);
    writeNote(vault, '调研/记录/工作/中文笔记.md', '# 中文笔记\n');
    writeNote(vault, '实践/引用.md', '参见 [[中文笔记]]。\n');

    const result = await moveCommand('中文笔记', '改名笔记', vault);

    expect(result).toContain('completed successfully');
    expect(fs.existsSync(path.join(vault, '调研/记录/工作/中文笔记.md'))).toBe(false);
    expect(fs.existsSync(path.join(vault, '调研/记录/工作/改名笔记.md'))).toBe(true);
    expect(readNote(vault, '实践/引用.md')).toContain('[[改名笔记]]');
  });

  test('reports candidate paths when a stem is ambiguous', async () => {
    const vault = makeVault();
    writeNote(vault, 'knowledge/raw/records/work/dup.md', '# work copy\n');
    writeNote(vault, 'knowledge/raw/records/personal/dup.md', '# personal copy\n');

    const result = await moveCommand('dup', 'renamed', vault);

    expect(result).toContain('ambiguous');
    expect(result).toContain('knowledge/raw/records/work/dup.md');
    expect(result).toContain('knowledge/raw/records/personal/dup.md');
    // Nothing moved.
    expect(fs.existsSync(path.join(vault, 'knowledge/raw/records/work/dup.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, 'knowledge/raw/records/personal/dup.md'))).toBe(true);
  });

  test('returns not-found for an unknown note', async () => {
    const vault = makeVault();

    const result = await moveCommand('missing-note', 'whatever', vault);

    expect(result).toContain("Error: Note 'missing-note' not found in the vault.");
  });

  test('escapes regex metacharacters in note names during rewrite', async () => {
    const vault = makeVault(null);
    writeNote(vault, 'raw/note+(draft).md', '# Draft\n');
    writeNote(vault, 'raw/notedraft.md', '# Unrelated\n');
    writeNote(
      vault,
      'practices/referencing.md',
      'Draft: [[note+(draft)]]. Unrelated: [[notedraft]].\n',
    );

    const result = await moveCommand('note+(draft)', 'note-final', vault);

    expect(result).toContain('completed successfully');
    const referencing = readNote(vault, 'practices/referencing.md');
    expect(referencing).toContain('[[note-final]]');
    expect(referencing).toContain('[[notedraft]]');
    expect(referencing).not.toContain('note+(draft)');
  });

  test('inserts dollar signs in the new name literally', async () => {
    const vault = makeVault(null);
    writeNote(vault, 'raw/price.md', '# Price\n');
    writeNote(vault, 'practices/referencing.md', 'See [[price]].\n');

    const result = await moveCommand('price', 'price$&updated', vault);

    expect(result).toContain('completed successfully');
    expect(readNote(vault, 'practices/referencing.md')).toContain('[[price$&updated]]');
  });

  test('leaves ordinary markdown links untouched (documented limitation)', async () => {
    const vault = makeVault(null);
    writeNote(vault, 'raw/note-b.md', '# Note B\n');
    writeNote(
      vault,
      'practices/note-a.md',
      'Wikilink [[note-b]] and markdown [link](../raw/note-b.md).\n',
    );

    const result = await moveCommand('note-b', 'note-b-renamed', vault);

    expect(result).toContain('completed successfully');
    const referencing = readNote(vault, 'practices/note-a.md');
    expect(referencing).toContain('[[note-b-renamed]]');
    // Ordinary markdown links are explicitly not rewritten.
    expect(referencing).toContain('[link](../raw/note-b.md)');
  });
});

describe('me:move Obsidian mode', () => {
  function installObsidianStub(): { stubDir: string; log: string; vault: string } {
    const vault = seedNestedVault();
    const stubDir = temporaryDirectory('me-move-obsidian-stub-');
    const log = path.join(stubDir, 'calls.jsonl');
    const stub = `#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';

const [, , command, ...rest] = process.argv;
const vault = process.env.OBSIDIAN_STUB_VAULT!;
const log = process.env.OBSIDIAN_STUB_LOG!;

function parse(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    parsed[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return parsed;
}

if (command === 'vault') {
  process.exit(0);
}

const params = parse(rest);
fs.appendFileSync(log, JSON.stringify({ command, ...params }) + '\\n');

if (command === 'move') {
  fs.renameSync(path.join(vault, params.file), path.join(vault, params.to));
} else if (command === 'rename') {
  const source = path.join(vault, params.file);
  fs.renameSync(source, path.join(path.dirname(source), params.name + '.md'));
}
`;
    fs.writeFileSync(path.join(stubDir, 'obsidian'), stub, { mode: 0o755 });
    return { stubDir, log, vault };
  }

  function stubCalls(log: string): Array<Record<string, string>> {
    return fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  // bun's execSync does not propagate runtime process.env mutations to
  // children, so Obsidian-mode tests drive bin/move.ts as a subprocess with
  // the stub PATH applied at process launch.
  function runMoveCli(
    stubDir: string,
    log: string,
    vault: string,
    source: string,
    destination: string,
  ): string {
    const result = spawnSync(
      process.execPath,
      ['run', path.join(pluginRoot, 'bin/move.ts'), source, destination, vault],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubDir}:${path.dirname(process.execPath)}:${SAFE_PATH}`,
          OBSIDIAN_STUB_VAULT: vault,
          OBSIDIAN_STUB_LOG: log,
        },
      },
    );
    return `${result.stdout}${result.stderr}`;
  }

  test('passes the normalized vault-relative path to obsidian rename', () => {
    const { stubDir, log, vault } = installObsidianStub();

    // Bare stem input: the CLI must receive the resolved vault-relative path.
    const output = runMoveCli(stubDir, log, vault, '2026-07-28-example', '2026-07-21-example');

    expect(output).toContain('completed successfully');
    expect(output).toContain('Obsidian CLI');
    const calls = stubCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('rename');
    expect(calls[0].file).toBe('knowledge/raw/records/work/org/2026-07-28-example.md');
    expect(calls[0].name).toBe('2026-07-21-example');
    expect(
      fs.existsSync(path.join(vault, 'knowledge/raw/records/work/org/2026-07-21-example.md')),
    ).toBe(true);
  });

  test('passes the normalized vault-relative path to obsidian move', () => {
    const { stubDir, log, vault } = installObsidianStub();
    const destination = 'knowledge/cognition/2026-07-28-example.md';

    const output = runMoveCli(stubDir, log, vault, '2026-07-28-example', destination);

    expect(output).toContain('completed successfully');
    const calls = stubCalls(log);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('move');
    expect(calls[0].file).toBe('knowledge/raw/records/work/org/2026-07-28-example.md');
    expect(calls[0].to).toBe(destination);
    expect(fs.existsSync(path.join(vault, destination))).toBe(true);
  });
});
