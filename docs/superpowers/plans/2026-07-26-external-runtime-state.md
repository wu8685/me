# ME External Runtime State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all ME host-local locks, staging, journals, request files, and recovery artifacts outside synchronized vaults by default.

**Architecture:** A domain-neutral runtime resolver maps a canonical vault to a same-filesystem sibling namespace, with an optional host-local environment override. Vault-write and ingest share this resolver but retain separate transaction semantics; legacy vault-local state blocks mutation until inspected.

**Tech Stack:** TypeScript on Bun/Node filesystem APIs, Bash contract tests, Markdown Skills and documentation.

## Global Constraints

- Base implementation on public tag `v1.5.0`.
- External runtime is the ME 1.6 default, not an opt-in.
- Never write an absolute runtime path into `.me/config.yaml`.
- Preview and path inspection create no vault or runtime files.
- All runtime mutation must remain on the same filesystem device as the vault.
- Never silently delete or migrate non-empty ME 1.5 runtime state.
- Preserve stdin as the preferred request boundary.
- Follow TDD: failing focused test, minimal implementation, focused green test, then refactor.
- Full baseline has 172/175 passing; only the three recorded Claude-access E2E tests may remain failed.

---

## File map

```text
bin/
├── runtime-paths.ts                 # shared resolution, containment, bootstrap, display paths
├── runtime.ts                       # read-only path and prepare-inbox CLI
├── vault-write.ts                   # request inbox boundary
├── vault-write/
│   ├── contracts.ts                 # LEGACY_RUNTIME_STATE public error
│   ├── path-safety.ts               # vault layout consumes runtime layout
│   └── transaction.ts               # external lock/transaction/recovery paths
├── ingest.ts                        # processed Markdown stdin/runtime inbox
└── ingest/finalize.ts               # external reservations, locks, staging, README temp

test/
├── runtime-paths.test.ts
├── vault-write-path-safety.test.ts
├── vault-write-transaction.test.ts
├── vault-write-cli.test.ts
├── ingest-contracts.test.ts
├── ingest-finalize.test.ts
└── vault-test.sh

skills/
├── decision-brief/SKILL.md
└── ingest/SKILL.md

README.md
docs/user-guide.md
docs/features.md
docs/development.md
AGENTS.md
CLAUDE.md
package.json
```

### Task 1: Shared runtime resolver

**Files:**
- Create: `bin/runtime-paths.ts`
- Create: `test/runtime-paths.test.ts`

**Interfaces:**
- Produces:

```ts
export type RuntimePathErrorCode = 'UNSAFE_PATH' | 'UNSUPPORTED_FILESYSTEM';

export class RuntimePathError extends Error {
  constructor(public readonly code: RuntimePathErrorCode);
}

export interface RuntimeLayout {
  lexicalVault: string;
  canonicalVault: string;
  runtimeBase: string;
  runtimeRoot: string;
  lockDir: string;
  transactionDir: string;
  inboxDir: string;
  ingestDir: string;
  ingestLockDir: string;
  ingestStagingDir: string;
}

export function resolveRuntimeLayout(
  vaultDir: string,
  environment?: NodeJS.ProcessEnv,
): RuntimeLayout;

export function assertSafeRuntimePath(
  layout: RuntimeLayout,
  candidate: string,
): void;

export function bootstrapRuntimeDirectories(
  layout: RuntimeLayout,
  directories: string[],
): void;

export function runtimeDisplayPath(
  layout: RuntimeLayout,
  candidate: string,
): string;
```

- [ ] **Step 1: Write failing resolver and containment tests**

Cover deterministic sibling resolution, no creation, absolute override,
relative/control-character/symlink rejection, candidate escape rejection, and
same-device validation:

```ts
const layout = resolveRuntimeLayout(vault);
expect(layout.runtimeRoot).toStartWith(path.join(path.dirname(fs.realpathSync(vault)), '.me-runtime'));
expect(fs.existsSync(layout.runtimeRoot)).toBeFalse();
expect(() => resolveRuntimeLayout(vault, { ME_RUNTIME_ROOT: 'relative' }))
  .toThrow(/UNSAFE_PATH/);
expect(() => assertSafeRuntimePath(layout, path.join(layout.runtimeRoot, '..', 'escape')))
  .toThrow(/UNSAFE_PATH/);
```

- [ ] **Step 2: Run RED test**

Run:

```bash
bun test test/runtime-paths.test.ts
```

Expected: fail because `bin/runtime-paths.ts` does not exist.

- [ ] **Step 3: Implement minimal resolver**

Implement SHA-256 canonical-path namespace, existing-prefix lstat/realpath
checks, device comparison, contained bootstrap with `0700`, and
`<ME_RUNTIME>/...` display paths. Do not create paths in
`resolveRuntimeLayout`.

- [ ] **Step 4: Run GREEN test**

Run:

```bash
bun test test/runtime-paths.test.ts
```

Expected: all runtime resolver tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/runtime-paths.ts test/runtime-paths.test.ts
git commit -m "feat: resolve host-local ME runtime state"
```

### Task 2: Vault writer layout, transaction migration, and legacy gate

**Files:**
- Modify: `bin/vault-write/contracts.ts`
- Modify: `bin/vault-write/path-safety.ts`
- Modify: `bin/vault-write/transaction.ts`
- Modify: `test/vault-write-contracts.test.ts`
- Modify: `test/vault-write-path-safety.test.ts`
- Modify: `test/vault-write-transaction.test.ts`

**Interfaces:**
- `ResolvedVaultLayout` consumes `RuntimeLayout` and exposes its runtime paths.
- `WriterErrorCode` gains `LEGACY_RUNTIME_STATE`.
- `detectLegacyVaultWriterState(layout): string[]` returns contained
  vault-relative entries without mutation.
- Transaction locks, journals, staging, originals, and public recovery paths
  consume the external runtime layout.

- [ ] **Step 1: Write failing contract and layout tests**

Assert:

```ts
expect(layout.transactionDir).not.toStartWith(`${layout.lexicalVault}${path.sep}`);
expect(layout.lockDir).not.toStartWith(`${layout.lexicalVault}${path.sep}`);
expect(fs.existsSync(path.join(vault, '.me/tmp'))).toBeFalse();
expect(WRITER_ERROR_CATALOG.LEGACY_RUNTIME_STATE.status).toBe('manual_recovery');
```

Add fixtures for empty legacy directories (allowed), non-empty legacy
`tmp`/`locks` (reported), symlinks (fail closed), runtime/vault overlap, and
cross-device injection.

Convert transaction expectations to external runtime, preserve every existing
interrupt/concurrency case, and add a non-empty legacy-state test that expects
`manual_recovery / LEGACY_RUNTIME_STATE` before lock acquisition.

- [ ] **Step 2: Run RED tests**

```bash
bun test test/vault-write-contracts.test.ts test/vault-write-path-safety.test.ts \
  test/vault-write-transaction.test.ts
```

Expected: assertions fail against vault-local v1.5 layout.

- [ ] **Step 3: Implement minimal layout integration**

Call `resolveRuntimeLayout`, keep `.me` only for config/Profile, add explicit
vault/runtime assertion functions, map `RuntimePathError` to fixed writer
errors, and add legacy-state detection without creating files. Replace
vault-local tmp/lock construction with `transactionDir`/`lockDir`, apply
runtime containment to locks, journals, staging, originals, cleanup, and
fingerprints, then render public recovery paths through `runtimeDisplayPath`.

- [ ] **Step 4: Run GREEN tests**

```bash
bun test test/vault-write-contracts.test.ts test/vault-write-path-safety.test.ts \
  test/vault-write-transaction.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add bin/vault-write/contracts.ts bin/vault-write/path-safety.ts \
  bin/vault-write/transaction.ts test/vault-write-contracts.test.ts \
  test/vault-write-path-safety.test.ts test/vault-write-transaction.test.ts
git commit -m "feat: move vault transactions outside synced vaults"
```

### Task 3: Runtime CLI and request inbox

**Files:**
- Create: `bin/runtime.ts`
- Modify: `bin/vault-write.ts`
- Modify: `package.json`
- Modify: `test/vault-write-cli.test.ts`
- Create: `test/runtime-cli.test.ts`

**Interfaces:**
- `runtime path --vault-dir DIR` returns JSON without mutation.
- `runtime prepare-inbox --vault-dir DIR` creates only the runtime namespace
  and inbox.
- `vault-write --request` accepts a real direct child of `inboxDir`.

- [ ] **Step 1: Write failing CLI tests**

Verify read-only path output, contained inbox creation, symlink/FIFO/nested
input rejection, old `.me/tmp/request.json` rejection, and stdin compatibility.

- [ ] **Step 2: Run RED CLI tests**

```bash
bun test test/runtime-cli.test.ts test/vault-write-cli.test.ts
```

- [ ] **Step 3: Implement runtime CLI and inbox reader**

Use the same no-follow descriptor, identity recheck, file-type, extension, and
4 MiB controls as v1.5. Add:

```json
{
  "me-runtime": "bin/runtime.ts"
}
```

to `package.json`’s `bin` map. Release versions are updated together in
Task 5.

- [ ] **Step 4: Run GREEN CLI tests**

```bash
bun test test/runtime-cli.test.ts test/vault-write-cli.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add bin/runtime.ts bin/vault-write.ts package.json \
  test/runtime-cli.test.ts test/vault-write-cli.test.ts
git commit -m "feat: expose local runtime inbox"
```

### Task 4: Ingest runtime migration

**Files:**
- Modify: `bin/ingest.ts`
- Modify: `bin/ingest/finalize.ts`
- Modify: `test/ingest-contracts.test.ts`
- Modify: `test/ingest-finalize.test.ts`
- Modify: `test/ingest-command.test.ts`

**Interfaces:**
- `--processed-markdown -` consumes bounded stdin.
- File input must be a direct real file in runtime inbox.
- Finalizer consumes `RuntimeLayout` for reservations, topic locks, staging,
  and README temporary bytes.

- [ ] **Step 1: Write failing ingest tests**

Assert no vault runtime markers exist before, during, or after cooperating
operations:

```ts
expect(findNames(vault, name => name.startsWith('.me-ingest-'))).toEqual([]);
expect(fs.existsSync(path.join(vault, '.me/ingest-reservations'))).toBeFalse();
```

Add processed-stdin, runtime-inbox, legacy reservation/topic marker,
same-device, and concurrent finalizer cases.

- [ ] **Step 2: Run RED ingest tests**

```bash
bun test test/ingest-contracts.test.ts test/ingest-finalize.test.ts \
  test/ingest-command.test.ts
```

- [ ] **Step 3: Implement minimal ingest migration**

Hash normalized stem/topic identities for runtime lock names, stage artifact
and README bytes under `ingestStagingDir`, retain atomic rename, preserve
ambiguous content, and fail before mutation on legacy state.

- [ ] **Step 4: Run GREEN ingest tests**

```bash
bun test test/ingest-contracts.test.ts test/ingest-finalize.test.ts \
  test/ingest-command.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add bin/ingest.ts bin/ingest/finalize.ts \
  test/ingest-contracts.test.ts test/ingest-finalize.test.ts \
  test/ingest-command.test.ts
git commit -m "feat: move ingest runtime state outside vaults"
```

### Task 5: Skills, setup, and public documentation

**Files:**
- Modify: `skills/decision-brief/SKILL.md`
- Modify: `skills/ingest/SKILL.md`
- Modify: `skills/setup/SKILL.md`
- Modify: `README.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/features.md`
- Modify: `docs/development.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `test/vault-test.sh`

**Interfaces:**
- Public docs distinguish portable `.me` content from host-local
  `.me-runtime`.
- Skills prefer stdin and use `runtime prepare-inbox` only when required.
- Project instructions no longer assert “no sync”.

- [ ] **Step 1: Add failing contract tests**

Add `vault-test.sh` tests that require runtime documentation and reject
active instructions containing:

```text
<vault>/.me/tmp
<vault>/.me/locks
.me/ingest-reservations
.me-ingest-staging-
```

- [ ] **Step 2: Run RED contract tests**

```bash
bash test/vault-test.sh test_external_runtime_documented
bash test/vault-test.sh test_skills_use_external_runtime
```

- [ ] **Step 3: Update Skills and documentation**

Document default resolution, `ME_RUNTIME_ROOT`, explicit runtime CLI,
legacy-state handling, recovery-before-vault-move, Obsidian Sync safety, and
the fact that config/Profile remain portable. Mirror the project assumption
change in `AGENTS.md` and `CLAUDE.md`.

Set the public release version to `1.6.0` in package and plugin manifests,
marketplace metadata, README release notes, and exact-version tests.

- [ ] **Step 4: Run GREEN contract tests**

```bash
bash test/vault-test.sh test_external_runtime_documented
bash test/vault-test.sh test_skills_use_external_runtime
bash test/vault-test.sh test_packed_release_has_no_private_paths
```

- [ ] **Step 5: Commit**

```bash
git add skills README.md docs AGENTS.md CLAUDE.md package.json \
  .claude-plugin/plugin.json .codex-plugin/plugin.json \
  .claude-plugin/marketplace.json test/vault-test.sh
git commit -m "docs: publish external runtime workflow"
```

### Task 6: Full verification and release readiness

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run complete Bun tests**

```bash
bun test
```

Expected: zero failures.

- [ ] **Step 2: Run type and shell tests**

```bash
bash test/typecheck-ingest-finalize.sh
bash test/vault-test.sh
```

Expected: no new failure beyond the three recorded Claude-access E2E
failures if the external restriction remains.

- [ ] **Step 3: Run release/privacy checks**

```bash
git diff --check v1.5.0...HEAD
rg -n '/Users/|brain-spark|optimuswu8685|\\.me/tmp|\\.me/locks|ingest-reservations' \
  bin skills README.md docs package.json
npm pack --dry-run
```

Expected: no private paths; any remaining legacy path string appears only in
legacy detection/migration documentation or tests.

- [ ] **Step 4: Verify diff and version**

```bash
git status --short
git diff --stat v1.5.0...HEAD
node -p "require('./package.json').version"
```

Expected: clean tracked worktree after final commit and version `1.6.0`.
