# Versioned `me:update` Vault Migration Design

**Status:** Proposed
**Date:** 2026-07-26
**Scope:** Design only; no implementation is included in this document.

## 1. Goal

`me:update` is ME's forward-only vault migration mechanism. It upgrades the
portable structure and managed artifacts of an existing vault after the ME
plugin has been upgraded.

The command must:

- distinguish plugin releases from vault-format changes;
- determine an exact, ordered migration path;
- show all planned vault changes before writing;
- wait for explicit user confirmation;
- reject apply when the vault changed after preview;
- preserve user configuration and user-authored content by default;
- provide journaled rollback or explicit recovery material if a multi-file
  migration cannot complete cleanly;
- be deterministic, idempotent, and testable without an Agent making
  migration decisions at runtime.

## 2. Non-goals

`me:update` is not:

- a plugin installer or marketplace updater;
- a general “best-practice configurator”;
- a host capability detector;
- a command that silently rewrites user Profiles;
- an automatic knowledge lifecycle transition;
- a downgrade engine.

The plugin is upgraded separately, for example with
`codex plugin marketplace upgrade me-marketplace`. `me:update` then migrates
the current vault when the new plugin declares a newer vault schema.

## 3. Version model

Plugin semver and vault schema version are separate:

```yaml
vault_schema_version: 1

layers:
  raw: "knowledge/raw"
  practices: "knowledge/practices"
  cognition: "knowledge/cognition"
```

- `package.json.version` describes the installed plugin release.
- `vault_schema_version` is a monotonically increasing integer describing the
  portable vault contract.
- The plugin exports one `CURRENT_VAULT_SCHEMA_VERSION` constant.
- A missing `vault_schema_version` is the legacy schema `0`.
- A non-integer, negative, or otherwise malformed version blocks migration.
- A vault version greater than the plugin's current version returns
  `VAULT_NEWER_THAN_PLUGIN`; ME must not guess or downgrade it.
- Plugin releases that do not change the vault contract do not increment the
  vault schema version.

The first release containing this mechanism sets the current schema to `1`.
Its `0 → 1` migration adopts legacy vaults and records the version. Any other
managed-file changes included in that migration must follow the ownership and
conflict rules below.

## 4. Command boundary

ME adds:

```text
$me:update
```

and a deterministic CLI:

```bash
bun run bin/update.ts preview --vault-dir <vault>
bun run bin/update.ts apply --vault-dir <vault> \
  --expected-plan-digest <digest>
```

The Skill is responsible for conversation and confirmation. The CLI owns
discovery, validation, planning, mutation, rollback, and structured results.
The Agent must not invent migration steps or edit migration targets directly.

### 4.1 Preview

Preview is read-only with respect to both the vault and host-local runtime. It:

1. resolves and validates the vault;
2. reads `.me/config.yaml`;
3. resolves the ordered migration chain;
4. reads every migration precondition and target;
5. computes the exact desired bytes or filesystem operation;
6. returns migration descriptions, warnings, conflicts, exact diffs, source
   fingerprints, and a canonical `planDigest`.

The digest covers at least:

- source and target vault schema versions;
- ordered migration IDs;
- normalized target paths;
- source existence, type, mode, and content digest;
- desired file bytes or directory operations;
- the plugin migration-registry revision.

The Skill presents the preview and asks the user to confirm. It performs no
vault mutation before an affirmative response.

### 4.2 Apply

After confirmation, apply:

1. acquires the vault-wide cooperative ME write lock;
2. recomputes the plan from current vault state while holding the lock;
3. compares the new digest with `--expected-plan-digest`;
4. returns `STALE_PREVIEW` without mutation if anything material changed;
5. stages all desired bytes in the external runtime transaction directory;
6. validates staged output and all migration postconditions;
7. executes the journaled transaction;
8. writes `vault_schema_version` as part of the final migration state;
9. reports committed paths, warnings, and recovery state.

Apply never accepts a caller-supplied list of mutations. The digest authorizes
only the deterministic plan produced by the installed migration registry.

### 4.3 No-change behavior

If the vault is current, preview returns `up_to_date` with no confirmation
request. Re-running apply after a successful update also returns
`up_to_date`; it does not manufacture a new transaction.

## 5. Migration registry

Migrations are plugin-owned TypeScript modules registered in a static,
ordered registry. Vault content cannot provide executable migration code.

Conceptually, each migration exposes:

```ts
interface VaultMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  describe(): string;
  plan(context: ReadonlyMigrationContext): MigrationPlan;
  validate(result: ReadonlyMigratedView): ValidationResult;
}
```

Rules:

- every migration advances exactly one version;
- IDs are stable and unique;
- the registry contains one unbroken path from every supported version to the
  current version;
- planning is deterministic for identical plugin and vault bytes;
- migration modules do not write directly;
- migrations declare operations and preconditions to the shared executor;
- each migration is independently idempotent;
- the combined plan is validated before any write;
- old migration modules remain available for every still-supported legacy
  version.

If the registry has a gap or two migrations claim the same edge, ME fails
closed with `INVALID_MIGRATION_REGISTRY`.

## 6. Supported migration operations

The shared executor supports a deliberately small operation vocabulary:

- set, rename, or remove a known config key;
- create a file only when absent;
- replace a plugin-owned file only when ownership is proven;
- merge a marked or otherwise recognized plugin-owned section;
- create a directory;
- rename a path with explicit source and destination preconditions;
- transform a declared set of note files when a schema change genuinely
  requires content migration.

Every operation includes source fingerprints and a conflict policy. Bulk note
migrations must list their affected files and counts in preview; they may not
scan and mutate an open-ended set during apply.

The executor rejects absolute vault targets, lexical escapes, symlink escapes,
special files, duplicate targets, overlapping parent/child replacements, and
operations outside the canonical vault.

## 7. Configuration preservation

`.me/config.yaml` is portable user configuration. Migration uses a
round-trip-capable YAML document representation so that it can:

- preserve unknown keys;
- preserve comments and stable ordering where practical;
- change only keys explicitly owned by the migration;
- reject duplicate or ambiguous keys instead of choosing one;
- preserve relative vault paths exactly unless a migration targets them.

Host-specific values such as `ME_RUNTIME_ROOT` must never be written to this
file. A migration also must not reorder transcription providers based on the
machine running the update; portable configuration cannot safely encode a
one-machine capability probe.

The version key is updated only after all earlier migration operations have
validated. In a multi-version update, the final committed config records the
target version, while the journal records each migration that contributed to
the plan.

## 8. Managed artifacts and ownership

A migration declares one of these strategies for each managed artifact:

### 8.1 `create-if-absent`

Create the artifact only if the path is absent. An existing file is
user-owned and remains unchanged unless another ownership strategy proves
otherwise.

### 8.2 `replace-known-template`

Replace only when the current bytes match a known historical ME template
digest. If the file differs, preview reports a conflict and does not overwrite
it.

This is appropriate for a canonical `SCHEMA.md` only when ME can prove it is
an unmodified managed version.

### 8.3 `merge-owned-sections`

Replace only sections delimited by ME ownership markers. For legacy Agent
instruction files without markers, a migration may recognize the exact known
legacy section structure and adopt it once. Ambiguous headers or modified
legacy sections are conflicts.

This strategy preserves unrelated project instructions in `AGENTS.md` and
`CLAUDE.md`. Future setup templates should emit ownership markers so later
updates do not depend on header heuristics.

### 8.4 User Profiles

Profiles are user assets:

- a migration may create a new optional Profile with `create-if-absent`;
- an existing Profile is never replaced merely because the plugin ships a
  newer example;
- structural Profile migration requires a specific migration with explicit
  preconditions and previewed changes;
- optional editorial improvements are reported as suggestions, not vault
  migrations.

## 9. `me:setup` boundary

Fresh setup writes a vault directly at
`CURRENT_VAULT_SCHEMA_VERSION`. It does not replay historical migrations.

Setup is responsible for:

- creating `.me/config.yaml` with the current version and chosen layer map;
- creating the current baseline directories and managed templates;
- adding current ownership markers;
- validating the newly created vault.

When setup sees an existing `.me/config.yaml`, it performs no upgrade writes.
It reports the detected vault schema and instructs the user to run
`$me:update`. The existing setup upgrade path for refreshing `SCHEMA.md` and
Agent instructions moves into versioned migrations.

## 10. Transaction and recovery model

ME cannot make multiple filesystem renames globally atomic. The guarantee is
therefore **journaled all-or-recovery**, not transactional atomicity in the
database sense.

The updater reuses the external runtime and path-safety model:

```text
<ME_RUNTIME>/transactions/me-update-<operation-id>/
├── journal.json
├── staged/
└── originals/
```

It also shares the vault-wide ME write lock so update cannot race ingest,
vault-write, or another update.

Before mutation, the transaction records:

- operation ID and plan digest;
- source and target schema versions;
- ordered migration IDs;
- original fingerprints;
- intended mutations;
- staged output fingerprints.

For each replacement, ME retains the original bytes before publication.
Normal failures trigger ownership-aware rollback. A crash, concurrent
external edit, or ambiguous ownership preserves the journal and originals,
returns `RECOVERY_REQUIRED`, and never claims that the vault is current.

Legacy non-empty runtime state continues to block writes according to the ME
external-runtime design. Preview may report the blocker, but apply does not
delete or silently migrate recovery material.

## 11. Result contract

Preview and apply emit one versioned JSON result. At minimum it contains:

```ts
interface UpdateResultV1 {
  version: 1;
  status:
    | 'up_to_date'
    | 'preview'
    | 'blocked'
    | 'committed'
    | 'rolled_back'
    | 'recovery_required';
  operationId: string;
  currentVaultSchemaVersion: number;
  targetVaultSchemaVersion: number;
  migrations: Array<{ id: string; description: string }>;
  planDigest?: string;
  plannedPaths: string[];
  changedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
  warnings: string[];
  conflicts: Array<{ path: string; reason: string }>;
  recoveryState: 'none' | 'rolled_back' | 'manual';
  error?: { code: string; message: string };
}
```

Public recovery paths use `<ME_RUNTIME>/...`; the updater does not leak
absolute host-local paths unless the user explicitly invokes the existing
runtime path inspection command.

Primary error codes include:

- `NOT_A_ME_VAULT`
- `INVALID_CONFIG`
- `INVALID_VAULT_SCHEMA_VERSION`
- `VAULT_NEWER_THAN_PLUGIN`
- `INVALID_MIGRATION_REGISTRY`
- `MIGRATION_CONFLICT`
- `STALE_PREVIEW`
- `UPDATE_IN_PROGRESS`
- `UNSAFE_PATH`
- `UNSUPPORTED_FILESYSTEM`
- `LEGACY_RUNTIME_STATE`
- `VALIDATION_FAILED`
- `RECOVERY_REQUIRED`
- `INTERNAL_ERROR`

Errors are stable machine-readable codes; human messages do not expose
sensitive file contents.

## 12. Compatibility and support policy

- Migrations are forward-only.
- Downgrade is refused; the remedy is to reinstall a compatible plugin or
  restore the vault from version control/recovery material.
- Removing support for an old vault version is a deliberate breaking change
  documented in release notes.
- A plugin release must not publish
  `CURRENT_VAULT_SCHEMA_VERSION = N` unless the registry and tests contain a
  complete path to `N`.
- Migration behavior is part of the plugin release and must not depend on
  network services or current external facts.
- The updater never commits the user's vault to Git. Git remains an
  independent audit and recovery layer controlled by the user.

## 13. Testing strategy

### 13.1 Registry and unit tests

- registry continuity, uniqueness, and monotonic edges;
- missing version resolves to legacy `0`;
- malformed and future versions fail closed;
- each migration plans deterministically and is idempotent;
- combined plans preserve migration order;
- config round-trip preserves unknown keys and comments;
- ownership strategies handle known, modified, missing, and ambiguous files;
- plan digest changes for every material source or desired-output change.

### 13.2 Preview/apply contract tests

- preview creates no vault or runtime files;
- preview lists exact paths, diffs, warnings, and conflicts;
- apply without an expected digest is rejected;
- cancellation leaves the vault byte-for-byte unchanged;
- matching confirmation applies the planned migration;
- edits between preview and apply produce `STALE_PREVIEW`;
- a second run returns `up_to_date`.

### 13.3 Transaction and safety tests

- update serializes against ingest and vault-write;
- injected failure at every mutation boundary rolls back owned changes;
- external interference preserves recovery material;
- symlink, traversal, special-file, and cross-filesystem targets fail closed;
- config version never advances when postconditions fail;
- recovery output uses `<ME_RUNTIME>` display paths.

### 13.4 Setup and packaging tests

- fresh setup writes the current vault schema directly;
- setup on an existing vault performs no migration and points to
  `$me:update`;
- the plugin exposes `skills/update/SKILL.md` and packages all registry and
  template resources;
- user documentation separates plugin upgrade from vault update;
- Claude Code and Codex invocation instructions describe the same migration
  semantics.

## 14. Delivery shape

Implementation is expected to add these focused units:

```text
skills/update/SKILL.md
bin/update.ts
bin/update/
├── contracts.ts
├── config-document.ts
├── registry.ts
├── planner.ts
├── transaction.ts
└── migrations/
    └── 0000-to-0001.ts
```

Exact filenames may change during implementation planning, but the boundaries
must remain:

- Skill: user interaction and confirmation;
- planner: pure deterministic migration planning;
- registry: version-chain integrity;
- config document: safe round-trip mutations;
- transaction: locking, staging, journal, rollback, recovery;
- migration modules: declarative version-specific intent.

## 15. Acceptance criteria

The design is satisfied when:

1. an old vault can be previewed without mutation;
2. the user sees the complete migration effect before confirming;
3. apply cannot proceed against state different from the preview;
4. supported migrations run in order and advance the independent vault schema;
5. user configuration and content remain unchanged unless a migration
   explicitly and safely targets them;
6. partial failure produces rollback or actionable recovery, never a false
   success;
7. setup creates current vaults while update exclusively owns later
   migrations;
8. repeated update is a no-op.
