import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  type LogicalLayer,
  VaultWriterError,
} from './contracts';
import {
  compareCodePoints,
  mentionOffsets,
  snapshotVaultGraph,
  stemIdentity,
  wikilinkTargetsPlannedNote,
  type VaultGraphSnapshot,
} from './graph';
import {
  assertSafeWriterPath,
  type ResolvedVaultLayout,
  type ResolvedWriteTarget,
  vaultRelative,
} from './path-safety';

export interface IndexPlan {
  action: 'none' | 'create' | 'replace';
  path: string;
  before?: Buffer;
  after?: Buffer;
  digest?: string;
}

export interface LinkSuggestions {
  backlinks: Array<{ path: string; count: number }>;
  unlinkedMentions: Array<{ path: string; count: number; offsets: number[] }>;
}

const START = '<!-- me:index:start -->';
const END = '<!-- me:index:end -->';
const STEM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY = /^- \[\[([^\]\r\n]+)\]\]$/;

function invalidNote(): never {
  throw new VaultWriterError('INVALID_NOTE');
}

function postValidationFailed(): never {
  throw new VaultWriterError('POST_VALIDATION_FAILED');
}

function readIfPresent(file: string): Buffer | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) invalidNote();
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof VaultWriterError) throw error;
    invalidNote();
  }
}

function markerLines(text: string): {
  start: number;
  end: number;
  startContent: number;
  endContent: number;
} | undefined {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  for (const match of text.matchAll(/.*(?:\r\n|\n|$)/g)) {
    if (match[0] === '') continue;
    const raw = match[0];
    const line = raw.replace(/\r?\n$/, '');
    lines.push({ text: line, start: offset, end: offset + raw.length });
    offset += raw.length;
  }
  const starts = lines.filter(line => line.text === START);
  const ends = lines.filter(line => line.text === END);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].start >= ends[0].start) {
    invalidNote();
  }
  return {
    start: starts[0].start,
    end: ends[0].end,
    startContent: starts[0].end,
    endContent: ends[0].start,
  };
}

function managedEntries(text: string, markers: ReturnType<typeof markerLines>): string[] {
  if (!markers) return [];
  const content = text.slice(markers.startContent, markers.endContent);
  const entries: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(ENTRY);
    if (!match) invalidNote();
    const target = match[1].split('|', 1)[0].split('#', 1)[0].trim();
    if (
      !target.includes('/')
      || target.endsWith('.md')
      || target.startsWith('/')
      || target.includes('\\')
      || target.split('/').some(component => !component || component === '.' || component === '..')
    ) invalidNote();
    entries.push(target);
  }
  return entries;
}

function managedBlock(entries: string[]): string {
  return [
    START,
    ...entries.map(entry => `- [[${entry}]]`),
    END,
    '',
  ].join('\n');
}

function appendBlock(before: Buffer, block: string): Buffer {
  if (before.length === 0) return Buffer.from(block);
  const text = before.toString('utf8');
  if (!Buffer.from(text).equals(before)) invalidNote();
  const separator = text.endsWith('\n\n') || text.endsWith('\r\n\r\n')
    ? ''
    : text.endsWith('\n')
      ? '\n'
      : '\n\n';
  return Buffer.concat([before, Buffer.from(`${separator}${block}`)]);
}

function buildIndexPlan(
  layout: ResolvedVaultLayout,
  target: ResolvedWriteTarget,
): IndexPlan {
  assertSafeWriterPath(layout, target.indexPath, 'index');
  const relativeIndex = vaultRelative(layout, target.indexPath);
  const before = readIfPresent(target.indexPath);
  const text = before?.toString('utf8') ?? '';
  if (before && !Buffer.from(text).equals(before)) invalidNote();
  const markers = markerLines(text);
  const targetLink = target.vaultRelativePath.replace(/\.md$/, '');
  const entries = [...new Set([...managedEntries(text, markers), targetLink])]
    .sort(compareCodePoints);
  const block = managedBlock(entries);
  let after: Buffer;
  if (!before) {
    after = Buffer.from(block);
  } else if (!markers) {
    after = appendBlock(before, block);
  } else {
    after = Buffer.from(`${text.slice(0, markers.start)}${block}${text.slice(markers.end)}`);
  }
  return {
    action: before ? 'replace' : 'create',
    path: relativeIndex,
    ...(before ? { before } : {}),
    after,
    digest: crypto.createHash('sha256').update(after).digest('hex'),
  };
}

function assertTargetConsistency(
  layout: ResolvedVaultLayout,
  layer: LogicalLayer,
  target: ResolvedWriteTarget,
): void {
  if (!STEM.test(target.stem)) throw new VaultWriterError('INVALID_REQUEST');
  const expectedRoot = layout.layers[layer];
  const expectedRelative = vaultRelative(layout, target.notePath);
  const layerRelative = path.relative(expectedRoot, target.notePath);
  if (
    target.layerRoot !== expectedRoot
    || target.indexPath !== path.join(expectedRoot, 'README.md')
    || target.vaultRelativePath !== expectedRelative
    || !layerRelative
    || layerRelative === '..'
    || layerRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(layerRelative)
    || path.basename(target.notePath, '.md') !== target.stem
    || path.extname(target.notePath) !== '.md'
  ) {
    throw new VaultWriterError('UNSAFE_PATH');
  }
  assertSafeWriterPath(layout, target.notePath, 'note');
  try {
    fs.lstatSync(target.notePath);
    throw new VaultWriterError('TARGET_EXISTS');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function planIndexUpdate(
  layout: ResolvedVaultLayout,
  layer: LogicalLayer,
  target: ResolvedWriteTarget,
  title: string,
): { index: IndexPlan; suggestions: LinkSuggestions } {
  assertTargetConsistency(layout, layer, target);
  const graph = snapshotVaultGraph(layout);
  const collision = graph.stemPaths.get(stemIdentity(target.stem)) ?? [];
  if (collision.length > 0) throw new VaultWriterError('DUPLICATE_STEM');

  /* Parse and validate markers even when another document already links to the note. */
  const candidateIndex = buildIndexPlan(layout, target);
  const backlinkCounts = new Map<string, number>();
  for (const document of graph.documents) {
    if (document.path === target.vaultRelativePath) continue;
    for (const link of document.wikilinks) {
      if (wikilinkTargetsPlannedNote(link, target.vaultRelativePath, target.stem)) {
        backlinkCounts.set(document.path, (backlinkCounts.get(document.path) ?? 0) + 1);
      }
    }
  }

  const backlinks = [...backlinkCounts]
    .map(([sourcePath, count]) => ({ path: sourcePath, count }))
    .sort((first, second) => compareCodePoints(first.path, second.path));
  const unlinkedMentions = graph.documents
    .filter(document =>
      !document.isIndex
      && document.path !== target.vaultRelativePath
      && !backlinkCounts.has(document.path))
    .map(document => ({
      path: document.path,
      offsets: mentionOffsets(document, title, target.stem),
    }))
    .filter(item => item.offsets.length > 0)
    .map(item => ({ ...item, count: item.offsets.length }))
    .sort((first, second) => compareCodePoints(first.path, second.path));

  return {
    index: backlinks.length > 0
      ? { action: 'none', path: candidateIndex.path }
      : candidateIndex,
    suggestions: { backlinks, unlinkedMentions },
  };
}

export function validatePostWriteGraph(
  before: VaultGraphSnapshot,
  layout: ResolvedVaultLayout,
  target: ResolvedWriteTarget,
  index: IndexPlan,
): void {
  const expectedIndexPath = vaultRelative(layout, target.indexPath);
  if (index.path !== expectedIndexPath) postValidationFailed();
  if (index.action !== 'none') {
    if (!index.after || !index.digest) postValidationFailed();
    let actual: Buffer;
    try {
      actual = fs.readFileSync(path.join(layout.lexicalVault, ...index.path.split('/')));
    } catch {
      postValidationFailed();
    }
    const digest = crypto.createHash('sha256').update(actual).digest('hex');
    if (!actual.equals(index.after) || digest !== index.digest) postValidationFailed();
  }

  let after: VaultGraphSnapshot;
  try {
    after = snapshotVaultGraph(layout);
  } catch {
    postValidationFailed();
  }
  const excluded = new Set([target.vaultRelativePath]);
  if (index.action !== 'none') excluded.add(expectedIndexPath);
  const stableBefore = before.inputs.filter(input => !excluded.has(input.path));
  const stableAfter = after.inputs.filter(input => !excluded.has(input.path));
  if (JSON.stringify(stableAfter) !== JSON.stringify(stableBefore)) postValidationFailed();
  if (
    !after.noteFiles.includes(target.vaultRelativePath)
    || after.orphans.has(target.vaultRelativePath)
    || (after.incoming.get(target.vaultRelativePath) ?? 0) === 0
  ) {
    postValidationFailed();
  }
  for (const broken of after.broken) {
    if (!before.broken.has(broken)) postValidationFailed();
  }
}

export type { VaultGraphSnapshot } from './graph';
