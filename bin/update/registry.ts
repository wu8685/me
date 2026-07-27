import type { ConfigEdit } from './config-document.ts';
import { UpdateError } from './contracts.ts';
import type { ManagedAssetIntent } from './managed-assets.ts';
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

export interface MigrationIntent {
  configEdits: readonly ConfigEdit[];
  managedAssets: readonly ManagedAssetIntent[];
  contentTransforms: readonly ContentTransformIntent[];
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

export function validateMigrationRegistry(
  migrations: readonly VaultMigration[],
  currentVersion: number,
): void {
  if (
    !Array.isArray(migrations)
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
      || typeof migration !== 'object'
      || typeof migration.id !== 'string'
      || migration.id.length === 0
      || /[\u0000-\u001f\u007f]/.test(migration.id)
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
