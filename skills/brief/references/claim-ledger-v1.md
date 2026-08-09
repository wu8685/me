# Claim Ledger Contract v1

The claim ledger is the mandatory intermediate between evidence retrieval and
drafting. It is validated deterministically by `bin/brief.ts validate`; the
same ledger plus the same `--now` produces a byte-identical report on Claude
Code and Codex.

## Ledger shape (contract `claim-ledger`, version 1)

```json
{
  "version": 1,
  "contract": "claim-ledger",
  "brief": {
    "topic": "required non-empty string",
    "audience": "optional",
    "purpose": "optional",
    "structure": "executive-report | technical-narrative | retrospective | nomination | summary",
    "maxWords": 300,
    "freshnessDays": 90
  },
  "sources": [
    {
      "id": "S1",
      "kind": "vault | session | bundle",
      "ref": "raw/topic/note.md or session:<id>",
      "authorized": true,
      "date": "2026-08-01"
    }
  ],
  "claims": [
    {
      "id": "C1",
      "text": "the claim as currently worded",
      "type": "fact | target | verified_result | inference | correction | recognition | recommendation | unknown",
      "sources": ["S1"],
      "evidenceDate": "2026-08-01",
      "confidence": "low | medium | high",
      "supersedes": null,
      "contradicts": [],
      "decisive": false,
      "safeWording": "evidence-safe alternative when text is flagged",
      "metric": { "value": 91, "unit": "%", "scope": "45 pages, 2026-08-01 run", "baseline": "72% in the 2026-06 run" }
    }
  ],
  "briefText": "optional rendered brief for budget/provenance checks"
}
```

Field rules:

- Every claim needs `id`, `text`, `type`, `sources`, and `confidence`.
  `unknown` claims may have empty `sources`.
- `session` sources require `authorized: true`; anything else fails closed
  with `SESSION_SOURCE_UNAUTHORIZED`.
- `verified_result` requires a `metric` with `value`, `unit`, `scope`, plus an
  `evidenceDate`; a missing `baseline` is a warning, not an error.
- A `correction` must name the claim it `supersedes`; the superseded claim
  stays in the ledger and remains visible in the report.
- `decisive: true` marks claims that must survive compression with their
  provenance.

## Report shape (contract `brief-ledger`, version 1)

- `status`: `invalid` (any error) > `insufficient_evidence` (no claims, or
  all `unknown`) > `findings` (warnings only) > `ok`.
- `findings[]`: stable `code`, `severity`, optional `claimId`/`sourceId`,
  human message, and `safeAlternative` when a downgrade is proposed. Sorted by
  code then claim id.
- `claims[]`: per-claim `flagged`, `supersededBy`, and `effectiveText` (the
  safe wording when it passed the guard, else the original text).
- `supersededClaims[]`, `contradictions[]`: both sides always visible.
- `wordBudget`: `words`, `withinBudget`, `missingDecisiveClaims`.
- `stats`: claim counts by type, source counts, finding counts by severity.

## Finding codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `STRUCTURE_UNKNOWN` | error | `brief.structure` outside the five profiles |
| `SOURCE_FIELD_MISSING` | error | source lacks id/ref or has unknown kind |
| `SESSION_SOURCE_UNAUTHORIZED` | error | session evidence without explicit authorization |
| `CLAIM_FIELD_MISSING` | error | claim lacks id/text or has unknown type |
| `CLAIM_ID_DUPLICATE` | error | duplicate claim id |
| `SOURCE_MISSING` | error | non-`unknown` claim names no source |
| `SOURCE_UNKNOWN` | error | claim references an undeclared source |
| `CONFIDENCE_MISSING` | warning | claim carries no confidence |
| `TARGET_WORDED_AS_RESULT` | error | a `target` uses achieved-result wording |
| `VERIFIED_RESULT_WITHOUT_METRIC` | error | `verified_result` with no metric |
| `METRIC_INCOMPLETE` | error | metric missing value/unit/scope |
| `METRIC_BASELINE_MISSING` | warning | metric has no baseline |
| `EVIDENCE_DATE_MISSING` | warning | `verified_result` has no evidence date |
| `EVIDENCE_DATE_INVALID` | warning | evidence date unparseable |
| `UNSUPPORTED_SUPERLATIVE` | warning | guard hit; `safeAlternative` proposed |
| `SAFE_WORDING_UNSUPPORTED` | warning | proposed safe wording still hits the guard |
| `BRIEF_SUPERLATIVE` | warning | rendered brief text hits the guard |
| `RECOGNITION_AS_OUTCOME` | error | recognition asserts outcome/validity |
| `CORRECTION_WITHOUT_TARGET` | error | correction names no superseded claim |
| `SUPERSEDED_CLAIM_MISSING` | error | superseded claim dropped from the ledger |
| `CONTRADICTION_TARGET_MISSING` | error | contradiction points at an unknown claim |
| `STALE_CLAIM` | warning | evidence older than the freshness window |
| `WORD_BUDGET_EXCEEDED` | error | brief text over `maxWords` |
| `DECISIVE_CLAIM_NOT_PRESERVED` | error | decisive claim id absent from brief text |
| `PROVENANCE_APPENDIX_MISSING` | warning | brief text references no claim ids |
| `NO_EVIDENCE` | warning | the ledger contains no claims |
| `INSUFFICIENT_EVIDENCE` | warning | every claim is `unknown` |

## Unsupported-language guard

Flagged forms (English matched case-insensitively on word boundaries, Chinese
as substrings): `first`, `only`, `best`, `highest`, `fully completed`,
`production proven`, `organization-wide`, `significant improvement` without a
metric value and baseline; `最高`, `最佳/最好`, `首个/首次`, `唯一`, `全面完成`,
`生产验证`, `全组织`, `显著提升` without a metric. The guard proposes
evidence-safe wording — scoped, dated, with the actual measurement — rather
than deleting the claim. A `safeWording` that itself hits the guard is rejected
(`SAFE_WORDING_UNSUPPORTED`).
