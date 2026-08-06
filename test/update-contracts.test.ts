import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import {
  UPDATE_ERROR_CATALOG,
  UpdateError,
  sanitizePublicUpdateResult,
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
    recoveryActions: [],
    preservedPaths: [],
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

  test('sanitizes structured recovery actions and preserved paths', () => {
    const privatePath = path.join(
      path.parse(process.cwd()).root,
      'private',
      'runtime',
      'journal.json',
    );
    const sanitized = sanitizePublicUpdateResult(result({
      status: 'recovery_required',
      recoveryState: 'manual',
      recoveryActions: [{
        kind: 'inspect',
        path: privatePath,
        description: `Inspect ${privatePath}`,
      }],
      preservedPaths: [privatePath, '<ME_RUNTIME>/transactions/op'],
    }));

    expect(sanitized.recoveryActions[0]).toEqual({
      kind: 'inspect',
      path: '<ABSOLUTE_PATH>',
      description: 'Inspect <ABSOLUTE_PATH>',
    });
    expect(sanitized.preservedPaths).toEqual([
      '<ABSOLUTE_PATH>',
      '<ME_RUNTIME>/transactions/op',
    ]);
  });

  test('redacts cross-platform, file URL, UNC, and punctuation-adjacent paths', () => {
    const sensitivePaths = [
      '/private/me-runtime/transactions/unix.json',
      'file:///private/me-runtime/transactions/file-url.json',
      'file:///C:/runtime/transactions/file-url-windows.json',
      'file://server/share/transactions/file-url-unc.json',
      'C:\\runtime\\transactions\\windows-backslash.json',
      'C:/runtime/transactions/windows-slash.json',
      '\\\\server\\share\\transactions\\unc-backslash.json',
      '//server/share/transactions/unc-slash.json',
      'file:/private/me-runtime/transactions/file-url-single-slash.json',
    ];
    const serialized = serializeUpdateResult(result({
      warnings: [
        `bracket=[${sensitivePaths[0]}]`,
        `colon:${sensitivePaths[0]}`,
        `url=${sensitivePaths[1]}`,
        `windows-url=${sensitivePaths[2]}`,
        `unc-url=${sensitivePaths[3]}`,
        `windows=(${sensitivePaths[4]})`,
        `windows-slash={${sensitivePaths[5]}}`,
        `unc=${sensitivePaths[6]}`,
        `unc-slash=${sensitivePaths[7]}`,
        `single-slash-url=${sensitivePaths[8]}`,
        'portable=<ME_RUNTIME>/transactions/public.json',
      ],
    }));

    for (const sensitivePath of sensitivePaths) {
      expect(serialized).not.toContain(sensitivePath);
    }
    expect(serialized).toContain('<ME_RUNTIME>/transactions/public.json');
    expect(serialized).toContain('<ABSOLUTE_PATH>');
  });

  test('redacts path tokens after angle brackets and arrows without consuming safe trailing text', () => {
    const serialized = serializeUpdateResult(result({
      warnings: [
        'arrow=>/private/me-runtime/transactions/arrow.json continue here',
        'html=<code>/private/me-runtime/transactions/html.json</code> preserved',
        'multi=///private/me-runtime/transactions/multi.json tail',
        'portable=<ME_RUNTIME>/transactions/public.json keep this text',
      ],
    }));
    const warnings = JSON.parse(serialized).warnings;

    expect(warnings).toEqual([
      'arrow=><ABSOLUTE_PATH> continue here',
      'html=<code><ABSOLUTE_PATH></code> preserved',
      'multi=<ABSOLUTE_PATH> tail',
      'portable=<ME_RUNTIME>/transactions/public.json keep this text',
    ]);
  });

  test('redacts complete angle-wrapped and quoted paths containing spaces', () => {
    const unixPath = [
      '',
      'Users',
      'alice',
      'ME Runtime',
      'journal.json',
    ].join('/');
    const serialized = serializeUpdateResult(result({
      warnings: [
        `angle-unix=<${unixPath}> after`,
        'angle-windows=<C:\\Users\\Alice\\ME Runtime\\journal.json> after',
        'angle-unc=<\\\\server\\share\\ME Runtime\\journal.json> after',
        `quoted-unix="${unixPath}" after`,
        "quoted-windows='C:\\Users\\Alice\\ME Runtime\\journal.json' after",
      ],
    }));
    const warnings = JSON.parse(serialized).warnings;

    expect(warnings).toEqual([
      'angle-unix=<ABSOLUTE_PATH> after',
      'angle-windows=<ABSOLUTE_PATH> after',
      'angle-unc=<ABSOLUTE_PATH> after',
      'quoted-unix="<ABSOLUTE_PATH>" after',
      "quoted-windows='<ABSOLUTE_PATH>' after",
    ]);
  });

  test('preserves ordinary non-file URI tokens exactly', () => {
    const uris = [
      'http://example.com/runtime/journal.json',
      'https://example.com/a/b?digest=abc#preview',
      'ssh://git@example.com/team/repository.git',
    ];
    const serialized = serializeUpdateResult(result({
      warnings: [
        `HTTP ${uris[0]} retained`,
        `HTTPS <${uris[1]}> retained`,
        `SSH "${uris[2]}" retained`,
      ],
    }));

    for (const uri of uris) expect(serialized).toContain(uri);
    expect(serialized).not.toContain('<ABSOLUTE_PATH>');
  });

  test('redacts slash-form Windows drive paths that resemble URI schemes', () => {
    const doubleSlash = 'C://runtime/transactions/double-slash.json';
    const tripleSlash = 'C:///runtime/transactions/triple-slash.json';
    const serialized = serializeUpdateResult(result({
      warnings: [
        `bare-double=${doubleSlash}`,
        `bare-triple=${tripleSlash}`,
        `quoted-double="${doubleSlash}"`,
        `quoted-triple='${tripleSlash}'`,
        `angle-double=<${doubleSlash}>`,
        `angle-triple=<${tripleSlash}>`,
      ],
    }));
    const warnings = JSON.parse(serialized).warnings;

    expect(warnings).toEqual([
      'bare-double=<ABSOLUTE_PATH>',
      'bare-triple=<ABSOLUTE_PATH>',
      'quoted-double="<ABSOLUTE_PATH>"',
      "quoted-triple='<ABSOLUTE_PATH>'",
      'angle-double=<ABSOLUTE_PATH>',
      'angle-triple=<ABSOLUTE_PATH>',
    ]);
    expect(serialized).not.toContain(doubleSlash);
    expect(serialized).not.toContain(tripleSlash);
  });

  test('redacts a nested file URL before preserving its ordinary outer URI', () => {
    const privatePath = [
      '',
      'Users',
      'alice',
      'ME-Runtime',
      'journal.json',
    ].join('/');
    const nested = `https://example.test/redirect?next=file://${privatePath}&keep=public`;
    const serialized = serializeUpdateResult(result({
      warnings: [nested],
    }));

    expect(JSON.parse(serialized).warnings).toEqual([
      'https://example.test/redirect?next=<ABSOLUTE_PATH>&keep=public',
    ]);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).toContain('https://example.test/redirect?next=');
  });

  test('recognizes nested file URI delimiters without matching composite schemes', () => {
    const privatePath = [
      '',
      'Users',
      'alice',
      'vault',
      'secret.json',
    ].join('/');
    const unsafe = [
      `https://example.test/?next=/file://${privatePath}&keep=public`,
      `/path/file://${privatePath}`,
      `prefix:file://${privatePath}`,
    ];
    const safeSchemes = [
      'x-file://example.test/resource',
      'my.file://example.test/resource',
      'git+file://example.test/resource',
    ];
    const serialized = serializeUpdateResult(result({
      warnings: [...unsafe, ...safeSchemes],
    }));
    const warnings = JSON.parse(serialized).warnings as string[];

    for (const warning of warnings.slice(0, unsafe.length)) {
      expect(warning).not.toContain(privatePath);
      expect(warning).toContain('<ABSOLUTE_PATH>');
    }
    expect(warnings.slice(unsafe.length)).toEqual(safeSchemes);
    expect(serialized).not.toContain(privatePath);
  });

  test('preserves only explicit ME slash-command grammar while redacting paths', () => {
    const privatePath = [
      '',
      'Users',
      'alice',
      'vault',
      'secret.md',
    ].join('/');
    const serialized = serializeUpdateResult(result({
      diffs: [{
        path: 'CLAUDE.md',
        diff: [
          '`/me:setup`',
          '`/me:ingest <url>`',
          '`/me:checklinks raw`',
          '`/me:update`',
          `/ordinary/path ${privatePath}`,
        ].join('\n'),
      }],
    }));
    const diff = JSON.parse(serialized).diffs[0].diff;

    expect(diff).toContain('`/me:setup`');
    expect(diff).toContain('`/me:ingest <url>`');
    expect(diff).toContain('`/me:checklinks raw`');
    expect(diff).toContain('`/me:update`');
    expect(diff).not.toContain('/ordinary/path');
    expect(diff).not.toContain(privatePath);
    expect(diff.match(/<ABSOLUTE_PATH>/g)?.length).toBe(2);
  });

  test('sanitizes the in-memory public result recursively and removes binary values', () => {
    const privatePath = [
      '',
      'private',
      'me-runtime',
      'transactions',
      'secret.json',
    ].join('/');
    const unsafe = result({
      warnings: [
        `warning ${privatePath}`,
        Buffer.from(privatePath) as unknown as string,
      ],
      conflicts: [{
        path: 'SCHEMA.md',
        reason: `conflict ${privatePath}`,
      }],
      diffs: [{
        path: 'CLAUDE.md',
        diff: `/me:setup\n${privatePath}`,
      }],
      error: {
        code: 'INTERNAL_ERROR',
        message: `failure ${privatePath}`,
      },
    });
    const sanitized = sanitizePublicUpdateResult(unsafe);

    expect(JSON.stringify(sanitized)).not.toContain(privatePath);
    expect(sanitized.warnings).toEqual([
      'warning <ABSOLUTE_PATH>',
      '<BINARY_DATA>',
    ]);
    expect(sanitized.diffs[0].diff).toBe('/me:setup\n<ABSOLUTE_PATH>');
    expect(sanitized.conflicts[0].reason).toBe('conflict <ABSOLUTE_PATH>');
    expect(sanitized.error?.message).toBe('failure <ABSOLUTE_PATH>');
    expect(Buffer.isBuffer(sanitized.warnings[1])).toBeFalse();
  });
});
