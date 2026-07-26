import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RuntimePathError,
  assertSafeRuntimePath,
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
  runtimeDisplayPath,
  runtimeLexicalDisplayPath,
} from '../bin/runtime-paths';

describe('external runtime path resolution', () => {
  let fixtureRoot: string;
  let vault: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'me-runtime-test-'));
    vault = path.join(fixtureRoot, 'vault');
    fs.mkdirSync(vault);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('derives a deterministic sibling namespace without creating it', () => {
    const first = resolveRuntimeLayout(vault, {});
    const second = resolveRuntimeLayout(vault, {});
    const expectedBase = path.join(path.dirname(fs.realpathSync(vault)), '.me-runtime');

    expect(first.runtimeBase).toBe(expectedBase);
    expect(first.runtimeRoot).toBe(second.runtimeRoot);
    expect(path.dirname(first.runtimeRoot)).toBe(expectedBase);
    expect(path.basename(first.runtimeRoot)).toMatch(/^vault-[a-f0-9]{24}$/);
    expect(fs.existsSync(first.runtimeBase)).toBeFalse();
    expect(fs.existsSync(first.runtimeRoot)).toBeFalse();
  });

  test('uses an absolute host-local override and still appends a vault namespace', () => {
    const override = path.join(fixtureRoot, 'local-state');
    fs.mkdirSync(override);

    const layout = resolveRuntimeLayout(vault, { ME_RUNTIME_ROOT: override });

    expect(layout.runtimeBase).toBe(override);
    expect(path.dirname(layout.runtimeRoot)).toBe(override);
    expect(path.basename(layout.runtimeRoot)).toMatch(/^vault-[a-f0-9]{24}$/);
    expect(fs.readdirSync(override)).toEqual([]);
  });

  test('rejects relative, vault-contained, control-character, and symlink overrides', () => {
    const outside = path.join(fixtureRoot, 'outside');
    const linked = path.join(fixtureRoot, 'linked-state');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linked);

    const invalid = [
      'relative-state',
      path.join(vault, '.runtime'),
      `${outside}\u0000bad`,
      linked,
    ];

    for (const runtimeRoot of invalid) {
      try {
        resolveRuntimeLayout(vault, { ME_RUNTIME_ROOT: runtimeRoot });
        throw new Error(`accepted unsafe runtime root: ${runtimeRoot}`);
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimePathError);
        expect((error as RuntimePathError).code).toBe('UNSAFE_PATH');
      }
    }
  });

  test('contains runtime candidates and renders only runtime-relative public paths', () => {
    const layout = resolveRuntimeLayout(vault, {});
    const journal = path.join(layout.transactionDir, 'vault-write-op', 'journal.json');

    expect(() => assertSafeRuntimePath(layout, journal)).not.toThrow();
    expect(runtimeDisplayPath(layout, journal))
      .toBe('<ME_RUNTIME>/transactions/vault-write-op/journal.json');
    expect(() => assertSafeRuntimePath(layout, path.join(layout.runtimeRoot, '..', 'escape')))
      .toThrow(/UNSAFE_PATH/);
    expect(() => runtimeDisplayPath(layout, path.join(vault, 'note.md')))
      .toThrow(/UNSAFE_PATH/);
  });

  test('renders a lexically contained unsafe entry for recovery reporting', () => {
    const layout = resolveRuntimeLayout(vault, {});
    bootstrapRuntimeDirectories(layout, [layout.transactionDir]);
    const outside = path.join(fixtureRoot, 'foreign-journal');
    const linkedJournal = path.join(layout.transactionDir, 'journal.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, linkedJournal);

    expect(() => runtimeDisplayPath(layout, linkedJournal)).toThrow(/UNSAFE_PATH/);
    expect(runtimeLexicalDisplayPath(layout, linkedJournal))
      .toBe('<ME_RUNTIME>/transactions/journal.json');
  });

  test('bootstraps only requested contained directories with private permissions', () => {
    const layout = resolveRuntimeLayout(vault, {});

    bootstrapRuntimeDirectories(layout, [layout.lockDir, layout.inboxDir]);

    expect(fs.statSync(layout.runtimeBase).isDirectory()).toBeTrue();
    expect(fs.statSync(layout.runtimeRoot).isDirectory()).toBeTrue();
    expect(fs.statSync(layout.lockDir).isDirectory()).toBeTrue();
    expect(fs.statSync(layout.inboxDir).isDirectory()).toBeTrue();
    expect(fs.existsSync(layout.transactionDir)).toBeFalse();
    expect(fs.statSync(layout.runtimeRoot).mode & 0o077).toBe(0);
    expect(() => bootstrapRuntimeDirectories(layout, [path.join(layout.runtimeRoot, '..', 'escape')]))
      .toThrow(/UNSAFE_PATH/);
  });

  test('rejects a runtime prefix replaced by a symlink before bootstrap', () => {
    const layout = resolveRuntimeLayout(vault, {});
    const outside = path.join(fixtureRoot, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(layout.runtimeBase);
    fs.symlinkSync(outside, layout.runtimeRoot);

    expect(() => bootstrapRuntimeDirectories(layout, [layout.lockDir]))
      .toThrow(/UNSAFE_PATH/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
