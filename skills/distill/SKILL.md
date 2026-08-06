---
name: distill
description: "Use when the user wants to promote a practice note to a cognition-level insight, distill knowledge from practice evidence, or evaluate whether a practice is ready for cognition promotion; evidence-gated, requires manual review of the preview before applying."
---

# me:distill

Evaluate a practice note against deterministic evidence gates and, when all
gates pass, produce a cognition-level insight. The promotion is **never**
automatic — every distill requires an explicit human review of the exact preview
before the apply step writes anything.

## Constraints (non-negotiable)

- **Never auto-promote.** Preview always; apply only after explicit human confirmation.
- **Never delete or demote Practices.** The source practice note is preserved and linked.
- **No status/lifecycle frontmatter.** Distill does not modify the practice note.
- **Same-task/copied/child agents are not independent.** Evidence must come from
  genuinely separate projects or tasks.
- **PR merge/praise is not evidence or authorization.** Only verifiable claims count.
- **No bypass of the lock/transaction/recovery/confirmation flow.**
- **No commit/push.** Distill only writes to the vault; version control is manual.

## Default gates

| Gate | Requirement |
|------|-------------|
| `local-provenance` | Practice note exists in the configured practices layer with valid frontmatter. |
| `multiple-independent-cases` | At least one other independent case supports the practice. |
| `counterevidence-search` | Counterevidence has been explicitly searched for in the vault. |
| `no-unresolved-contradiction` | No unresolved high-severity contradictions remain. |
| `generalizes-beyond-task` | The insight applies beyond the originating task. |
| `clear-boundaries` | Practice note documents boundaries/limitations. |
| `justified-confidence` | Confidence level is justified by available evidence. |
| `review-trigger-set` | A review date or trigger condition is set. |
| `schema-valid-destination` | The cognition layer is configured and valid. |

## Run the preview

Resolve `PLUGIN_ROOT` to this installed plugin/repository and `VAULT_DIR` to the
current workspace, then run:

```bash
bun run "$PLUGIN_ROOT/bin/distill.ts" --vault-dir "$VAULT_DIR" preview --practice "practices/some-practice.md"
```

Optional flags:

```bash
bun run "$PLUGIN_ROOT/bin/distill.ts" --vault-dir "$VAULT_DIR" preview \
  --practice "practices/some-practice.md" \
  --gates local-provenance,multiple-independent-cases
```

- `--practice PATH` — vault-relative path to the practice note (required).
- `--gates gate1,gate2` — comma-separated gate names to run (default: all gates).

The output is a versioned JSON preview (`DistillPreviewV1`) containing:

- **`status`** — `preview` (all gates pass), `not_ready` (some gates fail), or `conflict`.
- **`previewDigest`** — SHA-256 of the entire preview state for exact-preview confirmation.
- **`plannedCognitionPath`** — where the cognition note will be written.
- **`plannedMarkdown`** — the exact cognition note content that will be written.
- **`gates`** — per-gate results with verdict (`pass`/`fail`/`insufficient_data`) and reason.
- **`cases`** — primary and independent case summaries.
- **`support`** — supporting evidence items with excerpts.
- **`contradictions`** — counterevidence items.
- **`independentCount`** — number of independent cases.
- **`boundaries`** — extracted boundary statements.
- **`confidence`** — justified confidence level.
- **`reviewTrigger`** — review date or condition.
- **`warnings`** — any warnings.

## Review the preview

Before applying, review:

1. **Gates**: Every gate must have `verdict: "pass"`.
2. **Planned markdown**: Read `plannedMarkdown` — this is exactly what will be written.
3. **Cases**: Confirm the independent cases are genuinely independent.
4. **Evidence**: Verify support and contradictions are accurate.
5. **Boundaries**: Ensure the boundaries section is complete.
6. **Confidence**: The confidence level should be justified.

Do NOT apply if:
- Any gate shows `fail` or `insufficient_data`.
- The planned markdown needs edits (re-run preview after editing the practice note).
- Independent cases are not genuinely independent.
- Counterevidence is unresolved.

## Apply the distillation

After confirming the preview, run:

```bash
bun run "$PLUGIN_ROOT/bin/distill.ts" --vault-dir "$VAULT_DIR" apply \
  --practice "practices/some-practice.md" \
  --preview-digest "<digest from preview>"
```

The apply step:
1. Re-reads the practice note from disk.
2. Re-runs all gate checks.
3. Re-generates the cognition markdown.
4. Verifies the preview digest matches (rejects if vault state changed).
5. Writes the cognition note via the shared vault-write transaction executor under lock.

The output is a versioned JSON result (`DistillResultV1`):
- **`status`** — `committed`, `not_ready`, `conflict`, `validation_failed`, or `manual_recovery`.
- **`operationId`** — vault-write operation ID.
- **`cognitionPath`** — vault-relative path to the created cognition note.
- **`changedPaths`** / **`plannedPaths`** — what was written.
- **`recoveryState`** — `none`, `retained-originals`, or `incomplete`.

## Safety boundaries

- If `status` is `not_ready`, the failed gates explain why. Address them before retrying.
- If `status` is `conflict`, the vault state changed between preview and apply. Re-run preview.
- If `status` is `manual_recovery`, inspect the recovery state before retrying.
- Never edit the cognition note directly after distillation — edit the source practice and re-distill.
- Never skip the preview step — apply always requires a fresh preview digest.
