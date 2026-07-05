---
name: checklinks
description: "Check vault link health - report broken wikilinks, orphaned notes, and dead-end notes across all configured knowledge layers."
---

# /me:checklinks

Reports vault link health across all configured knowledge layers (resolved from `.me/config.yaml`).

## Usage

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/checklinks.ts" "$(pwd)" "$ARGUMENTS"
```

The TypeScript executable automatically:
- Reads layer directory mapping from `.me/config.yaml` (defaults to `raw/`, `practices/`, `cognition/`)
- Detects Obsidian CLI availability and uses enhanced mode when available
- Falls back to native grep-based engine when Obsidian is not running
- Filters to a single layer if `$ARGUMENTS` contains `raw`, `practices`, or `cognition`
- Outputs broken wikilinks, orphaned notes, and dead-end notes in formatted report

## Output

The command produces a structured report with:
- Broken Wikilinks (links pointing to non-existent notes)
- Orphaned Notes (notes with no incoming links)
- Dead-End Notes (notes with no outgoing links)

## Constraints

- All vault paths are relative to cwd
- Read-only diagnostic command (does not modify any notes)
- Layer directories resolved from `.me/config.yaml` at runtime
