# Brief Output Contract

A brief leads with the conclusion and keeps detailed evidence available
without forcing it into the main narrative.

## Structure profiles

`Structure` in the Brief Contract selects one deterministic section order:

| Profile | Sections |
| --- | --- |
| `executive-report` | conclusion → background → tension → approach → outcome → next step |
| `technical-narrative` | conclusion → background → difficulty → reasoning → solution |
| `retrospective` | conclusion → timeline → outcomes → causes → learning → follow-up |
| `nomination` | conclusion → importance → action → verified impact → reuse value |
| `summary` | conclusion → supporting points, inside an explicit word budget |

The conclusion comes first in every profile. Do not invent new sections; if
none of the profiles fits, use `summary`.

## Composition rules

- Every material statement in the narrative traces to a ledger claim through
  its claim ID. Use the report's `effectiveText` wording; never upgrade a
  flagged claim back to its original wording.
- Targets read as targets (“goal: reach X by Q4”), results read as measured
  results (“reached Y in the August run, scope S, baseline B”). The two never
  merge into one sentence.
- A correction appears with what it supersedes; the stale claim is never
  presented as current.
- Recognition is reported as recognition (“received a division commendation”)
  and never as proof of outcome or validity. Award outcome, work value, and
  organizational recognition remain separate facts.
- Contradictory evidence stays visible: state which source carries more
  weight and why, or state that the conflict is unresolved.
- Quantitative claims keep unit, scope, baseline, and evidence date.

## Word budget and provenance

- The main narrative respects `maxWords`. CJK characters count as one word
  each; latin runs count per whitespace token — the same rule the validator
  applies.
- Compression never drops `decisive` claims and never drops provenance. The
  brief ends with a compact provenance appendix mapping claim IDs to sources
  and dates, for example:

```text
## Provenance
- [C2] verified_result — practices/site-rollout.md, 2026-08-01, metric 91% (scope: 45 pages; baseline: 72%)
- [C3] recognition — practices/site-rollout.md, 2026-08-01
```

- A machine-readable claim map (the ledger JSON itself) may replace the
  prose appendix when the audience is tooling.
- Validate the final draft as `briefText`; `WORD_BUDGET_EXCEEDED`,
  `DECISIVE_CLAIM_NOT_PRESERVED`, or `PROVENANCE_APPENDIX_MISSING` means the
  draft is revised, not shipped.
