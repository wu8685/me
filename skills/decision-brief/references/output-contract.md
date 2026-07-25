# Output Contract

Lead with the decision. Keep every section concise, but include enough evidence
and uncertainty for another reader to audit the recommendation.

Use this template without removing or reordering sections:

```markdown
# 结论

[一句话建议；置信度；若证据不足则写“暂不决策”]

## 决策问题与假设

[Decision owner、time horizon、constraints、reversibility、success signals、
worst acceptable outcome；列出会影响建议的 Assumption 和 Unknown]

## ME 知识命中

[只列实际影响判断的本地笔记及可定位链接；无命中则如实说明]

## 最新事实

[逐项写 Fact、来源、日期；将 Interpretation 和 Inference 分开标注]

## 主要矛盾

[最影响结果的一对矛盾；说明其他变量为何暂居次要]

## 选项比较

### 选项 A：[名称]

- 收益：
- 成本与机会成本：
- 风险：
- 依赖：
- 可逆性：
- 胜出信号：
- 出局信号：

### 选项 B：[名称]

- 收益：
- 成本与机会成本：
- 风险：
- 依赖：
- 可逆性：
- 胜出信号：
- 出局信号：

## 推荐理由

[连接关键 evidence 与 assumption；写出最强反方及推荐失败的路径]

## 最小验证实验

[最低成本、可逆、能区分核心假设真假的动作；负责人、期限、观察指标]

## 失效条件

[出现哪些事实、阈值或事件时撤回或改换建议]

## 不确定性

[Unknown、证据限制、对结论的影响，以及需要补充的最小信息]

## 复盘时间

[明确日期或触发事件，以及复盘时重新核验的信号]
```

Add or remove option blocks as needed, but every viable option must include
收益、成本与机会成本、风险、依赖、可逆性、胜出信号和出局信号。When evidence
is insufficient, use **暂不决策** in the conclusion and identify the smallest
fact or experiment that could unlock the decision.
