import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  type LogicalLayer,
  VaultWriterError,
} from './contracts';
import {
  assertSafeWriterPath,
  type ResolvedVaultLayout,
} from './path-safety';

export interface FieldContract {
  name: string;
  type: 'string' | 'date' | 'string-list' | 'enum';
  required: boolean;
  values?: string[];
  allowEmpty?: boolean;
  itemPattern?: string;
}

export interface LayerSchemaContract {
  profileId: 'me-schema-v1';
  revision: 1;
  layer: LogicalLayer;
  fields: Map<string, FieldContract>;
  templateFields: string[];
  schemaDocumentSha256: string;
  templateSha256: string;
}

export interface ValidatedNote {
  stem: string;
  title: string;
  created: string;
  tags: string[];
  type: string;
  source: string;
  markdown: string;
}

type JsonRecord = Record<string, unknown>;

const PROFILE_ID = 'me-schema-v1';
const PROFILE_REVISION = 1;
const PROFILE_FILE = 'me-schema-v1.json';
const LAYERS: LogicalLayer[] = ['raw', 'practices', 'cognition'];
const CORE_ORDER = ['title', 'created', 'tags', 'type', 'source'];
const TEMPLATE_FIELDS: Record<LogicalLayer, string[]> = {
  raw: [...CORE_ORDER],
  practices: [...CORE_ORDER, 'project'],
  cognition: [...CORE_ORDER, 'confidence'],
};
const TYPE_VALUES: Record<LogicalLayer, string[]> = {
  raw: ['article', 'concept'],
  practices: ['experiment', 'reflection'],
  cognition: ['insight'],
};
const TEMPLATE_HASHES: Record<LogicalLayer, string> = {
  raw: '28e24f3e835c3a34a123c4ef8082abfcef8cfdcce3a913371869dbc9e6f2a4d4',
  practices: 'ad169bbe8a74d5be0fa615eeae436380e8eb75dc8f4a3342df50482d7608323b',
  cognition: 'a8084f5b1a601cdcdf1460247fa82bdb9fc2b24281ecca5fc48a0e3d32338a7b',
};
const SCHEMA_HASH = '9894ec60c4c7e583a215938ec71186e8a12d24eaedc6dc96a42e2a4aa24480b5';
const TAG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function unsupported(): never {
  throw new VaultWriterError('UNSUPPORTED_SCHEMA');
}

function invalidNote(): never {
  throw new VaultWriterError('INVALID_NOTE');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: JsonRecord, keys: string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
}

function exactStrings(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function exactField(
  value: unknown,
  expected: JsonRecord,
): boolean {
  if (!isRecord(value) || !exactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actual = value[key];
    return Array.isArray(expectedValue)
      ? exactStrings(actual, expectedValue as string[])
      : actual === expectedValue;
  });
}

function validateProfile(value: unknown): JsonRecord {
  if (!isRecord(value) || !exactKeys(value, [
    'id',
    'revision',
    'schemaDocumentSha256',
    'templateSha256',
    'core',
    'layers',
  ])) unsupported();
  if (
    value.id !== PROFILE_ID
    || value.revision !== PROFILE_REVISION
    || !exactStrings(value.schemaDocumentSha256, [SCHEMA_HASH])
    || !isRecord(value.templateSha256)
    || !exactKeys(value.templateSha256, LAYERS)
    || LAYERS.some(layer => value.templateSha256[layer] !== TEMPLATE_HASHES[layer])
    || !isRecord(value.core)
    || !exactKeys(value.core, CORE_ORDER)
  ) unsupported();

  const expectedCore: Record<string, JsonRecord> = {
    title: { type: 'string', required: true, minLength: 1 },
    created: { type: 'date', required: true, format: 'YYYY-MM-DD' },
    tags: {
      type: 'string-list',
      required: true,
      unique: true,
      itemPattern: TAG_PATTERN,
    },
    type: { type: 'enum', required: true },
    source: { type: 'string', required: true, minLength: 1 },
  };
  if (CORE_ORDER.some(field => !exactField(value.core![field], expectedCore[field]))) {
    unsupported();
  }

  if (!isRecord(value.layers) || !exactKeys(value.layers, LAYERS)) unsupported();
  for (const layer of LAYERS) {
    const definition = value.layers[layer];
    if (!isRecord(definition) || !exactKeys(definition, ['types', 'source', 'extensions'])) {
      unsupported();
    }
    if (!exactStrings(definition.types, TYPE_VALUES[layer]) || !isRecord(definition.source)) {
      unsupported();
    }
    if (layer === 'raw') {
      if (
        !exactField(definition.source, { kind: 'http-url', schemes: ['http', 'https'] })
        || !isRecord(definition.extensions)
        || !exactKeys(definition.extensions, [])
      ) unsupported();
    } else {
      if (
        !exactField(definition.source, { kind: 'existing-path-qualified-wikilink' })
        || !isRecord(definition.extensions)
      ) unsupported();
      const extensionName = layer === 'practices' ? 'project' : 'confidence';
      const expectedExtension = layer === 'practices'
        ? { type: 'string', required: false, allowEmpty: true }
        : { type: 'enum', required: true, values: ['low', 'medium', 'high'] };
      if (
        !exactKeys(definition.extensions, [extensionName])
        || !exactField(definition.extensions[extensionName], expectedExtension)
      ) unsupported();
    }
  }
  return value;
}

function sha256(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    unsupported();
  }
}

function makeFields(layer: LogicalLayer): Map<string, FieldContract> {
  const fields = new Map<string, FieldContract>([
    ['title', { name: 'title', type: 'string', required: true }],
    ['created', { name: 'created', type: 'date', required: true }],
    ['tags', {
      name: 'tags',
      type: 'string-list',
      required: true,
      itemPattern: TAG_PATTERN,
    }],
    ['type', {
      name: 'type',
      type: 'enum',
      required: true,
      values: [...TYPE_VALUES[layer]],
    }],
    ['source', { name: 'source', type: 'string', required: true }],
  ]);
  if (layer === 'practices') {
    fields.set('project', {
      name: 'project',
      type: 'string',
      required: false,
      allowEmpty: true,
    });
  }
  if (layer === 'cognition') {
    fields.set('confidence', {
      name: 'confidence',
      type: 'enum',
      required: true,
      values: ['low', 'medium', 'high'],
    });
  }
  return fields;
}

export function loadLayerSchema(
  layout: ResolvedVaultLayout,
  pluginRoot: string,
  layer: LogicalLayer,
): LayerSchemaContract {
  if (!LAYERS.includes(layer)) unsupported();
  const profilePath = path.join(pluginRoot, 'templates', 'schema-profiles', PROFILE_FILE);
  let profile: unknown;
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch {
    unsupported();
  }
  validateProfile(profile);

  const schemaDocumentSha256 = sha256(layout.schemaPath);
  const templatePath = path.join(pluginRoot, 'templates', `${layer}-template.md`);
  const templateSha256 = sha256(templatePath);
  if (schemaDocumentSha256 !== SCHEMA_HASH || templateSha256 !== TEMPLATE_HASHES[layer]) {
    unsupported();
  }

  return {
    profileId: PROFILE_ID,
    revision: PROFILE_REVISION,
    layer,
    fields: makeFields(layer),
    templateFields: [...TEMPLATE_FIELDS[layer]],
    schemaDocumentSha256,
    templateSha256,
  };
}

function parseQuotedString(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) invalidNote();
    try {
      const value = JSON.parse(raw);
      if (typeof value !== 'string') invalidNote();
      return value;
    } catch {
      invalidNote();
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) invalidNote();
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return undefined;
}

function rejectYamlConstruct(raw: string): void {
  if (
    !raw
    || /^(?:null|~|true|false|[-+]?(?:\d+\.?\d*|\.\d+))$/i.test(raw)
    || /^[&*!|>{}]/.test(raw)
    || /:\s/.test(raw)
    || /[\u0000-\u001f\u007f]/.test(raw)
  ) invalidNote();
}

function parseString(raw: string, allowEmpty: boolean): string {
  const quoted = parseQuotedString(raw);
  if (quoted !== undefined) {
    if (!allowEmpty && quoted.trim().length === 0) invalidNote();
    return quoted;
  }
  rejectYamlConstruct(raw);
  if (!allowEmpty && raw.trim().length === 0) invalidNote();
  return raw;
}

function splitInlineList(raw: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) invalidNote();
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote === "'") {
      if (character === "'" && inner[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ',') {
      items.push(inner.slice(start, index).trim());
      start = index + 1;
    } else if (character === '[' || character === ']' || character === '{' || character === '}') {
      invalidNote();
    }
  }
  if (quote) invalidNote();
  items.push(inner.slice(start).trim());
  if (items.some(item => !item)) invalidNote();
  return items.map(item => parseString(item, false));
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseFrontmatter(markdown: string): {
  raw: Map<string, string>;
  body: string;
} {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) invalidNote();
  const lines = markdown.split(/\r?\n/);
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index;
      break;
    }
  }
  if (closing < 0) invalidNote();
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    if (!line || /^\s/.test(line)) invalidNote();
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
    if (!match || fields.has(match[1])) invalidNote();
    const raw = match[2] ?? '';
    if (raw.includes('#') && parseQuotedString(raw) === undefined) invalidNote();
    fields.set(match[1], raw);
  }
  const body = lines.slice(closing + 1).join('\n');
  if (!body.trim()) invalidNote();
  if (/(?:^|\n)---\r?\n[A-Za-z][A-Za-z0-9_-]*:.*\r?\n---(?:\r?\n|$)/.test(body)) {
    invalidNote();
  }
  return { raw: fields, body };
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireExistingFile(
  layout: ResolvedVaultLayout,
  candidate: string,
): void {
  try {
    assertSafeWriterPath(layout, candidate, 'note resource');
    if (!inside(layout.lexicalVault, path.resolve(candidate))) invalidNote();
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) invalidNote();
    const canonical = fs.realpathSync(candidate);
    if (!inside(layout.canonicalVault, canonical)) invalidNote();
  } catch {
    invalidNote();
  }
}

function validateSource(
  layout: ResolvedVaultLayout,
  layer: LogicalLayer,
  source: string,
): void {
  if (layer === 'raw') {
    try {
      const parsed = new URL(source);
      if (!['http:', 'https:'].includes(parsed.protocol)) invalidNote();
    } catch {
      invalidNote();
    }
    return;
  }

  const match = source.match(/^\[\[([^\]]+)\]\]$/);
  if (!match) invalidNote();
  const target = match[1];
  if (
    !target.includes('/')
    || target.endsWith('.md')
    || target.includes('|')
    || target.includes('#')
    || target.includes('\\')
    || target.startsWith('/')
    || target.startsWith('//')
    || WINDOWS_DRIVE.test(target)
    || /[\u0000-\u001f\u007f]/.test(target)
  ) invalidNote();
  const components = target.split('/');
  if (components.some(component => !component || component === '.' || component === '..')) {
    invalidNote();
  }
  requireExistingFile(layout, path.join(layout.lexicalVault, ...components) + '.md');
}

function maskCode(markdown: string): string {
  const characters = markdown.split('');
  const maskRange = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' ';
    }
  };

  const lines = markdown.split(/(?<=\n)/);
  let offset = 0;
  let fence: { character: '`' | '~'; length: number; start: number } | undefined;
  for (const line of lines) {
    const withoutNewline = line.replace(/\r?\n$/, '');
    if (!fence) {
      const opening = withoutNewline.match(/^[ ]{0,3}(`{3,}|~{3,})(?:[^`~]*)$/);
      if (opening) {
        fence = {
          character: opening[1][0] as '`' | '~',
          length: opening[1].length,
          start: offset,
        };
      }
    } else {
      const closePattern = new RegExp(`^[ ]{0,3}\\${fence.character}{${fence.length},}[ \\t]*$`);
      if (closePattern.test(withoutNewline)) {
        maskRange(fence.start, offset + line.length);
        fence = undefined;
      }
    }
    offset += line.length;
  }
  if (fence) maskRange(fence.start, markdown.length);

  const fencedMasked = characters.join('');
  for (let index = 0; index < fencedMasked.length;) {
    if (fencedMasked[index] !== '`') {
      index += 1;
      continue;
    }
    let run = 1;
    while (fencedMasked[index + run] === '`') run += 1;
    const delimiter = '`'.repeat(run);
    const close = fencedMasked.indexOf(delimiter, index + run);
    if (close < 0) {
      index += run;
      continue;
    }
    maskRange(index, close + run);
    index = close + run;
  }
  return characters.join('');
}

function decodeLocalDestination(raw: string): string {
  let value = raw;
  for (let round = 0; round < 4; round += 1) {
    if (/%(?:2f|5c)/i.test(value)) invalidNote();
    if (/%(?![0-9A-Fa-f]{2})/.test(value)) invalidNote();
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      invalidNote();
    }
    if (decoded === value) return value;
    value = decoded;
  }
  if (/%(?:2f|5c)/i.test(value) || /%(?![0-9A-Fa-f]{2})/.test(value)) invalidNote();
  try {
    if (decodeURIComponent(value) !== value) invalidNote();
  } catch {
    invalidNote();
  }
  return value;
}

function unescapeCommonMark(raw: string): string {
  return raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function validateDestination(
  layout: ResolvedVaultLayout,
  plannedNotePath: string,
  rawDestination: string,
  image: boolean,
): void {
  if (
    !rawDestination
    || /[\u0000-\u001f\u007f]/.test(rawDestination)
    || rawDestination.startsWith('//')
  ) invalidNote();
  if (rawDestination.startsWith('#')) {
    if (image || rawDestination.length === 1) invalidNote();
    return;
  }

  let destination = unescapeCommonMark(rawDestination);
  if (/^https?:\/\//i.test(destination)) {
    if (image) invalidNote();
    try {
      const url = new URL(destination);
      if (!['http:', 'https:'].includes(url.protocol)) invalidNote();
    } catch {
      invalidNote();
    }
    return;
  }

  destination = decodeLocalDestination(destination);
  if (
    URI_SCHEME.test(destination)
    || destination.startsWith('/')
    || destination.startsWith('//')
    || WINDOWS_DRIVE.test(destination)
    || destination.includes('\\')
    || destination.includes('?')
    || /[\u0000-\u001f\u007f]/.test(destination)
  ) invalidNote();
  const hash = destination.indexOf('#');
  const localPath = hash >= 0 ? destination.slice(0, hash) : destination;
  if (!localPath) invalidNote();
  const resolved = path.resolve(path.dirname(plannedNotePath), localPath);
  requireExistingFile(layout, resolved);
}

function findClosingBracket(markdown: string, start: number): number {
  for (let index = start; index < markdown.length; index += 1) {
    if (markdown[index] === '\\') {
      index += 1;
    } else if (markdown[index] === ']') {
      return index;
    } else if (markdown[index] === '\n' || markdown[index] === '\r') {
      return -1;
    }
  }
  return -1;
}

function parseLinkDestination(
  markdown: string,
  open: number,
): { destination: string; end: number } {
  if (markdown[open + 1] === '<') {
    let index = open + 2;
    while (index < markdown.length && markdown[index] !== '>') {
      if (markdown[index] === '\\') index += 1;
      index += 1;
    }
    if (index >= markdown.length || markdown[index + 1] !== ')') invalidNote();
    return { destination: markdown.slice(open + 2, index), end: index + 2 };
  }

  let depth = 1;
  for (let index = open + 1; index < markdown.length; index += 1) {
    const character = markdown[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        const destination = markdown.slice(open + 1, index);
        if (/\s/.test(destination)) invalidNote();
        return { destination, end: index + 1 };
      }
    }
    if (character === '\n' || character === '\r') invalidNote();
  }
  invalidNote();
}

function validateMarkdownDestinations(
  layout: ResolvedVaultLayout,
  plannedNotePath: string,
  body: string,
): void {
  const markdown = maskCode(body);
  if (
    /!\[\[[^\]]*\]\]/.test(markdown)
    || /^[ ]{0,3}\[[^\]\n]+\]:/m.test(markdown)
    || /\[[^\]\n]+\]\[[^\]\n]*\]/.test(markdown)
  ) invalidNote();

  const mutable = markdown.split('');
  for (let index = 0; index < markdown.length; index += 1) {
    const image = markdown[index] === '!' && markdown[index + 1] === '[';
    const labelStart = image ? index + 1 : index;
    if (markdown[labelStart] !== '[' || markdown[labelStart + 1] === '[') continue;
    const labelEnd = findClosingBracket(markdown, labelStart + 1);
    if (labelEnd < 0 || markdown[labelEnd + 1] !== '(') continue;
    const parsed = parseLinkDestination(markdown, labelEnd + 1);
    validateDestination(layout, plannedNotePath, parsed.destination, image);
    for (let position = index; position < parsed.end; position += 1) {
      if (mutable[position] !== '\n' && mutable[position] !== '\r') mutable[position] = ' ';
    }
    index = parsed.end - 1;
  }

  const remainder = mutable.join('');
  if (
    /<(?:!|\?|\/?[A-Za-z])/.test(remainder)
  ) invalidNote();
}

export function validateNoteMarkdown(
  layout: ResolvedVaultLayout,
  plannedNotePath: string,
  markdown: string,
  contract: LayerSchemaContract,
): ValidatedNote {
  try {
    const layerRoot = path.resolve(layout.layers[contract.layer]);
    const target = path.resolve(plannedNotePath);
    if (!inside(layerRoot, target) || target === layerRoot) invalidNote();
    assertSafeWriterPath(layout, target, 'planned note');

    const parsed = parseFrontmatter(markdown);
    if (
      parsed.raw.size !== contract.fields.size
      && !([...contract.fields.values()].some(field => !field.required))
    ) invalidNote();
    for (const key of parsed.raw.keys()) {
      if (!contract.fields.has(key)) invalidNote();
    }
    for (const field of contract.fields.values()) {
      if (field.required && !parsed.raw.has(field.name)) invalidNote();
    }

    const values = new Map<string, string | string[]>();
    for (const [name, field] of contract.fields) {
      const raw = parsed.raw.get(name);
      if (raw === undefined) continue;
      if (field.type === 'string-list') {
        const list = splitInlineList(raw);
        if (
          new Set(list).size !== list.length
          || (field.itemPattern && list.some(item => !new RegExp(field.itemPattern).test(item)))
        ) invalidNote();
        values.set(name, list);
      } else {
        const value = field.type === 'date'
          ? parseString(raw, false)
          : parseString(raw, field.allowEmpty === true);
        if (field.type === 'date' && !isRealDate(value)) invalidNote();
        if (field.type === 'enum' && !field.values?.includes(value)) invalidNote();
        values.set(name, value);
      }
    }

    const title = values.get('title');
    const created = values.get('created');
    const tags = values.get('tags');
    const type = values.get('type');
    const source = values.get('source');
    if (
      typeof title !== 'string'
      || typeof created !== 'string'
      || !Array.isArray(tags)
      || typeof type !== 'string'
      || typeof source !== 'string'
    ) invalidNote();
    const stem = path.basename(target, '.md');
    if (!stem.startsWith(`${created}-`)) invalidNote();
    validateSource(layout, contract.layer, source);
    validateMarkdownDestinations(layout, target, parsed.body);

    return { stem, title, created, tags, type, source, markdown };
  } catch (error) {
    if (error instanceof VaultWriterError && error.code === 'UNSUPPORTED_SCHEMA') throw error;
    invalidNote();
  }
}
