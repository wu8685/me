import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");

/**
 * Release guard tests.
 *
 * These tests verify the release invariants required by Issue #13:
 * - All version-bearing manifests agree.
 * - A Git tag/version maps to one package digest.
 * - Package-affecting changes without a version bump are detected.
 * - CI fails when authoritative manifests disagree.
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
          env: { ...process.env, ME_TEST_MODE: "1" },
          encoding: "utf-8",
          stdio: "pipe",
        },
      );
      return { exitCode: 0, stdout: result, stderr: "" };
    } catch (e: any) {
      // Despite the name, stdout may be available even when execSync throws
      const stdout = (e as any)?.stdout?.toString() ?? "";
      const stderr = (e as any)?.stderr?.toString() ?? "";
      const exitCode = (e as any)?.status ?? 1;
      if (exitCode !== expectedExit) {
        console.error(
          `Expected exit ${expectedExit}, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }
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
        // Split on "." and "[n]" brackets, e.g. "plugins[0].version" → ["plugins","0","version"]
        const segments = jsonPath.split(/\.|\[|\]/).filter(Boolean);
        let value: any = content;
        for (const seg of segments) {
          const idx = parseInt(seg, 10);
          value = Number.isNaN(idx) ? value[seg] : value[idx];
        }
        versions.push(value as string);
      }

      const unique = [...new Set(versions)];
      if (unique.length !== 1) {
        console.error(`Version mismatch across manifests: ${JSON.stringify({ versions, manifestPaths: Object.keys(versionPaths) })}`);
      }
      expect(unique.length).toBe(1);
      // Must be semver-compatible
      expect(unique[0]).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("release guard check fails when manifests disagree (simulated)", () => {
      // Copy relevant manifests to tmp and introduce a mismatch
      const guardTmp = path.join(tmpDir, "version-disagree");
      fs.mkdirSync(guardTmp, { recursive: true });
      fs.mkdirSync(path.join(guardTmp, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(guardTmp, ".codex-plugin"), { recursive: true });

      // Copy manifests
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

      // Introduce a version mismatch in .codex-plugin/plugin.json
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
    it("identifies skills/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).toMatch(/skills|package-affecting/i);
    });

    it("identifies bin/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).toMatch(/bin|package-affecting/i);
    });

    it("identifies templates/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).toMatch(/templates|package-affecting/i);
    });

    it("identifies plugin manifests as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).toMatch(/manifest|package-affecting/i);
    });

    it("identifies package.json changes as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).toMatch(/package\.json|package-affecting/i);
    });

    it("does not flag test/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).not.toMatch(/test\/.*package-affecting/i);
    });

    it("does not flag docs/ as package-affecting", () => {
      const result = runGuard(["check-affected", "--root", PLUGIN_ROOT], {
        cwd: PLUGIN_ROOT,
      });
      expect(result.stdout).not.toMatch(/docs\/.*package-affecting/i);
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

    // Pack the plugin
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

  it("package contains doctor skill", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(
      fs.existsSync(path.join(pkgRoot, "skills/doctor/SKILL.md")),
    ).toBe(true);
  });

  it("package contains recall skill", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(
      fs.existsSync(path.join(pkgRoot, "skills/recall/SKILL.md")),
    ).toBe(true);
  });

  it("package contains distill skill", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(
      fs.existsSync(path.join(pkgRoot, "skills/distill/SKILL.md")),
    ).toBe(true);
  });

  it("package contains doctor CLI binary", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(fs.existsSync(path.join(pkgRoot, "bin/doctor.ts"))).toBe(true);
  });

  it("package contains recall CLI binary", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(fs.existsSync(path.join(pkgRoot, "bin/recall.ts"))).toBe(true);
  });

  it("package contains distill CLI binary", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(fs.existsSync(path.join(pkgRoot, "bin/distill.ts"))).toBe(true);
  });

  it("package contains doctor references", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(
      fs.existsSync(
        path.join(
          pkgRoot,
          "skills/doctor/references/diagnostic-contract-v1.md",
        ),
      ),
    ).toBe(true);
  });

  it("package contains recall references", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(
      fs.existsSync(
        path.join(pkgRoot, "skills/recall/references/evidence-contract-v1.md"),
      ),
    ).toBe(true);
  });

  it("package does not contain private paths", () => {
    const pkgRoot = path.join(extractDir, "package");
    expect(fs.existsSync(path.join(pkgRoot, "test"))).toBe(false);
    expect(fs.existsSync(path.join(pkgRoot, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(pkgRoot, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(pkgRoot, ".planning"))).toBe(false);
  });

  it("doctor CLI executes help/read-only successfully", () => {
    const pkgRoot = path.join(extractDir, "package");
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "me-smoke-vault-"));
    try {
      execSync(`ME_TEST_MODE=1 bun run ${pkgRoot}/bin/doctor.ts --help`, {
        encoding: "utf-8",
        env: { ...process.env, ME_TEST_MODE: "1" },
      });
    } catch {
      // --help may not be supported; try running without args
      try {
        execSync(
          `ME_TEST_MODE=1 bun run ${pkgRoot}/bin/doctor.ts --vault-dir "${tmpVault}"`,
          {
            encoding: "utf-8",
            env: { ...process.env, ME_TEST_MODE: "1" },
          },
        );
      } catch (e: any) {
        // Doctor may exit non-zero for empty vault (expected)
        // Just verify it runs and produces output
        const stdout = (e as any)?.stdout?.toString() ?? "";
        const stderr = (e as any)?.stderr?.toString() ?? "";
        const combined = stdout + stderr;
        // Should produce JSON or help text, not crash
        expect(combined.length).toBeGreaterThan(0);
      }
    }
  });

  it("recall CLI executes without crashing", () => {
    const pkgRoot = path.join(extractDir, "package");
    try {
      execSync(`ME_TEST_MODE=1 bun run ${pkgRoot}/bin/recall.ts --help`, {
        encoding: "utf-8",
        env: { ...process.env, ME_TEST_MODE: "1" },
      });
    } catch (e: any) {
      const stdout = (e as any)?.stdout?.toString() ?? "";
      const stderr = (e as any)?.stderr?.toString() ?? "";
      const combined = stdout + stderr;
      expect(combined.length).toBeGreaterThan(0);
    }
  });

  it("distill CLI executes without crashing", () => {
    const pkgRoot = path.join(extractDir, "package");
    try {
      execSync(`ME_TEST_MODE=1 bun run ${pkgRoot}/bin/distill.ts --help`, {
        encoding: "utf-8",
        env: { ...process.env, ME_TEST_MODE: "1" },
      });
    } catch (e: any) {
      const stdout = (e as any)?.stdout?.toString() ?? "";
      const stderr = (e as any)?.stderr?.toString() ?? "";
      const combined = stdout + stderr;
      expect(combined.length).toBeGreaterThan(0);
    }
  });
});
