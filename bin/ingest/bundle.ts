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

const SENSITIVE_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'awsaccesskeyid',
  'awssecretaccesskey',
  'clientsecret',
  'cookie',
  'credential',
  'decryptkey',
  'decryptionkey',
  'password',
  'passwd',
  'privatekey',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'securitytoken',
  'sessiontoken',
  'setcookie',
  'signature',
  'token',
  'xapikey',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
]);
const HIGH_CONFIDENCE_CREDENTIAL = /(?:^|[\s"'=:,(])(?:Bearer|Basic)\s+\S+|(?:^|[\s"'=:,(])(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}|(?:^|[\s"'=:,(])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[\s"',;)])|(?:^|[\s"'=:,(])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[\s"',;)])|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const KEYED_VALUE = /\b([A-Za-z][A-Za-z0-9_-]{1,63})\s*[:=]\s*(\S+)/g;
const ABSOLUTE_LOCAL_PATH = /(?:^|[\s"'=(])(?:\/(?!\/)[^\s"']+|[A-Za-z]:\\[^\s"']+)/;
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
    issues.push(`duplicate ${label} id`);
    return;
  }
  ids.add(id);
}

function rejectUnknownKeys(value: RecordValue, allowed: string[], label: string, issues: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${label} contains an unknown field`);
  }
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeSensitiveKey(key));
}

function isSourceBody(pathParts: Array<string | number>): boolean {
  return (
    pathParts.length === 3
    && pathParts[0] === 'blocks'
    && typeof pathParts[1] === 'number'
    && pathParts[2] === 'markdown'
  ) || (
    pathParts.length === 3
    && pathParts[0] === 'transcript'
    && typeof pathParts[1] === 'number'
    && pathParts[2] === 'text'
  );
}

function addIssue(issues: string[], issue: string): void {
  if (!issues.includes(issue)) issues.push(issue);
}

function scanSensitiveString(value: string, issues: string[]): void {
  if (HIGH_CONFIDENCE_CREDENTIAL.test(value)) {
    addIssue(issues, 'bundle contains sensitive credential data');
  }

  KEYED_VALUE.lastIndex = 0;
  for (const match of value.matchAll(KEYED_VALUE)) {
    if (isSensitiveKey(match[1])) {
      addIssue(issues, 'bundle contains sensitive credential data');
      break;
    }
  }

  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.username || url.password) {
        addIssue(issues, 'bundle contains sensitive credential data');
      }
      for (const [key, queryValue] of url.searchParams) {
        if (isSensitiveKey(key) || HIGH_CONFIDENCE_CREDENTIAL.test(queryValue)) {
          addIssue(issues, 'bundle contains sensitive credential data');
          break;
        }
      }
    }
  } catch {
    // Non-URL strings still receive keyed-value and token scanning above.
  }

  if (ABSOLUTE_LOCAL_PATH.test(value)) {
    addIssue(issues, 'bundle contains a local path');
  }
}

function scanSensitiveStructure(
  value: unknown,
  issues: string[],
  pathParts: Array<string | number> = [],
  seen = new WeakSet<object>(),
): void {
  if (typeof value === 'string') {
    if (!isSourceBody(pathParts)) scanSensitiveString(value, issues);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSensitiveStructure(child, issues, [...pathParts, index], seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) addIssue(issues, 'forbidden sensitive credential field');
    scanSensitiveStructure(child, issues, [...pathParts, key], seen);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function requireHttpUrl(value: unknown, label: string, issues: string[]): value is string {
  if (!requireString(value, label, issues)) return false;
  if (!isHttpUrl(value)) {
    issues.push(`${label} must be an http(s) URL`);
    return false;
  }
  return true;
}

function optionalString(value: unknown, label: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label, issues) ? value : undefined;
}

function validateSource(value: unknown, issues: string[]): ExtractedSource['source'] | undefined {
  const source = requireRecord(value, 'source', issues);
  if (!source) return undefined;
  rejectUnknownKeys(source, ['url', 'canonicalUrl', 'kind', 'title', 'author', 'publishedAt', 'language', 'durationSec'], 'source', issues);
  const url = requireHttpUrl(source.url, 'source.url', issues) ? source.url : '';
  const title = requireString(source.title, 'source.title', issues) ? source.title : '';
  const kind = source.kind;
  if (typeof kind !== 'string' || !SOURCE_KINDS.has(kind)) issues.push('source.kind is invalid');
  const canonicalUrl = source.canonicalUrl === undefined ? undefined : (requireHttpUrl(source.canonicalUrl, 'source.canonicalUrl', issues) ? source.canonicalUrl : undefined);
  const author = optionalString(source.author, 'source.author', issues);
  const publishedAt = optionalString(source.publishedAt, 'source.publishedAt', issues);
  const language = optionalString(source.language, 'source.language', issues);
  if (source.durationSec !== undefined && (typeof source.durationSec !== 'number' || !Number.isFinite(source.durationSec) || source.durationSec <= 0)) {
    issues.push('source.durationSec must be a positive finite number');
  }
  return {
    url,
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    kind: kind as ExtractedSource['source']['kind'],
    title,
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(language === undefined ? {} : { language }),
    ...(source.durationSec === undefined ? {} : { durationSec: source.durationSec as number }),
  };
}

function validateBlocks(value: unknown, issues: string[]): SourceBlock[] {
  if (!Array.isArray(value)) {
    issues.push('blocks must be an array');
    return [];
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const block = requireRecord(item, `blocks[${index}]`, issues) ?? {};
    rejectUnknownKeys(block, ['id', 'kind', 'markdown', 'mediaId', 'page'], `blocks[${index}]`, issues);
    const id = requireString(block.id, `blocks[${index}].id`, issues) ? block.id : '';
    requireUniqueId(id, ids, 'block', issues);
    if (typeof block.kind !== 'string' || !BLOCK_KINDS.has(block.kind)) issues.push(`blocks[${index}].kind is invalid`);
    const markdown = requireString(block.markdown, `blocks[${index}].markdown`, issues) ? block.markdown : '';
    const mediaId = optionalString(block.mediaId, `blocks[${index}].mediaId`, issues);
    if (block.page !== undefined && (
      typeof block.page !== 'number'
      || !Number.isInteger(block.page)
      || block.page < 1
    )) {
      issues.push(`blocks[${index}].page must be a positive integer`);
    }
    return {
      id,
      kind: block.kind as SourceBlock['kind'],
      markdown,
      ...(mediaId === undefined ? {} : { mediaId }),
      ...(block.page === undefined ? {} : { page: block.page as number }),
    };
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
    rejectUnknownKeys(media, ['id', 'kind', 'path', 'url', 'durationSec', 'alt', 'caption', 'timestampSec', 'page'], `media[${index}]`, issues);
    const id = requireString(media.id, `media[${index}].id`, issues) ? media.id : '';
    requireUniqueId(id, ids, 'media', issues);
    if (typeof media.kind !== 'string' || !MEDIA_KINDS.has(media.kind)) issues.push(`media[${index}].kind is invalid`);
    const url = media.url === undefined ? undefined : (requireHttpUrl(media.url, `media[${index}].url`, issues) ? media.url : undefined);
    const alt = optionalString(media.alt, `media[${index}].alt`, issues);
    const caption = optionalString(media.caption, `media[${index}].caption`, issues);
    if (media.durationSec !== undefined && (
      typeof media.durationSec !== 'number'
      || !Number.isFinite(media.durationSec)
      || media.durationSec <= 0
    )) {
      issues.push(`media[${index}].durationSec must be a positive finite number`);
    }
    if (media.timestampSec !== undefined && (typeof media.timestampSec !== 'number' || !Number.isFinite(media.timestampSec))) issues.push(`media[${index}].timestampSec must be a finite number`);
    if (media.page !== undefined && (
      typeof media.page !== 'number'
      || !Number.isInteger(media.page)
      || media.page < 1
    )) {
      issues.push(`media[${index}].page must be a positive integer`);
    }
    let assetPath: string | undefined = media.path === undefined ? undefined : media.path as string;
    if (assetPath !== undefined) {
      if (typeof assetPath !== 'string' || assetPath.length === 0) {
        issues.push(`media[${index}].path must be a non-empty string`);
      } else {
        const resolved = path.resolve(bundleDir, assetPath);
        if (path.isAbsolute(assetPath) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
          issues.push('media path escapes bundle root');
        } else if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          issues.push('media resource does not exist');
        } else {
          const realPath = fs.realpathSync(resolved);
          if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
            issues.push('media path escapes bundle root');
          } else {
            assetPath = resolved;
          }
        }
      }
    }
    if (assetPath === undefined && url === undefined) {
      issues.push(`media[${index}] must provide path or url`);
    }
    return {
      id,
      kind: media.kind as MediaAsset['kind'],
      ...(assetPath === undefined ? {} : { path: assetPath }),
      ...(url === undefined ? {} : { url }),
      ...(media.durationSec === undefined ? {} : { durationSec: media.durationSec as number }),
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
      ...(media.timestampSec === undefined ? {} : { timestampSec: media.timestampSec as number }),
      ...(media.page === undefined ? {} : { page: media.page as number }),
    };
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
    rejectUnknownKeys(segment, ['start', 'end', 'text', 'speaker'], `transcript[${index}]`, issues);
    const start = segment.start;
    const end = segment.end;
    if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end) || start < 0 || start >= end) {
      issues.push(`transcript[${index}] must satisfy 0 <= start < end`);
    } else if (index > 0 && start < previousEnd) {
      issues.push('transcript segments must be sorted and non-overlapping');
    }
    if (typeof end === 'number' && Number.isFinite(end)) previousEnd = end;
    const text = requireString(segment.text, `transcript[${index}].text`, issues) ? segment.text : '';
    const speaker = optionalString(segment.speaker, `transcript[${index}].speaker`, issues);
    return { start: start as number, end: end as number, text, ...(speaker === undefined ? {} : { speaker }) };
  });
}

function validateProvenance(value: unknown, issues: string[]): ExtractedSource['provenance'] | undefined {
  const provenance = requireRecord(value, 'provenance', issues);
  if (!provenance) return undefined;
  rejectUnknownKeys(provenance, ['extractor', 'extractedAt', 'methods'], 'provenance', issues);
  const extractor = requireString(provenance.extractor, 'provenance.extractor', issues) ? provenance.extractor : '';
  const extractedAt = requireString(provenance.extractedAt, 'provenance.extractedAt', issues) ? provenance.extractedAt : '';
  if (!Array.isArray(provenance.methods) || provenance.methods.some(method => typeof method !== 'string')) issues.push('provenance.methods must be an array of strings');
  return { extractor, extractedAt, methods: Array.isArray(provenance.methods) ? provenance.methods as string[] : [] };
}

function validateWarnings(value: unknown, issues: string[]): SourceBundleV1['warnings'] {
  if (!Array.isArray(value)) {
    issues.push('warnings must be an array');
    return [];
  }
  return value.map((item, index) => {
    const warning = requireRecord(item, `warnings[${index}]`, issues) ?? {};
    rejectUnknownKeys(warning, ['code', 'message', 'mediaId'], `warnings[${index}]`, issues);
    const code = requireString(warning.code, `warnings[${index}].code`, issues) ? warning.code : '';
    const message = requireString(warning.message, `warnings[${index}].message`, issues) ? warning.message : '';
    const mediaId = optionalString(warning.mediaId, `warnings[${index}].mediaId`, issues);
    return { code, message, ...(mediaId === undefined ? {} : { mediaId }) };
  });
}

export function validateSourceBundle(value: unknown, bundleDir: string): SourceBundleV1 {
  const issues: string[] = [];
  scanSensitiveStructure(value, issues);
  const bundle = requireRecord(value, 'bundle', issues) ?? {};
  rejectUnknownKeys(bundle, ['version', 'source', 'blocks', 'transcript', 'media', 'provenance', 'warnings'], 'bundle', issues);
  if (bundle.version !== 1) issues.push('version must be 1');
  const source = validateSource(bundle.source, issues);
  const blocks = validateBlocks(bundle.blocks, issues);
  const media = validateMedia(bundle.media, bundleDir, issues);
  const transcript = validateTranscript(bundle.transcript, issues);
  const provenance = validateProvenance(bundle.provenance, issues);
  const warnings = validateWarnings(bundle.warnings, issues);
  const mediaIds = new Set(media.map(asset => asset.id));
  for (const block of blocks) {
    if (block.mediaId && !mediaIds.has(block.mediaId)) issues.push('block references missing media');
  }
  if (issues.length > 0) throw new BundleValidationError(issues);
  return { version: 1, source: source!, blocks, ...(transcript === undefined ? {} : { transcript }), media, provenance: provenance!, warnings };
}

export function loadSourceBundle(bundleDir: string): ExtractedSource {
  const manifestPath = path.join(bundleDir, 'source-bundle.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new BundleValidationError(['cannot load source bundle']);
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
