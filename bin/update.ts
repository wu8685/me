#!/usr/bin/env -S bun run

import * as crypto from 'crypto';
import * as path from 'path';
import {
  CURRENT_VAULT_SCHEMA_VERSION,
  UPDATE_ERROR_CATALOG,
  UpdateError,
  sanitizePublicUpdateResult,
  serializeUpdateResult,
  type UpdateErrorCode,
  type UpdatePlan,
  type UpdateResultV1,
} from './update/contracts.ts';
import {
  planVaultUpdate,
  type ManagedAgent,
} from './update/planner.ts';
import {
  executeVaultUpdate,
  inspectVaultUpdateRecovery,
} from './update/transaction.ts';
import { RuntimePathError } from './runtime-paths.ts';

interface PreviewArguments {
  mode: 'preview';
  vaultDir: string;
  managedAgents?: readonly ManagedAgent[];
}

interface ApplyArguments {
  mode: 'apply';
  vaultDir: string;
  expectedPlanDigest: string;
  managedAgents?: readonly ManagedAgent[];
}

export interface UpdateCliOptions {
  pluginRoot?: string;
  environment?: NodeJS.ProcessEnv;
  operationIdFactory?: () => string;
  planUpdate?: typeof planVaultUpdate;
  executeUpdate?: typeof executeVaultUpdate;
  signal?: AbortSignal;
}

const PUBLIC_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeOperationId(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '.'
    && value !== '..'
    && PUBLIC_OPERATION_ID.test(value);
}

function parseArguments(
  argv: readonly string[],
): PreviewArguments | ApplyArguments {
  const managedAgents = (value: string | undefined): readonly ManagedAgent[] => {
    if (value === 'codex') return ['codex'];
    if (value === 'claude') return ['claude'];
    if (value === 'codex,claude') return ['codex', 'claude'];
    throw new UpdateError('INVALID_REQUEST');
  };
  if (
    argv.length === 3
    && argv[0] === 'preview'
    && argv[1] === '--vault-dir'
    && argv[2]
    && !argv[2].startsWith('--')
  ) {
    return { mode: 'preview', vaultDir: argv[2] };
  }
  if (
    argv.length === 5
    && argv[0] === 'preview'
    && argv[1] === '--vault-dir'
    && argv[2]
    && !argv[2].startsWith('--')
    && argv[3] === '--managed-agents'
  ) {
    return {
      mode: 'preview',
      vaultDir: argv[2],
      managedAgents: managedAgents(argv[4]),
    };
  }
  if (
    argv.length === 5
    && argv[0] === 'apply'
    && argv[1] === '--vault-dir'
    && argv[2]
    && !argv[2].startsWith('--')
    && argv[3] === '--expected-plan-digest'
    && /^[a-f0-9]{64}$/.test(argv[4] ?? '')
  ) {
    return {
      mode: 'apply',
      vaultDir: argv[2],
      expectedPlanDigest: argv[4],
    };
  }
  if (
    argv.length === 7
    && argv[0] === 'apply'
    && argv[1] === '--vault-dir'
    && argv[2]
    && !argv[2].startsWith('--')
    && argv[3] === '--expected-plan-digest'
    && /^[a-f0-9]{64}$/.test(argv[4] ?? '')
    && argv[5] === '--managed-agents'
  ) {
    return {
      mode: 'apply',
      vaultDir: argv[2],
      expectedPlanDigest: argv[4],
      managedAgents: managedAgents(argv[6]),
    };
  }
  throw new UpdateError('INVALID_REQUEST');
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
    recoveryActions: [],
    preservedPaths: [],
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
    recoveryActions: [],
    preservedPaths: [],
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
    return sanitizePublicUpdateResult(
      emptyResult('unavailable', 'INTERNAL_ERROR'),
    );
  }
  if (!safeOperationId(operationId)) {
    return sanitizePublicUpdateResult(
      emptyResult('unavailable', 'INTERNAL_ERROR'),
    );
  }

  try {
    const args = parseArguments(argv);
    if (options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');

    const pluginRoot = options.pluginRoot ?? path.resolve(__dirname, '..');
    if (args.mode === 'apply') {
      const execute = options.executeUpdate ?? executeVaultUpdate;
      return sanitizePublicUpdateResult(execute(
        args.vaultDir,
        args.expectedPlanDigest,
        {
          pluginRoot,
          environment: options.environment,
          operationIdFactory: () => operationId,
          signal: options.signal,
          managedAgents: args.managedAgents,
        },
      ));
    }
    const recovery = inspectVaultUpdateRecovery(
      args.vaultDir,
      options.environment,
    );
    if (recovery) {
      const result = emptyResult(operationId, recovery.code);
      result.recoveryActions = recovery.actions;
      result.preservedPaths = recovery.preservedPaths;
      return sanitizePublicUpdateResult(result);
    }
    const planner = options.planUpdate ?? planVaultUpdate;
    const plan = planner({
      vaultDir: args.vaultDir,
      pluginRoot,
      managedAgents: args.managedAgents,
    });

    if (options.signal?.aborted) throw new UpdateError('INVALID_REQUEST');
    return sanitizePublicUpdateResult(previewResult(operationId, plan));
  } catch (error) {
    return sanitizePublicUpdateResult(
      emptyResult(operationId, publicErrorCode(error)),
    );
  }
}

export function exitCodeForUpdateResult(result: UpdateResultV1): number {
  if (
    result.status === 'preview'
    || result.status === 'up_to_date'
    || result.status === 'committed'
  ) return 0;
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
