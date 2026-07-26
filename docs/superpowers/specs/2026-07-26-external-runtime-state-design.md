# ME External Runtime State Design

## 1. Goal

ME vaults may be Git repositories and Obsidian Sync roots. Persistent,
portable knowledge belongs inside the vault; host-local coordination,
staging, journals, and recovery artifacts do not.

ME 1.6 moves every runtime artifact outside the vault by default while
preserving the same-filesystem guarantees required by the existing
journaled writer and ingest finalizer.

## 2. Problem

ME 1.5 writes runtime state into the vault:

- `.me/tmp/` contains request copies, staged note/index bytes, journals,
  retained originals, and manual-recovery artifacts;
- `.me/locks/` contains the vault writer cooperative lock;
- `.me/ingest-reservations/` contains vault-wide ingest stem reservations;
- raw topic directories temporarily contain `.me-ingest-finalize.lock`,
  `.me-ingest-staging-*`, and `.README.md.me-ingest-*.tmp`.

Git ignore rules do not affect Obsidian Sync. Syncing these paths can create
false locks, duplicate incomplete operations on another machine, change
filesystem identity, leak staged private content, and turn a recoverable
local operation into an ambiguous cross-machine recovery.

The old project assumption that a vault has “no sync” is no longer valid.

## 3. Decision

External runtime state is the default in ME 1.6. It is not an opt-in mode.

The vault keeps only portable state:

```text
<vault>/.me/
├── config.yaml
└── profiles/
```

The default host-local runtime is stored under the current user's home:

```text
~/.me/
└── runtime/
    └── vault-<sha256(canonical-vault-path)[0:24]>/
        ├── locks/
        ├── transactions/
        ├── inbox/
        └── ingest/
            ├── locks/
            └── staging/
```

The hash is a local namespace, not a portable vault identity. Moving a vault
changes its default runtime namespace; users must resolve outstanding
recoveries before moving a vault.

## 4. Runtime root resolution

Runtime resolution is centralized in `bin/runtime-paths.ts`.

### 4.1 Default

1. Resolve the lexical vault path.
2. Resolve the canonical vault path.
3. Resolve the current user's home directory without consulting vault
   configuration.
4. Resolve `~/.me/runtime/vault-<path-hash>`.
5. Do not create any directory during preview or path inspection.

### 4.2 Host-local override

`ME_RUNTIME_ROOT` may override the `~/.me/runtime` base:

- it is a host-local environment variable, never written to
  `.me/config.yaml`;
- it must be an absolute path;
- its nearest existing parent and every existing prefix must be real
  directories, not symlinks;
- its device identity must match the canonical vault device;
- the per-vault `vault-<path-hash>` namespace is still appended.

Relative values, control characters, symlinked roots, non-directory entries,
and cross-device roots fail closed with `UNSUPPORTED_FILESYSTEM` or
`UNSAFE_PATH`.

### 4.3 Same-filesystem invariant

Before any write, ME compares filesystem device identity for:

- the canonical vault;
- the runtime base or its nearest existing parent;
- the per-vault runtime root when it exists;
- target layer/parent directories used by the operation.

The operation stops before acquiring locks or staging bytes if these devices
differ. There is no automatic fallback to a vault-adjacent directory and no
cross-device copy mode. The error directs the user to set `ME_RUNTIME_ROOT`
to an absolute directory on the vault filesystem. This preserves the existing
hard-link and atomic-rename model.

## 5. Path safety

Vault paths and runtime paths have separate containment roots.

- `assertSafeVaultPath` accepts only paths contained by the paired
  lexical/canonical vault roots.
- `assertSafeRuntimePath` accepts only paths contained by the paired
  lexical/canonical per-vault runtime roots.
- Runtime directories are created with mode `0700` where supported; files
  are created with mode `0600`.
- Runtime roots, lock directories, transaction directories, and ingest
  directories reject symlinks.
- Public structured results never infer safety from a string prefix alone.

The runtime resolver is domain-neutral and is reused by vault-write and
ingest.

## 6. Vault writer migration

`ResolvedVaultLayout` gains:

- `runtimeRoot`;
- `transactionDir`;
- `lockDir`;
- `runtimeDisplayRoot`, fixed as `<ME_RUNTIME>`;
- legacy vault paths used only for detection.

The old `tmpDir` name is removed internally. All writer transaction state
moves to `transactionDir`.

The writer continues to provide:

- exclusive cooperative lock acquisition;
- full operation journals;
- staged note and README bytes;
- original README retention;
- ownership-aware rollback;
- aggregate manual recovery.

Recovery paths in public JSON are runtime-relative and prefixed with
`<ME_RUNTIME>/`, for example:

```text
<ME_RUNTIME>/transactions/vault-write-<operationId>/originals/README.md
```

No implicit absolute runtime path is returned. A new read-only CLI command
prints the local absolute root when an operator explicitly requests it:

```bash
bun run bin/runtime.ts path --vault-dir <vault>
```

The command emits one JSON object containing `vaultDir`, `runtimeRoot`, and
`exists`; it creates nothing.

## 7. Request and processed-Markdown inputs

Stdin remains the preferred input boundary.

- `vault-write` continues to accept a complete JSON request through stdin.
- `ingest --processed-markdown -` reads the edited Markdown body from stdin.

When a file boundary is unavoidable:

- `vault-write --request` accepts only a real `.json` file directly under
  `<runtime>/inbox/`;
- `ingest --processed-markdown` accepts only a real file directly under the
  same inbox;
- nested files, symlinks, FIFOs, devices, wrong extensions, and files over
  the existing size limit are rejected;
- the caller removes its input file after use.

ME provides:

```bash
bun run bin/runtime.ts prepare-inbox --vault-dir <vault>
```

This command creates only the contained runtime namespace and inbox, then
prints the absolute inbox path as JSON.

## 8. Ingest migration

All cooperating ingest runtime artifacts move outside the vault:

- vault-wide stem reservation;
- topic-level finalizer lock;
- artifact staging directory;
- README replacement temp file.

The final artifact and README remain in the vault. Runtime staging is on the
same filesystem, so final publication still uses atomic rename. Lock names
use hashes of the normalized target/topic identity rather than embedding
arbitrary vault paths.

On success, owned locks and transient staging are removed. Runtime directory
containers may remain empty. On ambiguous ownership or concurrent mutation,
content is preserved in the runtime tree and the operation reports manual
recovery rather than deleting it.

## 9. Legacy-state gate

ME 1.6 never silently deletes or automatically migrates non-empty ME 1.5
runtime state.

Before a write, the relevant operation inspects:

- `<vault>/.me/tmp/`;
- `<vault>/.me/locks/`;
- `<vault>/.me/ingest-reservations/`;
- affected topic directories for `.me-ingest-finalize.lock`,
  `.me-ingest-staging-*`, and `.README.md.me-ingest-*.tmp`.

Missing or empty legacy directories do not block. Any non-empty or malformed
legacy state fails before new runtime mutation:

- vault-write returns `manual_recovery / LEGACY_RUNTIME_STATE`;
- ingest throws a stable `legacy runtime state requires inspection` error;
- output lists only contained vault-relative legacy paths;
- no legacy file is deleted, renamed, or copied automatically.

Documentation tells users to inspect the legacy state on the machine where
it originated, exclude it from sync during recovery, then remove it only
after confirming no data is needed.

## 10. Configuration and setup

`.me/config.yaml` does not gain an absolute runtime path.

`me:setup`:

- creates or preserves `.me/config.yaml`;
- does not create runtime directories;
- no longer recommends vault-local runtime ignore rules as the primary sync
  boundary;
- documents that `.me/config.yaml` and `.me/profiles/` are portable;
- documents that `~/.me/runtime/` is host-local and outside the vault;
- documents the explicit `ME_RUNTIME_ROOT` remedy for cross-filesystem
  vaults.

The repository’s project instructions are updated to remove the obsolete
“same directory, no sync” assumption.

## 11. Compatibility

- Layer configuration and Decision Profile syntax are unchanged.
- Read-only skills do not require a runtime directory.
- Preview remains byte-for-byte vault read-only and also runtime read-only.
- Existing stdin workflows continue to work.
- Vault-local request/processed-Markdown files are rejected in 1.6 with an
  actionable message pointing to stdin or `runtime prepare-inbox`.
- Existing non-empty legacy runtime state blocks writes until inspected.

This is a minor-version behavioral change because v1.5.0 is the first public
release containing the journaled writer and no prior stable external-runtime
contract exists.

## 12. Test strategy

TDD proceeds in this order:

1. Runtime resolver tests:
   - deterministic `~/.me/runtime` root;
   - override validation;
   - no creation during resolution;
   - symlink, traversal, control-character, and cross-device rejection;
   - cross-device failure has no vault-adjacent fallback;
   - lexical/canonical vault roots.
2. Vault writer path and transaction tests:
   - no `.me/tmp` or `.me/locks` creation;
   - runtime lock/staging/recovery behavior;
   - `<ME_RUNTIME>` public paths;
   - preview runtime read-only;
   - legacy-state gate;
   - interrupt and ownership windows.
3. CLI tests:
   - stdin unchanged;
   - runtime inbox containment;
   - `runtime path` and `prepare-inbox`;
   - old vault-local request rejection.
4. Ingest tests:
   - external reservation, topic lock, staging, and README temp;
   - target publication remains atomic;
   - legacy-state gate;
   - processed Markdown stdin and inbox file.
5. Contract and documentation tests:
   - skills contain no `.me/tmp`, `.me/locks`, or vault-local reservation
     instructions;
   - user guide explains portable versus host-local state;
   - packed release contains the runtime CLI and no private paths.

## 13. Verification baseline

Before changes on `v1.5.0`:

- `bash test/vault-test.sh`: 172 passed, 3 failed;
- the three failures are Claude Code E2E tests blocked by the organization’s
  disabled Claude subscription access:
  `test_e2e_me_setup`, `test_e2e_me_setup_idempotent`,
  `test_e2e_me_checklink_headless`;
- runtime-relevant Bun suite: 169 passed, 0 failed.

Completion requires:

- every new and affected Bun test passing;
- all non-Claude `vault-test.sh` tests passing;
- the same three external E2E failures, and no additional failures, if the
  Claude access restriction remains;
- package validation, privacy scan, and release version checks passing.
