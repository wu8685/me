---
name: route-check
description: "Use before creating or filing any vault note: applies the layer routing contract (semantic knowledge type > layer schema constraints > existing directory convention), blocks deterministic schema violations, and surfaces advisory semantic mismatches that need explicit confirmation. Read-only."
---

# /me:route-check

The pre-write layer decision contract. Run it before proposing any note write
to decide the destination layer and validate the candidate frontmatter.

## Routing precedence

```text
semantic knowledge type > layer schema constraints > existing directory convention
```

1. External source material or faithful source capture → **raw**.
2. Practice history, subjective observations, feedback, decisions, trade-offs,
   working conclusions → **practices**.
3. Stable reusable insight → **cognition**, only via the evidence-gated
   `/me:distill` flow.
4. Existing nearby notes are navigation evidence, never routing evidence — a
   misfiled legacy note does not justify copying its location.
5. If content mixes source material and judgment, preserve the source in raw
   and write the interpretation or decision in practices with a `[[wikilink]]`
   provenance back to the raw note.

## Usage

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# From a candidate file:
bun run "$PLUGIN_ROOT/bin/route-check.ts" --vault-dir "$(pwd)" --layer <raw|practices|cognition> --file <candidate.md>

# Or from stdin:
bun run "$PLUGIN_ROOT/bin/route-check.ts" --vault-dir "$(pwd)" --layer <layer> --stdin < <candidate.md>

# Explicit knowledge type overrides the heuristic classification:
bun run "$PLUGIN_ROOT/bin/route-check.ts" --vault-dir "$(pwd)" --layer <layer> \
  --knowledge-type <external-source|practice-record|distilled-insight> --file <candidate.md>
```

## Reading the result

The JSON report carries `status`:

- `ok` — the declared layer matches the semantic knowledge type and the
  frontmatter satisfies the layer schema. Proceed.
- `advisory` — a heuristic mismatch (for example
  `ROUTING_LAYER_NEEDS_CONFIRMATION`) or a cognition gate
  (`ROUTING_COGNITION_REQUIRES_DISTILL`). Show the advisory and its evidence
  to the user and ask for explicit confirmation; never treat the heuristic as
  certain, and never let a legacy neighbor override it silently.
- `blocked` — deterministic schema violations (`errors`): invalid `type` for
  the layer, non-URL raw `source`, missing required fields, forbidden fields.
  Do not write; fix the frontmatter or the destination layer first.

Exit codes: `0` ok/advisory, `2` invalid arguments, `3` blocked.

## Constraints

- Strictly read-only: the vault is never modified.
- Keyword/marker matches are signals, not proof of semantic type.
- Cognition writes remain gated by `/me:distill`; only pass `--via-distill`
  from that flow.
