import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import {
  UPDATE_ERROR_CATALOG,
  UpdateError,
  serializeUpdateResult,
  type UpdateErrorCode,
  type UpdateResultV1,
} from '../bin/update/contracts.ts';

function result(overrides: Partial<UpdateResultV1> = {}): UpdateResultV1 {
  return {
    version: 1,
    status: 'preview',
    operationId: 'fixture-operation',
    currentVaultSchemaVersion: 0,
    targetVaultSchemaVersion: 1,
    migrations: [{ id: '0001-adopt-vault-schema', description: 'Adopt the versioned vault schema.' }],
    planDigest: 'a'.repeat(64),
    plannedPaths: ['.me/config.yaml'],
    changedPaths: [],
    diffs: [],
    warnings: [],
    conflicts: [],
    recoveryState: 'none',
    ...overrides,
  };
}

describe('update contracts', () => {
  test('freezes one stable public status, exit class, and message for every error', () => {
    expect(UPDATE_ERROR_CATALOG).toEqual({
      INVALID_REQUEST: {
        status: 'blocked',
        exitCode: 2,
        message: 'INVALID_REQUEST: Request does not match me-update v1.',
      },
      NOT_A_ME_VAULT: {
        status: 'blocked',
        exitCode: 2,
        message: 'NOT_A_ME_VAULT: The selected directory is not an initialized ME vault.',
      },
      INVALID_CONFIG: {
        status: 'blocked',
        exitCode: 2,
        message: 'INVALID_CONFIG: Vault configuration is invalid.',
      },
      INVALID_VAULT_SCHEMA_VERSION: {
        status: 'blocked',
        exitCode: 2,
        message: 'INVALID_VAULT_SCHEMA_VERSION: Vault schema version must be a non-negative safe integer.',
      },
      VAULT_NEWER_THAN_PLUGIN: {
        status: 'blocked',
        exitCode: 5,
        message: 'VAULT_NEWER_THAN_PLUGIN: Vault schema is newer than this ME version.',
      },
      INVALID_MIGRATION_REGISTRY: {
        status: 'blocked',
        exitCode: 2,
        message: 'INVALID_MIGRATION_REGISTRY: Installed ME migration registry is invalid.',
      },
      MIGRATION_CONFLICT: {
        status: 'blocked',
        exitCode: 3,
        message: 'MIGRATION_CONFLICT: Vault content conflicts with the required migration.',
      },
      STALE_PREVIEW: {
        status: 'blocked',
        exitCode: 3,
        message: 'STALE_PREVIEW: Vault inputs changed after preview; no update was applied.',
      },
      UPDATE_IN_PROGRESS: {
        status: 'blocked',
        exitCode: 3,
        message: 'UPDATE_IN_PROGRESS: Another ME vault update may still be active.',
      },
      UNSAFE_PATH: {
        status: 'blocked',
        exitCode: 2,
        message: 'UNSAFE_PATH: A required path is outside the safe vault layout.',
      },
      UNSUPPORTED_FILESYSTEM: {
        status: 'blocked',
        exitCode: 5,
        message: 'UNSUPPORTED_FILESYSTEM: Filesystem cannot provide the required no-clobber primitive.',
      },
      LEGACY_RUNTIME_STATE: {
        status: 'recovery_required',
        exitCode: 4,
        message: 'LEGACY_RUNTIME_STATE: Vault-local ME 1.5 runtime state requires inspection.',
      },
      VALIDATION_FAILED: {
        status: 'rolled_back',
        exitCode: 2,
        message: 'VALIDATION_FAILED: Post-migration validation failed and owned changes were restored.',
      },
      RECOVERY_REQUIRED: {
        status: 'recovery_required',
        exitCode: 4,
        message: 'RECOVERY_REQUIRED: Conflicting content was preserved; manual recovery is required.',
      },
      INTERNAL_ERROR: {
        status: 'blocked',
        exitCode: 1,
        message: 'INTERNAL_ERROR: Vault update could not complete safely.',
      },
    });
    expect(Object.isFrozen(UPDATE_ERROR_CATALOG)).toBeTrue();
    for (const definition of Object.values(UPDATE_ERROR_CATALOG)) {
      expect(Object.isFrozen(definition)).toBeTrue();
    }
  });

  test('UpdateError always uses the frozen public message for its code', () => {
    for (const code of Object.keys(UPDATE_ERROR_CATALOG) as UpdateErrorCode[]) {
      const error = new UpdateError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(UPDATE_ERROR_CATALOG[code].message);
      expect(error.name).toBe('UpdateError');
    }
  });

  test('result serialization redacts absolute runtime paths and emits one JSON line', () => {
    const privateRuntimePath = path.join(
      path.parse(process.cwd()).root,
      'private',
      'me-runtime-fixture',
      'transactions',
      'op-1',
      'journal.json',
    );
    const serialized = serializeUpdateResult(result({
      warnings: [
        `Inspect ${privateRuntimePath}`,
        'Portable path: <ME_RUNTIME>/transactions/op-1/journal.json',
      ],
    }));

    expect(serialized.endsWith('\n')).toBeTrue();
    expect(serialized.trimEnd().includes('\n')).toBeFalse();
    expect(serialized).not.toContain(privateRuntimePath);
    expect(serialized).toContain('<ABSOLUTE_PATH>');
    expect(serialized).toContain('<ME_RUNTIME>/transactions/op-1/journal.json');
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      status: 'preview',
      plannedPaths: ['.me/config.yaml'],
    });
  });
});
