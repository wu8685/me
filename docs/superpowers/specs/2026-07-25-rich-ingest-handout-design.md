# Rich Ingest 与视频讲义设计

**状态：** Approved
**日期：** 2026-07-25
**所属项目：** ME

## 1. 背景

现有 `/me:ingest` 已支持：

- 通用 HTML，经 `defuddle` 提取；
- Bilibili 元数据与 CC 字幕；
- 无字幕时通过 `yt-dlp + whisper.cpp` 转写；
- `raw / translate-cn / summarize` 三种模式；
- 图片下载、frontmatter、auto-link、related notes。

实际使用已经扩展到 X Article、X Video、论文 PDF、课程视频和带幻灯片的长视频。继续在 `bin/ingest.ts` 中增加平台条件分支会让提取、媒体处理、知识库落盘和用户交互互相耦合。

本设计把 `/me:ingest` 升级为单一入口下的模块化富媒体管线。它不新增 `rich-ingest` 命令。

## 2. 目标

1. 保持 `/me:ingest <URL>` 的兼容入口。
2. 用稳定的 Source Adapter contract 隔离来源差异。
3. 支持公开 HTML、PDF、X Article、X Video 与 Bilibili。
4. 为本地或第三方 extractor 定义 Source Bundle 导入契约。
5. 视频默认生成讲义，优先采用 Slide-driven 结构。
6. 保留正文插图、figure、caption、时间戳和来源顺序。
7. 将 schema、资源校验、索引可达性和落盘统一到 finalizer。
8. 保持 ME 可公开发布，不携带账号凭据或私人 Profile。

## 3. 非目标

- 不把小鹅通登录、cookie、付费内容或 DRM 处理写进公开 ME。
- 不绕过 Widevine、FairPlay 或其他强 DRM。
- 不内嵌浏览器、账号系统或云端 ASR 服务。
- 不创建动态第三方插件 ABI；v1 只定义静态 Source Bundle 数据契约。
- 不改变 raw / practices / cognition 三层语义。
- 不自动把新结论提升到 cognition。

## 4. 所有权边界

| 内容 | 所有者 |
| --- | --- |
| Adapter contract、公开来源 adapter | ME |
| Source Bundle contract | ME |
| 通用 handout 编排规则 | ME |
| schema、资源验证、索引、backlinks | ME |
| 小鹅通 extractor | 用户本地 vault |
| 宋鸿兵核心课讲义 Profile | 用户本地 vault |
| cookie、token、临时 key、付费原始媒体 | 用户本机，不进 Git |

公开 ME 只消费经过验证的 Source Bundle，不执行 vault 中配置的任意外部命令。

## 5. 架构

```text
/me:ingest URL
      |
      v
Adapter Registry
  |- HTML
  |- PDF
  |- X Article / X Video
  `- Bilibili
      |
      v
ExtractedSource / Source Bundle
      |
      +--> raw / translate-cn / summarize
      `--> transcribe / handout
      |
      v
Finalizer
  |- frontmatter
  |- asset localization
  |- atomic write
  |- reachability
  `- backlinks suggestions
```

建议的代码边界：

```text
bin/
├── ingest.ts                    # 兼容 CLI 与顶层编排
└── ingest/
    ├── contracts.ts
    ├── registry.ts
    ├── adapters/
    │   ├── html.ts
    │   ├── pdf.ts
    │   ├── x.ts
    │   └── bilibili.ts
    ├── media/
    │   ├── transcription.ts
    │   └── frames.ts
    ├── handout.ts
    └── finalize.ts
```

实际拆分可在实施计划中调整，但 adapter、handout 和 finalizer 必须保持独立 contract。

## 6. Source Adapter Contract

```ts
interface SourceAdapter {
  id: string
  fallback?: boolean
  matches(url: URL): boolean
  matchesContentType?(contentType: string): boolean
  probe(context: ExtractContext): Promise<CapabilityReport>
  extract(context: ExtractContext): Promise<ExtractedSource>
}
```

`matches(url)` 保持同步，用于 Bilibili、X、`.pdf` 等确定 URL 路由。通用 HTML adapter 标记为 `fallback: true`；只有先命中 fallback 时，registry 才可通过注入的、基于 argv `curl -I` 的 resolver 读取最终响应 `Content-Type`，并用 `matchesContentType()` 选择更具体的 adapter。Content-Type 查询失败、为空或未知时，必须保留 fallback，不能把错误页或未知内容猜成 PDF。

`probe()` 不产生正式 vault 文件。它只报告：

- 是否匹配；
- 是否能读取来源；
- 需要哪些本地依赖；
- 能否取得正文、字幕、音频、视频和页面图；
- 可生成完整正文、完整讲义，还是只能降级。

Adapter 优先级：

1. Bilibili；
2. X；
3. PDF；
4. 通用 HTML。

明确 adapter 匹配但提取失败时，不得静默回退到通用 HTML 并把登录页或错误页当正文。

## 7. Source Bundle Contract

本地 extractor 通过目录 bundle 与 ME 交换，不通过动态代码加载：

```text
bundle/
├── source-bundle.json
└── assets/
    ├── audio.m4a
    ├── slide-001.jpg
    └── ...
```

核心结构：

```ts
interface SourceBundleV1 {
  version: 1
  source: {
    url: string
    canonicalUrl?: string
    kind: "article" | "paper" | "video" | "course"
    title: string
    author?: string
    publishedAt?: string
    language?: string
    durationSec?: number
  }
  blocks: SourceBlock[]
  transcript?: TranscriptSegment[]
  media: MediaAsset[]
  provenance: {
    extractor: string
    extractedAt: string
    methods: string[]
  }
  warnings: BundleWarning[]
}
```

约束：

- bundle 内路径必须是相对路径，解析后不得逃出 bundle 根目录；
- `source.url` 必须保留原始来源；
- transcript segment 必须满足 `0 <= start < end`，整体按时间排序；
- media ID 必须唯一；
- 正文与 media 通过 ID 关联，不能依赖模糊文件名匹配；
- JSON 中禁止 cookie、Authorization header、token、解密 key 和本地绝对路径；
- ME 导入前完整验证 bundle；失败时不写 vault。

CLI 增加：

```text
me ingest --bundle <directory>
```

具体二进制入口仍由现有插件调用方式决定。

## 8. 来源行为

### 8.1 HTML

- 延续 `defuddle`；
- 保持标题、正文顺序和 Markdown；
- 盘点正文容器内图片；
- 排除头像、站点图标、推荐卡片和广告；
- 下载失败时保留精确 warning。

### 8.2 PDF / 论文

- 判断 URL 或响应是否为 PDF；
- 提取正文、页码、figure 和 caption；
- figure 在正文中按出现位置引用；
- 只得到摘要页、扫描图片或不完整正文时报告 degraded，不得宣称完成；
- OCR 不作为 v1 强制依赖，但 capability report 必须说明扫描 PDF 需要 OCR。

### 8.3 X Article

- 优先无登录公开读取；
- 提取标题、作者、发布日期、正文和正文图片；
- 公共读取失败时返回 `auth-required` 或 `extraction-failed`；
- Skill 层可使用当前 Agent 的浏览器能力生成 Source Bundle，但 `bin/` 不依赖浏览器。

### 8.4 X Video

- 获取可公开访问的音视频与元数据；
- 默认进入 `handout`；
- 无字幕时使用本地 transcription provider；
- 无法取得画面但音频完整时生成无图 Topic-driven 讲义，并声明限制。

### 8.5 Bilibili

- 保留 CC 字幕优先策略；
- 无字幕时优先探测 `mlx-whisper`，再探测 `whisper.cpp`；
- 公共实现不写死用户模型路径；
- 代理与 Range 下载的机器特定问题留在本地 Profile/Memory；
- 公开视频默认进入 `handout`，用户可显式选择 `transcribe` 或 `summarize`。

## 9. 模式

保留：

- `raw`
- `translate-cn`
- `summarize`
- `transcribe`

新增：

- `handout`

自动模式：

| 来源 | 默认模式 |
| --- | --- |
| 英文图文 | `translate-cn` |
| 中文图文 | `summarize` |
| 视频/课程 | `handout` |

用户明确要求逐字稿、原文或纯摘要时，显式选择覆盖自动模式。

## 10. Handout

### 10.1 判型

- 连续稳定页面、PPT 或屏幕演示：Slide-driven；
- 访谈、讲师出镜、短视频、无稳定页面：Topic-driven。

### 10.2 Slide-driven

通用结构：

```markdown
# 标题（讲义）

> 主讲人｜发布日期｜总时长｜页面数
>
> 提取、转写、抽帧、时间归并和校订方法说明。

---

## 第 1 页 · 00:00–01:34（94s）

![说明性 alt](slides/slide-001.jpg)

与本页对应的完整讲解正文。
```

要求：

- 页面与讲解按时间归并；
- 保留完整论证、例子、数据与反例；
- 只清理口头重复、明显 ASR 错误和无意义语气词；
- 不强制增加通用 Key Points；
- 专名校订不得改变说话者原意。

### 10.3 Topic-driven

```markdown
## §1 · 00:00–05:20 · 主题

对应时间段的编辑后正文。
```

只保留信息型关键帧；片头、Logo、转场和重复讲师头像不作为正文图片。

### 10.4 本地 Profile

公共 handout 定义结构，不携带特定讲者品牌。Skill 可读取 vault 配置指向的本地 Profile，对通用结构增加私人编辑偏好。

建议配置：

```yaml
ingest:
  default_video_mode: handout
  handout_profile: .me/profiles/hongxueyuan-handout.md
  transcription_preference:
    - mlx-whisper
    - whisper-cpp
```

缺少 Profile 时使用通用结构。Profile 路径必须位于 vault 内。

## 11. 落盘

所有 ingest 产物使用相同的 note-specific artifact directory。图文与讲义只在资源子目录名称上不同：

```text
<raw>/<topic>/YYYY-MM-DD-<slug>/
├── YYYY-MM-DD-<slug>.md
├── images/                         # 图文
└── slides/                         # 讲义
```

主 Markdown 保持唯一文件名，避免多个 `handout.md` 造成 Obsidian wikilink 歧义。
`stem` 必须严格符合 `YYYY-MM-DD-<ascii-kebab-slug>`；在配置的三层目录中
全局唯一，禁止依赖目录路径消除 Obsidian wikilink 歧义。

Finalizer 必须：

1. 由 orchestration 显式传入至少一个窄范围 `trustedResourceRoots`；不得信任 `/`、
   home、vault root 或能包含 home/vault 的祖先目录，也不把该能力暴露成用户可传的
   CLI 参数；
2. 在创建/open lock 前验证 `.me`、`ingest-reservations` 与具体 lock path 的 lexical
   path/realpath 均位于 vault；任一祖先 symlink 指向外部时 fail closed，不得在外部
   创建 lock；
3. 在 topic 目录取得 exclusive lock，并在 vault 内取得 stem reservation；二者覆盖
   uniqueness/destination check、artifact publish 与 README compare-and-swap。同 topic
   协作 finalizer 必须串行，不同 topic 的同 stem 也不能并发发布；
4. 在目标 vault/topic 内创建 staging 目录，生成 Markdown 与全部资源；
5. 验证 frontmatter、English kebab-case tags、资源类型/扩展、相对引用、图片数量与
   顺序、transcript 完整性；不支持的 Obsidian/HTML/reference-style media syntax
   必须显式拒绝；media/backlink scanner 必须忽略 inline code，并按 opening marker
   字符与长度正确处理 fenced code；
6. 记录 staging artifact manifest，再将整个 `<stem>/` staging 目录以一次同文件系统
   `rename` 发布；已有同名目标
   或 vault 其他位置的同 stem 均 fail closed；
7. 检查索引可达性；扫描排除 staging，并忽略 frontmatter/fenced/inline code 中的
   wikilink；
8. 若没有有效入链，则以 snapshot 内容和 metadata 做 README compare-and-swap，
   再通过同目录 temp rename 替换；
9. README 变化或替换失败时，只有 artifact 与发布 manifest 完全一致才可删除；发现
   新增或变化的用户内容时保留 artifact 与当前 README，并报 manual recovery；
10. 返回 related notes/backlinks/unlinked mentions 建议，不修改其他笔记正文。

topic exclusive lock、vault-wide stem reservation 与二次 destination check 保证所有
遵守 contract 的 finalizer 不会互相覆盖。外部 hostile writer 若绕过 lock，portable Node/Bun 文件 API 无
`renameat2(RENAME_NOREPLACE)` 等价物，仍存在最后一次检查到 rename 之间的不可消除
竞态；实现必须在检测到已出现的目标时保留对方数据并失败。

## 12. 失败与降级

以下情况不得报告完成：

- 视频只有元数据，没有字幕或转写；
- 明确 adapter 返回登录页、错误页或空正文；
- PDF 只得到摘要页却被当作全文；
- bundle path 越界或包含禁止字段；
- transcript 时间范围无效；
- 视频/课程 transcript 为空、含 `transcript-empty`、included mapping 未覆盖全部
  transcript index、或 omitted mapping 非空；metadata-only `processedMarkdown`
  不能替代 coverage mapping；
- 图片数量不一致且未报告；
- Task 6 formatter 未让每个合法 transcript segment 恰好进入 included/omitted 之一。

允许的部分成功：

- 主体文字完整，少量图片下载失败；
- 音频完整，但视频画面不可得，生成无图 Topic-driven 讲义；
- figure 可识别但 caption 缺失，明确列出缺失。

部分成功必须在结果和讲义方法说明中列出缺失数量与原因。

## 13. 安全

- shell 调用使用参数数组或严格转义，禁止拼接不可信 URL/路径；
- temporary directory 必须在结束时清理；
- 日志不输出 cookie、token、header、key 或敏感 query；
- bundle import 不执行任何 bundle 内脚本；
- resource root 只由 adapter/bundle orchestration 建立，且必须窄于 vault/home/root；
- source media 的 lexical path 与 realpath 都必须落在同一个 trusted root 内；
- 不支持的 media embed syntax 必须拒绝，不能因 parser 未识别而漏过 traversal/absolute 引用；
- media 与 backlink scanner 必须忽略 inline/fenced code；fence closing marker 必须与
  opening marker 同字符且长度不短于 opening；backtick fence 的 info string 含
  backtick 时不是合法 opening，不能借此隐藏真实 media；
- custom frontmatter 的 tags 只接受显式 quoted YAML strings；boolean、number、mapping
  即使字面符合 kebab regex 也必须拒绝；closing `]` 后除已 trim 的 EOF 外不得有任何
  token；
- 浏览器登录态只存在于 Agent 会话，不写入 ME 产物；
- 公开 fixture 不包含真实付费内容。

## 14. 测试

实施遵循 TDD。

### 14.1 Tool tests

- adapter routing；
- capability report；
- Source Bundle schema 与路径安全；
- transcript 时间排序与覆盖；
- HTML 图片顺序；
- PDF figure/caption；
- X Article/X Video fixture；
- Bilibili CC 与无字幕分支；
- transcription provider 选择；
- Slide-driven 与 Topic-driven formatter；
- atomic write 与失败清理；
- destination check→rename 与 README snapshot→replace 并发注入；
- 同 topic 多篇图文资源隔离、vault-wide stem 唯一性；
- trusted resource root、media extension 与 unsupported media syntax；
- README 可达性；
- secret redaction。

外部来源使用 fixture 或 mock server，默认测试不依赖网络、账号或真实付费材料。

### 14.2 Skill tests

在修改 Skill 前先运行无新指导的 baseline 场景，记录 Agent 是否：

- 把视频只保存成元数据；
- 遗漏正文插图；
- 把长课压成摘要；
- 将无 PPT 视频错误套成逐页结构；
- 把浏览器登录页当正文；
- 静默忽略资源失败。

随后用相同场景验证 Skill 能正确选择 adapter、模式、降级和完成标准。

## 15. 兼容性

- `/me:ingest <URL>` 保持可用；
- 现有三种图文模式保持语义；
- Bilibili CC 路径不得退化；
- 现有 frontmatter 不增加禁止字段；
- 现有测试必须保持通过；
- 新配置字段均为可选，旧 vault 不修改即可继续运行。

## 16. 验收标准

1. 一个公开 HTML URL 能按现有行为入库。
2. 一个带正文图片的 X Article 能完整本地化图片。
3. 一个公开 PDF 能保存正文、figure 与 caption。
4. 一个公开视频能默认生成 Topic-driven 或 Slide-driven 讲义。
5. 一个无 CC 的 Bilibili 视频能选择可用本地转写 provider。
6. 一个合法 Source Bundle 能生成与 URL adapter 等价的最终产物。
7. 非法或含敏感字段的 bundle 被拒绝，vault 无部分文件。
8. 新笔记满足 schema、资源完整性与索引可达性。
9. 小鹅通等私人 extractor 可以仅依赖 Source Bundle contract 接入，无需修改 ME 核心。

## 17. 后续依赖

Source Bundle v1 实现并稳定后，用户本地 vault 再单独设计和实现：

- 小鹅通授权 extractor；
- 宋鸿兵核心课讲义 Profile；
- 本机 transcription 与代理偏好。

这些内容不进入公开 ME Git 历史。
