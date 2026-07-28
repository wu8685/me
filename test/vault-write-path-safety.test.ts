import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertSafeWriterPath,
  detectLegacyVaultWriterState,
  resolveVaultLayout,
  resolveWriteTarget,
  vaultRelative,
} from '../bin/vault-write/path-safety.ts';
import { parseVaultWriteRequest } from '../bin/vault-write/contracts.ts';
import {
  assertSafeRuntimePath,
  bootstrapRuntimeDirectories,
} from '../bin/runtime-paths.ts';

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

function makeVault(config?: string, layerPaths = ['raw', 'practices', 'cognition']): string {
  const fixture = temporaryDirectory('me-vault-write-');
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'SCHEMA.md'), '# Schema\n');
  for (const layer of layerPaths) fs.mkdirSync(path.join(vault, layer), { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(vault, '.me', 'config.yaml'), config);
  return vault;
}

function validRequest(relativePath = 'decisions/2026-07-26-orchid-choice.md') {
  return parseVaultWriteRequest({
    version: 1,
    layer: 'practices',
    relativePath,
    markdown: 'body',
    index: { mode: 'auto' },
  });
}

function expectInvalidConfig(action: () => unknown): void {
  expect(action).toThrow('Vault layer configuration is invalid.');
}

function expectUnsafe(action: () => unknown): void {
  expect(action).toThrow('A required path is outside the safe vault layout.');
}

describe('resolveVaultLayout configuration', () => {
  test('uses defaults when config is missing', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    expect(layout.layers).toEqual({
      raw: path.join(vault, 'raw'),
      practices: path.join(vault, 'practices'),
      cognition: path.join(vault, 'cognition'),
    });
  });

  test('resolves custom layer roots without creating internal directories', () => {
    const config = [
      'layers:',
      '  raw: knowledge/raw',
      '  practices: "knowledge/practices"',
      "  cognition: 'knowledge/cognition'",
      'ingest:',
      '  default_video_mode: handout',
      '',
    ].join('\n');
    const vault = makeVault(config, [
      'knowledge/raw',
      'knowledge/practices',
      'knowledge/cognition',
    ]);
    const layout = resolveVaultLayout(vault);
    expect(layout.layers.practices).toBe(path.join(vault, 'knowledge/practices'));
    expect(layout.runtimeRoot.startsWith(`${vault}${path.sep}`)).toBeFalse();
    expect(fs.existsSync(layout.transactionDir)).toBeFalse();
    expect(fs.existsSync(layout.lockDir)).toBeFalse();
  });

  test.each([
    ['layers:\n  raw: ../outside\n', ['practices', 'cognition']],
    ['layers:\n  raw: /tmp/outside\n', ['practices', 'cognition']],
    ['layers:\n  raw: C:\\vault\\raw\n', ['practices', 'cognition']],
    ['layers:\n  raw: \\\\server\\share\n', ['practices', 'cognition']],
    ['layers:\n  raw: [raw]\n', ['practices', 'cognition']],
    ['layers:\n  raw: true\n', ['practices', 'cognition']],
    ['layers:\n  raw: raw\n  raw: raw2\n', ['raw', 'raw2', 'practices', 'cognition']],
    ['layers:\n  archive: archive\n', ['raw', 'practices', 'cognition', 'archive']],
    ['layers: {}\n', ['raw', 'practices', 'cognition']],
  ])('rejects invalid or ambiguous layer config %#', (config, dirs) => {
    const vault = makeVault(config, dirs);
    expectInvalidConfig(() => resolveVaultLayout(vault));
  });
});

describe('resolveVaultLayout containment matrices', () => {
  test.each([
    ['equal lexical roots', 'layers:\n  raw: shared\n  practices: shared\n', ['shared', 'cognition']],
    ['lexical ancestor roots', 'layers:\n  raw: knowledge\n  practices: knowledge/practices\n', ['knowledge', 'cognition']],
  ])('rejects %s', (_name, config, dirs) => {
    const vault = makeVault(config, dirs);
    expectInvalidConfig(() => resolveVaultLayout(vault));
  });

  test('rejects canonical equality and ancestry through contained symlinks', () => {
    const vault = makeVault(undefined, ['targets/raw', 'targets/practices', 'cognition']);
    fs.symlinkSync(path.join(vault, 'targets/raw'), path.join(vault, 'raw'));
    fs.symlinkSync(path.join(vault, 'targets/raw'), path.join(vault, 'practices'));
    expectInvalidConfig(() => resolveVaultLayout(vault));
  });

  test.each([
    ['layers:\n  raw: .\n', ['practices', 'cognition']],
    ['layers:\n  raw: .me\n', ['practices', 'cognition']],
    ['layers:\n  raw: .me/tmp\n', ['practices', 'cognition', '.me/tmp']],
    ['layers:\n  raw: SCHEMA.md\n', ['practices', 'cognition']],
  ])('rejects root and reserved overlap %#', (config, dirs) => {
    const vault = makeVault(config, dirs);
    expectInvalidConfig(() => resolveVaultLayout(vault));
  });

  test('accepts the intended external runtime nesting tree', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    bootstrapRuntimeDirectories(layout, [layout.transactionDir, layout.lockDir]);
    fs.mkdirSync(path.join(layout.transactionDir, 'vault-write-op/originals'), { recursive: true });
    fs.writeFileSync(path.join(layout.lockDir, 'vault.lock'), 'lock');
    assertSafeRuntimePath(layout, path.join(layout.transactionDir, 'vault-write-op/originals'));
    assertSafeRuntimePath(layout, path.join(layout.lockDir, 'vault.lock'));
    expect(path.relative(layout.transactionDir, layout.lockDir).startsWith('..')).toBeTrue();
    expect(fs.existsSync(path.join(vault, '.me/tmp'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, '.me/locks'))).toBeFalse();
  });
});

describe('resolveVaultLayout filesystem identity', () => {
  test('rejects a non-directory layer', () => {
    const vault = makeVault(undefined, ['raw', 'cognition']);
    fs.writeFileSync(path.join(vault, 'practices'), 'not a directory');
    expectInvalidConfig(() => resolveVaultLayout(vault));
  });

  test('rejects .me when it is a symlink', () => {
    const vault = temporaryDirectory('me-vault-write-link-');
    const internal = temporaryDirectory('me-vault-write-internal-');
    for (const layer of ['raw', 'practices', 'cognition']) {
      fs.mkdirSync(path.join(vault, layer));
    }
    fs.writeFileSync(path.join(vault, 'SCHEMA.md'), '# Schema\n');
    fs.symlinkSync(internal, path.join(vault, '.me'));
    expectUnsafe(() => resolveVaultLayout(vault));
  });

  test.each(['tmp', 'locks'])('rejects escaping and dangling legacy .me/%s symlinks', child => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-vault-write-outside-');
    fs.symlinkSync(outside, path.join(vault, '.me', child));
    const layout = resolveVaultLayout(vault);
    expectUnsafe(() => detectLegacyVaultWriterState(layout));

    fs.unlinkSync(path.join(vault, '.me', child));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(vault, '.me', child));
    expectUnsafe(() => detectLegacyVaultWriterState(layout));
  });

  test('allows empty legacy directories and reports every non-empty legacy entry', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    fs.mkdirSync(path.join(vault, '.me/tmp'));
    fs.mkdirSync(path.join(vault, '.me/locks'));
    expect(detectLegacyVaultWriterState(layout)).toEqual([]);

    fs.mkdirSync(path.join(vault, '.me/tmp/vault-write-old'));
    fs.writeFileSync(path.join(vault, '.me/locks/vault-write.lock'), 'legacy');
    expect(detectLegacyVaultWriterState(layout)).toEqual([
      '.me/locks/vault-write.lock',
      '.me/tmp/vault-write-old',
    ]);
  });

  test('rejects escaping config, schema, layer, and README symlinks', () => {
    for (const target of ['config', 'schema', 'layer', 'readme']) {
      const vault = makeVault();
      const outside = temporaryDirectory(`me-vault-write-${target}-`);
      const outsideFile = path.join(outside, 'outside');
      fs.writeFileSync(outsideFile, 'outside');
      if (target === 'config') {
        fs.symlinkSync(outsideFile, path.join(vault, '.me', 'config.yaml'));
      } else if (target === 'schema') {
        fs.unlinkSync(path.join(vault, 'SCHEMA.md'));
        fs.symlinkSync(outsideFile, path.join(vault, 'SCHEMA.md'));
      } else if (target === 'layer') {
        fs.rmSync(path.join(vault, 'practices'), { recursive: true });
        fs.symlinkSync(outside, path.join(vault, 'practices'));
      } else {
        fs.symlinkSync(outsideFile, path.join(vault, 'practices', 'README.md'));
      }
      expectUnsafe(() => {
        const layout = resolveVaultLayout(vault);
        resolveWriteTarget(layout, validRequest());
      });
    }
  });

  test('rejects dangling layer and README symlinks', () => {
    const vault = makeVault();
    fs.rmSync(path.join(vault, 'practices'), { recursive: true });
    fs.symlinkSync(path.join(vault, 'missing-layer'), path.join(vault, 'practices'));
    expectUnsafe(() => resolveVaultLayout(vault));

    const second = makeVault();
    fs.symlinkSync(path.join(second, 'missing-readme'), path.join(second, 'practices', 'README.md'));
    expectUnsafe(() => resolveVaultLayout(second));
  });

  test('accepts a symlinked vault root and retains lexical/canonical pairing', () => {
    const realVault = makeVault();
    const parent = temporaryDirectory('me-vault-write-root-link-');
    const linkedVault = path.join(parent, 'vault');
    fs.symlinkSync(realVault, linkedVault);
    const layout = resolveVaultLayout(linkedVault);
    expect(layout.lexicalVault).toBe(path.resolve(linkedVault));
    expect(layout.canonicalVault).toBe(fs.realpathSync(realVault));
    expect(layout.lexicalVault).not.toBe(layout.canonicalVault);
  });
});

describe('writer path and target resolution', () => {
  test('accepts a nonexistent target after canonicalizing its deepest existing ancestor', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    const target = resolveWriteTarget(layout, validRequest('nested/deeper/2026-07-26-orchid.md'));
    expect(target).toEqual({
      layerRoot: path.join(vault, 'practices'),
      notePath: path.join(vault, 'practices/nested/deeper/2026-07-26-orchid.md'),
      vaultRelativePath: 'practices/nested/deeper/2026-07-26-orchid.md',
      stem: '2026-07-26-orchid',
      indexPath: path.join(vault, 'practices/README.md'),
    });
  });

  test('rejects a target whose existing parent symlink escapes', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-vault-write-outside-');
    fs.symlinkSync(outside, path.join(vault, 'practices', 'decisions'));
    const layout = resolveVaultLayout(vault);
    expectUnsafe(() => resolveWriteTarget(layout, validRequest()));
  });

  test('reports the fixed target collision without overwriting it', () => {
    const vault = makeVault();
    const existing = path.join(vault, 'practices/decisions/2026-07-26-orchid-choice.md');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'existing bytes');
    const layout = resolveVaultLayout(vault);

    expect(() => resolveWriteTarget(layout, validRequest()))
      .toThrow('The requested target already exists.');
    expect(fs.readFileSync(existing, 'utf8')).toBe('existing bytes');
  });

  test('returns only contained POSIX vault-relative paths', () => {
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    expect(vaultRelative(layout, path.join(vault, 'practices/deep/note.md')))
      .toBe('practices/deep/note.md');
    expect(vaultRelative(layout, layout.lexicalVault)).toBe('.');
    expectUnsafe(() => vaultRelative(layout, path.dirname(vault)));
    expect(vaultRelative(layout, path.join(vault, 'practices/deep/note.md')))
      .not.toContain('\\');
  });
});
