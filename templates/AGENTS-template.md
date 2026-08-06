<!-- me:managed:start knowledge-base -->
# Knowledge Base

This workspace is a three-layer knowledge vault managed by the me plugin. Knowledge flows through three layers:

- **raw** — Source material: translated articles, research docs, reference content. Objective, no personal interpretation.
- **practices** — Process material: practice records, experiments, feedback notes. Subjective, fragmentary.
- **cognition** — Distilled knowledge: high-value stable insights that guide decisions.

Layers cross-reference freely via wikilinks (`[[Note Name]]`). No directional constraint.
<!-- me:managed:end knowledge-base -->

<!-- me:managed:start configuration -->
## Configuration

Layer directories are configured in `.me/config.yaml`. The defaults are `raw/`, `practices/`, `cognition/`, but your workspace may use different directory names (configured during `$me:setup`).

To check your layer mapping:

```bash
cat .me/config.yaml
```
<!-- me:managed:end configuration -->

<!-- me:managed:start layer-map -->
## Layer Map

| Layer | Directory | Purpose | Write here when... |
|-------|-----------|---------|-------------------|
| Raw | per `.me/config.yaml` (default: `raw/`) | Source material, translated articles, reference docs | Ingesting external content |
| Practices | per `.me/config.yaml` (default: `practices/`) | Practice records, experiments, process notes | Recording what you tried |
| Cognition | per `.me/config.yaml` (default: `cognition/`) | Distilled insights, stable knowledge | Insight is proven by practice |
<!-- me:managed:end layer-map -->

<!-- me:managed:start commands -->
## Commands

| Command | Action |
|---------|--------|
| `$me:setup` | Initialize this workspace (already done) |
| `$me:update` | Preview and, after explicit confirmation, apply forward-only managed vault migrations |
| `$me:ingest <url> [--mode translate-cn\|summarize\|raw\|transcribe]` | Ingest URL into structured note in the raw layer. Supports HTML articles (auto-detects language/mode) and Bilibili videos (metadata + CC; `--mode transcribe` forces whisper ASR when no CC) |
| `$me:checklinks [layer]` | Check vault link health — broken wikilinks, orphans, dead-ends (optionally filter by layer) |
| `$me:autolinks [file] [layer]` | Auto-add wikilinks via LLM concept extraction matched against vault index (bulk or single-note) |
| `$me:backlinks <note>` | Discover backlinks and unlinked mentions for a note |
| `$me:move <file> <dest>` | Move/rename a note with wikilink integrity preserved |
| `$me:search [query] [--tags t1,t2] [--layer L] [--after date] [--before date]` | Search vault by content, tags, layer, date, or wikilink connections |
<!-- me:managed:end commands -->

<!-- me:managed:start note-templates -->
## Note Templates

When creating new notes, use the appropriate template from the plugin:

- Raw layer notes → use `raw-template.md` (type: article, source: URL)
- Practices layer notes → use `practices-template.md` (type: experiment, project field)
- Cognition layer notes → use `cognition-template.md` (type: insight, confidence field)

Frontmatter schema is defined in `SCHEMA.md` in this workspace root.
<!-- me:managed:end note-templates -->

<!-- me:managed:start after-creating-a-note -->
## After Creating a Note

After creating or filing a new note in any layer:

1. Run `$me:backlinks <new-note-name>` to discover:
   - Existing notes that already reference related topics
   - Unlinked mentions — notes that mention the new note's title but don't wikilink to it

2. Present results as suggestions. Do NOT auto-insert wikilinks — let the user decide which connections to make.

3. Use `[[filename]]` syntax (no path prefix). Wikilinks can cross any layer boundary freely.
<!-- me:managed:end after-creating-a-note -->

<!-- me:managed:start search -->
## Search

Use `$me:search` as the primary search tool — it combines free-text, tags, layer, date, and wikilink filters:

```
$me:search transformer                          # free-text search
$me:search --tags ai,ml                         # filter by tags (OR logic)
$me:search --layer raw --after 2026-03          # layer + date filter
$me:search attention --tags ai --layer raw      # combined filters
$me:search --linked-to "my-note"                # find notes linking to a note
$me:search --before 2026-04-01 --limit 50       # date + limit
```

For quick grep queries (replace dirs with your `.me/config.yaml` values):

```bash
# Find notes by project
grep -rl "project: myproject" practices/

# Find all high-confidence cognition notes
grep -rl "^confidence: high" cognition/ --include="*.md"

# Find notes by type
grep -rl "^type: insight" --include="*.md" .
```
<!-- me:managed:end search -->

<!-- me:managed:start conventions -->
## Conventions

- **Filenames:** `YYYY-MM-DD-short-slug.md` for new notes
- **Wikilinks:** `[[filename]]` without path — Obsidian resolves by name
- **Frontmatter:** defined in `SCHEMA.md` — do not add ad hoc fields
- **No lifecycle field:** The directory IS the knowledge level. No `status:` or `lifecycle:` field.
- **Link health:** Run `$me:checklinks` periodically to catch broken wikilinks, orphans, and dead-ends. Filter by layer: `$me:checklinks raw`
- **Auto-link:** Run `$me:autolinks` to batch-add wikilinks, or `$me:autolinks raw/my-note.md` for a single note
- **Move/rename:** Always use `$me:move` for wikilink-safe file operations — never shell `mv`
- **Layer directories:** Configured in `.me/config.yaml` — all commands read from this config.
<!-- me:managed:end conventions -->
