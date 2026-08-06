# me Frontmatter Schema

> **LOCKED** — This schema is the canonical frontmatter contract for all me notes.
> No ad hoc fields are allowed (per D-08). Field names defined here propagate to every
> template, skill, and grep query in the system. Changes require a deliberate schema migration.

---

## Core Fields

All layers (raw, practices, cognition — directory names per `.me/config.yaml`) share these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Human-readable title of the note |
| `created` | YYYY-MM-DD (ISO 8601) | yes | Note creation date |
| `tags` | list | yes | Topic tags for search and filtering |
| `type` | string | yes | Note type — controlled vocabulary: `article`, `concept`, `reflection`, `experiment`, `insight` |
| `source` | string | yes | Origin URL or `[[wikilink]]` to source note |

---

## Per-Layer Extensions

Each layer adds fields beyond the core set. Only the fields listed here are permitted.

### `raw/` Layer (default directory: `raw/` — actual path from `.me/config.yaml`)

Source material: translated articles, research docs, reference content.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | URL string | yes | The original source URL (overrides core definition — must be a URL in `raw/`) |

No additional fields beyond core. The `source` field is always a URL in this layer.

### `practices/` Layer (default directory: `practices/` — actual path from `.me/config.yaml`)

Process material: practice records, experiments, feedback notes.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | optional | Project or context this practice belongs to. Wikilink allowed: `[[ProjectName]]` |

### `cognition/` Layer (default directory: `cognition/` — actual path from `.me/config.yaml`)

Distilled knowledge: high-value stable insights that guide decisions.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confidence` | enum | yes | Maturity of this distilled insight: `low` \| `medium` \| `high` |

---

## Design Notes

### D-06: No `status:` or `lifecycle:` Field

The directory IS the knowledge level indicator. There is no `status:` field anywhere in this schema.

- raw layer (default: `raw/`) = source material (objective, unprocessed)
- practices layer (default: `practices/`) = process material (subjective, fragmentary)
- cognition layer (default: `cognition/`) = distilled knowledge (high value, stable)

To query by knowledge level, use the layer directory path (from `.me/config.yaml`):

```bash
# All raw notes tagged "machine-learning" (replace raw/ with your configured raw dir)
grep -rl "machine-learning" raw/ --include="*.md"

# All practice notes for a project (replace practices/ with your configured practices dir)
grep -rl "^project:" practices/ --include="*.md"

# All high-confidence cognition notes (replace cognition/ with your configured cognition dir)
grep -rl "^confidence: high" cognition/ --include="*.md"
```

### Field Naming Rationale

- `created` replaces the deprecated `date_created` used by the `translate-research-doc` skill. Phase 2 will migrate that skill to write `created:` instead.
- `source` is a polymorphic field: URL string in `raw/`, wikilink `[[Note Name]]` in `practices/` and `cognition/`. Single field handles all provenance tracking.
- `type` uses a controlled vocabulary so notes are classifiable without free-text search: `article` (raw layer), `concept` (raw layer), `experiment` (practices layer), `reflection` (practices layer), `insight` (cognition layer).

### Forbidden Fields

The following fields must NEVER appear in any me note:

- `status:` — prohibited by D-06
- `lifecycle:` — prohibited by D-06
- `date_created:` — deprecated; replaced by `created:`

---

## YAML Examples

One valid frontmatter block per layer. These examples use default directory names (`raw/`, `practices/`, `cognition/`). Your workspace may use different names — check `.me/config.yaml`.

### `raw/` Layer Example (default name)

```yaml
---
title: "Attention Is All You Need — Summary"
created: 2026-04-05
tags: [transformer, attention, deep-learning]
type: article
source: "https://arxiv.org/abs/1706.03762"
---
```

### `practices/` Layer Example (default name)

```yaml
---
title: "Implementing Self-Attention from Scratch"
created: 2026-04-06
tags: [transformer, pytorch, experiment]
type: experiment
source: "[[raw/2026-04-05-attention-is-all-you-need]]"
project: "[[ml-study-2026]]"
---
```

### `cognition/` Layer Example (default name)

```yaml
---
title: "Attention Mechanisms Generalize Across Domains"
created: 2026-04-10
tags: [transformer, attention, architecture-principle]
type: insight
source: "[[practices/2026-04-06-implementing-self-attention]]"
confidence: medium
---
```
