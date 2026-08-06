/**
 * Codex local-session adapter for me:recall.
 *
 * Scans the Codex session store (`~/.codex/sessions`, overridable with
 * `sessionsDir`) for JSONL session files and extracts bounded, redacted,
 * task-level session evidence. Strictly read-only.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  EvidenceKind,
  RecallCorrection,
  RecallEvidence,
  RecallProvenance,
  RecallTask,
  RecallWarning,
  RedactResult,
  SessionListing,
  SourceCategory,
} from './contracts';
import { redactText } from './redact';
import { canonicalize, isPathWithin } from './paths';

export const EVIDENCE_TEXT_MAX = 400;
export const DERIVED_TITLE_MAX = 120;
export const MAX_EVIDENCE_PER_TASK = 20;

interface CodexContentPart {
  type?: string;
  text?: string;
}

interface CodexRecordPayload {
  type?: string;
  message?: string;
  role?: string;
  content?: CodexContentPart[];
  session_id?: string;
  id?: string;
  cwd?: string;
  workspace_roots?: unknown;
  name?: string;
  input?: unknown;
  arguments?: string;
  call_id?: string;
  output?: string;
  thread_id?: string;
  parent_thread_id?: string;
  thread_source?: string;
  source?: unknown;
  phase?: string;
  invocation?: { server?: string; tool?: string; arguments?: unknown };
  result?: unknown;
}

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: CodexRecordPayload;
}

/** Internal evidence carries an untruncated redacted match text and speaker. */
interface MutableEvidence extends Omit<RecallEvidence, 'text' | 'truncated'> {
  _matchText: string;
  _speaker: 'user' | 'agent' | 'tool';
  _recordIndex: number;
  /** Normalized ORIGINAL text (pre-redaction) used for cross-file root/child dedup. */
  _dedupKey?: string;
}

interface FileScanResult {
  task: RecallTask | null;
  corrections: RecallCorrection[];
  inScope: boolean;
  recordsScanned: number;
  malformedRecords: number;
  truncatedRecords: number;
  coalesced: number;
  redactionTokens: Record<string, number>;
  /** Unique session id of this file's session (rollout id). */
  sessionId: string;
  /** Thread the session belongs to (Codex thread/session id, or explicit thread_id). */
  threadId: string | null;
  /** Parent thread id when this session is a subagent child, else null. */
  parentThreadId: string | null;
  isSubagent: boolean;
  depth: number | null;
  agentPath: string | null;
  agentNickname: string | null;
  /** Internal evidence retained so thread clusters can be re-merged and deduped. */
  internalEvidence: MutableEvidence[];
}

interface ScanOptions {
  scopeWorkspace: string;
  query?: string;
  topic?: string;
  title?: string;
  after?: string;
  before?: string;
  limit: number;
  redact: (text: string) => RedactResult;
  warn: (warning: RecallWarning) => void;
}

export function parseJsonlLine(
  line: string,
): { ok: true; record: CodexRecord } | { ok: false; error: string } {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, error: 'empty line' };
  try {
    return { ok: true, record: JSON.parse(trimmed) as CodexRecord };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const CORRECTION_PATTERNS: RegExp[] = [
  /^(?:correction|correcting|to correct|let me correct)\b[\s\:：\-—]/i,
  /^(?:on second thought|scratch that|never mind|nevermind)\b[\s,，.\-—]?/i,
  /^(?:i was wrong|i was mistaken|i was incorrect|that'?s wrong|that was wrong|that'?s incorrect)\b/i,
  /^(?:actually|wait|hold on)\b[\s,，\-—]/i,
  /^(?:ignore|disregard|forget)\s+(?:my|the|that)\s+(?:previous|last|earlier)\b/i,
  /^(?:更正|纠正|修正|其实|不对|等等|改一下|我说错了|我讲错了)/,
];

/**
 * Deterministic, marker-based correction detection. Heuristic by design; the
 * output labels `detection: "correction-marker"` so consumers know it is not
 * an authoritative semantic classification.
 */
export function isCorrection(text: string): boolean {
  for (const re of CORRECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function safeStringify(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

function inWindow(at: string, after?: string, before?: string): boolean {
  if (!at) return false;
  if (after && at < after) return false;
  if (before && at > before) return false;
  return true;
}

/**
 * System-injected developer/user content is untrusted data and is never
 * treated as a user statement. Real Codex sessions inject permissions blocks,
 * AGENTS.md/CLAUDE.md instruction dumps, `<environment_context>`, and
 * recommended_plugins payloads into user-role records — all of those must be
 * skipped, not surfaced as evidence.
 */
function isSystemInjectedText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^<[a-z_]+>/.test(t)) return true;
  if (/^<permissions/i.test(t)) return true;
  if (/^# AGENTS(?:\.[A-Za-z]+)? instructions/i.test(t)) return true;
  if (/^# CLAUDE\.md instructions/i.test(t)) return true;
  if (/<INSTRUCTIONS>/.test(t)) return true;
  if (/recommended_plugins/.test(t)) return true;
  return false;
}

function responseUserText(record: CodexRecord): string | null {
  const p = record.payload;
  if (!p || !Array.isArray(p.content)) return null;
  const parts: string[] = [];
  for (const c of p.content) {
    if (!c || c.type !== 'input_text' || typeof c.text !== 'string') continue;
    const trimmed = c.text.trim();
    if (!trimmed) continue;
    if (isSystemInjectedText(trimmed)) continue; // injected parts are skipped, real user text is kept
    parts.push(trimmed);
  }
  return parts.join(' ') || null;
}

/**
 * Extract assistant text from a response_item message. Real Codex assistant
 * content parts use `type: "output_text"`; legacy parts may use `input_text`.
 * (The dead `agent_message` branch was removed — response_item assistant
 * records are always `type: "message", role: "assistant"`.)
 */
function responseAssistantText(record: CodexRecord): string | null {
  const p = record.payload;
  if (!p || p.type !== 'message' || p.role !== 'assistant' || !Array.isArray(p.content)) {
    return null;
  }
  const parts: string[] = [];
  for (const c of p.content) {
    if (!c || typeof c.text !== 'string') continue;
    if (c.type !== 'output_text' && c.type !== 'input_text') continue;
    const t = c.text.trim();
    if (t) parts.push(t);
  }
  return parts.join(' ') || null;
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function buildCorrections(taskId: string, evidence: RecallEvidence[]): RecallCorrection[] {
  const corrections: RecallCorrection[] = evidence
    .filter(e => e.kind === 'correction')
    .map(e => ({
      key: e.key,
      taskId,
      at: e.at,
      text: e.text,
      supersedes: e.supersedes,
      supersededBy: null,
      conflicts: false,
    }));
  for (const c of corrections) {
    const later = corrections.find(o => o.supersedes === c.key && o.key !== c.key);
    if (later) c.supersededBy = later.key;
  }
  // A correction "conflicts" when a later correction supersedes it.
  for (const c of corrections) c.conflicts = c.supersededBy !== null;
  return corrections;
}

function taskMatches(
  query: string | undefined,
  topic: string | undefined,
  title: string | undefined,
  derivedTitle: string,
  evidence: MutableEvidence[],
): boolean {
  if (query) {
    const q = query.toLowerCase();
    if (!derivedTitle.toLowerCase().includes(q) && !evidence.some(e => e._matchText.toLowerCase().includes(q))) {
      return false;
    }
  }
  if (topic) {
    const t = topic.toLowerCase();
    if (!evidence.some(e => e._matchText.toLowerCase().includes(t))) return false;
  }
  if (title) {
    if (!derivedTitle.toLowerCase().includes(title.toLowerCase())) return false;
  }
  return true;
}

function scanSessionFile(file: string, opts: ScanOptions): FileScanResult {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      task: null,
      corrections: [],
      inScope: false,
      recordsScanned: 0,
      malformedRecords: 0,
      truncatedRecords: 0,
      coalesced: 0,
      redactionTokens: {},
      sessionId: '',
      threadId: null,
      parentThreadId: null,
      isSubagent: false,
      depth: null,
      agentPath: null,
      agentNickname: null,
      internalEvidence: [],
    };
  }

  const lines = content.split('\n');
  let sessionId = '';
  let threadId: string | null = null;
  let parentThreadId: string | null = null;
  let isSubagent = false;
  let depth: number | null = null;
  let agentPath: string | null = null;
  let agentNickname: string | null = null;
  let cwd: string | null = null;
  const workspaceRoots: string[] = [];
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let recordsScanned = 0;
  let malformedRecords = 0;
  let truncatedRecords = 0;
  let scoped = false;
  let excluded = false;
  let coalesced = 0;
  const evidence: MutableEvidence[] = [];
  const toolCalls = new Map<string, MutableEvidence>();
  const seenUserTexts = new Set<string>();
  const seenAgentTexts = new Set<string>();

  // Index of the last non-empty line; a final line that fails to parse is a
  // truncated record (cut-off JSONL) rather than a malformed line in the middle.
  let lastNonEmptyIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastNonEmptyIndex = i;
      break;
    }
  }

  const workspaceInScope = (): boolean =>
    workspaceRoots.some(r => canonicalize(r) === canonicalize(opts.scopeWorkspace));

  const makeBaseEvidence = (
    at: string,
    recordIndex: number,
    recordType: string,
    payloadType: string,
  ): MutableEvidence => ({
    key: '',
    kind: 'user_statement',
    sourceCategory: 'conversation',
    at,
    text: '',
    _matchText: '',
    redacted: false,
    truncated: false,
    provenance: {
      sessionId: '',
      threadId: null,
      sourcePath: file,
      recordIndex,
      recordType,
      payloadType,
    },
    supersedes: null,
    detection: null,
    _speaker: 'user',
    _recordIndex: recordIndex,
  });

  const addUserStatement = (
    text: string,
    at: string,
    recordIndex: number,
    recordType: string,
    payloadType: string,
  ): void => {
    // Coalesce on the original text, not the redacted form: two different
    // secrets must not collapse into one statement.
    const norm = singleLine(text);
    if (!norm) return;
    if (seenUserTexts.has(norm)) {
      coalesced++;
      return;
    }
    seenUserTexts.add(norm);
    const red = opts.redact(text);
    const kind: EvidenceKind = isCorrection(red.text) ? 'correction' : 'user_statement';
    const ev = makeBaseEvidence(at, recordIndex, recordType, payloadType);
    ev.kind = kind;
    ev._speaker = 'user';
    ev.sourceCategory = 'conversation';
    ev._matchText = red.text;
    ev._dedupKey = norm;
    ev.redacted = red.redacted;
    ev.detection = kind === 'correction' ? 'correction-marker' : null;
    evidence.push(ev);
  };

  const addAgentConclusion = (
    text: string,
    at: string,
    recordIndex: number,
    recordType: string,
    payloadType: string,
  ): void => {
    const norm = singleLine(text);
    if (!norm) return;
    if (seenAgentTexts.has(norm)) {
      coalesced++;
      return;
    }
    seenAgentTexts.add(norm);
    const red = opts.redact(text);
    const kind: EvidenceKind = isCorrection(red.text) ? 'correction' : 'agent_conclusion';
    const ev = makeBaseEvidence(at, recordIndex, recordType, payloadType);
    ev.kind = kind;
    ev._speaker = 'agent';
    ev.sourceCategory = 'conversation';
    ev._matchText = red.text;
    ev._dedupKey = norm;
    ev.redacted = red.redacted;
    ev.detection = kind === 'correction' ? 'correction-marker' : null;
    evidence.push(ev);
  };

  const addToolResult = (
    matchText: string,
    at: string,
    recordIndex: number,
    redacted: boolean,
    callId: string,
  ): void => {
    const ev = makeBaseEvidence(at, recordIndex, 'response_item', 'custom_tool_call');
    ev.kind = 'tool_result';
    ev._speaker = 'tool';
    ev.sourceCategory = 'tool';
    ev._matchText = matchText;
    ev.redacted = redacted;
    if (callId) toolCalls.set(callId, ev);
    evidence.push(ev);
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    recordsScanned++;
    const parsed = parseJsonlLine(line);
    if (!parsed.ok) {
      if (idx === lastNonEmptyIndex) truncatedRecords++;
      else malformedRecords++;
      continue;
    }
    const record = parsed.record;
    const at = record.timestamp || '';
    if (at) {
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
    }
    const p = record.payload || {};

    switch (record.type) {
      case 'session_meta': {
        // `id` is the unique rollout/session id. `session_id` is the thread id:
        // for a root session id === session_id; for a subagent child, session_id
        // is the PARENT thread id while `id` is the child's own session id.
        sessionId = (p.id as string) || (p.session_id as string) || '';
        threadId = (p.thread_id as string) || (p.session_id as string) || sessionId || null;
        if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
        if (!startedAt && record.timestamp) startedAt = record.timestamp;
        // Subagent relation: real Codex metadata lives in payload.source.subagent
        // .thread_spawn.parent_thread_id (with depth/agent_path/agent_nickname),
        // and thread_source === "subagent". Accept a payload-level parent_thread_id
        // as a fallback.
        const src = p.source;
        if (src && typeof src === 'object' && !Array.isArray(src)) {
          const sub = (src as Record<string, unknown>).subagent;
          if (sub && typeof sub === 'object') {
            const spawn = (sub as Record<string, unknown>).thread_spawn;
            if (spawn && typeof spawn === 'object') {
              const s = spawn as Record<string, unknown>;
              if (typeof s.parent_thread_id === 'string') parentThreadId = s.parent_thread_id;
              if (typeof s.depth === 'number') depth = s.depth;
              if (typeof s.agent_path === 'string') agentPath = s.agent_path;
              if (typeof s.agent_nickname === 'string') agentNickname = s.agent_nickname;
            }
          }
        }
        if (parentThreadId === null && typeof p.parent_thread_id === 'string') {
          parentThreadId = p.parent_thread_id;
        }
        isSubagent = p.thread_source === 'subagent' || parentThreadId !== null ||
          (src !== null && typeof src === 'object' && !Array.isArray(src) &&
            (src as Record<string, unknown>).subagent !== undefined);
        break;
      }
      case 'turn_context': {
        if (Array.isArray(p.workspace_roots)) {
          for (const r of p.workspace_roots) {
            if (typeof r === 'string' && !workspaceRoots.includes(r)) workspaceRoots.push(r);
          }
        }
        if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
        break;
      }
      case 'event_msg': {
        if (p.type === 'task_started') {
          if (!startedAt && record.timestamp) startedAt = record.timestamp;
        } else if (p.type === 'task_complete') {
          if (record.timestamp) endedAt = record.timestamp;
        } else if (p.type === 'user_message') {
          if (typeof p.message === 'string') {
            const text = p.message.trim();
            if (text && !isSystemInjectedText(text)) {
              addUserStatement(text, at, idx, 'event_msg', 'user_message');
            }
          }
        } else if (p.type === 'agent_message') {
          if (typeof p.message === 'string') {
            const text = p.message.trim();
            if (text) addAgentConclusion(text, at, idx, 'event_msg', 'agent_message');
          }
        } else if (p.type === 'mcp_tool_call_end') {
          const invocation = p.invocation;
          const name = invocation && typeof invocation.tool === 'string' ? invocation.tool : 'mcp';
          const raw = p.result !== undefined ? safeStringify(p.result) : '';
          const red = opts.redact(raw.slice(0, 4000));
          const matchText = `tool ${name}${red.text ? `\noutput: ${red.text}` : ''}`;
          addToolResult(matchText, at, idx, red.redacted, '');
        }
        break;
      }
      case 'response_item': {
        if (p.type === 'message') {
          if (p.role === 'user') {
            const text = responseUserText(record);
            if (text) addUserStatement(text, at, idx, 'response_item', 'message');
          } else if (p.role === 'assistant') {
            const text = responseAssistantText(record);
            if (text) addAgentConclusion(text, at, idx, 'response_item', 'message');
          }
          // role 'developer' carries system instructions and is skipped.
        } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
          const name = typeof p.name === 'string' ? p.name : 'tool';
          const callId = typeof p.call_id === 'string' ? p.call_id : '';
          let inputText = '';
          if (p.type === 'custom_tool_call' && p.input !== undefined) {
            inputText = safeStringify(p.input);
          } else if (p.type === 'function_call' && typeof p.arguments === 'string') {
            inputText = p.arguments;
          }
          const red = opts.redact(inputText);
          const matchText = `tool ${name}${inputText ? `\ninput: ${red.text}` : ''}`;
          addToolResult(matchText, at, idx, red.redacted, callId);
        } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
          const callId = typeof p.call_id === 'string' ? p.call_id : '';
          const output = typeof p.output === 'string' ? p.output : '';
          const red = opts.redact(output);
          const call = callId ? toolCalls.get(callId) : undefined;
          if (call) {
            call._matchText += `\noutput: ${red.text}`;
            call.redacted = call.redacted || red.redacted;
          } else {
            const matchText = `tool output: ${red.text}`;
            addToolResult(matchText, at, idx, red.redacted, '');
          }
        }
        break;
      }
      default:
        break;
    }

    // Early scope exit: once workspace_roots resolve and none match the scope,
    // the session is provably out of scope and we can stop. `cwd` is NOT used
    // for early exit — a later turn_context may carry the authoritative
    // workspace_roots even when session_meta.cwd is outside the scope.
    if (!excluded && !scoped) {
      if (workspaceRoots.length > 0) {
        if (workspaceInScope()) scoped = true;
        else {
          excluded = true;
          break;
        }
      }
    }
  }

  // Structured warnings for damaged sources: malformed lines and truncated
  // trailing records are skipped safely, never fatal.
  if (malformedRecords > 0) {
    opts.warn({
      code: 'MALFORMED_RECORD',
      adapter: 'codex-local',
      message: `${malformedRecords} malformed record(s) skipped in ${file}`,
      details: { sourcePath: file, count: malformedRecords },
    });
  }
  if (truncatedRecords > 0) {
    opts.warn({
      code: 'TRUNCATED_RECORD',
      adapter: 'codex-local',
      message: `Truncated trailing record skipped in ${file}`,
      details: { sourcePath: file },
    });
  }

  // Post-loop scope resolution for files that never produced workspace roots.
  let inScope = scoped;
  if (!inScope && !excluded) {
    if (workspaceRoots.length > 0) inScope = workspaceInScope();
    else if (cwd) inScope = isPathWithin(cwd, opts.scopeWorkspace);
    else inScope = false;
  }

  if (!inScope) {
    return {
      task: null,
      corrections: [],
      inScope,
      recordsScanned,
      malformedRecords,
      truncatedRecords,
      coalesced,
      redactionTokens: {},
      sessionId,
      threadId,
      parentThreadId,
      isSubagent,
      depth,
      agentPath,
      agentNickname,
      internalEvidence: [],
    };
  }

  const fileSessionId = sessionId || path.basename(file, '.jsonl');
  const taskId = fileSessionId;
  for (const ev of evidence) {
    // Keys stay globally unique across a thread cluster because fileSessionId is
    // unique per file (for subagents, `id` differs while `session_id` is shared).
    ev.key = `${fileSessionId}:${ev.provenance.recordIndex}`;
    ev.provenance.sessionId = fileSessionId;
    ev.provenance.threadId = threadId;
  }

  // Correction supersession: a correction supersedes the most recent prior
  // conversation claim by the same speaker (user or agent).
  for (let i = 0; i < evidence.length; i++) {
    const ev = evidence[i];
    if (ev.kind !== 'correction') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = evidence[j];
      if (prev._speaker === ev._speaker && prev.kind !== 'tool_result') {
        ev.supersedes = prev.key;
        break;
      }
    }
  }

  const filtered = evidence.filter(e => inWindow(e.at, opts.after, opts.before));
  // A task is included only if at least one evidence record falls inside the
  // time window; an empty filtered set means the task does not intersect it.
  if (filtered.length === 0) {
    return {
      task: null,
      corrections: [],
      inScope,
      recordsScanned,
      malformedRecords,
      truncatedRecords,
      coalesced,
      redactionTokens: {},
      sessionId,
      threadId,
      parentThreadId,
      isSubagent,
      depth,
      agentPath,
      agentNickname,
      internalEvidence: [],
    };
  }
  const firstUser = evidence.find(e => e._speaker === 'user');
  const derivedTitle = firstUser
    ? truncateText(singleLine(firstUser._matchText), DERIVED_TITLE_MAX).text
    : '';

  if (!taskMatches(opts.query, opts.topic, opts.title, derivedTitle, filtered)) {
    return {
      task: null,
      corrections: [],
      inScope,
      recordsScanned,
      malformedRecords,
      truncatedRecords,
      coalesced,
      redactionTokens: {},
      sessionId,
      threadId,
      parentThreadId,
      isSubagent,
      depth,
      agentPath,
      agentNickname,
      internalEvidence: [],
    };
  }

  let shown = filtered;
  let evidenceTruncated = false;
  if (shown.length > MAX_EVIDENCE_PER_TASK) {
    shown = shown.slice(0, MAX_EVIDENCE_PER_TASK);
    evidenceTruncated = true;
  }

  const publicEvidence: RecallEvidence[] = shown.map(ev => {
    const bounded = truncateText(ev._matchText, EVIDENCE_TEXT_MAX);
    return {
      key: ev.key,
      kind: ev.kind,
      sourceCategory: ev.sourceCategory as SourceCategory,
      at: ev.at,
      text: bounded.text,
      redacted: ev.redacted,
      truncated: bounded.truncated,
      provenance: ev.provenance,
      supersedes: ev.supersedes,
      detection: ev.detection,
    };
  });

  const corrections = buildCorrections(taskId, publicEvidence);
  const sessionWorkspace =
    workspaceRoots.find(r => canonicalize(r) === canonicalize(opts.scopeWorkspace)) ||
    opts.scopeWorkspace;

  const task: RecallTask = {
    taskId,
    sessionId: taskId,
    adapter: 'codex-local',
    workspace: sessionWorkspace,
    derivedTitle,
    titleLabel: 'derived',
    startedAt: startedAt || firstAt || '',
    endedAt: endedAt || lastAt,
    sources: [file],
    evidenceCount: publicEvidence.length,
    evidence: publicEvidence,
    evidenceTruncated,
  };

  const redactionTokens: Record<string, number> = {};
  for (const ev of evidence) {
    for (const [k, v] of Object.entries(countTokens(ev._matchText, ev.redacted))) {
      redactionTokens[k] = (redactionTokens[k] || 0) + v;
    }
  }

  return {
    task,
    corrections,
    inScope,
    recordsScanned,
    malformedRecords,
    truncatedRecords,
    coalesced,
    redactionTokens,
    sessionId,
    threadId,
    parentThreadId,
    isSubagent,
    depth,
    agentPath,
    agentNickname,
    internalEvidence: evidence,
  };
}

/**
 * Returns the redaction token counts already embedded in a text. Because
 * redaction tokens are static labels, we recount the markers that appear.
 */
function countTokens(text: string, redacted: boolean): Record<string, number> {
  if (!redacted) return {};
  const tokens: Record<string, number> = {};
  const re = /\[REDACTED:([a-z-]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens[m[1]] = (tokens[m[1]] || 0) + 1;
  }
  return tokens;
}

export interface ScanCodexOptions {
  sessionsDir: string;
  scopeWorkspace: string;
  query?: string;
  topic?: string;
  title?: string;
  after?: string;
  before?: string;
  limit: number;
  warn: (warning: RecallWarning) => void;
  redactor?: (text: string) => RedactResult;
}

/**
 * Thread cluster key for a scanned session. A session belongs to its thread:
 * a root session's threadId is its own id/session_id, while a subagent child's
 * threadId is the PARENT thread id. Fall back to the parent relation, then the
 * per-file task id / session id.
 */
function threadClusterKey(r: FileScanResult): string {
  return r.threadId || r.parentThreadId || r.task?.taskId || r.sessionId;
}

interface MergedCluster {
  task: RecallTask | null;
  corrections: RecallCorrection[];
  extraCoalesced: number;
}

/**
 * Merge a thread cluster (root + subagent children) into one task.
 *
 * - The copied root prompt that appears in each child session is counted once
 *   (cross-file dedup keyed on the ORIGINAL normalized text so distinct secrets
 *   never collapse).
 * - Genuinely distinct child evidence is retained, each with its own
 *   per-record provenance (sessionId, sourcePath, recordIndex).
 * - All member source paths are retained in `sources`.
 * - Tool facts are never cross-deduped.
 */
function buildTaskFromMembers(members: FileScanResult[], opts: ScanOptions): MergedCluster {
  // Single-file tasks keep the per-file result exactly (behavior preserved).
  if (members.length === 1) {
    const m = members[0];
    return { task: m.task!, corrections: m.corrections, extraCoalesced: 0 };
  }

  // Root member: the non-subagent member, else the first.
  const root = members.find(m => !m.isSubagent) ?? members[0];
  const rootTask = root.task!;
  const taskId = rootTask.taskId || root.threadId || members[0].task!.taskId;

  // Flatten internal evidence, apply the time window, then cross-file dedup.
  const raw: MutableEvidence[] = [];
  for (const member of members) {
    for (const ev of member.internalEvidence) {
      if (!inWindow(ev.at, opts.after, opts.before)) continue;
      raw.push(ev);
    }
  }
  if (raw.length === 0) return { task: null, corrections: [], extraCoalesced: 0 };

  // Sort chronologically BEFORE dedup so the earliest occurrence (the root's
  // copy of the prompt) is kept rather than a child copy walked first.
  raw.sort((a, b) => a.at.localeCompare(b.at));
  const seen = new Map<string, true>();
  const merged: MutableEvidence[] = [];
  for (const ev of raw) {
    const key = ev._dedupKey !== undefined ? `${ev.kind}|${ev._dedupKey}` : null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.set(key, true);
    }
    merged.push(ev);
  }
  const extraCoalesced = raw.length - merged.length;
  merged.sort((a, b) => a.at.localeCompare(b.at));

  // Recompute supersession on merged evidence so references never dangle.
  for (let i = 0; i < merged.length; i++) {
    const ev = merged[i];
    ev.supersedes = null;
    if (ev.kind !== 'correction') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = merged[j];
      if (prev._speaker === ev._speaker && prev.kind !== 'tool_result') {
        ev.supersedes = prev.key;
        break;
      }
    }
  }

  let shown = merged;
  let evidenceTruncated = false;
  if (shown.length > MAX_EVIDENCE_PER_TASK) {
    shown = shown.slice(0, MAX_EVIDENCE_PER_TASK);
    evidenceTruncated = true;
  }

  const publicEvidence: RecallEvidence[] = shown.map(ev => {
    const bounded = truncateText(ev._matchText, EVIDENCE_TEXT_MAX);
    return {
      key: ev.key,
      kind: ev.kind,
      sourceCategory: ev.sourceCategory as SourceCategory,
      at: ev.at,
      text: bounded.text,
      redacted: ev.redacted,
      truncated: bounded.truncated,
      provenance: ev.provenance,
      supersedes: ev.supersedes,
      detection: ev.detection,
    };
  });

  const firstUser = merged.find(e => e._speaker === 'user');
  const derivedTitle = firstUser
    ? truncateText(singleLine(firstUser._matchText), DERIVED_TITLE_MAX).text
    : '';

  const sources = [...new Set(members.map(m => m.task!.sources[0]))];
  const startedAt =
    members
      .map(m => m.task!.startedAt)
      .filter(Boolean)
      .sort()[0] ?? '';
  const endedAt =
    members
      .map(m => m.task!.endedAt)
      .filter((v): v is string => v !== null)
      .sort()
      .pop() ?? null;

  const corrections = buildCorrections(taskId, publicEvidence);
  const task: RecallTask = {
    taskId,
    sessionId: taskId,
    adapter: 'codex-local',
    workspace: rootTask.workspace,
    derivedTitle,
    titleLabel: 'derived',
    startedAt,
    endedAt,
    sources,
    evidenceCount: publicEvidence.length,
    evidence: publicEvidence,
    evidenceTruncated,
  };
  return { task, corrections, extraCoalesced };
}

export function scanCodexSessionDir(opts: ScanCodexOptions): SessionListing {
  if (!fs.existsSync(opts.sessionsDir)) {
    opts.warn({
      code: 'SESSIONS_DIR_NOT_FOUND',
      message: `Codex sessions directory not found: ${opts.sessionsDir}`,
    });
    return {
      tasks: [],
      corrections: [],
      stats: {
        sessionsScanned: 0,
        sessionsInScope: 0,
        recordsScanned: 0,
        malformedRecords: 0,
        truncatedRecords: 0,
        tasksMatched: 0,
        evidenceEmitted: 0,
        coalescedDuplicates: 0,
        redactionTokens: {},
      },
    };
  }

  const redact = opts.redactor ?? redactText;
  const scanOpts: ScanOptions = {
    scopeWorkspace: opts.scopeWorkspace,
    query: opts.query,
    topic: opts.topic,
    title: opts.title,
    after: opts.after,
    before: opts.before,
    limit: opts.limit,
    redact,
    warn: opts.warn,
  };

  const files = walkJsonl(opts.sessionsDir);
  const results: FileScanResult[] = [];
  const stats = {
    sessionsScanned: files.length,
    sessionsInScope: 0,
    recordsScanned: 0,
    malformedRecords: 0,
    truncatedRecords: 0,
    tasksMatched: 0,
    evidenceEmitted: 0,
    coalescedDuplicates: 0,
    redactionTokens: {} as Record<string, number>,
  };

  for (const file of files) {
    const result = scanSessionFile(file, scanOpts);
    stats.recordsScanned += result.recordsScanned;
    stats.malformedRecords += result.malformedRecords;
    stats.truncatedRecords += result.truncatedRecords;
    stats.coalescedDuplicates += result.coalesced;
    if (result.inScope) stats.sessionsInScope++;
    if (result.task) results.push(result);
    for (const [k, v] of Object.entries(result.redactionTokens)) {
      stats.redactionTokens[k] = (stats.redactionTokens[k] || 0) + v;
    }
  }

  // Cluster sessions by thread so a subagent child folds into its parent task
  // (the copied root prompt is counted once, distinct child evidence retained).
  const clusters = new Map<string, FileScanResult[]>();
  for (const result of results) {
    const key = threadClusterKey(result);
    const list = clusters.get(key);
    if (list) list.push(result);
    else clusters.set(key, [result]);
  }

  const tasks: RecallTask[] = [];
  const corrections: RecallCorrection[] = [];
  for (const members of clusters.values()) {
    // Merge only when a non-subagent root is present in the cluster: the root
    // anchors the thread, so the copied root prompt in each child is deduped
    // and the children fold into the root task. Without a root, sibling
    // subagent sessions are genuinely distinct sessions and stay separate.
    const hasRoot = members.some(m => !m.isSubagent);
    if (hasRoot && members.length > 1) {
      const merged = buildTaskFromMembers(members, scanOpts);
      if (!merged.task) continue;
      tasks.push(merged.task);
      corrections.push(...merged.corrections);
      stats.coalescedDuplicates += (members.length - 1) + merged.extraCoalesced;
    } else {
      for (const m of members) {
        tasks.push(m.task!);
        corrections.push(...m.corrections);
      }
    }
  }

  tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const sliced = tasks.slice(0, opts.limit);
  const keptIds = new Set(sliced.map(t => t.taskId));
  const keptCorrections = corrections.filter(c => keptIds.has(c.taskId));

  return {
    tasks: sliced,
    corrections: keptCorrections,
    stats: {
      ...stats,
      tasksMatched: sliced.length,
      evidenceEmitted: sliced.reduce((n, t) => n + t.evidence.length, 0),
    },
  };
}
