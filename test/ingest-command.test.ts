import { expect, test } from 'bun:test';
import { defaultCommandRunner } from '../bin/ingest/command.ts';

test('redacts complete Authorization and Cookie credentials from default runner errors', () => {
  let message = '';
  try {
    defaultCommandRunner.run(process.execPath, [
      '-e',
      'console.error("Authorization: Bearer top-secret\\nCookie: sid=super-secret; theme=private\\nX-Token: token-secret"); process.exit(9)',
    ]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).not.toContain('top-secret');
  expect(message).not.toContain('super-secret');
  expect(message).not.toContain('private');
  expect(message).not.toContain('token-secret');
});
