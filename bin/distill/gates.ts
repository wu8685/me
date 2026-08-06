/**
 * me:distill — Gate check functions for Practice→Cognition promotion.
 *
 * Each gate receives a DistillContext and returns a DistillGateResult.
 * Gates are deterministic and side-effect-free; they only read from the
 * provided context (never from disk directly).
 *
 * The schema-valid-destination gate is special: it receives the result of
 * an actual vault-write preview call performed by the core orchestration.
 */

import type { DistillContext, DistillGateResult, GateName, ParsedNote } from './contracts';
import { PRACTICE_TYPES } from './contracts';

// ── Body section parsing ───────────────────────────────────────────────

/** Extract a value from a `## SectionName` body section. */
export function extractBodySection(body: string, sectionNames: string[]): string | null {
  const pattern = new RegExp(
    `#{1,3}\\s+(?:${sectionNames.join('|')})[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n*$)`,
    'i',
  );
  const match = body.match(pattern);
  if (!match) return null;
  return match[1].trim();
}

/** Parse confidence from body `## Confidence` section. */
export function parseConfidenceFromBody(body: string): string | null {
  const section = extractBodySection(body, ['confidence']);
  if (!section) return null;
  const firstLine = section.split('\n')[0].trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(firstLine)) return firstLine;
  const match = section.match(/\b(low|medium|high)\b/i);
  return match ? match[1].toLowerCase() : null;
}

/** Parse review trigger from body `## Review` section. */
export function parseReviewFromBody(body: string): string | null {
  const section = extractBodySection(body, ['review']);
  if (!section) return null;
  const dateMatch = section.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  return section.split('\n')[0].trim() || null;
}

export interface GateFunction {
  (ctx: DistillContext): DistillGateResult;
}

function gate(name: string, verdict: DistillGateResult['verdict'], reason: string, detail?: string): DistillGateResult {
  return { gate: name, verdict, reason, detail };
}

// ── Independence helpers ──────────────────────────────────────────────

// ── Independence detection helpers ───────────────────────────────────

/**
 * Detect root-child session relationship via recall metadata.
 * Two notes that share a recall session or have a parent-child relationship
 * are not independent — they derive from the same agent session.
 */
function hasRootChildSessionRelation(primary: ParsedNote, candidate: ParsedNote): boolean {
  const primarySession = primary.frontmatter['recall-session'] ?? primary.frontmatter['session'];
  const candidateSession = candidate.frontmatter['recall-session'] ?? candidate.frontmatter['session'];
  if (primarySession && candidateSession && primarySession === candidateSession) {
    return true;
  }
  const primaryParent = primary.frontmatter['parent'];
  const candidateParent = candidate.frontmatter['parent'];
  if (typeof primaryParent === 'string' && primaryParent === candidate.path) return true;
  if (typeof candidateParent === 'string' && candidateParent === primary.path) return true;
  return false;
}

/**
 * Detect PR merge or praise-only content.
 * Notes that contain only PR merge descriptions or praise without substantive
 * practice evidence are not valid independent cases.
 */
function isPrMergeOrPraiseOnly(note: ParsedNote): boolean {
  const body = note.body.toLowerCase();
  const prMergeMarkers = ['merged pr', 'merge pull request', 'merged pull request', 'auto-merge'];
  const praiseOnlyMarkers = ['lgtm', 'great work', 'nice job', 'well done', 'looks good to me'];
  const hasPrMerge = prMergeMarkers.some(m => body.includes(m));
  const hasPraiseOnly = praiseOnlyMarkers.some(m => body.includes(m))
    && body.length < 500
    && !body.includes('## what i did')
    && !body.includes('## what i learned');
  return hasPrMerge || hasPraiseOnly;
}

/**
 * Deterministic independence check.
 *
 * Two practice notes are independent ONLY when they have BOTH explicit
 * distinct project/task identity AND explicit distinct provenance/source,
 * AND none of the rejection criteria apply.
 *
 * Rejection criteria (checked in order):
 * - Same note
 * - Same project/task identity
 * - Same or copied source (checked BEFORE project comparison)
 * - Direct derivation (one wikilinks to the other as evidence)
 * - Root-child session metadata (recall session or parent/child relation)
 * - PR merge or praise-only content
 * - Missing project identity on either note
 * - Missing source provenance on either note
 * - Same project (belt-and-suspenders)
 *
 * Only after ALL rejections pass do we return independent: true.
 * Mere tag overlap is relevance, NOT independence.
 */
export function areIndependentCases(primary: ParsedNote, candidate: ParsedNote): { independent: boolean; rationale: string } {
  // Same note is not independent
  if (primary.path === candidate.path) {
    return { independent: false, rationale: 'Same note.' };
  }

  const primaryProject = primary.project || primary.frontmatter.project as string | undefined;
  const candidateProject = candidate.project || candidate.frontmatter.project as string | undefined;
  const primarySource = primary.source || primary.frontmatter.source as string | undefined;
  const candidateSource = candidate.source || candidate.frontmatter.source as string | undefined;

  // REJECTION 1: Same explicit project → not independent
  if (primaryProject && candidateProject && primaryProject === candidateProject) {
    return { independent: false, rationale: `Same project: "${primaryProject}".` };
  }

  // REJECTION 2: Same source provenance → not independent
  // This fires BEFORE the "different projects" check so that different-project
  // same-source pairs are correctly rejected.
  if (primarySource && candidateSource && primarySource === candidateSource) {
    return { independent: false, rationale: `Same source provenance: ${primarySource}. Copied source does not constitute independent evidence.` };
  }

  // REJECTION 3: Direct derivation — candidate wikilinks to primary → not independent
  const primaryStem = primary.path.replace(/\.md$/, '').split('/').pop() ?? '';
  if (candidate.body.includes(`[[${primary.path.replace(/\.md$/, '')}]]`)
      || candidate.body.includes(`[[${primaryStem}]]`)) {
    return { independent: false, rationale: `Directly references primary practice [[${primary.path.replace(/\.md$/, '')}]].` };
  }

  // REJECTION 4: Direct derivation — primary wikilinks to candidate → not independent
  const candidateStem = candidate.path.replace(/\.md$/, '').split('/').pop() ?? '';
  if (primary.body.includes(`[[${candidate.path.replace(/\.md$/, '')}]]`)
      || primary.body.includes(`[[${candidateStem}]]`)) {
    return { independent: false, rationale: `Primary practice references candidate [[${candidate.path.replace(/\.md$/, '')}]].` };
  }

  // REJECTION 5: Root-child session metadata
  if (hasRootChildSessionRelation(primary, candidate)) {
    return { independent: false, rationale: 'Root-child session relation detected via recall metadata. Notes from the same agent session or derived via parent/child relationship are not independent evidence.' };
  }

  // REJECTION 6: PR merge or praise-only content
  if (isPrMergeOrPraiseOnly(primary)) {
    return { independent: false, rationale: 'Primary note is PR merge or praise-only content, not substantive independent evidence.' };
  }
  if (isPrMergeOrPraiseOnly(candidate)) {
    return { independent: false, rationale: 'Candidate note is PR merge or praise-only content, not substantive independent evidence.' };
  }

  // REQUIREMENT 1: Both notes must have explicit project/task identity
  if (!primaryProject) {
    return { independent: false, rationale: 'Primary note lacks explicit project identity. Independence requires distinct project/task identity for both notes. Set "project:" in frontmatter.' };
  }
  if (!candidateProject) {
    return { independent: false, rationale: 'Candidate note lacks explicit project identity. Independence requires distinct project/task identity for both notes. Set "project:" in frontmatter.' };
  }

  // REQUIREMENT 2: Both notes must have explicit source/provenance
  if (!primarySource) {
    return { independent: false, rationale: 'Primary note lacks explicit source provenance. Independence requires distinct provenance/source for both notes.' };
  }
  if (!candidateSource) {
    return { independent: false, rationale: 'Candidate note lacks explicit source provenance. Independence requires distinct provenance/source for both notes.' };
  }

  // REQUIREMENT 3: Projects must differ
  if (primaryProject === candidateProject) {
    return { independent: false, rationale: `Same project: "${primaryProject}".` };
  }

  // All rejection criteria passed, all requirements met → independent
  return { independent: true, rationale: `Different projects ("${primaryProject}" vs "${candidateProject}") with distinct provenance.` };
}

// ── Gate 1: local-provenance ──────────────────────────────────────────

/**
 * Practice note must exist within the configured practices layer
 * (resolved from .me/config.yaml, not hardcoded).
 */
export function checkLocalProvenance(ctx: DistillContext): DistillGateResult {
  const practicesLayer = ctx.layerNames.practices || 'practices';
  if (!ctx.practice.path.startsWith(`${practicesLayer}/`) && !ctx.practice.path.startsWith(`${practicesLayer}\\`)) {
    return gate('local-provenance', 'fail', `Practice note is not in the configured practices layer "${practicesLayer}/".`, `Path: ${ctx.practice.path}`);
  }
  if (!ctx.practice.title || ctx.practice.title.trim().length === 0) {
    return gate('local-provenance', 'fail', 'Practice note has no title.');
  }
  if (!PRACTICE_TYPES.includes(ctx.practice.type as (typeof PRACTICE_TYPES)[number])) {
    return gate('local-provenance', 'fail', `Practice note type "${ctx.practice.type}" is not a valid practice type.`, `Valid types: ${PRACTICE_TYPES.join(', ')}`);
  }
  // Source must be a path-qualified wikilink when present
  const source = ctx.practice.source || ctx.practice.frontmatter.source as string | undefined;
  if (source && !source.startsWith('[[')) {
    return gate('local-provenance', 'fail', 'Practice source must be a path-qualified wikilink.', `Got: ${source}`);
  }
  return gate('local-provenance', 'pass', `Practice note is in the "${practicesLayer}/" layer with valid frontmatter.`);
}

// ── Gate 2: multiple-independent-cases ────────────────────────────────

/**
 * At least one genuinely independent case must support the practice.
 * Independence is determined by project/task identity and provenance,
 * NOT by mere tag overlap.
 */
export function checkMultipleIndependentCases(ctx: DistillContext): DistillGateResult {
  const independentCases = ctx.independentCases.filter(
    c => c.path !== ctx.practice.path,
  );

  if (independentCases.length < 1) {
    return gate(
      'multiple-independent-cases',
      'fail',
      `Found ${independentCases.length} independent case(s); at least 1 genuinely independent case is required.`,
      'Independence requires different project/task identity plus distinct provenance. Tag overlap is relevance, not independence.',
    );
  }

  const details = independentCases.map(c => {
    const result = areIndependentCases(ctx.practice, c);
    return `[[${c.path}]]: ${result.rationale}`;
  });

  return gate(
    'multiple-independent-cases',
    'pass',
    `${independentCases.length} independent case(s) found.`,
    details.join(' | '),
  );
}

// ── Gate 3: counterevidence-search ────────────────────────────────────

export function checkCounterevidenceSearch(ctx: DistillContext): DistillGateResult {
  if (ctx.counterevidence.length > 0) {
    return gate(
      'counterevidence-search',
      'pass',
      `Counterevidence search found ${ctx.counterevidence.length} note(s) with alternative viewpoints.`,
    );
  }
  return gate(
    'counterevidence-search',
    'pass',
    'Counterevidence search completed; no contradicting claims found in the vault.',
  );
}

// ── Gate 4: no-unresolved-contradiction ───────────────────────────────

export function checkNoUnresolvedContradiction(ctx: DistillContext): DistillGateResult {
  if (ctx.counterevidence.length === 0) {
    return gate('no-unresolved-contradiction', 'pass', 'No counterevidence found.');
  }
  const unresolved = ctx.counterevidence.filter(ce => {
    const body = ctx.practice.body;
    const stem = ce.path.replace(/\.md$/, '').split('/').pop() ?? '';
    return !body.includes(stem) && !body.includes(ce.path);
  });
  if (unresolved.length > 0) {
    return gate(
      'no-unresolved-contradiction',
      'fail',
      `${unresolved.length} unresolved contradiction(s) found. Practice note must address or refute them.`,
      unresolved.map(c => `[[${c.path}]]`).join(', '),
    );
  }
  return gate(
    'no-unresolved-contradiction',
    'pass',
    'All counterevidence has been acknowledged or addressed in the practice note.',
  );
}

// ── Gate 5: generalizes-beyond-task ───────────────────────────────────

export function checkGeneralizesBeyondTask(ctx: DistillContext): DistillGateResult {
  const independentFromOthers = ctx.independentCases.filter(
    c => c.path !== ctx.practice.path,
  );
  if (independentFromOthers.length === 0 && ctx.allPractices.length <= 1) {
    return gate(
      'generalizes-beyond-task',
      'fail',
      'No independent cases found. The insight may be task-specific.',
      'Wait for at least one additional independent case before distilling.',
    );
  }
  const body = ctx.practice.body.toLowerCase();
  const taskSpecificMarkers = [
    'only applies to this project',
    'specific to this task',
    'one-time',
    'never seen again',
  ];
  const hasTaskSpecificLimitation = taskSpecificMarkers.some(m => body.includes(m));
  if (hasTaskSpecificLimitation) {
    return gate(
      'generalizes-beyond-task',
      'fail',
      'Practice note contains language limiting it to a single task or project.',
    );
  }
  return gate(
    'generalizes-beyond-task',
    'pass',
    independentFromOthers.length > 0
      ? 'Insight is supported by independent cases from different projects.'
      : 'Practice note describes a generalizable pattern.',
  );
}

// ── Gate 6: clear-boundaries ──────────────────────────────────────────

export function checkClearBoundaries(ctx: DistillContext): DistillGateResult {
  const body = ctx.practice.body;
  const hasBoundariesSection = /#{1,3}\s+(boundar|limit|scope|when\s+not\s+to|constraint)/i.test(body);
  if (!hasBoundariesSection) {
    return gate(
      'clear-boundaries',
      'fail',
      'No boundaries or limitations section found in the practice note.',
      'Add a "## Boundaries" or "## Limitations" section.',
    );
  }
  return gate(
    'clear-boundaries',
    'pass',
    'Practice note includes a boundaries/limitations section.',
  );
}

// ── Gate 7: justified-confidence ──────────────────────────────────────

export function checkJustifiedConfidence(ctx: DistillContext): DistillGateResult {
  // Confidence comes from body `## Confidence` section (not frontmatter per schema)
  const confidence = parseConfidenceFromBody(ctx.practice.body);
  if (!confidence) {
    return gate(
      'justified-confidence',
      'fail',
      'No confidence level found in practice note body.',
      'Add a "## Confidence" section with "low", "medium", or "high" to the practice note body.',
    );
  }
  const validConfidence = ['low', 'medium', 'high'];
  if (!validConfidence.includes(confidence)) {
    return gate(
      'justified-confidence',
      'fail',
      `Invalid confidence value: "${confidence}". Must be one of: low, medium, high.`,
    );
  }
  const independentCount = ctx.independentCases.filter(c => c.path !== ctx.practice.path).length;
  const supportCount = ctx.linkedNotes.filter(n => n.type === 'raw' || PRACTICE_TYPES.includes(n.type as (typeof PRACTICE_TYPES)[number])).length;

  if (confidence === 'high' && independentCount < 1) {
    return gate(
      'justified-confidence',
      'fail',
      'Confidence is "high" but there are no independent cases.',
      'Reduce confidence to "medium" or wait for independent corroboration.',
    );
  }
  if (confidence === 'high' && supportCount < 2) {
    return gate(
      'justified-confidence',
      'fail',
      'Confidence is "high" but supporting evidence is limited.',
      `Only ${supportCount} supporting note(s) found.`,
    );
  }
  return gate(
    'justified-confidence',
    'pass',
    `Confidence "${confidence}" is justified by ${independentCount} independent case(s) and ${supportCount} supporting note(s).`,
  );
}

// ── Gate 8: review-trigger-set ────────────────────────────────────────

export function checkReviewTriggerSet(ctx: DistillContext): DistillGateResult {
  // Review trigger comes from body `## Review` section (not frontmatter per schema)
  const review = parseReviewFromBody(ctx.practice.body);
  if (!review) {
    return gate(
      'review-trigger-set',
      'fail',
      'No review date or trigger set in practice note body.',
      'Add a "## Review" section with a YYYY-MM-DD date or trigger condition to the practice note body.',
    );
  }
  return gate(
    'review-trigger-set',
    'pass',
    `Review trigger set: "${review}".`,
  );
}

// ── Gate 9: schema-valid-destination ──────────────────────────────────

/**
 * Schema-valid-destination gate.
 *
 * This gate is special: the actual vault-write preview call is performed by
 * the core orchestration (which has access to executeVaultWrite). The gate
 * result reflects whether the preview succeeded.
 *
 * The `previewStatus` parameter comes from the vault-write preview call.
 */
export function checkSchemaValidDestination(previewStatus: string | null): DistillGateResult {
  if (previewStatus === 'preview') {
    return gate(
      'schema-valid-destination',
      'pass',
      'Cognition request passed vault-write preview validation.',
    );
  }
  if (previewStatus === null) {
    return gate(
      'schema-valid-destination',
      'fail',
      'Schema validation was not performed.',
      'Internal error: vault-write preview was not called.',
    );
  }
  return gate(
    'schema-valid-destination',
    'fail',
    `Vault-write preview failed with status: "${previewStatus}".`,
    'Check that the cognition layer is configured and SCHEMA.md is valid.',
  );
}

// ── Registry ──────────────────────────────────────────────────────────

/** Registry of pure gate functions (excluding schema-valid-destination). */
export const GATE_REGISTRY: Readonly<Record<Exclude<GateName, 'schema-valid-destination'>, GateFunction>> = {
  'local-provenance': checkLocalProvenance,
  'multiple-independent-cases': checkMultipleIndependentCases,
  'counterevidence-search': checkCounterevidenceSearch,
  'no-unresolved-contradiction': checkNoUnresolvedContradiction,
  'generalizes-beyond-task': checkGeneralizesBeyondTask,
  'clear-boundaries': checkClearBoundaries,
  'justified-confidence': checkJustifiedConfidence,
  'review-trigger-set': checkReviewTriggerSet,
};

/** Run all requested gates and return results. */
export function runGates(ctx: DistillContext, gateNames?: readonly string[], schemaPreviewStatus?: string | null): DistillGateResult[] {
  const names = gateNames ?? [...Object.keys(GATE_REGISTRY), 'schema-valid-destination'];
  return names.map(name => {
    if (name === 'schema-valid-destination') {
      return checkSchemaValidDestination(schemaPreviewStatus ?? null);
    }
    const fn = GATE_REGISTRY[name as Exclude<GateName, 'schema-valid-destination'>];
    if (!fn) {
      return {
        gate: name,
        verdict: 'fail' as const,
        reason: `Unknown gate: "${name}".`,
      };
    }
    return fn(ctx);
  });
}

/** Check if all gates pass. */
export function allGatesPass(results: DistillGateResult[]): boolean {
  return results.every(r => r.verdict === 'pass');
}

/** Extract boundaries from practice note. */
export function extractBoundaries(ctx: DistillContext): string[] {
  const body = ctx.practice.body;
  const boundaries: string[] = [];
  const sectionMatch = body.match(/#{1,3}\s+(?:boundar|limit|scope|when\s+not\s+to|constraint)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n*$)/i);
  if (sectionMatch) {
    const section = sectionMatch[1];
    const items = section.match(/[-*]\s+([^\n]+)/g);
    if (items) {
      boundaries.push(...items.map(item => item.replace(/^[-*]\s+/, '').trim()));
    }
  }
  if (boundaries.length === 0) {
    boundaries.push('No explicit boundaries documented.');
  }
  return boundaries;
}

/** Determine review trigger from practice note body `## Review` section. */
export function extractReviewTrigger(ctx: DistillContext): string {
  const review = parseReviewFromBody(ctx.practice.body);
  if (review) return review;
  const created = ctx.practice.created;
  if (created) {
    const date = new Date(created);
    date.setDate(date.getDate() + 90);
    return date.toISOString().slice(0, 10);
  }
  return 'Review after 90 days';
}
