---
name: move
description: "Move or rename vault notes while preserving wikilink integrity — uses native grep+sed for wikilink rewriting, with Obsidian CLI as enhanced option."
---

# /me:move

Moves or renames a vault note with full wikilink integrity. All references to the note across all configured layer directories are automatically rewritten.

## Usage

Parse `$ARGUMENTS` to extract source and destination:

```bash
# Resolve plugin root (works whether installed as plugin or run locally)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# Extract first two tokens from $ARGUMENTS
set -- $ARGUMENTS
SOURCE="$1"
DEST="$2"

# Call TypeScript executable
bun run "$PLUGIN_ROOT/bin/move.ts" "$SOURCE" "$DEST" "$(pwd)"
```

The TypeScript executable automatically:
- Validates that both source and destination were provided
- Reads layer directory mapping from `.me/config.yaml` (defaults to `raw/`, `practices/`, `cognition/`)
- Detects Obsidian CLI availability and uses enhanced mode when available
- Falls back to native grep+sed engine when Obsidian is not running
- Handles both in-place renames (same folder) and cross-folder moves
- Rewrites all wikilink references across the vault when filename changes

## Source Resolution

The source note may be given in three forms, tried in this order (first hit wins):

1. **Vault-relative path** — `knowledge/raw/records/work/org/note.md` (with or without `.md`)
2. **Layer-relative path** — `records/work/org/note.md` is joined to each configured layer root
3. **Bare stem** — `note` is looked up recursively across every configured layer, so notes in
   nested subdirectories resolve without typing the full path

If a bare stem matches more than one note, the command fails with an ambiguity error listing
every candidate as a vault-relative path; re-run with a layer-relative or vault-relative form
to disambiguate. In Obsidian mode the resolved note is always passed to the Obsidian CLI as a
normalized vault-relative path, never as the raw input.

## Examples

```bash
# In-place rename
/me:move old-name new-name

# Cross-folder move
/me:move old-name practices/new-name.md

# Nested note by bare stem (resolved recursively inside the layers)
/me:move 2026-07-28-example 2026-07-21-example

# Nested note by vault-relative path
/me:move knowledge/raw/records/work/org/2026-07-28-example.md cognition/example.md
```

## Output

The command reports:
- Move operation type (in-place rename or cross-folder move)
- Whether Obsidian CLI or native mode was used
- Wikilink rewrite status
- Verification that destination file exists

## Constraints

- Native mode handles `[[name]]`, `[[name|alias]]`, and `[[name#heading]]` variants using grep+sed
- Obsidian mode provides enhanced accuracy (alias resolution, metadata cache)
- All vault paths are relative to cwd
- Wikilinks use `[[Filename]]` without path prefix per D-08
- Layer directories resolved from `.me/config.yaml` at runtime
- Ordinary Markdown links (`[text](path)`) are NOT rewritten — only wikilinks are maintained
