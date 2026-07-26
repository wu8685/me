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
  assertSafeWriterPath,
  resolveVaultLayout,
} from './vault-write/path-safety';
import { executeVaultWrite } from './vault-write/transaction';

interface CliArguments {
  mode: 'preview' | 'write';
  vaultDir: string;
  requestPath?: string;
}

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

function readContainedRequestFile(vaultDir: string, requestValue: string): Buffer {
  const layout = resolveVaultLayout(vaultDir);
  const candidate = path.isAbsolute(requestValue)
    ? path.resolve(requestValue)
    : path.resolve(layout.lexicalVault, requestValue);
  const expectedParent = path.join(layout.meDir, 'tmp');

  if (
    path.dirname(candidate) !== expectedParent
    || path.extname(candidate) !== '.json'
    || path.basename(candidate) === '.json'
  ) {
    throw new VaultWriterError('UNSAFE_PATH');
  }

  assertSafeWriterPath(layout, candidate, 'request file');
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    const canonical = fs.realpathSync(candidate);
    const canonicalTmp = fs.realpathSync(expectedParent);
    if (path.dirname(canonical) !== canonicalTmp) {
      throw new VaultWriterError('UNSAFE_PATH');
    }
    return fs.readFileSync(candidate);
  } catch (error) {
    if (error instanceof VaultWriterError) throw error;
    throw new VaultWriterError('UNSAFE_PATH');
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
      : fs.readFileSync(0);
    const request = decodeJson(bytes);
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
