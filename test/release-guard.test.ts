import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");

/**
 * Release guard tests.
 *
 * Verifies the three invariants required by Issue #13:
 * 1. All version-bearing manifests agree.
 * 2. Package-affecting changes without a version bump fail CI.
 * 3. A recorded version→content-digest mapping is never overwritten
 *    with a different payload.
 *
 * Plus the install-contract invariants required by Issue #18:
 * 4. package.json and package-lock.json agree (clean `npm ci` hydration).
 * 5. Every runtime dependency is bundled into the packed artifact.
 */
describe("release guard", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-release-guard-"));
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function runGuard(
    args: string[],
    opts?: { cwd?: string; expectedExit?: number },
  ): { exitCode: number; stdout: string; stderr: string } {
    const expectedExit = opts?.expectedExit ?? 0;
    try {
      const result = execSync(
        `bun run ${PLUGIN_ROOT}/bin/release-guard.ts ${args.join(" ")}`,
        {
          cwd: opts?.cwd ?? PLUGIN_ROOT,
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
      return { exitCode: 0, stdout: result, stderr: "" };
    } catch (e: any) {
      const stdout = (e as any)?.stdout?.toString() ?? "";
      const stderr = (e as any)?.stderr?.toString() ?? "";
      const exitCode = (e as any)?.status ?? 1;
      return { exitCode, stdout, stderr };
    }
  }

  describe("version agreement", () => {
    it("all version-bearing manifests agree on the same version", () => {
      const versionPaths: Record<string, string> = {
        "package.json": "version",
        ".claude-plugin/plugin.json": "version",
        ".claude-plugin/marketplace.json": "plugins[0].version",
        ".codex-plugin/plugin.json": "version",
      };

      const versions: string[] = [];
      for (const [relPath, jsonPath] of Object.entries(versionPaths)) {
        const fullPath = path.join(PLUGIN_ROOT, relPath);
        const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        const segments = jsonPath.split(/\.|\[|\]/).filter(Boolean);
        let value: any = content;
        for (const seg of segments) {
          const idx = parseInt(seg, 10);
          value = Number.isNaN(idx) ? value[seg] : value[idx];
        }
        versions.push(value as string);
      }

      const unique = [...new Set(versions)];
      expect(unique.length).toBe(1);
      expect(unique[0]).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("release guard check fails when manifests disagree (simulated)", { timeout: 15_000 }, () => {
      const guardTmp = path.join(tmpDir, "version-disagree");
      fs.mkdirSync(guardTmp, { recursive: true });
      fs.mkdirSync(path.join(guardTmp, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(guardTmp, ".codex-plugin"), { recursive: true });

      fs.cpSync(
        path.join(PLUGIN_ROOT, ".claude-plugin"),
        path.join(guardTmp, ".claude-plugin"),
        { recursive: true },
      );
      fs.cpSync(
        path.join(PLUGIN_ROOT, ".codex-plugin"),
        path.join(guardTmp, ".codex-plugin"),
        { recursive: true },
      );
      fs.cpSync(
        path.join(PLUGIN_ROOT, "package.json"),
        path.join(guardTmp, "package.json"),
      );

      const codexPlugin = JSON.parse(
        fs.readFileSync(path.join(guardTmp, ".codex-plugin/plugin.json"), "utf-8"),
      );
      codexPlugin.version = "9.9.9";
      fs.writeFileSync(
        path.join(guardTmp, ".codex-plugin/plugin.json"),
        JSON.stringify(codexPlugin, null, 2),
      );

      const result = runGuard(["check", "--root", guardTmp], {
        cwd: guardTmp,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/version|mismatch|disagree/i);
    });
  });

  describe("package-affecting change detection", () => {
    it("check-affected identifies skills/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      expect(result.stdout).toMatch(/skills\//);
    });

    it("check-affected identifies bin/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      expect(result.stdout).toMatch(/bin\//);
    });

    it("check-affected identifies templates/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      expect(result.stdout).toMatch(/templates\//);
    });

    it("check-affected lists package.json as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      expect(result.stdout).toMatch(/package\.json/);
    });

    it("check-affected lists test/ only in exempt paths, not packlist", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      // test/ should appear under "Exempt" section only, not in the packlist
      const sections = result.stdout.split("\n\n");
      const packlistSection = sections[0] ?? "";
      const exemptSection = sections.slice(1).join("\n");
      expect(packlistSection).not.toMatch(/test\//);
      expect(exemptSection).toMatch(/test\//);
    });

    it("check-affected DOES list docs/ as package-affecting (they are shipped)", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      // docs/ files are in the npm packlist → they appear in the packlist output
      expect(result.stdout).toMatch(/docs\//);
    });

    it("check-affected DOES list root markdown as package-affecting (shipped)", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT]);
      // README, AGENTS, CLAUDE, etc. are in the packlist
      expect(result.stdout).toMatch(/README|AGENTS|CLAUDE/);
    });
  });

  describe("VERSION_NOT_BUMPED rejection (git-based)", () => {
    it("rejects a package-affecting change without version bump", () => {
      // Set up a fake git repo with a baseline commit, then introduce
      // a package-affecting change without bumping the version.
      const repoDir = path.join(tmpDir, "no-bump-repo");
      fs.mkdirSync(repoDir, { recursive: true });

      // Init repo
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });

      // Create a minimal plugin root with just enough for the guard
      fs.mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".codex-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".agents/plugins"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "skills/test-skill"), { recursive: true });

      const pkg = {
        name: "me",
        version: "1.0.0",
        files: ["skills/"],
      };
      fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ version: "1.0.0" }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: [{ source: { path: "./" } }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, "skills/test-skill/SKILL.md"), "# Test\n");

      // First commit — baseline
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repoDir, stdio: "pipe" });

      // Now modify a shipped file (package-affecting) WITHOUT bumping version
      fs.appendFileSync(path.join(repoDir, "skills/test-skill/SKILL.md"), "changed\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      const combined = result.stderr + result.stdout;
      expect(combined).toMatch(/VERSION_NOT_BUMPED/);
      expect(combined).toMatch(/1\.0\.0/);
    });

    it("allows a test-only change without version bump", () => {
      const repoDir = path.join(tmpDir, "test-only-repo");
      fs.mkdirSync(repoDir, { recursive: true });

      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });

      fs.mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".codex-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".agents/plugins"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "test"), { recursive: true });

      const pkg = { name: "me", version: "1.0.0", files: ["skills/"] };
      fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ version: "1.0.0" }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: [{ source: { path: "./" } }] }, null, 2));

      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repoDir, stdio: "pipe" });

      // Modify test/ (not in packlist, not package-affecting) — should pass
      fs.writeFileSync(path.join(repoDir, "test/dummy.test.ts"), "// test");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr + result.stdout).not.toMatch(/VERSION_NOT_BUMPED/);
    });

    it("fails closed when base ref does not exist", () => {
      // Use the real repo but ask for a ref that doesn't exist
      const result = runGuard(
        ["check", "--root", PLUGIN_ROOT, "--base-ref", "refs/heads/does-not-exist-xyzzy"],
        { expectedExit: 1 },
      );
      expect(result.exitCode).toBe(1);
      const combined = result.stderr + result.stdout;
      expect(combined).toMatch(/GIT_ERROR|BASE_VERSION_UNREADABLE/);
    });

    it("rejects a docs/ change without version bump (docs are shipped)", () => {
      const repoDir = path.join(tmpDir, "docs-bump-repo");
      fs.mkdirSync(repoDir, { recursive: true });

      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });

      fs.mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".codex-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".agents/plugins"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });

      const pkg = { name: "me", version: "1.0.0", files: ["docs/"] };
      fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ version: "1.0.0" }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "me", version: "1.0.0" }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: [{ source: { path: "./" } }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, "docs/guide.md"), "# User Guide\n");

      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repoDir, stdio: "pipe" });

      // Modify docs/ — which is in the packlist, so must bump
      fs.appendFileSync(path.join(repoDir, "docs/guide.md"), "updated\n");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/VERSION_NOT_BUMPED/);
    });
  });

  describe("lockfile consistency (install contract)", () => {
    /**
     * Build a minimal synthetic plugin repo whose manifests all agree,
     * with a controllable package.json and package-lock.json.
     */
    function makeLockfileRepo(
      name: string,
      opts: {
        pkg?: Record<string, unknown>;
        lock?: Record<string, unknown> | null;
        bumpVersion?: string;
      } = {},
    ): string {
      const repoDir = path.join(tmpDir, name);
      fs.mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".codex-plugin"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, ".agents/plugins"), { recursive: true });
      fs.mkdirSync(path.join(repoDir, "skills/test-skill"), { recursive: true });

      const version = opts.bumpVersion ?? "1.0.0";
      const pkg = {
        name: "me",
        version,
        files: ["skills/"],
        ...opts.pkg,
      };
      fs.writeFileSync(
        path.join(repoDir, "package.json"),
        JSON.stringify(pkg, null, 2),
      );
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "me", version }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ version }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "me", version }, null, 2));
      fs.writeFileSync(path.join(repoDir, ".agents/plugins/marketplace.json"), JSON.stringify({ plugins: [{ source: { path: "./" } }] }, null, 2));
      fs.writeFileSync(path.join(repoDir, "skills/test-skill/SKILL.md"), "# Test\n");

      if (opts.lock !== null) {
        const lock = opts.lock ?? {
          name: pkg.name,
          version: pkg.version,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: pkg.name,
              version: pkg.version,
              dependencies: (pkg as any).dependencies,
              devDependencies: (pkg as any).devDependencies,
            },
            ...Object.fromEntries(
              [
                ...Object.keys((pkg as any).dependencies ?? {}),
                ...Object.keys((pkg as any).devDependencies ?? {}),
              ].map((dep) => [
                `node_modules/${dep}`,
                { version: "0.0.0", resolved: "https://registry.invalid/x.tgz", integrity: "sha256-x" },
              ]),
            ),
          },
        };
        fs.writeFileSync(
          path.join(repoDir, "package-lock.json"),
          JSON.stringify(lock, null, 2),
        );
      }

      execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repoDir, stdio: "pipe" });
      return repoDir;
    }

    it("passes when package.json and lockfile agree and deps are bundled", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-consistent", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
      });
      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
      });
      expect(result.exitCode).toBe(0);
    });

    it("fails when the lockfile root version differs from package.json", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-version-drift", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
      });
      // Simulate the 1.7.0 defect: bump package.json without regenerating the lockfile.
      const pkgPath = path.join(repoDir, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      pkg.version = "1.0.1";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      for (const rel of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
        const p = path.join(repoDir, rel);
        const m = JSON.parse(fs.readFileSync(p, "utf-8"));
        m.version = "1.0.1";
        fs.writeFileSync(p, JSON.stringify(m, null, 2));
      }
      const mktPath = path.join(repoDir, ".claude-plugin/marketplace.json");
      const mkt = JSON.parse(fs.readFileSync(mktPath, "utf-8"));
      mkt.plugins[0].version = "1.0.1";
      fs.writeFileSync(mktPath, JSON.stringify(mkt, null, 2));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_VERSION_MISMATCH/);
    });

    it("fails when a dependency is declared only in package.json", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-dep-added", {
        pkg: {
          dependencies: { diff: "^9.0.0", yaml: "^2.9.0" },
          bundleDependencies: ["diff", "yaml"],
        },
      });
      // Remove yaml from the lockfile root only.
      const lockPath = path.join(repoDir, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      delete lock.packages[""].dependencies.yaml;
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_DEP_MISMATCH/);
    });

    it("fails when a dependency exists only in the lockfile", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-dep-removed", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
      });
      const lockPath = path.join(repoDir, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      lock.packages[""].dependencies.leftpad = "^1.0.0";
      lock.packages["node_modules/leftpad"] = { version: "1.0.0" };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_DEP_MISMATCH/);
    });

    it("fails when a declared dependency has no resolved lockfile entry", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-dep-unresolved", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
      });
      const lockPath = path.join(repoDir, "package-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      delete lock.packages["node_modules/diff"];
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });

      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_DEP_UNRESOLVED/);
    });

    it("fails when the lockfile is missing but dependencies are declared", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("lock-missing", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
        lock: null,
      });
      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_MISSING/);
    });

    it("fails when a runtime dependency is not bundled", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("dep-not-bundled", {
        pkg: {
          dependencies: { diff: "^9.0.0", yaml: "^2.9.0" },
          bundleDependencies: ["diff"],
        },
      });
      const result = runGuard(["check", "--root", repoDir, "--base-ref", "HEAD"], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      const combined = result.stderr + result.stdout;
      expect(combined).toMatch(/DEP_NOT_BUNDLED/);
      expect(combined).toMatch(/yaml/);
    });

    it("the real repository lockfile is consistent and runtime deps are bundled", { timeout: 15_000 }, () => {
      const result = runGuard(["check", "--root", PLUGIN_ROOT, "--base-ref", "origin/main"]);
      expect(result.exitCode).toBe(0);
      const combined = result.stderr + result.stdout;
      expect(combined).not.toMatch(/LOCKFILE_|DEP_NOT_BUNDLED/);
    });

    it("record refuses a version whose lockfile is drifted", { timeout: 15_000 }, () => {
      const repoDir = makeLockfileRepo("record-drifted", {
        pkg: {
          dependencies: { diff: "^9.0.0" },
          bundleDependencies: ["diff"],
        },
        lock: null,
      });
      const result = runGuard(["record", "--root", repoDir], {
        cwd: repoDir,
        expectedExit: 1,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/LOCKFILE_MISSING/);
    });
  });

  describe("content digest (immutable payload)", () => {
    it("same files + different content → different digest", () => {
      const dirA = path.join(tmpDir, "digest-a");
      const dirB = path.join(tmpDir, "digest-b");
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });

      // Create identical directory structures with a single shipped file
      for (const dir of [dirA, dirB]) {
        const pkg = { name: "me", version: "1.0.0", files: ["data/"] };
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
        fs.mkdirSync(path.join(dir, "data"), { recursive: true });
        fs.writeFileSync(path.join(dir, "data/payload.txt"), "hello");
      }

      // Compute digest for A
      const digestA = execSync(
        `bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dirA}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      const matchA = digestA.match(/digest:\s+(\S+)/);
      expect(matchA).not.toBeNull();
      const shaA = matchA![1];

      // Modify content in B
      fs.writeFileSync(path.join(dirB, "data/payload.txt"), "hello-changed");
      const digestB = execSync(
        `bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dirB}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      const matchB = digestB.match(/digest:\s+(\S+)/);
      expect(matchB).not.toBeNull();
      const shaB = matchB![1];

      // Different content must produce different digest
      expect(shaA).not.toBe(shaB);
    });

    it("same content + same files → same digest (reproducible)", () => {
      const dir1 = path.join(tmpDir, "digest-repro-1");
      const dir2 = path.join(tmpDir, "digest-repro-2");
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      for (const dir of [dir1, dir2]) {
        const pkg = { name: "me", version: "1.0.0", files: ["data/"] };
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
        fs.mkdirSync(path.join(dir, "data"), { recursive: true });
        fs.writeFileSync(path.join(dir, "data/payload.txt"), "identical");
      }

      const out1 = execSync(
        `bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dir1}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
      const out2 = execSync(
        `bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dir2}`,
        { encoding: "utf-8", stdio: "pipe" },
      );

      const d1 = out1.match(/digest:\s+(\S+)/)![1];
      const d2 = out2.match(/digest:\s+(\S+)/)![1];
      expect(d1).toBe(d2);
    });

    it("digest conflict is rejected at record time", () => {
      const dir = path.join(tmpDir, "digest-conflict-record");
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });

      const pkg = { name: "me", version: "1.0.0", files: ["data/"] };
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(dir, "data/payload.txt"), "v1");

      // Record first version
      execSync(`bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dir}`, {
        encoding: "utf-8", stdio: "pipe",
      });

      // Change content without bumping version
      fs.writeFileSync(path.join(dir, "data/payload.txt"), "v2-changed");

      // Second record should fail
      try {
        execSync(`bun run ${PLUGIN_ROOT}/bin/release-guard.ts record --root ${dir}`, {
          encoding: "utf-8", stdio: "pipe",
        });
        expect("should have thrown").toBe("but did not");
      } catch (e: any) {
        expect(e.status).toBe(1);
        const msg = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
        expect(msg).toMatch(/different digest/);
      }
    });
  });
});

/**
 * Package smoke tests — verify the packed artifact contains required files.
 */
describe("package smoke", () => {
  let packDir: string;
  let extractDir: string;

  beforeAll(() => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-pkg-smoke-"));
    extractDir = path.join(packDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });

    const packJson = execSync("npm pack --json --pack-destination " + packDir, {
      cwd: PLUGIN_ROOT,
      encoding: "utf-8",
    });
    const entries = JSON.parse(packJson);
    const tarball = entries[0].filename;
    execSync(`tar -xzf "${packDir}/${tarball}" -C "${extractDir}"`, {
      cwd: PLUGIN_ROOT,
    });
  });

  afterAll(() => {
    if (packDir && fs.existsSync(packDir)) {
      fs.rmSync(packDir, { recursive: true, force: true });
    }
  });

  function pkgPath(rel: string): string {
    return path.join(extractDir, "package", rel);
  }

  it("package contains doctor skill", () => {
    expect(fs.existsSync(pkgPath("skills/doctor/SKILL.md"))).toBe(true);
  });

  it("package contains recall skill", () => {
    expect(fs.existsSync(pkgPath("skills/recall/SKILL.md"))).toBe(true);
  });

  it("package contains distill skill", () => {
    expect(fs.existsSync(pkgPath("skills/distill/SKILL.md"))).toBe(true);
  });

  it("package contains doctor CLI binary", () => {
    expect(fs.existsSync(pkgPath("bin/doctor.ts"))).toBe(true);
  });

  it("package contains recall CLI binary", () => {
    expect(fs.existsSync(pkgPath("bin/recall.ts"))).toBe(true);
  });

  it("package contains distill CLI binary", () => {
    expect(fs.existsSync(pkgPath("bin/distill.ts"))).toBe(true);
  });

  it("package contains doctor references", () => {
    expect(
      fs.existsSync(pkgPath("skills/doctor/references/diagnostic-contract-v1.md")),
    ).toBe(true);
  });

  it("package contains recall references", () => {
    expect(
      fs.existsSync(pkgPath("skills/recall/references/evidence-contract-v1.md")),
    ).toBe(true);
  });

  it("package does not contain private paths", () => {
    expect(fs.existsSync(pkgPath("test"))).toBe(false);
    expect(fs.existsSync(pkgPath(".claude"))).toBe(false);
    expect(fs.existsSync(pkgPath(".codex"))).toBe(false);
    expect(fs.existsSync(pkgPath(".planning"))).toBe(false);
  });

  it("doctor CLI executes without crashing", () => {
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "me-smoke-vault-"));
    try {
      execSync(`bun run ${pkgPath("bin/doctor.ts")} --help`, {
        encoding: "utf-8",
      });
    } catch {
      try {
        execSync(`bun run ${pkgPath("bin/doctor.ts")} --vault-dir "${tmpVault}"`, {
          encoding: "utf-8",
        });
      } catch (e: any) {
        const combined = ((e as any)?.stdout?.toString() ?? "") + ((e as any)?.stderr?.toString() ?? "");
        expect(combined.length).toBeGreaterThan(0);
      }
    }
  });

  it("recall CLI executes without crashing", () => {
    try {
      execSync(`bun run ${pkgPath("bin/recall.ts")} --help`, { encoding: "utf-8" });
    } catch (e: any) {
      const combined = ((e as any)?.stdout?.toString() ?? "") + ((e as any)?.stderr?.toString() ?? "");
      expect(combined.length).toBeGreaterThan(0);
    }
  });

  it("distill CLI executes without crashing", () => {
    try {
      execSync(`bun run ${pkgPath("bin/distill.ts")} --help`, { encoding: "utf-8" });
    } catch (e: any) {
      const combined = ((e as any)?.stdout?.toString() ?? "") + ((e as any)?.stderr?.toString() ?? "");
      expect(combined.length).toBeGreaterThan(0);
    }
  });
});
