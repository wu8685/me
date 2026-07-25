import * as fs from 'fs';
import * as path from 'path';
import type {
  ExtractedSource,
  MediaAsset,
  SourceBlock,
  TranscriptSegment,
} from './contracts.ts';

export interface SourceBundleV1 {
  version: 1;
  source: ExtractedSource['source'];
  blocks: SourceBlock[];
  transcript?: TranscriptSegment[];
  media: MediaAsset[];
  provenance: ExtractedSource['provenance'];
  warnings: Array<{ code: string; message: string; mediaId?: string }>;
}

const FORBIDDEN_KEYS = /^(cookie|authorization|token|decrypt(?:ion)?key|secret)$/i;
const SOURCE_KINDS = new Set(['article', 'paper', 'video', 'course']);
const BLOCK_KINDS = new Set(['heading', 'paragraph', 'quote', 'code', 'image', 'figure']);
const MEDIA_KINDS = new Set(['image', 'figure', 'audio', 'video', 'slide', 'frame']);

export class BundleValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid source bundle: ${issues.join('; ')}`);
    this.name = 'BundleValidationError';
    this.issues = issues;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string, issues: string[]): RecordValue | undefined {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }
  return value;
}

function requireString(value: unknown, label: string, issues: string[]): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function requireUniqueId(id: string, ids: Set<string>, label: string, issues: string[]): void {
  if (!id) return;
  if (ids.has(id)) {
    issues.push(`duplicate ${label} id: ${id}`);
    return;
  }
  ids.add(id);
}

function rejectForbiddenKeys(value: unknown, issues: string[], seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) issues.push(`forbidden key: ${key}`);
    rejectForbiddenKeys(child, issues, seen);
  }
}

function validateSource(value: unknown, issues: string[]): ExtractedSource['source'] | undefined {
  const source = requireRecord(value, 'source', issues);
  if (!source) return undefined;
  const url = requireString(source.url, 'source.url', issues) ? source.url : '';
  const title = requireString(source.title, 'source.title', issues) ? source.title : '';
  const kind = source.kind;
  if (typeof kind !== 'string' || !SOURCE_KINDS.has(kind)) issues.push('source.kind is invalid');
  if (source.canonicalUrl !== undefined && typeof source.canonicalUrl !== 'string') issues.push('source.canonicalUrl must be a string');
  if (source.author !== undefined && typeof source.author !== 'string') issues.push('source.author must be a string');
  if (source.publishedAt !== undefined && typeof source.publishedAt !== 'string') issues.push('source.publishedAt must be a string');
  if (source.language !== undefined && typeof source.language !== 'string') issues.push('source.language must be a string');
  if (source.durationSec !== undefined && (typeof source.durationSec !== 'number' || !Number.isFinite(source.durationSec))) issues.push('source.durationSec must be a finite number');
  return { ...source, url, title, kind: kind as ExtractedSource['source']['kind'] } as ExtractedSource['source'];
}

function validateBlocks(value: unknown, issues: string[]): SourceBlock[] {
  if (!Array.isArray(value)) {
    issues.push('blocks must be an array');
    return [];
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const block = requireRecord(item, `blocks[${index}]`, issues) ?? {};
    const id = requireString(block.id, `blocks[${index}].id`, issues) ? block.id : '';
    requireUniqueId(id, ids, 'block', issues);
    if (typeof block.kind !== 'string' || !BLOCK_KINDS.has(block.kind)) issues.push(`blocks[${index}].kind is invalid`);
    const markdown = requireString(block.markdown, `blocks[${index}].markdown`, issues) ? block.markdown : '';
    if (block.mediaId !== undefined && typeof block.mediaId !== 'string') issues.push(`blocks[${index}].mediaId must be a string`);
    if (block.page !== undefined && (!Number.isInteger(block.page) || block.page < 1)) issues.push(`blocks[${index}].page must be a positive integer`);
    return { ...block, id, markdown } as SourceBlock;
  });
}

function validateMedia(value: unknown, bundleDir: string, issues: string[]): MediaAsset[] {
  if (!Array.isArray(value)) {
    issues.push('media must be an array');
    return [];
  }
  const root = path.resolve(bundleDir);
  const realRoot = fs.realpathSync(root);
  const ids = new Set<string>();
  return value.map((item, index) => {
    const media = requireRecord(item, `media[${index}]`, issues) ?? {};
    const id = requireString(media.id, `media[${index}].id`, issues) ? media.id : '';
    requireUniqueId(id, ids, 'media', issues);
    if (typeof media.kind !== 'string' || !MEDIA_KINDS.has(media.kind)) issues.push(`media[${index}].kind is invalid`);
    if (media.url !== undefined && typeof media.url !== 'string') issues.push(`media[${index}].url must be a string`);
    let assetPath = media.path;
    if (assetPath !== undefined) {
      if (typeof assetPath !== 'string' || assetPath.length === 0) {
        issues.push(`media[${index}].path must be a non-empty string`);
      } else {
        const resolved = path.resolve(bundleDir, assetPath);
        if (path.isAbsolute(assetPath) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
          issues.push(`media path escapes bundle root: ${assetPath}`);
        } else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          issues.push(`media resource does not exist: ${assetPath}`);
        } else {
          const realPath = fs.realpathSync(resolved);
          if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
            issues.push(`media path escapes bundle root: ${assetPath}`);
          } else {
            assetPath = resolved;
          }
        }
      }
    }
    return { ...media, id, path: assetPath } as MediaAsset;
  });
}

function validateTranscript(value: unknown, issues: string[]): TranscriptSegment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push('transcript must be an array');
    return undefined;
  }
  let previousEnd = 0;
  return value.map((item, index) => {
    const segment = requireRecord(item, `transcript[${index}]`, issues) ?? {};
    const start = segment.start;
    const end = segment.end;
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end) || start < 0 || start >= end) {
      issues.push(`transcript[${index}] must satisfy 0 <= start < end`);
    } else if (index > 0 && start < previousEnd) {
      issues.push('transcript segments must be sorted and non-overlapping');
    }
    if (typeof end === 'number' && Number.isFinite(end)) previousEnd = end;
    const text = requireString(segment.text, `transcript[${index}].text`, issues) ? segment.text : '';
    if (segment.speaker !== undefined && typeof segment.speaker !== 'string') issues.push(`transcript[${index}].speaker must be a string`);
    return { ...segment, start, end, text } as TranscriptSegment;
  });
}

function validateProvenance(value: unknown, issues: string[]): ExtractedSource['provenance'] | undefined {
  const provenance = requireRecord(value, 'provenance', issues);
  if (!provenance) return undefined;
  const extractor = requireString(provenance.extractor, 'provenance.extractor', issues) ? provenance.extractor : '';
  const extractedAt = requireString(provenance.extractedAt, 'provenance.extractedAt', issues) ? provenance.extractedAt : '';
  if (!Array.isArray(provenance.methods) || provenance.methods.some(method => typeof method !== 'string')) issues.push('provenance.methods must be an array of strings');
  return { ...provenance, extractor, extractedAt, methods: Array.isArray(provenance.methods) ? provenance.methods as string[] : [] };
}

function validateWarnings(value: unknown, issues: string[]): SourceBundleV1['warnings'] {
  if (!Array.isArray(value)) {
    issues.push('warnings must be an array');
    return [];
  }
  return value.map((item, index) => {
    const warning = requireRecord(item, `warnings[${index}]`, issues) ?? {};
    const code = requireString(warning.code, `warnings[${index}].code`, issues) ? warning.code : '';
    const message = requireString(warning.message, `warnings[${index}].message`, issues) ? warning.message : '';
    if (warning.mediaId !== undefined && typeof warning.mediaId !== 'string') issues.push(`warnings[${index}].mediaId must be a string`);
    return { ...warning, code, message } as SourceBundleV1['warnings'][number];
  });
}

export function validateSourceBundle(value: unknown, bundleDir: string): SourceBundleV1 {
  const issues: string[] = [];
  rejectForbiddenKeys(value, issues);
  const bundle = requireRecord(value, 'bundle', issues) ?? {};
  if (bundle.version !== 1) issues.push('version must be 1');
  const source = validateSource(bundle.source, issues);
  const blocks = validateBlocks(bundle.blocks, issues);
  const media = validateMedia(bundle.media, bundleDir, issues);
  const transcript = validateTranscript(bundle.transcript, issues);
  const provenance = validateProvenance(bundle.provenance, issues);
  const warnings = validateWarnings(bundle.warnings, issues);
  const mediaIds = new Set(media.map(asset => asset.id));
  for (const block of blocks) {
    if (block.mediaId && !mediaIds.has(block.mediaId)) issues.push(`block ${block.id} references missing media: ${block.mediaId}`);
  }
  if (issues.length > 0) throw new BundleValidationError(issues);
  return { version: 1, source: source!, blocks, ...(transcript === undefined ? {} : { transcript }), media, provenance: provenance!, warnings };
}

export function loadSourceBundle(bundleDir: string): ExtractedSource {
  const manifestPath = path.join(bundleDir, 'source-bundle.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new BundleValidationError([`cannot load source bundle: ${reason}`]);
  }
  const bundle = validateSourceBundle(parsed, bundleDir);
  return {
    source: bundle.source,
    blocks: bundle.blocks,
    ...(bundle.transcript === undefined ? {} : { transcript: bundle.transcript }),
    media: bundle.media,
    provenance: bundle.provenance,
    warnings: bundle.warnings.map(warning => warning.message),
  };
}
