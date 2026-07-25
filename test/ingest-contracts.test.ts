import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry, AdapterExtractionError } from '../bin/ingest/registry.ts';
import type { SourceAdapter } from '../bin/ingest/contracts.ts';

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
