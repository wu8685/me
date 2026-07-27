---
name: setup
description: "Use when a workspace needs initial ME vault setup. Existing ME vaults are handed off to me:update without writes."
---

# /me:setup

Initializes a new workspace vault at the current schema version. Claude Code
invokes this Skill as `/me:setup`; Codex invokes it as `$me:setup`.

## Step 1: Resolve the target

Use cwd as the target. If `$ARGUMENTS` contains one explicit path, use that
instead. Reject multiple target paths. Resolve every workspace path relative to
that target.

Resolve `PLUGIN_ROOT` without writing:

1. In Claude Code, if `CLAUDE_PLUGIN_ROOT` is non-empty, canonicalize it and
   use it.
2. Otherwise, in Codex, take the absolute path shown for this loaded
   `skills/setup/SKILL.md` by the skill catalog and walk up from
   `skills/setup/SKILL.md` to the plugin root. Concretely, canonicalize
   `dirname(<absolute-SKILL.md>)/../..`; do not derive it from cwd.
3. Verify that `<PLUGIN_ROOT>/skills/setup/SKILL.md`,
   `<PLUGIN_ROOT>/bin/setup-preflight.ts`, and both Agent templates exist.

Never expand an unset `CLAUDE_PLUGIN_ROOT` into `/bin/...` or `/templates/...`.
If neither trusted source yields a verified absolute plugin root, stop without
writing.

## Step 2: Stop for an existing vault

Check for `{target}/.me/config.yaml` before creating any directory, lock,
runtime namespace, or temporary file.

If it exists, perform **no writes at all** to the vault or runtime and report
exactly:

```text
me vault already initialized.
Run $me:update (Codex) or /me:update (Claude Code) to preview any required
vault migrations. No files changed.
```

Then stop. Existing-vault changes to `.me/config.yaml`, `SCHEMA.md`,
`CLAUDE.md`, and `AGENTS.md` belong exclusively to `me:update`; setup never
performs a direct upgrade.

## Step 3: Configure layer mapping (fresh only)

If `$ARGUMENTS` contains `--defaults`, use `raw`, `practices`, and `cognition`.
Otherwise scan for existing directories using
`<PLUGIN_ROOT>/skills/setup/references/layer-candidates.md`. If candidates are
found, show the proposed mapping and ask the user to confirm it. If none are
found, use the defaults.

## Step 4: Preflight every mutation target (fresh only)

Before the first `mkdir`, temp file, copy, append, or other write, run:

```bash
bun run "<PLUGIN_ROOT>/bin/setup-preflight.ts" \
  --vault-dir "<target>" \
  --raw-dir "<raw_dir>" \
  --practices-dir "<practices_dir>" \
  --cognition-dir "<cognition_dir>"
```

This read-only preflight must return `status: ready`. It checks the complete
prospective mutation set together:

- `.me/`, absent `.me/config.yaml`, every configured layer path, and each
  `.gitkeep`;
- existing `SCHEMA.md`, `CLAUDE.md`, `AGENTS.md`, and `.gitignore`;
- every path component, target type, symlink boundary, and write feasibility;
- both Agent files for duplicate, nested, mismatched, unknown, or incomplete
  ME markers, fenced ambiguity, and safe append/refresh semantics.

If preflight is blocked or fails, display its structured error and stop.
The entire vault and runtime must remain byte-for-byte unchanged. Do not create
schema v1 config, directories, or any partial managed file before all targets
pass.

## Step 5: Write the preflighted current vault (fresh only)

Only after the complete preflight succeeds, perform the exact preflighted
actions below. Do not rewrite a target that preflight found already current.
If a target no longer matches its preflighted state, stop instead of
overwriting it.

### Layer directories

Create the configured Raw, Practices, and Cognition directories and a
`.gitkeep` in each.

### Current managed files

1. Copy `<PLUGIN_ROOT>/templates/SCHEMA.md` to `SCHEMA.md`.
2. Apply `<PLUGIN_ROOT>/templates/CLAUDE-template.md` to `CLAUDE.md`.
3. Apply `<PLUGIN_ROOT>/templates/AGENTS-template.md` to `AGENTS.md`.

For both Agent files, follow
`skills/setup/references/merge-rules.md`. If the file is absent, create it
from the matching current template. If it already contains a valid ME managed
block, refresh only that block. If it is user-authored and unmarked, preserve
every existing byte and append the complete current ME block. Duplicate,
nested, mismatched, unknown, or incomplete markers are conflicts: stop instead
of guessing. Never overwrite user-authored Agent instructions.

### `.gitignore`

- If `.gitignore` is absent, create it from
  `<PLUGIN_ROOT>/references/gitignore-snippet.txt`.
- If it exists without an `.obsidian/` entry, append the snippet while
  preserving all existing bytes.
- If it already has an `.obsidian/` entry, leave it unchanged.

For this contract, an effective entry is a non-blank, non-comment line whose
content after trimming surrounding whitespace is exactly `.obsidian/`.
Preflight rejects more than one effective entry; comment-only mentions do not
count. Use the same rule during final validation.

Do not ignore `.me/`; portable config belongs in version control.

### Config — publish last

Only after every other preflighted target has been written successfully,
create `.me/` and publish `.me/config.yaml` last:

```yaml
# me plugin configuration
vault_schema_version: 1

layers:
  raw: "<raw_dir>"
  practices: "<practices_dir>"
  cognition: "<cognition_dir>"
```

Publishing config last prevents an incomplete fresh setup from claiming schema
version 1.

## Step 6: Validate the fresh vault

Before reporting success, read back the created files and verify:

- `.me/config.yaml` parses with `vault_schema_version: 1` and the confirmed
  three-layer mapping;
- every configured layer directory and `.gitkeep` exists;
- `SCHEMA.md` matches the current template;
- both Agent files contain one complete set of current ME managed markers and
  preserve all pre-existing bytes outside those markers;
- `.gitignore` contains exactly one effective `.obsidian/` entry.

If validation fails, report the failure and do not claim initialization
succeeded.

## Step 7: Report

Report the files and mapped layer directories actually created or safely
merged. Suggest `/me:ingest <url>` for Claude Code and `$me:ingest <url>` for
Codex. Do not run Git and do not commit the vault.

## Constraints

- Setup writes only portable vault content and does not create runtime directories.
- Host-local locks, staging, inbox, and recovery state live under
  `~/.me/runtime/vault-<path-hash>/`.
- Never store an absolute runtime path in `.me/config.yaml`.
- If a future mutation is needed, hand it to `$me:update` / `/me:update`;
  setup is fresh-install only.
- Layer paths always come from `.me/config.yaml` after initialization.
- No git hooks. No `status:` or `lifecycle:` frontmatter.
