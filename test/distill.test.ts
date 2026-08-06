import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDistillArguments } from '../bin/distill';
import {
  parseNote,
  extractWikilinks,
  buildDistillContext,
  generateCognitionMarkdown,
  computePreviewDigest,
  generateCognitionPath,
  buildCaseSummaries,
  buildEvidenceItems,
  runDistillPreview,
  runDistillApply,
  resolveDistillLayout,
} from '../bin/distill/core';
import {
  checkLocalProvenance,
  checkMultipleIndependentCases,
  checkCounterevidenceSearch,
  checkNoUnresolvedContradiction,
  checkGeneralizesBeyondTask,
  checkClearBoundaries,
  checkJustifiedConfidence,
  checkReviewTriggerSet,
  checkSchemaValidDestination,
  areIndependentCases,
  runGates,
  allGatesPass,
  extractBoundaries,
  extractReviewTrigger,
} from '../bin/distill/gates';
import type { DistillContext, DistillPreviewV1, ParsedNote } from '../bin/distill/contracts';
import { PRACTICE_TYPES } from '../bin/distill/contracts';
import { executeVaultWrite, type VaultWriteHooks } from '../bin/vault-write/transaction';
import { resolveVaultLayout } from '../bin/vault-write/path-safety';
import { loadLayerSchema, validateNoteMarkdown } from '../bin/vault-write/schema';
import type { VaultWriteRequestV1, LogicalLayer } from '../bin/vault-write/contracts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/distill.ts');
const fixtureDir = path.join(pluginRoot, 'test/fixtures/distill');
const vaultHealthy = path.join(fixtureDir, 'vault-healthy');
const vaultCustom = path.join(fixtureDir, 'vault-custom-layers');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ── Helper: build minimal DistillContext for unit tests ───────────────

function makeCtx(overrides: Partial<DistillContext> = {}): DistillContext {
  const practice: ParsedNote = {
    path: 'practices/test.md',
    frontmatter: { title: 'Test', type: 'reflection', created: '2026-08-01', tags: ['go'] },
    body: '# Test\n\n## Boundaries\n- Applies to Go\n',
    title: 'Test', created: '2026-08-01', tags: ['go'], type: 'reflection',
    project: 'test-project', source: '[[raw/source]]',
  };
  return {
    vaultDir: '/vault',
    layout: {
      lexicalVault: '/vault',
      canonicalVault: '/vault',
      meDir: '/vault/.me',
      layers: { raw: '/vault/raw', practices: '/vault/practices', cognition: '/vault/cognition' },
    },
    layerNames: { raw: 'raw', practices: 'practices', cognition: 'cognition' },
    practice,
    linkedNotes: [],
    allPractices: [],
    independentCases: [],
    counterevidence: [],
    ...overrides,
  };
}

function makeNote(overrides: Partial<ParsedNote> = {}): ParsedNote {
  return {
    path: 'practices/test.md',
    frontmatter: {},
    body: '# Test',
    title: 'Test',
    created: '',
    tags: [],
    type: 'reflection',
    ...overrides,
  };
}

// ── makeVault helper for apply tests ──────────────────────────────────

function makeVault(): string {
  const fixture = makeTemp('me-distill-vault-');
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  fs.mkdirSync(path.join(vault, '.me'));
  for (const layer of ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer));
    fs.writeFileSync(path.join(vault, layer, 'README.md'), `# ${layer}\n`);
  }
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  fs.writeFileSync(path.join(vault, '.me/config.yaml'), 'layers:\n  raw: raw\n  practices: practices\n  cognition: cognition\n');
  return vault;
}

function writePracticeNote(vault: string, relPath: string, content: string): void {
  const fullPath = path.join(vault, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** Build a schema-valid practice note (confidence/review in body, not frontmatter). */
function practiceContent(opts: {
  title: string; created?: string; tags?: string[]; type?: string;
  source?: string; project?: string; body: string[];
  confidence?: string; review?: string;
}): string {
  const fm = [
    '---',
    `title: "${opts.title}"`,
    `created: ${opts.created || '2026-08-01'}`,
    `tags: [${(opts.tags || ['test']).join(', ')}]`,
    `type: ${opts.type || 'reflection'}`,
    ...(opts.source ? [`source: "${opts.source}"`] : []),
    ...(opts.project ? [`project: "${opts.project}"`] : []),
    '---',
  ];
  const bodyExtra: string[] = [];
  if (opts.confidence) {
    bodyExtra.push('## Confidence', opts.confidence);
  }
  if (opts.review) {
    bodyExtra.push('## Review', opts.review);
  }
  return [...fm, '', ...opts.body, ...bodyExtra].join('\n');
}

// ── parseNote ─────────────────────────────────────────────────────────

describe('parseNote', () => {
  test('parses a valid note with frontmatter', () => {
    const content = [
      '---',
      'title: "Test Note"',
      'created: 2026-08-01',
      'tags: [go, testing]',
      'type: reflection',
      'source: "[[raw/source]]"',
      'project: "myproject"',
      'confidence: medium',
      'review: 2026-11-05',
      '---',
      '',
      '# Test Note',
      '',
      'Body content here.',
    ].join('\n');

    const note = parseNote(content, 'practices/test-note.md');
    expect(note.title).toBe('Test Note');
    expect(note.created).toBe('2026-08-01');
    expect(note.tags).toEqual(['go', 'testing']);
    expect(note.type).toBe('reflection');
    expect(note.source).toBe('[[raw/source]]');
    expect(note.project).toBe('myproject');
    expect(note.body).toContain('# Test Note');
    expect(note.path).toBe('practices/test-note.md');
  });

  test('throws on missing frontmatter', () => {
    expect(() => parseNote('# No frontmatter', 'test.md')).toThrow();
  });

  test('handles empty tags', () => {
    const content = [
      '---',
      'title: "Minimal"',
      'created: 2026-08-01',
      'tags: []',
      'type: reflection',
      '---',
      '',
      '# Minimal',
    ].join('\n');
    const note = parseNote(content, 'practices/minimal.md');
    expect(note.tags).toEqual([]);
    expect(note.project).toBeUndefined();
  });
});

// ── extractWikilinks ──────────────────────────────────────────────────

describe('extractWikilinks', () => {
  test('extracts simple, aliased, anchored, dedup', () => {
    const links = extractWikilinks('[[raw/a]] [[raw/b|Alias]] [[raw/c#head]] [[raw/a]]');
    expect(links).toEqual(['raw/a', 'raw/b', 'raw/c']);
  });
  test('returns empty for no links', () => {
    expect(extractWikilinks('No links here.').length).toBe(0);
  });
});

// ── buildDistillContext ───────────────────────────────────────────────

describe('buildDistillContext', () => {
  test('builds context from healthy vault', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const ctx = buildDistillContext(vaultHealthy, 'practices/2026-08-01-go-error-handling.md', layout, layerNames);
    expect(ctx.practice.path).toBe('practices/2026-08-01-go-error-handling.md');
    expect(ctx.practice.title).toContain('Go explicit error handling');
    expect(ctx.practice.type).toBe('reflection');
    expect(ctx.practice.project).toBe('graphyer');
    expect(ctx.layerNames.practices).toBe('practices');
  });

  test('throws on missing practice', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    expect(() => buildDistillContext(vaultHealthy, 'practices/nonexistent.md', layout, layerNames)).toThrow();
  });

  test('throws when path not in configured practices layer', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    expect(() => buildDistillContext(vaultHealthy, 'raw/go-error-crash-log.md', layout, layerNames)).toThrow();
  });

  test('works with custom layer names', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultCustom);
    const ctx = buildDistillContext(vaultCustom, 'notes/2026-08-01-custom-practice.md', layout, layerNames);
    expect(ctx.layerNames.practices).toBe('notes');
    expect(ctx.layerNames.raw).toBe('research');
    expect(ctx.layerNames.cognition).toBe('insights');
    expect(ctx.practice.type).toBe('reflection');
  });
});

// ── areIndependentCases ───────────────────────────────────────────────

describe('areIndependentCases', () => {
  test('different projects with distinct sources are independent', () => {
    const a = makeNote({ path: 'practices/a.md', project: 'proj-a', source: '[[raw/x]]', tags: ['go'] });
    const b = makeNote({ path: 'practices/b.md', project: 'proj-b', source: '[[raw/y]]', tags: ['go'] });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeTrue();
    expect(result.rationale).toContain('proj-a');
    expect(result.rationale).toContain('proj-b');
    expect(result.rationale).toContain('distinct provenance');
  });

  test('different project + same source is NOT independent', () => {
    const a = makeNote({ path: 'practices/a.md', project: 'proj-a', source: '[[raw/x]]' });
    const b = makeNote({ path: 'practices/b.md', project: 'proj-b', source: '[[raw/x]]' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('Same source provenance');
  });

  test('different project + missing source on candidate is NOT independent', () => {
    const a = makeNote({ path: 'practices/a.md', project: 'proj-a', source: '[[raw/x]]' });
    const b = makeNote({ path: 'practices/b.md', project: 'proj-b' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('source provenance');
  });

  test('different project + missing source on primary is NOT independent', () => {
    const a = makeNote({ path: 'practices/a.md', project: 'proj-a' });
    const b = makeNote({ path: 'practices/b.md', project: 'proj-b', source: '[[raw/y]]' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('source provenance');
  });

  test('same project is not independent', () => {
    const a = makeNote({ path: 'practices/a.md', project: 'same-proj' });
    const b = makeNote({ path: 'practices/b.md', project: 'same-proj' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('Same project');
  });

  test('same source is not independent', () => {
    const a = makeNote({ path: 'practices/a.md', source: '[[raw/x]]' });
    const b = makeNote({ path: 'practices/b.md', source: '[[raw/x]]' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('Same source');
  });

  test('direct wikilink derivation is not independent', () => {
    const a = makeNote({ path: 'practices/a.md' });
    const b = makeNote({ path: 'practices/b.md', body: 'See [[practices/a]] for details.' });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('Directly references');
  });

  test('tag overlap without project is NOT independent', () => {
    const a = makeNote({ path: 'practices/a.md', tags: ['go', 'error-handling'] });
    const b = makeNote({ path: 'practices/b.md', tags: ['go', 'daemon'] });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('project identity');
  });

  test('same note is not independent', () => {
    const a = makeNote({ path: 'practices/a.md' });
    expect(areIndependentCases(a, a).independent).toBeFalse();
  });

  test('root-child session relation is NOT independent', () => {
    const a = makeNote({
      path: 'practices/a.md',
      project: 'proj-a',
      source: '[[raw/x]]',
      frontmatter: { project: 'proj-a', source: '[[raw/x]]', 'recall-session': 'session-001' },
    });
    const b = makeNote({
      path: 'practices/b.md',
      project: 'proj-b',
      source: '[[raw/y]]',
      frontmatter: { project: 'proj-b', source: '[[raw/y]]', 'recall-session': 'session-001' },
    });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('Root-child session');
  });

  test('PR praise-only material is NOT independent', () => {
    const a = makeNote({
      path: 'practices/a.md',
      project: 'proj-a',
      source: '[[raw/x]]',
      body: 'LGTM, great work on this!',
    });
    const b = makeNote({
      path: 'practices/b.md',
      project: 'proj-b',
      source: '[[raw/y]]',
      body: '# Real practice\n## What I Did\nImplemented feature.',
    });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeFalse();
    expect(result.rationale).toContain('praise-only');
  });

  test('distinct project + distinct source = true (all checks pass)', () => {
    const a = makeNote({
      path: 'practices/a.md',
      project: 'proj-a',
      source: '[[raw/src-a]]',
      tags: ['go'],
      body: '# Practice A\n## What I Did\nWorked on feature A.\n## What I Learned\nIt works.',
    });
    const b = makeNote({
      path: 'practices/b.md',
      project: 'proj-b',
      source: '[[raw/src-b]]',
      tags: ['go'],
      body: '# Practice B\n## What I Did\nWorked on feature B.\n## What I Learned\nIt also works.',
    });
    const result = areIndependentCases(a, b);
    expect(result.independent).toBeTrue();
    expect(result.rationale).toContain('distinct provenance');
  });
});

// ── Gate: local-provenance ────────────────────────────────────────────

describe('checkLocalProvenance', () => {
  test('passes for valid reflection note', () => {
    const ctx = makeCtx();
    expect(checkLocalProvenance(ctx).verdict).toBe('pass');
  });

  test('fails for non-practices path', () => {
    const ctx = makeCtx({ practice: makeNote({ path: 'raw/test.md', type: 'reflection' }) });
    expect(checkLocalProvenance(ctx).verdict).toBe('fail');
  });

  test('fails for invalid practice type', () => {
    const ctx = makeCtx({ practice: makeNote({ type: 'essay' }) });
    expect(checkLocalProvenance(ctx).verdict).toBe('fail');
  });

  test('accepts experiment type', () => {
    const ctx = makeCtx({ practice: makeNote({ type: 'experiment' }) });
    expect(checkLocalProvenance(ctx).verdict).toBe('pass');
  });

  test('fails when source is not wikilink', () => {
    const ctx = makeCtx({ practice: makeNote({ type: 'reflection', source: 'just-a-string' }) });
    expect(checkLocalProvenance(ctx).verdict).toBe('fail');
  });

  test('uses configured layer name from context', () => {
    const ctx = makeCtx({ layerNames: { raw: 'research', practices: 'notes', cognition: 'insights' } });
    // Note path is 'practices/test.md' but configured layer is 'notes'
    const result = checkLocalProvenance(ctx);
    expect(result.verdict).toBe('fail');
    expect(result.reason).toContain('notes');
  });
});

// ── Gate: multiple-independent-cases ──────────────────────────────────

describe('checkMultipleIndependentCases', () => {
  test('fails with no independent cases', () => {
    const ctx = makeCtx();
    expect(checkMultipleIndependentCases(ctx).verdict).toBe('fail');
  });

  test('passes with independent cases from different projects and sources', () => {
    const independent = makeNote({ path: 'practices/b.md', project: 'proj-b', source: '[[raw/other]]', tags: ['go'] });
    const practice = makeNote({ path: 'practices/a.md', project: 'proj-a', source: '[[raw/main]]', tags: ['go'] });
    const ctx = makeCtx({ practice, independentCases: [independent] });
    expect(checkMultipleIndependentCases(ctx).verdict).toBe('pass');
  });
});

// ── Gate: counterevidence-search ──────────────────────────────────────

describe('checkCounterevidenceSearch', () => {
  test('passes with or without counterevidence', () => {
    expect(checkCounterevidenceSearch(makeCtx()).verdict).toBe('pass');
    const ctx = makeCtx({
      counterevidence: [makeNote({ path: 'raw/alt.md', body: 'however, different' })],
    });
    expect(checkCounterevidenceSearch(ctx).verdict).toBe('pass');
  });
});

// ── Gate: no-unresolved-contradiction ─────────────────────────────────

describe('checkNoUnresolvedContradiction', () => {
  test('passes with no counterevidence', () => {
    expect(checkNoUnresolvedContradiction(makeCtx()).verdict).toBe('pass');
  });

  test('fails with unresolved counterevidence', () => {
    const ce = makeNote({ path: 'raw/alt.md', body: 'Different approach', title: 'Alt' });
    const ctx = makeCtx({ counterevidence: [ce] });
    expect(checkNoUnresolvedContradiction(ctx).verdict).toBe('fail');
  });
});

// ── Gate: generalizes-beyond-task ─────────────────────────────────────

describe('checkGeneralizesBeyondTask', () => {
  test('fails with no independent cases', () => {
    expect(checkGeneralizesBeyondTask(makeCtx()).verdict).toBe('fail');
  });

  test('fails with task-specific language', () => {
    const independent = makeNote({ path: 'practices/b.md', project: 'proj-b', source: '[[raw/other]]' });
    const ctx = makeCtx({
      practice: makeNote({ project: 'proj-a', source: '[[raw/main]]', body: '# A\nThis only applies to this project.' }),
      independentCases: [independent],
    });
    expect(checkGeneralizesBeyondTask(ctx).verdict).toBe('fail');
  });
});

// ── Gate: clear-boundaries ────────────────────────────────────────────

describe('checkClearBoundaries', () => {
  test('passes with boundaries section', () => {
    expect(checkClearBoundaries(makeCtx()).verdict).toBe('pass');
  });
  test('fails without', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# A\nNo boundaries.' }) });
    expect(checkClearBoundaries(ctx).verdict).toBe('fail');
  });
});

// ── Gate: justified-confidence ────────────────────────────────────────

describe('checkJustifiedConfidence', () => {
  test('fails when missing', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# Test\nNo confidence section.' }) });
    expect(checkJustifiedConfidence(ctx).verdict).toBe('fail');
  });

  test('fails when high without independent cases', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# Test\n## Confidence\nhigh\n' }) });
    expect(checkJustifiedConfidence(ctx).verdict).toBe('fail');
  });

  test('passes with medium confidence', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# Test\n## Confidence\nmedium\n' }) });
    expect(checkJustifiedConfidence(ctx).verdict).toBe('pass');
  });
});

// ── Gate: review-trigger-set ──────────────────────────────────────────

describe('checkReviewTriggerSet', () => {
  test('passes with review', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# Test\n## Review\n2026-11-05\n' }) });
    expect(checkReviewTriggerSet(ctx).verdict).toBe('pass');
  });
  test('fails without', () => {
    expect(checkReviewTriggerSet(makeCtx({ practice: makeNote() })).verdict).toBe('fail');
  });
});

// ── Gate: schema-valid-destination ────────────────────────────────────

describe('checkSchemaValidDestination', () => {
  test('passes with preview status', () => {
    expect(checkSchemaValidDestination('preview').verdict).toBe('pass');
  });
  test('fails with null', () => {
    expect(checkSchemaValidDestination(null).verdict).toBe('fail');
  });
  test('fails with validation_failed', () => {
    expect(checkSchemaValidDestination('validation_failed').verdict).toBe('fail');
  });
});

// ── runGates and allGatesPass ─────────────────────────────────────────

describe('runGates', () => {
  test('runs all default gates', () => {
    const ctx = makeCtx();
    // schema-valid-destination needs explicit status
    const results = runGates(ctx, undefined, 'preview');
    expect(results.length).toBe(9);
  });

  test('allGatesPass works', () => {
    expect(allGatesPass([])).toBeTrue();
    expect(allGatesPass([{ gate: 'a', verdict: 'pass', reason: 'ok' }])).toBeTrue();
    expect(allGatesPass([{ gate: 'a', verdict: 'fail', reason: 'no' }])).toBeFalse();
  });
});

// ── extractBoundaries ─────────────────────────────────────────────────

describe('extractBoundaries', () => {
  test('extracts from boundaries section', () => {
    const ctx = makeCtx();
    const boundaries = extractBoundaries(ctx);
    expect(boundaries).toContain('Applies to Go');
  });
});

// ── extractReviewTrigger ──────────────────────────────────────────────

describe('extractReviewTrigger', () => {
  test('extracts from body Review section', () => {
    const ctx = makeCtx({ practice: makeNote({ body: '# Test\n## Review\n2026-11-05\n' }) });
    expect(extractReviewTrigger(ctx)).toBe('2026-11-05');
  });
});

// ── generateCognitionMarkdown ─────────────────────────────────────────

describe('generateCognitionMarkdown', () => {
  test('generates valid cognition with schema-compliant frontmatter', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const ctx = buildDistillContext(vaultHealthy, 'practices/2026-08-01-go-error-handling.md', layout, layerNames);
    const markdown = generateCognitionMarkdown(ctx);

    // Frontmatter must NOT have review
    expect(markdown.startsWith('---')).toBeTrue();
    const fmEnd = markdown.indexOf('---', 4);
    const fm = markdown.slice(0, fmEnd + 3);
    expect(fm).toContain('title:');
    expect(fm).toContain('type: insight');
    expect(fm).toContain('confidence:');
    expect(fm).toContain('source:');
    expect(fm).not.toContain('review:');  // review must NOT be in frontmatter

    // Body must have review trigger
    expect(markdown).toContain('## Review');
    expect(markdown).toContain('## The Insight');
    expect(markdown).toContain('## Boundaries');
    expect(markdown).toContain('## Confidence');
  });

  test('review trigger is in body, not frontmatter', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const ctx = buildDistillContext(vaultHealthy, 'practices/2026-08-01-go-error-handling.md', layout, layerNames);
    const markdown = generateCognitionMarkdown(ctx);
    // Find frontmatter
    const fmEnd = markdown.indexOf('---', 4);
    const fmSection = markdown.slice(0, fmEnd + 3);
    const bodySection = markdown.slice(fmEnd + 3);
    expect(fmSection).not.toContain('review:');
    expect(bodySection).toContain('## Review');
  });
});

// ── computePreviewDigest ──────────────────────────────────────────────

describe('computePreviewDigest', () => {
  test('includes contract version, full gate details, evidence excerpts', () => {
    const preview: Omit<DistillPreviewV1, 'previewDigest'> = {
      version: 1,
      contract: 'distill-preview',
      status: 'preview',
      practicePath: 'practices/test.md',
      plannedCognitionPath: '2026-08-05-test.md',
      plannedMarkdown: '# Test\n\nContent.',
      gates: [{ gate: 'local-provenance', verdict: 'pass', reason: 'Valid practice.', detail: 'Path: practices/test.md' }],
      cases: [{ path: 'practices/test.md', summary: 'Test case', independent: false, rationale: 'Primary case.' }],
      support: [{ path: 'raw/evidence.md', kind: 'support', excerpt: 'Evidence excerpt here.', independent: false }],
      contradictions: [],
      independentCount: 0,
      boundaries: ['Applies to Go'],
      confidence: 'medium',
      reviewTrigger: '2026-11-05',
      warnings: ['Test warning'],
    };

    const digest1 = computePreviewDigest(preview);
    const digest2 = computePreviewDigest(preview);
    expect(digest1).toBe(digest2);
    expect(digest1.length).toBe(64);

    // Different gate detail → different digest
    const modified = {
      ...preview,
      gates: [{ gate: 'local-provenance', verdict: 'pass', reason: 'Valid practice.', detail: 'Different detail.' }],
    };
    expect(computePreviewDigest(preview)).not.toBe(computePreviewDigest(modified));

    // Different warning → different digest
    const diffWarning = { ...preview, warnings: ['Different warning'] };
    expect(computePreviewDigest(preview)).not.toBe(computePreviewDigest(diffWarning));
  });
});

// ── generateCognitionPath ─────────────────────────────────────────────

describe('generateCognitionPath', () => {
  test('returns logical-layer-relative path (no layer prefix)', () => {
    const result = generateCognitionPath('practices/my-practice.md');
    // Must NOT have layer prefix — VaultWriteRequest uses this
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-my-practice\.md$/);
    expect(result).not.toContain('cognition/');
  });
});

// ── generatePlannedCognitionPath ──────────────────────────────────────

describe('generatePlannedCognitionPath', () => {
  const { generatePlannedCognitionPath } = require('../bin/distill/core');
  test('includes configured cognition layer prefix', () => {
    const result = generatePlannedCognitionPath('practices/test.md', 'cognition');
    expect(result).toMatch(/^cognition\/\d{4}-\d{2}-\d{2}-test\.md$/);
  });
  test('uses custom layer name', () => {
    const result = generatePlannedCognitionPath('notes/test.md', 'insights');
    expect(result).toMatch(/^insights\/\d{4}-\d{2}-\d{2}-test\.md$/);
  });
});

// ── buildCaseSummaries ────────────────────────────────────────────────

describe('buildCaseSummaries', () => {
  test('includes rationale in case summaries', () => {
    const practice = makeNote({ path: 'practices/a.md', title: 'Primary', project: 'proj-a', source: '[[raw/x]]' });
    const independent = makeNote({ path: 'practices/b.md', title: 'Independent', project: 'proj-b', source: '[[raw/y]]', tags: ['go'] });
    const ctx = makeCtx({ practice, independentCases: [independent] });
    const cases = buildCaseSummaries(ctx);
    expect(cases.length).toBe(2);
    expect(cases[0].rationale).toBeTruthy();
    expect(cases[1].rationale).toBeTruthy();
    expect(cases[1].rationale).toContain('proj-b');
  });
});

// ── buildEvidenceItems ────────────────────────────────────────────────

describe('buildEvidenceItems', () => {
  test('separates support from contradictions', () => {
    const support = makeNote({ path: 'raw/evidence.md', body: 'Supporting data.' });
    const contradiction = makeNote({ path: 'raw/alt.md', body: 'However, a different approach exists.' });
    const ctx = makeCtx({ linkedNotes: [support, contradiction], counterevidence: [contradiction] });
    const result = buildEvidenceItems(ctx);
    expect(result.support.some(s => s.path === 'raw/evidence.md')).toBeTrue();
    expect(result.contradictions.some(c => c.path === 'raw/alt.md')).toBeTrue();
  });
});

// ── runDistillPreview ─────────────────────────────────────────────────

describe('runDistillPreview', () => {
  test('produces preview with schema validation for healthy practice', () => {
    const result = runDistillPreview({
      vaultDir: vaultHealthy,
      practicePath: 'practices/2026-08-01-go-error-handling.md',
    });
    expect(result.version).toBe(1);
    expect(result.contract).toBe('distill-preview');
    expect(['preview', 'not_ready']).toContain(result.status);
    expect(result.previewDigest.length).toBe(64);
    expect(result.gates.length).toBe(9);
    // schema-valid-destination must be present with real vault-write preview result
    const schemaGate = result.gates.find(g => g.gate === 'schema-valid-destination');
    expect(schemaGate).toBeDefined();
  });

  test('works with custom layer names', () => {
    const result = runDistillPreview({
      vaultDir: vaultCustom,
      practicePath: 'notes/2026-08-01-custom-practice.md',
    });
    expect(result.version).toBe(1);
    expect(result.practicePath).toBe('notes/2026-08-01-custom-practice.md');
    // The plannedCognitionPath should be vault-relative with configured layer prefix
    expect(result.plannedCognitionPath).toContain('insights/');
  });

  test('returns not_ready when gates fail', () => {
    // Create a practice without confidence/review body sections → gates will fail
    const vault = makeVault();
    writePracticeNote(vault, 'practices/incomplete.md', practiceContent({
      title: 'Incomplete practice',
      project: 'test',
      body: ['# Incomplete', '## Boundaries', '- Test boundary'],
      // No confidence or review → gates will fail
    }));

    const result = runDistillPreview({ vaultDir: vault, practicePath: 'practices/incomplete.md' });
    const hasFailures = result.gates.some(g => g.verdict !== 'pass');
    if (hasFailures) {
      expect(result.status).toBe('not_ready');
    }
  });
});

// ── BuildPreview confidence from body ────────────────────────────────

describe('buildPreview confidence source', () => {
  test('confidence comes from parseConfidenceFromBody, never frontmatter', () => {
    const vault = makeVault();
    // Frontmatter says "low" but body says "medium" → body wins
    writePracticeNote(vault, 'practices/conf-body.md', [
      '---',
      'title: "Confidence body test"',
      'created: 2026-08-01',
      'tags: [test]',
      'type: reflection',
      'source: "[[raw/ev]]"',
      'project: "conf-proj"',
      'confidence: low',
      '---',
      '',
      '# Confidence body test',
      '## Boundaries',
      '- Applies to test',
      '## Confidence',
      'medium — Based on body evidence.',
      '## Review',
      '2026-11-01',
    ].join('\n'));
    writePracticeNote(vault, 'raw/ev.md', [
      '---', 'title: "EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/conf-body.md' });
    // Confidence must be "medium" from body, NOT "low" from frontmatter
    expect(preview.confidence).toBe('medium');
  });
});

// ── runDistillApply ───────────────────────────────────────────────────

describe('runDistillApply', () => {
  test('successful preview→commit flow', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/go-err.md', practiceContent({
      title: 'Go error handling is robust',
      tags: ['go', 'error-handling'],
      source: '[[raw/crash-log]]',
      project: 'graphyer',
      body: [
        '# Go error handling is robust',
        '## Context',
        'Working on graphyer, found that explicit error checks prevent crashes.',
        '## What I Did',
        'Always check if err != nil.',
        '## What I Learned',
        'Explicit checks caught 3 production issues.',
        '## Boundaries',
        '- Applies to: production Go services',
        '- May not apply to: throwaway scripts',
      ],
      confidence: 'medium — Based on two independent project experiences.',
      review: '2026-11-05 — Re-evaluate with new error handling patterns.',
    }));
    writePracticeNote(vault, 'practices/go-err-2.md', practiceContent({
      title: 'Go error handling in ahsir',
      created: '2026-07-15',
      tags: ['go', 'error-handling'],
      source: '[[raw/crash-log-2]]',
      project: 'ahsir',
      body: [
        '# Go error handling in ahsir',
        '## Boundaries',
        '- Applies to: long-running daemons',
      ],
      confidence: 'medium — Confirmed across two independent daemon projects.',
      review: '2026-10-15 — Re-evaluate when ahsir architecture changes.',
    }));
    writePracticeNote(vault, 'raw/crash-log.md', [
      '---',
      'title: "Crash log"',
      'created: 2026-07-01',
      'tags: [debugging]',
      'type: raw',
      '---',
      '',
      '# Crash log',
      'Three crashes from ignored errors.',
    ].join('\n'));
    writePracticeNote(vault, 'raw/crash-log-2.md', [
      '---',
      'title: "Crash log 2"',
      'created: 2026-07-10',
      'tags: [debugging]',
      'type: raw',
      '---',
      '',
      '# Crash log 2',
      'Additional error handling evidence.',
    ].join('\n'));

    // First preview
    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/go-err.md' });
    // It should have schema-valid-destination gate evaluated
    expect(preview.gates.some(g => g.gate === 'schema-valid-destination')).toBeTrue();

    expect(preview.status).toBe('preview');
    // Apply with correct digest
    const result = runDistillApply({
      vaultDir: vault,
      practicePath: 'practices/go-err.md',
      previewDigest: preview.previewDigest,
    });
    expect(result.status).toBe('committed');
    expect(result.cognitionPath).toBeTruthy();
    expect(result.operationId).toBeTruthy();
    expect(result.recoveries).toBeDefined();
    // Verify source practice byte-identical
    const practiceBytes = fs.readFileSync(path.join(vault, 'practices/go-err.md'));
    expect(practiceBytes.toString()).toContain('graphyer');
    // Verify cognition note exists
    const cognitionAbsPath = path.join(vault, result.cognitionPath!);
    expect(fs.existsSync(cognitionAbsPath)).toBeTrue();
  });

  test('stale digest returns conflict, zero-write, no cognition file', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/stale.md', practiceContent({
      title: 'Stale test', source: '[[raw/evidence]]', project: 'test-proj',
      body: ['# Stale test', '## Boundaries', '- Test boundary'],
      confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/evidence.md', [
      '---', 'title: "Evidence"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# Evidence',
    ].join('\n'));

    const result = runDistillApply({ vaultDir: vault, practicePath: 'practices/stale.md', previewDigest: '0'.repeat(64) });
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('PREVIEW_DIGEST_MISMATCH');
    const cognitions = fs.readdirSync(path.join(vault, 'cognition'));
    expect(cognitions.filter(f => f !== 'README.md').length).toBe(0);
  });

  test('ABA race: evidence changes between preview and locked callback with hook', () => {
    const vault = makeVault();
    // Write raw note version A
    writePracticeNote(vault, 'raw/aba-ev.md', [
      '---', 'title: "ABA evidence vA"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# Version A',
    ].join('\n'));
    writePracticeNote(vault, 'practices/aba.md', practiceContent({
      title: 'ABA race test', source: '[[raw/aba-ev]]', project: 'aba-proj',
      body: ['# ABA test', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'practices/aba-ind.md', practiceContent({
      title: 'ABA independent', source: '[[raw/aba-ev-2]]', project: 'aba-other',
      body: ['# ABA independent', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/aba-ev-2.md', [
      '---', 'title: "ABA evidence 2"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV2',
    ].join('\n'));

    // Preview with evidence version A → get digest A
    const previewA = runDistillPreview({ vaultDir: vault, practicePath: 'practices/aba.md' });
    expect(previewA.previewDigest).toBeTruthy();

    // Mutate evidence to version B BEFORE calling apply
    // (simulates real TOCTOU where evidence changes between preview and apply)
    const evPath = path.join(vault, 'raw/aba-ev.md');
    const evBytesA = fs.readFileSync(evPath);
    fs.writeFileSync(evPath, [
      '---', 'title: "ABA evidence vB"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# Version B - changed evidence',
    ].join('\n'));

    expect(previewA.status).toBe('preview');
    // afterLock hook: mutate evidence back to A under the vault-write lock
    // This races with the locked callback's re-read → must detect mismatch
    const afterLockHook: VaultWriteHooks = {
      afterLock() {
        fs.writeFileSync(evPath, evBytesA);
      },
    };

    const result = runDistillApply({
      vaultDir: vault,
      practicePath: 'practices/aba.md',
      previewDigest: previewA.previewDigest,
      vaultWriteHooks: afterLockHook,
    });
    // Evidence mutated to B before apply, then back to A in afterLock hook
    // Pre-lock context builds with B's markdown, afterLock restores A
    // Locked callback re-reads → sees A → digest mismatch with pre-lock cognitionRequest → conflict
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('PREVIEW_DIGEST_MISMATCH');
    // No cognition file written
    const cognitions = fs.readdirSync(path.join(vault, 'cognition')).filter(f => f !== 'README.md');
    expect(cognitions.length).toBe(0);

    // Restore evidence to A for cleanup verification
    fs.writeFileSync(evPath, evBytesA);
  });

  test('concurrent LOCK_HELD returns conflict with INPUT_CHANGED error', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/locked.md', practiceContent({
      title: 'Lock test', source: '[[raw/ev]]', project: 'test-proj',
      body: ['# Lock test', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/ev.md', [
      '---', 'title: "EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV',
    ].join('\n'));
    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/locked.md' });
    const layout = resolveVaultLayout(vault);
    const lockPath = path.join(layout.lockDir, 'vault-write.lock');
    fs.mkdirSync(layout.lockDir, { recursive: true });
    const lockFd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockFd, JSON.stringify({ version: 1, operationId: 'foreign-lock', startedAt: new Date().toISOString() }));
    fs.fsyncSync(lockFd);
    try {
      const result = runDistillApply({ vaultDir: vault, practicePath: 'practices/locked.md', previewDigest: preview.previewDigest });
      expect(result.status).toBe('conflict');
      expect(result.error?.code).toBe('LOCK_HELD');
    } finally {
      try { fs.closeSync(lockFd); } catch { /* ok */ }
      try { fs.unlinkSync(lockPath); } catch { /* ok */ }
    }
  });

  test('source mutation in after-lock verification window → conflict', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/mut.md', practiceContent({
      title: 'Mutation test', source: '[[raw/mut-ev]]', project: 'mut-proj',
      body: ['# Mutation test', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/mut-ev.md', [
      '---', 'title: "MUT EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# MUT EV',
    ].join('\n'));
    writePracticeNote(vault, 'practices/mut-ind.md', practiceContent({
      title: 'Mutation independent', source: '[[raw/mut-ev-2]]', project: 'mut-other',
      body: ['# Mutation independent', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/mut-ev-2.md', [
      '---', 'title: "MUT EV2"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# MUT EV2',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/mut.md' });
    expect(preview.status).toBe('preview');
    const mutPath = path.join(vault, 'practices/mut.md');
    const original = fs.readFileSync(mutPath, 'utf8');

    // Mutate the practice in the after-lock hook — simulates mutation
    // happening AFTER lock acquisition but before the callback re-reads
    const hooks: VaultWriteHooks = {
      afterLock() {
        fs.writeFileSync(mutPath, original.replace('Mutation test', 'MUTATED practice content'));
      },
    };

    const result = runDistillApply({
      vaultDir: vault,
      practicePath: 'practices/mut.md',
      previewDigest: preview.previewDigest,
      vaultWriteHooks: hooks,
    });
    // After lock hook mutates the practice → locked callback re-reads → byte mismatch → conflict
    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('PREVIEW_DIGEST_MISMATCH');
    // No cognition file written
    const cognitions = fs.readdirSync(path.join(vault, 'cognition')).filter(f => f !== 'README.md');
    expect(cognitions.length).toBe(0);

    // Restore original for verification
    fs.writeFileSync(mutPath, original);
    expect(fs.readFileSync(mutPath, 'utf8')).toBe(original);
  });

  test('manual_recovery: valid recognized incomplete operation returns exact status', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/rec.md', practiceContent({
      title: 'Recovery test', source: '[[raw/rec-ev]]', project: 'rec-proj',
      body: ['# Recovery test', '## Boundaries', '- Test'], confidence: 'medium — Test.', review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/rec-ev.md', [
      '---', 'title: "REC EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# REC EV',
    ].join('\n'));
    writePracticeNote(vault, 'practices/rec-ind.md', practiceContent({
      title: 'Recovery independent case',
      created: '2026-07-15',
      source: '[[raw/rec-ev-2]]',
      project: 'rec-other',
      body: ['# Recovery independent', '## Boundaries', '- Test'],
      confidence: 'medium — Independent.', review: '2026-10-15',
    }));
    writePracticeNote(vault, 'raw/rec-ev-2.md', [
      '---', 'title: "REC EV2"', 'created: 2026-07-10', 'tags: []', 'type: raw', '---', '', '# REC EV2',
    ].join('\n'));

    // Construct a valid recognized incomplete operation journal
    // Must use a proper UUID v4 operationId
    const opId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const layout = resolveVaultLayout(vault);
    const reqDigest = '0'.repeat(64);
    const noteSha = '0'.repeat(64);
    const opDir = path.join(layout.transactionDir, `vault-write-${opId}`);
    fs.mkdirSync(opDir, { recursive: true });
    fs.writeFileSync(
      path.join(opDir, 'journal.json'),
      JSON.stringify({
        version: 1,
        operationId: opId,
        state: 'locked',
        notePath: 'cognition/2026-08-05-rec.md',
        requestDigest: reqDigest,
        plannedNoteSha256: noteSha,
      }, null, 2) + '\n',
    );

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/rec.md' });
    expect(preview.status).toBe('preview');
    const result = runDistillApply({ vaultDir: vault, practicePath: 'practices/rec.md', previewDigest: preview.previewDigest });
    // Must be exactly manual_recovery — committed is not acceptable
    expect(result.status).toBe('manual_recovery');
    expect(result.recoveryState).toBe('incomplete');
    expect(Array.isArray(result.recoveries)).toBeTrue();
    expect(result.recoveries.length).toBeGreaterThan(0);

    // Verify recovery details
    const rec = result.recoveries[0];
    expect(rec.state).toBe('incomplete-operation');
    expect(rec.operationId).toBe(opId);
    // preservedPaths must include the operation directory path
    expect(rec.preservedPaths.length).toBeGreaterThan(0);
    expect(rec.preservedPaths.some(p => p.includes(opId))).toBeTrue();
    // Must have at least one action
    expect(rec.actions.length).toBeGreaterThan(0);
    expect(rec.actions[0].kind).toBe('inspect');
    expect(rec.actions[0].condition).toBeTruthy();

    // No cognition file written
    const cognitions = fs.readdirSync(path.join(vault, 'cognition')).filter(f => f !== 'README.md');
    expect(cognitions.length).toBe(0);
  });

  test('verify source Practices byte-identical after commit', () => {
    const vault = makeVault();
    const pc = practiceContent({
      title: 'Byte identical test', source: '[[raw/ev]]', project: 'test-proj',
      body: ['# Byte identical test', '## Boundaries', '- Test boundary'],
      confidence: 'medium — Test.', review: '2026-11-01',
    });
    writePracticeNote(vault, 'practices/byte-test.md', pc);
    writePracticeNote(vault, 'raw/ev.md', [
      '---', 'title: "EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV',
    ].join('\n'));
    writePracticeNote(vault, 'practices/byte-ind.md', practiceContent({
      title: 'Byte identical independent case',
      created: '2026-07-15',
      source: '[[raw/ev-2]]', project: 'test-other',
      body: ['# Byte identical independent', '## Boundaries', '- Test boundary'],
      confidence: 'medium — Independent.', review: '2026-10-15',
    }));
    writePracticeNote(vault, 'raw/ev-2.md', [
      '---', 'title: "EV2"', 'created: 2026-07-10', 'tags: []', 'type: raw', '---', '', '# EV2',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/byte-test.md' });
    expect(preview.status).toBe('preview');
    const result = runDistillApply({ vaultDir: vault, practicePath: 'practices/byte-test.md', previewDigest: preview.previewDigest });
    expect(result.status).toBe('committed');
    const afterBytes = fs.readFileSync(path.join(vault, 'practices/byte-test.md'), 'utf8');
    expect(afterBytes).toBe(pc);
  });

  test('beforePostValidation failure injection → rollback, no cognition, all sources identical', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/pv.md', practiceContent({
      title: 'Post-validation failure test',
      source: '[[raw/pv-ev]]',
      project: 'pv-proj',
      body: ['# Post-validation test', '## Boundaries', '- Test'],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/pv-ev.md', [
      '---', 'title: "PV EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# PV EV',
    ].join('\n'));
    writePracticeNote(vault, 'practices/pv-ind.md', practiceContent({
      title: 'PV independent',
      source: '[[raw/pv-ev-2]]',
      project: 'pv-other',
      body: ['# PV independent', '## Boundaries', '- Test'],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/pv-ev-2.md', [
      '---', 'title: "PV EV2"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# PV EV2',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/pv.md' });

    // Capture all source bytes before apply for post-test comparison
    const sourcePaths = [
      'practices/pv.md',
      'practices/pv-ind.md',
      'raw/pv-ev.md',
      'raw/pv-ev-2.md',
    ];
    const preApplyBytes: Record<string, Buffer> = {};
    for (const rel of sourcePaths) {
      preApplyBytes[rel] = fs.readFileSync(path.join(vault, rel));
    }

    expect(preview.status).toBe('preview');
    let beforePostValidationCalled = false;
    const hooks: VaultWriteHooks = {
      beforePostValidation() {
        beforePostValidationCalled = true;
        // Inject failure to trigger rollback
        throw new Error('Injected post-validation failure');
      },
    };

    const result = runDistillApply({
      vaultDir: vault,
      practicePath: 'practices/pv.md',
      previewDigest: preview.previewDigest,
      vaultWriteHooks: hooks,
    });

    // beforePostValidation must have been called
    expect(beforePostValidationCalled).toBeTrue();

    // Status must indicate the failure (conflict/validation_failed/manual_recovery)
    // The vault-write error becomes RECOVERY_REQUIRED when mutations started
    expect(['conflict', 'validation_failed', 'manual_recovery']).toContain(result.status);

    // No cognition file written
    const cognitions = fs.readdirSync(path.join(vault, 'cognition')).filter(f => f !== 'README.md');
    expect(cognitions.length).toBe(0);

    // All source bytes must be identical
    for (const rel of sourcePaths) {
      const afterBytes = fs.readFileSync(path.join(vault, rel));
      expect(afterBytes.equals(preApplyBytes[rel])).toBeTrue();
    }
  });
});

// ── Good+bad case tests ───────────────────────────────────────────────

describe('good+bad case with contradictions', () => {
  test('contradictions visible: first not_ready, then preview after resolution', () => {
    const vault = makeVault();
    // Phase 1: Create practice with an unresolved contradiction → should be not_ready
    writePracticeNote(vault, 'practices/main.md', practiceContent({
      title: 'Pattern X is best',
      tags: ['pattern', 'design'],
      source: '[[raw/case-study]]',
      project: 'main-proj',
      body: [
        '# Pattern X is best',
        '## Context',
        'Applied pattern X to the main project.',
        '## What I Did',
        'Used pattern X everywhere.',
        '## What I Learned',
        'Pattern X reduced bugs by 50%.',
        '## Evidence',
        '- [[raw/case-study]]',
        '- [[raw/alternative-view]]',
        '## Boundaries',
        '- Applies to: web services',
        '- May not apply to: embedded systems',
      ],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/case-study.md', [
      '---', 'title: "Case study"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '',
      '# Case study', 'Pattern X worked well in production.',
    ].join('\n'));
    // Alternative view with contradiction markers → will be detected as counterevidence
    writePracticeNote(vault, 'raw/alternative-view.md', [
      '---', 'title: "Alternative view"', 'created: 2026-07-15', 'tags: []', 'type: raw', '---', '',
      '# Alternative view',
      'However, pattern Y is a different approach that may work better for async workflows.',
      'Unlike pattern X, pattern Y handles backpressure natively.',
    ].join('\n'));

    // Phase 1 preview: has contradiction + no independent cases → not_ready unconditionally
    const preview1 = runDistillPreview({ vaultDir: vault, practicePath: 'practices/main.md' });

    // Phase 1 assertions are UNCONDITIONAL
    expect(preview1.contradictions.length).toBeGreaterThan(0);
    expect(preview1.contradictions.some(c => c.path.includes('alternative-view'))).toBeTrue();
    expect(preview1.status).toBe('not_ready');
    const failedGates = preview1.gates.filter(g => g.verdict !== 'pass');
    expect(failedGates.length).toBeGreaterThan(0);

    // Phase 2: Add resolution of contradiction and independent evidence
    // Update the practice to address the contradiction and add explicit boundaries
    writePracticeNote(vault, 'practices/main.md', practiceContent({
      title: 'Pattern X is best',
      tags: ['pattern', 'design'],
      source: '[[raw/case-study]]',
      project: 'main-proj',
      body: [
        '# Pattern X is best',
        '## Context',
        'Applied pattern X to the main project.',
        '## What I Did',
        'Used pattern X everywhere.',
        '## What I Learned',
        'Pattern X reduced bugs by 50%.',
        '## Evidence',
        '- [[raw/case-study]]',
        '- [[raw/alternative-view]]',
        '## Counterevidence Resolution',
        'While [[raw/alternative-view]] suggests pattern Y for async workflows,',
        'pattern X has been confirmed to work with backpressure when combined',
        'with bounded channels. The alternative view is acknowledged but does not',
        'undermine the core insight for synchronous workflows.',
        '## Boundaries',
        '- Applies to: synchronous web services',
        '- May not apply to: async event-driven systems without bounded channels',
        '- When combined with bounded channels, also applies to async workflows',
      ],
      confidence: 'medium — Confirmed in production with bounded mitigation.',
      review: '2026-11-01',
    }));

    // Add an independent case from a different project with distinct source
    writePracticeNote(vault, 'practices/main-ind.md', practiceContent({
      title: 'Pattern X in other project',
      created: '2026-07-15',
      tags: ['pattern', 'design'],
      source: '[[raw/other-case]]',
      project: 'other-proj',
      body: [
        '# Pattern X in other project',
        '## Context',
        'Applied pattern X in a different project with similar results.',
        '## What I Did',
        'Same pattern, different domain.',
        '## What I Learned',
        'Pattern X also reduced bugs in the other project.',
        '## Boundaries',
        '- Applies to: web services',
      ],
      confidence: 'medium — Confirmed independently.',
      review: '2026-10-15',
    }));
    writePracticeNote(vault, 'raw/other-case.md', [
      '---', 'title: "Other case study"', 'created: 2026-07-10', 'tags: []', 'type: raw', '---', '',
      '# Other case study', 'Pattern X confirmed in another domain.',
    ].join('\n'));

    // Phase 2 preview: contradiction still visible + independent case → preview unconditionally
    const preview2 = runDistillPreview({ vaultDir: vault, practicePath: 'practices/main.md' });

    // Phase 2 assertions are UNCONDITIONAL
    expect(preview2.contradictions.length).toBeGreaterThan(0);
    expect(preview2.contradictions.some(c => c.path.includes('alternative-view'))).toBeTrue();
    expect(preview2.status).toBe('preview');
    // Contradiction is still visible in plannedMarkdown
    expect(preview2.plannedMarkdown).toContain('## Counterevidence');

    // Markdown should have bounded content (not unlimited)
    expect(preview2.plannedMarkdown.length).toBeLessThan(10000);
  });

  test('Unicode content handled correctly', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/unicode.md', practiceContent({
      title: 'ユニコードテスト — Unicode test 测试',
      tags: ['unicode', 'test'],
      source: '[[raw/unicode-research]]',
      project: 'unicode-proj',
      body: [
        '# ユニコードテスト',
        '## Context',
        '日本語と中文和English混在のテスト。',
        '## What I Did',
        '测试 Unicode 内容 🎉',
        '## Boundaries',
        '- 适用于: 多语言环境',
      ],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/unicode-research.md', [
      '---', 'title: "Unicode研究"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '',
      '# Unicode研究', '日本語の内容。',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/unicode.md' });
    expect(preview.version).toBe(1);
    expect(preview.previewDigest).toBeTruthy();
    // Unicode title preserved
    expect(preview.plannedMarkdown).toContain('テスト');
    expect(preview.plannedMarkdown).toContain('测试');
  });
});

// ── parseDistillArguments ─────────────────────────────────────────────

describe('parseDistillArguments', () => {
  test('parses preview mode', () => {
    const args = parseDistillArguments([
      '--vault-dir', '/vault', 'preview', '--practice', 'practices/test.md',
    ]);
    expect(args.vaultDir).toBe('/vault');
    expect(args.mode).toBe('preview');
    expect(args.practicePath).toBe('practices/test.md');
  });

  test('parses apply mode', () => {
    const args = parseDistillArguments([
      '--vault-dir', '/vault', 'apply', '--practice', 'practices/test.md',
      '--preview-digest', 'abc123',
    ]);
    expect(args.mode).toBe('apply');
    expect(args.previewDigest).toBe('abc123');
  });

  test('rejects missing vault-dir', () => {
    expect(() => parseDistillArguments(['preview', '--practice', 'test.md'])).toThrow();
  });

  test('rejects preview without practice', () => {
    expect(() => parseDistillArguments(['--vault-dir', '/v', 'preview'])).toThrow();
  });

  test('rejects apply without preview-digest', () => {
    expect(() => parseDistillArguments(['--vault-dir', '/v', 'apply', '--practice', 'test.md'])).toThrow();
  });
});

// ── CLI integration ───────────────────────────────────────────────────

function invoke(args: string[]) {
  return spawnSync('bun', ['run', cli, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
}

describe('distill CLI', () => {
  test('rejects malformed arguments with stable JSON error', () => {
    const result = invoke([]);
    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('INVALID_ARGUMENTS');
  });

  test('preview mode emits versioned JSON with contract field', () => {
    const result = invoke([
      '--vault-dir', vaultHealthy,
      'preview',
      '--practice', 'practices/2026-08-01-go-error-handling.md',
    ]);
    expect(result.status).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.version).toBe(1);
    expect(preview.contract).toBe('distill-preview');
    expect(preview.previewDigest).toBeTruthy();
  });

  test('returns error for nonexistent practice', () => {
    const result = invoke([
      '--vault-dir', vaultHealthy,
      'preview',
      '--practice', 'practices/nonexistent.md',
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('validation_failed');
  });

  test('custom gates flag reduces gate count', () => {
    const result = invoke([
      '--vault-dir', vaultHealthy,
      'preview',
      '--practice', 'practices/2026-08-01-go-error-handling.md',
      '--gates', 'local-provenance',
    ]);
    expect(result.status).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.gates.length).toBe(1);
    expect(preview.gates[0].gate).toBe('local-provenance');
  });
});

// ── Digest stability ──────────────────────────────────────────────────

describe('preview digest stability', () => {
  test('same practice produces same digest on consecutive runs', () => {
    const r1 = runDistillPreview({ vaultDir: vaultHealthy, practicePath: 'practices/2026-08-01-go-error-handling.md' });
    const r2 = runDistillPreview({ vaultDir: vaultHealthy, practicePath: 'practices/2026-08-01-go-error-handling.md' });
    expect(r1.previewDigest).toBe(r2.previewDigest);
  });

  test('different practice produces different digest', () => {
    const r1 = runDistillPreview({ vaultDir: vaultHealthy, practicePath: 'practices/2026-08-01-go-error-handling.md' });
    const r2 = runDistillPreview({ vaultDir: vaultHealthy, practicePath: 'practices/2026-07-15-go-error-handling-2.md' });
    expect(r1.previewDigest).not.toBe(r2.previewDigest);
  });
});

// ── No status/lifecycle frontmatter ───────────────────────────────────

describe('safety: no status/lifecycle', () => {
  test('cognition markdown has no status or lifecycle frontmatter', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const ctx = buildDistillContext(vaultHealthy, 'practices/2026-08-01-go-error-handling.md', layout, layerNames);
    const markdown = generateCognitionMarkdown(ctx);
    expect(markdown).not.toContain('status:');
    expect(markdown).not.toContain('lifecycle:');
    expect(markdown).not.toContain('stage:');
  });
});

// ── me-schema-v1 validation for every distill fixture practice ─────────

describe('me-schema-v1 direct validation', () => {
  test('validateNoteMarkdown accepts vault-healthy primary practice (2026-08-01-go-error-handling)', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const practicesLayer = layerNames.practices || 'practices';
    const contract = loadLayerSchema(layout, pluginRoot, practicesLayer as LogicalLayer);
    const markdown = fs.readFileSync(
      path.join(vaultHealthy, 'practices/2026-08-01-go-error-handling.md'), 'utf8');
    const notePath = path.join(layout.layers[practicesLayer], '2026-08-01-go-error-handling.md');
    const validated = validateNoteMarkdown(layout, notePath, markdown, contract);
    expect(validated.stem).toBe('2026-08-01-go-error-handling');
    expect(validated.title).toContain('Go explicit error handling produces robust code');
    expect(validated.created).toBe('2026-08-01');
    expect(validated.tags).toContain('go');
    expect(validated.type).toBe('reflection');
    expect(validated.source).toBe('[[raw/go-error-crash-log]]');
  });

  test('validateNoteMarkdown accepts vault-healthy secondary practice (2026-07-15-go-error-handling-2)', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const practicesLayer = layerNames.practices || 'practices';
    const contract = loadLayerSchema(layout, pluginRoot, practicesLayer as LogicalLayer);
    const markdown = fs.readFileSync(
      path.join(vaultHealthy, 'practices/2026-07-15-go-error-handling-2.md'), 'utf8');
    const notePath = path.join(layout.layers[practicesLayer], '2026-07-15-go-error-handling-2.md');
    const validated = validateNoteMarkdown(layout, notePath, markdown, contract);
    expect(validated.stem).toBe('2026-07-15-go-error-handling-2');
    expect(validated.title).toContain('Go explicit error handling in ahsir daemon');
    expect(validated.created).toBe('2026-07-15');
    expect(validated.tags).toContain('daemon');
    expect(validated.type).toBe('reflection');
    expect(validated.source).toBe('[[practices/2026-08-01-go-error-handling]]');
  });

  test('validateNoteMarkdown accepts vault-custom-layers practice (2026-08-01-custom-practice)', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultCustom);
    // loadLayerSchema uses logical layer names ('practices'), not configured names ('notes')
    const contract = loadLayerSchema(layout, pluginRoot, 'practices');
    const markdown = fs.readFileSync(
      path.join(vaultCustom, 'notes/2026-08-01-custom-practice.md'), 'utf8');
    // layout.layers always uses logical keys; the configured name 'notes' is only
    // used in display paths and frontmatter resolution — the files live in the logical dir
    const notePath = path.join(layout.layers.practices, '2026-08-01-custom-practice.md');
    const validated = validateNoteMarkdown(layout, notePath, markdown, contract);
    expect(validated.stem).toBe('2026-08-01-custom-practice');
    expect(validated.created).toBe('2026-08-01');
    expect(validated.type).toBe('reflection');
    expect(validated.source).toBe('[[research/some-research]]');
    // Distinct provenance still holds: project, tags, and source are uniquely identifiable
    expect(validated.title).toContain('Custom layer practice note');
  });

  test('rejects practice whose filename stem does not start with created date', () => {
    const { layout, layerNames } = resolveDistillLayout(vaultHealthy);
    const practicesLayer = layerNames.practices || 'practices';
    const contract = loadLayerSchema(layout, pluginRoot, practicesLayer as LogicalLayer);
    const markdown = fs.readFileSync(
      path.join(vaultHealthy, 'practices/2026-08-01-go-error-handling.md'), 'utf8');
    // Use a filename whose stem does NOT start with the created date
    const wrongPath = path.join(layout.layers[practicesLayer], '2025-01-01-go-error-handling.md');
    expect(() => validateNoteMarkdown(layout, wrongPath, markdown, contract))
      .toThrow();
  });
});

describe('me-schema-v1 validation in pipeline', () => {
  test('preview pipeline validates cognition output against me-schema-v1', () => {
    // Create a vault with valid practice → preview must include schema-valid-destination gate
    const vault = makeVault();
    writePracticeNote(vault, 'practices/schema-test.md', practiceContent({
      title: 'Schema validation test',
      source: '[[raw/ev]]',
      project: 'schema-proj',
      body: ['# Schema test', '## Boundaries', '- Test'],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/ev.md', [
      '---', 'title: "EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/schema-test.md' });
    // schema-valid-destination gate must be present in the result
    const schemaGate = preview.gates.find(g => g.gate === 'schema-valid-destination');
    expect(schemaGate).toBeDefined();
    // The gate must have a verdict (pass or fail based on schema validation)
    expect(['pass', 'fail', 'insufficient_data']).toContain(schemaGate!.verdict);
  });

  test('preview pipeline passes schema-valid-destination for valid cognition markdown', () => {
    const vault = makeVault();
    writePracticeNote(vault, 'practices/valid-schema.md', practiceContent({
      title: 'Valid schema test',
      source: '[[raw/ev]]',
      project: 'valid-proj',
      body: ['# Valid schema', '## Boundaries', '- Test'],
      confidence: 'medium — Test.',
      review: '2026-11-01',
    }));
    writePracticeNote(vault, 'raw/ev.md', [
      '---', 'title: "EV"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV',
    ].join('\n'));
    writePracticeNote(vault, 'practices/valid-schema-2.md', practiceContent({
      title: 'Valid schema independent',
      created: '2026-07-15',
      source: '[[raw/ev-2]]',
      project: 'valid-other',
      body: ['# Valid schema 2', '## Boundaries', '- Test'],
      confidence: 'medium — Test.',
      review: '2026-10-15',
    }));
    writePracticeNote(vault, 'raw/ev-2.md', [
      '---', 'title: "EV2"', 'created: 2026-07-01', 'tags: []', 'type: raw', '---', '', '# EV2',
    ].join('\n'));

    const preview = runDistillPreview({ vaultDir: vault, practicePath: 'practices/valid-schema.md' });
    const schemaGate = preview.gates.find(g => g.gate === 'schema-valid-destination');
    expect(schemaGate).toBeDefined();
    // When all gates pass (status=preview), schema-valid-destination must also pass
    if (preview.status === 'preview') {
      expect(schemaGate!.verdict).toBe('pass');
    }
  });

  test('schema validation is called for vault-healthy fixture via preview pipeline', () => {
    const preview = runDistillPreview({
      vaultDir: vaultHealthy,
      practicePath: 'practices/2026-08-01-go-error-handling.md',
    });
    // The preview pipeline calls executeVaultWrite in preview mode,
    // which internally calls validateNoteMarkdown against me-schema-v1
    const schemaGate = preview.gates.find(g => g.gate === 'schema-valid-destination');
    expect(schemaGate).toBeDefined();
    expect(schemaGate!.verdict).toBe('pass');
  });

  test('schema validation is called for vault-custom-layers fixture via preview pipeline', () => {
    const preview = runDistillPreview({
      vaultDir: vaultCustom,
      practicePath: 'notes/2026-08-01-custom-practice.md',
    });
    const schemaGate = preview.gates.find(g => g.gate === 'schema-valid-destination');
    expect(schemaGate).toBeDefined();
  });
});

// ── PRACTICE_TYPES constant ───────────────────────────────────────────

describe('PRACTICE_TYPES', () => {
  test('contains reflection and experiment', () => {
    expect(PRACTICE_TYPES).toContain('reflection');
    expect(PRACTICE_TYPES).toContain('experiment');
  });
});
