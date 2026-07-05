# CLAUDE.md Smart Merge Rules

Used during version upgrade (Step 2b) when CLAUDE.md already exists.

## Template-owned sections (replace with latest)

These sections are maintained by the plugin — replace entirely with latest template content:

- `# Knowledge Base` (intro paragraph and layer descriptions)
- `## Configuration`
- `## Layer Map` (the table)
- `## Commands` (the command reference table)
- `## Note Templates`
- `## After Creating a Note`
- `## Search`
- `## Conventions`

## User-added sections (preserve)

Any `##` or `###` headers that do NOT exist in the template are user-added. Preserve them at their current position relative to other sections.

## Merge algorithm

1. Read current workspace CLAUDE.md
2. Read latest `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE-template.md`
3. For each section in the merged output:
   - **Template-owned** → use latest template content
   - **User-added** → preserve at original position
   - **New in template** → insert at position from template
   - **User content within template sections** → replaced (template sections are fully replaced)
4. Write merged result to `{target}/CLAUDE.md`

The merge is performed by Claude's reasoning — read both files and produce the merged output following these rules.
