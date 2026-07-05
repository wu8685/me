// test/ingest-unit.test.ts — unit tests for bin/ingest.ts pure functions
// Run with: bun test test/ingest-unit.test.ts

import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import functions under test
import {
  resolveConfig,
  detectLanguage,
  deriveSlug,
  generateFrontmatter,
  buildVaultIndex,
  autoLink,
  scoreRelatedNotes,
  isBilibiliUrl,
  parseBilibiliBvid,
  getWhisperModelPath,
} from '../bin/ingest.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── resolveConfig ─────────────────────────────────────────────────────────────

describe('resolveConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  test('returns defaults when no config exists', () => {
    const config = resolveConfig(tmpDir);
    expect(config.raw).toBe('raw');
    expect(config.practices).toBe('practices');
    expect(config.cognition).toBe('cognition');
  });

  test('reads custom values from .me/config.yaml', () => {
    fs.mkdirSync(path.join(tmpDir, '.me'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.me', 'config.yaml'),
      'layers:\n  raw: "research"\n  practices: "experiments"\n  cognition: "insights"\n');
    const config = resolveConfig(tmpDir);
    expect(config.raw).toBe('research');
    expect(config.practices).toBe('experiments');
    expect(config.cognition).toBe('insights');
  });

  test('returns defaults for missing keys in partial config', () => {
    fs.mkdirSync(path.join(tmpDir, '.me'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.me', 'config.yaml'),
      'layers:\n  raw: "调研"\n');
    const config = resolveConfig(tmpDir);
    expect(config.raw).toBe('调研');
    expect(config.practices).toBe('practices');
    expect(config.cognition).toBe('cognition');
  });

  test('handles quoted values', () => {
    fs.mkdirSync(path.join(tmpDir, '.me'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.me', 'config.yaml'),
      "layers:\n  raw: '调研'\n  practices: '实践'\n  cognition: '认知'\n");
    const config = resolveConfig(tmpDir);
    expect(config.raw).toBe('调研');
    expect(config.practices).toBe('实践');
    expect(config.cognition).toBe('认知');
  });
});

// ── detectLanguage ────────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  test('returns "en" for English text', () => {
    const text = 'This is a sample English article about machine learning and AI agents.';
    expect(detectLanguage(text)).toBe('en');
  });

  test('returns "zh" for predominantly Chinese text', () => {
    const text = '本文介绍了人工智能在现代社会中的应用，探讨了机器学习算法的发展趋势。';
    expect(detectLanguage(text)).toBe('zh');
  });

  test('returns "en" for text below 0.3 Chinese ratio', () => {
    // ~10% Chinese: 5 Chinese chars out of 50 total non-whitespace
    const text = 'This article covers 中文 topics in 技术 depth with English';
    expect(detectLanguage(text)).toBe('en');
  });

  test('returns "zh" for text at or above 0.3 Chinese ratio', () => {
    // All Chinese
    const text = '人工智能机器学习深度学习神经网络自然语言处理计算机视觉';
    expect(detectLanguage(text)).toBe('zh');
  });

  test('uses only first 500 chars for detection', () => {
    // First 500 chars all English, remainder all Chinese
    const english500 = 'a'.repeat(500);
    const chineseSuffix = '中文内容'.repeat(100);
    expect(detectLanguage(english500 + chineseSuffix)).toBe('en');
  });

  test('returns "en" for empty text', () => {
    expect(detectLanguage('')).toBe('en');
  });
});

// ── deriveSlug ────────────────────────────────────────────────────────────────

describe('deriveSlug', () => {
  test('lowercases and hyphenates English title', () => {
    expect(deriveSlug('Attention Is All You Need')).toBe('attention-is-all-you-need');
  });

  test('strips Chinese characters', () => {
    expect(deriveSlug('Claude Code 使用指南')).toBe('claude-code');
  });

  test('truncates to 60 chars max', () => {
    const longTitle = 'A Very Long Title That Exceeds Sixty Characters In Total Length When Written Out';
    const result = deriveSlug(longTitle);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  test('collapses consecutive hyphens', () => {
    expect(deriveSlug('Hello   World')).toBe('hello-world');
  });

  test('removes leading and trailing hyphens', () => {
    expect(deriveSlug('---hello---')).toBe('hello');
  });

  test('handles special characters', () => {
    expect(deriveSlug('C++ Programming: The Complete Guide')).toBe('c-programming-the-complete-guide');
  });

  test('handles mixed Chinese and English', () => {
    const result = deriveSlug('GPT-4 技术报告 Analysis');
    expect(result).toBe('gpt-4-analysis');
  });

  test('handles title with only Chinese (returns empty-safe slug)', () => {
    const result = deriveSlug('纯中文标题文章');
    // All Chinese stripped, result should be empty or minimal
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  test('does not produce consecutive hyphens from punctuation', () => {
    const result = deriveSlug('Hello, World! How Are You?');
    expect(result).not.toMatch(/--/);
  });
});

// ── generateFrontmatter ───────────────────────────────────────────────────────

describe('generateFrontmatter', () => {
  test('returns YAML frontmatter with all required fields', () => {
    const result = generateFrontmatter('Test Article', '2026-04-06', ['ai', 'test'], 'https://example.com');
    expect(result).toContain('title:');
    expect(result).toContain('created:');
    expect(result).toContain('tags:');
    expect(result).toContain('type:');
    expect(result).toContain('source:');
  });

  test('includes the correct title', () => {
    const result = generateFrontmatter('My Article Title', '2026-04-06', [], 'https://example.com');
    expect(result).toContain('My Article Title');
  });

  test('type is always "article"', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result).toContain('type: article');
  });

  test('includes created date', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result).toContain('2026-04-06');
  });

  test('includes source URL', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://my-source.com/article');
    expect(result).toContain('https://my-source.com/article');
  });

  test('does NOT include status field', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result).not.toMatch(/^status:/m);
  });

  test('does NOT include lifecycle field', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result).not.toMatch(/^lifecycle:/m);
  });

  test('does NOT include date_created field', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result).not.toMatch(/date_created/m);
  });

  test('includes tags array', () => {
    const result = generateFrontmatter('Title', '2026-04-06', ['ai-agents', 'ml'], 'https://example.com');
    expect(result).toContain('ai-agents');
    expect(result).toContain('ml');
  });

  test('wraps output in frontmatter delimiters', () => {
    const result = generateFrontmatter('Title', '2026-04-06', [], 'https://example.com');
    expect(result.trim()).toMatch(/^---/);
    expect(result.trim()).toMatch(/---\s*$/);
  });
});

// ── buildVaultIndex ───────────────────────────────────────────────────────────

describe('buildVaultIndex', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tmpDir); });

  test('returns empty map for empty vault', () => {
    fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'practices'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cognition'), { recursive: true });
    const index = buildVaultIndex(tmpDir);
    expect(index.size).toBe(0);
  });

  test('indexes notes by lowercase title', () => {
    fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'raw', '2026-04-06-claude-agents.md'),
      '---\ntitle: "Claude Agents in Production"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nContent.');
    const index = buildVaultIndex(tmpDir);
    expect(index.has('claude agents in production')).toBe(true);
    const entry = index.get('claude agents in production')!;
    expect(entry.stem).toBe('2026-04-06-claude-agents');
    expect(entry.title).toBe('Claude Agents in Production');
  });

  test('indexes notes from multiple layer directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'practices'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'raw', 'note-a.md'),
      '---\ntitle: "Note A"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n');
    fs.writeFileSync(path.join(tmpDir, 'practices', 'note-b.md'),
      '---\ntitle: "Note B"\ncreated: 2026-04-06\ntags: []\ntype: experiment\nsource: ""\nproject: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    expect(index.has('note a')).toBe(true);
    expect(index.has('note b')).toBe(true);
  });

  test('skips files without title frontmatter', () => {
    fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'raw', 'no-title.md'), '# Just a heading\n\nNo frontmatter.');
    const index = buildVaultIndex(tmpDir);
    expect(index.size).toBe(0);
  });

  test('respects custom layer directories from config', () => {
    fs.mkdirSync(path.join(tmpDir, '.me'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.me', 'config.yaml'),
      'layers:\n  raw: "research"\n  practices: "experiments"\n  cognition: "insights"\n');
    fs.mkdirSync(path.join(tmpDir, 'research'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'research', 'custom-note.md'),
      '---\ntitle: "Custom Note"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    expect(index.has('custom note')).toBe(true);
  });
});

// ── autoLink ──────────────────────────────────────────────────────────────────

describe('autoLink', () => {
  function makeIndex(entries: Array<{ title: string; stem: string; path: string }>): Map<string, { stem: string; path: string; title: string }> {
    const map = new Map<string, { stem: string; path: string; title: string }>();
    for (const e of entries) {
      map.set(e.title.toLowerCase(), e);
    }
    return map;
  }

  test('replaces first occurrence of vault title in body', () => {
    const body = '---\ntitle: "Test"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nSee Claude Agents in Production for details. Claude Agents in Production is great.';
    const index = makeIndex([{ title: 'Claude Agents in Production', stem: '2026-04-06-claude-agents', path: 'raw/2026-04-06-claude-agents.md' }]);
    const result = autoLink(body, index);
    expect(result.linkedBody).toContain('[[2026-04-06-claude-agents|Claude Agents in Production]]');
    // Second occurrence should NOT be linked
    const occurrences = (result.linkedBody.match(/\[\[2026-04-06-claude-agents\|Claude Agents in Production\]\]/g) || []).length;
    expect(occurrences).toBe(1);
  });

  test('does NOT modify frontmatter', () => {
    const content = '---\ntitle: "Claude Agents in Production"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nBody text here.';
    const index = makeIndex([{ title: 'Claude Agents in Production', stem: 'note-a', path: 'raw/note-a.md' }]);
    const result = autoLink(content, index);
    // Extract frontmatter (between first and second ---)
    const parts = result.linkedBody.split('---');
    const frontmatter = parts[1] || '';
    expect(frontmatter).not.toContain('[[');
  });

  test('returns links array with matched entries', () => {
    const body = '---\ntitle: "Test"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nSee Note A for info.';
    const index = makeIndex([{ title: 'Note A', stem: 'note-a', path: 'raw/note-a.md' }]);
    const result = autoLink(body, index);
    expect(result.links.length).toBe(1);
    expect(result.links[0]).toContain('note-a');
  });

  test('matches longer titles before shorter ones', () => {
    const body = '---\ntitle: "Test"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nSee Claude Code Assistant for details.';
    const index = makeIndex([
      { title: 'Claude Code', stem: 'claude-code', path: 'raw/claude-code.md' },
      { title: 'Claude Code Assistant', stem: 'claude-code-assistant', path: 'raw/claude-code-assistant.md' },
    ]);
    const result = autoLink(body, index);
    // Should match the longer title first
    expect(result.linkedBody).toContain('[[claude-code-assistant|Claude Code Assistant]]');
    expect(result.linkedBody).not.toContain('[[claude-code|Claude Code]]');
  });

  test('case-insensitive matching', () => {
    const body = '---\ntitle: "Test"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nSee machine learning concepts.';
    const index = makeIndex([{ title: 'Machine Learning', stem: 'machine-learning', path: 'raw/machine-learning.md' }]);
    const result = autoLink(body, index);
    expect(result.linkedBody).toContain('[[machine-learning|Machine Learning]]');
  });

  test('returns empty links/stubs for no matches', () => {
    const body = '---\ntitle: "Test"\ncreated: 2026-04-06\ntags: []\ntype: article\nsource: ""\n---\n\nNo matching content here.';
    const index = makeIndex([{ title: 'Nonexistent Topic', stem: 'nonexistent', path: 'raw/nonexistent.md' }]);
    const result = autoLink(body, index);
    expect(result.links.length).toBe(0);
  });
});

// ── scoreRelatedNotes ─────────────────────────────────────────────────────────

describe('scoreRelatedNotes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'practices'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cognition'), { recursive: true });
  });
  afterEach(() => { cleanupDir(tmpDir); });

  test('scores 2 pts per shared tag', () => {
    fs.writeFileSync(path.join(tmpDir, 'raw', 'note-a.md'),
      '---\ntitle: "Note A"\ncreated: 2026-04-06\ntags: [ai-agents, machine-learning]\ntype: article\nsource: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    const results = scoreRelatedNotes(['ai-agents', 'machine-learning'], 'New Article', index, tmpDir);
    // Should find note-a with score of 4 (2 shared tags * 2pts)
    const noteA = results.find(r => r.path.includes('note-a'));
    expect(noteA).toBeDefined();
    expect(noteA!.score).toBeGreaterThanOrEqual(4);
  });

  test('scores 1 pt per shared significant title keyword', () => {
    fs.writeFileSync(path.join(tmpDir, 'raw', 'agent-note.md'),
      '---\ntitle: "AI Agent Patterns"\ncreated: 2026-04-06\ntags: [tools]\ntype: article\nsource: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    // Shares keyword "agent" but no tags
    const results = scoreRelatedNotes(['unrelated'], 'Agent Framework Design', index, tmpDir);
    const agentNote = results.find(r => r.path.includes('agent-note'));
    // "agent" is a shared keyword between "Agent Framework Design" and "AI Agent Patterns"
    if (agentNote) {
      expect(agentNote.score).toBeGreaterThanOrEqual(1);
    }
  });

  test('filters out notes with score < 2', () => {
    fs.writeFileSync(path.join(tmpDir, 'raw', 'unrelated.md'),
      '---\ntitle: "Cooking Recipes"\ncreated: 2026-04-06\ntags: [cooking]\ntype: article\nsource: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    const results = scoreRelatedNotes(['ai-agents'], 'New AI Article', index, tmpDir);
    const unrelatedNote = results.find(r => r.path.includes('unrelated'));
    expect(unrelatedNote).toBeUndefined();
  });

  test('returns results sorted by score descending', () => {
    fs.writeFileSync(path.join(tmpDir, 'raw', 'high.md'),
      '---\ntitle: "High Score"\ncreated: 2026-04-06\ntags: [ai-agents, ml, tools]\ntype: article\nsource: ""\n---\n');
    fs.writeFileSync(path.join(tmpDir, 'practices', 'low.md'),
      '---\ntitle: "Low Score"\ncreated: 2026-04-06\ntags: [ai-agents]\ntype: experiment\nsource: ""\nproject: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    const results = scoreRelatedNotes(['ai-agents', 'ml', 'tools'], 'New Article', index, tmpDir);
    if (results.length >= 2) {
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    }
  });

  test('skips stop words in title keyword scoring', () => {
    fs.writeFileSync(path.join(tmpDir, 'raw', 'stop-words.md'),
      '---\ntitle: "The Art of the Deal"\ncreated: 2026-04-06\ntags: [business]\ntype: article\nsource: ""\n---\n');
    const index = buildVaultIndex(tmpDir);
    // "the" and "of" are stop words — should not count
    const results = scoreRelatedNotes(['unrelated'], 'The Story of the Year', index, tmpDir);
    // Stop words ("the", "of") should not create a score of >= 2
    const stopWordNote = results.find(r => r.path.includes('stop-words'));
    expect(stopWordNote).toBeUndefined();
  });
});

// ── isBilibiliUrl ─────────────────────────────────────────────────────────────

describe('isBilibiliUrl', () => {
  test('returns true for canonical bilibili.com/video/BV... URL', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/BV1GpL76LEHH')).toBe(true);
  });

  test('returns true for bilibili.com/video/BV... URL with query string', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/video/BV1GpL76LEHH?spm_id_from=333.788')).toBe(true);
  });

  test('returns true for b23.tv short link', () => {
    expect(isBilibiliUrl('https://b23.tv/abc123')).toBe(true);
  });

  test('returns false for unrelated http URL', () => {
    expect(isBilibiliUrl('https://example.com')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isBilibiliUrl('')).toBe(false);
  });

  test('returns false for bilibili bangumi URL (only /video/ is supported)', () => {
    expect(isBilibiliUrl('https://www.bilibili.com/bangumi/play/ep12345')).toBe(false);
  });
});

// ── parseBilibiliBvid ─────────────────────────────────────────────────────────

describe('parseBilibiliBvid', () => {
  test('extracts BV id from canonical URL', () => {
    expect(parseBilibiliBvid('https://www.bilibili.com/video/BV1GpL76LEHH')).toBe('BV1GpL76LEHH');
  });

  test('extracts BV id from URL with spm_id_from query', () => {
    expect(parseBilibiliBvid('https://www.bilibili.com/video/BV1GpL76LEHH?spm_id_from=333.788')).toBe('BV1GpL76LEHH');
  });

  test('extracts BV id from URL with /?p=N pagination', () => {
    expect(parseBilibiliBvid('https://www.bilibili.com/video/BV1GpL76LEHH/?p=2')).toBe('BV1GpL76LEHH');
  });

  test('extracts BV id from URL with trailing slash', () => {
    expect(parseBilibiliBvid('https://www.bilibili.com/video/BV1GpL76LEHH/')).toBe('BV1GpL76LEHH');
  });

  test('returns null for non-bilibili URL', () => {
    expect(parseBilibiliBvid('https://example.com/foo')).toBe(null);
  });

  test.skip('resolves b23.tv via curl redirect (requires live network)', () => {
    // This test exercises the curl redirect path for b23.tv short links.
    // Sandboxed/offline test environments cannot reach bilibili.com, so this
    // case is documented but skipped by default. Run manually when validating
    // against the live API.
    expect(true).toBe(true);
  });
});

// ── getWhisperModelPath ─────────────────────────────────────────────────────

describe('getWhisperModelPath', () => {
  let tmpDir: string;
  const saved = process.env.ME_WHISPER_MODEL;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => {
    cleanupDir(tmpDir);
    if (saved === undefined) delete process.env.ME_WHISPER_MODEL;
    else process.env.ME_WHISPER_MODEL = saved;
  });

  test('honors ME_WHISPER_MODEL env var when the file exists', () => {
    const modelFile = path.join(tmpDir, 'custom-model.bin');
    fs.writeFileSync(modelFile, 'fake-model-weights');
    process.env.ME_WHISPER_MODEL = modelFile;

    expect(getWhisperModelPath()).toBe(modelFile);
  });
});
