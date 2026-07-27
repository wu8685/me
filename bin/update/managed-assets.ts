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
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function utf8(bytes: Buffer, unsafePluginResource: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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

export function planManagedAsset(
  vaultRoot: string,
  pluginRoot: string,
  intent: ManagedAssetIntent,
): PlannedMutation | undefined {
  validateIntent(intent);
  const vault = canonicalDirectory(vaultRoot);
  const plugin = canonicalDirectory(pluginRoot);
  const desiredBytes = readRegularFile(plugin, intent.desiredTemplatePath);
  const desiredText = intent.strategy === 'merge-owned-sections'
    ? utf8(desiredBytes, true)
    : undefined;
  if (desiredText !== undefined) {
    const validated = mergeMeOwnedSections(desiredText, desiredText, 'conflict');
    if (validated.content !== desiredText) fail('UNSAFE_PATH');
  }
  const source = sourceFingerprint(vault, intent.vaultRelativePath);

  if (source.type === 'missing') {
    return intent.onAbsent === 'skip'
      ? undefined
      : writeMutation(intent.vaultRelativePath, source, desiredBytes, 0o644);
  }
  if (source.type !== 'file') fail('UNSAFE_PATH');
  const currentBytes = readRegularFile(vault, intent.vaultRelativePath);
  if (sha256(currentBytes) !== source.sha256) fail('UNSAFE_PATH');
  if (currentBytes.equals(desiredBytes)) return undefined;

  if (intent.strategy === 'create-if-absent') return undefined;
  const knownBytes = (intent.knownTemplatePaths ?? [])
    .map(knownPath => readRegularFile(plugin, knownPath));

  if (intent.strategy === 'replace-known-template') {
    if (!knownBytes.some(known => known.equals(currentBytes))) {
      fail('MIGRATION_CONFLICT');
    }
    return writeMutation(
      intent.vaultRelativePath,
      source,
      desiredBytes,
      source.mode ?? 0o644,
    );
  }

  const exactLegacy = knownBytes.some(known => known.equals(currentBytes));
  const merged = exactLegacy
    ? desiredText as string
    : mergeMeOwnedSections(
        utf8(currentBytes, false),
        desiredText as string,
        intent.onUnmarked,
      ).content;
  const mergedBytes = Buffer.from(merged);
  if (currentBytes.equals(mergedBytes)) return undefined;
  return writeMutation(
    intent.vaultRelativePath,
    source,
    mergedBytes,
    source.mode ?? 0o644,
  );
}

export { mergeMeOwnedSections } from './markdown-sections';
