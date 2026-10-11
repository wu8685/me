import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KNOWLEDGE_TYPE_LAYER,
  ROUTING_PRECEDENCE,
  analyzeNoteRouting,
  classifyKnowledgeType,
  decideLayer,
  deterministicFindings,
  loadAdvisorySuppressions,
  parseLooseNote,
  semanticAdvisories,
  suppressAdvisories,
} from '../bin/vault-write/routing';

function fields(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

const RAW_FIELDS = {
  title: 'Example Note',
  created: '2026-01-10',
  tags: '[example]',
  type: 'article',
  source: 'https://example.com/article',
};

describe('routing precedence contract', () => {
  test('semantic knowledge type outranks directory convention', () => {
    expect(ROUTING_PRECEDENCE).toEqual([
      'semantic knowledge type',
      'layer schema constraints',
      'existing directory convention',
    ]);
  });

  test('external source material decides raw', () => {
    const decision = decideLayer('external-source');
    expect(decision.layer).toBe('raw');
    expect(decision.explanation).toContain('raw');
  });

  test('subjective decision record decides practices', () => {
    expect(decideLayer('practice-record').layer).toBe('practices');
    expect(KNOWLEDGE_TYPE_LAYER['practice-record']).toBe('practices');
  });

  test('stable insight decides cognition (distill-gated)', () => {
    expect(decideLayer('distilled-insight').layer).toBe('cognition');
  });

  test('decision ignores misleading legacy neighbors', () => {
    // A legacy decision record wrongly filed under raw/ must not influence
    // the routing of a new decision record: the decision depends only on the
    // declared/classified knowledge type.
    const withLegacyNeighbor = decideLayer('practice-record');
    expect(withLegacyNeighbor.layer).toBe('practices');
    expect(withLegacyNeighbor.precedence[0]).toBe('semantic knowledge type');
  });
});

describe('classifyKnowledgeType', () => {
  test('external article with URL source classifies as external-source', () => {
    const result = classifyKnowledgeType(
      fields(RAW_FIELDS),
      'A faithful summary of the referenced article with quoted opinions from the author.',
    );
    expect(result.knowledgeType).toBe('external-source');
    expect(result.mixedSourceAndJudgment).toBeFalse();
  });

  test('subjective decision record classifies as practice-record', () => {
    const result = classifyKnowledgeType(
      fields({ ...RAW_FIELDS, type: 'reflection', source: '[[raw/2026-01-01-example]]' }),
      'We decided to adopt option B. The trade-off is documented here, with a follow-up experiment planned.',
    );
    expect(result.knowledgeType).toBe('practice-record');
  });

  test('URL source plus judgment markers is flagged as mixed content', () => {
    const result = classifyKnowledgeType(
      fields(RAW_FIELDS),
      'The article argues for X. We decided otherwise; recommend a follow-up.',
    );
    expect(result.knowledgeType).toBe('practice-record');
    expect(result.mixedSourceAndJudgment).toBeTrue();
  });

  test('insight type classifies as distilled-insight', () => {
    const result = classifyKnowledgeType(
      fields({ ...RAW_FIELDS, type: 'insight', source: '[[practices/2026-01-02-example]]' }),
      'A stable reusable insight.',
    );
    expect(result.knowledgeType).toBe('distilled-insight');
  });
});

describe('parseLooseNote', () => {
  test('parses frontmatter and body', () => {
    const note = parseLooseNote('---\ntitle: T\ntype: article\n---\nbody text\n');
    expect(note).not.toBeNull();
    expect(note?.fields.get('title')).toBe('T');
    expect(note?.body).toContain('body text');
  });

  test('returns null without a frontmatter block', () => {
    expect(parseLooseNote('no frontmatter here')).toBeNull();
  });
});

describe('deterministicFindings', () => {
  test('valid raw note has no errors', () => {
    expect(deterministicFindings('raw', fields(RAW_FIELDS))).toEqual([]);
  });

  test('raw note with internal provenance URI fails', () => {
    const findings = deterministicFindings('raw', fields({ ...RAW_FIELDS, source: 'me://vault/raw/2026-01-01-old' }));
    expect(findings.map(f => f.code)).toContain('ROUTING_RAW_SOURCE_NOT_URL');
  });

  test('raw note with malformed URL fails', () => {
    for (const source of ['not-a-url', 'htp://example.com', '[[raw/2026-01-01-x]]']) {
      const findings = deterministicFindings('raw', fields({ ...RAW_FIELDS, source }));
      expect(findings.map(f => f.code)).toContain('ROUTING_RAW_SOURCE_NOT_URL');
    }
  });

  test('practices-only field under raw is rejected', () => {
    const findings = deterministicFindings('raw', fields({ ...RAW_FIELDS, project: 'demo' }));
    expect(findings.map(f => f.code)).toContain('ROUTING_FIELD_NOT_ALLOWED');
  });

  test('missing required per-layer field is reported', () => {
    const { source: _drop, ...rest } = RAW_FIELDS;
    const findings = deterministicFindings('raw', fields(rest));
    expect(findings.map(f => f.code)).toContain('ROUTING_MISSING_REQUIRED_FIELD');
  });

  test('cognition note missing confidence is reported', () => {
    const findings = deterministicFindings('cognition', fields({
      title: 'I', created: '2026-01-10', tags: '[x]', type: 'insight',
      source: '[[practices/2026-01-02-example]]',
    }));
    const missing = findings.find(f => f.code === 'ROUTING_MISSING_REQUIRED_FIELD');
    expect(missing?.details?.field).toBe('confidence');
  });

  test('layer-invalid controlled type value is rejected', () => {
    const findings = deterministicFindings('raw', fields({ ...RAW_FIELDS, type: 'experiment' }));
    const invalid = findings.find(f => f.code === 'ROUTING_TYPE_INVALID_FOR_LAYER');
    expect(invalid).toBeDefined();
    expect(invalid?.details?.type).toBe('experiment');
  });

  test('practices source must be a wikilink reference', () => {
    const findings = deterministicFindings('practices', fields({
      title: 'P', created: '2026-01-10', tags: '[x]', type: 'experiment',
      source: 'https://example.com/x',
    }));
    expect(findings.map(f => f.code)).toContain('ROUTING_PROVENANCE_NOT_REFERENCE');
  });

  test('forbidden fields are rejected in every layer', () => {
    const findings = deterministicFindings('raw', fields({ ...RAW_FIELDS, lifecycle: 'digest' }));
    expect(findings.map(f => f.code)).toContain('ROUTING_FORBIDDEN_FIELD');
  });
});

describe('semanticAdvisories', () => {
  const decisionBody = [
    'We decided to adopt option B after comparing both candidates.',
    'The trade-off is acceptable, and we recommend a follow-up experiment.',
    'In my opinion the risk is low; next step is validation.',
  ].join('\n');

  test('raw note dominated by judgment raises advisory with evidence', () => {
    const advisories = semanticAdvisories('raw', fields(RAW_FIELDS), decisionBody);
    const advisory = advisories.find(a => a.code === 'ROUTING_RAW_LIKE_PRACTICE');
    expect(advisory).toBeDefined();
    expect(advisory?.severity).toBe('advisory');
    expect(advisory?.heuristic).toBeTrue();
    expect(advisory?.evidence.length).toBeGreaterThan(0);
  });

  test('external article with quoted opinions stays quiet in raw', () => {
    const body = 'The author recommends caution. '.repeat(40);
    const advisories = semanticAdvisories('raw', fields(RAW_FIELDS), body);
    expect(advisories.find(a => a.code === 'ROUTING_RAW_LIKE_PRACTICE')).toBeUndefined();
  });

  test('practices note that looks like an unmodified article raises advisory', () => {
    const body = [
      'See https://example.com/a and https://example.com/b for the full text.',
      'The report covers the topic in detail without any local commentary.',
      'Additional context is available at https://example.com/c .',
      'x'.repeat(500),
    ].join('\n');
    const advisories = semanticAdvisories('practices', fields({
      title: 'P', created: '2026-01-10', tags: '[x]', type: 'experiment',
      source: '[[raw/2026-01-01-example]]',
    }), body);
    expect(advisories.map(a => a.code)).toContain('ROUTING_PRACTICES_LIKE_RAW');
  });

  test('cognition note dominated by a single unverified event raises advisory', () => {
    const advisories = semanticAdvisories('cognition', fields({
      title: 'I', created: '2026-01-10', tags: '[x]', type: 'insight',
      source: '[[practices/2026-01-02-example]]', confidence: 'low',
    }), 'This was only observed in one experiment; a single incident motivated it.');
    expect(advisories.map(a => a.code)).toContain('ROUTING_COGNITION_SINGLE_EVENT');
  });

  test('well-linked cognition insight stays quiet', () => {
    const advisories = semanticAdvisories('cognition', fields({
      title: 'I', created: '2026-01-10', tags: '[x]', type: 'insight',
      source: '[[practices/2026-01-02-example]]', confidence: 'high',
    }), 'Confirmed by [[practices/2026-01-02-a]] and [[practices/2026-01-03-b]].');
    expect(advisories.find(a => a.code === 'ROUTING_COGNITION_SINGLE_EVENT')).toBeUndefined();
  });
});

describe('analyzeNoteRouting', () => {
  test('unparseable note yields a frontmatter error', () => {
    const result = analyzeNoteRouting('raw', 'no frontmatter');
    expect(result.note).toBeNull();
    expect(result.errors.map(f => f.code)).toContain('ROUTING_FRONTMATTER_INVALID');
  });
});

describe('advisory suppression', () => {
  test('matching code+path suppresses only that advisory', () => {
    const advisories = semanticAdvisories('raw', fields(RAW_FIELDS), 'We decided X. Recommend Y.');
    expect(advisories.length).toBeGreaterThan(0);
    const { kept, suppressed } = suppressAdvisories(
      advisories,
      [{ code: 'ROUTING_RAW_LIKE_PRACTICE', path: 'raw/2026-01-10-example.md' }],
      'raw/2026-01-10-example.md',
    );
    expect(suppressed.length).toBe(advisories.length);
    expect(kept).toEqual([]);
  });

  test('suppression for a different path keeps the advisory', () => {
    const advisories = semanticAdvisories('raw', fields(RAW_FIELDS), 'We decided X. Recommend Y.');
    const { kept } = suppressAdvisories(
      advisories,
      [{ code: 'ROUTING_RAW_LIKE_PRACTICE', path: 'raw/other.md' }],
      'raw/2026-01-10-example.md',
    );
    expect(kept.length).toBe(advisories.length);
  });

  test('deterministic errors are never suppressible', () => {
    const errors = deterministicFindings('raw', fields({ ...RAW_FIELDS, source: 'me://internal' }));
    const { kept } = suppressAdvisories(
      errors,
      [{ code: 'ROUTING_RAW_SOURCE_NOT_URL' }],
      'raw/x.md',
    );
    expect(kept.length).toBe(errors.length);
  });

  test('loadAdvisorySuppressions reads a valid file and rejects unknown codes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-routing-suppress-'));
    try {
      fs.mkdirSync(path.join(dir, '.me'));
      fs.writeFileSync(path.join(dir, '.me', 'doctor-suppressions.json'), JSON.stringify({
        version: 1,
        suppress: [
          { code: 'ROUTING_RAW_LIKE_PRACTICE', path: 'raw/a.md' },
          { code: 'NOT_A_CODE' },
        ],
      }));
      const { suppressions, error } = loadAdvisorySuppressions(dir);
      expect(error).toBeNull();
      expect(suppressions).toEqual([{ code: 'ROUTING_RAW_LIKE_PRACTICE', path: 'raw/a.md' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadAdvisorySuppressions reports malformed file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-routing-suppress-'));
    try {
      fs.mkdirSync(path.join(dir, '.me'));
      fs.writeFileSync(path.join(dir, '.me', 'doctor-suppressions.json'), '{not json');
      const { error } = loadAdvisorySuppressions(dir);
      expect(error).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadAdvisorySuppressions is absent-tolerant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-routing-suppress-'));
    try {
      const { suppressions, error } = loadAdvisorySuppressions(dir);
      expect(suppressions).toEqual([]);
      expect(error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
