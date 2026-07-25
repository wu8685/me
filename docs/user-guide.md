# ME 使用指南

## 安装

### Claude Code

```bash
# 1. 添加插件市场源
claude plugin marketplace add https://github.com/wu8685/me.git

# 2. 安装插件
claude plugin install me@me-marketplace
```

### Codex

```bash
# 1. 添加插件市场源（本地开发）
codex plugin marketplace add /path/to/me

# 或：GitHub 仓库内容发布后
codex plugin marketplace add https://github.com/wu8685/me.git

# 2. 安装插件
codex plugin add me@me-marketplace
```

Codex 支持 `codex plugin marketplace add <SOURCE>` 和 `codex plugin add me@me-marketplace`。本仓库提供 Codex 原生 marketplace：`.agents/plugins/marketplace.json`，其中 `source.path: "./"` 指向仓库根目录的插件本体；插件能力由 `.codex-plugin/plugin.json` 暴露，`skills: "./skills/"` 会加载 7 个 `me:*` skills。

本指南后续命令默认写成 Claude Code 的 `/me:*` slash command。Codex 中对应的 skill 名称是 `me:*`：运行 `/skills` 选择 `me:setup`，或在 prompt 中显式写 `$me:setup`、`$me:ingest https://example.com/article`。

## 初始化工作空间

```bash
cd your-workspace
/me:setup
```

Codex 等价调用：`$me:setup`。

**输出：**
```
me vault initialized.

Created:
  .me/config.yaml     (layer mapping: raw -> raw, practices -> practices, cognition -> cognition)
  raw/                 (+ .gitkeep)
  practices/           (+ .gitkeep)
  cognition/           (+ .gitkeep)
  SCHEMA.md
  CLAUDE.md
  .gitignore           (added .obsidian/ entry)

Next steps:
  Run `/me:ingest <url>` to add your first research note.
```

## 摄入文章、PDF 与公开视频

```bash
# HTML 文章
/me:ingest https://example.com/article-about-ai

# PDF（也支持由响应类型识别的无后缀 PDF）
/me:ingest https://example.com/research/report.pdf

# 公开 X 文章或视频
/me:ingest https://x.com/example/status/1234567890

# Bilibili 公共视频
/me:ingest https://www.bilibili.com/video/BV1Example
```

Codex 等价调用：`$me:ingest https://example.com/article-about-ai`。

`/me:ingest` 会先预览来源类型、处理模式和可用能力，再确认 topic 并写入。英文文章默认 `translate-cn`，中文文章默认 `summarize`；视频或课程默认生成 `handout` 讲义。也可以显式指定：

```bash
/me:ingest https://www.bilibili.com/video/BV1Example --mode handout
/me:ingest https://x.com/example/status/1234567890 --mode transcribe
```

讲义不是十条摘要。ME 会保留完整的时间戳 transcript：有稳定、带时间戳的页面时生成 Slide-driven 讲义；访谈、talking head 或没有稳定页面的视频生成 Topic-driven 讲义。

### 导入 Source Bundle

Source Bundle v1 是静态交换目录，适合导入用户已有合法访问权、但公开 URL 无法直接读取的材料：

```text
my-bundle/
├── source-bundle.json
└── assets/
    └── slide-001.jpg
```

```bash
/me:ingest --bundle ./my-bundle
```

Bundle 中的路径必须留在目录内部，不能包含登录状态、凭据、本机绝对路径或可执行指令。ME 会在写入前校验完整 Bundle；非法 Bundle 不会留下部分文件。

### 依赖探测与 degraded 结果

基础 HTML 摄入只需插件运行环境。富媒体来源会在预览阶段探测所需能力：

- PDF：需要 `curl`、`pdftotext`、`pdftohtml`。
- X 视频：需要 `yt-dlp`。
- 缺少现成字幕而需要本地转写时：使用配置中可用的 `mlx-whisper` 或 `whisper.cpp` provider。

预览 JSON 中的 `capabilities` 表示实际可用内容，`warnings` 表示缺失或失败的资源。`warnings` 非空时应把结果视为 degraded/partial，并明确说明缺了什么；登录阻断、加密/DRM 或不可读来源会直接失败。只有输出包含 `writeResult` 才表示 artifact 已写入，失败时不会留下半篇笔记。

成功写入后，一篇材料位于独立目录中：

```text
raw/<topic>/YYYY-MM-DD-slug/
├── YYYY-MM-DD-slug.md
├── images/
└── slides/
```

只有实际存在的素材目录才会创建。输出还会给出 warnings 与 link suggestions，便于后续补充连接。

## 搜索笔记

```bash
# 自由文本搜索
/me:search transformer

# 按标签搜索
/me:search --tags ai,llm

# 按层级 + 日期范围
/me:search --layer raw --after 2026-04-01

# 组合搜索
/me:search agent --tags ai --limit 5
```

## 检查链接健康

```bash
/me:checklinks
```

## 自动添加链接

```bash
# 批量模式：处理所有层级
/me:autolinks

# 批量模式：仅处理 raw 层
/me:autolinks raw

# 单笔记模式：仅处理指定文件
/me:autolinks raw/2026-04-06-my-note.md
```

**何时使用：**
- 批量模式：新增多篇笔记后，统一添加链接
- 单笔记模式：编辑某篇笔记后，只想更新该笔记的链接

## 发现反向链接

```bash
/me:backlinks "my-note"
```

## 移动笔记

```bash
# 重命名
/me:move old-name new-name

# 移动到不同层级
/me:move raw/note.md practices/note.md
```

## 记录事件

Events 模块可以记录知识库中的关键操作，方便回顾和自动化。

```bash
# 记录一次摄入事件（传文件路径，自动解析 UUID）
bun run bin/events.ts append \
  --file .me/events.jsonl \
  --type ingest --subtype translate-cn \
  --description "Ingested LLM Wiki article" \
  --doc-paths "raw/摘录/2026-04-08-llm-wiki.md"

# 查询最近的摄入事件
bun run bin/events.ts query \
  --file .me/events.jsonl \
  --type ingest --limit 5

# 查询某篇文档相关的所有事件
bun run bin/events.ts query \
  --file .me/events.jsonl \
  --doc-id "a1b2c3d4-..."
```

## 典型工作流

### 工作流 1: 摄入 → 链接 → 搜索

```bash
# 1. 摘入一篇英文文章
/me:ingest https://example.com/ai-paper

# 2. 自动添加 WikiLink
/me:autolinks raw/2026-04-06-ai-paper.md

# 3. 搜索相关笔记
/me:search --tags ai-agents --layer raw
```

### 工作流 2: 定期维护

```bash
# 每周检查链接健康
/me:checklinks

# 自动添加新笔记的链接
/me:autolinks

# 发现笔记之间的关系
/me:backlinks "recent-note"
```

### 工作流 3: 知识提炼

```bash
# 1. 搜索某个主题的所有素材
/me:search transformer --layer raw

# 2. 阅读后提炼为认知
/me:move raw/2026-04-06-ai-paper.md cognition/ai-agents-pattern.md

# 3. 检查链接完整性
/me:checklinks
```

## 与 Obsidian 配合使用

### 在 Obsidian 中查看

```bash
# 初始化后，直接用 Obsidian 打开工作空间
open /path/to/your-workspace
```

### Obsidian CLI 增强模式

如果 Obsidian 1.12+ 已安装并运行：
- `/me:checklinks` 使用 Obsidian CLI（别名解析、元数据缓存）
- `/me:move` 使用 Obsidian CLI（精确的引用更新）

### 离线模式

如果 Obsidian 未运行：
- 使用内置 `wikilink-graph.ts` 引擎
- 功能完整，无外部依赖

## 自定义目录映射

### 中文目录名

```bash
/me:setup
# 提示时输入：
# Raw layer [raw]: 调研
# Practices layer [practices]: 实践
# Cognition layer [cognition]: 认知
```

### 手动编辑配置

创建 `.me/config.yaml`：
```yaml
raw: 调研
practices: 实践
cognition: 认知
```

## 常见问题

### Q: 如何迁移现有 Obsidian vault？

A:
1. 备份现有 vault
2. 在 vault 根目录运行 `/me:setup`
3. 按提示映射现有目录到三层模型
4. 使用 `/me:autolinks` 批量添加链接

### Q: 是否支持多人协作？

A: **通过 Git**：
- 每个人维护自己的 vault
- 通过 Git 合并共享内容
- 或使用共享 knowledge-base 仓库

### Q: 如何备份知识库？

A: 使用 Git：
```bash
cd your-workspace
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

### Q: 如何在不同设备间同步？

A: 使用 Git 同步：
```bash
# 设备 A
git push

# 设备 B
git pull
```

或使用 Obsidian Sync / Git Sync 插件。
