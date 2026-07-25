import * as fs from 'fs';
import * as path from 'path';
import type { ExtractMode } from './contracts.ts';
import type { TranscriptionProviderId, TranscriptionProviderOptions } from './media/transcription.ts';

export interface IngestConfig extends TranscriptionProviderOptions {
  defaultVideoMode: ExtractMode;
  handoutProfilePath?: string;
  transcriptionPreference: TranscriptionProviderId[];
}

const DEFAULT_PREFERENCE: TranscriptionProviderId[] = ['mlx-whisper', 'whisper-cpp'];
const EXTRACT_MODES = new Set<ExtractMode>(['raw', 'translate-cn', 'summarize', 'transcribe', 'handout']);
const PROVIDERS = new Set<TranscriptionProviderId>(DEFAULT_PREFERENCE);

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function rejectEscapingSymlinks(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
    if (!isInside(root, target)) {
      throw new Error(`${label} is outside vault`);
    }
    if (!fs.existsSync(current)) {
      throw new Error(`${label} is outside vault`);
    }
  }
}

function resolveVaultPath(vaultDir: string, configuredPath: string, label: string): string {
  const root = fs.realpathSync(vaultDir);
  const candidate = path.resolve(vaultDir, configuredPath);
  if (!isInside(path.resolve(vaultDir), candidate)) {
    throw new Error(`${label} is outside vault`);
  }
  rejectEscapingSymlinks(path.resolve(vaultDir), candidate, label);

  const existing = nearestExistingPath(candidate);
  const realExisting = fs.realpathSync(existing);
  if (!isInside(root, realExisting)) {
    throw new Error(`${label} is outside vault`);
  }
  if (fs.existsSync(candidate) && !isInside(root, fs.realpathSync(candidate))) {
    throw new Error(`${label} is outside vault`);
  }
  return candidate;
}

function stripYamlComment(value: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? undefined : character;
    } else if (character === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function scalar(value: string): string {
  const clean = stripYamlComment(value);
  if (
    clean.length >= 2
    && ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'")))
  ) {
    return clean.slice(1, -1);
  }
  return clean;
}

interface ParsedIngestConfig {
  default_video_mode?: string;
  handout_profile?: string;
  transcription_preference?: string[];
  mlx_whisper_model?: string;
  whisper_cpp_model?: string;
}

function parseIngestSection(text: string): ParsedIngestConfig {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^ingest\s*:\s*(?:#.*)?$/.test(line));
  if (start < 0) return {};
  const directIndent = lines
    .slice(start + 1)
    .find(line => line.trim() && !/^\s*#/.test(line))
    ?.match(/^\s*/)?.[0].length;
  if (!directIndent) return {};
  const section: ParsedIngestConfig = {};

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0) break;
    if (indent !== directIndent) continue;
    const entry = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/);
    if (!entry) continue;
    const [, key, rawValue] = entry;
    if (key === 'transcription_preference') {
      const inline = scalar(rawValue);
      if (inline === '[]') {
        section.transcription_preference = [];
        continue;
      }
      if (inline.startsWith('[') && inline.endsWith(']')) {
        section.transcription_preference = inline
          .slice(1, -1)
          .split(',')
          .map(item => scalar(item))
          .filter(Boolean);
        continue;
      }
      const values: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const itemLine = lines[index];
        if (!itemLine.trim() || /^\s*#/.test(itemLine)) continue;
        const itemIndent = itemLine.match(/^\s*/)?.[0].length ?? 0;
        const item = itemLine.match(/^\s*-\s*(.*?)\s*$/);
        if (itemIndent <= directIndent || !item) {
          index -= 1;
          break;
        }
        values.push(scalar(item[1]));
      }
      section.transcription_preference = values.filter(Boolean);
      continue;
    }
    if (
      key === 'default_video_mode'
      || key === 'handout_profile'
      || key === 'mlx_whisper_model'
      || key === 'whisper_cpp_model'
    ) {
      section[key] = scalar(rawValue);
    }
  }
  return section;
}

export function resolveIngestConfig(vaultDir: string): IngestConfig {
  const vault = path.resolve(vaultDir);
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    throw new Error('vault directory does not exist');
  }
  const configPath = path.join(vault, '.me', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return {
      defaultVideoMode: 'handout',
      transcriptionPreference: [...DEFAULT_PREFERENCE],
    };
  }
  resolveVaultPath(vault, configPath, 'config path');

  const parsed = parseIngestSection(fs.readFileSync(configPath, 'utf8'));
  const defaultVideoMode = parsed.default_video_mode || 'handout';
  if (!EXTRACT_MODES.has(defaultVideoMode as ExtractMode)) {
    throw new Error(`invalid ingest.default_video_mode: ${defaultVideoMode}`);
  }
  const transcriptionPreference = parsed.transcription_preference ?? [...DEFAULT_PREFERENCE];
  if (transcriptionPreference.some(provider => !PROVIDERS.has(provider as TranscriptionProviderId))) {
    throw new Error('invalid ingest.transcription_preference');
  }

  return {
    defaultVideoMode: defaultVideoMode as ExtractMode,
    ...(parsed.handout_profile
      ? { handoutProfilePath: resolveVaultPath(vault, parsed.handout_profile, 'handout profile path') }
      : {}),
    transcriptionPreference: transcriptionPreference as TranscriptionProviderId[],
    ...(parsed.mlx_whisper_model
      ? { mlxWhisperModelPath: resolveVaultPath(vault, parsed.mlx_whisper_model, 'mlx-whisper model path') }
      : {}),
    ...(parsed.whisper_cpp_model
      ? { whisperCppModelPath: resolveVaultPath(vault, parsed.whisper_cpp_model, 'whisper.cpp model path') }
      : {}),
  };
}
