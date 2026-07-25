import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry, AdapterExtractionError } from '../bin/ingest/registry.ts';
import type { SourceAdapter } from '../bin/ingest/contracts.ts';

const html: SourceAdapter = {
  id: 'html',
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
});
