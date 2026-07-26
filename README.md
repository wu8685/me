# ME

> 让知识持续参与你的研究、判断与行动。

ME 是一套面向个人的知识操作系统。它以 Claude Code 或 Codex 为交互入口，
以 Markdown 保存内容，用 Git 记录变化，帮助你管理知识从来源、实践到认知
的生长过程。

人们已经不缺少收藏信息的工具。真正困难的是后半程：哪些材料值得留下，
哪些观点经受过实践，哪些经验已经足以成为下一次判断的依据。ME 关注的正是
这一段过程。

## 知识如何生长

ME 用三层结构描述知识的变化：

```text
Raw → Practices → Cognition
 ↑                      │
 └──── 新的问题与实践 ────┘
```

- Raw 保存来源、事实和他人的观点，让判断有据可查。
- Practices 记录尝试、反馈和阶段性结论，让经验能够复盘。
- Cognition 沉淀经过反复检验的原则，用来指导新的行动。

这三层不是资料分类表，也不是自动晋级流水线。知识是否值得上升，仍由人根据
实践证据决定。Agent 负责降低整理、检索和维护的成本，把注意力留给阅读、
判断与反思。

## 一个属于个人的知识操作系统

ME 把知识库作为个人工作的长期基础设施：

- 通过自然语言与 Agent 协作，在当前问题中调用已有知识；
- 用纯 Markdown 保留完整内容，不把个人积累锁在某个平台；
- 用 Git 保存知识变化的过程，使重要判断可以追溯和修正；
- 与 Obsidian 等现有工具共存，不要求改变熟悉的阅读和写作方式。

随着材料、实践和认知不断积累，知识库会逐渐形成个人的研究脉络、决策依据
和做事原则。新的行动产生新的证据，再回到知识库中修正旧判断。

## 适合用在哪里

ME 适合需要长期积累上下文的工作：

- 围绕一个领域持续研究，而不是每次从零开始；
- 在重要决策中调用过去的材料、经验和原则；
- 记录实践与反馈，分清设想、经验和稳定认知；
- 建立一套可以跨工具、跨机器迁移的个人知识库。

## 开始使用

Claude Code：

```bash
claude plugin marketplace add https://github.com/wu8685/me.git
claude plugin install me@me-marketplace
```

Codex：

```bash
codex plugin marketplace add https://github.com/wu8685/me.git
codex plugin add me@me-marketplace
```

进入准备作为知识库的工作空间，运行初始化命令：

```text
# Claude Code
/me:setup

# Codex
$me:setup
```

ME 会建立三层知识结构。之后可以继续使用 `/me:*` commands 或 `me:*`
skills 摄入材料、检索笔记、维护连接，并让已有知识参与新的问题。

## 文档

- [使用指南](./docs/user-guide.md)：安装、初始化、配置与典型工作流
- [功能说明](./docs/features.md)：Skills、输入类型与行为边界
- [设计理念](./docs/philosophy.md)：三层知识模型及其设计原则
- [开发文档](./docs/development.md)：项目结构、测试与贡献方式
