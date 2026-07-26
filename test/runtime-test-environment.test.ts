import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRuntimeLayout } from '../bin/runtime-paths.ts';

test('isolates test runtime mutations from the real user home', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'me-runtime-isolation-'));
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  try {
    const layout = resolveRuntimeLayout(vault);
    expect(layout.runtimeBase.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)).toBeTrue();
    expect(layout.runtimeBase).not.toBe(path.join(os.homedir(), '.me', 'runtime'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
