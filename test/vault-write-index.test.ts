import { afterEach, describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VaultWriterError } from '../bin/vault-write/contracts.ts';
import {
  resolveVaultLayout,
  resolveWriteTarget,
  type ResolvedWriteTarget,
} from '../bin/vault-write/path-safety.ts';
import {
  snapshotVaultGraph,
  type VaultGraphSnapshot,
} from '../bin/vault-write/graph.ts';
import {
  planIndexUpdate,
  validatePostWriteGraph,
} from '../bin/vault-write/index.ts';

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

function makeVault(custom = false): {
  vault: string;
  layout: ReturnType<typeof resolveVaultLayout>;
  target: ResolvedWriteTarget;
} {
  const vault = temporaryDirectory('me-vault-index-');
  fs.mkdirSync(path.join(vault, '.me'));
  fs.writeFileSync(path.join(vault, 'SCHEMA.md'), '# Schema\n');
  if (custom) {
    fs.writeFileSync(path.join(vault, '.me/config.yaml'), [
      'layers:',
      '  raw: knowledge/raw',
      '  practices: knowledge/practices',
      '  cognition: knowledge/cognition',
      '',
    ].join('\n'));
  }
  const roots = custom
    ? ['knowledge/raw', 'knowledge/practices', 'knowledge/cognition']
    : ['raw', 'practices', 'cognition'];
  for (const root of roots) fs.mkdirSync(path.join(vault, root), { recursive: true });
  const layout = resolveVaultLayout(vault);
  const target = resolveWriteTarget(layout, {
    version: 1,
    layer: 'practices',
    relativePath: 'decisions/2026-07-26-orchid-choice.md',
    markdown: 'body',
    index: { mode: 'auto' },
  });
  return { vault, layout, target };
}

function write(vault: string, relative: string, markdown: string): string {
  const absolute = path.join(vault, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, markdown);
  return absolute;
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(VaultWriterError);
    expect((error as VaultWriterError).code).toBe(code);
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('resolved writer target identity', () => {
  test('carries one consistent absolute and vault-relative target identity', () => {
    const { vault, target } = makeVault();
    expect(target).toEqual({
      layerRoot: path.join(vault, 'practices'),
      notePath: path.join(vault, 'practices/decisions/2026-07-26-orchid-choice.md'),
      vaultRelativePath: 'practices/decisions/2026-07-26-orchid-choice.md',
      stem: '2026-07-26-orchid-choice',
      indexPath: path.join(vault, 'practices/README.md'),
    });
  });
});

describe('writer-owned Markdown graph', () => {
  test('resolves qualified and unique basename links while stripping alias and fragments', () => {
    const { vault, layout } = makeVault();
    write(vault, 'raw/source.md', '# source\n');
    write(vault, 'practices/one.md', [
      '[[raw/source|Source]] [[raw/source#heading]] [[raw/source#^block]]',
      '[[source]]',
      '',
    ].join('\n'));

    const graph = snapshotVaultGraph(layout);
    expect(graph.broken.size).toBe(0);
    expect(graph.incoming.get('raw/source.md')).toBe(4);
    expect(graph.orphans.has('raw/source.md')).toBeFalse();
  });

  test('treats duplicate ordinary stems as ambiguous but qualified paths as exact', () => {
    const { vault, layout } = makeVault();
    write(vault, 'raw/a/Guide.md', '# A\n');
    write(vault, 'cognition/b/guide.md', '# B\n');
    write(vault, 'practices/links.md', '[[Guide]] [[raw/a/Guide]]\n');

    const graph = snapshotVaultGraph(layout);
    expect([...graph.broken].some(item => item.includes('[[Guide]]'))).toBeTrue();
    expect(graph.incoming.get('raw/a/Guide.md')).toBe(1);
    expect(graph.incoming.get('cognition/b/guide.md') ?? 0).toBe(0);
  });

  test('uses ASCII-only folding and exact non-ASCII stem identity', () => {
    const { vault, layout } = makeVault();
    write(vault, 'raw/a/Résumé.md', '# A\n');
    write(vault, 'cognition/b/résumé.md', '# B\n');
    write(vault, 'practices/links.md', '[[Résumé]] [[résumé]]\n');
    let graph = snapshotVaultGraph(layout);
    expect(graph.broken.size).toBe(0);
    expect(graph.incoming.get('raw/a/Résumé.md')).toBe(1);
    expect(graph.incoming.get('cognition/b/résumé.md')).toBe(1);

    write(vault, 'cognition/c/Résumé.md', '# duplicate exact code points\n');
    graph = snapshotVaultGraph(layout);
    expect([...graph.broken].some(item => item.includes('[[Résumé]]'))).toBeTrue();
  });

  test('ignores frontmatter, paired inline code, and matching 3/4 marker fences', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/code.md', [
      '---',
      'source: "[[2026-07-26-orchid-choice]]"',
      '---',
      '`[[2026-07-26-orchid-choice]]`',
      '`` [[2026-07-26-orchid-choice]] ``',
      '```md',
      '[[2026-07-26-orchid-choice]]',
      '```',
      '````',
      '[[2026-07-26-orchid-choice]]',
      '````',
      '~~~',
      '[[2026-07-26-orchid-choice]]',
      '~~~',
      '~~~~',
      '[[2026-07-26-orchid-choice]]',
      '~~~~',
      '',
    ].join('\n'));

    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(plan.suggestions.backlinks).toEqual([]);
    expect(plan.index.action).toBe('create');
  });

  test('requires the same inline delimiter and a long-enough same-character fence closer', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/fences.md', [
      '`` `[[2026-07-26-orchid-choice]]` ``',
      '````',
      '[[2026-07-26-orchid-choice]]',
      '```',
      '~~~~',
      '[[2026-07-26-orchid-choice]]',
      '```',
      '~~~~',
      '````',
      'outside [[2026-07-26-orchid-choice]]',
      '',
    ].join('\n'));
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(plan.suggestions.backlinks).toEqual([
      { path: 'raw/fences.md', count: 1 },
    ]);
    expect(plan.index.action).toBe('none');
  });

  test('masks a code span across line endings until an exact delimiter run', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/multiline-code.md', [
      '``opening',
      '[[2026-07-26-orchid-choice]] Orchid Choice',
      '`',
      'still code [[2026-07-26-orchid-choice]] Orchid Choice',
      '``',
      'visible Orchid Choice',
      '',
    ].join('\n'));

    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(plan.suggestions.backlinks).toEqual([]);
    expect(plan.suggestions.unlinkedMentions).toEqual([
      {
        path: 'raw/multiline-code.md',
        count: 1,
        offsets: [120],
      },
    ]);
    expect(plan.index.action).toBe('create');
  });

  test.each(['```', '~~~', '~~~~'])(
    'masks an unclosed %s code block through EOF',
    opener => {
      const { vault, layout, target } = makeVault();
      const body = `${opener}md\n[[2026-07-26-orchid-choice]] Orchid Choice\n`;
      write(vault, 'raw/unclosed.md', body);
      const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
      expect(plan.suggestions.backlinks).toEqual([]);
      expect(plan.suggestions.unlinkedMentions).toEqual([]);
      expect(plan.index.action).toBe('create');
    },
  );

  test('uses opening escape parity while keeping exact-run closer semantics', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/escape-parity.md', [
      '\\`escaped opener [[2026-07-26-orchid-choice]]',
      '\\\\``real opener',
      '[[2026-07-26-orchid-choice]]',
      '`',
      'still masked [[2026-07-26-orchid-choice]]',
      '``',
      '',
    ].join('\n'));
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(plan.suggestions.backlinks).toEqual([
      { path: 'raw/escape-parity.md', count: 1 },
    ]);
  });

  test('fingerprints sorted note inputs and excludes README from ordinary notes', () => {
    const { vault, layout } = makeVault();
    write(vault, 'raw/z.md', '# z\n');
    write(vault, 'raw/README.md', '[[raw/z]]\n');
    write(vault, 'cognition/a.md', '# a\n');
    const first = snapshotVaultGraph(layout);
    const second = snapshotVaultGraph(layout);

    expect(first.noteFiles).toEqual(['cognition/a.md', 'raw/z.md']);
    expect(first.inputs.map(input => input.path)).toEqual([
      'cognition/a.md',
      'raw/README.md',
      'raw/z.md',
    ]);
    expect(second.inputs).toEqual(first.inputs);
    expect(first.inputs.every(input =>
      /^[0-9a-f]{64}$/.test(input.sha256) && input.identity.length > 0
    )).toBeTrue();
    expect(first.incoming.get('raw/z.md')).toBe(1);
  });

  test.each(['escaping', 'dangling'])('fails closed on %s symlinks during traversal', kind => {
    const { vault, layout } = makeVault();
    const outside = temporaryDirectory('me-vault-index-outside-');
    const link = path.join(vault, 'raw', 'linked');
    if (kind === 'escaping') {
      fs.writeFileSync(path.join(outside, 'note.md'), '# outside\n');
      fs.symlinkSync(outside, link);
    } else {
      fs.symlinkSync(path.join(outside, 'missing'), link);
    }
    expectCode(() => snapshotVaultGraph(layout), 'UNSAFE_PATH');
  });

  test('allows a contained non-Markdown symlink while excluding it from graph inputs', () => {
    const { vault, layout } = makeVault();
    const asset = write(vault, 'assets/image.txt', 'not Markdown');
    fs.symlinkSync(asset, path.join(vault, 'raw/image.txt'));
    const graph = snapshotVaultGraph(layout);
    expect(graph.inputs).toEqual([]);
  });
});

describe('deterministic reachability and suggestions', () => {
  test('uses a real existing backlink instead of touching the index', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/ref.md', [
      '[[practices/decisions/2026-07-26-orchid-choice|choice]]',
      '[[2026-07-26-orchid-choice#why]]',
      '',
    ].join('\n'));
    const result = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(result.index).toEqual({
      action: 'none',
      path: 'practices/README.md',
    });
    expect(result.suggestions.backlinks).toEqual([
      { path: 'raw/ref.md', count: 2 },
    ]);
  });

  test.each([
    [false, 'practices/decisions/2026-07-26-orchid-choice'],
    [true, 'knowledge/practices/decisions/2026-07-26-orchid-choice'],
  ])('creates a full vault-relative managed entry (custom=%s)', (custom, qualified) => {
    const { layout, target } = makeVault(custom);
    const result = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    const expected = [
      '<!-- me:index:start -->',
      `- [[${qualified}]]`,
      '<!-- me:index:end -->',
      '',
    ].join('\n');
    expect(result.index.action).toBe('create');
    expect(result.index.path).toBe(
      custom ? 'knowledge/practices/README.md' : 'practices/README.md',
    );
    expect(result.index.after?.toString('utf8')).toBe(expected);
    expect(result.index.digest).toBe(sha256(Buffer.from(expected)));
  });

  test('appends without changing any existing README bytes', () => {
    const { vault, layout, target } = makeVault();
    const original = Buffer.from('# Existing\r\n\r\nUser bytes without final LF');
    fs.writeFileSync(path.join(vault, 'practices/README.md'), original);
    const result = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(result.index.action).toBe('replace');
    expect(result.index.before).toEqual(original);
    expect(result.index.after?.subarray(0, original.length)).toEqual(original);
    expect(result.index.after?.toString('utf8')).toBe([
      original.toString('utf8'),
      '',
      '<!-- me:index:start -->',
      '- [[practices/decisions/2026-07-26-orchid-choice]]',
      '<!-- me:index:end -->',
      '',
    ].join('\n'));
  });

  test('normalizes, deduplicates, and code-point sorts a valid managed block', () => {
    const { vault, layout, target } = makeVault();
    fs.writeFileSync(path.join(vault, 'practices/README.md'), [
      '# Keep',
      '<!-- me:index:start -->',
      '- [[practices/éclair]]',
      '- [[practices/zebra]]',
      '- [[practices/éclair]]',
      '<!-- me:index:end -->',
      'Tail stays.',
      '',
    ].join('\n'));
    const result = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(result.index.after?.toString('utf8')).toBe([
      '# Keep',
      '<!-- me:index:start -->',
      '- [[practices/decisions/2026-07-26-orchid-choice]]',
      '- [[practices/zebra]]',
      '- [[practices/éclair]]',
      '<!-- me:index:end -->',
      'Tail stays.',
      '',
    ].join('\n'));
  });

  test.each([
    ['duplicate', '<!-- me:index:start -->\n<!-- me:index:start -->\n<!-- me:index:end -->\n'],
    ['nested', '<!-- me:index:start -->\ntext\n<!-- me:index:start -->\n<!-- me:index:end -->\n<!-- me:index:end -->\n'],
    ['reversed', '<!-- me:index:end -->\n<!-- me:index:start -->\n'],
    ['unclosed', '<!-- me:index:start -->\n'],
  ])('rejects a %s managed block', (_name, readme) => {
    const { vault, layout, target } = makeVault();
    fs.writeFileSync(path.join(vault, 'practices/README.md'), readme);
    expectCode(
      () => planIndexUpdate(layout, 'practices', target, 'Orchid Choice'),
      'INVALID_NOTE',
    );
  });

  test('reports deterministic backlinks and UTF-8 byte-offset mentions without overlap', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/z.md', [
      '前缀 Orchid Choice；后面 orchid choice 与 2026-07-26-ORCHID-CHOICE。',
      '`Orchid Choice` [[2026-07-26-orchid-choice|Orchid Choice]]',
      '',
    ].join('\n'));
    write(vault, 'cognition/a.md', 'Orchid Choice / Orchid Choice\n');
    write(vault, 'raw/README.md', 'Orchid Choice\n');
    const result = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');

    expect(result.suggestions.backlinks).toEqual([
      { path: 'raw/z.md', count: 1 },
    ]);
    expect(result.suggestions.unlinkedMentions).toEqual([
      { path: 'cognition/a.md', count: 2, offsets: [0, 16] },
    ]);
    expect(result.suggestions.unlinkedMentions.every(item =>
      item.count === item.offsets.length
      && item.path.includes('/')
      && !path.isAbsolute(item.path)
    )).toBeTrue();
  });

  test('rejects invalid request stems and vault-wide existing stem collisions', () => {
    const { vault, layout, target } = makeVault();
    expectCode(
      () => planIndexUpdate(
        layout,
        'practices',
        { ...target, stem: 'Résumé' },
        'Résumé',
      ),
      'INVALID_REQUEST',
    );
    write(vault, 'raw/2026-07-26-ORCHID-CHOICE.md', '# existing\n');
    expectCode(
      () => planIndexUpdate(layout, 'practices', target, 'Orchid Choice'),
      'DUPLICATE_STEM',
    );
  });

  test('rejects a target object whose note path belongs to another logical layer', () => {
    const { vault, layout, target } = makeVault();
    const foreignPath = path.join(vault, 'raw/decisions/2026-07-26-orchid-choice.md');
    expectCode(
      () => planIndexUpdate(layout, 'practices', {
        ...target,
        notePath: foreignPath,
        vaultRelativePath: 'raw/decisions/2026-07-26-orchid-choice.md',
      }, 'Orchid Choice'),
      'UNSAFE_PATH',
    );
  });
});

describe('post-write graph no-regression', () => {
  function publishPlanned(
    vault: string,
    target: ResolvedWriteTarget,
    plan: ReturnType<typeof planIndexUpdate>,
    note = '# Orchid\n',
  ): void {
    fs.mkdirSync(path.dirname(target.notePath), { recursive: true });
    fs.writeFileSync(target.notePath, note);
    if (plan.index.action !== 'none') {
      fs.mkdirSync(path.dirname(path.join(vault, plan.index.path)), { recursive: true });
      fs.writeFileSync(path.join(vault, plan.index.path), plan.index.after!);
    }
  }

  test('accepts the planned note once it is reachable and not orphaned', () => {
    const { vault, layout, target } = makeVault();
    const before = snapshotVaultGraph(layout);
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    publishPlanned(vault, target, plan);
    expect(() => validatePostWriteGraph(before, layout, target, plan.index)).not.toThrow();
  });

  test('rejects a new broken link but tolerates an unrelated pre-existing broken link', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/old.md', '[[already-missing]]\n');
    const before = snapshotVaultGraph(layout);
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    publishPlanned(vault, target, plan, '[[newly-missing]]\n');
    expectCode(
      () => validatePostWriteGraph(before, layout, target, plan.index),
      'POST_VALIDATION_FAILED',
    );

    fs.writeFileSync(target.notePath, '# no new broken link\n');
    expect(() => validatePostWriteGraph(before, layout, target, plan.index)).not.toThrow();
  });

  test('rejects planned index byte or digest drift', () => {
    const { vault, layout, target } = makeVault();
    const before = snapshotVaultGraph(layout);
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    publishPlanned(vault, target, plan);
    fs.appendFileSync(path.join(vault, plan.index.path), 'foreign bytes\n');
    expectCode(
      () => validatePostWriteGraph(before, layout, target, plan.index),
      'POST_VALIDATION_FAILED',
    );

    const exact = plan.index.after!;
    fs.writeFileSync(path.join(vault, plan.index.path), exact);
    expectCode(
      () => validatePostWriteGraph(before, layout, target, {
        ...plan.index,
        digest: '0'.repeat(64),
      }),
      'POST_VALIDATION_FAILED',
    );
  });

  test('rejects a target that remains unreachable', () => {
    const { vault, layout, target } = makeVault();
    const before = snapshotVaultGraph(layout);
    const index = {
      action: 'none' as const,
      path: 'practices/README.md',
    };
    fs.mkdirSync(path.dirname(target.notePath), { recursive: true });
    fs.writeFileSync(target.notePath, '# unreachable\n');
    expectCode(
      () => validatePostWriteGraph(before, layout, target, index),
      'POST_VALIDATION_FAILED',
    );
  });

  test.each(['modified', 'added'])(
    'rejects an unrelated graph input that was %s after planning',
    mutation => {
      const { vault, layout, target } = makeVault();
      const unrelated = write(vault, 'raw/unrelated.md', '# stable\n');
      const before = snapshotVaultGraph(layout);
      const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
      publishPlanned(vault, target, plan);
      if (mutation === 'modified') {
        fs.writeFileSync(unrelated, '# changed\n');
      } else {
        write(vault, 'cognition/concurrent.md', '# concurrent\n');
      }
      expectCode(
        () => validatePostWriteGraph(before, layout, target, plan.index),
        'POST_VALIDATION_FAILED',
      );
    },
  );

  test('fingerprints the graph path identity, not only symlink target bytes and inode', () => {
    const { vault, layout, target } = makeVault();
    const first = write(vault, 'shared/first.txt', '# same inode\n');
    const second = path.join(vault, 'shared/second.txt');
    fs.linkSync(first, second);
    const linkedNote = path.join(vault, 'raw/symlinked.md');
    fs.symlinkSync(first, linkedNote);
    const before = snapshotVaultGraph(layout);
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    publishPlanned(vault, target, plan);
    fs.unlinkSync(linkedNote);
    fs.symlinkSync(second, linkedNote);

    expectCode(
      () => validatePostWriteGraph(before, layout, target, plan.index),
      'POST_VALIDATION_FAILED',
    );
  });

  test('does not exempt an unchanged index from graph input regression checks', () => {
    const { vault, layout, target } = makeVault();
    write(vault, 'raw/backlink.md', '[[2026-07-26-orchid-choice]]\n');
    const readme = write(vault, 'practices/README.md', '# Existing index\n');
    const before = snapshotVaultGraph(layout);
    const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
    expect(plan.index.action).toBe('none');
    publishPlanned(vault, target, plan);
    fs.appendFileSync(readme, 'Concurrent plain text.\n');

    expectCode(
      () => validatePostWriteGraph(before, layout, target, plan.index),
      'POST_VALIDATION_FAILED',
    );
  });

  test.each(['chmod', 'touch', 'type', 'size'])(
    'rejects an unrelated graph input %s fingerprint change',
    mutation => {
      const { vault, layout, target } = makeVault();
      const note = write(vault, 'raw/metadata.md', '# stable bytes\n');
      const sameInode = path.join(vault, 'same-inode.txt');
      fs.linkSync(note, sameInode);
      const before = snapshotVaultGraph(layout);
      const plan = planIndexUpdate(layout, 'practices', target, 'Orchid Choice');
      publishPlanned(vault, target, plan);

      if (mutation === 'chmod') {
        const currentMode = fs.statSync(note).mode & 0o777;
        fs.chmodSync(note, currentMode ^ 0o100);
      } else if (mutation === 'touch') {
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(note, future, future);
      } else if (mutation === 'type') {
        fs.unlinkSync(note);
        fs.symlinkSync(sameInode, note);
      } else {
        fs.appendFileSync(note, 'larger\n');
      }

      expectCode(
        () => validatePostWriteGraph(before, layout, target, plan.index),
        'POST_VALIDATION_FAILED',
      );
    },
  );
});
