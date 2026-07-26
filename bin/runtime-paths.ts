import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type RuntimePathErrorCode = 'UNSAFE_PATH' | 'UNSUPPORTED_FILESYSTEM';

export class RuntimePathError extends Error {
  constructor(public readonly code: RuntimePathErrorCode) {
    super(code);
    this.name = 'RuntimePathError';
  }
}

export interface RuntimeLayout {
  lexicalVault: string;
  canonicalVault: string;
  runtimeBase: string;
  runtimeRoot: string;
  lockDir: string;
  transactionDir: string;
  inboxDir: string;
  ingestDir: string;
  ingestLockDir: string;
  ingestStagingDir: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function fail(code: RuntimePathErrorCode): never {
  throw new RuntimePathError(code);
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail('UNSAFE_PATH');
  }
}

function nearestExistingDirectory(candidate: string): string {
  let current = path.resolve(candidate);
  while (true) {
    const stat = lstatIfPresent(current);
    if (stat) {
      if (!stat.isDirectory()) fail('UNSAFE_PATH');
      try {
        return fs.realpathSync(current);
      } catch {
        fail('UNSAFE_PATH');
      }
    }
    const parent = path.dirname(current);
    if (parent === current) fail('UNSAFE_PATH');
    current = parent;
  }
}

function assertRealDirectoryIfPresent(candidate: string): void {
  const stat = lstatIfPresent(candidate);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH');
  try {
    fs.realpathSync(candidate);
  } catch {
    fail('UNSAFE_PATH');
  }
}

function assertSameDevice(vault: string, candidate: string): void {
  try {
    const vaultDevice = fs.statSync(vault, { bigint: true }).dev;
    const candidateDevice = fs.statSync(nearestExistingDirectory(candidate), { bigint: true }).dev;
    if (vaultDevice !== candidateDevice) fail('UNSUPPORTED_FILESYSTEM');
  } catch (error) {
    if (error instanceof RuntimePathError) throw error;
    fail('UNSAFE_PATH');
  }
}

function assertExistingRuntimePrefixes(layout: RuntimeLayout, candidate: string): void {
  const absolute = path.resolve(candidate);
  if (!isInside(layout.runtimeRoot, absolute)) fail('UNSAFE_PATH');

  assertRealDirectoryIfPresent(layout.runtimeBase);
  assertRealDirectoryIfPresent(layout.runtimeRoot);
  const relative = path.relative(layout.runtimeRoot, absolute);
  let current = layout.runtimeRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
  }
}

export function resolveRuntimeLayout(
  vaultDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeLayout {
  const lexicalVault = path.resolve(vaultDir);
  let canonicalVault: string;
  try {
    canonicalVault = fs.realpathSync(lexicalVault);
    if (!fs.statSync(canonicalVault).isDirectory()) fail('UNSAFE_PATH');
  } catch (error) {
    if (error instanceof RuntimePathError) throw error;
    fail('UNSAFE_PATH');
  }

  const override = environment.ME_RUNTIME_ROOT;
  if (override !== undefined && (
    !override
    || !path.isAbsolute(override)
    || CONTROL_CHARACTERS.test(override)
  )) {
    fail('UNSAFE_PATH');
  }

  const runtimeBase = override
    ? path.resolve(override)
    : path.join(path.dirname(canonicalVault), '.me-runtime');
  if (isInside(lexicalVault, runtimeBase) || isInside(canonicalVault, runtimeBase)) {
    fail('UNSAFE_PATH');
  }
  assertRealDirectoryIfPresent(runtimeBase);
  assertSameDevice(canonicalVault, runtimeBase);

  const vaultKey = createHash('sha256').update(canonicalVault, 'utf8').digest('hex').slice(0, 24);
  const runtimeRoot = path.join(runtimeBase, `vault-${vaultKey}`);
  const layout: RuntimeLayout = {
    lexicalVault,
    canonicalVault,
    runtimeBase,
    runtimeRoot,
    lockDir: path.join(runtimeRoot, 'locks'),
    transactionDir: path.join(runtimeRoot, 'transactions'),
    inboxDir: path.join(runtimeRoot, 'inbox'),
    ingestDir: path.join(runtimeRoot, 'ingest'),
    ingestLockDir: path.join(runtimeRoot, 'ingest', 'locks'),
    ingestStagingDir: path.join(runtimeRoot, 'ingest', 'staging'),
  };
  assertExistingRuntimePrefixes(layout, runtimeRoot);
  assertSameDevice(canonicalVault, runtimeRoot);
  return layout;
}

export function assertSafeRuntimePath(layout: RuntimeLayout, candidate: string): void {
  assertExistingRuntimePrefixes(layout, candidate);
}

function createPrivateDirectory(candidate: string): void {
  const stat = lstatIfPresent(candidate);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH');
    return;
  }
  try {
    fs.mkdirSync(candidate, { mode: 0o700 });
    fs.chmodSync(candidate, 0o700);
  } catch {
    fail('UNSAFE_PATH');
  }
  const created = lstatIfPresent(candidate);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) fail('UNSAFE_PATH');
}

function createDirectoryChain(target: string): void {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!lstatIfPresent(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) fail('UNSAFE_PATH');
    current = parent;
  }
  const anchor = lstatIfPresent(current);
  if (!anchor || !anchor.isDirectory()) fail('UNSAFE_PATH');
  for (const directory of missing.reverse()) createPrivateDirectory(directory);
}

export function bootstrapRuntimeDirectories(
  layout: RuntimeLayout,
  directories: string[],
): void {
  for (const directory of directories) assertSafeRuntimePath(layout, directory);
  createDirectoryChain(layout.runtimeBase);
  createDirectoryChain(layout.runtimeRoot);
  for (const directory of directories) {
    createDirectoryChain(directory);
    assertSafeRuntimePath(layout, directory);
  }
  assertSameDevice(layout.canonicalVault, layout.runtimeRoot);
}

export function runtimeDisplayPath(layout: RuntimeLayout, candidate: string): string {
  assertSafeRuntimePath(layout, candidate);
  return runtimeLexicalDisplayPath(layout, candidate);
}

export function runtimeLexicalDisplayPath(
  layout: RuntimeLayout,
  candidate: string,
): string {
  const absolute = path.resolve(candidate);
  if (!isInside(layout.runtimeRoot, absolute)) fail('UNSAFE_PATH');
  const relative = path.relative(layout.runtimeRoot, absolute);
  return relative ? `<ME_RUNTIME>/${relative.split(path.sep).join('/')}` : '<ME_RUNTIME>';
}
