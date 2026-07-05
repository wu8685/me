# JSONL Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic JSONL event logging module with append and query capabilities, usable as both TypeScript API and CLI.

**Architecture:** Single file `bin/events.ts` exports `appendEvent`, `appendEventWithPaths`, and `queryEvents` functions. CLI entry point at the bottom parses `append` / `query` subcommands. Reuses `ensureFrontmatterId` from `bin/autolinks.ts` for UUID resolution.

**Tech Stack:** TypeScript (Bun runtime), existing `bin/autolinks.ts` for `ensureFrontmatterId`

---

### Task 1: Core Types and appendEvent

**Files:**
- Create: `bin/events.ts`
- Test: `test/vault-test.sh` (append new test functions)

- [ ] **Step 1: Write failing tests for appendEvent**

Add these test functions to `test/vault-test.sh` before the `# ── Main ──` section (line 3843):

```bash
test_events_script_exists() {
  assert_file_exists "$PLUGIN_ROOT/bin/events.ts" || return 1
}

test_events_append_creates_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test event" > /dev/null 2>&1

  assert_file_exists "$evfile" || return 1
  local lines
  lines=$(wc -l < "$evfile" | tr -d ' ')
  if [ "$lines" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 line, got $lines"
    return 1
  fi
}

test_events_append_valid_json() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --subtype "translate-cn" \
    --description "Ingested article" \
    --doc-ids "uuid-1,uuid-2" > /dev/null 2>&1

  # Parse with bun (jq alternative)
  local parsed
  parsed=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.type + '|' + obj.subtype + '|' + obj.docIds.length)")
  if [ "$parsed" != "ingest|translate-cn|2" ]; then
    echo -e "    ${RED}FAIL${NC}: unexpected parsed output: $parsed"
    return 1
  fi
}

test_events_append_auto_timestamp() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "test" \
    --description "Timestamp test" > /dev/null 2>&1

  local has_ts
  has_ts=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.timestamp ? 'yes' : 'no')")
  if [ "$has_ts" != "yes" ]; then
    echo -e "    ${RED}FAIL${NC}: timestamp not auto-generated"
    return 1
  fi

  # Verify ISO 8601 format
  local ts_valid
  ts_valid=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); const d = new Date(obj.timestamp); console.log(isNaN(d.getTime()) ? 'no' : 'yes')")
  if [ "$ts_valid" != "yes" ]; then
    echo -e "    ${RED}FAIL${NC}: timestamp is not valid ISO 8601"
    return 1
  fi
}

test_events_append_empty_doc_ids() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "search" \
    --description "No docs" > /dev/null 2>&1

  local doc_ids_len
  doc_ids_len=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds.length)")
  if [ "$doc_ids_len" != "0" ]; then
    echo -e "    ${RED}FAIL${NC}: expected empty docIds, got length $doc_ids_len"
    return 1
  fi
}

test_events_append_multiple() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "first" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "second" > /dev/null 2>&1

  local lines
  lines=$(wc -l < "$evfile" | tr -d ' ')
  if [ "$lines" -ne 2 ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 lines, got $lines"
    return 1
  fi
}
```

- [ ] **Step 2: Register tests in main() and run to verify they fail**

Add to `main()` in `test/vault-test.sh`, before the `fi` closing the else block (before line 4048):

```bash
    # JSONL Event Log
    run_test test_events_script_exists
    run_test test_events_append_creates_file
    run_test test_events_append_valid_json
    run_test test_events_append_auto_timestamp
    run_test test_events_append_empty_doc_ids
    run_test test_events_append_multiple
```

Run: `bash test/vault-test.sh test_events_script_exists`
Expected: FAIL (bin/events.ts does not exist)

- [ ] **Step 3: Implement appendEvent and CLI append subcommand**

Create `bin/events.ts`:

```typescript
#!/usr/bin/env -S bun run
// bin/events.ts — JSONL event logging for me plugin
//
// Exports functions for append and query operations.
// CLI usage:
//   bun run bin/events.ts append --file <path> --type <type> [--subtype <sub>] --description <desc> [--doc-ids id1,id2] [--doc-paths p1,p2]
//   bun run bin/events.ts query --file <path> [--type <type>] [--subtype <sub>] [--doc-id <id>] [--after <date>] [--before <date>] [--limit <n>]

import * as fs from 'fs';
import * as path from 'path';
import { ensureFrontmatterId } from './autolinks.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MeEvent {
  type: string;
  subtype?: string;
  description: string;
  docIds: string[];
  timestamp: string;
}

export interface AppendEventInput {
  type: string;
  subtype?: string;
  description: string;
  docIds?: string[];
}

export interface QueryFilter {
  type?: string;
  subtype?: string;
  docId?: string;
  after?: string;
  before?: string;
  limit?: number;
}

// ── appendEvent ───────────────────────────────────────────────────────────────

export function appendEvent(file: string, event: AppendEventInput): MeEvent {
  const meEvent: MeEvent = {
    type: event.type,
    description: event.description,
    docIds: event.docIds ?? [],
    timestamp: new Date().toISOString(),
  };
  if (event.subtype) {
    meEvent.subtype = event.subtype;
  }

  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(file, JSON.stringify(meEvent) + '\n');
  return meEvent;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      map.set(args[i].slice(2), args[i + 1]);
      i++;
    }
  }
  return map;
}

function cliAppend(args: string[]) {
  const opts = parseArgs(args);
  const file = opts.get('file');
  const type = opts.get('type');
  const description = opts.get('description');

  if (!file || !type || !description) {
    console.error('Usage: events.ts append --file <path> --type <type> --description <desc> [--subtype <sub>] [--doc-ids id1,id2]');
    process.exit(1);
  }

  const docIdsStr = opts.get('doc-ids');
  const docIds = docIdsStr ? docIdsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const subtype = opts.get('subtype');

  const event = appendEvent(file, { type, subtype, description, docIds });
  console.log(JSON.stringify(event));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const subcommand = process.argv[2];
if (subcommand === 'append') {
  cliAppend(process.argv.slice(3));
} else if (subcommand === 'query') {
  // Placeholder — implemented in Task 3
  console.error('query not yet implemented');
  process.exit(1);
} else if (subcommand) {
  console.error(`Unknown subcommand: ${subcommand}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash test/vault-test.sh test_events_script_exists`
Run: `bash test/vault-test.sh test_events_append_creates_file`
Run: `bash test/vault-test.sh test_events_append_valid_json`
Run: `bash test/vault-test.sh test_events_append_auto_timestamp`
Run: `bash test/vault-test.sh test_events_append_empty_doc_ids`
Run: `bash test/vault-test.sh test_events_append_multiple`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add bin/events.ts test/vault-test.sh
git commit -m "feat: add JSONL event log — appendEvent + CLI append"
```

---

### Task 2: appendEventWithPaths (UUID resolution from file paths)

**Files:**
- Modify: `bin/events.ts`
- Test: `test/vault-test.sh`

- [ ] **Step 1: Write failing tests for appendEventWithPaths**

Add to `test/vault-test.sh` before `# ── Main ──`:

```bash
test_events_append_with_paths_resolves_uuid() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # Create a note WITH existing UUID
  cat > "$v/raw/note-with-id.md" << 'EOF'
---
id: "abc-123-def"
title: "Has ID"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Content here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test path resolution" \
    --doc-paths "raw/note-with-id.md" > /dev/null 2>&1

  local doc_id
  doc_id=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds[0])")
  if [ "$doc_id" != "abc-123-def" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 'abc-123-def', got '$doc_id'"
    return 1
  fi
}

test_events_append_with_paths_generates_uuid() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # Create a note WITHOUT UUID
  cat > "$v/raw/note-no-id.md" << 'EOF'
---
title: "No ID"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Content here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test UUID generation" \
    --doc-paths "raw/note-no-id.md" > /dev/null 2>&1

  # Event should have a UUID in docIds
  local doc_id
  doc_id=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds[0])")
  if [ -z "$doc_id" ] || [ "$doc_id" = "undefined" ]; then
    echo -e "    ${RED}FAIL${NC}: docIds[0] is empty or undefined"
    return 1
  fi

  # The file frontmatter should now contain the UUID
  assert_file_contains "$v/raw/note-no-id.md" "^id: \"$doc_id\"" || return 1
}

test_events_append_with_paths_missing_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Missing file" \
    --doc-paths "raw/nonexistent.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit for missing file"
    return 1
  fi

  # No event should be written
  assert_file_not_exists "$evfile" || return 1
}

test_events_append_with_paths_no_frontmatter() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # File without frontmatter
  echo "Just plain text, no frontmatter." > "$v/raw/plain.md"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "No frontmatter" \
    --doc-paths "raw/plain.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit for file without frontmatter"
    return 1
  fi
}

test_events_append_doc_ids_doc_paths_exclusive() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "test" \
    --description "Both flags" \
    --doc-ids "uuid1" \
    --doc-paths "raw/x.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit when both --doc-ids and --doc-paths are given"
    return 1
  fi
}
```

- [ ] **Step 2: Register tests in main() and run to verify they fail**

Add to `main()`:

```bash
    run_test test_events_append_with_paths_resolves_uuid
    run_test test_events_append_with_paths_generates_uuid
    run_test test_events_append_with_paths_missing_file
    run_test test_events_append_with_paths_no_frontmatter
    run_test test_events_append_doc_ids_doc_paths_exclusive
```

Run: `bash test/vault-test.sh test_events_append_with_paths_resolves_uuid`
Expected: FAIL

- [ ] **Step 3: Implement appendEventWithPaths and update CLI**

Add to `bin/events.ts` after the `appendEvent` function:

```typescript
// ── UUID Resolution ───────────────────────────────────────────────────────────

function readFrontmatterId(filePath: string): string | null {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const fm = content.slice(4, end);
  const match = fm.match(/^id:\s*"?([^"\n]+)"?/m);
  return match ? match[1] : null;
}

export function resolveDocIds(docPaths: string[], cwd: string): string[] {
  const ids: string[] = [];
  for (const relPath of docPaths) {
    const fullPath = path.resolve(cwd, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relPath}`);
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    if (!content.startsWith('---\n')) {
      throw new Error(`File has no frontmatter: ${relPath}`);
    }

    let id = readFrontmatterId(fullPath);
    if (!id) {
      const result = ensureFrontmatterId(content);
      if (!result.idAdded) {
        throw new Error(`Cannot add UUID to file: ${relPath}`);
      }
      fs.writeFileSync(fullPath, result.content);
      id = readFrontmatterId(fullPath)!;
    }
    ids.push(id);
  }
  return ids;
}

export function appendEventWithPaths(
  file: string,
  event: Omit<AppendEventInput, 'docIds'>,
  docPaths: string[],
  cwd: string,
): MeEvent {
  const docIds = resolveDocIds(docPaths, cwd);
  return appendEvent(file, { ...event, docIds });
}
```

Update the `cliAppend` function to handle `--doc-paths`:

```typescript
function cliAppend(args: string[]) {
  const opts = parseArgs(args);
  const file = opts.get('file');
  const type = opts.get('type');
  const description = opts.get('description');

  if (!file || !type || !description) {
    console.error('Usage: events.ts append --file <path> --type <type> --description <desc> [--subtype <sub>] [--doc-ids id1,id2] [--doc-paths p1,p2]');
    process.exit(1);
  }

  const docIdsStr = opts.get('doc-ids');
  const docPathsStr = opts.get('doc-paths');
  const subtype = opts.get('subtype');

  if (docIdsStr && docPathsStr) {
    console.error('Error: --doc-ids and --doc-paths are mutually exclusive');
    process.exit(1);
  }

  let event: MeEvent;
  if (docPathsStr) {
    const docPaths = docPathsStr.split(',').map(s => s.trim()).filter(Boolean);
    event = appendEventWithPaths(file, { type, subtype, description }, docPaths, process.cwd());
  } else {
    const docIds = docIdsStr ? docIdsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    event = appendEvent(file, { type, subtype, description, docIds });
  }
  console.log(JSON.stringify(event));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash test/vault-test.sh test_events_append_with_paths_resolves_uuid`
Run: `bash test/vault-test.sh test_events_append_with_paths_generates_uuid`
Run: `bash test/vault-test.sh test_events_append_with_paths_missing_file`
Run: `bash test/vault-test.sh test_events_append_with_paths_no_frontmatter`
Run: `bash test/vault-test.sh test_events_append_doc_ids_doc_paths_exclusive`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add bin/events.ts test/vault-test.sh
git commit -m "feat: add appendEventWithPaths — resolve file paths to UUIDs"
```

---

### Task 3: queryEvents

**Files:**
- Modify: `bin/events.ts`
- Test: `test/vault-test.sh`

- [ ] **Step 1: Write failing tests for queryEvents**

Add to `test/vault-test.sh` before `# ── Main ──`:

```bash
test_events_query_empty_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null)
  if [ "$output" != "[]" ]; then
    echo -e "    ${RED}FAIL${NC}: expected '[]', got '$output'"
    return 1
  fi
}

test_events_query_all() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "first" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "second" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events, got $count"
    return 1
  fi
}

test_events_query_by_type() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --description "one" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "search" --description "two" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --description "three" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --type "ingest" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 ingest events, got $count"
    return 1
  fi
}

test_events_query_by_subtype() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --subtype "raw" --description "one" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --subtype "translate-cn" --description "two" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --subtype "translate-cn" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 translate-cn event, got $count"
    return 1
  fi
}

test_events_query_by_doc_id() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "one" --doc-ids "uuid-1,uuid-2" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "two" --doc-ids "uuid-3" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --doc-id "uuid-2" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 event with uuid-2, got $count"
    return 1
  fi
}

test_events_query_by_time_range() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  # Write events with known timestamps directly
  echo '{"type":"a","description":"old","docIds":[],"timestamp":"2026-04-01T10:00:00.000Z"}' >> "$evfile"
  echo '{"type":"b","description":"mid","docIds":[],"timestamp":"2026-04-05T10:00:00.000Z"}' >> "$evfile"
  echo '{"type":"c","description":"new","docIds":[],"timestamp":"2026-04-09T10:00:00.000Z"}' >> "$evfile"

  cd "$v"
  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --after "2026-04-03" --before "2026-04-07" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 event in range, got $count"
    return 1
  fi
}

test_events_query_limit() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "1" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "2" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "3" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --limit 2 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events with limit, got $count"
    return 1
  fi
}

test_events_query_skips_malformed() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  echo '{"type":"a","description":"good","docIds":[],"timestamp":"2026-04-09T10:00:00.000Z"}' >> "$evfile"
  echo 'NOT VALID JSON' >> "$evfile"
  echo '{"type":"b","description":"also good","docIds":[],"timestamp":"2026-04-09T11:00:00.000Z"}' >> "$evfile"

  cd "$v"
  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events (skipping malformed), got $count"
    return 1
  fi
}
```

- [ ] **Step 2: Register tests in main() and run to verify they fail**

Add to `main()`:

```bash
    run_test test_events_query_empty_file
    run_test test_events_query_all
    run_test test_events_query_by_type
    run_test test_events_query_by_subtype
    run_test test_events_query_by_doc_id
    run_test test_events_query_by_time_range
    run_test test_events_query_limit
    run_test test_events_query_skips_malformed
```

Run: `bash test/vault-test.sh test_events_query_empty_file`
Expected: FAIL (query not yet implemented)

- [ ] **Step 3: Implement queryEvents and CLI query subcommand**

Add to `bin/events.ts` after `appendEventWithPaths`:

```typescript
// ── queryEvents ───────────────────────────────────────────────────────────────

export function queryEvents(file: string, filter?: QueryFilter): MeEvent[] {
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: MeEvent[] = [];

  for (const line of lines) {
    let event: MeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      console.error(`Warning: skipping malformed JSON line`);
      continue;
    }

    if (filter?.type && event.type !== filter.type) continue;
    if (filter?.subtype && event.subtype !== filter.subtype) continue;
    if (filter?.docId && !event.docIds.includes(filter.docId)) continue;
    if (filter?.after && event.timestamp < new Date(filter.after).toISOString()) continue;
    if (filter?.before && event.timestamp >= new Date(filter.before + 'T23:59:59.999Z').toISOString()) continue;

    events.push(event);
  }

  if (filter?.limit && filter.limit > 0) {
    return events.slice(-filter.limit);
  }

  return events;
}
```

Replace the query placeholder in the CLI main section:

```typescript
function cliQuery(args: string[]) {
  const opts = parseArgs(args);
  const file = opts.get('file');

  if (!file) {
    console.error('Usage: events.ts query --file <path> [--type <type>] [--subtype <sub>] [--doc-id <id>] [--after <date>] [--before <date>] [--limit <n>]');
    process.exit(1);
  }

  const filter: QueryFilter = {};
  if (opts.has('type')) filter.type = opts.get('type');
  if (opts.has('subtype')) filter.subtype = opts.get('subtype');
  if (opts.has('doc-id')) filter.docId = opts.get('doc-id');
  if (opts.has('after')) filter.after = opts.get('after');
  if (opts.has('before')) filter.before = opts.get('before');
  if (opts.has('limit')) filter.limit = parseInt(opts.get('limit')!, 10);

  const events = queryEvents(file, filter);
  console.log(JSON.stringify(events));
}
```

Update the main block to wire query:

```typescript
const subcommand = process.argv[2];
if (subcommand === 'append') {
  cliAppend(process.argv.slice(3));
} else if (subcommand === 'query') {
  cliQuery(process.argv.slice(3));
} else if (subcommand) {
  console.error(`Unknown subcommand: ${subcommand}`);
  process.exit(1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash test/vault-test.sh test_events_query_empty_file`
Run: `bash test/vault-test.sh test_events_query_all`
Run: `bash test/vault-test.sh test_events_query_by_type`
Run: `bash test/vault-test.sh test_events_query_by_subtype`
Run: `bash test/vault-test.sh test_events_query_by_doc_id`
Run: `bash test/vault-test.sh test_events_query_by_time_range`
Run: `bash test/vault-test.sh test_events_query_limit`
Run: `bash test/vault-test.sh test_events_query_skips_malformed`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add bin/events.ts test/vault-test.sh
git commit -m "feat: add queryEvents — filter by type/subtype/docId/time/limit"
```

---

### Task 4: Full test suite verification

**Files:** (no new files)

- [ ] **Step 1: Run entire test suite**

Run: `bash test/vault-test.sh`
Expected: All tests pass (existing + new event log tests)

- [ ] **Step 2: Commit if any fixes were needed**

Only if fixes were applied. Otherwise skip.
