import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandResult, CommandRunner } from '../bin/ingest/command.ts';
import { createHtmlAdapter, markdownToSourceParts } from '../bin/ingest/adapters/html.ts';
import { createBilibiliAdapter } from '../bin/ingest/adapters/bilibili.ts';
import { createPdfAdapter, parsePdftohtmlXml, probePdfContentType } from '../bin/ingest/adapters/pdf.ts';
import { createXAdapter } from '../bin/ingest/adapters/x.ts';
import { extractContent, transcribeBilibili } from '../bin/ingest.ts';

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'ingest');
const BILI_URL = 'https://www.bilibili.com/video/BV1fixture';
const PDF_URL = 'https://example.com/paper.pdf';
const X_ARTICLE_URL = 'https://x.com/example/articles/123';
const X_VIDEO_URL = 'https://x.com/example/status/456';

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

test('classifies an abstract-only PDF preview as partial instead of complete', async () => {
  const report = await createPdfAdapter(pdfPreviewRunner()).probe({
    url: new URL(PDF_URL),
    vaultDir: '/tmp/v',
  });

  expect(report.completeness).toBe('partial');
  expect(report.degradation).toBe('partial');
  expect(report.warnings).toContain('pdf-pages-incomplete');
});

test('classifies a full-page PDF extraction as complete when document and XML page counts agree', async () => {
  const report = await createPdfAdapter(pdfFixtureRunner()).probe({
    url: new URL(PDF_URL),
    vaultDir: '/tmp/v',
  });

  expect(report.completeness).toBe('complete');
  expect(report.degradation).toBe('none');
  expect(report.warnings).toEqual([]);
});

test('classifies PDF completeness as unknown when document page evidence is unavailable', async () => {
  const runner = pdfFixtureRunner();
  const originalRun = runner.run.bind(runner);
  runner.run = (command, args, options) => command === 'pdfinfo'
    ? { stdout: '', stderr: '', status: 0 }
    : originalRun(command, args, options);

  const report = await createPdfAdapter(runner).probe({
    url: new URL(PDF_URL),
    vaultDir: '/tmp/v',
  });

  expect(report.completeness).toBe('unknown');
  expect(report.degradation).toBe('partial');
  expect(report.warnings).toContain('pdf-completeness-unknown');
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
    const figureBlock = source.blocks.find((block) => block.mediaId === source.media[0].id);
    expect(figureBlock?.markdown).toContain(source.media[0].path!);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('probes PDF Content-Type through the argv runner without downloading a body', async () => {
  const runner = recordingRunner({ stdout: 'application/pdf\n' });

  await expect(probePdfContentType(runner, new URL('https://example.com/download?id=42'))).resolves.toBe('application/pdf');
  expect(runner.calls).toEqual([{
    command: 'curl',
    args: ['-sS', '-L', '--fail', '--max-time', '15', '-I', '-o', '/dev/null', '-w', '%{content_type}', 'https://example.com/download?id=42'],
  }]);
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
  expect(result.content).toContain([
    'Before',
    '',
    '![inline chart](https://cdn.example.com/inline.png)',
    '',
    'after',
  ].join('\n'));
});

test('associates a standalone duplicate image with its own Markdown occurrence', async () => {
  const source = await createHtmlAdapter(recordingRunner({
    stdout: 'Before ![same](https://cdn.example.com/same.png) after\n\n![same](https://cdn.example.com/same.png)\n',
  })).extract({ url: new URL('https://example.com/article'), vaultDir: '/tmp/v' });

  expect(source.media.map((asset) => asset.id)).toEqual(['image-001', 'image-002']);
  expect(source.blocks.at(-1)).toMatchObject({ kind: 'image', mediaId: 'image-002' });
});

test('splits every inline and duplicate Markdown image occurrence into an associated ordered block', async () => {
  const source = await createHtmlAdapter(recordingRunner({
    stdout: [
      '# Inline images',
      '',
      'Before ![same](https://cdn.example.com/same.png) between ![other](https://cdn.example.com/other.png) after',
      '',
      '![same](https://cdn.example.com/same.png)',
      '',
    ].join('\n'),
  })).extract({ url: new URL('https://example.com/article'), vaultDir: '/tmp/v' });

  expect(source.media.map((asset) => [asset.id, asset.url])).toEqual([
    ['image-001', 'https://cdn.example.com/same.png'],
    ['image-002', 'https://cdn.example.com/other.png'],
    ['image-003', 'https://cdn.example.com/same.png'],
  ]);
  expect(source.blocks.map((block) => [block.kind, block.markdown, block.mediaId])).toEqual([
    ['heading', '# Inline images', undefined],
    ['paragraph', 'Before', undefined],
    ['image', '![same](https://cdn.example.com/same.png)', 'image-001'],
    ['paragraph', 'between', undefined],
    ['image', '![other](https://cdn.example.com/other.png)', 'image-002'],
    ['paragraph', 'after', undefined],
    ['image', '![same](https://cdn.example.com/same.png)', 'image-003'],
  ]);
});

test('keeps fenced and inline code images as code while extracting only true Markdown resources', () => {
  const markdown = [
    '# Code-aware images',
    '',
    'Before `![inline-code](https://cdn.example.com/inline-code.png)` and ![real](https://cdn.example.com/real.png) after.',
    '',
    '````md',
    '```',
    '![nested-fence](https://cdn.example.com/nested-fence.png)',
    '```',
    '````',
    '',
    '~~~md',
    '![tilde-fence](https://cdn.example.com/tilde-fence.png)',
    '~~~',
    '',
    '```md`invalid',
    '![visible-after-invalid-opener](https://cdn.example.com/visible.png)',
    '',
  ].join('\n');

  const source = markdownToSourceParts(markdown);

  expect(source.media.map((asset) => asset.url)).toEqual([
    'https://cdn.example.com/real.png',
    'https://cdn.example.com/visible.png',
  ]);
  expect(source.blocks.filter((block) => block.kind === 'code').map((block) => block.markdown)).toEqual([
    [
      '````md',
      '```',
      '![nested-fence](https://cdn.example.com/nested-fence.png)',
      '```',
      '````',
    ].join('\n'),
    [
      '~~~md',
      '![tilde-fence](https://cdn.example.com/tilde-fence.png)',
      '~~~',
    ].join('\n'),
  ]);
  expect(source.blocks.map((block) => block.markdown).join('\n\n')).toContain(
    '`![inline-code](https://cdn.example.com/inline-code.png)`',
  );
  expect(source.blocks.map((block) => block.markdown).join('\n\n')).toContain('```md`invalid');
});

test('extracts an X Article body and ordered images', async () => {
  const source = await createXAdapter(xArticleRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  });

  expect(source.source.kind).toBe('article');
  expect(source.source.title).toBe('A public X Article');
  expect(source.source.author).toBe('@fixture_author');
  expect(source.source.publishedAt).toBe('2026-07-25T08:30:00Z');
  expect(source.media.map((media) => media.url)).toEqual([
    'https://pbs.twimg.com/a.jpg',
    'https://pbs.twimg.com/b.jpg',
  ]);
});

test('classifies public X media as video and persists its media path', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-video-vault-'));
  try {
    const source = await createXAdapter(xVideoRunner()).extract({
      url: new URL(X_VIDEO_URL), vaultDir, mode: 'handout',
    });

    const video = source.media.find((media) => media.kind === 'video');
    expect(source.source.kind).toBe('video');
    expect(video?.path).toBeDefined();
    expect(video?.path?.startsWith(vaultDir)).toBe(true);
    expect(fs.existsSync(video!.path!)).toBe(true);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('persists X media inside the caller-provided per-run workspace', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-workspace-vault-'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-workspace-run-'));
  try {
    const source = await createXAdapter(xVideoRunner()).extract({
      url: new URL(X_VIDEO_URL), vaultDir, tempDir, mode: 'handout',
    });

    expect(source.media[0].path?.startsWith(tempDir + path.sep)).toBe(true);
    expect(fs.existsSync(source.media[0].path!)).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, '.me', 'ingest-media'))).toBe(false);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('extracts every public X playlist entry in source order using final media extensions', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-playlist-vault-'));
  try {
    const source = await createXAdapter(xPlaylistRunner()).extract({
      url: new URL(X_VIDEO_URL), vaultDir, mode: 'handout',
    });

    expect(source.source).toMatchObject({ kind: 'video', title: 'Two public X clips', author: 'fixture_author' });
    expect(source.media.map((media) => [media.kind, media.caption, path.extname(media.path!)]))
      .toEqual([
        ['video', 'First public clip', '.webm'],
        ['video', 'Second public clip', '.mp4'],
      ]);
    expect(source.media.map((media) => fs.readFileSync(media.path!, 'utf8'))).toEqual(['FIRST', 'SECOND']);
    expect(source.media.every((media) => fs.existsSync(media.path!))).toBe(true);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('rolls back every published X playlist asset when a later entry fails', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-playlist-rollback-vault-'));
  try {
    await expect(createXAdapter(xPlaylistSecondFailureRunner()).extract({
      url: new URL(X_VIDEO_URL), vaultDir,
    })).rejects.toThrow(/yt-dlp failed/);
    const assetDirectory = path.join(vaultDir, '.me', 'ingest-media');
    expect(fs.existsSync(assetDirectory) ? fs.readdirSync(assetDirectory) : []).toEqual([]);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('reports mixed X audio-only playlist entries as degraded media', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-mixed-vault-'));
  try {
    const adapter = createXAdapter(xMixedPlaylistRunner());
    const context = { url: new URL(X_VIDEO_URL), vaultDir };
    const [report, source] = await Promise.all([adapter.probe(context), adapter.extract(context)]);

    expect(report.capabilities).toEqual(['video', 'audio']);
    expect(report.degradation).toBe('partial');
    expect(source.media.map((media) => media.kind)).toEqual(['video', 'audio']);
    expect(source.warnings).toContain('video-unavailable:audio-only:audio-002');
    expect(report.warnings).toContain('video-unavailable:audio-only:audio-002');
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('persists concurrent X downloads under distinct paths', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-concurrent-vault-'));
  try {
    const adapter = createXAdapter(xVideoRunner());
    const context = { url: new URL(X_VIDEO_URL), vaultDir };
    const [first, second] = await Promise.all([adapter.extract(context), adapter.extract(context)]);
    const paths = [...first.media, ...second.media].map((media) => media.path!);

    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((mediaPath) => fs.existsSync(mediaPath))).toBe(true);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('treats malformed or unknown successful X video metadata as extraction failures', async () => {
  await expect(createXAdapter(xMalformedProbeRunner('{broken')).extract({
    url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/extraction-failed/);
  await expect(createXAdapter(xMalformedProbeRunner(JSON.stringify({ id: 'unknown' }))).extract({
    url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/extraction-failed/);
  await expect(createXAdapter(xMalformedProbeRunner(JSON.stringify({ id: 'unknown', title: 'Unknown schema' }))).extract({
    url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/extraction-failed/);
});

test('falls back to X Article for yt-dlp’s explicit no-video tweet result', async () => {
  const source = await createXAdapter(xExplicitNoVideoRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  });

  expect(source.source.kind).toBe('article');
});

test('cleans partial X video downloads before returning a failure', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-download-failure-vault-'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-download-failure-temp-'));
  try {
    await expect(createXAdapter(xPartialDownloadRunner()).extract({
      url: new URL(X_VIDEO_URL), vaultDir, tempDir,
    })).rejects.toThrow(/yt-dlp failed/);
    const assetDirectory = path.join(vaultDir, '.me', 'ingest-media');
    expect(fs.existsSync(assetDirectory) ? fs.readdirSync(assetDirectory) : []).toEqual([]);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('reports X audio-only media without claiming video capability', async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-x-audio-vault-'));
  try {
    const adapter = createXAdapter(xAudioOnlyRunner());
    const context = { url: new URL(X_VIDEO_URL), vaultDir };
    const [report, source] = await Promise.all([adapter.probe(context), adapter.extract(context)]);

    expect(report.capabilities).toEqual(['audio']);
    expect(source.media).toMatchObject([{ kind: 'audio' }]);
    expect(source.warnings).toContain('video-unavailable:audio-only');
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
});

test('returns auth-required instead of ingesting an X login page', async () => {
  await expect(createXAdapter(loginPageRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/auth-required/);
});

test('returns auth-required for a long X login flow without article structure', async () => {
  await expect(createXAdapter(longLoginPageRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/auth-required/);
});

test('returns auth-required for an X flow login marker even with an article heading', async () => {
  await expect(createXAdapter(flowLoginWithHeadingRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/auth-required/);
});

test('returns auth-required when an X Article body is shorter than 200 visible characters', async () => {
  await expect(createXAdapter(shortXArticleRunner()).extract({
    url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/auth-required/);
});

test('returns auth-required when the X video probe reports a login wall', async () => {
  await expect(createXAdapter(xAuthProbeRunner()).extract({
    url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/auth-required/);
});

test('does not hide an X video-probe network failure by falling back to Article', async () => {
  await expect(createXAdapter(xNetworkFailureRunner()).extract({
    url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v',
  })).rejects.toThrow(/extraction-failed/);
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

function xArticleRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') {
        expect(args).toEqual(['parse', X_ARTICLE_URL, '--md']);
        return { stdout: fixtureText('x-article.md'), stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function xVideoRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') {
        expect(args).toEqual(['--dump-single-json', X_VIDEO_URL]);
        return {
          stdout: JSON.stringify({
            id: '456', title: 'Public X video', uploader: 'example', duration: 42,
            ext: 'mp4', webpage_url: X_VIDEO_URL, formats: [{ format_id: 'best' }],
          }),
          stderr: '', status: 0,
        };
      }
      const template = args[args.indexOf('-o') + 1];
      expect(template).toContain('%(ext)s');
      expect(args).toContain('after_move:filepath');
      const actualPath = template.replace('%(id)s', '456').replace('%(ext)s', 'mp4');
      fs.writeFileSync(actualPath, 'video-fixture');
      return { stdout: `${actualPath}\n`, stderr: '', status: 0 };
    },
  };
}

function xPlaylistRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') {
        return { stdout: fixtureText('x-video-playlist.json'), stderr: '', status: 0 };
      }
      const outputIndex = args.indexOf('-o');
      const printIndex = args.indexOf('--print');
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      expect(args[outputIndex + 1]).toContain('%(ext)s');
      expect(args[printIndex + 1]).toBe('after_move:filepath');
      expect(args.at(-1)).toBe(X_VIDEO_URL);
      const selected = args[args.indexOf('--playlist-items') + 1];
      const template = args[outputIndex + 1];
      const first = template.replace('%(id)s', 'clip-1').replace('%(ext)s', 'webm');
      const second = template.replace('%(id)s', 'clip-2').replace('%(ext)s', 'mp4');
      if (selected === '1') {
        expect(args).not.toContain('--no-playlist');
        fs.writeFileSync(first, 'FIRST');
        return { stdout: `${first}\n`, stderr: '', status: 0 };
      }
      if (selected === '2') {
        expect(args).not.toContain('--no-playlist');
        fs.writeFileSync(second, 'SECOND');
        return { stdout: `${second}\n`, stderr: '', status: 0 };
      }
      fs.writeFileSync(first, 'FIRST');
      fs.writeFileSync(second, 'SECOND');
      return { stdout: `${first}\n${second}\n`, stderr: '', status: 0 };
    },
  };
}

function xPlaylistSecondFailureRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') return { stdout: fixtureText('x-video-playlist.json'), stderr: '', status: 0 };
      const template = args[args.indexOf('-o') + 1];
      const selected = args[args.indexOf('--playlist-items') + 1];
      if (selected === '2') {
        fs.writeFileSync(path.join(path.dirname(template), 'second.part'), 'partial');
        return { stdout: '', stderr: 'second clip unavailable', status: 1 };
      }
      const first = template.replace('%(id)s', 'clip-1').replace('%(ext)s', 'webm');
      fs.writeFileSync(first, 'FIRST');
      return { stdout: `${first}\n`, stderr: '', status: 0 };
    },
  };
}

function xMixedPlaylistRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') return { stdout: fixtureText('x-video-mixed.json'), stderr: '', status: 0 };
      const template = args[args.indexOf('-o') + 1];
      const selected = args[args.indexOf('--playlist-items') + 1];
      const video = template.replace('%(id)s', 'mixed-video').replace('%(ext)s', 'mp4');
      const audio = template.replace('%(id)s', 'mixed-audio').replace('%(ext)s', 'm4a');
      const actualPath = selected === '2' ? audio : video;
      fs.writeFileSync(actualPath, selected === '2' ? 'AUDIO' : 'VIDEO');
      return { stdout: `${actualPath}\n`, stderr: '', status: 0 };
    },
  };
}

function xMalformedProbeRunner(stdout: string): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout, stderr: '', status: 0 };
      throw new Error(`Article fallback must not run after malformed video metadata: ${command}`);
    },
  };
}

function xExplicitNoVideoRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'ERROR: No video could be found in this tweet', status: 1 };
      if (command === 'defuddle') return { stdout: fixtureText('x-article.md'), stderr: '', status: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function xPartialDownloadRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') {
        return { stdout: JSON.stringify({ id: 'partial', title: 'Partial download', webpage_url: X_VIDEO_URL, ext: 'mp4', vcodec: 'avc1' }), stderr: '', status: 0 };
      }
      const template = args[args.indexOf('-o') + 1];
      fs.writeFileSync(path.join(path.dirname(template), 'download.part'), 'partial');
      return { stdout: '', stderr: 'network interrupted', status: 1 };
    },
  };
}

function xAudioOnlyRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'yt-dlp') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === '--dump-single-json') {
        return { stdout: JSON.stringify({ id: 'audio-only', title: 'Public audio', webpage_url: X_VIDEO_URL, ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' }), stderr: '', status: 0 };
      }
      const template = args[args.indexOf('-o') + 1];
      const actualPath = template.replace('%(id)s', 'audio-only').replace('%(ext)s', 'm4a');
      fs.writeFileSync(actualPath, 'audio');
      return { stdout: `${actualPath}\n`, stderr: '', status: 0 };
    },
  };
}

function loginPageRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') return { stdout: '# Log in to X\n\nSign in to see what is happening.', stderr: '', status: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function longLoginPageRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') return { stdout: `Sign in to X\n\n${'Login wall content. '.repeat(20)}\n/i/flow/login`, stderr: '', status: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function flowLoginWithHeadingRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') return { stdout: `# Welcome to X\n\n${'Login flow content. '.repeat(20)}\n/i/flow/login`, stderr: '', status: 0 };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function shortXArticleRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') {
        return { stdout: `# ${'An unusually long heading '.repeat(12)}\n\nToo short.`, stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function xAuthProbeRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'ERROR: Sign in to confirm you are not a bot', status: 1 };
      throw new Error(`Article fallback must not run after an auth failure: ${command}`);
    },
  };
}

function xNetworkFailureRunner(): CommandRunner {
  return {
    run(command) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'ERROR: Unable to download webpage: timed out', status: 1 };
      throw new Error(`Article fallback must not run after a network failure: ${command}`);
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
      if (command === 'pdfinfo') return { stdout: 'Pages:           1\n', stderr: '', status: 0 };
      if (command === 'pdftotext') fs.writeFileSync(args[2], text);
      if (command === 'pdftohtml') {
        fs.writeFileSync(args.at(-1)!, fixtureText('paper.xml'));
        fs.writeFileSync(path.join(path.dirname(args.at(-1)!), 'figure-1.png'), 'fixture-image');
      }
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}

function pdfPreviewRunner(): CommandRunner {
  return {
    run(command, args) {
      if (command === 'which') return { stdout: '/safe/bin/tool\n', stderr: '', status: 0 };
      if (command === 'curl') fs.writeFileSync(args[5], '%PDF-preview');
      if (command === 'pdfinfo') return { stdout: 'Pages:           12\n', stderr: '', status: 0 };
      if (command === 'pdftotext') fs.writeFileSync(args[2], 'Abstract preview text');
      if (command === 'pdftohtml') {
        fs.writeFileSync(args.at(-1)!, [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<pdf2xml>',
          '  <page number="1"><text top="10" left="10">Abstract preview text</text></page>',
          '</pdf2xml>',
        ].join('\n'));
      }
      return { stdout: '', stderr: '', status: 0 };
    },
  };
}
