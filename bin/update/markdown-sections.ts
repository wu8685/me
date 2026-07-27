import { UpdateError } from './contracts';

export interface ManagedSectionMergeResult {
  content: string;
  adoptedLegacySections: string[];
}

export type UnmarkedManagedAssetPolicy =
  | 'adopt-known-legacy'
  | 'append-marked-block'
  | 'conflict';

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

interface ManagedBlock {
  id: string;
  start: number;
  end: number;
  content: string;
}

interface Heading {
  level: number;
  title: string;
  start: number;
}

interface LegacySection {
  id: string;
  start: number;
  end: number;
}

const OWNED_HEADINGS = Object.freeze([
  { id: 'knowledge-base', level: 1, title: 'Knowledge Base' },
  { id: 'configuration', level: 2, title: 'Configuration' },
  { id: 'layer-map', level: 2, title: 'Layer Map' },
  { id: 'commands', level: 2, title: 'Commands' },
  { id: 'note-templates', level: 2, title: 'Note Templates' },
  { id: 'after-creating-a-note', level: 2, title: 'After Creating a Note' },
  { id: 'search', level: 2, title: 'Search' },
  { id: 'conventions', level: 2, title: 'Conventions' },
] as const);

const OWNED_BY_HEADING = new Map(
  OWNED_HEADINGS.map(owned => [`${owned.level}:${owned.title}`, owned]),
);

function conflict(): never {
  throw new UpdateError('MIGRATION_CONFLICT');
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline + 1;
    let text = source.slice(start, newline === -1 ? source.length : newline);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push({ start, end, text });
    start = end;
  }
  return lines;
}

function fenceToken(line: string): { character: '`' | '~'; length: number } | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return undefined;
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
  };
}

function closesFence(
  line: string,
  fence: { character: '`' | '~'; length: number },
): boolean {
  const escaped = fence.character === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${escaped}{${fence.length},}[ \\t]*$`).test(line);
}

function parseManagedBlocks(source: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  const ids = new Set<string>();
  let open: { id: string; start: number } | undefined;
  let fence: { character: '`' | '~'; length: number } | undefined;

  for (const line of sourceLines(source)) {
    if (fence) {
      if (closesFence(line.text, fence)) fence = undefined;
      continue;
    }
    const openedFence = fenceToken(line.text);
    if (openedFence) {
      fence = openedFence;
      continue;
    }

    const start = line.text.match(
      /^<!-- me:managed:start ([a-z0-9]+(?:-[a-z0-9]+)*) -->$/,
    );
    const end = line.text.match(
      /^<!-- me:managed:end ([a-z0-9]+(?:-[a-z0-9]+)*) -->$/,
    );
    if (
      (!start && line.text.includes('<!-- me:managed:start'))
      || (!end && line.text.includes('<!-- me:managed:end'))
    ) conflict();
    if (start) {
      if (open || ids.has(start[1])) conflict();
      open = { id: start[1], start: line.start };
      continue;
    }
    if (end) {
      if (!open || open.id !== end[1]) conflict();
      ids.add(open.id);
      blocks.push({
        id: open.id,
        start: open.start,
        end: line.end,
        content: source.slice(open.start, line.end),
      });
      open = undefined;
    }
  }
  if (open) conflict();
  return blocks;
}

function parseHeadings(source: string): Heading[] {
  const headings: Heading[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (const line of sourceLines(source)) {
    if (fence) {
      if (closesFence(line.text, fence)) fence = undefined;
      continue;
    }
    const openedFence = fenceToken(line.text);
    if (openedFence) {
      fence = openedFence;
      continue;
    }
    const match = line.text.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/);
    if (!match) continue;
    const title = (match[2] ?? '')
      .replace(/[ \t]+#+[ \t]*$/, '')
      .trim();
    headings.push({ level: match[1].length, title, start: line.start });
  }
  return headings;
}

function normalizedHeading(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function resemblesOwnedHeading(heading: Heading): boolean {
  const current = normalizedHeading(heading.title);
  return OWNED_HEADINGS.some(owned => {
    if (heading.level !== owned.level) return false;
    const expected = normalizedHeading(owned.title);
    return current === expected
      || current.startsWith(`${expected} `)
      || expected.startsWith(`${current} `);
  });
}

function legacySections(source: string): LegacySection[] {
  const headings = parseHeadings(source);
  const seen = new Set<string>();
  const sections: LegacySection[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const owned = OWNED_BY_HEADING.get(`${heading.level}:${heading.title}`);
    if (!owned) {
      if (resemblesOwnedHeading(heading)) conflict();
      continue;
    }
    if (seen.has(owned.id)) conflict();
    seen.add(owned.id);
    let end = source.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      const boundaryLevel = owned.level === 1 ? 2 : owned.level;
      if (headings[next].level <= boundaryLevel) {
        end = headings[next].start;
        break;
      }
    }
    sections.push({ id: owned.id, start: heading.start, end });
  }
  return sections;
}

function appendMarkedTemplate(current: string, desiredTemplate: string): string {
  if (!current) return desiredTemplate;
  return `${current}${current.endsWith('\n') ? '\n' : '\n\n'}${desiredTemplate}`;
}

function replaceRanges(
  current: string,
  ranges: ReadonlyArray<{ id: string; start: number; end: number }>,
  desired: ReadonlyMap<string, ManagedBlock>,
): string {
  let result = current;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    const replacement = desired.get(range.id);
    if (!replacement) conflict();
    result = result.slice(0, range.start) + replacement.content + result.slice(range.end);
  }
  return result;
}

function mergeMarkedBlocks(
  current: string,
  currentBlocks: readonly ManagedBlock[],
  desiredBlocks: readonly ManagedBlock[],
): string {
  const desiredIndexes = new Map(
    desiredBlocks.map((block, index) => [block.id, index]),
  );
  const indexes = currentBlocks.map(block => desiredIndexes.get(block.id));
  if (indexes.some(index => index === undefined)) conflict();
  for (let index = 1; index < indexes.length; index += 1) {
    if ((indexes[index - 1] as number) >= (indexes[index] as number)) conflict();
  }

  let result = '';
  let sourceOffset = 0;
  let desiredOffset = 0;
  for (let index = 0; index < currentBlocks.length; index += 1) {
    const currentBlock = currentBlocks[index];
    const desiredIndex = indexes[index] as number;
    result += current.slice(sourceOffset, currentBlock.start);
    result += desiredBlocks
      .slice(desiredOffset, desiredIndex)
      .map(block => block.content)
      .join('');
    result += desiredBlocks[desiredIndex].content;
    sourceOffset = currentBlock.end;
    desiredOffset = desiredIndex + 1;
  }
  result += current.slice(sourceOffset);
  const trailing = desiredBlocks
    .slice(desiredOffset)
    .map(block => block.content)
    .join('');
  if (trailing) {
    result += `${result.endsWith('\n') ? '\n' : '\n\n'}${trailing}`;
  }
  return result;
}

export function mergeMeOwnedSections(
  current: string,
  desiredTemplate: string,
  onUnmarked: UnmarkedManagedAssetPolicy,
): ManagedSectionMergeResult {
  const desiredBlocks = parseManagedBlocks(desiredTemplate);
  if (desiredBlocks.length === 0) conflict();
  const desired = new Map(desiredBlocks.map(block => [block.id, block]));
  const currentBlocks = parseManagedBlocks(current);

  if (currentBlocks.length > 0) {
    for (const block of currentBlocks) {
      if (!desired.has(block.id)) conflict();
    }
    return {
      content: mergeMarkedBlocks(current, currentBlocks, desiredBlocks),
      adoptedLegacySections: [],
    };
  }

  if (onUnmarked === 'conflict') conflict();
  const legacy = legacySections(current);
  if (onUnmarked === 'append-marked-block') {
    if (legacy.length > 0) conflict();
    return {
      content: appendMarkedTemplate(current, desiredTemplate),
      adoptedLegacySections: [],
    };
  }
  if (onUnmarked !== 'adopt-known-legacy' || legacy.length === 0) conflict();

  const presentIds = new Set(legacy.map(section => section.id));
  const replaced = replaceRanges(current, legacy, desired);
  const missing = desiredBlocks
    .filter(block => !presentIds.has(block.id))
    .map(block => block.content)
    .join('');
  return {
    content: missing
      ? `${replaced}${replaced.endsWith('\n') ? '\n' : '\n\n'}${missing}`
      : replaced,
    adoptedLegacySections: legacy.map(section => section.id),
  };
}

export const ME_OWNED_SECTION_IDS = Object.freeze(
  OWNED_HEADINGS.map(section => section.id),
);
