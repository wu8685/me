import type {
  CapabilityReport,
  ExtractedSource,
  MediaAsset,
  SourceAdapter,
  SourceBlock,
} from '../contracts.ts';
import type { CommandRunner } from '../command.ts';

function titleFromMarkdown(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)/m) || markdown.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return match ? match[1].trim() : 'Untitled';
}

function blockId(index: number): string {
  return `block-${String(index).padStart(3, '0')}`;
}

function markdownOutsideInlineCode(line: string): string {
  const visible = line.split('');
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`' || (index > 0 && line[index - 1] === '\\')) {
      index += 1;
      continue;
    }
    let openerEnd = index;
    while (line[openerEnd] === '`') openerEnd += 1;
    const openerLength = openerEnd - index;
    let cursor = openerEnd;
    let closerEnd = -1;
    while (cursor < line.length) {
      if (line[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      let runEnd = cursor;
      while (line[runEnd] === '`') runEnd += 1;
      if (runEnd - cursor === openerLength) {
        closerEnd = runEnd;
        break;
      }
      cursor = runEnd;
    }
    if (closerEnd < 0) {
      index = openerEnd;
      continue;
    }
    visible.fill(' ', index, closerEnd);
    index = closerEnd;
  }
  return visible.join('');
}

/** Convert the Markdown emitted by defuddle into ordered source blocks and media. */
export function markdownToSourceParts(markdown: string): { blocks: SourceBlock[]; media: MediaAsset[] } {
  const blocks: SourceBlock[] = [];
  const media: MediaAsset[] = [];
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const lines = normalizedMarkdown.split('\n');
  let paragraph: string[] = [];
  let fence: { marker: '`' | '~'; length: number; lines: string[] } | undefined;

  const addBlock = (kind: SourceBlock['kind'], value: string, mediaId?: string) => {
    blocks.push({ id: blockId(blocks.length + 1), kind, markdown: value, ...(mediaId ? { mediaId } : {}) });
  };
  const flushParagraph = () => {
    const value = paragraph.join('\n').trim();
    if (value) addBlock('paragraph', value);
    paragraph = [];
  };

  for (const line of lines) {
    if (fence) {
      fence.lines.push(line);
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        closing
        && closing[1][0] === fence.marker
        && closing[1].length >= fence.length
      ) {
        addBlock('code', fence.lines.join('\n'));
        fence = undefined;
      }
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      flushParagraph();
      fence = {
        marker: opening[1][0] as '`' | '~',
        length: opening[1].length,
        lines: [line],
      };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    imagePattern.lastIndex = 0;
    const images = [...markdownOutsideInlineCode(line).matchAll(imagePattern)];
    if (heading && images.length === 0) {
      flushParagraph();
      addBlock('heading', line);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    if (images.length === 0) {
      paragraph.push(line);
      continue;
    }

    let cursor = 0;
    for (const image of images) {
      const before = line.slice(cursor, image.index).trim();
      if (before) paragraph.push(before);
      flushParagraph();

      const asset: MediaAsset = {
        id: `image-${String(media.length + 1).padStart(3, '0')}`,
        kind: 'image',
        url: image[2],
        ...(image[1] ? { alt: image[1] } : {}),
      };
      media.push(asset);
      addBlock('image', image[0], asset.id);
      cursor = image.index + image[0].length;
    }
    const after = line.slice(cursor).trim();
    if (after) paragraph.push(after);
  }
  flushParagraph();
  if (fence) addBlock('code', fence.lines.join('\n'));

  return { blocks, media };
}

export function extractHtmlSource(runner: CommandRunner, url: URL, originalUrl = url.toString()): ExtractedSource {
  const result = runner.run('defuddle', ['parse', originalUrl, '--md'], { timeoutMs: 30000 });
  if (result.status !== 0) {
    throw new Error(`defuddle failed with exit code ${result.status}`);
  }
  const { blocks, media } = markdownToSourceParts(result.stdout);
  return {
    source: { url: originalUrl, canonicalUrl: url.toString(), kind: 'article', title: titleFromMarkdown(result.stdout) },
    blocks,
    media,
    provenance: {
      extractor: 'defuddle',
      extractedAt: new Date().toISOString(),
      methods: ['defuddle parse --md'],
    },
    warnings: [],
  };
}

export function createHtmlAdapter(runner: CommandRunner): SourceAdapter {
  return {
    id: 'html',
    fallback: true,
    matches: () => true,
    async probe(): Promise<CapabilityReport> {
      return {
        adapterId: 'html',
        readable: true,
        capabilities: ['body', 'images'],
        degradation: 'none',
        warnings: [],
      };
    },
    async extract(context): Promise<ExtractedSource> {
      return extractHtmlSource(runner, context.url);
    },
  };
}
