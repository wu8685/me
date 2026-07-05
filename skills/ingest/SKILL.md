---
name: ingest
description: "Ingest a URL into the knowledge base. Claude Code: /me:ingest <URL>; Codex skill: me:ingest."
---

# /me:ingest

Fetches a URL and saves it as a structured research document in the raw layer.
Supports three modes: translate to Chinese, summarize, or save raw content.

All deterministic steps (config resolution, language detection, slug derivation,
vault indexing, auto-linking, related note scoring) run via `bin/ingest.ts`.
LLM reasoning is only used for translate-cn and summarize content transformation.

Layer directories resolve from `.me/config.yaml` (with raw/practices/cognition as defaults).

## Source Adapters

`extractContent(url)` in `bin/ingest.ts` dispatches to a source-specific adapter
based on URL shape. Downstream contract (frontmatter, auto-link, related-notes,
JSON output) is identical regardless of source.

- **HTML (default)** — `defuddle parse` pipeline. Handles articles, blogs, papers.
- **Bilibili** — API + CC subtitle pipeline. Auto-detected on URLs matching
  `bilibili.com/video/BV...` or `b23.tv/...`. When the video has no CC subtitle,
  falls back to `whisper` transcription via the `--mode transcribe` opt-in
  (see Step 2.5). yt-dlp + whisper-cpp must be installed for the fallback path.

## Step 1: Run scriptable pipeline

Parse `$ARGUMENTS` to get the URL (first token) and optional `--mode` flag.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
VAULT_DIR="$(pwd)"
URL="<first token from $ARGUMENTS>"
MODE_FLAG=""  # add "--mode raw" or "--mode translate-cn" etc. if --mode was specified

RESULT=$(bun run "$PLUGIN_ROOT/bin/ingest.ts" "$URL" $MODE_FLAG --vault-dir "$VAULT_DIR" 2>/dev/null)
```

If `bun run "$PLUGIN_ROOT/bin/ingest.ts"` fails, report the error to the user and stop.

Parse the JSON output. It contains:
- `title`: article title
- `slug`: kebab-case English slug (max 60 chars)
- `language`: "en" or "zh"
- `mode`: auto-detected mode ("translate-cn" for English, "summarize" for Chinese)
- `frontmatter`: YAML block with title, created, tags, type, source
- `content`: full extracted content
- `images`: array of image URLs found in the article
- `autoLinks`: array of wikilink stems inserted into body text
- `relatedNotes`: top 5 related vault notes by tag+keyword score

## Step 2: Confirm mode with user

Present the detected mode from the JSON output:

```
Detected: [English/Chinese] article.
Mode: [translate-cn/summarize/raw]
Override? (press Enter to accept, or type: translate-cn | summarize | raw)
```

Wait for user input. If user types a valid mode, update MODE_FLAG and re-run Step 1 with `--mode <new-mode>`.
If Enter (empty), proceed with the JSON output already obtained.

**If mode is "raw"**: write file directly from script output. Skip to Step 5.

## Step 2.5: Transcription opt-in (Bilibili only)

This step only fires when the JSON output from Step 1 contains
`"needsTranscription": true` (Bilibili video missing CC subtitles).

Check the `transcriptionAvailable` field:

- If `transcriptionAvailable: false`, surface the install hint and proceed with
  metadata-only content:

  ```
  视频无 CC 字幕。whisper 转录需要 yt-dlp + whisper-cpp：
    brew install yt-dlp
    brew install whisper-cpp
  继续以仅元数据模式入库（无字幕正文）。
  ```

- If `transcriptionAvailable: true`, prompt the user:

  ```
  视频无 CC，是否启动 whisper 转录？(y / n)
  ```

  - On `y`: append `--mode transcribe` to `MODE_FLAG` and re-run Step 1.
    Replace the JSON output with the new result (which now embeds the whisper
    transcript and omits `needsTranscription`).
  - On `n`: continue with metadata-only content from the original JSON.

## Step 3: LLM Processing (translate-cn or summarize only)

Apply the selected mode to `content` from the JSON output:

### Mode: translate-cn

Translate English content to Chinese. Rules:
- **Keep in English**: technical terms ("Prompt Engineering", "Chain-of-Thought"), product names ("OpenAI", "React"), framework names, function names, APIs, CLI commands, code block contents
- **Translate to Chinese**: narrative text, section titles (may keep key terms in parentheses), general descriptions and examples
- **Preserve exactly**: all code blocks, inline code, markdown formatting, image references, wikilinks already inserted by auto-linking

### Mode: summarize

Extract key points in the article's original language:
- 2-3 sentence overview of what the source says
- Bulleted key points (5-10 most important)
- Notable quotes or data points

### Output structure for ALL modes

The final file content MUST match `templates/raw-template.md` exactly. Use the `frontmatter` from the JSON output as-is — do NOT add status, lifecycle, or date_created fields:

```markdown
---
title: "Article Title Here"
created: YYYY-MM-DD
tags: [tag-one, tag-two]
type: article
source: "https://original-url.com"
---

<!-- Summary: 2-3 sentence overview of what this source says -->

## Key Points

- Key point one
- Key point two

## Raw Notes

[Processed content here]
```

See `skills/ingest/references/translation-guidelines.md` for extended translation examples.

## Step 4: Confirm topic folder with user

Analyze the slug from JSON output to suggest a topic folder:

```
Detected topic: ai-agents
Save to {raw_dir}/ai-agents/? (press Enter to accept, or type a different folder name)
```

Wait for user input. Validate that any override matches `^[a-z0-9-]+$`. Ask again if invalid.

## Step 5: Write file and post-process

Construct filename: `YYYY-MM-DD-{slug}.md` using date from frontmatter and slug from JSON.

Full path: `{raw_dir}/{topic}/{filename}`

Steps:
1. `mkdir -p {raw_dir}/{topic}`
2. Write the processed content with frontmatter from JSON output
3. Download images (with automatic retries on failure): `bun run "$PLUGIN_ROOT/bin/ingest.ts" --download-images --vault-dir "$VAULT_DIR" --target-dir "{raw_dir}/{topic}/images/" --urls "<comma-separated image URLs>"`
4. Update any downloaded image references from remote URLs to local `images/{filename}`
5. Report results from JSON output

```
Ingested: {title}
Mode: {mode}
Saved to: {raw_dir}/{topic}/{filename}
Auto-linked: {autoLinks joined with ", "}
Related notes: top results from relatedNotes array
Images: {N} downloaded locally, {M} preserved as remote
```

## Reference: Frontmatter Schema

Per `templates/SCHEMA.md` — raw layer fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | Human-readable article title |
| `created` | YYYY-MM-DD | yes | Script output uses `date +%Y-%m-%d` |
| `tags` | list | yes | 3-5 tags, English, kebab-case |
| `type` | string | yes | Always `article` for raw layer |
| `source` | URL string | yes | Original source URL |

**Forbidden fields**: status, lifecycle, the deprecated date_created field — directory is the lifecycle indicator (D-06)

Layer directories resolve from `.me/config.yaml`. Defaults: raw, practices, cognition.
