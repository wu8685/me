/**
 * me:recall — session evidence contract types (contract v1).
 *
 * The evidence kinds are authoritative for issue #10 and are intentionally
 * kept separate from the decision-brief Fact/Inference taxonomy.
 */

export const EVIDENCE_KINDS = [
  'user_statement',
  'agent_conclusion',
  'tool_result',
  'correction',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** conversation claims (user/agent/correction) vs tool facts. */
export type SourceCategory = 'conversation' | 'tool';

export interface RedactResult {
  text: string;
  redacted: boolean;
  tokens: Record<string, number>;
}

export interface RecallWarning {
  code: string;
  message: string;
  adapter?: string;
  details?: Record<string, unknown>;
}

export interface RecallProvenance {
  sessionId: string;
  threadId: string | null;
  sourcePath: string;
  recordIndex: number;
  recordType: string;
  payloadType: string | null;
}

export interface RecallEvidence {
  key: string;
  kind: EvidenceKind;
  sourceCategory: SourceCategory;
  at: string;
  text: string;
  redacted: boolean;
  truncated: boolean;
  provenance: RecallProvenance;
  supersedes: string | null;
  detection: string | null;
}

export interface RecallTask {
  taskId: string;
  sessionId: string;
  adapter: string;
  workspace: string;
  derivedTitle: string;
  titleLabel: 'derived';
  startedAt: string;
  endedAt: string | null;
  sources: string[];
  evidenceCount: number;
  evidence: RecallEvidence[];
  evidenceTruncated: boolean;
}

export interface RecallCorrection {
  key: string;
  taskId: string;
  at: string;
  text: string;
  supersedes: string | null;
  supersededBy: string | null;
  conflicts: boolean;
}

export interface RecallStats {
  sessionsScanned: number;
  sessionsInScope: number;
  recordsScanned: number;
  malformedRecords: number;
  truncatedRecords: number;
  tasksMatched: number;
  evidenceEmitted: number;
  coalescedDuplicates: number;
  redactionTokens: Record<string, number>;
}

export interface RecallScope {
  workspace: {
    requested: string;
    canonical: string;
    resolved: boolean;
    current: boolean;
  };
  requestedWorkspace: string | null;
  crossWorkspace: boolean;
  authorized: boolean;
}

export interface RecallBundleV1 {
  version: 1;
  contract: 'session-evidence';
  generatedAt: string;
  query: {
    text: string;
    topic: string | null;
    title: string | null;
    after: string | null;
    before: string | null;
    limit: number;
  };
  scope: RecallScope;
  adapters: {
    requested: string[];
    active: string[];
    unsupported: string[];
  };
  tasks: RecallTask[];
  corrections: RecallCorrection[];
  warnings: RecallWarning[];
  stats: RecallStats;
}

/** Narrow, additive adapter interface: one method, no shared mutable state. */
export interface SessionQuery {
  text?: string;
  topic?: string;
  title?: string;
  after?: string;
  before?: string;
  /** Effective workspace scope (canonical root) the adapter must filter to. */
  workspace: string;
  limit: number;
  /** Adapter-specific options, e.g. `{ sessionsDir }`. */
  options?: Record<string, string>;
}

export interface AdapterContext {
  redact(text: string): RedactResult;
  warn(warning: RecallWarning): void;
}

export interface SessionListing {
  tasks: RecallTask[];
  corrections: RecallCorrection[];
  stats: RecallStats;
}

export interface SessionAdapter {
  readonly name: string;
  readonly description: string;
  readonly sessionSource: string;
  listSessions(query: SessionQuery, ctx: AdapterContext): SessionListing;
}
