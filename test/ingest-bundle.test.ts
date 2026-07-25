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

test('rejects URL userinfo and sensitive query keys or values without leaking the matched value', () => {
  const secret = ['very', 'private', 'value'].join('-');
  const tokenKey = ['access', 'token'].join('_');
  const cases = [
    `https://reader:${secret}@example.com/source`,
    `https://example.com/source?${tokenKey}=${secret}`,
    `https://example.com/source?apikey=${secret}`,
    `https://example.com/source?download=${encodeURIComponent(`Bearer ${secret}`)}`,
  ];

  for (const url of cases) {
    let message = '';
    try {
      validateSourceBundle(bundle({
        source: { url, kind: 'article', title: 'Source' },
      }), fixture('bundle-valid'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/sensitive|credential/i);
    expect(message).not.toContain(secret);
  }
});

test('rejects credential headers and absolute local paths in provenance and non-body metadata', () => {
  const secret = ['private', 'credential', 'value'].join('-');
  const headerName = ['Authoriza', 'tion'].join('');
  const localPath = ['/', 'Users', '/', 'name', '/', 'private.txt'].join('');
  const cases = [
    { provenance: { extractor: 'test', extractedAt: NOW, methods: [`${headerName}: Bearer ${secret}`] } },
    { provenance: { extractor: localPath, extractedAt: NOW, methods: [] } },
    { source: { url: 'https://example.com/source', kind: 'article', title: localPath } },
    { warnings: [{ code: 'source-warning', message: `${headerName}: Bearer ${secret}` }] },
  ];

  for (const invalid of cases) {
    let message = '';
    try {
      validateSourceBundle(bundle(invalid), fixture('bundle-valid'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/sensitive|local path/i);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(localPath);
  }
});

test('rejects audited sensitive query keys and high-confidence tokens across non-body values without echoing them', () => {
  const secret = ['sk', '-', 'A'.repeat(32)].join('');
  const queryKeys = [
    ['au', 'th'].join(''),
    ['X', '-Amz-', 'Credential'].join(''),
    ['X', '-Amz-', 'Signature'].join(''),
    ['decrypt', '-', 'key'].join(''),
    ['client', '_', 'secret'].join(''),
    ['access', '-', 'key'].join(''),
  ];
  const cases: Array<Record<string, unknown>> = [
    ...queryKeys.map(key => ({
      source: {
        url: `https://example.com/source?${encodeURIComponent(key)}=${encodeURIComponent(secret)}`,
        kind: 'article',
        title: 'Source',
      },
    })),
    { source: { url: 'https://example.com/source', kind: 'article', title: secret } },
    {
      provenance: {
        extractor: 'test',
        extractedAt: NOW,
        methods: [`${['client', '_', 'secret'].join('')}=${secret}`],
      },
    },
    {
      media: [{
        id: secret,
        kind: 'image',
        url: 'https://cdn.example.com/image.png',
      }],
    },
    {
      warnings: [{
        code: 'credential-warning',
        message: `${['access', '-', 'key'].join('')}=${secret}`,
      }],
    },
  ];

  for (const invalid of cases) {
    let message = '';
    try {
      validateSourceBundle(bundle(invalid), fixture('bundle-valid'));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/sensitive|credential/i);
    expect(message).not.toContain(secret);
  }
});

test('does not treat quoted source body prose as executable metadata', () => {
  const headerName = ['Authoriza', 'tion'].join('');
  const localPath = ['/', 'Users', '/', 'example', '/', 'quoted.txt'].join('');
  const exampleToken = ['sk', '-', 'B'.repeat(32)].join('');
  const validated = validateSourceBundle(bundle({
    blocks: [{
      id: 'b1',
      kind: 'quote',
      markdown: `The article discusses auth, X-Amz-Credential, "${headerName}: Bearer illustrative-value", ${exampleToken}, and ${localPath}.`,
    }],
    transcript: [{
      start: 0,
      end: 2,
      text: `Spoken prose mentions ${exampleToken} and ${localPath} without granting filesystem access.`,
    }],
  }), fixture('bundle-valid'));

  expect(validated.blocks).toHaveLength(1);
  expect(validated.transcript).toHaveLength(1);
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

test('accepts only positive finite per-media durations', () => {
  expect(validateSourceBundle(bundle({
    media: [{ id: 'm1', kind: 'video', url: 'https://cdn.example.com/video.mp4', durationSec: 60 }],
  }), fixture('bundle-valid')).media[0].durationSec).toBe(60);

  expect(() => validateSourceBundle(bundle({
    media: [{ id: 'm1', kind: 'video', url: 'https://cdn.example.com/video.mp4', durationSec: 0 }],
  }), fixture('bundle-valid'))).toThrow(/duration/i);
});
