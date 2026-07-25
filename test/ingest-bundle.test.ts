import { expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BundleValidationError,
  loadSourceBundle,
  validateSourceBundle,
} from '../bin/ingest/bundle.ts';

const NOW = '2026-07-25T00:00:00Z';
const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', 'ingest', name);

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: { url: 'https://example.com/source', kind: 'article', title: 'Source' },
    blocks: [{ id: 'b1', kind: 'paragraph', markdown: 'Body' }],
    media: [],
    provenance: { extractor: 'test', extractedAt: NOW, methods: [] },
    warnings: [],
    ...overrides,
  };
}

test('loads a valid bundle with normalized asset paths', () => {
  const source = loadSourceBundle(fixture('bundle-valid'));
  expect(source.media[0].path).toBe(fixture('bundle-valid/assets/slide-001.txt'));
});

test('accepts http(s) source URLs', () => {
  expect(validateSourceBundle(bundle({ source: { url: 'https://example.com/source', kind: 'article', title: 'Source' } }), fixture('bundle-valid')).source.url)
    .toBe('https://example.com/source');
});

test('rejects an unknown top-level field containing a local absolute path', () => {
  expect(() => validateSourceBundle(
    bundle({ localPath: '/Users/name/private' }),
    fixture('bundle-valid'),
  )).toThrow(BundleValidationError);
});

test.each([
  { source: { url: 'file:///Users/name/private', kind: 'article', title: 'Source' } },
  { source: { url: 'https://example.com/source', kind: 'article', title: 'Source', localPath: '/Users/name/private' } },
  { media: [{ id: 'm1', kind: 'image', localPath: '/Users/name/private' }] },
])('rejects local absolute paths in URL or unknown fields', invalid => {
  expect(() => validateSourceBundle(bundle(invalid), fixture('bundle-valid'))).toThrow(BundleValidationError);
});

test.each(['../outside.jpg', '/tmp/secret.jpg'])('rejects unsafe media path %s', unsafe => {
  expect(() => validateSourceBundle(bundle({ media: [{ id: 'm1', kind: 'image', path: unsafe }] }), fixture('bundle-valid')))
    .toThrow(BundleValidationError);
});

test.each(['cookie', 'authorization', 'token', 'decryptKey'])('rejects forbidden key %s recursively', key => {
  expect(() => validateSourceBundle(bundle({ provenance: { extractor: 'x', extractedAt: NOW, methods: [], [key]: 'secret' } }), fixture('bundle-valid')))
    .toThrow(/forbidden/i);
});

test('rejects overlapping or unsorted transcript segments', () => {
  expect(() => validateSourceBundle(bundle({ transcript: [
    { start: 10, end: 20, text: 'later' },
    { start: 5, end: 9, text: 'earlier' },
  ] }), fixture('bundle-valid'))).toThrow(/sorted/i);
});

test('rejects duplicate block or media IDs and unresolved media references', () => {
  const invalid = bundle({
    blocks: [
      { id: 'b1', kind: 'paragraph', markdown: 'One', mediaId: 'missing' },
      { id: 'b1', kind: 'paragraph', markdown: 'Two' },
    ],
    media: [
      { id: 'm1', kind: 'image' },
      { id: 'm1', kind: 'image' },
    ],
  });

  expect(() => validateSourceBundle(invalid, fixture('bundle-valid'))).toThrow(BundleValidationError);
});

test('rejects an empty block mediaId', () => {
  expect(() => validateSourceBundle(bundle({
    blocks: [{ id: 'b1', kind: 'paragraph', markdown: 'Body', mediaId: '' }],
  }), fixture('bundle-valid'))).toThrow(/mediaId/i);
});

test('rejects media resources that do not exist within the bundle', () => {
  expect(() => validateSourceBundle(
    bundle({ media: [{ id: 'm1', kind: 'image', path: 'assets/missing.jpg' }] }),
    fixture('bundle-valid'),
  )).toThrow(/does not exist/i);
});

test('rejects a bundle-relative symlink whose target escapes the bundle root', () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-bundle-outside-'));
  const linkPath = path.join(fixture('bundle-valid'), 'assets', 'escape.txt');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), linkPath);
  try {
    expect(() => validateSourceBundle(
      bundle({ media: [{ id: 'm1', kind: 'image', path: 'assets/escape.txt' }] }),
      fixture('bundle-valid'),
    )).toThrow(/escapes bundle root/i);
  } finally {
    fs.unlinkSync(linkPath);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('rejects invalid transcript bounds', () => {
  expect(() => validateSourceBundle(bundle({ transcript: [{ start: 3, end: 3, text: 'invalid' }] }), fixture('bundle-valid')))
    .toThrow(/start/i);
});
