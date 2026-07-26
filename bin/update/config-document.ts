import * as fs from 'fs';
import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import {
  Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Pair,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import { UpdateError } from './contracts.ts';

export type ConfigEdit =
  | {
      kind: 'set';
      path: readonly string[];
      value: string | number | boolean | readonly string[];
    }
  | { kind: 'remove'; path: readonly string[] }
  | { kind: 'rename'; from: readonly string[]; to: readonly string[] };

export interface ConfigRenderResult {
  currentVersion: number;
  sourceBytes: Buffer;
  desiredBytes: Buffer;
  sourceSha256: string;
  desiredSha256: string;
}

type ConfigEditValue = string | number | boolean | readonly string[];

function invalidConfig(): never {
  throw new UpdateError('INVALID_CONFIG');
}

function invalidRequest(): never {
  throw new UpdateError('INVALID_REQUEST');
}

function assertSupportedNode(node: unknown): void {
  if (node === null) return;
  if (isAlias(node) || !isNode(node) || node.anchor) invalidConfig();
  if (isScalar(node)) return;

  if (isSeq(node)) {
    for (const item of node.items) assertSupportedNode(item);
    return;
  }

  if (isMap(node)) {
    const keys = new Set<string>();
    for (const pair of node.items) {
      const isMergeKey = isScalar(pair.key) && (
        pair.key.tag === 'tag:yaml.org,2002:merge'
        || (
          pair.key.type === 'PLAIN'
          && pair.key.tag === undefined
          && pair.key.value === '<<'
        )
      );
      if (
        !isScalar(pair.key)
        || pair.key.anchor
        || typeof pair.key.value !== 'string'
        || isMergeKey
        || keys.has(pair.key.value)
      ) {
        invalidConfig();
      }
      keys.add(pair.key.value);
      assertSupportedNode(pair.value);
    }
    return;
  }

  invalidConfig();
}

function parseConfig(source: string): Document {
  try {
    const document = parseDocument(source, {
      keepSourceTokens: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || !isMap(document.contents)) invalidConfig();
    assertSupportedNode(document.contents);
    return document;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return invalidConfig();
  }
}

function pairFor(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find(pair => (
    isScalar(pair.key) && pair.key.value === key
  ));
}

function readVersion(document: Document): number {
  if (!isMap(document.contents)) invalidConfig();
  const pair = pairFor(document.contents, 'vault_schema_version');
  if (!pair) return 0;
  if (
    !isScalar(pair.value)
    || typeof pair.value.value !== 'number'
    || !Number.isSafeInteger(pair.value.value)
    || pair.value.value < 0
  ) {
    throw new UpdateError('INVALID_VAULT_SCHEMA_VERSION');
  }
  return pair.value.value;
}

export function readVaultSchemaVersion(source: string): number {
  return readVersion(parseConfig(source));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every(key => (
      typeof key === 'string' && expected.includes(key)
    ));
}

function parsePath(candidate: unknown): readonly string[] {
  if (!Array.isArray(candidate) || candidate.length === 0) invalidRequest();
  const path: string[] = [];
  for (let index = 0; index < candidate.length; index += 1) {
    if (!Object.hasOwn(candidate, index)) invalidRequest();
    const component = candidate[index];
    if (
      typeof component !== 'string'
      || component.length === 0
      || component.includes('\u0000')
    ) {
      invalidRequest();
    }
    path.push(component);
  }
  return path;
}

function isVaultSchemaVersionPath(path: readonly string[]): boolean {
  return path.length === 1 && path[0] === 'vault_schema_version';
}

function parseSetValue(value: unknown, path: readonly string[]): ConfigEditValue {
  if (isVaultSchemaVersionPath(path)) {
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 0
    ) {
      throw new UpdateError('INVALID_VAULT_SCHEMA_VERSION');
    }
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const strings: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalidRequest();
      const item = value[index];
      if (typeof item !== 'string') invalidRequest();
      strings.push(item);
    }
    return strings;
  }
  return invalidRequest();
}

function isPathPrefix(
  prefix: readonly string[],
  candidate: readonly string[],
): boolean {
  return prefix.length <= candidate.length
    && prefix.every((component, index) => candidate[index] === component);
}

function parseConfigEdit(value: unknown): ConfigEdit {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') invalidRequest();

  if (value.kind === 'set') {
    if (!hasExactKeys(value, ['kind', 'path', 'value'])) invalidRequest();
    const path = parsePath(value.path);
    return {
      kind: 'set',
      path,
      value: parseSetValue(value.value, path),
    };
  }

  if (value.kind === 'remove') {
    if (!hasExactKeys(value, ['kind', 'path'])) invalidRequest();
    return { kind: 'remove', path: parsePath(value.path) };
  }

  if (value.kind === 'rename') {
    if (!hasExactKeys(value, ['kind', 'from', 'to'])) invalidRequest();
    const from = parsePath(value.from);
    const to = parsePath(value.to);
    if (isPathPrefix(from, to) || isPathPrefix(to, from)) invalidRequest();
    return { kind: 'rename', from, to };
  }

  return invalidRequest();
}

function parseConfigEdits(edits: unknown): ConfigEdit[] {
  if (!Array.isArray(edits)) invalidRequest();
  try {
    const parsed: ConfigEdit[] = [];
    for (let index = 0; index < edits.length; index += 1) {
      if (!Object.hasOwn(edits, index)) invalidRequest();
      parsed.push(parseConfigEdit(edits[index]));
    }
    return parsed;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return invalidRequest();
  }
}

function parentMap(document: Document, path: readonly string[]): YAMLMap {
  let current = document.contents;
  for (const component of path.slice(0, -1)) {
    if (!isMap(current)) invalidConfig();
    current = current.get(component, true);
  }
  if (!isMap(current)) invalidConfig();
  return current;
}

type ComparableScalar =
  | null
  | string
  | number
  | boolean
  | { readonly kind: 'buffer'; readonly bytes: readonly number[] }
  | { readonly kind: 'date'; readonly epochMilliseconds: number };

type ComparableNode =
  | {
      readonly kind: 'scalar';
      readonly tag: string | undefined;
      readonly value: ComparableScalar;
    }
  | {
      readonly kind: 'sequence';
      readonly items: readonly ComparableNode[];
    }
  | {
      readonly kind: 'mapping';
      readonly entries: ReadonlyArray<readonly [string, ComparableNode]>;
    };

function comparableScalar(
  value: unknown,
  tag: string | undefined,
): ComparableNode {
  let comparable: ComparableScalar;
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    comparable = value as null | string | number | boolean;
  } else if (Buffer.isBuffer(value)) {
    comparable = { kind: 'buffer', bytes: [...value] };
  } else if (value instanceof Date) {
    comparable = {
      kind: 'date',
      epochMilliseconds: value.getTime(),
    };
  } else {
    return invalidConfig();
  }
  return { kind: 'scalar', tag, value: comparable };
}

function comparableNode(node: unknown): ComparableNode {
  if (
    node === null
    || typeof node === 'string'
    || typeof node === 'number'
    || typeof node === 'boolean'
  ) {
    return comparableScalar(node, undefined);
  }
  if (Array.isArray(node)) {
    return { kind: 'sequence', items: node.map(comparableNode) };
  }
  if (isAlias(node) || !isNode(node) || node.anchor) invalidConfig();
  if (isScalar(node)) return comparableScalar(node.value, node.tag);
  if (isSeq(node)) {
    return { kind: 'sequence', items: node.items.map(comparableNode) };
  }
  if (isMap(node)) {
    return {
      kind: 'mapping',
      entries: node.items.map(pair => {
        const key = typeof pair.key === 'string'
          ? pair.key
          : isScalar(pair.key) && typeof pair.key.value === 'string'
            ? pair.key.value
            : invalidConfig();
        return [key, comparableNode(pair.value)] as const;
      }),
    };
  }
  return invalidConfig();
}

function comparableEqual(left: ComparableNode, right: ComparableNode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'scalar' && right.kind === 'scalar') {
    if (left.tag !== right.tag) return false;
    const leftValue = left.value;
    const rightValue = right.value;
    if (Object.is(leftValue, rightValue)) return true;
    if (
      leftValue === null
      || rightValue === null
      || typeof leftValue !== 'object'
      || typeof rightValue !== 'object'
      || leftValue.kind !== rightValue.kind
    ) {
      return false;
    }
    if (leftValue.kind === 'date' && rightValue.kind === 'date') {
      return Object.is(
        leftValue.epochMilliseconds,
        rightValue.epochMilliseconds,
      );
    }
    return leftValue.kind === 'buffer'
      && rightValue.kind === 'buffer'
      && leftValue.bytes.length === rightValue.bytes.length
      && leftValue.bytes.every((byte, index) => (
        rightValue.bytes[index] === byte
      ));
  }
  if (left.kind === 'sequence' && right.kind === 'sequence') {
    return left.items.length === right.items.length
      && left.items.every((item, index) => (
        comparableEqual(item, right.items[index])
      ));
  }
  if (left.kind !== 'mapping' || right.kind !== 'mapping') return false;
  return left.entries.length === right.entries.length
    && left.entries.every(([key, value], index) => (
      right.entries[index][0] === key
      && comparableEqual(value, right.entries[index][1])
    ));
}

function applySet(
  document: Document,
  path: readonly string[],
  value: ConfigEditValue,
): void {
  const map = parentMap(document, path);
  const key = path.at(-1)!;
  const pair = pairFor(map, key);
  if (!pair) {
    map.set(key, Array.isArray(value) ? [...value] : value);
    return;
  }

  if (
    isScalar(pair.value)
    && !Array.isArray(value)
    && typeof pair.value.value === typeof value
  ) {
    (pair.value as Scalar).value = value;
    return;
  }

  const replacement = document.createNode(Array.isArray(value) ? [...value] : value);
  if (isNode(pair.value)) {
    replacement.commentBefore = pair.value.commentBefore;
    replacement.comment = pair.value.comment;
    replacement.spaceBefore = pair.value.spaceBefore;
  }
  pair.value = replacement;
}

function applyRemove(document: Document, path: readonly string[]): void {
  parentMap(document, path).delete(path.at(-1)!);
}

function applyRename(
  document: Document,
  from: readonly string[],
  to: readonly string[],
): void {
  const sourceMap = parentMap(document, from);
  const destinationMap = parentMap(document, to);
  const sourceKey = from.at(-1)!;
  const destinationKey = to.at(-1)!;
  const sourcePair = pairFor(sourceMap, sourceKey);
  if (!sourcePair || pairFor(destinationMap, destinationKey)) {
    throw new UpdateError('MIGRATION_CONFLICT');
  }

  if (sourceMap === destinationMap) {
    if (!isScalar(sourcePair.key)) invalidConfig();
    sourcePair.key.value = destinationKey;
    return;
  }

  sourceMap.items.splice(sourceMap.items.indexOf(sourcePair), 1);
  if (!isScalar(sourcePair.key)) invalidConfig();
  sourcePair.key.value = destinationKey;
  destinationMap.items.push(sourcePair);
}

function applyEdits(document: Document, edits: readonly ConfigEdit[]): void {
  for (const edit of edits) {
    if (edit.kind === 'set') {
      applySet(document, edit.path, edit.value);
    } else if (edit.kind === 'remove') {
      applyRemove(document, edit.path);
    } else {
      applyRename(document, edit.from, edit.to);
    }
  }
}

function verifyRenderedDocument(
  expected: ComparableNode,
  rendered: Document,
): void {
  if (!comparableEqual(expected, comparableNode(rendered.contents))) {
    throw new UpdateError('VALIDATION_FAILED');
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(bytes));
  } catch {
    return invalidConfig();
  }
}

function renderDocument(document: Document): string {
  try {
    return document.toString().replace(/\n*$/, '\n');
  } catch {
    return invalidConfig();
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf;
}

export function renderConfigEdits(
  configPath: string,
  edits: readonly ConfigEdit[],
): ConfigRenderResult {
  const validatedEdits = parseConfigEdits(edits);
  let sourceBytes: Buffer;
  try {
    sourceBytes = fs.readFileSync(configPath);
  } catch {
    throw new UpdateError('INVALID_CONFIG');
  }

  try {
    const document = parseConfig(decodeUtf8(sourceBytes));
    const currentVersion = readVersion(document);
    applyEdits(document, validatedEdits);
    const expected = comparableNode(document.contents);
    const rendered = renderDocument(document);
    const desiredBytes = Buffer.from(
      hasUtf8Bom(sourceBytes) ? `\u{feff}${rendered}` : rendered,
      'utf8',
    );
    const verified = parseConfig(decodeUtf8(desiredBytes));
    readVersion(verified);
    verifyRenderedDocument(expected, verified);

    return {
      currentVersion,
      sourceBytes,
      desiredBytes,
      sourceSha256: sha256(sourceBytes),
      desiredSha256: sha256(desiredBytes),
    };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return invalidConfig();
  }
}
