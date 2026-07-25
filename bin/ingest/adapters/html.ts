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

/** Convert the Markdown emitted by defuddle into ordered source blocks and media. */
export function markdownToSourceParts(markdown: string): { blocks: SourceBlock[]; media: MediaAsset[] } {
  const blocks: SourceBlock[] = [];
  const media: MediaAsset[] = [];
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const lines = normalizedMarkdown.split('\n');
  let paragraph: string[] = [];

  const addBlock = (kind: SourceBlock['kind'], value: string, mediaId?: string) => {
    blocks.push({ id: blockId(blocks.length + 1), kind, markdown: value, ...(mediaId ? { mediaId } : {}) });
  };
  const flushParagraph = () => {
    const value = paragraph.join('\n').trim();
    if (value) addBlock('paragraph', value);
    paragraph = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    imagePattern.lastIndex = 0;
    const images = [...line.matchAll(imagePattern)];
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
