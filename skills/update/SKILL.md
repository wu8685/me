---
name: update
description: "Use when an initialized ME vault needs its managed schema, config, or Agent navigation files migrated after the plugin is upgraded."
---

# /me:update

Preview and, only after explicit user confirmation, apply forward-only ME vault
migrations. Claude Code invokes this Skill as `/me:update`; Codex invokes it as
`$me:update`. Both interfaces have identical confirmation and recovery
semantics.

## Hard boundary

Never edit migration targets directly. Never apply without the digest from
the preview shown to the user in this conversation. Preview does not authorize
apply; the user's affirmative response does.

ME updates managed vault files only. Never run Git, create a commit, stage
files, push, or otherwise commit the user's vault.

## Step 1: Resolve exactly one target

Use cwd when no path is supplied. Otherwise accept one explicit vault path.
Reject multiple paths. The target must contain `.me/config.yaml`.

Resolve `PLUGIN_ROOT` without writing:

1. In Claude Code, if `CLAUDE_PLUGIN_ROOT` is non-empty, canonicalize it and
   use it.
2. Otherwise, in Codex, take the absolute path shown for this loaded
   `skills/update/SKILL.md` by the skill catalog and walk up from
   `skills/update/SKILL.md` to the plugin root. Concretely, canonicalize
   `dirname(<absolute-SKILL.md>)/../..`; do not derive it from cwd.
3. Verify `<PLUGIN_ROOT>/skills/update/SKILL.md`,
   `<PLUGIN_ROOT>/bin/update.ts`, and `<PLUGIN_ROOT>/bin/update/` exist.

Never expand an unset `CLAUDE_PLUGIN_ROOT` into `/bin/update.ts`. If neither
trusted source yields a verified absolute plugin root, stop without preview or
apply. Run the verified executable with Bun; do not reproduce its planning or
mutation logic in shell or edit a migration target yourself.

## Step 2: Preview

Run:

```bash
bun run "<PLUGIN_ROOT>/bin/update.ts" preview --vault-dir "<target>"
```

Parse the single structured JSON result.

- On `blocked`, any non-empty `conflicts`, `VAULT_NEWER_THAN_PLUGIN`, or any
  recovery state other than `none`, stop. Display all structured conflicts,
  warnings, and recovery actions. Do not apply.
- On `up_to_date`, report the current and target schema versions and return
  immediately.
- Only `preview` with a non-empty `planDigest` may continue.

## Step 3: Show the exact plan

Before asking for confirmation, display:

1. ordered migration IDs and descriptions;
2. every planned path;
3. every warning;
4. every exact diff returned by this preview.

Do not summarize away or omit a diff. Keep the returned `planDigest` bound to
this displayed preview.

## Step 4: Ask once

Ask one explicit confirmation question covering the whole displayed plan:

```text
Apply this exact ME vault migration plan?
```

This is the single explicit confirmation boundary. If the user declines or
does not affirm, report `not written` and stop without calling `apply`.

## Step 5: Apply the confirmed digest

After an affirmative response, pass the exact digest from Step 2:

```bash
bun run "<PLUGIN_ROOT>/bin/update.ts" apply \
  --vault-dir "<target>" \
  --expected-plan-digest "<planDigest>"
```

Never substitute a digest from another preview or conversation.

## Step 6: Report the structured result

Report the returned status, schema versions, migrations, changed paths,
warnings, conflicts, and recovery state/actions without inventing success.

- `committed` is the only successful write result.
- `STALE_PREVIEW` means the vault or plugin plan changed after confirmation.
  Nothing is authorized from the old preview: tell the user to run preview
  again and obtain a new explicit confirmation.
- `rolled_back` means no migration may be reported as committed.
- `recovery_required` / `manual` means stop and present every returned recovery
  action and preserved path. Do not retry or edit recovery material directly.
- Any other error is reported from the structured result; do not fall back to
  direct file edits.
