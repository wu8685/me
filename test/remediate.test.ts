import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/remediate.ts');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeVault(layers: { raw: string; practices: string; cognition: string } = {
  raw: 'raw', practices: 'practices', cognition: 'cognition',
}): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-remediate-test-'));
  fixtures.push(fixture);
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(path.join(vault, '.me'));
  fs.writeFileSync(
    path.join(vault, '.me', 'config.yaml'),
    ['layers:', `  raw: ${layers.raw}`, `  practices: ${layers.practices}`, `  cognition: ${layers.cognition}`].join('\n') + '\n',
  );
  for (const dir of Object.values(layers)) {
    fs.mkdirSync(path.join(vault, dir), { recursive: true });
  }
  return vault;
}

function runtimeEnv(vault: string): NodeJS.ProcessEnv {
  const root = path.join(path.dirname(vault), 'runtime');
  fs.mkdirSync(root, { recursive: true });
  return { ME_RUNTIME_ROOT: root };
}

function sha(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function vaultSnapshot(vault: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(vault, full)}:${sha(fs.readFileSync(full))}`);
    }
  };
  walk(vault);
  return entries.join('\n');
}

function invoke(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

/** Misfiled decision record living in raw/ (schema-shaped as a raw note). */
const MISFILED_DECISION = [
  '---',
  'title: "Chose Option B"',
  'created: 2026-02-02',
  'tags: [decision]',
  'type: article',
  'source: "https://example.com/blog/attention"',
  '---',
  '',
  'We decided to adopt option B. The trade-off is acceptable.',
  'We recommend a follow-up experiment next week.',
  '',
].join('\n');

/** Corrected frontmatter for the practices layer. */
const CORRECTED_DECISION = MISFILED_DECISION
  .replace('type: article', 'type: reflection')
  .replace('source: "https://example.com/blog/attention"', 'source: "[[raw/2026-02-01-attention-paper-summary]]"');

function plantMisfiled(vault: string, rawDir = 'raw'): string {
  const notePath = path.join(vault, rawDir, '2026-02-02-chose-option-b.md');
  fs.writeFileSync(notePath, MISFILED_DECISION);
  return `${rawDir}/2026-02-02-chose-option-b.md`;
}

function plantSource(vault: string, rawDir = 'raw'): void {
  fs.writeFileSync(path.join(vault, rawDir, '2026-02-01-attention-paper-summary.md'), [
    '---',
    'title: "Attention Paper Summary"',
    'created: 2026-02-01',
    'tags: [attention]',
    'type: article',
    'source: "https://example.com/blog/attention"',
    '---',
    '',
    'A faithful summary of the referenced article.',
    '',
  ].join('\n'));
}

function markdownFile(content: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-remediate-md-'));
  fixtures.push(fixture);
  const file = path.join(fixture, 'note.md');
  fs.writeFileSync(file, content);
  return file;
}

describe('remediate preview', () => {
  test('produces a zero-write digest-bound preview', () => {
    const vault = makeVault();
    plantSource(vault);
    const noteRel = plantMisfiled(vault);
    const before = vaultSnapshot(vault);

    const result = invoke([
      'preview', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', markdownFile(CORRECTED_DECISION),
    ]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('preview');
    expect(report.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.sourcePath).toBe(noteRel);
    expect(report.destinationPath).toBe('practices/2026-02-02-chose-option-b.md');
    expect(report.frontmatterChanges.map((c: { field: string }) => c.field).sort()).toEqual(['source', 'type']);
    expect(report.zeroWrite).toBeTrue();

    expect(vaultSnapshot(vault)).toBe(before);
  });

  test('preview without corrected markdown is blocked by schema validation', () => {
    const vault = makeVault();
    const noteRel = plantMisfiled(vault);
    const result = invoke(['preview', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices']);
    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('blocked');
    expect(report.validation.errors.map((e: { code: string }) => e.code))
      .toEqual(expect.arrayContaining(['ROUTING_TYPE_INVALID_FOR_LAYER', 'ROUTING_PROVENANCE_NOT_REFERENCE']));
  });

  test('rejects a missing note and an existing destination', () => {
    const vault = makeVault();
    const noteRel = plantMisfiled(vault);
    expect(invoke(['preview', '--vault-dir', vault, '--note', 'raw/nope.md', '--to-layer', 'practices']).status).toBe(2);
    fs.writeFileSync(path.join(vault, 'practices', '2026-02-02-chose-option-b.md'), CORRECTED_DECISION);
    const result = invoke(['preview', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', markdownFile(CORRECTED_DECISION)]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe('TARGET_EXISTS');
  });

  test('supports custom configured layer paths', () => {
    const vault = makeVault({ raw: 'inbox', practices: 'journal', cognition: 'wiki' });
    plantSource(vault, 'inbox');
    const noteRel = plantMisfiled(vault, 'inbox');
    const result = invoke([
      'preview', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', markdownFile(CORRECTED_DECISION),
    ]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.destinationPath).toBe('journal/2026-02-02-chose-option-b.md');
  });
});

describe('remediate apply', () => {
  function previewDigest(vault: string, noteRel: string, md: string): string {
    const preview = invoke([
      'preview', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', md,
    ]);
    expect(preview.status).toBe(0);
    return JSON.parse(preview.stdout).planDigest;
  }

  test('confirmed apply moves the note, rewrites path-qualified wikilinks, and preserves indexes', () => {
    const vault = makeVault();
    plantSource(vault);
    const noteRel = plantMisfiled(vault);
    // A practices note referencing the misfiled note via path-qualified wikilink.
    fs.writeFileSync(path.join(vault, 'practices', '2026-02-03-follow-up.md'), [
      '---',
      'title: "Follow Up"',
      'created: 2026-02-03',
      'tags: [decision]',
      'type: experiment',
      'source: "[[raw/2026-02-02-chose-option-b]]"',
      '---',
      '',
      'Builds on [[raw/2026-02-02-chose-option-b]] and [[raw/2026-02-02-chose-option-b#rationale]].',
      '',
    ].join('\n'));
    // Layer indexes with managed blocks.
    fs.writeFileSync(path.join(vault, 'raw', 'README.md'), [
      '# Raw', '', '<!-- me:index:start -->',
      '- [[raw/2026-02-01-attention-paper-summary]]',
      '- [[raw/2026-02-02-chose-option-b]]',
      '<!-- me:index:end -->', '',
    ].join('\n'));
    fs.writeFileSync(path.join(vault, 'practices', 'README.md'), [
      '# Practices', '', '<!-- me:index:start -->',
      '- [[practices/2026-02-03-follow-up]]',
      '<!-- me:index:end -->', '',
    ].join('\n'));

    const md = markdownFile(CORRECTED_DECISION);
    const digest = previewDigest(vault, noteRel, md);
    const apply = invoke([
      'apply', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', md, '--expected-plan-digest', digest,
    ], runtimeEnv(vault));
    expect(apply.status).toBe(0);
    const report = JSON.parse(apply.stdout);
    expect(report.status).toBe('committed');
    expect(report.recoveryState).toBe('none');
    expect(report.preservedPaths.length).toBeGreaterThan(0);

    // Note moved with corrected frontmatter.
    expect(fs.existsSync(path.join(vault, noteRel))).toBeFalse();
    const moved = fs.readFileSync(path.join(vault, 'practices', '2026-02-02-chose-option-b.md'), 'utf8');
    expect(moved).toContain('type: reflection');

    // Path-qualified wikilinks rewritten; index entries moved between READMEs.
    const followUp = fs.readFileSync(path.join(vault, 'practices', '2026-02-03-follow-up.md'), 'utf8');
    expect(followUp).toContain('[[practices/2026-02-02-chose-option-b]]');
    expect(followUp).toContain('[[practices/2026-02-02-chose-option-b#rationale]]');
    expect(followUp).not.toContain('[[raw/2026-02-02-chose-option-b');
    const rawIndex = fs.readFileSync(path.join(vault, 'raw', 'README.md'), 'utf8');
    expect(rawIndex).not.toContain('[[raw/2026-02-02-chose-option-b]]');
    expect(rawIndex).toContain('[[raw/2026-02-01-attention-paper-summary]]');
    const practicesIndex = fs.readFileSync(path.join(vault, 'practices', 'README.md'), 'utf8');
    expect(practicesIndex).toContain('[[practices/2026-02-02-chose-option-b]]');
    expect(practicesIndex).toContain('[[practices/2026-02-03-follow-up]]');
  });

  test('stale digest rejects the apply without touching the vault', () => {
    const vault = makeVault();
    plantSource(vault);
    const noteRel = plantMisfiled(vault);
    const md = markdownFile(CORRECTED_DECISION);
    const digest = previewDigest(vault, noteRel, md);

    // Vault state changes after the preview.
    fs.appendFileSync(path.join(vault, noteRel), 'Edited after preview.\n');
    const before = vaultSnapshot(vault);
    const apply = invoke([
      'apply', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', md, '--expected-plan-digest', digest,
    ]);
    expect(apply.status).toBe(4);
    expect(JSON.parse(apply.stdout).error.code).toBe('STALE_PREVIEW');
    expect(vaultSnapshot(vault)).toBe(before);
  });

  test('a failed apply rolls back and reports a truthful recovery', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const vault = makeVault();
    plantSource(vault);
    const noteRel = plantMisfiled(vault);
    const md = markdownFile(CORRECTED_DECISION);
    const digest = previewDigest(vault, noteRel, md);

    // Sabotage the destination layer after preview: file fingerprints are
    // unchanged, but publishing the moved note will fail with EACCES.
    const practicesDir = path.join(vault, 'practices');
    fs.chmodSync(practicesDir, 0o555);
    try {
      const before = vaultSnapshot(vault);
      const apply = invoke([
        'apply', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
        '--markdown-file', md, '--expected-plan-digest', digest,
      ], runtimeEnv(vault));
      expect(apply.status).toBe(5);
      const report = JSON.parse(apply.stdout);
      expect(report.status).toBe('rolled-back');
      expect(report.recoveryState).toBe('rolled-back');
      expect(report.preservedPaths.length).toBeGreaterThan(0);

      // Original bytes restored exactly.
      expect(vaultSnapshot(vault)).toBe(before);
      expect(fs.existsSync(path.join(vault, noteRel))).toBeTrue();
    } finally {
      fs.chmodSync(practicesDir, 0o755);
    }
  });

  test('digest mismatch for a tampered destination markdown is stale', () => {
    const vault = makeVault();
    plantSource(vault);
    const noteRel = plantMisfiled(vault);
    const digest = previewDigest(vault, noteRel, markdownFile(CORRECTED_DECISION));
    const tampered = markdownFile(CORRECTED_DECISION.replace('Option B', 'Option C'));
    const apply = invoke([
      'apply', '--vault-dir', vault, '--note', noteRel, '--to-layer', 'practices',
      '--markdown-file', tampered, '--expected-plan-digest', digest,
    ]);
    expect(apply.status).toBe(4);
  });
});
