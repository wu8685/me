import type { ConfigEdit } from './config-document.ts';
import { UpdateError } from './contracts.ts';
import type { ManagedAssetIntent } from './managed-assets.ts';
import type { PlannedMutation } from '../mutation/contracts.ts';
import { migration0000To0001 } from './migrations/0000-to-0001.ts';

export interface ReadonlyMigrationContext {
  vaultDir: string;
  pluginRoot: string;
  currentVaultSchemaVersion: number;
}

export interface ContentTransformIntent {
  vaultRelativePaths: readonly string[];
  transform(vaultRelativePath: string, currentBytes: Buffer): Buffer;
}

/**
 * Registry declarations are projections of the shared mutation contract.
 * The planner supplies fingerprints and publication order from the vault view.
 */
export type MigrationMutation =
  | Pick<
      Extract<PlannedMutation, { kind: 'mkdir' }>,
      'kind' | 'vaultRelativePath' | 'desiredMode'
    >
  | Pick<
      Extract<PlannedMutation, { kind: 'rename' }>,
      'kind' | 'vaultRelativePath' | 'destinationVaultRelativePath'
    >;

export interface MigrationIntent {
  configEdits: readonly ConfigEdit[];
  managedAssets: readonly ManagedAssetIntent[];
  contentTransforms: readonly ContentTransformIntent[];
  mutations: readonly MigrationMutation[];
}

export interface VaultMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  describe(): string;
  plan(context: ReadonlyMigrationContext): MigrationIntent;
}

function invalidRegistry(): never {
  throw new UpdateError('INVALID_MIGRATION_REGISTRY');
}

function safeVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => (
      typeof key === 'string' && expected.includes(key)
    ));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function denseRegistry(value: readonly VaultMigration[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  return keys.every(key => (
    key === 'length'
    || (
      typeof key === 'string'
      && Number.isSafeInteger(Number(key))
      && String(Number(key)) === key
      && Number(key) >= 0
      && Number(key) < value.length
    )
  ));
}

export function validateMigrationRegistry(
  migrations: readonly VaultMigration[],
  currentVersion: number,
): void {
  if (
    !Array.isArray(migrations)
    || !denseRegistry(migrations)
    || !safeVersion(currentVersion)
    || migrations.length !== currentVersion
  ) {
    invalidRegistry();
  }

  const ids = new Set<string>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index] as VaultMigration | undefined;
    if (
      !migration
      || !plainRecord(migration)
      || !hasExactKeys(migration, [
        'id',
        'fromVersion',
        'toVersion',
        'describe',
        'plan',
      ])
      || typeof migration.id !== 'string'
      || !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(migration.id)
      || ids.has(migration.id)
      || !safeVersion(migration.fromVersion)
      || !safeVersion(migration.toVersion)
      || migration.fromVersion !== index
      || migration.toVersion !== index + 1
      || typeof migration.describe !== 'function'
      || typeof migration.plan !== 'function'
    ) {
      invalidRegistry();
    }
    ids.add(migration.id);
  }
}

export const MIGRATION_REGISTRY: readonly VaultMigration[] = Object.freeze([
  migration0000To0001,
]);
