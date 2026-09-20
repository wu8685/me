# Semantic Wikilink Health Design

**Status:** Approved
**Date:** 2026-09-20
**Scope:** `/me:checklinks` and the native wikilink graph scanner. No
implementation is included in this document.

## 1. Problem

The current scanner equates “no Markdown file has this basename” with “broken
wikilink.” That is the wrong model for this vault.

A wikilink is also a graph identifier. Notes can independently write
`[[宋鸿兵]]` or `[[美元环流]]` and become mutually discoverable through that
shared node even before a hub note exists. Requiring every identifier to point
to one concrete article destroys this center-node behavior and turns healthy
graph structure into hundreds of false alarms.

The scanner also reports link-shaped examples in code, fails to resolve valid
targets outside the configured knowledge layers, and does not reliably resolve
path-qualified links or non-Markdown assets.

## 2. Goals

The revised command must:

- preserve bare unresolved wikilinks as valid virtual center nodes;
- distinguish virtual nodes from references that clearly intend a concrete
  file or note;
- report a concrete reference as broken only when its target is absent;
- resolve targets against the whole vault while limiting orphan and dead-end
  metrics to the configured knowledge layers;
- ignore wikilink-shaped literals in fenced code, inline code, and template
  placeholders;
- produce the same semantic result whether or not Obsidian is running;
- preserve the existing `links` map contract used by backlinks and search.

## 3. Non-goals

This change does not:

- create a hub note for every virtual node;
- decide whether a concept deserves a dedicated note;
- rewrite note content or repair links automatically;
- validate heading or block anchors inside an existing note;
- implement every detail of Obsidian's duplicate-name ranking algorithm;
- include files outside configured layers in orphan or dead-end counts.

## 4. Source and target scope

### 4.1 Source notes

Only Markdown notes under the three layer directories resolved from
`.me/config.yaml` contribute outgoing graph edges and participate in orphan and
dead-end metrics. No layer path may be hardcoded.

### 4.2 Target inventory

A target may exist anywhere under the vault root, including:

- another configured knowledge layer;
- `Memory/`, `TODO/`, templates, or another user-authored directory;
- a non-Markdown attachment such as PNG, PDF, JSON, audio, or video.

Internal control trees such as `.git/`, `.obsidian/`, `.me/`, and dependency or
cache directories are not user-facing link targets and are excluded from the
basename inventory. An explicit safe vault-relative path may still be checked
directly, but it must not escape the vault root.

## 5. Parsing contract

For every source note, the scanner extracts `[[target]]`,
`[[target|alias]]`, `[[target#heading]]`, and `![[target]]` while retaining
whether the occurrence is an embed.

Before extraction, the scanner masks:

- fenced code blocks using backtick or tilde fences;
- inline code spans delimited by backticks.

YAML frontmatter remains scannable because wikilinks in fields such as `source`
are intentional graph edges.

Targets containing wildcard/template markers such as `*`, `${…}`, or `<…>` are
classified as placeholders and omitted from graph health metrics.

## 6. Resolution

Resolution is case-insensitive and strips the display alias and heading/block
suffix before lookup.

The resolver checks, in order:

1. an explicit normalized vault-relative path, with or without the `.md`
   suffix;
2. a whole-vault basename match, with or without the `.md` suffix;
3. a whole-vault exact filename match for attachments and other non-Markdown
   files.

A target is considered resolved when at least one safe vault entry matches.
Duplicate basenames are sufficient for link-health purposes: ambiguity may be
reported later, but it is not absence and therefore is not a broken link.

For incoming-link and orphan calculations, a resolved Markdown target is
credited to the matching layer note. Path-qualified links must therefore count
as incoming links to their actual note rather than to the raw path string.

## 7. Semantic classification

Every extracted occurrence belongs to exactly one category.

### 7.1 Resolved reference

The target resolves to an existing vault entry. It is healthy.

### 7.2 Virtual wikilink node

The target is unresolved but is a bare semantic identifier. Examples:

- `[[宋鸿兵]]`
- `[[美元环流]]`
- `[[AI Agent]]`

It remains a graph edge and is reported as a virtual node, not an error. This
rule applies even when the node currently has only one occurrence; occurrence
count measures connectivity, not validity.

### 7.3 Broken concrete reference

An unresolved occurrence is broken when at least one of these signals shows
that it intends a concrete resource:

- it is an embed (`![[…]]`);
- it contains a path-like separator without surrounding whitespace, such as
  `Memory/原则` or `images/chart.png`; a spaced slash in a semantic label such
  as `OpenClaw 多 Session / Agent` does not make the node a file path;
- it ends with a recognized vault file extension, including Markdown,
  document, data, image, audio, and video formats;
- its final path component starts with an ISO date prefix
  (`YYYY-MM-DD-…`), the vault's note-filename convention.

This category catches missing attachments and renamed or deleted note files
without treating a concept node as defective.

### 7.4 Ignored placeholder

The target is a wildcard or template expression. It is documentation syntax,
not a graph edge, and appears only in an optional ignored count.

## 8. Report contract

`/me:checklinks` uses the native graph as its authoritative semantic engine.
It must not switch definitions based on Obsidian CLI availability because
Obsidian's “unresolved” category intentionally includes virtual nodes.

The report contains:

1. **Broken Concrete References** — one entry per occurrence, with source;
2. **Virtual Wikilink Nodes** — grouped by normalized target, with occurrence
   and source-note counts, explicitly labeled “not errors”;
3. **Orphaned Notes** — configured-layer notes with no incoming resolved note
   link;
4. **Dead-End Notes** — configured-layer notes with no outgoing real graph
   edge; ignored code/placeholders do not prevent dead-end status;
5. a summary with separate broken-reference and virtual-node totals.

Layer filtering applies to source notes for broken and virtual occurrences, and
to the note path for orphan and dead-end results. A target string is not a
filesystem path and must not be used to decide its layer.

## 9. Compatibility

`buildGraph()` keeps these existing fields:

- `files`
- `links`
- `broken`
- `orphans`
- `deadends`

`links` continues to map each configured-layer source file to normalized target
identifiers so `backlinks`, `search --linked-to`, and existing callers keep
working. New structured fields may expose occurrence metadata, virtual nodes,
and ignored placeholders. `broken` changes from “all unresolved targets” to
“unresolved concrete references,” which is the intended bug fix.

## 10. Acceptance matrix

| Input | Vault state | Expected classification |
|---|---|---|
| `[[宋鸿兵]]` | no same-named note | virtual node |
| `[[宋鸿兵]]` | same-named note anywhere in vault | resolved |
| `[[Memory/原则]]` | `Memory/原则.md` exists | resolved |
| `[[模板]]` | `模版/模板.md` exists outside layers | resolved |
| `[[knowledge/raw/a/note]]` | note exists | resolved and credited as incoming |
| `[[OpenClaw 多 Session / Agent]]` | no same-named note | virtual node |
| `![[images/chart.png]]` | image exists | resolved |
| `![[missing.png]]` | image absent | broken concrete reference |
| `[[2026-09-20-renamed-note]]` | note absent | broken concrete reference |
| `` `[[example]]` `` | any state | ignored literal |
| fenced `[[example]]` | any state | ignored literal |
| `[[讲义_*]]` | any state | ignored placeholder |

## 11. Verification

Implementation follows TDD:

1. add focused shell tests for every acceptance row and confirm they fail on
   the current implementation;
2. implement the minimum scanner and reporter changes;
3. run focused tests, then `bash test/vault-test.sh`;
4. run the command against `brain-spark` and verify that bare concept nodes are
   no longer counted as broken while the two known absent image embeds remain
   broken;
5. run `git diff --check` and review the user-facing report.
