# Versioned `me:update` Vault Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, confirmation-gated `me:update` command that migrates an existing ME vault through independently versioned, ordered, journaled schema migrations.

**Architecture:** A pure planner reads a round-trip YAML config document, resolves a static migration chain, plans managed-asset changes, and computes a digest over source fingerprints and exact desired bytes. Preview is read-only; apply acquires a shared vault lock, recomputes and matches the digest, then publishes the plan through an external-runtime journal with rollback or explicit recovery.

**Tech Stack:** TypeScript, Bun test runner, Node filesystem/crypto APIs, `yaml@^2.9.0` for comment-preserving YAML documents, `diff@^9.0.0` for deterministic unified diffs.

## Global Constraints

- Follow [the approved design](../specs/2026-07-26-me-update-vault-migration-design.md).
- Keep plugin semver separate from integer `vault_schema_version`; the first updater release uses `CURRENT_VAULT_SCHEMA_VERSION = 1`, and a missing key means legacy version `0`.
- Preview must not create or mutate vault or runtime files.
- No vault mutation occurs until the user confirms the exact preview.
- Apply must recompute under the shared vault lock and reject a changed plan with `STALE_PREVIEW`.
- Migrations are forward-only, deterministic, ordered, independently idempotent, and statically registered by the plugin.
- Preserve unknown config keys, comments, user Profiles, and non-ME Agent instructions.
- Use vault-relative paths publicly and `<ME_RUNTIME>/...` for host-local recovery paths.
- Multi-file publication is journaled all-or-recovery, not described as database-atomic.
- Do not commit, push, or otherwise mutate the user's vault Git repository.
- Write tests before implementation and commit after every task.

---

## File and responsibility map

| File | Responsibility |
| --- | --- |
| `bin/cooperative-lock.ts` | One vault-wide lock shared by vault-write, ingest finalization, and update |
| `bin/update/contracts.ts` | Versioned updater result, plan, mutation, fingerprint, and error contracts |
| `bin/update/config-document.ts` | Safe round-trip parsing and explicit config-key edits |
| `bin/update/markdown-sections.ts` | Deterministic ME-owned Markdown section recognition and marker merge |
| `bin/update/managed-assets.ts` | Ownership strategies and exact desired-byte planning |
| `bin/update/registry.ts` | Static migration registry and continuity validation |
| `bin/update/migrations/0000-to-0001.ts` | Legacy-vault adoption migration |
| `bin/update/planner.ts` | Pure chain resolution, exact plan construction, diffs, fingerprints, and digest |
| `bin/update/transaction.ts` | Locked replan, staging, journal, mutation, rollback, and recovery |
| `bin/update.ts` | `preview`/`apply` CLI and exit-code mapping |
| `skills/update/SKILL.md` | Conversation workflow: preview, confirmation pause, digest-bound apply |
| `skills/setup/SKILL.md` | Fresh-current setup and existing-vault handoff to update |

---

### Task 1: Extract a shared vault-wide cooperative lock

**Files:**
- Create: `bin/cooperative-lock.ts`
- Create: `test/cooperative-lock.test.ts`
- Modify: `bin/vault-write/transaction.ts`
- Modify: `bin/ingest/finalize.ts`
- Modify: `test/vault-write-transaction.test.ts`
- Modify: `test/ingest-finalize.test.ts`

**Interfaces:**
- Consumes: `RuntimeLayout`, `assertSafeRuntimePath`, and `bootstrapRuntimeDirectories` from `bin/runtime-paths.ts`.
- Produces:

```ts
export type CooperativeLockOwner = 'vault-write' | 'ingest' | 'me-update';

export interface CooperativeLockRequest {
  operationId: string;
  owner: CooperativeLockOwner;
}

export interface OwnedCooperativeLock {
  path: string;
  descriptor: number;
  operationId: string;
  owner: CooperativeLockOwner;
}

export interface CooperativeLockHooks {
  beforeMutation?(kind: 'create' | 'unlink', path: string): void;
}

export function acquireVaultLock(
  layout: RuntimeLayout,
  request: CooperativeLockRequest,
  hooks?: CooperativeLockHooks,
): OwnedCooperativeLock;

export function releaseVaultLock(
  layout: RuntimeLayout,
  lock: OwnedCooperativeLock,
  hooks?: CooperativeLockHooks,
): void;
```

- Lock path: `<ME_RUNTIME>/locks/vault.lock`.
- Error surface: `CooperativeLockError` with codes `LOCK_HELD`, `UNSAFE_PATH`, and `RECOVERY_REQUIRED`.

- [ ] **Step 1: Write failing shared-lock tests**

Add tests that prove exclusive acquisition, owner metadata, ownership-aware
release, and cross-consumer serialization:

```ts
test('serializes all ME vault writers on one vault.lock', () => {
  const layout = preparedRuntime();
  const first = acquireVaultLock(layout, {
    operationId: 'op-write',
    owner: 'vault-write',
  });

  expect(() => acquireVaultLock(layout, {
    operationId: 'op-update',
    owner: 'me-update',
  })).toThrow(/LOCK_HELD/);

  releaseVaultLock(layout, first);
  const second = acquireVaultLock(layout, {
    operationId: 'op-update',
    owner: 'me-update',
  });
  expect(JSON.parse(fs.readFileSync(second.path, 'utf8')).owner).toBe('me-update');
  releaseVaultLock(layout, second);
});

test('does not unlink a lock whose bytes changed after acquisition', () => {
  const layout = preparedRuntime();
  const lock = acquireVaultLock(layout, {
    operationId: 'owned',
    owner: 'ingest',
  });
  fs.writeFileSync(lock.path, '{"version":1,"operationId":"foreign","owner":"ingest"}\n');

  expect(() => releaseVaultLock(layout, lock)).toThrow(/RECOVERY_REQUIRED/);
  expect(fs.existsSync(lock.path)).toBeTrue();
});
```

Update existing vault-write and ingest tests to expect `vault.lock`, and add a
test that holds it as `me-update` while each existing writer returns its
normal lock-conflict result without publishing content.

- [ ] **Step 2: Run the targeted tests and verify failure**

Run:

```bash
bun test test/cooperative-lock.test.ts \
  test/vault-write-transaction.test.ts \
  test/ingest-finalize.test.ts
```

Expected: `test/cooperative-lock.test.ts` fails because
`bin/cooperative-lock.ts` does not exist; existing lock-path assertions still
refer to `vault-write.lock` and ingest-specific-only locking.

- [ ] **Step 3: Implement the shared lock and integrate existing writers**

Move the no-follow exclusive-open, inode/device/byte ownership verification,
private permissions, and safe cleanup behavior out of
`bin/vault-write/transaction.ts` into `bin/cooperative-lock.ts`. The lock
payload must be:

```ts
const bytes = Buffer.from(`${JSON.stringify({
  version: 1,
  operationId: request.operationId,
  owner: request.owner,
  startedAt: new Date().toISOString(),
})}\n`);
```

Use `openSync(path, 'wx', 0o600)`, `fsyncSync`, `fchmodSync`, `fstatSync`,
`lstatSync`, and content re-read before treating the lock as owned. Release
must compare descriptor identity, path identity, operation ID, owner, and
bytes before unlinking.

In `executeVaultWrite`, acquire as owner `vault-write` before any graph
mutation and release in the existing ownership-aware cleanup path. In ingest
finalization, acquire as owner `ingest` before reservation/topic locks and
release after their cleanup. Preserve existing operation-specific locks; the
new lock supplies cross-subsystem serialization.

- [ ] **Step 4: Run targeted and regression tests**

Run:

```bash
bun test test/cooperative-lock.test.ts \
  test/vault-write-transaction.test.ts \
  test/ingest-finalize.test.ts
bash test/typecheck-ingest-finalize.sh
```

Expected: all pass; no existing recovery-state or failure-injection assertion
regresses.

- [ ] **Step 5: Commit**

```bash
git add bin/cooperative-lock.ts bin/vault-write/transaction.ts \
  bin/ingest/finalize.ts test/cooperative-lock.test.ts \
  test/vault-write-transaction.test.ts test/ingest-finalize.test.ts
git commit -m "refactor: share vault lock across me writers"
```

---

### Task 2: Define updater contracts and round-trip config editing

**Files:**
- Create: `bin/update/contracts.ts`
- Create: `bin/update/config-document.ts`
- Create: `test/update-contracts.test.ts`
- Create: `test/update-config.test.ts`
- Modify: `package.json`
- Create: `package-lock.json`

**Interfaces:**
- Consumes: `parseDocument` and `Document` from `yaml`.
- Produces:

```ts
export const CURRENT_VAULT_SCHEMA_VERSION = 1;

export type ConfigEdit =
  | { kind: 'set'; path: readonly string[]; value: string | number | boolean | readonly string[] }
  | { kind: 'remove'; path: readonly string[] }
  | { kind: 'rename'; from: readonly string[]; to: readonly string[] };

export interface ConfigRenderResult {
  currentVersion: number;
  sourceBytes: Buffer;
  desiredBytes: Buffer;
  sourceSha256: string;
  desiredSha256: string;
}

export function renderConfigEdits(
  configPath: string,
  edits: readonly ConfigEdit[],
): ConfigRenderResult;

export function readVaultSchemaVersion(source: string): number;
```

The shared contracts are:

```ts
export type UpdateStatus =
  | 'up_to_date'
  | 'preview'
  | 'blocked'
  | 'committed'
  | 'rolled_back'
  | 'recovery_required';

export type UpdateErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_A_ME_VAULT'
  | 'INVALID_CONFIG'
  | 'INVALID_VAULT_SCHEMA_VERSION'
  | 'VAULT_NEWER_THAN_PLUGIN'
  | 'INVALID_MIGRATION_REGISTRY'
  | 'MIGRATION_CONFLICT'
  | 'STALE_PREVIEW'
  | 'UPDATE_IN_PROGRESS'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'LEGACY_RUNTIME_STATE'
  | 'VALIDATION_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'INTERNAL_ERROR';

export interface SourceFingerprint {
  vaultRelativePath: string;
  type: 'missing' | 'file' | 'directory';
  sha256?: string;
  mode?: number;
}

export type PlannedMutation =
  | {
      kind: 'write-file';
      vaultRelativePath: string;
      source: SourceFingerprint;
      desiredBytes: Buffer;
      desiredSha256: string;
      publishOrder: number;
    }
  | {
      kind: 'mkdir';
      vaultRelativePath: string;
      source: SourceFingerprint;
      publishOrder: number;
    }
  | {
      kind: 'rename';
      vaultRelativePath: string;
      destinationVaultRelativePath: string;
      source: SourceFingerprint;
      publishOrder: number;
    };

export interface UpdatePlan {
  status: 'up_to_date' | 'preview';
  currentVaultSchemaVersion: number;
  targetVaultSchemaVersion: number;
  migrations: Array<{ id: string; description: string }>;
  mutations: PlannedMutation[];
  plannedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
  warnings: string[];
  planDigest: string;
}

export interface UpdateResultV1 {
  version: 1;
  status: UpdateStatus;
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
  error?: { code: UpdateErrorCode; message: string };
}
```

`UpdateError` stores one `UpdateErrorCode` and always uses the stable public
message from a frozen error catalog.

- [ ] **Step 1: Add the YAML dependency**

Run:

```bash
npm install yaml@^2.9.0
```

Expected: `package.json` gains runtime dependency `yaml` and npm creates or
updates `package-lock.json`. Do not add `diff` until Task 4 uses it.

- [ ] **Step 2: Write failing contract and config tests**

Use a fixture containing comments and unknown keys:

```ts
test('adds the schema version while preserving comments and unknown keys', () => {
  const config = fixtureConfig([
    '# portable vault config',
    'layers:',
    '  raw: "knowledge/raw" # keep this comment',
    '  practices: "knowledge/practices"',
    '  cognition: "knowledge/cognition"',
    'custom:',
    '  keep: true',
    '',
  ].join('\n'));

  const result = renderConfigEdits(config, [{
    kind: 'set',
    path: ['vault_schema_version'],
    value: 1,
  }]);

  const rendered = result.desiredBytes.toString('utf8');
  expect(rendered).toContain('# portable vault config');
  expect(rendered).toContain('raw: "knowledge/raw" # keep this comment');
  expect(rendered).toContain('custom:\\n  keep: true');
  expect(parseDocument(rendered).get('vault_schema_version')).toBe(1);
});

test('treats a missing version as legacy zero and rejects ambiguous yaml', () => {
  expect(readVaultSchemaVersion('layers:\\n  raw: raw\\n')).toBe(0);
  expect(() => readVaultSchemaVersion(
    'vault_schema_version: 0\\nvault_schema_version: 1\\n',
  )).toThrow(/INVALID_CONFIG/);
  expect(() => readVaultSchemaVersion('vault_schema_version: 1.5\\n'))
    .toThrow(/INVALID_VAULT_SCHEMA_VERSION/);
});
```

Add contract tests that assert every status maps to one stable exit class and
that a result serializer never includes absolute runtime paths.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test test/update-contracts.test.ts test/update-config.test.ts
```

Expected: failure because updater contracts and config functions are absent.

- [ ] **Step 4: Implement contracts and safe YAML mutation**

Parse with duplicate-key rejection and source-token retention:

```ts
const document = parseDocument(source, {
  keepSourceTokens: true,
  uniqueKeys: true,
});
if (document.errors.length > 0) throw new UpdateError('INVALID_CONFIG');
```

Require a mapping root. Read `vault_schema_version` as a non-negative safe
integer; absence returns `0`. Apply only declared direct paths, reject a rename
whose destination already exists, and serialize with a final newline. Reparse
the desired bytes and verify all edits before returning them. Never resolve
host paths or probe executables in this module.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/update-contracts.test.ts test/update-config.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json bin/update/contracts.ts \
  bin/update/config-document.ts test/update-contracts.test.ts \
  test/update-config.test.ts
git commit -m "feat: define me update config contracts"
```

---

### Task 3: Implement deterministic managed-asset ownership and merging

**Files:**
- Create: `bin/update/markdown-sections.ts`
- Create: `bin/update/managed-assets.ts`
- Create: `test/update-managed-assets.test.ts`
- Create: `templates/migration-history/0000/SCHEMA.md`
- Create: `templates/migration-history/0000/CLAUDE-template.md`
- Modify: `templates/CLAUDE-template.md`
- Modify: `skills/setup/references/merge-rules.md`

**Interfaces:**
- Consumes: source fingerprints and `UpdateError` from
  `bin/update/contracts.ts`.
- Produces:

```ts
export type ManagedAssetStrategy =
  | 'create-if-absent'
  | 'replace-known-template'
  | 'merge-owned-sections';

export interface ManagedAssetIntent {
  vaultRelativePath: string;
  desiredTemplatePath: string;
  strategy: ManagedAssetStrategy;
  knownTemplatePaths?: readonly string[];
  optional?: boolean;
}

export function planManagedAsset(
  vaultRoot: string,
  pluginRoot: string,
  intent: ManagedAssetIntent,
): PlannedMutation | undefined;

export function mergeMeOwnedSections(
  current: string,
  desiredTemplate: string,
): { content: string; adoptedLegacySections: string[] };
```

- Marker format:

```html
<!-- me:managed:start configuration -->
## Configuration
...
<!-- me:managed:end configuration -->
```

- [ ] **Step 1: Preserve the legacy templates before adding markers**

Copy the exact pre-updater bytes:

```bash
mkdir -p templates/migration-history/0000
cp templates/SCHEMA.md templates/migration-history/0000/SCHEMA.md
cp templates/CLAUDE-template.md \
  templates/migration-history/0000/CLAUDE-template.md
```

These snapshots are plugin resources used only for ownership proof; do not
edit them after copying.

- [ ] **Step 2: Write failing ownership and Markdown-merge tests**

Cover all three strategies and legacy adoption:

```ts
test('replaces only a byte-known historical template', () => {
  const vault = assetFixture('SCHEMA.md', legacySchemaBytes);
  const intent: ManagedAssetIntent = {
    vaultRelativePath: 'SCHEMA.md',
    desiredTemplatePath: 'templates/SCHEMA.md',
    strategy: 'replace-known-template',
    knownTemplatePaths: ['templates/migration-history/0000/SCHEMA.md'],
  };
  const mutation = planManagedAsset(vault, pluginRoot, intent);
  expect(mutation?.kind).toBe('write-file');

  fs.writeFileSync(path.join(vault, 'SCHEMA.md'), `${legacySchemaBytes}\\nuser`);
  expect(() => planManagedAsset(vault, pluginRoot, intent))
    .toThrow(/MIGRATION_CONFLICT/);
});

test('adopts exact legacy sections and preserves project instructions', () => {
  const current = [
    '# Knowledge Base',
    '',
    'legacy intro',
    '',
    '## Configuration',
    '',
    'legacy config text',
    '',
    '## Project Rules',
    '',
    'Never overwrite this.',
    '',
  ].join('\\n');

  const merged = mergeMeOwnedSections(current, desiredMarkedTemplate);
  expect(merged.content).toContain('<!-- me:managed:start configuration -->');
  expect(merged.content).toContain('## Project Rules\\n\\nNever overwrite this.');
});
```

Also test nested headings, duplicate markers, mismatched markers, an
unrecognized `# Knowledge Base`, symlink targets, special files, absent
optional `AGENTS.md`, and a second merge producing identical bytes.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test test/update-managed-assets.test.ts
```

Expected: failure because managed-asset modules and markers are absent.

- [ ] **Step 4: Implement section recognition and ownership strategies**

Parse ATX headings without executing Markdown. Treat fenced code blocks as
opaque so headings inside fences are not sections. For marked content,
replace only complete matching marker pairs. For legacy content, recognize
only the exact plugin-owned heading set from `merge-rules.md`; ambiguous or
duplicated owned headings return `MIGRATION_CONFLICT`.

`planManagedAsset` must:

1. resolve lexical and canonical vault/plugin roots;
2. reject absolute paths, traversal, symlinks, and non-regular targets;
3. hash current, known, and desired bytes;
4. return `undefined` when desired bytes already match;
5. return an exact `write-file` mutation only when the selected strategy
   proves ownership;
6. report a conflict instead of overwriting uncertain content.

Add ownership markers around every template-owned section in
`templates/CLAUDE-template.md`, and update merge rules to describe markers as
the primary mechanism and legacy headings as one-time adoption only.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/update-managed-assets.test.ts
bash test/vault-test.sh test_setup_upgrade_smart_merge
```

Expected: all pass. If the shell test name differs, locate the exact setup
merge test with `rg -n "smart.merge|merge.*CLAUDE" test/vault-test.sh` and run
that function using the script's documented single-test argument.

- [ ] **Step 6: Commit**

```bash
git add bin/update/markdown-sections.ts bin/update/managed-assets.ts \
  test/update-managed-assets.test.ts templates/CLAUDE-template.md \
  templates/migration-history/0000/SCHEMA.md \
  templates/migration-history/0000/CLAUDE-template.md \
  skills/setup/references/merge-rules.md
git commit -m "feat: plan owned me vault assets safely"
```

---

### Task 4: Build the migration registry, legacy migration, pure planner, and digest

**Files:**
- Create: `bin/update/registry.ts`
- Create: `bin/update/migrations/0000-to-0001.ts`
- Create: `bin/update/planner.ts`
- Create: `test/update-registry.test.ts`
- Create: `test/update-planner.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `renderConfigEdits`, `planManagedAsset`, and updater contracts.
- Produces:

```ts
export interface VaultMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  describe(): string;
  plan(context: ReadonlyMigrationContext): MigrationIntent;
}

export interface ReadonlyMigrationContext {
  vaultDir: string;
  pluginRoot: string;
  currentVaultSchemaVersion: number;
}

export interface ContentTransformIntent {
  vaultRelativePaths: readonly string[];
  transform(vaultRelativePath: string, currentBytes: Buffer): Buffer;
}

export interface MigrationIntent {
  configEdits: readonly ConfigEdit[];
  managedAssets: readonly ManagedAssetIntent[];
  contentTransforms: readonly ContentTransformIntent[];
}

export function validateMigrationRegistry(
  migrations: readonly VaultMigration[],
  currentVersion: number,
): void;

export function planVaultUpdate(options: {
  vaultDir: string;
  pluginRoot: string;
  registry?: readonly VaultMigration[];
}): UpdatePlan;
```

- `UpdatePlan.planDigest` is SHA-256 over canonical JSON containing registry
  revision, source/target versions, ordered migration IDs, normalized paths,
  source fingerprints, desired fingerprints, and operation kinds.

- [ ] **Step 1: Add deterministic diff support**

Run:

```bash
npm install diff@^9.0.0
```

Expected: `diff` appears under runtime dependencies and the lockfile updates.

- [ ] **Step 2: Write failing registry and planner tests**

```ts
function migration(fromVersion: number, toVersion: number, id: string): VaultMigration {
  return {
    id,
    fromVersion,
    toVersion,
    describe: () => id,
    plan: () => ({
      configEdits: [],
      managedAssets: [],
      contentTransforms: [],
    }),
  };
}

test('rejects gaps, duplicate edges, and non-unit version jumps', () => {
  expect(() => validateMigrationRegistry([
    migration(0, 1, 'a'),
    migration(2, 3, 'b'),
  ], 3)).toThrow(/INVALID_MIGRATION_REGISTRY/);
  expect(() => validateMigrationRegistry([
    migration(0, 2, 'jump'),
  ], 2)).toThrow(/INVALID_MIGRATION_REGISTRY/);
});

test('plans legacy zero to current one without writing', () => {
  const vault = legacyVault();
  const before = manifest(vault);
  const plan = planVaultUpdate({ vaultDir: vault, pluginRoot });

  expect(plan.currentVaultSchemaVersion).toBe(0);
  expect(plan.targetVaultSchemaVersion).toBe(1);
  expect(plan.migrations.map(item => item.id)).toEqual(['0000-to-0001']);
  expect(plan.mutations.at(-1)?.vaultRelativePath).toBe('.me/config.yaml');
  expect(plan.diffs.some(item => item.path === '.me/config.yaml')).toBeTrue();
  expect(manifest(vault)).toEqual(before);
});

test('digest changes for every material input and is stable otherwise', () => {
  const first = planVaultUpdate(options);
  const second = planVaultUpdate(options);
  expect(second.planDigest).toBe(first.planDigest);

  fs.appendFileSync(path.join(vault, 'AGENTS.md'), '\\nuser change\\n');
  expect(planVaultUpdate(options).planDigest).not.toBe(first.planDigest);
});
```

Add cases for current vault (`up_to_date`), malformed config, future schema,
optional absent Agent files, modified managed files, unsafe paths, and exact
unified diffs without absolute paths.

The future-schema case must assert the exact compatibility error:

```ts
test('refuses a vault newer than the installed migration registry', () => {
  writeConfig(vault, 'vault_schema_version: 2\\n');
  expect(() => planVaultUpdate({ vaultDir: vault, pluginRoot }))
    .toThrow(expect.objectContaining({ code: 'VAULT_NEWER_THAN_PLUGIN' }));
});
```

Use an injected registry migration in a fixture to prove content transforms
expand to a closed, fingerprinted file list during preview; apply must not
rescan an open-ended directory for additional note targets.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test test/update-registry.test.ts test/update-planner.test.ts
```

Expected: failure because registry, migration, and planner are absent.

- [ ] **Step 4: Implement registry and `0000-to-0001`**

The static registry is:

```ts
import { migration0000To0001 } from './migrations/0000-to-0001';

export const MIGRATION_REGISTRY = Object.freeze([
  migration0000To0001,
]);
```

Migration `0000-to-0001` must:

- set `vault_schema_version` to `1`;
- plan `SCHEMA.md` with `replace-known-template`;
- plan existing `CLAUDE.md` and `AGENTS.md` with
  `merge-owned-sections`, treating absence as an optional no-op;
- leave Profiles and knowledge-layer notes untouched.

The planner reads all inputs before returning, resolves every migration from
current to target, rejects conflicts, sorts mutations so the config version
write is last, and uses `createTwoFilesPatch` for text diffs. Canonicalize the
digest input by lexicographically sorting object keys and path lists; do not
include random operation IDs, timestamps, absolute paths, or raw file content.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test test/update-registry.test.ts test/update-planner.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json bin/update/registry.ts \
  bin/update/migrations/0000-to-0001.ts bin/update/planner.ts \
  test/update-registry.test.ts test/update-planner.test.ts
git commit -m "feat: plan versioned me vault migrations"
```

---

### Task 5: Add the read-only preview CLI and structured result mapping

**Files:**
- Create: `bin/update.ts`
- Create: `test/update-cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `planVaultUpdate`.
- Produces:

```ts
export function runUpdateCli(
  argv: readonly string[],
  options?: UpdateCliOptions,
): UpdateResultV1;

export function exitCodeForUpdateResult(result: UpdateResultV1): number;
```

- CLI:

```text
me-update preview --vault-dir <vault>
```

- Task 5 deliberately exposes only the complete read-only preview command.
  Task 6 adds `apply` and `--expected-plan-digest` together with the real
  transaction executor, so no intermediate commit advertises a partial apply
  path.

- [ ] **Step 1: Write failing CLI preview tests**

```ts
test('preview emits one JSON result and creates no runtime state', () => {
  const vault = legacyVault();
  const runtime = resolveRuntimeLayout(vault, testEnvironment);
  const before = manifest(vault);
  const result = runUpdateCli([
    'preview',
    '--vault-dir',
    vault,
  ], { pluginRoot, environment: testEnvironment });

  expect(result.status).toBe('preview');
  expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.changedPaths).toEqual([]);
  expect(manifest(vault)).toEqual(before);
  expect(fs.existsSync(runtime.runtimeRoot)).toBeFalse();
});

test('rejects apply before the transaction command is introduced', () => {
  const result = runUpdateCli(['apply', '--vault-dir', vault], { pluginRoot });
  expect(result.error?.code).toBe('INVALID_REQUEST');
  expect(exitCodeForUpdateResult(result)).toBe(2);
});
```

Test exact argument rejection, `up_to_date`, conflict, future vault, error exit
classes, one-line JSON from a spawned process, and absence of absolute runtime
or vault paths in public fields.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test test/update-cli.test.ts
```

Expected: failure because `bin/update.ts` is absent.

- [ ] **Step 3: Implement CLI parsing and preview result**

Follow `bin/vault-write.ts` conventions:

- accept exactly one mode;
- require exactly one `--vault-dir`;
- reject `apply` and `--expected-plan-digest` in this preview-only task;
- catch only known updater/runtime errors into stable public results;
- write one JSON line and set exit code when run as main;
- map `preview` and `up_to_date` to exit `0`, validation to `2`, conflict to
  `3`, recovery to `4`, unsupported to `5`, and unexpected internal failure to
  `1`.

Convert an `UpdatePlan` to `UpdateResultV1` without exposing desired bytes,
absolute paths, or source contents.

- [ ] **Step 4: Run tests**

Run:

```bash
bun test test/update-cli.test.ts
```

Expected: all preview/argument/result tests pass.

- [ ] **Step 5: Commit**

```bash
git add bin/update.ts test/update-cli.test.ts package.json
git commit -m "feat: preview me vault updates"
```

---

### Task 6: Implement digest-bound journaled apply, rollback, and recovery

**Files:**
- Create: `bin/update/transaction.ts`
- Create: `test/update-transaction.test.ts`
- Modify: `bin/update.ts`
- Modify: `test/update-cli.test.ts`

**Interfaces:**
- Consumes: `planVaultUpdate`, `acquireVaultLock`, runtime path helpers, and
  `UpdatePlan`.
- Produces:

```ts
export interface UpdateTransactionOptions {
  pluginRoot: string;
  environment?: NodeJS.ProcessEnv;
  hooks?: {
    beforeMutation?(kind: string, paths: readonly string[]): void;
    beforeLockRelease?(path: string): void;
  };
}

export function executeVaultUpdate(
  vaultDir: string,
  expectedPlanDigest: string,
  options: UpdateTransactionOptions,
): UpdateResultV1;
```

- Transaction directory:
  `<ME_RUNTIME>/transactions/me-update-<operationId>/`.

- [ ] **Step 1: Write failing successful-apply and stale-preview tests**

```ts
test('replans under lock and commits the confirmed digest', () => {
  const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
  const result = executeVaultUpdate(vault, preview.planDigest, {
    pluginRoot,
    environment: testEnvironment,
  });

  expect(result.status).toBe('committed');
  expect(readVaultSchemaVersion(configBytes(vault))).toBe(1);
  expect(result.changedPaths.at(-1)).toBe('.me/config.yaml');
  expect(planVaultUpdate({ vaultDir: vault, pluginRoot }).status).toBe('up_to_date');
});

test('rejects stale preview before staging or vault mutation', () => {
  const preview = planVaultUpdate({ vaultDir: vault, pluginRoot });
  fs.appendFileSync(path.join(vault, 'AGENTS.md'), '\\nexternal edit\\n');
  const before = manifest(vault);

  const result = executeVaultUpdate(vault, preview.planDigest, {
    pluginRoot,
    environment: testEnvironment,
  });

  expect(result.error?.code).toBe('STALE_PREVIEW');
  expect(manifest(vault)).toEqual(before);
});
```

- [ ] **Step 2: Write failing fault-injection and recovery tests**

Inject failure before each hard-link/rename/unlink/mkdir boundary. Assert:

- failure before first vault mutation removes owned staging and originals;
- failure after mutation restores owned originals;
- externally changed output is preserved and yields `recovery_required`;
- the journal contains IDs, fingerprints, and mutation state but no file
  content;
- recovery paths begin with `<ME_RUNTIME>/transactions/me-update-`;
- schema version never advances on rollback or recovery;
- a held `vault.lock` returns `UPDATE_IN_PROGRESS`;
- non-empty ME 1.5 runtime state returns `LEGACY_RUNTIME_STATE`.

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
bun test test/update-transaction.test.ts test/update-cli.test.ts
```

Expected: transaction tests fail because `executeVaultUpdate` is absent and
CLI apply is not wired.

- [ ] **Step 4: Implement locked replan and staging**

Execution order:

```ts
const layout = resolveRuntimeLayout(vaultDir, options.environment);
bootstrapRuntimeDirectories(layout, [layout.lockDir, layout.transactionDir]);
const lock = acquireVaultLock(layout, {
  operationId,
  owner: 'me-update',
});
try {
  const plan = planVaultUpdate({ vaultDir, pluginRoot: options.pluginRoot });
  if (plan.status === 'up_to_date') return upToDateResult(plan);
  if (plan.planDigest !== expectedPlanDigest) {
    throw new UpdateError('STALE_PREVIEW');
  }
  return commitPlannedUpdate(plan, layout, operationId, options);
} finally {
  releaseVaultLock(layout, lock);
}
```

Before the first mutation, create a private operation directory and
`journal.json`, stage desired files with mode `0600`, fsync them, and verify
their SHA-256 digests. Use same-filesystem hard links/renames and record
`pendingMutation` before every filesystem change. Move or link originals into
`originals/` before replacement. Publish `.me/config.yaml` last.

On error, restore only files whose inode/digest ownership still matches the
transaction. When ownership is ambiguous, stop cleanup, retain journal and
originals, and return `RECOVERY_REQUIRED`. Do not return committed until all
postconditions and final config version validate.

- [ ] **Step 5: Wire CLI apply and run tests**

Extend CLI parsing with:

```text
me-update apply --vault-dir <vault> --expected-plan-digest <sha256>
```

Call `executeVaultUpdate` from `runUpdateCli` only after validating a
64-character lowercase SHA-256 digest. Keep the preview parsing and output
contract unchanged.

Run:

```bash
bun test test/update-transaction.test.ts test/update-cli.test.ts
```

Expected: all pass.

- [ ] **Step 6: Run writer concurrency regressions**

Run:

```bash
bun test test/cooperative-lock.test.ts \
  test/vault-write-transaction.test.ts \
  test/ingest-finalize.test.ts \
  test/update-transaction.test.ts
```

Expected: all pass; each writer serializes through `vault.lock`.

- [ ] **Step 7: Commit**

```bash
git add bin/update/transaction.ts bin/update.ts \
  test/update-transaction.test.ts test/update-cli.test.ts
git commit -m "feat: apply me vault migrations safely"
```

---

### Task 7: Add the `me:update` Skill, change setup boundary, and publish docs

**Files:**
- Create: `skills/update/SKILL.md`
- Modify: `skills/setup/SKILL.md`
- Modify: `README.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/features.md`
- Modify: `docs/development.md`
- Modify: `package.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `test/vault-test.sh`

**Interfaces:**
- Consumes: the `me-update` CLI from Tasks 5–6.
- Produces: `$me:update` / `/me:update` behavior and current-version fresh
  setup.

- [ ] **Step 1: Write failing Skill/setup/package contract tests**

Add shell assertions equivalent to:

```bash
assert_file_exists "$PLUGIN_ROOT/skills/update/SKILL.md"
assert_file_contains "$PLUGIN_ROOT/skills/update/SKILL.md" \
  'bin/update.ts preview'
assert_file_contains "$PLUGIN_ROOT/skills/update/SKILL.md" \
  'expected-plan-digest'
assert_file_contains "$PLUGIN_ROOT/skills/update/SKILL.md" \
  'explicit confirmation'
assert_file_contains "$PLUGIN_ROOT/skills/setup/SKILL.md" \
  'vault_schema_version: 1'
assert_file_contains "$PLUGIN_ROOT/skills/setup/SKILL.md" \
  'Run.*me:update'
assert_file_contains "$PLUGIN_ROOT/package.json" '"me-update"'
```

Add an end-to-end temporary-vault test:

1. fresh setup instructions generate `vault_schema_version: 1`;
2. existing config causes setup to report update guidance without changing
   file hashes;
3. preview of a legacy fixture leaves it unchanged;
4. apply with the returned digest migrates it;
5. the second preview is `up_to_date`.

- [ ] **Step 2: Run contract tests and verify failure**

Run:

```bash
bash test/vault-test.sh
```

Expected: new update/setup/package assertions fail.

- [ ] **Step 3: Write `skills/update/SKILL.md`**

The Skill must perform exactly this flow:

1. resolve target vault from cwd or one explicit path;
2. run CLI `preview`;
3. stop on `blocked`, conflicts, newer vault, or recovery state;
4. report `up_to_date` immediately;
5. display ordered migration descriptions, paths, warnings, and exact diffs;
6. ask one explicit confirmation question;
7. if declined, report `not written`;
8. if confirmed, run `apply` with the preview's exact `planDigest`;
9. report only the structured result, including `STALE_PREVIEW` guidance to
   preview again.

Include this hard boundary:

```markdown
Never edit migration targets directly. Never apply without the digest from
the preview shown to the user in this conversation. Preview does not authorize
apply; the user's affirmative response does.
```

- [ ] **Step 4: Change setup to create current vaults and hand off existing ones**

Fresh config begins:

```yaml
# me plugin configuration
vault_schema_version: 1

layers:
  raw: "<raw_dir>"
  practices: "<practices_dir>"
  cognition: "<cognition_dir>"
```

Add ME ownership markers through the current template. When
`.me/config.yaml` already exists, setup performs no writes and reports:

```text
me vault already initialized.
Run $me:update (Codex) or /me:update (Claude Code) to preview any required
vault migrations. No files changed.
```

Remove the old setup behavior that directly refreshes `SCHEMA.md` and
smart-merges `CLAUDE.md`; that behavior now belongs to migration
`0000-to-0001`.

- [ ] **Step 5: Update packaging and documentation**

Add:

```json
"me-update": "bin/update.ts"
```

under `package.json.bin`. The plugin manifest already exposes the whole
`skills/` directory; add update-oriented default prompt text without adding a
second skills path.

Document the two separate operations:

```bash
codex plugin marketplace upgrade me-marketplace
# then, in the vault
$me:update
```

Explain preview/confirmation, schema version, forward-only policy,
`STALE_PREVIEW`, recovery inspection, and that ME never commits the user's
vault.

- [ ] **Step 6: Run complete verification**

Run:

```bash
npm install
bun test test/*.test.ts
bash test/typecheck-ingest-finalize.sh
bash test/vault-test.sh
npm test
```

Expected: all commands exit `0`. Review CLI JSON fixtures to confirm no
absolute runtime path, source content, or user Profile content appears.

- [ ] **Step 7: Verify packaged contents**

Run:

```bash
npm pack --dry-run
```

Expected: output includes `skills/update/SKILL.md`, `bin/update.ts`,
`bin/update/**`, current templates, and `templates/migration-history/0000/**`;
it excludes `.planning/`, `.worktrees/`, runtime state, and test fixtures.

- [ ] **Step 8: Commit**

```bash
git add skills/update/SKILL.md skills/setup/SKILL.md README.md \
  docs/user-guide.md docs/features.md docs/development.md \
  package.json .codex-plugin/plugin.json test/vault-test.sh
git commit -m "feat: expose versioned me vault updates"
```

---

## Final review gate

Before integration:

- [ ] Compare every section of the design spec with Tasks 1–7.
- [ ] Run `rg -n 'TB[D]|TO[D]O|implement [l]ater|appropriate [e]rror|similar to [T]ask' docs/superpowers/plans/2026-07-26-me-update-vault-migration.md` and resolve every hit.
- [ ] Confirm all Task 2 contract names are used unchanged by Tasks 3–7.
- [ ] Confirm preview performs no `mkdir`, lock acquisition, staging, or runtime bootstrap.
- [ ] Confirm apply publishes `.me/config.yaml` last and never advances the version after rollback/recovery.
- [ ] Confirm `git status --short` contains only intended implementation and plan artifacts.
- [ ] Request an independent code review before merging.
