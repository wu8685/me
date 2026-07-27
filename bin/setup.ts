#!/usr/bin/env -S bun run

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireVaultLock,
  CooperativeLockError,
  releaseVaultLock,
  type OwnedCooperativeLock,
} from './cooperative-lock.ts';
import {
  MutationFailure,
  fingerprintMutationSource,
  type MutationPathPolicy,
  type OwnedDirectoryFingerprint,
  type OwnedFileFingerprint,
  type PlannedMutation,
  type SourceFingerprint,
} from './mutation/contracts.ts';
import { createMutationExecutor } from './mutation/executor.ts';
import {
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
  RuntimePathError,
  type RuntimeLayout,
} from './runtime-paths.ts';
import { preflightFreshSetup } from './setup-preflight.ts';
import { UpdateError, type UpdateErrorCode } from './update/contracts.ts';
import {
  planManagedAsset,
  type ManagedAssetIntent,
} from './update/managed-assets.ts';

type SetupResult =
  | {
      version: 1;
      status: 'initialized';
      changedPaths: string[];
      layerDirectories: string[];
    }
  | {
      version: 1;
      status: 'already_initialized';
      message: string;
    }
  | {
      version: 1;
      status: 'ready';
      plannedPaths: string[];
    }
  | {
      version: 1;
      status: 'blocked';
      error: { code: UpdateErrorCode; message: string };
      recoveryState: 'none' | 'manual';
    };

export interface SetupOptions {
  vaultDir: string;
  pluginRoot: string;
  layerDirectories: readonly [string, string, string];
  environment?: NodeJS.ProcessEnv;
  preview?: boolean;
  hooks?: {
    beforePublish?(vaultRelativePath: string): void;
  };
}

interface AppliedWrite {
  mutation: Extract<PlannedMutation, { kind: 'write-file' }>;
  destination: string;
  original?: OwnedFileFingerprint;
  published?: OwnedFileFingerprint;
}

interface AppliedDirectory {
  mutation: Extract<PlannedMutation, { kind: 'mkdir' }>;
  published: OwnedDirectoryFingerprint;
}

const EXISTING_MESSAGE =
  'me vault already initialized.\n'
  + 'Run $me:update (Codex) or /me:update (Claude Code) to preview any required\n'
  + 'vault migrations. No files changed.';

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeRelativePath(value: string): boolean {
  return !!value
    && !value.startsWith('/')
    && !value.startsWith('//')
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split('/').some(component => (
      !component || component === '.' || component === '..'
    ));
}

function inspectComponents(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isInside(root, absolute)) throw new MutationFailure('UNSAFE_PATH');
  let current = root;
  for (const component of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const entry = fs.lstatSync(current);
      if (entry.isSymbolicLink()) throw new MutationFailure('UNSAFE_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof MutationFailure) throw error;
      throw new MutationFailure('UNSAFE_PATH');
    }
  }
}

function setupPathPolicy(layout: RuntimeLayout): MutationPathPolicy {
  return {
    assertSafe(candidate) {
      const absolute = path.resolve(candidate);
      if (isInside(layout.canonicalVault, absolute)) {
        inspectComponents(layout.canonicalVault, absolute);
        return;
      }
      if (isInside(layout.runtimeRoot, absolute)) {
        inspectComponents(layout.runtimeRoot, absolute);
        return;
      }
      throw new MutationFailure('UNSAFE_PATH');
    },
    display(candidate) {
      const absolute = path.resolve(candidate);
      if (isInside(layout.canonicalVault, absolute)) {
        return path.relative(layout.canonicalVault, absolute)
          .split(path.sep).join('/') || '.';
      }
      return '<ME_RUNTIME>';
    },
  };
}

function assetIntent(
  vaultRelativePath: 'SCHEMA.md' | 'CLAUDE.md' | 'AGENTS.md',
): ManagedAssetIntent {
  if (vaultRelativePath === 'SCHEMA.md') {
    return {
      vaultRelativePath,
      desiredTemplatePath: 'templates/SCHEMA.md',
      strategy: 'replace-known-template',
      knownTemplatePaths: ['templates/SCHEMA.md'],
      onAbsent: 'create',
      onUnmarked: 'conflict',
    };
  }
  return {
    vaultRelativePath,
    desiredTemplatePath: `templates/${vaultRelativePath.replace('.md', '-template.md')}`,
    strategy: 'merge-owned-sections',
    onAbsent: 'create',
    onUnmarked: 'append-marked-block',
  };
}

function source(
  vault: string,
  relative: string,
  policy: MutationPathPolicy,
): SourceFingerprint {
  return fingerprintMutationSource({
    vaultRoot: vault,
    vaultRelativePath: relative,
    pathPolicy: policy,
  });
}

function writeMutation(
  vault: string,
  relative: string,
  bytes: Buffer,
  mode: number,
  publishOrder: number,
  policy: MutationPathPolicy,
): PlannedMutation {
  return {
    kind: 'write-file',
    vaultRelativePath: relative,
    source: source(vault, relative, policy),
    desiredBytes: bytes,
    desiredSha256: sha256(bytes),
    desiredMode: mode,
    publishOrder,
  };
}

function readRegular(candidate: string): Buffer {
  let descriptor: number | undefined;
  try {
    const named = fs.lstatSync(candidate, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()) {
      throw new MutationFailure('UNSAFE_PATH');
    }
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== named.dev
      || opened.ino !== named.ino
      || opened.mode !== named.mode
      || opened.size !== named.size
      || opened.nlink !== named.nlink
    ) throw new MutationFailure('UNSAFE_PATH');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const namedAfter = fs.lstatSync(candidate, { bigint: true });
    if (
      !after.isFile()
      || !namedAfter.isFile()
      || namedAfter.isSymbolicLink()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.mode !== opened.mode
      || after.size !== opened.size
      || after.nlink !== opened.nlink
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || namedAfter.dev !== after.dev
      || namedAfter.ino !== after.ino
      || namedAfter.mode !== after.mode
      || namedAfter.size !== after.size
      || namedAfter.nlink !== after.nlink
    ) throw new MutationFailure('UNSAFE_PATH');
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function configBytes(layers: readonly string[]): Buffer {
  return Buffer.from([
    '# me plugin configuration',
    'vault_schema_version: 1',
    '',
    'layers:',
    `  raw: ${JSON.stringify(layers[0])}`,
    `  practices: ${JSON.stringify(layers[1])}`,
    `  cognition: ${JSON.stringify(layers[2])}`,
    '',
  ].join('\n'));
}

function planSetup(
  options: SetupOptions,
  layout: RuntimeLayout,
): PlannedMutation[] {
  const vault = layout.canonicalVault;
  const policy = setupPathPolicy(layout);
  const mutations: PlannedMutation[] = [];
  const directories = new Set<string>();
  const addDirectoryChain = (relative: string): void => {
    const components = relative.split('/');
    for (let index = 1; index <= components.length; index += 1) {
      const current = components.slice(0, index).join('/');
      if (directories.has(current)) continue;
      directories.add(current);
      const fingerprint = source(vault, current, policy);
      if (fingerprint.type === 'missing') {
        mutations.push({
          kind: 'mkdir',
          vaultRelativePath: current,
          source: fingerprint,
          desiredMode: 0o755,
          publishOrder: mutations.length,
        });
      } else if (fingerprint.type !== 'directory') {
        throw new UpdateError('UNSAFE_PATH');
      }
    }
  };

  for (const layer of options.layerDirectories) addDirectoryChain(layer);
  addDirectoryChain('.me');

  for (const layer of options.layerDirectories) {
    const relative = `${layer}/.gitkeep`;
    const current = source(vault, relative, policy);
    if (current.type === 'missing') {
      mutations.push(writeMutation(
        vault,
        relative,
        Buffer.alloc(0),
        0o644,
        mutations.length,
        policy,
      ));
    } else if (current.type !== 'file') {
      throw new UpdateError('UNSAFE_PATH');
    }
  }

  for (const asset of ['SCHEMA.md', 'CLAUDE.md', 'AGENTS.md'] as const) {
    const mutation = planManagedAsset(vault, options.pluginRoot, assetIntent(asset));
    if (mutation) {
      mutation.publishOrder = mutations.length;
      mutations.push(mutation);
    }
  }

  const snippet = readRegular(path.join(
    options.pluginRoot,
    'references/gitignore-snippet.txt',
  ));
  const gitignoreSource = source(vault, '.gitignore', policy);
  if (gitignoreSource.type === 'missing') {
    mutations.push(writeMutation(
      vault,
      '.gitignore',
      snippet,
      0o644,
      mutations.length,
      policy,
    ));
  } else if (gitignoreSource.type === 'file') {
    const current = readRegular(path.join(vault, '.gitignore'));
    if (sha256(current) !== gitignoreSource.sha256) {
      throw new MutationFailure('SOURCE_CHANGED');
    }
    const effective = current.toString('utf8').split(/\r?\n/).filter(line => (
      line.trim() && !line.trim().startsWith('#') && line.trim() === '.obsidian/'
    )).length;
    if (effective === 0) {
      const separator = current.length > 0 && current.at(-1) !== 0x0a
        ? Buffer.from('\n')
        : Buffer.alloc(0);
      mutations.push(writeMutation(
        vault,
        '.gitignore',
        Buffer.concat([
          Uint8Array.from(current),
          Uint8Array.from(separator),
          Uint8Array.from(snippet),
        ]),
        gitignoreSource.mode ?? 0o644,
        mutations.length,
        policy,
      ));
    }
  } else {
    throw new UpdateError('UNSAFE_PATH');
  }

  mutations.push(writeMutation(
    vault,
    '.me/config.yaml',
    configBytes(options.layerDirectories),
    0o644,
    mutations.length,
    policy,
  ));
  return mutations;
}

function sameSource(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.vaultRelativePath === right.vaultRelativePath
    && left.type === right.type
    && left.sha256 === right.sha256
    && left.mode === right.mode;
}

function errorCode(error: unknown): UpdateErrorCode {
  if (error instanceof UpdateError) return error.code;
  if (error instanceof RuntimePathError) return error.code;
  if (error instanceof CooperativeLockError) {
    return error.code === 'LOCK_HELD' ? 'UPDATE_IN_PROGRESS' : 'RECOVERY_REQUIRED';
  }
  if (error instanceof MutationFailure) {
    if (error.code === 'SOURCE_CHANGED' || error.code === 'TARGET_EXISTS') {
      return 'STALE_PREVIEW';
    }
    if (error.code === 'UNSAFE_PATH') return 'UNSAFE_PATH';
    if (error.code === 'UNSUPPORTED_FILESYSTEM') return 'UNSUPPORTED_FILESYSTEM';
    return 'RECOVERY_REQUIRED';
  }
  return 'INTERNAL_ERROR';
}

function existingConfig(vaultDir: string): boolean {
  try {
    fs.lstatSync(path.join(path.resolve(vaultDir), '.me/config.yaml'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new UpdateError('UNSAFE_PATH');
  }
}

export function executeFreshSetup(options: SetupOptions): SetupResult {
  if (
    !options
    || !Array.isArray(options.layerDirectories)
    || options.layerDirectories.length !== 3
    || options.layerDirectories.some(layer => !safeRelativePath(layer))
  ) {
    return {
      version: 1,
      status: 'blocked',
      error: { code: 'INVALID_REQUEST', message: 'INVALID_REQUEST' },
      recoveryState: 'none',
    };
  }
  try {
    if (existingConfig(options.vaultDir)) {
      return { version: 1, status: 'already_initialized', message: EXISTING_MESSAGE };
    }
    const preflight = preflightFreshSetup(options);
    if (options.preview) return preflight;
  } catch (error) {
    const code = errorCode(error);
    return {
      version: 1,
      status: 'blocked',
      error: { code, message: code },
      recoveryState: 'none',
    };
  }

  let layout: RuntimeLayout | undefined;
  let lock: OwnedCooperativeLock | undefined;
  let staging: string | undefined;
  let stagingOwned: OwnedDirectoryFingerprint | undefined;
  let executor: ReturnType<typeof createMutationExecutor> | undefined;
  let rollbackComplete = true;
  const writes: AppliedWrite[] = [];
  const directories: AppliedDirectory[] = [];
  const transientFiles: OwnedFileFingerprint[] = [];
  const cleanupStaging = (): void => {
    if (!executor || !stagingOwned) return;
    for (const owned of [...transientFiles].reverse()) {
      executor.unlink(owned);
    }
    executor.rmdir(stagingOwned);
    staging = undefined;
    stagingOwned = undefined;
    transientFiles.length = 0;
  };
  try {
    layout = resolveRuntimeLayout(options.vaultDir, options.environment);
    bootstrapRuntimeDirectories(layout, [layout.lockDir, layout.retirementDir]);
    lock = acquireVaultLock(layout, {
      operationId: crypto.randomUUID(),
      owner: 'me-update',
    });

    if (existingConfig(layout.canonicalVault)) {
      return { version: 1, status: 'already_initialized', message: EXISTING_MESSAGE };
    }
    preflightFreshSetup({ ...options, vaultDir: layout.canonicalVault });
    const policy = setupPathPolicy(layout);
    const mutations = planSetup(options, layout);
    if (
      mutations.at(-1)?.kind !== 'write-file'
      || mutations.at(-1)?.vaultRelativePath !== '.me/config.yaml'
    ) throw new UpdateError('VALIDATION_FAILED');

    staging = fs.mkdtempSync(path.join(layout.canonicalVault, '.me-setup-'));
    fs.chmodSync(staging, 0o700);
    executor = createMutationExecutor({
      pathPolicy: policy,
      journal: { beforeMutation() {}, afterMutation() {} },
      retirementDirectory: layout.retirementDir,
    });
    stagingOwned = executor.captureDirectory(staging);
    const staged = new Map<number, OwnedFileFingerprint>();
    for (const mutation of mutations) {
      if (mutation.kind !== 'write-file') continue;
      const candidate = path.join(
        staging,
        `${String(mutation.publishOrder).padStart(6, '0')}.stage`,
      );
      const descriptor = fs.openSync(
        candidate,
        fs.constants.O_WRONLY | fs.constants.O_CREAT
          | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, Uint8Array.from(mutation.desiredBytes));
        fs.fchmodSync(descriptor, mutation.desiredMode);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const owned = executor.captureFile(candidate);
      staged.set(mutation.publishOrder, owned);
      transientFiles.push(owned);
    }

    for (const mutation of mutations) {
      options.hooks?.beforePublish?.(mutation.vaultRelativePath);
      const current = source(
        layout.canonicalVault,
        mutation.vaultRelativePath,
        policy,
      );
      if (!sameSource(current, mutation.source)) {
        throw new MutationFailure('SOURCE_CHANGED');
      }
      const destination = path.join(
        layout.canonicalVault,
        ...mutation.vaultRelativePath.split('/'),
      );
      if (mutation.kind === 'mkdir') {
        const published = executor.mkdir(destination, mutation.desiredMode);
        directories.push({ mutation, published });
        continue;
      }
      if (mutation.kind !== 'write-file') {
        throw new UpdateError('INVALID_REQUEST');
      }
      const applied: AppliedWrite = { mutation, destination };
      writes.push(applied);
      if (mutation.source.type === 'file') {
        const originalPath = path.join(
          staging,
          `${String(mutation.publishOrder).padStart(6, '0')}.original`,
        );
        applied.original = executor.rename(
          executor.captureFile(destination),
          originalPath,
        );
        transientFiles.push(applied.original);
      } else if (mutation.source.type !== 'missing') {
        throw new MutationFailure('SOURCE_CHANGED');
      }
      const stagedFile = staged.get(mutation.publishOrder);
      if (!stagedFile) throw new MutationFailure('SOURCE_CHANGED');
      applied.published = executor.link(stagedFile, destination);
    }

    for (const mutation of mutations) {
      const current = source(
        layout.canonicalVault,
        mutation.vaultRelativePath,
        policy,
      );
      if (mutation.kind === 'mkdir') {
        if (current.type !== 'directory') throw new UpdateError('VALIDATION_FAILED');
      } else if (mutation.kind !== 'write-file') {
        throw new UpdateError('VALIDATION_FAILED');
      } else if (
        current.type !== 'file'
        || current.sha256 !== mutation.desiredSha256
        || current.mode !== mutation.desiredMode
      ) {
        throw new UpdateError('VALIDATION_FAILED');
      }
    }

    cleanupStaging();
    return {
      version: 1,
      status: 'initialized',
      changedPaths: mutations.map(mutation => mutation.vaultRelativePath),
      layerDirectories: [...options.layerDirectories],
    };
  } catch (error) {
    try {
      if (layout) {
        const policy = setupPathPolicy(layout);
        executor ??= createMutationExecutor({
          pathPolicy: policy,
          journal: { beforeMutation() {}, afterMutation() {} },
          retirementDirectory: layout.retirementDir,
        });
        for (const applied of [...writes].reverse()) {
          if (applied.published) {
            const discard = path.join(
              staging!,
              `${String(applied.mutation.publishOrder).padStart(6, '0')}.discard`,
            );
            const discarded = executor.rename(applied.published, discard);
            transientFiles.push(discarded);
          }
          if (applied.original) {
            executor.link(applied.original, applied.destination);
          }
        }
        for (const applied of [...directories].reverse()) {
          executor.rmdir(applied.published);
        }
      }
    } catch {
      rollbackComplete = false;
    }
    if (rollbackComplete && staging) {
      try {
        cleanupStaging();
      } catch {
        rollbackComplete = false;
      }
    }
    const code = rollbackComplete ? errorCode(error) : 'RECOVERY_REQUIRED';
    return {
      version: 1,
      status: 'blocked',
      error: { code, message: code },
      recoveryState: rollbackComplete ? 'none' : 'manual',
    };
  } finally {
    if (lock && layout) releaseVaultLock(layout, lock);
  }
}

function parseArguments(argv: readonly string[]): SetupOptions {
  const command = argv[0];
  if (command !== 'preview' && command !== 'apply') {
    throw new UpdateError('INVALID_REQUEST');
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) {
      throw new UpdateError('INVALID_REQUEST');
    }
    values.set(key, value);
  }
  const allowed = new Set([
    '--vault-dir',
    '--raw-dir',
    '--practices-dir',
    '--cognition-dir',
  ]);
  if (
    values.size !== allowed.size
    || [...values.keys()].some(key => !allowed.has(key))
  ) throw new UpdateError('INVALID_REQUEST');
  return {
    vaultDir: values.get('--vault-dir')!,
    pluginRoot: path.resolve(__dirname, '..'),
    layerDirectories: [
      values.get('--raw-dir')!,
      values.get('--practices-dir')!,
      values.get('--cognition-dir')!,
    ],
    preview: command === 'preview',
  };
}

if (require.main === module) {
  let result: SetupResult;
  try {
    result = executeFreshSetup(parseArguments(process.argv.slice(2)));
  } catch (error) {
    const code = errorCode(error);
    result = {
      version: 1,
      status: 'blocked',
      error: { code, message: code },
      recoveryState: 'none',
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'blocked') process.exitCode = 2;
}
