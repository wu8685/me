# me:move Nested Note Resolution Design

Issue: <https://github.com/wu8685/me/issues/2>

## 1. Goal

`me:move` must resolve notes stored in nested directories inside a configured
knowledge layer. Three documented input forms are accepted for the source, and
the resolved file is always normalized to a vault-relative path before the
Obsidian CLI is invoked.

## 2. Problem

ME 1.6.1 `findNotePath()` only checks a direct child under each configured
layer root:

```ts
const withExt = path.join(layerPath, `${cleanName}.md`);
```

Consequences:

- A bare stem (`2026-07-28-example`) fails when the note lives at
  `knowledge/raw/records/work/org/2026-07-28-example.md`, because the lookup
  never descends into `records/work/org/`.
- A vault-relative source
  (`knowledge/raw/records/work/org/2026-07-28-example.md`) is joined to each
  layer root again (`knowledge/raw/knowledge/raw/...`) and fails.
- In Obsidian mode the original `source` argument — not the resolved path —
  is passed to `obsidian move` / `obsidian rename`, so a bare stem reaches the
  CLI even when resolution succeeded by another route.
- Wikilink rewrite patterns interpolate the note name into a `RegExp` without
  escaping, so names containing regex metacharacters rewrite the wrong text.

## 3. Decision

### 3.1 Source resolution order

`bin/move.ts` resolves the source in this exact order; the first hit wins:

1. **Vault-relative path.** If the input contains a path separator, it is
   tried relative to the vault root (with and without `.md`). Absolute paths
   inside the vault are accepted and converted to vault-relative. Paths that
   escape the vault (`..`) are rejected as not found.
2. **Layer-relative path.** The input is joined to each configured layer root
   in turn (with and without `.md`). This preserves the pre-existing direct
   child behavior and extends it to nested layer-relative paths such as
   `records/work/org/2026-07-28-example`.
3. **Recursive stem lookup.** Each configured layer tree is walked
   recursively (dot-directories such as `.obsidian` skipped) collecting notes
   whose filename stem equals the input. Exactly one match resolves; zero
   matches is "not found".

### 3.2 Ambiguity

If the recursive stem lookup finds more than one match, the command fails
with an ambiguity error that lists every candidate as a vault-relative path,
so the user can re-run with a layer-relative or vault-relative form.

### 3.3 Obsidian CLI normalization

After resolution, the absolute source path is converted to a POSIX-style
vault-relative path (`path.relative(vault, sourcePath)` with separators
normalized to `/`). That normalized path — never the raw user input — is
passed to `obsidian move file=...` / `obsidian rename file=...`.

### 3.4 Wikilink rewriting

Native mode rewrites `[[name]]`, `[[name|alias]]`, and `[[name#heading]]`
across all configured layers. Note names are escaped before being
interpolated into the rewrite `RegExp`, and the replacement uses a function
so `$` sequences in the new name are inserted literally.

### 3.5 Ordinary Markdown links

Ordinary Markdown links (`[text](relative/path.md)`) are **not** rewritten.
They are explicitly unsupported in both modes by `me:move`; only wikilinks
are maintained. This is documented in the move skill so the limitation is a
contract, not a surprise.

## 4. Tests

`test/move.test.ts` (bun) covers, in native mode and with a stubbed
`obsidian` binary for Obsidian mode:

- root-level and nested rename by stem;
- layer-relative and vault-relative source paths;
- cross-layer move from a nested source;
- Chinese directory and note names;
- duplicate stems → ambiguity error listing candidates;
- wikilink variants `[[name]]`, `[[name|alias]]`, `[[name#heading]]`;
- note names containing regex metacharacters;
- Obsidian mode receives the normalized vault-relative path;
- ordinary Markdown links are left untouched (documented limitation).

`test/vault-test.sh` gains a shell-level regression test that drives
`bin/move.ts` through the CLI against a mock vault with the nested layout
from the issue reproduction.
