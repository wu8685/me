---
name: doctor
description: "Use when a user asks why ME is misbehaving, what state a vault is in, whether the plugin or the vault is out of date, whether a workspace is a valid ME vault, or what to fix next for a ME workspace; strictly read-only, never upgrades or repairs."
---

# me:doctor

Explain the effective ME state of a workspace in one structured, read-only
report: resolved vault/plugin roots, locally available versions, config and
schema validity, managed Agent surfaces and section integrity, and unfinished
runtime lock/journal/recovery state — with stable finding codes, severities,
and recommended actions.

## Constraints (non-negotiable)

- **Read-only.** Never upgrade, migrate, repair, clean locks, stage, commit,
  push, or write anything. This Skill only inspects.
- **No network.** Base diagnostic never contacts npm, GitHub, or any service.
- **No directory creation.** Missing runtime directories must remain absent.
- **Not a process monitor.** Report state at a point in time; do not tail logs
  or watch for changes.
- Preserve ME 1.6.x confirmation/recovery semantics: never resolve a recovery
  or proceed past `manual_recovery` on doctor's word alone.

## Run the diagnostic

Resolve `PLUGIN_ROOT` to this installed plugin/repository and `VAULT_DIR` to
the current workspace, then run:

```bash
bun run "$PLUGIN_ROOT/bin/doctor.ts" --vault-dir "$VAULT_DIR"
```

Optional flags (all read-only):

```bash
bun run "$PLUGIN_ROOT/bin/doctor.ts" --vault-dir "$VAULT_DIR" \
  --plugin-root /path/to/me \
  --installed-version 1.6.0
```

- `--plugin-root` — point at a specific plugin checkout/install when the
  default (the plugin this Skill ships in) is not the one to diagnose.
- `--installed-version` — the version the marketplace installed, to surface a
  checkout-vs-installed mismatch without using the network. This is the only
  way the doctor learns the installed version: when run from a checkout it
  cannot discover the marketplace-installed version automatically, so without
  this flag `installedVersion` defaults to the checkout version and no
  mismatch is reported.

Exit code `0` means a report was produced; findings are still reported in the
JSON. Exit code `2` means invalid arguments. The report is contract v1
(documented in [`references/diagnostic-contract-v1.md`](references/diagnostic-contract-v1.md)).

## Render a concise summary

Parse the versioned JSON and render, in this order:

1. **Overall state** (`report.state`): `healthy` | `behind` | `malformed` | `future-schema`.
2. **Roots** (`report.roots`): vault resolved? runtime present?
3. **Versions** (`report.plugin`, `report.versions`): plugin version, source
   (`checkout`/`installed`), installed mismatch, manifest agreement.
4. **Config & schema** (`report.config`, `report.schema`): present/valid, and
   schema state `current` | `edited` | `future` | `malformed` | `missing`.
5. **Agent surfaces & managed sections** (`report.agents`,
   `report.managedSections`): mode (`dual`/`claude-only`/`codex-only`/`none`),
   and per-section states.
6. **Runtime** (`report.runtime`): locks, recoveries, legacy state, ingest
   pending — with exact recovery states and preserved paths.
7. **Findings** (`report.findings`): group by severity (`error` → `warning` →
   `info`), and for each finding quote `code`, `severity`, `message`, and
   `recommendedAction`.

Never claim a fix happened. Every recommended action is a *suggestion for the
user*, not a step this Skill performs.

## Classify the outcome for the user

| `report.state` | Meaning | Direction |
| --- | --- | --- |
| `healthy` | Everything this plugin understands is current and consistent. | No action. |
| `behind` | Vault or plugin is out of date (missing config/schema, an edited current schema, version mismatch, stale runtime lock, missing managed sections). | Apply the matching recommended actions. |
| `malformed` | Something is broken now (invalid config, unrecognizable schema, unrecognized runtime entry). | Inspect before anything else; do not auto-fix. |
| `future-schema` | Vault schema carries a deterministic marker declaring a newer revision than this plugin understands. | **Plugin upgrade**, not a vault migration. |

Distinguish the three fix families in every recommendation:

- **Plugin upgrade** — the installed plugin is older than the vault or the
  checkout (e.g. `SCHEMA_FUTURE`, `PLUGIN_INSTALLED_MISMATCH`).
- **Vault migration** — the vault needs `/me:setup` to refresh managed files
  (e.g. `SCHEMA_MISSING`, `SCHEMA_EDITED`, `CONFIG_MISSING`, managed-section
  findings).
- **Diagnosis** — runtime state needs manual inspection before the next write
  (e.g. `RUNTIME_*` findings).

## Safety boundaries

- If the report is `malformed` or contains `error` findings, say clearly that
  ME state needs inspection and give the findings. Do not write, repair, or
  promote anything.
- If `RUNTIME_*` findings appear, state the exact recovery states and preserved
  paths from `report.runtime.recoveries` and the legacy entries. Do not clear
  them.
- If a configured layer directory is missing, do not create it; report the
  missing path.
