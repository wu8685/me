import { randomUUID } from 'crypto';
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
import { markdownToSourceParts } from './html.ts';

const MINIMUM_ARTICLE_VISIBLE_CHARACTERS = 200;
const LOGIN_TITLE = /^(?:log\s*in|sign\s*in)(?:\s+to\s+(?:x|twitter))?$|^(?:登录|登入)(?:\s*(?:x|twitter))?$/i;
const LOGIN_PAGE_MARKER = /(?:\/i\/flow\/login|(?:^|\n)\s*(?:log\s*in|sign\s*in)\s+to\s+(?:x|twitter)\s*(?:\n|$))/i;
const VIDEO_PROBE_NOT_VIDEO = /(?:unsupported\s+url|not\s+a\s+video|no\s+video\s+formats?|no\s+video\s+could\s+be\s+found\s+in\s+this\s+tweet)/i;
const VIDEO_PROBE_AUTH_REQUIRED = /(?:log\s*in|sign\s*in|authentication|cookies?|private\s+video|not\s+available\s+to\s+you)/i;

interface XMediaMetadata {
  id: string;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  durationSec?: number;
  description?: string;
  kind: 'video' | 'audio';
  hasAudio: boolean;
}

interface XVideoProbe {
  kind: 'video';
  title: string;
  author?: string;
  publishedAt?: string;
  media: XMediaMetadata[];
}

type XProbe = XVideoProbe | { kind: 'not-video' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function toPublishedAt(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function requiresHttpUrl(value: string | undefined, label: string): string {
  if (!value) throw new Error(`extraction-failed: yt-dlp ${label} is missing`);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('non-http URL');
  } catch {
    throw new Error(`extraction-failed: yt-dlp ${label} is invalid`);
  }
  return value;
}

function codecFields(entry: Record<string, unknown>): Array<{ video?: string; audio?: string }> {
  const codecs = [{ video: stringField(entry, 'vcodec'), audio: stringField(entry, 'acodec') }];
  if (Array.isArray(entry.formats)) {
    for (const format of entry.formats) {
      const item = record(format);
      if (item) codecs.push({ video: stringField(item, 'vcodec'), audio: stringField(item, 'acodec') });
    }
  }
  return codecs;
}

function mediaKind(entry: Record<string, unknown>): { kind: 'video' | 'audio'; hasAudio: boolean } {
  const codecs = codecFields(entry);
  const hasVideo = codecs.some(({ video }) => Boolean(video && video !== 'none'));
  const hasAudio = codecs.some(({ audio }) => Boolean(audio && audio !== 'none'));
  return hasVideo || !codecs.some(({ video }) => video === 'none')
    ? { kind: 'video', hasAudio: hasAudio || codecs.length === 1 }
    : { kind: 'audio', hasAudio: true };
}

function parseMedia(value: unknown, fallbackUrl?: string): XMediaMetadata {
  const entry = record(value);
  if (!entry) throw new Error('extraction-failed: yt-dlp media entry is invalid');
  const id = stringField(entry, 'id');
  const title = stringField(entry, 'title');
  if (!id || !title) throw new Error('extraction-failed: yt-dlp media entry lacks id or title');
  const hasMediaEvidence = Boolean(
    stringField(entry, 'ext')
    || stringField(entry, 'vcodec')
    || stringField(entry, 'acodec')
    || stringField(entry, 'url')
    || Array.isArray(entry.formats),
  );
  if (!hasMediaEvidence) throw new Error('extraction-failed: yt-dlp media entry lacks media fields');
  const url = requiresHttpUrl(
    stringField(entry, 'webpage_url') ?? stringField(entry, 'original_url') ?? stringField(entry, 'url') ?? fallbackUrl,
    'media URL',
  );
  const type = mediaKind(entry);
  return {
    id,
    title,
    url,
    ...(stringField(entry, 'uploader') ?? stringField(entry, 'channel') ? { author: stringField(entry, 'uploader') ?? stringField(entry, 'channel') } : {}),
    ...(toPublishedAt(entry.timestamp) ? { publishedAt: toPublishedAt(entry.timestamp) } : {}),
    ...(typeof entry.duration === 'number' && Number.isFinite(entry.duration) ? { durationSec: entry.duration } : {}),
    ...(stringField(entry, 'description') ? { description: stringField(entry, 'description') } : {}),
    ...type,
  };
}

function parseVideoProbe(stdout: string, sourceUrl: URL): XProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('extraction-failed: yt-dlp returned malformed JSON');
  }
  const metadata = record(parsed);
  if (!metadata) throw new Error('extraction-failed: yt-dlp returned an unknown JSON schema');
  const hasEntries = Object.prototype.hasOwnProperty.call(metadata, 'entries');
  const media = hasEntries
    ? (() => {
      if (!Array.isArray(metadata.entries) || metadata.entries.length === 0) {
        throw new Error('extraction-failed: yt-dlp playlist has no usable entries');
      }
      return metadata.entries.map((entry) => parseMedia(entry));
    })()
    : [parseMedia(metadata, sourceUrl.toString())];
  return {
    kind: 'video',
    title: stringField(metadata, 'title') ?? media[0].title,
    ...(stringField(metadata, 'uploader') ?? stringField(metadata, 'channel') ? { author: stringField(metadata, 'uploader') ?? stringField(metadata, 'channel') } : {}),
    ...(toPublishedAt(metadata.timestamp) ? { publishedAt: toPublishedAt(metadata.timestamp) } : {}),
    media,
  };
}

function videoProbeFailure(detail: string): XProbe {
  if (VIDEO_PROBE_NOT_VIDEO.test(detail)) return { kind: 'not-video' };
  if (VIDEO_PROBE_AUTH_REQUIRED.test(detail)) {
    throw new Error('auth-required: X Video is not publicly readable');
  }
  throw new Error(`extraction-failed: yt-dlp video probe failed${detail ? `: ${detail}` : ''}`);
}

function probeVideo(runner: CommandRunner, url: URL): XProbe {
  let result: ReturnType<CommandRunner['run']>;
  try {
    result = runner.run('yt-dlp', ['--dump-single-json', url.toString()], { timeoutMs: 30000 });
  } catch (cause) {
    return videoProbeFailure(cause instanceof Error ? cause.message : String(cause));
  }
  return result.status === 0 ? parseVideoProbe(result.stdout, url) : videoProbeFailure(result.stderr);
}

function articleMetadata(markdown: string): { author?: string; publishedAt?: string } {
  const author = markdown.match(/^>\s*Author:\s*(.+?)\s*$/im)?.[1]?.trim();
  const publishedAt = markdown.match(/^>\s*Published:\s*(.+?)\s*$/im)?.[1]?.trim();
  return {
    ...(author ? { author } : {}),
    ...(publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? { publishedAt } : {}),
  };
}

function requirePublicArticle(markdown: string): void {
  const title = titleFromMarkdown(markdown);
  const hasArticleHeading = /^#{1,6}\s+\S+/m.test(markdown);
  if (LOGIN_TITLE.test(title) || !hasVisibleArticleBody(markdown) || (LOGIN_PAGE_MARKER.test(markdown) && !hasArticleHeading)) {
    throw new Error('auth-required: X Article is not publicly readable');
  }
}

function extractArticle(runner: CommandRunner, url: URL): ExtractedSource {
  const result = runner.run('defuddle', ['parse', url.toString(), '--md'], { timeoutMs: 30000 });
  if (result.status !== 0) throw new Error(`defuddle failed with exit code ${result.status}`);
  requirePublicArticle(result.stdout);
  const { blocks, media } = markdownToSourceParts(result.stdout);
  return {
    source: { url: url.toString(), kind: 'article', title: titleFromMarkdown(result.stdout), ...articleMetadata(result.stdout) },
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

function temporaryDirectory(context: ExtractContext): string {
  const root = context.tempDir ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'me-ingest-x-'));
}

function outputPathFromPrint(stdout: string, directory: string): string {
  const printed = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!printed) throw new Error('yt-dlp did not report the downloaded media path');
  const resolved = path.resolve(printed);
  const root = path.resolve(directory);
  if ((resolved !== root && !resolved.startsWith(root + path.sep)) || !fs.existsSync(resolved)) {
    throw new Error('yt-dlp reported an invalid temporary media path');
  }
  return resolved;
}

function persistMedia(source: string, context: ExtractContext): string {
  const extension = path.extname(source);
  if (!/^\.[a-z0-9]{1,10}$/i.test(extension)) throw new Error('yt-dlp produced media without a safe extension');
  const directory = path.join(context.vaultDir, '.me', 'ingest-media');
  fs.mkdirSync(directory, { recursive: true });
  const filename = `x-media-${randomUUID()}${extension.toLowerCase()}`;
  const destination = path.join(directory, filename);
  const staging = path.join(directory, `.${filename}.part`);
  try {
    fs.copyFileSync(source, staging);
    fs.renameSync(staging, destination);
    return destination;
  } catch (cause) {
    fs.rmSync(staging, { force: true });
    throw cause;
  }
}

function downloadMedia(runner: CommandRunner, context: ExtractContext, media: XMediaMetadata): string {
  const directory = temporaryDirectory(context);
  try {
    const template = path.join(directory, `media-${randomUUID()}-%(id)s.%(ext)s`);
    const result = runner.run('yt-dlp', ['--no-playlist', '-o', template, '--print', 'after_move:filepath', media.url], { timeoutMs: 600000 });
    if (result.status !== 0) throw new Error(`yt-dlp failed with exit code ${result.status}`);
    return persistMedia(outputPathFromPrint(result.stdout, directory), context);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function videoBlocks(probe: XVideoProbe): SourceBlock[] {
  const blocks: SourceBlock[] = [{ id: 'block-001', kind: 'heading', markdown: `# ${probe.title}` }];
  probe.media.forEach((media, index) => {
    const ordinal = String(index + 2).padStart(3, '0');
    blocks.push({ id: `block-${ordinal}`, kind: 'heading', markdown: `## ${media.title}` });
    const details = [media.author ? `作者: ${media.author}` : '', media.durationSec === undefined ? '' : `时长: ${media.durationSec}s`].filter(Boolean);
    if (details.length > 0) blocks.push({ id: `block-${ordinal}-meta`, kind: 'paragraph', markdown: `> ${details.join(' · ')}` });
    if (media.description) blocks.push({ id: `block-${ordinal}-description`, kind: 'paragraph', markdown: media.description });
  });
  return blocks;
}

function capabilities(probe: XVideoProbe): CapabilityReport['capabilities'] {
  const hasVideo = probe.media.some((media) => media.kind === 'video');
  const hasAudio = probe.media.some((media) => media.hasAudio);
  return [...(hasVideo ? ['video' as const] : []), ...(hasAudio ? ['audio' as const] : [])];
}

function extractVideo(runner: CommandRunner, context: ExtractContext, probe: XVideoProbe): ExtractedSource {
  const media: MediaAsset[] = probe.media.map((entry, index) => ({
    id: `${entry.kind}-${String(index + 1).padStart(3, '0')}`,
    kind: entry.kind,
    path: downloadMedia(runner, context, entry),
    url: entry.url,
    caption: entry.title,
  }));
  const audioOnly = media.every((asset) => asset.kind === 'audio');
  return {
    source: {
      url: context.url.toString(), kind: 'video', title: probe.title,
      ...(probe.author ? { author: probe.author } : {}),
      ...(probe.publishedAt ? { publishedAt: probe.publishedAt } : {}),
      ...(probe.media.every((entry) => entry.durationSec !== undefined) ? { durationSec: probe.media.reduce((total, entry) => total + entry.durationSec!, 0) } : {}),
    },
    blocks: videoBlocks(probe),
    media,
    provenance: {
      extractor: 'yt-dlp', extractedAt: new Date().toISOString(),
      methods: ['yt-dlp --dump-single-json', 'yt-dlp --no-playlist -o %(id)s.%(ext)s --print after_move:filepath'],
    },
    warnings: audioOnly ? ['video-unavailable:audio-only'] : [],
  };
}

export function createXAdapter(runner: CommandRunner): SourceAdapter {
  return {
    id: 'x',
    matches: (url) => isXHostname(url.hostname),
    async probe(context): Promise<CapabilityReport> {
      const result = probeVideo(runner, context.url);
      if (result.kind === 'video') {
        const mediaCapabilities = capabilities(result);
        const audioOnly = mediaCapabilities.length === 1 && mediaCapabilities[0] === 'audio';
        return {
          adapterId: 'x', readable: true, capabilities: mediaCapabilities, degradation: audioOnly ? 'partial' : 'none',
          warnings: audioOnly ? ['video-unavailable:audio-only'] : [],
        };
      }
      try {
        extractArticle(runner, context.url);
        return { adapterId: 'x', readable: true, capabilities: ['body', 'images'], degradation: 'none', warnings: [] };
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('auth-required')) {
          return { adapterId: 'x', readable: false, capabilities: [], degradation: 'blocked', warnings: ['auth-required'] };
        }
        throw cause;
      }
    },
    async extract(context): Promise<ExtractedSource> {
      const result = probeVideo(runner, context.url);
      return result.kind === 'video' ? extractVideo(runner, context, result) : extractArticle(runner, context.url);
    },
  };
}
