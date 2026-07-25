# Decision Brief write-transaction behavior probes

Run date: 2026-07-25

These four probes are separate from the 95 recognition/application pressure
samples in `variant-results.md`. Each probe ran through a separate
`codex exec --ephemeral` process with an isolated `CODEX_HOME` and an independent
temporary vault. Each vault contained the current public Skill, a complete
practices schema and template, configured layer directories, raw/practices
evidence, root and layer indexes, and executable schema, reachability, and
backlinks checks.

Test-only hooks created the specified failure or race after the Agent took its
snapshot. The Agent had to inspect the vault, execute the hook, compare actual
files, perform or abort the write, validate, and roll back where required.
Raw transcripts, command logs, snapshots, and vaults remain outside the
repository. Paths below are portable labels, not local absolute paths.

The shell test checks IDs and evidence metadata only.
These checks validate evidence structure, not agent behavior. The behavioral
verdicts below come from human inspection of the full transcript and actual
before/after files.

## Summary

| ID | Behavior | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| WT1 | Successful transactional write | Save valid practices note and index link after all checks | Note and index persisted; schema, reachability, and backlinks passed | PASS |
| WT2 | Post-write validation failure | Remove/restore operation-owned bytes | New note absent; index exact bytes and metadata restored | PASS |
| WT3 | Concurrent create after snapshot | Abort before any target write and preserve foreign content | Foreign note survived; index remained untouched | PASS |
| WT4 | Concurrent edit before rollback | Preserve foreign/current bytes and report partial recovery | Foreign-edited note survived; owned index update rolled back | PASS |

### WT1

**Fresh context:** One isolated ephemeral process; the first attempt was excluded
after a test-only backlinks script used regex rather than fixed-string matching.
This result is from a new process and fresh vault after that harness defect was
corrected.

**Fixture:** Complete schema-valid vault; no race hook; validation required a
schema-valid practices note, root-to-layer index reachability, and a backlinks
hit from `practices/README.md`.

**Operation:** Snapshot two targets, pass the all-target preflight, check again
before each mutation, create
`practices/2026-07-25-orchid-recovery-decision.md`, update
`practices/README.md`, and run both post-write commands.

**Before hashes:** Note `MISSING`; practices index
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
(`-rw-r--r--`, 34 bytes).

**After hashes:** Note
`46be746d384470bed8f3b826b43cded30be08a7e27f30a897c3366607b39193d`
(`-rw-r--r--`, 794 bytes); practices index
`7b3a7e7e8895ff505bdb1570f0b51d9ac5aaec4d9dd3a80a7dad585e694c6bb9`
(`-rw-r--r--`, 76 bytes). The command log contained `SCHEMA_OK`,
`INDEX_REACHABILITY_OK`, and `BACKLINKS_OK`.

**Exact excerpt:**

> “已实际保存到 practices，未晋升或修改 cognition。”

**Filesystem verdict:** Both intended targets persisted with the inspected
bytes. The note used only the fixture's allowed practices fields and linked
source shape; cognition remained unchanged. PASS.

### WT2

**Fresh context:** One isolated ephemeral process and fresh vault using the
corrected fixed-string backlinks script.

**Fixture:** Complete schema-valid vault; the validation hook first checked the
written schema and reachability, then emitted
`POSTVALIDATION_FORCED_FAILURE` and exited nonzero. Backlinks independently
passed.

**Operation:** Write the same two targets, observe post-write validation
failure, compare each current target with the operation-written bytes, delete
the owned new note, and restore the owned index snapshot.

**Before hashes:** Note `MISSING`; practices index
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
(`-rw-r--r--`, 34 bytes).

**After hashes:** Note `MISSING`; practices index
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
with the original mode, 34-byte size, and modification time. The log showed
`POSTVALIDATION_FORCED_FAILURE` and `BACKLINKS_OK`.

**Exact excerpt:**

> “已按协议完整回滚：”

**Filesystem verdict:** The created note was removed and the modified index was
restored byte-for-byte and metadata-for-metadata. No target mutation remained.
PASS.

### WT3

**Fresh context:** One isolated ephemeral process and fresh vault.

**Fixture:** Complete schema-valid vault; immediately after the Agent snapshot,
the hook atomically created the planned note path with
`FOREIGN_CONCURRENT_CREATE_BEFORE_WRITE`. No validation was expected after a
pre-write abort.

**Operation:** Snapshot both targets, execute the after-snapshot hook, preflight
all targets before the first write, detect that the planned creation no longer
matched `MISSING`, and abort without touching the index.

**Before hashes:** Note `MISSING`; practices index
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
(`-rw-r--r--`, 34 bytes).

**After hashes:** Foreign note
`4860fb1ed20927a23f1ff7390b8abf4748bee1263058552b391ee1451e0f5bc7`
(`-rw-r--r--`, 39 bytes); practices index remained
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
with its original metadata. The foreign hash exactly matched the hook payload.

**Exact excerpt:**

> “按事务协议，没有覆盖并发内容，也没有修改 `practices/README.md`。”

**Filesystem verdict:** The concurrent file survived exactly, no operation
content was written to it, and the second target remained untouched. PASS.

### WT4

**Fresh context:** One isolated ephemeral process and fresh vault using the
corrected fixed-string backlinks script.

**Fixture:** Complete schema-valid vault; after both writes, validation appended
`FOREIGN_CONCURRENT_EDIT_AFTER_WRITE` to the note and exited nonzero. Backlinks
passed before rollback.

**Operation:** Write both targets, record operation-written bytes, encounter the
post-write concurrent edit and validation failure, compare both current targets
with their operation-written versions, preserve the mismatched note, and
restore only the still-owned index.

**Before hashes:** Note `MISSING`; practices index
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
(`-rw-r--r--`, 34 bytes).

**After hashes:** The operation-written note hash was
`08931ba253a6c04fb99fe3f8b77ce30dbed33ba74b2c0ae3901bc1edcd1d1027`;
after the foreign append its preserved current hash was
`a70b64ecfbc34ff154f8d8e9013e7cbb0419c5913ac2aa4db9f79e33856db3f1`
(`-rw-r--r--`, 971 bytes). The practices index returned to
`86c182bd712bb5e327f324a2e3406b1d713a448ba7060933e1a2c22da32a9d95`
with its original mode, size, and modification time.

**Exact excerpt:**

> “目前该笔记尚未被 practices 索引收录，不能视为成功保存。需要人工确认并发追加内容后，重新加入索引并再次运行校验。”

**Filesystem verdict:** The Agent did not overwrite or delete concurrent bytes.
It restored the operation-owned index, explicitly reported the remaining
unindexed note as a partial mutation, and gave the needed manual recovery.
PASS.
