# Evidence Contract

Use this contract to classify every claim that materially affects a decision.
Keep the label visible wherever confusing the claim with a sourced fact could
change the recommendation.

## Quick reference

| Label | Test |
| --- | --- |
| Fact | A dated source directly supports the claim |
| Interpretation | Explains known facts without claiming the source said it |
| Inference | Combines multiple facts into a provisional judgment |
| Assumption | Is temporarily accepted and still needs validation |
| Unknown | Cannot currently be confirmed |

## Classification rules

- A **Fact** states only what the cited source directly supports. Record the
  source and its publication or observation date; do not attribute conclusions
  to a source that it did not make.
- An **Interpretation** explains the meaning of one or more Facts. Name the
  Facts it interprets and keep the explanation distinct from the source's own
  claims.
- An **Inference** combines identified Facts into a provisional judgment. State
  the reasoning and the evidence that would overturn it.
- An **Assumption** is an unverified condition accepted temporarily so analysis
  can continue. State why it is needed, how consequential it is, and how to
  validate it.
- An **Unknown** is material information that cannot currently be confirmed.
  State whether it blocks the decision or merely lowers confidence.

## Source discipline

- Re-verify every time-sensitive or current-state Fact when preparing the
  brief. A previously saved note can supply a lead, but not proof that the
  condition still holds.
- For technical claims, prefer primary evidence: official documentation,
  source code, standards, and original research papers. Use secondary material
  for context and mark any added explanation as Interpretation.
- Community material may support a narrowly stated Fact about what sampled
  participants reported. It does not establish an underlying technical,
  market, or causal claim. Record the platform, collection period, sample
  limits, and selection bias; do not upgrade popularity or consensus into Fact.
- If the strongest available source cannot directly support a claim, label the
  claim Interpretation, Inference, Assumption, or Unknown instead of weakening
  the Fact standard.
- Conflicting credible evidence remains visible. Explain which source carries
  more weight and why.

## Traceability

For each key recommendation, preserve a reviewable chain:

```text
recommendation
  -> decisive claims and their labels
  -> supporting source or local note, with date
  -> material assumptions and unknowns
  -> disconfirming evidence or failure signal
```

Confidence follows the quality, relevance, and recency of this chain, not the
number of sources. If a recommendation cannot be traced to evidence and its
material assumptions, lower confidence or return **暂不决策**.
