import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  CapabilityReport,
  ExtractContext,
  ExtractedSource,
  MediaAsset,
  SourceAdapter,
  SourceBlock,
} from '../contracts.ts';
import type { CommandRunner } from '../command.ts';

const PDF_DEPENDENCIES = ['curl', 'pdftotext', 'pdftohtml'];
const CAPTION_PREFIX = /^(?:Figure\b|Fig\.|图)/i;
const ENCRYPTION_ERROR = /\b(?:encrypted|encryption|password|drm|protected)\b/i;

interface XmlItem {
  kind: 'text' | 'image';
  top: number;
  left: number;
  width: number;
  height: number;
  value: string;
  page: number;
}

function blockId(index: number): string {
  return `block-${String(index).padStart(3, '0')}`;
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2];
}

function numericAttribute(tag: string, name: string): number {
  const value = Number.parseFloat(attribute(tag, name) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAdjacentCaption(figure: XmlItem, candidate: XmlItem): boolean {
  if (candidate.page !== figure.page || candidate.kind !== 'text' || !CAPTION_PREFIX.test(candidate.value)) return false;
  const figureBottom = figure.top + figure.height;
  const verticalGap = candidate.top - figureBottom;
  const horizontalGap = Math.abs(candidate.left - figure.left);
  return verticalGap >= 0 && verticalGap <= 72 && horizontalGap <= 48;
}

function figureMarkdown(asset: Pick<MediaAsset, 'path' | 'caption'>): string {
  return `![${asset.caption ?? 'Figure'}](${asset.path ?? ''})`;
}

/** Convert pdftohtml XML into source-order text and figure blocks. */
export function parsePdftohtmlXml(xml: string): { blocks: SourceBlock[]; media: MediaAsset[] } {
  const items: XmlItem[] = [];
  const pagePattern = /<page\b([^>]*)>([\s\S]*?)<\/page>/gi;
  let pageMatch: RegExpExecArray | null;

  while ((pageMatch = pagePattern.exec(xml)) !== null) {
    const page = Math.max(1, Math.trunc(numericAttribute(pageMatch[1], 'number')) || 1);
    const childPattern = /<(text|image)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
    let childMatch: RegExpExecArray | null;
    while ((childMatch = childPattern.exec(pageMatch[2])) !== null) {
      const kind = childMatch[1].toLowerCase() as XmlItem['kind'];
      const value = kind === 'image'
        ? attribute(childMatch[2], 'src') ?? ''
        : decodeXml(childMatch[3] ?? '');
      if (!value) continue;
      items.push({
        kind,
        top: numericAttribute(childMatch[2], 'top'),
        left: numericAttribute(childMatch[2], 'left'),
        width: numericAttribute(childMatch[2], 'width'),
        height: numericAttribute(childMatch[2], 'height'),
        value,
        page,
      });
    }
  }

  const blocks: SourceBlock[] = [];
  const media: MediaAsset[] = [];
  const captionIndexes = new Set<number>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (captionIndexes.has(index)) continue;
    if (item.kind === 'text') {
      blocks.push({ id: blockId(blocks.length + 1), kind: 'paragraph', markdown: item.value, page: item.page });
      continue;
    }

    const id = `figure-${media.length + 1}`;
    const next = items[index + 1];
    const caption = next && isAdjacentCaption(item, next) ? next.value : undefined;
    if (caption) captionIndexes.add(index + 1);
    media.push({ id, kind: 'figure', path: item.value, ...(caption ? { caption } : {}), page: item.page });
    blocks.push({ id: blockId(blocks.length + 1), kind: 'figure', markdown: figureMarkdown({ path: item.value, caption }), mediaId: id, page: item.page });
  }

  return { blocks, media };
}

function missingDependencies(runner: CommandRunner): string[] {
  return PDF_DEPENDENCIES.filter((dependency) => {
    try {
      return runner.run('which', [dependency], { timeoutMs: 5000 }).status !== 0;
    } catch {
      return true;
    }
  });
}

function isEncryptedOrDrm(cause: unknown): boolean {
  if (!(cause instanceof Error)) return ENCRYPTION_ERROR.test(String(cause));
  const stderr = (cause as Error & { stderr?: unknown }).stderr;
  return ENCRYPTION_ERROR.test(`${cause.message} ${typeof stderr === 'string' ? stderr : ''}`);
}

function run(runner: CommandRunner, command: string, args: string[], timeoutMs: number): void {
  const result = runner.run(command, args, { timeoutMs });
  if (result.status !== 0) {
    const failure = new Error(`${command} failed with exit code ${result.status}`) as Error & { stderr?: string };
    failure.stderr = result.stderr;
    throw failure;
  }
}

/** Read the final HTTP Content-Type without downloading the response body. */
export async function probePdfContentType(runner: CommandRunner, url: URL): Promise<string | undefined> {
  try {
    const result = runner.run('curl', ['-sS', '-L', '--fail', '--max-time', '15', '-I', '-o', '/dev/null', '-w', '%{content_type}', url.toString()], { timeoutMs: 18000 });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function temporaryDirectory(context: ExtractContext): string {
  const root = context.tempDir ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'me-ingest-pdf-'));
}

function downloadAndExtractText(runner: CommandRunner, url: URL, directory: string): { pdfPath: string; textPath: string } {
  const pdfPath = path.join(directory, 'source.pdf');
  const textPath = path.join(directory, 'source.txt');
  run(runner, 'curl', ['-L', '--fail', '--max-time', '30', '-o', pdfPath, url.toString()], 35000);
  run(runner, 'pdftotext', ['-layout', pdfPath, textPath], 30000);
  return { pdfPath, textPath };
}

function sourceTitle(url: URL): string {
  const filename = path.basename(decodeURIComponent(url.pathname)).replace(/\.pdf$/i, '');
  return filename || 'Untitled PDF';
}

function reportForMissingDependencies(missing: string[]): CapabilityReport {
  return {
    adapterId: 'pdf',
    readable: false,
    capabilities: [],
    missingDependencies: missing,
    degradation: 'partial',
    warnings: missing.map((dependency) => `missing-dependency:${dependency}`),
  };
}

function persistFigureAssets(
  media: MediaAsset[],
  workingDirectory: string,
  context: ExtractContext,
): { media: MediaAsset[]; warnings: string[] } {
  const figures = media.filter((asset) => asset.kind === 'figure' && asset.path);
  if (figures.length === 0) return { media, warnings: [] };

  const assetRoot = context.tempDir ?? path.join(context.vaultDir, '.me', 'tmp');
  fs.mkdirSync(assetRoot, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(assetRoot, 'me-ingest-pdf-assets-'));
  const root = path.resolve(workingDirectory);
  const warnings: string[] = [];
  const persisted = media.map((asset) => {
    if (asset.kind !== 'figure' || !asset.path) return asset;
    const source = path.resolve(workingDirectory, asset.path);
    if ((source !== root && !source.startsWith(root + path.sep)) || !fs.existsSync(source)) {
      warnings.push(`figure-asset-missing:${asset.id}`);
      const { path: _ignored, ...withoutPath } = asset;
      return withoutPath;
    }
    const extension = path.extname(asset.path);
    const destination = path.join(outputDirectory, `${asset.id}${extension}`);
    fs.copyFileSync(source, destination);
    return { ...asset, path: destination };
  });
  return { media: persisted, warnings };
}

function rewriteFigureBlocks(blocks: SourceBlock[], media: MediaAsset[]): SourceBlock[] {
  const figures = new Map(media.filter((asset) => asset.kind === 'figure' && asset.path).map((asset) => [asset.id, asset]));
  return blocks.map((block) => {
    const figure = block.mediaId ? figures.get(block.mediaId) : undefined;
    return figure ? { ...block, markdown: figureMarkdown(figure) } : block;
  });
}

export function createPdfAdapter(runner: CommandRunner): SourceAdapter {
  return {
    id: 'pdf',
    matches: (url) => /\.pdf$/i.test(url.pathname),
    matchesContentType: (contentType) => /^application\/pdf(?:\s*;|$)/i.test(contentType),
    async probe(context): Promise<CapabilityReport> {
      const missing = missingDependencies(runner);
      if (missing.length > 0) return reportForMissingDependencies(missing);

      const directory = temporaryDirectory(context);
      try {
        const { pdfPath, textPath } = downloadAndExtractText(runner, context.url, directory);
        run(runner, 'pdftohtml', ['-xml', '-hidden', '-nodrm', pdfPath, path.join(directory, 'source.xml')], 30000);
        const text = fs.readFileSync(textPath, 'utf8').trim();
        if (!text) {
          return {
            adapterId: 'pdf',
            readable: false,
            capabilities: ['body', 'images', 'captions'],
            degradation: 'partial',
            warnings: ['ocr-required'],
          };
        }
        return {
          adapterId: 'pdf',
          readable: true,
          capabilities: ['body', 'images', 'captions'],
          degradation: 'none',
          warnings: [],
        };
      } catch (cause) {
        if (isEncryptedOrDrm(cause)) {
          return {
            adapterId: 'pdf',
            readable: false,
            capabilities: [],
            degradation: 'blocked',
            warnings: ['encrypted-or-drm'],
          };
        }
        throw cause;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    async extract(context): Promise<ExtractedSource> {
      const missing = missingDependencies(runner);
      if (missing.length > 0) throw new Error(`Missing PDF dependencies: ${missing.join(', ')}`);

      const directory = temporaryDirectory(context);
      try {
        const { pdfPath, textPath } = downloadAndExtractText(runner, context.url, directory);
        const xmlPath = path.join(directory, 'source.xml');
        run(runner, 'pdftohtml', ['-xml', '-hidden', '-nodrm', pdfPath, xmlPath], 30000);
        const text = fs.readFileSync(textPath, 'utf8').trim();
        const { blocks, media } = parsePdftohtmlXml(fs.readFileSync(xmlPath, 'utf8'));
        const figures = persistFigureAssets(media, directory, context);
        return {
          source: { url: context.url.toString(), kind: 'paper', title: sourceTitle(context.url) },
          blocks: rewriteFigureBlocks(blocks, figures.media),
          media: figures.media,
          provenance: {
            extractor: 'poppler',
            extractedAt: new Date().toISOString(),
            methods: ['curl', 'pdftotext -layout', 'pdftohtml -xml -hidden -nodrm'],
          },
          warnings: [...(text ? [] : ['ocr-required']), ...figures.warnings],
        };
      } catch (cause) {
        if (isEncryptedOrDrm(cause)) throw new Error('PDF is encrypted or DRM-protected');
        throw cause;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
