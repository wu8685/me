/**
 * me:brief — deterministic claim ledger validation (contract v1).
 *
 * Pure and deterministic: the same ledger plus the same `now` always produce
 * the same report, on any Agent surface. No clock, filesystem, or network
 * access happens inside this module; the caller supplies `now`.
 */

import {
  BRIEF_STRUCTURES,
  CLAIM_TYPES,
  SOURCE_KINDS,
  type BriefFinding,
  type BriefLedgerReportV1,
  type ClaimType,
} from './contracts';

export {
  BRIEF_STRUCTURES,
  CLAIM_TYPES,
  SOURCE_KINDS,
} from './contracts';
export type {
  BriefFinding,
  BriefLedgerReportV1,
  BriefLedgerStatus,
  BriefWordBudget,
  ClaimType,
} from './contracts';

export class LedgerInputError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Language guards ────────────────────────────────────────────────

interface GuardPattern {
  re: RegExp;
  label: string;
  /** Skipped when the claim carries a metric with value and baseline. */
  metricAware?: boolean;
}

const SUPERLATIVE_PATTERNS: GuardPattern[] = [
  { re: /\bfirst\b/i, label: 'first' },
  { re: /\bonly\b/i, label: 'only' },
  { re: /\bbest\b/i, label: 'best' },
  { re: /\bhighest\b/i, label: 'highest' },
  { re: /fully completed/i, label: 'fully completed' },
  { re: /production[- ]proven/i, label: 'production proven' },
  { re: /(?:organization|org)-wide/i, label: 'organization-wide' },
  { re: /significant(?:ly)? improv/i, label: 'significant improvement', metricAware: true },
  { re: /最高/, label: '最高' },
  { re: /最佳|最好/, label: '最佳' },
  { re: /首个|首次/, label: '首个' },
  { re: /唯一/, label: '唯一' },
  { re: /全面完成/, label: '全面完成' },
  { re: /生产验证/, label: '生产验证' },
  { re: /全组织/, label: '全组织' },
  { re: /显著提升/, label: '显著提升', metricAware: true },
];

const ACHIEVED_RE =
  /\bachieved\b|\bcompleted\b|\bdelivered\b|\bshipped\b|已完成|已达成|实现了|交付了/i;

const OUTCOME_RE = /\bprove[sd]?\b|\bvalidates?\b|\bdemonstrates?\b|证明|验证/i;

/** Deterministic unsupported-language scan; returns matched labels in pattern order. */
export function findSuperlatives(text: string, options?: { hasMetric?: boolean }): string[] {
  const labels: string[] = [];
  for (const pattern of SUPERLATIVE_PATTERNS) {
    if (pattern.metricAware && options?.hasMetric) continue;
    if (pattern.re.test(text)) labels.push(pattern.label);
  }
  return labels;
}

/** Wording that presents an outcome as already achieved. */
export function hasAchievedWording(text: string): boolean {
  return ACHIEVED_RE.test(text);
}

/** Wording that asserts technical validity or outcome inside recognition. */
export function hasOutcomeWording(text: string): boolean {
  return OUTCOME_RE.test(text);
}

/** CJK characters count as one word each; latin runs count per whitespace token. */
export function countWords(text: string): number {
  const cjkRe = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const cjk = text.match(cjkRe);
  const latin = text
    .replace(cjkRe, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return (cjk?.length ?? 0) + latin.length;
}

// ── Input narrowing ────────────────────────────────────────────────

interface RawMetric {
  value?: unknown;
  unit?: unknown;
  scope?: unknown;
  baseline?: unknown;
}

interface RawClaim {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  sources?: unknown;
  evidenceDate?: unknown;
  confidence?: unknown;
  supersedes?: unknown;
  contradicts?: unknown;
  decisive?: unknown;
  safeWording?: unknown;
  metric?: unknown;
}

interface RawSource {
  id?: unknown;
  kind?: unknown;
  ref?: unknown;
  authorized?: unknown;
  date?: unknown;
}

interface RawLedger {
  version?: unknown;
  contract?: unknown;
  brief?: unknown;
  sources?: unknown;
  claims?: unknown;
  briefText?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseDate(value: string): Date | null {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencesId(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`).test(text);
}

// ── Validation ─────────────────────────────────────────────────────

export function validateLedger(input: unknown, now: Date): BriefLedgerReportV1 {
  const ledger = input as RawLedger;
  if (!isObject(input)) throw new LedgerInputError('ledger must be a JSON object');
  if (ledger.version !== 1) throw new LedgerInputError('ledger version must be 1');
  if (ledger.contract !== 'claim-ledger') {
    throw new LedgerInputError('ledger contract must be "claim-ledger"');
  }
  if (!isObject(ledger.brief) || !nonEmptyString(ledger.brief.topic)) {
    throw new LedgerInputError('ledger brief.topic is required');
  }
  if (!Array.isArray(ledger.sources)) throw new LedgerInputError('ledger sources must be an array');
  if (!Array.isArray(ledger.claims)) throw new LedgerInputError('ledger claims must be an array');

  const brief = ledger.brief as {
    topic: string;
    structure?: unknown;
    maxWords?: unknown;
    freshnessDays?: unknown;
  };
  const briefText = typeof ledger.briefText === 'string' ? ledger.briefText : null;
  const maxWords = typeof brief.maxWords === 'number' ? brief.maxWords : null;
  const freshnessDays = typeof brief.freshnessDays === 'number' ? brief.freshnessDays : null;

  const findings: BriefFinding[] = [];
  const add = (
    code: string,
    severity: BriefFinding['severity'],
    message: string,
    extra?: { claimId?: string; sourceId?: string; safeAlternative?: string },
  ): void => {
    findings.push({
      code,
      severity,
      claimId: extra?.claimId ?? null,
      sourceId: extra?.sourceId ?? null,
      message,
      safeAlternative: extra?.safeAlternative ?? null,
    });
  };

  // Brief structure
  const structure = typeof brief.structure === 'string' ? brief.structure : null;
  if (structure !== null && !(BRIEF_STRUCTURES as readonly string[]).includes(structure)) {
    add(
      'STRUCTURE_UNKNOWN',
      'error',
      `brief structure "${structure}" is not one of: ${BRIEF_STRUCTURES.join(', ')}`,
    );
  }

  // Sources
  const sourceIds = new Set<string>();
  let unauthorizedSources = 0;
  for (const raw of ledger.sources as RawSource[]) {
    if (!isObject(raw) || !nonEmptyString(raw.id) || !nonEmptyString(raw.ref)) {
      add('SOURCE_FIELD_MISSING', 'error', 'source requires a non-empty id and ref');
      continue;
    }
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    if (!(SOURCE_KINDS as readonly string[]).includes(kind)) {
      add('SOURCE_FIELD_MISSING', 'error', `source ${raw.id} has unknown kind "${kind}"`, {
        sourceId: raw.id,
      });
      continue;
    }
    sourceIds.add(raw.id);
    if (kind === 'session' && raw.authorized !== true) {
      unauthorizedSources += 1;
      add(
        'SESSION_SOURCE_UNAUTHORIZED',
        'error',
        `session source ${raw.id} requires explicit authorization (authorized: true); failing closed`,
        { sourceId: raw.id },
      );
    }
  }

  // Claims
  const claims = ledger.claims as RawClaim[];
  const seenIds = new Set<string>();
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (!isObject(claim) || !nonEmptyString(claim.id)) {
      add('CLAIM_FIELD_MISSING', 'error', 'claim requires a non-empty id');
      continue;
    }
    if (seenIds.has(claim.id)) {
      add('CLAIM_ID_DUPLICATE', 'error', `duplicate claim id ${claim.id}`, { claimId: claim.id });
      continue;
    }
    seenIds.add(claim.id);
    claimIds.add(claim.id);
  }

  const supersededBy = new Map<string, string>();
  const effectiveText = new Map<string, string>();
  const byType = Object.fromEntries(CLAIM_TYPES.map((type) => [type, 0])) as Record<ClaimType, number>;
  const typedClaims: Array<RawClaim & { id: string; text: string; type: string }> = [];
  const processedIds = new Set<string>();

  for (const claim of claims) {
    if (!isObject(claim) || !nonEmptyString(claim.id)) continue; // already flagged above
    if (processedIds.has(claim.id)) continue; // duplicate already flagged above
    processedIds.add(claim.id);
    const id = claim.id;

    if (!nonEmptyString(claim.text)) {
      add('CLAIM_FIELD_MISSING', 'error', `claim ${id} requires non-empty text`, { claimId: id });
      continue;
    }
    const type = typeof claim.type === 'string' ? claim.type : '';
    if (!(CLAIM_TYPES as readonly string[]).includes(type)) {
      add('CLAIM_FIELD_MISSING', 'error', `claim ${id} has unknown type "${type}"`, { claimId: id });
      continue;
    }
    typedClaims.push(claim as RawClaim & { id: string; text: string; type: string });
    byType[type as ClaimType] += 1;

    const text = claim.text;
    const claimSources = Array.isArray(claim.sources)
      ? claim.sources.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (type !== 'unknown' && claimSources.length === 0) {
      add('SOURCE_MISSING', 'error', `claim ${id} names no evidence source`, { claimId: id });
    }
    for (const sourceId of claimSources) {
      if (!sourceIds.has(sourceId)) {
        add('SOURCE_UNKNOWN', 'error', `claim ${id} references undeclared source ${sourceId}`, {
          claimId: id,
        });
      }
    }
    if (!nonEmptyString(claim.confidence)) {
      add('CONFIDENCE_MISSING', 'warning', `claim ${id} carries no confidence`, { claimId: id });
    }

    const metric = isObject(claim.metric) ? (claim.metric as RawMetric) : null;
    const hasMetric =
      metric !== null &&
      metric.value !== undefined &&
      metric.value !== null &&
      metric.baseline !== undefined &&
      metric.baseline !== null;

    if (type === 'target' && hasAchievedWording(text)) {
      add(
        'TARGET_WORDED_AS_RESULT',
        'error',
        `claim ${id} is a target but uses achieved-result wording; targets and verified results cannot be merged`,
        { claimId: id, safeAlternative: nonEmptyString(claim.safeWording) ? claim.safeWording : undefined },
      );
    }

    if (type === 'verified_result') {
      if (metric === null) {
        add(
          'VERIFIED_RESULT_WITHOUT_METRIC',
          'error',
          `verified_result ${id} carries no metric; quantitative claims need value, unit, scope, baseline, and evidence date`,
          { claimId: id },
        );
      } else {
        const missing = (['value', 'unit', 'scope'] as const).filter(
          (field) => metric[field] === undefined || metric[field] === null || metric[field] === '',
        );
        if (missing.length > 0) {
          add(
            'METRIC_INCOMPLETE',
            'error',
            `verified_result ${id} metric is missing: ${missing.join(', ')}`,
            { claimId: id },
          );
        }
        if (metric.baseline === undefined || metric.baseline === null || metric.baseline === '') {
          add('METRIC_BASELINE_MISSING', 'warning', `verified_result ${id} metric has no baseline`, {
            claimId: id,
          });
        }
      }
      if (!nonEmptyString(claim.evidenceDate)) {
        add('EVIDENCE_DATE_MISSING', 'warning', `verified_result ${id} has no evidence date`, {
          claimId: id,
        });
      }
    }

    const superlatives = findSuperlatives(text, { hasMetric });
    if (superlatives.length > 0) {
      add(
        'UNSUPPORTED_SUPERLATIVE',
        'warning',
        `claim ${id} uses unsupported wording (${superlatives.join(', ')}); rewrite conservatively`,
        { claimId: id, safeAlternative: nonEmptyString(claim.safeWording) ? claim.safeWording : undefined },
      );
    }

    let effective = text;
    if (nonEmptyString(claim.safeWording)) {
      const safeHits = findSuperlatives(claim.safeWording, { hasMetric });
      if (safeHits.length > 0) {
        add(
          'SAFE_WORDING_UNSUPPORTED',
          'warning',
          `claim ${id} safe wording still uses unsupported wording (${safeHits.join(', ')})`,
          { claimId: id },
        );
      } else if (superlatives.length > 0) {
        effective = claim.safeWording;
      }
    }
    effectiveText.set(id, effective);

    if (type === 'recognition' && hasOutcomeWording(text)) {
      add(
        'RECOGNITION_AS_OUTCOME',
        'error',
        `recognition ${id} asserts an outcome or technical validity; recognition does not imply either`,
        { claimId: id, safeAlternative: nonEmptyString(claim.safeWording) ? claim.safeWording : undefined },
      );
    }

    if (type === 'correction') {
      if (!nonEmptyString(claim.supersedes)) {
        add(
          'CORRECTION_WITHOUT_TARGET',
          'error',
          `correction ${id} must name the claim it supersedes`,
          { claimId: id },
        );
      } else if (!claimIds.has(claim.supersedes)) {
        add(
          'SUPERSEDED_CLAIM_MISSING',
          'error',
          `correction ${id} supersedes unknown claim ${claim.supersedes}; superseded claims must stay in the ledger`,
          { claimId: id },
        );
      } else {
        supersededBy.set(claim.supersedes, id);
      }
    }

    if (Array.isArray(claim.contradicts)) {
      for (const target of claim.contradicts) {
        if (typeof target === 'string' && !claimIds.has(target)) {
          add(
            'CONTRADICTION_TARGET_MISSING',
            'error',
            `claim ${id} contradicts unknown claim ${target}`,
            { claimId: id },
          );
        }
      }
    }
  }

  // Staleness (superseded claims stay historical and are not re-flagged)
  if (freshnessDays !== null) {
    for (const claim of typedClaims) {
      if (supersededBy.has(claim.id)) continue;
      if (!nonEmptyString(claim.evidenceDate)) continue;
      const evidenceDate = parseDate(claim.evidenceDate);
      if (evidenceDate === null) {
        add('EVIDENCE_DATE_INVALID', 'warning', `claim ${claim.id} evidence date is unparseable`, {
          claimId: claim.id,
        });
        continue;
      }
      const ageDays = (now.getTime() - evidenceDate.getTime()) / DAY_MS;
      if (ageDays > freshnessDays) {
        add(
          'STALE_CLAIM',
          'warning',
          `claim ${claim.id} evidence is ${Math.floor(ageDays)} days old, beyond the ${freshnessDays}-day freshness window`,
          { claimId: claim.id },
        );
      }
    }
  }

  // Contradiction pairs, deduplicated, both sides visible
  const contradictions: Array<{ a: string; b: string }> = [];
  const seenPairs = new Set<string>();
  for (const claim of typedClaims) {
    if (!Array.isArray(claim.contradicts)) continue;
    for (const target of claim.contradicts) {
      if (typeof target !== 'string' || !claimIds.has(target)) continue;
      const pairKey = [claim.id, target].sort().join('');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      contradictions.push({ a: claim.id, b: target });
    }
  }

  // Brief text: budget, decisive preservation, provenance
  let wordBudget: BriefLedgerReportV1['wordBudget'] = null;
  if (briefText !== null) {
    const words = countWords(briefText);
    const withinBudget = maxWords === null || words <= maxWords;
    const missingDecisiveClaims: string[] = [];
    for (const claim of typedClaims) {
      if (claim.decisive !== true) continue;
      if (!referencesId(briefText, claim.id)) missingDecisiveClaims.push(claim.id);
    }
    wordBudget = { maxWords, words, withinBudget, missingDecisiveClaims };

    if (maxWords !== null && !withinBudget) {
      add(
        'WORD_BUDGET_EXCEEDED',
        'error',
        `brief text has ${words} words, exceeding the ${maxWords}-word budget; compress without dropping decisive claims`,
      );
    }
    for (const id of missingDecisiveClaims) {
      add(
        'DECISIVE_CLAIM_NOT_PRESERVED',
        'error',
        `decisive claim ${id} is not referenced in the brief text; compression must preserve decisive claims and their provenance`,
        { claimId: id },
      );
    }
    const anyReferenced = typedClaims.some((claim) => referencesId(briefText, claim.id));
    if (typedClaims.length > 0 && !anyReferenced) {
      add(
        'PROVENANCE_APPENDIX_MISSING',
        'warning',
        'brief text references no claim ids; keep a compact provenance appendix or claim map',
      );
    }
    const briefSuperlatives = findSuperlatives(briefText);
    if (briefSuperlatives.length > 0) {
      add(
        'BRIEF_SUPERLATIVE',
        'warning',
        `brief text uses unsupported wording (${briefSuperlatives.join(', ')}); apply the ledger safe wording`,
      );
    }
  }

  // Evidence floor
  if (typedClaims.length === 0) {
    add('NO_EVIDENCE', 'warning', 'the ledger contains no claims; gather evidence before writing');
  } else if (typedClaims.every((claim) => claim.type === 'unknown')) {
    add(
      'INSUFFICIENT_EVIDENCE',
      'warning',
      'every claim is unresolved; evidence is insufficient for a brief',
    );
  }

  // Status
  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.length - errorCount;
  let status: BriefLedgerReportV1['status'];
  if (errorCount > 0) status = 'invalid';
  else if (typedClaims.length === 0 || typedClaims.every((claim) => claim.type === 'unknown')) {
    status = 'insufficient_evidence';
  } else if (findings.length > 0) status = 'findings';
  else status = 'ok';

  findings.sort((a, b) => {
    const keyA = `${a.code}${a.claimId ?? ''}${a.sourceId ?? ''}`;
    const keyB = `${b.code}${b.claimId ?? ''}${b.sourceId ?? ''}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const claimSummaries = typedClaims.map((claim) => ({
    id: claim.id,
    type: claim.type,
    flagged: findings.some((finding) => finding.claimId === claim.id),
    supersededBy: supersededBy.get(claim.id) ?? null,
    effectiveText: effectiveText.get(claim.id) ?? (claim.text as string),
  }));

  const supersededClaims = typedClaims
    .filter((claim) => supersededBy.has(claim.id))
    .map((claim) => claim.id);

  return {
    version: 1,
    contract: 'brief-ledger',
    status,
    generatedAt: now.toISOString(),
    brief: {
      topic: brief.topic,
      structure,
      maxWords,
      freshnessDays,
    },
    findings,
    claims: claimSummaries,
    supersededClaims,
    contradictions,
    wordBudget,
    stats: {
      claims: typedClaims.length,
      byType,
      sources: sourceIds.size,
      unauthorizedSources,
      findings: { error: errorCount, warning: warningCount },
    },
  };
}
