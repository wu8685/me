#!/usr/bin/env -S bun run

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  VaultWriterError,
  WRITER_ERROR_CATALOG,
  type VaultWriteResultV1,
  type WriterErrorCode,
} from './vault-write/contracts';
import {
  resolveVaultLayout,
} from './vault-write/path-safety';
import { executeVaultWrite } from './vault-write/transaction';
import {
  RuntimePathError,
  assertSafeRuntimePath,
} from './runtime-paths';

interface CliArguments {
  mode: 'preview' | 'write';
  vaultDir: string;
  requestPath?: string;
}

interface RequestFileHooks {
  afterIdentityValidation?(): void;
}

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function publicFailure(code: WriterErrorCode): VaultWriteResultV1 {
  const definition = WRITER_ERROR_CATALOG[code];
  return {
    version: 1,
    status: definition.status,
    operationId: crypto.randomUUID(),
    commitModel: 'journaled-cooperative',
    requestDigest: '',
    changedPaths: [],
    plannedPaths: [],
    indexAction: 'none',
    backlinks: [],
    unlinkedMentions: [],
    warnings: [],
    error: { code, message: definition.message },
    recoveryState: 'none',
    recoveries: [],
  };
}

function parseArguments(argv: string[]): CliArguments {
  if (argv.length === 0 || (argv[0] !== 'preview' && argv[0] !== 'write')) {
    throw new VaultWriterError('INVALID_REQUEST');
  }

  let vaultDir: string | undefined;
  let requestPath: string | undefined;
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new VaultWriterError('INVALID_REQUEST');
    }
    if (flag === '--vault-dir' && vaultDir === undefined) {
      vaultDir = value;
    } else if (flag === '--request' && requestPath === undefined) {
      requestPath = value;
    } else {
      throw new VaultWriterError('INVALID_REQUEST');
    }
  }

  if (!vaultDir) throw new VaultWriterError('INVALID_REQUEST');
  return { mode: argv[0], vaultDir, ...(requestPath ? { requestPath } : {}) };
}

function decodeJson(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new VaultWriterError('INVALID_REQUEST');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VaultWriterError('INVALID_REQUEST');
  }
}

export function readLimitedRequest(descriptor: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remainingWithOverflowByte = MAX_REQUEST_BYTES - total + 1;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingWithOverflowByte));
    const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) throw new VaultWriterError('INVALID_REQUEST');
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function sameFileIdentity(first: fs.Stats, second: fs.Stats): boolean {
  return first.isFile()
    && second.isFile()
    && !first.isSymbolicLink()
    && !second.isSymbolicLink()
    && first.dev === second.dev
    && first.ino === second.ino;
}

export function readContainedRequestFile(
  vaultDir: string,
  requestValue: string,
  hooks: RequestFileHooks = {},
): Buffer {
  const layout = resolveVaultLayout(vaultDir);
  const candidate = path.isAbsolute(requestValue)
    ? path.resolve(requestValue)
    : path.resolve(layout.lexicalVault, requestValue);
  const expectedParent = layout.inboxDir;

  if (
    path.dirname(candidate) !== expectedParent
    || path.extname(candidate) !== '.json'
    || path.basename(candidate) === '.json'
  ) {
    throw new VaultWriterError('UNSAFE_PATH');
  }

  try {
    assertSafeRuntimePath(layout, candidate);
  } catch (error) {
    if (error instanceof RuntimePathError) throw new VaultWriterError('UNSAFE_PATH');
    throw error;
  }
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    const nonBlock = fs.constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    const entry = fs.lstatSync(candidate);
    if (opened.size > MAX_REQUEST_BYTES) {
      throw new VaultWriterError('INVALID_REQUEST');
    }
    if (!sameFileIdentity(opened, entry)) {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    const canonical = fs.realpathSync(candidate);
    const canonicalTmp = fs.realpathSync(expectedParent);
    if (path.dirname(canonical) !== canonicalTmp) {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    hooks.afterIdentityValidation?.();
    const bytes = readLimitedRequest(descriptor);
    const openedAfter = fs.fstatSync(descriptor);
    const entryAfter = fs.lstatSync(candidate);
    if (!sameFileIdentity(opened, openedAfter) || !sameFileIdentity(opened, entryAfter)) {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    return bytes;
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    throw new VaultWriterError('UNSAFE_PATH');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* descriptor is no longer usable */ }
    }
  }
}

export function exitCodeForResult(result: VaultWriteResultV1): number {
  if (result.status === 'preview' || result.status === 'committed') return 0;
  const code = result.error?.code as WriterErrorCode | undefined;
  return code && WRITER_ERROR_CATALOG[code]
    ? WRITER_ERROR_CATALOG[code].exitCode
    : WRITER_ERROR_CATALOG.INTERNAL_ERROR.exitCode;
}

function errorCode(error: unknown): WriterErrorCode {
  return error instanceof VaultWriterError ? error.code : 'INTERNAL_ERROR';
}

function run(argv: string[]): VaultWriteResultV1 {
  try {
    const args = parseArguments(argv);
    const bytes = args.requestPath
      ? readContainedRequestFile(args.vaultDir, args.requestPath)
      : readLimitedRequest(0);
    const request = decodeJson(bytes);
    const injectedFailure = process.env.NODE_ENV === 'test'
      ? process.env.ME_VAULT_WRITE_TEST_FAILURE
      : undefined;
    if (injectedFailure === 'UNSUPPORTED_FILESYSTEM') {
      throw new VaultWriterError('UNSUPPORTED_FILESYSTEM');
    }
    if (injectedFailure?.startsWith('INTERNAL_ERROR:')) {
      throw new Error(injectedFailure.slice('INTERNAL_ERROR:'.length));
    }
    return executeVaultWrite(args.vaultDir, request as never, {
      pluginRoot: path.resolve(__dirname, '..'),
      mode: args.mode,
    });
  } catch (error) {
    return publicFailure(errorCode(error));
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCodeForResult(result);
}
