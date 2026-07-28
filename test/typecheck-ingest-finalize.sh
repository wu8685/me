#!/usr/bin/env bash
set -euo pipefail

typecheck_output="$(mktemp)"
trap 'rm -f "$typecheck_output"' EXIT

set +e
"${TSC_BIN:-./node_modules/.bin/tsc}" \
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
  grep -E 'error TS' "$typecheck_output" \
    | grep -Ev "^bin/ingest/(finalize|handout)\\.ts.*(error TS2307: Cannot find module '(fs|path|os|crypto)'|error TS2304: Cannot find name 'URL'\\.)" \
    || true
)"
if [[ -n "$unexpected" ]]; then
  printf '%s\n' "$unexpected"
  exit 1
fi

if [[ "$typecheck_exit" -ne 0 ]]; then
  baseline_count="$(
    { grep -E "^bin/ingest/(finalize|handout)\\.ts.*(error TS2307: Cannot find module '(fs|path|os|crypto)'|error TS2304: Cannot find name 'URL'\\.)" "$typecheck_output" || true; } \
      | wc -l \
      | tr -d ' '
  )"
  printf 'PASS: no task-local type errors; ignored %s missing Node/URL typing diagnostics\n' "$baseline_count"
else
  printf 'PASS: focused TypeScript check is clean\n'
fi
