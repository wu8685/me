import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdapterRegistry, AdapterExtractionError } from '../bin/ingest/registry.ts';
import type { SourceAdapter } from '../bin/ingest/contracts.ts';
import {
  createRichIngestRegistry,
  ingestErrorPayload,
  parseIngestCliOptions,
  resolveIngestMode,
  runRichIngest,
  SourceBlockedError,
} from '../bin/ingest.ts';
import type { CommandRunner } from '../bin/ingest/command.ts';

const html: SourceAdapter = {
  id: 'html',
  fallback: true,
  matches: () => true,
  probe: async () => ({ adapterId: 'html', readable: true, capabilities: ['body'], warnings: [] }),
  extract: async () => ({
    source: { url: 'https://example.com', kind: 'article', title: 'HTML' },
    blocks: [],
    media: [],
    warnings: [],
    provenance: { extractor: 'html', extractedAt: '2026-07-25T00:00:00Z', methods: [] },
  }),
};

describe('createAdapterRegistry', () => {
  test('selects the first matching adapter', () => {
    const x = { ...html, id: 'x', matches: (url: URL) => url.hostname === 'x.com' };
    expect(createAdapterRegistry([x, html]).match(new URL('https://x.com/a/status/1')).id).toBe('x');
  });

  test('does not fall through after an explicit adapter extraction failure', async () => {
    const x = {
      ...html,
      id: 'x',
      matches: () => true,
      extract: async () => { throw new Error('auth-required'); },
    };
    await expect(createAdapterRegistry([x, html]).extract(
      new URL('https://x.com/i/article/1'),
      { vaultDir: '/tmp/vault' },
    )).rejects.toBeInstanceOf(AdapterExtractionError);
  });

  test('resolves a suffixless application/pdf response to the PDF adapter before HTML', async () => {
    const pdf = {
      ...html,
      id: 'pdf',
      fallback: false,
      matches: () => false,
      matchesContentType: (contentType: string) => contentType === 'application/pdf',
    };
    const registry = createAdapterRegistry([pdf, html], {
      resolveContentType: async () => 'application/pdf',
    });

    await expect(registry.resolve(new URL('https://example.com/download?id=42'))).resolves.toMatchObject({ id: 'pdf' });
  });

  test('keeps suffixless text/html on the HTML fallback adapter', async () => {
    const pdf = {
      ...html,
      id: 'pdf',
      fallback: false,
      matches: () => false,
      matchesContentType: (contentType: string) => contentType === 'application/pdf',
    };
    const registry = createAdapterRegistry([pdf, html], {
      resolveContentType: async () => 'text/html; charset=utf-8',
    });

    await expect(registry.resolve(new URL('https://example.com/download?id=42'))).resolves.toMatchObject({ id: 'html' });
  });

  test('does not probe Content-Type when a direct adapter already matches', async () => {
    const x = { ...html, id: 'x', fallback: false, matches: (url: URL) => url.hostname === 'x.com' };
    const registry = createAdapterRegistry([x, html], {
      resolveContentType: async () => { throw new Error('must not run'); },
    });

    await expect(registry.resolve(new URL('https://x.com/i/article/1'))).resolves.toMatchObject({ id: 'x' });
  });

  test('falls back to HTML when Content-Type lookup fails', async () => {
    const pdf = {
      ...html,
      id: 'pdf',
      fallback: false,
      matches: () => false,
      matchesContentType: (contentType: string) => contentType === 'application/pdf',
    };
    const registry = createAdapterRegistry([pdf, html], {
      resolveContentType: async () => { throw new Error('HTTP 500'); },
    });

    await expect(registry.resolve(new URL('https://example.com/download?id=42'))).resolves.toMatchObject({ id: 'html' });
  });

  test('pins one resolved adapter for probe and extract', async () => {
    let contentTypeCalls = 0;
    const pdf = {
      ...html,
      id: 'pdf',
      fallback: false,
      matches: () => false,
      matchesContentType: (contentType: string) => contentType === 'application/pdf',
      probe: async () => ({ adapterId: 'pdf', readable: true, capabilities: ['body'] as const, warnings: [] }),
      extract: async () => ({
        source: { url: 'https://example.com/download', kind: 'paper' as const, title: 'Pinned PDF' },
        blocks: [],
        media: [],
        warnings: [],
        provenance: { extractor: 'pdf', extractedAt: '2026-07-25T00:00:00Z', methods: [] },
      }),
    };
    const registry = createAdapterRegistry([pdf, html], {
      resolveContentType: async () => {
        contentTypeCalls += 1;
        if (contentTypeCalls === 1) return 'application/pdf';
        throw new Error('second resolution must not occur');
      },
    });

    const session = await registry.resolveSession(new URL('https://example.com/download?id=42'));
    await expect(session.probe({ vaultDir: '/tmp/vault' })).resolves.toMatchObject({ adapterId: 'pdf' });
    await expect(session.extract({ vaultDir: '/tmp/vault' })).resolves.toMatchObject({
      source: { kind: 'paper', title: 'Pinned PDF' },
    });
    expect(session.adapter.id).toBe('pdf');
    expect(contentTypeCalls).toBe(1);
  });
});

describe('rich ingest CLI orchestration', () => {
  test('serializes blocked sources as a direct structured payload', () => {
    expect(ingestErrorPayload(new SourceBlockedError('pdf', ['encrypted-or-drm']))).toEqual({
      code: 'source-blocked',
      adapterId: 'pdf',
      warnings: ['encrypted-or-drm'],
    });
  });
  test('parses URL and Bundle entries explicitly', () => {
    expect(parseIngestCliOptions(['https://example.com', '--vault-dir', '/tmp/vault'])).toMatchObject({
      url: new URL('https://example.com'),
      vaultDir: '/tmp/vault',
      write: false,
    });
    expect(parseIngestCliOptions(['--bundle', '/tmp/bundle', '--write'])).toMatchObject({
      bundleDir: '/tmp/bundle',
      write: true,
    });
  });

  test('rejects ambiguous, incomplete, and unsafe options', () => {
    expect(() => parseIngestCliOptions(['https://example.com', '--bundle', '/tmp/bundle'])).toThrow(/exactly one/i);
    expect(() => parseIngestCliOptions(['--bundle'])).toThrow(/value/i);
    expect(() => parseIngestCliOptions(['https://example.com', '--mode', 'metadata'])).toThrow(/mode/i);
    expect(() => parseIngestCliOptions(['https://example.com', '--topic', '../escape'])).toThrow(/topic/i);
    expect(() => parseIngestCliOptions(['https://example.com', '--processed-markdown', '/tmp/note.md'])).toThrow(/--write/i);
    expect(() => parseIngestCliOptions(['https://example.com', '--unknown'])).toThrow(/unknown/i);
  });

  test('defaults video and course sources to handout while preserving article language defaults', () => {
    expect(resolveIngestMode(undefined, 'video', 'zh', 'handout')).toBe('handout');
    expect(resolveIngestMode(undefined, 'course', 'en', 'raw')).toBe('raw');
    expect(resolveIngestMode(undefined, 'article', 'en', 'handout')).toBe('translate-cn');
    expect(resolveIngestMode(undefined, 'paper', 'zh', 'handout')).toBe('summarize');
    expect(resolveIngestMode('raw', 'video', 'zh', 'handout')).toBe('raw');
  });

  test('registers adapters in fixed order and probes suffixless Content-Type through argv curl', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run(command, args) {
        calls.push({ command, args });
        if (command === 'curl') return { stdout: 'application/pdf', stderr: '', status: 0 };
        return { stdout: '', stderr: '', status: 0 };
      },
    };
    const registry = createRichIngestRegistry(runner);

    expect(registry.adapters.map(adapter => adapter.id)).toEqual(['bilibili', 'x', 'pdf', 'html']);
    await expect(registry.registry.resolve(new URL('https://example.com/download?id=42')))
      .resolves.toMatchObject({ id: 'pdf' });
    expect(calls[0]).toEqual({
      command: 'curl',
      args: ['-sS', '-L', '--fail', '--max-time', '15', '-I', '-o', '/dev/null', '-w', '%{content_type}', 'https://example.com/download?id=42'],
    });
  });

  test('previews a video Bundle as a topic handout by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-cli-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
      version: 1,
      source: {
        url: 'https://example.com/course',
        kind: 'course',
        title: 'Course preview',
        durationSec: 60,
      },
      blocks: [{ id: 'b1', kind: 'heading', markdown: '# Course preview' }],
      transcript: [{ start: 0, end: 60, text: 'Complete transcript.' }],
      media: [],
      provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: ['fixture'] },
      warnings: [],
    }));
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        '--bundle', bundle, '--vault-dir', vault,
      ]));
      expect(result).toMatchObject({
        mode: 'handout',
        sourceKind: 'course',
        adapterId: 'source-bundle-v1',
        handoutKind: 'topic',
      });
      expect(result.capabilities).toContain('transcript');
      expect(result.writeResult).toBeUndefined();
      expect(fs.readdirSync(vault)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes a Bundle through the finalizer and consumes processed Markdown', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-cli-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    const edit = path.join(vault, '.me', 'tmp', 'edited.md');
    fs.mkdirSync(path.dirname(edit), { recursive: true });
    fs.mkdirSync(bundle);
    fs.writeFileSync(edit, '# Edited article\n\nReviewed body.\n');
    fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
      version: 1,
      source: { url: 'https://example.com/article', kind: 'article', title: 'Bundle article' },
      blocks: [{ id: 'b1', kind: 'paragraph', markdown: 'Original body.' }],
      media: [],
      provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: ['fixture'] },
      warnings: [],
    }));
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        '--bundle', bundle,
        '--vault-dir', vault,
        '--mode', 'raw',
        '--processed-markdown', edit,
        '--write',
      ]));
      const today = new Date().toISOString().slice(0, 10);
      expect(result.writeResult?.notePath).toBe(
        path.join(vault, 'raw', `${today}-bundle-article`, `${today}-bundle-article.md`),
      );
      expect(fs.readFileSync(result.writeResult!.notePath, 'utf8')).toContain('Reviewed body.');
      expect(fs.existsSync(edit)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects processed Markdown outside the vault temporary directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-cli-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    const edit = path.join(root, 'outside.md');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    fs.writeFileSync(edit, 'outside');
    fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
      version: 1,
      source: { url: 'https://example.com/article', kind: 'article', title: 'Bundle article' },
      blocks: [{ id: 'b1', kind: 'paragraph', markdown: 'Original body.' }],
      media: [],
      provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: ['fixture'] },
      warnings: [],
    }));
    try {
      await expect(runRichIngest(parseIngestCliOptions([
        '--bundle', bundle,
        '--vault-dir', vault,
        '--mode', 'raw',
        '--processed-markdown', edit,
        '--write',
      ]))).rejects.toThrow(/\.me\/tmp/);
      expect(fs.existsSync(edit)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses the configured generic mlx-whisper provider for Bilibili no-CC audio and cleans the per-run workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-bili-url-'));
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    const transcribedInputs: string[] = [];
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        'https://www.bilibili.com/video/BV1fixture', '--vault-dir', vault, '--write',
      ]), bilibiliUrlRunner(transcribedInputs));
      expect(result.mode).toBe('handout');
      expect(result.content).toContain('Bilibili local transcript');
      expect(result.warnings).not.toContain('needs-transcription');
      expect(result.warnings).not.toContain('transcription-unavailable');
      expect(result.capabilities).toContain('transcript');
      expect(result.writeResult?.notePath).toBeDefined();
      expect(transcribedInputs).toHaveLength(1);
      expect(transcribedInputs[0]).toContain(`${path.sep}me-ingest-run-`);
      expect(fs.existsSync(transcribedInputs[0])).toBeFalse();
      expect(fs.existsSync(path.join(vault, '.me', 'ingest-media'))).toBeFalse();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('renders an X transcription into preview and written note bodies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-x-url-'));
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        'https://x.com/example/status/456',
        '--vault-dir', vault,
        '--mode', 'transcribe',
        '--write',
      ]), xTranscribeUrlRunner());
      expect(result.content).toContain('X transcript text');
      expect(fs.readFileSync(result.writeResult!.notePath, 'utf8')).toContain('X transcript text');
      expect(result.capabilities).toContain('transcript');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['HTML', 'https://example.com/inline-images'],
    ['X Article', 'https://x.com/example/articles/inline-images'],
  ])('writes %s inline and duplicate images in source order with stable localized associations', async (_label, url) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-inline-images-'));
    const vault = path.join(root, 'vault');
    const downloadedUrls: string[] = [];
    fs.mkdirSync(vault);
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        url,
        '--vault-dir', vault,
        '--mode', 'raw',
        '--write',
      ]), inlineDuplicateArticleRunner(url, downloadedUrls));
      const note = fs.readFileSync(result.writeResult!.notePath, 'utf8');

      expect(note).toContain([
        'Before the first occurrence.',
        '',
        '![same](images/image-001.png)',
        '',
        'Between the duplicate occurrences.',
        '',
        '![same](images/image-002.png)',
        '',
        'After the second occurrence.',
      ].join('\n'));
      expect(result.writeResult?.assetPaths.map(asset => path.basename(asset))).toEqual([
        'image-001.png',
        'image-002.png',
      ]);
      expect(result.writeResult?.assetPaths.map(asset => fs.readFileSync(asset, 'utf8'))).toEqual([
        'download-1',
        'download-2',
      ]);
      expect(downloadedUrls).toEqual([
        'https://cdn.example.com/same.png',
        'https://cdn.example.com/same.png',
      ]);
      expect(note).toContain('`![inline-code](https://cdn.example.com/inline-code.png)`');
      expect(note).toContain([
        '```md',
        '![fenced-code](https://cdn.example.com/fenced-code.png)',
        '```',
      ].join('\n'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects sensitive Bundle values before --write and leaves the vault empty without echoing secrets', async () => {
    const secret = ['sk', '-', 'C'.repeat(32)].join('');
    const headerName = ['Authoriza', 'tion'].join('');
    const invalidCases = [
      { source: { url: `https://reader:${secret}@example.com/source`, kind: 'article', title: 'Source' } },
      {
        source: {
          url: `https://example.com/source?${['au', 'th'].join('')}=${secret}`,
          kind: 'article',
          title: 'Source',
        },
      },
      {
        source: {
          url: `https://example.com/source?${['X', '-Amz-', 'Credential'].join('')}=${secret}`,
          kind: 'article',
          title: 'Source',
        },
      },
      { source: { url: 'https://example.com/source', kind: 'article', title: secret } },
      { provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: [`${headerName}: Bearer ${secret}`] } },
      {
        provenance: {
          extractor: 'fixture',
          extractedAt: '2026-07-25T00:00:00Z',
          methods: [`${['client', '_', 'secret'].join('')}=${secret}`],
        },
      },
    ];

    for (const invalid of invalidCases) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-sensitive-bundle-'));
      const vault = path.join(root, 'vault');
      const bundle = path.join(root, 'bundle');
      fs.mkdirSync(vault);
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
        version: 1,
        source: { url: 'https://example.com/source', kind: 'article', title: 'Source' },
        blocks: [{ id: 'b1', kind: 'paragraph', markdown: 'Substantive source body.' }],
        media: [],
        provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: [] },
        warnings: [],
        ...invalid,
      }));
      try {
        let message = '';
        try {
          await runRichIngest(parseIngestCliOptions([
            '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
          ]));
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/sensitive|credential/i);
        expect(message).not.toContain(secret);
        expect(fs.readdirSync(vault)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('does not echo an untrusted media ID from a full Bundle write failure payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-hostile-media-id-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    const hostileId = ['media-', '<script>', 'alert-1'].join('');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
      version: 1,
      source: { url: 'https://example.com/source', kind: 'article', title: 'Source' },
      blocks: [{
        id: 'b1',
        kind: 'image',
        markdown: '![Remote](https://cdn.example.com/image.png)',
        mediaId: hostileId,
      }],
      media: [{
        id: hostileId,
        kind: 'image',
        url: 'https://cdn.example.com/image.png',
      }],
      provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: [] },
      warnings: [],
    }));
    try {
      let payload = '';
      try {
        await runRichIngest(parseIngestCliOptions([
          '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
        ]), {
          run() {
            return { stdout: '', stderr: '', status: 1 };
          },
        });
      } catch (error) {
        payload = JSON.stringify(ingestErrorPayload(error));
      }
      expect(payload).toMatch(/stage media|failed/i);
      expect(payload).not.toContain(hostileId);
      expect(fs.readdirSync(vault)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not echo an untrusted media ID from a finalizer media validation failure payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-hostile-finalizer-id-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    const hostileId = ['media-', '<img-onerror>', 'alert-2'].join('');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'asset-without-extension'), 'image');
    fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
      version: 1,
      source: { url: 'https://example.com/source', kind: 'article', title: 'Source' },
      blocks: [{
        id: 'b1',
        kind: 'image',
        markdown: '![Local](asset-without-extension)',
        mediaId: hostileId,
      }],
      media: [{
        id: hostileId,
        kind: 'image',
        path: 'asset-without-extension',
      }],
      provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: [] },
      warnings: [],
    }));
    try {
      let payload = '';
      try {
        await runRichIngest(parseIngestCliOptions([
          '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
        ]));
      } catch (error) {
        payload = JSON.stringify(ingestErrorPayload(error));
      }
      expect(payload).toMatch(/extension|media kind/i);
      expect(payload).not.toContain(hostileId);
      expect(fs.readdirSync(vault)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stages URL-only Bundle media into the transaction workspace before finalizing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-url-bundle-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    writeUrlOnlyArticleBundle(bundle);
    const stagedPaths: string[] = [];
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
      ]), remoteBundleMediaRunner(stagedPaths));

      expect(result.writeResult?.assetPaths).toHaveLength(1);
      expect(fs.readFileSync(result.writeResult!.assetPaths[0], 'utf8')).toBe('remote-image');
      expect(fs.readFileSync(result.writeResult!.notePath, 'utf8'))
        .toContain('![Remote diagram](images/image-001.png)');
      expect(stagedPaths).toHaveLength(1);
      expect(stagedPaths[0]).toContain(`${path.sep}me-ingest-run-`);
      expect(fs.existsSync(stagedPaths[0])).toBeFalse();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rolls back URL-only Bundle media staging failures without a partial artifact', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-url-bundle-failure-'));
    const vault = path.join(root, 'vault');
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(vault);
    fs.mkdirSync(bundle);
    writeUrlOnlyArticleBundle(bundle);
    try {
      await expect(runRichIngest(parseIngestCliOptions([
        '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
      ]), {
        run(command, args) {
          if (command === 'curl') {
            fs.writeFileSync(args[args.indexOf('-o') + 1], '<html>not an image</html>');
            return { stdout: 'text/html', stderr: '', status: 0 };
          }
          throw new Error(`Unexpected command: ${command}`);
        },
      })).rejects.toThrow(/content type|stage media/i);
      expect(fs.readdirSync(vault)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects explicit raw metadata-only video writes but allows a substantive raw video body', async () => {
    for (const substantive of [false, true]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-raw-video-'));
      const vault = path.join(root, 'vault');
      const bundle = path.join(root, 'bundle');
      fs.mkdirSync(vault);
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
        version: 1,
        source: {
          url: 'https://example.com/video',
          kind: 'video',
          title: substantive ? 'Substantive raw video' : 'Metadata only video',
          durationSec: 60,
        },
        blocks: substantive
          ? [{ id: 'b1', kind: 'paragraph', markdown: 'The speaker develops a complete argument with evidence, a counterexample, and a conclusion.' }]
          : [
            { id: 'b1', kind: 'heading', markdown: '# Metadata only video' },
            { id: 'b2', kind: 'paragraph', markdown: '> Author: Fixture · Duration: 60s' },
          ],
        media: [],
        provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: ['metadata'] },
        warnings: [],
      }));
      try {
        const operation = runRichIngest(parseIngestCliOptions([
          '--bundle', bundle, '--vault-dir', vault, '--mode', 'raw', '--write',
        ]));
        if (substantive) {
          const result = await operation;
          expect(fs.readFileSync(result.writeResult!.notePath, 'utf8')).toContain('complete argument');
        } else {
          await expect(operation).rejects.toThrow(/metadata-only|substantive|completeness/i);
          expect(fs.readdirSync(vault)).toEqual([]);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('offsets a 60s + 60s X playlist by media duration rather than the first transcript tail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-x-offset-'));
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    try {
      const result = await runRichIngest(parseIngestCliOptions([
        'https://x.com/example/status/duration-offset',
        '--vault-dir', vault,
        '--mode', 'transcribe',
      ]), xDurationPlaylistRunner());

      expect(result.content).toContain('**00:00–00:10**');
      expect(result.content).toContain('**01:00–01:10**');
      expect(result.content).not.toContain('**00:10–00:20**');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a provider transcript that exceeds its individual media duration', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ingest-x-offset-bounds-'));
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    try {
      await expect(runRichIngest(parseIngestCliOptions([
        'https://x.com/example/status/duration-offset',
        '--vault-dir', vault,
        '--mode', 'transcribe',
      ]), xDurationPlaylistRunner(61))).rejects.toThrow(/media duration|duration bound/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function bilibiliUrlRunner(transcribedInputs: string[]): CommandRunner {
  const metadata = {
    code: 0,
    data: {
      bvid: 'BV1fixture',
      title: 'Bilibili URL fixture',
      desc: 'No public CC.',
      pubdate: 1721865600,
      duration: 42,
      owner: { name: 'Fixture' },
      stat: { view: 1, danmaku: 0, like: 0, coin: 0, favorite: 0, share: 0 },
      pages: [{ cid: 123, page: 1, part: 'P1', duration: 42 }],
    },
  };
  return {
    run(command, args) {
      const target = args.at(-1) ?? '';
      if (command === 'curl' && target.includes('/x/web-interface/view')) {
        return { stdout: JSON.stringify(metadata), stderr: '', status: 0 };
      }
      if (command === 'curl' && target.includes('/x/player/v2')) {
        return { stdout: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), stderr: '', status: 0 };
      }
      if (command === 'which') {
        const executable = args[0];
        if (executable === 'yt-dlp' || executable === 'mlx-whisper') {
          return { stdout: `/safe/${executable}\n`, stderr: '', status: 0 };
        }
        throw new Error(`missing executable: ${executable}`);
      }
      if (command === '/safe/yt-dlp') {
        const template = args[args.indexOf('-o') + 1];
        fs.writeFileSync(template.replace('%(ext)s', 'wav'), 'audio');
        return { stdout: '', stderr: '', status: 0 };
      }
      if (command === '/safe/mlx-whisper') {
        const input = args[0];
        transcribedInputs.push(input);
        const outputDir = args[args.indexOf('--output-dir') + 1];
        fs.writeFileSync(path.join(outputDir, `${path.basename(input, path.extname(input))}.json`), JSON.stringify({
          segments: [{ start: 0, end: 42, text: 'Bilibili local transcript' }],
        }));
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function xTranscribeUrlRunner(): CommandRunner {
  const url = 'https://x.com/example/status/456';
  return {
    run(command, args) {
      if (command === 'yt-dlp' && args[0] === '--dump-single-json') {
        return {
          stdout: JSON.stringify({
            id: '456',
            title: 'Public X video',
            uploader: 'fixture',
            duration: 42,
            ext: 'mp4',
            webpage_url: url,
            vcodec: 'avc1',
            acodec: 'mp4a.40.2',
          }),
          stderr: '',
          status: 0,
        };
      }
      if (command === 'yt-dlp') {
        const template = args[args.indexOf('-o') + 1];
        const actual = template.replace('%(id)s', '456').replace('%(ext)s', 'mp4');
        fs.writeFileSync(actual, 'video');
        return { stdout: `${actual}\n`, stderr: '', status: 0 };
      }
      if (command === 'which') {
        if (args[0] === 'mlx-whisper') return { stdout: '/safe/mlx-whisper\n', stderr: '', status: 0 };
        throw new Error(`missing executable: ${args[0]}`);
      }
      if (command === '/safe/mlx-whisper') {
        const input = args[0];
        const outputDir = args[args.indexOf('--output-dir') + 1];
        const output = path.join(outputDir, `${path.basename(input, path.extname(input))}.json`);
        fs.writeFileSync(output, JSON.stringify({
          segments: [{ start: 0, end: 42, text: 'X transcript text' }],
        }));
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function inlineDuplicateArticleRunner(url: string, downloadedUrls: string[] = []): CommandRunner {
  let download = 0;
  const markdown = [
    '# Inline duplicate article',
    '',
    [
      'Before the first occurrence.',
      '![same](https://cdn.example.com/same.png)',
      'Between the duplicate occurrences.',
      '![same](https://cdn.example.com/same.png)',
      'After the second occurrence.',
    ].join(' '),
    '',
    '`![inline-code](https://cdn.example.com/inline-code.png)`',
    '',
    '```md',
    '![fenced-code](https://cdn.example.com/fenced-code.png)',
    '```',
    '',
    'This substantive public article body is intentionally long enough for the X Article readability gate. '
      + 'It contains ordinary explanatory prose, evidence, and a conclusion without depending on a live source. '.repeat(2),
    '',
  ].join('\n');
  return {
    run(command, args) {
      if (command === 'yt-dlp') return { stdout: '', stderr: 'not a video', status: 1 };
      if (command === 'defuddle') {
        expect(args).toEqual(['parse', url, '--md']);
        return { stdout: markdown, stderr: '', status: 0 };
      }
      if (command === 'curl' && args.includes('-I')) {
        return { stdout: 'text/html; charset=utf-8', stderr: '', status: 0 };
      }
      if (command === 'curl') {
        const destination = args[args.indexOf('-o') + 1];
        downloadedUrls.push(args.at(-1) ?? '');
        download += 1;
        fs.writeFileSync(destination, `download-${download}`);
        return { stdout: 'image/png', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

function writeUrlOnlyArticleBundle(bundle: string): void {
  fs.writeFileSync(path.join(bundle, 'source-bundle.json'), JSON.stringify({
    version: 1,
    source: { url: 'https://example.com/remote-article', kind: 'article', title: 'Remote media article' },
    blocks: [
      { id: 'b1', kind: 'paragraph', markdown: 'Before the diagram.' },
      {
        id: 'b2',
        kind: 'image',
        markdown: '![Remote diagram](https://cdn.example.com/diagram.png)',
        mediaId: 'image-001',
      },
      { id: 'b3', kind: 'paragraph', markdown: 'After the diagram.' },
    ],
    media: [{
      id: 'image-001',
      kind: 'image',
      url: 'https://cdn.example.com/diagram.png',
      alt: 'Remote diagram',
    }],
    provenance: { extractor: 'fixture', extractedAt: '2026-07-25T00:00:00Z', methods: ['fixture'] },
    warnings: [],
  }));
}

function remoteBundleMediaRunner(stagedPaths: string[]): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'curl') throw new Error(`Unexpected command: ${command}`);
      const destination = args[args.indexOf('-o') + 1];
      stagedPaths.push(destination);
      fs.writeFileSync(destination, 'remote-image');
      return { stdout: 'image/png', stderr: '', status: 0 };
    },
  };
}

function xDurationPlaylistRunner(firstSegmentEnd = 10): CommandRunner {
  const url = 'https://x.com/example/status/duration-offset';
  let transcription = 0;
  return {
    run(command, args) {
      if (command === 'yt-dlp' && args[0] === '--dump-single-json') {
        return {
          stdout: JSON.stringify({
            _type: 'playlist',
            id: 'duration-offset',
            title: 'Duration offset playlist',
            entries: [
              {
                id: 'clip-1',
                title: 'First 60 second clip',
                webpage_url: url,
                duration: 60,
                ext: 'mp4',
                vcodec: 'avc1',
                acodec: 'mp4a',
              },
              {
                id: 'clip-2',
                title: 'Second 60 second clip',
                webpage_url: url,
                duration: 60,
                ext: 'mp4',
                vcodec: 'avc1',
                acodec: 'mp4a',
              },
            ],
          }),
          stderr: '',
          status: 0,
        };
      }
      if (command === 'yt-dlp') {
        const template = args[args.indexOf('-o') + 1];
        const selected = args[args.indexOf('--playlist-items') + 1];
        const actual = template
          .replace('%(id)s', selected === '2' ? 'clip-2' : 'clip-1')
          .replace('%(ext)s', 'mp4');
        fs.writeFileSync(actual, selected === '2' ? 'second' : 'first');
        return { stdout: `${actual}\n`, stderr: '', status: 0 };
      }
      if (command === 'which') {
        if (args[0] === 'mlx-whisper') return { stdout: '/safe/mlx-whisper\n', stderr: '', status: 0 };
        throw new Error(`missing executable: ${args[0]}`);
      }
      if (command === '/safe/mlx-whisper') {
        transcription += 1;
        const input = args[0];
        const outputDir = args[args.indexOf('--output-dir') + 1];
        const end = transcription === 1 ? firstSegmentEnd : 10;
        fs.writeFileSync(path.join(outputDir, `${path.basename(input, path.extname(input))}.json`), JSON.stringify({
          segments: [{
            start: 0,
            end,
            text: transcription === 1 ? 'First clip transcript' : 'Second clip transcript',
          }],
        }));
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}
