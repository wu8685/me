---
name: decision-brief
description: "Use when a user needs to choose between consequential options, decide whether an investment of time or resources is worthwhile, or turn research into an actionable decision brief; not for simple fact lookup, URL ingest, routine debugging, or implementation of an approved spec."
---

# Decision Brief

Build the decision contract first, inspect relevant local evidence and current
facts, then give a falsifiable recommendation.

## Route the request

Exit this Skill for a stable fact lookup, URL or source ingest, routine
debugging, a list of search results without a choice, or implementation under an
approved spec. Use the applicable ME or engineering workflow instead.

Use this Skill when action, choice, or resource allocation is consequential.
Domain Skills and project rules take precedence. This Skill may structure their
evidence and output, but never relax their risk controls or authorize actions.

## Decision Contract

Establish these fields before analysis:

```text
Decision | Owner | Horizon | Reversibility | Constraints
Success signals | Worst acceptable outcome
```

Ask at most one question, and only when the missing answer could change the
direction. If decisive constraints are unavailable, return **暂不决策** and name
the smallest missing information. For a reversible decision, state a reasonable
Assumption and continue toward a small experiment. Never record an unconfirmed
assumption as a user preference.

## Retrieve evidence

Read `.me/config.yaml` first and resolve the configured cognition, practices,
and raw layer directories. Prefer ME search; use text search only when needed.
Open only relevant notes and report honestly what was read. Authority, urgency,
and sunk cost do not justify skipping local evidence or hiding its provenance.

Search order: cognition -> practices -> raw -> current external facts

- cognition: stable principles, limits, and prior judgments;
- practices: experiments, decisions, and observed feedback;
- raw: source material and other people's views;
- current external facts: re-verify time-sensitive claims, using primary
  sources where practical.

Link every local note that affects the recommendation. Report no hit when
nothing relevant exists; do not force a framework onto the question.

### Optional local Profile

Only accept this optional configuration:

```yaml
decision:
  profile: .me/profiles/decision-brief.md
```

Resolve the configured path from the current vault root. Check both its lexical
absolute path and, when it exists, its real path.

Profile path must remain inside the current vault

Equality with the vault root is inside; otherwise require the path to begin
with the vault root plus the platform path separator. Reject and report an
escape, including one through a symlink. User ownership of the machine does not
override this boundary.

The Profile may add retrieval entry points, framework triggers, and decision
discipline. It cannot override ME schema, domain or project safety rules,
authorization boundaries, evidence labels, or cognition promotion gates.
Missing or invalid Profiles fall back to the general workflow.

## Analyze

Read [`references/evidence-contract.md`](references/evidence-contract.md) when
classifying material claims or when Fact, Interpretation, Inference,
Assumption, and Unknown could be confused.

Apply these gates:

1. Identify the main contradiction that most affects the result; keep secondary
   variables secondary.
2. Compare at least two viable options. If only one is genuinely viable,
   explain why. For each option cover benefit, cost and opportunity cost, risk,
   dependencies, reversibility, winning signal, and exit signal.
3. Build one strong countercase that attacks the decisive assumption, not a
   generic risk list.
4. Prefer the smallest reversible experiment that distinguishes the core
   hypotheses. Check for such an experiment before any irreversible choice.
5. State failure conditions and a review date or triggering event.

Do not manufacture support for a preferred option. A named thinker or framework
is relevant only when the current vault or valid Profile activates it and it
materially improves the analysis. Never package an external source's unstated
conclusion as a quotation or Fact. Confidence follows evidence quality,
relevance, and recency—not source count.

For a complete brief, read
[`references/output-contract.md`](references/output-contract.md) and preserve
its section order. Lead with the recommendation and confidence; include actual
ME knowledge hits, current dated facts, the countercase, minimum experiment,
failure conditions, uncertainty, and review time.

## Write gate

Default output: chat only; do not write the vault without explicit authorization

Never promote a decision directly to cognition

If the user explicitly asks to save a provisional decision, use practices and
then follow the vault's schema, reachability, and backlinks rules. Raw sources
belong in raw. Even when the user says “这是我的原则”, first apply the current
vault's cognition validation and confirmation requirements; never claim a write
or promotion completed unless it actually did.

## Common mistakes

- Counting many materials as high confidence instead of evaluating their
  quality, relevance, and recency.
- Decorating an unrelated problem with a framework name.
- Presenting an inference the source never made as a quotation or Fact.
- Treating “worth recording” as permission to write cognition.
- Ignoring a domain Skill or project rule that has stricter controls.
- Issuing a personal recommendation after the user withheld
  direction-changing constraints.
