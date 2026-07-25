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
  const normalizedMarkdown = markdown.replace(/\r\n/g, '\n');
  const imagePattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const imageOccurrences = Array.from(normalizedMarkdown.matchAll(imagePattern), (match, index) => ({
    offset: match.index!,
    media: {
      id: `image-${String(index + 1).padStart(3, '0')}`,
      kind: 'image' as const,
      url: match[2],
      alt: match[1] || undefined,
    },
  }));
  const media = imageOccurrences.map((occurrence) => occurrence.media);
  const lines = normalizedMarkdown.split('\n');
  let paragraph: string[] = [];
  let lineOffset = 0;

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
    const image = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (heading) {
      flushParagraph();
      addBlock('heading', line);
      lineOffset += line.length + 1;
      continue;
    }
    if (image) {
      flushParagraph();
      const occurrence = imageOccurrences.find((candidate) => candidate.offset === lineOffset);
      addBlock('image', line, occurrence?.media.id);
      lineOffset += line.length + 1;
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      lineOffset += line.length + 1;
      continue;
    }
    paragraph.push(line);
    lineOffset += line.length + 1;
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
