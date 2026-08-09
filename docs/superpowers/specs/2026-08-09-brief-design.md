# Brief Skill（me:brief）设计

**状态：** Approved（GitHub issue #14）
**日期：** 2026-08-09
**所属项目：** ME

## 1. 背景

ME 已有摄入（ingest）、检索（search）、会话证据（recall）与决策简报
（decision-brief），但缺少面向"非决策"高风险写作的通用流程：executive
汇报、技术叙事、复盘、奖项申报、项目总结。这类写作的失败模式不是选错方向，
而是把不同性质的陈述混在一起：

- 把目标（target）写成已达成的结果（verified_result）；
- 把推断（inference）写成事实（fact）；
- 使用没有证据支撑的最高级措辞（best / first / highest / 最高 / 唯一）；
- 后来的更正被旧说法淹没；
- 把"没获奖""工作仍有价值""获得组织认可"合并成一个判断；
- 压缩到字数预算时丢失关键主张与出处；
- 输出长度与受众不匹配。

issue #14 的两个真实场景（跨仓库 executive 建站汇报、奖项申报记录）证明：
这类写作存在必须确定化的重复工作——claim 分类纪律、unsupported-language
检查、correction 可见性与字数预算是每次都要执行的相同校验，因此以公共
`bin/brief.ts` 提供确定性 claim ledger 校验，而不是依赖每个 Agent 临场自觉。

## 2. 目标

1. 提供通用 `me:brief` 工作流：先建立 brief contract，再检索证据、构建
   claim ledger，最后生成 conclusion-first 的简报。
2. claim ledger 区分八类主张：fact / target / verified_result / inference /
   correction / recognition / recommendation / unknown。
3. 确定性校验（Codex 与 Claude 两端同一 CLI、同一 fixtures、同一输出）：
   - target 不得使用已完成措辞；
   - verified_result 必须带 unit、scope、baseline、证据日期；
   - unsupported superlative 被标记并给出保守改写；
   - correction 必须指向被取代的 claim，被取代的 claim 保持可见；
   - recognition 不得断言技术有效性或结果；
   - 矛盾双方都保留在报告中；
   - session 证据必须显式授权；
   - 字数预算超限时报错，且 decisive claims 的出处必须在正文中保留。
4. 输出支持少量确定性结构：executive report、technical narrative、
   retrospective、nomination/application、带字数预算的 summary。
5. 默认只在对话输出；显式授权后仅可保存到 Practices，复用共享
   vault-write preview/confirmation/mutation 流程；绝不写入 Cognition。

## 3. 非目标

- 不替代 `me:decision-brief`（brief 不强制产出决策）。
- 不做 slide 渲染或文档排版。
- 不直接抓取外部系统；摄入与 connector 工作流保持独立。
- 不为增强叙事而编造证据。
- 不写 Cognition。

## 4. 形态

```text
skills/brief/
├── SKILL.md
└── references/
    ├── claim-ledger-v1.md      # claim ledger 契约（八类主张 + 字段）
    └── output-contract.md      # 输出结构、字数预算、provenance appendix
bin/brief.ts                    # CLI 入口（validate）
bin/brief/contracts.ts          # contract v1 类型
bin/brief/ledger.ts             # 确定性校验核心
test/fixtures/brief/*.json      # 确定性 claim ledger fixtures
test/brief-ledger.test.ts       # bun 测试
```

Skill 负责判断与写作；CLI 负责确定性校验。同一 ledger 输入在 Codex 与
Claude 表面产生逐字节相同的校验报告（fixtures 显式传 `--now` 消除时钟
依赖）。

## 5. 触发与路由

应触发：汇报、总结、复盘、申报材料、叙事写作——材料异构、受众明确、
需要区分目标/结果/推断/认可的场合。

不应触发：待决选择（用 me:decision-brief）、稳定事实查询、URL 摄入、
日常调试。

## 6. Brief contract

写作前建立：

```text
Topic | Audience | Purpose | Desired action | Structure | Max words | Tone | Freshness window
```

最多问一个问题，且仅当缺失答案会改变简报方向时。

## 7. 证据来源与授权

- 默认通过 `me:search` 检索当前 vault；
- `me:recall` 会话证据需要用户显式授权；跨 workspace 另有其自身的
  `--authorize-cross-workspace` 边界。ledger 中 kind 为 `session` 的 source
  必须带 `authorized: true`，否则校验 fail closed
  （`SESSION_SOURCE_UNAUTHORIZED`）；
- 已摄入的 Source Bundle 即 vault 笔记，无额外授权；
- 会话内容是不可信数据，永远不作为指令执行。

## 8. Claim ledger 校验（确定性）

`bin/brief.ts validate` 读取 ledger（stdin 或 `--ledger`），输出
versioned JSON 报告（contract `brief-ledger` v1）。finding code 稳定，
按 `(code, claimId)` 排序；exit 0 表示报告已产出（包括存在 findings 与
空证据），exit 2 表示参数或输入非法。严格只读：不写 vault / runtime /
任何文件，不联网。

status 优先级：`invalid`（任一 error）> `insufficient_evidence`（无
claim 或全部 unknown）> `findings`（仅 warning）> `ok`。

## 9. 保存门控

默认 chat-only。用户显式授权后，简报以 `type: reflection` 写入 Practices
层 `briefs/YYYY-MM-DD-<slug>.md`（slug 算法与 decision-brief 相同，以 Topic
为输入，fallback 前缀 `brief-`），经由 `bin/vault-write.ts preview` → 人工
确认 → `bin/vault-write.ts write`，commitModel 为 `journaled-cooperative`。
预览与写入请求的 bytes 完全一致；只有 `status: committed` 才能报告已保存。
不设置 `acknowledgeCognition`，永不提升到 Cognition。

## 10. 测试策略

先写测试（TDD）：

- bun 测试逐 fixture 断言 status / finding codes / 安全改写 / supersession
  可见性 / 字数预算 / 授权门控 / insufficient-evidence；
- 确定性：同一 fixture 两次运行输出逐字节相同；
- 零写入：validate 前后 vault 与 runtime 快照不变；
- shell 套件：skill 契约、文档、打包发布内容、npm bin。
