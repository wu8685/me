# Development Guide

## Version Bump Checklist

When bumping the version, update versioned metadata in sync:

1. `package.json` — `"version"` field
2. `.claude-plugin/plugin.json` — `"version"` field
3. `.claude-plugin/marketplace.json` — `plugins[0].version` field
4. `.codex-plugin/plugin.json` — `"version"` field

Forgetting plugin metadata files will cause plugin registries to show a stale version. The Codex marketplace at `.agents/plugins/marketplace.json` has no version field; it points Codex at the plugin root, and Codex reads the version from `.codex-plugin/plugin.json`.

## Plugin Path Resolution

Claude Code skills reference bin/ scripts via `${CLAUDE_PLUGIN_ROOT}` — an environment variable set by Claude Code that points to the plugin's installation directory (e.g. `~/.claude/plugins/cache/me-marketplace/me/1.2.3/`).

Codex installs the same `skills/` directory from `.codex-plugin/plugin.json` (`"skills": "./skills/"`) and exposes them as `me:*` skills. In Codex, invoke a skill from `/skills` or mention it explicitly, e.g. `$me:setup`; do not document `/me:*` as a Codex slash command unless Codex adds that support.

**Do NOT use:**
- `$(pwd)/bin/...` — resolves to the user's workspace, not the plugin directory
- `${BASH_SOURCE[0]}` — skills are not executed as bash scripts; Claude reads them and runs commands individually

**Correct pattern:**
```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
bun run "$PLUGIN_ROOT/bin/xxx.ts" "$(pwd)" ...
```

## Template Sync Check

On every version bump, review `templates/CLAUDE-template.md` against the current skill surface:

1. Scan all `skills/*/SKILL.md` — check for new commands, renamed flags, or changed usage patterns
2. Compare with `templates/CLAUDE-template.md` — the Commands table, Search section, and Conventions must reflect the latest skill interfaces
3. If there are differences, update the template before committing the version bump

This ensures that workspaces refreshed via `/me:setup` after a plugin update get an accurate CLAUDE.md.

## Release Steps

1. Update version in all versioned metadata files listed above
2. Review and sync `templates/CLAUDE-template.md` with latest skill changes (see Template Sync Check)
3. Commit: `git commit -m "chore: bump plugin version to X.Y.Z"`
4. Push: `git push`
