# Home Runtime Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change ME's default host-local runtime base from a vault-adjacent `.me-runtime/` directory to `~/.me/runtime/`, while preserving per-vault isolation and fail-closed same-filesystem semantics.

**Architecture:** `bin/runtime-paths.ts` remains the single resolver for writer and ingest runtime paths. The default base comes from `os.homedir()` and the existing `vault-<canonical-path-hash>` namespace remains unchanged; `ME_RUNTIME_ROOT` still overrides the base. Existing device checks reject a home-based runtime on a different filesystem and instruct users to set an explicit same-device override.

**Tech Stack:** TypeScript, Bun test runner, Bash contract tests, Markdown documentation.

## Global Constraints

- Default runtime base is exactly `path.join(os.homedir(), '.me', 'runtime')`.
- The per-vault namespace remains `vault-<sha256(canonical-vault-path)[0:24]>`.
- `ME_RUNTIME_ROOT` remains an absolute, host-local override and is never written to `.me/config.yaml`.
- A runtime base on a different filesystem fails with `UNSUPPORTED_FILESYSTEM`.
- There is no vault-adjacent fallback and no cross-device copy mode.
- Runtime path resolution remains read-only; directories are created only by explicit bootstrap operations.
- Existing containment, symlink rejection, private permissions, recovery display, ingest, and vault-writer contracts remain unchanged.

---

## File Structure

- Modify `bin/runtime-paths.ts`: resolve the default runtime base from the current user's home directory.
- Modify `test/runtime-paths.test.ts`: pin the new default and verify the old sibling path is not selected or created.
- Modify `test/vault-test.sh`: require public documentation to describe `~/.me/runtime/` and reject the obsolete `.me-runtime` default.
- Modify `README.md`: update the concise sync-safety contract.
- Modify `docs/user-guide.md`: document the default, cross-filesystem error, and override remedy.
- Modify `docs/features.md`: update the architecture diagram and runtime description.
- Modify `docs/development.md`: update the resolver contract for maintainers.
- Modify `skills/setup/SKILL.md`: ensure setup teaches the new host-local default.
- Modify `docs/superpowers/plans/2026-07-26-external-runtime-state.md`: mark the original sibling-default examples as superseded by the approved design amendment.
- Create `bunfig.toml`: preload the Bun test runtime isolation hook.
- Create `test/runtime-test-preload.ts`: route test mutations to a process-local temporary runtime and remove it on exit.
- Create `test/runtime-test-environment.test.ts`: prove tests do not use the real home runtime.
- Modify `test/ingest-contracts.test.ts`: keep expected runtime paths and child-process environments aligned with the test override.
- Modify `test/ingest-finalize.test.ts`: assert per-vault non-mutation rather than shared-base absence.

### Task 1: Resolve the default runtime under the user home

**Files:**
- Modify: `test/runtime-paths.test.ts`
- Modify: `bin/runtime-paths.ts`

**Interfaces:**
- Consumes: `resolveRuntimeLayout(vaultDir: string, environment?: NodeJS.ProcessEnv): RuntimeLayout`
- Produces: unchanged `RuntimeLayout`; `runtimeBase` defaults to `path.join(os.homedir(), '.me', 'runtime')`

- [ ] **Step 1: Write the failing default-path test**

Replace the sibling-root test with assertions equivalent to:

```ts
test('derives a deterministic home runtime namespace without creating it', () => {
  const first = resolveRuntimeLayout(vault, {});
  const second = resolveRuntimeLayout(vault, {});
  const expectedBase = path.join(os.homedir(), '.me', 'runtime');
  const oldSiblingBase = path.join(path.dirname(fs.realpathSync(vault)), '.me-runtime');

  expect(first.runtimeBase).toBe(expectedBase);
  expect(first.runtimeRoot).toBe(second.runtimeRoot);
  expect(path.dirname(first.runtimeRoot)).toBe(expectedBase);
  expect(path.basename(first.runtimeRoot)).toMatch(/^vault-[a-f0-9]{24}$/);
  expect(fs.existsSync(oldSiblingBase)).toBeFalse();
});
```

Do not assert that `~/.me` is absent because it may already exist on the developer's machine. Instead snapshot the runtime namespace entry count before and after resolution and assert it is unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test test/runtime-paths.test.ts
```

Expected: FAIL because `runtimeBase` still resolves to the vault-adjacent `.me-runtime`.

- [ ] **Step 3: Implement the minimal resolver change**

In `bin/runtime-paths.ts`:

```ts
import * as os from 'os';

const runtimeBase = override
  ? path.resolve(override)
  : path.join(os.homedir(), '.me', 'runtime');
```

Keep all override validation, containment checks, prefix validation, device checks, hashing, and bootstrap behavior unchanged.

- [ ] **Step 4: Run resolver tests and verify GREEN**

Run:

```bash
bun test test/runtime-paths.test.ts test/runtime-cli.test.ts
```

Expected: all tests pass; no new runtime directory is created by the path-only test.

- [ ] **Step 5: Commit the resolver change**

```bash
git add bin/runtime-paths.ts test/runtime-paths.test.ts
git commit -m "feat: default runtime state to user home"
```

### Task 2: Publish the home-runtime contract

**Files:**
- Modify: `test/vault-test.sh`
- Modify: `README.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/features.md`
- Modify: `docs/development.md`
- Modify: `skills/setup/SKILL.md`
- Modify: `docs/superpowers/plans/2026-07-26-external-runtime-state.md`

**Interfaces:**
- Consumes: the Task 1 default `~/.me/runtime/vault-<path-hash>/`
- Produces: public and maintainer documentation that describes the same default and same-filesystem remedy

- [ ] **Step 1: Write failing documentation contract assertions**

Update `test_external_runtime_documented` so each active public document must contain `~/.me/runtime` and `ME_RUNTIME_ROOT`:

```bash
for file in README.md docs/user-guide.md docs/features.md docs/development.md; do
  assert_file_contains "$PLUGIN_ROOT/$file" '~/.me/runtime' || return 1
  assert_file_contains "$PLUGIN_ROOT/$file" 'ME_RUNTIME_ROOT' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/$file" 'vault 相邻的 .me-runtime' || return 1
done
```

Also require `skills/setup/SKILL.md` to contain `~/.me/runtime` and not contain the obsolete `.me-runtime` default.

- [ ] **Step 2: Run the focused contract and verify RED**

Run:

```bash
bash test/vault-test.sh test_external_runtime_documented
```

Expected: FAIL because the active documentation still names `.me-runtime`.

- [ ] **Step 3: Update active documentation and setup skill**

Use these exact semantics everywhere:

```text
默认：~/.me/runtime/vault-<path-hash>/
跨 filesystem：操作在创建锁或 staging 前停止，并提示设置同盘的 ME_RUNTIME_ROOT。
无自动 vault-adjacent fallback，无 cross-device copy mode。
```

In the original implementation plan, add a prominent amendment immediately below the header:

```markdown
> **Design amendment (2026-07-26):** The approved default is
> `~/.me/runtime/vault-<path-hash>/`, not a vault-adjacent `.me-runtime`.
> Cross-filesystem layouts fail closed and require `ME_RUNTIME_ROOT`.
```

Do not rewrite historical RED/GREEN command transcripts beyond this amendment; the active spec and docs define the shipped behavior.

- [ ] **Step 4: Validate the modified setup skill**

Run:

```bash
python3 /Users/wu8685/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/setup
```

Expected: `Skill is valid!`

- [ ] **Step 5: Run documentation contracts and verify GREEN**

Run:

```bash
bash test/vault-test.sh test_external_runtime_documented
bash test/vault-test.sh test_skills_use_external_runtime
```

Expected: both focused tests pass.

- [ ] **Step 6: Commit the documentation contract**

```bash
git add README.md docs/user-guide.md docs/features.md docs/development.md \
  skills/setup/SKILL.md test/vault-test.sh \
  docs/superpowers/plans/2026-07-26-external-runtime-state.md
git commit -m "docs: publish home runtime default"
```

### Task 3: Regression and release verification

**Files:**
- Create: `bunfig.toml`
- Create: `test/runtime-test-preload.ts`
- Create: `test/runtime-test-environment.test.ts`
- Modify: `test/ingest-contracts.test.ts`
- Modify: `test/ingest-finalize.test.ts`
- Verify all task files

**Interfaces:**
- Consumes: Tasks 1 and 2
- Produces: evidence that ME 1.6 consistently ships the approved runtime default

- [ ] **Step 0: Isolate the Bun suite from the real home runtime**

Configure Bun to preload a test hook that creates a private runtime under the
canonical temporary directory, exports it through `ME_RUNTIME_ROOT`, and
removes it on process exit. Add a regression test that resolves a temporary
vault with the process environment and proves its runtime base is under the
temporary directory rather than `~/.me/runtime`. Integration-test helpers and
child processes must consume or propagate the same environment; the dedicated
default resolver test remains the only test that passes `{}` deliberately.

Run:

```bash
bun test test/runtime-test-environment.test.ts \
  test/ingest-finalize.test.ts test/ingest-contracts.test.ts
```

Expected: zero failures, and `~/.me/runtime` remains unchanged.

- [ ] **Step 1: Run all Bun tests**

```bash
bun test
```

Expected: zero failures; the single live-network Bilibili redirect test may remain skipped.

- [ ] **Step 2: Run the ingest typecheck**

```bash
bash test/typecheck-ingest-finalize.sh
```

Expected: no task-local type errors. The existing missing Node/URL ambient typing diagnostics may remain explicitly ignored by the script.

- [ ] **Step 3: Run the shell suite**

```bash
bash test/vault-test.sh
```

Expected: all local contract tests pass. Claude subscription E2E tests may report the previously documented organization-level access failure; no task-local shell test may fail.

- [ ] **Step 4: Validate the package and repository**

```bash
git diff --check v1.5.0...HEAD
npm pack --json --dry-run
rg -n 'vault 相邻的 \.me-runtime|canonical vault 相邻|本机运行时：vault 外相邻' \
  README.md docs/user-guide.md docs/features.md docs/development.md skills/setup/SKILL.md
```

Expected: `git diff --check` and package dry-run exit zero; the final `rg` returns no matches.

- [ ] **Step 5: Inspect final branch state**

```bash
git status --short
git log --oneline -5
```

Expected: clean worktree with the design, resolver, and documentation commits at the branch tip.
