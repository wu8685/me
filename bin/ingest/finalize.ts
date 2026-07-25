import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
  /** Additional trusted roots for local media, for example an imported bundle directory. */
  allowedResourceRoots?: string[];
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
}

const FRONTMATTER_FIELDS = new Set(['title', 'created', 'tags', 'type', 'source']);
const VISUAL_KINDS = new Set<MediaAsset['kind']>(['image', 'figure', 'slide', 'frame']);

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

function safeStem(value: string): string {
  if (
    !value
    || value === '.'
    || value === '..'
    || value.endsWith('.md')
    || /[\/\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('target path is outside vault');
  }
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

function resolveResourcePath(sourcePath: string | undefined, roots: string[]): string {
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error('missing asset');
  }
  const lexicalSource = path.resolve(sourcePath);
  const matchingRoots = roots.flatMap(root => {
    const lexicalRoot = path.resolve(root);
    if (!isInside(lexicalRoot, lexicalSource)) return [];
    if (!fs.existsSync(lexicalRoot) || !fs.statSync(lexicalRoot).isDirectory()) return [];
    return [{ lexicalRoot, realRoot: fs.realpathSync(lexicalRoot) }];
  });
  if (matchingRoots.length === 0) throw new Error('asset is outside allowed resource roots');
  if (!fs.existsSync(sourcePath)) throw new Error('missing asset');

  let realSource: string;
  try {
    if (!fs.statSync(sourcePath).isFile()) throw new Error('not a file');
    realSource = fs.realpathSync(sourcePath);
  } catch {
    throw new Error('missing asset');
  }

  const allowed = matchingRoots.some(root => isInside(root.realRoot, realSource));
  if (!allowed) throw new Error('asset is outside allowed resource roots');
  return realSource;
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
  if (!/^\[[^\]\r\n]*\]$/.test(values.get('tags')?.trim() ?? '')) {
    throw new Error('frontmatter schema: tags must be an inline list');
  }
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
  const tags = input.tags ?? [];
  if (tags.some(tag => /[\],\r\n]/.test(tag) || !tag.trim())) {
    throw new Error('frontmatter schema: invalid tag');
  }
  return [
    '---',
    `title: ${yamlString(input.source.source.title)}`,
    `created: ${created}`,
    `tags: [${tags.map(tag => tag.trim()).join(', ')}]`,
    'type: article',
    `source: ${yamlString(input.source.source.url)}`,
    '---',
  ].join('\n');
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
    mediaIds.add(asset.id);
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
  if (handout?.omittedTranscriptSegments.length) {
    throw new Error('handout has omitted transcript segments');
  }
}

function extensionFor(asset: MediaAsset, sourcePath: string): string {
  const extension = path.extname(sourcePath);
  if (!extension || extension === '.') throw new Error(`missing asset extension for ${asset.id}`);
  return extension.toLowerCase();
}

function imageEmbed(asset: MediaAsset, relativePath: string): string {
  const alt = (asset.alt || asset.caption || asset.id).replace(/[\r\n\]]+/g, ' ').trim();
  return `![${alt}](${relativePath.split(path.sep).join('/')})`;
}

function articleBodyAndAssets(
  input: FinalizeInput,
  staging: string,
  finalParent: string,
  resourceRoots: string[],
): { body: string; assets: PlannedAsset[] } {
  const mediaById = new Map(input.source.media.map(asset => [asset.id, asset]));
  const referenced = new Set<string>();
  const replacements = new Map<string, string>();
  const assets: PlannedAsset[] = [];

  for (const block of input.source.blocks) {
    if (block.kind !== 'image' && block.kind !== 'figure') continue;
    if (!block.mediaId) throw new Error('missing asset reference');
    const asset = mediaById.get(block.mediaId);
    if (!asset || !VISUAL_KINDS.has(asset.kind) || referenced.has(asset.id)) {
      throw new Error('missing asset or invalid image count');
    }
    referenced.add(asset.id);
    const sourcePath = resolveResourcePath(asset.path, resourceRoots);
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
      finalPath: path.join(finalParent, ...relativePath.split('/')),
    });
  }

  const visualIds = input.source.media.filter(asset => asset.kind === 'image' || asset.kind === 'figure')
    .map(asset => asset.id);
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
  resourceRoots: string[],
): { body: string; assets: PlannedAsset[] } {
  const handout = input.handout as HandoutResult;
  const mediaById = new Map(input.source.media.map(asset => [asset.id, asset]));
  if (new Set(handout.usedMediaIds).size !== handout.usedMediaIds.length) {
    throw new Error('invalid image count');
  }
  const assets = handout.usedMediaIds.map((id): PlannedAsset => {
    const asset = mediaById.get(id);
    if (!asset || !VISUAL_KINDS.has(asset.kind)) throw new Error('missing asset reference');
    const sourcePath = resolveResourcePath(asset.path, resourceRoots);
    const filename = path.basename(sourcePath);
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

function imageReferences(markdown: string): string[] {
  const references: string[] = [];
  const pattern = /!\[[^\]\r\n]*\]\((<[^>\r\n]*>|[^)\r\n]*)\)/g;
  for (const match of markdown.matchAll(pattern)) {
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

function validateStagedArtifact(markdown: string, assets: PlannedAsset[], frontmatter: string, source: ExtractedSource): void {
  validateFrontmatter(frontmatter, source);
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
    const content = fs.readFileSync(file, 'utf8');
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
  const stat = fs.lstatSync(readmePath);
  if (stat.isSymbolicLink()) throw new Error('README path is outside vault');
  if (stat.isFile()) return { kind: 'file', content: fs.readFileSync(readmePath, 'utf8') };
  if (stat.isDirectory()) return { kind: 'directory' };
  throw new Error('README path is invalid');
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

function rollbackPublished(paths: string[]): void {
  for (const published of [...paths].reverse()) {
    try {
      fs.rmSync(published, { recursive: true, force: true });
    } catch {
      // Continue removing only paths recorded as belonging to this transaction.
    }
  }
}

export function finalizeIngest(
  input: FinalizeInput,
  fileOperations: FinalizeFileOperations = { renameSync: fs.renameSync },
): FinalizeResult {
  const vaultDir = path.resolve(input.vaultDir);
  if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
    throw new Error('vault directory does not exist');
  }
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
  const stem = safeStem(input.stem ?? `${created}-${derived}`);
  const isDirectoryArtifact = Boolean(input.handout);
  const artifactPath = isDirectoryArtifact ? path.join(finalParent, stem) : path.join(finalParent, `${stem}.md`);
  const notePath = isDirectoryArtifact ? path.join(artifactPath, `${stem}.md`) : artifactPath;
  assertSafeVaultPath(vaultDir, artifactPath, 'target path');

  const createdDirectories: string[] = [];
  createDirectoryTracked(finalParent, createdDirectories);
  const staging = fs.mkdtempSync(path.join(finalParent, '.me-ingest-staging-'));
  let readmeTemp: string | undefined;
  const published: string[] = [];
  let readmePath: string | undefined;
  let readmeState: ReadmeState | undefined;
  let readmeAttempted = false;

  try {
    // Snapshot suggestions before the staged note is written. Staging lives
    // inside a configured layer for same-filesystem publication and must never
    // appear as a related note, backlink, or unlinked mention.
    const vaultIndex = buildVaultIndex(vaultDir);
    const relatedNotes = scoreRelatedNotes(input.tags ?? [], input.source.source.title, vaultIndex, vaultDir);
    const files = noteFiles(vaultDir, configuredLayers);
    const suggestions = discoverSuggestions(vaultDir, files, stem, input.source.source.title);

    const resourceRoots = [vaultDir, ...(input.allowedResourceRoots ?? [])];
    const preparedParts = input.handout
      ? handoutBodyAndAssets(input, staging, artifactPath, resourceRoots)
      : articleBodyAndAssets(input, staging, finalParent, resourceRoots);
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

    if (fs.existsSync(artifactPath)) throw new Error(`destination already exists: ${artifactPath}`);
    for (const asset of preparedParts.assets) {
      if (fs.existsSync(asset.finalPath)) throw new Error(`destination already exists: ${asset.finalPath}`);
    }

    const shouldUpdateReadme = suggestions.backlinks.length === 0;
    if (shouldUpdateReadme) {
      readmePath = path.join(finalParent, 'README.md');
      assertSafeVaultPath(vaultDir, readmePath, 'README path');
      readmeState = readReadmeState(readmePath);
      readmeTemp = path.join(finalParent, `.README.md.me-ingest-${randomUUID()}.tmp`);
      fs.writeFileSync(readmeTemp, readmeContent(readmeState, finalParent, stem), { flag: 'wx' });
    }

    if (isDirectoryArtifact) {
      fileOperations.renameSync(staging, artifactPath);
      published.push(artifactPath);
    } else {
      for (const asset of preparedParts.assets) {
        const assetParent = path.dirname(asset.finalPath);
        if (!fs.existsSync(assetParent)) {
          fs.mkdirSync(assetParent);
          createdDirectories.push(assetParent);
        }
        fileOperations.renameSync(asset.stagedPath, asset.finalPath);
        published.push(asset.finalPath);
      }
      fileOperations.renameSync(stagedNote, notePath);
      published.push(notePath);
    }

    if (readmeTemp && readmePath) {
      try {
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
    rollbackPublished(published);
    throw cause;
  } finally {
    if (readmeTemp) fs.rmSync(readmeTemp, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    cleanupCreatedDirectories(createdDirectories);
  }
}
