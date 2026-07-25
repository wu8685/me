import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VaultWriterError, type LogicalLayer } from '../bin/vault-write/contracts.ts';
import { resolveVaultLayout } from '../bin/vault-write/path-safety.ts';
import {
  loadLayerSchema,
  validateNoteMarkdown,
  type LayerSchemaContract,
} from '../bin/vault-write/schema.ts';

const pluginRoot = path.resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function makeVault(custom = false): string {
  const vault = tempDir('me-schema-');
  fs.mkdirSync(path.join(vault, '.me'));
  if (custom) {
    fs.writeFileSync(path.join(vault, '.me/config.yaml'), [
      'layers:',
      '  raw: knowledge/raw',
      '  practices: knowledge/practices',
      '  cognition: knowledge/cognition',
      '',
    ].join('\n'));
  }
  for (const layer of custom
    ? ['knowledge/raw', 'knowledge/practices', 'knowledge/cognition']
    : ['raw', 'practices', 'cognition']) {
    fs.mkdirSync(path.join(vault, layer), { recursive: true });
  }
  fs.copyFileSync(path.join(pluginRoot, 'templates/SCHEMA.md'), path.join(vault, 'SCHEMA.md'));
  return vault;
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

function contract(vault: string, layer: LogicalLayer): {
  layout: ReturnType<typeof resolveVaultLayout>;
  contract: LayerSchemaContract;
} {
  const layout = resolveVaultLayout(vault);
  return { layout, contract: loadLayerSchema(layout, pluginRoot, layer) };
}

function writeSource(vault: string, relative = 'raw/source-note.md'): void {
  const target = path.join(vault, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '# Source\n');
}

function note(
  layer: LogicalLayer,
  overrides: Record<string, string> = {},
  body = '# Body\n\nSubstantive text.\n',
): string {
  const fields: Record<string, string> = {
    title: '"A useful note"',
    created: '2026-07-26',
    tags: '[decision, careful-check]',
    type: layer === 'raw' ? 'article' : layer === 'practices' ? 'experiment' : 'insight',
    source: layer === 'raw' ? '"https://example.com/source"' : '"[[raw/source-note]]"',
    ...(layer === 'practices' ? { project: '""' } : {}),
    ...(layer === 'cognition' ? { confidence: 'medium' } : {}),
    ...overrides,
  };
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${body}`;
}

function validate(
  vault: string,
  layer: LogicalLayer,
  markdown: string,
  relative = 'decisions/2026-07-26-useful-note.md',
) {
  const loaded = contract(vault, layer);
  const target = path.join(loaded.layout.layers[layer], relative);
  return validateNoteMarkdown(loaded.layout, target, markdown, loaded.contract);
}

describe('me-schema-v1 profile and fingerprint loading', () => {
  test.each([
    ['raw', ['title', 'created', 'tags', 'type', 'source']],
    ['practices', ['title', 'created', 'tags', 'type', 'source', 'project']],
    ['cognition', ['title', 'created', 'tags', 'type', 'source', 'confidence']],
  ] as const)('loads exact schema and %s template', (layer, expectedFields) => {
    const vault = makeVault();
    const loaded = contract(vault, layer).contract;
    expect(loaded.profileId).toBe('me-schema-v1');
    expect(loaded.revision).toBe(1);
    expect([...loaded.fields.keys()]).toEqual(expectedFields);
    expect(loaded.templateFields).toEqual(expectedFields);
    expect(loaded.schemaDocumentSha256)
      .toBe('9894ec60c4c7e583a215938ec71186e8a12d24eaedc6dc96a42e2a4aa24480b5');
    expect(loaded.fields.get('project')).toEqual(layer === 'practices'
      ? { name: 'project', type: 'string', required: false, allowEmpty: true }
      : undefined);
    expect(loaded.fields.get('confidence')?.values).toEqual(
      layer === 'cognition' ? ['low', 'medium', 'high'] : undefined,
    );
  });

  test.each(['schema bytes', 'schema prose with same field claims'])('rejects changed %s', kind => {
    const vault = makeVault();
    fs.appendFileSync(path.join(vault, 'SCHEMA.md'), kind === 'schema bytes'
      ? '\n'
      : '\nThe fields and meanings above remain unchanged.\n');
    expectCode(() => contract(vault, 'raw'), 'UNSUPPORTED_SCHEMA');
  });

  test('rejects any template byte drift', () => {
    const copiedPlugin = tempDir('me-plugin-');
    fs.cpSync(path.join(pluginRoot, 'templates'), path.join(copiedPlugin, 'templates'), {
      recursive: true,
    });
    fs.appendFileSync(path.join(copiedPlugin, 'templates/raw-template.md'), '\n');
    const vault = makeVault();
    const layout = resolveVaultLayout(vault);
    expectCode(() => loadLayerSchema(layout, copiedPlugin, 'raw'), 'UNSUPPORTED_SCHEMA');
  });

  test.each([
    ['unsupported id', (profile: any) => { profile.id = 'future'; }],
    ['unsupported revision', (profile: any) => { profile.revision = 2; }],
    ['unknown root key', (profile: any) => { profile.future = true; }],
    ['unknown nested key', (profile: any) => { profile.core.title.future = true; }],
    ['unknown field type', (profile: any) => { profile.core.title.type = 'object'; }],
    ['malformed profile', (_profile: any, file: string) => fs.writeFileSync(file, '{')],
  ])('fails closed for %s', (_name, mutate) => {
    const copiedPlugin = tempDir('me-profile-');
    fs.cpSync(path.join(pluginRoot, 'templates'), path.join(copiedPlugin, 'templates'), {
      recursive: true,
    });
    const profilePath = path.join(copiedPlugin, 'templates/schema-profiles/me-schema-v1.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    mutate(profile, profilePath);
    if (_name !== 'malformed profile') {
      fs.writeFileSync(profilePath, JSON.stringify(profile));
    }
    const vault = makeVault();
    expectCode(
      () => loadLayerSchema(resolveVaultLayout(vault), copiedPlugin, 'raw'),
      'UNSUPPORTED_SCHEMA',
    );
  });
});

describe('frontmatter and layer contracts', () => {
  test.each(['raw', 'practices', 'cognition'] as const)('accepts a valid %s note', layer => {
    const vault = makeVault();
    writeSource(vault);
    const result = validate(vault, layer, note(layer));
    expect(result.stem).toBe('2026-07-26-useful-note');
    expect(result.title).toBe('A useful note');
    expect(result.created).toBe('2026-07-26');
    expect(result.tags).toEqual(['decision', 'careful-check']);
    expect(result.type).toBe(layer === 'raw' ? 'article' : layer === 'practices' ? 'experiment' : 'insight');
    expect(result.markdown).toBe(note(layer));
  });

  test.each([
    ['unknown key', note('raw', { status: 'draft' })],
    ['duplicate key', note('raw').replace('title: ', 'title: "First"\ntitle: ')],
    ['missing key', note('raw').replace(/^source:.*\n/m, '')],
    ['deprecated key', note('raw', { date_created: '2026-07-26' })],
    ['YAML alias', note('raw', { title: '*shared' })],
    ['YAML tag', note('raw', { title: '!unsafe value' })],
    ['stray YAML single quote', note('raw', { title: "'bad'quote'" })],
    ['decoded NUL in title', note('raw', { title: '"bad\\u0000title"' })],
    ['decoded newline in title', note('raw', { title: '"bad\\nline"' })],
    ['decoded C1 control in title', note('raw', { title: '"bad\\u0085title"' })],
    ['decoded Unicode line separator in title', note('raw', { title: '"bad\\u2028title"' })],
    ['multiline object', note('raw', { title: '|\n  text' })],
    ['mapping', note('raw', { title: '{ nested: value }' })],
    ['boolean as string', note('raw', { title: 'true' })],
    ['number as string', note('raw', { title: '123' })],
    ['invalid date', note('raw', { created: '2026-02-30' })],
    ['wrong filename date', note('raw', { created: '2026-07-25' })],
    ['tags scalar', note('raw', { tags: 'decision' })],
    ['tags non-string', note('raw', { tags: '[decision, true]' })],
    ['decoded control in tags', note('raw', { tags: '["decision", "bad\\u0001tag"]' })],
    ['duplicate tags', note('raw', { tags: '[decision, decision]' })],
    ['invalid tag', note('raw', { tags: '[Decision]' })],
    ['wrong layer type', note('raw', { type: 'insight' })],
    ['raw source non-http', note('raw', { source: '"ftp://example.com/a"' })],
    ['empty title', note('raw', { title: '""' })],
    ['whitespace-only title', note('raw', { title: '"   "' })],
    ['empty body', note('raw', {}, ' \n')],
    ['frontmatter offset', `\n${note('raw')}`],
    ['second frontmatter', `${note('raw')}\n---\ntitle: second\n---\n`],
  ])('rejects %s', (_name, markdown) => {
    const vault = makeVault();
    expectCode(() => validate(vault, 'raw', markdown), 'INVALID_NOTE');
  });

  test('accepts quoted strings, inline string lists and optional empty string', () => {
    const vault = makeVault();
    writeSource(vault);
    expect(validate(vault, 'practices', note('practices', {
      title: "'It''s valid'",
      tags: '["one", \'two-tag\']',
      project: "'project''s-name'",
    })).tags).toEqual(['one', 'two-tag']);
  });

  test.each([
    ['raw source', 'raw', { source: '"https://example.com/bad\\u0000path"' }],
    ['practices source', 'practices', { source: '"[[raw/source\\n-note]]"' }],
    ['optional project', 'practices', { project: '"bad\\u0001project"' }],
  ] as const)('rejects decoded control in %s', (_name, layer, overrides) => {
    const vault = makeVault();
    writeSource(vault);
    expectCode(() => validate(vault, layer, note(layer, overrides)), 'INVALID_NOTE');
  });

  test.each([
    ['empty', '""'],
    ['basename-only', '"[[source-note]]"'],
    ['alias', '"[[raw/source-note|alias]]"'],
    ['fragment', '"[[raw/source-note#part]]"'],
    ['suffix', '"[[raw/source-note.md]]"'],
    ['absolute', '"[[/raw/source-note]]"'],
    ['traversal', '"[[raw/../source-note]]"'],
    ['missing', '"[[raw/missing]]"'],
  ])('rejects practices source: %s', (_name, source) => {
    const vault = makeVault();
    writeSource(vault);
    expectCode(() => validate(vault, 'practices', note('practices', { source })), 'INVALID_NOTE');
  });

  test('rejects an escaping source symlink', () => {
    const vault = makeVault();
    const outside = tempDir('me-source-outside-');
    fs.writeFileSync(path.join(outside, 'source.md'), '# Outside\n');
    fs.symlinkSync(path.join(outside, 'source.md'), path.join(vault, 'raw/escape.md'));
    expectCode(
      () => validate(vault, 'practices', note('practices', { source: '"[[raw/escape]]"' })),
      'INVALID_NOTE',
    );
  });

  test('rejects cognition confidence outside the enum', () => {
    const vault = makeVault();
    writeSource(vault);
    expectCode(
      () => validate(vault, 'cognition', note('cognition', { confidence: 'certain' })),
      'INVALID_NOTE',
    );
  });
});

describe('Markdown destination grammar', () => {
  function markdownWith(destination: string, image = false): string {
    return note('raw', {}, `# Body\n\n${image ? '!' : ''}[label](${destination})\n`);
  }

  test.each([
    ['remote HTTP', 'https://example.com/a(b)', false],
    ['remote HTTPS angle', '<https://example.com/a b>', false],
    ['remote query and fragment', 'https://example.com/a?q=1#part', false],
    ['fragment', '#heading', false],
    ['local link', '../sources/note.md', false],
    ['local image', '../sources/image.png', true],
    ['escaped parentheses', '../sources/a\\(b\\).md', false],
  ])('accepts %s', (_name, destination, image) => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, 'raw/sources'));
    for (const file of ['note.md', 'image.png', 'a(b).md']) {
      fs.writeFileSync(path.join(vault, 'raw/sources', file), 'bytes');
    }
    expect(validate(vault, 'raw', markdownWith(destination, image))).toBeTruthy();
  });

  test.each([
    ['reference definition', '[id]: https://example.com'],
    ['full reference', '[label][id]'],
    ['collapsed reference', '[label][]'],
    ['HTML', '<a href="https://example.com">x</a>'],
    ['HTML comment', '<!-- hidden -->'],
    ['unclosed HTML comment', '<!-- hidden'],
    ['HTML declaration', '<!DOCTYPE html>'],
    ['autolink', '<https://example.com>'],
    ['Obsidian embed', '![[raw/source-note]]'],
    ['remote image', '![alt](https://example.com/image.png)'],
    ['file scheme', '[x](file:///tmp/a)'],
    ['data scheme', '[x](data:text/plain,x)'],
    ['javascript scheme', '[x](javascript:alert(1))'],
    ['unknown scheme', '[x](gemini://example.com)'],
    ['protocol relative', '[x](//example.com/a)'],
    ['absolute', '[x](/tmp/a)'],
    ['UNC', '[x](\\\\server\\share)'],
    ['drive', '[x](C:\\temp\\a)'],
    ['query', '[x](../sources/note.md?q=1)'],
    ['empty', '[x]()'],
    ['control', '[x](../sources/no\u0001te.md)'],
    ['unbalanced', '[x](../sources/a(b.md)'],
    ['optional title', '[x](../sources/note.md "title")'],
  ])('rejects %s', (_name, body) => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, 'raw/sources'));
    fs.writeFileSync(path.join(vault, 'raw/sources/note.md'), '# Existing\n');
    expectCode(() => validate(vault, 'raw', note('raw', {}, `# Body\n\n${body}\n`)), 'INVALID_NOTE');
  });

  test.each([
    '../sources/note.md',
    '%2e%2e/sources/note.md',
    '%252e%252e/sources/note.md',
  ])('accepts contained raw/decoded traversal %s', destination => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, 'raw/sources'));
    fs.writeFileSync(path.join(vault, 'raw/sources/note.md'), '# Existing\n');
    expect(validate(vault, 'raw', markdownWith(destination))).toBeTruthy();
  });

  test.each([
    '../../../../outside.md',
    '%2e%2e/%2e%2e/%2e%2e/outside.md',
    '%252e%252e/%252e%252e/%252e%252e/outside.md',
  ])('rejects escaping raw/decoded traversal %s', destination => {
    const vault = makeVault();
    expectCode(() => validate(vault, 'raw', markdownWith(destination)), 'INVALID_NOTE');
  });

  test.each([
    'a%2fb',
    'a%252fb',
    'a%5cb',
    'a%255cb',
    'bad%zz',
    '%252525252e%252525252e/sources/note.md',
  ])('rejects encoded separator, invalid percent or decode depth: %s', destination => {
    const vault = makeVault();
    expectCode(() => validate(vault, 'raw', markdownWith(destination)), 'INVALID_NOTE');
  });

  test('ignores invalid-looking destinations in fenced and inline code', () => {
    const vault = makeVault();
    const body = [
      '# Body',
      '',
      '`[x](file:///tmp/a)`',
      '',
      '````md',
      '<script>bad()</script>',
      '![x](https://example.com/a.png)',
      '```',
      '````',
      '',
    ].join('\n');
    expect(validate(vault, 'raw', note('raw', {}, body))).toBeTruthy();
  });

  test.each([
    ['longer closer', '`[x](file:///tmp/a)``'],
    ['shorter closer', '``[x](file:///tmp/a)`'],
    ['closer embedded in a longer run', '`[x](file:///tmp/a)```'],
  ])('does not mask inline code with a %s', (_name, body) => {
    const vault = makeVault();
    expectCode(() => validate(vault, 'raw', note('raw', {}, `# Body\n\n${body}\n`)), 'INVALID_NOTE');
  });

  test('masks multiple inline code spans only with exact delimiter runs', () => {
    const vault = makeVault();
    const body = [
      '# Body',
      '',
      '`[x](file:///tmp/one)` and ``![x](https://example.com/two.png)``',
      '',
    ].join('\n');
    expect(validate(vault, 'raw', note('raw', {}, body))).toBeTruthy();
  });

  test('accepts nested and escaped inline link labels', () => {
    const vault = makeVault();
    fs.mkdirSync(path.join(vault, 'raw/sources'));
    fs.writeFileSync(path.join(vault, 'raw/sources/image.png'), 'bytes');
    const body = [
      '# Body',
      '',
      '![a [nested] label](../sources/image.png)',
      '[an \\[escaped\\] label](https://example.com)',
      '',
    ].join('\n');
    expect(validate(vault, 'raw', note('raw', {}, body))).toBeTruthy();
  });

  test.each([
    ['nested local-bypass label', '[a [nested] label](file:///tmp/a)'],
    ['nested image-bypass label', '![a [nested] label](https://example.com/a.png)'],
    ['full nested reference', '[a [nested] label][target]'],
    ['collapsed nested reference', '[a [nested] label][]'],
    ['shortcut nested reference definition', '[a [nested] label]\n\n[a [nested] label]: https://example.com'],
  ])('rejects %s', (_name, body) => {
    const vault = makeVault();
    expectCode(() => validate(vault, 'raw', note('raw', {}, `# Body\n\n${body}\n`)), 'INVALID_NOTE');
  });

  test('keeps code masking aligned after non-BMP Unicode', () => {
    const vault = makeVault();
    const body = [
      '# Body',
      '',
      '😀😀😀 `<script>bad()</script> [x](file:///tmp/a)`',
      '',
    ].join('\n');
    expect(validate(vault, 'raw', note('raw', {}, body))).toBeTruthy();
  });

  test('does not let Unicode-shifted code masking hide following raw HTML', () => {
    const vault = makeVault();
    expectCode(
      () => validate(vault, 'raw', note('raw', {}, '# Body\n\n😀 `safe` <script>bad()</script>\n')),
      'INVALID_NOTE',
    );
  });

  test.each([false, true])('resolves nested local links from planned note parent (custom=%s)', custom => {
    const vault = makeVault(custom);
    const rawRoot = custom ? 'knowledge/raw' : 'raw';
    fs.mkdirSync(path.join(vault, rawRoot, 'sources'));
    fs.writeFileSync(path.join(vault, rawRoot, 'sources/note.md'), '# Existing\n');
    expect(validate(vault, 'raw', markdownWith('../sources/note.md'))).toBeTruthy();
    expectCode(
      () => validate(vault, 'raw', markdownWith('../../../outside.md')),
      'INVALID_NOTE',
    );
  });
});
