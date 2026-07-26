# ME - Personal Knowledge Base Plugin for Claude Code / Codex

> 三层知识飞轮（Raw → Practices → Cognition）+ 自由 WikiLink 交叉引用的个人知识管理插件

**ME** 把任何工作空间变成知识飞轮 —— 零基础设施，只需 Git + Markdown + Claude Code 或 Codex。
同一个 `/me:ingest` 可以把 HTML 文章、PDF、X 与 Bilibili 公共内容整理成带来源、正文和本地素材的笔记；视频默认优先生成保留完整时间线的讲义，便于之后检索、复习和引用。
当研究走到“该怎么选”时，`/me:decision-brief` 会把本地证据、现实约束、备选方案和最小验证实验整理成可复盘的决策简报。简报默认只在对话中返回；只有明确要求保存时，才会写入 Practices。

## 快速开始

```bash
# Claude Code 安装
claude plugin marketplace add https://github.com/wu8685/me.git
claude plugin install me@me-marketplace

# Codex 安装（本地开发）
codex plugin marketplace add /path/to/me
codex plugin add me@me-marketplace

# Codex 安装（GitHub 仓库发布后）
codex plugin marketplace add https://github.com/wu8685/me.git
codex plugin add me@me-marketplace
```

Claude Code 使用 `/me:*` slash commands：

```bash
cd your-workspace
/me:setup
/me:ingest https://example.com/article
/me:decision-brief "团队是否应该在下个季度采用新的发布流程？"
```

Codex 安装后会把技能加载为 `me:*`。在 Codex 里运行 `/skills` 选择 `me:setup`，或在 prompt 中显式写 `$me:setup`、`$me:ingest https://example.com/article`、`$me:decision-brief ...`。

## 核心功能

| 功能 | Claude Code | Codex skill |
| --- | --- | --- |
| 初始化三层知识目录结构 | `/me:setup` | `me:setup` |
| 摘入文章、PDF、公开视频或 Source Bundle | `/me:ingest <source>` | `me:ingest` |
| 基于证据形成可复盘的决策简报 | `/me:decision-brief <问题>` | `me:decision-brief` |
| 多维搜索笔记（全文 / 标签 / 层级 / 日期） | `/me:search <query>` | `me:search` |
| 检查链接健康（断链、孤儿、死结） | `/me:checklinks` | `me:checklinks` |
| 自动添加 WikiLink（支持单笔记模式） | `/me:autolinks [note]` | `me:autolinks` |
| 发现反向链接 | `/me:backlinks <note>` | `me:backlinks` |
| 移动/重命名笔记（保持引用完整） | `/me:move <file> <dest>` | `me:move` |

## 三层知识结构

```
Raw (调研) → Practices (实践) → Cognition (认知)
```

- **Raw**: 调研、摘录、原始素材
- **Practices**: 经过实践检验的方法、模式
- **Cognition**: 形成认知、原则、世界观

目录可配置（`.me/config.yaml`），默认为 `raw/`、`practices/`、`cognition/`。

## 同步安全

vault 可以由 Obsidian Sync、Git 或其他工具同步。ME 只把可迁移配置保留在
vault 的 `.me/` 中；锁、事务、临时输入和恢复材料默认写到同文件系统的相邻
`.me-runtime/`，不会进入 Obsidian vault。需要把运行时放到其他本机目录时，
可设置 host-local 环境变量 `ME_RUNTIME_ROOT`；该绝对路径不会写入
`.me/config.yaml`。

## 技术栈

- **TypeScript** + **Bun** - 类型安全的 CLI 工具
- **Git + Markdown** - 零基础设施的知识存储
- **Claude Code / Codex Skills** - 原生 AI 集成

## 版本

**v1.6.0**

## 文档

- [理念](./docs/philosophy.md) - 设计原则与知识飞轮模型
- [功能](./docs/features.md) - Skills 功能详解
- [使用指南](./docs/user-guide.md) - 快速开始与典型工作流
- [开发文档](./docs/development.md) - 项目结构与贡献指南
