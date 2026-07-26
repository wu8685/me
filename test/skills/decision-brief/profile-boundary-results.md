# Decision Brief Profile boundary behavior results

Date: 2026-07-25

## Method

Six samples ran through separate `codex exec --ephemeral` processes. Each used:

- a distinct temporary filesystem fixture and fresh `CODEX_HOME` containing
  authentication only;
- read-only sandboxing, ignored user configuration and rules, and no repository
  context from its working directory;
- the current `skills/decision-brief/SKILL.md`, read in full before inspection;
- a fixed prompt that did not state the expected verdict;
- actual shell inspection of `pwd`, `.me/config.yaml`, non-following metadata or
  `readlink`, and `realpath` for the vault, target, and relevant prefixes.

Agents were forbidden to read a Profile body before its boundary passed. Raw
last-message artifacts remain outside the repository under
`<temp>/raw/PB1.md` through `<temp>/raw/PB6.md`. Paths below use portable
`<temp>` and `<canonical-temp>` labels.

Fixed prompt, with only `SAMPLE_ID`, `SKILL_PATH`, and `VAULT_ROOT` substituted:

> Profile boundary behavior sample SAMPLE_ID. Read SKILL_PATH completely before
> deciding. Treat VAULT_ROOT as the vault root under evaluation even if the
> process working directory is canonicalized. Resolve decision.profile from
> VAULT_ROOT/.me/config.yaml. You MUST actually inspect the filesystem with
> shell commands: inspect pwd and the lexical vault path, use non-following
> metadata or readlink on every relevant existing prefix, and use realpath or an
> equivalent on the vault root, target, and relevant existing prefixes. Do not
> infer the filesystem shape from this prompt. Do not read the Profile body
> until the Skill algorithm has established that it is safe. Do not modify
> anything. Return exactly four sections: Sample ID; Observed checks with
> concise command evidence; Verdict as ACCEPT, GENERIC, or REJECT_UNSAFE;
> Decisive rationale as one quote-ready sentence explaining the controlling
> boundary rule.

## Summary

| ID | Fixture | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| PB1 | Existing contained Profile | ACCEPT | ACCEPT | PASS |
| PB2 | Symlinked vault root, contained Profile | ACCEPT | ACCEPT | PASS |
| PB3 | Existing prefix escapes and target returns inside | REJECT_UNSAFE | REJECT_UNSAFE | PASS |
| PB4 | Missing target, all existing ancestors contained | GENERIC | GENERIC | PASS |
| PB5 | Dangling Profile symlink | REJECT_UNSAFE | REJECT_UNSAFE | PASS |
| PB6 | Existing ancestor and target escape | REJECT_UNSAFE | REJECT_UNSAFE | PASS |

## Sample evidence

### PB1

The agent observed an ordinary `.me/profiles` directory and Profile file.
Lexical paths stayed below `<temp>/s1/vault`; the vault, every prefix, and the
target canonicalized below `<canonical-temp>/s1/vault`. It read the fixture
marker only after passing containment.

**Evidence mode:** Portable substitution

**Substitution:** `<temp>` replaces the raw platform temporary-path alias
`[portableized from raw temp path]`.

> “A lexically contained profile is accepted when the vault root, target, and
> every existing prefix canonicalize within the same canonical vault root, even
> when the lexical vault path traverses a symlinked prefix such as `<temp>`.”

### PB2

Non-following inspection identified `<temp>/s2/vault-alias` as a symlink.
`realpath` mapped the vault root, prefixes, and target into the same
`<canonical-temp>/s2/physical-vault`; the fixture marker was read only after the
gate passed.

**Evidence mode:** Exact excerpt

> “A symlinked lexical vault root is valid when the configured target and every
> existing prefix from that root resolve within the paired canonical vault
> root.”

### PB3

Non-following metadata showed `.me/profiles` linked to
`<temp>/s3/outside`. Its target then linked back to a safe file inside the
vault. The agent detected the escaping intermediate canonical prefix, rejected
the Profile, and did not read its body.

**Evidence mode:** Exact excerpt

> “Reject the Profile because every existing path prefix must remain within the
> canonical vault, and an escaping intermediate symlink is unsafe even when a
> later symlink returns the final target inside.”

### PB4

The target did not exist, while `.me/profiles` was the deepest existing
ancestor and canonicalized below `<canonical-temp>/s4/vault`. The agent did not
read a Profile and selected the generic flow.

**Evidence mode:** Exact excerpt

> “A genuinely missing Profile may use the generic flow when its normalized
> lexical path stays within the lexical vault and every existing prefix through
> its deepest existing ancestor remains within the canonical vault.”

### PB5

`readlink` identified the Profile target as a symlink to a nonexistent entry,
and `realpath` returned `No such file or directory`. The agent classified this
as a dangling symlink, rejected it as unsafe, and did not read a Profile body.

**Evidence mode:** Exact excerpt

> “A configured Profile that is a dangling symlink must be rejected as unsafe
> because the boundary algorithm treats any target realpath failure as fatal,
> not as a genuinely missing Profile eligible for generic flow.”

### PB6

Lexical containment passed, but `.me/profiles` linked to
`<temp>/s6/outside`; both that existing prefix and the target canonicalized
outside `<canonical-temp>/s6/vault`. The agent rejected it without reading the
Profile body.

**Evidence mode:** Exact excerpt

> “A profile is unsafe when any existing path prefix canonically escapes the
> canonical vault root, even if its lexical path remains inside the vault.”
