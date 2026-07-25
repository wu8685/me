# Decision Brief Skill 设计

**状态：** Approved
**日期：** 2026-07-25
**所属项目：** ME

## 1. 背景

ME 已能把外部材料沉淀为 raw、记录实践并管理 cognition，但尚未提供一个稳定流程，把知识库材料与最新外部事实组合成可执行、可证伪的决策。

用户的高频场景包括：

- 调研技术项目并判断是否投入；
- 比较多个实现或产品路线；
- 分析副业与创业机会；
- 将当前问题与历史实践、原则和外部事实结合。

本设计在公开 ME 中增加通用 `decision-brief` skill。私人原则、分析框架和路径不写入公共 Skill，而由每个 vault 的本地 Profile 提供。

## 2. 目标

1. 让任何 ME vault 都能使用统一的决策简报流程。
2. 在决策前检索 cognition、practices 和 raw。
3. 将 Fact、Interpretation、Inference、Assumption、Unknown 分开。
4. 将开放调研收敛为选项、反方、最小实验和失效条件。
5. 默认只输出到对话，避免自动污染 vault。
6. 允许 vault 本地 Profile 增加私人检索顺序与分析框架。
7. 通过 ME 双端插件同时服务 Claude Code 与 Codex。

## 3. 非目标

- 不替代投资、医疗、法律等领域专项协议。
- 不自动将判断写入 cognition。
- 不把某位用户的原则、经典偏好或私人路径写进公开仓库。
- 不强制所有简单查询执行完整决策流程。
- 不创建新的网页搜索引擎或向量数据库。
- 不要求 ahsir 或多 Agent 才能使用。

## 4. 形态

新增：

```text
skills/decision-brief/
├── SKILL.md
└── references/
    ├── evidence-contract.md
    └── output-contract.md
```

Skill 保持简洁，详细证据分类与输出契约按需读取。除非 baseline 测试证明存在确定性重复工作，v1 不新增脚本。

2026-07-26 的已批准增补（§19）已经由 write-safety probes 证明保存流程存在必须确定化
的重复工作，因此该句的“不新增脚本”条件已满足：新增的是公共 `vault-write` 工具，
不是 Decision Brief 专用脚本。

## 5. 触发

应触发：

- 用户需要在多个方案间作有分量的选择；
- 用户问某项投入是否值得；
- 用户希望调研一个新机制对自己或项目的含义；
- 用户讨论工作、生活、组织或产品决策；
- 用户要求形成 decision memo、决策简报或最小验证实验。

不应触发：

- 单个稳定事实查询；
- URL 摘录或资料入库；
- 已有批准 spec 的直接实现；
- 普通 debug；
- 只要求列出搜索结果；
- 对话中没有选择、行动或资源配置问题。

Skill description 只描述这些触发条件，不在 frontmatter 中概括完整流程。

## 6. Decision Contract

开始分析前建立以下 contract：

```text
Decision
Owner
Horizon
Reversibility
Constraints
Success signals
Worst acceptable outcome
```

规则：

- 缺失信息会实质改变决策时，询问用户；
- 缺失信息不影响当前方向时，写明假设后继续；
- 不用连续澄清问题拖延可逆决策；
- 不把未确认假设写成用户偏好。

## 7. 知识检索

默认顺序：

1. cognition：稳定原则、边界、已沉淀判断；
2. practices：历史实验、决策记录和反馈；
3. raw：原始来源与他人观点；
4. 最新外部事实。

使用当前 vault 的 `.me/config.yaml` 解析层目录。优先使用 ME search 能力；必要时使用文本检索。

引用要求：

- 本地判断必须链接具体笔记；
- 时间敏感笔记必须重新核验外部事实；
- 只在实际影响判断时报告“知识命中”；
- 没有命中时如实说明，不强行套用。

## 8. 本地 Decision Profile

公开 Skill 可读取可选配置：

```yaml
decision:
  profile: .me/profiles/decision-brief.md
```

Profile 只能位于 vault 内，负责增加：

- 特定 cognition 入口；
- 私人原则的读取门槛；
- 特定经典、案例或思想库的调用条件；
- 保存位置和复核偏好；
- 用户长期稳定的决策纪律。

Profile 不得：

- 覆盖 ME schema；
- 要求自动写入 cognition；
- 把推演声明为事实；
- 包含账号 secret；
- 修改公开 Skill 的高风险领域边界。

Profile 缺失时使用通用流程。

## 9. 外部调查

- 时效性事实必须使用当前外部来源核验；
- 技术问题优先官方文档、源码和论文；
- 市场评价、流行趋势或社会讨论按需使用近期社区材料；
- 明确区分一手来源、二手解释与社区意见；
- 无法核验的材料只作为 lead，不进入 Fact；
- 大规模重读是否 offload 由当前环境的能力和用户偏好决定，Skill 不绑定特定 worker。

## 10. 证据契约

每条关键主张属于以下一种：

| 类型 | 定义 |
| --- | --- |
| Fact | 来源直接支持且日期明确 |
| Interpretation | 对已知事实的解释 |
| Inference | 多项事实推出的阶段性判断 |
| Assumption | 当前决策暂时采用、尚未验证 |
| Unknown | 当前无法确认 |

要求：

- 推荐意见必须能追溯到 Fact、Interpretation 和 Assumption；
- 外部来源没有表达的结论不得包装成引用；
- 关键 Unknown 必须说明对决策的影响；
- 高置信度不能由材料数量代替。

## 11. 分析

### 11.1 主要矛盾

识别当前最影响结果的一对矛盾，并解释为什么其他问题是次要变量。只有本地 Profile 或 vault 确实命中相关框架时，才引用特定经典或史例。

### 11.2 选项

每个可行选项至少包含：

- 预期收益；
- 成本与机会成本；
- 关键风险；
- 依赖条件；
- 可逆性；
- 胜出信号；
- 出局信号。

### 11.3 反方

至少构造一个会使推荐方案失败的路径。反方必须挑战关键假设，而不是只列通用风险。

### 11.4 最小验证实验

优先提出能以最低成本区分核心假设真假的动作。不可逆决策必须先检查是否存在可逆试验。

## 12. 输出契约

```markdown
# 结论

一句话建议与当前置信度。

## 决策问题与假设

## ME 知识命中

## 最新事实

## 主要矛盾

## 选项比较

## 推荐理由

## 最小验证实验

## 失效条件

## 不确定性

## 复盘时间
```

输出要求：

- 结论在首屏；
- 事实带日期和来源；
- 本地笔记使用可定位链接；
- 推荐必须包含反方、失效条件和复盘时间；
- 若证据不足，输出“暂不决策”及需要补充的最小信息；
- 不用框架名装饰无关问题。

## 13. 落盘

默认不写 vault。

满足以下任一条件时才建议保存：

- 用户明确要求；
- 决策跨多周，需要持续跟踪；
- 已形成实际行动与复盘点；
- 用户明确要求记录为自己的原则。

保存规则：

- 阶段性决策进入 practices；
- 外部原始材料进入 raw；
- cognition 必须遵守当前 vault 的验证门槛；
- 用户自己的原则必须有明确确认，不能由 Agent 推断；
- 创建笔记后执行索引可达性与 backlinks 流程；
- 出现实际待办时遵守当前 vault 的 TODO 约定。

## 14. 与领域 Skill 的关系

当议题属于已有高风险或专项 Skill：

```text
领域 Skill / 项目规则
        ↓
Decision Brief 的证据与输出结构
```

领域规则优先。Decision Brief 可以提供结构，但不得放宽领域风控或授权外部动作。

## 15. 测试

实施遵循 Skill TDD：先运行无 Skill baseline，观察失败，再编写最小指导并复测。

### 15.1 Recognition

- 技术路线选择应触发；
- 副业机会判断应触发；
- 简单事实查询不应触发；
- URL 摘录应交给 ingest；
- 已批准 spec 的代码实现不应重新做决策分析。

### 15.2 Application

- 能从 ME vault 命中相关 cognition/practices；
- 能把最新事实与历史笔记分开；
- 能形成选项、反方和最小实验；
- 能在信息不足时写明 Assumption/Unknown；
- 能识别不可逆决策并优先寻找可逆试验。

### 15.3 Write gates

- 未要求保存时不写 vault；
- 用户要求保存阶段性决策时写 practices；
- 用户说“这是我的原则”但缺少 vault 门槛时不直接写 cognition；
- Profile 不存在时仍能完成通用 Decision Brief。

### 15.4 Privacy

- 公共测试不依赖 brain-spark；
- Skill 与 references 不包含私人路径、原则、持仓或账号；
- fixture Profile 使用虚构 vault。

## 16. 兼容与安装

- Skill 放入 ME 现有 `skills/`，由 `.codex-plugin/plugin.json` 暴露给 Codex；
- Claude 插件沿用 ME 现有 skill 自动发现；
- 新机器安装相同 ME 版本即可获得通用 Skill；
- 私人 Profile 随各自 vault 迁移，不随 ME 公共仓库发布；
- Profile 配置字段为可选，旧 vault 不受影响。

## 17. 验收标准

1. 在无 Profile 的最小 ME vault 中生成完整 Decision Brief。
2. 在配置 Profile 的 vault 中按 Profile 增加检索入口，但不泄漏 Profile 内容到公共产物。
3. 简单事实查询不会被升级成完整决策流程。
4. 技术选择能引用官方来源与本地历史实践。
5. 推荐包含反方、最小实验、失效条件和复盘时间。
6. 没有明确保存意图时不修改 vault。
7. 用户自己的原则不会被 Agent 自动创建。
8. Claude 与 Codex 安装同一 ME 插件后获得等价触发和输出契约。

## 18. 暂缓项

- FinOps 已有稳定 Automation，本轮不迁移到 Skill。
- graphyer 审美评审使用频率尚不足，本轮不创建 Skill。
- 小鹅通 extractor 等 Source Bundle v1 稳定后，在用户本地 vault 单独写 spec。

---

## 19. 2026-07-26 Approved Addendum：通用 Transactional Vault Writer

**状态：** Approved
**用户选择：** 实现 ME 公共、可安装、可复用的 deterministic transactional
vault writer；Decision Brief 只作为首个 practices 调用方，不在 Skill 内自造事务。

### 19.1 为什么新增通用 writer

Decision Brief 的保存需求不是特例。ingest、未来的 practice recorder，以及其他
需要创建结构化笔记的 Skill，都会重复遇到以下确定性问题：

- 从 `.me/config.yaml` 解析逻辑层；
- 校验 schema、template、目标路径和 symlink；
- no-clobber 创建笔记；
- 维护索引可达性；
- 发现 backlinks 与 unlinked mentions；
- 在并发编辑或中途失败时避免覆盖用户内容。

这些能力属于 ME 的公共工具层。Decision Brief 仍负责判断“是否获得保存授权、应该
进入哪一层、正文写什么”；writer 只负责验证并执行明确的 create request。

### 19.2 范围与非目标

v1 支持：

- logical layer：`raw`、`practices`、`cognition`，实际路径均由配置解析；
- 一次请求创建一篇 Markdown 笔记，并在必要时更新该 layer 根目录的
  `README.md`；
- `preview` 与 `write` 两种模式；
- schema/template 校验、no-clobber、索引可达性、link regression 检查和
  backlinks suggestions；
- cooperative lock、journal、并发冲突检测、ownership-aware rollback 和结构化
  manual recovery。

v1 不支持：

- 替换、合并或删除既有笔记；
- 自动提升 cognition，或替调用方判断保存授权；
- 自动插入 backlinks suggestions；
- 多篇笔记组成一个全有或全无的 filesystem transaction；
- 对恶意的同账号进程提供安全隔离；
- 声称在断电、kernel crash、network filesystem 或所有 Node 支持平台上具有
  database-style atomicity。

### 19.3 架构决策：单独模块，不重构 ingest finalizer

新增独立模块：

```text
bin/vault-write.ts
bin/vault-write/
├── contracts.ts
├── path-safety.ts
├── schema.ts
├── index.ts
└── transaction.ts
```

不让 v1 直接调用或重构 `bin/ingest/finalize.ts`。后者包含 raw ingest 专用的
artifact directory、media、handout、stem reservation 和 staging 语义；把它抽成
共享基类会扩大已经通过终审的 rich ingest 回归面。

writer 会复用已经验证过的原则，但重新实现更窄的通用 primitive，并以独立测试钉死：

- lexical + canonical containment；
- existing-prefix symlink 检查；
- exclusive create/cooperative lock；
- bytes + identity fingerprint；
- ownership-aware preservation；
- Markdown code-aware wikilink/mention scan。

待 writer 稳定后，是否让 ingest 迁移到这些 primitives 另开 spec。本轮不做。

### 19.4 配置、schema 与 template

writer 读取：

1. `{vault}/.me/config.yaml` 中 `layers.raw/practices/cognition`；
2. `{vault}/SCHEMA.md`；
3. 当前安装的 ME plugin 中 `templates/<layer>-template.md`。

三个输入都是 contract：

- layer 配置缺失时沿用 ME 既有默认值；
- 配置的 layer、`.me`、`SCHEMA.md`、target parent、README 和所有已存在 path
  prefix 必须同时通过 lexical 与 canonical containment；
- dangling symlink、逃逸 symlink、非普通文件或无法 canonicalize 均 fail closed；
- `SCHEMA.md` 必须包含 `LOCKED` 标记，并能无歧义解析 core/per-layer field table；
- template frontmatter 的字段集合必须与 schema 对该 layer 允许的字段兼容；
- 请求 Markdown 的 frontmatter 必须只含 schema 字段、必填字段齐全、类型与
  controlled vocabulary 合法；禁止 duplicate key、YAML alias/tag、mapping/对象型
  scalar 和 schema 未声明字段；
- raw 的 `source` 必须是 HTTP(S) URL；practices/cognition 的 `source` 必须是
  单条非空字符串，若是 wikilink则必须通过 link validation；
- cognition 请求额外要求 `acknowledgeCognition: true`。这只是防误操作，不等于
  语义验证；调用 Skill 仍必须先满足 vault 自己的 cognition 门槛。

若 vault schema 与当前安装 template 不兼容，writer 不猜测、不迁移，返回
`validation_failed`。schema/template 文件自身不会被 writer 修改。

### 19.5 Request contract

CLI 从 stdin 接收 UTF-8 JSON；也可通过 `--request` 读取文件，但该文件必须位于当前
vault 的 `.me/tmp/` 内。Markdown 不放进 argv，避免被 shell history 和 process list
记录。

```ts
interface VaultWriteRequestV1 {
  version: 1;
  layer: 'raw' | 'practices' | 'cognition';
  relativePath: string;       // relative to configured layer root
  markdown: string;           // complete frontmatter + body
  index: { mode: 'auto' };    // v1 only
  acknowledgeCognition?: boolean;
}
```

约束：

- `relativePath` 使用 `/`，必须以 `.md` 结尾；
- 每个 component 非空且不是 `.`/`..`，不得含 `\`、NUL、control character；
- basename 必须为 `YYYY-MM-DD-kebab-slug.md`，frontmatter `created` 必须与日期
  prefix 一致；
- stem 必须在三层 vault 内 case-fold 后唯一，防止 Obsidian 与大小写不同 filesystem
  出现含混链接；
- target 必须不存在。v1 没有 overwrite/force 选项；
- body 必须非空，Markdown image/link 不能引用 vault 外绝对路径或 traversal path；
- request 最大 4 MiB；超限在任何 staging 或 target mutation 前拒绝。

### 19.6 CLI 与 JSON result

```bash
bun run bin/vault-write.ts preview --vault-dir <vault> < request.json
bun run bin/vault-write.ts write   --vault-dir <vault> < request.json
bun run bin/vault-write.ts preview --vault-dir <vault> --request .me/tmp/request.json
bun run bin/vault-write.ts write   --vault-dir <vault> --request .me/tmp/request.json
```

stdout 永远只输出一个 JSON object；人类诊断不得混入 stdout。exit code：

- `0`：`preview` 或 `committed`；
- `2`：input/config/schema validation；
- `3`：lock/conflict；
- `4`：`manual_recovery`；
- `5`：当前 filesystem 不支持所需 primitive，且尚未写 target；
- `1`：经过 redaction 的其他内部错误。

```ts
type VaultWriteStatus =
  | 'preview'
  | 'committed'
  | 'validation_failed'
  | 'conflict'
  | 'unsupported'
  | 'manual_recovery';

interface VaultWriteResultV1 {
  version: 1;
  status: VaultWriteStatus;
  operationId: string;
  commitModel: 'preview-only' | 'journaled-cooperative';
  requestDigest: string;
  notePath?: string;          // vault-relative POSIX path only
  changedPaths: string[];
  plannedPaths: string[];
  indexAction: 'none' | 'create' | 'replace';
  backlinks: Array<{ path: string; count: number }>;
  unlinkedMentions: string[];
  warnings: string[];
  error?: { code: string; message: string };
  recovery?: {
    directory: string;        // always under .me/tmp, vault-relative
    journal: string;
    preservedPaths: string[];
    remainingMutations: string[];
    actions: Array<{
      kind: 'inspect' | 'compare' | 'restore' | 'remove-owned';
      path: string;
      from?: string;
      condition: string;
    }>;
  };
}
```

结果不得回显 Markdown、frontmatter、绝对 vault path、用户名、home path、环境变量、
command stderr、secret-looking value 或原始 exception message。`message` 来自固定的
public error catalog；详细 path、fingerprint 与内部 error 只写入权限受限的本地
journal。

### 19.7 Preview

`preview`：

- 执行完整的 config/path/schema/template/duplicate/link/index/backlink plan；
- 只在内存中生成 proposed note 和 README bytes；
- 不创建 lock、`.me/tmp`、target directory、note 或 README；
- 返回 `commitModel: preview-only`、`changedPaths: []` 和确定的
  `plannedPaths/indexAction`；
- 明确包含 warning：preview 是 point-in-time plan，不能为后续 write 保留目标。

相同 vault snapshot 与相同 request 必须得到相同的 planned paths、index bytes
digest、backlinks 和 mentions；`operationId` 与时间字段不参与该断言。

### 19.8 索引可达性与 backlinks

writer 在写前扫描配置的三层 Markdown：

1. 忽略 frontmatter、inline code、正确配对的 fenced code、`.me/tmp` 与 writer
   recovery；
2. 如果已有有效 `[[stem]]` 入链，则 `indexAction: none`；
3. 否则固定更新 `{configured-layer-root}/README.md`，不根据遍历顺序选择别的
   README；
4. 在 README 的 managed block 中维护按 Unicode code point 排序的
   `- [[stem]]`：

```markdown
<!-- me:index:start -->
- [[2026-07-26-example]]
<!-- me:index:end -->
```

已有且格式合法的 managed block 被规范化；没有 block 时在保留原文 exact bytes 的
前提下追加一个 block；重复、嵌套或 malformed marker 导致 validation failure。

写后使用 ME native wikilink graph 做 no-regression validation：

- note 通过既有 backlink 或 layer README 的 managed link 可达；
- 新 note 不进入 orphan set；
- operation 不新增 broken wikilink；
- README 只发生计划内变化。

backlinks 和 unlinked mentions 只作为结果建议返回，不修改其他笔记。

### 19.9 Transaction model

#### Cooperative lock

`write` 首先以 Node `open(..., 'wx')` 创建
`.me/locks/vault-write.lock`。它只串行化遵守同一协议的 writer：

- lock 内容只有 version、operationId、startedAt；
- lock path 与 `.me` 先做 symlink containment；
- 已存在 lock 返回 `conflict/LOCK_HELD`；
- v1 不自动删除“看似过期”的 lock。crash journal/lock 由 recovery result 指引，
  避免误杀仍在运行的 writer。

#### Staging and publish

所有 request copy、staged note、staged README、journal、original/recovery bytes
只能位于：

```text
.me/tmp/vault-write-<operationId>/
```

目录 mode 尽力设为 `0700`，文件 `0600`。writer 拒绝 `.me/tmp` symlink 逃逸。target
parent 只在持锁后创建，并追踪 writer 创建的空目录。

笔记 create 使用完成写入并 fsync 的 staged file，通过 Node `link` 发布到不存在的
target。`link` 提供单个 directory entry 的 no-clobber create；writer 先验证 staging
与 target 在同一 device，并对 `EXDEV`/`EPERM` 等返回 `unsupported`，不得退化成
check-then-write、copy 或可覆盖 rename。

README create 同样使用 staged file + `link` no-clobber。

README replace 不声称 Node 提供 atomic compare-and-swap。writer 使用 journaled
preservation：

1. snapshot README identity、bytes 与 metadata；
2. final compare；
3. 把当前 README `rename` 到 operation recovery directory 中一个保证未使用的
   original path——此操作移动当前 directory entry，而不是用 staged bytes覆盖它；
4. 立即验证被移动的 original 仍等于 snapshot；不等则先安全恢复或返回
   `manual_recovery`；
5. 用 staged hard link no-clobber 创建新 README；
6. 校验 ownership fingerprint 和 vault invariants。

旧 README inode 在成功后也保留在 operation recovery directory，不立即删除。这样，
在 rename 前已打开该 inode 的外部 editor 即使稍后写入，其 bytes 仍有保存位置。
结果通过 warning 和 `recovery.directory` 报告 retained original；后续 cleanup 不在
v1 自动执行。

#### Ownership-aware rollback

每个 operation-written target 都记录 publish 后 fingerprint。失败时：

- 只有 current fingerprint 仍等于 operation-owned fingerprint 才能 remove/restore；
- 不相等即视为外部内容，原地保留或移动到 recovery，绝不覆盖/删除；
- 恢复 original 也只能通过 no-clobber create；若目标已被外部创建，双方都保留；
- writer 自己创建的空目录只有在仍为空时才删除；
- 任一 target 无法证明 ownership、journal 状态不确定或恢复不完整，返回
  `manual_recovery`，列出 remaining mutations 和条件化 actions；
- 只有所有 target 恢复且无外部内容被移动出其原有效路径时，才能返回
  `conflict`/`validation_failed` 而不附 manual recovery。

#### Crash honesty

多文件操作没有 database-style atomic commit point。journal 在每个 mutation 前后
fsync，并记录 state machine：

```text
planned -> locked -> staged -> note-published -> index-preserved
-> index-published -> validated -> committed
```

启动 `write` 时发现非 `committed` journal 或 lock，writer 不自动猜测恢复，返回
`manual_recovery/INCOMPLETE_OPERATION`。`committed` 只表示本次运行完成全部计划写入、
ownership 校验与 post-validation；result 固定写
`commitModel: journaled-cooperative`，绝不使用 `atomic: true`。

### 19.10 Tested guarantees

writer 的公开保证严格限定为：

- 在支持同 filesystem hard link 和 exclusive create 的本地 filesystem 上，planned
  note/README create 不会覆盖已存在 path；
- 在 test hooks 覆盖的 snapshot 后、publish 前、index preserve 前后、post-validation
  前并发 create/edit/replace 中，不静默覆盖或删除外部 bytes；
- 冲突内容保留在原 path 或明确报告的 `.me/tmp` recovery path；
- 无法证明完整恢复时输出结构化 `manual_recovery`；
- 成功前执行 schema、template、link、index 和 ownership post-validation。

不保证：

- lock 能阻止不合作的外部工具；
- 整组 files 对其他 reader 瞬时可见；
- network/FUSE filesystem 遵守本地 filesystem 的 hard-link/rename 语义；
- directory `fsync` 在所有 Node 平台可用；
- power loss 后自动恢复；
- retained original 中的外部编辑会自动 merge 回新 README。

### 19.11 Decision Brief integration

Decision Brief 明确保存阶段性判断时：

1. Skill 生成符合 practices schema/template 的完整 Markdown；
2. 先调用 `preview`，向用户/Agent 暴露 target、index action 和 validation；
3. 已有明确保存授权时，用同一 request 调用 `write`；
4. 只有 `status: committed` 才报告已保存；
5. `conflict`、`unsupported`、`validation_failed` 均报告 `not written`；
6. `manual_recovery` 原样报告 preserved paths、remaining mutations 与 actions，不得
   简化成“已回滚”；
7. Skill 不设置 `acknowledgeCognition`，Decision Brief v1 自动落盘只到 practices。

### 19.12 新增验收标准

1. 在自定义 practices 路径的 vault 中 preview 与 write 都解析到正确 layer。
2. practices note 与 layer README 形成可达入链，且不新增 broken link。
3. target 已存在、大小写 stem 冲突、path traversal、symlink escape 均无 target
   mutation。
4. schema/template mismatch 与非法 YAML field/type 在 publish 前失败。
5. concurrent target create、README edit、README atomic replace、post-publish note
   edit 全部保留外部 bytes。
6. rollback 无法证明 ownership 时返回结构化 manual recovery。
7. preview 对 vault 为零写入。
8. stdin/JSON output 不泄漏 Markdown、绝对路径、用户名或 secret-like input。
9. hard link 不可用时 fail closed 为 `unsupported`，不降级到覆盖性 primitive。
10. Decision Brief 只在 writer 返回 `committed` 时声称 saved。
