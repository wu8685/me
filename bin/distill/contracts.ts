/**
 * me:distill — Practice→Cognition evidence-gated promotion contracts (v1).
 *
 * Distill evaluates a practice note against deterministic gates, produces an
 * exact-preview with digest for confirmation, and writes via the shared
 * vault-write transaction executor under lock. Never auto-promotes; never
 * deletes or demotes source Practices.
 */

import type { VaultWriteRecovery } from '../vault-write/contracts';

export type DistillStatus =
  | 'not_ready'
  | 'preview'
  | 'conflict'
  | 'committed'
  | 'validation_failed'
  | 'manual_recovery';

export type GateVerdict = 'pass' | 'fail' | 'insufficient_data';

export type Confidence = 'low' | 'medium' | 'high';

/** Valid practice note types per me-schema-v1 practices profile. */
export const PRACTICE_TYPES = ['reflection', 'experiment'] as const;

export interface DistillGateResult {
  gate: string;
  verdict: GateVerdict;
  reason: string;
  detail?: string;
}

export interface DistillCaseSummary {
  /** Vault-relative path to the case note. */
  path: string;
  /** Short description of the case. */
  summary: string;
  /** Whether this case is independent of the primary practice. */
  independent: boolean;
  /** Why this case is (not) independent. */
  rationale: string;
}

export interface DistillEvidenceItem {
  /** Vault-relative path to the evidence note. */
  path: string;
  /** Kind: supporting or contradicting. */
  kind: 'support' | 'contradiction';
  /** Excerpt or summary of the evidence. */
  excerpt: string;
  /** Whether this evidence comes from an independent source. */
  independent: boolean;
}

export interface DistillPreviewV1 {
  version: 1;
  /** Contract identifier for digest binding. */
  contract: 'distill-preview';
  status: 'not_ready' | 'preview' | 'conflict';
  /** SHA-256 digest of the entire preview state for exact-preview confirmation. */
  previewDigest: string;
  practicePath: string;
  plannedCognitionPath: string;
  plannedMarkdown: string;
  gates: DistillGateResult[];
  cases: DistillCaseSummary[];
  support: DistillEvidenceItem[];
  contradictions: DistillEvidenceItem[];
  independentCount: number;
  boundaries: string[];
  confidence: Confidence;
  reviewTrigger: string;
  warnings: string[];
}

export interface DistillResultV1 {
  version: 1;
  status: DistillStatus;
  operationId: string;
  previewDigest: string;
  cognitionPath?: string;
  changedPaths: string[];
  plannedPaths: string[];
  indexAction: 'none' | 'create' | 'replace';
  warnings: string[];
  error?: { code: string; message: string };
  recoveryState: 'none' | 'retained-originals' | 'incomplete';
  /** Recovery actions preserved from vault-write; never discarded. */
  recoveries: VaultWriteRecovery[];
}

export interface ParsedNote {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
  created: string;
  tags: string[];
  type: string;
  /** Explicit project/task identity for independence detection. */
  project?: string;
  /** Source provenance (path-qualified wikilink). */
  source?: string;
}

export interface DistillContext {
  vaultDir: string;
  /** Resolved vault layout from vault-write. */
  layout: {
    lexicalVault: string;
    canonicalVault: string;
    meDir: string;
    layers: Record<string, string>;
  };
  /** Configured layer directory names (e.g. {raw: 'raw', practices: 'practices', cognition: 'cognition'}). */
  layerNames: Record<string, string>;
  practice: ParsedNote;
  linkedNotes: ParsedNote[];
  allPractices: ParsedNote[];
  independentCases: ParsedNote[];
  counterevidence: ParsedNote[];
}

export const DISTILL_ERROR_CODES = {
  INVALID_ARGUMENTS: { exitCode: 2, message: 'Invalid distill arguments.' },
  PRACTICE_NOT_FOUND: { exitCode: 2, message: 'Practice note not found.' },
  NOT_A_PRACTICE: { exitCode: 2, message: 'The specified note is not in the practices layer.' },
  PREVIEW_DIGEST_MISMATCH: { exitCode: 3, message: 'Preview digest does not match; vault state changed after preview.' },
  VAULT_WRITE_FAILED: { exitCode: 4, message: 'Vault write operation failed.' },
  INTERNAL_ERROR: { exitCode: 1, message: 'Distill could not complete safely.' },
} as const;

export type DistillErrorCode = keyof typeof DISTILL_ERROR_CODES;

export class DistillError extends Error {
  readonly code: DistillErrorCode;
  constructor(code: DistillErrorCode) {
    super(DISTILL_ERROR_CODES[code].message);
    this.name = 'DistillError';
    this.code = code;
  }
}

/** Configurable distill gates. */
export const DEFAULT_GATES = [
  'local-provenance',
  'multiple-independent-cases',
  'counterevidence-search',
  'no-unresolved-contradiction',
  'generalizes-beyond-task',
  'clear-boundaries',
  'justified-confidence',
  'review-trigger-set',
  'schema-valid-destination',
] as const;

export type GateName = (typeof DEFAULT_GATES)[number];

/** Cognition note frontmatter keys per me-schema-v1 cognition profile. */
export const COGNITION_FRONTMATTER_KEYS = [
  'title',
  'created',
  'tags',
  'type',
  'source',
  'confidence',
] as const;
