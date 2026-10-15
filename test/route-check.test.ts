import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/route-check.ts');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeVault(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-route-check-test-'));
  fixtures.push(fixture);
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(path.join(vault, '.me'));
  fs.writeFileSync(
    path.join(vault, '.me', 'config.yaml'),
    ['layers:', '  raw: raw', '  practices: practices', '  cognition: cognition'].join('\n') + '\n',
  );
  for (const layer of ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer));
  }
  return vault;
}

function vaultSnapshot(vault: string): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(vault, full)}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(vault);
  return entries.join('\n');
}

function invoke(args: string[], input?: string) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
  });
}

function note(markdown: string): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-route-note-'));
  fixtures.push(fixture);
  const file = path.join(fixture, 'note.md');
  fs.writeFileSync(file, markdown);
  return file;
}

const EXTERNAL_ARTICLE = [
  '---',
  'title: "Attention Paper Summary"',
  'created: 2026-02-01',
  'tags: [attention]',
  'type: article',
  'source: "https://example.com/blog/attention"',
  '---',
  '',
  'A faithful summary of the article. The author recommends caution and argues for small batches.',
  'Quoted opinions remain part of the source capture.',
  '',
].join('\n');

const DECISION_RECORD = [
  '---',
  'title: "Chose Option B"',
  'created: 2026-02-02',
  'tags: [decision]',
  'type: reflection',
  'source: "[[raw/2026-02-01-attention-paper-summary]]"',
  '---',
  '',
  'We decided to adopt option B. The trade-off is acceptable.',
  'We recommend a follow-up experiment next week.',
  '',
].join('\n');

// A decision record dressed as a raw note (schema-valid raw frontmatter) —
// the exact shape of the legacy misfiling this contract guards against.
const DECISION_RECORD_AS_RAW = DECISION_RECORD
  .replace('type: reflection', 'type: article')
  .replace('source: "[[raw/2026-02-01-attention-paper-summary]]"', 'source: "https://example.com/blog/attention"');

describe('route-check CLI', () => {
  test('external source content routes to raw', () => {
    const vault = makeVault();
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(EXTERNAL_ARTICLE)]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ok');
    expect(report.decision.knowledgeType).toBe('external-source');
    expect(report.decision.expectedLayer).toBe('raw');
    expect(report.decision.layerMatches).toBeTrue();
  });

  test('external article with quoted opinions still routes to raw', () => {
    const vault = makeVault();
    const withOpinions = EXTERNAL_ARTICLE + 'The author says: "recommend smaller models". The piece argues trade-offs exist.\n';
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(withOpinions)]);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ok');
    expect(report.decision.expectedLayer).toBe('raw');
  });

  test('decision record declared for raw yields advisory pointing at practices', () => {
    const vault = makeVault();
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(DECISION_RECORD_AS_RAW)]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('advisory');
    expect(report.decision.knowledgeType).toBe('practice-record');
    expect(report.decision.expectedLayer).toBe('practices');
    expect(report.requiresConfirmation).toBeTrue();
    expect(report.advisories.map((a: { code: string }) => a.code)).toContain('ROUTING_LAYER_NEEDS_CONFIRMATION');
  });

  test('schema-invalid note for the declared layer is blocked even on layer mismatch', () => {
    const vault = makeVault();
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(DECISION_RECORD)]);
    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('blocked');
    expect(report.errors.map((e: { code: string }) => e.code)).toContain('ROUTING_TYPE_INVALID_FOR_LAYER');
    expect(report.decision.expectedLayer).toBe('practices');
  });

  test('decision record routes to practices even with a misleading legacy neighbor in raw', () => {
    const vault = makeVault();
    // Legacy misfiled decision record sitting in raw/.
    fs.writeFileSync(path.join(vault, 'raw', '2025-12-01-legacy-decision.md'), DECISION_RECORD_AS_RAW);
    const result = invoke(['--vault-dir', vault, '--layer', 'practices', '--file', note(DECISION_RECORD)]);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('ok');
    expect(report.decision.expectedLayer).toBe('practices');
    expect(report.decision.layerMatches).toBeTrue();
  });

  test('mixed source and judgment advises the raw/practices split', () => {
    const vault = makeVault();
    const mixed = EXTERNAL_ARTICLE + 'We decided against the author. Recommend a follow-up.\n';
    const result = invoke(['--vault-dir', vault, '--layer', 'practices', '--file', note(mixed)]);
    const report = JSON.parse(result.stdout);
    expect(report.decision.mixedSourceAndJudgment).toBeTrue();
    expect(report.advisories.map((a: { code: string }) => a.code)).toContain('ROUTING_MIXED_SOURCE_AND_JUDGMENT');
  });

  test('raw note with internal provenance URI is blocked', () => {
    const vault = makeVault();
    const bad = EXTERNAL_ARTICLE.replace('https://example.com/blog/attention', 'me://vault/raw/old-note');
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(bad)]);
    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('blocked');
    expect(report.errors.map((e: { code: string }) => e.code)).toContain('ROUTING_RAW_SOURCE_NOT_URL');
  });

  test('layer-invalid type is blocked', () => {
    const vault = makeVault();
    const bad = EXTERNAL_ARTICLE.replace('type: article', 'type: experiment');
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(bad)]);
    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.errors.map((e: { code: string }) => e.code)).toContain('ROUTING_TYPE_INVALID_FOR_LAYER');
  });

  test('cognition writes without the distill flag surface a gate advisory', () => {
    const vault = makeVault();
    const insight = [
      '---',
      'title: "Insight"',
      'created: 2026-02-03',
      'tags: [x]',
      'type: insight',
      'source: "[[practices/2026-02-02-chose-option-b]]"',
      'confidence: medium',
      '---',
      '',
      'A stable insight confirmed by [[practices/2026-02-02-a]] and [[practices/2026-02-03-b]].',
      '',
    ].join('\n');
    const without = invoke(['--vault-dir', vault, '--layer', 'cognition', '--file', note(insight)]);
    const report = JSON.parse(without.stdout);
    expect(report.advisories.map((a: { code: string }) => a.code)).toContain('ROUTING_COGNITION_REQUIRES_DISTILL');
    const withFlag = invoke(['--vault-dir', vault, '--layer', 'cognition', '--via-distill', '--file', note(insight)]);
    expect(JSON.parse(withFlag.stdout).advisories.map((a: { code: string }) => a.code))
      .not.toContain('ROUTING_COGNITION_REQUIRES_DISTILL');
  });

  test('reads markdown from stdin', () => {
    const vault = makeVault();
    const result = invoke(['--vault-dir', vault, '--layer', 'raw', '--stdin'], EXTERNAL_ARTICLE);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).decision.expectedLayer).toBe('raw');
  });

  test('explicit knowledge type drives the decision', () => {
    const vault = makeVault();
    const result = invoke([
      '--vault-dir', vault, '--layer', 'raw',
      '--knowledge-type', 'practice-record',
      '--file', note(DECISION_RECORD),
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.decision.knowledgeTypeSource).toBe('declared');
    expect(report.decision.expectedLayer).toBe('practices');
  });

  test('invalid arguments exit 2', () => {
    const vault = makeVault();
    expect(invoke(['--vault-dir', vault]).status).toBe(2);
    expect(invoke(['--vault-dir', vault, '--layer', 'nope', '--stdin'], 'x').status).toBe(2);
  });

  test('route-check is zero-write', () => {
    const vault = makeVault();
    const before = vaultSnapshot(vault);
    invoke(['--vault-dir', vault, '--layer', 'raw', '--file', note(EXTERNAL_ARTICLE)]);
    invoke(['--vault-dir', vault, '--layer', 'raw', '--stdin'], DECISION_RECORD);
    expect(vaultSnapshot(vault)).toBe(before);
  });
});
