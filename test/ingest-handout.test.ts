import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommandRunner } from '../bin/ingest/command.ts';
import type { ExtractedSource, MediaAsset, TranscriptSegment } from '../bin/ingest/contracts.ts';
import { resolveIngestConfig } from '../bin/ingest/config.ts';
import {
  discoverTranscriptionProvider,
  type TranscriptionProviderId,
} from '../bin/ingest/media/transcription.ts';
import { formatHandout, selectHandoutKind } from '../bin/ingest/handout.ts';

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

function vaultWithConfig(config: string): string {
  const vault = temporaryDirectory('me-ingest-config-');
  fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.me', 'config.yaml'), `ingest:\n${config
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')}\n`);
  return vault;
}

function providerRunner(available: string[]): CommandRunner {
  return {
    run(command, args) {
      if (command !== 'which') throw new Error(`unexpected command: ${command}`);
      const found = available.includes(args[0]);
      return { stdout: found ? `/usr/local/bin/${args[0]}\n` : '', stderr: '', status: found ? 0 : 1 };
    },
  };
}

function sourceWithMedia(
  kind: MediaAsset['kind'],
  timestamps: Array<number | undefined>,
  transcript: TranscriptSegment[] = [
    { start: 4, end: 40, text: '第一段完整论证，包括例子与数据。' },
    { start: 95, end: 170, text: '第二段反例不能被摘要或删除。' },
    { start: 181, end: 239, text: '第三段结论保留原意。' },
  ],
  durationSec = 240,
): ExtractedSource {
  return {
    source: {
      url: 'https://example.com/course',
      kind: 'course',
      title: '完整课程',
      author: '讲者',
      publishedAt: '2026-07-25T08:00:00Z',
      durationSec,
    },
    blocks: [],
    transcript,
    media: timestamps.map((timestampSec, index) => ({
      id: `${kind}-${String(index + 1).padStart(3, '0')}`,
      kind,
      path: `/tmp/${kind}-${String(index + 1).padStart(3, '0')}.jpg`,
      alt: `${kind} ${index + 1}`,
      ...(timestampSec === undefined ? {} : { timestampSec }),
    })),
    provenance: {
      extractor: 'fixture-adapter',
      extractedAt: '2026-07-25T09:00:00Z',
      methods: ['public metadata', 'local transcription'],
    },
    warnings: [],
  };
}

describe('resolveIngestConfig', () => {
  test('uses portable defaults when the optional ingest config is absent', () => {
    const vault = temporaryDirectory('me-ingest-config-');

    expect(resolveIngestConfig(vault)).toEqual({
      defaultVideoMode: 'handout',
      transcriptionPreference: ['mlx-whisper', 'whisper-cpp'],
    });
  });

  test('reads the optional profile and provider preference from the ingest section', () => {
    const vault = vaultWithConfig([
      'default_video_mode: transcribe',
      'handout_profile: .me/profiles/course.md',
      'transcription_preference:',
      '  - whisper-cpp',
      '  - mlx-whisper',
    ].join('\n'));
    fs.mkdirSync(path.join(vault, '.me', 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.me', 'profiles', 'course.md'), '# Editing profile\n');

    expect(resolveIngestConfig(vault)).toEqual({
      defaultVideoMode: 'transcribe',
      handoutProfilePath: path.join(vault, '.me', 'profiles', 'course.md'),
      transcriptionPreference: ['whisper-cpp', 'mlx-whisper'],
    });
  });

  test('reads only direct children of the root ingest section', () => {
    const vault = temporaryDirectory('me-ingest-config-');
    fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.me', 'config.yaml'), [
      'other:',
      '  ingest:',
      '    default_video_mode: raw',
      'ingest:',
      '  default_video_mode: transcribe',
      '  transcription_preference:',
      '    - whisper-cpp',
      '  nested:',
      '    default_video_mode: summarize',
      '    transcription_preference:',
      '      - mlx-whisper',
      '',
    ].join('\n'));

    expect(resolveIngestConfig(vault)).toEqual({
      defaultVideoMode: 'transcribe',
      transcriptionPreference: ['whisper-cpp'],
    });
  });

  test('rejects an optional profile path outside the vault', () => {
    expect(() => resolveIngestConfig(vaultWithConfig('handout_profile: ../private.md')))
      .toThrow(/outside vault/);
  });

  test('rejects a profile symlink whose real path escapes the vault', () => {
    const vault = vaultWithConfig('handout_profile: .me/profiles/course.md');
    const outside = temporaryDirectory('me-private-profile-');
    fs.writeFileSync(path.join(outside, 'course.md'), 'private\n');
    fs.mkdirSync(path.join(vault, '.me', 'profiles'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'course.md'), path.join(vault, '.me', 'profiles', 'course.md'));

    expect(() => resolveIngestConfig(vault)).toThrow(/outside vault/);
  });

  test('rejects a broken profile symlink that targets outside the vault', () => {
    const vault = vaultWithConfig('handout_profile: .me/profiles/course.md');
    const outside = temporaryDirectory('me-private-profile-');
    fs.mkdirSync(path.join(vault, '.me', 'profiles'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'not-created.md'), path.join(vault, '.me', 'profiles', 'course.md'));

    expect(() => resolveIngestConfig(vault)).toThrow(/outside vault/);
  });

  test('rejects a config file symlink whose real path escapes the vault', () => {
    const vault = temporaryDirectory('me-ingest-config-');
    const outside = temporaryDirectory('me-private-config-');
    fs.mkdirSync(path.join(vault, '.me'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'config.yaml'), 'ingest:\n  default_video_mode: raw\n');
    fs.symlinkSync(path.join(outside, 'config.yaml'), path.join(vault, '.me', 'config.yaml'));

    expect(() => resolveIngestConfig(vault)).toThrow(/outside vault/);
  });
});

describe('discoverTranscriptionProvider', () => {
  test('prefers mlx-whisper then whisper-cpp by default', () => {
    expect(discoverTranscriptionProvider(
      undefined,
      providerRunner(['mlx-whisper', 'whisper-cli']),
    )?.id).toBe('mlx-whisper');
  });

  test('recognizes the mlx_whisper executable name installed by the Python package', () => {
    expect(discoverTranscriptionProvider(
      ['mlx-whisper'],
      providerRunner(['mlx_whisper']),
    )?.id).toBe('mlx-whisper');
  });

  test('honors an explicit provider order and returns null when none are available', () => {
    expect(discoverTranscriptionProvider(
      ['whisper-cpp', 'mlx-whisper'],
      providerRunner(['mlx-whisper', 'whisper-cli']),
    )?.id).toBe('whisper-cpp');
    expect(discoverTranscriptionProvider([], providerRunner(['mlx-whisper']))).toBeNull();
  });

  test('runs mlx-whisper with input and output paths as separate argv items', () => {
    const outputDir = temporaryDirectory('me-transcript-output-');
    const inputPath = '/tmp/audio; touch SHOULD_NOT_EXIST.wav';
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === 'which') {
          return { stdout: '/opt/bin/mlx-whisper\n', stderr: '', status: args[0] === 'mlx-whisper' ? 0 : 1 };
        }
        fs.writeFileSync(path.join(outputDir, 'audio; touch SHOULD_NOT_EXIST.json'), JSON.stringify({
          segments: [{ start: 0, end: 2.5, text: '完整转写' }],
        }));
        return { stdout: '', stderr: '', status: 0 };
      },
    };

    const provider = discoverTranscriptionProvider(['mlx-whisper'], runner);
    expect(provider?.transcribe(inputPath, outputDir)).toEqual([
      { start: 0, end: 2.5, text: '完整转写' },
    ]);
    expect(calls.at(-1)).toMatchObject({
      command: '/opt/bin/mlx-whisper',
      args: [inputPath, '--output-dir', outputDir, '--output-format', 'json'],
    });
    expect(fs.existsSync('/tmp/SHOULD_NOT_EXIST')).toBeFalse();
  });

  test('uses only an explicitly supplied whisper.cpp model path', () => {
    const outputDir = temporaryDirectory('me-transcript-output-');
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === 'which') {
          return { stdout: '/opt/bin/whisper-cli\n', stderr: '', status: args[0] === 'whisper-cli' ? 0 : 1 };
        }
        const outputBase = args[args.indexOf('-of') + 1];
        fs.writeFileSync(`${outputBase}.json`, JSON.stringify({
          transcription: [{
            offsets: { from: 0, to: 2500 },
            text: 'whisper.cpp 转写',
          }],
        }));
        return { stdout: '', stderr: '', status: 0 };
      },
    };

    const provider = discoverTranscriptionProvider(
      ['whisper-cpp'],
      runner,
      { whisperCppModelPath: '/models/local.bin' },
    );
    expect(provider?.transcribe('/tmp/audio.wav', outputDir)).toEqual([
      { start: 0, end: 2.5, text: 'whisper.cpp 转写' },
    ]);
    expect(calls.at(-1)?.args).toContain('/models/local.bin');
  });

  test('does not accept stale JSON left in the output directory as a new transcription', () => {
    const outputDir = temporaryDirectory('me-transcript-output-');
    fs.writeFileSync(path.join(outputDir, 'audio.json'), JSON.stringify({
      segments: [{ start: 0, end: 2, text: '旧结果' }],
    }));
    const runner: CommandRunner = {
      run(command, args) {
        if (command === 'which') {
          return { stdout: '/opt/bin/mlx-whisper\n', stderr: '', status: args[0] === 'mlx-whisper' ? 0 : 1 };
        }
        return { stdout: '', stderr: '', status: 0 };
      },
    };

    const provider = discoverTranscriptionProvider(['mlx-whisper'], runner);
    expect(() => provider?.transcribe('/tmp/audio.wav', outputDir)).toThrow(/transcription failed/);
  });

  test('redacts output paths when filesystem preparation fails', () => {
    const root = temporaryDirectory('me-provider-secret-');
    const blocker = path.join(root, 'private-blocker');
    const outputDir = path.join(blocker, 'secret-output');
    fs.writeFileSync(blocker, 'not a directory');
    const provider = discoverTranscriptionProvider(
      ['mlx-whisper'],
      providerRunner(['mlx-whisper']),
    );

    let message = '';
    try {
      provider?.transcribe('/private/input-secret.wav', outputDir);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('mlx-whisper transcription failed');
    expect(message).not.toContain(root);
    expect(message).not.toContain('secret-output');
    expect(message).not.toContain('input-secret');
  });
});

describe('selectHandoutKind', () => {
  test('uses slide-driven only for two or more timestamped slide assets', () => {
    expect(selectHandoutKind(sourceWithMedia('slide', [0, 94]))).toBe('slide');
    expect(selectHandoutKind(sourceWithMedia('frame', [0, 94]))).toBe('topic');
    expect(selectHandoutKind(sourceWithMedia('slide', [0]))).toBe('topic');
  });

  test.each([
    [[0, undefined], 'missing timestamp'],
    [[0, 0], 'duplicate timestamp'],
    [[94, 0], 'decreasing timestamp'],
    [[-1, 50], 'negative timestamp'],
    [[0, 240], 'timestamp at duration'],
  ] as Array<[Array<number | undefined>, string]>)(
    'does not accept slides with a %s',
    (timestamps) => {
      expect(selectHandoutKind(sourceWithMedia('slide', timestamps))).toBe('topic');
    },
  );

  test('does not use slide-driven without a finite duration bound', () => {
    const source = sourceWithMedia('slide', [0, 94]);
    delete source.source.durationSec;

    expect(selectHandoutKind(source)).toBe('topic');
  });
});

describe('formatHandout', () => {
  test('maps every complete transcript segment into slide intervals ending at duration', () => {
    const result = formatHandout(sourceWithMedia('slide', [0, 94, 180]), { topicHeadings: [] });

    expect(result.kind).toBe('slide');
    expect(result.markdown).toContain('# 完整课程（讲义）');
    expect(result.markdown).toContain('作者：讲者');
    expect(result.markdown).toContain('发布日期：2026-07-25');
    expect(result.markdown).toContain('总时长：04:00');
    expect(result.markdown).toContain('页数：3');
    expect(result.markdown).toContain('fixture-adapter');
    expect(result.markdown).toContain('local transcription');
    expect(result.markdown).toContain('## 第 1 页 · 00:00–01:34（94s）');
    expect(result.markdown).toContain('## 第 3 页 · 03:00–04:00（60s）');
    expect(result.markdown).toContain('第一段完整论证，包括例子与数据。');
    expect(result.markdown).toContain('第二段反例不能被摘要或删除。');
    expect(result.markdown).toContain('第三段结论保留原意。');
    expect(result.markdown).not.toContain('Key Points');
    expect(result.usedMediaIds).toEqual(['slide-001', 'slide-002', 'slide-003']);
    expect(result.includedTranscriptSegments).toEqual([0, 1, 2]);
    expect(result.omittedTranscriptSegments).toEqual([]);
  });

  test('writes local image paths as valid CommonMark destinations', () => {
    const source = sourceWithMedia('slide', [0, 94]);
    source.media[0].path = '/tmp/slide 1 (intro).jpg';
    source.media[1].path = '/tmp/slide > 2.jpg';

    const markdown = formatHandout(source, { topicHeadings: [] }).markdown;

    expect(markdown).toContain('![slide 1](<slides/slide 1 (intro).jpg>)');
    expect(markdown).toContain('![slide 2](<slides/slide %3E 2.jpg>)');
  });

  test('assigns a boundary-crossing segment once by its start timestamp', () => {
    const source = sourceWithMedia('slide', [0, 94, 180], [
      { start: 90, end: 100, text: '跨页论证保持为一个完整片段。' },
    ]);

    const markdown = formatHandout(source, { topicHeadings: [] }).markdown;
    const firstSection = markdown.slice(
      markdown.indexOf('## 第 1 页'),
      markdown.indexOf('## 第 2 页'),
    );
    expect(firstSection).toContain('跨页论证保持为一个完整片段。');
    expect(markdown.match(/跨页论证保持为一个完整片段。/g)).toHaveLength(1);
  });

  test('uses exact left-closed right-open interval boundaries', () => {
    const source = sourceWithMedia('slide', [0, 94, 180], [
      { start: 93.9995, end: 93.9999, text: '边界之前。' },
      { start: 94, end: 95, text: '边界之上。' },
    ]);

    const markdown = formatHandout(source, { topicHeadings: [] }).markdown;
    const firstSection = markdown.slice(
      markdown.indexOf('## 第 1 页'),
      markdown.indexOf('## 第 2 页'),
    );
    const secondSection = markdown.slice(
      markdown.indexOf('## 第 2 页'),
      markdown.indexOf('## 第 3 页'),
    );
    expect(firstSection).toContain('边界之前。');
    expect(firstSection).not.toContain('边界之上。');
    expect(secondSection).toContain('边界之上。');
  });

  test('uses validated topic headings for talking-head video', () => {
    const source = sourceWithMedia('frame', [12], [
      { start: 0, end: 120, text: '开场论证。' },
      { start: 121, end: 319, text: '继续展开。' },
    ], 320);

    const result = formatHandout(source, {
      topicHeadings: [{ start: 0, end: 320, title: '主题' }],
      editorialNote: '已按术语表校订专名，未删减论证。',
    });

    expect(result.kind).toBe('topic');
    expect(result.markdown).toContain('## §1 · 00:00–05:20 · 主题');
    expect(result.markdown).toContain('开场论证。');
    expect(result.markdown).toContain('继续展开。');
    expect(result.markdown).toContain('编辑说明：已按术语表校订专名，未删减论证。');
    expect(result.usedMediaIds).toEqual(['frame-001']);
    expect(result.includedTranscriptSegments).toEqual([0, 1]);
    expect(result.omittedTranscriptSegments).toEqual([]);
  });

  test.each([
    [[{ start: -1, end: 320, title: '负数' }], 'non-negative'],
    [[{ start: 0, end: 321, title: '越界' }], 'duration'],
    [[{ start: 0, end: 320.0005, title: '微小越界' }], 'duration'],
    [[{ start: 0, end: 100, title: '一' }, { start: 99, end: 320, title: '二' }], 'overlap'],
    [[{ start: 0, end: 100.0005, title: '一' }, { start: 100, end: 320, title: '二' }], 'overlap'],
    [[{ start: 0, end: 100, title: '一' }, { start: 100.0005, end: 320, title: '二' }], 'continuous'],
    [[{ start: 0, end: 100, title: '一' }, { start: 101, end: 320, title: '二' }], 'continuous'],
  ] as Array<[Array<{ start: number; end: number; title: string }>, string]>)(
    'rejects invalid topic heading ranges: %s',
    (topicHeadings, message) => {
      expect(() => formatHandout(sourceWithMedia('frame', [], [], 320), { topicHeadings }))
        .toThrow(new RegExp(message));
    },
  );

  test('uses deterministic pause-aware 5–12 minute topic windows when headings are absent', () => {
    const transcript = Array.from({ length: 78 }, (_, index) => {
      const start = index * 10 + (index >= 45 ? 20 : 0);
      return { start, end: start + 8, text: `完整片段 ${index + 1}` };
    });
    const source = sourceWithMedia('frame', [], transcript, 800);

    const first = formatHandout(source, { topicHeadings: [] });
    const second = formatHandout(source, { topicHeadings: [] });
    const ranges = [...first.markdown.matchAll(/^## §\d+ · (\d\d:\d\d)–(\d\d:\d\d) ·/gm)];

    expect(first.markdown).toBe(second.markdown);
    expect(ranges.length).toBeGreaterThan(1);
    expect(first.markdown).toContain('## §1 · 00:00–07:50 · 主题 1');
    expect(first.markdown).toContain('## §2 · 07:50–13:20 · 主题 2');
    expect(first.markdown).toContain('完整片段 1');
    expect(first.markdown).toContain('完整片段 78');
    expect(first.includedTranscriptSegments).toEqual(Array.from({ length: 78 }, (_, index) => index));
    expect(first.omittedTranscriptSegments).toEqual([]);
  });

  test('does not create a sub-five-minute tail when no pause boundary is available', () => {
    const source = sourceWithMedia('frame', [], [
      { start: 0, end: 721, text: '一个不可拆分的长片段。' },
    ], 721);
    const markdown = formatHandout(source, { topicHeadings: [] }).markdown;

    expect(markdown).toContain('## §1 · 00:00–07:01 · 主题 1');
    expect(markdown).toContain('## §2 · 07:01–12:01 · 主题 2');
    expect(markdown.match(/一个不可拆分的长片段。/g)).toHaveLength(1);
  });

  test('ignores a hard pause candidate that would create a sub-five-minute tail', () => {
    const source = sourceWithMedia('frame', [], [
      { start: 0, end: 699, text: '长段落。' },
      { start: 700, end: 721, text: '尾段。' },
    ], 721);
    const markdown = formatHandout(source, { topicHeadings: [] }).markdown;

    expect(markdown).toContain('## §1 · 00:00–07:01 · 主题 1');
    expect(markdown).toContain('## §2 · 07:01–12:01 · 主题 2');
    expect(markdown).not.toContain('## §1 · 00:00–11:40');
  });

  test('omits transcript and media exactly at or beyond duration', () => {
    const source = sourceWithMedia('frame', [320], [
      { start: 319, end: 320.0005, text: '结束时间越界。' },
      { start: 320, end: 321, text: '起点位于 duration。' },
    ], 320);

    const result = formatHandout(source, {
      topicHeadings: [{ start: 0, end: 320, title: '主题' }],
    });

    expect(result.markdown).not.toContain('结束时间越界。');
    expect(result.markdown).not.toContain('起点位于 duration。');
    expect(result.includedTranscriptSegments).toEqual([]);
    expect(result.omittedTranscriptSegments).toEqual([0, 1]);
    expect(result.usedMediaIds).toEqual([]);
  });

  test('reports transcript segments that cannot fit inside the declared duration', () => {
    const source = sourceWithMedia('frame', [], [
      { start: 0, end: 20, text: '有效片段' },
      { start: 241, end: 250, text: '越界片段' },
    ], 240);

    const result = formatHandout(source, {
      topicHeadings: [{ start: 0, end: 240, title: '主题' }],
    });

    expect(result.markdown).toContain('有效片段');
    expect(result.markdown).not.toContain('越界片段');
    expect(result.includedTranscriptSegments).toEqual([0]);
    expect(result.omittedTranscriptSegments).toEqual([1]);
    expect(result.warnings).toContain('incomplete-transcript-mapping');
  });
});
