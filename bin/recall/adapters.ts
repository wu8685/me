/**
 * me:recall orchestration: adapter registry, workspace authorization, bundle
 * assembly. Purely read-only; no writes, no network, no persistent index.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AdapterContext,
  RecallBundleV1,
  RecallCorrection,
  RecallStats,
  RecallTask,
  RecallWarning,
  SessionAdapter,
  SessionListing,
  SessionQuery,
} from './contracts';
import { redactText } from './redact';
import { scanCodexSessionDir } from './codex-local';
import { canonicalize } from './paths';

export interface RecallRunParams {
  vaultDir: string;
  query?: string;
  topic?: string | null;
  title?: string | null;
  after?: string | null;
  before?: string | null;
  workspace?: string | null;
  authorizeCrossWorkspace: boolean;
  adapterNames: string[];
  limit: number;
  sessionsDir?: string;
}

export function defaultSessionsDir(): string {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) return path.join(codexHome, 'sessions');
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.codex', 'sessions');
}

class CodexLocalAdapter implements SessionAdapter {
  readonly name = 'codex-local';
  readonly description = 'Local Codex session JSONL store (~/.codex/sessions)';
  readonly sessionSource = 'local';

  listSessions(query: SessionQuery, ctx: AdapterContext): SessionListing {
    const sessionsDir = query.options?.sessionsDir ?? defaultSessionsDir();
    return scanCodexSessionDir({
      sessionsDir,
      scopeWorkspace: query.workspace,
      query: query.text,
      topic: query.topic,
      title: query.title,
      after: query.after,
      before: query.before,
      limit: query.limit,
      warn: ctx.warn,
    });
  }
}

const ADAPTERS: SessionAdapter[] = [new CodexLocalAdapter()];

export function resolveAdapters(names: string[]): {
  active: SessionAdapter[];
  unsupported: string[];
  warnings: RecallWarning[];
} {
  const active: SessionAdapter[] = [];
  const unsupported: string[] = [];
  const warnings: RecallWarning[] = [];
  for (const name of names) {
    const found = ADAPTERS.find(a => a.name === name);
    if (found) {
      if (!active.includes(found)) active.push(found);
    } else {
      unsupported.push(name);
      warnings.push({
        code: 'ADAPTER_UNSUPPORTED',
        adapter: name,
        message: `Adapter "${name}" is not supported; no sessions were searched.`,
      });
    }
  }
  return { active, unsupported, warnings };
}

function mergeStats(target: RecallStats, src: RecallStats): void {
  target.sessionsScanned += src.sessionsScanned;
  target.sessionsInScope += src.sessionsInScope;
  target.recordsScanned += src.recordsScanned;
  target.malformedRecords += src.malformedRecords;
  target.truncatedRecords += src.truncatedRecords;
  target.coalescedDuplicates += src.coalescedDuplicates;
  for (const [k, v] of Object.entries(src.redactionTokens)) {
    target.redactionTokens[k] = (target.redactionTokens[k] || 0) + v;
  }
}

function resolved(p: string): boolean {
  try {
    fs.realpathSync(p);
    return true;
  } catch {
    return false;
  }
}

export function runRecall(params: RecallRunParams): RecallBundleV1 {
  const warnings: RecallWarning[] = [];
  const vaultCanonical = canonicalize(params.vaultDir);
  const requestedWorkspace = params.workspace ? canonicalize(params.workspace) : null;
  const crossWorkspace = requestedWorkspace !== null && requestedWorkspace !== vaultCanonical;

  let effectiveScope: string;
  let authorized: boolean;
  if (crossWorkspace && !params.authorizeCrossWorkspace) {
    // Fail closed: never search another workspace without explicit authorization.
    warnings.push({
      code: 'CROSS_WORKSPACE_UNAUTHORIZED',
      message:
        `Searching workspace "${requestedWorkspace}" requires --authorize-cross-workspace. ` +
        'No sessions from that workspace were searched.',
    });
    authorized = false;
    effectiveScope = requestedWorkspace!;
  } else {
    authorized = true;
    effectiveScope = requestedWorkspace ?? vaultCanonical;
  }

  const { active, unsupported, warnings: adapterWarnings } = resolveAdapters(params.adapterNames);
  warnings.push(...adapterWarnings);

  const stats: RecallStats = {
    sessionsScanned: 0,
    sessionsInScope: 0,
    recordsScanned: 0,
    malformedRecords: 0,
    truncatedRecords: 0,
    tasksMatched: 0,
    evidenceEmitted: 0,
    coalescedDuplicates: 0,
    redactionTokens: {},
  };

  const mergedTasks: RecallTask[] = [];
  const mergedCorrections: RecallCorrection[] = [];

  if (authorized) {
    for (const adapter of active) {
      const query: SessionQuery = {
        text: params.query,
        topic: params.topic ?? undefined,
        title: params.title ?? undefined,
        after: params.after ?? undefined,
        before: params.before ?? undefined,
        workspace: effectiveScope,
        limit: params.limit,
        options: params.sessionsDir ? { sessionsDir: params.sessionsDir } : undefined,
      };
      const ctx: AdapterContext = {
        redact: redactText,
        warn: w => warnings.push(w),
      };
      const listing = adapter.listSessions(query, ctx);
      mergedTasks.push(...listing.tasks);
      mergedCorrections.push(...listing.corrections);
      mergeStats(stats, listing.stats);
    }
  }

  // Coalesce root/child duplicate tasks by session id across adapters.
  const byTaskId = new Map<string, RecallTask>();
  for (const task of mergedTasks) {
    const existing = byTaskId.get(task.taskId);
    if (existing) {
      stats.coalescedDuplicates++;
      if (task.evidence.length > existing.evidence.length) byTaskId.set(task.taskId, task);
    } else {
      byTaskId.set(task.taskId, task);
    }
  }

  const tasks = [...byTaskId.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(0, params.limit);
  stats.tasksMatched = tasks.length;
  stats.evidenceEmitted = tasks.reduce((n, t) => n + t.evidence.length, 0);

  const keptIds = new Set(tasks.map(t => t.taskId));
  const corrections = mergedCorrections.filter(c => keptIds.has(c.taskId));

  return {
    version: 1,
    contract: 'session-evidence',
    generatedAt: new Date().toISOString(),
    query: {
      text: params.query ?? '',
      topic: params.topic ?? null,
      title: params.title ?? null,
      after: params.after ?? null,
      before: params.before ?? null,
      limit: params.limit,
    },
    scope: {
      workspace: {
        requested: params.workspace ?? params.vaultDir,
        canonical: effectiveScope,
        resolved: resolved(params.vaultDir),
        current: effectiveScope === vaultCanonical,
      },
      requestedWorkspace,
      crossWorkspace,
      authorized,
    },
    adapters: {
      requested: [...params.adapterNames],
      active: active.map(a => a.name),
      unsupported,
    },
    tasks,
    corrections,
    warnings,
    stats,
  };
}
