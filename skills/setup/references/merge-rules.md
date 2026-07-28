# Agent Instruction Managed Merge Rules

These Agent-neutral rules apply identically to workspace `CLAUDE.md` and
`AGENTS.md`. ME ownership markers are the primary and durable ownership
mechanism:

```html
<!-- me:managed:start configuration -->
## Configuration
...
<!-- me:managed:end configuration -->
```

Only content inside a complete, matching marker pair is plugin-owned. Preserve
every byte outside ME managed markers. Duplicate, nested, mismatched, unknown,
or incomplete markers are conflicts and must not be guessed through.

## Current managed section IDs

- `knowledge-base` — exact heading `# Knowledge Base`
- `configuration` — exact heading `## Configuration`
- `layer-map` — exact heading `## Layer Map`
- `commands` — exact heading `## Commands`
- `note-templates` — exact heading `## Note Templates`
- `after-creating-a-note` — exact heading `## After Creating a Note`
- `search` — exact heading `## Search`
- `conventions` — exact heading `## Conventions`

ATX headings inside fenced code blocks are opaque and never identify a
section.

## One-time legacy CLAUDE.md adoption

Version-zero setup emitted an unmarked `CLAUDE.md`. A migration may adopt the
exact historical template from
`templates/migration-history/0000/CLAUDE-template.md` once. The headings above
are the only recognized legacy ME headings. Duplicates, partial matches,
modified legacy sections, or ambiguous structure are migration conflicts.
There is no historical `AGENTS.md` template.

## Unrelated existing Agent instructions

When an existing unmarked `CLAUDE.md` or `AGENTS.md` has no legacy ME-owned
heading collision, preserve its existing bytes and append the complete current
marked template. Never reinterpret unrelated project instructions as
plugin-owned content.

An absent Agent file may be created from its current template. Repeating
create, legacy adoption, safe append, or marked replacement must be a no-op.
