import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeVaultWrite,
  type VaultWriteHooks,
} from '../bin/vault-write/transaction.ts';
import type { VaultWriteRequestV1 } from '../bin/vault-write/contracts.ts';

const temporaryDirectories: string[] = [];
const pluginRoot = path.resolve(import.meta.dir, '..');

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

function makeVault(): string {
  const fixture = temporaryDirectory('me-vault-future-sections-');
  const vault = path.join(fixture, 'vault');
  fs.mkdirSync(vault);
  fs.mkdirSync(path.join(vault, '.me'));
  for (const layer of ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer));
  }
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  fs.writeFileSync(path.join(vault, 'raw/source.md'), '# Source\n');
  return vault;
}

/**
 * A practices note that carries the optional future-retrieval contract
 * sections as ordinary Markdown (issue #19). The contract forbids new
 * frontmatter fields, so the frontmatter stays schema-exact.
 */
function futureSectionMarkdown(title: string, created: string): string {
  return [
    '---',
    `title: ${title}`,
    `created: ${created}`,
    'tags: [capacity-planning, year-end-review]',
    'type: reflection',
    'source: "[[raw/source]]"',
    'project: ""',
    '---',
    '',
    '## Context',
    '',
    '平台升级评审中容量受到质疑。',
    '',
    '## Practice Record',
    '',
    '记录了容量挑战的应对过程。',
    '',
    '## 后续用途',
    '',
    '年底总结（year-end review）时需要重新找到这件事。',
    '',
    '## 决策背景',
    '',
    '选择横向扩容而非升配，依据是可回退性与成本。',
    '',
    '## 未决问题',
    '',
    '峰值压测结论未出；下一个决策点：压测报告出来后重新评估扩容倍数。',
    '',
    '## 检索入口',
    '',
    '- tags: capacity-planning, year-end-review',
    '- 未来检索词：年终复盘、容量挑战',
    '',
    '## 来源',
    '',
    '- 会话线索：`me:recall --query "平台升级 容量"`（taskId 0199a1b2-c3d4，2026-09-20，当前工作区）。',
    '',
  ].join('\n');
}

function futureRequest(
  relativePath = 'reviews/2026-09-20-capacity-challenge.md',
  title = '平台升级容量挑战',
): VaultWriteRequestV1 {
  const created = path.posix.basename(relativePath).slice(0, 10);
  return {
    version: 1,
    layer: 'practices',
    relativePath,
    markdown: futureSectionMarkdown(title, created),
    index: { mode: 'auto' },
  };
}

function run(
  vault: string,
  request: VaultWriteRequestV1,
  mode: 'preview' | 'write',
  hooks?: VaultWriteHooks,
) {
  return executeVaultWrite(vault, request, { pluginRoot, mode, hooks });
}

describe('future-retrieval sections through the existing mutation contract', () => {
  test('preview of a retrieval-planned note writes nothing (chat-only default)', () => {
    const vault = makeVault();
    const result = run(vault, futureRequest(), 'preview');

    expect(result.status).toBe('preview');
    expect(result.commitModel).toBe('preview-only');
    expect(result.changedPaths).toEqual([]);
    expect(fs.existsSync(path.join(vault, 'practices/reviews'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, 'practices/README.md'))).toBeFalse();
  });

  test('write commits a note carrying all five optional sections and creates the layer index', () => {
    const vault = makeVault();
    const result = run(vault, futureRequest(), 'write');

    expect(result.status).toBe('committed');
    const notePath = path.join(vault, 'practices/reviews/2026-09-20-capacity-challenge.md');
    const note = fs.readFileSync(notePath, 'utf8');
    for (const heading of ['## 后续用途', '## 决策背景', '## 未决问题', '## 检索入口', '## 来源']) {
      expect(note).toContain(heading);
    }
    // Provenance stays a pointer (recall query + taskId), never a transcript dump.
    expect(note).toContain('me:recall');
    expect(note).not.toContain('user:');
    expect(note).not.toContain('assistant:');
    // Frontmatter carries no ad hoc fields.
    const frontmatter = note.split('---')[1];
    expect(frontmatter).not.toContain('status:');
    expect(frontmatter).not.toContain('lifecycle:');
    expect(frontmatter).not.toContain('future');

    // Absent index note: the managed per-layer index is created.
    const indexPath = path.join(vault, 'practices/README.md');
    expect(fs.existsSync(indexPath)).toBeTrue();
    expect(fs.readFileSync(indexPath, 'utf8'))
      .toContain('- [[practices/reviews/2026-09-20-capacity-challenge]]');
    expect(result.indexAction).toBe('create');
  });

  test('second retrieval-planned note reuses the existing index instead of duplicating it', () => {
    const vault = makeVault();
    const first = run(vault, futureRequest(), 'write');
    expect(first.status).toBe('committed');

    const second = run(
      vault,
      futureRequest('reviews/2026-10-09-okr-resume.md', 'S2 OKR 恢复讨论'),
      'write',
    );
    expect(second.status).toBe('committed');
    expect(second.indexAction).toBe('replace');

    const indexPath = path.join(vault, 'practices/README.md');
    const index = fs.readFileSync(indexPath, 'utf8');
    expect(index).toContain('- [[practices/reviews/2026-09-20-capacity-challenge]]');
    expect(index).toContain('- [[practices/reviews/2026-10-09-okr-resume]]');
    // Exactly one index note exists for the layer.
    const readmes = [];
    const walk = (directory: string): void => {
      for (const name of fs.readdirSync(directory)) {
        const absolute = path.join(directory, name);
        if (fs.lstatSync(absolute).isDirectory()) walk(absolute);
        else if (name === 'README.md') readmes.push(absolute);
      }
    };
    walk(path.join(vault, 'practices'));
    expect(readmes).toEqual([indexPath]);
  });

  test('a concurrent vault change after planning aborts with INPUT_CHANGED', () => {
    const vault = makeVault();
    const result = run(vault, futureRequest(), 'write', {
      afterLock() {
        fs.writeFileSync(path.join(vault, '.me/config.yaml'), '# concurrent edit\n');
      },
    });

    expect(result.status).toBe('conflict');
    expect(result.error?.code).toBe('INPUT_CHANGED');
    expect(fs.existsSync(path.join(vault, 'practices/reviews'))).toBeFalse();
    expect(fs.existsSync(path.join(vault, 'practices/README.md'))).toBeFalse();
  });

  test('future-retrieval notes work with configured custom layer paths', () => {
    const vault = makeVault();
    fs.writeFileSync(path.join(vault, '.me/config.yaml'), [
      'layers:',
      '  raw: research',
      '  practices: practice',
      '  cognition: insights',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(vault, 'research'));
    fs.mkdirSync(path.join(vault, 'practice'));
    fs.mkdirSync(path.join(vault, 'insights'));
    fs.writeFileSync(path.join(vault, 'research/source.md'), '# Source\n');

    const request = futureRequest();
    request.markdown = request.markdown.replace('[[raw/source]]', '[[research/source]]');
    const result = run(vault, request, 'write');

    expect(result.status).toBe('committed');
    const note = fs.readFileSync(
      path.join(vault, 'practice/reviews/2026-09-20-capacity-challenge.md'),
      'utf8',
    );
    expect(note).toContain('## 检索入口');
    expect(fs.readFileSync(path.join(vault, 'practice/README.md'), 'utf8'))
      .toContain('- [[practice/reviews/2026-09-20-capacity-challenge]]');
  });
});
