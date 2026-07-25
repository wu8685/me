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

function rangeIsSearchable(searchable: boolean[], start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!searchable[index]) return false;
  }
  return true;
}

/**
 * Return a character-aligned mask for Markdown outside fenced and inline code.
 * An optional initial mask lets callers exclude frontmatter or other block
 * regions without permitting a code span to bridge across them.
 */
export function markdownCodeSearchMask(
  markdown: string,
  initial?: boolean[],
): boolean[] {
  if (initial && initial.length !== markdown.length) {
    throw new Error('Markdown mask length mismatch.');
  }
  const searchable = initial
    ? [...initial]
    : Array<boolean>(markdown.length).fill(true);
  const lines = lineRanges(markdown);
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const line of lines) {
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
    if (!rangeIsSearchable(searchable, line.start, line.contentEnd)) continue;
    const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = {
        marker: opening[1][0] as '`' | '~',
        length: opening[1].length,
      };
      maskRange(searchable, line.start, line.end);
    }
  }

  for (let index = 0; index < markdown.length;) {
    if (!searchable[index] || markdown[index] !== '`' || isEscaped(markdown, index)) {
      index += 1;
      continue;
    }
    let openerEnd = index;
    while (openerEnd < markdown.length && searchable[openerEnd] && markdown[openerEnd] === '`') {
      openerEnd += 1;
    }
    const openerLength = openerEnd - index;
    let candidate = openerEnd;
    let closerEnd = -1;
    while (candidate < markdown.length) {
      if (!searchable[candidate]) break;
      if (markdown[candidate] !== '`') {
        candidate += 1;
        continue;
      }
      let runEnd = candidate;
      while (runEnd < markdown.length && searchable[runEnd] && markdown[runEnd] === '`') {
        runEnd += 1;
      }
      if (runEnd - candidate === openerLength) {
        closerEnd = runEnd;
        break;
      }
      candidate = runEnd;
    }
    if (closerEnd < 0) {
      index = openerEnd;
      continue;
    }
    maskRange(searchable, index, closerEnd);
    index = closerEnd;
  }
  return searchable;
}
