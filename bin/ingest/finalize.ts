import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import {
  buildVaultIndex,
  deriveSlug,
  resolveConfig,
  scoreRelatedNotes,
  type RelatedNote,
} from '../ingest.ts';
import type { ExtractedSource, MediaAsset } from './contracts.ts';
import type { HandoutResult } from './handout.ts';

export interface FinalizeInput {
  vaultDir: string;
  source: ExtractedSource;
  handout?: HandoutResult;
  processedMarkdown?: string;
  frontmatter?: string;
  topic?: string;
  stem?: string;
  created?: string;
  tags?: string[];
  /**
   * Narrow roots established by orchestration from adapter/bundle context.
   * Never accept these roots directly from an end-user CLI flag.
   */
  trustedResourceRoots: string[];
}

export interface BacklinkSuggestion {
  path: string;
  count: number;
}

export interface FinalizeResult {
  notePath: string;
  stem: string;
  assetPaths: string[];
  readmePath?: string;
  relatedNotes: RelatedNote[];
  backlinks: BacklinkSuggestion[];
  unlinkedMentions: string[];
  warnings: string[];
}

export interface FinalizeFileOperations {
  renameSync(source: fs.PathLike, destination: fs.PathLike): void;
  beforeArtifactPublish?(destination: string): void;
  beforeReadmeCompare?(readmePath: string): void;
}

interface PlannedAsset {
  asset: MediaAsset;
  relativePath: string;
  sourcePath: string;
  stagedPath: string;
  finalPath: string;
}

interface ReadmeState {
  kind: 'absent' | 'file' | 'directory';
  content?: string;
  metadata?: string;
}

interface TrustedRoot {
  lexical: string;
  real: string;
}

interface PublishedArtifact {
  path: string;
  manifest: Map<string, string>;
}

const FRONTMATTER_FIELDS = new Set(['title', 'created', 'tags', 'type', 'source']);
const VISUAL_KINDS = new Set<MediaAsset['kind']>(['image', 'figure', 'slide', 'frame']);
const VISUAL_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEM_PATTERN = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isVisualAsset(asset: MediaAsset): boolean {
  return VISUAL_KINDS.has(asset.kind);
}

function visualAssets(source: ExtractedSource): MediaAsset[] {
  return source.media.filter(isVisualAsset);
}

function visualReferenceIds(source: ExtractedSource): string[] {
  return source.blocks
    .filter(block => block.kind === 'image' || block.kind === 'figure')
    .map(block => block.mediaId)
    .filter((id): id is string => Boolean(id));
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yamlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function validateDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('frontmatter schema: created must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('frontmatter schema: created must be a real date');
  }
}

function safeStem(value: string, created: string): string {
  const match = value.match(STEM_PATTERN);
  if (!match || match[1] !== created) throw new Error('stem must be YYYY-MM-DD-kebab-slug and match created');
  return value;
}

function safeTopic(value: string | undefined): string {
  if (!value) return '';
  if (path.isAbsolute(value) || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('target path is outside vault');
  }
  const components = value.split('/');
  if (components.some(component => !component || component === '.' || component === '..')) {
    throw new Error('target path is outside vault');
  }
  return components.join(path.sep);
}

function assertSafeVaultPath(vaultDir: string, candidate: string, label: string): void {
  const lexicalRoot = path.resolve(vaultDir);
  const lexicalCandidate = path.resolve(candidate);
  if (!isInside(lexicalRoot, lexicalCandidate)) throw new Error(`${label} is outside vault`);

  const realRoot = fs.realpathSync(lexicalRoot);
  let current = lexicalRoot;
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) continue;
    const realCurrent = fs.realpathSync(current);
    if (!isInside(realRoot, realCurrent)) throw new Error(`${label} is outside vault`);
  }
}

function assertVaultTreeDoesNotEscape(vaultDir: string, directories: string[]): void {
  const realVault = fs.realpathSync(vaultDir);
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        let real: string;
        try {
          real = fs.realpathSync(candidate);
        } catch {
          throw new Error('vault note path is outside vault');
        }
        if (!isInside(realVault, real)) throw new Error('vault note path is outside vault');
        continue;
      }
      if (stat.isDirectory()) walk(candidate);
    }
  };
  for (const directory of directories) walk(directory);
}

function createDirectoryTracked(directory: string, created: string[]): void {
  if (fs.existsSync(directory)) return;
  const parent = path.dirname(directory);
  if (parent !== directory) createDirectoryTracked(parent, created);
  fs.mkdirSync(directory);
  created.push(directory);
}

function cleanupCreatedDirectories(created: string[]): void {
  for (const directory of [...created].reverse()) {
    try {
      if (fs.existsSync(directory) && fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
      }
    } catch {
      // Best-effort cleanup must never hide the original failure.
    }
  }
}

function trustedRoots(input: FinalizeInput, vaultDir: string): TrustedRoot[] {
  const configured = input.trustedResourceRoots;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('at least one trusted resource root is required');
  }
  const realVault = fs.realpathSync(vaultDir);
  const realHome = fs.realpathSync(os.homedir());
  const filesystemRoot = path.parse(realVault).root;
  const roots = configured.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !fs.existsSync(root)) {
      throw new Error('trusted resource root must be an existing absolute directory');
    }
    const real = fs.realpathSync(root);
    if (
      !fs.statSync(real).isDirectory()
      || real === filesystemRoot
      || isInside(real, realHome)
      || isInside(real, realVault)
    ) {
      throw new Error('trusted resource root is too broad');
    }
    return { lexical: path.resolve(root), real };
  });
  return roots.filter((root, index) =>
    roots.findIndex(candidate => candidate.lexical === root.lexical && candidate.real === root.real) === index);
}

function resolveResourcePath(sourcePath: string | undefined, roots: TrustedRoot[]): string {
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error('missing asset');
  }
  const lexicalSource = path.resolve(sourcePath);
  const matchingRoots = roots.filter(root => isInside(root.lexical, lexicalSource));
  if (matchingRoots.length === 0) throw new Error('asset is outside trusted resource roots');
  if (!fs.existsSync(sourcePath)) throw new Error('missing asset');

  let realSource: string;
  try {
    if (!fs.statSync(sourcePath).isFile()) throw new Error('not a file');
    realSource = fs.realpathSync(sourcePath);
  } catch {
    throw new Error('missing asset');
  }

  const allowed = matchingRoots.some(root => isInside(root.real, realSource));
  if (!allowed) throw new Error('asset is outside trusted resource roots');
  return realSource;
}

function validateMediaExtension(asset: MediaAsset, sourcePath: string): void {
  const extension = path.extname(asset.path ?? sourcePath).toLowerCase();
  if (VISUAL_KINDS.has(asset.kind) && !VISUAL_EXTENSIONS.has(extension)) {
    throw new Error('media extension is incompatible with media kind');
  }
}

function parseFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) {
    return { body: markdown };
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('frontmatter schema: unterminated frontmatter');
  return {
    frontmatter: markdown.slice(0, match[0].lastIndexOf('---') + 3),
    body: markdown.slice(match[0].length),
  };
}

function scalar(value: string): string {
  const clean = value.trim();
  if (
    clean.length >= 2
    && ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'")))
  ) {
    return clean.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return clean;
}

function validateTag(value: unknown): string {
  if (typeof value !== 'string' || !TAG_PATTERN.test(value)) {
    throw new Error('frontmatter schema: tags must contain English kebab-case strings');
  }
  return value;
}

function parseTagList(value: string): string[] {
  const clean = value.trim();
  if (!clean.startsWith('[') || !clean.endsWith(']')) {
    throw new Error('frontmatter schema: tags must be an inline list');
  }
  const tags: string[] = [];
  let index = 1;
  const skipWhitespace = (): void => {
    while (index < clean.length && /\s/.test(clean[index])) index += 1;
  };
  skipWhitespace();
  if (clean[index] === ']') {
    if (index !== clean.length - 1) throw new Error('frontmatter schema: malformed tags list');
    return tags;
  }

  while (index < clean.length - 1) {
    const quote = clean[index];
    if (quote !== '"' && quote !== "'") {
      throw new Error('frontmatter schema: tags must contain explicitly quoted strings');
    }
    const start = index;
    index += 1;
    let singleQuoted = '';
    let closed = false;
    while (index < clean.length - 1) {
      const character = clean[index];
      if (quote === '"' && character === '\\') {
        index += 2;
        continue;
      }
      if (character === quote) {
        if (quote === "'" && clean[index + 1] === "'") {
          singleQuoted += "'";
          index += 2;
          continue;
        }
        closed = true;
        index += 1;
        break;
      }
      if (quote === "'") singleQuoted += character;
      index += 1;
    }
    if (!closed) throw new Error('frontmatter schema: malformed tags list');

    let parsed: unknown;
    if (quote === '"') {
      try {
        parsed = JSON.parse(clean.slice(start, index));
      } catch {
        throw new Error('frontmatter schema: malformed tags list');
      }
    } else {
      parsed = singleQuoted;
    }
    tags.push(validateTag(parsed));

    skipWhitespace();
    if (clean[index] === ']') {
      if (index !== clean.length - 1) throw new Error('frontmatter schema: malformed tags list');
      return tags;
    }
    if (clean[index] !== ',') throw new Error('frontmatter schema: malformed tags list');
    index += 1;
    skipWhitespace();
    if (clean[index] === ']') throw new Error('frontmatter schema: malformed tags list');
  }
  throw new Error('frontmatter schema: malformed tags list');
}

function validateFrontmatter(frontmatter: string, source: ExtractedSource): void {
  const match = frontmatter.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
  if (!match) throw new Error('frontmatter schema: invalid delimiters');
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!entry || !FRONTMATTER_FIELDS.has(entry[1]) || values.has(entry[1])) {
      throw new Error('frontmatter schema: unknown, malformed, or duplicate field');
    }
    values.set(entry[1], entry[2]);
  }
  if ([...FRONTMATTER_FIELDS].some(field => !values.has(field))) {
    throw new Error('frontmatter schema: missing required field');
  }
  if (!scalar(values.get('title') ?? '')) throw new Error('frontmatter schema: title is empty');
  validateDate(scalar(values.get('created') ?? ''));
  parseTagList(values.get('tags') ?? '');
  if (scalar(values.get('type') ?? '') !== 'article') {
    throw new Error('frontmatter schema: raw ingest type must be article');
  }
  const sourceValue = scalar(values.get('source') ?? '');
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceValue);
  } catch {
    throw new Error('frontmatter schema: source must be a URL');
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceValue !== source.source.url) {
    throw new Error('frontmatter schema: source must match the extracted source URL');
  }
}

function generatedFrontmatter(input: FinalizeInput, created: string): string {
  if (input.tags !== undefined && !Array.isArray(input.tags)) throw new Error('frontmatter schema: tags must be a list');
  const tags = (input.tags ?? []).map(validateTag);
  return [
    '---',
    `title: ${yamlString(input.source.source.title)}`,
    `created: ${created}`,
    `tags: [${tags.map(yamlString).join(', ')}]`,
    'type: article',
    `source: ${yamlString(input.source.source.url)}`,
    '---',
  ].join('\n');
}

function hasSubstantiveVideoBody(source: ExtractedSource): boolean {
  return source.blocks.some((block) => {
    if (!['paragraph', 'quote', 'code'].includes(block.kind)) return false;
    const markdown = block.markdown.trim();
    if (
      /^>\s*(?:author|作者|duration|时长|published|发布日期|播放|views?)\s*[:：]/i.test(markdown)
    ) {
      return false;
    }
    const visible = markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[`*_>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return visible.length >= 40;
  });
}

function hasPublishableVideoMedia(source: ExtractedSource): boolean {
  const referenced = new Set(visualReferenceIds(source));
  return visualAssets(source).some(asset =>
    Boolean(asset.path)
    && referenced.has(asset.id));
}

function validateSource(source: ExtractedSource, handout?: HandoutResult): void {
  if (!source.source.title.trim()) throw new Error('source title is empty');
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source.source.url);
  } catch {
    throw new Error('source URL is invalid');
  }
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('source URL is invalid');

  const mediaIds = new Set<string>();
  for (const asset of source.media) {
    if (!asset.id || mediaIds.has(asset.id)) throw new Error('duplicate or empty media id');
    if (
      asset.durationSec !== undefined
      && (!Number.isFinite(asset.durationSec) || asset.durationSec <= 0)
    ) {
      throw new Error('media duration is invalid');
    }
    mediaIds.add(asset.id);
  }

  if (
    source.source.durationSec !== undefined
    && (!Number.isFinite(source.source.durationSec) || source.source.durationSec <= 0)
  ) {
    throw new Error('source duration is invalid');
  }
  const transcript = source.transcript ?? [];
  for (const [index, segment] of transcript.entries()) {
    if (
      !Number.isFinite(segment.start)
      || !Number.isFinite(segment.end)
      || segment.start < 0
      || segment.start >= segment.end
      || !segment.text.trim()
      || (index > 0 && segment.start < transcript[index - 1].end)
      || (
        source.source.durationSec !== undefined
        && (!Number.isFinite(source.source.durationSec) || segment.end > source.source.durationSec)
      )
    ) {
      throw new Error('transcript completeness validation failed');
    }
  }
  if (handout && (source.source.kind === 'video' || source.source.kind === 'course')) {
    const warnings = [...source.warnings, ...handout.warnings];
    if (transcript.length === 0 || warnings.includes('transcript-empty')) {
      throw new Error('video/course handout requires a non-empty transcript');
    }
    const included = handout.includedTranscriptSegments;
    const omitted = handout.omittedTranscriptSegments;
    if (Array.isArray(omitted) && omitted.length > 0) {
      throw new Error('handout has omitted transcript segments');
    }
    if (
      !Array.isArray(included)
      || !Array.isArray(omitted)
      || included.length !== transcript.length
      || new Set(included).size !== transcript.length
      || included.some(index => !Number.isInteger(index) || index < 0 || index >= transcript.length)
    ) {
      throw new Error('video/course handout transcript coverage is incomplete');
    }
  }
  if (
    !handout
    && (source.source.kind === 'video' || source.source.kind === 'course')
    && transcript.length === 0
    && !hasSubstantiveVideoBody(source)
    && !hasPublishableVideoMedia(source)
  ) {
    throw new Error('video/course metadata-only ingest lacks substantive transcript, body, or publishable media');
  }
}

function extensionFor(asset: MediaAsset, sourcePath: string): string {
  const extension = path.extname(sourcePath);
  if (!extension || extension === '.') throw new Error('missing asset extension');
  return extension.toLowerCase();
}

function imageEmbed(asset: MediaAsset, relativePath: string): string {
  const alt = (asset.alt || asset.caption || asset.id).replace(/[\r\n\]]+/g, ' ').trim();
  return `![${alt}](${relativePath.split(path.sep).join('/')})`;
}

function articleBodyAndAssets(
  input: FinalizeInput,
  staging: string,
  artifactPath: string,
  resourceRoots: TrustedRoot[],
): { body: string; assets: PlannedAsset[] } {
  const mediaById = new Map(input.source.media.map(asset => [asset.id, asset]));
  const referenced = new Set<string>();
  const replacements = new Map<string, string>();
  const assets: PlannedAsset[] = [];

  for (const block of input.source.blocks) {
    if (block.kind !== 'image' && block.kind !== 'figure') continue;
    if (!block.mediaId) throw new Error('missing asset reference');
    const asset = mediaById.get(block.mediaId);
    if (!asset || !isVisualAsset(asset) || referenced.has(asset.id)) {
      throw new Error('missing asset or invalid image count');
    }
    referenced.add(asset.id);
    const sourcePath = resolveResourcePath(asset.path, resourceRoots);
    validateMediaExtension(asset, sourcePath);
    const relativePath = path.posix.join(
      'images',
      `image-${String(assets.length + 1).padStart(3, '0')}${extensionFor(asset, sourcePath)}`,
    );
    replacements.set(block.id, imageEmbed(asset, relativePath));
    assets.push({
      asset,
      relativePath,
      sourcePath,
      stagedPath: path.join(staging, ...relativePath.split('/')),
      finalPath: path.join(artifactPath, ...relativePath.split('/')),
    });
  }

  const visualIds = visualAssets(input.source).map(asset => asset.id);
  if (visualIds.length !== referenced.size || visualIds.some(id => !referenced.has(id))) {
    throw new Error('invalid image count');
  }

  const sourceBody = input.source.blocks
    .map(block => replacements.get(block.id) ?? block.markdown)
    .join('\n\n')
    .trim();
  let body = input.processedMarkdown?.trim() || sourceBody;
  if (input.processedMarkdown) {
    for (const block of input.source.blocks) {
      const replacement = replacements.get(block.id);
      if (replacement && body.includes(block.markdown)) body = body.replace(block.markdown, replacement);
    }
  }
  if (!body) throw new Error('article body is empty');
  return { body: `${body}\n`, assets };
}

function handoutBodyAndAssets(
  input: FinalizeInput,
  staging: string,
  artifactPath: string,
  resourceRoots: TrustedRoot[],
): { body: string; assets: PlannedAsset[] } {
  const handout = input.handout as HandoutResult;
  const mediaById = new Map(input.source.media.map(asset => [asset.id, asset]));
  if (new Set(handout.usedMediaIds).size !== handout.usedMediaIds.length) {
    throw new Error('invalid image count');
  }
  const assets = handout.usedMediaIds.map((id): PlannedAsset => {
    const asset = mediaById.get(id);
    if (!asset || !isVisualAsset(asset)) throw new Error('missing asset reference');
    const sourcePath = resolveResourcePath(asset.path, resourceRoots);
    validateMediaExtension(asset, sourcePath);
    const filename = path.basename(asset.path as string);
    const relativePath = path.posix.join('slides', filename);
    return {
      asset,
      relativePath,
      sourcePath,
      stagedPath: path.join(staging, 'slides', filename),
      finalPath: path.join(artifactPath, 'slides', filename),
    };
  });
  if (new Set(assets.map(asset => asset.relativePath)).size !== assets.length) {
    throw new Error('duplicate handout asset destination');
  }
  const body = (input.processedMarkdown ?? handout.markdown).trim();
  if (!body) throw new Error('handout body is empty');
  return { body: `${body}\n`, assets };
}

function stripInlineCode(line: string): string {
  let result = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`' || (index > 0 && line[index - 1] === '\\')) {
      result += line[index];
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
      result += line.slice(index, openerEnd);
      index = openerEnd;
      continue;
    }
    result += ' '.repeat(closerEnd - index);
    index = closerEnd;
  }
  return result;
}

function markdownOutsideCode(markdown: string): string {
  const visible: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        closing
        && closing[1][0] === fence.marker
        && closing[1].length >= fence.length
      ) {
        fence = undefined;
      }
      visible.push('');
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = {
        marker: opening[1][0] as '`' | '~',
        length: opening[1].length,
      };
      visible.push('');
      continue;
    }
    visible.push(stripInlineCode(line));
  }
  return visible.join('\n');
}

function imageReferences(markdown: string): string[] {
  const references: string[] = [];
  const pattern = /!\[[^\]\r\n]*\]\((<[^>\r\n]*>|[^)\r\n]*)\)/g;
  for (const match of markdownOutsideCode(markdown).matchAll(pattern)) {
    const raw = match[1].trim();
    const unwrapped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    let decoded: string;
    try {
      decoded = decodeURIComponent(unwrapped);
    } catch {
      throw new Error('invalid image reference');
    }
    if (
      !decoded
      || path.posix.isAbsolute(decoded)
      || decoded.includes('\\')
      || decoded.split('/').some(component => component === '..' || component === '.')
      || /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    ) {
      throw new Error('image reference must be a local relative path');
    }
    references.push(decoded);
  }
  return references;
}

function rejectUnsupportedMediaSyntax(markdown: string): void {
  const visible = markdownOutsideCode(markdown);
  if (
    /!\[\[/m.test(visible)
    || /<img\b[^>]*>/im.test(visible)
    || /!\[[^\]\r\n]*\]\s*\[[^\]\r\n]*\]/m.test(visible)
    || /!\[[^\]\r\n]+\](?!\s*\()/m.test(visible)
  ) {
    throw new Error('unsupported media syntax; use inline Markdown images with local relative paths');
  }
}

function validateStagedArtifact(markdown: string, assets: PlannedAsset[], frontmatter: string, source: ExtractedSource): void {
  validateFrontmatter(frontmatter, source);
  rejectUnsupportedMediaSyntax(markdown);
  const references = imageReferences(markdown);
  const expected = assets.map(asset => asset.relativePath);
  if (references.length !== expected.length || references.some((reference, index) => reference !== expected[index])) {
    throw new Error('invalid image count or resource reference order');
  }
  for (const asset of assets) {
    if (!fs.existsSync(asset.stagedPath) || !fs.statSync(asset.stagedPath).isFile()) {
      throw new Error('missing asset');
    }
  }
}

function noteFiles(vaultDir: string, layerDirectories: string[]): string[] {
  const realVault = fs.realpathSync(vaultDir);
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name.startsWith('.me-ingest-staging-')) continue;
      if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(candidate);
        if (!isInside(realVault, real)) throw new Error('vault note path is outside vault');
        if (entry.name.endsWith('.md') && fs.statSync(candidate).isFile()) files.push(candidate);
      } else if (entry.isDirectory()) {
        walk(candidate);
      } else if (entry.name.endsWith('.md')) {
        files.push(candidate);
      }
    }
  };
  for (const directory of layerDirectories) walk(directory);
  return files;
}

function searchableMarkdown(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return markdownOutsideCode(withoutFrontmatter);
}

function discoverSuggestions(
  vaultDir: string,
  files: string[],
  stem: string,
  title: string,
): { backlinks: BacklinkSuggestion[]; unlinkedMentions: string[] } {
  const backlinks: BacklinkSuggestion[] = [];
  const unlinkedMentions: string[] = [];
  const linkPattern = new RegExp(`\\[\\[${escapeRegex(stem)}(?:\\]|[|#])`, 'gi');
  const mentionPattern = new RegExp(`${escapeRegex(title)}|${escapeRegex(stem)}`, 'i');
  for (const file of files) {
    const content = searchableMarkdown(fs.readFileSync(file, 'utf8'));
    const links = content.match(linkPattern) ?? [];
    const relative = path.relative(vaultDir, file);
    if (links.length > 0) {
      backlinks.push({ path: relative, count: links.length });
    } else if (mentionPattern.test(content)) {
      unlinkedMentions.push(relative);
    }
  }
  return {
    backlinks: backlinks.sort((left, right) => left.path.localeCompare(right.path)),
    unlinkedMentions: unlinkedMentions.sort(),
  };
}

function readReadmeState(readmePath: string): ReadmeState {
  if (!fs.existsSync(readmePath)) return { kind: 'absent' };
  const stat = fs.lstatSync(readmePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error('README path is outside vault');
  const metadata = [
    stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs,
  ].join(':');
  if (stat.isFile()) return { kind: 'file', content: fs.readFileSync(readmePath, 'utf8'), metadata };
  if (stat.isDirectory()) return { kind: 'directory', metadata };
  throw new Error('README path is invalid');
}

function sameReadmeState(left: ReadmeState, right: ReadmeState): boolean {
  return left.kind === right.kind
    && left.content === right.content
    && left.metadata === right.metadata;
}

function readmeContent(state: ReadmeState, parent: string, stem: string): string {
  if (state.kind !== 'file') {
    return `# ${path.basename(parent)}\n\n## Notes\n\n- [[${stem}]]\n`;
  }
  const original = state.content ?? '';
  const separator = original.endsWith('\n\n') ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  return `${original}${separator}- [[${stem}]]\n`;
}

function restoreReadme(readmePath: string, state: ReadmeState): void {
  if (state.kind === 'directory') {
    if (!fs.existsSync(readmePath)) fs.mkdirSync(readmePath);
    return;
  }
  if (state.kind === 'absent') {
    if (fs.existsSync(readmePath) && fs.lstatSync(readmePath).isFile()) fs.rmSync(readmePath, { force: true });
    return;
  }
  const restorePath = path.join(path.dirname(readmePath), `.README.md.me-ingest-restore-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(restorePath, state.content ?? '');
    fs.renameSync(restorePath, readmePath);
  } finally {
    fs.rmSync(restorePath, { force: true });
  }
}

function artifactManifest(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (directory: string, relativeDirectory: string): void => {
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(relativeDirectory, name);
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isDirectory()) {
        entries.set(relative, [
          'directory', stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs,
        ].join(':'));
        walk(absolute, relative);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        entries.set(relative, [
          'file', stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, digest,
        ].join(':'));
      } else {
        entries.set(relative, [
          'other', stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs,
        ].join(':'));
      }
    }
  };
  walk(root, '');
  return entries;
}

function sameArtifactManifest(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [relative, fingerprint] of left) {
    if (right.get(relative) !== fingerprint) return false;
  }
  return true;
}

function rollbackPublished(artifacts: PublishedArtifact[]): string[] {
  const preserved: string[] = [];
  for (const published of [...artifacts].reverse()) {
    if (!fs.existsSync(published.path)) continue;
    let unchanged = false;
    try {
      unchanged = fs.lstatSync(published.path).isDirectory()
        && sameArtifactManifest(published.manifest, artifactManifest(published.path));
    } catch {
      unchanged = false;
    }
    if (!unchanged) {
      preserved.push(published.path);
      continue;
    }
    try {
      fs.rmSync(published.path, { recursive: true, force: true });
    } catch {
      preserved.push(published.path);
    }
  }
  return preserved;
}

export function finalizeIngest(
  input: FinalizeInput,
  fileOperations: FinalizeFileOperations = { renameSync: fs.renameSync },
): FinalizeResult {
  const vaultDir = path.resolve(input.vaultDir);
  if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
    throw new Error('vault directory does not exist');
  }
  assertSafeVaultPath(vaultDir, path.join(vaultDir, '.me'), '.me path');
  validateSource(input.source, input.handout);

  const config = resolveConfig(vaultDir);
  const configuredLayers = [config.raw, config.practices, config.cognition]
    .map(layer => path.resolve(vaultDir, layer));
  configuredLayers.forEach(layer => assertSafeVaultPath(vaultDir, layer, 'target path'));
  assertVaultTreeDoesNotEscape(vaultDir, configuredLayers);

  const rawRoot = path.resolve(vaultDir, config.raw);
  const topic = safeTopic(input.topic);
  const finalParent = path.resolve(rawRoot, topic);
  if (!isInside(rawRoot, finalParent)) throw new Error('target path is outside vault');
  assertSafeVaultPath(vaultDir, finalParent, 'target path');

  const created = input.created ?? new Date().toISOString().slice(0, 10);
  validateDate(created);
  const derived = deriveSlug(input.source.source.title) || 'ingest';
  const stem = safeStem(input.stem ?? `${created}-${derived}`, created);
  const artifactPath = path.join(finalParent, stem);
  const notePath = path.join(artifactPath, `${stem}.md`);
  assertSafeVaultPath(vaultDir, artifactPath, 'target path');
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new Error('frontmatter schema: tags must be a list');
  }
  const tags = (input.tags ?? []).map(validateTag);
  const resourceRoots = trustedRoots(input, vaultDir);

  const createdDirectories: string[] = [];
  createDirectoryTracked(finalParent, createdDirectories);
  const reservationDirectory = path.join(vaultDir, '.me', 'ingest-reservations');
  assertSafeVaultPath(vaultDir, reservationDirectory, 'ingest reservation path');
  createDirectoryTracked(reservationDirectory, createdDirectories);
  const lockPaths = [
    path.join(reservationDirectory, `${stem}.lock`),
    path.join(finalParent, '.me-ingest-finalize.lock'),
  ];
  lockPaths.forEach(lockPath => assertSafeVaultPath(vaultDir, lockPath, 'ingest lock path'));
  const locks: Array<{ path: string; handle: number }> = [];
  try {
    for (const lockPath of lockPaths) {
      locks.push({ path: lockPath, handle: fs.openSync(lockPath, 'wx', 0o600) });
    }
  } catch {
    for (const acquired of locks.reverse()) {
      fs.closeSync(acquired.handle);
      fs.rmSync(acquired.path, { force: true });
    }
    cleanupCreatedDirectories(createdDirectories);
    throw new Error('ingest finalizer is locked or stem is reserved by another operation');
  }

  let staging: string | undefined;
  let readmeTemp: string | undefined;
  const published: PublishedArtifact[] = [];
  let readmePath: string | undefined;
  let readmeState: ReadmeState | undefined;
  let readmeAttempted = false;

  try {
    const files = noteFiles(vaultDir, configuredLayers);
    if (files.some(file => path.basename(file, '.md').toLowerCase() === stem.toLowerCase())) {
      throw new Error(`duplicate stem already exists in vault: ${stem}`);
    }
    const vaultIndex = buildVaultIndex(vaultDir);
    const relatedNotes = scoreRelatedNotes(tags, input.source.source.title, vaultIndex, vaultDir);
    const suggestions = discoverSuggestions(vaultDir, files, stem, input.source.source.title);

    staging = fs.mkdtempSync(path.join(finalParent, '.me-ingest-staging-'));
    const preparedParts = input.handout
      ? handoutBodyAndAssets(input, staging, artifactPath, resourceRoots)
      : articleBodyAndAssets(input, staging, artifactPath, resourceRoots);
    const processed = parseFrontmatter(preparedParts.body);
    if (processed.frontmatter && input.frontmatter) {
      throw new Error('frontmatter schema: frontmatter was supplied twice');
    }
    const frontmatter = input.frontmatter ?? processed.frontmatter ?? generatedFrontmatter(input, created);
    const body = processed.body.trim();
    const markdown = `${frontmatter}\n\n${body}\n`;
    const stagedNote = path.join(staging, `${stem}.md`);

    for (const asset of preparedParts.assets) {
      fs.mkdirSync(path.dirname(asset.stagedPath), { recursive: true });
      fs.copyFileSync(asset.sourcePath, asset.stagedPath, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(stagedNote, markdown, { flag: 'wx' });
    validateStagedArtifact(markdown, preparedParts.assets, frontmatter, input.source);
    const manifest = artifactManifest(staging);

    if (fs.existsSync(artifactPath)) throw new Error(`destination already exists: ${artifactPath}`);

    const shouldUpdateReadme = suggestions.backlinks.length === 0;
    if (shouldUpdateReadme) {
      readmePath = path.join(finalParent, 'README.md');
      assertSafeVaultPath(vaultDir, readmePath, 'README path');
      readmeState = readReadmeState(readmePath);
      readmeTemp = path.join(finalParent, `.README.md.me-ingest-${randomUUID()}.tmp`);
      fs.writeFileSync(readmeTemp, readmeContent(readmeState, finalParent, stem), { flag: 'wx' });
    }

    fileOperations.beforeArtifactPublish?.(artifactPath);
    if (fs.existsSync(artifactPath)) throw new Error(`destination already exists before publish: ${artifactPath}`);
    fileOperations.renameSync(staging, artifactPath);
    staging = undefined;
    published.push({ path: artifactPath, manifest });

    if (readmeTemp && readmePath) {
      try {
        fileOperations.beforeReadmeCompare?.(readmePath);
        if (!readmeState || !sameReadmeState(readmeState, readReadmeState(readmePath))) {
          throw new Error('README changed during compare-and-swap');
        }
        readmeAttempted = true;
        fileOperations.renameSync(readmeTemp, readmePath);
        readmeTemp = undefined;
      } catch (cause) {
        throw new Error(`README update failed: ${cause instanceof Error ? cause.message : 'rename failed'}`);
      }
    }

    return {
      notePath,
      stem,
      assetPaths: preparedParts.assets.map(asset => asset.finalPath),
      ...(readmePath ? { readmePath } : {}),
      relatedNotes,
      backlinks: suggestions.backlinks,
      unlinkedMentions: suggestions.unlinkedMentions,
      warnings: [...new Set([...(input.source.warnings ?? []), ...(input.handout?.warnings ?? [])])],
    };
  } catch (cause) {
    if (readmeAttempted && readmePath && readmeState) {
      try {
        restoreReadme(readmePath, readmeState);
      } catch {
        // Preserve the original transaction failure; artifact rollback still proceeds.
      }
    }
    const preserved = rollbackPublished(published);
    if (preserved.length > 0) {
      const original = cause instanceof Error ? cause.message : 'unknown transaction failure';
      throw new Error(
        `manual recovery required: published artifact changed after publication and was preserved at `
        + `${preserved.join(', ')}; original failure: ${original}`,
      );
    }
    throw cause;
  } finally {
    if (readmeTemp) fs.rmSync(readmeTemp, { force: true });
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    for (const acquired of locks.reverse()) {
      fs.closeSync(acquired.handle);
      fs.rmSync(acquired.path, { force: true });
    }
    cleanupCreatedDirectories(createdDirectories);
  }
}
