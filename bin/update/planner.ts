import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { createTwoFilesPatch } from 'diff';
import {
  MutationFailure,
  fingerprintMutationSource,
  validatePlannedMutations,
  type MutationPathPolicy,
  type PlannedMutation,
  type SourceFingerprint,
} from '../mutation/contracts.ts';
import {
  readVaultSchemaVersion,
  renderConfigEdits,
  type ConfigEdit,
} from './config-document.ts';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UpdateError,
  type UpdatePlan,
} from './contracts.ts';
import {
  planManagedAsset,
  type ManagedAssetIntent,
} from './managed-assets.ts';
import {
  MIGRATION_REGISTRY,
  validateMigrationRegistry,
  type ContentTransformIntent,
  type MigrationIntent,
  type VaultMigration,
} from './registry.ts';

const CONFIG_PATH = '.me/config.yaml';

type DigestMaterial =
  | {
      kind: 'config';
      path: string;
      source: SourceFingerprint;
      desiredSha256: string;
      desiredMode: number;
    }
  | {
      kind: 'managed-asset';
      path: string;
      source: SourceFingerprint;
      desiredTemplateSha256: string;
      knownTemplateSha256: readonly string[];
    }
  | {
      kind: 'content-transform';
      path: string;
      source: SourceFingerprint;
      desiredSha256: string;
      desiredMode: number;
    };

function fail(
  code:
    | 'INVALID_MIGRATION_REGISTRY'
    | 'MIGRATION_CONFLICT'
    | 'NOT_A_ME_VAULT'
    | 'UNSAFE_PATH'
    | 'UNSUPPORTED_FILESYSTEM',
): never {
  throw new UpdateError(code);
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash('sha256')
    .update(typeof bytes === 'string' ? bytes : Uint8Array.from(bytes))
    .digest('hex');
}

function bytesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length
    && left.every((byte, index) => right[index] === byte);
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
  ) {
    return false;
  }
  return !value.split('/').some(
    component => !component || component === '.' || component === '..',
  );
}

function canonicalDirectory(candidate: string): string {
  const lexical = path.resolve(candidate);
  try {
    const stat = fs.lstatSync(lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
    return fs.realpathSync.native(lexical);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function inspectPathComponents(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isWithin(root, absolute)) fail('UNSAFE_PATH');
  const relative = path.relative(root, absolute);
  if (!relative) return;
  let current = root;
  const components = relative.split(path.sep);
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
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail('UNSAFE_PATH');
    }
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

function translateMutationFailure(error: MutationFailure): never {
  if (error.code === 'UNSUPPORTED_FILESYSTEM') {
    fail('UNSUPPORTED_FILESYSTEM');
  }
  if (
    error.code === 'TARGET_EXISTS'
    || error.code === 'SOURCE_CHANGED'
    || error.code === 'OWNERSHIP_LOST'
  ) {
    fail('MIGRATION_CONFLICT');
  }
  fail('UNSAFE_PATH');
}

function fingerprint(
  root: string,
  vaultRelativePath: string,
): SourceFingerprint {
  if (!safeRelativePath(vaultRelativePath)) fail('UNSAFE_PATH');
  try {
    return fingerprintMutationSource({
      vaultRoot: root,
      vaultRelativePath,
      pathPolicy: pathPolicy(root),
    });
  } catch (error) {
    if (error instanceof MutationFailure) {
      return translateMutationFailure(error);
    }
    throw error;
  }
}

function readRegularFile(
  root: string,
  relativePath: string,
  expected?: SourceFingerprint,
): { bytes: Buffer; fingerprint: SourceFingerprint } {
  const source = expected ?? fingerprint(root, relativePath);
  if (source.type !== 'file') fail('UNSAFE_PATH');
  const absolute = path.resolve(root, ...relativePath.split('/'));
  inspectPathComponents(root, absolute);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail('UNSAFE_PATH');
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
      || Number(after.mode & 0o777n) !== source.mode
      || sha256(bytes) !== source.sha256
    ) {
      fail('UNSAFE_PATH');
    }
    return { bytes, fingerprint: source };
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Closing cannot make an untrusted read safe.
      }
    }
  }
}

function readPluginResource(
  pluginRoot: string,
  relativePath: string,
): Buffer {
  if (!safeRelativePath(relativePath)) fail('UNSAFE_PATH');
  return readRegularFile(pluginRoot, relativePath).bytes;
}

function validateIntent(value: unknown): asserts value is MigrationIntent {
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as MigrationIntent).configEdits)
    || !Array.isArray((value as MigrationIntent).managedAssets)
    || !Array.isArray((value as MigrationIntent).contentTransforms)
  ) {
    fail('INVALID_MIGRATION_REGISTRY');
  }
}

function planMigration(
  migration: VaultMigration,
  vaultDir: string,
  pluginRoot: string,
): MigrationIntent {
  let intent: MigrationIntent;
  try {
    intent = migration.plan(Object.freeze({
      vaultDir,
      pluginRoot,
      currentVaultSchemaVersion: migration.fromVersion,
    }));
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('INVALID_MIGRATION_REGISTRY');
  }
  validateIntent(intent);
  return intent;
}

function planManagedAssets(
  vaultDir: string,
  pluginRoot: string,
  intents: readonly ManagedAssetIntent[],
): {
  mutations: PlannedMutation[];
  materials: DigestMaterial[];
} {
  const mutations: PlannedMutation[] = [];
  const materials: DigestMaterial[] = [];
  for (const intent of intents) {
    if (
      !intent
      || typeof intent !== 'object'
      || !safeRelativePath(intent.vaultRelativePath)
      || !safeRelativePath(intent.desiredTemplatePath)
    ) {
      fail('UNSAFE_PATH');
    }
    const knownTemplatePaths = [...(intent.knownTemplatePaths ?? [])];
    if (knownTemplatePaths.some(item => !safeRelativePath(item))) {
      fail('UNSAFE_PATH');
    }
    const source = fingerprint(vaultDir, intent.vaultRelativePath);
    const desiredBytes = readPluginResource(
      pluginRoot,
      intent.desiredTemplatePath,
    );
    const desiredTemplateSha256 = sha256(desiredBytes);
    const knownTemplateSha256 = knownTemplatePaths
      .map(item => sha256(readPluginResource(pluginRoot, item)))
      .sort();
    const mutation = planManagedAsset(vaultDir, pluginRoot, intent);
    const sourceAfter = fingerprint(vaultDir, intent.vaultRelativePath);
    const desiredTemplateSha256After = sha256(readPluginResource(
      pluginRoot,
      intent.desiredTemplatePath,
    ));
    const knownTemplateSha256After = knownTemplatePaths
      .map(item => sha256(readPluginResource(pluginRoot, item)))
      .sort();
    if (
      canonicalStringify(sourceAfter) !== canonicalStringify(source)
      || desiredTemplateSha256After !== desiredTemplateSha256
      || canonicalStringify(knownTemplateSha256After)
        !== canonicalStringify(knownTemplateSha256)
    ) {
      fail('UNSAFE_PATH');
    }
    if (mutation) mutations.push(mutation);
    materials.push({
      kind: 'managed-asset',
      path: intent.vaultRelativePath,
      source,
      desiredTemplateSha256,
      knownTemplateSha256,
    });
  }
  return { mutations, materials };
}

function planContentTransforms(
  vaultDir: string,
  intents: readonly ContentTransformIntent[],
): {
  mutations: PlannedMutation[];
  materials: DigestMaterial[];
  sourceBytes: Map<string, Buffer>;
} {
  const mutations: PlannedMutation[] = [];
  const materials: DigestMaterial[] = [];
  const sourceBytes = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const intent of intents) {
    if (
      !intent
      || typeof intent !== 'object'
      || !Array.isArray(intent.vaultRelativePaths)
      || typeof intent.transform !== 'function'
    ) {
      fail('INVALID_MIGRATION_REGISTRY');
    }
    const paths = [...intent.vaultRelativePaths];
    if (paths.some(item => !safeRelativePath(item))) fail('UNSAFE_PATH');
    paths.sort();
    for (const relativePath of paths) {
      if (seen.has(relativePath)) fail('MIGRATION_CONFLICT');
      seen.add(relativePath);
      const source = fingerprint(vaultDir, relativePath);
      const current = readRegularFile(vaultDir, relativePath, source).bytes;
      let desired: Buffer;
      try {
        const transformed = intent.transform(
          relativePath,
          Buffer.from(Uint8Array.from(current)),
        );
        if (!Buffer.isBuffer(transformed)) {
          fail('INVALID_MIGRATION_REGISTRY');
        }
        desired = Buffer.from(Uint8Array.from(transformed));
      } catch (error) {
        if (error instanceof UpdateError) throw error;
        return fail('MIGRATION_CONFLICT');
      }
      sourceBytes.set(relativePath, current);
      materials.push({
        kind: 'content-transform',
        path: relativePath,
        source,
        desiredSha256: sha256(desired),
        desiredMode: source.mode ?? 0o644,
      });
      if (!bytesEqual(current, desired)) {
        mutations.push({
          kind: 'write-file',
          vaultRelativePath: relativePath,
          source,
          desiredBytes: desired,
          desiredSha256: sha256(desired),
          desiredMode: source.mode ?? 0o644,
          publishOrder: 0,
        });
      }
    }
  }
  return { mutations, materials, sourceBytes };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function mutationDigestRecord(mutation: PlannedMutation): unknown {
  if (mutation.kind === 'write-file') {
    return {
      kind: mutation.kind,
      path: mutation.vaultRelativePath,
      source: mutation.source,
      desiredSha256: mutation.desiredSha256,
      desiredMode: mutation.desiredMode,
      publishOrder: mutation.publishOrder,
    };
  }
  if (mutation.kind === 'mkdir') {
    return {
      kind: mutation.kind,
      path: mutation.vaultRelativePath,
      source: mutation.source,
      desiredMode: mutation.desiredMode,
      publishOrder: mutation.publishOrder,
    };
  }
  return {
    kind: mutation.kind,
    path: mutation.vaultRelativePath,
    destinationPath: mutation.destinationVaultRelativePath,
    source: mutation.source,
    destinationSource: mutation.destinationSource,
    publishOrder: mutation.publishOrder,
  };
}

function utf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(bytes));
  } catch {
    return fail('MIGRATION_CONFLICT');
  }
}

function sourceBytesForMutation(
  vaultDir: string,
  mutation: PlannedMutation,
  cached: ReadonlyMap<string, Buffer>,
): Buffer {
  const cachedBytes = cached.get(mutation.vaultRelativePath);
  if (cachedBytes) return cachedBytes;
  if (mutation.source.type === 'missing') return Buffer.alloc(0);
  return readRegularFile(
    vaultDir,
    mutation.vaultRelativePath,
    mutation.source,
  ).bytes;
}

function makeDiff(
  relativePath: string,
  sourceBytes: Buffer,
  desiredBytes: Buffer,
): string {
  return createTwoFilesPatch(
    relativePath,
    relativePath,
    utf8(sourceBytes),
    utf8(desiredBytes),
    'before',
    'after',
    { context: 3 },
  );
}

function sortMutations(mutations: readonly PlannedMutation[]): PlannedMutation[] {
  return [...mutations]
    .sort((left, right) => {
      const leftConfig = left.vaultRelativePath === CONFIG_PATH ? 1 : 0;
      const rightConfig = right.vaultRelativePath === CONFIG_PATH ? 1 : 0;
      if (leftConfig !== rightConfig) return leftConfig - rightConfig;
      return left.vaultRelativePath.localeCompare(right.vaultRelativePath);
    })
    .map((mutation, publishOrder) => ({ ...mutation, publishOrder }));
}

export function planVaultUpdate(options: {
  vaultDir: string;
  pluginRoot: string;
  registry?: readonly VaultMigration[];
}): UpdatePlan {
  const vaultDir = canonicalDirectory(options.vaultDir);
  const pluginRoot = canonicalDirectory(options.pluginRoot);
  const registry = options.registry ?? MIGRATION_REGISTRY;
  validateMigrationRegistry(registry, CURRENT_VAULT_SCHEMA_VERSION);

  const configSource = fingerprint(vaultDir, CONFIG_PATH);
  if (configSource.type === 'missing') fail('NOT_A_ME_VAULT');
  if (configSource.type !== 'file') fail('UNSAFE_PATH');
  const configBytes = readRegularFile(
    vaultDir,
    CONFIG_PATH,
    configSource,
  ).bytes;
  const currentVersion = readVaultSchemaVersion(utf8(configBytes));
  if (currentVersion > CURRENT_VAULT_SCHEMA_VERSION) {
    throw new UpdateError('VAULT_NEWER_THAN_PLUGIN');
  }

  const selected = registry.slice(currentVersion);
  const descriptions: Array<{ id: string; description: string }> = [];
  const configEdits: ConfigEdit[] = [];
  const managedAssets: ManagedAssetIntent[] = [];
  const contentTransforms: ContentTransformIntent[] = [];
  for (const migration of selected) {
    let description: string;
    try {
      description = migration.describe();
    } catch {
      return fail('INVALID_MIGRATION_REGISTRY');
    }
    if (typeof description !== 'string') fail('INVALID_MIGRATION_REGISTRY');
    descriptions.push({ id: migration.id, description });
    const intent = planMigration(migration, vaultDir, pluginRoot);
    configEdits.push(...intent.configEdits);
    managedAssets.push(...intent.managedAssets);
    contentTransforms.push(...intent.contentTransforms);
  }

  if (selected.length === 0) {
    const registryRevision = sha256(canonicalStringify(
      registry.map(migration => ({
        id: migration.id,
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
      })),
    ));
    const planDigest = sha256(canonicalStringify({
      registryRevision,
      sourceVersion: currentVersion,
      targetVersion: CURRENT_VAULT_SCHEMA_VERSION,
      migrationIds: [],
      plannedPaths: [],
      materials: [{
        kind: 'config',
        path: CONFIG_PATH,
        source: configSource,
        desiredSha256: sha256(configBytes),
        desiredMode: configSource.mode ?? 0o644,
      }],
      mutations: [],
    }));
    return {
      status: 'up_to_date',
      currentVaultSchemaVersion: currentVersion,
      targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
      migrations: [],
      mutations: [],
      plannedPaths: [],
      diffs: [],
      warnings: [],
      planDigest,
    };
  }

  const configRender = renderConfigEdits(
    path.join(vaultDir, '.me', 'config.yaml'),
    configEdits,
  );
  if (
    configRender.currentVersion !== currentVersion
    || configRender.sourceSha256 !== configSource.sha256
    || canonicalStringify(fingerprint(vaultDir, CONFIG_PATH))
      !== canonicalStringify(configSource)
    || readVaultSchemaVersion(utf8(configRender.desiredBytes))
      !== CURRENT_VAULT_SCHEMA_VERSION
  ) {
    fail('INVALID_MIGRATION_REGISTRY');
  }
  const configMutation: PlannedMutation = {
    kind: 'write-file',
    vaultRelativePath: CONFIG_PATH,
    source: configSource,
    desiredBytes: Buffer.from(Uint8Array.from(configRender.desiredBytes)),
    desiredSha256: configRender.desiredSha256,
    desiredMode: configSource.mode ?? 0o644,
    publishOrder: 0,
  };
  const configMaterial: DigestMaterial = {
    kind: 'config',
    path: CONFIG_PATH,
    source: configSource,
    desiredSha256: configRender.desiredSha256,
    desiredMode: configSource.mode ?? 0o644,
  };

  const assets = planManagedAssets(vaultDir, pluginRoot, managedAssets);
  const transforms = planContentTransforms(vaultDir, contentTransforms);
  const mutations = sortMutations([
    ...assets.mutations,
    ...transforms.mutations,
    configMutation,
  ]);
  try {
    validatePlannedMutations(mutations);
  } catch (error) {
    if (error instanceof MutationFailure) {
      translateMutationFailure(error);
    }
    throw error;
  }

  const plannedPaths = mutations
    .flatMap(mutation => (
      mutation.kind === 'rename'
        ? [
            mutation.vaultRelativePath,
            mutation.destinationVaultRelativePath,
          ]
        : [mutation.vaultRelativePath]
    ))
    .sort();
  const cachedSourceBytes = new Map(transforms.sourceBytes);
  cachedSourceBytes.set(CONFIG_PATH, configBytes);
  const diffs = mutations
    .filter((mutation): mutation is Extract<
      PlannedMutation,
      { kind: 'write-file' }
    > => mutation.kind === 'write-file')
    .map(mutation => ({
      path: mutation.vaultRelativePath,
      diff: makeDiff(
        mutation.vaultRelativePath,
        sourceBytesForMutation(vaultDir, mutation, cachedSourceBytes),
        mutation.desiredBytes,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const registryRevision = sha256(canonicalStringify(
    registry.map(migration => ({
      id: migration.id,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
    })),
  ));
  const materials = [
    configMaterial,
    ...assets.materials,
    ...transforms.materials,
  ].sort((left, right) => (
    left.path.localeCompare(right.path)
      || left.kind.localeCompare(right.kind)
  ));
  const planDigest = sha256(canonicalStringify({
    registryRevision,
    sourceVersion: currentVersion,
    targetVersion: CURRENT_VAULT_SCHEMA_VERSION,
    migrationIds: selected.map(migration => migration.id),
    plannedPaths,
    materials,
    mutations: mutations.map(mutationDigestRecord),
  }));

  return {
    status: mutations.length === 0 ? 'up_to_date' : 'preview',
    currentVaultSchemaVersion: currentVersion,
    targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
    migrations: descriptions,
    mutations,
    plannedPaths,
    diffs,
    warnings: [],
    planDigest,
  };
}
