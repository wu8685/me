#!/usr/bin/env -S bun run
// bin/ingest.ts — scriptable ingest pipeline for /me:ingest skill
//
// Exports pure functions for all deterministic ingest steps.
// LLM reasoning is only used for translate-cn and summarize modes in SKILL.md.
//
// CLI usage: bun run bin/ingest.ts <url> [--mode MODE] [--vault-dir DIR] [--write]
//            bun run bin/ingest.ts --bundle DIR [--mode MODE] [--vault-dir DIR] [--write]
//            bun run bin/ingest.ts --download-images --vault-dir DIR --target-dir DIR --urls url1,url2,...
//            bun run bin/ingest.ts --help

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';
import { defaultCommandRunner, type CommandRunner } from './ingest/command.ts';
import { extractHtmlSource } from './ingest/adapters/html.ts';
import { createHtmlAdapter } from './ingest/adapters/html.ts';
import { createPdfAdapter } from './ingest/adapters/pdf.ts';
import { createXAdapter } from './ingest/adapters/x.ts';
import {
  createBilibiliAdapter,
  extractBilibiliSource,
  fetchBilibiliMeta as fetchBilibiliMetaFromAdapter,
  fetchBilibiliSubtitleBody as fetchBilibiliSubtitleBodyFromAdapter,
  fetchBilibiliSubtitleList as fetchBilibiliSubtitleListFromAdapter,
  isBilibiliUrl as isBilibiliUrlFromAdapter,
  parseBilibiliBvid as parseBilibiliBvidFromAdapter,
} from './ingest/adapters/bilibili.ts';
import { loadSourceBundle } from './ingest/bundle.ts';
import { resolveIngestConfig } from './ingest/config.ts';
import type {
  CapabilityReport,
  ExtractMode,
  ExtractedSource,
  SourceAdapter,
  SourceKind,
} from './ingest/contracts.ts';
import { finalizeIngest, type FinalizeResult } from './ingest/finalize.ts';
import { formatHandout, type HandoutResult } from './ingest/handout.ts';
import { createAdapterRegistry } from './ingest/registry.ts';
import { discoverTranscriptionProvider } from './ingest/media/transcription.ts';

export type {
  Capability,
  CapabilityReport,
  ExtractContext,
  ExtractMode,
  ExtractedSource,
  MediaAsset,
  SourceAdapter,
  SourceBlock,
  SourceKind,
  TranscriptSegment,
} from './ingest/contracts.ts';
export {
  finalizeIngest,
  type BacklinkSuggestion,
  type FinalizeFileOperations,
  type FinalizeInput,
  type FinalizeResult,
} from './ingest/finalize.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LayerConfig {
  raw: string;
  practices: string;
  cognition: string;
}

export interface VaultEntry {
  stem: string;
  path: string;
  title: string;
}

export interface AutoLinkResult {
  linkedBody: string;
  links: string[];
  stubs: string[];
}

export interface RelatedNote {
  path: string;
  score: number;
}

export interface WikilinkCandidate {
  stem: string;
  title: string;
  count: number;
}

export interface ExtractedContent {
  title: string;
  content: string;
  images: string[];
}

export interface BilibiliMeta {
  bvid: string;
  title: string;
  desc: string;
  pubdate: number;
  duration: number;
  owner: { name: string };
  stat: {
    view: number;
    danmaku: number;
    like: number;
    coin: number;
    favorite: number;
    share: number;
  };
  pages: Array<{ cid: number; page: number; part: string; duration: number }>;
}

export interface BilibiliSubtitleEntry {
  lan: string;
  lan_doc: string;
  subtitle_url: string;
  ai_type: number;
}

export interface IngestPipelineResult {
  title: string;
  slug: string;
  language: 'en' | 'zh';
  mode: string;
  frontmatter: string;
  content: string;
  images: string[];
  autoLinks: string[];
  relatedNotes: RelatedNote[];
  needsTranscription?: boolean;
  transcriptionAvailable?: boolean;
  sourceKind?: SourceKind;
  adapterId?: string;
  capabilities?: CapabilityReport['capabilities'];
  degradation?: CapabilityReport['degradation'];
  completeness?: CapabilityReport['completeness'];
  warnings?: string[];
  handoutKind?: HandoutResult['kind'];
  writeResult?: FinalizeResult;
}

// ── resolveConfig ─────────────────────────────────────────────────────────────

/**
 * Read .me/config.yaml from vaultDir and return layer directory mapping.
 * Falls back to defaults (raw, practices, cognition) if config is absent.
 */
export function resolveConfig(vaultDir: string): LayerConfig {
  const cfgPath = path.join(vaultDir, '.me', 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return { raw: 'raw', practices: 'practices', cognition: 'cognition' };
  }
  const text = fs.readFileSync(cfgPath, 'utf8');
  const raw = (text.match(/^\s*raw:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'raw';
  const practices = (text.match(/^\s*practices:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'practices';
  const cognition = (text.match(/^\s*cognition:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'cognition';
  return {
    raw: raw.trim(),
    practices: practices.trim(),
    cognition: cognition.trim(),
  };
}

// ── detectLanguage ────────────────────────────────────────────────────────────

/**
 * Detect language from text sample. Returns "zh" if Chinese characters
 * exceed 30% of non-whitespace chars in first 500 chars, else "en".
 */
export function detectLanguage(text: string): 'en' | 'zh' {
  const sample = text.slice(0, 500);
  const nonWhitespace = sample.replace(/\s/g, '');
  if (nonWhitespace.length === 0) return 'en';
  const chineseChars = (nonWhitespace.match(/[\u4e00-\u9fff]/g) || []).length;
  const ratio = chineseChars / nonWhitespace.length;
  return ratio >= 0.3 ? 'zh' : 'en';
}

// ── deriveSlug ────────────────────────────────────────────────────────────────

/**
 * Derive a kebab-case English slug from a title.
 * - Strips Chinese characters
 * - Lowercase
 * - Replaces non-alphanumeric with hyphens
 * - Collapses consecutive hyphens
 * - Strips leading/trailing hyphens
 * - Truncates to 60 chars max (at word boundary)
 */
export function deriveSlug(title: string): string {
  let slug = title
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ') // strip Chinese
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanumeric with hyphen
    .replace(/-+/g, '-')           // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');      // strip leading/trailing hyphens

  if (slug.length > 60) {
    // Truncate at word boundary
    slug = slug.slice(0, 60).replace(/-[^-]*$/, '');
    // If that removed everything, just truncate hard
    if (slug.length === 0) {
      slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/-$/, '');
    }
  }

  return slug;
}

// ── generateFrontmatter ───────────────────────────────────────────────────────

/**
 * Generate YAML frontmatter matching templates/raw-template.md schema.
 * Fields: title, created, tags, type (always "article"), source.
 * FORBIDDEN: status, lifecycle, date_created.
 */
export function generateFrontmatter(
  title: string,
  date: string,
  tags: string[],
  source: string,
): string {
  const tagsYaml = tags.length > 0
    ? `[${tags.join(', ')}]`
    : '[]';
  return `---
title: "${title}"
created: ${date}
tags: ${tagsYaml}
type: article
source: "${source}"
---`;
}

// ── buildVaultIndex ───────────────────────────────────────────────────────────

/**
 * Build a Map<lowercaseTitle, VaultEntry> from all .md files in configured layer dirs.
 * Only indexes files that have a `title:` frontmatter field.
 */
export function buildVaultIndex(vaultDir: string): Map<string, VaultEntry> {
  const config = resolveConfig(vaultDir);
  const layerDirs = [config.raw, config.practices, config.cognition];
  const index = new Map<string, VaultEntry>();

  function walkDir(dir: string): void {
    const absDir = path.join(vaultDir, dir);
    if (!fs.existsSync(absDir)) return;

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walkDir(path.relative(vaultDir, fullPath));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const titleMatch = content.match(/^---[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
      if (!titleMatch) continue;

      const title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
      if (!title) continue;

      const stem = entry.name.replace(/\.md$/, '');
      const relPath = path.relative(vaultDir, fullPath);
      index.set(title.toLowerCase(), { stem, path: relPath, title });
    }
  }

  for (const layerDir of layerDirs) {
    walkDir(layerDir);
  }

  return index;
}

// ── autoLink ──────────────────────────────────────────────────────────────────

/**
 * Auto-link vault titles in body text (not frontmatter).
 * - Splits at second '---' delimiter to separate frontmatter from body
 * - Processes vault index entries longest-first (greedy matching)
 * - Replaces only first occurrence of each title (case-insensitive)
 * - Returns { linkedBody, links, stubs }
 */
export function autoLink(
  content: string,
  vaultIndex: Map<string, VaultEntry>,
): AutoLinkResult {
  // Split into frontmatter + body: find second --- delimiter
  const delimiter = '---';
  const firstDelim = content.indexOf(delimiter);
  if (firstDelim === -1) {
    // No frontmatter, process whole content
    return linkBody(content, vaultIndex, '');
  }
  const secondDelim = content.indexOf(delimiter, firstDelim + delimiter.length);
  if (secondDelim === -1) {
    return linkBody(content, vaultIndex, '');
  }

  const frontmatter = content.slice(0, secondDelim + delimiter.length);
  const body = content.slice(secondDelim + delimiter.length);

  const { linkedBody: linkedBodyOnly, links, stubs } = linkBody(body, vaultIndex, '');
  return {
    linkedBody: frontmatter + linkedBodyOnly,
    links,
    stubs,
  };
}

function linkBody(
  body: string,
  vaultIndex: Map<string, VaultEntry>,
  _prefix: string,
): AutoLinkResult {
  const links: string[] = [];
  const stubs: string[] = [];

  // Sort entries by title length descending (longest-first for greedy match)
  const sortedEntries = Array.from(vaultIndex.entries()).sort(
    (a, b) => b[0].length - a[0].length,
  );

  // Use a token-based approach: split body into segments where odd-indexed segments
  // are already-linked wikilinks (skip them) and even-indexed are plain text (process them)
  // We represent the body as an array of { text, linked } segments

  // IMPORTANT: Parse existing wikilinks first to prevent nested wikilinks
  // when running autolinks multiple times on the same file
  type Segment = { text: string; linked: boolean };
  let segments: Segment[] = [];

  // Split body by wikilink pattern: [[...]]
  // This marks existing wikilinks as linked so they won't be processed again
  const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = wikilinkRegex.exec(body)) !== null) {
    // Add text before wikilink as plain segment
    if (match.index > lastIndex) {
      segments.push({ text: body.slice(lastIndex, match.index), linked: false });
    }
    // Add wikilink as linked segment
    segments.push({ text: match[0], linked: true });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last wikilink
  if (lastIndex < body.length) {
    segments.push({ text: body.slice(lastIndex), linked: false });
  }

  // If no wikilinks found, treat entire body as single plain segment
  if (segments.length === 0) {
    segments.push({ text: body, linked: false });
  }

  for (const [_lowercaseTitle, entry] of sortedEntries) {
    const escapedTitle = entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedTitle, 'i');
    const wikilink = `[[${entry.stem}|${entry.title}]]`;
    let matched = false;

    const newSegments: Segment[] = [];
    for (const seg of segments) {
      if (seg.linked || matched) {
        newSegments.push(seg);
        continue;
      }
      const m = seg.text.match(regex);
      if (!m) {
        newSegments.push(seg);
        continue;
      }
      // Replace only the first occurrence in this plain text segment
      const idx = m.index!;
      const before = seg.text.slice(0, idx);
      const after = seg.text.slice(idx + m[0].length);
      if (before) newSegments.push({ text: before, linked: false });
      newSegments.push({ text: wikilink, linked: true });
      if (after) newSegments.push({ text: after, linked: false });
      matched = true;
    }

    if (matched) {
      segments = newSegments;
      links.push(entry.stem);
    }
  }

  const linkedBody = segments.map(s => s.text).join('');
  return { linkedBody, links, stubs };
}

// ── scoreRelatedNotes ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'for', 'to', 'and', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'its', 'it', 'this', 'that', 'these', 'those',
]);

/**
 * Score vault notes for relevance to new article.
 * Scoring: 2 pts per shared tag, 1 pt per shared significant title keyword.
 * Returns notes with score >= 2, sorted descending.
 */
export function scoreRelatedNotes(
  newTags: string[],
  newTitle: string,
  vaultIndex: Map<string, VaultEntry>,
  vaultDir: string,
): RelatedNote[] {
  const newTagSet = new Set(newTags.map(t => t.toLowerCase()));
  const newTitleKeywords = newTitle
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const results: RelatedNote[] = [];

  for (const [, entry] of vaultIndex) {
    const filePath = path.join(vaultDir, entry.path);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');

    // Extract tags from frontmatter
    const tagsMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
    const tags: string[] = tagsMatch
      ? tagsMatch[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
      : [];

    // Score: 2 pts per shared tag
    let score = 0;
    for (const tag of tags) {
      if (newTagSet.has(tag)) {
        score += 2;
      }
    }

    // Score: 1 pt per shared significant title keyword
    const entryTitleKeywords = entry.title
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    for (const keyword of newTitleKeywords) {
      if (entryTitleKeywords.includes(keyword)) {
        score += 1;
      }
    }

    if (score >= 2) {
      results.push({ path: entry.path, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── extractWikilinkCandidates ────────────────────────────────────────────────────

/**
 * Extract wikilink candidates from content by matching phrases against vault index.
 * - Identifies phrases (2-4 words) that match vault entry titles
 * - Filters: must start with capital letter (proper noun/technical term)
 * - Filters: exclude common stop words (the, a, an, in, on, of, for, to, and, with)
 * - Returns array of {stem, title, count} sorted by frequency (count descending)
 */
export function extractWikilinkCandidates(
  content: string,
  vaultIndex: Map<string, VaultEntry>,
): WikilinkCandidate[] {
  const candidates: Map<string, WikilinkCandidate> = new Map();

  // Sort vault entries by title length descending (longest first for greedy matching)
  const sortedEntries = Array.from(vaultIndex.entries()).sort(
    (a, b) => b[1].title.length - a[1].title.length,
  );

  for (const [, entry] of sortedEntries) {
    const title = entry.title;
    const stem = entry.stem;

    // Skip if title is a stop word or doesn't start with capital letter
    if (!title || !/^[A-Z]/.test(title)) continue;

    // Check if title contains only stop words
    const words = title.split(/\s+/);
    const allStopWords = words.every(w => STOP_WORDS.has(w.toLowerCase()));
    if (allStopWords) continue;

    // Count occurrences (case-insensitive)
    const regex = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = content.match(regex);
    const count = matches ? matches.length : 0;

    if (count > 0) {
      candidates.set(stem, { stem, title, count });
    }
  }

  // Return sorted by count (descending)
  return Array.from(candidates.values()).sort((a, b) => b.count - a.count);
}

// ── HTML / Bilibili compatibility wrappers ──────────────────────────────────

/** Retained for callers while the CLI is migrated to adapter registry in Task 8. */
export function isBilibiliUrl(url: string): boolean {
  return isBilibiliUrlFromAdapter(url);
}

/** Retained for callers while redirect resolution now uses the safe command runner. */
export function parseBilibiliBvid(url: string): string | null {
  return parseBilibiliBvidFromAdapter(defaultCommandRunner, url);
}

export function fetchBilibiliMeta(bvid: string): BilibiliMeta {
  return fetchBilibiliMetaFromAdapter(defaultCommandRunner, bvid);
}

export function fetchBilibiliSubtitleList(bvid: string, cid: number): BilibiliSubtitleEntry[] {
  return fetchBilibiliSubtitleListFromAdapter(defaultCommandRunner, bvid, cid);
}

export function fetchBilibiliSubtitleBody(subtitleUrl: string): string {
  return fetchBilibiliSubtitleBodyFromAdapter(defaultCommandRunner, subtitleUrl);
}

/**
 * Check if yt-dlp is available on PATH. Returns the resolved path or null.
 * (Defined here so extractBilibili can compute transcriptionAvailable; the
 * actual transcribe pipeline lives further down.)
 */
export function whichYtDlp(runner: CommandRunner = defaultCommandRunner): string | null {
  try {
    const out = runner.run('which', ['yt-dlp'], { timeoutMs: 5000 }).stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Check if whisper-cli is available. Tries `which`, then the homebrew
 * whisper-cpp keg location. Returns the resolved path or null.
 */
export function whichWhisperCli(runner: CommandRunner = defaultCommandRunner): string | null {
  try {
    const out = runner.run('which', ['whisper-cli'], { timeoutMs: 5000 }).stdout.trim();
    if (out) return out;
  } catch {
    // fall through to keg check
  }
  const kegPath = '/opt/homebrew/opt/whisper-cpp/bin/whisper-cli';
  if (fs.existsSync(kegPath)) return kegPath;
  return null;
}

/**
 * Extract a Bilibili video as ingest-ready markdown.
 * Path: parse bvid → fetch meta → for each page, fetch subtitle list and body
 * → build markdown (title header, stats blockquote, 视频简介, per-page sections).
 *
 * When `opts.mode !== 'transcribe'` and any page lacks CC, sets
 * `needsTranscription: true` so SKILL.md can prompt the user.
 * `transcriptionAvailable` reflects yt-dlp + whisper-cli presence on PATH.
 *
 * When `opts.mode === 'transcribe'`, the actual whisper pipeline is invoked
 * inline via `transcribeBilibili` for any page without CC.
 */
export function extractBilibili(
  url: string,
  opts?: { mode?: 'metadata' | 'transcribe'; runner?: CommandRunner },
): ExtractedContent & { needsTranscription?: boolean; transcriptionAvailable?: boolean } {
  const mode = opts?.mode ?? 'metadata';
  const runner = opts?.runner ?? defaultCommandRunner;
  const source = extractBilibiliSource(runner, url, mode, {
    transcribe: (sourceUrl, cid) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whisper-'));
      try {
        return transcribeBilibili(sourceUrl, cid, tmpDir, runner);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    transcriptionAvailable: () => whichYtDlp(runner) !== null && whichWhisperCli(runner) !== null,
  });
  const result = projectExtractedSource(source);
  if (source.warnings.includes('needs-transcription')) {
    result.needsTranscription = true;
    result.transcriptionAvailable = whichYtDlp(runner) !== null && whichWhisperCli(runner) !== null;
  }
  return result;
}

// ── extractContent ────────────────────────────────────────────────────────────

/**
 * Extract content from URL. Dispatches to extractBilibili for Bilibili URLs;
 * otherwise uses the defuddle CLI (HTML path, unchanged for callers passing
 * no opts).
 */
export function extractContent(
  url: string,
  opts?: { mode?: 'metadata' | 'transcribe'; runner?: CommandRunner },
  runner: CommandRunner = opts?.runner ?? defaultCommandRunner,
): ExtractedContent & { needsTranscription?: boolean; transcriptionAvailable?: boolean } {
  if (isBilibiliUrl(url)) {
    return extractBilibili(url, { ...opts, runner });
  }
  return projectExtractedSource(extractHtmlSource(runner, new URL(url), url));
}

function projectExtractedSource(
  source: import('./ingest/contracts.ts').ExtractedSource,
): ExtractedContent & { needsTranscription?: boolean; transcriptionAvailable?: boolean } {
  return {
    title: source.source.title,
    content: source.blocks.map((block) => block.markdown).join('\n\n'),
    images: source.media.flatMap((media) => media.kind === 'image' && media.url ? [media.url] : []),
  };
}

/**
 * Resolve the local path of the whisper model used for transcription.
 * Honors ME_WHISPER_MODEL env var first; defaults to
 * `~/.cache/me/whisper-models/ggml-large-v3-turbo.bin`.
 *
 * If the file is missing, downloads it from the official whisper.cpp HuggingFace
 * mirror (large file — caller pays the network cost only when transcribe mode
 * is actually used). Creates parent directory as needed.
 */
export function getWhisperModelPath(runner: CommandRunner = defaultCommandRunner): string {
  const envPath = process.env.ME_WHISPER_MODEL;
  const modelPath =
    envPath || path.join(os.homedir(), '.cache/me/whisper-models/ggml-large-v3-turbo.bin');

  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) {
    return modelPath;
  }

  const parent = path.dirname(modelPath);
  fs.mkdirSync(parent, { recursive: true });

  const modelUrl =
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
  try {
    runner.run('curl', ['-L', '--max-time', '600', '-o', modelPath, modelUrl], { timeoutMs: 620000 });
  } catch {
    throw new Error(
      `Failed to download whisper model — manually place at ${modelPath} (source: ${modelUrl})`,
    );
  }

  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size === 0) {
    throw new Error(
      `Failed to download whisper model — manually place at ${modelPath} (source: ${modelUrl})`,
    );
  }
  return modelPath;
}

/**
 * Run the whisper transcription pipeline for a single Bilibili page (cid).
 *
 * Steps:
 *  1. yt-dlp extracts audio (best available, converted to wav) into tmpDir
 *  2. ffmpeg resamples to 16 kHz mono PCM s16le (whisper.cpp's expected format)
 *  3. whisper-cli transcribes to a .txt file
 *  4. read transcript, clean up intermediate wav files (model + tmpDir kept)
 *
 * Throws with a `brew install ...` hint if either binary is missing.
 */
export function transcribeBilibili(
  url: string,
  cid: number,
  tmpDir: string,
  runner: CommandRunner = defaultCommandRunner,
): string {
  const ytdlp = whichYtDlp(runner);
  if (!ytdlp) {
    throw new Error('yt-dlp not installed. brew install yt-dlp');
  }
  const wcli = whichWhisperCli(runner);
  if (!wcli) {
    throw new Error('whisper-cli not installed. brew install whisper-cpp');
  }

  // Step 1: extract audio with yt-dlp → tmpDir/audio-<cid>.<ext>
  const audioOutTpl = path.join(tmpDir, `audio-${cid}.%(ext)s`);
  runner.run(ytdlp, ['-x', '--audio-format', 'wav', '-o', audioOutTpl, url], { timeoutMs: 600000 });

  const wavName = fs
    .readdirSync(tmpDir)
    .find((f) => f.startsWith(`audio-${cid}.`) && f.endsWith('.wav'));
  if (!wavName) {
    throw new Error(`yt-dlp did not produce a wav file for cid=${cid}`);
  }
  const wavIn = path.join(tmpDir, wavName);
  const wav16k = path.join(tmpDir, `audio-${cid}-16k.wav`);

  // Step 2: ffmpeg resample to 16kHz mono PCM
  runner.run('ffmpeg', ['-y', '-i', wavIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav16k], { timeoutMs: 300000 });

  // Step 3: whisper-cli → transcript-<cid>.txt
  const model = getWhisperModelPath(runner);
  const transcriptBase = path.join(tmpDir, `transcript-${cid}`);
  runner.run(wcli, ['-m', model, '-f', wav16k, '-l', 'auto', '-otxt', '-of', transcriptBase], { timeoutMs: 1800000 });

  const transcriptFile = `${transcriptBase}.txt`;
  const transcript = fs.existsSync(transcriptFile)
    ? fs.readFileSync(transcriptFile, 'utf8')
    : '';

  // Step 4: cleanup intermediate wavs (caller cleans tmpDir wholesale)
  try { fs.rmSync(wavIn, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(wav16k, { force: true }); } catch { /* ignore */ }

  return transcript.trim();
}

// ── scanExistingWikilinks ────────────────────────────────────────────────────────

/**
 * Scan all .md files in configured layer directories for existing wikilinks.
 * Returns a Set of unique wikilink stems found in the vault.
 *
 * Wikilink format: [[stem]] or [[stem|display text]]
 * - Extracts the stem (before | if present, or entire target)
 * - Skips wikilinks inside code blocks (```...```)
 * - Respects layer directory config from .me/config.yaml
 */
export function scanExistingWikilinks(vaultDir: string): Set<string> {
  const config = resolveConfig(vaultDir);
  const layerDirs = [config.raw, config.practices, config.cognition];
  const wikilinks = new Set<string>();

  function walkDir(dir: string): void {
    const absDir = path.join(vaultDir, dir);
    if (!fs.existsSync(absDir)) return;

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walkDir(path.relative(vaultDir, fullPath));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      extractWikilinksFromContent(content, wikilinks);
    }
  }

  for (const layerDir of layerDirs) {
    walkDir(layerDir);
  }

  return wikilinks;
}

/**
 * Extract wikilink stems from content, skipping code blocks.
 * Modifies the wikilinks Set in place.
 */
function extractWikilinksFromContent(content: string, wikilinks: Set<string>): void {
  // Split content by code blocks to skip them
  const parts = content.split(/```[\s\S]*?```/);

  for (const part of parts) {
    // Find all wikilinks in this non-code section
    // Pattern: [[stem]] or [[stem|display]]
    const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = wikilinkRegex.exec(part)) !== null) {
      const stem = match[1].trim();
      if (stem) {
        wikilinks.add(stem);
      }
    }
  }
}

// ── downloadImage ─────────────────────────────────────────────────────────────

/**
 * Download image from URL to targetDir/filename.
 * Uses Node.js https/http with User-Agent header and 2 retries.
 * Returns true on success, false on failure.
 */
export function downloadImage(url: string, targetDir: string, filename: string): boolean {
  const maxRetries = 2;
  let attempt = 0;

  function tryDownload(): boolean {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, filename);
      const protocol = url.startsWith('https://') ? https : http;

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        },
      };

      // Synchronous download via execSync as a simpler approach
      execSync(`curl -s -L --max-time 15 -A "Mozilla/5.0" -o "${targetPath}" "${url}"`, {
        timeout: 20000,
      });
      return fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0;
    } catch {
      return false;
    }
  }

  while (attempt <= maxRetries) {
    if (tryDownload()) return true;
    attempt++;
  }
  return false;
}

// ── Rich ingest orchestration ─────────────────────────────────────────────────

export interface IngestCliOptions {
  url?: URL;
  bundleDir?: string;
  mode?: ExtractMode;
  vaultDir: string;
  topic?: string;
  processedMarkdown?: string;
  write: boolean;
}

export class SourceBlockedError extends Error {
  readonly code = 'source-blocked' as const;

  constructor(
    readonly adapterId: string,
    readonly warnings: string[],
  ) {
    super(`Source is blocked for adapter ${adapterId}`);
    this.name = 'SourceBlockedError';
  }
}

export type IngestErrorPayload =
  | { code: 'source-blocked'; adapterId: string; warnings: string[] }
  | { error: string };

export function ingestErrorPayload(error: unknown): IngestErrorPayload {
  if (error instanceof SourceBlockedError) {
    return {
      code: error.code,
      adapterId: error.adapterId,
      warnings: [...error.warnings],
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

const INGEST_MODES = new Set<ExtractMode>(['raw', 'translate-cn', 'summarize', 'transcribe', 'handout']);
const TOPIC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function parseIngestCliOptions(args: string[], cwd = process.cwd()): IngestCliOptions {
  let url: URL | undefined;
  let bundleDir: string | undefined;
  let mode: ExtractMode | undefined;
  let vaultDir = cwd;
  let topic: string | undefined;
  let processedMarkdown: string | undefined;
  let write = false;

  const takeValue = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      if (url) throw new Error('exactly one URL or --bundle is required');
      try {
        const parsed = new URL(argument);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
        url = parsed;
      } catch {
        throw new Error('URL must be an http(s) URL');
      }
      continue;
    }
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--bundle') {
      bundleDir = takeValue(index, argument);
      index += 1;
      continue;
    }
    if (argument === '--mode') {
      const value = takeValue(index, argument);
      if (!INGEST_MODES.has(value as ExtractMode)) throw new Error(`unknown ingest mode: ${value}`);
      mode = value as ExtractMode;
      index += 1;
      continue;
    }
    if (argument === '--vault-dir') {
      vaultDir = takeValue(index, argument);
      index += 1;
      continue;
    }
    if (argument === '--topic') {
      topic = takeValue(index, argument);
      if (!TOPIC_PATTERN.test(topic)) throw new Error('topic must be an ASCII kebab slug');
      index += 1;
      continue;
    }
    if (argument === '--processed-markdown') {
      processedMarkdown = takeValue(index, argument);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (Boolean(url) === Boolean(bundleDir)) throw new Error('exactly one URL or --bundle is required');
  if (processedMarkdown && !write) throw new Error('--processed-markdown requires --write');
  return {
    ...(url ? { url } : {}),
    ...(bundleDir ? { bundleDir: path.resolve(bundleDir) } : {}),
    ...(mode ? { mode } : {}),
    vaultDir: path.resolve(vaultDir),
    ...(topic ? { topic } : {}),
    ...(processedMarkdown ? { processedMarkdown: path.resolve(processedMarkdown) } : {}),
    write,
  };
}

export function resolveIngestMode(
  explicitMode: ExtractMode | undefined,
  sourceKind: SourceKind,
  language: 'en' | 'zh',
  defaultVideoMode: ExtractMode,
): ExtractMode {
  if (explicitMode) return explicitMode;
  if (sourceKind === 'video' || sourceKind === 'course') return defaultVideoMode;
  return language === 'en' ? 'translate-cn' : 'summarize';
}

export function createRichIngestRegistry(runner: CommandRunner = defaultCommandRunner): {
  adapters: SourceAdapter[];
  registry: ReturnType<typeof createAdapterRegistry>;
} {
  // Rich ingest deliberately routes every source through the configured generic
  // transcription providers. The legacy Bilibili whisper-cpp callback remains
  // available only through the compatibility wrapper above.
  const bili = createBilibiliAdapter(runner);
  const adapters = [bili, createXAdapter(runner), createPdfAdapter(runner), createHtmlAdapter(runner)];
  const registry = createAdapterRegistry(adapters, {
    async resolveContentType(url) {
      const result = runner.run('curl', [
        '-sS', '-L', '--fail', '--max-time', '15', '-I', '-o', '/dev/null',
        '-w', '%{content_type}', url.toString(),
      ], { timeoutMs: 18000 });
      return result.stdout.trim() || undefined;
    },
  });
  return { adapters, registry };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function readProcessedMarkdown(vaultDir: string, filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const tmpRoot = path.resolve(vaultDir, '.me', 'tmp');
  const candidate = path.resolve(filename);
  if (!isInside(tmpRoot, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error('--processed-markdown must be a file inside <vault>/.me/tmp/');
  }
  const realVault = fs.realpathSync(vaultDir);
  const realTmp = fs.realpathSync(tmpRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realVault, realTmp) || !isInside(realTmp, realCandidate)) {
    throw new Error('--processed-markdown must be a file inside <vault>/.me/tmp/');
  }
  return fs.readFileSync(realCandidate, 'utf8');
}

const REMOTE_MEDIA_EXTENSIONS = {
  visual: new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']),
  audio: new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']),
  video: new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm']),
};
const MAX_REMOTE_MEDIA_BYTES = 256 * 1024 * 1024;

function safeRemoteMediaExtension(asset: import('./ingest/contracts.ts').MediaAsset): string {
  const pathname = asset.url ? new URL(asset.url).pathname : '';
  const extension = path.extname(pathname).toLowerCase();
  if (['image', 'figure', 'slide', 'frame'].includes(asset.kind)) {
    if (!extension) return '.jpg';
    if (REMOTE_MEDIA_EXTENSIONS.visual.has(extension)) return extension;
  } else if (asset.kind === 'audio' && REMOTE_MEDIA_EXTENSIONS.audio.has(extension)) {
    return extension;
  } else if (asset.kind === 'video' && REMOTE_MEDIA_EXTENSIONS.video.has(extension)) {
    return extension;
  }
  throw new Error(`remote media has an incompatible extension for ${asset.kind}`);
}

function requireCompatibleRemoteContentType(
  asset: import('./ingest/contracts.ts').MediaAsset,
  contentTypeOutput: string,
): void {
  const contentType = contentTypeOutput.trim().split(';', 1)[0].toLowerCase();
  const compatible = ['image', 'figure', 'slide', 'frame'].includes(asset.kind)
    ? contentType.startsWith('image/')
    : asset.kind === 'audio'
      ? contentType.startsWith('audio/') || contentType === 'application/octet-stream'
      : contentType.startsWith('video/') || contentType === 'application/octet-stream';
  if (!compatible) throw new Error(`remote media content type is incompatible with ${asset.kind}`);
}

function prepareSourceMedia(
  source: ExtractedSource,
  workspace: string,
  runner: CommandRunner,
  downloadRemote: boolean,
  includePlayableRemote = false,
): ExtractedSource {
  const mediaDirectory = path.join(workspace, 'media');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  const media = source.media.map((asset, index) => {
    if (asset.path) {
      const sourcePath = path.resolve(asset.path);
      if (isInside(path.resolve(workspace), sourcePath)) return asset;
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return asset;
      const extension = path.extname(sourcePath).toLowerCase();
      const destination = path.join(mediaDirectory, `asset-${String(index + 1).padStart(3, '0')}${extension}`);
      fs.copyFileSync(sourcePath, destination);
      return { ...asset, path: destination };
    }
    const isVisual = ['image', 'figure', 'slide', 'frame'].includes(asset.kind);
    if (!downloadRemote || !asset.url || (!isVisual && !includePlayableRemote)) {
      return asset;
    }
    const extension = safeRemoteMediaExtension(asset);
    const destination = path.join(
      mediaDirectory,
      `asset-${String(index + 1).padStart(3, '0')}${extension}`,
    );
    const staging = `${destination}.part`;
    const result = runner.run('curl', [
      '-sS', '-L', '--fail', '--max-time', '30',
      '--max-filesize', String(MAX_REMOTE_MEDIA_BYTES),
      '-o', staging, '-w', '%{content_type}', asset.url,
    ], { timeoutMs: 35000 });
    if (result.status !== 0) throw new Error(`failed to stage media asset: ${asset.id}`);
    requireCompatibleRemoteContentType(asset, result.stdout);
    if (
      !fs.existsSync(staging)
      || !fs.statSync(staging).isFile()
      || fs.statSync(staging).size === 0
      || fs.statSync(staging).size > MAX_REMOTE_MEDIA_BYTES
    ) {
      fs.rmSync(staging, { force: true });
      throw new Error(`failed to stage media asset: ${asset.id}`);
    }
    fs.renameSync(staging, destination);
    return { ...asset, path: destination };
  });
  return { ...source, media };
}

function stageBilibiliAudio(
  source: ExtractedSource,
  workspace: string,
  runner: CommandRunner,
): ExtractedSource {
  if (source.transcript?.length || source.media.some(asset => asset.kind === 'audio' && asset.path)) {
    return source;
  }
  const ytdlp = whichYtDlp(runner);
  if (!ytdlp) {
    return { ...source, warnings: [...new Set([...source.warnings, 'transcription-unavailable'])] };
  }
  const directory = path.join(workspace, 'bilibili-audio');
  fs.mkdirSync(directory, { recursive: true });
  const template = path.join(directory, 'audio.%(ext)s');
  const result = runner.run(ytdlp, ['-x', '--audio-format', 'wav', '-o', template, source.source.url], {
    timeoutMs: 600000,
  });
  if (result.status !== 0) throw new Error('yt-dlp failed to stage Bilibili audio');
  const audioPath = fs.readdirSync(directory)
    .map(name => path.join(directory, name))
    .find(candidate =>
      path.extname(candidate).toLowerCase() === '.wav'
      && fs.statSync(candidate).isFile()
      && fs.statSync(candidate).size > 0);
  if (!audioPath || !isInside(path.resolve(directory), path.resolve(audioPath))) {
    throw new Error('yt-dlp did not produce a usable Bilibili audio file');
  }
  return {
    ...source,
    media: [
      ...source.media,
      {
        id: 'audio-001',
        kind: 'audio',
        path: audioPath,
        url: source.source.url,
        ...(source.source.durationSec === undefined ? {} : { durationSec: source.source.durationSec }),
      },
    ],
  };
}

function mediaDuration(asset: import('./ingest/contracts.ts').MediaAsset, runner: CommandRunner): number {
  if (asset.durationSec !== undefined) {
    if (Number.isFinite(asset.durationSec) && asset.durationSec > 0) return asset.durationSec;
    throw new Error('media duration is invalid');
  }
  const result = runner.run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    asset.path as string,
  ], { timeoutMs: 30000 });
  const duration = Number.parseFloat(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('media duration is unavailable');
  }
  return duration;
}

function transcribeLocalMedia(
  source: ExtractedSource,
  workspace: string,
  config: ReturnType<typeof resolveIngestConfig>,
  runner: CommandRunner,
): ExtractedSource {
  if (source.transcript?.length) return source;
  const inputs = source.media.filter(asset =>
    (asset.kind === 'audio' || asset.kind === 'video') && asset.path);
  if (inputs.length === 0) return source;
  const provider = discoverTranscriptionProvider(config.transcriptionPreference, runner, config);
  if (!provider) {
    return { ...source, warnings: [...source.warnings, 'transcription-unavailable'] };
  }
  let offset = 0;
  const transcript = inputs.flatMap((asset, index) => {
    const duration = mediaDuration(asset, runner);
    const output = path.join(workspace, `transcript-${String(index + 1).padStart(3, '0')}`);
    const localSegments = provider.transcribe(asset.path as string, output);
    if (localSegments.some(segment =>
      segment.start < 0
      || segment.start >= segment.end
      || segment.end > duration)) {
      throw new Error('transcript exceeds media duration bound');
    }
    const segments = localSegments
      .map(segment => ({ ...segment, start: segment.start + offset, end: segment.end + offset }));
    offset += duration;
    return segments;
  });
  if (
    source.source.durationSec !== undefined
    && (!Number.isFinite(source.source.durationSec)
      || source.source.durationSec <= 0
      || offset > source.source.durationSec)
  ) {
    throw new Error('cumulative media duration exceeds source duration bound');
  }
  return transcript.length > 0
    ? {
      ...source,
      transcript,
      warnings: source.warnings.filter(warning =>
        warning !== 'needs-transcription'
        && warning !== 'transcription-unavailable'
        && warning !== 'transcription-empty'),
    }
    : { ...source, warnings: [...source.warnings, 'transcription-empty'] };
}

function sourceCapabilities(source: ExtractedSource, probed: CapabilityReport['capabilities']): CapabilityReport['capabilities'] {
  const capabilities = new Set(probed);
  if (source.blocks.length > 0) capabilities.add('body');
  if (source.transcript?.length) capabilities.add('transcript');
  if (source.media.some(asset => asset.kind === 'image' || asset.kind === 'figure')) capabilities.add('images');
  if (source.media.some(asset => asset.kind === 'slide')) capabilities.add('slides');
  if (source.media.some(asset => asset.kind === 'audio')) capabilities.add('audio');
  if (source.media.some(asset => asset.kind === 'video')) capabilities.add('video');
  return [...capabilities];
}

function transcriptBody(source: ExtractedSource): string | undefined {
  const transcript = source.transcript ?? [];
  if (transcript.length === 0) return undefined;
  const timestamp = (seconds: number): string => {
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remainder = value % 60;
    const pad = (part: number) => String(part).padStart(2, '0');
    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(remainder)}`
      : `${pad(minutes)}:${pad(remainder)}`;
  };
  return [
    `# ${source.source.title}（转写）`,
    '',
    '## 完整转写',
    '',
    ...transcript.flatMap(segment => [
      `**${timestamp(segment.start)}–${timestamp(segment.end)}**${segment.speaker ? ` · ${segment.speaker}` : ''}`,
      '',
      segment.text.trim(),
      '',
    ]),
  ].join('\n').trimEnd() + '\n';
}

export async function runRichIngest(
  options: IngestCliOptions,
  runner: CommandRunner = defaultCommandRunner,
): Promise<IngestPipelineResult> {
  if (!fs.existsSync(options.vaultDir) || !fs.statSync(options.vaultDir).isDirectory()) {
    throw new Error('vault directory does not exist');
  }
  const config = resolveIngestConfig(options.vaultDir);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-run-'));
  let processedMarkdown: string | undefined;
  let processedPath: string | undefined;

  try {
    processedMarkdown = readProcessedMarkdown(options.vaultDir, options.processedMarkdown);
    processedPath = options.processedMarkdown ? fs.realpathSync(options.processedMarkdown) : undefined;

    let source: ExtractedSource;
    let adapterId: string;
    let capabilityReport: CapabilityReport;
    let trustedResourceRoots: string[];
    if (options.bundleDir) {
      source = loadSourceBundle(options.bundleDir);
      adapterId = 'source-bundle-v1';
      capabilityReport = {
        adapterId,
        readable: true,
        capabilities: sourceCapabilities(source, []),
        degradation: source.warnings.length > 0 ? 'partial' : 'none',
        warnings: [...source.warnings],
      };
      const shouldStageRemote = options.write
        || options.mode === 'transcribe'
        || options.mode === 'handout'
        || (
          !options.mode
          && (source.source.kind === 'video' || source.source.kind === 'course')
          && (config.defaultVideoMode === 'transcribe' || config.defaultVideoMode === 'handout')
        );
      source = prepareSourceMedia(source, workspace, runner, shouldStageRemote, true);
      trustedResourceRoots = [workspace];
    } else {
      const url = options.url as URL;
      const { registry } = createRichIngestRegistry(runner);
      const session = await registry.resolveSession(url);
      capabilityReport = await session.probe({ vaultDir: options.vaultDir, tempDir: workspace });
      if (capabilityReport.degradation === 'blocked') {
        throw new SourceBlockedError(session.adapter.id, capabilityReport.warnings);
      }
      const guessedMode = options.mode
        ?? (session.adapter.id === 'bilibili' || session.adapter.id === 'x' ? config.defaultVideoMode : undefined);
      const extractionMode = guessedMode === 'handout' ? 'transcribe' : guessedMode;
      source = await session.extract({
        vaultDir: options.vaultDir,
        tempDir: workspace,
        ...(extractionMode ? { mode: extractionMode } : {}),
      });
      adapterId = session.adapter.id;
      source = prepareSourceMedia(source, workspace, runner, options.write);
      trustedResourceRoots = [workspace];
    }

    const body = source.blocks.map(block => block.markdown).join('\n\n');
    const language = detectLanguage(`${source.source.title}\n${body}`);
    const mode = resolveIngestMode(options.mode, source.source.kind, language, config.defaultVideoMode);
    if (mode === 'handout' || mode === 'transcribe') {
      if (adapterId === 'bilibili') source = stageBilibiliAudio(source, workspace, runner);
      source = transcribeLocalMedia(source, workspace, config, runner);
    }
    const handout = mode === 'handout'
      ? formatHandout(source, { topicHeadings: [] })
      : undefined;
    const generatedTranscript = mode === 'transcribe' ? transcriptBody(source) : undefined;
    const finalizedMarkdown = processedMarkdown ?? generatedTranscript;
    const previewBody = finalizedMarkdown ?? handout?.markdown ?? body;
    const slug = deriveSlug(source.source.title) || 'ingest';
    const today = new Date().toISOString().slice(0, 10);
    const stem = `${today}-${slug}`;
    const frontmatter = generateFrontmatter(source.source.title, today, [], source.source.url);
    const vaultIndex = buildVaultIndex(options.vaultDir);
    const autoLinkResult = autoLink(`${frontmatter}\n\n${previewBody}`, vaultIndex);
    const relatedNotes = scoreRelatedNotes([], source.source.title, vaultIndex, options.vaultDir).slice(0, 5);
    const capabilities = sourceCapabilities(source, capabilityReport.capabilities);
    const probeWarnings = source.transcript?.length
      ? capabilityReport.warnings.filter(warning =>
        warning !== 'needs-transcription'
        && warning !== 'transcription-unavailable'
        && warning !== 'transcription-empty')
      : capabilityReport.warnings;
    const warnings = [...new Set([...probeWarnings, ...source.warnings, ...(handout?.warnings ?? [])])];

    let writeResult: FinalizeResult | undefined;
    if (options.write) {
      writeResult = finalizeIngest({
        vaultDir: options.vaultDir,
        source,
        ...(handout ? { handout } : {}),
        ...(finalizedMarkdown ? { processedMarkdown: finalizedMarkdown } : {}),
        ...(options.topic ? { topic: options.topic } : {}),
        stem,
        created: today,
        trustedResourceRoots,
      });
      if (processedPath) fs.rmSync(processedPath, { force: true });
    }

    return {
      title: source.source.title,
      slug,
      language,
      mode,
      frontmatter,
      content: autoLinkResult.linkedBody,
      images: source.media.flatMap(asset => asset.kind === 'image' && asset.url ? [asset.url] : []),
      autoLinks: autoLinkResult.links,
      relatedNotes,
      sourceKind: source.source.kind,
      adapterId,
      capabilities,
      degradation: warnings.length > 0 ? 'partial' : 'none',
      ...(capabilityReport.completeness ? { completeness: capabilityReport.completeness } : {}),
      warnings,
      ...(handout ? { handoutKind: handout.kind } : {}),
      ...(writeResult ? { writeResult } : {}),
      ...(source.warnings.includes('needs-transcription') ? { needsTranscription: true } : {}),
      ...(capabilities.includes('transcript') ? { transcriptionAvailable: true } : {}),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`Usage: bun run bin/ingest.ts <url> [--mode translate-cn|summarize|raw|transcribe|handout] [--vault-dir DIR] [--topic SLUG] [--processed-markdown FILE] [--write]
       bun run bin/ingest.ts --bundle <directory> [--mode translate-cn|summarize|raw|transcribe|handout] [--vault-dir DIR] [--topic SLUG] [--processed-markdown FILE] [--write]
       bun run bin/ingest.ts --download-images --vault-dir DIR --target-dir DIR --urls url1,url2,...

Options:
  --mode       Processing mode: translate-cn (default for English), summarize (default for Chinese),
               raw, transcribe, or handout (default for video/course)
  --bundle     Load a validated Source Bundle v1 directory instead of a URL
  --vault-dir  Vault directory (default: current directory)
  --topic      Optional ASCII kebab topic path under the configured raw layer
  --processed-markdown
               Agent-edited Markdown inside <vault>/.me/tmp/ (requires --write)
  --write      Atomically finalize the note and assets; otherwise emit JSON preview only
  --help       Show this help

Download mode:
  --download-images  Download image files
  --target-dir       Target directory for images
  --urls             Comma-separated list of image URLs

Output: JSON preview with legacy fields plus { sourceKind, adapterId, capabilities, warnings,
        handoutKind?, writeResult? }
`);
    process.exit(0);
  }

  // Download images mode
  if (args.includes('--download-images')) {
    const vaultDirIdx = args.indexOf('--vault-dir');
    const targetDirIdx = args.indexOf('--target-dir');
    const urlsIdx = args.indexOf('--urls');

    const vaultDir = vaultDirIdx !== -1 ? args[vaultDirIdx + 1] : process.cwd();
    const targetDir = targetDirIdx !== -1 ? args[targetDirIdx + 1] : path.join(vaultDir, 'images');
    const urlsArg = urlsIdx !== -1 ? args[urlsIdx + 1] : '';
    const urls = urlsArg ? urlsArg.split(',').filter(Boolean) : [];

    const results: Array<{ url: string; success: boolean; filename: string }> = [];
    for (const imageUrl of urls) {
      const filename = path.basename(new URL(imageUrl).pathname) || `image-${Date.now()}.jpg`;
      const success = downloadImage(imageUrl, targetDir, filename);
      results.push({ url: imageUrl, success, filename });
    }
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  try {
    const options = parseIngestCliOptions(args);
    console.log(JSON.stringify(await runRichIngest(options), null, 2));
  } catch (error: unknown) {
    console.error(JSON.stringify(ingestErrorPayload(error)));
    process.exit(1);
  }
}
