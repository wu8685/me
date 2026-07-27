import type { VaultMigration } from '../registry.ts';

const legacyMigration: VaultMigration = {
  id: '0000-to-0001',
  fromVersion: 0,
  toVersion: 1,
  describe: () => (
    'Adopt versioned vault metadata and Agent-neutral managed assets.'
  ),
  plan: () => ({
    configEdits: [{
      kind: 'set',
      path: ['vault_schema_version'],
      value: 1,
    }],
    managedAssets: [
      {
        vaultRelativePath: 'SCHEMA.md',
        desiredTemplatePath: 'templates/SCHEMA.md',
        strategy: 'replace-known-template',
        knownTemplatePaths: [
          'templates/migration-history/0000/SCHEMA.md',
        ],
        onAbsent: 'create',
        onUnmarked: 'conflict',
      },
      {
        vaultRelativePath: 'CLAUDE.md',
        desiredTemplatePath: 'templates/CLAUDE-template.md',
        strategy: 'merge-owned-sections',
        knownTemplatePaths: [
          'templates/migration-history/0000/CLAUDE-template.md',
        ],
        onAbsent: 'create',
        onUnmarked: 'append-marked-block',
      },
      {
        vaultRelativePath: 'AGENTS.md',
        desiredTemplatePath: 'templates/AGENTS-template.md',
        strategy: 'merge-owned-sections',
        onAbsent: 'create',
        onUnmarked: 'append-marked-block',
      },
    ],
    contentTransforms: [],
    mutations: [],
  }),
};

export const migration0000To0001: VaultMigration = Object.freeze(
  legacyMigration,
);
