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
├── graph.ts
├── index.ts
└── transaction.ts
templates/schema-profiles/
└── me-schema-v1.json
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

### 19.4 Machine-readable schema profile、配置与 template

writer **不解析 `SCHEMA.md` prose 或 Markdown table**。公共插件新增
`templates/schema-profiles/me-schema-v1.json`，它是当前 LOCKED schema revision 的
唯一 machine-readable contract：

```json
{
  "id": "me-schema-v1",
  "revision": 1,
  "schemaDocumentSha256": [
    "9894ec60c4c7e583a215938ec71186e8a12d24eaedc6dc96a42e2a4aa24480b5"
  ],
  "templateSha256": {
    "raw": "28e24f3e835c3a34a123c4ef8082abfcef8cfdcce3a913371869dbc9e6f2a4d4",
    "practices": "ad169bbe8a74d5be0fa615eeae436380e8eb75dc8f4a3342df50482d7608323b",
    "cognition": "a8084f5b1a601cdcdf1460247fa82bdb9fc2b24281ecca5fc48a0e3d32338a7b"
  },
  "core": {
    "title":  { "type": "string", "required": true, "minLength": 1 },
    "created": { "type": "date", "required": true, "format": "YYYY-MM-DD" },
    "tags": {
      "type": "string-list",
      "required": true,
      "unique": true,
      "itemPattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    },
    "type":   { "type": "enum", "required": true },
    "source": { "type": "string", "required": true, "minLength": 1 }
  },
  "layers": {
    "raw": {
      "types": ["article", "concept"],
      "source": { "kind": "http-url", "schemes": ["http", "https"] },
      "extensions": {}
    },
    "practices": {
      "types": ["experiment", "reflection"],
      "source": { "kind": "existing-path-qualified-wikilink" },
      "extensions": {
        "project": { "type": "string", "required": false, "allowEmpty": true }
      }
    },
    "cognition": {
      "types": ["insight"],
      "source": { "kind": "existing-path-qualified-wikilink" },
      "extensions": {
        "confidence": {
          "type": "enum",
          "required": true,
          "values": ["low", "medium", "high"]
        }
      }
    }
  }
}
```

实施时 JSON 必须包含以上 exact semantics；property ordering/indentation 不属于
contract。profile loader 拒绝 unknown profile key、unknown field type 和 unknown
revision。

writer 读取并 fingerprint：

1. `{vault}/.me/config.yaml` 中 `layers.raw/practices/cognition`；
2. `{vault}/SCHEMA.md` 的 exact bytes；
3. 当前插件的 `me-schema-v1.json`；
4. 当前插件的 `templates/<layer>-template.md`。

`SCHEMA.md` SHA-256 必须出现在 profile 的 `schemaDocumentSha256`，selected template
SHA-256 必须 exact match `templateSha256[layer]`。不支持的 schema revision、用户修改
过的 LOCKED schema、未来 schema 或 template drift 一律
`validation_failed/UNSUPPORTED_SCHEMA`，提示先运行 ME upgrade；writer 不猜版本、
不迁移、不从 prose 推导。将来 schema 变化必须发布新的 profile/revision 与明确
migration。

path-qualified wikilink 的规范形式为
`[[<vault-relative-posix-path-without-.md>]]`，例如
`[[knowledge/raw/2026-07-25-source-note]]`。schema `source` 不接受 basename-only link、
alias、heading、block、`.md` suffix、absolute path 或 traversal；它必须 exact resolve
到一个已存在、contained、普通 Markdown file。

请求 frontmatter 必须只含 profile 字段、必填字段齐全、类型/enum/source semantics
合法；禁止 duplicate key、YAML alias/tag、mapping/对象型 scalar 和未声明字段。
cognition 请求额外要求 `acknowledgeCognition: true`；这只是防误操作，不替代调用
Skill 的语义门槛。

### 19.4.1 Layer 与内部目录拓扑

layer 配置缺失时沿用 ME 默认值，但 resolved layout 必须满足：

- raw/practices/cognition 三个 root 都已存在且 canonical target 是 directory；
- layer-layer matrix：任意两个 lexical roots 或 canonical roots 都不能 equal，也不能
  互为 strict ancestor/descendant；三层只能是 disjoint sibling subtrees；
- layer-vault matrix：layer 必须是 vault root 的 strict descendant；等于 vault root
  或位于 vault 外都拒绝；
- layer-reserved matrix：layer 与 `.me` 不能 equal，layer 不能是 `.me` 的 ancestor，
  `.me` 也不能是 layer 的 ancestor；这同时排除 config、tmp、locks 和所有
  operation/recovery。对 root `SCHEMA.md` file，layer 不能 equal，也不能是该 file 的
  lexical ancestor；`SCHEMA.md/...` 这种 file-descendant path亦拒绝；
- **内部 nesting 是有意允许的**，不应用 layer overlap rule：

```text
vault/.me/
├── config.yaml
├── locks/
│   └── vault-write.lock
└── tmp/
    └── vault-write-<operationId>/
        ├── journal.json
        └── originals/
```

  `.me` ancestor of tmp/locks、tmp ancestor of operation、operation ancestor of
  originals 都合法；tmp 与 locks 必须彼此 disjoint；
- `.me` 必须是 vault 内已存在的 real directory，不接受 symlink；`tmp`/`locks`
  缺失时可在 write 的 pre-lock bootstrap 以 tracked mkdir 创建（preview 不创建），
  存在时必须是 contained real directory；
- config、schema、target parent、README、lock、staging、journal、original/recovery
  和每个 existing prefix 都同时通过 lexical/canonical containment；
- dangling symlink、逃逸 symlink、non-directory layer、reserved/root target 或无法
  canonicalize 均 fail closed。

这些约束在 preview、持锁后、每个 mutation boundary 和 post-validation 都重验。

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
  unlinkedMentions: Array<{
    path: string;
    count: number;
    offsets: number[];        // zero-based UTF-8 byte offsets in original file
  }>;
  warnings: string[];
  error?: { code: string; message: string };
  recoveryState: 'none' | 'retained-originals' | 'incomplete';
  recoveries: Array<{
    operationId: string;
    state:
      | 'retained-original'
      | 'incomplete-operation'
      | 'unrecognized-operation'
      | 'ownership-conflict';
    directory: string;        // always under .me/tmp, vault-relative
    journal?: string;
    preservedPaths: string[];
    remainingMutations: string[];
    actions: Array<{
      kind: 'inspect' | 'compare' | 'restore' | 'remove-owned';
      path: string;
      from?: string;
      condition: string;
    }>;
  }>;
}
```

结果不得回显 Markdown、frontmatter、绝对 vault path、用户名、home path、环境变量、
command stderr、secret-looking value 或原始 exception message。`message` 来自固定的
public error catalog；详细 path、fingerprint 与内部 error 只写入权限受限的本地
journal。多个未完成 operation 必须聚合进 `recoveries[]`，不得只返回扫描到的第一
项；`recoveryState` 是数组的 aggregate state。

固定 error catalog 随 `contracts.ts` 实现，不留到 CLI 临时决定：

| Code | Status | Exit | Public message |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | validation_failed | 2 | Request does not match vault-write v1. |
| `INVALID_CONFIG` | validation_failed | 2 | Vault layer configuration is invalid. |
| `UNSAFE_PATH` | validation_failed | 2 | A required path is outside the safe vault layout. |
| `UNSUPPORTED_SCHEMA` | validation_failed | 2 | Vault schema revision is not supported by this ME version. |
| `INVALID_NOTE` | validation_failed | 2 | Note does not match the selected schema profile. |
| `DUPLICATE_STEM` | conflict | 3 | A note with this stem already exists. |
| `TARGET_EXISTS` | conflict | 3 | The requested target already exists. |
| `LOCK_HELD` | conflict | 3 | Another vault-write operation may still be active. |
| `INPUT_CHANGED` | conflict | 3 | Vault inputs changed after planning; nothing new was published. |
| `UNSUPPORTED_FILESYSTEM` | unsupported | 5 | Filesystem cannot provide the required no-clobber primitive. |
| `POST_VALIDATION_FAILED` | validation_failed | 2 | Post-write validation failed and owned changes were restored. |
| `INCOMPLETE_OPERATION` | manual_recovery | 4 | One or more incomplete operations require inspection. |
| `RECOVERY_REQUIRED` | manual_recovery | 4 | Conflicting content was preserved; manual recovery is required. |
| `INTERNAL_ERROR` | validation_failed | 1 | Vault write could not complete safely. |

`INTERNAL_ERROR` 只有在确定零 target mutation 时使用；一旦 mutation state 不明，
必须改用 `RECOVERY_REQUIRED`/manual_recovery/exit 4。

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

writer 新增自己的 `bin/vault-write/graph.ts`。v1 不修改或依赖既有
`wikilink-graph.js`，避免改变 checklinks/backlinks 的历史行为。scanner contract：

- 只递归扫描三个 validated layer roots；每个 directory entry 和 existing prefix 都
  做 symlink containment，dangling/escaping link fail closed；
- frontmatter、inline code、正确配对的 fenced code 不参与 wikilink/mention；
- `.me`、staging、journal、recovery 永远不进入 graph；
- `README.md` 是 index document：它的 wikilink可形成入链，但它不作为 note 参与
  duplicate-stem、orphan 或 unlinked-mention suggestion；
- note stem 按 Unicode simple case fold 比较，三层中任何 duplicate 都
  `DUPLICATE_STEM`，即便所有 link 已 path-qualified；
- graph 可读取 `[[target]]`、`[[target|alias]]`、`[[target#heading]]`、
  `[[target#^block]]`。含 `/` 的 target 按 vault-relative POSIX path exact resolve；
  basename-only target 只有在全 vault 唯一时可 resolve，否则是 ambiguous/broken；
- writer 自己生成的 source/index link 永远使用不带 alias/fragment/`.md` 的
  path-qualified form；
- backlink count 是同一 source document 的 resolved wikilink 实际出现次数；
- unlinked mention 在 code/frontmatter mask 后扫描：title 使用 exact Unicode
  code-point sequence，ASCII stem 使用 ASCII case-insensitive match；已处于 wikilink
  span 的 occurrence 排除，同一 byte span 同时匹配 title/stem 时只计一次；
- `offsets` 是 original UTF-8 file bytes 的 zero-based start offsets，升序且去重；
  `count === offsets.length`；
- backlinks 与 unlinkedMentions 都先按 vault-relative POSIX path code-point sort；
  offsets 升序。不依赖 filesystem enumeration order。

写前：

1. 如果已有 resolved 入链指向 planned path，则 `indexAction: none`；
2. 否则固定更新 `{configured-layer-root}/README.md`；
3. managed entry 始终使用 **vault-relative** path-qualified link，不随 README
   所在目录改变解析基准。例如 target 为
   `knowledge/practices/decisions/2026-07-26-orchid-choice.md`，README 写
   `[[knowledge/practices/decisions/2026-07-26-orchid-choice]]`；custom layer
   `实验记录` 则写 `[[实验记录/decisions/2026-07-26-orchid-choice]]`；
4. managed block 按 normalized target code point 排序：

```markdown
<!-- me:index:start -->
- [[knowledge/practices/decisions/2026-07-26-example]]
<!-- me:index:end -->
```

已有且格式合法的 managed block 被规范化；没有 block 时在保留原文 exact bytes 的
前提下追加一个 block；重复、嵌套或 malformed marker 导致 validation failure。

写后重新运行同一个 writer-owned scanner 做 no-regression validation：

- note 通过既有 backlink 或 layer README 的 managed link 可达；
- 新 note 不进入 orphan set；
- operation 不新增 broken wikilink；
- README 只发生计划内变化。

backlinks 和 structured unlinked mentions
`{path,count,offsets}[]` 只作为结果建议返回，不修改其他笔记。

### 19.8.1 Markdown destination grammar

writer 对 request Markdown fail closed，只接受：

- 普通文本与 CommonMark fenced/inline code；
- writer-owned scanner 支持的 Obsidian wikilink；
- inline Markdown link/image：`[label](destination)`、
  `![alt](destination)`，destination 可为 `<...>` 或支持反斜线 escape 与 balanced
  parentheses 的 unwrapped form；v1 不接受 optional title；
- normal link 的 `https://`/`http://` remote destination；
- fragment-only normal link（`#heading`）；
- contained、已存在的 vault-local relative destination；local fragment 可保留。

明确拒绝：

- full/collapsed/shortcut reference link 与 reference definition；
- raw HTML、HTML `<a>/<img>`、HTML/autolink；
- Obsidian embed `![[...]]`；
- remote image；
- `file:`、`data:`、`javascript:` 或其他 scheme；
- protocol-relative、absolute/drive/UNC path；
- local query string、empty destination、control character、NUL、unbalanced destination；
- local path 的 `.`/`..`、backslash 或 encoded traversal/separator。

校验 destination path 时先拆 fragment，再对 path component 反复
`decodeURIComponent` 直至稳定（最多 4 轮）。每轮先拒绝 encoded `/` 或 `\`
（`%2f/%5c`，case-insensitive），decode 后同时按 `/`/`\` 检查 component；任一轮产生
`.` 或 `..` component 即拒绝。`%25` 本身不是错误，但必须继续 decode，若最终形成
encoded separator/dot traversal则拒绝；invalid escape 或第 4 轮后仍会变化也拒绝。
因此 `file%2emd` 可解析为普通 filename，而 `%2e%2e`、`%252e%252e`、
`a%2fb`、`a%255cb` 均拒绝。解析后的 local path 必须通过 lexical/canonical
containment并 exact resolve 到普通 file。Markdown link grammar 与 frontmatter
`source` grammar 是两个独立 contract；source 仍只能使用 §19.4 的 path-qualified
wikilink。

local Markdown destination 的相对基准固定为 **planned note parent directory**，不是
process cwd、vault root、layer root 或 README parent。schema validator 因而必须同时
接收 `ResolvedVaultLayout` 与 absolute planned note path；先相对 planned parent
resolve，再做 vault containment与 file existence/type validation。

### 19.9 Transaction model

#### Cooperative lock

`write` 按固定顺序处理全局状态：validate internal layout → inspect lock → 若无 lock
则扫描 incomplete journals → 以 Node `open(..., 'wx')` 创建
`.me/locks/vault-write.lock`。最后一步的 `EEXIST` 仍映射为 `LOCK_HELD`。lock 只
串行化遵守同一协议的 writer：

- lock 内容只有 version、operationId、startedAt；
- lock path 与 `.me` 先做 symlink containment；
- **只要 lock 存在，永远先返回 `conflict/LOCK_HELD`**；即使同时发现 incomplete
  journal 也不把可能仍 active 的 operation 宣布为 recovery；
- 仅在 lock 不存在时扫描 `.me/tmp` 中名字以 `vault-write-` 开头的**每一个**
  directory entry。valid non-committed journal 以及任何 unrecognized entry 都阻止
  新 write，并全部聚合到 `recoveries[]`；
- v1 不用 PID、mtime 或“过期”猜测自动删除 lock/journal；
- release 时 close 自己的 fd 后，只有 lock 的 lstat identity、bytes 和 operationId
  仍等于 acquisition fingerprint 才能 unlink。changed/replaced lock 视为外部内容，
  保留并返回 `manual_recovery/RECOVERY_REQUIRED`。

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

staging/journal/request copy 为 `0600` 且受 `0700` directory 保护。publish 前把 staged
note mode 调整为 `0666 & ~process.umask()`；hard link 后 target 继承该 mode。writer
不承诺保留 request 指定的 mode、uid/gid、ACL、xattr 或 timestamps。

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

新建 README mode 为 `0666 & ~process.umask()`。替换既有 README 时，staged README
在 publish 前复制原文件的 POSIX permission bits (`mode & 0o777`)；不复制
uid/gid、ACL、xattr、birthtime/mtime，并在 result warning 明确该 metadata policy。
原 README inode/metadata仍保存在 operation recovery。

旧 README inode 在成功后也保留在 operation recovery directory，不立即删除。这样，
在 rename 前已打开该 inode 的外部 editor 即使稍后写入，其 bytes 仍有保存位置。
结果通过 warning、`recoveryState: retained-originals` 与 `recoveries[]` 报告。

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

startup 的**唯一 precedence** 是：existing lock → `LOCK_HELD`；no lock + operation
scan issue → aggregate `INCOMPLETE_OPERATION` manual recovery；两者都没有才允许 acquire
lock。

operation scan 对以下每个 `vault-write-*` entry 都创建
`state: unrecognized-operation` recovery，保留原 entry、不 follow symlink、不自动
rename/delete：

- entry 是 symlink、非 directory 或 unreadable；
- `journal.json` missing、symlink、非普通文件、unreadable、malformed JSON；
- journal version/operationId/state unknown，directory name 与 operationId 不匹配；
- state 不在 `planned|locked|staged|note-published|index-preserved|index-published|
  validated|committed`；
- duplicate operationId 或相互矛盾的 path/state。

valid non-committed journal 使用 `state: incomplete-operation`；recognized committed
directory 不阻止 write。missing/malformed journal 时 recovery 的 `journal` 省略。
所有 problematic entries 按 vault-relative POSIX path排序后完整返回，不能只取第一
个。`committed` 只表示本次运行完成全部计划写入、ownership 校验与
post-validation；result 固定写
`commitModel: journaled-cooperative`，绝不使用 `atomic: true`。

#### Plan fingerprint 与 mutation-boundary revalidation

preview/write plan 产生 `PlanFingerprintV1`，至少包括：

- request digest；
- config bytes + lstat identity；
- selected schema profile bytes/hash、vault SCHEMA bytes/hash、selected template
  bytes/hash + identities；
- writer-owned graph 的每个 input：vault-relative path、dev/ino/type/mode/size/
  mtimeNs/ctimeNs/content SHA-256，按 path 排序；
- layer roots、`.me`、tmp、locks、target parent existing-prefix、target absent state、
  README bytes/identity；
- planned note/index bytes digest。

获得 lock 后重新 plan；`afterLock`/`afterStaging` 之后且**第一次 publish 前**必须重读
所有 fingerprint input，任何差异返回 `conflict/INPUT_CHANGED` 且零 target mutation。
note publish 后、index preserve/publish 前，允许 operation-owned expected change，其余
input 仍必须匹配；若变化，按 ownership rollback/manual recovery 处理。post-validation
再次 fingerprint config/profile/schema/template/graph/README/path identities，并确认
只有 planned changes。

每次 `link`、`rename`、`unlink`、`mkdir`、`rmdir` 前立即重跑该 source/destination 及
existing parent chain 的 lexical/canonical containment。不能只依赖 plan-time check。
test-only `beforeFsMutation(kind, paths)` 在每次真实 mutation 的最终 check 前、紧邻 fs
call 触发；kind 为 `link|rename|unlink|mkdir|rmdir`，link/rename paths 固定为
`[source,destination]`，其余为 `[target]`。测试通过该 hook 在五类 mutation window
替换 parent/symlink/destination，证明没有未覆盖的 fs call。production CLI 不接受
hook。

#### Commit cleanup 与 retained recovery

commit 不能把 sensitive staging hardlink 留在 `.me/tmp`：

1. 对 staged note/README 与 published target 比较 dev+ino、content fingerprint 和
   expected link count；
2. 只有 target 仍是 operation-owned inode、staged path 指向同 inode且 `nlink >= 2`
   时才 unlink staged name；
3. unlink 后重验 published target仍存在且 ownership unchanged；
4. operation-owned request copy、rendered Markdown copy 和 transient fingerprint
   files只有 identity/content仍匹配时才删；
5. staged path 已变化、是最后 link、target 被 replace 或 cleanup ownership 不明时，
   保留内容并返回 `manual_recovery`，不得以“只是 temp”删除。

successful operation directory最终只允许保留：

- sanitized minimal `journal.json`（operationId、state、relative paths、hash、metadata
  policy，不含 request Markdown/frontmatter/secret/raw exception）；
- replace README 的 `originals/README.md`。

`recoveries[].actions` 对 retained original 至少包含：

- `inspect` original 与 current README；
- `compare` current expected committed digest；
- `remove-owned` retained original，仅当用户确认 current README 含所需内容、original
  不含待合并外部编辑。

v1 不自动 cleanup retained original；文档提供条件化 guidance，不给无条件 recursive
delete command。

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

1. Skill 只生成 practices `type: reflection`：Decision Brief 记录的是当前判断和行动
   依据，尚未执行 `最小验证实验`，因此不是 `experiment`；
2. `source` 必须是本次简报实际使用的、已存在且通过 scanner resolution 的
   path-qualified wikilink。多个来源时选择对推荐影响最大的 primary local note，
   其余放正文；若没有合法 local provenance，先 ingest raw 或保持 chat-only，明确
   `not written`，不得用空字符串、当前 note 自链、虚构 link 或 remote URL 绕过
   practices profile；
3. target 固定为 configured practices layer 下
   `decisions/YYYY-MM-DD-<slug>.md`。slug 的唯一 input 是 Decision Contract
   `Decision` field 的原始 string，不含 owner、日期、brief body 或 writer request。
   精确算法：

```ts
const normalizedTitle = decision
  .normalize('NFKC')
  .trim()
  .replace(/\p{White_Space}+/gu, ' ')
  .toLowerCase();
const ascii = normalizedTitle
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60)
  .replace(/-+$/g, '');
const slug = ascii || `decision-${
  sha256(Buffer.from(normalizedTitle, 'utf8')).slice(0, 12)
}`;
```

   `.toLowerCase()` 使用 ECMAScript locale-independent mapping，不用
   `toLocaleLowerCase`。empty/全中文/全符号 title 都按 normalized UTF-8 title hash，
   不使用 requestDigest。existing path 或 case-fold stem collision 返回 conflict，
   不自动加 `-2`、重新 hash 或改写别的文件；
4. frontmatter `project` 仅在 Decision Contract 有明确项目时填写 path-qualified
   wikilink/plain string，否则使用 template 允许的 empty string；
5. 先调用 `preview`，向用户/Agent 暴露 target、index action 和 validation；
6. 已有明确保存授权时，用同一 request 调用 `write`；
7. 只有 `status: committed` 才报告已保存；
8. `conflict`、`unsupported`、`validation_failed` 均报告 `not written`；
9. `manual_recovery` 原样逐项报告全部 `recoveries[]` 的 state、preserved paths、
   remaining mutations 与 actions，并报告 aggregate `recoveryState`；不得只报第一项
   或简化成“已回滚”；
10. Skill 不设置 `acknowledgeCognition`，Decision Brief v1 自动落盘只到 practices。

### 19.12 新增验收标准

1. 在自定义 practices 路径的 vault 中 preview 与 write 都解析到正确 layer。
2. practices note 与 layer README 形成可达入链，且不新增 broken link。
3. target 已存在、大小写 stem 冲突、path traversal、symlink escape 均无 target
   mutation。
4. unsupported SCHEMA fingerprint/profile revision、template fingerprint mismatch 与
   非法 YAML field/type 在 publish 前失败；runtime 不解析 SCHEMA prose。
5. concurrent target create、README edit、README external rename replacement、post-publish note
   edit 全部保留外部 bytes。
6. rollback/lock release/staging cleanup 无法证明 ownership 时返回聚合的结构化
   `recoveries[]`；既有 lock 始终只报 `LOCK_HELD`。
7. preview 对 vault 为零写入。
8. stdin/JSON output 不泄漏 Markdown、绝对路径、用户名或 secret-like input。
9. hard link 不可用时 fail closed 为 `unsupported`，不降级到覆盖性 primitive。
10. Decision Brief 只在 writer 返回 `committed` 时声称 saved。
11. 重叠/nested/duplicate layer roots、reserved/internal overlap、non-directory root
    全部在 mutation 前拒绝。
12. config/schema/profile/template/graph/README/path identity 在 first publish 前与
    post-validation 重验，四个 hook boundary 的变更均被检测。
13. Decision Brief practices note 固定为 reflection、path-qualified existing source
    和 deterministic `decisions/` target；无 provenance 或 collision 时 not written。
14. managed index 对 default/custom layer 都生成 full vault-relative link；local
    Markdown destination 相对 planned note parent resolve。
15. 每种 fs mutation 都经过 `beforeFsMutation` test window 与即时 containment。
16. 任意 malformed/missing/unreadable/symlink/unknown `vault-write-*` entry 在 no-lock
    startup 全量进入 `recoveries[]` 并阻止 write。
17. unlinked mentions 返回 deterministic `{path,count,offsets}[]`，count 与 UTF-8 byte
    offsets一致。
