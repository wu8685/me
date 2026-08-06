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
import {
  acquireVaultLock,
  releaseVaultLock,
} from '../bin/cooperative-lock.ts';
import {
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
} from '../bin/runtime-paths.ts';

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
  const fixture = temporaryDirectory('me-finalize-vault-');
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'resources'));
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

function resourceRoot(vault: string): string {
  return path.join(path.dirname(vault), 'resources');
}

function writeAsset(vault: string, name: string, contents = 'image bytes'): string {
  const assetPath = path.join(resourceRoot(vault), name);
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
    trustedResourceRoots: [resourceRoot(vault)],
  };
}

const RAW_VISUAL_CASES = [
  ['image', 'video'],
  ['figure', 'course'],
  ['slide', 'video'],
  ['frame', 'course'],
] as const;

function rawVisualInput(
  vault: string,
  mediaKind: typeof RAW_VISUAL_CASES[number][0],
  sourceKind: typeof RAW_VISUAL_CASES[number][1],
  referenceCount = 1,
): FinalizeInput {
  const mediaId = `visual-${mediaKind}`;
  const stem = `2026-07-25-raw-${mediaKind}`;
  return {
    vaultDir: vault,
    source: {
      source: {
        url: `https://example.com/${sourceKind}/${mediaKind}`,
        kind: sourceKind,
        title: `Raw ${mediaKind}`,
        durationSec: 60,
      },
      blocks: Array.from({ length: referenceCount }, (_, index) => ({
        id: `block-${index + 1}`,
        kind: mediaKind === 'figure' ? 'figure' as const : 'image' as const,
        markdown: `![Visual ${index + 1}](source-${mediaKind}.jpg)`,
        mediaId,
      })),
      media: [{
        id: mediaId,
        kind: mediaKind,
        path: writeAsset(vault, `source-${mediaKind}.jpg`, `${mediaKind} bytes`),
        alt: `${mediaKind} visual`,
      }],
      provenance: {
        extractor: 'fixture',
        extractedAt: '2026-07-25T00:00:00Z',
        methods: ['fixture'],
      },
      warnings: [],
    },
    topic: 'raw-visual',
    stem,
    created: '2026-07-25',
    trustedResourceRoots: [resourceRoot(vault)],
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

function vaultRuntimeMarkers(vault: string): string[] {
  const markers: string[] = [];
  const walk = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (
        entry.name.startsWith('.me-ingest-')
        || entry.name === 'ingest-reservations'
      ) {
        markers.push(path.relative(vault, candidate));
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(candidate);
    }
  };
  walk(vault);
  return markers.sort();
}

function expectedNote(vault: string): string {
  return path.join(
    vault,
    'knowledge/raw/atomic-ingest/2026-07-25-atomic-ingest-guide/2026-07-25-atomic-ingest-guide.md',
  );
}

describe('finalizeIngest', () => {
  test('leaves no destination or staging files after validation failure', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    input.source.media[0].path = path.join(resourceRoot(vault), 'missing.jpg');

    expect(() => finalizeIngest(input)).toThrow(/missing asset/);
    expect(stagingEntries(vault)).toEqual([]);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('copies assets and rewrites markdown in source order', () => {
    const vault = makeVault();
    const runtime = resolveRuntimeLayout(vault);
    let observedExternalState = false;
    const result = finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        observedExternalState = true;
        expect(vaultRuntimeMarkers(vault)).toEqual([]);
        expect(fs.readdirSync(runtime.ingestLockDir).length).toBeGreaterThan(0);
        expect(fs.readdirSync(runtime.ingestStagingDir).length).toBeGreaterThan(0);
      },
      renameSync: fs.renameSync,
    });
    const note = fs.readFileSync(result.notePath, 'utf8');

    expect(observedExternalState).toBeTrue();
    expect(vaultRuntimeMarkers(vault)).toEqual([]);
    expect(fs.readdirSync(runtime.ingestLockDir)).toEqual([]);
    expect(fs.readdirSync(runtime.ingestStagingDir)).toEqual([]);
    expect(result.notePath).toBe(expectedNote(vault));
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
    const readmePath = path.join(path.dirname(path.dirname(result.notePath)), 'README.md');

    expect(result.readmePath).toBe(readmePath);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain(`[[${result.stem}]]`);
  });

  test('rejects an asset outside trusted roots and an escaping asset symlink', () => {
    const vault = makeVault();
    const outside = temporaryDirectory('me-finalize-private-');
    const privatePath = path.join(outside, 'private.jpg');
    fs.writeFileSync(privatePath, 'private');
    const direct = validArticleInput(vault);
    direct.source.media[0].path = privatePath;

    expect(() => finalizeIngest(direct)).toThrow(/outside trusted resource roots/);

    const nonexistentOutside = validArticleInput(vault);
    nonexistentOutside.source.media[0].path = path.join(outside, 'does-not-exist.jpg');
    expect(() => finalizeIngest(nonexistentOutside)).toThrow(/outside trusted resource roots/);

    const symlink = path.join(resourceRoot(vault), 'linked.jpg');
    fs.symlinkSync(privatePath, symlink);
    const linked = validArticleInput(vault);
    linked.source.media[0].path = symlink;
    expect(() => finalizeIngest(linked)).toThrow(/outside trusted resource roots/);
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
    input.trustedResourceRoots = [bundle];

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

    expect(() => finalizeIngest(validArticleInput(vault))).toThrow(/duplicate stem|destination already exists/);
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
      includedTranscriptSegments: [],
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
      trustedResourceRoots: [resourceRoot(vault)],
    })).toThrow(/omitted transcript/);

    expect(stagingEntries(vault)).toEqual([]);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('rolls back the artifact when the README replacement fails', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    const parent = path.dirname(path.dirname(expectedNote(vault)));
    fs.mkdirSync(path.join(parent, 'README.md', 'not-a-file'), { recursive: true });

    expect(() => finalizeIngest(input)).toThrow(/README/);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    expect(fs.existsSync(path.dirname(expectedNote(vault)))).toBeFalse();
    expect(fs.statSync(path.join(parent, 'README.md')).isDirectory()).toBeTrue();
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('preserves an existing README byte-for-byte when its temp rename fails after artifact publish', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    const parent = path.dirname(path.dirname(expectedNote(vault)));
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
    expect(fs.existsSync(path.dirname(expectedNote(vault)))).toBeFalse();
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('publishes a second illustrated article in the same topic without resource collisions', () => {
    const vault = makeVault();
    const first = finalizeIngest(validArticleInput(vault));
    const second = validArticleInput(vault);
    second.stem = '2026-07-25-second-atomic-guide';
    second.source.source.title = 'Second Atomic Guide';
    second.source.media[0].path = writeAsset(vault, 'second.jpg', 'second image');

    const result = finalizeIngest(second);

    expect(fs.readFileSync(first.assetPaths[0], 'utf8')).toBe('image bytes');
    expect(fs.readFileSync(result.assetPaths[0], 'utf8')).toBe('second image');
    expect(path.dirname(first.notePath)).not.toBe(path.dirname(result.notePath));
  });

  test('does not overwrite a destination created in the check-to-rename window', () => {
    const vault = makeVault();
    const artifact = path.dirname(expectedNote(vault));
    const userFile = path.join(artifact, 'user-created.txt');

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish(destination) {
        expect(destination).toBe(artifact);
        fs.mkdirSync(artifact);
        fs.writeFileSync(userFile, 'user data');
      },
      renameSync: fs.renameSync,
    })).toThrow(/destination.*exists|publish/i);

    expect(fs.readFileSync(userFile, 'utf8')).toBe('user data');
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('serializes cooperating finalizers with an exclusive topic lock', () => {
    const vault = makeVault();
    let nestedAttempted = false;
    const second = validArticleInput(vault);
    second.stem = '2026-07-25-second-atomic-guide';
    second.source.source.title = 'Second Atomic Guide';
    second.source.media[0].path = writeAsset(vault, 'second.jpg', 'second');

    const first = finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        nestedAttempted = true;
        expect(() => finalizeIngest(second)).toThrow(/locked|in progress/i);
      },
      renameSync: fs.renameSync,
    });

    expect(nestedAttempted).toBeTrue();
    expect(fs.existsSync(first.notePath)).toBeTrue();
    expect(fs.existsSync(path.dirname(first.notePath))).toBeTrue();
  });

  test('a me-update owner blocks ingest without publishing content', () => {
    const vault = makeVault();
    const runtime = resolveRuntimeLayout(vault);
    bootstrapRuntimeDirectories(runtime, [runtime.lockDir]);
    const lock = acquireVaultLock(runtime, {
      operationId: 'update-in-progress',
      owner: 'me-update',
    });

    try {
      expect(() => finalizeIngest(validArticleInput(vault)))
        .toThrow(/locked|in progress/i);
      expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    } finally {
      releaseVaultLock(runtime, lock);
    }
  });

  test('cleans later operation locks best-effort and preserves vault.lock on cleanup failure', () => {
    const vault = makeVault();
    const runtime = resolveRuntimeLayout(vault);
    const cleanupAttempts: string[] = [];

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        throw new Error('stop before publish');
      },
      cleanupOps: {
        rmSync(candidate, options) {
          const target = candidate.toString();
          if (
            path.dirname(target) === runtime.ingestLockDir
            && target.endsWith('.lock')
          ) {
            cleanupAttempts.push(target);
            if (cleanupAttempts.length === 1) {
              throw new Error('injected operation-lock cleanup failure');
            }
          }
          fs.rmSync(candidate, options);
        },
      },
      renameSync: fs.renameSync,
    })).toThrow(/recovery|required|cleanup/i);

    expect(cleanupAttempts).toHaveLength(2);
    expect(fs.readdirSync(runtime.ingestLockDir).filter(name => name.endsWith('.lock')))
      .toHaveLength(1);
    expect(fs.existsSync(path.join(runtime.lockDir, 'vault.lock'))).toBeTrue();
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('preserves vault.lock when staging cleanup is incomplete', () => {
    const vault = makeVault();
    const runtime = resolveRuntimeLayout(vault);
    let stagingCleanupFailed = false;

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        throw new Error('stop before publish');
      },
      cleanupOps: {
        rmSync(candidate, options) {
          const target = candidate.toString();
          if (
            target.startsWith(`${runtime.ingestStagingDir}${path.sep}artifact-`)
            && options?.recursive
          ) {
            stagingCleanupFailed = true;
            throw new Error('injected staging cleanup failure');
          }
          fs.rmSync(candidate, options);
        },
      },
      renameSync: fs.renameSync,
    })).toThrow(/recovery|required|cleanup/i);

    expect(stagingCleanupFailed).toBeTrue();
    expect(fs.existsSync(path.join(runtime.lockDir, 'vault.lock'))).toBeTrue();
    expect(fs.readdirSync(runtime.ingestStagingDir)
      .some(name => name.startsWith('artifact-'))).toBeTrue();
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('reserves a stem vault-wide across concurrent topics', () => {
    const vault = makeVault();
    const otherTopic = validArticleInput(vault);
    otherTopic.topic = 'other-topic';
    let nestedAttempted = false;

    finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        nestedAttempted = true;
        expect(() => finalizeIngest(otherTopic)).toThrow(/locked|reserved|in progress/i);
      },
      renameSync: fs.renameSync,
    });

    expect(nestedAttempted).toBeTrue();
    expect(fs.existsSync(path.join(
      vault,
      'knowledge/raw/other-topic/2026-07-25-atomic-ingest-guide',
    ))).toBeFalse();
  });

  test('detects a concurrent README edit with compare-and-swap and preserves it', () => {
    const vault = makeVault();
    const parent = path.dirname(path.dirname(expectedNote(vault)));
    const readmePath = path.join(parent, 'README.md');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(readmePath, '# Existing index\n');

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeReadmeCompare() {
        fs.writeFileSync(readmePath, '# Concurrent user edit\n');
      },
      renameSync: fs.renameSync,
    })).toThrow(/README.*changed|compare-and-swap/i);

    expect(fs.readFileSync(readmePath, 'utf8')).toBe('# Concurrent user edit\n');
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    expect(stagingEntries(vault)).toEqual([]);
  });

  test('preserves a published artifact when concurrent user content makes rollback unsafe', () => {
    const vault = makeVault();
    const artifact = path.dirname(expectedNote(vault));
    const userFile = path.join(artifact, 'user-created-after-publish.txt');
    const parent = path.dirname(artifact);
    const readmePath = path.join(parent, 'README.md');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(readmePath, '# Existing index\n');

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeReadmeCompare() {
        fs.writeFileSync(userFile, 'concurrent user data');
        fs.writeFileSync(readmePath, '# Concurrent user edit\n');
      },
      renameSync: fs.renameSync,
    })).toThrow(/manual recovery/i);

    expect(fs.readFileSync(userFile, 'utf8')).toBe('concurrent user data');
    expect(fs.readFileSync(readmePath, 'utf8')).toBe('# Concurrent user edit\n');
    expect(fs.existsSync(expectedNote(vault))).toBeTrue();
  });

  test('rejects unsupported media syntax instead of omitting it from validation', () => {
    const fixtures = [
      '段落一\n\n![图一](images/image-001.jpg)\n\n![[../../private.png]]',
      '段落一\n\n![图一](images/image-001.jpg)\n\n<img src="/etc/passwd">',
      '段落一\n\n![图一](images/image-001.jpg)\n\n![private][asset]\n\n[asset]: ../../private.png',
    ];
    for (const processedMarkdown of fixtures) {
      const vault = makeVault();
      const input = validArticleInput(vault);
      input.processedMarkdown = processedMarkdown;

      expect(() => finalizeIngest(input)).toThrow(/unsupported media syntax/);
      expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    }
  });

  test('ignores media-looking examples in inline and correctly nested fenced code', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    input.processedMarkdown = [
      '段落一',
      '',
      '![图一](images/image-001.jpg)',
      '',
      '`<img src="/etc/passwd">` and `![[private.png]]` and `![code](../../private.png)`',
      '',
      '````md',
      '```',
      '<img src="/etc/passwd">',
      '![[private.png]]',
      '![code](../../private.png)',
      '```',
      '````',
      '',
      '~~~~md',
      '~~~',
      '![code](../../private.png)',
      '~~~',
      '~~~~',
    ].join('\n');

    const result = finalizeIngest(input);

    expect(fs.existsSync(result.notePath)).toBeTrue();
    expect(fs.readFileSync(result.notePath, 'utf8')).toContain('![图一](images/image-001.jpg)');
  });

  test('does not treat a backtick fence with a backtick in its info string as code', () => {
    const vault = makeVault();
    const input = validArticleInput(vault);
    input.processedMarkdown = [
      '段落一',
      '',
      '![图一](images/image-001.jpg)',
      '',
      '```md`invalid',
      '<img src="/etc/passwd">',
      '```',
    ].join('\n');

    expect(() => finalizeIngest(input)).toThrow(/unsupported media syntax/i);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('rejects an empty or metadata-only video handout', () => {
    for (const warnings of [[], ['transcript-empty']]) {
      const vault = makeVault();
      const source: ExtractedSource = {
        source: {
          url: 'https://example.com/empty-course',
          kind: 'course',
          title: 'Empty Course',
          durationSec: 60,
        },
        blocks: [],
        transcript: [],
        media: [],
        provenance: {
          extractor: 'fixture',
          extractedAt: '2026-07-25T00:00:00Z',
          methods: ['fixture'],
        },
        warnings,
      };
      const handout: HandoutResult = {
        kind: 'topic',
        markdown: '# Empty Course（讲义）\n\n> 作者：未知｜总时长：01:00\n',
        usedMediaIds: [],
        includedTranscriptSegments: [],
        omittedTranscriptSegments: [],
        warnings,
      };

      expect(() => finalizeIngest({
        vaultDir: vault,
        source,
        handout,
        topic: 'courses',
        stem: '2026-07-25-empty-course',
        created: '2026-07-25',
        trustedResourceRoots: [resourceRoot(vault)],
      })).toThrow(/transcript|substantive/i);
    }

    const vault = makeVault();
    const source: ExtractedSource = {
      source: {
        url: 'https://example.com/metadata-only',
        kind: 'video',
        title: 'Metadata Only',
        durationSec: 60,
      },
      blocks: [],
      transcript: [{ start: 0, end: 60, text: '必须保留的完整论证' }],
      media: [],
      provenance: {
        extractor: 'fixture',
        extractedAt: '2026-07-25T00:00:00Z',
        methods: ['fixture'],
      },
      warnings: [],
    };
    expect(() => finalizeIngest({
      vaultDir: vault,
      source,
      handout: {
        kind: 'topic',
        markdown: '# Metadata Only（讲义）\n\n必须保留的完整论证\n',
        usedMediaIds: [],
        includedTranscriptSegments: [],
        omittedTranscriptSegments: [],
        warnings: [],
      },
      processedMarkdown: '# Metadata Only（讲义）\n\n> 作者：未知｜总时长：01:00\n',
      topic: 'courses',
      stem: '2026-07-25-metadata-only',
      created: '2026-07-25',
      trustedResourceRoots: [resourceRoot(vault)],
    })).toThrow(/processed handout|coverage|transcript/i);
  });

  test.each(RAW_VISUAL_CASES)(
    'publishes a raw %s-backed %s when its only substantive content is one referenced visual',
    (mediaKind, sourceKind) => {
      const vault = makeVault();
      const result = finalizeIngest(rawVisualInput(vault, mediaKind, sourceKind));
      const note = fs.readFileSync(result.notePath, 'utf8');

      expect(result.assetPaths).toHaveLength(1);
      expect(path.basename(result.assetPaths[0])).toBe('image-001.jpg');
      expect(fs.readFileSync(result.assetPaths[0], 'utf8')).toBe(`${mediaKind} bytes`);
      expect(note).toContain(`![${mediaKind} visual](images/image-001.jpg)`);
    },
  );

  test.each(RAW_VISUAL_CASES)(
    'rejects an unreferenced raw %s-backed %s without publishing an artifact',
    (mediaKind, sourceKind) => {
      const vault = makeVault();
      const input = rawVisualInput(vault, mediaKind, sourceKind, 0);

      expect(() => finalizeIngest(input)).toThrow(/metadata-only|publishable media/i);
      expect(fs.existsSync(path.join(vault, 'knowledge/raw/raw-visual', input.stem))).toBeFalse();
      expect(stagingEntries(vault)).toEqual([]);
    },
  );

  test.each(RAW_VISUAL_CASES)(
    'rejects duplicate raw %s-backed %s associations without publishing an artifact',
    (mediaKind, sourceKind) => {
      const vault = makeVault();
      const input = rawVisualInput(vault, mediaKind, sourceKind, 2);

      expect(() => finalizeIngest(input)).toThrow(/invalid image count/i);
      expect(fs.existsSync(path.join(vault, 'knowledge/raw/raw-visual', input.stem))).toBeFalse();
      expect(stagingEntries(vault)).toEqual([]);
    },
  );

  test('rejects a handout whose included mapping does not cover every transcript segment', () => {
    const vault = makeVault();
    const source: ExtractedSource = {
      source: {
        url: 'https://example.com/incomplete-course',
        kind: 'course',
        title: 'Incomplete Course',
        durationSec: 60,
      },
      blocks: [],
      transcript: [
        { start: 0, end: 30, text: '第一段完整论证' },
        { start: 30, end: 60, text: '第二段完整论证' },
      ],
      media: [],
      provenance: {
        extractor: 'fixture',
        extractedAt: '2026-07-25T00:00:00Z',
        methods: ['fixture'],
      },
      warnings: [],
    };
    const handout = {
      kind: 'topic',
      markdown: '# Incomplete Course（讲义）\n\n第一段完整论证\n',
      usedMediaIds: [],
      includedTranscriptSegments: [0],
      omittedTranscriptSegments: [],
      warnings: [],
    } satisfies HandoutResult;

    expect(() => finalizeIngest({
      vaultDir: vault,
      source,
      handout,
      topic: 'courses',
      stem: '2026-07-25-incomplete-course',
      created: '2026-07-25',
      trustedResourceRoots: [resourceRoot(vault)],
    })).toThrow(/coverage|transcript/i);
  });

  test('rejects unsafe or noncanonical stems before creating an artifact', () => {
    for (const stem of [
      '2026-07-25-Escape',
      'atomic-ingest',
      '2026-07-25-safe]]|# ![[private',
      '2026-07-25-double--hyphen',
    ]) {
      const vault = makeVault();
      const input = validArticleInput(vault);
      input.stem = stem;
      expect(() => finalizeIngest(input)).toThrow(/stem|target path/);
      expect(stagingEntries(vault)).toEqual([]);
    }
  });

  test('ignores frontmatter and fenced-code wikilinks for reachability', () => {
    const vault = makeVault();
    const raw = path.join(vault, 'knowledge/raw');
    const stem = '2026-07-25-atomic-ingest-guide';
    fs.writeFileSync(path.join(raw, 'code-only.md'), [
      '---',
      `title: "[[${stem}]]"`,
      'created: 2026-07-20',
      'tags: []',
      'type: article',
      'source: "https://example.com/code"',
      '---',
      '',
      '```md',
      `[[${stem}]]`,
      '```',
      '',
    ].join('\n'));

    const result = finalizeIngest(validArticleInput(vault));
    const readmePath = path.join(path.dirname(path.dirname(result.notePath)), 'README.md');

    expect(result.readmePath).toBe(readmePath);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain(`[[${stem}]]`);
    expect(result.backlinks).toEqual([]);
  });

  test('requires a matching fence marker and sufficient closing length for backlink scanning', () => {
    const vault = makeVault();
    const raw = path.join(vault, 'knowledge/raw');
    const stem = '2026-07-25-atomic-ingest-guide';
    fs.writeFileSync(path.join(raw, 'four-backticks.md'), [
      '````md',
      '```',
      `[[${stem}]]`,
      '```',
      '````',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(raw, 'four-tildes.md'), [
      '~~~~md',
      '~~~',
      `[[${stem}]]`,
      '~~~',
      '~~~~',
      '',
    ].join('\n'));

    const result = finalizeIngest(validArticleInput(vault));

    expect(result.backlinks).toEqual([]);
    expect(result.readmePath).toBe(path.join(raw, 'atomic-ingest', 'README.md'));
  });

  test('rejects a duplicate stem anywhere in configured vault layers', () => {
    const vault = makeVault();
    const duplicate = path.join(
      vault,
      'knowledge/raw/another-topic/2026-07-25-atomic-ingest-guide.md',
    );
    fs.mkdirSync(path.dirname(duplicate), { recursive: true });
    fs.writeFileSync(duplicate, [
      '---',
      'title: "Older Atomic Ingest Guide"',
      'created: 2026-07-20',
      'tags: []',
      'type: article',
      'source: "https://example.com/older"',
      '---',
      '',
      'Older note.',
      '',
    ].join('\n'));

    expect(() => finalizeIngest(validArticleInput(vault))).toThrow(/duplicate stem|already exists/i);
    expect(fs.existsSync(expectedNote(vault))).toBeFalse();
  });

  test('validates tags as English kebab-case strings and emits quoted YAML strings', () => {
    for (const tags of [['bad:tag'], ['Uppercase'], [{ secret: 'value' }]]) {
      const vault = makeVault();
      const input = validArticleInput(vault);
      input.tags = tags as unknown as string[];
      expect(() => finalizeIngest(input)).toThrow(/tag/i);
    }

    const malformedVault = makeVault();
    const malformed = validArticleInput(malformedVault);
    malformed.frontmatter = [
      '---',
      'title: "Atomic Ingest Guide"',
      'created: 2026-07-25',
      'tags: [{secret: value}]',
      'type: article',
      'source: "https://example.com/article"',
      '---',
    ].join('\n');
    expect(() => finalizeIngest(malformed)).toThrow(/tag/i);

    for (const tags of ['[true]', '[123]', '[{secret: value}]']) {
      const invalidVault = makeVault();
      const invalid = validArticleInput(invalidVault);
      invalid.frontmatter = [
        '---',
        'title: "Atomic Ingest Guide"',
        'created: 2026-07-25',
        `tags: ${tags}`,
        'type: article',
        'source: "https://example.com/article"',
        '---',
      ].join('\n');
      expect(() => finalizeIngest(invalid)).toThrow(/tag/i);
    }

    const quotedVault = makeVault();
    const quoted = validArticleInput(quotedVault);
    quoted.frontmatter = [
      '---',
      'title: "Atomic Ingest Guide"',
      'created: 2026-07-25',
      'tags: ["ingest", \'atomic-write\']',
      'type: article',
      'source: "https://example.com/article"',
      '---',
    ].join('\n');
    expect(() => finalizeIngest(quoted)).not.toThrow();

    const vault = makeVault();
    const result = finalizeIngest(validArticleInput(vault));
    expect(fs.readFileSync(result.notePath, 'utf8')).toContain('tags: ["ingest", "atomic"]');
  });

  test('rejects trailing tokens after a custom frontmatter tags array', () => {
    for (const tags of ['["ingest"]]', '["ingest"] garbage]']) {
      const vault = makeVault();
      const input = validArticleInput(vault);
      input.frontmatter = [
        '---',
        'title: "Atomic Ingest Guide"',
        'created: 2026-07-25',
        `tags: ${tags}`,
        'type: article',
        'source: "https://example.com/article"',
        '---',
      ].join('\n');

      expect(() => finalizeIngest(input)).toThrow(/tag/i);
      expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    }
  });

  test('requires narrow explicit trusted resource roots and compatible media extensions', () => {
    for (const root of [undefined, '/', os.homedir(), makeVault()]) {
      const vault = makeVault();
      const input = validArticleInput(vault);
      if (root === undefined) {
        delete (input as Partial<FinalizeInput>).trustedResourceRoots;
      } else {
        input.trustedResourceRoots = [root === '/' || root === os.homedir() ? root : vault];
      }
      expect(() => finalizeIngest(input)).toThrow(/trusted resource root/i);
    }

    const ancestorVault = makeVault();
    const ancestorInput = validArticleInput(ancestorVault);
    ancestorInput.trustedResourceRoots = [path.dirname(ancestorVault)];
    expect(() => finalizeIngest(ancestorInput)).toThrow(/trusted resource root/i);

    const vault = makeVault();
    const input = validArticleInput(vault);
    input.source.media[0].path = writeAsset(vault, 'not-an-image.txt', 'text');
    expect(() => finalizeIngest(input)).toThrow(/extension|media kind/i);
  });

  test('rejects a .me symlink that escapes the vault before creating reservation locks', () => {
    const vault = makeVault();
    const externalMe = temporaryDirectory('me-finalize-external-me-');
    fs.cpSync(path.join(vault, '.me'), externalMe, { recursive: true });
    fs.rmSync(path.join(vault, '.me'), { recursive: true });
    fs.symlinkSync(externalMe, path.join(vault, '.me'));
    const input = validArticleInput(vault);
    input.trustedResourceRoots = [path.join(externalMe, 'tmp')];

    expect(() => finalizeIngest(input)).toThrow(/\\.me|outside vault/i);
    expect(fs.existsSync(path.join(externalMe, 'ingest-reservations'))).toBeFalse();
  });

  test('rejects an escaping ingest-reservations symlink before opening a lock', () => {
    const vault = makeVault();
    const externalReservations = temporaryDirectory('me-finalize-external-reservations-');
    fs.symlinkSync(externalReservations, path.join(vault, '.me', 'ingest-reservations'));
    const externalLock = path.join(externalReservations, '2026-07-25-atomic-ingest-guide.lock');
    let reachedPublish = false;

    expect(() => finalizeIngest(validArticleInput(vault), {
      beforeArtifactPublish() {
        reachedPublish = true;
      },
      renameSync: fs.renameSync,
    })).toThrow(/reservation|outside vault/i);

    expect(reachedPublish).toBeFalse();
    expect(fs.existsSync(externalLock)).toBeFalse();
  });

  test.each(['reservation', 'topic-marker', 'staging'] as const)(
    'blocks legacy vault-local ingest state before external runtime mutation: %s',
    legacy => {
      const vault = makeVault();
      if (legacy === 'reservation') {
        const directory = path.join(vault, '.me', 'ingest-reservations');
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'old.lock'), 'legacy');
      } else if (legacy === 'topic-marker') {
        const topic = path.join(vault, 'knowledge/raw/atomic-ingest');
        fs.mkdirSync(topic, { recursive: true });
        fs.writeFileSync(path.join(topic, '.me-ingest-finalize.lock'), 'legacy');
      } else {
        const staging = path.join(vault, 'knowledge/raw/.me-ingest-staging-old');
        fs.mkdirSync(staging);
        fs.writeFileSync(path.join(staging, 'note.md'), 'legacy');
      }
      const runtime = resolveRuntimeLayout(vault);

      expect(() => finalizeIngest(validArticleInput(vault)))
        .toThrow(/legacy.*runtime state|manual recovery/i);
      expect(fs.existsSync(runtime.runtimeRoot)).toBeFalse();
      expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    },
  );

  test.each(['tmp', 'locks', 'ingest-reservations'] as const)(
    'blocks a dangling legacy .me/%s symlink before external runtime mutation',
    directory => {
      const vault = makeVault();
      fs.symlinkSync(
        path.join(path.dirname(vault), `missing-${directory}`),
        path.join(vault, '.me', directory),
      );
      const runtime = resolveRuntimeLayout(vault);

      expect(() => finalizeIngest(validArticleInput(vault)))
        .toThrow(/legacy.*runtime state|manual recovery/i);
      expect(fs.existsSync(runtime.runtimeRoot)).toBeFalse();
      expect(fs.existsSync(expectedNote(vault))).toBeFalse();
    },
  );

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
      includedTranscriptSegments: [0],
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
      trustedResourceRoots: [resourceRoot(vault)],
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
