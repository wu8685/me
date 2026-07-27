#!/usr/bin/env -S bun run

import * as crypto from 'crypto';
import * as path from 'path';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UPDATE_ERROR_CATALOG,
  UpdateError,
  serializeUpdateResult,
  type UpdateErrorCode,
  type UpdatePlan,
  type UpdateResultV1,
} from './update/contracts.ts';
import { planVaultUpdate } from './update/planner.ts';
import { RuntimePathError } from './runtime-paths.ts';

interface PreviewArguments {
  mode: 'preview';
  vaultDir: string;
}

export interface UpdateCliOptions {
  pluginRoot?: string;
  environment?: NodeJS.ProcessEnv;
  operationIdFactory?: () => string;
  planUpdate?: typeof planVaultUpdate;
  signal?: AbortSignal;
}

function parseArguments(argv: readonly string[]): PreviewArguments {
  if (
    argv.length !== 3
    || argv[0] !== 'preview'
    || argv[1] !== '--vault-dir'
    || !argv[2]
    || argv[2].startsWith('--')
  ) {
    throw new UpdateError('INVALID_REQUEST');
  }
  return { mode: 'preview', vaultDir: argv[2] };
}

function emptyResult(
  operationId: string,
  code: UpdateErrorCode,
): UpdateResultV1 {
  const definition = UPDATE_ERROR_CATALOG[code];
  const recoveryState = definition.status === 'rolled_back'
    ? 'rolled_back'
    : definition.status === 'recovery_required'
      ? 'manual'
      : 'none';
  return {
    version: 1,
    status: definition.status,
    operationId,
    currentVaultSchemaVersion: 0,
    targetVaultSchemaVersion: CURRENT_VAULT_SCHEMA_VERSION,
    migrations: [],
    plannedPaths: [],
    changedPaths: [],
    diffs: [],
    warnings: [],
    conflicts: [],
    recoveryState,
    error: { code, message: definition.message },
  };
}

function previewResult(
  operationId: string,
  plan: UpdatePlan,
): UpdateResultV1 {
  const result: UpdateResultV1 = {
    version: 1,
    status: plan.status,
    operationId,
    currentVaultSchemaVersion: plan.currentVaultSchemaVersion,
    targetVaultSchemaVersion: plan.targetVaultSchemaVersion,
    migrations: plan.migrations.map(migration => ({ ...migration })),
    planDigest: plan.planDigest,
    plannedPaths: [...plan.plannedPaths],
    changedPaths: [],
    diffs: plan.diffs.map(diff => ({ ...diff })),
    warnings: [...plan.warnings],
    conflicts: plan.conflicts.map(conflict => ({ ...conflict })),
    recoveryState: 'none',
  };
  if (plan.status === 'blocked') {
    const definition = UPDATE_ERROR_CATALOG.MIGRATION_CONFLICT;
    result.error = {
      code: 'MIGRATION_CONFLICT',
      message: definition.message,
    };
  }
  return result;
}

function publicErrorCode(error: unknown): UpdateErrorCode {
  if (error instanceof UpdateError) return error.code;
  if (error instanceof RuntimePathError) return error.code;
  return 'INTERNAL_ERROR';
}

/**
 * Run one preview request and return its structured result.
 *
 * One opaque operation id is allocated per invocation, including validation
 * failures. The plan digest, rather than the operation id, is the stable
 * confirmation token for a specific vault state.
 */
export function runUpdateCli(
  argv: readonly string[],
  options: UpdateCliOptions = {},
): UpdateResultV1 {
  const operationIdFactory = options.operationIdFactory ?? crypto.randomUUID;
  let operationId: string;
  try {
    operationId = operationIdFactory();
  } catch {
    return emptyResult('unavailable', 'INTERNAL_ERROR');
  }

  try {
    const args = parseArguments(argv);
    if (options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');

    const pluginRoot = options.pluginRoot ?? path.resolve(__dirname, '..');
    const planner = options.planUpdate ?? planVaultUpdate;
    const plan = planner({
      vaultDir: args.vaultDir,
      pluginRoot,
    });

    if (options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');
    return previewResult(operationId, plan);
  } catch (error) {
    return emptyResult(operationId, publicErrorCode(error));
  }
}

export function exitCodeForUpdateResult(result: UpdateResultV1): number {
  if (result.status === 'preview' || result.status === 'up_to_date') return 0;
  const code = result.error?.code;
  return code && UPDATE_ERROR_CATALOG[code]
    ? UPDATE_ERROR_CATALOG[code].exitCode
    : UPDATE_ERROR_CATALOG.INTERNAL_ERROR.exitCode;
}

if (require.main === module) {
  const result = runUpdateCli(process.argv.slice(2));
  process.stdout.write(serializeUpdateResult(result));
  process.exitCode = exitCodeForUpdateResult(result);
}
