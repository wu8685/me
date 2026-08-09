/**
 * me:brief — claim ledger contract types (contract `claim-ledger` v1, report
 * contract `brief-ledger` v1).
 *
 * The claim taxonomy is authoritative for issue #14 and is intentionally kept
 * separate from the decision-brief Fact/Interpretation/Inference taxonomy and
 * the recall session-evidence kinds.
 */

export const CLAIM_TYPES = [
  'fact',
  'target',
  'verified_result',
  'inference',
  'correction',
  'recognition',
  'recommendation',
  'unknown',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const SOURCE_KINDS = ['vault', 'session', 'bundle'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const BRIEF_STRUCTURES = [
  'executive-report',
  'technical-narrative',
  'retrospective',
  'nomination',
  'summary',
] as const;
export type BriefStructure = (typeof BRIEF_STRUCTURES)[number];

export type FindingSeverity = 'error' | 'warning';

export interface BriefFinding {
  code: string;
  severity: FindingSeverity;
  claimId: string | null;
  sourceId: string | null;
  message: string;
  safeAlternative: string | null;
}

export interface BriefClaimSummary {
  id: string;
  type: ClaimType | string;
  flagged: boolean;
  supersededBy: string | null;
  effectiveText: string;
}

export interface BriefWordBudget {
  maxWords: number | null;
  words: number;
  withinBudget: boolean;
  missingDecisiveClaims: string[];
}

export interface BriefLedgerStats {
  claims: number;
  byType: Record<ClaimType, number>;
  sources: number;
  unauthorizedSources: number;
  findings: { error: number; warning: number };
}

export type BriefLedgerStatus = 'ok' | 'findings' | 'insufficient_evidence' | 'invalid';

export interface BriefLedgerReportV1 {
  version: 1;
  contract: 'brief-ledger';
  status: BriefLedgerStatus;
  generatedAt: string;
  brief: {
    topic: string;
    structure: string | null;
    maxWords: number | null;
    freshnessDays: number | null;
  };
  findings: BriefFinding[];
  claims: BriefClaimSummary[];
  supersededClaims: string[];
  contradictions: Array<{ a: string; b: string }>;
  wordBudget: BriefWordBudget | null;
  stats: BriefLedgerStats;
}
