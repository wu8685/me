import { describe, expect, test } from 'bun:test';
import {
  parseVaultWriteRequest,
  WRITER_ERROR_CATALOG,
} from '../bin/vault-write/contracts.ts';

const markdown = [
  '---',
  'title: "Orchid Choice"',
  'created: 2026-07-26',
  'tags: ["decision"]',
  'type: reflection',
  'source: "[[raw/2026-07-25-orchid-source]]"',
  'project: ""',
  '---',
  '',
  'Choose the reversible pilot.',
  '',
].join('\n');

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    layer: 'practices',
    relativePath: 'decisions/2026-07-26-orchid-choice.md',
    markdown,
    index: { mode: 'auto' },
    ...overrides,
  };
}

function expectInvalid(value: unknown): void {
  expect(() => parseVaultWriteRequest(value))
    .toThrow('Request does not match vault-write v1.');
}

describe('parseVaultWriteRequest', () => {
  test('accepts the exact v1 request shape', () => {
    expect(parseVaultWriteRequest(request())).toEqual(request());
  });

  test('rejects unknown top-level and index fields', () => {
    expectInvalid(request({ future: true }));
    expectInvalid(request({ index: { mode: 'auto', future: true } }));
  });

  test('rejects unsupported versions, layers, index modes, and acknowledgement types', () => {
    expectInvalid(request({ version: 2 }));
    expectInvalid(request({ layer: 'archive' }));
    expectInvalid(request({ index: { mode: 'manual' } }));
    expectInvalid(request({ acknowledgeCognition: 'true' }));
  });

  test('rejects non-string, empty, and over-4-MiB markdown', () => {
    expectInvalid(request({ markdown: 42 }));
    expectInvalid(request({ markdown: '' }));
    expectInvalid(request({ markdown: ' \n\t' }));
    expectInvalid(request({ markdown: 'a'.repeat((4 * 1024 * 1024) + 1) }));
    expect(parseVaultWriteRequest(request({ markdown: 'a'.repeat(4 * 1024 * 1024) })).markdown)
      .toHaveLength(4 * 1024 * 1024);
  });

  test('requires explicit acknowledgement for cognition', () => {
    expectInvalid(request({ layer: 'cognition' }));
    expectInvalid(request({ layer: 'cognition', acknowledgeCognition: false }));
    expect(parseVaultWriteRequest(request({
      layer: 'cognition',
      acknowledgeCognition: true,
    }))).toMatchObject({ layer: 'cognition', acknowledgeCognition: true });
  });

  test.each([
    '../x.md',
    '/x.md',
    'a\\b.md',
    'a//2026-07-26-x.md',
    './2026-07-26-x.md',
    'a/../2026-07-26-x.md',
    'a/\u0000/2026-07-26-x.md',
    'a/\u001f/2026-07-26-x.md',
    'C:/vault/2026-07-26-x.md',
    'C:\\vault\\2026-07-26-x.md',
    '\\\\server\\share\\2026-07-26-x.md',
    '//server/share/2026-07-26-x.md',
  ])('rejects unsafe relative path %s', relativePath => {
    expectInvalid(request({ relativePath }));
  });

  test.each([
    '2026-07-26-orchid-choice.txt',
    'orchid-choice.md',
    '2026-07-26-orchid--choice.md',
    '2026-07-26-Orchid-choice.md',
    '2026-07-26--orchid.md',
    '2026-07-26-orchid-.md',
    '2026-07-26-兰花.md',
  ])('rejects invalid note basename %s', relativePath => {
    expectInvalid(request({ relativePath }));
  });

  test('does not infer frontmatter created during request parsing', () => {
    const accepted = parseVaultWriteRequest(request({
      markdown: markdown.replace('created: 2026-07-26', 'created: 1999-01-01'),
    }));
    expect(accepted.relativePath).toBe('decisions/2026-07-26-orchid-choice.md');
  });
});

describe('WRITER_ERROR_CATALOG', () => {
  test('provides the single exact public mapping', () => {
    expect(WRITER_ERROR_CATALOG).toEqual({
      INVALID_REQUEST: { status: 'validation_failed', exitCode: 2, message: 'Request does not match vault-write v1.' },
      INVALID_CONFIG: { status: 'validation_failed', exitCode: 2, message: 'Vault layer configuration is invalid.' },
      UNSAFE_PATH: { status: 'validation_failed', exitCode: 2, message: 'A required path is outside the safe vault layout.' },
      UNSUPPORTED_SCHEMA: { status: 'validation_failed', exitCode: 2, message: 'Vault schema revision is not supported by this ME version.' },
      INVALID_NOTE: { status: 'validation_failed', exitCode: 2, message: 'Note does not match the selected schema profile.' },
      DUPLICATE_STEM: { status: 'conflict', exitCode: 3, message: 'A note with this stem already exists.' },
      TARGET_EXISTS: { status: 'conflict', exitCode: 3, message: 'The requested target already exists.' },
      LOCK_HELD: { status: 'conflict', exitCode: 3, message: 'Another vault-write operation may still be active.' },
      INPUT_CHANGED: { status: 'conflict', exitCode: 3, message: 'Vault inputs changed after planning; nothing new was published.' },
      UNSUPPORTED_FILESYSTEM: { status: 'unsupported', exitCode: 5, message: 'Filesystem cannot provide the required no-clobber primitive.' },
      POST_VALIDATION_FAILED: { status: 'validation_failed', exitCode: 2, message: 'Post-write validation failed and owned changes were restored.' },
      INCOMPLETE_OPERATION: { status: 'manual_recovery', exitCode: 4, message: 'One or more incomplete operations require inspection.' },
      RECOVERY_REQUIRED: { status: 'manual_recovery', exitCode: 4, message: 'Conflicting content was preserved; manual recovery is required.' },
      LEGACY_RUNTIME_STATE: { status: 'manual_recovery', exitCode: 4, message: 'Vault-local ME 1.5 runtime state requires inspection.' },
      INTERNAL_ERROR: { status: 'validation_failed', exitCode: 1, message: 'Vault write could not complete safely.' },
    });
    expect(Object.isFrozen(WRITER_ERROR_CATALOG)).toBeTrue();
  });
});
