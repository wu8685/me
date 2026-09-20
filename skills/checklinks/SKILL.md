---
name: checklinks
description: "Check vault link health - distinguish broken concrete references from valid virtual wikilink nodes, and report orphaned and dead-end notes."
---

# /me:checklinks

Reports semantic vault link health across all configured knowledge layers
(resolved from `.me/config.yaml`). Bare wikilinks may act as center nodes even
when no same-named note exists, so they are reported separately rather than
treated as broken.

## Usage

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/checklinks.ts" "$(pwd)" "$ARGUMENTS"
```

The TypeScript executable automatically:
- Reads layer directory mapping from `.me/config.yaml` (defaults to `raw/`, `practices/`, `cognition/`)
- Uses the deterministic native semantic graph engine whether or not Obsidian is running
- Resolves targets against the whole vault, including assets and notes outside the configured layers
- Ignores wikilink-shaped examples in fenced/inline code and wildcard placeholders
- Filters to a single layer if `$ARGUMENTS` contains `raw`, `practices`, or `cognition`
- Outputs broken concrete references, virtual nodes, orphaned notes, and dead-end notes

## Output

The command produces a structured report with:
- Broken Concrete References (missing embeds, explicit paths/files, or date-named notes)
- Virtual Wikilink Nodes (unresolved semantic center nodes; not errors)
- Orphaned Notes (notes with no incoming links)
- Dead-End Notes (notes with no outgoing links)

## Constraints

- All vault paths are relative to cwd
- Read-only diagnostic command (does not modify any notes)
- Layer directories resolved from `.me/config.yaml` at runtime
