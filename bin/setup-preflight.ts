#!/usr/bin/env -S bun run

import * as fs from 'fs';
import * as path from 'path';
import {
  planManagedAsset,
  type ManagedAssetIntent,
} from './update/managed-assets.ts';
import { UpdateError, type UpdateErrorCode } from './update/contracts.ts';

export interface SetupPreflightOptions {
  vaultDir: string;
  pluginRoot: string;
  layerDirectories: readonly [string, string, string];
}

export interface SetupPreflightResult {
  version: 1;
  status: 'ready';
  plannedPaths: string[];
}

const MANAGED_FILES = new Set([
  '.me/config.yaml',
  'SCHEMA.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
]);
const RESERVED_ROOTS = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.git',
  '.github',
  '.gitlab',
  '.me',
  '.me-runtime',
  '.obsidian',
  '.vscode',
]);

function fail(code: 'INVALID_REQUEST' | 'MIGRATION_CONFLICT' | 'UNSAFE_PATH'): never {
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
  try {
    const entry = fs.lstatSync(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('UNSAFE_PATH');
    return fs.realpathSync.native(candidate);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
  }
}

function overlaps(first: string, second: string): boolean {
  return first === second
    || first.startsWith(`${second}/`)
    || second.startsWith(`${first}/`);
}

function effectivePermissionBits(entry: fs.Stats): number {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  const gid = typeof process.getegid === 'function' ? process.getegid() : -1;
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  if (uid >= 0 && entry.uid === uid) return (entry.mode >> 6) & 0o7;
  if (gid >= 0 && (entry.gid === gid || groups.includes(entry.gid))) {
    return (entry.mode >> 3) & 0o7;
  }
  return entry.mode & 0o7;
}

/**
 * A read-only, fail-closed write-feasibility check. accessSync alone is not
 * sufficient because privileged test/process users can bypass 0555 mode bits.
 * ACL denial is still caught by accessSync for ordinary users; an ACL grant
 * never overrides the conservative POSIX ownership/mode decision here.
 */
function assertWritableDirectory(candidate: string): void {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('UNSAFE_PATH');
    if ((effectivePermissionBits(entry) & 0o3) !== 0o3) fail('UNSAFE_PATH');
    fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    fail('UNSAFE_PATH');
  }
}

function assertMutationParentWritable(
  root: string,
  relativePath: string,
): void {
  const components = relativePath.split('/');
  let current = root;
  let nearestExisting = root;
  for (let index = 0; index < components.length - 1; index += 1) {
    current = path.join(current, components[index]);
    try {
      const entry = fs.lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('UNSAFE_PATH');
      nearestExisting = current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      if (error instanceof UpdateError) throw error;
      fail('UNSAFE_PATH');
    }
  }
  assertWritableDirectory(nearestExisting);
}

function inspectPath(
  root: string,
  relativePath: string,
  finalType: 'file' | 'directory' | 'either',
): 'missing' | 'file' | 'directory' {
  if (!safeRelativePath(relativePath)) fail('UNSAFE_PATH');
  const components = relativePath.split('/');
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      return fail('UNSAFE_PATH');
    }
    if (entry.isSymbolicLink()) fail('UNSAFE_PATH');
    const final = index === components.length - 1;
    if (!final && !entry.isDirectory()) fail('UNSAFE_PATH');
    if (final) {
      if (entry.isFile()) {
        if (finalType === 'directory') fail('UNSAFE_PATH');
        return 'file';
      }
      if (entry.isDirectory()) {
        if (finalType === 'file') fail('UNSAFE_PATH');
        return 'directory';
      }
      fail('UNSAFE_PATH');
    }
  }
  return fail('UNSAFE_PATH');
}

function assertMissing(root: string, relativePath: string): void {
  if (inspectPath(root, relativePath, 'either') !== 'missing') {
    fail('MIGRATION_CONFLICT');
  }
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

function readRegularFile(
  root: string,
  relativePath: string,
): Buffer {
  if (inspectPath(root, relativePath, 'file') !== 'file') fail('UNSAFE_PATH');
  const absolute = path.join(root, ...relativePath.split('/'));
  let descriptor: number | undefined;
  try {
    const named = fs.lstatSync(absolute, { bigint: true });
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !named.isFile()
      || named.isSymbolicLink()
      || !before.isFile()
      || named.dev !== before.dev
      || named.ino !== before.ino
      || named.mode !== before.mode
      || named.size !== before.size
      || named.nlink !== before.nlink
    ) fail('UNSAFE_PATH');
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mode !== before.mode
      || after.size !== before.size
      || after.nlink !== before.nlink
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) fail('UNSAFE_PATH');
    return bytes;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    return fail('UNSAFE_PATH');
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

function countEffectiveObsidianEntries(
  bytes: Buffer,
  invalidUtf8Code: 'MIGRATION_CONFLICT' | 'UNSAFE_PATH',
): number {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(Uint8Array.from(bytes));
  } catch {
    return fail(invalidUtf8Code);
  }
  return text.split('\n').filter(line => {
    const normalized = line.replace(/\r$/, '').trim();
    return normalized !== ''
      && !normalized.startsWith('#')
      && normalized === '.obsidian/';
  }).length;
}

/**
 * Read-only validation for every path a fresh setup may mutate.
 */
export function preflightFreshSetup(
  options: SetupPreflightOptions,
): SetupPreflightResult {
  if (
    !options
    || typeof options !== 'object'
    || !Array.isArray(options.layerDirectories)
    || options.layerDirectories.length !== 3
  ) fail('INVALID_REQUEST');

  const vault = canonicalDirectory(options.vaultDir);
  const plugin = canonicalDirectory(options.pluginRoot);
  try {
    if (fs.readdirSync(vault).some(name => name.startsWith('.me-setup-'))) {
      fail('MIGRATION_CONFLICT');
    }
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    fail('UNSAFE_PATH');
  }
  const layerDirectories = [...options.layerDirectories];
  if (
    layerDirectories.some(layer => !safeRelativePath(layer))
    || new Set(layerDirectories).size !== layerDirectories.length
    || layerDirectories.some((layer, index) => (
      layerDirectories.some((other, otherIndex) => (
        index !== otherIndex && overlaps(layer, other)
      ))
    ))
    || layerDirectories.some(layer => (
      layer.split('/').some(component => RESERVED_ROOTS.has(component))
      || MANAGED_FILES.has(layer)
      || [...MANAGED_FILES].some(file => file.startsWith(`${layer}/`))
      || [...MANAGED_FILES].some(file => layer.startsWith(`${file}/`))
    ))
  ) fail('INVALID_REQUEST');

  inspectPath(vault, '.me', 'directory');
  assertMissing(vault, '.me/config.yaml');
  assertWritableDirectory(vault);
  assertMutationParentWritable(vault, '.me/config.yaml');

  const plannedPaths = new Set<string>(['.me/config.yaml']);
  for (const layer of layerDirectories) {
    const layerState = inspectPath(vault, layer, 'directory');
    const keepState = inspectPath(vault, `${layer}/.gitkeep`, 'file');
    if (layerState === 'missing') assertMutationParentWritable(vault, layer);
    if (keepState === 'missing') {
      assertMutationParentWritable(vault, `${layer}/.gitkeep`);
    }
    plannedPaths.add(layer);
    plannedPaths.add(`${layer}/.gitkeep`);
  }

  for (const asset of ['SCHEMA.md', 'CLAUDE.md', 'AGENTS.md'] as const) {
    const mutation = planManagedAsset(vault, plugin, assetIntent(asset));
    if (mutation) {
      assertMutationParentWritable(vault, asset);
      plannedPaths.add(asset);
    }
  }

  const snippetEntries = countEffectiveObsidianEntries(
    readRegularFile(plugin, 'references/gitignore-snippet.txt'),
    'UNSAFE_PATH',
  );
  if (snippetEntries !== 1) fail('UNSAFE_PATH');

  const gitignore = inspectPath(vault, '.gitignore', 'file');
  if (gitignore === 'missing') {
    assertMutationParentWritable(vault, '.gitignore');
    plannedPaths.add('.gitignore');
  } else {
    const effectiveEntries = countEffectiveObsidianEntries(
      readRegularFile(vault, '.gitignore'),
      'MIGRATION_CONFLICT',
    );
    if (effectiveEntries > 1) fail('MIGRATION_CONFLICT');
    if (effectiveEntries === 0) {
      assertMutationParentWritable(vault, '.gitignore');
      plannedPaths.add('.gitignore');
    }
  }

  return {
    version: 1,
    status: 'ready',
    plannedPaths: [...plannedPaths].sort(),
  };
}

function parseArguments(argv: readonly string[]): SetupPreflightOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith('--')
      || !value
      || value.startsWith('--')
      || values.has(key)
    ) fail('INVALID_REQUEST');
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
  ) fail('INVALID_REQUEST');
  return {
    vaultDir: values.get('--vault-dir') as string,
    pluginRoot: path.resolve(__dirname, '..'),
    layerDirectories: [
      values.get('--raw-dir') as string,
      values.get('--practices-dir') as string,
      values.get('--cognition-dir') as string,
    ],
  };
}

function publicFailure(error: unknown): {
  version: 1;
  status: 'blocked';
  error: { code: UpdateErrorCode; message: string };
} {
  const update = error instanceof UpdateError
    ? error
    : new UpdateError('INTERNAL_ERROR');
  return {
    version: 1,
    status: 'blocked',
    error: { code: update.code, message: update.message },
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(
      preflightFreshSetup(parseArguments(process.argv.slice(2))),
    )}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicFailure(error))}\n`);
    process.exitCode = 2;
  }
}
