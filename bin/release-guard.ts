#!/usr/bin/env bun
/**
 * Release guard — enforces immutable package version invariants.
 *
 * Subcommands:
 *   check          Main CI guard: verify all guards against a base ref.
 *   check-affected List which monitored paths are package-affecting.
 *   record         Record the current version's package content digest.
 *
 * Invariants enforced:
 *   1. All version-bearing manifests agree.
 *   2. Package-affecting changes without a version bump fail CI.
 *      Package-affecting = any path that appears in 'npm pack'.
 *   3. A recorded version→content-digest mapping is never overwritten
 *      with a different payload (paths + file contents hashed, not just
 *      file names).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ── Configuration ──────────────────────────────────────────────────

interface VersionSource {
  /** Relative path from plugin root. */
  relPath: string;
  /** JSON path segments to the version string. */
  jsonPath: string[];
}

const VERSION_SOURCES: VersionSource[] = [
  { relPath: "package.json", jsonPath: ["version"] },
  { relPath: ".claude-plugin/plugin.json", jsonPath: ["version"] },
  { relPath: ".claude-plugin/marketplace.json", jsonPath: ["plugins", "0", "version"] },
  { relPath: ".codex-plugin/plugin.json", jsonPath: ["version"] },
];

/**
 * Paths whose changes do NOT require a version bump.
 *
 * These paths never appear in the npm package.  The packlist
 * (computed from `package.json#files`) is the ground truth for
 * what is package-affecting — everything else is exempt.
 *
 * CAUTION: keep this list in sync with `.gitignore` and
 * `package.json#files`.  A path listed here that later enters
 * the packlist will silently undermine guard 2.
 */
const NON_PACKAGE_PATHS: string[] = [
  "test/",
  ".claude/",
  ".codex/",
  ".planning/",
  ".worktrees/",
  ".superpowers/",
  ".gitignore",
  "bunfig.toml",
  "node_modules/",
  "package-lock.json",
];

const DIGEST_STORE = ".release-digests.json";

// ── Types ──────────────────────────────────────────────────────────

interface DigestEntry {
  version: string;
  /** SHA-256 of `path:sha256(content)` per packed file, joined with newlines. */
  contentDigest: string;
  /** ISO 8601 timestamp when this digest was recorded. */
  recordedAt: string;
  /** Short git commit SHA of the tree that produced this digest.
   *  `"(working-tree)"` when the working tree is dirty. */
  commitSha: string;
}

interface ReleaseDigests {
  entries: DigestEntry[];
}

interface GuardFinding {
  severity: "error" | "warning";
  code: string;
  message: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function pluginRoot(argvRoot?: string): string {
  if (argvRoot) return path.resolve(argvRoot);
  return path.resolve(__dirname, "..");
}

function readVersion(root: string, src: VersionSource): string | null {
  const fullPath = path.join(root, src.relPath);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    let value: unknown = content;
    for (const seg of src.jsonPath) {
      const idx = parseInt(seg, 10);
      if (Number.isNaN(idx)) {
        if (typeof value !== "object" || value === null) return null;
        value = (value as Record<string, unknown>)[seg];
      } else {
        if (!Array.isArray(value)) return null;
        value = value[idx];
      }
    }
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Validate that a git ref looks safe to pass to git commands.
 * Rejects refs containing shell metacharacters.
 */
function validateRef(ref: string): void {
  if (/[\s|&;<>`$(){}\[\]*?#~!\\'"]/.test(ref)) {
    throw new Error(`Unsafe git ref: ${JSON.stringify(ref)}`);
  }
}

/**
 * Run git and return trimmed stdout.  Fails closed — any git error
 * is surfaced, not silently swallowed.
 */
function git(args: string[], opts: { cwd: string }): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Detect files changed relative to baseRef (plus any staged changes).
 * Fails closed — git errors propagate as exceptions.
 */
function detectChangedFiles(root: string, baseRef: string): string[] {
  validateRef(baseRef);

  const allFiles = new Set<string>();

  // Changed files relative to base
  const diffOut = git(
    ["diff", "--name-only", `${baseRef}...HEAD`],
    { cwd: root },
  );
  for (const f of diffOut.split("\n")) {
    const trimmed = f.trim();
    if (trimmed) allFiles.add(trimmed);
  }

  // Staged changes (for pre-commit or CI on merge-commit runs)
  try {
    const stagedOut = git(
      ["diff", "--name-only", "--cached"],
      { cwd: root },
    );
    for (const f of stagedOut.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) allFiles.add(trimmed);
    }
  } catch {
    // Not fatal — no staged changes or not a git repo edge case
  }

  return [...allFiles];
}

/**
 * Build the ordered set of relative paths that would be packed by npm.
 * This is the ground truth for "package-affecting".
 */
function computePacklist(root: string): string[] {
  try {
    const output = execFileSync(
      "npm", ["pack", "--dry-run", "--json"],
      { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const entries = JSON.parse(output);
    if (Array.isArray(entries) && entries.length > 0 && entries[0].files) {
      return entries[0].files
        .map((f: { path: string }) => f.path)
        .sort();
    }
  } catch {
    // Fall through to manifest-based expansion
  }

  // Fallback: expand `package.json#files`
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const patterns: string[] = pkg.files ?? [];
  const result: string[] = [];
  for (const entry of patterns) {
    const fullPath = path.join(root, entry);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      result.push(entry);
    } else if (stat.isDirectory()) {
      collectFiles(fullPath, entry, result);
    }
  }
  return result.sort();
}

function collectFiles(dir: string, prefix: string, result: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + "/" + entry.name;
    if (entry.isFile()) {
      result.push(rel);
    } else if (entry.isDirectory()) {
      collectFiles(path.join(dir, entry.name), rel, result);
    }
  }
}

/**
 * Is a changed file package-affecting?
 *
 * Uses the actual npm packlist as ground truth, not a separate
 * hardcoded list that can drift from `package.json#files`.
 */
function isPackageAffecting(
  filePath: string,
  packlist: Set<string>,
): boolean {
  // Check non-package paths first (fast exclusion)
  for (const exempt of NON_PACKAGE_PATHS) {
    if (filePath.startsWith(exempt)) return false;
  }

  // Check against the packlist
  // A path is package-affecting if it IS in the packlist, OR
  // it's a parent directory that contributes files to the packlist.
  if (packlist.has(filePath)) return true;

  // Directory changes: any file whose path starts with `${filePath}/`
  // that is in the packlist means this directory is package-affecting.
  const dirPrefix = filePath.endsWith("/") ? filePath : filePath + "/";
  for (const p of packlist) {
    if (p.startsWith(dirPrefix)) return true;
  }

  return false;
}

/**
 * Compute a content digest over the actual packed files.
 *
 * For each file in the packlist: read bytes, compute SHA-256,
 * then hash `relPath:fileSha256` joined with newlines.
 *
 * This ensures ANY byte change in ANY shipped file produces a
 * different digest.
 */
function computePackageContentDigest(root: string): string {
  const packlist = computePacklist(root);

  const entries: string[] = [];
  for (const relPath of packlist) {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) {
      // File in manifest but missing on disk — still part of the digest
      entries.push(`${relPath}:sha256:MISSING`);
      continue;
    }
    try {
      const bytes = fs.readFileSync(fullPath);
      const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
      entries.push(`${relPath}:sha256:${fileHash}`);
    } catch {
      entries.push(`${relPath}:sha256:UNREADABLE`);
    }
  }

  const joined = entries.join("\n");
  return crypto.createHash("sha256").update(joined).digest("hex");
}

function readDigestStore(root: string): ReleaseDigests {
  const storePath = path.join(root, DIGEST_STORE);
  if (!fs.existsSync(storePath)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch {
    return { entries: [] };
  }
}

function writeDigestStore(root: string, store: ReleaseDigests): void {
  const storePath = path.join(root, DIGEST_STORE);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/**
 * Detect whether the working tree is dirty (uncommitted changes).
 */
function isWorkingTreeDirty(root: string): boolean {
  try {
    // -uno excludes untracked files (e.g. bun.lock) which don't
    // affect the packaged content.
    const status = git(["status", "--porcelain", "-uno"], { cwd: root });
    return status.length > 0;
  } catch {
    return false;
  }
}

function currentCommitLabel(root: string): string {
  if (isWorkingTreeDirty(root)) return "(working-tree)";
  try {
    return git(["rev-parse", "--short", "HEAD"], { cwd: root });
  } catch {
    return "unknown";
  }
}

// ── Guard checks ───────────────────────────────────────────────────

/**
 * Check 1: All version-bearing manifests must agree.
 */
function guardVersionsAgree(root: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const entries: { path: string; version: string | null }[] = [];

  for (const src of VERSION_SOURCES) {
    const version = readVersion(root, src);
    entries.push({ path: src.relPath, version });
    if (version === null) {
      findings.push({
        severity: "error",
        code: "VERSION_MISSING",
        message: `Missing or unreadable version in ${src.relPath}`,
      });
    }
  }

  const validVersions = entries
    .filter((e) => e.version !== null)
    .map((e) => e.version!);
  const unique = [...new Set(validVersions)];

  if (unique.length > 1) {
    const detail = entries
      .map((e) => `  ${e.path}: ${e.version ?? "MISSING"}`)
      .join("\n");
    findings.push({
      severity: "error",
      code: "VERSION_MISMATCH",
      message: `Authoritative manifests disagree on version:\n${detail}`,
    });
  }

  return findings;
}

/**
 * Check 2: Package-affecting changes without a version bump fail CI.
 *
 * Uses the npm packlist as ground truth for "package-affecting".
 * Fails closed: unreadable base ref is an error.
 */
function guardVersionBumpedOnChange(
  root: string,
  baseRef: string,
): GuardFinding[] {
  const findings: GuardFinding[] = [];

  let changedFiles: string[];
  try {
    changedFiles = detectChangedFiles(root, baseRef);
  } catch (e: any) {
    findings.push({
      severity: "error",
      code: "GIT_ERROR",
      message:
        `Cannot detect changed files relative to '${baseRef}': ${e.message}. ` +
        `Verify the ref exists and git is available.`,
    });
    return findings;
  }

  if (changedFiles.length === 0) {
    return findings;
  }

  const packlist = new Set(computePacklist(root));

  const affectedFiles: { file: string }[] = [];
  for (const file of changedFiles) {
    if (isPackageAffecting(file, packlist)) {
      affectedFiles.push({ file });
    }
  }

  if (affectedFiles.length === 0) {
    return findings;
  }

  const currentVersion = readVersion(root, VERSION_SOURCES[0]);
  let baseVersion: string | null = null;

  try {
    validateRef(baseRef);
    const basePkgJson = git(
      ["show", `${baseRef}:package.json`],
      { cwd: root },
    );
    const basePkg = JSON.parse(basePkgJson);
    baseVersion = basePkg.version ?? null;
  } catch (e: any) {
    findings.push({
      severity: "error",
      code: "BASE_VERSION_UNREADABLE",
      message:
        `Cannot read version from ${baseRef}:package.json: ${e.message}. ` +
        `Cannot verify whether the version was bumped.`,
    });
    return findings;
  }

  if (currentVersion === baseVersion) {
    const detail = affectedFiles.map((f) => `  ${f.file}`).join("\n");
    findings.push({
      severity: "error",
      code: "VERSION_NOT_BUMPED",
      message:
        `Package-affecting changes detected but version remains at ${currentVersion}:\n${detail}\n\n` +
        `These files are in the npm packlist and change the shipped runtime payload. ` +
        `Bump the version (currently ${currentVersion}) to proceed.`,
    });
  }

  return findings;
}

/**
 * Check 3: A recorded version→content-digest mapping must not be overwritten.
 */
function guardDigestImmutable(root: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const currentVersion = readVersion(root, VERSION_SOURCES[0]);
  if (!currentVersion) return findings;

  const currentDigest = computePackageContentDigest(root);
  const store = readDigestStore(root);

  // Backward compat: also check old `fileListDigest` field
  for (const entry of store.entries) {
    if (entry.version === currentVersion) {
      const recordedDigest =
        (entry as any).contentDigest ?? (entry as any).fileListDigest;
      if (recordedDigest && recordedDigest !== currentDigest) {
        findings.push({
          severity: "error",
          code: "DIGEST_CONFLICT",
          message:
            `Version ${currentVersion} was previously recorded with digest ${recordedDigest.slice(0, 16)}… ` +
            `(commit ${entry.commitSha}, ${entry.recordedAt}) but the current package has digest ` +
            `${currentDigest.slice(0, 16)}…. The same version must identify exactly one immutable package payload. ` +
            `Bump the version to resolve.`,
        });
      }
      break;
    }
  }

  return findings;
}

// ── Subcommands ────────────────────────────────────────────────────

function cmdCheck(args: string[]): never {
  let root = "";
  let baseRef = "origin/main";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = args[++i];
    } else if (args[i] === "--base-ref" && i + 1 < args.length) {
      baseRef = args[++i];
    }
  }

  root = pluginRoot(root || undefined);

  const findings: GuardFinding[] = [
    ...guardVersionsAgree(root),
    ...guardVersionBumpedOnChange(root, baseRef),
    ...guardDigestImmutable(root),
  ];

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  if (warnings.length > 0) {
    console.error("⚠  Warnings:");
    for (const w of warnings) {
      console.error(`   [${w.code}] ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error("✗  Release guard FAILED:");
    for (const e of errors) {
      console.error(`   [${e.code}] ${e.message}`);
    }
    console.error(
      `\n${errors.length} error(s), ${warnings.length} warning(s). ` +
        "Fix the errors above before merging.",
    );
    process.exit(1);
  }

  const version = readVersion(root, VERSION_SOURCES[0]);
  console.log(`✓  Release guard PASSED  (version ${version})`);
  console.log(
    `   0 errors, ${warnings.length} warning(s). All invariants hold.`,
  );
  process.exit(0);
}

function cmdCheckAffected(args: string[]): never {
  let root = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = args[++i];
    }
  }
  root = pluginRoot(root || undefined);

  const packlist = computePacklist(root);
  const packSet = new Set(packlist);

  console.log(`Package-affecting path patterns (${packlist.length} files in packlist):`);
  // Show the packlist-derived categories
  const categories = new Map<string, number>();
  for (const p of packlist) {
    const top = p.split("/")[0] + "/";
    categories.set(top, (categories.get(top) ?? 0) + 1);
  }
  for (const [cat, count] of [...categories].sort()) {
    console.log(`  ${cat.padEnd(34)} ${count} file(s)`);
  }

  console.log("\nExempt (non-package) paths:");
  for (const exempt of NON_PACKAGE_PATHS) {
    console.log(`  ${exempt}`);
  }
  process.exit(0);
}

function cmdRecord(args: string[]): never {
  let root = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = args[++i];
    }
  }
  root = pluginRoot(root || undefined);

  const version = readVersion(root, VERSION_SOURCES[0]);
  if (!version) {
    console.error("✗  Cannot read version from package.json");
    process.exit(1);
  }

  const digest = computePackageContentDigest(root);
  const sha = currentCommitLabel(root);
  const dirty = isWorkingTreeDirty(root);
  const store = readDigestStore(root);

  // Check for existing entry with same version
  const existing = store.entries.find((e) => e.version === version);
  if (existing) {
    const existingDigest =
      (existing as any).contentDigest ?? (existing as any).fileListDigest;
    if (existingDigest && existingDigest !== digest) {
      console.error(
        `✗  Version ${version} already recorded with different digest.\n` +
          `   Existing: ${existingDigest.slice(0, 16)}… (${existing.commitSha})\n` +
          `   Current:  ${digest.slice(0, 16)}… (${sha})\n` +
          `   Bump the version first.`,
      );
      process.exit(1);
    }
    // Same digest — update commitSha if it was stale (working-tree)
    if (existing.commitSha === "(working-tree)" && sha !== "(working-tree)") {
      existing.commitSha = sha;
      existing.recordedAt = new Date().toISOString();
      writeDigestStore(root, store);
      console.log(`✓  Version ${version} digest unchanged — updated commitSha to ${sha}.`);
      console.log(`   digest: ${digest}`);
      process.exit(0);
    }
    console.log(`✓  Version ${version} digest unchanged — already recorded.`);
    console.log(`   digest: ${digest}`);
    process.exit(0);
  }

  if (dirty) {
    console.error(
      "⚠  Working tree is dirty. The recorded commitSha will be '(working-tree)'.\n" +
        "   For a clean release audit trail, commit first, then run 'record'.",
    );
  }

  const entry: DigestEntry = {
    version,
    contentDigest: digest,
    recordedAt: new Date().toISOString(),
    commitSha: sha,
  };

  store.entries.push(entry);
  writeDigestStore(root, store);

  console.log(`✓  Recorded content digest for version ${version}`);
  console.log(`   digest:  ${digest}`);
  console.log(`   commit:  ${sha}`);
  console.log(`   stored:  ${DIGEST_STORE}`);
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────

const [_bun, _script, subcommand, ...rest] = process.argv;

function usage(): never {
  console.error(`Usage: release-guard.ts <subcommand> [options]

Subcommands:
  check          Run all release guards (for CI)
  check-affected List package-affecting path patterns (from npm packlist)
  record         Record the current version's content digest

Options:
  --root <path>  Plugin root directory (default: repo root)
  --base-ref     Git ref to compare against (default: origin/main)
`);
  process.exit(2);
}

switch (subcommand) {
  case "check":
    cmdCheck(rest);
    break;
  case "check-affected":
    cmdCheckAffected(rest);
    break;
  case "record":
    cmdRecord(rest);
    break;
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown subcommand: ${subcommand ?? "(none)"}`);
    usage();
}
