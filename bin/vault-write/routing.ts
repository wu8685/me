/**
 * Shared layer-routing contract for ME notes.
 *
 * Routing precedence (see templates/CLAUDE-template.md, "Layer Map"):
 *
 *   semantic knowledge type > layer schema constraints > existing directory convention
 *
 * An existing note in a directory is navigation evidence, never routing
 * evidence: a misfiled legacy note must not pull new notes into the wrong
 * layer. This module provides:
 *
 * - `decideLayer` / `classifyKnowledgeType` — the pre-write layer decision
 *   contract used before any note write;
 * - `deterministicFindings` — schema-level violations that must block a
 *   write (stable error codes);
 * - `semanticAdvisories` — heuristic misfile signals, advisory only, always
 *   labeled `heuristic` and suppressible via `.me/doctor-suppressions.json`;
 * - `analyzeNoteRouting` — one-shot combination consumed by `me:doctor`,
 *   `route-check`, and `remediate`.
 *
 * Everything here is pure or read-only. Nothing in this module writes to
 * the vault, and no advisory ever moves or rewrites a note by itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LogicalLayer } from './contracts';

export type KnowledgeType = 'external-source' | 'practice-record' | 'distilled-insight';

export const KNOWLEDGE_TYPE_LAYER: Readonly<Record<KnowledgeType, LogicalLayer>> = Object.freeze({
  'external-source': 'raw',
  'practice-record': 'practices',
  'distilled-insight': 'cognition',
});

export const ROUTING_PRECEDENCE: readonly string[] = Object.freeze([
  'semantic knowledge type',
  'layer schema constraints',
  'existing directory convention',
]);

export type RoutingErrorCode =
  | 'ROUTING_FRONTMATTER_INVALID'
  | 'ROUTING_RAW_SOURCE_NOT_URL'
  | 'ROUTING_FIELD_NOT_ALLOWED'
  | 'ROUTING_MISSING_REQUIRED_FIELD'
  | 'ROUTING_TYPE_INVALID_FOR_LAYER'
  | 'ROUTING_PROVENANCE_NOT_REFERENCE'
  | 'ROUTING_FORBIDDEN_FIELD';

export type RoutingAdvisoryCode =
  | 'ROUTING_RAW_LIKE_PRACTICE'
  | 'ROUTING_PRACTICES_LIKE_RAW'
  | 'ROUTING_COGNITION_SINGLE_EVENT';

/** Pre-write gate advisories emitted by route-check (never vault diagnostics). */
export type RoutingGateCode =
  | 'ROUTING_LAYER_NEEDS_CONFIRMATION'
  | 'ROUTING_MIXED_SOURCE_AND_JUDGMENT'
  | 'ROUTING_COGNITION_REQUIRES_DISTILL';

export const ADVISORY_CODES: readonly RoutingAdvisoryCode[] = Object.freeze([
  'ROUTING_RAW_LIKE_PRACTICE',
  'ROUTING_PRACTICES_LIKE_RAW',
  'ROUTING_COGNITION_SINGLE_EVENT',
]);

export interface RoutingFinding {
  code: RoutingErrorCode | RoutingAdvisoryCode | RoutingGateCode;
  severity: 'error' | 'advisory';
  /** Heuristic findings are advisory, evidence-bearing, and suppressible. */
  heuristic: boolean;
  message: string;
  recommendedAction: string;
  /** Marker/rule labels that triggered the finding — never note sentences. */
  evidence: string[];
  details?: Record<string, unknown>;
}

const CORE_FIELDS = ['title', 'created', 'tags', 'type', 'source'] as const;
const LAYER_EXTENSIONS: Record<LogicalLayer, string[]> = {
  raw: [],
  practices: ['project'],
  cognition: ['confidence'],
};
const LAYER_TYPES: Record<LogicalLayer, string[]> = {
  raw: ['article', 'concept'],
  practices: ['experiment', 'reflection'],
  cognition: ['insight'],
};
const FORBIDDEN_FIELDS = ['status', 'lifecycle', 'date_created'] as const;

const WIKILINK_REFERENCE = /^\[\[[^\][\r\n]+\]\]$/;

export interface LooseNote {
  fields: Map<string, string>;
  body: string;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Lenient frontmatter reader for diagnostics: accepts any `key: value` lines
 * inside the leading `---` block. Returns null when no frontmatter block is
 * present. Never throws — diagnostics must survive broken notes.
 */
export function parseLooseNote(markdown: string): LooseNote | null {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return null;
  const lines = markdown.split(/\r?\n/);
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) return null;
  const noteFields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
    if (!match) continue;
    noteFields.set(match[1], unquote(match[2] ?? ''));
  }
  return { fields: noteFields, body: lines.slice(closing + 1).join('\n') };
}

function error(
  code: RoutingErrorCode,
  message: string,
  recommendedAction: string,
  details?: Record<string, unknown>,
): RoutingFinding {
  return {
    code,
    severity: 'error',
    heuristic: false,
    message,
    recommendedAction,
    evidence: [],
    ...(details ? { details } : {}),
  };
}

function advisory(
  code: RoutingAdvisoryCode,
  message: string,
  recommendedAction: string,
  evidence: string[],
): RoutingFinding {
  return { code, severity: 'advisory', heuristic: true, message, recommendedAction, evidence };
}

function isExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Deterministic per-layer schema checks. Every finding here blocks a write
 * and is never suppressible.
 */
export function deterministicFindings(
  layer: LogicalLayer,
  noteFields: Map<string, string>,
): RoutingFinding[] {
  const findings: RoutingFinding[] = [];
  const allowed = new Set([...CORE_FIELDS, ...LAYER_EXTENSIONS[layer]]);
  const required = new Set([...CORE_FIELDS, ...(layer === 'cognition' ? ['confidence'] : [])]);

  for (const key of noteFields.keys()) {
    if ((FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      findings.push(error(
        'ROUTING_FORBIDDEN_FIELD',
        `Field "${key}" is forbidden by the ME schema (the layer directory is the knowledge-level indicator).`,
        `Remove the "${key}" field from the note frontmatter.`,
        { field: key },
      ));
    } else if (!allowed.has(key)) {
      findings.push(error(
        'ROUTING_FIELD_NOT_ALLOWED',
        `Field "${key}" is not allowed in the ${layer} layer.`,
        `Remove "${key}" or move the note to the layer that permits it.`,
        { field: key, layer },
      ));
    }
  }

  for (const key of required) {
    if (!noteFields.has(key) || noteFields.get(key) === '') {
      findings.push(error(
        'ROUTING_MISSING_REQUIRED_FIELD',
        `Required field "${key}" is missing in the ${layer} layer.`,
        `Add the "${key}" field to the note frontmatter.`,
        { field: key, layer },
      ));
    }
  }

  const type = noteFields.get('type');
  if (type !== undefined && type !== '' && !LAYER_TYPES[layer].includes(type)) {
    findings.push(error(
      'ROUTING_TYPE_INVALID_FOR_LAYER',
      `Type "${type}" is not valid in the ${layer} layer.`,
      `Use one of: ${LAYER_TYPES[layer].join(', ')} — or route the note to the layer matching its semantic type.`,
      { type, layer, allowed: [...LAYER_TYPES[layer]] },
    ));
  }

  const source = noteFields.get('source');
  if (source !== undefined && source !== '') {
    if (layer === 'raw') {
      if (!isExternalUrl(source)) {
        findings.push(error(
          'ROUTING_RAW_SOURCE_NOT_URL',
          'Raw layer "source" must be a valid external http(s) URL.',
          'Point "source" at the external origin URL; internal provenance URIs and wikilinks are not valid in raw.',
          { sourceKind: WIKILINK_REFERENCE.test(source) ? 'wikilink' : 'non-url' },
        ));
      }
    } else if (!WIKILINK_REFERENCE.test(source)) {
      findings.push(error(
        'ROUTING_PROVENANCE_NOT_REFERENCE',
        `${layer} layer "source" must be a [[wikilink]] note/evidence reference.`,
        'Rewrite "source" as a [[wikilink]] to the supporting note.',
      ));
    }
  }

  return findings;
}

interface MarkerRule {
  label: string;
  pattern: RegExp;
}

/**
 * First-person judgment markers: the note's author is deciding, recommending,
 * or reflecting. These distinguish a decision/practice record from a source
 * capture that merely *quotes* third-party opinions.
 */
const AGENCY_MARKERS: MarkerRule[] = [
  { label: 'judgment:we-decided', pattern: /\bwe decided\b/i },
  { label: 'judgment:i-decided', pattern: /\bi decided\b/i },
  { label: 'judgment:decided-to', pattern: /\bdecided to\b/i },
  { label: 'judgment:decision', pattern: /\bdecision\s*:/i },
  { label: 'judgment:in-my-opinion', pattern: /\bin my opinion\b/i },
  { label: 'judgment:i-believe', pattern: /\bi believe\b/i },
  { label: 'judgment:we-chose', pattern: /\bwe chose\b/i },
  { label: 'judgment:we-recommend', pattern: /\bwe recommend\b/i },
  { label: 'judgment:i-recommend', pattern: /\bi recommend\b/i },
  { label: 'judgment:lessons-learned', pattern: /\blessons? learned\b/i },
  { label: 'judgment:retrospective', pattern: /\bretrospectives?\b/i },
  { label: 'judgment:rationale', pattern: /\brationale\s*:/i },
];

/** Process/context words that also appear in faithful source captures. */
const CONTEXT_MARKERS: MarkerRule[] = [
  { label: 'context:recommend', pattern: /\brecommend/i },
  { label: 'context:trade-off', pattern: /\btrade-?offs?\b/i },
  { label: 'context:pros-and-cons', pattern: /\bpros and cons\b/i },
  { label: 'context:follow-up', pattern: /\bfollow-?ups?\b/i },
  { label: 'context:next-step', pattern: /\bnext steps?\b/i },
];

const SINGLE_EVENT_MARKERS: MarkerRule[] = [
  { label: 'single-event:a-single', pattern: /\ba single\b/i },
  { label: 'single-event:one-experiment', pattern: /\bone experiment\b/i },
  { label: 'single-event:one-incident', pattern: /\bone incident\b/i },
  { label: 'single-event:one-time', pattern: /\bone time\b/i },
  { label: 'single-event:only-observed', pattern: /\bonly observed\b/i },
  { label: 'single-event:anecdote', pattern: /\banecdote/i },
];

const EXTERNAL_LINK = /https?:\/\/[^\s)\]]+/g;
const FIRST_PERSON = /\b(I|we|my|our|me)\b/;
const WIKILINK = /\[\[[^\][\r\n]+\]\]/g;

function stripCodeFences(body: string): string {
  return body.replace(/```[\s\S]*?(?:```|$)/g, ' ');
}

function matchedLabels(rules: MarkerRule[], text: string): string[] {
  return rules.filter(rule => rule.pattern.test(text)).map(rule => rule.label);
}

/**
 * Heuristic semantic-misfiling signals. Always advisory: clearly labeled
 * `heuristic`, evidence-bearing, and suppressible. Never proof of semantic
 * type, never a trigger for automatic moves.
 */
export function semanticAdvisories(
  layer: LogicalLayer,
  noteFields: Map<string, string>,
  body: string,
): RoutingFinding[] {
  const text = stripCodeFences(body);
  const agency = matchedLabels(AGENCY_MARKERS, text);
  const context = matchedLabels(CONTEXT_MARKERS, text);
  const findings: RoutingFinding[] = [];

  if (layer === 'raw' && (agency.length >= 2 || (agency.length >= 1 && agency.length + context.length >= 2))) {
    findings.push(advisory(
      'ROUTING_RAW_LIKE_PRACTICE',
      'Raw note body is dominated by first-person decisions, recommendations, trade-offs, or judgment.',
      'If this is a decision/practice record, remediate it into the practices layer via the me:move remediation contract; quoted opinions inside a faithful source capture are fine.',
      [...agency, ...context],
    ));
  }

  if (layer === 'practices') {
    const externalLinks = (text.match(EXTERNAL_LINK) ?? []).length;
    if (
      externalLinks >= 2
      && agency.length === 0
      && context.length === 0
      && !FIRST_PERSON.test(text)
      && text.trim().length >= 400
    ) {
      findings.push(advisory(
        'ROUTING_PRACTICES_LIKE_RAW',
        'Practices note looks like an unmodified external article (external links, no judgment, no first person).',
        'If this is faithful source capture, remediate it into the raw layer; otherwise record the local observation or decision explicitly.',
        [`external-links:${externalLinks}`, 'no-judgment-markers', 'no-first-person'],
      ));
    }
  }

  if (layer === 'cognition') {
    const singleEvent = matchedLabels(SINGLE_EVENT_MARKERS, text);
    const wikilinks = (text.match(WIKILINK) ?? []).length;
    if (singleEvent.length >= 1 && wikilinks <= 1) {
      findings.push(advisory(
        'ROUTING_COGNITION_SINGLE_EVENT',
        'Cognition note appears dominated by a single unverified event.',
        'Cognition entries must pass the me:distill evidence gates; demote to practices until corroborating evidence exists.',
        [...singleEvent, `wikilinks:${wikilinks}`],
      ));
    }
  }

  return findings;
}

export interface NoteRoutingAnalysis {
  note: LooseNote | null;
  errors: RoutingFinding[];
  advisories: RoutingFinding[];
}

export function analyzeNoteRouting(layer: LogicalLayer, markdown: string): NoteRoutingAnalysis {
  const note = parseLooseNote(markdown);
  if (!note) {
    return {
      note: null,
      errors: [error(
        'ROUTING_FRONTMATTER_INVALID',
        'Note has no recognizable YAML frontmatter block.',
        'Add a frontmatter block matching SCHEMA.md for the note\'s layer.',
      )],
      advisories: [],
    };
  }
  return {
    note,
    errors: deterministicFindings(layer, note.fields),
    advisories: semanticAdvisories(layer, note.fields, note.body),
  };
}

export interface ContentClassification {
  knowledgeType: KnowledgeType;
  /** Signal labels that drove the classification. */
  signals: string[];
  /** True when external source material and local judgment are mixed. */
  mixedSourceAndJudgment: boolean;
}

/**
 * Heuristic pre-write content classification. The result is guidance for the
 * routing decision — never silent proof. `distilled-insight` is only returned
 * when the note declares `type: insight`; cognition writes remain gated by
 * me:distill.
 */
export function classifyKnowledgeType(
  noteFields: Map<string, string>,
  body: string,
): ContentClassification {
  const signals: string[] = [];
  if (noteFields.get('type') === 'insight') {
    signals.push('declared-type:insight');
    return { knowledgeType: 'distilled-insight', signals, mixedSourceAndJudgment: false };
  }

  const text = stripCodeFences(body);
  const agency = matchedLabels(AGENCY_MARKERS, text);
  const source = noteFields.get('source') ?? '';
  const sourceIsUrl = source !== '' && isExternalUrl(source);
  const declaredType = noteFields.get('type') ?? '';
  if (sourceIsUrl) signals.push('source:external-url');
  if (agency.length > 0) signals.push(...agency);

  // First-person judgment outranks the declared type: a decision record
  // labeled "article" to fit a legacy raw directory is still a practice.
  if (agency.length > 0) {
    return {
      knowledgeType: 'practice-record',
      signals,
      mixedSourceAndJudgment: sourceIsUrl,
    };
  }
  if (declaredType === 'article' || declaredType === 'concept') {
    signals.push(`declared-type:${declaredType}`);
    return { knowledgeType: 'external-source', signals, mixedSourceAndJudgment: false };
  }
  if (declaredType === 'experiment' || declaredType === 'reflection') {
    signals.push(`declared-type:${declaredType}`);
    return { knowledgeType: 'practice-record', signals, mixedSourceAndJudgment: false };
  }
  if (sourceIsUrl) {
    return { knowledgeType: 'external-source', signals, mixedSourceAndJudgment: false };
  }
  if (WIKILINK_REFERENCE.test(source)) signals.push('source:wikilink');
  return { knowledgeType: 'practice-record', signals, mixedSourceAndJudgment: false };
}

export interface LayerDecision {
  layer: LogicalLayer;
  precedence: readonly string[];
  explanation: string;
}

/**
 * The pre-write layer decision contract. The destination layer follows the
 * semantic knowledge type alone; existing directory contents are navigation
 * evidence, never routing evidence, and are deliberately not an input here.
 */
export function decideLayer(knowledgeType: KnowledgeType): LayerDecision {
  const layer = KNOWLEDGE_TYPE_LAYER[knowledgeType];
  const explanations: Record<KnowledgeType, string> = {
    'external-source':
      'External source material or faithful source capture belongs in the raw layer.',
    'practice-record':
      'Practice history, subjective observations, feedback, decisions, trade-offs, and working conclusions belong in the practices layer.',
    'distilled-insight':
      'Stable reusable insight belongs in the cognition layer, and only through the evidence-gated me:distill promotion flow.',
  };
  return { layer, precedence: ROUTING_PRECEDENCE, explanation: explanations[knowledgeType] };
}

export interface AdvisorySuppression {
  code: RoutingAdvisoryCode;
  path?: string;
}

export interface LoadedSuppressions {
  suppressions: AdvisorySuppression[];
  error: string | null;
}

/**
 * Read `.me/doctor-suppressions.json`:
 * `{ "version": 1, "suppress": [{ "code": "ROUTING_*", "path"?: "..." }] }`.
 * Only advisory codes are honored — deterministic errors can never be
 * suppressed. Read-only; a missing file is not an error.
 */
export function loadAdvisorySuppressions(vaultDir: string): LoadedSuppressions {
  const file = path.join(vaultDir, '.me', 'doctor-suppressions.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { suppressions: [], error: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { suppressions: [], error: 'not valid JSON' };
  }
  if (
    typeof value !== 'object'
    || value === null
    || (value as { version?: unknown }).version !== 1
    || !Array.isArray((value as { suppress?: unknown }).suppress)
  ) {
    return { suppressions: [], error: 'must be { "version": 1, "suppress": [...] }' };
  }
  const suppressions: AdvisorySuppression[] = [];
  for (const entry of (value as { suppress: unknown[] }).suppress) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { code?: unknown; path?: unknown };
    if (
      typeof record.code === 'string'
      && (ADVISORY_CODES as readonly string[]).includes(record.code)
      && (record.path === undefined || typeof record.path === 'string')
    ) {
      suppressions.push({
        code: record.code as RoutingAdvisoryCode,
        ...(typeof record.path === 'string' ? { path: record.path } : {}),
      });
    }
  }
  return { suppressions, error: null };
}

/**
 * Split findings into kept vs suppressed. Only `heuristic` advisory findings
 * are suppressible; deterministic errors always survive.
 */
export function suppressAdvisories(
  findings: RoutingFinding[],
  suppressions: AdvisorySuppression[],
  notePath: string,
): { kept: RoutingFinding[]; suppressed: RoutingFinding[] } {
  const kept: RoutingFinding[] = [];
  const suppressed: RoutingFinding[] = [];
  for (const finding of findings) {
    const match = finding.heuristic
      && suppressions.some(entry =>
        entry.code === finding.code && (entry.path === undefined || entry.path === notePath));
    if (match) suppressed.push(finding);
    else kept.push(finding);
  }
  return { kept, suppressed };
}
