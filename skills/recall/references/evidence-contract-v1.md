# me:recall — Session Evidence Contract v1

`bin/recall.ts` prints one JSON object on stdout. Version field is `version: 1`
and `contract` is `"session-evidence"`.

## Invocation

```
Usage: recall --vault-dir DIR [--query TEXT] [--topic TEXT] [--title TEXT] [--after DATE] [--before DATE] [--workspace DIR] [--authorize-cross-workspace] [--adapter NAME] [--limit N] [--sessions-dir DIR]
```

- Exit `0`: a bundle was produced (findings/warnings/empty results are still a
  valid bundle).
- Exit `2`: invalid arguments — output is
  `{"status":"error","error":{"code":"INVALID_ARGUMENTS","message":"..."}}`.

## Top-level shape

```jsonc
{
  "version": 1,
  "contract": "session-evidence",
  "generatedAt": "2026-08-05T00:00:00.000Z",
  "query": { "text": "调试", "topic": null, "title": null, "after": null, "before": null, "limit": 20 },
  "scope": {
    "workspace": {
      "requested": "/current/vault",
      "canonical": "/current/vault",
      "resolved": false,
      "current": true
    },
    "requestedWorkspace": null,     // --workspace canonical, else null
    "crossWorkspace": false,
    "authorized": true
  },
  "adapters": { "requested": ["codex-local"], "active": ["codex-local"], "unsupported": [] },
  "tasks": [
    {
      "taskId": "019f...",
      "sessionId": "019f...",
      "adapter": "codex-local",
      "workspace": "/current/vault",
      "derivedTitle": "修复 issue： ...",
      "titleLabel": "derived",
      "startedAt": "2026-08-03T09:00:00.000Z",
      "endedAt": "2026-08-03T09:03:00.000Z",
      "sources": ["/recall-fixture/sessions/rollout-session-a.jsonl"],
      "evidenceCount": 5,
      "evidence": [
        {
          "key": "019f...:3",
          "kind": "user_statement",
          "sourceCategory": "conversation",
          "at": "2026-08-03T09:00:02.000Z",
          "text": "修复 issue： ...",
          "redacted": false,
          "truncated": false,
          "provenance": {
            "sessionId": "019f...",
            "threadId": null,
            "sourcePath": "/recall-fixture/sessions/rollout-session-a.jsonl",
            "recordIndex": 3,
            "recordType": "event_msg",
            "payloadType": "user_message"
          },
          "supersedes": null,
          "detection": null
        }
      ],
      "evidenceTruncated": false
    }
  ],
  "corrections": [
    {
      "key": "019f...:8",
      "taskId": "019f...",
      "at": "2026-08-03T09:01:00.000Z",
      "text": "其实问题是环境变量导致的，改一下",
      "supersedes": "019f...:3",
      "supersededBy": "019f...:9",
      "conflicts": true
    }
  ],
  "warnings": [
    { "code": "ADAPTER_UNSUPPORTED", "adapter": "claude-local", "message": "..." }
  ],
  "stats": {
    "sessionsScanned": 5,
    "sessionsInScope": 4,
    "recordsScanned": 28,
    "malformedRecords": 0,
    "truncatedRecords": 1,
    "tasksMatched": 1,
    "evidenceEmitted": 5,
    "coalescedDuplicates": 1,
    "redactionTokens": { "api-key": 1, "email": 1 }
  }
}
```

## Evidence kinds (authoritative, issue #10)

Exactly four kinds. The `correction` kind is part of the evidence taxonomy and
is **not** the decision-brief Fact/Inference taxonomy.

| Kind | `sourceCategory` | Meaning |
| --- | --- | --- |
| `user_statement` | `conversation` | A redacted user message. |
| `agent_conclusion` | `conversation` | An agent message (a claim, not a fact). |
| `tool_result` | `tool` | A tool call paired with its output. |
| `correction` | `conversation` | A later statement detected as correcting a prior claim. |

- `detection: "correction-marker"` on a `correction` labels it as
  marker-heuristic, not authoritative.
- `supersedes` on a `correction` points at the evidence it replaces (the most
  recent prior conversation claim by the same speaker). The top-level
  `corrections` array exposes `supersededBy` for chained corrections so later
  corrections/supersession are visible.

## Adapter interface (narrow, additive)

Each adapter implements `SessionAdapter.listSessions(query, ctx)`:

```ts
interface SessionQuery {
  text?: string;            // free-text query (matches derived title OR evidence)
  topic?: string;           // topic filter (matches evidence text)
  title?: string;           // task-title filter (matches derived title)
  after?: string;           // ISO UTC window start
  before?: string;          // ISO UTC window end
  workspace: string;        // effective canonical scope root
  limit: number;
  options?: Record<string, string>;  // e.g. { sessionsDir }
}
interface AdapterContext {
  redact(text: string): RedactResult;   // deterministic redaction
  warn(warning: RecallWarning): void;
}
interface SessionListing {
  tasks: RecallTask[];
  corrections: RecallCorrection[];
  stats: RecallStats;
}
```

- Only `codex-local` is implemented today. Unsupported adapters fail closed with
  `ADAPTER_UNSUPPORTED` warnings and return no sessions.
- The Codex adapter reads `~/.codex/sessions` (or `$CODEX_HOME/sessions`,
  overridable with `--sessions-dir`), parses `rollout-*.jsonl` records
  (`session_meta`, `turn_context`, `event_msg`, `response_item`), and never
  writes. `response_item` assistant messages are read from
  `content[].type === "output_text"` (real Codex) with `input_text` accepted for
  legacy sessions; legacy `function_call` / `function_call_output` records are
  handled alongside `custom_tool_call` / `custom_tool_call_output`.

## Workspace scoping

- Default scope is the current workspace (`--vault-dir`, canonicalized).
  Sessions whose `workspace_roots` (or `cwd`) resolve outside it are excluded.
- `--workspace DIR` different from the current vault is a cross-workspace
  request: **requires `--authorize-cross-workspace`**. Without it, recall fails
  closed — `scope.authorized: false`, a `CROSS_WORKSPACE_UNAUTHORIZED` warning,
  and zero cross-workspace sessions.

## Query filters

Filters combine with AND (each present filter must match for a task to be
included):

- `--query TEXT` — free text matching the derived title **or** any evidence.
- `--topic TEXT` — matches the topic words in any evidence text.
- `--title TEXT` — matches the derived task title.

## Time filtering

- `--after` / `--before` accept ISO date or date-time; a bare local date-time is
  normalized to UTC.
- A task is included when at least one of its evidence records falls inside the
  window; the evidence shown is filtered to the window.

## Derived titles

Task title is not a stable `session_meta` field. `derivedTitle` is derived from
the first redacted user statement (bounded, single-line) and is labeled
`titleLabel: "derived"` — never authoritative.

## Redaction

Deterministic, pure-function redaction over evidence text. Every match maps to
a fixed `[REDACTED:<type>]` token. Types:

`private-key`, `credential` (URL user:pass), `header` (Authorization), `api-key`
(Bearer / `sk-` / `ghp_` / `github_pat_` / `xox*` / `AKIA` / `AIza` / `glpat-`),
`email`, `env-value` (`SCREAMING_CASE=value`), `env` (`$VAR` / `${VAR}`),
`ip-address`, `mac-address`, `secret` (mixed-case long tokens).

- Provenance identifiers (session ids, record indexes, source paths) are never
  redacted.
- Evidence text is bounded to 400 chars (`truncated: true` when cut); full
  transcripts are never returned.
- Per-type counts are reported in `stats.redactionTokens`.

## Provenance

Each evidence exposes `provenance`: `sessionId`, `threadId`, `sourcePath`,
`recordIndex`, `recordType`, `payloadType`. The bundle does not invent custom
URLs; "reopen where supported" means using the session id with the agent's own
resume mechanism (e.g. `codex resume <session_id>`).

- `sessionId` is the unique rollout/session id (`session_meta.payload.id`).
- `threadId` is the Codex thread/session id (`session_meta.payload.session_id`,
  or an explicit `payload.thread_id` when present). For a subagent child,
  `session_id` is the PARENT thread id, so `threadId` truthfully identifies the
  thread the session belongs to.

## Root / subagent-child coalescing

Real Codex subagent metadata lives in
`session_meta.payload.source.subagent.thread_spawn.parent_thread_id` (with
`depth`, `agent_path`, `agent_nickname`) and `thread_source === "subagent"`.
Sessions that share a thread (a root session and the subagent children spawned
by it) are folded into **one task**:

- The copied root prompt that appears verbatim in each child session is counted
  once (cross-file dedup keyed on the ORIGINAL normalized text, so two distinct
  secrets never collapse).
- Genuinely distinct child evidence is retained; each evidence keeps its own
  `provenance` (child `sessionId`, `sourcePath`, `recordIndex`).
- `task.sources` retains every contributing source path (root + children).
- Tool facts are never cross-deduped.
- A child whose parent is not present in the scan still stands alone as its own
  task (its threadId is preserved in provenance).

## Warnings

| Code | Meaning |
| --- | --- |
| `ADAPTER_UNSUPPORTED` | A requested adapter is not implemented; no sessions from it. |
| `CROSS_WORKSPACE_UNAUTHORIZED` | Cross-workspace scope requested without authorization; failed closed. |
| `SESSIONS_DIR_NOT_FOUND` | The Codex sessions directory does not exist. |
| `MALFORMED_RECORD` | One or more JSONL lines were skipped as malformed (with `sourcePath` + count). |
| `TRUNCATED_RECORD` | A trailing JSONL record was cut off and skipped (with `sourcePath`). |

Damaged sources never fail the recall: malformed/truncated lines are counted in
`stats.malformedRecords` / `stats.truncatedRecords` and reported via these
structured warnings, while the remaining valid records still produce evidence.

## Zero-write guarantees

`bin/recall.ts` and the adapters are strictly read-only: no writes to vault,
Memory, Agent config, runtime, indexes, or session stores; no directory
creation; no DB/vector/persistent index; no network.

## Known limitations

- Correction detection is marker-based and heuristic; it may miss reworded
  corrections or flag a soft "actually…" opener. It is labeled, never
  authoritative.
- Contradictions without an explicit correction marker are not detected.
- The Codex adapter reads every in-scope session file fully; large session
  stores are parsed on each recall (no persistent index by design).
- Legacy `function_call`/`function_call_output` records are handled alongside
  `custom_tool_call`/`custom_tool_call_output`; web-search and sub-agent
  activity records are skipped in v1.
