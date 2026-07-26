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
the smallest missing information. This gate permits no interim direction: do
not select the status quo, say “先不要 X,” or re-label delay as a reversible
experiment. A separate safety rule may still require immediate action. For a
reversible decision that is not blocked, state a reasonable Assumption and
continue toward a small experiment. Never record an unconfirmed assumption as
a user preference.

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
  profile: profiles/decision-brief.md
```

Profile path must remain inside the current vault

Containment requires paired lexical and canonical vault roots

Apply this path algorithm:

1. Make the vault root absolute without resolving symlinks, resolve the Profile
   against that lexical root, and require the normalized target to equal the
   lexical root or begin with the root plus the platform path separator.
2. Canonicalize the vault root with `realpath` or an equivalent operation. This
   separate canonical root makes a symlinked vault root valid; never compare a
   canonical target with the lexical root.
3. For an existing target, canonicalize it and require containment under the
   canonical root. Also inspect and canonicalize every existing path prefix
   from the lexical root to the target; reject if any prefix escapes, even if a
   later symlink would return inside.

Canonicalize the deepest existing ancestor when the Profile target is missing

Find it by walking upward from the target with a non-following metadata check,
so a symlink is distinguishable from a nonexistent entry. Canonicalize every
existing prefix through that ancestor and require canonical-root containment.
Keep the nonexistent remainder beneath that contained canonical ancestor and
verify the resulting prospective path remains contained.

Reject dangling symlinks and realpath errors as unsafe

Stop and report unsafe configuration; do not read the Profile, treat it as
missing, or let user ownership of the machine override the boundary.

Only a genuinely missing Profile whose ancestors are contained may use the generic flow

The Profile may add retrieval entry points, framework triggers, and decision
discipline. It cannot override ME schema, domain or project safety rules,
authorization boundaries, evidence labels, or cognition promotion gates.

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
materially improves the analysis. With no activation, do not name, emulate, or
offer a thinker as an “if you insist” fallback; report no framework hit and use
generic analysis. Never package an external source's unstated conclusion as a
quotation or Fact. Confidence follows evidence quality, relevance, and
recency—not source count.

For a complete brief, read
[`references/output-contract.md`](references/output-contract.md) and preserve
its section order. Lead with the recommendation and confidence; include actual
ME knowledge hits, current dated facts, the countercase, minimum experiment,
failure conditions, uncertainty, and review time.

## Write gate

Default output: chat only; do not write the vault without explicit authorization

Never promote a decision directly to cognition

An explicit request to save a provisional decision authorizes only the
practices path below. Agreement such as “建议不错” is not save authorization.

### Prepare a practices request

1. Resolve `PLUGIN_ROOT` to this installed plugin/repository and `VAULT_DIR` to
   the current vault. Read `.me/config.yaml`, the schema, practices template,
   and project instructions.
2. Require at least one local note that materially informed this brief. Choose
   one such note as the primary provenance and verify it already exists. Its
   `source` must be an existing path-qualified local wikilink, such as
   `[[raw/topic/source-note]]`: no basename-only link, remote URL, conversation
   inference, or planned note qualifies. With no qualifying provenance, do not
   call the writer; suggest ingesting the source into raw or remain chat-only,
   and say `not written`.
3. Build a practices note with the current schema's exact fields. It must use
   `type: reflection`; Do not use `type: experiment` for the planned minimum
   experiment. The body preserves the Decision Brief output sections.
4. Derive the slug only from the raw `Decision` field of the Decision Contract,
   never from a summary, title, date, source, or result. Use Node's `createHash`
   from `crypto`:

```ts
const normalizedDecision = decision.normalize('NFKC').trim()
  .replace(/\p{White_Space}+/gu, ' ').toLowerCase();
const ascii = normalizedDecision.replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
const slug = ascii || `decision-${
  createHash('sha256')
    .update(Buffer.from(normalizedDecision, 'utf8'))
    .digest('hex')
    .slice(0, 12)
}`;
```

This algorithm is locale-independent. Use it unchanged for ASCII, full-width
characters, Unicode whitespace, mixed case, all-Unicode, all-symbol, empty, and
over-60-character inputs. The requested relative target is always
`decisions/YYYY-MM-DD-<slug>.md`. Apply the writer's ASCII-fold/exact-Unicode
collision rule. Do not add a numeric suffix; a collision is a conflict.

Construct this v1 JSON request, omitting every unknown or empty optional field:

```json
{
  "version": 1,
  "layer": "practices",
  "relativePath": "decisions/YYYY-MM-DD-<slug>.md",
  "markdown": "<complete schema-valid reflection note>",
  "index": { "mode": "auto" }
}
```

Do not set `acknowledgeCognition`. Send the complete Markdown request through stdin,
not a shell argument. If tooling cannot supply stdin, run
`bin/runtime.ts prepare-inbox --vault-dir "$VAULT_DIR"`, write one unique
`.json` file directly inside the returned host-local `inboxDir`, pass its
absolute path with `--request`, and remove it after use. Never use `apply_patch`, shell redirect, `mv`, or
another generic file operation to write a vault target.

### Preview, then write

Fully prepare the request before any writer invocation. Do not invoke the CLI
for discovery, `--help`, capability probing, or with empty, placeholder, or
partial stdin. The first invocation must be `bin/vault-write.ts preview` with
the complete request:

```bash
bun run "$PLUGIN_ROOT/bin/vault-write.ts" preview --vault-dir "$VAULT_DIR"
```

Parse its actual JSON. Continue only when `status: preview`,
`commitModel: preview-only`, the note path and planned paths match the prepared
practices request, and no error is present. Preview reserves nothing. Only then
invoke `bin/vault-write.ts write` with the same request bytes:

```bash
bun run "$PLUGIN_ROOT/bin/vault-write.ts" write --vault-dir "$VAULT_DIR"
```

Parse the write JSON rather than inferring success from its exit code:

| Result | Required report |
| --- | --- |
| `status: committed` and `commitModel: journaled-cooperative` | Report saved; include `notePath`, changed paths, warnings, backlinks, and unlinked mentions. |
| `status: validation_failed` | Report `not written`; include the public error code/message. |
| `status: conflict` | Report `not written`; include the conflict without choosing a new path or suffix. |
| `status: unsupported` | Report `not written`; explain that the filesystem cannot provide the required primitive. |
| `status: manual_recovery` | Do not say saved or rolled back. Report aggregate `recoveryState`, then iterate over every item in `recoveries[]` and transcribe its `operationId`, `state`, `preservedPaths`, `remainingMutations`, and every `actions` entry. |

The writer's model is cooperative and journaled; describe it only as
`commitModel: journaled-cooperative`. A preview result, exit code zero, partial
filesystem observation, or an empty recovery list never independently proves a
save. Recovery paths beginning with `<ME_RUNTIME>` are host-local; resolve the
absolute root only when inspection is required by running
`bin/runtime.ts path --vault-dir "$VAULT_DIR"`.

Raw sources belong in raw. Even when the user says “这是我的原则”, first apply the
current vault's cognition validation and confirmation requirements; never claim
a write or promotion completed unless it actually did.

## Common mistakes

- Counting many materials as high confidence instead of evaluating their
  quality, relevance, and recency.
- Decorating an unrelated problem with a framework name.
- Presenting an inference the source never made as a quotation or Fact.
- Treating “worth recording” as permission to write cognition.
- Ignoring a domain Skill or project rule that has stricter controls.
- Issuing a personal recommendation after the user withheld
  direction-changing constraints.
