import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdapterRegistry, AdapterExtractionError } from '../bin/ingest/registry.ts';
import type { SourceAdapter } from '../bin/ingest/contracts.ts';
import {
  createRichIngestRegistry,
  parseIngestCliOptions,
  resolveIngestMode,
  runRichIngest,
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
});

describe('rich ingest CLI orchestration', () => {
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
});
