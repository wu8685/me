import type {
  CapabilityReport,
  ExtractedSource,
  SourceAdapter,
  TranscriptSegment,
} from '../contracts.ts';
import type { CommandRunner } from '../command.ts';
import { markdownToSourceParts } from './html.ts';

export interface BilibiliMeta {
  bvid: string;
  title: string;
  desc: string;
  pubdate: number;
  duration: number;
  owner: { name: string };
  stat: { view: number; danmaku: number; like: number; coin: number; favorite: number; share: number };
  pages: Array<{ cid: number; page: number; part: string; duration: number }>;
}

export interface BilibiliSubtitleEntry {
  lan: string;
  lan_doc: string;
  subtitle_url: string;
  ai_type: number;
}

interface BilibiliSubtitleLine { from: number; to: number; content: string }

export interface BilibiliAdapterOptions {
  transcribe?: (url: string, cid: number) => string;
  transcriptionAvailable?: () => boolean;
}

const BILI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'Referer: https://www.bilibili.com/';

function run(runner: CommandRunner, args: string[], timeoutMs: number): string {
  const result = runner.run('curl', args, { timeoutMs });
  if (result.status !== 0) throw new Error(`curl failed with exit code ${result.status}`);
  return result.stdout;
}

export function isBilibiliUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  return /^(https?:\/\/)?(www\.)?bilibili\.com\/video\/BV[A-Za-z0-9]+/.test(url)
    || /^(https?:\/\/)?b23\.tv\/[A-Za-z0-9]+/.test(url);
}

export function parseBilibiliBvid(runner: CommandRunner, url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const direct = url.match(/\/video\/(BV[A-Za-z0-9]+)/);
  if (direct) return direct[1];
  if (!/^(https?:\/\/)?b23\.tv\//.test(url)) return null;
  try {
    const resolved = run(runner, ['-sIL', '-o', '/dev/null', '-w', '%{url_effective}', '--max-time', '10', '-A', BILI_UA, url], 12000).trim();
    return resolved.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function fetchBilibiliMeta(runner: CommandRunner, bvid: string): BilibiliMeta {
  const raw = run(runner, ['-s', '--max-time', '15', '-A', BILI_UA, '-H', REFERER, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`], 18000);
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error(`Bilibili API returned non-JSON for bvid=${bvid}`); }
  if (!json || json.code !== 0) throw new Error(`Bilibili API error: ${json?.message ?? json?.code ?? 'unknown'}`);
  return json.data as BilibiliMeta;
}

export function fetchBilibiliSubtitleList(runner: CommandRunner, bvid: string, cid: number): BilibiliSubtitleEntry[] {
  try {
    const raw = run(runner, ['-s', '--max-time', '15', '-A', BILI_UA, '-H', REFERER, `https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`], 18000);
    const list = JSON.parse(raw)?.data?.subtitle?.subtitles;
    return Array.isArray(list) ? list as BilibiliSubtitleEntry[] : [];
  } catch { return []; }
}

function fetchBilibiliSubtitleLines(runner: CommandRunner, subtitleUrl: string): BilibiliSubtitleLine[] {
  try {
    if (!subtitleUrl) return [];
    const url = subtitleUrl.startsWith('//') ? `https:${subtitleUrl}` : subtitleUrl;
    const body = JSON.parse(run(runner, ['-s', '--max-time', '15', '-A', BILI_UA, '-H', REFERER, url], 18000))?.body;
    if (!Array.isArray(body)) return [];
    return body
      .map((line: any) => ({ from: Number(line?.from), to: Number(line?.to), content: String(line?.content ?? '') }))
      .filter((line: BilibiliSubtitleLine) => line.content);
  } catch { return []; }
}

export function fetchBilibiliSubtitleBody(runner: CommandRunner, subtitleUrl: string): string {
  return fetchBilibiliSubtitleLines(runner, subtitleUrl).map((line) => line.content).join('\n');
}

function preferredSubtitle(list: BilibiliSubtitleEntry[]): BilibiliSubtitleEntry | null {
  return [...list].sort((a, b) => {
    const ai = (a.ai_type === 0 ? 0 : 1) - (b.ai_type === 0 ? 0 : 1);
    return ai || (a.lan === 'zh-CN' ? 0 : 1) - (b.lan === 'zh-CN' ? 0 : 1);
  })[0] ?? null;
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  const pad = (number: number) => String(number).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}`;
}

export function extractBilibiliSource(
  runner: CommandRunner,
  url: string,
  mode: 'metadata' | 'transcribe' = 'metadata',
  options: BilibiliAdapterOptions = {},
): ExtractedSource {
  const bvid = parseBilibiliBvid(runner, url);
  if (!bvid) throw new Error(`Not a Bilibili video URL: ${url}`);
  const meta = fetchBilibiliMeta(runner, bvid);
  const lines = [
    `# ${meta.title}`,
    '',
    `> 作者: ${meta.owner?.name ?? '未知'} · 时长: ${formatDuration(meta.duration ?? 0)} · 发布: ${meta.pubdate ? new Date(meta.pubdate * 1000).toISOString().split('T')[0] : ''}`,
    `> 播放: ${meta.stat?.view ?? 0} · 弹幕: ${meta.stat?.danmaku ?? 0} · 点赞: ${meta.stat?.like ?? 0} · 投币: ${meta.stat?.coin ?? 0} · 收藏: ${meta.stat?.favorite ?? 0}`,
    '',
    '## 视频简介',
    '',
    meta.desc || '*（无简介）*',
    '',
  ];
  const transcript: TranscriptSegment[] = [];
  const pages = Array.isArray(meta.pages) && meta.pages.length > 0
    ? meta.pages
    : [{ cid: 0, page: 1, part: meta.title, duration: meta.duration ?? 0 }];
  let missingTranscript = false;

  for (const page of pages) {
    if (pages.length > 1) lines.push(`## P${page.page}: ${page.part}`, '');
    const chosen = preferredSubtitle(fetchBilibiliSubtitleList(runner, bvid, page.cid));
    const subtitleLines = chosen ? fetchBilibiliSubtitleLines(runner, chosen.subtitle_url) : [];
    if (subtitleLines.length > 0) {
      lines.push(`### 字幕转录（${chosen?.lan ?? 'unknown'}）`, '', ...subtitleLines.map((line) => line.content), '');
      transcript.push(...subtitleLines
        .filter((line) => Number.isFinite(line.from) && Number.isFinite(line.to) && line.from < line.to)
        .map((line) => ({ start: line.from, end: line.to, text: line.content })));
    } else if (mode === 'transcribe' && options.transcribe) {
      const text = options.transcribe(url, page.cid);
      lines.push('### 字幕转录（whisper-auto）', '', text, '');
      if (text.trim() && (page.duration ?? meta.duration) > 0) {
        transcript.push({ start: 0, end: page.duration ?? meta.duration, text });
      }
    } else {
      lines.push('<!-- 无 CC 字幕 -->', '');
      missingTranscript = true;
    }
  }

  const content = lines.join('\n');
  const parts = markdownToSourceParts(content);
  const warnings = missingTranscript && mode !== 'transcribe' ? ['needs-transcription'] : [];
  return {
    source: {
      url,
      kind: 'video',
      title: meta.title,
      author: meta.owner?.name,
      publishedAt: meta.pubdate ? new Date(meta.pubdate * 1000).toISOString() : undefined,
      language: transcript.length > 0 ? 'zh-CN' : undefined,
      durationSec: meta.duration,
    },
    blocks: parts.blocks,
    transcript: transcript.length > 0 ? transcript : undefined,
    media: [{ id: 'video-001', kind: 'video', url }],
    provenance: { extractor: 'bilibili-public-api', extractedAt: new Date().toISOString(), methods: ['web-interface/view', 'player/v2'] },
    warnings,
  };
}

export function createBilibiliAdapter(runner: CommandRunner, options: BilibiliAdapterOptions = {}): SourceAdapter {
  return {
    id: 'bilibili',
    matches: (url) => isBilibiliUrl(url.toString()),
    async probe(context): Promise<CapabilityReport> {
      const source = extractBilibiliSource(runner, context.url.toString(), context.mode === 'transcribe' ? 'transcribe' : 'metadata', options);
      const hasTranscript = Boolean(source.transcript?.length);
      return {
        adapterId: 'bilibili',
        readable: hasTranscript,
        capabilities: hasTranscript ? ['body', 'captions', 'transcript', 'video'] : ['video'],
        degradation: hasTranscript ? 'none' : 'partial',
        warnings: source.warnings,
      };
    },
    async extract(context): Promise<ExtractedSource> {
      return extractBilibiliSource(runner, context.url.toString(), context.mode === 'transcribe' ? 'transcribe' : 'metadata', options);
    },
  };
}
