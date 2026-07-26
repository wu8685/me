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
  operations: CooperativeLockOperations;
}

interface CooperativeLockIdentity {
  bytes: Buffer;
  device: bigint;
  inode: bigint;
  operationId: string;
  owner: CooperativeLockOwner;
}

type PathOwnershipState =
  | 'owned'
  | 'same-inode-corrupt'
  | 'replacement'
  | 'missing'
  | 'unknown';

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

function readPathOwnership(
  candidate: string,
  descriptor: number,
  identity: CooperativeLockIdentity,
  operations: CooperativeLockOperations,
): Exclude<PathOwnershipState, 'missing'> {
  const opened = operations.fstatSync(descriptor);
  const entryBeforeRead = operations.lstatSync(candidate);
  const targetBeforeRead = operations.statSync(candidate);
  const actualBytes = operations.readFileSync(candidate);
  /*
   * Reading bytes is not an identity-stable operation. Re-read both path
   * identities afterwards so a replacement made during readFileSync can
   * never inherit the ownership proof for the previous inode.
   */
  const entryAfterRead = operations.lstatSync(candidate);
  const targetAfterRead = operations.statSync(candidate);
  const openedIsOwned = opened.isFile()
    && opened.dev === identity.device
    && opened.ino === identity.inode;
  const beforeIsRegular = entryBeforeRead.isFile()
    && !entryBeforeRead.isSymbolicLink()
    && targetBeforeRead.isFile()
    && entryBeforeRead.dev === targetBeforeRead.dev
    && entryBeforeRead.ino === targetBeforeRead.ino;
  const afterIsRegular = entryAfterRead.isFile()
    && !entryAfterRead.isSymbolicLink()
    && targetAfterRead.isFile()
    && entryAfterRead.dev === targetAfterRead.dev
    && entryAfterRead.ino === targetAfterRead.ino;
  if (!openedIsOwned || !beforeIsRegular || !afterIsRegular) return 'unknown';

  const beforeIsOwned = entryBeforeRead.dev === identity.device
    && entryBeforeRead.ino === identity.inode;
  const afterIsOwned = entryAfterRead.dev === identity.device
    && entryAfterRead.ino === identity.inode;
  if (beforeIsOwned && afterIsOwned) {
    return isExpectedOwnership(
      actualBytes,
      identity.bytes,
      identity.operationId,
      identity.owner,
    )
      ? 'owned'
      : 'same-inode-corrupt';
  }

  const stableReplacement = !beforeIsOwned
    && !afterIsOwned
    && entryBeforeRead.dev === entryAfterRead.dev
    && entryBeforeRead.ino === entryAfterRead.ino;
  return stableReplacement ? 'replacement' : 'unknown';
}

function inspectPathOwnership(
  candidate: string,
  descriptor: number,
  identity: CooperativeLockIdentity,
  operations: CooperativeLockOperations,
): PathOwnershipState {
  try {
    return readPathOwnership(candidate, descriptor, identity, operations);
  } catch (error) {
    return errno(error) === 'ENOENT' ? 'missing' : 'unknown';
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
  const identity: CooperativeLockIdentity = {
    bytes,
    device: opened.dev,
    inode: opened.ino,
    operationId: request.operationId,
    owner: request.owner,
  };
  if (
    !opened.isFile()
    || readPathOwnership(lockPath, descriptor, identity, operations) !== 'owned'
  ) {
    throw new CooperativeLockError('RECOVERY_REQUIRED');
  }
  return {
    bytes,
    descriptorDevice: opened.dev,
    descriptorInode: opened.ino,
    operations,
  };
}

function safeRuntimeMutation(layout: RuntimeLayout, candidate: string): void {
  try {
    assertSafeRuntimePath(layout, candidate);
  } catch {
    throw new CooperativeLockError('UNSAFE_PATH');
  }
}

function nativeInspectionOperations(
  operations: CooperativeLockOperations,
): CooperativeLockOperations {
  return {
    ...operations,
    fstatSync: descriptor => fs.fstatSync(descriptor, { bigint: true }),
    lstatSync: candidate => fs.lstatSync(candidate, { bigint: true }),
    statSync: candidate => fs.statSync(candidate, { bigint: true }),
    readFileSync: candidate => fs.readFileSync(candidate),
  };
}

function inspectWithOptionalNativeFallback(
  candidate: string,
  descriptor: number,
  identity: CooperativeLockIdentity,
  operations: CooperativeLockOperations,
  nativeFallback: boolean,
): PathOwnershipState {
  const observed = inspectPathOwnership(candidate, descriptor, identity, operations);
  return observed === 'unknown' && nativeFallback
    ? inspectPathOwnership(
      candidate,
      descriptor,
      identity,
      nativeInspectionOperations(operations),
    )
    : observed;
}

function closeDescriptorStateAware(
  descriptor: number,
  operations: CooperativeLockOperations,
): void {
  try {
    operations.closeSync(descriptor);
    return;
  } catch {
    try {
      fs.fstatSync(descriptor);
    } catch (error) {
      if (errno(error) === 'EBADF') return;
    }
    try {
      fs.closeSync(descriptor);
    } catch {
      // Namespace recovery state is authoritative even if descriptor close fails.
    }
  }
}

function quarantineAndRemoveOwnedLock(
  layout: RuntimeLayout,
  lockPath: string,
  descriptor: number,
  identity: CooperativeLockIdentity,
  operations: CooperativeLockOperations,
  hooks: CooperativeLockHooks | undefined,
  nativeInspectionFallback: boolean,
): boolean {
  let quarantineDirectory: string | undefined;
  let quarantinePath: string | undefined;

  const inspect = (candidate: string): PathOwnershipState =>
    inspectWithOptionalNativeFallback(
      candidate,
      descriptor,
      identity,
      operations,
      nativeInspectionFallback,
    );

  const reconcileActualState = (): 'removed' | 'recovery' => {
    if (!quarantinePath) return 'recovery';
    const sourceState = inspect(lockPath);
    const quarantineState = inspect(quarantinePath);
    if (
      quarantineState === 'missing'
      && (sourceState === 'missing' || sourceState === 'replacement')
    ) {
      /*
       * The owned inode is no longer reachable. A replacement source is a new
       * owner and must be preserved, but the previous owner is fully released.
       */
      return 'removed';
    }
    if (quarantineState !== 'missing') {
      try {
        /*
         * linkSync is no-clobber: an existing new owner wins, while an empty
         * cooperative namespace is restored from the actual quarantine inode.
         */
        operations.linkSync(quarantinePath, lockPath);
      } catch {
        // Existing source or unknown quarantine remains untouched.
      }
    }
    return 'recovery';
  };

  try {
    if (inspect(lockPath) !== 'owned') return false;

    hooks?.beforeMutation?.('unlink', lockPath);
    safeRuntimeMutation(layout, lockPath);
    quarantineDirectory = operations.mkdtempSync(
      path.join(layout.lockDir, '.vault-lock-release-'),
    );
    quarantinePath = path.join(quarantineDirectory, 'vault.lock');
    safeRuntimeMutation(layout, quarantineDirectory);
    safeRuntimeMutation(layout, quarantinePath);

    try {
      operations.renameSync(lockPath, quarantinePath);
    } catch {
      return reconcileActualState() === 'removed';
    }

    if (inspect(quarantinePath) !== 'owned') {
      reconcileActualState();
      return false;
    }

    try {
      operations.unlinkSync(quarantinePath);
    } catch {
      return reconcileActualState() === 'removed';
    }
    /*
     * Do not trust a successful wrapper return either. Derive the namespace
     * state after every mutation so post-success wrapper behavior cannot make
     * stale booleans authoritative.
     */
    return reconcileActualState() === 'removed';
  } catch {
    return reconcileActualState() === 'removed';
  } finally {
    /*
     * Keep the owned descriptor live through rename, final byte+identity
     * verification, unlink, and state reconciliation.
     */
    closeDescriptorStateAware(descriptor, operations);
    if (
      quarantineDirectory
      && quarantinePath
      && pathIsMissing(quarantinePath, operations)
    ) {
      try {
        operations.rmdirSync(quarantineDirectory);
      } catch {
        // An empty private quarantine directory is harmless.
      }
    }
  }
}

function pathIsMissing(
  candidate: string,
  operations: CooperativeLockOperations,
): boolean {
  try {
    operations.lstatSync(candidate);
    return false;
  } catch (error) {
    return errno(error) === 'ENOENT';
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
    let opened: fs.BigIntStats;
    try {
      opened = fs.fstatSync(descriptor, { bigint: true });
    } catch {
      closeDescriptorStateAware(descriptor, operations);
      throw new CooperativeLockError('RECOVERY_REQUIRED');
    }
    const removed = quarantineAndRemoveOwnedLock(
      layout,
      lockPath,
      descriptor,
      {
        bytes,
        device: opened.dev,
        inode: opened.ino,
        operationId: request.operationId,
        owner: request.owner,
      },
      operations,
      hooks,
      true,
    );
    if (!removed) throw new CooperativeLockError('RECOVERY_REQUIRED');
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
  lockStates.delete(lock);
  if (path.resolve(lock.path) !== path.resolve(expectedPath)) {
    closeDescriptorStateAware(lock.descriptor, state.operations);
    throw new CooperativeLockError('RECOVERY_REQUIRED');
  }
  const removed = quarantineAndRemoveOwnedLock(
    layout,
    lock.path,
    lock.descriptor,
    {
      bytes: state.bytes,
      device: state.descriptorDevice,
      inode: state.descriptorInode,
      operationId: lock.operationId,
      owner: lock.owner,
    },
    state.operations,
    hooks,
    false,
  );
  if (!removed) throw new CooperativeLockError('RECOVERY_REQUIRED');
}
