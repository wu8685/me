# Future-Retrieval Contract for Durable Practice Notes

> Contract for how an Agent records a **declared future use** when creating or
> updating a Practices note. Document-centered: it improves how a note records
> its future use, retrieval vocabulary, unresolved questions, and minimal
> provenance — without treating sessions or code as managed knowledge.

## 1. Trigger

The contract applies only when the user explicitly expresses a future
retrieval or continuation intent, for example:

- 年底总结时需要找到这件事 (must be findable at the year-end review)
- 下个季度复盘 (next quarter's retrospective)
- 下次继续完善 (continue refining this next time)
- 以后恢复这个聊天 (resume this conversation later)
- 等某个指标出来后重新判断 (revisit once a metric lands)
- 作为晋升或项目总结素材 (material for a promotion or project report)

When no such intent exists, write the note normally. Ordinary one-off notes
carry **none** of the sections below.

## 2. Retrieval-plan preview (before any write)

On a trigger, present a retrieval-plan preview and wait for the normal write
confirmation. The preview is chat-only: nothing is written until confirmed.
The preview must state:

1. **Intended future use** — the declared scenario, in the user's own words.
2. **Proposed retrieval vocabulary** — schema-valid tags
   (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), preferring tags and aliases already used in
   the vault, plus the future phrasing a reviewer would actually search for.
3. **Index changes** — which existing index or topic note the note connects
   to. Never create a duplicate index note when an existing navigation
   surface is appropriate; the per-layer managed index is maintained by the
   vault-write transaction itself.
4. **Preserved rationale** — which reasoning, assumptions, and unresolved
   questions will be recorded.
5. **Provenance** — the pointer to be stored (see §5), or none.
6. **Exact writes** — every file path to be created or modified.

## 3. Optional note sections

Record only the minimum context the declared scenario needs, as ordinary
Markdown sections. **No new frontmatter fields** — `SCHEMA.md` is locked and
unchanged. Localized headings (or their equivalents) are:

- `## 后续用途` — the declared future use: when and why this note must be
  found again.
- `## 决策背景` — decision rationale, constraints, and assumptions behind the
  conclusion.
- `## 未决问题` — unresolved questions and the **next decision point** (what
  event or input reopens the decision).
- `## 检索入口` — the retrieval entry points: the tags and the future
  search phrasings, including vocabulary that did not appear verbatim in the
  original statement.
- `## 来源` — minimal provenance (see §5).

## 4. Index and link connection

Connect the note to an appropriate existing index or topic note when useful —
a wikilink is enough. Do not create duplicate index notes. Backlinks answer
what already connects to the note; index reachability answers whether it is
navigable now; this contract answers whether a declared later use can recover
the note with enough context.

## 5. Provenance: minimal, navigable, safe

- Store a **pointer**, never a transcript: a `me:recall` query plus the
  `taskId`/`sessionId` and date, or a path to an evidence bundle. Session
  provenance that lives only in the chat is lost; a transcript dump in the
  vault is forbidden.
- **Redact** sensitive material: credentials, secrets, and personal
  identifiers are never copied into the vault.
- Default scope is the current vault. Cross-workspace session access requires
  explicit user authorization (for `me:recall`,
  `--authorize-cross-workspace`).

## 6. Post-write verification

After an authorized write, run representative `me:search` queries using the
planned future vocabulary and report whether the declared retrieval scenario
succeeds. If a query misses the note, fix the tags, the `## 检索入口`
section, or the index connection, and re-verify.

## 7. Boundaries

- ME manages document knowledge only: no code, binaries, worktrees, or
  execution state is written as part of this contract.
- Do not automatically promote the note to Cognition.
- Do not invent future intent the user has not expressed.
- All writes go through the existing mutation contract (preview, cooperative
  lock, journaled transaction). A stale preview is re-planned, never forced.
