import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExtractedSource } from '../bin/ingest/contracts.ts';
import type { HandoutResult } from '../bin/ingest/handout.ts';
import {
  finalizeIngest,
  type FinalizeInput,
} from '../bin/ingest/finalize.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function makeVault(raw = 'knowledge/raw'): string {
  const vault = temporaryDirectory('me-finalize-vault-');
  fs.mkdirSync(path.join(vault, '.me', 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(vault, raw), { recursive: true });
  fs.mkdirSync(path.join(vault, 'knowledge/practices'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'knowledge/cognition'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.me', 'config.yaml'), [
    'layers:',
    `  raw: ${raw}`,
    '  practices: knowledge/practices',
    '  cognition: knowledge/cognition',
    '',
  ].join('\n'));
  return vault;
}

function writeAsset(vault: string, name: string, contents = 'image bytes'): string {
  const assetPath = path.join(vault, '.me', 'tmp', name);
  fs.writeFileSync(assetPath, contents);
  return assetPath;
}

function articleSource(vault: string, assetPath = writeAsset(vault, 'source.jpg')): ExtractedSource {
  return {
    source: {
      url: 'https://example.com/article',
      kind: 'article',
      title: 'Atomic Ingest Guide',
      publishedAt: '2026-07-24',
    },
    blocks: [
      { id: 'block-001', kind: 'paragraph', markdown: '段落一' },
      { id: 'block-002', kind: 'image', markdown: '![旧引用](/tmp/source.jpg)', mediaId: 'image-001' },
      { id: 'block-003', kind: 'paragraph', markdown: '段落二' },
    ],
    media: [
      { id: 'image-001', kind: 'image', path: assetPath, alt: '图一' },
    ],
    provenance: {
      extractor: 'fixture',
      extractedAt: '2026-07-25T00:00:00Z',
      methods: ['fixture'],
    },
    warnings: [],
  };
}

function validArticleInput(vault: string): FinalizeInput {
  return {
    vaultDir: vault,
    source: articleSource(vault),
    topic: 'atomic-ingest',
    stem: '2026-07-25-atomic-ingest-guide',
    created: '2026-07-25',
    tags: ['ingest', 'atomic'],
  };
}

function stagingEntries(vault: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.name.startsWith('.me-ingest-staging-')) found.push(fullPath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(fullPath);
    }
  };
  walk(vault);
  return found;
}

function expectedNote(vault: string): string {
  return path.join(vault, 'knowledge/raw/atomic-ingest/2026-07-25-atomic-ingest-guide.md');
}

describe('finalizeIngest', () => {
  test('leaves no destination or staging files after validation failure', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    input.source.media[0].path = path.join(vault, '.me', 'tmp', 'missing.jpg');

    expect(() => finalizeIngest(input)).toThrow(/missing asset/);
    expect(stagingEntries(vault)).toEqual([]);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('copies assets and rewrites markdown in source order', () => {
    const vault = makeVault();
    const result = finalizeIngest(validArticleInput(vault));
    const note = fs.readFileSync(result.notePath, 'utf8');

    expect(note).toContain('段落一\n\n![图一](images/image-001.jpg)\n\n段落二');
    expect(fs.readFileSync(path.join(path.dirname(result.notePath), 'images', 'image-001.jpg'), 'utf8'))
      .toBe('image bytes');
    expect(result.assetPaths).toEqual([
      path.join(path.dirname(result.notePath), 'images', 'image-001.jpg'),
    ]);
  });

  test('adds an unreachable note to the nearest README', () => {
    const vault = makeVault();
    const result = finalizeIngest(validArticleInput(vault));
    const readmePath = path.join(path.dirname(result.notePath), 'README.md');

    expect(result.readmePath).toBe(readmePath);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain(`[[${result.stem}]]`);
  });

  test('rejects an asset outside the allowed roots and an escaping asset symlink', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-finalize-private-');
    const privatePath = path.join(outside, 'private.jpg');
    fs.writeFileSync(privatePath, 'private');
    const direct = validArticleInput(vault);
    direct.source.media[0].path = privatePath;

    expect(() => finalizeIngest(direct)).toThrow(/outside allowed resource roots/);

    const nonexistentOutside = validArticleInput(vault);
    nonexistentOutside.source.media[0].path = path.join(outside, 'does-not-exist.jpg');
    expect(() => finalizeIngest(nonexistentOutside)).toThrow(/outside allowed resource roots/);

    const symlink = path.join(vault, '.me', 'tmp', 'linked.jpg');
    fs.symlinkSync(privatePath, symlink);
    const linked = validArticleInput(vault);
    linked.source.media[0].path = symlink;
    expect(() => finalizeIngest(linked)).toThrow(/outside allowed resource roots/);
    expect(stagingEntries(vault)).toEqual([]);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('accepts a resource only when its external root is explicitly allowed', () => {
    const vault = makeVault();
    const bundle = temporaryDirectory('me-finalize-bundle-');
    const assetPath = path.join(bundle, 'figure.png');
    fs.writeFileSync(assetPath, 'bundle image');
    const input = validArticleInput(vault);
    input.source = articleSource(vault, assetPath);
    input.allowedResourceRoots = [bundle];

    const result = finalizeIngest(input);
    expect(fs.readFileSync(result.assetPaths[0], 'utf8')).toBe('bundle image');
  });

  test('rejects target and configured layer traversal without writing outside the vault', () => {
    const vault = makeVault();
    const traversingTopic = validArticleInput(vault);
    traversingTopic.topic = '../escape';

    expect(() => finalizeIngest(traversingTopic)).toThrow(/target path is outside vault/);
    expect(fs.existsSync(path.join(vault, 'knowledge/escape'))).toBeFalse();

    const unsafeVault = makeVault('../escaped-raw');
    const unsafeInput = validArticleInput(unsafeVault);
    expect(() => finalizeIngest(unsafeInput)).toThrow(/target path is outside vault/);
    expect(stagingEntries(unsafeVault)).toEqual([]);
  });

  test('does not overwrite an existing note or asset', () => {
    const vault = makeVault();
    const notePath = expectedNote(vault);
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, 'keep existing note');

    expect(() => finalizeIngest(validArticleInput(vault))).toThrow(/destination already exists/);
    expect(fs.readFileSync(notePath, 'utf8')).toBe('keep existing note');

    fs.rmSync(notePath);
    const assetPath = path.join(path.dirname(notePath), 'images', 'image-001.jpg');
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'keep existing asset');
    expect(() => finalizeIngest(validArticleInput(vault))).toThrow(/destination already exists/);
    expect(fs.readFileSync(assetPath, 'utf8')).toBe('keep existing asset');
  });

  test('validates frontmatter schema and handout omissions before publishing', () => {
    const vault = makeVault();
    const invalidFrontmatter = validArticleInput(vault);
    invalidFrontmatter.frontmatter = [
      '---',
      'title: "Atomic Ingest Guide"',
      'created: 2026-07-25',
      'tags: []',
      'type: article',
      'source: "https://example.com/article"',
      'status: done',
      '---',
    ].join('\n');
    expect(() => finalizeIngest(invalidFrontmatter)).toThrow(/frontmatter schema/);

    const handoutSource: ExtractedSource = {
      ...articleSource(vault),
      source: {
        url: 'https://example.com/video',
        kind: 'video',
        title: 'Complete Course',
        durationSec: 10,
      },
      blocks: [],
      transcript: [{ start: 0, end: 10, text: '完整内容' }],
      media: [],
    };
    const handout: HandoutResult = {
      kind: 'topic',
      markdown: '# Complete Course（讲义）\n\n完整内容\n',
      usedMediaIds: [],
      omittedTranscriptSegments: [0],
      warnings: ['incomplete-transcript-mapping'],
    };
    expect(() => finalizeIngest({
      vaultDir: vault,
      source: handoutSource,
      handout,
      topic: 'courses',
      stem: '2026-07-25-complete-course',
      created: '2026-07-25',
    })).toThrow(/omitted transcript/);

    expect(stagingEntries(vault)).toEqual([]);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('rolls back the artifact when the README replacement fails', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    const parent = path.dirname(expectedNote(vault));
    fs.mkdirSync(path.join(parent, 'README.md', 'not-a-file'), { recursive: true });

    expect(() => finalizeIngest(input)).toThrow(/README/);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    expect(fs.existsSync(path.join(parent, 'images', 'image-001.jpg'))).toBeFalse();
    expect(fs.statSync(path.join(parent, 'README.md')).isDirectory()).toBeTrue();
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('preserves an existing README byte-for-byte when its temp rename fails after artifact publish', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    const parent = path.dirname(expectedNote(vault));
    const readmePath = path.join(parent, 'README.md');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(readmePath, '# Existing index\n\nKeep this text.\n');

    expect(() => finalizeIngest(input, {
      renameSync(source, destination) {
        if (
          path.basename(source.toString()).startsWith('.README.md.me-ingest-')
          && destination.toString() === readmePath
        ) {
          throw new Error('injected README rename failure');
        }
        fs.renameSync(source, destination);
      },
    })).toThrow(/README update failed/);

    expect(fs.readFileSync(readmePath, 'utf8')).toBe('# Existing index\n\nKeep this text.\n');
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    expect(fs.existsSync(path.join(parent, 'images', 'image-001.jpg'))).toBeFalse();
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('rolls back only transaction-owned files when an asset rename fails', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    const secondSource = writeAsset(vault, 'second.png', 'second image');
    input.source.blocks.push({
      id: 'block-004',
      kind: 'figure',
      markdown: '![第二张](/tmp/second.png)',
      mediaId: 'figure-002',
    });
    input.source.media.push({
      id: 'figure-002',
      kind: 'figure',
      path: secondSource,
      alt: '第二张',
    });
    const images = path.join(path.dirname(expectedNote(vault)), 'images');
    const sentinel = path.join(images, 'not-created-by-finalizer.txt');

    expect(() => finalizeIngest(input, {
      renameSync(source, destination) {
        if (destination.toString().endsWith('image-002.png')) {
          fs.writeFileSync(sentinel, 'keep me');
          throw new Error('injected second asset failure');
        }
        fs.renameSync(source, destination);
      },
    })).toThrow(/injected second asset failure/);

    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(images, 'image-001.jpg'))).toBeFalse();
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('returns related notes, backlinks, and unlinked mentions without editing notes', () => {
    const vault = makeVault();
    const raw = path.join(vault, 'knowledge/raw');
    const relatedPath = path.join(raw, 'related.md');
    const backlinkPath = path.join(raw, 'backlink.md');
    const mentionPath = path.join(raw, 'mention.md');
    const related = [
      '---',
      'title: "Atomic Ingest Patterns"',
      'created: 2026-07-20',
      'tags: [ingest]',
      'type: article',
      'source: "https://example.com/related"',
      '---',
      '',
      'Related content.',
      '',
    ].join('\n');
    const backlink = 'See [[2026-07-25-atomic-ingest-guide]] for details.\n';
    const mention = 'Atomic Ingest Guide is named here without a wikilink.\n';
    fs.writeFileSync(relatedPath, related);
    fs.writeFileSync(backlinkPath, backlink);
    fs.writeFileSync(mentionPath, mention);

    const result = finalizeIngest(validArticleInput(vault));

    expect(result.relatedNotes).toContainEqual({
      path: path.relative(vault, relatedPath),
      score: 4,
    });
    expect(result.backlinks).toContainEqual({
      path: path.relative(vault, backlinkPath),
      count: 1,
    });
    expect(result.unlinkedMentions).toContain(path.relative(vault, mentionPath));
    expect(fs.readFileSync(relatedPath, 'utf8')).toBe(related);
    expect(fs.readFileSync(backlinkPath, 'utf8')).toBe(backlink);
    expect(fs.readFileSync(mentionPath, 'utf8')).toBe(mention);
    expect(result.readmePath).toBeUndefined();
  });

  test('publishes handout slides under one atomic artifact directory', () => {
    const vault = makeVault();
    const slide = writeAsset(vault, 'slide one.jpg', 'slide');
    const source: ExtractedSource = {
      source: {
        url: 'https://example.com/course',
        kind: 'course',
        title: 'Complete Course',
        durationSec: 60,
      },
      blocks: [],
      transcript: [{ start: 0, end: 60, text: '完整课程内容' }],
      media: [{
        id: 'slide-001',
        kind: 'slide',
        path: slide,
        alt: '第一页',
        timestampSec: 0,
      }],
      provenance: {
        extractor: 'fixture',
        extractedAt: '2026-07-25T00:00:00Z',
        methods: ['fixture'],
      },
      warnings: [],
    };
    const handout: HandoutResult = {
      kind: 'slide',
      markdown: '# Complete Course（讲义）\n\n![第一页](<slides/slide one.jpg>)\n\n完整课程内容\n',
      usedMediaIds: ['slide-001'],
      omittedTranscriptSegments: [],
      warnings: [],
    };

    const result = finalizeIngest({
      vaultDir: vault,
      source,
      handout,
      topic: 'courses',
      stem: '2026-07-25-complete-course',
      created: '2026-07-25',
    });

    expect(result.notePath).toBe(path.join(
      vault,
      'knowledge/raw/courses/2026-07-25-complete-course/2026-07-25-complete-course.md',
    ));
    expect(fs.readFileSync(result.notePath, 'utf8')).toContain('![第一页](<slides/slide one.jpg>)');
    expect(fs.readFileSync(path.join(path.dirname(result.notePath), 'slides', 'slide one.jpg'), 'utf8'))
      .toBe('slide');
  });
});
