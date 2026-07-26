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
import { UpdateError, type UpdateErrorCode } from '../bin/update/contracts.ts';

const fixtures: string[] = [];

function fixtureConfig(source: string): string {
  return fixtureBytes(Buffer.from(source));
}

function fixtureBytes(source: Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'me-update-config-'));
  const configPath = path.join(directory, 'config.yaml');
  fs.writeFileSync(configPath, source);
  fixtures.push(directory);
  return configPath;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectStableError(action: () => unknown, code: UpdateErrorCode): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UpdateError);
  expect((thrown as UpdateError).code).toBe(code);
  expect((thrown as UpdateError).message).toStartWith(`${code}:`);
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

  test.each([
    [
      'alias mapping key',
      'schema_key: &schema_key vault_schema_version\n*schema_key: 1\n',
    ],
    [
      'complex sequence key',
      '? [vault_schema_version]\n: 1\n',
    ],
    [
      'merge key',
      'defaults: &defaults\n  vault_schema_version: 1\n<<: *defaults\n',
    ],
    [
      'semantic duplicate scalar keys',
      'custom:\n  1: first\n  01: second\n',
    ],
    [
      'nested duplicate keys',
      'custom:\n  keep: first\n  keep: second\n',
    ],
  ])('rejects ambiguous YAML with %s', (_label, source) => {
    expectStableError(
      () => readVaultSchemaVersion(source),
      'INVALID_CONFIG',
    );
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

  test('accepts every public set value including empty strings and string arrays', () => {
    const config = fixtureConfig([
      'custom:',
      '  replace: original',
      '',
    ].join('\n'));

    const result = renderConfigEdits(config, [
      { kind: 'set', path: ['custom', 'empty_string'], value: '' },
      { kind: 'set', path: ['custom', 'empty_array'], value: [] },
      { kind: 'set', path: ['custom', 'empty_elements'], value: ['', 'kept', ''] },
      { kind: 'set', path: ['custom', 'positive_infinity'], value: Number.POSITIVE_INFINITY },
      { kind: 'set', path: ['custom', 'not_a_number'], value: Number.NaN },
    ]);
    const parsed = parseDocument(result.desiredBytes.toString('utf8')).toJS();

    expect(parsed.custom.empty_string).toBe('');
    expect(parsed.custom.empty_array).toEqual([]);
    expect(parsed.custom.empty_elements).toEqual(['', 'kept', '']);
    expect(parsed.custom.positive_infinity).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(parsed.custom.not_a_number)).toBeTrue();
  });

  test('preserves a quoted literal merge-looking key as unknown config', () => {
    const config = fixtureConfig([
      '"<<": literal-key',
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

    expect(rendered).toContain('"<<"');
    expect(parseDocument(rendered).get('<<')).toBe('literal-key');
    expect(parseDocument(rendered).get('vault_schema_version')).toBe(1);
  });

  test('verifies the final state after repeated set and set then remove edits', () => {
    const config = fixtureConfig('custom:\n  keep: original\n');

    const result = renderConfigEdits(config, [
      { kind: 'set', path: ['custom', 'keep'], value: 'first' },
      { kind: 'set', path: ['custom', 'keep'], value: 'final' },
      { kind: 'set', path: ['custom', 'temporary'], value: 'remove-me' },
      { kind: 'remove', path: ['custom', 'temporary'] },
    ]);
    const document = parseDocument(result.desiredBytes.toString('utf8'));

    expect(document.getIn(['custom', 'keep'])).toBe('final');
    expect(document.getIn(['custom', 'temporary'])).toBeUndefined();
  });

  test('verifies the final state of a rename chain', () => {
    const config = fixtureConfig('custom:\n  first: "preserved" # keep chain note\n');

    const result = renderConfigEdits(config, [
      {
        kind: 'rename',
        from: ['custom', 'first'],
        to: ['custom', 'second'],
      },
      {
        kind: 'rename',
        from: ['custom', 'second'],
        to: ['custom', 'third'],
      },
    ]);
    const rendered = result.desiredBytes.toString('utf8');
    const document = parseDocument(rendered);

    expect(document.getIn(['custom', 'first'])).toBeUndefined();
    expect(document.getIn(['custom', 'second'])).toBeUndefined();
    expect(document.getIn(['custom', 'third'])).toBe('preserved');
    expect(rendered).toContain('third: "preserved" # keep chain note');
  });

  test.each([
    {
      label: 'identical paths',
      edit: { kind: 'rename', from: ['custom'], to: ['custom'] },
    },
    {
      label: 'source is an ancestor of destination',
      edit: { kind: 'rename', from: ['custom'], to: ['custom', 'moved'] },
    },
    {
      label: 'destination is an ancestor of source',
      edit: { kind: 'rename', from: ['custom', 'child'], to: ['custom'] },
    },
  ])('rejects overlapping rename paths before mutation: $label', ({ edit }) => {
    const source = 'custom:\n  child:\n    keep: true\n';
    const config = fixtureConfig(source);

    expectStableError(
      () => renderConfigEdits(config, [edit as never]),
      'INVALID_REQUEST',
    );
    expect(fs.readFileSync(config, 'utf8')).toBe(source);
  });

  test.each([
    [
      'alias-valued source',
      'shared: &shared [one, two]\ncustom:\n  source: *shared\n',
    ],
    [
      'anchored source',
      'custom:\n  source: &source\n    keep: true\n',
    ],
    [
      'recursive alias graph',
      'custom: &custom\n  self: *custom\n',
    ],
  ])('fails closed for rename involving an unsupported %s', (_label, source) => {
    const config = fixtureConfig(source);
    expectStableError(
      () => renderConfigEdits(config, [{
        kind: 'rename',
        from: ['custom', 'source'],
        to: ['custom', 'destination'],
      }]),
      'INVALID_CONFIG',
    );
  });

  test.each([
    ['null edit', null],
    ['missing discriminant', {}],
    ['unknown discriminant', { kind: 'future', path: ['custom'] }],
    ['path is not an array', { kind: 'set', path: 'custom', value: true }],
    ['empty path', { kind: 'set', path: [], value: true }],
    ['empty path component', { kind: 'set', path: [''], value: true }],
    ['non-string path component', { kind: 'set', path: ['custom', 1], value: true }],
    ['null value', { kind: 'set', path: ['custom'], value: null }],
    ['object value', { kind: 'set', path: ['custom'], value: { keep: true } }],
    ['non-string array element', { kind: 'set', path: ['custom'], value: ['ok', 1] }],
    ['set extra field', { kind: 'set', path: ['custom'], value: true, extra: true }],
    ['remove extra field', { kind: 'remove', path: ['custom'], value: true }],
    [
      'rename extra field',
      { kind: 'rename', from: ['custom'], to: ['moved'], extra: true },
    ],
    ['rename missing from', { kind: 'rename', to: ['moved'] }],
  ])('rejects runtime-invalid ConfigEdit: %s', (_label, edit) => {
    const config = fixtureConfig('custom:\n  keep: true\n');
    expectStableError(
      () => renderConfigEdits(config, [edit as never]),
      'INVALID_REQUEST',
    );
  });

  test.each([
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects an invalid desired vault schema version: %s', value => {
    const config = fixtureConfig('custom:\n  keep: true\n');
    expectStableError(
      () => renderConfigEdits(config, [{
        kind: 'set',
        path: ['vault_schema_version'],
        value,
      }]),
      'INVALID_VAULT_SCHEMA_VERSION',
    );
  });

  test('revalidates a schema version introduced by rename', () => {
    const config = fixtureConfig('legacy_version: -1\ncustom:\n  keep: true\n');
    expectStableError(
      () => renderConfigEdits(config, [{
        kind: 'rename',
        from: ['legacy_version'],
        to: ['vault_schema_version'],
      }]),
      'INVALID_VAULT_SCHEMA_VERSION',
    );
  });

  test.each([
    Buffer.from([0x63, 0x75, 0x73, 0x74, 0x6f, 0x6d, 0x3a, 0x20, 0xc3, 0x28]),
    Buffer.from([0x76, 0x61, 0x75, 0x6c, 0x74, 0x3a, 0x20, 0xe2, 0x82]),
    Buffer.from([0x80, 0x0a]),
  ])('rejects invalid UTF-8 bytes without rewriting the source', source => {
    const config = fixtureBytes(source);
    expectStableError(
      () => renderConfigEdits(config, [{
        kind: 'set',
        path: ['vault_schema_version'],
        value: 1,
      }]),
      'INVALID_CONFIG',
    );
    expect(fs.readFileSync(config).equals(source)).toBeTrue();
  });

  test('preserves a valid UTF-8 BOM in desired bytes', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const source = Buffer.concat([
      bom,
      Buffer.from('custom:\n  keep: true\n', 'utf8'),
    ]);
    const config = fixtureBytes(source);

    const result = renderConfigEdits(config, [{
      kind: 'set',
      path: ['vault_schema_version'],
      value: 1,
    }]);

    expect(result.sourceBytes.equals(source)).toBeTrue();
    expect(result.desiredBytes.subarray(0, bom.length).equals(bom)).toBeTrue();
    expect(result.desiredBytes.subarray(bom.length, bom.length * 2).equals(bom))
      .toBeFalse();
    expect(readVaultSchemaVersion(
      result.desiredBytes.subarray(bom.length).toString('utf8'),
    )).toBe(1);
  });
});
