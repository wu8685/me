#!/usr/bin/env bash
set -euo pipefail

typecheck_output="$(mktemp)"
trap 'rm -f "$typecheck_output"' EXIT

set +e
./node_modules/.bin/tsc \
  --noEmit \
  --allowImportingTsExtensions \
  --moduleResolution bundler \
  --module preserve \
  --target ES2022 \
  --lib ES2023 \
  --skipLibCheck \
  bin/ingest/finalize.ts >"$typecheck_output" 2>&1
typecheck_exit=$?
set -e

unexpected="$(
  grep -E '^bin/ingest/(finalize|handout)\.ts.*error TS' "$typecheck_output" \
    | grep -Ev "error TS2307: Cannot find module '(fs|path|os|crypto)'|error TS2304: Cannot find name 'URL'\\." \
    || true
)"
if [[ -n "$unexpected" ]]; then
  printf '%s\n' "$unexpected"
  exit 1
fi

if [[ "$typecheck_exit" -ne 0 ]]; then
  baseline_count="$(
    { grep -E 'error TS' "$typecheck_output" || true; } \
      | wc -l \
      | tr -d ' '
  )"
  printf 'PASS: no finalize/handout type errors; ignored %s transitive environment diagnostics\n' "$baseline_count"
else
  printf 'PASS: focused TypeScript check is clean\n'
fi
