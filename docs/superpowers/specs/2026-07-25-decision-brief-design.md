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
