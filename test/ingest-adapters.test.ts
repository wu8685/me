import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { CommandResult, CommandRunner } from '../bin/ingest/command.ts';
import { createHtmlAdapter } from '../bin/ingest/adapters/html.ts';
import { createBilibiliAdapter } from '../bin/ingest/adapters/bilibili.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'ingest');
const BILI_URL = 'https://www.bilibili.com/video/BV1fixture';

function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function recordingRunner(result: Partial<CommandResult>): CommandRunner & {
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      return { stdout: '', stderr: '', status: 0, ...result };
    },
  };
}

function bilibiliFixtureRunner(): CommandRunner {
  return {
    run(_command, args) {
      const url = args.at(-1) ?? '';
      if (url.includes('/x/web-interface/view')) {
        return { stdout: fixtureText('bilibili-meta.json'), stderr: '', status: 0 };
      }
      if (url.includes('/x/player/v2')) {
        return {
          stdout: JSON.stringify({
            code: 0,
            data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://cdn.example.com/subtitles.json', ai_type: 0 }] } },
          }),
          stderr: '',
          status: 0,
        };
      }
      if (url === 'https://cdn.example.com/subtitles.json') {
        return { stdout: fixtureText('bilibili-subtitles.json'), stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command arguments: ${args.join(' ')}`);
    },
  };
}

test('passes an untrusted URL as one argv item', async () => {
  const runner = recordingRunner({ stdout: fixtureText('article.md') });
  await createHtmlAdapter(runner).extract({
    url: new URL('https://example.com/a?x=$(touch%20/tmp/pwn)'),
    vaultDir: '/tmp/v',
  });
  expect(runner.calls[0]).toEqual({
    command: 'defuddle',
    args: ['parse', 'https://example.com/a?x=$(touch%20/tmp/pwn)', '--md'],
  });
});

test('keeps article image blocks and media in Markdown order', async () => {
  const source = await createHtmlAdapter(recordingRunner({ stdout: fixtureText('article.md') })).extract({
    url: new URL('https://example.com/article'),
    vaultDir: '/tmp/v',
  });

  expect(source.blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'image', 'paragraph']);
  expect(source.blocks[2]).toMatchObject({ mediaId: 'image-001' });
  expect(source.media).toEqual([{ id: 'image-001', kind: 'image', url: 'https://cdn.example.com/chart.png', alt: 'A chart showing the result' }]);
});

test('keeps Bilibili CC as the preferred transcript', async () => {
  const source = await createBilibiliAdapter(bilibiliFixtureRunner()).extract({
    url: new URL(BILI_URL),
    vaultDir: '/tmp/v',
  });
  expect(source.transcript?.map((segment) => segment.text)).toContain('第一段字幕');
  expect(source.transcript?.[0]).toMatchObject({ start: 0.5, end: 2.0 });
  expect(source.warnings).not.toContain('needs-transcription');
});
