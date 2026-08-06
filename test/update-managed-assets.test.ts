import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mergeMeOwnedSections,
  planManagedAsset,
  type ManagedAssetIntent,
} from '../bin/update/managed-assets.ts';
import { UpdateError } from '../bin/update/contracts.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function makeVault(): string {
  const root = temporaryDirectory('me-update-assets-');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault);
  return vault;
}

function writeAsset(vault: string, relativePath: string, bytes: string | Buffer, mode = 0o644): void {
  const target = path.join(vault, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { mode });
}

function intent(
  overrides: Partial<ManagedAssetIntent> = {},
): ManagedAssetIntent {
  return {
    vaultRelativePath: 'CLAUDE.md',
    desiredTemplatePath: 'templates/CLAUDE-template.md',
    strategy: 'merge-owned-sections',
    onAbsent: 'create',
    onUnmarked: 'append-marked-block',
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function markerIds(source: string): string[] {
  return [...source.matchAll(/<!-- me:managed:start ([a-z0-9-]+) -->/g)]
    .map(match => match[1]);
}

function expectConflict(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UpdateError);
  expect((thrown as UpdateError).code).toBe('MIGRATION_CONFLICT');
}

describe('managed asset ownership strategies', () => {
  test('create-if-absent creates only an absent regular file and is idempotent', () => {
    const vault = makeVault();
    const createIntent = intent({
      vaultRelativePath: 'optional.md',
      desiredTemplatePath: 'templates/SCHEMA.md',
      strategy: 'create-if-absent',
      onUnmarked: 'conflict',
    });

    const mutation = planManagedAsset(vault, pluginRoot, createIntent);
    const desired = fs.readFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'));
    expect(mutation).toMatchObject({
      kind: 'write-file',
      vaultRelativePath: 'optional.md',
      source: { vaultRelativePath: 'optional.md', type: 'missing' },
      desiredSha256: sha256(desired),
      desiredMode: 0o644,
      publishOrder: 0,
    });
    expect(mutation?.kind === 'write-file' && mutation.desiredBytes.equals(desired)).toBeTrue();

    writeAsset(vault, 'optional.md', desired);
    expect(planManagedAsset(vault, pluginRoot, createIntent)).toBeUndefined();
    writeAsset(vault, 'optional.md', 'user-owned\n');
    expect(planManagedAsset(vault, pluginRoot, createIntent)).toBeUndefined();
  });

  test('replace-known-template replaces only byte-known historical content and preserves mode', () => {
    const vault = makeVault();
    const isolatedPlugin = path.join(temporaryDirectory('me-update-plugin-'), 'plugin');
    fs.cpSync(pluginRoot, isolatedPlugin, {
      recursive: true,
      filter(source) {
        return !source.includes(`${path.sep}.git`)
          && !source.includes(`${path.sep}node_modules`)
          && !source.includes(`${path.sep}graphify-out`);
      },
    });
    fs.appendFileSync(path.join(isolatedPlugin, 'templates/SCHEMA.md'), '\n<!-- current -->\n');
    const legacyPath = path.join(isolatedPlugin, 'templates/migration-history/0000/SCHEMA.md');
    const legacy = fs.readFileSync(legacyPath);
    writeAsset(vault, 'SCHEMA.md', legacy, 0o640);
    const replaceIntent = intent({
      vaultRelativePath: 'SCHEMA.md',
      desiredTemplatePath: 'templates/SCHEMA.md',
      strategy: 'replace-known-template',
      knownTemplatePaths: ['templates/migration-history/0000/SCHEMA.md'],
      onUnmarked: 'conflict',
    });

    const mutation = planManagedAsset(vault, isolatedPlugin, replaceIntent);
    expect(mutation).toMatchObject({
      kind: 'write-file',
      source: { type: 'file', mode: 0o640 },
      desiredMode: 0o640,
    });

    fs.appendFileSync(path.join(vault, 'SCHEMA.md'), '\nuser change\n');
    expectConflict(() => planManagedAsset(vault, isolatedPlugin, replaceIntent));
  });

  test('obeys create and skip exactly when an Agent file is absent', () => {
    const vault = makeVault();
    const claude = planManagedAsset(vault, pluginRoot, intent());
    const agents = planManagedAsset(vault, pluginRoot, intent({
      vaultRelativePath: 'AGENTS.md',
      desiredTemplatePath: 'templates/AGENTS-template.md',
    }));
    expect(claude).toMatchObject({ kind: 'write-file', vaultRelativePath: 'CLAUDE.md' });
    expect(agents).toMatchObject({ kind: 'write-file', vaultRelativePath: 'AGENTS.md' });
    expect(planManagedAsset(vault, pluginRoot, intent({ onAbsent: 'skip' }))).toBeUndefined();
  });

  test('merges marked blocks, preserves user bytes outside markers, and is idempotent', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    const current = [
      '# Project Rules',
      '',
      'Keep this exact text.',
      '',
      '<!-- me:managed:start configuration -->',
      '## Configuration',
      '',
      'old config',
      '<!-- me:managed:end configuration -->',
      '',
      'Trailing project rule.',
      '',
    ].join('\n');

    const first = mergeMeOwnedSections(current, desired, 'conflict');
    expect(first.content).toContain('# Project Rules\n\nKeep this exact text.');
    expect(first.content).toContain('Trailing project rule.\n');
    expect(first.content).not.toContain('old config');
    expect(markerIds(first.content)).toEqual(markerIds(desired));
    const second = mergeMeOwnedSections(first.content, desired, 'conflict');
    expect(second.content).toBe(first.content);
  });

  test('adopts exact legacy Claude content once', () => {
    const vault = makeVault();
    const legacy = fs.readFileSync(
      path.join(pluginRoot, 'templates/migration-history/0000/CLAUDE-template.md'),
    );
    writeAsset(vault, 'CLAUDE.md', legacy);
    const adoption = planManagedAsset(vault, pluginRoot, intent({
      knownTemplatePaths: ['templates/migration-history/0000/CLAUDE-template.md'],
      onUnmarked: 'append-marked-block',
    }));
    expect(adoption).toMatchObject({ kind: 'write-file', desiredMode: 0o644 });
    expect(adoption?.kind === 'write-file'
      && markerIds(adoption.desiredBytes.toString('utf8')))
      .toEqual(markerIds(fs.readFileSync(
        path.join(pluginRoot, 'templates/CLAUDE-template.md'),
        'utf8',
      )));

    fs.writeFileSync(
      path.join(vault, 'CLAUDE.md'),
      Buffer.concat([legacy, Buffer.from('\n## Project Rules\n\nKeep me.\n')]),
    );
    expectConflict(() => planManagedAsset(vault, pluginRoot, intent({
      knownTemplatePaths: ['templates/migration-history/0000/CLAUDE-template.md'],
      onUnmarked: 'append-marked-block',
    })));
  });

  test('adopt-known-legacy requires an exact known historical document', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    const legacy = fs.readFileSync(
      path.join(pluginRoot, 'templates/migration-history/0000/CLAUDE-template.md'),
      'utf8',
    );
    const merged = mergeMeOwnedSections(
      legacy,
      desired,
      'adopt-known-legacy',
      [legacy],
    );
    expect(merged.content).toBe(desired);
    expect(merged.adoptedLegacySections).toEqual(markerIds(desired));

    for (const modified of [
      legacy.replace(
        'No directional constraint.',
        'No directional constraint.\n\nCustom project body.',
      ),
      `${legacy}\n## Project Rules\n\nNever overwrite this.\n\n### Nested Rule\n`,
    ]) {
      expectConflict(() => mergeMeOwnedSections(
        modified,
        desired,
        'adopt-known-legacy',
        [legacy],
      ));
    }
  });

  test('explicitly adopts one complete legacy section set and preserves outside bytes', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/AGENTS-template.md'),
      'utf8',
    );
    const legacy = fs.readFileSync(
      path.join(pluginRoot, 'templates/migration-history/0000/CLAUDE-template.md'),
      'utf8',
    )
      .replaceAll('/me:', '$me:');
    const nestedRule = [
      '### Preserve Illustrations',
      '',
      'Keep this nested rule byte-for-byte.',
      '',
    ].join('\n');
    const projectRules = '\n## Project Rules\n\nKeep this byte-for-byte.\n';
    const withNestedRule = legacy.replace(
      '\n## Search\n',
      `\n${nestedRule}## Search\n`,
    );

    const adopted = mergeMeOwnedSections(
      `${withNestedRule}${projectRules}`,
      desired,
      'adopt-legacy-sections',
    );

    expect(markerIds(adopted.content)).toEqual(markerIds(desired));
    expect(adopted.adoptedLegacySections).toEqual(markerIds(desired));
    expect(adopted.content.endsWith(projectRules)).toBeTrue();
    expect(adopted.content).toContain(nestedRule);
    expect(adopted.content.indexOf('<!-- me:managed:end after-creating-a-note -->'))
      .toBeLessThan(adopted.content.indexOf('### Preserve Illustrations'));
    expect(adopted.content).not.toContain('/me:');

    expectConflict(() => mergeMeOwnedSections(
      `${legacy.replace('## Commands', '## User Commands')}${projectRules}`,
      desired,
      'adopt-legacy-sections',
    ));
  });

  test('appends the complete marked template without changing existing AGENTS bytes', () => {
    const vault = makeVault();
    const userBytes = Buffer.from(
      '# Project Build Rules\r\n\r\nKeep CRLF and every byte.\r\n',
    );
    writeAsset(vault, 'AGENTS.md', userBytes, 0o600);
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/AGENTS-template.md'),
      'utf8',
    );
    const appendIntent = intent({
      vaultRelativePath: 'AGENTS.md',
      desiredTemplatePath: 'templates/AGENTS-template.md',
    });
    const mutation = planManagedAsset(vault, pluginRoot, appendIntent);
    expect(mutation).toMatchObject({ kind: 'write-file', desiredMode: 0o600 });
    if (!mutation || mutation.kind !== 'write-file') throw new Error('expected write mutation');
    expect(mutation.desiredBytes.subarray(0, userBytes.length).equals(userBytes)).toBeTrue();
    expect(mutation.desiredBytes.toString('utf8').slice(userBytes.length)).toBe(`\n${desired}`);

    fs.writeFileSync(path.join(vault, 'AGENTS.md'), mutation.desiredBytes, { mode: 0o600 });
    expect(planManagedAsset(vault, pluginRoot, appendIntent)).toBeUndefined();
  });

  test('rejects unmarked conflicts instead of guessing ownership', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    for (const current of [
      '# Knowledge Base\n\nUser-authored but colliding.\n',
      '## Configuration\n\nOnly one legacy-looking heading.\n',
      '# Knowledge Base Extra\n\nPartial title.\n',
      '## Configuration:\n\nPunctuation must not bypass ownership collision.\n',
      '## Configuration {#vault}\n\nHeading attributes must fail closed.\n',
      '## Configuration <!-- local -->\n\nInline metadata must fail closed.\n',
    ]) {
      expectConflict(() => mergeMeOwnedSections(
        current,
        desired,
        'append-marked-block',
      ));
    }
    expectConflict(() => mergeMeOwnedSections(
      '# Unrelated\n',
      desired,
      'conflict',
    ));
  });

  test('rejects unclosed backtick and tilde fences deterministically before append or merge', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    const cases = [
      {
        current: '# Project Rules\n\n```md\n## Configuration\n',
        policy: 'append-marked-block' as const,
      },
      {
        current: [
          '<!-- me:managed:start configuration -->',
          '## Configuration',
          'old',
          '<!-- me:managed:end configuration -->',
          '',
          '~~~md',
          '## Commands',
          '',
        ].join('\n'),
        policy: 'conflict' as const,
      },
    ];
    for (const fixture of cases) {
      const action = () => mergeMeOwnedSections(
        fixture.current,
        desired,
        fixture.policy,
      );
      expectConflict(action);
      expectConflict(action);
    }
  });

  test('treats headings in closed fences and nested user headings as opaque', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/AGENTS-template.md'),
      'utf8',
    );
    const current = [
      '# Project Rules',
      '',
      '### Configuration',
      '',
      '```md',
      '## Configuration',
      '```',
      '',
      '~~~md',
      '# Knowledge Base',
      '~~~',
      '',
    ].join('\n');
    const merged = mergeMeOwnedSections(
      current,
      desired,
      'append-marked-block',
    );
    expect(merged.content.startsWith(current)).toBeTrue();
    expect(merged.content.slice(current.length)).toBe(`\n${desired}`);
  });

  test('rejects duplicate, nested, mismatched, and unknown markers', () => {
    const desired = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    const malformed = [
      [
        '<!-- me:managed:start configuration -->',
        'one',
        '<!-- me:managed:end configuration -->',
        '<!-- me:managed:start configuration -->',
        'two',
        '<!-- me:managed:end configuration -->',
      ].join('\n'),
      [
        '<!-- me:managed:start configuration -->',
        '<!-- me:managed:start commands -->',
        '<!-- me:managed:end commands -->',
        '<!-- me:managed:end configuration -->',
      ].join('\n'),
      [
        '<!-- me:managed:start configuration -->',
        'broken',
        '<!-- me:managed:end commands -->',
      ].join('\n'),
      '<!-- me:managed:end configuration -->\n',
      [
        '<!-- me:managed:start unknown-section -->',
        'owned?',
        '<!-- me:managed:end unknown-section -->',
      ].join('\n'),
    ];
    for (const current of malformed) {
      expectConflict(() => mergeMeOwnedSections(current, desired, 'conflict'));
    }
  });

  test('rejects traversal, absolute paths, symlinks, and non-regular targets', () => {
    const vault = makeVault();
    const outside = path.join(path.dirname(vault), 'outside.md');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(vault, 'CLAUDE.md'));
    expect(() => planManagedAsset(vault, pluginRoot, intent())).toThrow();

    fs.unlinkSync(path.join(vault, 'CLAUDE.md'));
    fs.mkdirSync(path.join(vault, 'CLAUDE.md'));
    expect(() => planManagedAsset(vault, pluginRoot, intent())).toThrow();

    for (const vaultRelativePath of ['../outside.md', '/absolute.md']) {
      expect(() => planManagedAsset(vault, pluginRoot, intent({ vaultRelativePath })))
        .toThrow();
    }
    expect(() => planManagedAsset(vault, pluginRoot, intent({
      desiredTemplatePath: '../outside.md',
    }))).toThrow();
  });
});

describe('Agent-neutral managed templates', () => {
  test('CLAUDE and AGENTS templates expose the same marker IDs and semantics', () => {
    const claude = fs.readFileSync(
      path.join(pluginRoot, 'templates/CLAUDE-template.md'),
      'utf8',
    );
    const agents = fs.readFileSync(
      path.join(pluginRoot, 'templates/AGENTS-template.md'),
      'utf8',
    );

    expect(markerIds(claude)).toEqual([
      'knowledge-base',
      'configuration',
      'layer-map',
      'commands',
      'note-templates',
      'after-creating-a-note',
      'search',
      'conventions',
    ]);
    expect(markerIds(agents)).toEqual(markerIds(claude));
    expect(claude).toContain('/me:setup');
    expect(claude).toContain('/me:ingest');
    expect(claude).not.toContain('$me:setup');
    expect(agents).toContain('$me:setup');
    expect(agents).toContain('$me:ingest');
    expect(agents).not.toContain('/me:setup');

    const normalizeCommands = (source: string): string => source
      .replaceAll('/me:', 'me:')
      .replaceAll('$me:', 'me:');
    expect(normalizeCommands(agents)).toBe(normalizeCommands(claude));
  });

  test('historical snapshots retain exact unmarked version-zero bytes', () => {
    const legacyClaude = fs.readFileSync(
      path.join(pluginRoot, 'templates/migration-history/0000/CLAUDE-template.md'),
      'utf8',
    );
    const legacySchema = fs.readFileSync(
      path.join(pluginRoot, 'templates/migration-history/0000/SCHEMA.md'),
      'utf8',
    );
    expect(legacyClaude).not.toContain('me:managed:start');
    expect(legacyClaude).toContain('/me:setup');
    expect(legacySchema).toBe(fs.readFileSync(
      path.join(pluginRoot, 'templates/SCHEMA.md'),
      'utf8',
    ));
    expect(fs.existsSync(
      path.join(pluginRoot, 'templates/migration-history/0000/AGENTS-template.md'),
    )).toBeFalse();
  });
});
