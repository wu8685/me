/**
 * me:distill — Core orchestration for Practice→Cognition promotion.
 *
 * Preview: analyzes a practice note, runs gate checks (including an actual
 * vault-write preview for schema validation), and produces an exact preview
 * with digest for manual confirmation.
 *
 * Apply: calls executeVaultWrite in-process with an afterAuthoritativePlan
 * callback that re-verifies the preview digest under the vault-write lock,
 * closing the TOCTOU window between pre-lock check and actual write.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  DistillError,
  PRACTICE_TYPES,
  type DistillCaseSummary,
  type DistillContext,
  type DistillEvidenceItem,
  type DistillGateResult,
  type DistillPreviewV1,
  type DistillResultV1,
  type ParsedNote,
} from './contracts';
import {
  allGatesPass,
  areIndependentCases,
  extractBoundaries,
  extractReviewTrigger,
  parseConfidenceFromBody,
  runGates,
} from './gates';
import {
  resolveVaultLayout,
  parseLayerConfig,
  type ResolvedVaultLayout,
} from '../vault-write/path-safety';
import {
  executeVaultWrite,
  type PlannedWrite,
  type VaultWriteHooks,
} from '../vault-write/transaction';
import type { VaultWriteRequestV1, VaultWriteRecovery } from '../vault-write/contracts';

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

// ── Note parsing ──────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export function parseNote(content: string, vaultRelativePath: string): ParsedNote {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new DistillError('NOT_A_PRACTICE');
  }

  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      if (inner === '') {
        value = [];
      } else {
        value = inner.split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
      }
    }
    if (typeof value === 'string') {
      value = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }

    frontmatter[key] = value;
  }

  const title = (frontmatter.title as string) ?? '';
  const created = (frontmatter.created as string) ?? '';
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [];
  const type = (frontmatter.type as string) ?? '';
  const project = frontmatter.project as string | undefined;
  const source = frontmatter.source as string | undefined;

  return { path: vaultRelativePath, frontmatter, body, title, created, tags, type, project, source };
}

// Body section extraction imported from gates to avoid circular dependency

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;

export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const target = match[1].trim();
    if (target && !links.includes(target)) {
      links.push(target);
    }
  }
  return links;
}

// ── Vault layout integration ──────────────────────────────────────────

/** Resolve vault layout using the shared vault-write infrastructure. */
export function resolveDistillLayout(vaultDir: string): {
  layout: ResolvedVaultLayout;
  layerNames: Record<string, string>;
} {
  const layout = resolveVaultLayout(vaultDir);

  // Parse configured layer names from config.yaml
  const configPath = path.join(layout.meDir, 'config.yaml');
  let configured: Partial<Record<string, string>> = {};
  try {
    if (fs.existsSync(configPath)) {
      configured = parseLayerConfig(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    // Fall through to defaults
  }

  const layerNames: Record<string, string> = {
    raw: configured.raw ?? 'raw',
    practices: configured.practices ?? 'practices',
    cognition: configured.cognition ?? 'cognition',
  };

  return { layout, layerNames };
}

// ── Path helpers ──────────────────────────────────────────────────────

function vaultRelativePath(absolutePath: string, vaultDir: string): string {
  const rel = path.relative(vaultDir, absolutePath);
  return rel.split(path.sep).join('/');
}

function resolveWikilinkTarget(link: string, vaultDir: string, layerNames: Record<string, string>): string | null {
  const candidates: string[] = [];
  // Try vault-relative first
  candidates.push(path.join(vaultDir, `${link}.md`));
  candidates.push(path.join(vaultDir, link));
  // Try each configured layer directory
  for (const layerDir of Object.values(layerNames)) {
    candidates.push(path.join(vaultDir, layerDir, `${link}.md`));
    candidates.push(path.join(vaultDir, layerDir, link));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Skip inaccessible paths
    }
  }
  return null;
}

function findNotesInLayer(vaultDir: string, layerName: string): string[] {
  const layerDir = path.join(vaultDir, layerName);
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(layerDir, { recursive: true })) {
      const fullPath = path.join(layerDir, entry);
      if (fullPath.endsWith('.md') && !entry.endsWith('README.md')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Layer directory doesn't exist
  }
  return files;
}

// ── Independence detection ────────────────────────────────────────────

function findIndependentCases(
  practice: ParsedNote,
  allPractices: ParsedNote[],
): ParsedNote[] {
  return allPractices.filter(other => {
    if (other.path === practice.path) return false;
    const result = areIndependentCases(practice, other);
    return result.independent;
  });
}

// ── Counterevidence detection ─────────────────────────────────────────

function findCounterevidence(
  practice: ParsedNote,
  allNotes: ParsedNote[],
  linkedNotes: ParsedNote[],
): ParsedNote[] {
  const contradictionMarkers = [
    'however', 'but', 'alternatively', 'on the other hand',
    'different approach', 'not always', 'does not apply',
    'counterexample', 'differs from', 'unlike',
  ];
  const counterevidence: ParsedNote[] = [];

  for (const note of linkedNotes) {
    const lowerBody = note.body.toLowerCase();
    if (contradictionMarkers.some(m => lowerBody.includes(m))) {
      counterevidence.push(note);
    }
  }

  const linkedPaths = new Set(linkedNotes.map(n => n.path));
  for (const note of allNotes) {
    if (linkedPaths.has(note.path) || note.path === practice.path) continue;
    const lowerBody = note.body.toLowerCase();
    const practiceTitleWords = practice.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const mentionsPractice = practiceTitleWords.some(w => lowerBody.includes(w));
    const hasContradiction = contradictionMarkers.some(m => lowerBody.includes(m));
    if (mentionsPractice && hasContradiction) {
      counterevidence.push(note);
    }
  }

  return counterevidence;
}

// ── Context building ──────────────────────────────────────────────────

export function buildDistillContext(
  vaultDir: string,
  practicePath: string,
  layout: ResolvedVaultLayout,
  layerNames: Record<string, string>,
): DistillContext {
  const practiceAbsPath = path.join(vaultDir, practicePath);
  if (!fs.existsSync(practiceAbsPath)) {
    throw new DistillError('PRACTICE_NOT_FOUND');
  }
  const practiceContent = fs.readFileSync(practiceAbsPath, 'utf8');
  const practice = parseNote(practiceContent, practicePath);

  const practicesLayer = layerNames.practices || 'practices';
  if (!practicePath.startsWith(`${practicesLayer}/`) && !practicePath.startsWith(`${practicesLayer}\\`)) {
    throw new DistillError('NOT_A_PRACTICE');
  }

  // Extract and resolve wikilinks
  const wikilinks = extractWikilinks(practiceContent);
  const linkedNotes: ParsedNote[] = [];
  for (const link of wikilinks) {
    const target = resolveWikilinkTarget(link, vaultDir, layerNames);
    if (target) {
      const relPath = vaultRelativePath(target, vaultDir);
      try {
        linkedNotes.push(parseNote(fs.readFileSync(target, 'utf8'), relPath));
      } catch {
        // Skip unparseable notes
      }
    }
  }

  // Find all practices for independence detection
  const allPracticePaths = findNotesInLayer(vaultDir, practicesLayer);
  const allPractices: ParsedNote[] = [];
  for (const absPath of allPracticePaths) {
    const relPath = vaultRelativePath(absPath, vaultDir);
    if (relPath === practicePath) continue;
    try {
      allPractices.push(parseNote(fs.readFileSync(absPath, 'utf8'), relPath));
    } catch {
      // Skip
    }
  }
  for (const note of linkedNotes) {
    if (PRACTICE_TYPES.includes(note.type as (typeof PRACTICE_TYPES)[number])
        && !allPractices.some(p => p.path === note.path)) {
      allPractices.push(note);
    }
  }

  const independentCases = findIndependentCases(practice, allPractices);

  // Find all notes for counterevidence search
  const rawLayer = layerNames.raw || 'raw';
  const allRawPaths = findNotesInLayer(vaultDir, rawLayer);
  const allNotes: ParsedNote[] = [...allPractices];
  for (const absPath of allRawPaths) {
    const relPath = vaultRelativePath(absPath, vaultDir);
    try {
      allNotes.push(parseNote(fs.readFileSync(absPath, 'utf8'), relPath));
    } catch {
      // Skip
    }
  }
  for (const note of linkedNotes) {
    if (!allNotes.some(n => n.path === note.path)) {
      allNotes.push(note);
    }
  }

  const counterevidence = findCounterevidence(practice, allNotes, linkedNotes);

  return {
    vaultDir,
    layout: {
      lexicalVault: layout.lexicalVault,
      canonicalVault: layout.canonicalVault,
      meDir: layout.meDir,
      layers: {
        raw: layout.layers.raw,
        practices: layout.layers.practices,
        cognition: layout.layers.cognition,
      },
    },
    layerNames,
    practice,
    linkedNotes,
    allPractices,
    independentCases,
    counterevidence,
  };
}

// ── Cognition note generation ─────────────────────────────────────────

export function generateCognitionMarkdown(ctx: DistillContext): string {
  const practice = ctx.practice;
  const confidence = parseConfidenceFromBody(practice.body) || 'medium';
  const review = extractReviewTrigger(ctx);
  const title = practice.title;
  const allTags = [...new Set([...practice.tags, 'distilled'])];
  const source = `[[${practice.path.replace(/\.md$/, '')}]]`;
  const created = new Date().toISOString().slice(0, 10);

  // Frontmatter: only schema-valid keys (NO review in frontmatter)
  const frontmatter = [
    '---',
    `title: "${title}"`,
    `created: ${created}`,
    `tags: [${allTags.join(', ')}]`,
    'type: insight',
    `source: "${source}"`,
    `confidence: ${confidence}`,
    '---',
  ].join('\n');

  const boundaries = extractBoundaries(ctx);
  const supportItems = ctx.linkedNotes
    .filter(n => n.type === 'raw' || PRACTICE_TYPES.includes(n.type as (typeof PRACTICE_TYPES)[number]))
    .map(n => `- [[${n.path.replace(/\.md$/, '')}]] — ${n.title || 'Supporting evidence'}`);

  const independentItems = ctx.independentCases
    .filter(c => c.path !== practice.path)
    .map((c, i) => {
      const indResult = areIndependentCases(practice, c);
      return `${i + 1}. [[${c.path.replace(/\.md$/, '')}]] (${c.created || 'unknown date'}): ${c.title || 'Independent case'} — ${indResult.rationale}`;
    });

  const contradictionItems = ctx.counterevidence
    .map(c => `- [[${c.path.replace(/\.md$/, '')}]] — ${c.title || 'Counterevidence'}`);

  const body = [
    `# ${title}`,
    '',
    '## The Insight',
    '',
    `${practice.title} — distilled from practice evidence across multiple cases.`,
    '',
    '## Supporting Evidence',
    '',
    ...(supportItems.length > 0 ? supportItems : ['- No linked supporting evidence.']),
    '',
    '## Counterevidence',
    '',
    ...(contradictionItems.length > 0
      ? contradictionItems
      : ['- No counterevidence found after explicit search.']),
    '',
    '## Independent Cases',
    '',
    ...(independentItems.length > 0
      ? independentItems
      : [`1. Primary case: [[${practice.path.replace(/\.md$/, '')}]]`]),
    '',
    '## Boundaries',
    '',
    ...boundaries.map(b => `- ${b}`),
    '',
    '## Confidence',
    '',
    `**${confidence.charAt(0).toUpperCase() + confidence.slice(1)}** — ${ctx.independentCases.filter(c => c.path !== practice.path).length} independent case(s), ${ctx.linkedNotes.length} supporting note(s).`,
    '',
    '## Review',
    '',
    `- Trigger: ${review}`,
    '- If new contradictory evidence emerges, review this insight.',
    '',
  ].join('\n');

  return `${frontmatter}\n\n${body}`;
}

// ── Preview digest computation ────────────────────────────────────────

export function computePreviewDigest(preview: Omit<DistillPreviewV1, 'previewDigest'>): string {
  const canonical = {
    contract: preview.contract,
    version: preview.version,
    practicePath: preview.practicePath,
    plannedCognitionPath: preview.plannedCognitionPath,
    plannedMarkdown: preview.plannedMarkdown,
    gates: preview.gates.map(g => ({
      gate: g.gate,
      verdict: g.verdict,
      reason: g.reason,
      detail: g.detail ?? null,
    })),
    cases: preview.cases.map(c => ({
      path: c.path,
      summary: c.summary,
      independent: c.independent,
      rationale: c.rationale,
    })),
    support: preview.support.map(s => ({
      path: s.path,
      kind: s.kind,
      excerpt: s.excerpt,
      independent: s.independent,
    })),
    contradictions: preview.contradictions.map(c => ({
      path: c.path,
      excerpt: c.excerpt,
      independent: c.independent,
    })),
    independentCount: preview.independentCount,
    boundaries: [...preview.boundaries].sort(),
    confidence: preview.confidence,
    reviewTrigger: preview.reviewTrigger,
    warnings: [...preview.warnings].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical, null, 2)).digest('hex');
}

// ── Path generation ───────────────────────────────────────────────────

/**
 * Generate the logical-layer-relative cognition path.
 * This is used for VaultWriteRequest.relativePath (no layer prefix).
 */
export function generateCognitionPath(practicePath: string): string {
  const stem = path.basename(practicePath, '.md');
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${stem}.md`;
}

/**
 * Generate the vault-relative configured cognition path for preview display.
 * Includes the configured cognition layer prefix (e.g. "cognition/2026-08-05-stem.md"
 * or "insights/2026-08-05-stem.md" for custom layers).
 */
export function generatePlannedCognitionPath(practicePath: string, cognitionLayer: string): string {
  const logicalPath = generateCognitionPath(practicePath);
  return `${cognitionLayer}/${logicalPath}`;
}

// ── Evidence summary builders ─────────────────────────────────────────

export function buildCaseSummaries(ctx: DistillContext): DistillCaseSummary[] {
  const cases: DistillCaseSummary[] = [];
  cases.push({
    path: ctx.practice.path,
    summary: ctx.practice.title || 'Primary practice case',
    independent: false,
    rationale: 'Primary case.',
  });
  for (const c of ctx.independentCases) {
    if (c.path === ctx.practice.path) continue;
    const indResult = areIndependentCases(ctx.practice, c);
    cases.push({
      path: c.path,
      summary: c.title || 'Independent case',
      independent: indResult.independent,
      rationale: indResult.rationale,
    });
  }
  return cases;
}

export function buildEvidenceItems(ctx: DistillContext): {
  support: DistillEvidenceItem[];
  contradictions: DistillEvidenceItem[];
} {
  const support: DistillEvidenceItem[] = [];
  const contradictions: DistillEvidenceItem[] = [];
  const contradictionMarkers = ['however', 'but', 'alternatively', 'on the other hand', 'counterexample'];

  for (const note of ctx.linkedNotes) {
    const excerpt = note.body.slice(0, 200).replace(/\n/g, ' ').trim();
    const isIndependent = ctx.independentCases.some(c => c.path === note.path);
    const lowerBody = note.body.toLowerCase();
    const isContradiction = contradictionMarkers.some(m => lowerBody.includes(m));

    if (isContradiction) {
      contradictions.push({ path: note.path, kind: 'contradiction', excerpt: excerpt || note.title, independent: isIndependent });
    } else {
      support.push({ path: note.path, kind: 'support', excerpt: excerpt || note.title, independent: isIndependent });
    }
  }

  for (const note of ctx.counterevidence) {
    if (!contradictions.some(c => c.path === note.path)) {
      contradictions.push({
        path: note.path, kind: 'contradiction',
        excerpt: note.body.slice(0, 200).replace(/\n/g, ' ').trim(), independent: true,
      });
    }
  }

  return { support, contradictions };
}

// ── Preview orchestration ─────────────────────────────────────────────

export interface DistillPreviewParams {
  vaultDir: string;
  practicePath: string;
  gateNames?: string[];
}

function buildPreview(
  params: DistillPreviewParams,
  ctx: DistillContext,
  gateResults: DistillGateResult[],
  warnings: string[],
): DistillPreviewV1 {
  const cognitionLayer = ctx.layerNames.cognition || 'cognition';
  const cognitionPath = generateCognitionPath(params.practicePath); // logical-layer-relative for VaultWriteRequest
  const plannedCognitionPath = generatePlannedCognitionPath(params.practicePath, cognitionLayer); // vault-relative for display
  const markdown = generateCognitionMarkdown(ctx);
  const { support, contradictions } = buildEvidenceItems(ctx);
  const cases = buildCaseSummaries(ctx);
  const boundaries = extractBoundaries(ctx);
  const reviewTrigger = extractReviewTrigger(ctx);
  // Confidence MUST come from body `## Confidence` section, never from frontmatter
  const confidence = (parseConfidenceFromBody(ctx.practice.body) || 'medium') as DistillPreviewV1['confidence'];
  const status: DistillPreviewV1['status'] = allGatesPass(gateResults) ? 'preview' : 'not_ready';

  const preview: Omit<DistillPreviewV1, 'previewDigest'> = {
    version: 1,
    contract: 'distill-preview',
    status,
    practicePath: params.practicePath,
    plannedCognitionPath, // vault-relative configured path
    plannedMarkdown: markdown,
    gates: gateResults,
    cases,
    support,
    contradictions,
    independentCount: ctx.independentCases.filter(c => c.path !== ctx.practice.path).length,
    boundaries,
    confidence,
    reviewTrigger,
    warnings,
  };

  return { ...preview, previewDigest: computePreviewDigest(preview) };
}

export function runDistillPreview(params: DistillPreviewParams): DistillPreviewV1 {
  const { layout, layerNames } = resolveDistillLayout(params.vaultDir);
  const ctx = buildDistillContext(params.vaultDir, params.practicePath, layout, layerNames);

  // Build the cognition request for schema validation
  const cognitionPath = generateCognitionPath(params.practicePath);
  const cognitionMarkdown = generateCognitionMarkdown(ctx);

  // Call vault-write preview for schema-valid-destination gate
  let schemaPreviewStatus: string | null = null;
  try {
    const previewRequest: VaultWriteRequestV1 = {
      version: 1,
      layer: 'cognition',
      relativePath: cognitionPath,
      markdown: cognitionMarkdown,
      index: { mode: 'auto' },
      acknowledgeCognition: true,
    };
    const previewResult = executeVaultWrite(params.vaultDir, previewRequest, {
      pluginRoot: PLUGIN_ROOT,
      mode: 'preview',
    });
    schemaPreviewStatus = previewResult.status;
  } catch {
    schemaPreviewStatus = 'validation_failed';
  }

  // Run gates with the schema preview status
  const gateResults = runGates(ctx, params.gateNames, schemaPreviewStatus);

  const warnings: string[] = [];
  if (schemaPreviewStatus !== 'preview') {
    warnings.push(`Schema validation: vault-write preview returned "${schemaPreviewStatus}".`);
  }

  return buildPreview(params, ctx, gateResults, warnings);
}

// ── Apply orchestration ───────────────────────────────────────────────

export interface DistillApplyParams {
  vaultDir: string;
  practicePath: string;
  previewDigest: string;
  gateNames?: string[];
  /** Test-only hooks passed through to executeVaultWrite. */
  vaultWriteHooks?: VaultWriteHooks;
}

/**
 * Run distill apply.
 *
 * Calls executeVaultWrite in-process with an afterAuthoritativePlan callback.
 * The callback re-reads practices, re-runs gates, rebuilds the preview, and
 * verifies the digest matches — all under the vault-write lock. If anything
 * changed, it throws, causing vault-write to safely release the lock and
 * return INPUT_CHANGED.
 */
export function runDistillApply(params: DistillApplyParams): DistillResultV1 {
  const { layout, layerNames } = resolveDistillLayout(params.vaultDir);

  // Pre-lock: build context and preview to get the cognition request
  const ctx = buildDistillContext(params.vaultDir, params.practicePath, layout, layerNames);
  const cognitionPath = generateCognitionPath(params.practicePath);
  const cognitionMarkdown = generateCognitionMarkdown(ctx);
  const cognitionLayer = layerNames.cognition || 'cognition';
  const plannedCognitionPath = generatePlannedCognitionPath(params.practicePath, cognitionLayer);

  const cognitionRequest: VaultWriteRequestV1 = {
    version: 1,
    layer: 'cognition',
    relativePath: cognitionPath,
    markdown: cognitionMarkdown,
    index: { mode: 'auto' },
    acknowledgeCognition: true,
  };

  // Verify source Practices are byte-identical before locking
  const practiceAbsPath = path.join(params.vaultDir, params.practicePath);
  const preLockPracticeBytes = fs.readFileSync(practiceAbsPath);

  const result = executeVaultWrite(params.vaultDir, cognitionRequest, {
    pluginRoot: PLUGIN_ROOT,
    mode: 'write',
    hooks: params.vaultWriteHooks,
    afterAuthoritativePlan(_plan: PlannedWrite) {
      // Under the vault-write lock: re-verify everything

      // 1. Re-read the practice note (must be byte-identical)
      const currentBytes = fs.readFileSync(practiceAbsPath);
      if (!currentBytes.equals(preLockPracticeBytes)) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }

      // 2. Re-build context with fresh reads
      const freshCtx = buildDistillContext(params.vaultDir, params.practicePath, layout, layerNames);

      // 3. Re-build fresh markdown and compare to original cognition request
      const freshMarkdown = generateCognitionMarkdown(freshCtx);
      if (freshMarkdown !== cognitionRequest.markdown) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }

      // 4. Re-build logical relative path and compare
      const freshCognitionPath = generateCognitionPath(params.practicePath);
      if (freshCognitionPath !== cognitionRequest.relativePath) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }

      // 5. Compare PlannedWrite target vaultRelativePath to fresh planned configured path
      const freshPlannedCognitionPath = generatePlannedCognitionPath(params.practicePath, cognitionLayer);
      if (_plan.target.vaultRelativePath !== freshPlannedCognitionPath) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }

      // 6. Re-run schema validation
      let schemaPreviewStatus: string | null = null;
      try {
        const previewResult = executeVaultWrite(params.vaultDir, cognitionRequest, {
          pluginRoot: PLUGIN_ROOT,
          mode: 'preview',
        });
        schemaPreviewStatus = previewResult.status;
      } catch {
        schemaPreviewStatus = 'validation_failed';
      }

      // 7. Re-run gates
      const gateResults = runGates(freshCtx, params.gateNames, schemaPreviewStatus);

      // 8. Re-build preview and verify digest
      const freshPreview = buildPreview(
        { vaultDir: params.vaultDir, practicePath: params.practicePath, gateNames: params.gateNames },
        freshCtx,
        gateResults,
        [],
      );

      if (freshPreview.previewDigest !== params.previewDigest) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }

      if (!allGatesPass(gateResults)) {
        throw new DistillError('PREVIEW_DIGEST_MISMATCH');
      }
    },
  });

  return distillResultFromVaultWrite(result, params.previewDigest);
}

// ── Result conversion ─────────────────────────────────────────────────

function distillResultFromVaultWrite(
  vaultWriteResult: ReturnType<typeof executeVaultWrite>,
  previewDigest: string,
): DistillResultV1 {
  const distillStatus: DistillResultV1['status'] =
    vaultWriteResult.status === 'committed' ? 'committed'
    : vaultWriteResult.status === 'conflict' ? 'conflict'
    : vaultWriteResult.status === 'validation_failed' ? 'validation_failed'
    : vaultWriteResult.status === 'manual_recovery' ? 'manual_recovery'
    : 'validation_failed';

  // Map vault-write INPUT_CHANGED (from callback abort) to PREVIEW_DIGEST_MISMATCH
  let errorCode = vaultWriteResult.error?.code;
  let errorMessage = vaultWriteResult.error?.message;
  if (errorCode === 'INPUT_CHANGED' && vaultWriteResult.status === 'conflict') {
    errorCode = 'PREVIEW_DIGEST_MISMATCH';
    errorMessage = 'Preview digest does not match; vault state changed after preview.';
  }

  return {
    version: 1,
    status: distillStatus,
    operationId: vaultWriteResult.operationId || '',
    previewDigest,
    cognitionPath: vaultWriteResult.notePath,
    changedPaths: vaultWriteResult.changedPaths || [],
    plannedPaths: vaultWriteResult.plannedPaths || [],
    indexAction: (vaultWriteResult.indexAction as DistillResultV1['indexAction']) || 'none',
    warnings: vaultWriteResult.warnings || [],
    error: errorCode ? { code: errorCode, message: errorMessage || '' } : undefined,
    recoveryState: (vaultWriteResult.recoveryState as DistillResultV1['recoveryState']) || 'none',
    recoveries: (vaultWriteResult.recoveries || []) as VaultWriteRecovery[],
  };
}
