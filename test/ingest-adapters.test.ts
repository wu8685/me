import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import type { CommandResult, CommandRunner } from '../bin/ingest/command.ts';
import { createHtmlAdapter } from '../bin/ingest/adapters/html.ts';
import { createBilibiliAdapter } from '../bin/ingest/adapters/bilibili.ts';
import { extractContent, transcribeBilibili } from '../bin/ingest.ts';

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

test('projects inline Markdown images through the extractContent compatibility wrapper', () => {
  const result = extractContent('https://example.com/article', undefined, recordingRunner({
    stdout: '# Inline image\n\nBefore ![inline chart](https://cdn.example.com/inline.png) after\n',
  }));

  expect(result.images).toEqual(['https://cdn.example.com/inline.png']);
  expect(result.content).toContain('Before ![inline chart](https://cdn.example.com/inline.png) after');
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

test('marks transcribe mode as incomplete when no transcription provider exists', async () => {
  const source = await createBilibiliAdapter(bilibiliWithoutCcRunner()).extract({
    url: new URL(BILI_URL), vaultDir: '/tmp/v', mode: 'transcribe',
  });

  expect(source.warnings).toContain('needs-transcription');
  expect(source.warnings).toContain('transcription-unavailable');
});

test('marks transcribe mode as incomplete when its provider returns no transcript', async () => {
  const source = await createBilibiliAdapter(bilibiliWithoutCcRunner(), {
    transcribe: () => '', transcriptionAvailable: () => true,
  }).extract({ url: new URL(BILI_URL), vaultDir: '/tmp/v', mode: 'transcribe' });

  expect(source.warnings).toContain('needs-transcription');
  expect(source.warnings).toContain('transcription-empty');
});

test('accepts a non-empty transcribe provider result as a transcript', async () => {
  const source = await createBilibiliAdapter(bilibiliWithoutCcRunner(), {
    transcribe: () => '自动转写内容', transcriptionAvailable: () => true,
  }).extract({ url: new URL(BILI_URL), vaultDir: '/tmp/v', mode: 'transcribe' });

  expect(source.warnings).not.toContain('needs-transcription');
  expect(source.transcript).toEqual([{ start: 0, end: 42, text: '自动转写内容' }]);
});

test('offsets Bilibili multi-page captions into a single ordered timeline', async () => {
  const source = await createBilibiliAdapter(twoPageBilibiliRunner()).extract({
    url: new URL(BILI_URL), vaultDir: '/tmp/v',
  });

  expect(source.transcript).toEqual([
    { start: 0, end: 3, text: 'P1 字幕' },
    { start: 10, end: 12, text: 'P2 字幕' },
  ]);
});

test('passes a transcribe URL as one argv item at the public transcription boundary', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    run(command, args) {
      calls.push({ command, args });
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      throw new Error('stop after yt-dlp invocation');
    },
  };
  const url = 'https://www.bilibili.com/video/BV1fixture?x=$(touch%20/tmp/pwn)';

  expect(() => transcribeBilibili(url, 123, '/tmp/transcribe-safe', runner)).toThrow('stop after yt-dlp invocation');
  expect(calls).toContainEqual({
    command: '/safe/bin/tool',
    args: ['-x', '--audio-format', 'wav', '-o', '/tmp/transcribe-safe/audio-123.%(ext)s', url],
  });
});

test('forwards the supplied runner through the extractContent Bilibili compatibility wrapper', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    run(command, args) {
      calls.push({ command, args });
      const url = args.at(-1) ?? '';
      if (url.includes('/x/web-interface/view')) return { stdout: fixtureText('bilibili-meta.json'), stderr: '', status: 0 };
      if (url.includes('/x/player/v2')) return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), stderr: '', status: 0 };
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      throw new Error('stop after wrapped yt-dlp invocation');
    },
  };
  const url = 'https://www.bilibili.com/video/BV1fixture?x=$(touch%20/tmp/pwn)';

  expect(() => extractContent(url, { mode: 'transcribe' }, runner)).toThrow('stop after wrapped yt-dlp invocation');
  expect(calls).toContainEqual({
    command: '/safe/bin/tool',
    args: ['-x', '--audio-format', 'wav', '-o', expect.any(String), url],
  });
});

function bilibiliWithoutCcRunner(): CommandRunner {
  return {
    run(_command, args) {
      const url = args.at(-1) ?? '';
      if (url.includes('/x/web-interface/view')) {
        return { stdout: fixtureText('bilibili-meta.json'), stderr: '', status: 0 };
      }
      if (url.includes('/x/player/v2')) {
        return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command arguments: ${args.join(' ')}`);
    },
  };
}

function twoPageBilibiliRunner(): CommandRunner {
  const meta = JSON.parse(fixtureText('bilibili-meta.json'));
  meta.data.pages = [
    { cid: 101, page: 1, part: 'P1', duration: 10 },
    { cid: 202, page: 2, part: 'P2', duration: 20 },
  ];
  return {
    run(_command, args) {
      const url = args.at(-1) ?? '';
      if (url.includes('/x/web-interface/view')) return { stdout: JSON.stringify(meta), stderr: '', status: 0 };
      if (url.includes('cid=101')) {
        return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://cdn.example.com/p1.json', ai_type: 0 }] } } }), stderr: '', status: 0 };
      }
      if (url.includes('cid=202')) {
        return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://cdn.example.com/p2.json', ai_type: 0 }] } } }), stderr: '', status: 0 };
      }
      if (url === 'https://cdn.example.com/p1.json') return { stdout: JSON.stringify({ body: [{ from: 0, to: 3, content: 'P1 字幕' }] }), stderr: '', status: 0 };
      if (url === 'https://cdn.example.com/p2.json') return { stdout: JSON.stringify({ body: [{ from: 0, to: 2, content: 'P2 字幕' }] }), stderr: '', status: 0 };
      throw new Error(`Unexpected command arguments: ${args.join(' ')}`);
    },
  };
}
