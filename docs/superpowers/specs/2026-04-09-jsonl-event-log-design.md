# JSONL Event Log — Design Spec

## Overview

A generic JSONL-based event logging module for the me plugin. Provides append and query capabilities via both TypeScript API and CLI. Events track knowledge management activities with document associations.

## Event Schema

Each line in the JSONL file is a single JSON object:

```jsonc
{
  "type": "ingest",                          // event type (free string)
  "subtype": "translate-cn",                 // event subtype (optional, free string)
  "description": "Ingested LLM Wiki article with Chinese translation",
  "docIds": ["a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6"],  // frontmatter UUID list
  "timestamp": "2026-04-09T14:30:00+08:00"  // ISO 8601 with timezone
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Event type — free string, not enum-restricted |
| `subtype` | string | no | Event subtype for finer classification |
| `description` | string | yes | Human-readable event description |
| `docIds` | string[] | yes | Frontmatter UUID list (may be empty `[]`) |
| `timestamp` | string | yes | ISO 8601 with timezone, auto-generated on append |

### Conventional Event Types

Not enforced, just conventions for consistency across skills:

| type | typical subtype | trigger |
|------|----------------|---------|
| `ingest` | `translate-cn`, `summarize`, `raw` | `/me:ingest` |
| `autolinks` | `bulk`, `single` | `/me:autolinks` |
| `move` | — | `/me:move` |
| `checklinks` | — | `/me:checklinks` |
| `search` | — | `/me:search` |
| `link` | `add`, `remove` | manual wikilink changes |
| `lifecycle` | `promote`, `demote` | cross-layer document moves |

## TypeScript API

File: `bin/events.ts`

### `appendEvent(file, event, options?)`

Appends one event to the specified JSONL file.

```typescript
interface MeEvent {
  type: string
  subtype?: string
  description: string
  docIds: string[]
  timestamp: string
}

function appendEvent(
  file: string,
  event: Omit<MeEvent, 'timestamp'>,
  options?: { vaultDir?: string }
): MeEvent
```

**Behavior:**
- Auto-fills `timestamp` with current time in ISO 8601 format
- If JSONL file does not exist, creates it
- `docIds` accepts UUIDs directly
- Returns the complete event object (with timestamp)

### `appendEventWithPaths(file, event, docPaths, vaultDir)`

Convenience wrapper that resolves file paths to UUIDs before appending.

```typescript
function appendEventWithPaths(
  file: string,
  event: Omit<MeEvent, 'timestamp' | 'docIds'>,
  docPaths: string[],
  vaultDir: string
): MeEvent
```

**Behavior:**
- For each path in `docPaths`, reads file frontmatter to get UUID
- If UUID missing, calls `ensureId()` to generate and write UUID into the file's frontmatter
- Then delegates to `appendEvent()` with resolved UUIDs

### `queryEvents(file, filter?)`

Queries events from JSONL file with optional filters.

```typescript
function queryEvents(
  file: string,
  filter?: {
    type?: string
    subtype?: string
    docId?: string
    after?: string
    before?: string
    limit?: number
  }
): MeEvent[]
```

**Behavior:**
- Parses JSONL line by line, applies filters
- `docId` matches if any element in `docIds` array equals the value
- `after`/`before` compare against `timestamp` (ISO 8601 string comparison)
- `limit` caps number of returned results (most recent first when limit is set)
- File not found returns `[]`
- Malformed JSON lines are skipped with stderr warning

## CLI Interface

File: `bin/events.ts` (same file, CLI entry at bottom)

### `append` subcommand

```bash
# With UUIDs directly
bun run bin/events.ts append \
  --file path/to/events.jsonl \
  --type ingest \
  --subtype translate-cn \
  --description "Ingested LLM Wiki article" \
  --doc-ids "uuid1,uuid2"

# With file paths (resolves UUID from frontmatter, adds if missing)
bun run bin/events.ts append \
  --file path/to/events.jsonl \
  --type ingest \
  --description "Ingested article" \
  --doc-paths "raw/摘录/2026-04-08-llm-wiki.md"
```

- `--doc-ids` and `--doc-paths` are mutually exclusive
- `--doc-paths` are relative to cwd
- `--subtype` is optional
- Outputs the appended event as JSON to stdout

### `query` subcommand

```bash
bun run bin/events.ts query \
  --file path/to/events.jsonl \
  --type ingest \
  --after 2026-04-01 \
  --before 2026-04-10 \
  --doc-id uuid1 \
  --limit 20
```

- All filter flags are optional
- Outputs JSON array to stdout

## Error Handling

| Scenario | Behavior |
|----------|----------|
| JSONL file not found | `append`: create file; `query`: return `[]` |
| `--doc-paths` file not found | Error exit, no event written |
| `--doc-paths` file has no frontmatter | Error exit (cannot generate UUID) |
| Malformed JSON line in JSONL | `query` skips line, warns on stderr |
| `--doc-ids` and `--doc-paths` both provided | Error exit with message |
| Empty `docIds` | Allowed — some events have no associated docs |

## File Structure

```
bin/events.ts          # TypeScript module + CLI entry
test/vault-test.sh     # Test cases added here
```

No new skill is created. Event recording will be integrated into existing skills in future work.

## Out of Scope

- Trigger integration (skills auto-recording events)
- Event subscription / watch mechanism
- Event type enum enforcement
