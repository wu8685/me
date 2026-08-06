# ME 功能

> Claude Code / Codex 插件 — 让任何工作空间拥有知识管理能力

## 定位

ME 是一个 **Claude Code / Codex 插件**，将任何 Git 仓库变成一个三层知识飞轮系统。它不是 Obsidian 的替代品，而是命令行侧的知识管理运行时 — 负责摄入、链接、搜索、维护等自动化操作，让你专注于阅读和思考。

**核心价值：** 摄入研究 → 记录实践 → 提炼认知，零基础设施（Git + Markdown + Claude Code / Codex）。

**目标用户：** 使用 Claude Code 或 Codex 的个人知识工作者，希望在终端中高效管理 Markdown 笔记库。

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│  用户接口层：Claude Code slash commands / Codex skills    │
├──────────────────────────────────────────────────────────┤
│  脚本层：bin/*.ts (Bun runtime)                           │
│  ┌─────────┬──────────┬──────────┬────────┬───────────┐  │
│  │ingest.ts│autolinks │search.ts │move.ts │ events.ts │  │
│  │         │.ts       │          │        │           │  │
│  └─────────┴──────────┴──────────┴────────┴───────────┘  │
├──────────────────────────────────────────────────────────┤
│  存储层：Git + Markdown + YAML frontmatter                │
│  ┌────────────┬──────────────┬─────────────────┐         │
│  │ raw/       │ practices/   │ cognition/      │         │
│  │ (摄入素材)  │ (实践验证)    │ (认知提炼)       │         │
│  └────────────┴──────────────┴─────────────────┘         │
├──────────────────────────────────────────────────────────┤
│  配置层：.me/config.yaml (层级目录映射)                     │
├──────────────────────────────────────────────────────────┤
│  本机运行时：~/.me/runtime/vault-<path-hash>/             │
└──────────────────────────────────────────────────────────┘
```

## Skills 列表

Claude Code 侧表现为 `/me:*` slash command；Codex 侧安装插件后表现为 `me:*` Codex skill，可通过 `/skills` 选择，或在 prompt 中显式写 `$me:setup` 这类 skill mention。

| 功能 | Claude Code | Codex skill | 输入 | 输出 |
|------|-------------|-------------|------|------|
| 初始化工作空间 | `/me:setup` | `me:setup` | - | 三层目录 + 配置文件 |
| 摄入外部材料 | `/me:ingest <source>` | `me:ingest` | URL 或 Source Bundle | 结构化 Markdown 笔记与本地素材 |
| 生成决策简报 | `/me:decision-brief <问题>` | `me:decision-brief` | 待决问题、约束与相关证据 | 建议、选项比较、验证实验与复盘条件 |
| 多维搜索笔记 | `/me:search` | `me:search` | 查询条件 | 匹配笔记列表 |
| 链接健康检查 | `/me:checklinks` | `me:checklinks` | - | 断链/孤儿/死结报告 |
| 自动添加 WikiLink | `/me:autolinks` | `me:autolinks` | - | 批量更新笔记链接 |
| 发现反向链接 | `/me:backlinks <note>` | `me:backlinks` | 笔记名称 | 反向链接列表 |
| 移动笔记 | `/me:move <file> <dest>` | `me:move` | 源路径, 目标路径 | 更新所有引用 |
| 诊断 ME 状态 | `/me:doctor` | `me:doctor` | - | 只读的版本化 JSON 诊断报告 + 结论摘要 |
| 回顾历史会话 | `/me:recall <query>` | `me:recall` | 查询词、时间范围、workspace | 只读的会话证据包：任务级匹配 + 来源 |

## 底层模块

| 模块 | 文件 | 功能 |
|------|------|------|
| Events | `bin/events.ts` | JSONL 事件日志 — append/query，支持 UUID 关联 |
| Wikilink Graph | `bin/wikilink-graph.ts` | 无依赖的链接图引擎 |
| Vault Write | `bin/vault-write.ts` | 通用笔记写入的预览、校验、索引维护与恢复报告 |
| Runtime | `bin/runtime.ts` | 查询本机 runtime、准备受控 inbox |
| Doctor | `bin/doctor.ts` | 只读诊断：vault/plugin 根、版本、config/schema、managed sections、runtime 恢复 |
| Recall | `bin/recall.ts` | 只读会话证据检索：Codex 本地 session 适配器 + 确定性脱敏 + 证据包 |

## 可同步 vault 与本机运行时

ME 允许 vault 通过 Obsidian Sync、Git 或其他文件同步工具跨设备使用。
`.me/config.yaml` 和 Profile 属于可迁移配置；锁、事务 journal、staging、
inbox 与恢复材料属于本机状态，默认存放在
`~/.me/runtime/vault-<path-hash>/`。

每台机器可用 `ME_RUNTIME_ROOT` 指定另一个 host-local base。该值不会进入
vault 配置。runtime base 必须与 vault 位于同一 filesystem；不满足时操作
会停止，并要求把 `ME_RUNTIME_ROOT` 指到同盘目录，不会自动回退或跨盘
copy。只读命令和 preview 不创建 runtime；需要检查恢复材料时，
`bin/runtime.ts path` 才显式返回绝对路径。

## /me:setup - 初始化工作空间

**功能：** 在当前工作空间创建三层知识目录结构。

**输出：**
```
.me/config.yaml     # 层级目录映射
raw/                 # Raw 层
practices/           # Practices 层
cognition/           # Cognition 层
SCHEMA.md            # Frontmatter schema
CLAUDE.md            # Agent 导航契约
.gitignore           # Obsidian 配置
```

**自动检测现有目录：**

如果工作空间已有类似 `调研/`、`实践/` 等目录，会提示映射：
```
Detected existing directories:
  调研/ (suggested: raw layer)
  实践/ (suggested: practices layer)

Map these directories? (Press Enter for defaults)
```

## /me:ingest - 摄入文章、PDF 与公开视频

**功能：** 用一个入口把 HTML、PDF、X 文章或视频、Bilibili 视频，以及 Source Bundle 转换成可检索的 Markdown 笔记。正文图片、PDF 图表和视频讲义素材会随笔记本地化；写入时以整篇材料为单位完成，避免留下半篇笔记或散落素材。

| Source Adapter | 适用材料 | 主要产物 |
| --- | --- | --- |
| HTML | 普通网页文章 | 正文、来源信息、正文图片 |
| PDF | 公开论文与报告（包括无 `.pdf` 后缀但响应类型为 PDF 的链接） | 分页正文、图表与图注 |
| X | 公开 X 文章、单条或多段视频 | 文章正文或带时间线的视频内容 |
| Bilibili | 公开视频 | 字幕/转写与视频讲义 |
| Source Bundle v1 | 已由授权工具导出的静态材料目录 | 经完整校验后的正文、transcript 与素材 |

**处理模式：**

- `translate-cn` - 英文文章翻译为中文（默认）
- `summarize` - 中文文章摘要
- `raw` - 保留原文内容
- `transcribe` - 按时间顺序保存完整转写
- `handout` - 生成讲义；有稳定时间戳页面时采用 Slide-driven，否则采用 Topic-driven，并保留完整 transcript

**能力与 degraded 语义：**

- 预览结果会报告 `adapterId`、`capabilities`、`degradation`、`warnings`，视频讲义另有
  `handoutKind`；PDF 还会报告 `completeness: complete | partial | unknown`。
- `warnings` 非空表示结果处于 degraded/partial 状态。调用者必须说明缺少的字幕、图片或媒体，不得把部分结果描述为完整。
- CLI 已实现的 `blocked` cases（X auth wall、encrypted/DRM PDF）不会写入笔记。
- 视频/课程无论选择哪种写入模式，都必须具有 transcript、实质正文或可发布媒体；
  只有标题、作者、时长等元数据时拒绝写入。
- 普通 HTML 错误页没有统一的 CLI auto-block；Agent 必须做 body completeness check，标题或错误提示不能当作可读正文。
- 只有返回 `writeResult` 才表示写入成功；校验或最终写入失败时不会保留部分 artifact。

**输出布局：**

```text
raw/<topic>/YYYY-MM-DD-slug/
├── YYYY-MM-DD-slug.md
├── images/                 # 有正文图片或 PDF 图表时
└── slides/                 # 有讲义页面时
```

**Frontmatter schema：**
```yaml
---
title: "文章标题"
created: 2026-04-06
tags: [ai-agents, llm]
type: article
source: "https://example.com/article"
---
```

**自动处理：**
- 语言检测（中文/英文）
- HTML / PDF / X / Bilibili 来源识别
- PDF 与视频依赖探测
- 视频 Slide-driven / Topic-driven 讲义选择
- Source Bundle v1 完整校验
- 图片、图表与讲义页面本地化
- Kebab-case 英文 slug
- 自动添加 WikiLink（基于 vault index）
- 相关笔记推荐（基于 tag + 关键词）

## /me:decision-brief - 决策简报（Decision Brief）

**功能：** 当问题涉及有后果的选择、时间或资源投入时，把“该选什么”整理成可检验、可复盘的建议，而不是只给一份利弊清单。

**输入：**

- 待决定的问题、负责人、时间范围和不可突破的约束
- 成功信号与可接受的最坏结果
- 当前 vault 中实际相关的 Cognition、Practices 与 Raw 笔记
- 必要时补充的最新事实

**输出：**

- 明确建议与置信度；证据不足时给出“暂不决策”
- 主要矛盾、至少两个可行选项及其机会成本
- 最强反方、最小验证实验、失效条件和复盘时间
- 实际影响建议的本地笔记与事实来源

默认只在对话中返回，不修改 vault。只有用户明确要求保存，而且存在实际参与判断的本地来源时，才把阶段性判断保存为 Practices 笔记；它不会直接进入 Cognition。

通用 `vault-write` 提供两个阶段：`preview` 先展示目标路径、索引动作和校验结果，不写文件；`write` 在同一请求通过校验后写入笔记并维护索引。调用方只有收到明确的 committed 结果才应报告保存成功；冲突、环境不支持或需要人工恢复时，应如实报告未写入或恢复指引。

## /me:checklinks - 链接健康检查

**功能：** 检查知识库链接健康状态。

**检测项：**
- **Broken Wikilinks** - 指向不存在笔记的链接
- **Orphaned Notes** - 没有任何笔记链接到的孤立笔记
- **Dead-End Notes** - 没有 outgoing links 的笔记

**模式：**
- **Obsidian CLI 模式** - 如果 Obsidian 运行中，使用官方 CLI（增强模式）
- **Native 模式** - 使用内置 `wikilink-graph.ts` 引擎（无依赖）

**输出示例：**
```
## Vault Link Health Report

### Broken Wikilinks (3)
- [[missing-note]] referenced from raw/article.md
- [[another-broken]] referenced from practices/pattern.md

### Orphaned Notes (2)
- raw/orphaned.md
- cognition/alone.md

### Dead-End Notes (5)
- raw/dead-end.md
```

## /me:autolinks - 自动添加 WikiLink

**功能：** 扫描现有笔记，自动添加指向其他笔记的 WikiLink。

**模式：**
- **Bulk Mode（默认）** - 处理所有 vault 文件：`/me:autolinks`
- **Single-Note Mode** - 仅处理指定文件：`/me:autolinks raw/note.md`

**工作流程：**
1. 构建知识库索引（所有笔记的标题）
2. 对每个文件：匹配正文中的关键词
3. 替换首次出现为 `[[wikilink]]`
4. 保留 frontmatter 不变

**选项：**
- 层级过滤：`/me:autolinks raw` 仅处理 raw 层
- 单笔记模式：`/me:autolinks raw/note.md` 仅处理指定文件

**输出（Bulk Mode）：**
```
## Auto-Link Vault Notes

Vault: /path/to/vault
Mode: Bulk (all vault files)
Indexed 45 notes.
Found 30 files to process.

  ✓ raw/article.md (+3 links)
  ✓ practices/pattern.md (+1 link)
  ✓ raw/another.md (unchanged)

## Summary
Processed: 30 files
Linked: 15 files
Unchanged: 15 files
```

**输出（Single-Note Mode）：**
```
## Auto-Link Vault Notes

Vault: /path/to/vault
Mode: Single-note (processing raw/note.md)
Indexed 45 notes.

Processing: raw/note.md

  ✓ raw/note.md (+2 links)

## Summary
File: raw/note.md
Linked: 1 files
Unchanged: 0 files
```

## /me:search - 多维搜索

**功能：** 跨层级搜索笔记，支持多维过滤条件组合。

**用法：**
```bash
# 自由文本搜索（标题 + 正文）
/me:search transformer

# 按标签搜索
/me:search --tags ai,llm

# 按层级过滤
/me:search --layer raw

# 按日期范围
/me:search --after 2026-04-01 --before 2026-04-30

# 按 WikiLink 关联
/me:search --linked-to my-note

# 组合搜索（AND 逻辑）
/me:search transformer --tags ai --layer raw --after 2026-04-01

# 限制结果数量
/me:search --tags ai --limit 10
```

**过滤逻辑：**
- 不同 flag 之间用 AND 组合
- `--tags` 内多个标签用 OR 逻辑
- 结果按创建日期倒序排列

**输出：** 表格格式，包含文件路径、标题、日期、标签。

## /me:backlinks - 反向链接发现

**功能：** 发现指定笔记的所有 incoming links 和未链接提及。

**输出：**
```
## Backlinks for: "my-note"

### Linked (already wikilink to this note)
- practices/related.md - mentions [[my-note]]
- raw/source.md - contains [[my-note|alias]]

### Unlinked Mentions (mentions title but no wikilink)
- raw/draft.md - mentions "my-note" without wikilink
  Line 12: "As discussed in my-note, we should..."
```

## /me:move - 移动/重命名笔记

**功能：** 移动或重命名笔记，自动更新所有 WikiLink 引用。

**用法：**
- 同目录重命名：`/me:move old-name new-name`
- 跨目录移动：`/me:move old-name practices/new-name.md`
- 带目录移动：`/me:move raw/old.md practices/new.md`

**处理的 WikiLink 变体：**
- `[[name]]` - 基础链接
- `[[name|alias]]` - 带别名链接
- `[[name#heading]]` - 标题锚点链接

**检测 Obsidian CLI**，有则使用增强模式，无则使用原生引擎。

## /me:doctor - 只读诊断 ME 状态

**功能：** 把当前 ME 工作空间的"有效状态"汇总成一份结构化报告：
- 解析出的 vault / plugin / runtime 根；
- 本地 plugin/package/marketplace 版本（`.codex-plugin`、`.claude-plugin`、
  `.agents/plugins` 四个 manifest 与 `package.json`）；
- `.me/config.yaml` 的合法性与层级目录是否存在；
- `SCHEMA.md` 兼容性：`current` / `edited` / `future` / `malformed` /
  `missing`（`edited` = 被改动的当前 schema，走 vault migration；`future`
  只在该 schema 声明了更高的 profile/revision 标记时判定）；
- 受管 Agent 表面：`dual` / `claude-only` / `codex-only` / `none`；
- `CLAUDE.md` 受管 section 完整性：missing / duplicated / reordered /
  malformed / customized；
- 未完成的 runtime lock / journal / recovery（含精确恢复状态与保留路径）。

**约束（写死，不放开）：** 严格只读。不升级、不迁移、不修复、不清锁、不写
vault/runtime、不 push/commit；基础诊断不联网；缺失的 runtime 目录保持缺失；
不做进程监控。保留 ME 1.6.x 的确认与恢复语义。

**用法：**
```bash
bun run "$PLUGIN_ROOT/bin/doctor.ts" --vault-dir "$VAULT_DIR"
# 可选：--plugin-root /path/to/me  --installed-version 1.6.0
```

输出为 versioned JSON（contract v1，见
`skills/doctor/references/diagnostic-contract-v1.md`），每条 finding 带稳定
`code`、`severity` 与 `recommendedAction`。Skill 层再把报告渲染成简洁摘要。

**修复方向三分类（用于向用户解释）：**
- **Plugin upgrade**：插件落后于 vault/checkout（如 `SCHEMA_FUTURE`、
  `PLUGIN_INSTALLED_MISMATCH`）→ 升级 ME 插件。
- **Vault migration**：vault 需要 `/me:setup` 刷新受管文件（如
  `SCHEMA_MISSING`、`SCHEMA_EDITED`、`CONFIG_MISSING`、managed-section
  findings）。
- **Diagnosis**：runtime 状态需要人工检查后再写（如 `RUNTIME_*` findings）。

## /me:recall - 只读回顾历史会话

**功能：** 在本地 Codex session 证据里检索先前的任务，返回**任务级**匹配，
而不是转储 transcript：

- 默认只在**当前 workspace** 内检索；跨 workspace 检索必须显式
  `--authorize-cross-workspace`，否则 fail closed（返回
  `CROSS_WORKSPACE_UNAUTHORIZED` 警告，不搜索）。
- 证据种类**严格为四种**：`user_statement`（用户发言）、
  `agent_conclusion`（agent 结论）、`tool_result`（工具调用+输出）、
  `correction`（后来更正/取代先前说法）。会话里的主张（conversation claims）
  与工具事实（tool facts）在 `sourceCategory` 区分。
- **确定性脱敏**：凭证、密钥、邮箱、环境变量、私钥、IP/MAC、疑似长密钥统一
  替换为 `[REDACTED:<type>]`，统计在 `stats.redactionTokens`；provenance 不做
  脱敏。单条证据文本有界（≤400 字符），默认不返回完整 transcript。
- 任务标题非稳定字段：`derivedTitle` 从第一条脱敏后的用户发言推导并标注
  `titleLabel: "derived"`，不当作权威标题。
- provenance 暴露 `sourcePath` + `recordIndex`，可回到原始 session（如支持时
  `codex resume <session_id>`）；不发明自定义 URL。
- **零写入**：不写 vault / Memory / Agent config / runtime / index / session
  存储；不建 DB / vector / 持久索引；不联网；会话内容是**不可信数据**，永远
  不当作指令；agent 结论不当作已验证事实。

**用法：**
```bash
bun run "$PLUGIN_ROOT/bin/recall.ts" --vault-dir "$VAULT_DIR" --query "修复 issue"
# 可选：--after 2026-08-01 --before 2026-08-05T10:00:00Z --workspace DIR \
#        --authorize-cross-workspace --adapter codex-local --limit 10
```

输出为 versioned JSON（contract v1，见
`skills/recall/references/evidence-contract-v1.md`）。空结果也显式成功（exit 0）；
参数非法 exit 2。

> 未来 `me:reflect` 才负责把经验分类（一次性/workspace/ME-general）、展示
> 反例与边界、要求确认并使用共享 mutation 契约落盘——**现在不实现 reflect 写**。

## /me:distill - Practice→Cognition 证据门控提炼

**功能：** 把经过验证的 Practices 笔记提升为 Cognition 层认知洞察。
整个流程以"预览→人工确认→应用"三阶段进行：
先生成完整的预览（包括目标路径、计划写入的 Markdown 和每个 gate 的判定），
由人工审阅确认无误后，再用预览摘要（preview digest）执行写入——绝不自动 promotion。

**工作流程：**

1. **Preview** — 对目标 Practice 运行 9 个确定性 gate，生成 `DistillPreviewV1`：
   - 包括计划写入的 Cognition 路径、完整 Markdown、gate 结果、独立案例、支持证据、
     矛盾证据、置信度、review 触发条件
   - 产出 SHA-256 `previewDigest` 用于 apply 阶段的精确匹配
2. **人工确认** — 检查所有 gate 全部 `pass`、`plannedMarkdown` 无误、独立案例确实独立、
   矛盾证据已解决
3. **Apply** — 传入 `previewDigest`，重新运行所有 gate、重建 Markdown、校验 digest
   匹配后，通过共享 vault-write 事务执行器加锁写入

**9 个 Gate：**

| Gate | 要求 |
|------|------|
| `local-provenance` | Practice 笔记位于配置的 practices 层，frontmatter 合法 |
| `multiple-independent-cases` | 至少有一个来自不同项目且不同来源的独立案例支持 |
| `counterevidence-search` | 已搜索过反证据 |
| `no-unresolved-contradiction` | 不存在未解决的高严重性矛盾 |
| `generalizes-beyond-task` | 洞察可推广到任务之外 |
| `clear-boundaries` | 实践笔记文档化了边界/局限性 |
| `justified-confidence` | 置信度有可用证据支撑 |
| `review-trigger-set` | 设置了 review 日期或触发条件 |
| `schema-valid-destination` | Cognition 层已配置且能通过 schema 校验 |

**置信度与 Review 来源：** 置信度来自 Practice 正文的 `## Confidence` 段落，
review 触发条件来自 `## Review` 段落——两者均不写入 Practice frontmatter。
Promotion 到 Cognition 时，confidence 以 `confidence: low|medium|high` 形式
进入 Cognition frontmatter，review 触发条件作为 `## Review` 段落保留在 Cognition 正文中。

**安全约束：**
- 绝不自动 promotion；每次都需人工审阅预览确认
- 绝不删除、降级或修改源 Practice 笔记
- 不修改 Practice 笔记的 status/lifecycle frontmatter
- 同一任务、复制来源或子 agent 会话不算独立案例
- PR merge/review praise 不算证据
- 不绕过 lock/transaction/recovery/confirmation 流程
- 不 commit/push

**用法：**
```bash
# Preview
bun run "$PLUGIN_ROOT/bin/distill.ts" --vault-dir "$VAULT_DIR" preview --practice "practices/some-practice.md"

# Apply（需传入 preview 产出的 digest）
bun run "$PLUGIN_ROOT/bin/distill.ts" --vault-dir "$VAULT_DIR" apply \
  --practice "practices/some-practice.md" \
  --preview-digest "<digest>"
```

输出为 versioned JSON：preview 阶段输出 `DistillPreviewV1`（contract `distill-preview`），
apply 阶段输出 `DistillResultV1`；空结果也显式成功（exit 0），参数非法 exit 2。

## 配置文件

`.me/config.yaml` 示例：
```yaml
# 自定义层级目录映射
raw: 调研
practices: 实践
cognition: 认知
```

**默认值：** `raw: raw`, `practices: practices`, `cognition: cognition`

## Events 模块 (bin/events.ts)

**功能：** 通用 JSONL 事件日志，记录知识库中的关键活动。

**定位：** 底层模块，不是 Skill。供其他 Skills 和自动化脚本调用，也可直接通过 CLI 使用。

### 事件 Schema

每行 JSONL 是一个 JSON 对象：

```json
{
  "type": "ingest",
  "subtype": "translate-cn",
  "description": "Ingested LLM Wiki article",
  "docIds": ["a1b2c3d4-5e6f-7a8b-9c0d-e1f2a3b4c5d6"],
  "timestamp": "2026-04-09T14:30:00.000Z"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 事件类型（自由字符串） |
| `subtype` | string | 否 | 事件子类型 |
| `description` | string | 是 | 事件描述 |
| `docIds` | string[] | 是 | 关联文档的 frontmatter UUID 列表（可为空） |
| `timestamp` | string | 是 | ISO 8601 时间戳（自动生成） |

### CLI 用法

```bash
# 追加事件（传 UUID）
bun run bin/events.ts append \
  --file .me/events.jsonl \
  --type ingest --subtype translate-cn \
  --description "Ingested article" \
  --doc-ids "uuid1,uuid2"

# 追加事件（传文件路径，自动解析/补全 UUID）
bun run bin/events.ts append \
  --file .me/events.jsonl \
  --type ingest \
  --description "Ingested article" \
  --doc-paths "raw/2026-04-08-llm-wiki.md"

# 查询事件
bun run bin/events.ts query \
  --file .me/events.jsonl \
  --type ingest --after 2026-04-01 --limit 20

# 按关联文档查询
bun run bin/events.ts query \
  --file .me/events.jsonl \
  --doc-id "a1b2c3d4-5e6f-..."
```

### TypeScript API

```typescript
import { appendEvent, appendEventWithPaths, queryEvents } from './events.js';

// 直接追加（传 UUID）
appendEvent('events.jsonl', {
  type: 'ingest',
  subtype: 'translate-cn',
  description: 'Ingested article',
  docIds: ['uuid-1'],
});

// 传文件路径，自动解析/补全 UUID 到目标文件的 frontmatter
appendEventWithPaths('events.jsonl',
  { type: 'ingest', description: 'Ingested article' },
  ['raw/2026-04-08-llm-wiki.md'],
  process.cwd(),
);

// 查询（支持 type/subtype/docId/after/before/limit 过滤）
const events = queryEvents('events.jsonl', { type: 'ingest', limit: 10 });
```

### 约定事件类型

| type | 典型 subtype | 触发场景 |
|------|-------------|---------|
| `ingest` | `translate-cn`, `summarize`, `raw` | `/me:ingest` |
| `autolinks` | `bulk`, `single` | `/me:autolinks` |
| `move` | — | `/me:move` |
| `checklinks` | — | `/me:checklinks` |
| `search` | — | `/me:search` |
| `lifecycle` | `promote`, `demote` | 文档跨层移动 |
