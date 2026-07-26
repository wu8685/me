---
name: setup
description: "Use when a workspace needs initial ME vault setup or an existing ME vault needs its managed schema and navigation files upgraded."
---

# /me:setup

Initializes or upgrades a workspace vault.

## Step 1: Detect Target Workspace

Use cwd as target. If `$ARGUMENTS` contains a path, use that instead.

## Step 2: Route — Fresh Setup or Upgrade?

```bash
[ -f ".me/config.yaml" ] && echo "upgrade" || echo "fresh"
```

**If "upgrade"** → go to Step 2b (upgrade path below), then STOP.
**If "fresh"** → continue to Step 3.

### Step 2b: Version Upgrade Path

The workspace is already initialized. Refresh plugin-managed files only — do NOT touch `.me/config.yaml` or layer directories.

**2b-i. Refresh SCHEMA.md**

Read `${CLAUDE_PLUGIN_ROOT}/templates/SCHEMA.md` → write to `{target}/SCHEMA.md`.

**2b-ii. Smart-merge CLAUDE.md**

Read both files:
- Current `{target}/CLAUDE.md`
- Latest `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE-template.md`

Apply merge rules from `skills/setup/references/merge-rules.md`: replace template-owned sections with latest content, preserve user-added sections at their original positions.

Write merged result to `{target}/CLAUDE.md`.

**2b-iii. Report**

```
me vault already initialized — smart-merged CLAUDE.md and refreshed SCHEMA.md to latest plugin version.
Config unchanged: .me/config.yaml
```

Done. Do not continue to Step 3.

---

## Step 3: Configure Layer Mapping (fresh only)

If `$ARGUMENTS` contains `--defaults`, use defaults: `raw`, `practices`, `cognition`. Skip to Step 4.

Otherwise scan for existing directories that match known layer names. See `skills/setup/references/layer-candidates.md` for candidate lists and detection script.

If candidates found → present and ask user to confirm mapping via conversation.
If no candidates → use defaults.

## Step 4: Write .me/config.yaml (fresh only)

```bash
mkdir -p .me
```

Write `.me/config.yaml`:

```yaml
# me plugin configuration
# Layer directory mapping — maps logical layers to actual directory paths
layers:
  raw: "<raw_dir>"
  practices: "<practices_dir>"
  cognition: "<cognition_dir>"
```

## Step 5: Create Vault Directories (fresh only)

```bash
mkdir -p <raw_dir>/ <practices_dir>/ <cognition_dir>/
touch <raw_dir>/.gitkeep <practices_dir>/.gitkeep <cognition_dir>/.gitkeep
```

## Step 6: Write SCHEMA.md (fresh only)

Read `${CLAUDE_PLUGIN_ROOT}/templates/SCHEMA.md` → write to `{target}/SCHEMA.md`.

## Step 7: Write CLAUDE.md (fresh only)

Read `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE-template.md` → write to `{target}/CLAUDE.md`.

## Step 8: Configure .gitignore (fresh only)

- No `.gitignore` → create from `${CLAUDE_PLUGIN_ROOT}/references/gitignore-snippet.txt`
- `.gitignore` exists but no `.obsidian/` entry → append snippet
- Already has `.obsidian/` → skip

Do NOT add `.me/` to `.gitignore` — config should be tracked in git.

## Step 9: Report (fresh only)

```
me vault initialized.

Created:
  .me/config.yaml     (layer mapping: raw -> <raw_dir>, practices -> <practices_dir>, cognition -> <cognition_dir>)
  <raw_dir>/           (+ .gitkeep)
  <practices_dir>/     (+ .gitkeep)
  <cognition_dir>/     (+ .gitkeep)
  SCHEMA.md
  CLAUDE.md
  .gitignore           (added .obsidian/ entry)

Next steps:
  Run `/me:ingest <url>` to add your first research note.
```

## Constraints

- All workspace paths relative to cwd (or `$ARGUMENTS` path). Never absolute paths for target.
- Plugin files via `${CLAUDE_PLUGIN_ROOT}`.
- No git hooks (D-09). No `status:` or `lifecycle:` frontmatter (D-06).
- Layer directories always from `.me/config.yaml` — never hardcode `raw/`, `practices/`, `cognition/`.
- `.me/config.yaml` is committed to git — shared across machines.
- Setup writes only portable vault configuration and does not create runtime directories.
- Host-local locks, staging, inbox, and recovery data live outside the vault under `~/.me/runtime/vault-<path-hash>/`; never add an absolute runtime path to `.me/config.yaml`. If the vault is on another filesystem, require `ME_RUNTIME_ROOT` to point to an absolute same-filesystem directory; never choose a vault-adjacent fallback or cross-device copy.
