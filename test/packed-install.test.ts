import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");

/**
 * Packed-install tests (Issue #18).
 *
 * These tests model a marketplace-style installation: the exact npm release
 * artifact is packed, extracted into an empty directory with NO inherited
 * node_modules, and the shipped CLIs are executed from the installed
 * artifact — never from the source checkout.
 *
 * Isolation contract:
 *   - The install root lives under os.tmpdir(), outside PLUGIN_ROOT, so no
 *     parent directory contributes a node_modules.
 *   - bun runs with `--no-install` and an empty BUN_INSTALL_CACHE_DIR, so
 *     missing dependencies fail deterministically instead of being fetched
 *     from the network or a machine-global cache.
 *   - The install root path contains spaces and Unicode, mirroring real
 *     plugin cache paths.
 */

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe("packed install", () => {
  let packDir: string;
  let installRoot: string;
  let installedPkg: string;
  let emptyCwd: string;
  let bunCache: string;

  beforeAll(() => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "me-packed-install-"));
    // Marketplace-like install root: spaces + Unicode in the path.
    installRoot = path.join(packDir, "plugin cache 中文 𐍈");
    fs.mkdirSync(installRoot, { recursive: true });
    // Empty working directory for CLI invocations — proves the artifact does
    // not depend on cwd-adjacent files.
    emptyCwd = path.join(packDir, "empty-cwd");
    fs.mkdirSync(emptyCwd, { recursive: true });
    // Empty bun module cache — no machine-global dependency resolution.
    bunCache = path.join(packDir, "bun-cache");
    fs.mkdirSync(bunCache, { recursive: true });

    const packJson = execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", packDir],
      { cwd: PLUGIN_ROOT, encoding: "utf-8" },
    );
    const entries = JSON.parse(packJson);
    const tarball = entries[0].filename;
    execFileSync("tar", ["-xzf", path.join(packDir, tarball), "-C", installRoot]);
    installedPkg = path.join(installRoot, "package");
  });

  afterAll(() => {
    if (packDir && fs.existsSync(packDir)) {
      fs.rmSync(packDir, { recursive: true, force: true });
    }
  });

  /**
   * Run a shipped CLI from the installed artifact with full dependency
   * isolation: no auto-install, empty module cache, empty cwd.
   */
  function runInstalledCli(relBin: string, args: string[]): CliResult {
    try {
      const stdout = execFileSync(
        "bun",
        ["--no-install", "run", path.join(installedPkg, relBin), ...args],
        {
          cwd: emptyCwd,
          encoding: "utf-8",
          stdio: "pipe",
          env: { ...process.env, BUN_INSTALL_CACHE_DIR: bunCache },
        },
      );
      return { exitCode: 0, stdout, stderr: "" };
    } catch (e: any) {
      return {
        exitCode: e?.status ?? 1,
        stdout: e?.stdout?.toString() ?? "",
        stderr: e?.stderr?.toString() ?? "",
      };
    }
  }

  /** Module-resolution failures are the defect class this file guards. */
  function expectNoResolutionError(result: CliResult): void {
    const combined = result.stdout + result.stderr;
    expect(combined).not.toMatch(/Cannot find package/);
    expect(combined).not.toMatch(/Cannot find module/);
  }

  it("install root path contains spaces and Unicode (fixture sanity)", () => {
    expect(installRoot).toMatch(/ /);
    // eslint-disable-next-line no-control-regex
    expect(installRoot).toMatch(/[^\x00-\x7F]/);
    expect(fs.existsSync(installedPkg)).toBe(true);
  });

  it("does not resolve from the source checkout", () => {
    // The installed artifact must live outside the source tree, so none of
    // the repository's own node_modules can leak into resolution.
    expect(installedPkg.startsWith(PLUGIN_ROOT)).toBe(false);
  });

  it("bundles runtime dependencies inside the packed artifact", () => {
    // bundleDependencies must hydrate node_modules in the tarball itself —
    // marketplace-style installs never run a package manager.
    expect(fs.existsSync(path.join(installedPkg, "node_modules/diff/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedPkg, "node_modules/yaml/package.json"))).toBe(true);
  });

  it("installed package.json version matches the source checkout", () => {
    const src = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf-8"));
    const inst = JSON.parse(fs.readFileSync(path.join(installedPkg, "package.json"), "utf-8"));
    expect(inst.name).toBe(src.name);
    expect(inst.version).toBe(src.version);
  });

  it("me:update CLI runs from the installed artifact", () => {
    // No arguments → structured INVALID_REQUEST JSON, not a crash.
    const result = runInstalledCli("bin/update.ts", []);
    expectNoResolutionError(result);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.error?.code).toBe("INVALID_REQUEST");
  });

  it("me:doctor CLI runs from the installed artifact", () => {
    const result = runInstalledCli("bin/doctor.ts", ["--help"]);
    expectNoResolutionError(result);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
  });

  it("me:recall CLI runs from the installed artifact", () => {
    const result = runInstalledCli("bin/recall.ts", ["--help"]);
    expectNoResolutionError(result);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
  });

  it("me:brief CLI runs from the installed artifact", () => {
    const result = runInstalledCli("bin/brief.ts", ["--help"]);
    expectNoResolutionError(result);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
  });

  it("me:distill CLI runs from the installed artifact", () => {
    const result = runInstalledCli("bin/distill.ts", ["--help"]);
    expectNoResolutionError(result);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
  });

  it("fails deterministically when bundled dependencies are removed (no parent-dir leak)", () => {
    // Negative control: strip the bundled node_modules from the installed
    // artifact and prove the CLI can no longer resolve its runtime
    // dependencies. If resolution leaked from a parent directory or a
    // machine-global cache, this test would silently keep passing.
    const bundled = path.join(installedPkg, "node_modules");
    const stashed = path.join(installedPkg, "node_modules.stashed");
    fs.renameSync(bundled, stashed);
    try {
      const result = runInstalledCli("bin/update.ts", []);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Cannot find package/);
    } finally {
      fs.renameSync(stashed, bundled);
    }
  });

  it("packed artifact does not ship the lockfile exemption paths", () => {
    // node_modules must contain ONLY the bundled runtime deps — never the
    // dev toolchain (typescript, @types/node).
    const bundled = fs.readdirSync(path.join(installedPkg, "node_modules")).sort();
    expect(bundled).toEqual(["diff", "yaml"]);
    // The npm tarball never carries package-lock.json; hydration for
    // marketplace installs is the bundle, not a post-install npm ci.
    expect(fs.existsSync(path.join(installedPkg, "package-lock.json"))).toBe(false);
  });
});
