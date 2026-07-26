import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  Document,
  isMap,
  isNode,
  isScalar,
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

function parseConfig(source: string): Document {
  let document: Document;
  try {
    document = parseDocument(source, {
      keepSourceTokens: true,
      uniqueKeys: true,
    });
  } catch {
    throw new UpdateError('INVALID_CONFIG');
  }
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new UpdateError('INVALID_CONFIG');
  }
  return document;
}

function readVersion(document: Document): number {
  if (!document.has('vault_schema_version')) return 0;
  const value = document.get('vault_schema_version');
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new UpdateError('INVALID_VAULT_SCHEMA_VERSION');
  }
  return value;
}

export function readVaultSchemaVersion(source: string): number {
  return readVersion(parseConfig(source));
}

function validatePath(candidate: readonly string[] | undefined): void {
  if (
    !Array.isArray(candidate)
    || candidate.length === 0
    || candidate.some(component => (
      typeof component !== 'string'
      || component.length === 0
      || component.includes('\u0000')
    ))
  ) {
    throw new UpdateError('INVALID_REQUEST');
  }
}

function pairFor(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find(pair => (
    isScalar(pair.key) && pair.key.value === key
  ));
}

function parentMap(document: Document, path: readonly string[]): YAMLMap {
  validatePath(path);
  let current = document.contents;
  for (const component of path.slice(0, -1)) {
    if (!isMap(current)) throw new UpdateError('INVALID_CONFIG');
    current = current.get(component, true);
  }
  if (!isMap(current)) throw new UpdateError('INVALID_CONFIG');
  return current;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    );
  }
  return value;
}

function jsValueAt(document: Document, path: readonly string[]): unknown {
  let current = document.toJS();
  for (const component of path) {
    if (
      !current
      || typeof current !== 'object'
      || Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[component];
  }
  return cloneJsonValue(current);
}

function applySet(
  document: Document,
  path: readonly string[],
  value: string | number | boolean | readonly string[],
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
    && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
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
  const map = parentMap(document, path);
  map.delete(path.at(-1)!);
}

function applyRename(
  document: Document,
  from: readonly string[],
  to: readonly string[],
): unknown {
  const sourceMap = parentMap(document, from);
  const destinationMap = parentMap(document, to);
  const sourceKey = from.at(-1)!;
  const destinationKey = to.at(-1)!;
  const sourcePair = pairFor(sourceMap, sourceKey);
  if (!sourcePair || pairFor(destinationMap, destinationKey)) {
    throw new UpdateError('MIGRATION_CONFLICT');
  }

  const sourceValue = jsValueAt(document, from);
  if (sourceMap === destinationMap) {
    if (!isScalar(sourcePair.key)) throw new UpdateError('INVALID_CONFIG');
    sourcePair.key.value = destinationKey;
    return sourceValue;
  }

  const sourceIndex = sourceMap.items.indexOf(sourcePair);
  sourceMap.items.splice(sourceIndex, 1);
  if (!isScalar(sourcePair.key)) throw new UpdateError('INVALID_CONFIG');
  sourcePair.key.value = destinationKey;
  destinationMap.items.push(sourcePair);
  return sourceValue;
}

interface AppliedEdit {
  edit: ConfigEdit;
  renamedValue?: unknown;
}

function applyEdits(document: Document, edits: readonly ConfigEdit[]): AppliedEdit[] {
  return edits.map(edit => {
    if (edit.kind === 'set') {
      applySet(document, edit.path, edit.value);
      return { edit };
    }
    if (edit.kind === 'remove') {
      applyRemove(document, edit.path);
      return { edit };
    }
    if (edit.kind === 'rename') {
      return {
        edit,
        renamedValue: applyRename(document, edit.from, edit.to),
      };
    }
    throw new UpdateError('INVALID_REQUEST');
  });
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function verifyEdits(document: Document, applied: readonly AppliedEdit[]): void {
  for (const { edit, renamedValue } of applied) {
    if (edit.kind === 'set') {
      const expected = Array.isArray(edit.value) ? [...edit.value] : edit.value;
      if (!valuesEqual(document.getIn(edit.path), expected)) {
        throw new UpdateError('VALIDATION_FAILED');
      }
    } else if (edit.kind === 'remove') {
      if (document.hasIn(edit.path)) throw new UpdateError('VALIDATION_FAILED');
    } else if (
      document.hasIn(edit.from)
      || !valuesEqual(document.getIn(edit.to), renamedValue)
    ) {
      throw new UpdateError('VALIDATION_FAILED');
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

export function renderConfigEdits(
  configPath: string,
  edits: readonly ConfigEdit[],
): ConfigRenderResult {
  if (!Array.isArray(edits)) throw new UpdateError('INVALID_REQUEST');
  let sourceBytes: Buffer;
  try {
    sourceBytes = fs.readFileSync(configPath);
  } catch {
    throw new UpdateError('INVALID_CONFIG');
  }

  const document = parseConfig(sourceBytes.toString('utf8'));
  const currentVersion = readVersion(document);
  const applied = applyEdits(document, edits);
  const rendered = document.toString().replace(/\n*$/, '\n');
  const desiredBytes = Buffer.from(rendered, 'utf8');
  const verified = parseConfig(desiredBytes.toString('utf8'));
  verifyEdits(verified, applied);

  return {
    currentVersion,
    sourceBytes,
    desiredBytes,
    sourceSha256: sha256(sourceBytes),
    desiredSha256: sha256(desiredBytes),
  };
}
