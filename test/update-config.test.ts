import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { parseDocument } from 'yaml';
import {
  readVaultSchemaVersion,
  renderConfigEdits,
} from '../bin/update/config-document.ts';

const fixtures: string[] = [];

function fixtureConfig(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'me-update-config-'));
  const configPath = path.join(directory, 'config.yaml');
  fs.writeFileSync(configPath, source);
  fixtures.push(directory);
  return configPath;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe('readVaultSchemaVersion', () => {
  test('treats a missing version as legacy zero and rejects ambiguous yaml', () => {
    expect(readVaultSchemaVersion('layers:\n  raw: raw\n')).toBe(0);
    expect(() => readVaultSchemaVersion(
      'vault_schema_version: 0\nvault_schema_version: 1\n',
    )).toThrow(/INVALID_CONFIG/);
    expect(() => readVaultSchemaVersion('vault_schema_version: 1.5\n'))
      .toThrow(/INVALID_VAULT_SCHEMA_VERSION/);
  });

  test.each([
    'vault_schema_version: -1\n',
    'vault_schema_version: "1"\n',
    'vault_schema_version: null\n',
    `vault_schema_version: ${Number.MAX_SAFE_INTEGER + 1}\n`,
  ])('rejects an invalid schema version: %s', source => {
    expect(() => readVaultSchemaVersion(source))
      .toThrow(/INVALID_VAULT_SCHEMA_VERSION/);
  });

  test.each([
    '',
    '- raw\n- practices\n',
    'layers: [raw\n',
  ])('requires a valid mapping root: %s', source => {
    expect(() => readVaultSchemaVersion(source)).toThrow(/INVALID_CONFIG/);
  });
});

describe('renderConfigEdits', () => {
  test('adds the schema version while preserving comments and unknown keys', () => {
    const config = fixtureConfig([
      '# portable vault config',
      'layers:',
      '  raw: "knowledge/raw" # keep this comment',
      '  practices: "knowledge/practices"',
      '  cognition: "knowledge/cognition"',
      'custom:',
      '  keep: true',
      '',
    ].join('\n'));

    const result = renderConfigEdits(config, [{
      kind: 'set',
      path: ['vault_schema_version'],
      value: 1,
    }]);

    const rendered = result.desiredBytes.toString('utf8');
    expect(result.currentVersion).toBe(0);
    expect(rendered).toContain('# portable vault config');
    expect(rendered).toContain('raw: "knowledge/raw" # keep this comment');
    expect(rendered).toContain('custom:\n  keep: true');
    expect(parseDocument(rendered).get('vault_schema_version')).toBe(1);
  });

  test('sets, removes, and renames declared mapping paths without reordering siblings', () => {
    const source = [
      'vault_schema_version: 0',
      'layers:',
      '  raw: "knowledge/raw"',
      '  old_practices: "knowledge/practices" # preserve ownership note',
      '  cognition: "knowledge/cognition"',
      'custom:',
      '  remove_me: true',
      '  ordered_after: "yes"',
      '',
    ].join('\n');
    const config = fixtureConfig(source);

    const result = renderConfigEdits(config, [
      { kind: 'set', path: ['vault_schema_version'], value: 1 },
      { kind: 'rename', from: ['layers', 'old_practices'], to: ['layers', 'practices'] },
      { kind: 'remove', path: ['custom', 'remove_me'] },
      { kind: 'set', path: ['custom', 'providers'], value: ['mlx-whisper', 'whisper-cpp'] },
    ]);
    const rendered = result.desiredBytes.toString('utf8');
    const document = parseDocument(rendered);
    const parsed = document.toJS() as Record<string, Record<string, unknown>>;

    expect(document.getIn(['layers', 'old_practices'])).toBeUndefined();
    expect(document.getIn(['layers', 'practices'])).toBe('knowledge/practices');
    expect(document.getIn(['custom', 'remove_me'])).toBeUndefined();
    expect(document.getIn(['custom', 'ordered_after'])).toBe('yes');
    expect(parsed.custom.providers).toEqual(['mlx-whisper', 'whisper-cpp']);
    expect(rendered).toContain('practices: "knowledge/practices" # preserve ownership note');
    expect(rendered.indexOf('raw:')).toBeLessThan(rendered.indexOf('practices:'));
    expect(rendered.indexOf('practices:')).toBeLessThan(rendered.indexOf('cognition:'));
    expect(rendered.endsWith('\n')).toBeTrue();
  });

  test('returns exact source and desired bytes with their sha256 digests', () => {
    const source = 'layers:\n  raw: "raw"\n';
    const config = fixtureConfig(source);
    const result = renderConfigEdits(config, [{
      kind: 'set',
      path: ['vault_schema_version'],
      value: 1,
    }]);

    expect(result.sourceBytes.equals(Buffer.from(source))).toBeTrue();
    expect(result.sourceSha256).toBe(sha256(result.sourceBytes));
    expect(result.desiredSha256).toBe(sha256(result.desiredBytes));
    expect(result.sourceSha256).not.toBe(result.desiredSha256);
  });

  test('rejects a rename when its destination already exists', () => {
    const config = fixtureConfig([
      'layers:',
      '  old: "raw"',
      '  current: "practices"',
      '',
    ].join('\n'));

    expect(() => renderConfigEdits(config, [{
      kind: 'rename',
      from: ['layers', 'old'],
      to: ['layers', 'current'],
    }])).toThrow(/MIGRATION_CONFLICT/);
  });

  test('rejects undeclared or non-mapping paths with stable public errors', () => {
    const config = fixtureConfig('layers:\n  raw: "raw"\n');

    expect(() => renderConfigEdits(config, [{
      kind: 'set',
      path: [],
      value: 1,
    }])).toThrow(/INVALID_REQUEST/);
    expect(() => renderConfigEdits(config, [{
      kind: 'set',
      path: ['layers', 'raw', 'nested'],
      value: 1,
    }])).toThrow(/INVALID_CONFIG/);
    expect(() => renderConfigEdits(config, [{
      kind: 'rename',
      from: ['layers', 'missing'],
      to: ['layers', 'renamed'],
    }])).toThrow(/MIGRATION_CONFLICT/);
    expect(() => renderConfigEdits(config, [{
      kind: 'future-edit',
    } as never])).toThrow(/INVALID_REQUEST/);
  });

  test('renames collection values and preserves scalar meaning when value types change', () => {
    const config = fixtureConfig([
      'custom:',
      '  old_providers: [mlx-whisper, whisper-cpp] # keep provider note',
      '  enabled: true # keep enabled note',
      '',
    ].join('\n'));

    const result = renderConfigEdits(config, [
      {
        kind: 'rename',
        from: ['custom', 'old_providers'],
        to: ['custom', 'providers'],
      },
      { kind: 'set', path: ['custom', 'enabled'], value: 'true' },
    ]);
    const rendered = result.desiredBytes.toString('utf8');
    const parsed = parseDocument(rendered).toJS();

    expect(parsed.custom.providers).toEqual(['mlx-whisper', 'whisper-cpp']);
    expect(parsed.custom.enabled).toBe('true');
    expect(rendered).toContain('providers: [ mlx-whisper, whisper-cpp ] # keep provider note');
    expect(rendered).toContain('enabled: "true" # keep enabled note');
  });
});
