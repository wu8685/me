---
name: remediate
description: "Use when me:doctor or a user confirms a note is filed in the wrong layer: produces a zero-write, digest-bound preview of the corrective move (frontmatter changes, index changes, wikilink rewrites) and applies it only after explicit confirmation. Never moves notes in bulk or automatically."
---

# /me:remediate

The remediation contract for a confirmed misfiled note. One note per
invocation, always preview-then-confirm. Uses the same link-safe relocation
behavior as `/me:move`, plus schema revalidation and rollback recovery.

## Flow

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"

# 1. Zero-write preview (nothing changes):
bun run "$PLUGIN_ROOT/bin/remediate.ts" preview \
  --vault-dir "$(pwd)" --note raw/2026-02-02-chose-option-b.md --to-layer practices \
  --markdown-file /tmp/corrected-note.md

# 2. Show the preview to the user: source/destination paths,
#    frontmatterChanges, wikilinkRewrites, indexChanges, validation.
#    Ask for explicit confirmation.

# 3. Apply, bound to the preview digest:
bun run "$PLUGIN_ROOT/bin/remediate.ts" apply \
  --vault-dir "$(pwd)" --note raw/2026-02-02-chose-option-b.md --to-layer practices \
  --markdown-file /tmp/corrected-note.md \
  --expected-plan-digest <planDigest from the preview>
```

- `--markdown-file` carries the corrected destination markdown when the
  frontmatter must change for the target layer (for example `type: article` →
  `type: reflection`, URL `source` → `[[wikilink]]` provenance). Without it
  the note moves unchanged; if the unchanged frontmatter violates the target
  layer schema the preview is `blocked` with the exact deterministic findings.
- The preview's `planDigest` binds every byte the plan will touch. If the
  vault drifts after the preview, apply refuses with `STALE_PREVIEW` — a
  preview never authorizes a different vault state. Re-preview and re-confirm.

## Guarantees

- **Zero-write preview**: preview changes nothing in the vault or runtime.
- **Confirmation**: apply requires the preview digest; the digest is the
  confirmation token, never a blanket approval.
- **Link safety**: path-qualified wikilinks (`[[layer/note]]`,
  `[[layer/note#heading]]`, `[[layer/note|alias]]`) are rewritten across all
  configured layers; bare `[[stem]]` links are unaffected by a same-stem move.
- **Index preservation**: layer `README.md` managed index blocks lose the old
  entry and gain the new one.
- **Post-validation**: schema routing, reference rewriting, and index
  reachability are re-checked after the move.
- **Recovery**: every touched byte is backed up under the ME runtime
  transaction directory before mutation; a failed apply rolls back and reports
  a truthful `recoveryState` with the preserved journal path.

## Exit codes

`0` preview/committed · `2` invalid request · `3` blocked (schema validation,
existing destination) · `4` stale preview · `5` rolled back / manual recovery.

## Boundaries

- Never run remediation without a confirmed diagnostic and explicit user
  confirmation.
- Never move notes in bulk; one note per invocation.
- Advisory (heuristic) findings alone do not justify a move — confirm with the
  user first.
