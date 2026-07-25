import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandResult, CommandRunner } from '../bin/ingest/command.ts';
import { createHtmlAdapter } from '../bin/ingest/adapters/html.ts';
import { createBilibiliAdapter } from '../bin/ingest/adapters/bilibili.ts';
import { createPdfAdapter, parsePdftohtmlXml } from '../bin/ingest/adapters/pdf.ts';
import { extractContent, transcribeBilibili } from '../bin/ingest.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'ingest');
const BILI_URL = 'https://www.bilibili.com/video/BV1fixture';
const PDF_URL = 'https://example.com/paper.pdf';

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

test('matches PDF URLs before the fallback HTML adapter', () => {
  expect(createPdfAdapter(recordingRunner({})).matches(new URL(PDF_URL))).toBe(true);
  expect(createPdfAdapter(recordingRunner({})).matches(new URL('https://example.com/paper.PDF?download=1'))).toBe(true);
  expect(createPdfAdapter(recordingRunner({})).matches(new URL('https://example.com/paper.html'))).toBe(false);
});

test('keeps PDF figures and reliable captions at their source position', () => {
  const parsed = parsePdftohtmlXml(fixtureText('paper.xml'));

  expect(parsed.blocks.map((block) => [block.kind, block.mediaId])).toEqual([
    ['paragraph', undefined],
    ['figure', 'figure-1'],
    ['paragraph', undefined],
  ]);
  expect(parsed.media).toEqual([{
    id: 'figure-1',
    kind: 'figure',
    path: 'figure-1.png',
    caption: 'Figure 1: Adapter architecture',
    page: 1,
  }]);
});

test('does not guess a PDF caption without an adjacent figure prefix', () => {
  const parsed = parsePdftohtmlXml(`
    <pdf2xml><page number="1">
      <text top="10" left="10">Before figure</text>
      <image top="30" left="10" src="figure-1.png" />
      <text top="140" left="10">Architecture overview</text>
      <text top="180" left="10">After figure</text>
    </page></pdf2xml>
  `);

  expect(parsed.media[0].caption).toBeUndefined();
  expect(parsed.blocks.map((block) => block.kind)).toEqual(['paragraph', 'figure', 'paragraph', 'paragraph']);
});

test('reports a scanned PDF without OCR as degraded', async () => {
  const report = await createPdfAdapter(scannedPdfRunner()).probe({ url: new URL(PDF_URL), vaultDir: '/tmp/v' });

  expect(report).toMatchObject({
    adapterId: 'pdf',
    readable: false,
    capabilities: ['body', 'images', 'captions'],
    degradation: 'partial',
  });
  expect(report.warnings).toContain('ocr-required');
});

test('reports an encrypted PDF as blocked instead of falling back', async () => {
  const report = await createPdfAdapter(encryptedPdfRunner()).probe({ url: new URL(PDF_URL), vaultDir: '/tmp/v' });

  expect(report).toMatchObject({ readable: false, degradation: 'blocked' });
  expect(report.warnings).toContain('encrypted-or-drm');
});

test('reports PDF encryption detected by pdftohtml as blocked', async () => {
  const report = await createPdfAdapter(encryptedXmlPdfRunner()).probe({ url: new URL(PDF_URL), vaultDir: '/tmp/v' });

  expect(report).toMatchObject({ readable: false, degradation: 'blocked' });
  expect(report.warnings).toContain('encrypted-or-drm');
});

test('reports encrypted PDF status stderr as blocked without exposing it', async () => {
  const report = await createPdfAdapter(encryptedStatusPdfRunner()).probe({ url: new URL(PDF_URL), vaultDir: '/tmp/v' });

  expect(report).toMatchObject({ readable: false, degradation: 'blocked' });
  expect(report.warnings).toContain('encrypted-or-drm');
});

test('passes untrusted PDF URLs and Poppler arguments through the argv runner', async () => {
  const runner = pdfFixtureRunner();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-pdf-adapter-test-'));
  try {
    const source = await createPdfAdapter(runner).extract({
      url: new URL('https://example.com/paper.pdf?next=$(touch%20/tmp/pwn)'),
      vaultDir: '/tmp/v',
      tempDir,
    });

    const curlCall = runner.calls.find((call) => call.command === 'curl');
    expect(curlCall?.args).toEqual(['-L', '--fail', '--max-time', '30', '-o', expect.any(String), 'https://example.com/paper.pdf?next=$(touch%20/tmp/pwn)']);
    expect(runner.calls.find((call) => call.command === 'pdftotext')?.args).toEqual(['-layout', expect.any(String), expect.any(String)]);
    expect(runner.calls.find((call) => call.command === 'pdftohtml')?.args).toEqual(['-xml', '-hidden', '-nodrm', expect.any(String), expect.any(String)]);
    expect(source.source.kind).toBe('paper');
    expect(source.blocks.map((block) => block.kind)).toEqual(['paragraph', 'figure', 'paragraph']);
    expect(source.media[0].path).toBeDefined();
    expect(fs.existsSync(source.media[0].path!)).toBe(true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

test('associates a standalone duplicate image with its own Markdown occurrence', async () => {
  const source = await createHtmlAdapter(recordingRunner({
    stdout: 'Before ![same](https://cdn.example.com/same.png) after\n\n![same](https://cdn.example.com/same.png)\n',
  })).extract({ url: new URL('https://example.com/article'), vaultDir: '/tmp/v' });

  expect(source.media.map((asset) => asset.id)).toEqual(['image-001', 'image-002']);
  expect(source.blocks.at(-1)).toMatchObject({ kind: 'image', mediaId: 'image-002' });
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

test('offsets multi-page Whisper segments into a single ordered timeline', async () => {
  const source = await createBilibiliAdapter(twoPageWithoutCcRunner(), {
    transcribe: (_url, cid) => cid === 101
      ? [{ start: 0, end: 3, text: 'P1 Whisper' }]
      : [{ start: 0, end: 2, text: 'P2 Whisper' }],
    transcriptionAvailable: () => true,
  }).extract({ url: new URL(BILI_URL), vaultDir: '/tmp/v', mode: 'transcribe' });

  expect(source.transcript).toEqual([
    { start: 0, end: 3, text: 'P1 Whisper' },
    { start: 10, end: 12, text: 'P2 Whisper' },
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

function twoPageWithoutCcRunner(): CommandRunner {
  const meta = JSON.parse(fixtureText('bilibili-meta.json'));
  meta.data.pages = [
    { cid: 101, page: 1, part: 'P1', duration: 10 },
    { cid: 202, page: 2, part: 'P2', duration: 20 },
  ];
  return {
    run(_command, args) {
      const url = args.at(-1) ?? '';
      if (url.includes('/x/web-interface/view')) return { stdout: JSON.stringify(meta), stderr: '', status: 0 };
      if (url.includes('/x/player/v2')) return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), stderr: '', status: 0 };
      throw new Error(`Unexpected command arguments: ${args.join(' ')}`);
    },
  };
}

function scannedPdfRunner(): CommandRunner {
  return pdfRunner({ text: '' });
}

function encryptedPdfRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      if (command === 'pdftotext') throw new Error('Command pdftotext failed with exit code 1: encrypted PDF');
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}

function encryptedXmlPdfRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      if (command === 'pdftotext') fs.writeFileSync(args[2], 'Visible PDF text');
      if (command === 'pdftohtml') throw new Error('Command pdftohtml failed with exit code 1: DRM protected PDF');
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}

function encryptedStatusPdfRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      if (command === 'pdftotext') return { stdout: '', stderr: 'PDF is encrypted', status: 1 };
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}

function pdfFixtureRunner(): CommandRunner & { calls: Array<{ command: string; args: string[] }> } {
  return pdfRunner({ text: 'An introduction to adapter boundaries.\nThe extraction continues after the figure.\n' });
}

function pdfRunner({ text }: { text: string }): CommandRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      if (command === 'curl') fs.writeFileSync(args[5], '%PDF-fixture');
      if (command === 'pdftotext') fs.writeFileSync(args[2], text);
      if (command === 'pdftohtml') {
        fs.writeFileSync(args.at(-1)!, fixtureText('paper.xml'));
        fs.writeFileSync(path.join(path.dirname(args.at(-1)!), 'figure-1.png'), 'fixture-image');
      }
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}
