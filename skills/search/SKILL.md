---
name: search
description: "Search vault notes by content, tags, layer, date, and wikilink connections. Claude Code: /me:search; Codex skill: me:search."
---

# /me:search

Search vault notes across multiple dimensions: free-text content, tags, knowledge layer, creation date, and wikilink connections.

Filters combine with AND logic across flags. Multiple values within --tags use OR logic.
Layer directories resolve from `.me/config.yaml` (with raw/practices/cognition as defaults).

## Step 1: Run search

Parse `$ARGUMENTS` and pass them directly to `bin/search.ts`:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
RESULT=$(bun run "$PLUGIN_ROOT/bin/search.ts" $ARGUMENTS --vault-dir "$(pwd)" 2>&1)
```

Print the result directly — it is already formatted as a markdown table.

## Examples

```
/me:search transformer
/me:search --tags ai,ml
/me:search --layer raw --after 2026-03
/me:search attention --tags ai --layer raw
/me:search --linked-to "my-note"
/me:search --before 2026-04-01 --limit 50
```

## Flags Reference

| Flag | Description | Example |
|------|-------------|---------|
| (positional) | Free-text query (matches title and body, case-insensitive) | `/me:search transformer` |
| `--tags` | Filter by tags (comma-separated, OR logic) | `--tags ai,ml` |
| `--layer` | Filter by knowledge layer | `--layer raw` |
| `--after` | Notes created after date (YYYY-MM-DD or YYYY-MM) | `--after 2026-03` |
| `--before` | Notes created before date | `--before 2026-04-01` |
| `--linked-to` | Notes containing wikilink to target note | `--linked-to "attention"` |
| `--limit` | Max results (default: 20) | `--limit 50` |
