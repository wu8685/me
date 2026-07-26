import * as fs from 'fs';
import * as path from 'path';
import type { CommandRunner } from '../command.ts';
import type { TranscriptSegment } from '../contracts.ts';

export type TranscriptionProviderId = 'mlx-whisper' | 'whisper-cpp';

export interface TranscriptionProvider {
  id: TranscriptionProviderId;
  available(): boolean;
  transcribe(inputPath: string, outputDir: string): TranscriptSegment[];
}

export interface TranscriptionProviderOptions {
  mlxWhisperModelPath?: string;
  whisperCppModelPath?: string;
}

const DEFAULT_PREFERENCE: TranscriptionProviderId[] = ['mlx-whisper', 'whisper-cpp'];

function executable(runner: CommandRunner, command: string): string | null {
  try {
    const result = runner.run('which', [command], { timeoutMs: 5000 });
    const resolved = result.stdout.trim();
    return result.status === 0 && resolved ? resolved.split(/\r?\n/, 1)[0] : null;
  } catch {
    return null;
  }
}

function timestampSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!match) return undefined;
  const fraction = (match[4] ?? '').padEnd(3, '0');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    + (fraction ? Number(fraction) / 1000 : 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSegment(value: unknown): TranscriptSegment | undefined {
  const item = record(value);
  if (!item) return undefined;
  const offsets = record(item.offsets);
  const timestamps = record(item.timestamps);
  const start = timestampSeconds(item.start)
    ?? (typeof offsets?.from === 'number' ? offsets.from / 1000 : undefined)
    ?? timestampSeconds(timestamps?.from);
  const end = timestampSeconds(item.end)
    ?? (typeof offsets?.to === 'number' ? offsets.to / 1000 : undefined)
    ?? timestampSeconds(timestamps?.to);
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  const speaker = typeof item.speaker === 'string' && item.speaker.trim()
    ? item.speaker.trim()
    : undefined;
  if (
    start === undefined
    || end === undefined
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || start >= end
    || !text
  ) return undefined;
  return { start, end, text, ...(speaker ? { speaker } : {}) };
}

function parseTranscriptJson(text: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('transcription provider returned malformed JSON');
  }
  const container = record(parsed);
  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray(container?.segments)
      ? container.segments
      : Array.isArray(container?.transcription)
        ? container.transcription
        : undefined;
  if (!values) throw new Error('transcription provider returned an unknown JSON schema');
  const segments = values.map(parseSegment).filter((item): item is TranscriptSegment => Boolean(item));
  if (segments.length !== values.length) {
    throw new Error('transcription provider returned invalid transcript segments');
  }
  segments.sort((left, right) => left.start - right.start || left.end - right.end);
  if (segments.some((segment, index) => index > 0 && segment.start < segments[index - 1].end)) {
    throw new Error('transcription provider returned overlapping transcript segments');
  }
  return segments;
}

function readProviderOutput(
  outputDir: string,
  expectedPaths: string[],
  previousJsonFiles: Map<string, string>,
  stdout: string,
): TranscriptSegment[] {
  for (const candidate of expectedPaths) {
    if (
      fs.existsSync(candidate)
      && fs.statSync(candidate).isFile()
      && previousJsonFiles.get(candidate) !== fileVersion(candidate)
    ) {
      return parseTranscriptJson(fs.readFileSync(candidate, 'utf8'));
    }
  }
  for (const name of fs.readdirSync(outputDir).filter(file => file.endsWith('.json')).sort()) {
    const candidate = path.join(outputDir, name);
    if (previousJsonFiles.get(candidate) !== fileVersion(candidate)) {
      return parseTranscriptJson(fs.readFileSync(candidate, 'utf8'));
    }
  }
  if (stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
    return parseTranscriptJson(stdout);
  }
  throw new Error('transcription provider did not produce JSON output');
}

function fileVersion(candidate: string): string {
  const stat = fs.statSync(candidate, { bigint: true });
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function jsonFiles(outputDir: string): Map<string, string> {
  if (!fs.existsSync(outputDir)) return new Map();
  return new Map(fs.readdirSync(outputDir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const candidate = path.join(outputDir, file);
      return [candidate, fileVersion(candidate)];
    }));
}

function createMlxWhisperProvider(
  runner: CommandRunner,
  resolvedExecutable: string,
  options: TranscriptionProviderOptions,
): TranscriptionProvider {
  return {
    id: 'mlx-whisper',
    available: () => true,
    transcribe(inputPath, outputDir) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
        const before = jsonFiles(outputDir);
        const modelPath = options.mlxWhisperModelPath ?? process.env.ME_MLX_WHISPER_MODEL;
        const args = [
          inputPath,
          '--output-dir', outputDir,
          '--output-format', 'json',
          ...(modelPath ? ['--model', modelPath] : []),
        ];
        const result = runner.run(resolvedExecutable, args, { timeoutMs: 1800000 });
        if (result.status !== 0) throw new Error('non-zero status');
        const basename = path.basename(inputPath, path.extname(inputPath));
        return readProviderOutput(outputDir, [path.join(outputDir, `${basename}.json`)], before, result.stdout);
      } catch {
        throw new Error('mlx-whisper transcription failed');
      }
    },
  };
}

function createWhisperCppProvider(
  runner: CommandRunner,
  resolvedExecutable: string,
  options: TranscriptionProviderOptions,
): TranscriptionProvider {
  return {
    id: 'whisper-cpp',
    available: () => true,
    transcribe(inputPath, outputDir) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
        const modelPath = options.whisperCppModelPath ?? process.env.ME_WHISPER_MODEL;
        if (!modelPath) throw new Error('model is not configured');
        const before = jsonFiles(outputDir);
        const outputBase = path.join(outputDir, 'transcript');
        const result = runner.run(resolvedExecutable, [
          '-m', modelPath,
          '-f', inputPath,
          '-l', 'auto',
          '-oj',
          '-of', outputBase,
        ], { timeoutMs: 1800000 });
        if (result.status !== 0) throw new Error('non-zero status');
        return readProviderOutput(outputDir, [`${outputBase}.json`], before, result.stdout);
      } catch {
        throw new Error('whisper-cpp transcription failed');
      }
    },
  };
}

export function discoverTranscriptionProvider(
  preference: TranscriptionProviderId[] | undefined,
  runner: CommandRunner,
  options: TranscriptionProviderOptions = {},
): TranscriptionProvider | null {
  for (const provider of preference ?? DEFAULT_PREFERENCE) {
    if (provider === 'mlx-whisper') {
      const resolved = executable(runner, 'mlx-whisper') ?? executable(runner, 'mlx_whisper');
      if (resolved) return createMlxWhisperProvider(runner, resolved, options);
    } else if (provider === 'whisper-cpp') {
      const resolved = executable(runner, 'whisper-cli');
      if (resolved) return createWhisperCppProvider(runner, resolved, options);
    }
  }
  return null;
}
