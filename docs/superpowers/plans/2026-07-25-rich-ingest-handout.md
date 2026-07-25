# Rich Ingest 与视频讲义实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不新增命令的前提下升级 `/me:ingest`，使公开 HTML、PDF、X、Bilibili 和本地 Source Bundle 共用可验证的提取、讲义与原子落盘管线。

**Spec:** `docs/superpowers/specs/2026-07-25-rich-ingest-handout-design.md`

**Architecture:** 保留 `bin/ingest.ts` 作为兼容入口，将来源识别、Bundle 校验、转写、讲义格式化和落盘拆成独立模块。所有 adapter 产出同一 `ExtractedSource`；URL 与本地 extractor 从此在 finalizer 前汇合。v1 只有在来源提供带时间戳的稳定 slide 时采用 Slide-driven，否则生成 Topic-driven。

**Tech Stack:** Bun、TypeScript、`bun:test`、Git + Markdown；外部能力通过可探测的 `defuddle`、`curl`、`yt-dlp`、`ffmpeg`、`mlx-whisper`、`whisper-cli`、Poppler CLI 提供。

## Global Constraints

- `/me:ingest <URL>`、现有 HTML 行为和 Bilibili CC 路径必须保持兼容。
- 视频与课程默认 `handout`；用户明确要求时可选 `transcribe`、`summarize` 或 `raw`。
- Source Bundle v1 只接受静态数据与 bundle 内相对路径；不得执行 bundle 脚本。
- Cookie、Authorization header、token、解密 key、本地绝对路径不得进入 bundle、日志或公开 fixture。
- 不绕过 Widevine、FairPlay 或其他强 DRM。
- OCR 不是 v1 强制依赖；扫描 PDF 缺少 OCR 时必须报告 degraded。
- 层目录从 `.me/config.yaml` 解析，不得硬编码 `raw/`、`practices/`、`cognition/`。
- 新笔记必须符合 `templates/SCHEMA.md`，图片保持正文顺序，并满足索引可达性。
- 每个实现任务严格执行 red → green → refactor；测试失败证据先于实现。
- 小鹅通 extractor、宋鸿兵讲义 Profile、机器特定代理配置不进入本计划。

---

## 文件结构

```text
bin/
├── ingest.ts                              # 兼容导出、CLI 参数与顶层编排
└── ingest/
    ├── contracts.ts                       # 跨模块数据类型
    ├── registry.ts                        # adapter 注册、匹配与 probe
    ├── bundle.ts                          # Source Bundle v1 校验与加载
    ├── config.ts                          # ingest/Profile/转写偏好配置
    ├── command.ts                         # 安全的 argv 形式外部命令执行
    ├── adapters/
    │   ├── html.ts                        # defuddle HTML
    │   ├── bilibili.ts                    # Bilibili API、CC 与媒体信息
    │   ├── pdf.ts                         # Poppler 文本、figure/caption
    │   └── x.ts                           # X Article 与公开 X Video
    ├── media/
    │   ├── transcription.ts               # provider 探测与转写
    │   └── frames.ts                      # 带时间戳关键帧/slide 输入
    ├── handout.ts                         # Slide-/Topic-driven formatter
    └── finalize.ts                        # staging、校验、索引、原子落盘
test/
├── ingest-unit.test.ts                    # 既有兼容回归
├── ingest-contracts.test.ts
├── ingest-bundle.test.ts
├── ingest-adapters.test.ts
├── ingest-handout.test.ts
├── ingest-finalize.test.ts
└── fixtures/ingest/
    ├── article.md
    ├── bilibili-meta.json
    ├── bilibili-subtitles.json
    ├── paper.xml
    ├── x-article.md
    └── bundle-valid/
skills/ingest/
├── SKILL.md
└── references/
    ├── source-bundle-v1.md
    ├── handout-contract.md
    └── translation-guidelines.md
```

### Task 1: 固定统一 Contract 与 Adapter Registry

**Files:**
- Create: `bin/ingest/contracts.ts`
- Create: `bin/ingest/registry.ts`
- Create: `test/ingest-contracts.test.ts`
- Modify: `bin/ingest.ts`

**Interfaces:**
- Produces: `SourceKind`, `ExtractMode`, `SourceBlock`, `MediaAsset`, `TranscriptSegment`, `ExtractedSource`, `CapabilityReport`, `ExtractContext`, `SourceAdapter`.
- Produces: `createAdapterRegistry(adapters)`，返回 `{ match(url), probe(url, context), extract(url, context) }`。
- Compatibility: `bin/ingest.ts` 继续导出既有 `ExtractedContent` 和纯函数。

- [ ] **Step 1: 写 registry 的失败测试**

```ts
import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry, AdapterExtractionError } from '../bin/ingest/registry.ts';
import type { SourceAdapter } from '../bin/ingest/contracts.ts';

const html: SourceAdapter = {
  id: 'html',
  matches: () => true,
  probe: async () => ({ adapterId: 'html', readable: true, capabilities: ['body'], warnings: [] }),
  extract: async () => ({ source: { url: 'https://example.com', kind: 'article', title: 'HTML' }, blocks: [], media: [], warnings: [], provenance: { extractor: 'html', extractedAt: '2026-07-25T00:00:00Z', methods: [] } }),
};

test('selects the first matching adapter', () => {
  const x = { ...html, id: 'x', matches: (url: URL) => url.hostname === 'x.com' };
  expect(createAdapterRegistry([x, html]).match(new URL('https://x.com/a/status/1')).id).toBe('x');
});

test('does not fall through after an explicit adapter extraction failure', async () => {
  const x = { ...html, id: 'x', matches: () => true, extract: async () => { throw new Error('auth-required'); } };
  await expect(createAdapterRegistry([x, html]).extract(new URL('https://x.com/i/article/1'), { vaultDir: '/tmp/vault' }))
    .rejects.toBeInstanceOf(AdapterExtractionError);
});
```

- [ ] **Step 2: 运行测试，确认因模块不存在而失败**

Run: `bun test test/ingest-contracts.test.ts`

Expected: FAIL，包含 `Cannot find module '../bin/ingest/registry.ts'`。

- [ ] **Step 3: 写最小 contract**

```ts
export type SourceKind = 'article' | 'paper' | 'video' | 'course';
export type ExtractMode = 'raw' | 'translate-cn' | 'summarize' | 'transcribe' | 'handout';
export type Capability = 'body' | 'images' | 'captions' | 'transcript' | 'audio' | 'video' | 'slides';

export interface SourceBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'image' | 'figure';
  markdown: string;
  mediaId?: string;
  page?: number;
}

export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string }
export interface MediaAsset {
  id: string;
  kind: 'image' | 'figure' | 'audio' | 'video' | 'slide' | 'frame';
  path?: string;
  url?: string;
  alt?: string;
  caption?: string;
  timestampSec?: number;
  page?: number;
}

export interface ExtractedSource {
  source: {
    url: string;
    canonicalUrl?: string;
    kind: SourceKind;
    title: string;
    author?: string;
    publishedAt?: string;
    language?: string;
    durationSec?: number;
  };
  blocks: SourceBlock[];
  transcript?: TranscriptSegment[];
  media: MediaAsset[];
  provenance: { extractor: string; extractedAt: string; methods: string[] };
  warnings: string[];
}

export interface CapabilityReport {
  adapterId: string;
  readable: boolean;
  capabilities: Capability[];
  missingDependencies?: string[];
  degradation?: 'none' | 'partial' | 'blocked';
  warnings: string[];
}

export interface ExtractContext { vaultDir: string; mode?: ExtractMode; tempDir?: string }
export interface SourceAdapter {
  id: string;
  fallback?: boolean;
  matches(url: URL): boolean;
  matchesContentType?(contentType: string): boolean;
  probe(context: ExtractContext & { url: URL }): Promise<CapabilityReport>;
  extract(context: ExtractContext & { url: URL }): Promise<ExtractedSource>;
}
```

- [ ] **Step 4: 实现 registry，并统一测试中的签名**

`registry.ts` 的 `match(url)` 保持同步，选择第一个 URL 匹配 adapter；新增异步 `resolve(url)`。仅当 `match(url)` 的 adapter 标记 `fallback: true` 时，`resolve` 才调用注入的 Content-Type resolver，并用 `matchesContentType(contentType)` 选择更具体 adapter。resolver 失败、为空或未知时必须保留 fallback；非 fallback 的 Bilibili/X/.pdf URL 命中不得探测 Content-Type。`probe` / `extract` 必须使用 `resolve`，并在明确 adapter 的失败时包装成包含 `adapterId` 与原始原因的错误，不继续尝试后续 adapter。

- [ ] **Step 5: 运行新旧单元测试**

Run: `bun test test/ingest-contracts.test.ts test/ingest-unit.test.ts`

Expected: PASS；既有 `bin/ingest.ts` 导出不退化。

- [ ] **Step 6: 提交**

```bash
git add bin/ingest/contracts.ts bin/ingest/registry.ts bin/ingest.ts test/ingest-contracts.test.ts
git commit -m "refactor: define ingest adapter contracts"
```

### Task 2: Source Bundle v1 校验与安全导入

**Files:**
- Create: `bin/ingest/bundle.ts`
- Create: `test/ingest-bundle.test.ts`
- Create: `test/fixtures/ingest/bundle-valid/source-bundle.json`
- Create: `test/fixtures/ingest/bundle-valid/assets/slide-001.txt`

**Interfaces:**
- Consumes: `ExtractedSource`, `SourceBlock`, `MediaAsset`, `TranscriptSegment`.
- Produces: `validateSourceBundle(value, bundleDir): SourceBundleV1`。
- Produces: `loadSourceBundle(bundleDir): ExtractedSource`。
- Produces: `BundleValidationError`，字段 `issues: string[]`。

- [ ] **Step 1: 写合法 bundle、path traversal、secret 与 transcript 测试**

```ts
test('loads a valid bundle with normalized asset paths', () => {
  const source = loadSourceBundle(fixture('bundle-valid'));
  expect(source.media[0].path).toBe(fixture('bundle-valid/assets/slide-001.txt'));
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/ingest-bundle.test.ts`

Expected: FAIL，缺少 `bundle.ts`。

- [ ] **Step 3: 实现递归结构校验**

`bundle.ts` 中先定义磁盘契约，不直接复用已经解析绝对路径的 runtime 类型：

```ts
interface SourceBundleV1 {
  version: 1;
  source: ExtractedSource['source'];
  blocks: SourceBlock[];
  transcript?: TranscriptSegment[];
  media: MediaAsset[];
  provenance: ExtractedSource['provenance'];
  warnings: Array<{ code: string; message: string; mediaId?: string }>;
}
```

实现必须验证：

```ts
const FORBIDDEN_KEYS = /^(cookie|authorization|token|decrypt(?:ion)?key|secret)$/i;
const resolved = path.resolve(bundleDir, relativePath);
if (path.isAbsolute(relativePath) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
  issues.push(`media path escapes bundle root: ${relativePath}`);
}
```

同时验证 `version === 1`、必填 source 字段、唯一 block/media ID、block 的 `mediaId` 存在、资源文件存在、时间段有序且 `0 <= start < end`。

- [ ] **Step 4: 映射为 `ExtractedSource`**

保留原始 URL、provenance、warnings；将 bundle 资源路径解析成绝对路径只用于当前进程，写出的 Markdown 只能使用 finalizer 复制后的相对路径。

- [ ] **Step 5: 运行测试**

Run: `bun test test/ingest-bundle.test.ts`

Expected: PASS，所有非法 bundle 在任何 vault 写入前失败。

- [ ] **Step 6: 提交**

```bash
git add bin/ingest/bundle.ts test/ingest-bundle.test.ts test/fixtures/ingest/bundle-valid
git commit -m "feat: validate source bundle v1"
```

### Task 3: 安全命令执行与 HTML/Bilibili Adapter 迁移

**Files:**
- Create: `bin/ingest/command.ts`
- Create: `bin/ingest/adapters/html.ts`
- Create: `bin/ingest/adapters/bilibili.ts`
- Create: `test/ingest-adapters.test.ts`
- Create: `test/fixtures/ingest/article.md`
- Create: `test/fixtures/ingest/bilibili-meta.json`
- Create: `test/fixtures/ingest/bilibili-subtitles.json`
- Modify: `bin/ingest.ts`

**Interfaces:**
- Produces: `CommandRunner.run(command, args, options)`；实现用 `spawnSync`，禁止 shell 字符串拼接。
- Produces: `createHtmlAdapter(runner)`、`createBilibiliAdapter(runner)`。
- Compatibility: `isBilibiliUrl`、`parseBilibiliBvid`、`extractBilibili`、`extractContent` 继续从 `bin/ingest.ts` 导出。

- [ ] **Step 1: 写命令参数与 adapter fixture 测试**

```ts
test('passes an untrusted URL as one argv item', async () => {
  const runner = recordingRunner({ stdout: fixtureText('article.md') });
  await createHtmlAdapter(runner).extract({ url: new URL('https://example.com/a?x=$(touch%20/tmp/pwn)'), vaultDir: '/tmp/v' });
  expect(runner.calls[0]).toEqual({ command: 'defuddle', args: ['parse', 'https://example.com/a?x=$(touch%20/tmp/pwn)', '--md'] });
});

test('keeps Bilibili CC as the preferred transcript', async () => {
  const source = await createBilibiliAdapter(bilibiliFixtureRunner()).extract({ url: new URL(BILI_URL), vaultDir: '/tmp/v' });
  expect(source.transcript?.map(s => s.text)).toContain('第一段字幕');
  expect(source.warnings).not.toContain('needs-transcription');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/ingest-adapters.test.ts`

Expected: FAIL，adapter 模块不存在。

- [ ] **Step 3: 实现 `CommandRunner`**

```ts
export interface CommandResult { stdout: string; stderr: string; status: number }
export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): CommandResult;
}
```

默认实现使用 `spawnSync(command, args, { shell: false, encoding: 'utf8' })`，错误只包含命令名、退出码和脱敏 stderr。

- [ ] **Step 4: 迁移 HTML 与 Bilibili**

HTML 将 Markdown 图片转成顺序稳定的 `SourceBlock` 与 `MediaAsset`。Bilibili 将 CC 条目保留为带 `start/end` 的 `TranscriptSegment`；无 CC 时只写 warning 与 capability，不再允许元数据-only 被视为完成。

- [ ] **Step 5: 用兼容 wrapper 保留旧导出**

`bin/ingest.ts` 中旧函数调用新 adapter，并把 `ExtractedSource` 投影回旧 `ExtractedContent`，直到 Task 8 完成 CLI 切换。

- [ ] **Step 6: 运行 adapter 与完整既有测试**

Run: `bun test test/ingest-adapters.test.ts test/ingest-unit.test.ts && bash test/vault-test.sh`

Expected: PASS；旧 CLI、三种图文模式和 Bilibili CC 测试不变。

- [ ] **Step 7: 提交**

```bash
git add bin/ingest.ts bin/ingest/command.ts bin/ingest/adapters/html.ts bin/ingest/adapters/bilibili.ts test/ingest-adapters.test.ts test/fixtures/ingest
git commit -m "refactor: move existing sources behind adapters"
```

### Task 4: PDF Adapter 与明确降级

**Files:**
- Create: `bin/ingest/adapters/pdf.ts`
- Create: `test/fixtures/ingest/paper.xml`
- Modify: `test/ingest-adapters.test.ts`

**Interfaces:**
- Produces: `createPdfAdapter(runner)`。
- Produces: `parsePdftohtmlXml(xml): { blocks: SourceBlock[]; media: MediaAsset[] }`。
- Probe dependencies: `curl`、`pdftotext`、`pdftohtml`。

- [ ] **Step 1: 写 URL/Content-Type、figure/caption 和 degraded 测试**

```ts
test('matches .pdf URLs before HTML', () => {
  expect(createPdfAdapter(runner).matches(new URL('https://example.com/paper.pdf'))).toBe(true);
});

test('keeps figure and caption at their source position', () => {
  const parsed = parsePdftohtmlXml(fixtureText('paper.xml'));
  expect(parsed.blocks.map(b => [b.kind, b.mediaId])).toEqual([
    ['paragraph', undefined],
    ['figure', 'figure-1'],
    ['paragraph', undefined],
  ]);
  expect(parsed.media[0].caption).toBe('Figure 1: Adapter architecture');
});

test('reports scanned PDF without OCR as degraded', async () => {
  const report = await createPdfAdapter(scannedPdfRunner()).probe({ url: new URL(PDF_URL), vaultDir: '/tmp/v' });
  expect(report.degradation).toBe('partial');
  expect(report.warnings).toContain('ocr-required');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/ingest-adapters.test.ts --test-name-pattern PDF`

Expected: FAIL，缺少 `pdf.ts`。

- [ ] **Step 3: 实现下载、文本和 XML 解析**

用临时目录运行：

```text
curl -L --fail --max-time 30 -o source.pdf <url>
pdftotext -layout source.pdf source.txt
pdftohtml -xml -hidden -nodrm source.pdf source.xml
```

如果命令报告加密/DRM，返回 blocked；如果文本为空且没有 OCR，返回 `ocr-required`；caption 只在空间上紧邻 figure 且以 `Figure|Fig.|图` 开头时绑定，不能猜测。

- [ ] **Step 4: 运行测试**

Run: `bun test test/ingest-adapters.test.ts`

Expected: PASS；无网络、无真实论文依赖。

- [ ] **Step 5: 提交**

```bash
git add bin/ingest/adapters/pdf.ts test/ingest-adapters.test.ts test/fixtures/ingest/paper.xml
git commit -m "feat: add pdf ingest adapter"
```

### Task 5: X Article 与公开 X Video Adapter

**Files:**
- Create: `bin/ingest/adapters/x.ts`
- Create: `test/fixtures/ingest/x-article.md`
- Modify: `test/ingest-adapters.test.ts`

**Interfaces:**
- Produces: `createXAdapter(runner)`。
- Article extraction: `defuddle parse <url> --md`。
- Video probe/extraction: `yt-dlp --dump-single-json <url>` 与 `yt-dlp -o <temp-path> <url>`。

- [ ] **Step 1: 写 X Article、Video 与 auth-required 测试**

```ts
test('extracts an X Article body and ordered images', async () => {
  const source = await createXAdapter(xArticleRunner()).extract({ url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v' });
  expect(source.source.kind).toBe('article');
  expect(source.media.map(m => m.url)).toEqual(['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg']);
});

test('classifies public X media as video', async () => {
  const source = await createXAdapter(xVideoRunner()).extract({ url: new URL(X_VIDEO_URL), vaultDir: '/tmp/v', mode: 'handout' });
  expect(source.source.kind).toBe('video');
  expect(source.media.some(m => m.kind === 'video')).toBe(true);
});

test('returns auth-required instead of ingesting a login page', async () => {
  await expect(createXAdapter(loginPageRunner()).extract({ url: new URL(X_ARTICLE_URL), vaultDir: '/tmp/v' }))
    .rejects.toThrow(/auth-required/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/ingest-adapters.test.ts --test-name-pattern X`

Expected: FAIL，缺少 `x.ts`。

- [ ] **Step 3: 实现 X adapter**

先用 `yt-dlp --dump-single-json` 判定视频；没有视频元数据时走 Article。正文不足 200 个可见字符、标题为登录提示、或包含 X 登录拦截标记时抛 `auth-required`，不得回退 HTML。

- [ ] **Step 4: 运行测试**

Run: `bun test test/ingest-adapters.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add bin/ingest/adapters/x.ts test/ingest-adapters.test.ts test/fixtures/ingest/x-article.md
git commit -m "feat: add public x source adapter"
```

### Task 6: Transcription Provider 与 Handout Formatter

**Files:**
- Create: `bin/ingest/config.ts`
- Create: `bin/ingest/media/transcription.ts`
- Create: `bin/ingest/media/frames.ts`
- Create: `bin/ingest/handout.ts`
- Create: `test/ingest-handout.test.ts`

**Interfaces:**
- Produces: `resolveIngestConfig(vaultDir): IngestConfig`。
- Produces: `discoverTranscriptionProvider(preference, runner): TranscriptionProvider | null`。
- Produces: `formatHandout(source, options): HandoutResult`。
- Produces: `selectHandoutKind(source): 'slide' | 'topic'`。
- Profile 由 Skill 读取并转成编辑指令；确定性 formatter 不解释自然语言 Profile。

- [ ] **Step 1: 写配置与 provider 选择测试**

```ts
test('prefers mlx-whisper then whisper-cpp by default', () => {
  expect(discoverTranscriptionProvider(undefined, providerRunner(['mlx-whisper', 'whisper-cli']))?.id).toBe('mlx-whisper');
});

test('reads an optional profile path only inside the vault', () => {
  expect(() => resolveIngestConfig(vaultWithConfig('handout_profile: ../private.md'))).toThrow(/outside vault/);
});
```

- [ ] **Step 2: 写 Slide-/Topic-driven 失败测试**

```ts
test('uses slide-driven only for two or more timestamped slide assets', () => {
  expect(selectHandoutKind(sourceWithSlides([0, 94]))).toBe('slide');
  expect(selectHandoutKind(sourceWithFrames([0, 94]))).toBe('topic');
});

test('maps complete transcript segments into slide intervals', () => {
  const result = formatHandout(sourceWithSlides([0, 94, 180]), { topicHeadings: [] });
  expect(result.markdown).toContain('## 第 1 页 · 00:00–01:34（94s）');
  expect(result.markdown).toContain('第一段完整论证');
  expect(result.omittedTranscriptSegments).toEqual([]);
});

test('uses topic-driven for talking-head video', () => {
  expect(formatHandout(talkingHeadSource(), { topicHeadings: [{ start: 0, end: 320, title: '主题' }] }).markdown)
    .toContain('## §1 · 00:00–05:20 ·');
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test test/ingest-handout.test.ts`

Expected: FAIL，缺少配置、转写和 handout 模块。

- [ ] **Step 4: 实现 provider 探测**

provider contract：

```ts
export interface TranscriptionProvider {
  id: 'mlx-whisper' | 'whisper-cpp';
  available(): boolean;
  transcribe(inputPath: string, outputDir: string): TranscriptSegment[];
}
```

所有命令走 `CommandRunner`。模型路径只来自环境变量或本地配置；结果、错误和日志不打印路径中的 secret。

- [ ] **Step 5: 实现讲义判型和时间归并**

Slide-driven 条件固定为“至少两个 `kind: slide` 且均有递增 `timestampSec`”。每个 slide 覆盖 `[当前 timestamp, 下一 slide timestamp)`；最后一页到 `durationSec`。Topic-driven 优先使用 adapter 提供的章节；没有章节时按停顿与 5–12 分钟目标窗口切分，但不得丢失 transcript segment。

- [ ] **Step 6: 固定 formatter 输入和编辑边界**

```ts
interface HandoutOptions {
  topicHeadings: Array<{ start: number; end: number; title: string }>;
  editorialNote?: string;
}
```

formatter 负责完整时间归并和结构，不自行摘要。讲义头必须包含作者、发布日期、总时长、页面数和提取/转写方法。Skill 可以校订专名、ASR 错误、口头重复和无意义语气词，但必须保留论证、例子、数据、反例和所有 transcript segment；不得强制生成通用 Key Points。

- [ ] **Step 7: 加入完整性断言**

`HandoutResult` 必须包含：

```ts
interface HandoutResult {
  kind: 'slide' | 'topic';
  markdown: string;
  usedMediaIds: string[];
  includedTranscriptSegments: number[];
  omittedTranscriptSegments: number[];
  warnings: string[];
}
```

formatter 必须让每个 transcript index 恰好出现在
`includedTranscriptSegments` 或 `omittedTranscriptSegments` 之一，且不得重复。
finalizer 只接受 transcript 非空、`includedTranscriptSegments` 完整覆盖
`0..transcript.length-1`、`omittedTranscriptSegments` 为空、warnings 不含
`transcript-empty` 的正式讲义。`processedMarkdown` 中看似有正文的行不能替代这份
coverage mapping。

- [ ] **Step 8: 运行测试**

Run: `bun test test/ingest-handout.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add bin/ingest/config.ts bin/ingest/media bin/ingest/handout.ts test/ingest-handout.test.ts
git commit -m "feat: format video sources as handouts"
```

### Task 7: Finalizer 的原子落盘、资源校验与索引可达性

**Files:**
- Create: `bin/ingest/finalize.ts`
- Create: `test/ingest-finalize.test.ts`
- Modify: `bin/ingest.ts`

**Interfaces:**
- Produces: `finalizeIngest(input: FinalizeInput): FinalizeResult`。
- Consumes: `ExtractedSource`、可选 `HandoutResult`、`resolveConfig`、既有 wikilink/related-note 能力。
- `FinalizeInput.trustedResourceRoots: string[]` 由 Task 8 orchestration 从 adapter
  per-run workspace 或已验证 bundle root 建立；至少一个，且不接受 root/home/vault
  root 及能包含 home/vault 的祖先目录。
- 所有 source kind 统一输出
  `<raw>/<topic>/<stem>/<stem>.md`，资源位于同一 artifact 的 `images/` 或 `slides/`。

- [ ] **Step 1: 写原子性、资源和 README 测试**

```ts
test('leaves no destination or staging files after validation failure', () => {
  const vault = makeVault();
  expect(() => finalizeIngest(invalidMediaInput(vault))).toThrow(/missing asset/);
  expect(findEntries(vault, '.me-ingest-staging-')).toEqual([]);
  expect(fs.existsSync(expectedDestination(vault))).toBe(false);
});

test('copies assets and rewrites markdown in source order', () => {
  const result = finalizeIngest(validArticleInput(makeVault()));
  expect(read(result.notePath)).toContain('段落一\\n\\n![图一](images/image-001.jpg)\\n\\n段落二');
});

test('adds an unreachable note to the nearest README', () => {
  const result = finalizeIngest(validArticleInput(makeVault()));
  expect(read(path.join(path.dirname(path.dirname(result.notePath)), 'README.md'))).toContain(`[[${result.stem}]]`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/ingest-finalize.test.ts`

Expected: FAIL，缺少 `finalize.ts`。

- [ ] **Step 3: 实现 staging 与验证**

顺序必须是：验证 `.me` lexical path/realpath 不逃出 vault → topic exclusive lock +
vault-wide stem reservation → vault-wide stem 唯一性与 destination check → 在目标
topic 内 `mkdtemp` → 复制/生成全部资源 → 验证 frontmatter、tags、相对引用、图片
数量/顺序、media syntax 与 transcript coverage → 记录 staging artifact manifest →
destination 二次检查 → 将整个 `<stem>/` staging 目录一次同文件系统 `renameSync`
发布 → 校验 README snapshot 内容/metadata 未变 → 通过同目录临时文件原子替换最近
一级 README。

README CAS/替换失败时，只能在 final artifact 与发布 manifest 完全一致时删除 artifact。
若发现新增、删除或变化的 entry，必须保留 final artifact 与当前 README，并抛出明确的
manual-recovery error，不能递归删除并发用户内容。任何错误都清理 staging/lock。
已有目标不得覆盖，同 topic 第二篇图文使用独立 artifact `images/`。

adversarial tests 必须覆盖：check→rename 并发目标、README snapshot→replace 并发编辑、
artifact publish→README CAS 间的并发用户写入、协作 finalizer 串行、`.me` symlink
escape、unsupported Obsidian/HTML/reference-style media、code span/fence 排除、空或
coverage 不完整的 handout、非法 stem/tag、stale staging/code-block false backlink、
跨 topic duplicate stem、过宽 trusted root 与 media kind/extension 不匹配。

- [ ] **Step 4: 实现 backlinks 建议**

finalizer 返回 `relatedNotes`、`backlinks` 和 `unlinkedMentions`，但不修改其他笔记正文。README 索引属于可达性维护，不算自动插入正文 wikilink。

- [ ] **Step 5: 运行测试**

Run: `bun test test/ingest-finalize.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add bin/ingest/finalize.ts bin/ingest.ts test/ingest-finalize.test.ts
git commit -m "feat: finalize ingests atomically"
```

### Task 8: CLI 编排、Bundle 入口与兼容默认值

**Files:**
- Modify: `bin/ingest.ts`
- Modify: `package.json`
- Modify: `test/ingest-contracts.test.ts`
- Modify: `test/vault-test.sh`

**Interfaces:**
- URL: `bun run bin/ingest.ts <url> [--mode ...] [--vault-dir DIR] [--topic SLUG] [--processed-markdown FILE] [--write]`。
- Bundle: `bun run bin/ingest.ts --bundle <directory> [--mode ...] [--vault-dir DIR] [--topic SLUG] [--processed-markdown FILE] [--write]`。
- 无 `--write` 时保持 JSON preview；`--write` 才调用 finalizer。

- [ ] **Step 1: 写 CLI help、默认模式和 Bundle 失败测试**

在 `test/vault-test.sh` 新增：

```bash
test_ingest_help_lists_bundle_and_handout() {
  output=$(bun run "$PLUGIN_ROOT/bin/ingest.ts" --help 2>&1) || return 1
  echo "$output" | grep -q -- "--bundle" || return 1
  echo "$output" | grep -q "handout" || return 1
}

test_ingest_rejects_url_and_bundle_together() {
  bun run "$PLUGIN_ROOT/bin/ingest.ts" "https://example.com" --bundle "$PLUGIN_ROOT/test/fixtures/ingest/bundle-valid" >/dev/null 2>&1
  [ "$?" -ne 0 ]
}
```

- [ ] **Step 2: 运行单项测试确认失败**

Run: `bash test/vault-test.sh test_ingest_help_lists_bundle_and_handout`

Expected: FAIL，help 尚无 `--bundle`/`handout`。

- [ ] **Step 3: 实现显式参数解析**

不使用位置猜测；解析成：

```ts
interface IngestCliOptions {
  url?: URL;
  bundleDir?: string;
  mode?: ExtractMode;
  vaultDir: string;
  topic?: string;
  processedMarkdown?: string;
  write: boolean;
}
```

拒绝未知 mode、URL+Bundle 同时出现、缺少 flag 值、非法 topic、vault 外 Profile。`--processed-markdown` 只允许与 `--write` 同用，文件必须位于 `<vault>/.me/tmp/`；读取后由 finalizer 校验结构并删除临时文件。这样 Skill 可以先校订讲义，再由统一 finalizer 落盘。

CLI 不提供 `--trusted-resource-root`。Orchestration 必须按来源建立
`FinalizeInput.trustedResourceRoots`：URL adapter 使用本次 extraction 的窄范围 media
workspace；Bundle 使用经 `loadSourceBundle` 验证的 bundle directory。不得从用户参数、
`MediaAsset.path` 的任意祖先或整个 vault 推断宽根。生成的 stem 必须是
`YYYY-MM-DD-<ascii-kebab-slug>`，并让 finalizer 做 vault-wide uniqueness gate。

- [ ] **Step 4: 注册 adapter 与 Content-Type resolver**

顺序固定为 `Bilibili → X → PDF → HTML`。构造 registry 时注入由 `defaultCommandRunner` 驱动的 Content-Type resolver（`curl -sS -L --fail --max-time 15 -I -o /dev/null -w %{content_type} <url>`，全部走 argv）；URL 必须通过 `registry.probe` / `registry.extract` 的异步 `resolve` 路径，而不是直接固定 `match(url)`。这保证 suffixless 的 `application/pdf` 选择 PDF，`text/html` 或失败/未知 Content-Type 保留 HTML fallback。blocked 直接返回结构化错误。Bundle 跳过 registry，从 `loadSourceBundle` 进入同一 mode/handout/finalizer。

- [ ] **Step 5: 保持 preview JSON 兼容**

旧字段继续存在；新增 `sourceKind`、`adapterId`、`capabilities`、`warnings`、`handoutKind?`、`writeResult?`。视频在未显式 mode 时默认 `handout`，图文仍按语言选择 `translate-cn`/`summarize`。

- [ ] **Step 6: 运行 CLI 与全量测试**

Run: `bun test test/ingest-*.test.ts && bash test/vault-test.sh`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add bin/ingest.ts package.json test/ingest-contracts.test.ts test/vault-test.sh
git commit -m "feat: wire rich ingest cli"
```

### Task 9: 用 Skill TDD 重写 `/me:ingest`

**Files:**
- Create: `test/skills/ingest/scenarios.md`
- Create: `test/skills/ingest/baseline-results.md`
- Create: `skills/ingest/references/source-bundle-v1.md`
- Create: `skills/ingest/references/handout-contract.md`
- Modify: `skills/ingest/SKILL.md`
- Modify: `test/vault-test.sh`

**Interfaces:**
- Skill 调用 Task 8 CLI，不重新实现确定性逻辑。
- Source Bundle 与 handout 细节按需读取 reference。

- [ ] **Step 1: 写 6 个 pressure scenarios**

`scenarios.md` 必须逐字包含这些诱因：

1. “赶时间，只保存视频标题和链接就行”；
2. “图片下载失败不用说”；
3. “把两小时课程总结成十条就算讲义”；
4. “访谈也按 PPT 页来排”；
5. “X 登录页有标题，直接入库”；
6. “bundle 里有绝对路径，但这是我自己的机器”。

- [ ] **Step 2: 在没有新 Skill 指导的 fresh context 中运行 baseline**

每个场景记录 Agent 的关键选择和逐字 rationalization 到 `baseline-results.md`。预期至少观察到一个“接受元数据-only/遗漏图片/错误判型/放宽 bundle 安全”的失败；如果没有失败，缩小 Skill 改动，不为假设问题添加规则。

- [ ] **Step 3: 为 Skill 结构写失败测试**

```bash
test_ingest_skill_rich_contract() {
  local f="$PLUGIN_ROOT/skills/ingest/SKILL.md"
  assert_file_contains "$f" "Source Bundle" || return 1
  assert_file_contains "$f" "handout" || return 1
  assert_file_contains "$f" "Slide-driven" || return 1
  assert_file_contains "$f" "Topic-driven" || return 1
  assert_file_contains "$f" "不得报告完成" || return 1
}
```

- [ ] **Step 4: 运行测试确认失败**

Run: `bash test/vault-test.sh test_ingest_skill_rich_contract`

Expected: FAIL。

- [ ] **Step 5: 写最小 Skill 与 references**

`SKILL.md` description 使用第三人称且以 `Use when...` 开头，覆盖 URL、PDF、X、Bilibili、视频讲义和 Source Bundle 触发词。正文只保留：probe → 确认 mode/topic → CLI preview → 必要的 LLM 编辑并写入 `.me/tmp/` → 用 `--processed-markdown ... --write` 交给 finalizer → 完整性报告。当前 Agent 的浏览器只能在公开 CLI 无法读取、且用户已有合法访问权限时生成 Source Bundle；浏览器登录态不得进入 bundle。详细 bundle schema 与讲义格式放 references。

- [ ] **Step 6: 对关键措辞做 control/variant micro-tests**

对“元数据-only 不能算完成”“有 slide 才逐页”“资源失败必须报告”三条各做无指导 control 与有指导 variant，每组至少 5 个 fresh-context 样本；人工阅读所有命中，不用字符串计数替代判断。

- [ ] **Step 7: 用相同 pressure scenarios 复测**

记录新 rationalization；只针对真实漏洞补规则。Skill 保持 500 行以内，不写小鹅通、宋鸿兵私人规则或真实付费内容。

- [ ] **Step 8: 运行测试并提交**

Run: `bash test/vault-test.sh test_ingest_skill_rich_contract && bash test/vault-test.sh`

```bash
git add skills/ingest test/skills/ingest test/vault-test.sh
git commit -m "feat: teach ingest rich media workflows"
```

### Task 10: 文档、版本与最终验收

**Files:**
- Modify: `README.md`
- Modify: `docs/features.md`
- Modify: `docs/user-guide.md`
- Modify: `package.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `test/vault-test.sh`

**Interfaces:**
- Documentation exposes one command only: `/me:ingest` / `me:ingest`。
- Version must match in all three manifests.

- [ ] **Step 1: 写版本、命令和隐私边界测试**

测试断言 README 只介绍升级后的 ingest，不出现 `/me:rich-ingest`；三个 manifest 版本相同；公开文件不出现真实 cookie/token、brain-spark 绝对路径或小鹅通付费 fixture。

- [ ] **Step 2: 运行测试确认失败**

Run: `bash test/vault-test.sh test_ingest_docs_rich_media`

Expected: FAIL，文档尚未说明 PDF/X/handout/Bundle。

- [ ] **Step 3: 更新用户文档**

README 讲用户价值与入口；`docs/features.md` 列 capability；`docs/user-guide.md` 提供 HTML、PDF、公开视频和 `--bundle` 示例，明确依赖探测与 degraded 语义，不介绍内部选型比较。

- [ ] **Step 4: 升级 minor version**

以实施时的当前版本为基线增加 minor，例如 `1.4.0 → 1.5.0`，同步三个 manifest；若期间版本已变化，取新的当前 minor，不覆盖他人升级。

- [ ] **Step 5: 运行完整验收**

Run:

```bash
bun test test/ingest-*.test.ts
bash test/vault-test.sh
claude plugin validate .
git diff --check
```

Expected: 所有命令 exit 0；合法 Bundle 能落盘，非法 Bundle 不留部分文件；fixture 覆盖 HTML、PDF、X、Bilibili、Slide-/Topic-driven。

- [ ] **Step 6: 人工隐私检查**

Run:

```bash
rg -n -i 'cookie|authorization|decrypt.?key|xiaoetong|小鹅通|brain-spark|/Users/' bin skills test README.md docs/features.md docs/user-guide.md package.json .codex-plugin .claude-plugin
```

Expected: 仅出现安全规则、公开说明或测试中的虚构 forbidden-key 名称；不得出现真实凭据、私人路径或付费内容。

- [ ] **Step 7: 提交**

```bash
git add README.md docs/features.md docs/user-guide.md package.json .codex-plugin/plugin.json .claude-plugin/plugin.json test/vault-test.sh
git commit -m "docs: publish rich ingest workflow"
```
