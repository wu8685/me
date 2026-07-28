import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  MutationFailure,
  fingerprintMutationSource,
  type MutationPathPolicy,
  type PlannedMutation,
  type SourceFingerprint,
} from '../mutation/contracts';
import { UpdateError } from './contracts';
import {
  mergeMeOwnedSections,
  type UnmarkedManagedAssetPolicy,
} from './markdown-sections';

export type ManagedAssetStrategy =
  | 'create-if-absent'
  | 'replace-known-template'
  | 'merge-owned-sections';

export interface ManagedAssetIntent {
  vaultRelativePath: string;
  desiredTemplatePath: string;
  strategy: ManagedAssetStrategy;
  knownTemplatePaths?: readonly string[];
  onAbsent: 'create' | 'skip';
  onUnmarked: UnmarkedManagedAssetPolicy;
}

export type ManagedAssetCurrent =
  | { type: 'missing' }
  | { type: 'file'; bytes: Buffer; mode: number };

export interface ManagedAssetRenderResult {
  desiredBytes: Buffer;
  desiredMode: number;
}

function fail(code: 'MIGRATION_CONFLICT' | 'UNSAFE_PATH' | 'UNSUPPORTED_FILESYSTEM'): never {
  throw new UpdateError(code);
}

function safeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !value
    || value.startsWith('/')
    || value.startsWith('//')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  return !value.split('/').some(
    component => !component || component === '.' || component === '..',
  );
}

function canonicalDirectory(candidate: string): string {
  const lexical = path.resolve(candidate);
  let stat: fs.Stats;
  let canonical: string;
  try {
    stat = fs.lstatSync(lexical);
    canonical = fs.realpathSync.native(lexical);
  } catch {
    fail('UNSAFE_PATH');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function inspectPathComponents(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isWithin(root, absolute)) fail('UNSAFE_PATH');
  const relative = path.relative(root, absolute);
  if (!relative) return;
  const components = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      fail('UNSAFE_PATH');
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
    if (index < components.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH');
  }
}

function pathPolicy(root: string): MutationPathPolicy {
  return {
    assertSafe(candidate) {
      inspectPathComponents(root, candidate);
    },
    display(candidate) {
      const absolute = path.resolve(candidate);
      if (!isWithin(root, absolute)) return '<unsafe>';
      return path.relative(root, absolute).split(path.sep).join('/') || '.';
    },
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256')
    .update(Uint8Array.from(bytes))
    .digest('hex');
}

function bytesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length
    && left.every((byte, index) => right[index] === byte);
}

function utf8(bytes: Buffer, unsafePluginResource: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(bytes));
  } catch {
    if (unsafePluginResource) fail('UNSAFE_PATH');
    return fail('MIGRATION_CONFLICT');
  }
}

function readRegularFile(root: string, relativePath: string): Buffer {
  if (!safeRelativePath(relativePath)) fail('UNSAFE_PATH');
  const absolute = path.resolve(root, ...relativePath.split('/'));
  inspectPathComponents(root, absolute);
  let descriptor: number | undefined;
  try {
    const entry = fs.lstatSync(absolute, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) fail('UNSAFE_PATH');
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.dev !== entry.dev
      || before.ino !== entry.ino
      || before.mode !== entry.mode
      || before.size !== entry.size
      || before.nlink !== entry.nlink
    ) fail('UNSAFE_PATH');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(absolute, { bigint: true });
    if (
      !after.isFile()
      || !named.isFile()
      || named.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.size !== before.size
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || named.dev !== after.dev
      || named.ino !== after.ino
      || named.mode !== after.mode
      || named.size !== after.size
      || named.nlink !== after.nlink
    ) fail('UNSAFE_PATH');
    return bytes;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    fail('UNSAFE_PATH');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A close failure cannot make an untrusted path safe.
      }
    }
  }
}

function sourceFingerprint(
  vaultRoot: string,
  vaultRelativePath: string,
): SourceFingerprint {
  try {
    return fingerprintMutationSource({
      vaultRoot,
      vaultRelativePath,
      pathPolicy: pathPolicy(vaultRoot),
    });
  } catch (error) {
    if (error instanceof MutationFailure) {
      if (error.code === 'UNSUPPORTED_FILESYSTEM') fail('UNSUPPORTED_FILESYSTEM');
      fail('UNSAFE_PATH');
    }
    throw error;
  }
}

function writeMutation(
  vaultRelativePath: string,
  source: SourceFingerprint,
  desiredBytes: Buffer,
  desiredMode: number,
): PlannedMutation {
  return {
    kind: 'write-file',
    vaultRelativePath,
    source,
    desiredBytes,
    desiredSha256: sha256(desiredBytes),
    desiredMode,
    publishOrder: 0,
  };
}

function validateIntent(intent: ManagedAssetIntent): void {
  if (
    !safeRelativePath(intent.vaultRelativePath)
    || !safeRelativePath(intent.desiredTemplatePath)
    || !['create-if-absent', 'replace-known-template', 'merge-owned-sections']
      .includes(intent.strategy)
    || !['create', 'skip'].includes(intent.onAbsent)
    || !['adopt-known-legacy', 'append-marked-block', 'conflict']
      .includes(intent.onUnmarked)
    || intent.knownTemplatePaths?.some(known => !safeRelativePath(known))
  ) fail('UNSAFE_PATH');
}

export function renderManagedAssetBytes(options: {
  intent: ManagedAssetIntent;
  current: ManagedAssetCurrent;
  readPluginResource(relativePath: string): Buffer;
}): ManagedAssetRenderResult | undefined {
  const { intent, current, readPluginResource } = options;
  validateIntent(intent);
  if (
    !current
    || typeof current !== 'object'
    || (
      current.type === 'file'
      && (
        !Buffer.isBuffer(current.bytes)
        || !Number.isSafeInteger(current.mode)
        || current.mode < 0
        || current.mode > 0o777
      )
    )
    || !['missing', 'file'].includes(current.type)
  ) {
    fail('UNSAFE_PATH');
  }

  const desiredBytes = readPluginResource(intent.desiredTemplatePath);
  if (!Buffer.isBuffer(desiredBytes)) fail('UNSAFE_PATH');
  const desiredText = intent.strategy === 'merge-owned-sections'
    ? utf8(desiredBytes, true)
    : undefined;
  if (desiredText !== undefined) {
    const validated = mergeMeOwnedSections(
      desiredText,
      desiredText,
      'conflict',
    );
    if (validated.content !== desiredText) fail('UNSAFE_PATH');
  }

  if (current.type === 'missing') {
    return intent.onAbsent === 'skip'
      ? undefined
      : {
          desiredBytes: Buffer.from(Uint8Array.from(desiredBytes)),
          desiredMode: 0o644,
        };
  }
  if (bytesEqual(current.bytes, desiredBytes)) return undefined;
  if (intent.strategy === 'create-if-absent') return undefined;

  const knownBytes = (intent.knownTemplatePaths ?? []).map(relativePath => {
    const bytes = readPluginResource(relativePath);
    if (!Buffer.isBuffer(bytes)) fail('UNSAFE_PATH');
    return bytes;
  });
  if (intent.strategy === 'replace-known-template') {
    if (!knownBytes.some(known => bytesEqual(known, current.bytes))) {
      fail('MIGRATION_CONFLICT');
    }
    return {
      desiredBytes: Buffer.from(Uint8Array.from(desiredBytes)),
      desiredMode: current.mode,
    };
  }

  const merged = mergeMeOwnedSections(
    utf8(current.bytes, false),
    desiredText as string,
    intent.onUnmarked,
    knownBytes.map(known => utf8(known, true)),
  ).content;
  const mergedBytes = Buffer.from(merged);
  if (bytesEqual(current.bytes, mergedBytes)) return undefined;
  return { desiredBytes: mergedBytes, desiredMode: current.mode };
}

export function planManagedAsset(
  vaultRoot: string,
  pluginRoot: string,
  intent: ManagedAssetIntent,
): PlannedMutation | undefined {
  validateIntent(intent);
  const vault = canonicalDirectory(vaultRoot);
  const plugin = canonicalDirectory(pluginRoot);
  const source = sourceFingerprint(vault, intent.vaultRelativePath);
  let current: ManagedAssetCurrent;
  if (source.type === 'missing') {
    current = { type: 'missing' };
  } else if (source.type === 'file') {
    const currentBytes = readRegularFile(vault, intent.vaultRelativePath);
    if (sha256(currentBytes) !== source.sha256) fail('UNSAFE_PATH');
    current = {
      type: 'file',
      bytes: currentBytes,
      mode: source.mode ?? 0o644,
    };
  } else {
    return fail('UNSAFE_PATH');
  }
  const rendered = renderManagedAssetBytes({
    intent,
    current,
    readPluginResource(relativePath) {
      return readRegularFile(plugin, relativePath);
    },
  });
  if (!rendered) return undefined;
  return writeMutation(
    intent.vaultRelativePath,
    source,
    rendered.desiredBytes,
    rendered.desiredMode,
  );
}

export { mergeMeOwnedSections } from './markdown-sections';
