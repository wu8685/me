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
  "routing": {
    "scannedNotes": 12,
    "errors": 1,
    "advisories": 2,
    "suppressedAdvisories": 1
  },
  "findings": [
    {
      "code": "CONFIG_VALID",
      "severity": "info",           // info | warning | error
      "category": "config",          // roots | versions | config | schema | agents | managed-sections | runtime | layer-routing
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
| `ROUTING_FRONTMATTER_INVALID` | error | layer-routing | Note has no recognizable frontmatter block |
| `ROUTING_RAW_SOURCE_NOT_URL` | error | layer-routing | Raw note `source` is not an external http(s) URL (internal URI, wikilink, malformed) |
| `ROUTING_FIELD_NOT_ALLOWED` | error | layer-routing | Frontmatter field not permitted in the note's layer |
| `ROUTING_MISSING_REQUIRED_FIELD` | error | layer-routing | Required per-layer field missing (e.g. cognition `confidence`) |
| `ROUTING_TYPE_INVALID_FOR_LAYER` | error | layer-routing | `type` value outside the layer's controlled vocabulary |
| `ROUTING_PROVENANCE_NOT_REFERENCE` | error | layer-routing | Practices/cognition `source` is not a `[[wikilink]]` note/evidence reference |
| `ROUTING_FORBIDDEN_FIELD` | error | layer-routing | Forbidden field (`status`, `lifecycle`, `date_created`) present |
| `ROUTING_RAW_LIKE_PRACTICE` | warning (heuristic) | layer-routing | Raw note body dominated by first-person decisions/judgment |
| `ROUTING_PRACTICES_LIKE_RAW` | warning (heuristic) | layer-routing | Practices note looks like an unmodified external article |
| `ROUTING_COGNITION_SINGLE_EVENT` | warning (heuristic) | layer-routing | Cognition note dominated by a single unverified event |
| `ROUTING_SUPPRESSIONS_INVALID` | warning | layer-routing | `.me/doctor-suppressions.json` is malformed |

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

## Layer-routing diagnostics

When the vault resolves, doctor scans every note under the configured layer
directories (from `.me/config.yaml`, defaults `raw/`, `practices/`,
`cognition/`) and reports two finding classes in the `layer-routing` category:

- **Deterministic errors** (`ROUTING_*` error codes): schema-level violations
  such as a raw note with a non-URL `source`, a field not permitted in the
  layer, a missing required field, or a `type` outside the layer's controlled
  vocabulary. They carry stable codes, the note `path`, and a
  `recommendedAction`. Remediate a confirmed misfiled note with
  `/me:remediate` — never by moving files manually.
- **Advisory semantic findings** (`ROUTING_RAW_LIKE_PRACTICE`,
  `ROUTING_PRACTICES_LIKE_RAW`, `ROUTING_COGNITION_SINGLE_EVENT`): heuristic
  misfiling signals. They are warnings labeled `details.heuristic: true` with
  `details.evidence` listing the triggering marker labels (never note
  sentences). They are not proof of semantic type and never move or rewrite
  content.

False-positive suppression: add entries to `.me/doctor-suppressions.json`:

```json
{ "version": 1, "suppress": [{ "code": "ROUTING_RAW_LIKE_PRACTICE", "path": "raw/2026-01-01-example.md" }] }
```

`path` is optional (omit it to suppress the code vault-wide). Only advisory
codes are honored; deterministic errors can never be suppressed. Suppressed
advisories are counted in `report.routing.suppressedAdvisories`.

`report.routing` aggregates the scan: `scannedNotes`, `errors`, `advisories`,
`suppressedAdvisories`. The scan is read-only and never creates runtime state.

## Known limitations

- **Committed transaction depth**: doctor inspects incomplete and unrecognized
  transaction journals, but does not perform deep post-commit consistency checks
  (e.g. verifying every committed mutation's target bytes) beyond the recovery
  metadata already produced by vault-write. A committed-but-contradictory
  transaction is not re-verified by doctor.
- **Heuristic advisories**: routing advisories are keyword/marker signals, not
  semantic proof; quoted opinions inside a faithful raw capture are expected
  and suppressed via `.me/doctor-suppressions.json` when they trigger.
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
