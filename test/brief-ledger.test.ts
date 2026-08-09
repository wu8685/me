import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CLAIM_TYPES,
  countWords,
  findSuperlatives,
  hasAchievedWording,
  hasOutcomeWording,
  validateLedger,
  LedgerInputError,
  type BriefLedgerReportV1,
} from '../bin/brief/ledger';

const pluginRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(pluginRoot, 'bin/brief.ts');
const fixtureDir = path.join(pluginRoot, 'test/fixtures/brief');
const NOW = '2026-08-09T00:00:00.000Z';
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

function runValidate(args: string[], input?: string) {
  return spawnSync('bun', ['run', cli, ...args], {
    input,
    encoding: 'utf8',
  });
}

function validateFixture(name: string): { status: number; report: BriefLedgerReportV1; stdout: string } {
  const result = runValidate(
    ['validate', '--ledger', path.join(fixtureDir, name), '--now', NOW],
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout) as BriefLedgerReportV1;
  expect(report.version).toBe(1);
  expect(report.contract).toBe('brief-ledger');
  return { status: result.status ?? -1, report, stdout: result.stdout };
}

function codes(report: BriefLedgerReportV1): string[] {
  return report.findings.map((finding) => finding.code);
}

function codesFor(report: BriefLedgerReportV1, claimId: string): string[] {
  return report.findings
    .filter((finding) => finding.claimId === claimId)
    .map((finding) => finding.code);
}

// ── CLI contract ───────────────────────────────────────────────────

describe('brief CLI contract', () => {
  test('prints usage and exits 0 for --help', () => {
    const result = runValidate(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: brief validate');
  });

  test('exits 2 without a subcommand', () => {
    const result = runValidate([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage: brief validate');
  });

  test('exits 2 for an unknown flag', () => {
    const result = runValidate(['validate', '--bogus'], '{}');
    expect(result.status).toBe(2);
  });

  test('exits 2 for malformed JSON on stdin', () => {
    const result = runValidate(['validate'], 'not json');
    expect(result.status).toBe(2);
  });

  test('exits 2 for a structurally malformed ledger', () => {
    const result = runValidate(['validate'], JSON.stringify({ version: 2 }));
    expect(result.status).toBe(2);
  });

  test('reads the ledger from stdin', () => {
    const ledger = fs.readFileSync(path.join(fixtureDir, 'ledger-valid.json'), 'utf8');
    const result = runValidate(['validate', '--now', NOW], ledger);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as BriefLedgerReportV1;
    expect(report.status).toBe('ok');
  });
});

// ── Fixture: valid ledger ──────────────────────────────────────────

describe('ledger-valid fixture', () => {
  test('passes with status ok and no findings', () => {
    const { report } = validateFixture('ledger-valid.json');
    expect(report.status).toBe('ok');
    expect(report.findings).toEqual([]);
    expect(report.supersededClaims).toEqual([]);
    expect(report.contradictions).toEqual([]);
  });

  test('word budget is evaluated and within budget', () => {
    const { report } = validateFixture('ledger-valid.json');
    expect(report.wordBudget).not.toBeNull();
    expect(report.wordBudget?.maxWords).toBe(300);
    expect(report.wordBudget?.withinBudget).toBeTrue();
    expect(report.wordBudget?.missingDecisiveClaims).toEqual([]);
  });

  test('stats count claims by type with the full taxonomy', () => {
    const { report } = validateFixture('ledger-valid.json');
    expect(report.stats.claims).toBe(4);
    for (const type of CLAIM_TYPES) {
      expect(Object.keys(report.stats.byType)).toContain(type);
    }
    expect(report.stats.byType.verified_result).toBe(1);
    expect(report.stats.byType.recognition).toBe(1);
  });
});

// ── Fixture: target versus achieved result ─────────────────────────

describe('ledger-target-as-result fixture', () => {
  test('a target worded as an achieved result is an error', () => {
    const { report } = validateFixture('ledger-target-as-result.json');
    expect(report.status).toBe('invalid');
    expect(codesFor(report, 'C1')).toContain('TARGET_WORDED_AS_RESULT');
    const finding = report.findings.find((f) => f.code === 'TARGET_WORDED_AS_RESULT');
    expect(finding?.severity).toBe('error');
  });
});

// ── Fixture: unsupported superlative downgrade ─────────────────────

describe('ledger-superlative fixture', () => {
  test('superlatives are flagged with evidence-safe alternatives', () => {
    const { report } = validateFixture('ledger-superlative.json');
    expect(report.status).toBe('findings');
    expect(codesFor(report, 'C1')).toContain('UNSUPPORTED_SUPERLATIVE');
    const finding = report.findings.find(
      (f) => f.code === 'UNSUPPORTED_SUPERLATIVE' && f.claimId === 'C1',
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.safeAlternative).toBe(
      'The program reached a 91% page-generation success rate, above the 72% June baseline.',
    );
  });

  test('a clean safeWording becomes the effective text', () => {
    const { report } = validateFixture('ledger-superlative.json');
    const claim = report.claims.find((entry) => entry.id === 'C1');
    expect(claim?.flagged).toBeTrue();
    expect(claim?.effectiveText).toContain('91% page-generation success rate');
  });

  test('a safeWording that itself hits the guard is rejected', () => {
    const { report } = validateFixture('ledger-superlative.json');
    expect(codesFor(report, 'C2')).toContain('SAFE_WORDING_UNSUPPORTED');
    const claim = report.claims.find((entry) => entry.id === 'C2');
    expect(claim?.effectiveText).toBe(
      'The rollout was fully completed across the division.',
    );
  });
});

// ── Fixture: stale claim plus later correction ─────────────────────

describe('ledger-stale-correction fixture', () => {
  test('the superseded claim stays visible with its successor', () => {
    const { report } = validateFixture('ledger-stale-correction.json');
    expect(report.supersededClaims).toEqual(['C1']);
    const claim = report.claims.find((entry) => entry.id === 'C1');
    expect(claim?.supersededBy).toBe('C2');
  });

  test('a stale claim is flagged; a superseded claim is not re-flagged', () => {
    const { report } = validateFixture('ledger-stale-correction.json');
    expect(report.status).toBe('findings');
    expect(codesFor(report, 'C3')).toContain('STALE_CLAIM');
    expect(codesFor(report, 'C1')).not.toContain('STALE_CLAIM');
  });
});

// ── Fixture: recognition versus outcome ────────────────────────────

describe('ledger-recognition-vs-outcome fixture', () => {
  test('recognition asserting an outcome is an error', () => {
    const { report } = validateFixture('ledger-recognition-vs-outcome.json');
    expect(report.status).toBe('invalid');
    expect(codesFor(report, 'C4')).toContain('RECOGNITION_AS_OUTCOME');
    expect(codesFor(report, 'C4')).toContain('UNSUPPORTED_SUPERLATIVE');
  });

  test('loss, value, and recognition stay separate and clean', () => {
    const { report } = validateFixture('ledger-recognition-vs-outcome.json');
    for (const id of ['C1', 'C2', 'C3']) {
      expect(codesFor(report, id)).toEqual([]);
    }
  });
});

// ── Fixture: contradictory sources ─────────────────────────────────

describe('ledger-contradictory fixture', () => {
  test('declared contradictions stay visible for both sides', () => {
    const { report } = validateFixture('ledger-contradictory.json');
    expect(report.contradictions).toEqual([{ a: 'C1', b: 'C2' }]);
  });

  test('a dangling contradiction target is an error', () => {
    const { report } = validateFixture('ledger-contradictory.json');
    expect(report.status).toBe('invalid');
    expect(codesFor(report, 'C3')).toContain('CONTRADICTION_TARGET_MISSING');
  });
});

// ── Fixture: metric scope and baseline ─────────────────────────────

describe('ledger-metric-scope fixture', () => {
  test('a missing baseline is a warning, not an error', () => {
    const { report } = validateFixture('ledger-metric-scope.json');
    expect(codesFor(report, 'C1')).toEqual(['METRIC_BASELINE_MISSING']);
    const finding = report.findings.find((f) => f.claimId === 'C1');
    expect(finding?.severity).toBe('warning');
  });

  test('a verified_result without a metric is an error', () => {
    const { report } = validateFixture('ledger-metric-scope.json');
    expect(codesFor(report, 'C2')).toContain('VERIFIED_RESULT_WITHOUT_METRIC');
  });

  test('a metric without unit and an evidence date is flagged', () => {
    const { report } = validateFixture('ledger-metric-scope.json');
    expect(report.status).toBe('invalid');
    expect(codesFor(report, 'C3')).toContain('METRIC_INCOMPLETE');
    expect(codesFor(report, 'C3')).toContain('EVIDENCE_DATE_MISSING');
  });
});

// ── Fixture: word-budget compression ───────────────────────────────

describe('ledger-word-budget fixture', () => {
  test('exceeding the budget is an error with the exact counts', () => {
    const { report } = validateFixture('ledger-word-budget.json');
    expect(report.status).toBe('invalid');
    expect(codes(report)).toContain('WORD_BUDGET_EXCEEDED');
    expect(report.wordBudget?.maxWords).toBe(40);
    expect(report.wordBudget?.words).toBeGreaterThan(40);
    expect(report.wordBudget?.withinBudget).toBeFalse();
  });

  test('decisive claims must survive compression with provenance', () => {
    const { report } = validateFixture('ledger-word-budget.json');
    expect(codes(report)).toContain('DECISIVE_CLAIM_NOT_PRESERVED');
    expect(report.wordBudget?.missingDecisiveClaims).toEqual(['C1']);
    expect(codes(report)).toContain('PROVENANCE_APPENDIX_MISSING');
  });
});

// ── Fixture: authorization gates ───────────────────────────────────

describe('ledger-unauthorized-session fixture', () => {
  test('session evidence without explicit authorization fails closed', () => {
    const { report } = validateFixture('ledger-unauthorized-session.json');
    expect(report.status).toBe('invalid');
    const finding = report.findings.find((f) => f.code === 'SESSION_SOURCE_UNAUTHORIZED');
    expect(finding?.severity).toBe('error');
    expect(finding?.sourceId).toBe('S1');
    expect(report.stats.unauthorizedSources).toBe(1);
  });
});

// ── Fixtures: no evidence and insufficient evidence ────────────────

describe('evidence floor', () => {
  test('an empty claim set is insufficient evidence, not a crash', () => {
    const { report } = validateFixture('ledger-no-evidence.json');
    expect(report.status).toBe('insufficient_evidence');
    expect(codes(report)).toContain('NO_EVIDENCE');
  });

  test('unknown-only claims are insufficient evidence', () => {
    const { report } = validateFixture('ledger-unknown-only.json');
    expect(report.status).toBe('insufficient_evidence');
    expect(codes(report)).toContain('INSUFFICIENT_EVIDENCE');
  });
});

// ── Fixture: unknown output structure ──────────────────────────────

describe('ledger-structure-unknown fixture', () => {
  test('an unrecognized structure is an error', () => {
    const { report } = validateFixture('ledger-structure-unknown.json');
    expect(report.status).toBe('invalid');
    expect(codes(report)).toContain('STRUCTURE_UNKNOWN');
  });
});

// ── Determinism ────────────────────────────────────────────────────

describe('determinism', () => {
  test('the same evidence produces byte-identical reports', () => {
    for (const fixture of ['ledger-valid.json', 'ledger-superlative.json', 'ledger-word-budget.json']) {
      const first = runValidate(['validate', '--ledger', path.join(fixtureDir, fixture), '--now', NOW]);
      const second = runValidate(['validate', '--ledger', path.join(fixtureDir, fixture), '--now', NOW]);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout).toBe(second.stdout);
    }
  });

  test('findings are sorted by code then claim id', () => {
    const { report } = validateFixture('ledger-recognition-vs-outcome.json');
    const keys = report.findings.map((f) => `${f.code}${f.claimId ?? ''}`);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

// ── Zero-write guarantee ───────────────────────────────────────────

describe('zero-write guarantee', () => {
  test('validate leaves the vault and runtime byte-identical', () => {
    const vault = makeTemp('me-brief-vault-');
    const runtime = makeTemp('me-brief-runtime-');
    fs.mkdirSync(path.join(vault, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'raw', 'note.md'), '# note\n');

    const snapshot = (root: string) => {
      const entries: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else entries.push(`${path.relative(root, absolute)}:${fs.readFileSync(absolute).length}`);
        }
      };
      walk(root);
      return entries.sort().join('\n');
    };

    const beforeVault = snapshot(vault);
    const beforeRuntime = snapshot(runtime);
    const ledger = fs.readFileSync(path.join(fixtureDir, 'ledger-valid.json'), 'utf8');
    const result = spawnSync('bun', ['run', cli, 'validate', '--now', NOW], {
      input: ledger,
      encoding: 'utf8',
      cwd: vault,
      env: { ...process.env, ME_RUNTIME_ROOT: runtime },
    });
    expect(result.status).toBe(0);
    expect(snapshot(vault)).toBe(beforeVault);
    expect(snapshot(runtime)).toBe(beforeRuntime);
  });
});

// ── Guard unit tests ───────────────────────────────────────────────

describe('unsupported-language guard', () => {
  test('flags the documented English forms', () => {
    for (const text of [
      'the first tool of its kind',
      'the only supported path',
      'the best success rate',
      'the highest coverage',
      'fully completed rollout',
      'production proven design',
      'organization-wide adoption',
    ]) {
      expect(findSuperlatives(text).length).toBeGreaterThan(0);
    }
  });

  test('flags the documented Chinese forms', () => {
    for (const text of ['最高成功率', '最佳实践', '首个实现', '唯一方案', '全面完成', '生产验证', '全组织推广']) {
      expect(findSuperlatives(text).length).toBeGreaterThan(0);
    }
  });

  test('flags significant improvement only without a metric', () => {
    expect(findSuperlatives('a significant improvement for users').length).toBeGreaterThan(0);
    expect(findSuperlatives('显著提升').length).toBeGreaterThan(0);
  });

  test('leaves calibrated wording alone', () => {
    for (const text of [
      'a 91% success rate, above the 72% baseline',
      'success rate above the internal baseline of 85%',
      '完成率从 72% 上升到 91%',
      'well positioned for the next rollout',
    ]) {
      expect(findSuperlatives(text)).toEqual([]);
    }
  });

  test('detects achieved-result wording for targets', () => {
    expect(hasAchievedWording('we achieved the goal')).toBeTrue();
    expect(hasAchievedWording('已达成 99% 的目标')).toBeTrue();
    expect(hasAchievedWording('交付了第一版')).toBeTrue();
    expect(hasAchievedWording('reach 99% success rate by Q4')).toBeFalse();
    expect(hasAchievedWording('目标是在第四季度达到 99%')).toBeFalse();
  });

  test('detects outcome wording for recognition', () => {
    expect(hasOutcomeWording('the award proves the design works')).toBeTrue();
    expect(hasOutcomeWording('证明了方案可行')).toBeTrue();
    expect(hasOutcomeWording('the team received a commendation')).toBeFalse();
  });
});

describe('countWords', () => {
  test('counts latin tokens and CJK characters', () => {
    expect(countWords('hello world')).toBe(2);
    expect(countWords('完成率上升')).toBe(5);
    expect(countWords('完成率 reached 91%')).toBe(5);
    expect(countWords('')).toBe(0);
  });
});

// ── validateLedger unit behavior ───────────────────────────────────

describe('validateLedger', () => {
  test('rejects a non-ledger input', () => {
    expect(() => validateLedger(null, new Date(NOW))).toThrow(LedgerInputError);
    expect(() => validateLedger({ version: 1, contract: 'other' }, new Date(NOW))).toThrow(LedgerInputError);
    expect(() => validateLedger({ version: 2, contract: 'claim-ledger' }, new Date(NOW))).toThrow(LedgerInputError);
  });

  test('a ledger without a topic is malformed', () => {
    const ledger = {
      version: 1,
      contract: 'claim-ledger',
      brief: {},
      sources: [],
      claims: [],
    };
    expect(() => validateLedger(ledger, new Date(NOW))).toThrow(LedgerInputError);
  });

  test('duplicate claim ids are an error finding', () => {
    const ledger = {
      version: 1,
      contract: 'claim-ledger',
      brief: { topic: 'dup' },
      sources: [{ id: 'S1', kind: 'vault', ref: 'raw/a.md' }],
      claims: [
        { id: 'C1', text: 'one', type: 'fact', sources: ['S1'], confidence: 'low' },
        { id: 'C1', text: 'two', type: 'fact', sources: ['S1'], confidence: 'low' },
      ],
    };
    const report = validateLedger(ledger, new Date(NOW));
    expect(report.status).toBe('invalid');
    expect(report.findings.some((f) => f.code === 'CLAIM_ID_DUPLICATE')).toBeTrue();
  });

  test('a claim referencing an undeclared source is an error', () => {
    const ledger = {
      version: 1,
      contract: 'claim-ledger',
      brief: { topic: 'dangling source' },
      sources: [],
      claims: [{ id: 'C1', text: 'claim', type: 'fact', sources: ['S9'], confidence: 'low' }],
    };
    const report = validateLedger(ledger, new Date(NOW));
    expect(report.status).toBe('invalid');
    expect(report.findings.some((f) => f.code === 'SOURCE_UNKNOWN' && f.claimId === 'C1')).toBeTrue();
  });

  test('a correction without a supersession target is an error', () => {
    const ledger = {
      version: 1,
      contract: 'claim-ledger',
      brief: { topic: 'correction' },
      sources: [{ id: 'S1', kind: 'vault', ref: 'raw/a.md' }],
      claims: [
        { id: 'C1', text: '更正：之前的说法不对', type: 'correction', sources: ['S1'], confidence: 'medium' },
      ],
    };
    const report = validateLedger(ledger, new Date(NOW));
    expect(report.status).toBe('invalid');
    expect(report.findings.some((f) => f.code === 'CORRECTION_WITHOUT_TARGET')).toBeTrue();
  });

  test('significant improvement with a metric and baseline is allowed', () => {
    const ledger = {
      version: 1,
      contract: 'claim-ledger',
      brief: { topic: 'metric' },
      sources: [{ id: 'S1', kind: 'vault', ref: 'raw/a.md' }],
      claims: [
        {
          id: 'C1',
          text: 'a significant improvement in render time',
          type: 'verified_result',
          sources: ['S1'],
          evidenceDate: '2026-08-01',
          confidence: 'high',
          metric: { value: 820, unit: 'ms', scope: '200 renders', baseline: '1200 ms' },
        },
      ],
    };
    const report = validateLedger(ledger, new Date(NOW));
    expect(report.status).toBe('ok');
  });
});
