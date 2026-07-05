---
name: backlinks
description: "Discover backlinks and unlinked mentions for a note — show what existing notes link to or could link to the given note across all configured knowledge layers."
---

# /me:backlinks

Discovers incoming wikilinks and unlinked mention candidates for a given note across all configured knowledge layers.

## Usage

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/backlinks.ts" "$ARGUMENTS" "$(pwd)"
```

The TypeScript executable automatically:
- Validates that a note name was provided in `$ARGUMENTS`
- Reads layer directory mapping from `.me/config.yaml` (defaults to `raw/`, `practices/`, `cognition/`)
- Detects Obsidian CLI availability and uses enhanced mode when available
- Falls back to native grep-based engine when Obsidian is not running
- Finds existing backlinks (notes that wikilink to the target note)
- Finds unlinked mentions (notes that mention the title but don't wikilink to it)

## Output

The command produces a structured report with:
- Linked notes (backlinks with link counts)
- Unlinked mentions (notes that could link to the target note)

## Constraints

- Read-only command (does not modify any notes)
- Wikilink syntax: `[[filename]]` without path prefix (Obsidian resolves by name, case-insensitive)
- All vault paths are relative to cwd
- Layer directories resolved from `.me/config.yaml` at runtime
