---
name: ingest
description: Use when a URL, PDF, X article or video, Bilibili video, video handout, or Source Bundle needs ingest into an ME raw knowledge layer.
---

# /me:ingest

Ingest a source through the public adapter pipeline and its atomic finalizer.
Claude Code: `/me:ingest <source>`; Codex skill: me:ingest.
`bin/ingest.ts` owns detection, extraction, downloads, transcription, handout
formatting, schema checks, asset localization, indexing, and writes. Do not
reimplement those deterministic steps in the skill.

Layer directories come from `.me/config.yaml`. English articles default to
`translate-cn`, Chinese/中文 articles to `summarize`, and video/course sources to
`handout`. An explicit `raw`, `translate-cn`, `summarize`, `transcribe`, or
`handout` request overrides the default.

## Source Adapters

The CLI selects Bilibili, X, PDF, or HTML and reports `adapterId`,
`capabilities`, and `warnings`. Bilibili prefers CC and can fall back to local
`whisper` transcription. An explicit adapter failure must stay failed: never
ingest an X login shell, PDF abstract page, or generic error page as source
content.

Source Bundle input is a static interchange format, not executable code. Read
[`references/source-bundle-v1.md`](references/source-bundle-v1.md) only when
importing or producing a bundle.

## Workflow

### 1. Run a read-only probe/preview

Resolve `PLUGIN_ROOT` to this installed plugin/repository and `VAULT_DIR` to the
vault root. Run without `--write`:

```bash
bun run "$PLUGIN_ROOT/bin/ingest.ts" "$URL" --vault-dir "$VAULT_DIR"
# or
bun run "$PLUGIN_ROOT/bin/ingest.ts" --bundle "$BUNDLE_DIR" --vault-dir "$VAULT_DIR"
```

Inspect `mode`, `sourceKind`, `adapterId`, `capabilities`, `warnings`, and
`handoutKind`. Stop on a blocked source. A title without a real body is not
readable content.

### 2. Confirm mode and topic

Show the detected mode and suggest an ASCII kebab-case topic. Ask the user to
accept or override them, then rerun the preview with the exact choices:

```bash
bun run "$PLUGIN_ROOT/bin/ingest.ts" "$URL" \
  --vault-dir "$VAULT_DIR" --mode "$MODE" --topic "$TOPIC"
```

For bundles, replace `"$URL"` with `--bundle "$BUNDLE_DIR"`.

### 3. Apply only the necessary LLM edit

Write any processed input as **UTF-8 body-only Markdown** in a unique file under
`"$VAULT_DIR/.me/tmp/"`. Do not include frontmatter; the finalizer generates and
validates it.

**Translation (`translate-cn`):** translate narrative prose while preserving
Markdown structure, source order, wikilinks, code, image references, and all
substantive content.

**Summary (`summarize`):** compression is expected. Preserve source fidelity:
do not invent claims or omit key conclusions and the evidence needed to support
them. Keep relevant image references and provenance intact.

For `raw`, `transcribe`, and `handout`, use the deterministic CLI output.
`handout` is not a ten-point summary: it must retain the complete timestamped
transcript in sections. Read
[`references/handout-contract.md`](references/handout-contract.md) when handling
video/course output. Slide-driven requires real stable timestamped pages;
Topic-driven is required when those pages do not exist.

### 4. Finalize through the CLI

Never create the vault note or asset directories directly. For an LLM-edited
body:

```bash
bun run "$PLUGIN_ROOT/bin/ingest.ts" "$URL" \
  --vault-dir "$VAULT_DIR" --mode "$MODE" --topic "$TOPIC" \
  --processed-markdown "$VAULT_DIR/.me/tmp/$TEMP_FILE" --write
```

Without an edited body, omit `--processed-markdown`. For bundles, use
`--bundle "$BUNDLE_DIR"`. The finalizer creates the
`{raw_dir}/{topic}/YYYY-MM-DD-slug/` artifact, validates frontmatter and every
resource, localizes available assets, and updates reachability atomically.

The Agent's browser may produce a Source Bundle only when the public CLI cannot
read the source and the user already has lawful access. Never put browser login
state, cookies, Authorization headers, tokens, absolute paths, or DRM bypass
material in a bundle.

## Completion contract

Report:

- selected `mode`, `adapterId`, `capabilities`, `warnings`, and `handoutKind`
  exactly as returned by the preview;
- on success, only the paths, warnings, and link suggestions present in
  `writeResult`;
- on command failure or absent `writeResult`, that the source was not written
  and the exact reported error or warning.

Do not invent download counts, percentages, transcript indices, or files that
the CLI did not report. Metadata-only video/course output **不得报告完成**.
When `warnings` reports a failed or missing resource, surface it and label the
result incomplete; if finalization fails, report that nothing was written.
