---
name: autolinks
description: "Auto-add wikilinks to existing vault notes by LLM-extracted concepts matched against vault index."
---

# /me:autolinks

Intelligently adds wikilinks to vault notes using a two-stage LLM-first process:
1. **LLM Stage**: Extract key concepts from article content worth linking
2. **Script Stage**: Deterministically match extracted concepts against vault index

This eliminates false positives from generic keyword matching while maintaining deterministic script logic.

## Usage

```bash
# Bulk mode: process all vault files
/me:autolinks

# Bulk mode with layer filter: process only one layer
/me:autolinks raw

# Single-note mode: process only one file
/me:autolinks raw/my-note.md

# Single-note mode with layer filter
/me:autolinks raw/my-note.md raw
```

The skill automatically:
- Reads layer directory mapping from `.me/config.yaml` (defaults to `raw/`, `practices/`, `cognition/`)
- Ensures each processed file has a UUID `id` field in frontmatter (skips if already present)
- Extracts key concepts from article content using LLM reasoning
- Builds vault index from all `.md` files in configured layers
- Matches extracted concepts against vault titles (not greedy keyword matching)
- Writes files back if changed (preserves frontmatter, only links in body)
- Reports statistics: files processed, links inserted, IDs added, concepts not found (stubs)

## Modes

**Bulk Mode (default)**: Processes all vault files. Use for comprehensive vault updates.
```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$(pwd)"
```

**Single-Note Mode**: Processes only the specified file. Use for targeted updates.
```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$(pwd)" "raw/my-note.md"
```

Note paths are relative to the vault root and must include the `.md` extension.

## Vault Context Gathering

Before extracting concepts, gather the vault index for context:

1. Resolve plugin root: `PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"`
2. Run: `bun -e "import { buildVaultIndex, scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; const idx = buildVaultIndex('$(pwd)'); const wl = scanExistingWikilinks('$(pwd)'); const titles = Array.from(idx.values()).map(e => e.title); const stems = Array.from(wl); const all = [...new Set([...titles.map(t => t.toLowerCase()), ...stems.map(s => s.toLowerCase())])]; console.log(JSON.stringify(all));"`
2. Store the output as VAULT_TERMS -- a deduplicated list of lowercase terms from vault titles and existing wikilink stems
3. Pass VAULT_TERMS as context to the LLM extraction step below

## LLM Concept Extraction

Before script invocation, the skill uses Claude reasoning to extract key concepts from the article:

**Extraction Process:**
1. Read article content (from `$ARGUMENTS` or current file context)
2. Review the VAULT_TERMS list (existing vault titles and wikilink stems)
3. Extract 3-10 key concepts worth linking -- prioritize terms that exist in VAULT_TERMS, but also identify genuinely new concepts worth creating as future notes
4. Filter OUT: generic words (the, a, learning, system, method, approach)
5. Filter IN: technical terms, proper names, domain-specific concepts, multi-word phrases
6. Return structured JSON: `{concepts: [{term, reasoning}]}`

**LLM Prompt Pattern:**
```
You have an article and a list of existing vault terms.

Vault terms (existing notes and wikilinks):
$VAULT_TERMS

Extract 3-10 key concepts from this article that deserve wikilinks.
Prioritize concepts that match existing vault terms. Also include genuinely new concepts worth creating as future notes.

For each concept:
- term: the exact phrase to match (case-insensitive)
- reasoning: why this concept deserves a wikilink

Return JSON only: {concepts: [{term, reasoning}]}
```

**Script Invocation:**
```bash
bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$VAULT" "$NOTE_PATH" --concepts '$JSON'
```

The `--concepts` flag passes the LLM-extracted concepts to the script. JSON format: `{"concepts": [{"term": "Neural Networks", "reasoning": "core ML concept"}]}`

## Options

- **Layer filter** (`raw` | `practices` | `cognition`): Restrict processing to one layer
  - In bulk mode: processes only files in that layer
  - In single-note mode: validates the note is in the specified layer

- **Note path** (relative path): Path to a single note to process
  - Must contain `/` or end with `.md` to be recognized as a path
  - Examples: `raw/my-note.md`, `practices/experiment.md`

## Output

The command produces a summary report with:
- Mode indicator (Bulk or Single-note)
- Existing wikilinks count (scanned before processing)
- Vault index size (number of notes)
- New wikilinks inserted (count)
- Total wikilinks after processing (existing + new)
- Files processed/linked/unchanged
- Any errors encountered

Single-note mode shows `File: <path>` instead of `Processed: N files`.

## Constraints

- All vault paths are relative to cwd
- LLM extracts 3-10 concepts per article (per D-03)
- LLM concepts drive stub detection; the script matches ALL vault pool entries (titles + wikilink stems) additively
- Only adds links to first occurrence per concept (avoids over-linking)
- Respects frontmatter boundaries (no links inside YAML)
- Generates UUID v4 `id` in frontmatter for files that lack one (idempotent — skips if id exists)
- Files without frontmatter are not modified for id purposes
- Reports stubs for concepts not found in vault (worth creating)
- Single-note mode requires `.md` file extension
