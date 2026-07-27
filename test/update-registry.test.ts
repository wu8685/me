import { describe, expect, test } from 'bun:test';
import {
  validateMigrationRegistry,
  type VaultMigration,
} from '../bin/update/registry.ts';
import { UpdateError } from '../bin/update/contracts.ts';

function migration(
  fromVersion: number,
  toVersion: number,
  id: string,
): VaultMigration {
  return {
    id,
    fromVersion,
    toVersion,
    describe: () => id,
    plan: () => ({
      configEdits: [],
      managedAssets: [],
      contentTransforms: [],
    }),
  };
}

function expectInvalidRegistry(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UpdateError);
  expect((thrown as UpdateError).code).toBe('INVALID_MIGRATION_REGISTRY');
}

describe('migration registry validation', () => {
  test('accepts one ordered unit edge for every supported legacy version', () => {
    expect(() => validateMigrationRegistry([
      migration(0, 1, '0000-to-0001'),
      migration(1, 2, '0001-to-0002'),
    ], 2)).not.toThrow();
    expect(() => validateMigrationRegistry([], 0)).not.toThrow();
  });

  test('rejects gaps, duplicates, non-unit jumps, and reversed order', () => {
    const invalidRegistries = [
      [
        migration(0, 1, 'a'),
        migration(2, 3, 'b'),
      ],
      [
        migration(0, 1, 'a'),
        migration(0, 1, 'b'),
      ],
      [migration(0, 2, 'jump')],
      [
        migration(1, 2, 'second'),
        migration(0, 1, 'first'),
      ],
    ];
    for (const registry of invalidRegistries) {
      expectInvalidRegistry(() => validateMigrationRegistry(registry, 2));
    }
  });

  test('rejects incomplete current-version coverage and duplicate ids', () => {
    expectInvalidRegistry(() => validateMigrationRegistry([
      migration(0, 1, 'only'),
    ], 2));
    expectInvalidRegistry(() => validateMigrationRegistry([
      migration(0, 1, 'same'),
      migration(1, 2, 'same'),
    ], 2));
  });

  test('rejects malformed migrations and current versions', () => {
    for (const currentVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalidRegistry(() => validateMigrationRegistry(
        [],
        currentVersion,
      ));
    }
    for (const invalid of [
      { ...migration(0, 1, ''), id: '' },
      { ...migration(0, 1, 'a'), describe: undefined },
      { ...migration(0, 1, 'a'), plan: undefined },
      { ...migration(0, 1, 'a'), fromVersion: -1 },
      { ...migration(0, 1, 'a'), id: '/unsafe/id' },
      { ...migration(0, 1, 'a'), extra: true },
    ]) {
      expectInvalidRegistry(() => validateMigrationRegistry(
        [invalid as VaultMigration],
        1,
      ));
    }
  });
});
