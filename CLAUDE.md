<!-- GSD:project-start source:PROJECT.md -->
## Project

**me**

A Claude Code plugin that gives any workspace knowledge management capabilities. When installed, it provides skills, hooks, and templates for a three-layer knowledge flow system (raw → practices → cognition). The target workspace doubles as an Obsidian vault and git repo — same directory, no sync. Built for personal use, evolving toward automated knowledge processing and eventually a digital twin.

**Core Value:** A reusable plugin that turns any workspace into a knowledge flywheel — ingest research, record practice, distill cognition — with zero infrastructure beyond Git + Markdown + Claude Code.

### Constraints

- **Distribution**: Claude Code plugin — installable to any workspace
- **Storage**: Git + Markdown only — no database, no vector store, no external services in L1
- **Interface**: Claude Code Skills as primary interaction; CLI for automation-friendly operations
- **Architecture**: Target workspace = Obsidian vault = Git repo (single directory)
- **Lifecycle transitions**: Manual commands only in L1 — no auto-advancement
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Interface Layer: Claude Code Skills
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Claude Code Skills | Current (agentskills.io open standard) | Primary user interface for all me operations | Existing `translate-research-doc` and `search-ai-hot-doc` skills prove the pattern. Skills in `~/.claude/skills/` are personal-scoped (all projects). Supports `$ARGUMENTS`, `context: fork`, `allowed-tools`, and `hooks` frontmatter. |
| SKILL.md frontmatter | As of Claude Code 1.x | Skill configuration (invocation control, tool access, subagent routing) | `disable-model-invocation: true` for side-effect skills (lifecycle transitions). `context: fork` for isolated research tasks. `allowed-tools` to scope permissions per skill. `paths:` globs to auto-activate per folder. |
| Supporting files pattern | Current | Reference docs, templates, scripts bundled alongside SKILL.md | Keep SKILL.md under 500 lines; move templates and reference docs to `references/` subdirectory. Skills load supporting files on demand — zero context cost when idle. |
### Storage Layer: Git + Markdown
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Git | Any recent | Version control, history, diff, revert | Lifecycle transitions become commits. `git log` is the audit trail. `git diff` shows knowledge evolution. Zero infrastructure. |
| Markdown (CommonMark + Obsidian extensions) | n/a | Note format | Plain text = grep-able, diff-able, portable. Obsidian Flavored Markdown adds wikilinks (`[[Note]]`), callouts, embeds — all backward-compatible with raw text tools. |
| YAML frontmatter | n/a | Structured metadata for search, lifecycle, classification | The query layer without a database. Fields are grep-able. `grep -rl "^lifecycle: digest" --include="*.md" .` is the search primitive. |
### Vault Integration: Obsidian CLI (Official)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Obsidian CLI (`obsidian` binary) | Requires Obsidian 1.12+ (early access, Catalyst license) | Read, write, search, append notes via terminal; property manipulation | Official first-party CLI. Already has a skill (`obsidian-cli`) in `~/.claude/skills/` that covers the full command surface. Requires Obsidian app to be running. |
| obsidian-markdown skill | Current | Authoring Obsidian Flavored Markdown correctly | Already exists at `~/.claude/skills/obsidian-markdown/`. Reference `CALLOUTS.md`, `EMBEDS.md`, `PROPERTIES.md` supporting files. |
### Search Layer: grep + frontmatter
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `grep -rl` | POSIX | Full-text and frontmatter search | Zero infrastructure. `grep -rl "^lifecycle: ingest" --include="*.md" .` returns all ingest-stage files instantly. Composable with `xargs`, `sort`, `head`. |
| `awk` | POSIX | Frontmatter-scoped extraction | Parse between `---` delimiters to avoid false positives in body text. `awk '/^---/{f=!f; next} f && /lifecycle: absorb/' **/*.md` is frontmatter-only. |
| `fmd` (optional, future) | Cargo install | Fast parallel frontmatter field filtering | Rust CLI built for exactly this use case. `fmd -f "lifecycle:digest"` is cleaner than awk. Defer to L2 — `grep`/`awk` is sufficient for L1 and has zero setup. |
### Metadata Schema (Frontmatter Convention)
# Identity
# Lifecycle (the core me dimension)
# Provenance
# Timestamps
# Practice tracking (attached to digest+ docs)
### Automation Layer: Bash + Claude Code Hooks
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Bash scripts | POSIX sh | CLI-friendly lifecycle commands, metabolism reports | Called from skills or standalone. `bash transition-stage.sh <file> digest` updates frontmatter and commits. Zero runtime dependencies. |
| Claude Code hooks (`~/.claude/settings.json`) | Current | Session orientation, post-tool automation | `PostToolUse` hook fires after file writes — can auto-commit or surface pending items. Already in settings infrastructure. |
| `obsidian property:set` | Official CLI | Programmatic frontmatter updates without file parsing | More reliable than sed for YAML property updates. Requires Obsidian running. Fallback: `yq` for offline edits. |
### Content Extraction: Web Reader MCP
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `mcp__web_reader__webReader` | MCP (already configured) | URL → structured markdown content extraction | Already proven in `translate-research-doc` skill. `return_format=markdown` strips boilerplate. No alternative needed — MCP server is the existing dependency. |
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Interface | Claude Code Skills | Obsidian plugins | Skills work from terminal without Obsidian running; no plugin API learning curve; fits "CLI-first" constraint |
| Interface | Claude Code Skills | Custom CLI tool (Python/Go) | Skills reuse Claude's reasoning for classification/topic detection; no separate binary to maintain |
| Storage | Git + Markdown | SQLite / Notion / Logseq | Constraint from PROJECT.md: no database in L1; Notion is cloud-locked; Logseq has different file conventions |
| Search | grep + awk | Dataview plugin | Dataview requires Obsidian running; grep works from any terminal context including skills |
| Search | grep + awk | Vector embeddings | Out of scope (L2); requires infrastructure |
| Vault integration | Official Obsidian CLI | `notesmd-cli` (Go) | Official CLI already wrapped by existing skill; community tool adds nothing |
| Frontmatter updates | `obsidian property:set` | `sed` / `python` | Obsidian CLI is YAML-aware; sed is fragile on YAML; python requires parsing logic |
| Frontmatter updates (offline) | `yq` | `sed` | `yq` is YAML-aware; sed corrupts multiline values |
## Installation & Setup
# Obsidian CLI (requires Obsidian 1.12+, Catalyst license)
# Enable in Obsidian: Settings → General → Command Line Interface
# Follow on-screen instructions to add to PATH
# Verify
# yq (for offline frontmatter edits, fallback)
# No other runtime dependencies for L1
## Skill Structure Convention
## Confidence Assessment
| Component | Confidence | Basis |
|-----------|------------|-------|
| Claude Code Skills (SKILL.md spec) | HIGH | Official docs fetched from `code.claude.com/docs/en/skills` |
| Obsidian CLI command surface | HIGH | Official docs at `help.obsidian.md/cli`; existing `obsidian-cli` skill verified |
| Git + Markdown storage | HIGH | Proven by an existing `translate-research-doc` workflow in a generic local vault at `<vault-root>` |
| YAML frontmatter as search layer | HIGH | Existing templates in vault (`文章摘录模版.md`) confirm the convention; grep patterns are POSIX-standard |
| Frontmatter schema (proposed) | MEDIUM | Schema is new design, not yet validated against actual usage patterns. Fields derived from PROJECT.md requirements. Will evolve. |
| `obsidian property:set` for programmatic updates | MEDIUM | Command verified in skill doc; not yet battle-tested for bulk transitions |
## Sources
- [Extend Claude with skills — Claude Code Docs](https://code.claude.com/docs/en/skills) (fetched 2026-04-04)
- [Obsidian CLI — Official Help](https://help.obsidian.md/cli)
- [Agent Skills open standard](https://agentskills.io)
- [Skill authoring best practices — Anthropic](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Existing skills: `~/.claude/skills/translate-research-doc/SKILL.md`, `~/.claude/skills/obsidian-cli/SKILL.md`, `~/.claude/skills/obsidian-markdown/SKILL.md` (read directly)
- Generic local vault templates: `<vault-root>/templates/` (read directly)
- [obsidian-claude-pkm starter kit](https://github.com/ballred/obsidian-claude-pkm) (referenced for auto-commit pattern)
- [fmd — Find Markdown by metadata](https://github.com/zhouer/fmd) (deferred to L2)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

## Conventions

- **TDD**: Write tests first, then implement. All code changes (including markdown command/template changes) must have corresponding tests in `test/vault-test.sh`. Run `bash test/vault-test.sh` to verify.
- **Layer directories**: Never hardcode `raw/`, `practices/`, `cognition/`. Resolve from `.me/config.yaml` with those as defaults.
- **Test command**: `bash test/vault-test.sh` (all tests) or `bash test/vault-test.sh test_name` (single test)



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
