#!/usr/bin/env bun
/**
 * Release guard — enforces immutable package version invariants.
 *
 * Subcommands:
 *   check        Main CI guard: verify all guards against a base ref.
 *   check-affected  List which monitored paths are package-affecting.
 *   record       Record the current version's package content digest.
 *
 * Invariants enforced:
 *   1. All version-bearing manifests agree.
 *   2. Package-affecting changes without a version bump fail CI.
 *   3. A recorded version→digest mapping is never overwritten with
 *      a different payload.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

// ── Configuration ──────────────────────────────────────────────────

interface VersionSource {
  /** Relative path from plugin root. */
  path: string;
  /** JSON path segments to the version string. */
  jsonPath: string[];
}

const VERSION_SOURCES: VersionSource[] = [
  { path: "package.json", jsonPath: ["version"] },
  { path: ".claude-plugin/plugin.json", jsonPath: ["version"] },
  { path: ".claude-plugin/marketplace.json", jsonPath: ["plugins", "0", "version"] },
  { path: ".codex-plugin/plugin.json", jsonPath: ["version"] },
];

/**
 * Paths whose changes are considered package-affecting.
 *
 * Changes under any of these require a version bump.
 * Order: broad globs first, then specific files.
 */
const PACKAGE_AFFECTING_PATTERNS: { pattern: string; label: string }[] = [
  { pattern: "skills/", label: "skills (runtime Skills)" },
  { pattern: "bin/", label: "bin/ (CLI runtime)" },
  { pattern: "templates/", label: "templates/ (shipped templates)" },
  { pattern: ".claude-plugin/", label: "plugin manifest (Claude Code)" },
  { pattern: ".codex-plugin/", label: "plugin manifest (Codex)" },
  { pattern: ".agents/plugins/", label: "marketplace configuration" },
  { pattern: "package.json", label: "package metadata / dependencies" },
  { pattern: "references/", label: "references/ (shipped references)" },
];

/**
 * Paths explicitly exempt from version-bump requirements.
 *
 * These change no shipped runtime payload.
 */
const EXEMPT_PATTERNS: string[] = [
  "test/",
  "docs/",
  ".claude/",
  ".codex/",
  ".planning/",
  ".worktrees/",
  ".superpowers/",
  ".gitignore",
  "bunfig.toml",
];

const DIGEST_STORE = ".release-digests.json";

// ── Types ──────────────────────────────────────────────────────────

interface DigestEntry {
  version: string;
  /** SHA-256 of the sorted, newline-joined package file list. */
  fileListDigest: string;
  /** ISO 8601 timestamp when this digest was recorded. */
  recordedAt: string;
  /** Short git commit SHA that produced this digest. */
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
  // __dirname is the directory containing this script (bin/).
  // The plugin root is the parent of bin/.
  return path.resolve(__dirname, "..");
}

function readVersion(root: string, src: VersionSource): string | null {
  const fullPath = path.join(root, src.path);
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

function detectChangedFiles(root: string, baseRef: string): string[] {
  try {
    // Use git diff to get changed files
    const output = execSync(
      `git diff --name-only ${baseRef}...HEAD`,
      { cwd: root, encoding: "utf-8", stdio: "pipe" },
    ).trim();

    // Also check for uncommitted changes (staged + unstaged)
    const stagedOutput = execSync(
      "git diff --name-only --cached",
      { cwd: root, encoding: "utf-8", stdio: "pipe" },
    ).trim();

    const allFiles = new Set<string>();
    for (const f of output.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) allFiles.add(trimmed);
    }
    for (const f of stagedOutput.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) allFiles.add(trimmed);
    }
    return [...allFiles];
  } catch {
    // If git isn't available or there's no base ref, return empty
    return [];
  }
}

function isPackageAffecting(filePath: string): {
  affected: boolean;
  pattern: string;
  label: string;
} | null {
  // Check exemptions first
  for (const exempt of EXEMPT_PATTERNS) {
    if (filePath.startsWith(exempt)) return null;
  }

  // Root-level markdown files (except templates and plugin manifests)
  // are documentation, not package-affecting
  const rootMdPattern = /^(?!templates\/|skills\/)([A-Za-z].*\.md$)/;
  if (rootMdPattern.test(filePath)) return null;

  // Check package-affecting patterns
  for (const { pattern, label } of PACKAGE_AFFECTING_PATTERNS) {
    if (filePath.startsWith(pattern)) {
      return { affected: true, pattern, label };
    }
  }

  return null;
}

function computePackageFileListDigest(root: string): string {
  // Use npm pack --dry-run to get the exact file list
  let packedFiles: string[];
  try {
    const output = execSync(
      "npm pack --dry-run --json",
      { cwd: root, encoding: "utf-8", stdio: "pipe" },
    );
    // npm pack --dry-run --json outputs an array of {id, name, version, filename, files}
    const entries = JSON.parse(output);
    if (Array.isArray(entries) && entries.length > 0 && entries[0].files) {
      packedFiles = entries[0].files.map((f: { path: string }) => f.path).sort();
    } else {
      // Fallback: manually build the file list from package.json "files"
      packedFiles = buildFileListFromManifest(root);
    }
  } catch {
    packedFiles = buildFileListFromManifest(root);
  }

  // Compute stable digest
  const joined = packedFiles.join("\n");
  return crypto.createHash("sha256").update(joined).digest("hex");
}

function buildFileListFromManifest(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const files: string[] = pkg.files ?? [];

  // Expand each entry
  const result: string[] = [];
  for (const entry of files) {
    const fullPath = path.join(root, entry);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        result.push(entry);
      } else if (stat.isDirectory()) {
        collectFiles(fullPath, entry, result);
      }
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

function currentCommitSha(root: string): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: root,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
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
    entries.push({ path: src.path, version });
    if (version === null) {
      findings.push({
        severity: "error",
        code: "VERSION_MISSING",
        message: `Missing or unreadable version in ${src.path}`,
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
 */
function guardVersionBumpedOnChange(
  root: string,
  baseRef: string,
): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const changedFiles = detectChangedFiles(root, baseRef);

  if (changedFiles.length === 0) {
    // No changes detected relative to base — nothing to check
    return findings;
  }

  const affectedFiles: { file: string; label: string }[] = [];
  for (const file of changedFiles) {
    const result = isPackageAffecting(file);
    if (result) {
      affectedFiles.push({ file, label: result.label });
    }
  }

  if (affectedFiles.length === 0) {
    // No package-affecting changes — version bump not required
    return findings;
  }

  // Check if the version actually changed relative to base
  const currentVersion = readVersion(root, VERSION_SOURCES[0]); // package.json version
  let baseVersion: string | null = null;

  try {
    const basePkgJson = execSync(
      `git show ${baseRef}:package.json`,
      { cwd: root, encoding: "utf-8", stdio: "pipe" },
    );
    const basePkg = JSON.parse(basePkgJson);
    baseVersion = basePkg.version ?? null;
  } catch {
    // Can't read base version — can't verify bump
    findings.push({
      severity: "warning",
      code: "BASE_VERSION_UNREADABLE",
      message: `Cannot read version from ${baseRef}:package.json — unable to verify bump.`,
    });
    return findings;
  }

  if (currentVersion === baseVersion) {
    const detail = affectedFiles
      .map((f) => `  ${f.file} (${f.label})`)
      .join("\n");
    findings.push({
      severity: "error",
      code: "VERSION_NOT_BUMPED",
      message:
        `Package-affecting changes detected but version remains at ${currentVersion}:\n${detail}\n\n` +
        `Either bump the version (currently ${currentVersion}), or add an explicit exemption ` +
        `if these changes truly affect no shipped runtime payload.`,
    });
  }

  return findings;
}

/**
 * Check 3: A recorded version→digest mapping must not be overwritten.
 *
 * This checks the local digest store at CI time, not the remote registry.
 */
function guardDigestImmutable(root: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const currentVersion = readVersion(root, VERSION_SOURCES[0]);
  if (!currentVersion) return findings;

  const currentDigest = computePackageFileListDigest(root);
  const store = readDigestStore(root);

  for (const entry of store.entries) {
    if (entry.version === currentVersion) {
      if (entry.fileListDigest !== currentDigest) {
        findings.push({
          severity: "error",
          code: "DIGEST_CONFLICT",
          message:
            `Version ${currentVersion} was previously recorded with digest ${entry.fileListDigest.slice(0, 16)}… ` +
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

  console.log("✓  Release guard PASSED");
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

  console.log("Package-affecting path patterns:");
  for (const { pattern, label } of PACKAGE_AFFECTING_PATTERNS) {
    console.log(`  ${pattern.padEnd(32)} ${label}`);
  }
  console.log("\nExempt path patterns:");
  for (const exempt of EXEMPT_PATTERNS) {
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

  const digest = computePackageFileListDigest(root);
  const sha = currentCommitSha(root);
  const store = readDigestStore(root);

  // Check for existing entry with same version
  const existing = store.entries.find((e) => e.version === version);
  if (existing) {
    if (existing.fileListDigest !== digest) {
      console.error(
        `✗  Version ${version} already recorded with different digest.\n` +
          `   Existing: ${existing.fileListDigest.slice(0, 16)}… (${existing.commitSha})\n` +
          `   Current:  ${digest.slice(0, 16)}… (${sha})\n` +
          `   Bump the version first.`,
      );
      process.exit(1);
    }
    console.log(`✓  Version ${version} digest unchanged — already recorded.`);
    console.log(`   digest: ${digest}`);
    process.exit(0);
  }

  const entry: DigestEntry = {
    version,
    fileListDigest: digest,
    recordedAt: new Date().toISOString(),
    commitSha: sha,
  };

  store.entries.push(entry);
  writeDigestStore(root, store);

  console.log(`✓  Recorded package digest for version ${version}`);
  console.log(`   digest:    ${digest}`);
  console.log(`   commit:    ${sha}`);
  console.log(`   stored in: ${DIGEST_STORE}`);
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────

const [_bun, _script, subcommand, ...rest] = process.argv;

function usage(): never {
  console.error(`Usage: release-guard.ts <subcommand> [options]

Subcommands:
  check          Run all release guards (for CI)
  check-affected List package-affecting path patterns
  record         Record the current version's package digest

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
