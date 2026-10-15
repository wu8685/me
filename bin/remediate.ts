#!/usr/bin/env -S bun run

/**
 * remediate — the remediation contract for a confirmed misfiled note.
 *
 * Flow:
 *
 *   1. `preview` computes a zero-write plan: source/destination paths,
 *      frontmatter changes, README index changes, and path-qualified
 *      wikilink rewrites, bound to a `planDigest` over every byte it will
 *      touch. Nothing is written.
 *   2. The Agent shows the preview and asks for explicit confirmation.
 *   3. `apply --expected-plan-digest <digest>` re-derives the plan from the
 *      current vault; any drift is a STALE_PREVIEW refusal, so a preview
 *      never authorizes a different vault state. The move itself follows
 *      me:move behavior (link-safe relocation) under the shared cooperative
 *      lock, with byte-level backups and rollback on failure.
 *
 * Remediation never classifies or moves notes in bulk: one explicit,
 * confirmed note per invocation. Post-apply validation re-checks schema
 * routing, links, and index reachability; the runtime journal preserves an
 * auditable result with a truthful recovery status.
 *
 * Usage:
 *   remediate preview --vault-dir DIR --note REL --to-layer LAYER [--markdown-file F]
 *   remediate apply   --vault-dir DIR --note REL --to-layer LAYER [--markdown-file F] --expected-plan-digest HEX
 *
 * Exit codes: 0 preview/committed · 2 invalid request · 3 blocked ·
 * 4 stale preview · 5 rolled back / manual recovery.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LogicalLayer } from './vault-write/contracts';
import { parseLayerConfig } from './vault-write/path-safety';
import { analyzeNoteRouting, parseLooseNote, type RoutingFinding } from './vault-write/routing';
import { resolveRuntimeLayout, runtimeDisplayPath, type RuntimeLayout } from './runtime-paths';
import {
  CooperativeLockError,
  acquireVaultLock,
  releaseVaultLock,
  type OwnedCooperativeLock,
} from './cooperative-lock';

const LAYERS: LogicalLayer[] = ['raw', 'practices', 'cognition'];
const DEFAULT_LAYERS: Record<LogicalLayer, string> = {
  raw: 'raw',
  practices: 'practices',
  cognition: 'cognition',
};
const INDEX_START = '<!-- me:index:start -->';
const INDEX_END = '<!-- me:index:end -->';
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

const USAGE = 'Usage: remediate (preview|apply) --vault-dir DIR --note REL --to-layer LAYER [--markdown-file F] [--expected-plan-digest HEX]';

type RemediateStatus = 'preview' | 'blocked' | 'committed' | 'stale' | 'rolled-back' | 'manual-recovery';

interface FrontmatterChange {
  field: string;
  before?: string;
  after?: string;
}

interface WikilinkRewrite {
  path: string;
  replacements: number;
}

interface IndexChange {
  path: string;
  action: 'remove-entry' | 'add-entry' | 'create';
  entry: string;
}

interface RemediateReport {
  version: 1;
  status: RemediateStatus;
  operationId: string;
  planDigest?: string;
  sourcePath: string;
  destinationPath?: string;
  frontmatterChanges: FrontmatterChange[];
  wikilinkRewrites: WikilinkRewrite[];
  indexChanges: IndexChange[];
  validation: { errors: RoutingFinding[]; advisories: RoutingFinding[] };
  changedPaths: string[];
  zeroWrite: boolean;
  recoveryState: 'none' | 'rolled-back' | 'manual';
  preservedPaths: string[];
  error?: { code: string; message: string };
}

interface CliArguments {
  mode: 'preview' | 'apply';
  vaultDir: string;
  note: string;
  toLayer: LogicalLayer;
  markdownFile?: string;
  expectedPlanDigest?: string;
}

class RemediateError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number) {
    super(message);
    this.name = 'RemediateError';
  }
}

function invalid(message: string): never {
  throw new RemediateError('INVALID_REQUEST', message, 2);
}

function blocked(code: string, message: string): never {
  throw new RemediateError(code, message, 3);
}

function parseArguments(argv: string[]): CliArguments {
  const mode = argv[0];
  if (mode !== 'preview' && mode !== 'apply') invalid(USAGE);
  let vaultDir: string | undefined;
  let note: string | undefined;
  let toLayer: string | undefined;
  let markdownFile: string | undefined;
  let expectedPlanDigest: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) invalid(USAGE);
    if (flag === '--vault-dir' && vaultDir === undefined) vaultDir = value;
    else if (flag === '--note' && note === undefined) note = value;
    else if (flag === '--to-layer' && toLayer === undefined) toLayer = value;
    else if (flag === '--markdown-file' && markdownFile === undefined) markdownFile = value;
    else if (flag === '--expected-plan-digest' && expectedPlanDigest === undefined) expectedPlanDigest = value;
    else invalid(USAGE);
    index += 1;
  }
  if (!vaultDir || !note || !toLayer) invalid(USAGE);
  if (!LAYERS.includes(toLayer as LogicalLayer)) invalid(`Unknown layer "${toLayer}". ${USAGE}`);
  if (mode === 'apply' && !/^[a-f0-9]{64}$/.test(expectedPlanDigest ?? '')) {
    invalid(`apply requires --expected-plan-digest (64 hex chars). ${USAGE}`);
  }
  if (mode === 'preview' && expectedPlanDigest !== undefined) invalid(USAGE);
  return {
    mode,
    vaultDir,
    note,
    toLayer: toLayer as LogicalLayer,
    ...(markdownFile !== undefined ? { markdownFile } : {}),
    ...(expectedPlanDigest !== undefined ? { expectedPlanDigest } : {}),
  };
}

function isSafeRelativeDirectory(configured: string): boolean {
  if (
    !configured
    || path.posix.isAbsolute(configured)
    || configured.startsWith('//')
    || WINDOWS_DRIVE.test(configured)
    || configured.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(configured)
  ) {
    return false;
  }
  return !configured.split('/').some(component => !component || component === '.' || component === '..');
}

/** Resolve layer directories from `.me/config.yaml`, falling back to defaults. */
export function resolveLayers(vaultDir: string): Record<LogicalLayer, string> {
  const layers = { ...DEFAULT_LAYERS };
  const configPath = path.join(vaultDir, '.me', 'config.yaml');
  if (fs.existsSync(configPath)) {
    let parsed: Partial<Record<LogicalLayer, string>>;
    try {
      parsed = parseLayerConfig(fs.readFileSync(configPath, 'utf8'));
    } catch {
      blocked('INVALID_CONFIG', '.me/config.yaml layers mapping is invalid.');
    }
    for (const layer of LAYERS) {
      const configured = parsed[layer];
      if (configured === undefined) continue;
      if (!isSafeRelativeDirectory(configured)) {
        blocked('INVALID_CONFIG', `Configured ${layer} layer path is unsafe.`);
      }
      layers[layer] = configured;
    }
  }
  return layers;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isSafeVaultRelativeNote(value: string): boolean {
  return Boolean(value)
    && value.endsWith('.md')
    && !value.startsWith('/')
    && !value.startsWith('//')
    && !WINDOWS_DRIVE.test(value)
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split('/').some(component => !component || component === '.' || component === '..');
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Fingerprint a touched path: content for regular files, type otherwise. */
function fingerprint(absPath: string): string {
  const stat = lstatIfPresent(absPath);
  if (!stat) return 'missing';
  if (stat.isFile() && !stat.isSymbolicLink()) return `file:${sha256(fs.readFileSync(absPath))}`;
  return 'other';
}

function frontmatterDiff(beforeMarkdown: string, afterMarkdown: string): FrontmatterChange[] {
  const before = parseLooseNote(beforeMarkdown)?.fields ?? new Map<string, string>();
  const after = parseLooseNote(afterMarkdown)?.fields ?? new Map<string, string>();
  const changes: FrontmatterChange[] = [];
  for (const field of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(field);
    const newValue = after.get(field);
    if (oldValue === newValue) continue;
    changes.push({
      field,
      ...(oldValue !== undefined ? { before: oldValue } : {}),
      ...(newValue !== undefined ? { after: newValue } : {}),
    });
  }
  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Count path-qualified wikilink references to `oldRef` (without .md). */
function countReferences(content: string, oldRef: string): number {
  const pattern = new RegExp(`\\[\\[${escapeRegExp(oldRef)}(?=[\\]|#])`, 'g');
  return (content.match(pattern) ?? []).length;
}

function rewriteReferences(content: string, oldRef: string, newRef: string): string {
  const pattern = new RegExp(`\\[\\[${escapeRegExp(oldRef)}(?=[\\]|#])`, 'g');
  return content.replace(pattern, `[[${newRef}`);
}

function walkMarkdown(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
}

interface IndexUpdate {
  change: IndexChange;
  absPath: string;
  after: string | null;
}

/**
 * Plan one index update. `remove` drops the entry line from the managed
 * block; `add` inserts it (creating the block or README when needed),
 * keeping entries sorted by code point. Returns null when no change needed.
 */
function planIndexUpdate(
  vault: string,
  indexRel: string,
  entry: string,
  mode: 'add' | 'remove',
): IndexUpdate | null {
  const absPath = path.join(vault, ...indexRel.split('/'));
  const stat = lstatIfPresent(absPath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    blocked('INDEX_UNSAFE', `Index path ${indexRel} is not a regular file.`);
  }
  const entryLine = `- [[${entry}]]`;

  if (!stat) {
    if (mode === 'remove') return null;
    const after = `${INDEX_START}\n${entryLine}\n${INDEX_END}\n`;
    return { change: { path: indexRel, action: 'create', entry }, absPath, after };
  }

  const text = fs.readFileSync(absPath, 'utf8');
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start < 0 || end < 0 || end < start) {
    if (mode === 'remove') return null;
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    const after = `${text}${separator}${INDEX_START}\n${entryLine}\n${INDEX_END}\n`;
    return { change: { path: indexRel, action: 'add-entry', entry }, absPath, after };
  }

  const blockStart = start + INDEX_START.length;
  const block = text.slice(blockStart, end);
  const lines = block.split('\n').filter(line => line.startsWith('- [['));
  const has = lines.includes(entryLine);
  if (mode === 'remove' && !has) return null;
  if (mode === 'add' && has) return null;

  const entries = (mode === 'remove'
    ? lines.filter(line => line !== entryLine)
    : [...lines, entryLine].sort());
  const newBlock = `${INDEX_START}\n${entries.join('\n')}${entries.length ? '\n' : ''}${INDEX_END}`;
  const after = `${text.slice(0, start)}${newBlock}${text.slice(end + INDEX_END.length)}`;
  return {
    change: { path: indexRel, action: mode === 'remove' ? 'remove-entry' : 'add-entry', entry },
    absPath,
    after,
  };
}

interface RemediatePlan {
  sourceRel: string;
  destRel: string;
  sourceAbs: string;
  destAbs: string;
  sourceMarkdown: string;
  destMarkdown: string;
  frontmatterChanges: FrontmatterChange[];
  wikilinkRewrites: WikilinkRewrite[];
  rewriteFiles: Array<{ absPath: string; rel: string; after: string }>;
  indexUpdates: IndexUpdate[];
  validation: { errors: RoutingFinding[]; advisories: RoutingFinding[] };
  planDigest: string;
}

function computePlan(vault: string, args: CliArguments): RemediatePlan {
  const layers = resolveLayers(vault);
  const note = args.note;
  if (!isSafeVaultRelativeNote(note)) invalid(`--note must be a vault-relative .md path. ${USAGE}`);

  const sourceLayer = LAYERS.find(layer => {
    const prefix = `${layers[layer]}/`;
    return note.startsWith(prefix) && !note.slice(prefix.length).includes('/');
  });
  if (!sourceLayer) {
    blocked('NOTE_NOT_IN_LAYER', `--note ${note} is not a direct child of a configured layer directory.`);
  }
  if (sourceLayer === args.toLayer) {
    invalid(`--to-layer must differ from the note's current layer (${sourceLayer}).`);
  }

  const sourceAbs = path.join(vault, ...note.split('/'));
  const sourceStat = lstatIfPresent(sourceAbs);
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    invalid(`Note ${note} does not exist or is not a regular file.`);
  }
  const sourceMarkdown = fs.readFileSync(sourceAbs, 'utf8');

  const destRel = `${layers[args.toLayer]}/${path.posix.basename(note)}`;
  const destAbs = path.join(vault, ...destRel.split('/'));
  const destDir = path.dirname(destAbs);
  const destDirStat = lstatIfPresent(destDir);
  if (!destDirStat || !destDirStat.isDirectory() || destDirStat.isSymbolicLink()) {
    blocked('DESTINATION_LAYER_MISSING', `Destination layer directory ${layers[args.toLayer]} does not exist.`);
  }
  if (lstatIfPresent(destAbs)) {
    blocked('TARGET_EXISTS', `Destination ${destRel} already exists.`);
  }

  let destMarkdown = sourceMarkdown;
  if (args.markdownFile !== undefined) {
    try {
      destMarkdown = fs.readFileSync(args.markdownFile, 'utf8');
    } catch {
      invalid(`Cannot read --markdown-file. ${USAGE}`);
    }
  }

  const oldRef = note.replace(/\.md$/, '');
  const newRef = destRel.replace(/\.md$/, '');

  // Path-qualified wikilink rewrites across every layer (me:move behavior;
  // bare [[stem]] links are unaffected by a same-stem move).
  const rewriteFiles: RemediatePlan['rewriteFiles'] = [];
  for (const layer of LAYERS) {
    const layerAbs = path.join(vault, ...layers[layer].split('/'));
    const files: string[] = [];
    walkMarkdown(layerAbs, files);
    for (const file of files.sort()) {
      if (path.resolve(file) === path.resolve(sourceAbs)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const replacements = countReferences(content, oldRef);
      if (replacements === 0) continue;
      rewriteFiles.push({
        absPath: file,
        rel: toPosix(path.relative(vault, file)),
        after: rewriteReferences(content, oldRef, newRef),
      });
    }
  }

  const indexUpdates: IndexUpdate[] = [];
  const sourceIndex = planIndexUpdate(vault, `${layers[sourceLayer]}/README.md`, oldRef, 'remove');
  if (sourceIndex) indexUpdates.push(sourceIndex);
  const destIndex = planIndexUpdate(vault, `${layers[args.toLayer]}/README.md`, newRef, 'add');
  if (destIndex) indexUpdates.push(destIndex);

  const validation = analyzeNoteRouting(args.toLayer, destMarkdown);

  const touches: Record<string, string> = {
    [note]: fingerprint(sourceAbs),
  };
  for (const rewrite of rewriteFiles) touches[rewrite.rel] = fingerprint(rewrite.absPath);
  for (const update of indexUpdates) {
    touches[update.change.path] = fingerprint(update.absPath);
  }
  const sortedTouches = Object.keys(touches).sort()
    .map(key => [key, touches[key]]);
  const planDigest = sha256(JSON.stringify({
    version: 1,
    note,
    toLayer: args.toLayer,
    destinationMarkdown: sha256(destMarkdown),
    touches: sortedTouches,
  }));

  return {
    sourceRel: note,
    destRel,
    sourceAbs,
    destAbs,
    sourceMarkdown,
    destMarkdown,
    frontmatterChanges: frontmatterDiff(sourceMarkdown, destMarkdown),
    wikilinkRewrites: rewriteFiles.map(rewrite => ({
      path: rewrite.rel,
      replacements: countReferences(fs.readFileSync(rewrite.absPath, 'utf8'), oldRef),
    })),
    rewriteFiles,
    indexUpdates,
    validation,
    planDigest,
  };
}

function baseReport(operationId: string, args: CliArguments): RemediateReport {
  return {
    version: 1,
    status: 'preview',
    operationId,
    sourcePath: args.note,
    frontmatterChanges: [],
    wikilinkRewrites: [],
    indexChanges: [],
    validation: { errors: [], advisories: [] },
    changedPaths: [],
    zeroWrite: true,
    recoveryState: 'none',
    preservedPaths: [],
  };
}

function planReport(operationId: string, plan: RemediatePlan, args: CliArguments): RemediateReport {
  const report = baseReport(operationId, args);
  report.planDigest = plan.planDigest;
  report.destinationPath = plan.destRel;
  report.frontmatterChanges = plan.frontmatterChanges;
  report.wikilinkRewrites = plan.wikilinkRewrites;
  report.indexChanges = plan.indexUpdates.map(update => update.change);
  report.validation = plan.validation;
  return report;
}

interface Journal {
  version: 1;
  operationId: string;
  state: 'planned' | 'applied' | 'committed' | 'rolled-back' | 'manual-recovery';
  notePath: string;
  destinationPath: string;
  backups: Record<string, string>;
  created: string[];
  error?: string;
}

function writeJournal(recoveryDir: string, journal: Journal): void {
  fs.writeFileSync(
    path.join(recoveryDir, 'journal.json'),
    `${JSON.stringify(journal, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function applyPlan(
  vault: string,
  args: CliArguments,
  plan: RemediatePlan,
  operationId: string,
  environment: NodeJS.ProcessEnv,
): RemediateReport {
  let layout: RuntimeLayout;
  try {
    layout = resolveRuntimeLayout(vault, environment);
  } catch {
    throw new RemediateError('UNSAFE_PATH', 'ME runtime layout could not be resolved safely.', 2);
  }

  let lock: OwnedCooperativeLock | undefined;
  try {
    lock = acquireVaultLock(layout, { operationId, owner: 'remediate' });
  } catch (error) {
    if (error instanceof CooperativeLockError && error.code === 'LOCK_HELD') {
      throw new RemediateError('LOCK_HELD', 'Another vault mutation may still be active; inspect the runtime lock first.', 3);
    }
    throw new RemediateError('RECOVERY_REQUIRED', 'The runtime lock requires inspection before remediation.', 5);
  }

  const recoveryDir = path.join(layout.transactionDir, `remediate-${operationId}`);
  const displayDir = runtimeDisplayPath(layout, recoveryDir);
  const journal: Journal = {
    version: 1,
    operationId,
    state: 'planned',
    notePath: plan.sourceRel,
    destinationPath: plan.destRel,
    backups: {},
    created: [],
  };

  const rollback = (backupDir: string): boolean => {
    let clean = true;
    for (const created of journal.created) {
      try {
        fs.rmSync(created, { force: true });
      } catch {
        clean = false;
      }
    }
    for (const [absPath, backupName] of Object.entries(journal.backups)) {
      try {
        fs.copyFileSync(path.join(backupDir, backupName), absPath);
      } catch {
        clean = false;
      }
    }
    return clean;
  };

  try {
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    const backupDir = path.join(recoveryDir, 'backup');
    fs.mkdirSync(backupDir, { mode: 0o700 });

    // Byte-level backups of every existing file the plan touches.
    const touched: string[] = [plan.sourceAbs];
    for (const rewrite of plan.rewriteFiles) touched.push(rewrite.absPath);
    for (const update of plan.indexUpdates) touched.push(update.absPath);
    let sequence = 0;
    for (const absPath of touched) {
      if (journal.backups[absPath] !== undefined) continue;
      const stat = lstatIfPresent(absPath);
      if (stat && stat.isFile() && !stat.isSymbolicLink()) {
        const backupName = `file-${sequence}`;
        sequence += 1;
        fs.copyFileSync(absPath, path.join(backupDir, backupName));
        journal.backups[absPath] = backupName;
      }
    }
    writeJournal(recoveryDir, journal);

    // Mutations: publish the moved note, rewrite references, update indexes,
    // then retire the source (me:move link-safe relocation semantics).
    fs.writeFileSync(plan.destAbs, plan.destMarkdown, { flag: 'wx' });
    journal.created.push(plan.destAbs);
    for (const rewrite of plan.rewriteFiles) {
      fs.writeFileSync(rewrite.absPath, rewrite.after);
    }
    for (const update of plan.indexUpdates) {
      if (update.after === null) continue;
      const existed = lstatIfPresent(update.absPath) !== undefined;
      fs.writeFileSync(update.absPath, update.after);
      if (!existed) journal.created.push(update.absPath);
    }
    fs.unlinkSync(plan.sourceAbs);
    journal.state = 'applied';
    writeJournal(recoveryDir, journal);

    // Post-validation: schema routing, link rewrite completion, and index
    // reachability of the moved note.
    const postErrors: string[] = [];
    if (sha256(fs.readFileSync(plan.destAbs)) !== sha256(plan.destMarkdown)) {
      postErrors.push('destination content mismatch');
    }
    if (lstatIfPresent(plan.sourceAbs)) postErrors.push('source still present');
    const oldRef = plan.sourceRel.replace(/\.md$/, '');
    for (const layer of LAYERS) {
      const files: string[] = [];
      walkMarkdown(path.join(vault, ...resolveLayers(vault)[layer].split('/')), files);
      for (const file of files) {
        if (countReferences(fs.readFileSync(file, 'utf8'), oldRef) > 0) {
          postErrors.push(`stale reference in ${toPosix(path.relative(vault, file))}`);
        }
      }
    }
    for (const update of plan.indexUpdates) {
      const text = fs.readFileSync(update.absPath, 'utf8');
      const present = text.includes(`- [[${update.change.entry}]]`);
      if ((update.change.action === 'remove-entry' && present)
        || (update.change.action !== 'remove-entry' && !present)) {
        postErrors.push(`index ${update.change.path} not updated`);
      }
    }
    if (analyzeNoteRouting(args.toLayer, fs.readFileSync(plan.destAbs, 'utf8')).errors.length > 0) {
      postErrors.push('destination fails schema routing validation');
    }
    if (postErrors.length > 0) {
      throw new RemediateError('POST_VALIDATION_FAILED', `Post-apply validation failed: ${postErrors.join('; ')}.`, 5);
    }

    journal.state = 'committed';
    writeJournal(recoveryDir, journal);

    const report = planReport(operationId, plan, args);
    report.status = 'committed';
    report.zeroWrite = false;
    report.changedPaths = [
      plan.destRel,
      plan.sourceRel,
      ...plan.rewriteFiles.map(rewrite => rewrite.rel),
      ...plan.indexUpdates.map(update => update.change.path),
    ].sort();
    report.preservedPaths = [displayDir];
    return report;
  } catch (error) {
    let clean = false;
    try {
      clean = rollback(path.join(recoveryDir, 'backup'));
    } catch {
      clean = false;
    }
    journal.state = clean ? 'rolled-back' : 'manual-recovery';
    journal.error = error instanceof Error ? error.message : String(error);
    try {
      writeJournal(recoveryDir, journal);
    } catch {
      clean = false;
    }
    const report = planReport(operationId, plan, args);
    report.status = clean ? 'rolled-back' : 'manual-recovery';
    report.zeroWrite = false;
    report.recoveryState = clean ? 'rolled-back' : 'manual';
    report.preservedPaths = [displayDir];
    report.error = {
      code: error instanceof RemediateError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
    const wrapped = new RemediateError('__handled__', '', 5);
    (wrapped as unknown as { report: RemediateReport }).report = report;
    throw wrapped;
  } finally {
    try {
      releaseVaultLock(layout, lock);
    } catch {
      // Lock release failure is surfaced by me:doctor runtime findings.
    }
  }
}

export function runRemediate(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  operationIdFactory: () => string = crypto.randomUUID,
): { report: RemediateReport; exitCode: number } {
  const operationId = operationIdFactory();
  let args: CliArguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    const report: RemediateReport = {
      ...baseReport(operationId, { mode: 'preview', vaultDir: '', note: '', toLayer: 'raw' }),
      status: 'blocked',
      error: {
        code: error instanceof RemediateError ? error.code : 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : String(error),
      },
    };
    return { report, exitCode: 2 };
  }

  const vault = path.resolve(args.vaultDir);
  try {
    const plan = computePlan(vault, args);
    if (plan.validation.errors.length > 0) {
      const report = planReport(operationId, plan, args);
      report.status = 'blocked';
      report.error = {
        code: 'VALIDATION_FAILED',
        message: 'Destination note fails deterministic schema validation for the target layer; correct the frontmatter (see --markdown-file) before remediation.',
      };
      return { report, exitCode: 3 };
    }
    if (args.mode === 'preview') {
      return { report: planReport(operationId, plan, args), exitCode: 0 };
    }
    if (plan.planDigest !== args.expectedPlanDigest) {
      const report = planReport(operationId, plan, args);
      report.status = 'stale';
      report.error = {
        code: 'STALE_PREVIEW',
        message: 'Vault inputs changed after the preview; re-run preview and confirm the new digest. Nothing was written.',
      };
      return { report, exitCode: 4 };
    }
    const report = applyPlan(vault, args, plan, operationId, environment);
    return { report, exitCode: 0 };
  } catch (error) {
    if (error instanceof RemediateError && error.code === '__handled__') {
      return { report: (error as unknown as { report: RemediateReport }).report, exitCode: error.exitCode };
    }
    if (error instanceof RemediateError) {
      const report = baseReport(operationId, args);
      report.status = 'blocked';
      report.error = { code: error.code, message: error.message };
      return { report, exitCode: error.exitCode };
    }
    const report = baseReport(operationId, args);
    report.status = 'blocked';
    report.error = { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
    return { report, exitCode: 2 };
  }
}

if (require.main === module) {
  const { report, exitCode } = runRemediate(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
