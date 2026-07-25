import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CapabilityReport,
  ExtractContext,
  ExtractedSource,
  SourceAdapter,
  SourceBlock,
} from '../contracts.ts';
import type { CommandRunner } from '../command.ts';
import { markdownToSourceParts } from './html.ts';

const MINIMUM_ARTICLE_VISIBLE_CHARACTERS = 200;
const LOGIN_TITLE = /^(?:log\s*in|sign\s*in|登录|登入)(?:\s+to\s+(?:x|twitter))?\b/i;
const LOGIN_MARKER = /(?:\/i\/flow\/login|log\s*in\s+to\s+(?:x|twitter)|sign\s*in\s+to\s+(?:x|twitter)|create\s+account|join\s+(?:x|twitter)|登录(?:\s*(?:X|Twitter))?)/i;
const VIDEO_PROBE_NOT_VIDEO = /(?:unsupported\s+url|not\s+a\s+video|no\s+video\s+formats?)/i;
const VIDEO_PROBE_AUTH_REQUIRED = /(?:log\s*in|sign\s*in|authentication|cookies?|private\s+video|not\s+available\s+to\s+you)/i;

interface YtDlpMetadata {
  id: string;
  title?: string;
  uploader?: string;
  channel?: string;
  timestamp?: number;
  duration?: number;
  ext?: string;
  webpage_url?: string;
  description?: string;
}

function titleFromMarkdown(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)/m) || markdown.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return match ? match[1].trim() : 'Untitled';
}

function hasVisibleArticleBody(markdown: string): boolean {
  const visible = markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^title:\s*.*$/gim, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return visible.length >= MINIMUM_ARTICLE_VISIBLE_CHARACTERS;
}

function isXHostname(hostname: string): boolean {
  return hostname === 'x.com' || hostname.endsWith('.x.com')
    || hostname === 'twitter.com' || hostname.endsWith('.twitter.com');
}

function parseVideoMetadata(value: string): YtDlpMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) return undefined;
  const videoEvidence = typeof metadata.duration === 'number'
    || typeof metadata.ext === 'string'
    || typeof metadata.url === 'string'
    || Array.isArray(metadata.formats);
  if (!videoEvidence) return undefined;
  return {
    id: metadata.id,
    ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
    ...(typeof metadata.uploader === 'string' ? { uploader: metadata.uploader } : {}),
    ...(typeof metadata.channel === 'string' ? { channel: metadata.channel } : {}),
    ...(typeof metadata.timestamp === 'number' ? { timestamp: metadata.timestamp } : {}),
    ...(typeof metadata.duration === 'number' ? { duration: metadata.duration } : {}),
    ...(typeof metadata.ext === 'string' ? { ext: metadata.ext } : {}),
    ...(typeof metadata.webpage_url === 'string' ? { webpage_url: metadata.webpage_url } : {}),
    ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
  };
}

function videoProbeFailure(detail: string): undefined {
  if (VIDEO_PROBE_NOT_VIDEO.test(detail)) return undefined;
  if (VIDEO_PROBE_AUTH_REQUIRED.test(detail)) {
    throw new Error('auth-required: X Video is not publicly readable');
  }
  throw new Error(`extraction-failed: yt-dlp video probe failed${detail ? `: ${detail}` : ''}`);
}

function probeVideoMetadata(runner: CommandRunner, url: URL): YtDlpMetadata | undefined {
  let result: ReturnType<CommandRunner['run']>;
  try {
    result = runner.run('yt-dlp', ['--dump-single-json', url.toString()], { timeoutMs: 30000 });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return videoProbeFailure(detail);
  }
  return result.status === 0 ? parseVideoMetadata(result.stdout) : videoProbeFailure(result.stderr);
}

function requirePublicArticle(markdown: string): void {
  const title = titleFromMarkdown(markdown);
  if (LOGIN_TITLE.test(title) || LOGIN_MARKER.test(markdown) || !hasVisibleArticleBody(markdown)) {
    throw new Error('auth-required: X Article is not publicly readable');
  }
}

function extractArticle(runner: CommandRunner, url: URL): ExtractedSource {
  const result = runner.run('defuddle', ['parse', url.toString(), '--md'], { timeoutMs: 30000 });
  if (result.status !== 0) throw new Error(`defuddle failed with exit code ${result.status}`);
  requirePublicArticle(result.stdout);
  const { blocks, media } = markdownToSourceParts(result.stdout);
  return {
    source: { url: url.toString(), kind: 'article', title: titleFromMarkdown(result.stdout) },
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

function safeExtension(extension: string | undefined): string {
  return extension && /^[a-z0-9]{1,10}$/i.test(extension) ? extension.toLowerCase() : 'mp4';
}

function persistentVideoPath(context: ExtractContext, url: URL, metadata: YtDlpMetadata): string {
  const directory = path.join(context.vaultDir, '.me', 'ingest-media');
  fs.mkdirSync(directory, { recursive: true });
  const hash = createHash('sha256').update(`${url.toString()}\0${metadata.id}`).digest('hex').slice(0, 16);
  return path.join(directory, `x-video-${hash}.${safeExtension(metadata.ext)}`);
}

function videoBlocks(metadata: YtDlpMetadata): SourceBlock[] {
  const title = metadata.title?.trim() || 'Untitled X video';
  const blocks: SourceBlock[] = [{ id: 'block-001', kind: 'heading', markdown: `# ${title}` }];
  if (metadata.description?.trim()) {
    blocks.push({ id: 'block-002', kind: 'paragraph', markdown: metadata.description.trim() });
  }
  return blocks;
}

function extractVideo(runner: CommandRunner, context: ExtractContext, url: URL, metadata: YtDlpMetadata): ExtractedSource {
  const outputPath = persistentVideoPath(context, url, metadata);
  const result = runner.run('yt-dlp', ['-o', outputPath, url.toString()], { timeoutMs: 600000 });
  if (result.status !== 0) throw new Error(`yt-dlp failed with exit code ${result.status}`);
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    throw new Error('yt-dlp did not produce a persistent video file');
  }
  const title = metadata.title?.trim() || 'Untitled X video';
  return {
    source: {
      url: url.toString(),
      ...(metadata.webpage_url ? { canonicalUrl: metadata.webpage_url } : {}),
      kind: 'video',
      title,
      ...(metadata.uploader || metadata.channel ? { author: metadata.uploader ?? metadata.channel } : {}),
      ...(metadata.timestamp ? { publishedAt: new Date(metadata.timestamp * 1000).toISOString() } : {}),
      ...(typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) ? { durationSec: metadata.duration } : {}),
    },
    blocks: videoBlocks(metadata),
    media: [{ id: 'video-001', kind: 'video', path: outputPath, url: url.toString() }],
    provenance: {
      extractor: 'yt-dlp',
      extractedAt: new Date().toISOString(),
      methods: ['yt-dlp --dump-single-json', 'yt-dlp -o'],
    },
    warnings: [],
  };
}

export function createXAdapter(runner: CommandRunner): SourceAdapter {
  return {
    id: 'x',
    matches: (url) => isXHostname(url.hostname),
    async probe(context): Promise<CapabilityReport> {
      const metadata = probeVideoMetadata(runner, context.url);
      if (metadata) {
        return {
          adapterId: 'x', readable: true, capabilities: ['video', 'audio'], degradation: 'none', warnings: [],
        };
      }
      try {
        extractArticle(runner, context.url);
        return {
          adapterId: 'x', readable: true, capabilities: ['body', 'images'], degradation: 'none', warnings: [],
        };
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('auth-required')) {
          return {
            adapterId: 'x', readable: false, capabilities: [], degradation: 'blocked', warnings: ['auth-required'],
          };
        }
        throw cause;
      }
    },
    async extract(context): Promise<ExtractedSource> {
      const metadata = probeVideoMetadata(runner, context.url);
      return metadata ? extractVideo(runner, context, context.url, metadata) : extractArticle(runner, context.url);
    },
  };
}
