import * as fs from 'fs';
import * as path from 'path';
import {
  RuntimePathError,
  assertSafeRuntimePath,
  bootstrapRuntimeDirectories,
  type RuntimeLayout,
} from './runtime-paths.ts';

export type CooperativeLockOwner = 'vault-write' | 'ingest' | 'me-update';

export interface CooperativeLockRequest {
  operationId: string;
  owner: CooperativeLockOwner;
}

export interface OwnedCooperativeLock {
  path: string;
  descriptor: number;
  operationId: string;
  owner: CooperativeLockOwner;
}

export interface CooperativeLockHooks {
  beforeMutation?(kind: 'create' | 'unlink', path: string): void;
}

export type CooperativeLockErrorCode = 'LOCK_HELD' | 'UNSAFE_PATH' | 'RECOVERY_REQUIRED';

export class CooperativeLockError extends Error {
  constructor(public readonly code: CooperativeLockErrorCode) {
    super(code);
    this.name = 'CooperativeLockError';
  }
}

interface CooperativeLockOperations {
  openSync(file: string, flags: string, mode: number): number;
  writeFileSync(descriptor: number, bytes: Buffer): void;
  fsyncSync(descriptor: number): void;
  fchmodSync(descriptor: number, mode: number): void;
  fstatSync(descriptor: number): fs.BigIntStats;
  lstatSync(file: string): fs.BigIntStats;
  statSync(file: string): fs.BigIntStats;
  readFileSync(file: string): Buffer;
  closeSync(descriptor: number): void;
  mkdtempSync(prefix: string): string;
  renameSync(source: string, destination: string): void;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(file: string): void;
  rmdirSync(directory: string): void;
}

interface InternalCooperativeLockHooks extends CooperativeLockHooks {
  /**
   * Test-only fault injection used by the existing vault-write transaction
   * suite. Production callers use the native operations below.
   */
  __operations?: Partial<CooperativeLockOperations>;
}

interface CooperativeLockState {
  bytes: Buffer;
  descriptorDevice: bigint;
  descriptorInode: bigint;
  pathDevice: bigint;
  pathInode: bigint;
  operations: CooperativeLockOperations;
}

const lockStates = new WeakMap<OwnedCooperativeLock, CooperativeLockState>();

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function operationsFor(hooks?: CooperativeLockHooks): CooperativeLockOperations {
  const injected = (hooks as InternalCooperativeLockHooks | undefined)?.__operations;
  return {
    openSync: injected?.openSync ?? ((file, flags, mode) => fs.openSync(file, flags, mode)),
    writeFileSync: injected?.writeFileSync
      ?? ((descriptor, bytes) => fs.writeFileSync(descriptor, Uint8Array.from(bytes))),
    fsyncSync: injected?.fsyncSync ?? fs.fsyncSync,
    fchmodSync: injected?.fchmodSync ?? fs.fchmodSync,
    fstatSync: injected?.fstatSync
      ?? (descriptor => fs.fstatSync(descriptor, { bigint: true })),
    lstatSync: injected?.lstatSync
      ?? (file => fs.lstatSync(file, { bigint: true })),
    statSync: injected?.statSync
      ?? (file => fs.statSync(file, { bigint: true })),
    readFileSync: injected?.readFileSync ?? (file => fs.readFileSync(file)),
    closeSync: injected?.closeSync ?? fs.closeSync,
    mkdtempSync: injected?.mkdtempSync ?? fs.mkdtempSync,
    renameSync: injected?.renameSync ?? fs.renameSync,
    linkSync: injected?.linkSync ?? fs.linkSync,
    unlinkSync: injected?.unlinkSync ?? fs.unlinkSync,
    rmdirSync: injected?.rmdirSync ?? fs.rmdirSync,
  };
}

function parseOwnership(
  bytes: Buffer,
): { version?: unknown; operationId?: unknown; owner?: unknown } | undefined {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isExpectedOwnership(
  bytes: Buffer,
  expectedBytes: Buffer,
  operationId: string,
  owner: CooperativeLockOwner,
): boolean {
  const parsed = parseOwnership(bytes);
  return bytes.length === expectedBytes.length
    && bytes.every((byte, index) => byte === expectedBytes[index])
    && parsed?.version === 1
    && parsed.operationId === operationId
    && parsed.owner === owner;
}

function nativePathStillOwned(
  lockPath: string,
  descriptor: number,
  bytes: Buffer,
  request: CooperativeLockRequest,
): boolean {
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const entry = fs.lstatSync(lockPath, { bigint: true });
    const target = fs.statSync(lockPath, { bigint: true });
    const actualBytes = fs.readFileSync(lockPath);
    return opened.isFile()
      && entry.isFile()
      && !entry.isSymbolicLink()
      && target.isFile()
      && opened.dev === entry.dev
      && opened.ino === entry.ino
      && opened.dev === target.dev
      && opened.ino === target.ino
      && isExpectedOwnership(actualBytes, bytes, request.operationId, request.owner);
  } catch {
    return false;
  }
}

function validateAcquiredLock(
  lockPath: string,
  descriptor: number,
  bytes: Buffer,
  request: CooperativeLockRequest,
  operations: CooperativeLockOperations,
): CooperativeLockState {
  const opened = operations.fstatSync(descriptor);
  const entry = operations.lstatSync(lockPath);
  const target = operations.statSync(lockPath);
  const actualBytes = operations.readFileSync(lockPath);
  if (
    !opened.isFile()
    || !entry.isFile()
    || entry.isSymbolicLink()
    || !target.isFile()
    || opened.dev !== entry.dev
    || opened.ino !== entry.ino
    || opened.dev !== target.dev
    || opened.ino !== target.ino
    || !isExpectedOwnership(actualBytes, bytes, request.operationId, request.owner)
  ) {
    throw new CooperativeLockError('RECOVERY_REQUIRED');
  }
  return {
    bytes,
    descriptorDevice: opened.dev,
    descriptorInode: opened.ino,
    pathDevice: entry.dev,
    pathInode: entry.ino,
    operations,
  };
}

function assertReleaseOwnership(
  lock: OwnedCooperativeLock,
  state: CooperativeLockState,
  candidate: string = lock.path,
): boolean {
  try {
    const opened = state.operations.fstatSync(lock.descriptor);
    const entry = state.operations.lstatSync(candidate);
    const target = state.operations.statSync(candidate);
    const actualBytes = state.operations.readFileSync(candidate);
    return opened.isFile()
      && entry.isFile()
      && !entry.isSymbolicLink()
      && target.isFile()
      && opened.dev === state.descriptorDevice
      && opened.ino === state.descriptorInode
      && entry.dev === state.pathDevice
      && entry.ino === state.pathInode
      && opened.dev === entry.dev
      && opened.ino === entry.ino
      && opened.dev === target.dev
      && opened.ino === target.ino
      && isExpectedOwnership(
        actualBytes,
        state.bytes,
        lock.operationId,
        lock.owner,
      );
  } catch {
    return false;
  }
}

function assertPathOwnershipAfterClose(
  lock: OwnedCooperativeLock,
  state: CooperativeLockState,
  candidate: string = lock.path,
): boolean {
  try {
    const entry = state.operations.lstatSync(candidate);
    const target = state.operations.statSync(candidate);
    const actualBytes = state.operations.readFileSync(candidate);
    return entry.isFile()
      && !entry.isSymbolicLink()
      && target.isFile()
      && entry.dev === state.pathDevice
      && entry.ino === state.pathInode
      && entry.dev === target.dev
      && entry.ino === target.ino
      && isExpectedOwnership(
        actualBytes,
        state.bytes,
        lock.operationId,
        lock.owner,
      );
  } catch {
    return false;
  }
}

function safeRuntimeMutation(layout: RuntimeLayout, candidate: string): void {
  try {
    assertSafeRuntimePath(layout, candidate);
  } catch {
    throw new CooperativeLockError('UNSAFE_PATH');
  }
}

export function acquireVaultLock(
  layout: RuntimeLayout,
  request: CooperativeLockRequest,
  hooks?: CooperativeLockHooks,
): OwnedCooperativeLock {
  const lockPath = path.join(layout.lockDir, 'vault.lock');
  try {
    bootstrapRuntimeDirectories(layout, [layout.lockDir]);
    assertSafeRuntimePath(layout, lockPath);
  } catch (error) {
    if (error instanceof RuntimePathError) throw new CooperativeLockError('UNSAFE_PATH');
    throw error;
  }

  hooks?.beforeMutation?.('create', lockPath);
  safeRuntimeMutation(layout, lockPath);

  const operations = operationsFor(hooks);
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    operationId: request.operationId,
    owner: request.owner,
    startedAt: new Date().toISOString(),
  })}\n`);
  let descriptor: number;
  try {
    descriptor = operations.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (errno(error) === 'EEXIST') throw new CooperativeLockError('LOCK_HELD');
    throw error;
  }

  try {
    operations.writeFileSync(descriptor, bytes);
    operations.fsyncSync(descriptor);
    operations.fchmodSync(descriptor, 0o600);
    const state = validateAcquiredLock(lockPath, descriptor, bytes, request, operations);
    const lock: OwnedCooperativeLock = {
      path: lockPath,
      descriptor,
      operationId: request.operationId,
      owner: request.owner,
    };
    lockStates.set(lock, state);
    return lock;
  } catch (error) {
    let removed = false;
    if (nativePathStillOwned(lockPath, descriptor, bytes, request)) {
      try {
        hooks?.beforeMutation?.('unlink', lockPath);
        safeRuntimeMutation(layout, lockPath);
        if (nativePathStillOwned(lockPath, descriptor, bytes, request)) {
          operations.unlinkSync(lockPath);
          removed = true;
        }
      } catch {
        removed = false;
      }
    }
    let closed = false;
    try {
      operations.closeSync(descriptor);
      closed = true;
    } catch {
      closed = false;
    }
    if (!removed || !closed) throw new CooperativeLockError('RECOVERY_REQUIRED');
    throw error;
  }
}

export function releaseVaultLock(
  layout: RuntimeLayout,
  lock: OwnedCooperativeLock,
  hooks?: CooperativeLockHooks,
): void {
  const expectedPath = path.join(layout.lockDir, 'vault.lock');
  const state = lockStates.get(lock);
  if (!state) throw new CooperativeLockError('RECOVERY_REQUIRED');

  let quarantineDirectory: string | undefined;
  let quarantinePath: string | undefined;
  let movedToQuarantine = false;
  let quarantineUnlinked = false;
  let descriptorCloseAttempted = false;
  try {
    if (
      path.resolve(lock.path) !== path.resolve(expectedPath)
      || !assertReleaseOwnership(lock, state)
    ) {
      throw new CooperativeLockError('RECOVERY_REQUIRED');
    }

    hooks?.beforeMutation?.('unlink', lock.path);
    safeRuntimeMutation(layout, lock.path);
    quarantineDirectory = state.operations.mkdtempSync(
      path.join(layout.lockDir, '.vault-lock-release-'),
    );
    quarantinePath = path.join(quarantineDirectory, 'vault.lock');
    safeRuntimeMutation(layout, quarantineDirectory);
    safeRuntimeMutation(layout, quarantinePath);

    /*
     * Move the pathname out of the cooperative namespace atomically before
     * inspecting it again. A replacement raced into vault.lock is moved, not
     * deleted, and is retained in the private quarantine on mismatch.
     */
    state.operations.renameSync(lock.path, quarantinePath);
    movedToQuarantine = true;
    if (!assertReleaseOwnership(lock, state, quarantinePath)) {
      throw new CooperativeLockError('RECOVERY_REQUIRED');
    }

    /*
     * The descriptor remains open through the pathname mutation. It can be
     * closed after the rename while the quarantined inode is still available
     * as recovery material if close or final verification fails.
     */
    descriptorCloseAttempted = true;
    state.operations.closeSync(lock.descriptor);
    if (!assertPathOwnershipAfterClose(lock, state, quarantinePath)) {
      throw new CooperativeLockError('RECOVERY_REQUIRED');
    }
    state.operations.unlinkSync(quarantinePath);
    quarantineUnlinked = true;
    try {
      state.operations.rmdirSync(quarantineDirectory);
    } catch {
      // The lock is fully released; an empty private directory is harmless.
    }
  } catch {
    if (!descriptorCloseAttempted) {
      descriptorCloseAttempted = true;
      try {
        state.operations.closeSync(lock.descriptor);
      } catch {
        // Preserve the path or quarantine as recovery material.
      }
    }
    if (movedToQuarantine && !quarantineUnlinked && quarantinePath) {
      try {
        /*
         * linkSync is no-clobber. Keeping both names makes the raced inode
         * discoverable at vault.lock without risking deletion of quarantine.
         */
        state.operations.linkSync(quarantinePath, lock.path);
      } catch {
        // The quarantine path remains the recovery artifact.
      }
    }
    lockStates.delete(lock);
    throw new CooperativeLockError('RECOVERY_REQUIRED');
  }
  lockStates.delete(lock);
}
