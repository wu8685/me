#!/usr/bin/env -S bun run

/**
 * me:doctor — strictly read-only diagnostic of the effective ME state.
 *
 * Reports resolved vault/plugin roots, locally available plugin/package/
 * marketplace versions, config validity, schema compatibility, managed Agent
 * surfaces, managed-section integrity, and unfinished runtime lock/journal/
 * recovery state in one versioned JSON report with stable finding codes and
 * severities.
 *
 * Safety: no upgrades/migrations/repair/lock cleanup/writes/staging/commits/
 * pushes; no network; missing runtime directories are never created; not a
 * process monitor.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { VaultWriteRecovery } from './vault-write/contracts';
import { parseLayerConfig } from './vault-write/path-safety';
import {
  RuntimePathError,
  resolveRuntimeLayout,
} from './runtime-paths';

export type FindingSeverity = 'info' | 'warning' | 'error';
export type DoctorReportState = 'healthy' | 'behind' | 'malformed' | 'future-schema';
export type SchemaState = 'current' | 'edited' | 'future' | 'malformed' | 'missing';
export type AgentMode = 'dual' | 'claude-only' | 'codex-only' | 'none';
export type VaultRootErrorCode = 'VAULT_NOT_FOUND' | 'VAULT_UNSAFE';
export type ManagedSectionState = 'present' | 'missing' | 'duplicated' | 'malformed' | 'customized';

export interface DoctorCliArguments {
  vaultDir: string;
  pluginRoot: string;
  installedVersion?: string;
}

export interface DoctorFinding {
  code: string;
  severity: FindingSeverity;
  category: string;
  message: string;
  recommendedAction: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface ManagedSectionStateResult {
  heading: string;
  level: number;
  state: ManagedSectionState;
}

export interface DoctorReportV1 {
  version: 1;
  state: DoctorReportState;
  plugin: {
    name: string;
    root: string;
    version: string | null;
    source: 'checkout' | 'installed';
    installedVersion: string | null;
    installedMismatch: boolean;
  };
  roots: {
    vault: { resolved: boolean; lexical: string; canonical: string };
    runtime: { root: string; exists: boolean };
  };
  versions: Record<string, string | null>;
  config: {
    present: boolean;
    valid: boolean;
    parseError: string | null;
    layers: Partial<Record<'raw' | 'practices' | 'cognition', string>>;
  };
  schema: {
    present: boolean;
    state: SchemaState;
    path: string;
    sha256: string;
  };
  agents: {
    claude: boolean;
    codex: boolean;
    mode: AgentMode;
  };
  managedSections: {
    source: string;
    reordered: boolean;
    sections: ManagedSectionStateResult[];
  };
  runtime: {
    exists: boolean;
    locks: Array<{ path: string; size: number }>;
    recoveries: VaultWriteRecovery[];
    legacy: string[];
    ingestPending: string[];
  };
  findings: DoctorFinding[];
}

export const USAGE = 'Usage: doctor --vault-dir DIR [--plugin-root DIR] [--installed-version VERSION]';

const LAYERS = ['raw', 'practices', 'cognition'] as const;

/**
 * Current schema profile revision, from `templates/schema-profiles/me-schema-v1.json`.
 * A vault SCHEMA.md is only classified `future` when it carries a deterministic
 * marker declaring a revision strictly higher than this value.
 */
const CURRENT_SCHEMA_REVISION = 1;

export interface VaultRootResolution {
  resolved: boolean;
  canonical: string;
  errorCode?: VaultRootErrorCode;
}

interface RootOperations {
  statSync: typeof fs.statSync;
  realpathSync: typeof fs.realpathSync;
}

/**
 * Resolve the vault root with two distinct failure modes:
 * - existence/type failure (stat) → `VAULT_NOT_FOUND`
 * - canonicalization failure (realpath after stat succeeded) → `VAULT_UNSAFE`
 */
export function resolveVaultRoot(
  lexicalVault: string,
  operations: RootOperations = { statSync: fs.statSync, realpathSync: fs.realpathSync },
): VaultRootResolution {
  try {
    if (!operations.statSync(lexicalVault).isDirectory()) {
      return { resolved: false, canonical: lexicalVault, errorCode: 'VAULT_NOT_FOUND' };
    }
  } catch {
    return { resolved: false, canonical: lexicalVault, errorCode: 'VAULT_NOT_FOUND' };
  }
  try {
    return { resolved: true, canonical: operations.realpathSync(lexicalVault) };
  } catch {
    return { resolved: false, canonical: lexicalVault, errorCode: 'VAULT_UNSAFE' };
  }
}
const JOURNAL_STATES = new Set([
  'planned',
  'locked',
  'staged',
  'note-published',
  'index-preserved',
  'index-published',
  'validated',
  'committed',
]);

const MANAGED_SECTIONS: ReadonlyArray<{ heading: string; level: number }> = [
  { heading: 'Knowledge Base', level: 1 },
  { heading: 'Configuration', level: 2 },
  { heading: 'Layer Map', level: 2 },
  { heading: 'Commands', level: 2 },
  { heading: 'Note Templates', level: 2 },
  { heading: 'After Creating a Note', level: 2 },
  { heading: 'Search', level: 2 },
  { heading: 'Conventions', level: 2 },
];

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readJson(candidate: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJsonVersion(candidate: string): string | null {
  const json = readJson(candidate);
  return typeof json?.version === 'string' ? json.version : null;
}

export function parseDoctorArguments(argv: string[]): DoctorCliArguments {
  let vaultDir: string | undefined;
  let pluginRoot = path.resolve(__dirname, '..');
  let pluginRootSet = false;
  let installedVersion: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    if (flag === '--vault-dir' && vaultDir === undefined) {
      vaultDir = value;
    } else if (flag === '--plugin-root' && !pluginRootSet) {
      pluginRoot = value;
      pluginRootSet = true;
    } else if (flag === '--installed-version' && installedVersion === undefined) {
      installedVersion = value;
    } else {
      throw new Error('INVALID_ARGUMENTS');
    }
    index += 2;
  }

  if (!vaultDir) throw new Error('INVALID_ARGUMENTS');
  return {
    vaultDir,
    pluginRoot,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
  };
}

interface ParsedSection {
  level: number;
  heading: string;
  body: string;
}

function extractSections(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const headingLineIndexes: number[] = [];
  const parsed: Array<{ level: number; heading: string }> = [];
  const lineRegex = /^(#{1,6})\s+(.+?)\s*$/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lineRegex.exec(lines[index]);
    if (match) {
      headingLineIndexes.push(index);
      parsed.push({ level: match[1].length, heading: match[2].trim() });
    }
  }
  return parsed.map((heading, index) => ({
    ...heading,
    body: lines
      .slice(headingLineIndexes[index] + 1, headingLineIndexes[index + 1] ?? lines.length)
      .join('\n')
      .trim(),
  }));
}

function normalizeHeading(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function analyzeManagedSections(
  vaultMarkdown: string,
  templateMarkdown: string,
): { sections: ManagedSectionStateResult[]; reordered: boolean } {
  const vaultSections = extractSections(vaultMarkdown);
  const templateSections = extractSections(templateMarkdown);

  const sections: ManagedSectionStateResult[] = [];
  for (const managed of MANAGED_SECTIONS) {
    const matches = vaultSections.filter(
      section => normalizeHeading(section.heading) === normalizeHeading(managed.heading),
    );
    let state: ManagedSectionState;
    if (matches.length === 0) {
      state = 'missing';
    } else if (matches.length > 1) {
      state = 'duplicated';
    } else {
      const vault = matches[0];
      if (vault.level !== managed.level) {
        state = 'malformed';
      } else {
        const template = templateSections.find(
          section => normalizeHeading(section.heading) === normalizeHeading(managed.heading)
            && section.level === managed.level,
        );
        state = template && template.body !== vault.body ? 'customized' : 'present';
      }
    }
    sections.push({ heading: managed.heading, level: managed.level, state });
  }

  const expected = MANAGED_SECTIONS
    .filter((_, index) => sections[index].state === 'present' || sections[index].state === 'customized')
    .map(section => normalizeHeading(section.heading));
  const presentVaultHeadings = vaultSections
    .map(section => normalizeHeading(section.heading))
    .filter(heading => expected.includes(heading));
  const deduped: string[] = [];
  for (const heading of presentVaultHeadings) {
    if (!deduped.includes(heading)) deduped.push(heading);
  }
  return { sections, reordered: deduped.join('|') !== expected.join('|') };
}

function isRecognizableMeSchema(text: string): boolean {
  return /##\s+Core Fields/.test(text) && /##\s+Per-Layer Extensions/.test(text);
}

/**
 * A deterministic future-version signal: an explicit profile/revision marker
 * whose declared number is strictly higher than the current schema revision.
 * Without such a marker we cannot claim a schema is newer — unknown hash edits
 * are classified `edited`, never `future`.
 */
function hasFutureRevisionMarker(text: string, currentRevision: number): boolean {
  const patterns = [
    /me-schema-v(\d+)/g,
    /^Schema revision:\s*(\d+)/gm,
    /^revision:\s*(\d+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const declared = Number(match[1]);
      if (Number.isInteger(declared) && declared > currentRevision) return true;
    }
  }
  return false;
}

export function classifySchemaState(
  vaultText: string | null,
  pluginSchemaText: string,
  currentRevision: number = CURRENT_SCHEMA_REVISION,
): SchemaState {
  if (vaultText === null) return 'missing';
  if (vaultText === pluginSchemaText) return 'current';
  if (isRecognizableMeSchema(vaultText)) {
    return hasFutureRevisionMarker(vaultText, currentRevision) ? 'future' : 'edited';
  }
  return 'malformed';
}

export function overallState(findings: DoctorFinding[]): DoctorReportState {
  if (findings.some(finding => finding.code === 'SCHEMA_FUTURE')) return 'future-schema';
  if (findings.some(finding => finding.severity === 'error')) return 'malformed';
  if (findings.some(finding => finding.severity === 'warning')) return 'behind';
  return 'healthy';
}

function isSafeLayerPath(configured: string): boolean {
  if (
    !configured
    || path.posix.isAbsolute(configured)
    || configured.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(configured)
    || configured.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(configured)
  ) {
    return false;
  }
  return !configured
    .split('/')
    .some(component => !component || component === '.' || component === '..');
}

function scanDirectory(directory: string): string[] {
  try {
    return fs.readdirSync(directory).sort();
  } catch {
    return [];
  }
}

function runtimeDisplay(layout: ReturnType<typeof resolveRuntimeLayout>, candidate: string): string {
  const relative = path.relative(layout.runtimeRoot, path.resolve(candidate));
  return relative ? `<ME_RUNTIME>/${relative.split(path.sep).join('/')}` : '<ME_RUNTIME>';
}

function safeJournalRelativePath(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return !value
    .split('/')
    .some(component => !component || component === '.' || component === '..' || /[\u0000-\u001f\u007f]/.test(component));
}

function journalHasContradictoryPaths(value: Record<string, unknown>): boolean {
  for (const key of ['notePath', 'indexPath']) {
    if (value[key] !== undefined && !safeJournalRelativePath(value[key])) return true;
  }
  return typeof value.notePath === 'string'
    && typeof value.indexPath === 'string'
    && value.notePath === value.indexPath;
}

function scanRecoveries(
  layout: ReturnType<typeof resolveRuntimeLayout>,
): VaultWriteRecovery[] {
  const names = scanDirectory(layout.transactionDir)
    .filter(name => name.startsWith('vault-write-'));

  type Candidate = {
    name: string;
    operationId: string;
    state: VaultWriteRecovery['state'];
    directory: string;
    journal?: string;
  };

  const candidates: Candidate[] = [];
  for (const name of names) {
    const directory = path.join(layout.transactionDir, name);
    const relativeDirectory = runtimeDisplay(layout, directory);
    const fallbackId = name.slice('vault-write-'.length) || 'unrecognized';

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch {
      candidates.push({ name, operationId: fallbackId, state: 'unrecognized-operation', directory: relativeDirectory });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      candidates.push({ name, operationId: fallbackId, state: 'unrecognized-operation', directory: relativeDirectory });
      continue;
    }

    const journalPath = path.join(directory, 'journal.json');
    let value: unknown;
    try {
      const journalStat = fs.lstatSync(journalPath);
      if (journalStat.isSymbolicLink() || !journalStat.isFile()) throw new Error('unsafe journal');
      value = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      candidates.push({
        name,
        operationId: fallbackId,
        state: 'unrecognized-operation',
        directory: relativeDirectory,
        journal: `${relativeDirectory}/journal.json`,
      });
      continue;
    }

    const record = value as { version?: unknown; operationId?: unknown; state?: unknown };
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || record.version !== 1
      || typeof record.operationId !== 'string'
      || typeof record.state !== 'string'
      || !JOURNAL_STATES.has(record.state)
      || name !== `vault-write-${record.operationId}`
      || journalHasContradictoryPaths(record as Record<string, unknown>)
    ) {
      candidates.push({
        name,
        operationId: typeof record.operationId === 'string' ? record.operationId : fallbackId,
        state: 'unrecognized-operation',
        directory: relativeDirectory,
        journal: `${relativeDirectory}/journal.json`,
      });
      continue;
    }

    if (record.state === 'committed') continue;

    candidates.push({
      name,
      operationId: record.operationId,
      state: 'incomplete-operation',
      directory: relativeDirectory,
      journal: `${relativeDirectory}/journal.json`,
    });
  }

  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.operationId, (counts.get(candidate.operationId) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if ((counts.get(candidate.operationId) ?? 0) <= 1) continue;
    candidate.state = 'unrecognized-operation';
    candidate.journal = `${candidate.directory}/journal.json`;
  }

  return candidates
    .map(candidate => ({
      operationId: candidate.operationId,
      state: candidate.state,
      directory: candidate.directory,
      ...(candidate.journal ? { journal: candidate.journal } : {}),
      preservedPaths: [candidate.directory],
      remainingMutations: [
        candidate.state === 'incomplete-operation'
          ? 'Inspect the incomplete operation journal.'
          : 'Inspect the unrecognized operation metadata.',
      ],
      actions: [
        { kind: 'inspect' as const, path: candidate.directory, condition: 'Inspect the recovery entry before the next vault write.' },
      ],
    }))
    .sort((first, second) => first.directory < second.directory ? -1 : 1);
}

function collectVersions(pluginRoot: string): Record<string, string | null> {
  return {
    package: readJsonVersion(path.join(pluginRoot, 'package.json')),
    codexPlugin: readJsonVersion(path.join(pluginRoot, '.codex-plugin', 'plugin.json')),
    claudePlugin: readJsonVersion(path.join(pluginRoot, '.claude-plugin', 'plugin.json')),
    claudeMarketplace: readJsonVersion(path.join(pluginRoot, '.claude-plugin', 'marketplace.json')),
    codexMarketplace: readJsonVersion(path.join(pluginRoot, '.agents', 'plugins', 'marketplace.json')),
  };
}

export function buildDoctorReport(
  args: DoctorCliArguments,
  environment: NodeJS.ProcessEnv = process.env,
): DoctorReportV1 {
  const findings: DoctorFinding[] = [];

  // ── Roots ─────────────────────────────────────────────────────────
  const lexicalVault = path.resolve(args.vaultDir);
  const rootResolution = resolveVaultRoot(lexicalVault);
  let vaultResolved = rootResolution.resolved;
  const canonicalVault = rootResolution.canonical;
  if (!rootResolution.resolved) {
    const unsafe = rootResolution.errorCode === 'VAULT_UNSAFE';
    findings.push({
      code: rootResolution.errorCode ?? 'VAULT_NOT_FOUND',
      severity: 'error',
      category: 'roots',
      message: unsafe
        ? 'Vault directory exists but cannot be canonicalized safely.'
        : 'Vault directory does not exist or is not a directory.',
      recommendedAction: unsafe
        ? 'Resolve the symlink or permission issue for the vault directory.'
        : 'Provide an existing vault directory.',
      path: lexicalVault,
    });
  }

  let runtimeLayout: ReturnType<typeof resolveRuntimeLayout> | null = null;
  if (vaultResolved) {
    try {
      runtimeLayout = resolveRuntimeLayout(lexicalVault, environment);
    } catch (error) {
      findings.push({
        code: 'RUNTIME_UNSAFE',
        severity: 'error',
        category: 'roots',
        message: 'ME runtime layout could not be resolved safely.',
        recommendedAction: 'Set ME_RUNTIME_ROOT to an absolute same-filesystem directory.',
        details: { code: error instanceof RuntimePathError ? error.code : 'UNSAFE_PATH' },
      });
    }
  }

  // ── Versions ──────────────────────────────────────────────────────
  const versions = collectVersions(args.pluginRoot);
  const declaredVersions = Object.values(versions)
    .filter((value): value is string => typeof value === 'string');
  const versionSet = new Set(declaredVersions);
  if (versionSet.size <= 1) {
    const version = declaredVersions[0] ?? null;
    findings.push({
      code: 'PLUGIN_VERSION_CONSISTENT',
      severity: 'info',
      category: 'versions',
      message: version
        ? `All plugin manifests agree on version ${version}.`
        : 'No version field found in plugin manifests.',
      recommendedAction: 'No action needed.',
    });
  } else {
    findings.push({
      code: 'PLUGIN_VERSION_MISMATCH',
      severity: 'warning',
      category: 'versions',
      message: `Plugin manifests disagree: ${[...versionSet].join(', ')}.`,
      recommendedAction: 'Reinstall the plugin so all manifests agree on one version.',
    });
  }

  const pluginVersion = readJsonVersion(path.join(args.pluginRoot, 'package.json'));
  const installedVersion = args.installedVersion ?? pluginVersion;
  const installedMismatch = args.installedVersion !== undefined && args.installedVersion !== pluginVersion;
  if (installedMismatch) {
    findings.push({
      code: 'PLUGIN_INSTALLED_MISMATCH',
      severity: 'warning',
      category: 'versions',
      message: `Installed plugin version ${args.installedVersion} differs from checkout version ${pluginVersion}.`,
      recommendedAction: 'Align the installed plugin version with the checkout (plugin upgrade).',
    });
  }
  const pluginSource = fs.existsSync(path.join(args.pluginRoot, '.git')) ? 'checkout' : 'installed';

  // ── Config ────────────────────────────────────────────────────────
  const meDir = path.join(lexicalVault, '.me');
  const configPath = path.join(meDir, 'config.yaml');
  const config: DoctorReportV1['config'] = {
    present: false,
    valid: false,
    parseError: null,
    layers: {},
  };

  if (vaultResolved && fs.existsSync(configPath)) {
    config.present = true;
    try {
      const parsed = parseLayerConfig(fs.readFileSync(configPath, 'utf8'));
      for (const layer of LAYERS) {
        const configured = parsed[layer];
        if (configured !== undefined && !isSafeLayerPath(configured)) {
          throw new Error('unsafe layer path');
        }
      }
      config.valid = true;
      config.layers = parsed;
      findings.push({
        code: 'CONFIG_VALID',
        severity: 'info',
        category: 'config',
        message: 'Layer configuration is valid.',
        recommendedAction: 'No action needed.',
      });
      for (const layer of LAYERS) {
        const configured = parsed[layer];
        if (configured === undefined) continue;
        const layerDir = path.join(lexicalVault, ...configured.split('/'));
        if (!fs.existsSync(layerDir) || !fs.statSync(layerDir).isDirectory()) {
          findings.push({
            code: 'LAYER_DIR_MISSING',
            severity: 'warning',
            category: 'config',
            message: `Configured ${layer} layer directory ${configured} does not exist.`,
            recommendedAction: 'Create the configured layer directory or fix .me/config.yaml.',
            path: layerDir,
          });
        }
      }
    } catch (error) {
      config.valid = false;
      config.parseError = error instanceof Error ? error.message : String(error);
      findings.push({
        code: 'CONFIG_MALFORMED',
        severity: 'error',
        category: 'config',
        message: '.me/config.yaml is present but its layers mapping is invalid.',
        recommendedAction: 'Fix .me/config.yaml layers mapping or re-run /me:setup.',
        path: configPath,
      });
    }
  } else if (vaultResolved) {
    findings.push({
      code: 'CONFIG_MISSING',
      severity: 'warning',
      category: 'config',
      message: '.me/config.yaml is missing; the workspace is not an initialized ME vault.',
      recommendedAction: 'Run /me:setup to initialize the vault.',
      path: configPath,
    });
  }

  // ── Schema ────────────────────────────────────────────────────────
  const schemaPath = path.join(lexicalVault, 'SCHEMA.md');
  let schemaText: string | null = null;
  if (vaultResolved && fs.existsSync(schemaPath) && fs.statSync(schemaPath).isFile()) {
    schemaText = fs.readFileSync(schemaPath, 'utf8');
  }
  let pluginSchemaText = '';
  try {
    pluginSchemaText = fs.readFileSync(path.join(args.pluginRoot, 'templates', 'SCHEMA.md'), 'utf8');
  } catch {
    // Plugin template missing — every schema will classify as non-current.
  }
  let currentSchemaRevision = CURRENT_SCHEMA_REVISION;
  try {
    const profile = readJson(path.join(args.pluginRoot, 'templates', 'schema-profiles', 'me-schema-v1.json'));
    if (typeof profile?.revision === 'number') currentSchemaRevision = profile.revision;
  } catch {
    // Fall back to the constant when the profile is unreadable.
  }
  const schemaState = classifySchemaState(schemaText, pluginSchemaText, currentSchemaRevision);
  const schemaSha = schemaText === null ? '' : sha256(schemaText);

  if (vaultResolved) {
    switch (schemaState) {
      case 'current':
        findings.push({
          code: 'SCHEMA_CURRENT',
          severity: 'info',
          category: 'schema',
          message: 'Schema matches the current ME version.',
          recommendedAction: 'No action needed.',
        });
        break;
      case 'future':
        findings.push({
          code: 'SCHEMA_FUTURE',
          severity: 'warning',
          category: 'schema',
          message: 'Vault schema declares a newer revision than this plugin understands.',
          recommendedAction: 'Upgrade the ME plugin; the vault schema is newer than this plugin understands (plugin upgrade).',
          path: schemaPath,
        });
        break;
      case 'edited':
        findings.push({
          code: 'SCHEMA_EDITED',
          severity: 'warning',
          category: 'schema',
          message: 'SCHEMA.md differs from the current ME schema; treat it as an edited current schema, not a newer version.',
          recommendedAction: 'Run /me:setup to refresh SCHEMA.md from the plugin template (vault migration).',
          path: schemaPath,
        });
        break;
      case 'malformed':
        findings.push({
          code: 'SCHEMA_MALFORMED',
          severity: 'error',
          category: 'schema',
          message: 'SCHEMA.md is present but is not a recognizable ME schema.',
          recommendedAction: 'Inspect SCHEMA.md and restore it from the plugin template (vault migration).',
          path: schemaPath,
        });
        break;
      case 'missing':
        findings.push({
          code: 'SCHEMA_MISSING',
          severity: 'error',
          category: 'schema',
          message: 'SCHEMA.md is missing.',
          recommendedAction: 'Run /me:setup to refresh SCHEMA.md (vault migration).',
          path: schemaPath,
        });
        break;
    }
  }

  // ── Agents ────────────────────────────────────────────────────────
  const claudePresent = vaultResolved && fs.existsSync(path.join(lexicalVault, 'CLAUDE.md'));
  const codexPresent = vaultResolved && fs.existsSync(path.join(lexicalVault, 'AGENTS.md'));
  const agentMode: AgentMode = claudePresent && codexPresent
    ? 'dual'
    : claudePresent
      ? 'claude-only'
      : codexPresent
        ? 'codex-only'
        : 'none';

  if (vaultResolved) {
    if (agentMode === 'none') {
      findings.push({
        code: 'AGENT_SURFACE_NONE',
        severity: 'warning',
        category: 'agents',
        message: 'Neither CLAUDE.md nor AGENTS.md is present.',
        recommendedAction: 'Run /me:setup to create the managed agent surface (CLAUDE.md).',
      });
    }
    if (claudePresent) {
      findings.push({
        code: 'AGENT_SURFACE_CLAUDE',
        severity: 'info',
        category: 'agents',
        message: 'Claude managed surface (CLAUDE.md) is present.',
        recommendedAction: 'No action needed.',
      });
    }
    if (codexPresent) {
      findings.push({
        code: 'AGENT_SURFACE_CODEX',
        severity: 'info',
        category: 'agents',
        message: 'Codex managed surface (AGENTS.md) is present.',
        recommendedAction: 'No action needed.',
      });
    }
  }

  // ── Managed sections ──────────────────────────────────────────────
  const managedSections: DoctorReportV1['managedSections'] = {
    source: 'CLAUDE.md',
    reordered: false,
    sections: [],
  };
  if (claudePresent) {
    const vaultClaude = fs.readFileSync(path.join(lexicalVault, 'CLAUDE.md'), 'utf8');
    let templateClaude = '';
    try {
      templateClaude = fs.readFileSync(path.join(args.pluginRoot, 'templates', 'CLAUDE-template.md'), 'utf8');
    } catch {
      // Plugin template missing — every section compares against an empty template.
    }
    const analysis = analyzeManagedSections(vaultClaude, templateClaude);
    managedSections.reordered = analysis.reordered;
    managedSections.sections = analysis.sections;

    const claudePath = path.join(lexicalVault, 'CLAUDE.md');
    for (const section of analysis.sections) {
      if (section.state === 'present') continue;
      if (section.state === 'customized') {
        findings.push({
          code: 'MANAGED_SECTION_CUSTOMIZED',
          severity: 'info',
          category: 'managed-sections',
          message: `Managed section "${section.heading}" differs from the template and will be replaced on the next /me:setup upgrade.`,
          recommendedAction: 'No action needed; note this section is replaced on the next /me:setup upgrade.',
          path: claudePath,
          details: { heading: section.heading },
        });
        continue;
      }
      const isError = section.state === 'malformed';
      findings.push({
        code: `MANAGED_SECTION_${section.state.toUpperCase()}`,
        severity: isError ? 'error' : 'warning',
        category: 'managed-sections',
        message: {
          missing: `Managed section "${section.heading}" is missing from CLAUDE.md.`,
          duplicated: `Managed section "${section.heading}" appears more than once in CLAUDE.md.`,
          malformed: `Managed section "${section.heading}" has the wrong heading level.`,
        }[section.state],
        recommendedAction: {
          missing: 'Run /me:setup to refresh CLAUDE.md (vault migration).',
          duplicated: 'Run /me:setup to merge CLAUDE.md and deduplicate sections (vault migration).',
          malformed: 'Fix the section heading level or re-run /me:setup (vault migration).',
        }[section.state],
        path: claudePath,
        details: { heading: section.heading },
      });
    }
    if (analysis.reordered) {
      findings.push({
        code: 'MANAGED_SECTIONS_REORDERED',
        severity: 'info',
        category: 'managed-sections',
        message: 'Managed sections in CLAUDE.md are not in template order.',
        recommendedAction: 'Optional: re-run /me:setup to restore template order (vault migration).',
        path: claudePath,
      });
    }
  }

  // ── Runtime lock / journal / recovery ─────────────────────────────
  const runtime: DoctorReportV1['runtime'] = {
    exists: false,
    locks: [],
    recoveries: [],
    legacy: [],
    ingestPending: [],
  };

  if (runtimeLayout) {
    runtime.exists = fs.existsSync(runtimeLayout.runtimeRoot);

    for (const name of scanDirectory(runtimeLayout.lockDir)) {
      const lockPath = path.join(runtimeLayout.lockDir, name);
      let size = 0;
      try {
        size = fs.statSync(lockPath).size;
      } catch {
        // Ignore unreadable lock metadata.
      }
      runtime.locks.push({ path: runtimeDisplay(runtimeLayout, lockPath), size });
      findings.push({
        code: 'RUNTIME_LOCK_PRESENT',
        severity: 'warning',
        category: 'runtime',
        message: `Runtime lock ${name} is present; a vault-write operation may be unfinished.`,
        recommendedAction: 'Inspect the lock before the next vault write (diagnosis).',
        path: runtimeDisplay(runtimeLayout, lockPath),
      });
    }

    for (const recovery of scanRecoveries(runtimeLayout)) {
      runtime.recoveries.push(recovery);
      const incomplete = recovery.state === 'incomplete-operation';
      findings.push({
        code: incomplete ? 'RUNTIME_RECOVERY_INCOMPLETE' : 'RUNTIME_RECOVERY_UNRECOGNIZED',
        severity: incomplete ? 'warning' : 'error',
        category: 'runtime',
        message: incomplete
          ? `Incomplete operation ${recovery.operationId} requires inspection.`
          : `Unrecognized runtime entry ${recovery.operationId} requires inspection.`,
        recommendedAction: 'Inspect the transaction journal before the next vault write (diagnosis).',
        path: recovery.directory,
        details: { state: recovery.state, preservedPaths: recovery.preservedPaths },
      });
    }

    for (const legacyDirectory of [path.join(meDir, 'locks'), path.join(meDir, 'tmp')]) {
      if (!vaultResolved) continue;
      const names = scanDirectory(legacyDirectory);
      for (const name of names) {
        runtime.legacy.push(path.join('.me', path.basename(legacyDirectory), name));
      }
      if (names.length > 0) {
        findings.push({
          code: 'RUNTIME_LEGACY_STATE',
          severity: 'warning',
          category: 'runtime',
          message: `Legacy ME runtime state exists under .me/${path.basename(legacyDirectory)}.`,
          recommendedAction: 'Inspect legacy ME runtime state (diagnosis).',
          path: path.join(lexicalVault, '.me', path.basename(legacyDirectory)),
        });
      }
    }

    for (const pendingDirectory of [runtimeLayout.ingestLockDir, runtimeLayout.ingestStagingDir]) {
      const names = scanDirectory(pendingDirectory);
      for (const name of names) {
        runtime.ingestPending.push(runtimeDisplay(runtimeLayout, path.join(pendingDirectory, name)));
      }
      if (names.length > 0) {
        findings.push({
          code: 'RUNTIME_INGEST_PENDING',
          severity: 'warning',
          category: 'runtime',
          message: 'Ingest runtime state is pending under <ME_RUNTIME>/ingest.',
          recommendedAction: 'Inspect the ingest staging/lock state (diagnosis).',
        });
      }
    }
  }

  const packageJson = readJson(path.join(args.pluginRoot, 'package.json'));
  const report: DoctorReportV1 = {
    version: 1,
    state: overallState(findings),
    plugin: {
      name: typeof packageJson?.name === 'string' ? packageJson.name : 'me',
      root: args.pluginRoot,
      version: pluginVersion,
      source: pluginSource,
      installedVersion,
      installedMismatch,
    },
    roots: {
      vault: { resolved: vaultResolved, lexical: lexicalVault, canonical: canonicalVault },
      runtime: { root: runtimeLayout?.runtimeRoot ?? '', exists: runtimeLayout ? fs.existsSync(runtimeLayout.runtimeRoot) : false },
    },
    versions,
    config,
    schema: {
      present: schemaText !== null,
      state: schemaState,
      path: schemaPath,
      sha256: schemaSha,
    },
    agents: {
      claude: claudePresent,
      codex: codexPresent,
      mode: agentMode,
    },
    managedSections,
    runtime,
    findings,
  };
  return report;
}

export function runDoctor(argv: string[]): number {
  let args: DoctorCliArguments;
  try {
    args = parseDoctorArguments(argv);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'error', error: { code: 'INVALID_ARGUMENTS', message: USAGE } })}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(buildDoctorReport(args, process.env))}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = runDoctor(process.argv.slice(2));
}
