import * as fs from 'fs';
import * as path from 'path';
import {
  RuntimePathError,
  type RuntimeLayout,
  resolveRuntimeLayout,
} from '../runtime-paths';
import {
  type LogicalLayer,
  type VaultWriteRequestV1,
  VaultWriterError,
} from './contracts';

export interface ResolvedVaultLayout extends RuntimeLayout {
  meDir: string;
  schemaPath: string;
  layers: Record<LogicalLayer, string>;
}

export interface ResolvedWriteTarget {
  layerRoot: string;
  notePath: string;
  vaultRelativePath: string;
  stem: string;
  indexPath: string;
}

const LOGICAL_LAYERS: LogicalLayer[] = ['raw', 'practices', 'cognition'];
const DEFAULT_LAYERS: Record<LogicalLayer, string> = {
  raw: 'raw',
  practices: 'practices',
  cognition: 'cognition',
};
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isStrictDescendant(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

function unsafePath(): never {
  throw new VaultWriterError('UNSAFE_PATH');
}

function invalidConfig(): never {
  throw new VaultWriterError('INVALID_CONFIG');
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    unsafePath();
  }
}

function assertExistingPrefixes(
  lexicalVault: string,
  canonicalVault: string,
  candidate: string,
): void {
  const absolute = path.resolve(candidate);
  if (!isInside(lexicalVault, absolute)) unsafePath();

  const relative = path.relative(lexicalVault, absolute);
  let current = lexicalVault;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    let canonical: string;
    try {
      canonical = fs.realpathSync(current);
    } catch {
      unsafePath();
    }
    if (!isInside(canonicalVault, canonical)) unsafePath();
  }
}

export function assertSafeWriterPath(
  layout: ResolvedVaultLayout,
  candidate: string,
  _label: string,
): void {
  assertExistingPrefixes(layout.lexicalVault, layout.canonicalVault, candidate);
}

function stripComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === quote) {
      if (quote === "'" && raw[index + 1] === "'") {
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (!quote && character === '#' && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index).trim();
    }
  }
  if (quote) invalidConfig();
  return raw.trim();
}

function parseStringScalar(raw: string): string {
  const value = stripComment(raw);
  if (!value) invalidConfig();
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) invalidConfig();
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') invalidConfig();
      return parsed;
    } catch {
      invalidConfig();
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) invalidConfig();
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:null|~|true|false|[-+]?(?:\d+\.?\d*|\.\d+))$/i.test(value)) invalidConfig();
  if (/^[\[{&*!|>]/.test(value) || /:\s/.test(value)) invalidConfig();
  return value;
}

export function parseLayerConfig(text: string): Partial<Record<LogicalLayer, string>> {
  const lines = text.split(/\r?\n/);
  const layerHeaders: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^layers\s*:/.test(lines[index])) layerHeaders.push(index);
  }
  if (layerHeaders.length === 0) return {};
  if (layerHeaders.length !== 1) invalidConfig();

  const header = lines[layerHeaders[0]];
  if (!/^layers\s*:\s*(?:#.*)?$/.test(header)) invalidConfig();

  const result: Partial<Record<LogicalLayer, string>> = {};
  let childIndent: number | undefined;
  for (let index = layerHeaders[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0) break;
    if (childIndent === undefined) childIndent = indent;
    if (indent !== childIndent) invalidConfig();
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match || !LOGICAL_LAYERS.includes(match[1] as LogicalLayer)) invalidConfig();
    const layer = match[1] as LogicalLayer;
    if (result[layer] !== undefined) invalidConfig();
    result[layer] = parseStringScalar(match[2]);
  }
  return result;
}

function validateConfiguredLayerPath(configured: string): void {
  if (
    !configured
    || path.posix.isAbsolute(configured)
    || configured.startsWith('//')
    || WINDOWS_DRIVE.test(configured)
    || configured.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(configured)
  ) {
    invalidConfig();
  }
  const components = configured.split('/');
  if (components.some(component => component === '' || component === '.' || component === '..')) {
    invalidConfig();
  }
}

function requireRealDirectory(
  layout: ResolvedVaultLayout,
  candidate: string,
  allowSymlink: boolean,
  errorKind: 'config' | 'path',
): void {
  assertSafeWriterPath(layout, candidate, candidate);
  const stat = lstatIfPresent(candidate);
  if (!stat) {
    if (errorKind === 'config') invalidConfig();
    unsafePath();
  }
  if ((!allowSymlink && stat.isSymbolicLink()) || !fs.statSync(candidate).isDirectory()) {
    if (errorKind === 'config') invalidConfig();
    unsafePath();
  }
}

function validateOptionalRealDirectory(layout: ResolvedVaultLayout, candidate: string): void {
  assertSafeWriterPath(layout, candidate, candidate);
  const stat = lstatIfPresent(candidate);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) unsafePath();
}

function validateOptionalContainedEntry(layout: ResolvedVaultLayout, candidate: string): void {
  assertSafeWriterPath(layout, candidate, candidate);
}

export function resolveVaultLayout(vaultDir: string): ResolvedVaultLayout {
  const lexicalVault = path.resolve(vaultDir);
  let canonicalVault: string;
  try {
    canonicalVault = fs.realpathSync(lexicalVault);
    if (!fs.statSync(lexicalVault).isDirectory()) invalidConfig();
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    invalidConfig();
  }

  let runtime: RuntimeLayout;
  try {
    runtime = resolveRuntimeLayout(lexicalVault);
  } catch (error) {
    if (error instanceof RuntimePathError) {
      throw new VaultWriterError(
        error.code === 'UNSUPPORTED_FILESYSTEM' ? 'UNSUPPORTED_FILESYSTEM' : 'UNSAFE_PATH',
      );
    }
    unsafePath();
  }

  const meDir = path.join(lexicalVault, '.me');
  const layout: ResolvedVaultLayout = {
    ...runtime,
    meDir,
    schemaPath: path.join(lexicalVault, 'SCHEMA.md'),
    layers: {
      raw: path.join(lexicalVault, DEFAULT_LAYERS.raw),
      practices: path.join(lexicalVault, DEFAULT_LAYERS.practices),
      cognition: path.join(lexicalVault, DEFAULT_LAYERS.cognition),
    },
  };

  requireRealDirectory(layout, meDir, false, 'path');
  const configPath = path.join(meDir, 'config.yaml');
  validateOptionalContainedEntry(layout, configPath);
  const configStat = lstatIfPresent(configPath);
  let configured: Partial<Record<LogicalLayer, string>> = {};
  if (configStat) {
    if (!fs.statSync(configPath).isFile()) invalidConfig();
    try {
      configured = parseLayerConfig(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      if (error instanceof VaultWriterError) throw error;
      invalidConfig();
    }
  }

  for (const layer of LOGICAL_LAYERS) {
    const configuredPath = configured[layer] ?? DEFAULT_LAYERS[layer];
    validateConfiguredLayerPath(configuredPath);
    layout.layers[layer] = path.join(lexicalVault, ...configuredPath.split('/'));
  }

  validateOptionalContainedEntry(layout, layout.schemaPath);
  const schemaStat = lstatIfPresent(layout.schemaPath);
  if (!schemaStat || !fs.statSync(layout.schemaPath).isFile()) invalidConfig();

  const lexicalLayers = LOGICAL_LAYERS.map(layer => layout.layers[layer]);
  const canonicalLayers: string[] = [];
  for (const layerRoot of lexicalLayers) {
    if (!isStrictDescendant(lexicalVault, layerRoot)) invalidConfig();
    requireRealDirectory(layout, layerRoot, true, 'config');
    canonicalLayers.push(fs.realpathSync(layerRoot));
    validateOptionalContainedEntry(layout, path.join(layerRoot, 'README.md'));

    if (overlaps(layerRoot, meDir) || isInside(layerRoot, layout.schemaPath)) invalidConfig();
    const canonicalMe = fs.realpathSync(meDir);
    const canonicalSchema = fs.realpathSync(layout.schemaPath);
    const canonicalLayer = fs.realpathSync(layerRoot);
    if (overlaps(canonicalLayer, canonicalMe) || isInside(canonicalLayer, canonicalSchema)) {
      invalidConfig();
    }
    if (!isStrictDescendant(canonicalVault, canonicalLayer)) invalidConfig();
  }

  for (let first = 0; first < lexicalLayers.length; first += 1) {
    for (let second = first + 1; second < lexicalLayers.length; second += 1) {
      if (
        overlaps(lexicalLayers[first], lexicalLayers[second])
        || overlaps(canonicalLayers[first], canonicalLayers[second])
      ) {
        invalidConfig();
      }
    }
  }

  return layout;
}

export function detectLegacyVaultWriterState(layout: ResolvedVaultLayout): string[] {
  const entries: string[] = [];
  for (const directory of [
    path.join(layout.meDir, 'locks'),
    path.join(layout.meDir, 'tmp'),
  ]) {
    assertSafeWriterPath(layout, directory, 'legacy runtime directory');
    const stat = lstatIfPresent(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) unsafePath();
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      unsafePath();
    }
    for (const name of names) {
      const candidate = path.join(directory, name);
      assertSafeWriterPath(layout, candidate, 'legacy runtime entry');
      entries.push(vaultRelative(layout, candidate));
    }
  }
  return entries.sort();
}

export function resolveWriteTarget(
  layout: ResolvedVaultLayout,
  request: VaultWriteRequestV1,
): ResolvedWriteTarget {
  const layerRoot = layout.layers[request.layer];
  const notePath = path.join(layerRoot, ...request.relativePath.split('/'));
  const indexPath = path.join(layerRoot, 'README.md');
  if (!isStrictDescendant(layerRoot, notePath)) unsafePath();
  assertSafeWriterPath(layout, notePath, 'note');
  assertSafeWriterPath(layout, path.dirname(notePath), 'note parent');
  assertSafeWriterPath(layout, indexPath, 'index');
  if (lstatIfPresent(notePath)) throw new VaultWriterError('TARGET_EXISTS');

  return {
    layerRoot,
    notePath,
    vaultRelativePath: vaultRelative(layout, notePath),
    stem: path.basename(notePath, '.md'),
    indexPath,
  };
}

export function vaultRelative(layout: ResolvedVaultLayout, absolute: string): string {
  const candidate = path.resolve(absolute);
  assertSafeWriterPath(layout, candidate, 'result path');
  if (!isInside(layout.lexicalVault, candidate)) unsafePath();
  return path.relative(layout.lexicalVault, candidate).split(path.sep).join('/') || '.';
}
