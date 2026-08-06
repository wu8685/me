# me:doctor — Diagnostic Contract v1

`bin/doctor.ts` prints one JSON object on stdout. Version field is `version: 1`.

## Invocation

```
Usage: doctor --vault-dir DIR [--plugin-root DIR] [--installed-version VERSION]
```

- Exit `0`: a report was produced (findings may still report problems).
- Exit `2`: invalid arguments — output is
  `{"status":"error","error":{"code":"INVALID_ARGUMENTS","message":"..."}}`.

## Top-level shape

```jsonc
{
  "version": 1,
  "state": "healthy",              // healthy | behind | malformed | future-schema
  "plugin": {
    "name": "me",
    "root": "/abs/plugin/root",
    "version": "1.6.1",
    "source": "checkout",          // checkout (has .git) | installed
    "installedVersion": "1.6.1",   // --installed-version, else plugin.version
    "installedMismatch": false
  },
  "roots": {
    "vault": { "resolved": true, "lexical": "/abs", "canonical": "/abs" },
    "runtime": { "root": "/abs/.me/runtime/vault-...", "exists": false }
  },
  "versions": {
    "package": "1.6.1",
    "codexPlugin": "1.6.1",
    "claudePlugin": "1.6.1",
    "claudeMarketplace": "1.6.1",
    "codexMarketplace": null          // .agents/plugins/marketplace.json has no version
  },
  "config": {
    "present": true,
    "valid": true,
    "parseError": null,
    "layers": { "raw": "raw", "practices": "practices", "cognition": "cognition" }
  },
  "schema": {
    "present": true,
    "state": "current",             // current | edited | future | malformed | missing
    "path": "/abs/vault/SCHEMA.md",
    "sha256": "<hex>"
  },
  "agents": {
    "claude": true,
    "codex": false,
    "mode": "claude-only"           // dual | claude-only | codex-only | none
  },
  "managedSections": {
    "source": "CLAUDE.md",
    "reordered": false,
    "sections": [
      { "heading": "Knowledge Base", "level": 1, "state": "present" }
      // state: present | missing | duplicated | malformed | customized
    ]
  },
  "runtime": {
    "exists": false,
    "locks": [ { "path": "<ME_RUNTIME>/locks/vault-write.lock", "size": 0 } ],
    "recoveries": [
      {
        "operationId": "abc123",
        "state": "incomplete-operation",   // or "unrecognized-operation"
        "directory": "<ME_RUNTIME>/transactions/vault-write-abc123",
        "journal": "<ME_RUNTIME>/transactions/vault-write-abc123/journal.json",
        "preservedPaths": ["<ME_RUNTIME>/transactions/vault-write-abc123"],
        "remainingMutations": ["Inspect the incomplete operation journal."],
        "actions": [
          { "kind": "inspect", "path": "<ME_RUNTIME>/transactions/vault-write-abc123",
            "condition": "Inspect the recovery entry before the next vault write." }
        ]
      }
    ],
    "legacy": [".me/locks/x.lock"],
    "ingestPending": ["<ME_RUNTIME>/ingest/staging/..."]
  },
  "findings": [
    {
      "code": "CONFIG_VALID",
      "severity": "info",           // info | warning | error
      "category": "config",          // roots | versions | config | schema | agents | managed-sections | runtime
      "message": "Layer configuration is valid.",
      "recommendedAction": "No action needed.",
      "path": "/abs/vault/.me/config.yaml",   // optional
      "details": { "heading": "Configuration" } // optional
    }
  ]
}
```

## Overall state

`report.state` is computed from findings, in order:

1. Any finding with code `SCHEMA_FUTURE` → `future-schema`.
2. Any `error` finding → `malformed`.
3. Any `warning` finding → `behind`.
4. Otherwise → `healthy`.

## Finding codes and severities

| Code | Severity | Category | Meaning |
| --- | --- | --- | --- |
| `VAULT_NOT_FOUND` | error | roots | Vault dir missing or not a directory |
| `VAULT_UNSAFE` | error | roots | Vault root cannot be canonicalized safely |
| `RUNTIME_UNSAFE` | error | roots | Runtime layout cannot be resolved safely |
| `CONFIG_VALID` | info | config | `.me/config.yaml` parses |
| `CONFIG_MALFORMED` | error | config | `.me/config.yaml` present but invalid |
| `CONFIG_MISSING` | warning | config | `.me/config.yaml` absent (not initialized) |
| `LAYER_DIR_MISSING` | warning | config | Configured layer directory absent |
| `SCHEMA_CURRENT` | info | schema | Schema matches the current plugin |
| `SCHEMA_EDITED` | warning | schema | Schema differs from current but has no future revision marker |
| `SCHEMA_FUTURE` | warning | schema | Schema declares a newer revision than this plugin understands |
| `SCHEMA_MALFORMED` | error | schema | Schema present but not a recognizable ME schema |
| `SCHEMA_MISSING` | error | schema | `SCHEMA.md` absent |
| `PLUGIN_VERSION_CONSISTENT` | info | versions | All manifests agree on one version |
| `PLUGIN_VERSION_MISMATCH` | warning | versions | Manifests disagree |
| `PLUGIN_INSTALLED_MISMATCH` | warning | versions | Installed/expected version differs from checkout |
| `AGENT_SURFACE_NONE` | warning | agents | Neither `CLAUDE.md` nor `AGENTS.md` present |
| `AGENT_SURFACE_CLAUDE` | info | agents | `CLAUDE.md` present |
| `AGENT_SURFACE_CODEX` | info | agents | `AGENTS.md` present |
| `MANAGED_SECTION_MISSING` | warning | managed-sections | Template-owned section absent |
| `MANAGED_SECTION_DUPLICATED` | warning | managed-sections | Template-owned section duplicated |
| `MANAGED_SECTION_MALFORMED` | error | managed-sections | Section heading at wrong level |
| `MANAGED_SECTION_CUSTOMIZED` | info | managed-sections | Section body differs from template |
| `MANAGED_SECTIONS_REORDERED` | info | managed-sections | Sections present but not in template order |
| `RUNTIME_LOCK_PRESENT` | warning | runtime | A runtime lock file exists |
| `RUNTIME_RECOVERY_INCOMPLETE` | warning | runtime | An unfinished transaction journal exists |
| `RUNTIME_RECOVERY_UNRECOGNIZED` | error | runtime | An unrecognized runtime entry exists |
| `RUNTIME_LEGACY_STATE` | warning | runtime | `.me/locks` or `.me/tmp` contains state |
| `RUNTIME_INGEST_PENDING` | warning | runtime | Ingest locks/staging are non-empty |

## Recommended-action families

- **Plugin upgrade**: `SCHEMA_FUTURE`, `PLUGIN_INSTALLED_MISMATCH` — upgrade the
  ME plugin.
- **Vault migration**: `CONFIG_MISSING`, `SCHEMA_MISSING`, `SCHEMA_MALFORMED`,
  `SCHEMA_EDITED`, `MANAGED_SECTION_*` — run `/me:setup` to refresh managed files.
- **Diagnosis**: `RUNTIME_*` — inspect the exact states and preserved paths;
  never auto-clear.

## Schema state classification

`SCHEMA.md` is compared byte-for-byte with the plugin's `templates/SCHEMA.md`.
The plugin's current schema profile revision is read from
`templates/schema-profiles/me-schema-v1.json` (`revision`, currently 1).

- Identical → `current`.
- Different but structurally a ME schema (has `## Core Fields` and
  `## Per-Layer Extensions`):
  - With a **deterministic future-version marker** declaring a revision strictly
    higher than the current one → `future`. Recognized markers:
    `me-schema-v<N>` (N > current), `Schema revision: N`, or `revision: N`
    (N > current). Without such a marker the doctor cannot claim the schema is
    newer.
  - Otherwise → `edited` (an edited current schema, `behind`, vault migration).
- Present but not recognizable → `malformed`.
- Absent → `missing`.

There is no explicit schema version marker in the locked SCHEMA.md today; the
doctor does not invent certainty. An arbitrary edit to the current schema is
`edited`, never `future`.

## Known limitations

- **Committed transaction depth**: doctor inspects incomplete and unrecognized
  transaction journals, but does not perform deep post-commit consistency checks
  (e.g. verifying every committed mutation's target bytes) beyond the recovery
  metadata already produced by vault-write. A committed-but-contradictory
  transaction is not re-verified by doctor.
- **Installed-version source**: doctor cannot automatically discover the
  marketplace-installed plugin version when run from a checkout; `plugin.version`
  and `installedVersion` default to the checkout version. A true checkout-vs-
  installed mismatch is only surfaced when `--installed-version` is explicitly
  provided.

## Managed sections

The template-owned sections are those maintained by `/me:setup` per the merge
rules: `# Knowledge Base`, `## Configuration`, `## Layer Map`, `## Commands`,
`## Note Templates`, `## After Creating a Note`, `## Search`, `## Conventions`.

Per-section `state`:
- `missing` — heading absent.
- `duplicated` — heading appears more than once.
- `malformed` — heading present at the wrong markdown level.
- `customized` — heading present at the right level but body differs from the
  template (will be replaced on the next `/me:setup` upgrade).
- `present` — matches the template.

`reordered` is aggregate: the present/customized sections appear in a different
relative order than the template.
