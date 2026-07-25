import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VaultWriterError } from './contracts';
import {
  assertSafeWriterPath,
  type ResolvedVaultLayout,
  vaultRelative,
} from './path-safety';

export interface VaultGraphInput {
  path: string;
  identity: string;
  sha256: string;
}

export interface VaultWikilink {
  raw: string;
  target: string;
  start: number;
  end: number;
  resolved?: string;
}

export interface VaultGraphDocument {
  path: string;
  absolutePath: string;
  markdown: string;
  isIndex: boolean;
  wikilinks: VaultWikilink[];
  searchable: boolean[];
}

export interface VaultGraphSnapshot {
  broken: Set<string>;
  noteFiles: string[];
  inputs: VaultGraphInput[];
  incoming: Map<string, number>;
  orphans: Set<string>;
  documents: VaultGraphDocument[];
  stemPaths: Map<string, string[]>;
}

const README = 'README.md';

function failUnsafe(): never {
  throw new VaultWriterError('UNSAFE_PATH');
}

export function compareCodePoints(first: string, second: string): number {
  const left = Array.from(first, character => character.codePointAt(0) as number);
  const right = Array.from(second, character => character.codePointAt(0) as number);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

export function stemIdentity(stem: string): string {
  return /^[\x00-\x7f]*$/.test(stem)
    ? stem.replace(/[A-Z]/g, character => character.toLowerCase())
    : stem;
}

function readUtf8(file: string): { bytes: Buffer; markdown: string; identity: string } {
  try {
    const entryStat = fs.lstatSync(file);
    const stat = fs.statSync(file);
    if (!stat.isFile()) failUnsafe();
    const canonical = fs.realpathSync(file);
    const bytes = fs.readFileSync(file);
    const markdown = bytes.toString('utf8');
    if (!Buffer.from(markdown, 'utf8').equals(bytes)) failUnsafe();
    const canonicalIdentity = crypto.createHash('sha256').update(canonical).digest('hex');
    return {
      bytes,
      markdown,
      identity: [
        entryStat.dev,
        entryStat.ino,
        stat.dev,
        stat.ino,
        canonicalIdentity,
      ].join(':'),
    };
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    failUnsafe();
  }
}

function lineRanges(markdown: string): Array<{ start: number; contentEnd: number; end: number }> {
  const result: Array<{ start: number; contentEnd: number; end: number }> = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline < 0 ? markdown.length : newline + 1;
    let contentEnd = newline < 0 ? markdown.length : newline;
    if (contentEnd > start && markdown[contentEnd - 1] === '\r') contentEnd -= 1;
    result.push({ start, contentEnd, end });
    start = end;
  }
  if (markdown.length === 0) result.push({ start: 0, contentEnd: 0, end: 0 });
  return result;
}

function maskRange(searchable: boolean[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) searchable[index] = false;
}

function isEscaped(markdown: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function buildSearchMask(markdown: string): boolean[] {
  const searchable = Array<boolean>(markdown.length).fill(true);
  const lines = lineRanges(markdown);
  let firstBodyLine = 0;

  if (lines.length > 0 && markdown.slice(lines[0].start, lines[0].contentEnd) === '---') {
    const closing = lines.findIndex((line, index) =>
      index > 0 && markdown.slice(line.start, line.contentEnd) === '---');
    if (closing >= 0) {
      maskRange(searchable, 0, lines[closing].end);
      firstBodyLine = closing + 1;
    }
  }

  let fence:
    | { marker: '`' | '~'; length: number; start: number }
    | undefined;
  for (let lineIndex = firstBodyLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const content = markdown.slice(line.start, line.contentEnd);
    if (fence) {
      maskRange(searchable, line.start, line.end);
      const closing = content.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        closing
        && closing[1][0] === fence.marker
        && closing[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }

    const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = {
        marker: opening[1][0] as '`' | '~',
        length: opening[1].length,
        start: line.start,
      };
      maskRange(searchable, line.start, line.end);
      continue;
    }

    let cursor = line.start;
    while (cursor < line.contentEnd) {
      if (markdown[cursor] !== '`' || isEscaped(markdown, cursor)) {
        cursor += 1;
        continue;
      }
      let openerEnd = cursor;
      while (openerEnd < line.contentEnd && markdown[openerEnd] === '`') openerEnd += 1;
      const length = openerEnd - cursor;
      let candidate = openerEnd;
      let closerEnd = -1;
      while (candidate < line.contentEnd) {
        if (markdown[candidate] !== '`') {
          candidate += 1;
          continue;
        }
        let runEnd = candidate;
        while (runEnd < line.contentEnd && markdown[runEnd] === '`') runEnd += 1;
        if (runEnd - candidate === length) {
          closerEnd = runEnd;
          break;
        }
        candidate = runEnd;
      }
      if (closerEnd < 0) {
        cursor = openerEnd;
        continue;
      }
      maskRange(searchable, cursor, closerEnd);
      cursor = closerEnd;
    }
  }

  if (fence) {
    for (let index = fence.start; index < markdown.length; index += 1) searchable[index] = true;
  }
  return searchable;
}

function allSearchable(searchable: boolean[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!searchable[index]) return false;
  }
  return true;
}

function parseWikilinks(markdown: string, searchable: boolean[]): VaultWikilink[] {
  const result: VaultWikilink[] = [];
  const pattern = /\[\[([^\]\r\n]+)\]\]/g;
  for (const match of markdown.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!allSearchable(searchable, start, end)) continue;
    const withoutAlias = match[1].split('|', 1)[0];
    const target = withoutAlias.split('#', 1)[0].trim();
    result.push({ raw: match[0], target, start, end });
    maskRange(searchable, start, end);
  }
  return result;
}

function walkMarkdownFiles(layout: ResolvedVaultLayout): string[] {
  const files: string[] = [];
  const activeCanonicalDirectories = new Set<string>();

  function walk(directory: string): void {
    assertSafeWriterPath(layout, directory, 'graph directory');
    let canonical: string;
    let entries: fs.Dirent[];
    try {
      const stat = fs.statSync(directory);
      if (!stat.isDirectory()) failUnsafe();
      canonical = fs.realpathSync(directory);
      if (activeCanonicalDirectories.has(canonical)) failUnsafe();
      activeCanonicalDirectories.add(canonical);
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof VaultWriterError) throw error;
      failUnsafe();
    }
    entries.sort((first, second) => compareCodePoints(first.name, second.name));
    try {
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        assertSafeWriterPath(layout, candidate, 'graph entry');
        let stat: fs.Stats;
        try {
          stat = fs.statSync(candidate);
        } catch {
          failUnsafe();
        }
        if (stat.isDirectory()) {
          walk(candidate);
        } else if (stat.isFile() && entry.name.endsWith('.md')) {
          files.push(candidate);
        }
      }
    } finally {
      activeCanonicalDirectories.delete(canonical);
    }
  }

  for (const root of Object.values(layout.layers)) walk(root);
  return files.sort((first, second) =>
    compareCodePoints(vaultRelative(layout, first), vaultRelative(layout, second)));
}

function normalizedQualifiedTarget(target: string): string | undefined {
  if (
    !target.includes('/')
    || target.startsWith('/')
    || target.includes('\\')
    || target.split('/').some(component => !component || component === '.' || component === '..')
  ) return undefined;
  return target.endsWith('.md') ? target.slice(0, -3) : target;
}

function resolveWikilink(
  target: string,
  qualifiedPaths: Map<string, string>,
  stemPaths: Map<string, string[]>,
): string | undefined {
  if (!target) return undefined;
  if (target.includes('/')) {
    const normalized = normalizedQualifiedTarget(target);
    return normalized === undefined ? undefined : qualifiedPaths.get(normalized);
  }
  const basename = target.endsWith('.md') ? target.slice(0, -3) : target;
  const matches = stemPaths.get(stemIdentity(basename)) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function snapshotVaultGraph(layout: ResolvedVaultLayout): VaultGraphSnapshot {
  const markdownFiles = walkMarkdownFiles(layout);
  const documents: VaultGraphDocument[] = [];
  const inputs: VaultGraphInput[] = [];
  const noteFiles: string[] = [];
  const stemPaths = new Map<string, string[]>();
  const qualifiedPaths = new Map<string, string>();

  for (const absolutePath of markdownFiles) {
    const relative = vaultRelative(layout, absolutePath);
    const { bytes, markdown, identity } = readUtf8(absolutePath);
    const isIndex = path.basename(absolutePath) === README;
    const searchable = buildSearchMask(markdown);
    const wikilinks = parseWikilinks(markdown, searchable);
    documents.push({
      path: relative,
      absolutePath,
      markdown,
      isIndex,
      wikilinks,
      searchable,
    });
    inputs.push({
      path: relative,
      identity,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    if (!isIndex) {
      noteFiles.push(relative);
      const stem = path.posix.basename(relative, '.md');
      const identity = stemIdentity(stem);
      const existing = stemPaths.get(identity) ?? [];
      existing.push(relative);
      stemPaths.set(identity, existing);
      qualifiedPaths.set(relative.slice(0, -3), relative);
    }
  }

  for (const matches of stemPaths.values()) matches.sort(compareCodePoints);
  noteFiles.sort(compareCodePoints);
  inputs.sort((first, second) => compareCodePoints(first.path, second.path));
  documents.sort((first, second) => compareCodePoints(first.path, second.path));

  const incoming = new Map<string, number>();
  const broken = new Set<string>();
  const brokenOrdinals = new Map<string, number>();
  for (const document of documents) {
    for (const link of document.wikilinks) {
      link.resolved = resolveWikilink(link.target, qualifiedPaths, stemPaths);
      if (link.resolved) {
        incoming.set(link.resolved, (incoming.get(link.resolved) ?? 0) + 1);
      } else {
        const ordinalKey = `${document.path}\0${link.target}`;
        const ordinal = (brokenOrdinals.get(ordinalKey) ?? 0) + 1;
        brokenOrdinals.set(ordinalKey, ordinal);
        broken.add(`${document.path}:${link.raw}:${ordinal}`);
      }
    }
  }
  const orphans = new Set(noteFiles.filter(file => (incoming.get(file) ?? 0) === 0));

  return {
    broken,
    noteFiles,
    inputs,
    incoming,
    orphans,
    documents,
    stemPaths,
  };
}

export function wikilinkTargetsPlannedNote(
  link: VaultWikilink,
  targetPath: string,
  targetStem: string,
): boolean {
  if (!link.target) return false;
  if (link.target.includes('/')) {
    return normalizedQualifiedTarget(link.target) === targetPath.replace(/\.md$/, '');
  }
  const basename = link.target.endsWith('.md') ? link.target.slice(0, -3) : link.target;
  return stemIdentity(basename) === stemIdentity(targetStem);
}

export function mentionOffsets(
  document: VaultGraphDocument,
  title: string,
  stem: string,
): number[] {
  const spans = new Map<string, number>();

  function add(start: number, end: number): void {
    if (!allSearchable(document.searchable, start, end)) return;
    spans.set(`${start}:${end}`, start);
  }

  if (title) {
    let start = 0;
    while (start <= document.markdown.length - title.length) {
      const found = document.markdown.indexOf(title, start);
      if (found < 0) break;
      add(found, found + title.length);
      start = found + 1;
    }
  }

  const foldedStem = stemIdentity(stem);
  for (let start = 0; start <= document.markdown.length - stem.length; start += 1) {
    const candidate = document.markdown.slice(start, start + stem.length);
    if (stemIdentity(candidate) === foldedStem) add(start, start + stem.length);
  }

  return [...spans.values()]
    .map(characterOffset =>
      Buffer.byteLength(document.markdown.slice(0, characterOffset), 'utf8'))
    .sort((first, second) => first - second);
}
