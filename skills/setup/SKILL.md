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
that target; resolve plugin resources through `${CLAUDE_PLUGIN_ROOT}`.

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
`references/layer-candidates.md`. If candidates are found, show the proposed
mapping and ask the user to confirm it. If none are found, use the defaults.

## Step 4: Write current portable config (fresh only)

Create `.me/` and write `.me/config.yaml`:

```yaml
# me plugin configuration
vault_schema_version: 1

layers:
  raw: "<raw_dir>"
  practices: "<practices_dir>"
  cognition: "<cognition_dir>"
```

## Step 5: Create layer directories (fresh only)

Create the configured Raw, Practices, and Cognition directories and a
`.gitkeep` in each.

## Step 6: Write current managed files (fresh only)

1. Copy `${CLAUDE_PLUGIN_ROOT}/templates/SCHEMA.md` to `SCHEMA.md`.
2. Apply `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE-template.md` to `CLAUDE.md`.
3. Apply `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS-template.md` to `AGENTS.md`.

For both Agent files, follow
`skills/setup/references/merge-rules.md`. If the file is absent, create it
from the matching current template. If it already contains a valid ME managed
block, refresh only that block. If it is user-authored and unmarked, preserve
every existing byte and append the complete current ME block. Duplicate,
nested, mismatched, unknown, or incomplete markers are conflicts: stop instead
of guessing. Never overwrite user-authored Agent instructions.

## Step 7: Configure `.gitignore` (fresh only)

- If `.gitignore` is absent, create it from
  `${CLAUDE_PLUGIN_ROOT}/references/gitignore-snippet.txt`.
- If it exists without an `.obsidian/` entry, append the snippet while
  preserving all existing bytes.
- If it already has an `.obsidian/` entry, leave it unchanged.

Do not ignore `.me/`; portable config belongs in version control.

## Step 8: Validate the fresh vault

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

## Step 9: Report

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
