# ME 开发文档

## 项目结构

```
me/
├── .claude-plugin/
│   ├── plugin.json              # Plugin metadata
│   └── marketplace.json          # Claude Code marketplace configuration
├── .codex-plugin/
│   └── plugin.json              # Codex plugin metadata
├── .agents/
│   └── plugins/marketplace.json  # Codex marketplace configuration
├── bin/                          # TypeScript CLI tools
│   ├── wikilink-graph.ts         # Core link graph engine
│   ├── ingest.ts                 # URL ingestion pipeline
│   ├── runtime.ts                # Host-local runtime inspection/inbox CLI
│   ├── runtime-paths.ts          # Runtime resolution and containment
│   ├── vault-write.ts            # Generic transactional vault writer CLI
│   ├── vault-write/              # Validation, graph planning and transaction modules
│   ├── setup-preflight.ts        # Read-only fresh setup safety preflight
│   ├── update.ts                 # Versioned vault migration CLI
│   ├── update/                   # Registry, planner, contracts and transaction modules
│   ├── mutation/                 # Shared no-clobber mutation executor
│   ├── checklinks.ts             # Link health checker
│   ├── autolinks.ts              # Auto wikilink generator
│   ├── backlinks.ts              # Backlink discovery
│   ├── move.ts                   # Note move/rename
│   ├── search.ts                 # Multi-dimensional note search
│   └── events.ts                 # JSONL event log (append/query)
├── skills/                       # Claude Code / Codex skills
│   ├── ingest/SKILL.md           # URL ingestion skill
│   ├── decision-brief/SKILL.md   # Evidence-backed decision skill
│   ├── setup/SKILL.md            # Workspace setup skill
│   ├── update/SKILL.md           # Confirmed vault migration skill
│   ├── search/SKILL.md           # Multi-dimensional search skill
│   ├── checklinks/SKILL.md       # Link health skill
│   ├── autolinks/SKILL.md        # Auto wikilink skill
│   ├── backlinks/SKILL.md        # Backlink discovery skill
│   └── move/SKILL.md             # Note move/rename skill
├── test/                         # Test suite
│   └── vault-test.sh
├── templates/                    # Templates
│   ├── SCHEMA.md                 # Frontmatter schema
│   ├── CLAUDE-template.md        # Agent navigation contract
│   ├── AGENTS-template.md        # Codex Agent navigation contract
│   ├── migration-history/0000/   # Immutable version-zero migration inputs
│   ├── raw-template.md           # Raw layer note template
│   ├── practices-template.md     # Practices layer template
│   └── cognition-template.md     # Cognition layer template
└── README.md
```

## Vault / Runtime 边界

vault 可能由 Obsidian Sync 或 Git 同步，因此 `.me/` 只允许 portable config
和 Profile。所有会变化的 host-local 状态统一经 `bin/runtime-paths.ts`
解析到
`~/.me/runtime/vault-<sha256(canonical-path)[0:24]>/`：

- `locks/`：vault writer cooperative lock；
- `transactions/`：journal、staging、originals 与 recovery；
- `inbox/`：显式文件输入边界；
- `ingest/locks/`、`ingest/staging/`：ingest finalizer 状态。

`ME_RUNTIME_ROOT` 只覆盖本机 runtime base，禁止写入 `.me/config.yaml`。
resolver 拒绝 vault 内路径、symlink 逃逸和跨 filesystem 布局；跨 filesystem
时必须把 `ME_RUNTIME_ROOT` 指向 vault 所在 filesystem，不会自动回退到
vault 邻近目录，也不会退化为 copy。对外 recovery 使用 `<ME_RUNTIME>/...`，
只有 `bin/runtime.ts path --vault-dir DIR` 会按操作者请求显示绝对路径；
`prepare-inbox` 只创建 runtime namespace 和 inbox。

ME 1.6 不自动清理 1.5 留下的非空 vault-local runtime state。writer 与
ingest 都必须在新 runtime 发生 mutation 前 fail closed，让用户先检查旧
lock、journal 或 staging。

## Versioned vault update

marketplace/plugin upgrade 只更新插件资源；它不会静默修改 vault。用户随后
通过 `/me:update`（Claude Code）或 `$me:update`（Codex）执行相同协议：
零写 preview 展示 ordered migrations、paths、warnings 和 exact diffs，
一次明确确认后，才以该 preview 的 `planDigest` 调用 apply。

`.me/config.yaml` 的 `vault_schema_version` 是 portable、forward-only 的
managed schema 版本。newer vault、conflict、recovery state 与
`STALE_PREVIEW` 都 fail closed。apply 在 shared vault lock 内重新规划，
所有 publication/rollback mutation 复用 `bin/mutation/executor.ts`；
`.me/config.yaml` 最后发布。journal/staging/originals 位于 host-local
runtime。只有 `committed` 是成功，其他结果保留结构化 rollback 或 recovery
信息。ME updater 不执行 Git，也不 stage、commit 或 push 用户 vault。

## Decision Brief 与 Vault Writer 边界

`skills/decision-brief/` 负责判断层：建立 Decision Contract、检索证据、比较选项、给出最小验证实验，并决定用户是否已经明确授权保存。它不直接操作目标笔记或 README，也不自行实现写入事务。

`bin/vault-write.ts` 与 `bin/vault-write/` 是领域无关的工具层：解析 v1 request、校验内置 schema profile、规划目标与索引、执行写入并返回结构化结果。Decision Brief 是首个 Practices 调用方，但 writer 不包含决策领域规则；其他满足同一 request contract 的 Skill 也可以复用它。

### Commit model

- `preview` 是零写入检查，返回 `commitModel: preview-only`。
- `write` 使用 `commitModel: journaled-cooperative`：合作式锁、operation journal、ownership 检查和 filesystem hard-link/rename 语义共同降低并发覆盖与中断风险。
- 该模型不是跨文件 atomic CAS。网络盘、FUSE、断电和不支持所需 filesystem primitive 的环境，仍受实际 filesystem 语义限制；能力不足时 writer 必须 fail closed，不能悄悄退化为覆盖写入。

### Recovery contract

启动 write 时会先检查未完成 operation。可以证明 ownership 且未发生外部变化的内容才允许自动清理或恢复；无法证明归属、内容已变化或 operation 目录损坏时，保留现有数据并返回 `status: manual_recovery`。

调用方必须读取聚合的 `recoveryState`，并逐项展示 `recoveries[]` 中的 `operationId`、`state`、`preservedPaths`、`remainingMutations` 与全部 `actions`。不得把 `manual_recovery` 简化为“已保存”或“已回滚”。只有 `status: committed` 才能对外报告保存成功。

## 添加新 Skill

### 1. 创建 Skill 目录

```bash
mkdir -p skills/your-skill
```

### 2. 创建 SKILL.md

```markdown
---
description: One-line description of what this skill does
---

# /me:your-skill

Brief description of what this skill does.

Claude Code exposes this as `/me:your-skill`. Codex exposes installed plugin
skills as `me:your-skill`; invoke it from `/skills` or mention
`$me:your-skill` in the prompt.

## Usage

```bash
bun run bin/your-tool.ts "$(pwd)" "$ARGUMENTS"
```

The TypeScript executable automatically:
- Does something useful
- Handles errors gracefully
- Reports results clearly

## Step 1: First step description...

Detailed instructions for Claude to follow.

## Step 2: Second step description...

More detailed instructions.

## Output

Description of what this skill produces.

## Constraints

- All vault paths are relative to cwd
- Read-only operation (does not modify notes)
- Layer directories resolved from `.me/config.yaml`
```

### 3. 创建 TypeScript 工具（可选）

如果需要可编程逻辑：

```typescript
#!/usr/bin/env -S bun run
// bin/your-tool.ts - Your tool description

import * as fs from 'fs';

export async function yourCommand(vaultDir?: string): Promise<string> {
  const vault = vaultDir || process.cwd();

  // Your logic here

  return "Result";
}

// CLI entry point
if (require.main === module) {
  yourCommand()
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
```

### 4. 添加测试

在 `test/vault-test.sh` 中：

```bash
test_your_skill_basic_functionality() {
  # Test description
  local f="$PLUGIN_ROOT/skills/your-skill/SKILL.md"
  assert_file_exists "$f" || return 1
  assert_file_contains "$f" "description:" || return 1
}
```

在 main() 中注册：
```bash
run_test test_your_skill_basic_functionality
```

### 5. 运行测试

```bash
bash test/vault-test.sh test_your_skill_basic_functionality
```

## SKILL.md 编写规范

### 结构

```markdown
---
description: One-line description
---

# /me:your-skill

Brief description.

## Usage

CLI invocation pattern.

## Step N: Step Title

Clear instructions for Claude.

## Output

What this produces.

## Constraints
```

### 约定

- **不超过 500 行** - 提取到 `references/` 子目录
- **使用 `$ARGUMENTS`** - 接收用户输入
- **使用 `${CLAUDE_PLUGIN_ROOT}`** - 引用插件文件
- **Step-by-step** - Claude 需要明确的步骤指令

## Frontmatter Schema

### Raw 层笔记

```yaml
---
title: "Note Title"
created: YYYY-MM-DD
tags: [tag1, tag2]
type: article
source: "https://example.com"
---
```

### Practices 层笔记

```yaml
---
title: "Practice Title"
created: YYYY-MM-DD
tags: [tag1, tag2]
type: experiment
project: "project-name"
status: active | completed | archived
---
```

### Cognition 层笔记

```yaml
---
title: "Insight Title"
created: YYYY-MM-DD
tags: [tag1, tag2]
type: insight
confidence: low | medium | high
---
```

## Wikilink Graph Engine

核心实现在 `bin/wikilink-graph.ts`：

- **无依赖** - 纯 TypeScript，无需 Obsidian
- **快速** - 单次扫描建立索引
- **准确** - 支持 `[[name]]`、`[[name|alias]]`、`[[name#heading]]`

### API

```typescript
import { buildGraph, LinkGraph } from './wikilink-graph.js';

const graph: LinkGraph = buildGraph(vaultDir);

console.log(graph.broken);    // 断链: { source, target }[]
console.log(graph.orphans);   // 孤儿: string[]
console.log(graph.deadends);  // 死结: string[]
```

### LinkGraph 接口

```typescript
interface LinkGraph {
  broken: BrokenLink[];      // { source: string; target: string }[]
  orphans: string[];          // 孤儿笔记路径
  deadends: string[];         // 死结笔记路径
}

interface BrokenLink {
  source: string;  // 引用文件路径
  target: string;  // 被引用的目标笔记 stem
}
```

## 测试

### 运行测试

```bash
# 所有测试
bash test/vault-test.sh

# 单个测试
bash test/vault-test.sh test_name

# 显示所有测试
bash test/vault-test.sh --list
```

### TDD 流程

```bash
# 1. 先写 failing test
# 2. 实现功能
# 3. 确认 test passes
```

### 测试约定

- 测试函数名以 `test_` 开头
- 使用 `assert_file_exists`、`assert_file_contains` 等辅助函数
- 测试应该是幂等的（可重复运行）
- 测试应该独立（不依赖其他测试）

## 发布流程

### 发布不变式（Release Invariants）

ME 强制执行以下不变式，确保每个发布版本标识一个且仅一个不可变的 package payload：

1. **版本清单一致**：`package.json`、`.claude-plugin/plugin.json`、
   `.claude-plugin/marketplace.json`、`.codex-plugin/plugin.json` 四个清单
   的 `version` 字段始终一致。
2. **Package-affecting 变更必须有版本号 bump**：修改 `skills/`、`bin/`、
   `templates/`、插件清单、runtime dependencies、migration declarations
   或打包配置的 PR，必须同步提升版本号。
3. **一个 Git tag/version → 一个 package content digest**：`.release-digests.json`
   存储每个已发布版本的 content SHA-256 摘要（`path:sha256(file-bytes)` 逐文件计算后哈希）——任意打包文件的内容变化都会导致不同的摘要。同一版本号对应不同
   payload 时 CI 会拒绝。
4. **发布测试必须从打包产物安装**，不能从源码树直接运行。
5. **已安装 package smoke test** 必须解析 Skill 且成功执行每个 CLI 的
   help / 只读 fixture 路径。

### 豁免策略（Exemption Policy）

**仅**以下路径的变更**不需要**版本号 bump（它们不在 `npm pack` 产物中）：

- `test/` 目录下的测试文件
- `.claude/`、`.codex/`、`.planning/`、`.worktrees/`、`.superpowers/` — 开发工具与内部工作目录
- `.gitignore`、`bunfig.toml`、`node_modules/`、`package-lock.json` — 开发基础设施

**注意**：`docs/` 目录下的文档和仓库根目录下的 Markdown 文件（README、CLAUDE、AGENTS、
DEVELOPMENT、LEGAL）**已经**进入 npm package 的 `"files"` 清单，属于 shipped runtime
payload。修改这些文件时**必须**同步提升版本号。

豁免路径的判定以 `npm pack --dry-run --json` 的实际文件清单为准（ground truth），
不是 `bin/release-guard.ts` 内的硬编码数组。`NON_PACKAGE_PATHS` 只是一个快速排除
列表，真正的"是否 package-affecting"由文件是否在 packlist 中决定。

如果需要添加新的豁免路径，确认该路径**不在** `npm pack` 产物中后，在
`bin/release-guard.ts` 的 `NON_PACKAGE_PATHS` 数组中添加。

### 1. 更新版本号

更新以下四个文件的 `version` 字段：
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.codex-plugin/plugin.json`

`.agents/plugins/marketplace.json` 是 Codex marketplace 入口，本身不含版本号；
它通过 `source.path: "./"` 指向仓库根目录，Codex 从 `.codex-plugin/plugin.json` 读取版本。

版本格式：`MAJOR.MINOR.PATCH`
- MAJOR - 重大变更
- MINOR - 新功能
- PATCH - Bug 修复

### 2. 运行测试与 release guard

```bash
# 完整测试套件
bun test test/*.test.ts
bash test/typecheck-ingest-finalize.sh
bash test/vault-test.sh

# Release guard（版本一致性与 digest 检查）
bun bin/release-guard.ts check
```

### 3. 记录发布 digest

```bash
bun bin/release-guard.ts record
```

这会将当前版本的 package content 摘要写入 `.release-digests.json`。
该文件必须随版本号 bump 一起 commit。

### 4. 提交

```bash
git add -A
git commit -m "chore: bump version to x.y.z"
git push origin main
```

### 5. 创建 Git Tag（可选）

```bash
git tag -a v1.7.0 -m "Release v1.7.0"
git push origin v1.7.0
```

### 发布后手动步骤

在 PR merge 后，需要人工执行以下操作（不在 CI 中自动执行）：
1. **Plugin marketplace 发布**：更新 marketplace 注册表以区分新版本。
2. **Git tag**：按需创建 annotated tag。
3. **Release notes**：在 GitHub Releases 页面发布。注意：GitHub Release
   不等于 npm publish——ME 是 Codex / Claude Code 插件，通过 marketplace
   或本地路径安装。

## 代码风格

- **TypeScript** 严格模式
- **4 空格缩进**
- **单引号字符串**
- **函数注释** 使用 JSDoc

```typescript
/**
 * Build vault index from all markdown files.
 * @param vaultDir - Root directory of the vault
 * @returns Map of lowercase title to VaultEntry
 */
export function buildVaultIndex(vaultDir: string): Map<string, VaultEntry> {
  // ...
}
```

## 提交信息规范

```
type(scope): description

type: feat | fix | docs | refactor | test | chore
scope: short-scope-name
description: imperative mood, max 50 chars

Detailed explanation (optional).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

### 例子

```
feat(autolinks): add batch wikilink generation

- Scan vault files for matching keywords
- Replace first occurrence with wikilink
- Preserves frontmatter boundaries

Fixes #123

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## 故障排查

### 测试失败

```bash
# 查看详细输出
bash test/vault-test.sh test_name

# 检查文件状态
git status
```

### TypeScript 编译错误

```bash
# 检查类型错误
bun run bin/your-tool.ts
```

### Skill 无法加载

检查：
1. SKILL.md 是否存在
2. Frontmatter 是否有效
3. 路径是否正确

## 贡献指南

1. Fork 项目
2. 创建特性分支
3. 编写代码和测试
4. 确保所有测试通过
5. 提交 Pull Request

### Pull Request 检查清单

- [ ] 代码风格一致
- [ ] 测试覆盖新功能
- [ ] 文档已更新
- [ ] 提交信息清晰
