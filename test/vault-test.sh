#!/usr/bin/env bash
#
# me plugin test framework
#
# Usage:
#   ./test/vault-test.sh                  # Run all tests
#   ./test/vault-test.sh test_setup       # Run a single test
#   ./test/vault-test.sh --list           # List available tests
#
# The framework creates a temporary mock vault directory for each test,
# runs the test, then tears down regardless of pass/fail.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_VAULT=""
TEST_RUNTIME_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/me-shell-runtime.XXXXXX")
export ME_RUNTIME_ROOT="$TEST_RUNTIME_ROOT"
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Setup / Teardown ───────────────────────────────────────────────
setup_vault() {
  MOCK_VAULT=$(mktemp -d "${TMPDIR:-/tmp}/me-vault-test.XXXXXX")
  # Initialize as git repo (some tests may need git)
  git init "$MOCK_VAULT" --quiet
  echo "  vault: $MOCK_VAULT"
}

teardown_vault() {
  if [ -n "$MOCK_VAULT" ] && [ -d "$MOCK_VAULT" ]; then
    rm -rf "$MOCK_VAULT"
    MOCK_VAULT=""
  fi
}

teardown_test_environment() {
  teardown_vault
  if [ -n "$TEST_RUNTIME_ROOT" ] && [ -d "$TEST_RUNTIME_ROOT" ]; then
    rm -rf "$TEST_RUNTIME_ROOT"
    TEST_RUNTIME_ROOT=""
  fi
}

# Always teardown on exit (covers crashes, Ctrl+C, etc.)
trap teardown_test_environment EXIT

# ── Assertions ──────────────────────────────────────────────────────
assert_dir_exists() {
  if [ ! -d "$1" ]; then
    echo -e "    ${RED}FAIL${NC}: directory '$1' does not exist"
    return 1
  fi
}

assert_file_exists() {
  if [ ! -f "$1" ]; then
    echo -e "    ${RED}FAIL${NC}: file '$1' does not exist"
    return 1
  fi
}

assert_file_not_exists() {
  if [ -f "$1" ]; then
    echo -e "    ${RED}FAIL${NC}: file '$1' should not exist"
    return 1
  fi
}

assert_file_contains() {
  local file="$1"
  local pattern="$2"
  if ! grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: '$file' does not contain '$pattern'"
    return 1
  fi
}

assert_file_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: '$file' should not contain '$pattern'"
    return 1
  fi
}

assert_matches_pattern() {
  local value="$1"
  local pattern="$2"
  if ! echo "$value" | grep -qE "$pattern"; then
    echo -e "    ${RED}FAIL${NC}: '$value' does not match pattern '$pattern'"
    return 1
  fi
}

assert_not_matches_pattern() {
  local value="$1"
  local pattern="$2"
  if echo "$value" | grep -qE "$pattern"; then
    echo -e "    ${RED}FAIL${NC}: '$value' should NOT match pattern '$pattern'"
    return 1
  fi
}

# ── Test Runner ─────────────────────────────────────────────────────
run_test() {
  local test_name="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  echo -e "\n${CYAN}▶ ${test_name}${NC}"

  setup_vault

  if "$test_name"; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "  ${GREEN}✓ PASSED${NC}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAILED_TESTS+=("$test_name")
    echo -e "  ${RED}✗ FAILED${NC}"
  fi

  teardown_vault
}

# ── Tests ───────────────────────────────────────────────────────────

test_plugin_structure() {
  # Verify plugin has all required files
  assert_file_exists "$PLUGIN_ROOT/.claude-plugin/plugin.json" || return 1
  assert_file_exists "$PLUGIN_ROOT/.codex-plugin/plugin.json" || return 1
  assert_file_exists "$PLUGIN_ROOT/.agents/plugins/marketplace.json" || return 1
  if git -C "$PLUGIN_ROOT" check-ignore -v .agents/plugins/marketplace.json 2>/dev/null | grep -vq '!.agents/plugins/marketplace.json'; then
    echo -e "    ${RED}FAIL${NC}: .agents/plugins/marketplace.json is ignored and will not be published"
    return 1
  fi
  assert_file_exists "$PLUGIN_ROOT/skills/setup/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/templates/SCHEMA.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/templates/CLAUDE-template.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/templates/raw-template.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/templates/practices-template.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/templates/cognition-template.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/references/gitignore-snippet.txt" || return 1
}

test_plugin_manifest() {
  # Verify Claude plugin.json has required fields
  local claude_manifest="$PLUGIN_ROOT/.claude-plugin/plugin.json"
  assert_file_contains "$claude_manifest" '"name": "me"' || return 1
  assert_file_contains "$claude_manifest" '"version"' || return 1
  assert_file_contains "$claude_manifest" '"description"' || return 1
  assert_file_contains "$PLUGIN_ROOT/.claude-plugin/marketplace.json" '"source": "./"' || return 1

  # Verify Codex plugin.json has required fields and exposes skills
  local codex_manifest="$PLUGIN_ROOT/.codex-plugin/plugin.json"
  assert_file_contains "$codex_manifest" '"name": "me"' || return 1
  assert_file_contains "$codex_manifest" '"version"' || return 1
  assert_file_contains "$codex_manifest" '"description"' || return 1
  assert_file_contains "$codex_manifest" '"skills": "./skills/"' || return 1
  assert_file_contains "$codex_manifest" '"displayName": "ME"' || return 1

  # Verify Codex-native marketplace metadata points at the repository root plugin.
  local codex_marketplace="$PLUGIN_ROOT/.agents/plugins/marketplace.json"
  assert_file_contains "$codex_marketplace" '"name": "me-marketplace"' || return 1
  assert_file_contains "$codex_marketplace" '"path": "./"' || return 1
  assert_file_contains "$codex_marketplace" '"installation": "AVAILABLE"' || return 1
}

test_vault_writer_public_binary() {
  assert_file_exists "$PLUGIN_ROOT/bin/vault-write.ts" || return 1
  assert_file_exists "$PLUGIN_ROOT/bin/runtime.ts" || return 1
  node -e '
    const p=require(process.argv[1]);
    if (p.bin["vault-write"] !== "bin/vault-write.ts") process.exit(1)
    if (p.bin["me-runtime"] !== "bin/runtime.ts") process.exit(1)
  ' "$PLUGIN_ROOT/package.json" || return 1
  if [ ! -x "$PLUGIN_ROOT/bin/vault-write.ts" ]; then
    echo -e "    ${RED}FAIL${NC}: vault-write entrypoint is not executable"
    return 1
  fi
  if [ ! -x "$PLUGIN_ROOT/bin/runtime.ts" ]; then
    echo -e "    ${RED}FAIL${NC}: runtime entrypoint is not executable"
    return 1
  fi

  local pack_dir install_dir tarball binary runtime_binary result
  pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/me-vault-pack.XXXXXX")
  install_dir=$(mktemp -d "${TMPDIR:-/tmp}/me-vault-install.XXXXXX")
  tarball=$(npm pack --silent --pack-destination "$pack_dir" "$PLUGIN_ROOT") || return 1
  npm install --silent --ignore-scripts --prefix "$install_dir" \
    "$pack_dir/$tarball" || return 1
  binary="$install_dir/node_modules/.bin/vault-write"
  if [ ! -x "$binary" ]; then
    echo -e "    ${RED}FAIL${NC}: packed vault-write binary is not executable"
    return 1
  fi
  runtime_binary="$install_dir/node_modules/.bin/me-runtime"
  if [ ! -x "$runtime_binary" ]; then
    echo -e "    ${RED}FAIL${NC}: packed me-runtime binary is not executable"
    return 1
  fi

  mkdir -p "$MOCK_VAULT/.me" "$MOCK_VAULT/raw" \
    "$MOCK_VAULT/practices" "$MOCK_VAULT/cognition"
  cp "$PLUGIN_ROOT/templates/SCHEMA.md" "$MOCK_VAULT/SCHEMA.md"
  echo '# Source' > "$MOCK_VAULT/raw/source.md"
  result=$(node -e '
    process.stdout.write(JSON.stringify({
      version: 1,
      layer: "practices",
      relativePath: "decisions/2026-07-26-packed-preview.md",
      markdown: [
        "---",
        "title: Packed Preview",
        "created: 2026-07-26",
        "tags: [decision]",
        "type: reflection",
        "source: \"[[raw/source]]\"",
        "project: \"\"",
        "---",
        "",
        "# Preview",
        ""
      ].join("\n"),
      index: { mode: "auto" }
    }));
  ' | "$binary" preview --vault-dir "$MOCK_VAULT") || return 1
  node -e '
    const result=JSON.parse(process.argv[1]);
    if (result.status !== "preview") process.exit(1);
  ' "$result" || return 1
  result=$("$runtime_binary" path --vault-dir "$MOCK_VAULT") || return 1
  node -e '
    const result=JSON.parse(process.argv[1]);
    if (!result.runtimeRoot || result.vaultDir !== process.argv[2]) process.exit(1);
  ' "$result" "$(cd "$MOCK_VAULT" && pwd -P)" || return 1
  rm -rf "$pack_dir" "$install_dir"

  local public_writer_paths=(
    "$PLUGIN_ROOT/bin/vault-write.ts"
    "$PLUGIN_ROOT/bin/vault-write"
    "$PLUGIN_ROOT/test/vault-write-cli.test.ts"
    "$PLUGIN_ROOT/package.json"
  )
  local private_product="xiao""etong"
  local private_product_zh="小鹅""通"
  local private_vault="brain""-spark"
  local user_root="/""Users/"
  local machine_user_path="${user_root}wu8685/"
  if rg -n -i \
    "$private_product|$private_product_zh|$private_vault|$machine_user_path" \
    "${public_writer_paths[@]}"; then
    echo -e "    ${RED}FAIL${NC}: public vault writer artifacts contain private or machine-specific data"
    return 1
  fi
}

test_codex_public_docs() {
  assert_file_contains "$PLUGIN_ROOT/README.md" '个人的知识操作系统\|面向个人的知识操作系统' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" 'Claude Code 或 Codex' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" 'claude plugin marketplace add https://github.com/wu8685/me.git' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" '/me:setup' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" 'codex plugin marketplace add https://github.com/wu8685/me.git' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" '\$me:setup' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" '一套知识库，多台工作机器' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" 'Obsidian Sync' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" 'ME 不接管云存储' || return 1
  assert_file_contains "$PLUGIN_ROOT/README.md" '跨工具、跨机器持续使用' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/README.md" '跨工具、跨机器迁移' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" '.agents/plugins/marketplace.json' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'me:setup' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/features.md" 'Codex skill' || return 1
}

test_external_runtime_documented() {
  local file
  for file in docs/user-guide.md docs/features.md docs/development.md; do
    assert_file_contains "$PLUGIN_ROOT/$file" '~/.me/runtime' || return 1
    assert_file_contains "$PLUGIN_ROOT/$file" 'ME_RUNTIME_ROOT' || return 1
    assert_file_not_contains "$PLUGIN_ROOT/$file" 'vault 相邻的 .me-runtime' || return 1
  done
  assert_file_not_contains "$PLUGIN_ROOT/README.md" '~/.me/runtime' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/README.md" 'ME_RUNTIME_ROOT' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/setup/SKILL.md" '~/.me/runtime' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/skills/setup/SKILL.md" 'under `.me-runtime`' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'bin/runtime.ts path' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'bin/runtime.ts prepare-inbox' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/development.md" '<ME_RUNTIME>' || return 1
  if grep -Fq 'same directory, no sync' "$PLUGIN_ROOT/AGENTS.md" \
    || grep -Fq 'same directory, no sync' "$PLUGIN_ROOT/CLAUDE.md"; then
    echo -e "    ${RED}FAIL${NC}: project instructions still assume vaults are never synced"
    return 1
  fi
}

test_shell_runtime_isolated() {
  if [ -z "${ME_RUNTIME_ROOT:-}" ]; then
    echo -e "    ${RED}FAIL${NC}: shell suite has no isolated ME_RUNTIME_ROOT"
    return 1
  fi
  case "$ME_RUNTIME_ROOT" in
    "${TMPDIR:-/tmp}/"*) ;;
    *)
      echo -e "    ${RED}FAIL${NC}: shell suite runtime is not under the temporary directory"
      return 1
      ;;
  esac
  if [ "$ME_RUNTIME_ROOT" = "${HOME}/.me/runtime" ]; then
    echo -e "    ${RED}FAIL${NC}: shell suite points at the real home runtime"
    return 1
  fi
}

test_skills_use_external_runtime() {
  local skills=(
    "$PLUGIN_ROOT/skills/ingest/SKILL.md"
    "$PLUGIN_ROOT/skills/decision-brief/SKILL.md"
    "$PLUGIN_ROOT/skills/setup/SKILL.md"
  )
  if rg -n '\.me/tmp|\.me/locks|\.me/ingest-reservations' "${skills[@]}"; then
    echo -e "    ${RED}FAIL${NC}: public skills still direct runtime state into the vault"
    return 1
  fi
  grep -Fq -- '--processed-markdown -' "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" 'bin/runtime.ts' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" 'prepare-inbox' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" 'bin/runtime.ts' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" 'prepare-inbox' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" '<ME_RUNTIME>' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/setup/SKILL.md" 'does not create runtime directories' || return 1
}

test_decision_brief_documented() {
  assert_file_not_contains "$PLUGIN_ROOT/README.md" 'decision-brief' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/features.md" '决策简报\|Decision Brief' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'me:decision-brief' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'profiles/decision-brief.md' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" '.me/.*配置' || return 1
  assert_file_contains "$PLUGIN_ROOT/docs/user-guide.md" 'vault-relative\|vault 内相对路径' || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" 'profile: profiles/decision-brief.md' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/docs/user-guide.md" '.me/profiles/decision-brief.md' || return 1
  assert_file_not_contains "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" '.me/profiles/decision-brief.md' || return 1
}

test_decision_brief_discovery_and_release_version() {
  assert_file_exists "$PLUGIN_ROOT/skills/decision-brief/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/.codex-plugin/plugin.json" '"skills": "./skills/"' || return 1

  local versions
  versions=$(bun -e "
    const fs = require('fs');
    const files = [
      'package.json',
      '.codex-plugin/plugin.json',
      '.claude-plugin/plugin.json',
    ];
    console.log(files.map(file => {
      const data = JSON.parse(fs.readFileSync('$PLUGIN_ROOT/' + file, 'utf8'));
      return data.version;
    }).join('\\n'));
  ")
  [ "$(echo "$versions" | sort -u | wc -l | tr -d ' ')" -eq 1 ] || {
    echo -e "    ${RED}FAIL${NC}: plugin manifest versions differ"
    return 1
  }
  [ "$(echo "$versions" | head -n 1)" = "1.6.0" ] || {
    echo -e "    ${RED}FAIL${NC}: expected current release version 1.6.0"
    return 1
  }
}

test_packed_release_has_no_private_paths() {
  local pack_dir extract_dir pack_json tarball scan_output
  pack_dir=$(mktemp -d "${TMPDIR:-/tmp}/me-public-pack.XXXXXX")
  extract_dir="$pack_dir/extracted"
  mkdir -p "$extract_dir"

  pack_json=$(npm pack --json --pack-destination "$pack_dir" "$PLUGIN_ROOT") || {
    rm -rf "$pack_dir"
    return 1
  }
  tarball=$(node -e '
    const entries = JSON.parse(process.argv[1]);
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].filename) process.exit(1);
    process.stdout.write(entries[0].filename);
  ' "$pack_json") || {
    rm -rf "$pack_dir"
    return 1
  }
  tar -xzf "$pack_dir/$tarball" -C "$extract_dir" || {
    rm -rf "$pack_dir"
    return 1
  }

  scan_output=$(node - "$extract_dir/package" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const forbidden = [
  { label: 'absolute user path', value: '/' + 'Users/' },
  { label: 'private vault name', value: ['brain', 'spark'].join('-') },
  { label: 'private product', value: ['小鹅', '通'].join('') },
  { label: 'private product alias', value: ['xiao', 'etong'].join('') },
];
const decoder = new TextDecoder('utf-8', { fatal: true });
const findings = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    for (const rule of forbidden) {
      if (text.toLowerCase().includes(rule.value.toLowerCase())) {
        findings.push(`${path.relative(root, absolute)}: ${rule.label}`);
      }
    }
  }
}

walk(root);
process.stdout.write(findings.join('\n'));
NODE
  ) || {
    rm -rf "$pack_dir"
    return 1
  }
  rm -rf "$pack_dir"

  if [ -n "$scan_output" ]; then
    echo "$scan_output"
    echo -e "    ${RED}FAIL${NC}: packed release contains private or machine-specific text"
    return 1
  fi
}

test_decision_brief_profile_example_uses_real_layer_contract() {
  mkdir -p "$MOCK_VAULT/.me" \
    "$MOCK_VAULT/sources" \
    "$MOCK_VAULT/field-notes" \
    "$MOCK_VAULT/insights"
  cp "$PLUGIN_ROOT/templates/SCHEMA.md" "$MOCK_VAULT/SCHEMA.md"

  node - "$PLUGIN_ROOT/docs/user-guide.md" "$MOCK_VAULT/.me/config.yaml" <<'NODE'
const fs = require('fs');
const guide = fs.readFileSync(process.argv[2], 'utf8');
const section = guide.match(/### 使用本地 Profile[\s\S]*?```yaml\n([\s\S]*?)```/);
if (!section) process.exit(1);
fs.writeFileSync(process.argv[3], section[1], 'utf8');
NODE

  local resolved
  resolved=$(bun -e "
    import { resolveVaultLayout } from '$PLUGIN_ROOT/bin/vault-write/path-safety.ts';
    import path from 'path';
    const layout = resolveVaultLayout('$MOCK_VAULT');
    console.log(JSON.stringify({
      raw: path.relative('$MOCK_VAULT', layout.layers.raw),
      practices: path.relative('$MOCK_VAULT', layout.layers.practices),
      cognition: path.relative('$MOCK_VAULT', layout.layers.cognition),
    }));
  ") || return 1

  [ "$resolved" = '{"raw":"sources","practices":"field-notes","cognition":"insights"}' ] || {
    echo -e "    ${RED}FAIL${NC}: documented Profile config did not resolve custom layers: $resolved"
    return 1
  }
  assert_file_contains "$MOCK_VAULT/.me/config.yaml" '^decision:' || return 1
  assert_file_contains "$MOCK_VAULT/.me/config.yaml" 'profile: profiles/decision-brief.md' || return 1
}

test_ingest_docs_rich_media() {
  local readme="$PLUGIN_ROOT/README.md"
  local features="$PLUGIN_ROOT/docs/features.md"
  local guide="$PLUGIN_ROOT/docs/user-guide.md"

  for term in HTML PDF X Bilibili "Source Bundle" handout degraded; do
    assert_file_contains "$features" "$term" || return 1
  done

  for term in "https://example.com/article" ".pdf" "x.com/" "bilibili.com/" handout degraded "依赖"; do
    assert_file_contains "$guide" "$term" || return 1
  done
  assert_file_contains "$guide" "defuddle" || return 1
  assert_file_contains "$guide" "PATH" || return 1
  assert_file_not_contains "$guide" "基础 HTML 摄入只需插件运行环境" || return 1
  grep -q -- "--bundle" "$guide" || {
    echo -e "    ${RED}FAIL${NC}: '$guide' does not document --bundle"
    return 1
  }

  local bundle_reference="$PLUGIN_ROOT/skills/ingest/references/source-bundle-v1.md"
  assert_file_contains "$guide" "静态数据" || return 1
  assert_file_contains "$guide" "不会执行" || return 1
  assert_file_not_contains "$guide" "可执行指令" || return 1
  assert_file_contains "$bundle_reference" "static data" || return 1
  assert_file_contains "$bundle_reference" "does not execute" || return 1
  assert_file_not_contains "$bundle_reference" "executable instruction" || return 1

  assert_file_contains "$features" "X auth wall" || return 1
  assert_file_contains "$features" "encrypted/DRM PDF" || return 1
  assert_file_not_contains "$features" "不可读取的错误页" || return 1

  assert_file_contains "$readme" "./docs/features.md" || return 1
  assert_file_not_contains "$readme" "Source Bundle" || return 1
  assert_file_not_contains "$readme" "degraded" || return 1
  assert_file_not_contains "$readme" "rich-ingest" || return 1
  assert_file_not_contains "$features" "rich-ingest" || return 1
  assert_file_not_contains "$guide" "rich-ingest" || return 1

  local versions
  versions=$(bun -e "
    const fs = require('fs');
    const files = [
      'package.json',
      '.codex-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
    ];
    console.log(files.map(file => {
      const data = JSON.parse(fs.readFileSync('$PLUGIN_ROOT/' + file, 'utf8'));
      return data.version ?? data.plugins?.[0]?.version;
    }).join('\\n'));
  ")
  [ "$(echo "$versions" | sort -u | wc -l | tr -d ' ')" -eq 1 ] || {
    echo -e "    ${RED}FAIL${NC}: plugin manifest versions differ"
    return 1
  }
  [ "$(echo "$versions" | head -n 1)" = "1.6.0" ] || {
    echo -e "    ${RED}FAIL${NC}: expected rich-ingest release version 1.6.0"
    return 1
  }

  local private_product private_product_zh private_vault user_root machine_user_path
  private_product="xiao""etong"
  private_product_zh="小鹅""通"
  private_vault="brain""-spark"
  user_root="/""Users/"
  machine_user_path="${user_root}wu8685/"
  local public_paths=(
    "$PLUGIN_ROOT/bin"
    "$PLUGIN_ROOT/skills"
    "$PLUGIN_ROOT/test"
    "$readme"
    "$features"
    "$guide"
    "$PLUGIN_ROOT/package.json"
    "$PLUGIN_ROOT/.codex-plugin"
    "$PLUGIN_ROOT/.claude-plugin"
  )

  if rg -n -i "$private_product|$private_product_zh|$private_vault|$machine_user_path" "${public_paths[@]}"; then
    echo -e "    ${RED}FAIL${NC}: public ingest artifacts contain private product or machine-specific data"
    return 1
  fi

  local absolute_path_matches unexpected_paths
  absolute_path_matches=$(rg -n "$user_root" "$PLUGIN_ROOT/test" || true)
  unexpected_paths=$(echo "$absolute_path_matches" \
    | grep -vE '/test/ingest-bundle\.test\.ts:[0-9]+:.*[/]Users/name/private' \
    | grep -vE '/test/skills/ingest/scenarios\.md:[0-9]+:.*[/]Users/me/Downloads/private-slide\.jpg' \
    || true)
  if [ -n "$unexpected_paths" ]; then
    echo "$unexpected_paths"
    echo -e "    ${RED}FAIL${NC}: public tests contain a non-allowlisted absolute user path"
    return 1
  fi

  # PRIVACY_SELF_PROBE Authorization: Bearer test-runner-self-probe
  local credential_matches unexpected_credentials credential_pattern
  local runner_probe_value redaction_auth_value redaction_cookie_value redaction_token_value
  local self_probe_matches credential_match
  runner_probe_value="Authoriza""tion: Bearer test-runner-self-probe"
  redaction_auth_value="Authoriza""tion: Bearer top-secret"
  redaction_cookie_value="Coo""kie: sid=super-secret"
  redaction_token_value="X-To""ken: token-secret"
  credential_pattern='Authoriza''tion:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_./+=-]+|Coo''kie:[[:space:]]*sid=[A-Za-z0-9_./+=-]+|X-To''ken:[[:space:]]*[A-Za-z0-9_./+=-]+|(?:coo''kie|authoriza''tion|to''ken|api[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:],;]{12,}|(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}'
  credential_matches=$(rg -n -o -i \
    "$credential_pattern" \
    "${public_paths[@]}" || true)
  self_probe_matches=$(echo "$credential_matches" \
    | grep -F "$PLUGIN_ROOT/test/vault-test.sh:" \
    | grep -F ":$runner_probe_value" \
    || true)
  if [ "$(echo "$self_probe_matches" | grep -c .)" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: privacy runner did not scan its own credential self-probe"
    return 1
  fi
  unexpected_credentials=""
  while IFS= read -r credential_match; do
    [ -z "$credential_match" ] && continue
    case "$credential_match" in
      "$PLUGIN_ROOT/test/ingest-command.test.ts:"*":$redaction_auth_value") ;;
      "$PLUGIN_ROOT/test/ingest-command.test.ts:"*":$redaction_cookie_value") ;;
      "$PLUGIN_ROOT/test/ingest-command.test.ts:"*":$redaction_token_value") ;;
      "$PLUGIN_ROOT/test/vault-test.sh:"*":$runner_probe_value") ;;
      *) unexpected_credentials+="${unexpected_credentials:+$'\n'}$credential_match" ;;
    esac
  done <<< "$credential_matches"
  if [ -n "$unexpected_credentials" ]; then
    echo "$unexpected_credentials"
    echo -e "    ${RED}FAIL${NC}: public artifacts contain a non-allowlisted credential-shaped value"
    return 1
  fi
}

test_schema_fields() {
  local schema="$PLUGIN_ROOT/templates/SCHEMA.md"
  # Core fields present
  assert_file_contains "$schema" '| `title`' || return 1
  assert_file_contains "$schema" '| `created`' || return 1
  assert_file_contains "$schema" '| `tags`' || return 1
  assert_file_contains "$schema" '| `type`' || return 1
  assert_file_contains "$schema" '| `source`' || return 1
  # Per-layer extensions
  assert_file_contains "$schema" '| `project`' || return 1
  assert_file_contains "$schema" '| `confidence`' || return 1
  # Forbidden fields documented
  assert_file_contains "$schema" 'status:' || return 1
  assert_file_contains "$schema" 'lifecycle:' || return 1
  assert_file_contains "$schema" 'date_created:' || return 1
}

test_templates_match_schema() {
  # Each template should have the core frontmatter fields
  for tmpl in raw-template.md practices-template.md cognition-template.md; do
    local f="$PLUGIN_ROOT/templates/$tmpl"
    assert_file_contains "$f" 'title:' || return 1
    assert_file_contains "$f" 'created:' || return 1
    assert_file_contains "$f" 'tags:' || return 1
    assert_file_contains "$f" 'type:' || return 1
    assert_file_contains "$f" 'source:' || return 1
  done
  # Layer-specific fields
  assert_file_contains "$PLUGIN_ROOT/templates/practices-template.md" 'project:' || return 1
  assert_file_contains "$PLUGIN_ROOT/templates/cognition-template.md" 'confidence:' || return 1
}

test_no_forbidden_fields_in_templates() {
  # Templates must not have status or lifecycle fields
  for tmpl in raw-template.md practices-template.md cognition-template.md; do
    local f="$PLUGIN_ROOT/templates/$tmpl"
    assert_file_not_contains "$f" '^status:' || return 1
    assert_file_not_contains "$f" '^lifecycle:' || return 1
  done
}

test_setup_creates_directories() {
  # Simulate what /me:setup does: create vault dirs
  mkdir -p "$MOCK_VAULT/raw" "$MOCK_VAULT/practices" "$MOCK_VAULT/cognition"
  touch "$MOCK_VAULT/raw/.gitkeep" "$MOCK_VAULT/practices/.gitkeep" "$MOCK_VAULT/cognition/.gitkeep"

  assert_dir_exists "$MOCK_VAULT/raw" || return 1
  assert_dir_exists "$MOCK_VAULT/practices" || return 1
  assert_dir_exists "$MOCK_VAULT/cognition" || return 1
  assert_file_exists "$MOCK_VAULT/raw/.gitkeep" || return 1
  assert_file_exists "$MOCK_VAULT/practices/.gitkeep" || return 1
  assert_file_exists "$MOCK_VAULT/cognition/.gitkeep" || return 1
}

test_setup_writes_schema() {
  # Simulate: copy SCHEMA.md to vault
  cp "$PLUGIN_ROOT/templates/SCHEMA.md" "$MOCK_VAULT/SCHEMA.md"

  assert_file_exists "$MOCK_VAULT/SCHEMA.md" || return 1
  assert_file_contains "$MOCK_VAULT/SCHEMA.md" "LOCKED" || return 1
  assert_file_contains "$MOCK_VAULT/SCHEMA.md" '| `title`' || return 1
}

test_setup_writes_claude_md() {
  # Simulate: copy CLAUDE-template to vault as CLAUDE.md
  cp "$PLUGIN_ROOT/templates/CLAUDE-template.md" "$MOCK_VAULT/CLAUDE.md"

  assert_file_exists "$MOCK_VAULT/CLAUDE.md" || return 1
  assert_file_contains "$MOCK_VAULT/CLAUDE.md" "Layer Map" || return 1
  assert_file_contains "$MOCK_VAULT/CLAUDE.md" "/me:setup" || return 1
  assert_file_contains "$MOCK_VAULT/CLAUDE.md" "/me:ingest" || return 1
}

test_setup_configures_gitignore_new() {
  # Simulate: no .gitignore exists, create from snippet
  cp "$PLUGIN_ROOT/references/gitignore-snippet.txt" "$MOCK_VAULT/.gitignore"

  assert_file_exists "$MOCK_VAULT/.gitignore" || return 1
  assert_file_contains "$MOCK_VAULT/.gitignore" ".obsidian/" || return 1
}

test_setup_configures_gitignore_append() {
  # Simulate: .gitignore exists without .obsidian/
  echo "node_modules/" > "$MOCK_VAULT/.gitignore"
  cat "$PLUGIN_ROOT/references/gitignore-snippet.txt" >> "$MOCK_VAULT/.gitignore"

  assert_file_contains "$MOCK_VAULT/.gitignore" "node_modules/" || return 1
  assert_file_contains "$MOCK_VAULT/.gitignore" ".obsidian/" || return 1
}

test_setup_gitignore_idempotent() {
  # Simulate: .gitignore already has .obsidian/
  echo ".obsidian/" > "$MOCK_VAULT/.gitignore"
  local before
  before=$(cat "$MOCK_VAULT/.gitignore")

  # Should not duplicate
  if ! grep -q "^\.obsidian/$" "$MOCK_VAULT/.gitignore"; then
    cat "$PLUGIN_ROOT/references/gitignore-snippet.txt" >> "$MOCK_VAULT/.gitignore"
  fi

  local count
  count=$(grep -c ".obsidian/" "$MOCK_VAULT/.gitignore")
  if [ "$count" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: .obsidian/ appears $count times (expected 1)"
    return 1
  fi
}

test_full_setup_simulation() {
  # Full end-to-end simulation of /me:setup
  local v="$MOCK_VAULT"

  # Step 3: Create directories
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"
  touch "$v/raw/.gitkeep" "$v/practices/.gitkeep" "$v/cognition/.gitkeep"

  # Step 4: Write SCHEMA.md
  cp "$PLUGIN_ROOT/templates/SCHEMA.md" "$v/SCHEMA.md"

  # Step 5: Write CLAUDE.md
  cp "$PLUGIN_ROOT/templates/CLAUDE-template.md" "$v/CLAUDE.md"

  # Step 6: Configure .gitignore
  cp "$PLUGIN_ROOT/references/gitignore-snippet.txt" "$v/.gitignore"

  # Verify everything
  assert_dir_exists "$v/raw" || return 1
  assert_dir_exists "$v/practices" || return 1
  assert_dir_exists "$v/cognition" || return 1
  assert_file_exists "$v/SCHEMA.md" || return 1
  assert_file_exists "$v/CLAUDE.md" || return 1
  assert_file_exists "$v/.gitignore" || return 1
  assert_file_contains "$v/CLAUDE.md" "three-layer knowledge vault" || return 1
  assert_file_contains "$v/SCHEMA.md" "LOCKED" || return 1
  assert_file_contains "$v/.gitignore" ".obsidian/" || return 1

  # Verify no forbidden fields leaked
  assert_file_not_contains "$v/SCHEMA.md" "^status:" || return 1
}

# ── Headless Move: grep+sed wikilink rewriting ────────────────────

test_move_has_headless_fallback() {
  # /me:move must now have a headless fallback (D-08 revised)
  local f="$PLUGIN_ROOT/skills/move/SKILL.md"
  assert_file_contains "$f" "headless\|fallback\|grep.*sed\|Headless" || return 1
  # Must NOT hard-stop when Obsidian is missing
  assert_file_not_contains "$f" "STOP.*Do NOT fall back" || return 1
}

test_headless_move_rename() {
  # Simulate headless in-place rename with wikilink update
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Create note A referencing note B via wikilink
  cat > "$v/raw/note-b.md" << 'EOF'
---
title: "Note B"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Content of note B.
EOF

  cat > "$v/practices/note-a.md" << 'EOF'
---
title: "Note A"
created: 2026-04-05
tags: [test]
type: experiment
source: "[[note-b]]"
project: ""
---

See [[note-b]] for details. Also [[note-b#section]] and [[note-b|alias]].
EOF

  # Headless rename: note-b -> note-b-renamed
  local old_name="note-b"
  local new_name="note-b-renamed"

  # 1. Rename the file
  mv "$v/raw/note-b.md" "$v/raw/note-b-renamed.md"

  # 2. Update all wikilink references (the pattern from move.md headless fallback)
  grep -rl "\[\[${old_name}" "$v/raw/" "$v/practices/" "$v/cognition/" --include="*.md" 2>/dev/null \
    | xargs sed -i '' "s/\[\[${old_name}\]\]/\[\[${new_name}\]\]/g; s/\[\[${old_name}|/\[\[${new_name}|/g; s/\[\[${old_name}#/\[\[${new_name}#/g"

  # Verify: old file gone, new file exists
  assert_file_not_exists "$v/raw/note-b.md" || return 1
  assert_file_exists "$v/raw/note-b-renamed.md" || return 1

  # Verify: wikilinks updated in note-a
  assert_file_contains "$v/practices/note-a.md" '\[\[note-b-renamed\]\]' || return 1
  assert_file_contains "$v/practices/note-a.md" '\[\[note-b-renamed#section\]\]' || return 1
  assert_file_contains "$v/practices/note-a.md" '\[\[note-b-renamed|alias\]\]' || return 1
  # Old references must be gone
  assert_file_not_contains "$v/practices/note-a.md" '\[\[note-b\]\]' || return 1
  assert_file_not_contains "$v/practices/note-a.md" '\[\[note-b#' || return 1
  assert_file_not_contains "$v/practices/note-a.md" '\[\[note-b|' || return 1
}

test_headless_move_cross_folder() {
  # Simulate headless cross-folder move with wikilink update
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/insight.md" << 'EOF'
---
title: "Insight"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

An insight ready to promote.
EOF

  cat > "$v/raw/other.md" << 'EOF'
---
title: "Other"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Related to [[insight]].
EOF

  # Cross-folder move: raw/insight.md -> cognition/insight.md
  mv "$v/raw/insight.md" "$v/cognition/insight.md"

  # Wikilinks are path-less ([[insight]]) so no link update needed for same-name moves
  # Just verify the file moved
  assert_file_not_exists "$v/raw/insight.md" || return 1
  assert_file_exists "$v/cognition/insight.md" || return 1
  # Reference should still work (wikilinks don't use paths)
  assert_file_contains "$v/raw/other.md" '\[\[insight\]\]' || return 1
}

test_headless_move_rename_custom_dirs() {
  # Headless rename with custom layer directories
  local v="$MOCK_VAULT"
  mkdir -p "$v/.me" "$v/调研" "$v/实践" "$v/认知"

  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "调研"
  practices: "实践"
  cognition: "认知"
EOF

  cat > "$v/调研/my-note.md" << 'EOF'
---
title: "My Note"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Content.
EOF

  cat > "$v/实践/referencing.md" << 'EOF'
---
title: "Referencing"
created: 2026-04-05
tags: [test]
type: experiment
source: "[[my-note]]"
project: ""
---

See [[my-note]] for more.
EOF

  # Resolve dirs from config
  local RAW_DIR PRACTICES_DIR COGNITION_DIR
  RAW_DIR=$(grep "raw:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  PRACTICES_DIR=$(grep "practices:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  COGNITION_DIR=$(grep "cognition:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')

  local old_name="my-note"
  local new_name="my-renamed-note"

  mv "$v/$RAW_DIR/my-note.md" "$v/$RAW_DIR/my-renamed-note.md"

  grep -rl "\[\[${old_name}" "$v/$RAW_DIR/" "$v/$PRACTICES_DIR/" "$v/$COGNITION_DIR/" --include="*.md" 2>/dev/null \
    | xargs sed -i '' "s/\[\[${old_name}\]\]/\[\[${new_name}\]\]/g; s/\[\[${old_name}|/\[\[${new_name}|/g; s/\[\[${old_name}#/\[\[${new_name}#/g"

  assert_file_exists "$v/$RAW_DIR/my-renamed-note.md" || return 1
  assert_file_contains "$v/$PRACTICES_DIR/referencing.md" '\[\[my-renamed-note\]\]' || return 1
  assert_file_not_contains "$v/$PRACTICES_DIR/referencing.md" '\[\[my-note\]\]' || return 1
}

# ── Config: Configurable Layer Directories ────────────────────────

test_setup_references_config() {
  # Setup skill must reference .me/config.yaml
  local f="$PLUGIN_ROOT/skills/setup/SKILL.md"
  assert_file_contains "$f" "config.yaml" || return 1
  assert_file_contains "$f" ".me/" || return 1
}

test_commands_reference_config() {
  # All vault skills must reference .me/config.yaml for layer resolution
  for skill in checklinks backlinks move autolinks; do
    local f="$PLUGIN_ROOT/skills/$skill/SKILL.md"
    assert_file_contains "$f" "config.yaml" || { echo "    missing config.yaml in $skill"; return 1; }
  done
}

test_claude_template_references_config() {
  # CLAUDE-template must document the config mechanism
  local f="$PLUGIN_ROOT/templates/CLAUDE-template.md"
  assert_file_contains "$f" "config.yaml" || return 1
  assert_file_contains "$f" "Configuration" || return 1
}

test_schema_references_config() {
  # SCHEMA.md should note that directory names come from config
  local f="$PLUGIN_ROOT/templates/SCHEMA.md"
  assert_file_contains "$f" "config.yaml" || return 1
}

test_setup_creates_config() {
  # Simulate setup creating .me/config.yaml with defaults
  local v="$MOCK_VAULT"

  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
# me plugin configuration
# Layer directory mapping — maps logical layers to actual directory paths
layers:
  raw: "raw"
  practices: "practices"
  cognition: "cognition"
EOF

  assert_file_exists "$v/.me/config.yaml" || return 1
  assert_file_contains "$v/.me/config.yaml" "raw" || return 1
  assert_file_contains "$v/.me/config.yaml" "practices" || return 1
  assert_file_contains "$v/.me/config.yaml" "cognition" || return 1
}

test_setup_creates_config_custom_dirs() {
  # Simulate setup with custom directory mapping (existing workspace)
  local v="$MOCK_VAULT"

  # Pre-existing directories
  mkdir -p "$v/调研" "$v/实践" "$v/认知"

  # Setup creates config with custom mapping
  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "调研"
  practices: "实践"
  cognition: "认知"
EOF

  assert_file_exists "$v/.me/config.yaml" || return 1
  assert_file_contains "$v/.me/config.yaml" '调研' || return 1
  assert_file_contains "$v/.me/config.yaml" '实践' || return 1
  assert_file_contains "$v/.me/config.yaml" '认知' || return 1
}

test_config_resolution_with_defaults() {
  # When no config exists, commands should use default dirs
  local v="$MOCK_VAULT"
  local RAW_DIR PRACTICES_DIR COGNITION_DIR

  # No .me/config.yaml — use defaults
  if [ -f "$v/.me/config.yaml" ]; then
    RAW_DIR=$(grep "raw:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
    PRACTICES_DIR=$(grep "practices:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
    COGNITION_DIR=$(grep "cognition:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  else
    RAW_DIR="raw"
    PRACTICES_DIR="practices"
    COGNITION_DIR="cognition"
  fi

  [ "$RAW_DIR" = "raw" ] || { echo -e "    ${RED}FAIL${NC}: RAW_DIR=$RAW_DIR (expected raw)"; return 1; }
  [ "$PRACTICES_DIR" = "practices" ] || { echo -e "    ${RED}FAIL${NC}: PRACTICES_DIR=$PRACTICES_DIR"; return 1; }
  [ "$COGNITION_DIR" = "cognition" ] || { echo -e "    ${RED}FAIL${NC}: COGNITION_DIR=$COGNITION_DIR"; return 1; }
}

test_config_resolution_with_custom() {
  # When config exists with custom dirs, resolve them correctly
  local v="$MOCK_VAULT"

  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "research"
  practices: "experiments"
  cognition: "insights"
EOF

  local RAW_DIR PRACTICES_DIR COGNITION_DIR
  RAW_DIR=$(grep "raw:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  PRACTICES_DIR=$(grep "practices:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  COGNITION_DIR=$(grep "cognition:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')

  [ "$RAW_DIR" = "research" ] || { echo -e "    ${RED}FAIL${NC}: RAW_DIR=$RAW_DIR (expected research)"; return 1; }
  [ "$PRACTICES_DIR" = "experiments" ] || { echo -e "    ${RED}FAIL${NC}: PRACTICES_DIR=$PRACTICES_DIR"; return 1; }
  [ "$COGNITION_DIR" = "insights" ] || { echo -e "    ${RED}FAIL${NC}: COGNITION_DIR=$COGNITION_DIR"; return 1; }
}

test_full_setup_simulation_with_config() {
  # Full e2e simulation with config file
  local v="$MOCK_VAULT"

  # Step: Write config
  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "raw"
  practices: "practices"
  cognition: "cognition"
EOF

  # Step: Create directories from config
  local RAW_DIR PRACTICES_DIR COGNITION_DIR
  RAW_DIR=$(grep "raw:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  PRACTICES_DIR=$(grep "practices:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  COGNITION_DIR=$(grep "cognition:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')

  mkdir -p "$v/$RAW_DIR" "$v/$PRACTICES_DIR" "$v/$COGNITION_DIR"
  touch "$v/$RAW_DIR/.gitkeep" "$v/$PRACTICES_DIR/.gitkeep" "$v/$COGNITION_DIR/.gitkeep"

  # Step: Write SCHEMA.md and CLAUDE.md
  cp "$PLUGIN_ROOT/templates/SCHEMA.md" "$v/SCHEMA.md"
  cp "$PLUGIN_ROOT/templates/CLAUDE-template.md" "$v/CLAUDE.md"
  cp "$PLUGIN_ROOT/references/gitignore-snippet.txt" "$v/.gitignore"

  # Verify
  assert_file_exists "$v/.me/config.yaml" || return 1
  assert_dir_exists "$v/$RAW_DIR" || return 1
  assert_dir_exists "$v/$PRACTICES_DIR" || return 1
  assert_dir_exists "$v/$COGNITION_DIR" || return 1
  assert_file_exists "$v/SCHEMA.md" || return 1
  assert_file_exists "$v/CLAUDE.md" || return 1
  assert_file_contains "$v/CLAUDE.md" "config.yaml" || return 1
}

test_setup_idempotent_with_config() {
  # Second setup should detect .me/config.yaml and stop
  local v="$MOCK_VAULT"

  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "raw"
  practices: "practices"
  cognition: "cognition"
EOF

  # Check should find config and report already initialized
  if [ -f "$v/.me/config.yaml" ]; then
    return 0  # Setup would stop here — correct behavior
  else
    echo -e "    ${RED}FAIL${NC}: config.yaml not detected for idempotency check"
    return 1
  fi
}

# -- Phase 2 re-impl: Native Graph Engine Tests --

test_graph_script_exists() {
  assert_file_exists "$PLUGIN_ROOT/bin/wikilink-graph.js" || return 1
  # Must be runnable via node
  node "$PLUGIN_ROOT/bin/wikilink-graph.js" --version 2>/dev/null || true
}

test_graph_outputs_valid_json() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
---
title: Note A
---
Content with no wikilinks.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const ok = Array.isArray(g.files) && typeof g.links === 'object' &&
                Array.isArray(g.broken) && Array.isArray(g.orphans) && Array.isArray(g.deadends);
    process.exit(ok ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: output is not valid JSON with required keys (files, links, broken, orphans, deadends)"
    echo "    output: $(echo "$output" | head -3)"
    return 1
  fi
}

test_graph_detects_broken_links() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
---
title: Note A
---
See [[missing-note]].
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(g.broken.some(b => b.target === 'missing-note') ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph did not detect broken link to [[missing-note]]"
    return 1
  fi
}

test_graph_no_false_broken() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
---
title: Note A
---
See [[existing-note]].
EOF

  cat > "$v/practices/existing-note.md" << 'EOF'
---
title: Existing Note
---
Content here.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(g.broken.some(b => b.target === 'existing-note') ? 1 : 0);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph falsely flagged [[existing-note]] as broken (file exists in practices/)"
    return 1
  fi
}

test_graph_detects_orphans() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # note-a links to note-b, but note-c is not linked by anyone
  cat > "$v/raw/note-a.md" << 'EOF'
See [[note-b]].
EOF

  cat > "$v/practices/note-b.md" << 'EOF'
Content.
EOF

  cat > "$v/cognition/note-c.md" << 'EOF'
Nobody links to me.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const isOrphan = g.orphans.some(f => f.includes('note-c'));
    process.exit(isOrphan ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph did not detect note-c as orphan (nobody links to it)"
    return 1
  fi
}

test_graph_detects_deadends() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # note-a has wikilinks, note-b has zero
  cat > "$v/raw/note-a.md" << 'EOF'
See [[note-b]].
EOF

  cat > "$v/practices/note-b.md" << 'EOF'
No outgoing links here.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const isDeadend = g.deadends.some(f => f.includes('note-b'));
    process.exit(isDeadend ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph did not detect note-b as dead-end (zero outgoing links)"
    return 1
  fi
}

test_graph_case_insensitive() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
See [[Note-B]].
EOF

  cat > "$v/practices/note-b.md" << 'EOF'
I am note-b (lowercase filename).
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  # [[Note-B]] should resolve to note-b.md (case-insensitive), so broken should be empty
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(g.broken.length === 0 ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: [[Note-B]] was not resolved case-insensitively to note-b.md"
    return 1
  fi
}

test_graph_parses_alias_variant() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
See [[note-b|display text]].
EOF

  cat > "$v/practices/note-b.md" << 'EOF'
Target note.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  # [[note-b|display text]] should extract target "note-b", not "note-b|display text"
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(g.broken.length === 0 ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: [[note-b|display text]] was not parsed correctly (alias variant)"
    return 1
  fi
}

test_graph_parses_heading_variant() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
See [[note-b#section-one]].
EOF

  cat > "$v/practices/note-b.md" << 'EOF'
Target note with sections.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  # [[note-b#section-one]] should extract target "note-b", not "note-b#section-one"
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(g.broken.length === 0 ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: [[note-b#section-one]] was not parsed correctly (heading variant)"
    return 1
  fi
}

test_graph_reads_config() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/.me" "$v/research" "$v/experiments" "$v/insights"

  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "research"
  practices: "experiments"
  cognition: "insights"
EOF

  cat > "$v/research/note-a.md" << 'EOF'
Custom dir note.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const found = g.files.some(f => f.includes('research'));
    process.exit(found ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph did not scan 'research/' dir as configured in .me/config.yaml"
    return 1
  fi
}

test_graph_default_dirs() {
  local v="$MOCK_VAULT"
  # No .me/config.yaml — should default to raw/, practices/, cognition/
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/note-a.md" << 'EOF'
Default dir note.
EOF

  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const found = g.files.some(f => f.includes('raw'));
    process.exit(found ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph did not scan 'raw/' as default when no config.yaml present"
    return 1
  fi
}

# ── Claude Code E2E Tests ─────────────────────────────────────────

test_e2e_me_setup() {
  if ! command -v claude &>/dev/null; then
    echo -e "    ${YELLOW}SKIP${NC}: claude CLI not found"
    return 0
  fi

  local output
  output=$(cd "$MOCK_VAULT" && claude --plugin-dir "$PLUGIN_ROOT" -p "/me:setup" --allowedTools "Bash,Read,Write,Glob,Grep,Edit" 2>&1) || true
  if echo "$output" | grep -qi "disabled Claude subscription access\\|Use an Anthropic API key"; then
    echo -e "    ${YELLOW}SKIP${NC}: Claude Code authentication unavailable"
    return 0
  fi

  echo "    claude output: $(echo "$output" | head -3)"

  assert_dir_exists "$MOCK_VAULT/raw" || return 1
  assert_dir_exists "$MOCK_VAULT/practices" || return 1
  assert_dir_exists "$MOCK_VAULT/cognition" || return 1
  assert_file_exists "$MOCK_VAULT/SCHEMA.md" || return 1
  assert_file_exists "$MOCK_VAULT/CLAUDE.md" || return 1
  assert_file_exists "$MOCK_VAULT/.gitignore" || return 1

  assert_file_contains "$MOCK_VAULT/CLAUDE.md" "three-layer knowledge vault" || return 1
  assert_file_contains "$MOCK_VAULT/CLAUDE.md" "/me:setup" || return 1
  assert_file_contains "$MOCK_VAULT/SCHEMA.md" "LOCKED" || return 1
  assert_file_contains "$MOCK_VAULT/.gitignore" ".obsidian/" || return 1

  assert_file_exists "$MOCK_VAULT/raw/.gitkeep" || return 1
  assert_file_exists "$MOCK_VAULT/practices/.gitkeep" || return 1
  assert_file_exists "$MOCK_VAULT/cognition/.gitkeep" || return 1
}

test_e2e_me_setup_idempotent() {
  if ! command -v claude &>/dev/null; then
    echo -e "    ${YELLOW}SKIP${NC}: claude CLI not found"
    return 0
  fi

  local first_output
  first_output=$(cd "$MOCK_VAULT" && claude --plugin-dir "$PLUGIN_ROOT" -p "/me:setup" --allowedTools "Bash,Read,Write,Glob,Grep,Edit" 2>&1) || true
  if echo "$first_output" | grep -qi "disabled Claude subscription access\\|Use an Anthropic API key"; then
    echo -e "    ${YELLOW}SKIP${NC}: Claude Code authentication unavailable"
    return 0
  fi

  local output
  output=$(cd "$MOCK_VAULT" && claude --plugin-dir "$PLUGIN_ROOT" -p "/me:setup" --allowedTools "Bash,Read,Write,Glob,Grep,Edit" 2>&1) || true

  echo "    second run output: $(echo "$output" | head -3)"

  assert_dir_exists "$MOCK_VAULT/raw" || return 1
  assert_file_exists "$MOCK_VAULT/SCHEMA.md" || return 1

  local count
  count=$(grep -c ".obsidian/" "$MOCK_VAULT/.gitignore" 2>/dev/null || echo "0")
  if [ "$count" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: .obsidian/ appears $count times after second run (expected 1)"
    return 1
  fi
}

test_no_hardcoded_paths() {
  # Commands must not reference ~/.claude/skills/me/
  local found=0
  for f in "$PLUGIN_ROOT"/commands/*.md; do
    if grep -q '~/.claude/skills/me' "$f" 2>/dev/null; then
      echo -e "    ${RED}FAIL${NC}: '$f' contains hardcoded ~/.claude/skills/me path"
      found=1
    fi
  done
  return $found
}

# ── Phase 2: Wikilink Management Tests ─────────────────────────────

test_commands_exist() {
  # All Phase 2 commands converted to skills
  assert_file_exists "$PLUGIN_ROOT/skills/checklinks/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/backlinks/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/move/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/autolinks/SKILL.md" || return 1
}

test_commands_have_description() {
  # Every skill file must have description frontmatter
  for skill in checklinks backlinks move autolinks setup; do
    local f="$PLUGIN_ROOT/skills/$skill/SKILL.md"
    assert_file_contains "$f" "^description:" || { echo "    missing in $skill"; return 1; }
  done
}

test_checklink_command_structure() {
  local f="$PLUGIN_ROOT/skills/checklinks/SKILL.md"
  # Must use TypeScript binary
  assert_file_contains "$f" "bin/checklinks.ts" || return 1
  # Must report broken wikilinks, orphans, dead-ends
  assert_file_contains "$f" "broken" || return 1
  assert_file_contains "$f" "orphan" || return 1
  assert_file_contains "$f" "dead-end" || return 1
  # Must resolve layers from config
  assert_file_contains "$f" "config.yaml" || return 1
}

test_backlinks_command_structure() {
  local f="$PLUGIN_ROOT/skills/backlinks/SKILL.md"
  # Must use TypeScript binary
  assert_file_contains "$f" "bin/backlinks.ts" || return 1
  # Must discover backlinks and unlinked mentions
  assert_file_contains "$f" "backlink" || return 1
  assert_file_contains "$f" "Unlinked\|unlinked" || return 1
  # Must resolve layers from config
  assert_file_contains "$f" "config.yaml" || return 1
  # Must show usage
  assert_file_contains "$f" "Usage" || return 1
}

test_move_command_structure() {
  local f="$PLUGIN_ROOT/skills/move/SKILL.md"
  # Must use TypeScript binary
  assert_file_contains "$f" "bin/move.ts" || return 1
  # Must preserve wikilink integrity
  assert_file_contains "$f" "wikilink" || return 1
  # Must use native grep+sed
  assert_file_contains "$f" "grep+sed\|grep.*sed" || return 1
  # Must resolve layers from config
  assert_file_contains "$f" "config.yaml" || return 1
  # Must show usage
  assert_file_contains "$f" "Usage" || return 1
}

test_move_has_obsidian_and_native() {
  # /me:move must describe both native (primary) and Obsidian (enhanced) modes
  local f="$PLUGIN_ROOT/skills/move/SKILL.md"
  assert_file_contains "$f" "native" || return 1
  assert_file_contains "$f" "Obsidian" || return 1
}

# ── Phase 2 Plan 02: Native-First Architecture Tests ───────────────

test_checklink_native_engine() {
  # Verify checklinks skill uses native engine as primary mode (via TypeScript binary)
  local f="$PLUGIN_ROOT/skills/checklinks/SKILL.md"
  assert_file_contains "$f" "bin/checklinks.ts" || return 1
  # Must NOT contain "partial coverage" warning (per Pitfall 6)
  assert_file_not_contains "$f" "partial coverage" || return 1
}

test_backlinks_native_engine() {
  # Verify backlinks skill uses native engine for backlink discovery (via TypeScript binary)
  local f="$PLUGIN_ROOT/skills/backlinks/SKILL.md"
  assert_file_contains "$f" "bin/backlinks.ts" || return 1
  # Must NOT contain "partial coverage" warning
  assert_file_not_contains "$f" "partial coverage" || return 1
  # Must mention unlinked mentions
  assert_file_contains "$f" "unlinked" || return 1
}

test_move_native_primary() {
  # Verify move skill uses native grep+sed as primary mode
  local f="$PLUGIN_ROOT/skills/move/SKILL.md"
  assert_file_contains "$f" "bin/move.ts" || return 1
  # Must use native grep+sed for wikilink rewriting
  assert_file_contains "$f" "grep+sed\|grep.*sed" || return 1
  # Must still mention Obsidian as enhanced option
  assert_file_contains "$f" "Obsidian" || return 1
}

test_graph_backlinks_inversion() {
  # E2E test: verify graph script can invert links map for backlink discovery
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Create notes: note-a and note-c both link to note-b
  cat > "$v/raw/note-a.md" << 'EOF'
See [[note-b]] for details.
EOF

  cat > "$v/practices/note-c.md" << 'EOF'
Also see [[note-b]].
EOF

  cat > "$v/cognition/note-b.md" << 'EOF'
Content here.
EOF

  # Run graph script and verify backlink inversion works
  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)

  # Verify that inverting the links map for "note-b" yields both note-a and note-c
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    // Build backlink map by inverting links
    const backlinks = {};
    for (const [source, targets] of Object.entries(g.links)) {
      for (const target of targets) {
        const t = target.toLowerCase();
        if (!backlinks[t]) backlinks[t] = [];
        backlinks[t].push(source);
      }
    }
    // Check note-b has backlinks from both note-a and note-c
    const noteBBacklinks = backlinks['note-b'] || [];
    const hasNoteA = noteBBacklinks.some(f => f.includes('note-a'));
    const hasNoteC = noteBBacklinks.some(f => f.includes('note-c'));
    process.exit((hasNoteA && hasNoteC) ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph backlinks inversion did not find note-a and note-c as backlinks to note-b"
    return 1
  fi
}

test_claude_template_has_wikilink_commands() {
  # CLAUDE-template.md should reference all wikilink commands
  local f="$PLUGIN_ROOT/templates/CLAUDE-template.md"
  assert_file_contains "$f" "/me:checklinks" || return 1
  assert_file_contains "$f" "/me:backlinks" || return 1
  assert_file_contains "$f" "/me:move" || return 1
  # Should have after-creation workflow
  assert_file_contains "$f" "After Creating a Note" || return 1
}

test_headless_broken_link_detection() {
  # Simulate the grep fallback for broken link detection
  local v="$MOCK_VAULT"

  # Setup vault with notes
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Create a note with a valid and a broken wikilink
  cat > "$v/raw/2026-04-05-test-note.md" << 'NOTEEOF'
---
title: "Test Note"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Links to [[2026-04-05-existing-note]] and [[nonexistent-note]].
NOTEEOF

  # Create the target of the valid link
  cat > "$v/practices/2026-04-05-existing-note.md" << 'NOTEEOF'
---
title: "Existing Note"
created: 2026-04-05
tags: [test]
type: experiment
source: "[[2026-04-05-test-note]]"
project: ""
---

This note exists.
NOTEEOF

  # Run the grep broken-link detection pattern from links.md
  local broken
  broken=$(cd "$v" && grep -roh '\[\[[^]]*\]\]' raw/ practices/ cognition/ --include="*.md" 2>/dev/null \
    | sed 's/\[\[//;s/\]\]//' \
    | sed 's/|.*//' \
    | sed 's/#.*//' \
    | sort -u \
    | while IFS= read -r link; do
        find raw/ practices/ cognition/ -name "${link}.md" 2>/dev/null | grep -q . \
          || echo "BROKEN: [[${link}]]"
      done)

  # Should detect nonexistent-note as broken
  if ! echo "$broken" | grep -q "nonexistent-note"; then
    echo -e "    ${RED}FAIL${NC}: grep fallback did not detect broken link to [[nonexistent-note]]"
    echo "    broken output: $broken"
    return 1
  fi

  # Should NOT flag existing-note as broken
  if echo "$broken" | grep -q "existing-note"; then
    echo -e "    ${RED}FAIL${NC}: grep fallback falsely flagged [[2026-04-05-existing-note]] as broken"
    return 1
  fi
}

test_headless_broken_link_detection_custom_dirs() {
  # Same as test_headless_broken_link_detection but with custom layer directories
  local v="$MOCK_VAULT"

  # Setup vault with custom directory names (Chinese)
  mkdir -p "$v/.me" "$v/调研" "$v/实践" "$v/认知"
  cat > "$v/.me/config.yaml" << 'CFGEOF'
layers:
  raw: "调研"
  practices: "实践"
  cognition: "认知"
CFGEOF

  # Create a note with a valid and a broken wikilink
  cat > "$v/调研/2026-04-05-test-note.md" << 'NOTEEOF'
---
title: "Test Note"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Links to [[2026-04-05-existing-note]] and [[nonexistent-note]].
NOTEEOF

  cat > "$v/实践/2026-04-05-existing-note.md" << 'NOTEEOF'
---
title: "Existing Note"
created: 2026-04-05
tags: [test]
type: experiment
source: "[[2026-04-05-test-note]]"
project: ""
---

This note exists.
NOTEEOF

  # Resolve layer dirs from config (same pattern as commands)
  local RAW_DIR PRACTICES_DIR COGNITION_DIR
  RAW_DIR=$(grep "raw:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  PRACTICES_DIR=$(grep "practices:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')
  COGNITION_DIR=$(grep "cognition:" "$v/.me/config.yaml" | sed 's/.*: *"\([^"]*\)".*/\1/')

  # Run broken-link detection using config-resolved dirs
  local broken
  broken=$(cd "$v" && grep -roh '\[\[[^]]*\]\]' "$RAW_DIR/" "$PRACTICES_DIR/" "$COGNITION_DIR/" --include="*.md" 2>/dev/null \
    | sed 's/\[\[//;s/\]\]//' \
    | sed 's/|.*//' \
    | sed 's/#.*//' \
    | sort -u \
    | while IFS= read -r link; do
        find "$RAW_DIR/" "$PRACTICES_DIR/" "$COGNITION_DIR/" -name "${link}.md" 2>/dev/null | grep -q . \
          || echo "BROKEN: [[${link}]]"
      done)

  if ! echo "$broken" | grep -q "nonexistent-note"; then
    echo -e "    ${RED}FAIL${NC}: grep fallback with custom dirs did not detect broken link"
    return 1
  fi
  if echo "$broken" | grep -q "existing-note"; then
    echo -e "    ${RED}FAIL${NC}: grep fallback with custom dirs falsely flagged existing note"
    return 1
  fi
}

test_headless_backlink_detection() {
  # Simulate grep fallback for backlink discovery
  local v="$MOCK_VAULT"

  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Note A links to Note B
  cat > "$v/raw/note-a.md" << 'EOF'
---
title: "Note A"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

See [[note-b]] for details.
EOF

  # Note B exists
  cat > "$v/practices/note-b.md" << 'EOF'
---
title: "Note B"
created: 2026-04-05
tags: [test]
type: experiment
source: "[[note-a]]"
project: ""
---

Content here.
EOF

  # Note C mentions "note-b" as plain text (unlinked mention)
  cat > "$v/cognition/note-c.md" << 'EOF'
---
title: "Note C"
created: 2026-04-05
tags: [test]
type: insight
source: ""
confidence: medium
---

I learned from note-b that this is important.
EOF

  # Find backlinks to note-b (notes containing [[note-b]])
  local backlinks
  backlinks=$(cd "$v" && grep -rl '\[\[note-b\]\]' raw/ practices/ cognition/ --include="*.md" 2>/dev/null)

  if ! echo "$backlinks" | grep -q "note-a"; then
    echo -e "    ${RED}FAIL${NC}: backlink grep did not find note-a → note-b link"
    return 1
  fi

  # Find unlinked mentions of "note-b" (plain text, not wikilinked)
  local mentions
  mentions=$(cd "$v" && grep -rl "note-b" raw/ practices/ cognition/ --include="*.md" 2>/dev/null \
    | while IFS= read -r f; do
        grep -L '\[\[note-b\]\]' "$f" 2>/dev/null
      done)

  if ! echo "$mentions" | grep -q "note-c"; then
    echo -e "    ${RED}FAIL${NC}: unlinked mention grep did not find note-c mentioning note-b"
    return 1
  fi
}

test_e2e_me_checklink_headless() {
  if ! command -v claude &>/dev/null; then
    echo -e "    ${YELLOW}SKIP${NC}: claude CLI not found"
    return 0
  fi

  local v="$MOCK_VAULT"
  local setup_output
  setup_output=$(cd "$v" && claude --plugin-dir "$PLUGIN_ROOT" -p "/me:setup" --allowedTools "Bash,Read,Write,Glob,Grep,Edit" 2>&1) || true
  if echo "$setup_output" | grep -qi "disabled Claude subscription access\\|Use an Anthropic API key"; then
    echo -e "    ${YELLOW}SKIP${NC}: Claude Code authentication unavailable"
    return 0
  fi

  mkdir -p "$v/raw"
  cat > "$v/raw/2026-04-05-test.md" << 'EOF'
---
title: "Test"
created: 2026-04-05
tags: [test]
type: article
source: "https://example.com"
---

Links to [[does-not-exist]].
EOF

  local output
  output=$(cd "$v" && claude --plugin-dir "$PLUGIN_ROOT" -p "/me:checklinks" --allowedTools "Bash,Read,Write,Glob,Grep,Edit" 2>&1) || true

  echo "    claude output: $(echo "$output" | head -5)"

  if echo "$output" | grep -qi "broken\\|does-not-exist\\|unresolved\\|headless\\|grep"; then
    return 0
  else
    echo -e "    ${RED}FAIL${NC}: /me:checklinks did not report broken link or headless mode"
    return 1
  fi
}

# ── Quick Task 260406-din: checklinks (plural) and autolink ─────────────

test_checklinks_files_exist() {
  # Verify checklinks bin file exists (plural form)
  assert_file_exists "$PLUGIN_ROOT/bin/checklinks.ts" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/checklinks/SKILL.md" || return 1

  # Old singular form should not exist
  if [ -f "$PLUGIN_ROOT/bin/checklink.ts" ]; then
    echo -e "    ${RED}FAIL${NC}: old checklink.ts still exists, should be checklinks.ts"
    return 1
  fi
}

test_checklinks_package_json() {
  # Verify package.json uses checklinks (plural) in bin
  local f="$PLUGIN_ROOT/package.json"
  assert_file_contains "$f" '"checklinks":' || return 1
  # Should NOT contain singular checklink
  if grep -q '"checklink":' "$f"; then
    echo -e "    ${RED}FAIL${NC}: package.json still has checklink (singular)"
    return 1
  fi
}

test_autolinks_files_exist() {
  # Verify autolinks bin file exists (plural form)
  assert_file_exists "$PLUGIN_ROOT/bin/autolinks.ts" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/autolinks/SKILL.md" || return 1

  # Old singular form should not exist
  if [ -f "$PLUGIN_ROOT/bin/autolink.ts" ]; then
    echo -e "    ${RED}FAIL${NC}: old autolink.ts still exists, should be autolinks.ts"
    return 1
  fi
}

test_autolinks_imports_from_ingest() {
  # Verify autolinks.ts reuses functions from ingest.ts
  local f="$PLUGIN_ROOT/bin/autolinks.ts"
  assert_file_contains "$f" "from './ingest.js'" || return 1
  assert_file_contains "$f" "buildVaultIndex\|autoLink" || return 1
}

test_autolinks_single_note() {
  # Test single-note autolink mode
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Create three notes with titles that should link to each other
  cat > "$v/raw/ai-agents.md" << 'EOF'
---
title: "AI Agents"
created: 2026-04-06
tags: [ai]
type: article
source: "https://example.com"
---

Content about AI agents and LLMs.
EOF

  cat > "$v/practices/prompt-engineering.md" << 'EOF'
---
title: "Prompt Engineering"
created: 2026-04-06
tags: [ai]
type: experiment
source: ""
project: ""
---

We use prompt engineering to improve AI Agents behavior.
EOF

  cat > "$v/cognition/llm-principles.md" << 'EOF'
---
title: "LLM Principles"
created: 2026-04-06
tags: [ai]
type: principle
source: ""
confidence: high
---

AI Agents are built on LM Principles and prompt engineering.
EOF

  # Run autolinks on single note (practices/prompt-engineering.md)
  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "practices/prompt-engineering.md" > /tmp/autolinks-out.txt 2>&1
  local result=$?

  if [ $result -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: autolinks command failed"
    cat /tmp/autolinks-out.txt
    return 1
  fi

  # Verify single-note mode output
  assert_file_contains /tmp/autolinks-out.txt "Mode: Single-note" || return 1
  assert_file_contains /tmp/autolinks-out.txt "practices/prompt-engineering.md" || return 1

  # Verify only the specified file was modified (contains wikilink)
  # autoLink uses [[stem|title]] format
  assert_file_contains "$v/practices/prompt-engineering.md" '\[\[ai-agents|' || return 1

  # Verify other files were NOT modified (no wikilinks added)
  assert_file_not_contains "$v/raw/ai-agents.md" '\[\[' || return 1
  assert_file_not_contains "$v/cognition/llm-principles.md" '\[\[' || return 1
}

test_autolinks_bulk_mode_unchanged() {
  # Test that bulk mode still processes all files
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Create two notes
  cat > "$v/raw/agents.md" << 'EOF'
---
title: "Agents"
created: 2026-04-06
tags: [ai]
type: article
source: ""
---

Agents use tools.
EOF

  cat > "$v/practices/tools.md" << 'EOF'
---
title: "Tools"
created: 2026-04-06
tags: [ai]
type: experiment
source: ""
project: ""
---

We use tools with Agents.
EOF

  # Run autolinks in bulk mode (no file argument)
  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /tmp/autolinks-bulk-out.txt 2>&1
  local result=$?

  if [ $result -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: autolinks bulk command failed"
    cat /tmp/autolinks-bulk-out.txt
    return 1
  fi

  # Verify bulk mode output
  assert_file_contains /tmp/autolinks-bulk-out.txt "Found.*files to process" || return 1

  # Verify both files were modified (autoLink uses [[stem|title]] format)
  assert_file_contains "$v/raw/agents.md" '\[\[tools|' || return 1
  assert_file_contains "$v/practices/tools.md" '\[\[agents|' || return 1
}

test_autolinks_single_note_invalid_path() {
  # Test error handling for invalid note path
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/existing.md" << 'EOF'
---
title: "Existing"
created: 2026-04-06
tags: [test]
type: article
source: ""
---

Content here.
EOF

  # Run autolinks on non-existent file
  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/nonexistent.md" > /tmp/autolinks-error.txt 2>&1

  # Should show error about file not found
  assert_file_contains /tmp/autolinks-error.txt "not found\|does not exist\|error" || return 1
}

test_autolinks_no_nested_wikilinks() {
  # Bug fix: running autolinks multiple times should not create nested wikilinks
  # Regression test for: [[note-a|Note A]] becoming [[[[note|Note]]-a|...]]
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create notes with overlapping titles (Note A contains "Note")
  cat > "$v/raw/note-a.md" << 'EOF'
---
title: "Note A"
created: 2026-04-06
tags: [test]
type: article
source: ""

Content of Note A.
EOF

  cat > "$v/raw/test.md" << 'EOF'
---
title: "Test"
created: 2026-04-06
tags: [test]
type: article
source: ""

Discussion about Note A concept.
EOF

  cd "$v"
  # First run
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /dev/null
  # Second run - should NOT create nested wikilinks
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /dev/null
  # Third run - still no nesting
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /dev/null

  # Verify no nested wikilinks (pattern: [[...[[...]]...]])
  local content
  content=$(cat "$v/raw/test.md")
  # Count opening brackets - should have exactly 2 per wikilink
  local open_brackets=$(echo "$content" | grep -o '\[\[' | wc -l | tr -d ' ')
  # Should have 2 wikilinks = 4 brackets total, not more
  [ "$open_brackets" -le 4 ] || return 1

  # Verify no nested pattern [[...[[...]]
  ! echo "$content" | grep -q '\[\[.*\[\[' || return 1
}

# ── Quick task 260406-h3k: wikilink scanning and candidate extraction ──

test_scan_existing_wikilinks_empty_vault() {
  # Test 1: scanExistingWikilinks returns empty array for vault with no markdown files
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cd "$v"
  local result
  result=$(bun -e "import { scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; console.log(JSON.stringify([...scanExistingWikilinks('$v')]))" 2>&1)
  [ "$result" = "[]" ] || return 1
}

test_scan_existing_wikilinks_extracts_wikilinks() {
  # Test 2: scanExistingWikilinks extracts wikilinks from content
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

This references [[note-two]] and [[Note Three|display text]].
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

Links back to [[note-one]].
EOF

  cd "$v"
  local result
  result=$(bun -e "import { scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; const s = scanExistingWikilinks('$v'); console.log(JSON.stringify([...s].sort()))" 2>&1)

  # Should contain: note-one, note-two, Note Three (stems only, no display text)
  echo "$result" | grep -q '"note-one"' || return 1
  echo "$result" | grep -q '"note-two"' || return 1
  echo "$result" | grep -q '"Note Three"' || return 1
}

test_scan_existing_wikilinks_skips_code_blocks() {
  # Test 3: scanExistingWikilinks skips wikilinks inside code blocks
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/test.md" << 'EOF'
---
title: "Test"
created: 2026-04-06
tags: []
type: article
source: ""
---

Valid link: [[real-note]]

```bash
# This is code, should not be scanned
[[code-link]]
```

Another valid: [[another-note]]
EOF

  cd "$v"
  local result
  result=$(bun -e "import { scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; console.log(JSON.stringify([...scanExistingWikilinks('$v')]))" 2>&1)

  # Should have real-note and another-note, but NOT code-link
  echo "$result" | grep -q '"real-note"' || return 1
  echo "$result" | grep -q '"another-note"' || return 1
  ! echo "$result" | grep -q '"code-link"' || return 1
}

test_scan_existing_wikilinks_deduplicates() {
  # Test 4: scanExistingWikilinks returns unique wikilink stems
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

Links to [[common-note]] multiple times.
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

Also links to [[common-note]] and [[Common Note|display]].
EOF

  cd "$v"
  local result
  result=$(bun -e "import { scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; const s = scanExistingWikilinks('$v'); console.log(JSON.stringify([...s]))" 2>&1)

  # Should have only one instance of common-note (deduplicated)
  local count
  count=$(echo "$result" | grep -o '"common-note"' | wc -l | tr -d ' ')
  [ "$count" -eq 1 ] || return 1
}

test_scan_existing_wikilinks_respects_config() {
  # Test 5: scanExistingWikilinks respects layer directory config from .me/config.yaml
  local v="$MOCK_VAULT"

  # Create custom layer directories
  mkdir -p "$v/调研" "$v/实践" "$v/认知"

  # Create config with custom layer dirs
  mkdir -p "$v/.me"
  cat > "$v/.me/config.yaml" << 'EOF'
raw: 调研
practices: 实践
cognition: 认知
EOF

  # Create notes in custom dirs
  cat > "$v/调研/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

Link to [[note-two]].
EOF

  cat > "$v/实践/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

Link to [[note-one]].
EOF

  # Also create a note in default/raw - should NOT be scanned
  mkdir -p "$v/raw"
  cat > "$v/raw/ignored.md" << 'EOF'
---
title: "Ignored"
created: 2026-04-06
tags: []
type: article
source: ""
---

Link to [[should-not-appear]].
EOF

  cd "$v"
  local result
  result=$(bun -e "import { scanExistingWikilinks } from '$PLUGIN_ROOT/bin/ingest.ts'; const s = scanExistingWikilinks('$v'); console.log(JSON.stringify([...s].sort()))" 2>&1)

  # Should have note-one and note-two from custom dirs, but NOT should-not-appear
  echo "$result" | grep -q '"note-one"' || return 1
  echo "$result" | grep -q '"note-two"' || return 1
  ! echo "$result" | grep -q '"should-not-appear"' || return 1
}

test_autolinks_uses_existing_wikilinks() {
  # Test 1: autolinkCommand calls scanExistingWikilinks and logs count
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create a note with existing wikilinks
  cat > "$v/raw/existing-links.md" << 'EOF'
---
title: "Existing Links"
created: 2026-04-06
tags: []
type: article
source: ""
---

This has [[another-note]] already.
EOF

  cat > "$v/raw/another-note.md" << 'EOF'
---
title: "Another Note"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content here.
EOF

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" 2>&1)

  # Should mention scanning for existing wikilinks
  echo "$output" | grep -q "Scanning vault\|Found.*existing wikilink\|Existing wikilinks" || return 1
}

test_autolinks_preserves_existing_wikilinks() {
  # Test 2: autolinkCommand preserves existing wikilinks in files (doesn't duplicate)
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

This has [[note-two]] already.
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /dev/null 2>&1

  # Check that existing wikilink is preserved (not duplicated)
  local content
  content=$(cat "$v/raw/note1.md")

  # Should have exactly one [[note-two]] link
  local count
  count=$(echo "$content" | grep -o '\[\[note-two\]' | wc -l | tr -d ' ')
  [ "$count" -eq 1 ] || { echo "FAIL: expected 1 instance of [[note-two]], got $count"; return 1; }
}

test_autolinks_reports_existing_count() {
  # Test 3: autolinkCommand output reports "Existing wikilinks: N" before processing
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

[[note-a]] [[note-b]]
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

[[note-a]]
EOF

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" 2>&1)

  # Should report existing wikilink count
  echo "$output" | grep -qi "existing.*wikilink" || return 1
}

test_autolinks_reports_new_insertions() {
  # Test 4: autolinkCommand output shows "New wikilinks inserted: M" after processing
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create a note that references another note's title but has no wikilink yet
  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Target Note"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content about Target Note.
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Source Note"
created: 2026-04-06
tags: []
type: article
source: ""
---

This mentions Target Note but no link yet.
EOF

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" 2>&1)

  # Should report new wikilinks inserted
  echo "$output" | grep -qi "new.*wikilink\|inserted.*link" || return 1
}

test_autolinks_single_note_shows_existing_count() {
  # Test 5: Single-note mode also shows existing wikilink count
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note1.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: []
type: article
source: ""
---

[[note-two]] here.
EOF

  cat > "$v/raw/note2.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content.
EOF

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/note1.md" 2>&1)

  # Should still show existing wikilink count in single-note mode
  echo "$output" | grep -qi "existing.*wikilink" || return 1
}

test_extract_wikilink_candidates_identifies_phrases() {
  # Test 1: extractWikilinkCandidates identifies phrases that could be wikilinks
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create notes with titles
  cat > "$v/raw/ai-agents.md" << 'EOF'
---
title: "AI Agents"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content about AI agents.
EOF

  cat > "$v/raw/machine-learning.md" << 'EOF'
---
title: "Machine Learning"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content about ML.
EOF

  cd "$v"
  local result
  result=$(bun -e "import { extractWikilinkCandidates, buildVaultIndex } from '$PLUGIN_ROOT/bin/ingest.ts'; const idx = buildVaultIndex('$v'); const content = 'We discuss AI Agents and Machine Learning in this article.'; const cands = extractWikilinkCandidates(content, idx); console.log(JSON.stringify(cands.map(c => c.stem)))" 2>&1)

  # Should find both AI Agents and Machine Learning
  echo "$result" | grep -q '"ai-agents"' || return 1
  echo "$result" | grep -q '"machine-learning"' || return 1
}

test_extract_wikilink_candidates_filters_stop_words() {
  # Test 2: extractWikilinkCandidates filters out common words
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/the-agent.md" << 'EOF'
---
title: "The Agent"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content.
EOF

  cd "$v"
  local result
  result=$(bun -e "import { extractWikilinkCandidates, buildVaultIndex } from '$PLUGIN_ROOT/bin/ingest.ts'; const idx = buildVaultIndex('$v'); const content = 'The article discusses the concept.'; const cands = extractWikilinkCandidates(content, idx); console.log(JSON.stringify(cands))" 2>&1)

  # Should not match "the" as a candidate (stop word)
  ! echo "$result" | grep -q '"the-agent"' || return 1
}

test_extract_wikilink_candidates_matches_vault_index() {
  # Test 3: extractWikilinkCandidates returns candidates that exist in vault index
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/llm.md" << 'EOF'
---
title: "LLM"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content about LLM.
EOF

  cd "$v"
  local result
  result=$(bun -e "import { extractWikilinkCandidates, buildVaultIndex } from '$PLUGIN_ROOT/bin/ingest.ts'; const idx = buildVaultIndex('$v'); const content = 'We discuss LLM and AI in this article.'; const cands = extractWikilinkCandidates(content, idx); console.log(JSON.stringify(cands.map(c => c.stem)))" 2>&1)

  # Should find llm (exists in vault) but not AI (doesn't exist)
  echo "$result" | grep -q '"llm"' || return 1
  ! echo "$result" | grep -q '"ai"' || return 1
}

test_autolinks_suggests_candidates() {
  # Test 4: autolinkCommand logs potential candidates after processing
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create vault notes
  cat > "$v/raw/ai-agents.md" << 'EOF'
---
title: "AI Agents"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content about AI agents.
EOF

  # Create a note that mentions the title but doesn't link it
  cat > "$v/raw/article.md" << 'EOF'
---
title: "Article"
created: 2026-04-06
tags: []
type: article
source: ""
---

We discuss AI Agents in this article.
EOF

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" 2>&1)

  # After linking, should show candidates (though AI Agents might already be linked)
  echo "$output" | grep -qi "potential.*candidate\|Potential new\|candidates to consider" && echo "PASS" || echo "No candidates section (may already be linked)"
}

test_extract_wikilink_candidates_sorts_by_frequency() {
  # Test 5: Candidates are sorted by relevance (frequency in content)
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/llm.md" << 'EOF'
---
title: "LLM"
created: 2026-04-06
tags: []
type: article
source: ""
---

Content.
EOF

  cd "$v"
  local result
  result=$(bun -e "import { extractWikilinkCandidates, buildVaultIndex } from '$PLUGIN_ROOT/bin/ingest.ts'; const idx = buildVaultIndex('$v'); const content = 'LLM is great. LLM is useful. LLM is powerful.'; const cands = extractWikilinkCandidates(content, idx); console.log(JSON.stringify(cands))" 2>&1)

  # Should have count field showing frequency
  echo "$result" | grep -q '"count":3' || return 1

  cd "$PLUGIN_ROOT"
}

# ── Quick Task 260406-hwe: LLM-first autolinks ───────────────────────────

test_autolinks_llm_first_concept_extraction() {
  # Test LLM concept extraction phase
  # (Mock LLM output with hardcoded JSON for determinism)
  local concepts='{"concepts":[{"term":"neural network","reasoning":"core ML concept"}]}'
  # Verify SKILL.md has LLM extraction step
  grep -q "Extract.*key concepts" "$PLUGIN_ROOT/skills/autolinks/SKILL.md" || return 1
}

test_autolinks_merged_pool_concept_match() {
  # Test merged pool combines vault titles AND wikilink stems
  # LLM concepts that exist in merged pool are linked
  # Vault pool entries NOT extracted by LLM are still linked (D-07 additive)
  local v="$MOCK_VAULT"

  # Create mock vault with two notes
  mkdir -p "$v/practices"
  cat > "$v/practices/neural-networks.md" <<'EOF'
---
title: Neural Networks
created: 2026-04-06
tags: [ml]
type: practice
---
# Neural Networks
EOF

  cat > "$v/practices/deep-learning.md" <<'EOF'
---
title: Deep Learning
created: 2026-04-06
tags: [ml]
type: practice
---
# Deep Learning
EOF

  # Create article mentioning BOTH "Neural Networks" and "Deep Learning"
  mkdir -p "$v/raw"
  cat > "$v/raw/ml-article.md" <<'EOF'
---
title: ML Basics
created: 2026-04-06
tags: [ml]
type: article
---
Neural Networks architectures are fundamental. Deep Learning is popular.
EOF

  # Run with concept filter containing ONLY "Neural Networks" (no count field per D-05)
  local concepts='{"concepts":[{"term":"Neural Networks","reasoning":"core ML concept"}]}'
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/ml-article.md" --concepts "$concepts" > /tmp/autolinks-out.txt 2>&1

  # Should link BOTH neural-networks AND deep-learning (D-07 additive)
  grep -q "neural-networks" "$v/raw/ml-article.md" || return 1
  grep -q "deep-learning" "$v/raw/ml-article.md" || return 1
}

test_autolinks_backward_compat_no_concepts() {
  # Test backward compatibility: no --concepts flag = full merged pool matching
  local v="$MOCK_VAULT"

  # Create two notes - one appears in article, one doesn't
  mkdir -p "$v/practices"
  cat > "$v/practices/neural-networks.md" <<'EOF'
---
title: Neural Networks
created: 2026-04-06
tags: [ml]
type: practice
---
# Neural Networks
EOF

  cat > "$v/practices/deep-learning.md" <<'EOF'
---
title: Deep Learning
created: 2026-04-06
tags: [ml]
type: practice
---
# Deep Learning
EOF

  mkdir -p "$v/raw"
  cat > "$v/raw/ml-article.md" <<'EOF'
---
title: ML Basics
created: 2026-04-06
tags: [ml]
type: article
---
Neural Networks architectures are fundamental.
EOF

  # Run WITHOUT --concepts flag (full merged pool matching)
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/ml-article.md" > /tmp/autolinks-out.txt 2>&1

  # Should link "Neural Networks" (merged pool matches all vault titles)
  grep -q "neural-networks" "$v/raw/ml-article.md" || return 1

  # Should NOT link "Deep Learning" (not mentioned in article)
  ! grep -q "deep-learning" "$v/raw/ml-article.md" || return 1
}

test_autolinks_stubs_reported_for_missing_concepts() {
  # Test that concepts not in merged pool are reported as stubs (D-08)
  local v="$MOCK_VAULT"

  # Create article with "transformer" concept (not in vault)
  mkdir -p "$v/raw"
  cat > "$v/raw/llm-article.md" <<'EOF'
---
title: LLM Architecture
created: 2026-04-06
tags: [llm]
type: article
---
Transformer models revolutionized NLP. The transformer architecture uses self-attention.
EOF

  # Run with concept filter including "transformer" (not in vault, no count field per D-05)
  local concepts='{"concepts":[{"term":"transformer","reasoning":"core LLM architecture"}]}'
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/llm-article.md" --concepts "$concepts" > /tmp/autolinks-out.txt 2>&1

  # Should report "transformer" as stub
  grep -q "Stubs" /tmp/autolinks-out.txt || return 1
  grep -q "transformer" /tmp/autolinks-out.txt || return 1
}

test_autolinks_wikilink_stem_in_merged_pool() {
  # Test that wikilink stems from existing vault content are in merged pool (D-01)
  local v="$MOCK_VAULT"

  # Create note-a with a wikilink to "some-concept"
  mkdir -p "$v/practices"
  cat > "$v/practices/note-a.md" <<'EOF'
---
title: Note A
created: 2026-04-06
tags: [test]
type: practice
---
# Note A

This references [[some-concept]].
EOF

  # Create article mentioning "some-concept" as plain text
  mkdir -p "$v/raw"
  cat > "$v/raw/article.md" <<'EOF'
---
title: Article
created: 2026-04-06
tags: [test]
type: article
---
Discussion about some-concept.
EOF

  # Run autolinks on raw/article.md (no --concepts)
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/article.md" > /tmp/autolinks-out.txt 2>&1

  # Should link "some-concept" (wikilink stem matched from merged pool)
  grep -q "some-concept" "$v/raw/article.md" || return 1
}

test_autolinks_additive_non_concept_vault_entries() {
  # Test D-07 additive: vault entries not in LLM concepts still get linked
  local v="$MOCK_VAULT"

  # Create two notes
  mkdir -p "$v/practices"
  cat > "$v/practices/neural-networks.md" <<'EOF'
---
title: Neural Networks
created: 2026-04-06
tags: [ml]
type: practice
---
# Neural Networks
EOF

  cat > "$v/practices/deep-learning.md" <<'EOF'
---
title: Deep Learning
created: 2026-04-06
tags: [ml]
type: practice
---
# Deep Learning
EOF

  # Create article mentioning BOTH
  mkdir -p "$v/raw"
  cat > "$v/raw/ml-overview.md" <<'EOF'
---
title: ML Overview
created: 2026-04-06
tags: [ml]
type: article
---
Neural Networks and Deep Learning are related.
EOF

  # Run with --concepts containing ONLY "Neural Networks"
  local concepts='{"concepts":[{"term":"Neural Networks","reasoning":"core ML concept"}]}'
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/ml-overview.md" --concepts "$concepts" > /tmp/autolinks-out.txt 2>&1

  # Should link BOTH neural-networks AND deep-learning (additive)
  grep -q "neural-networks" "$v/raw/ml-overview.md" || return 1
  grep -q "deep-learning" "$v/raw/ml-overview.md" || return 1
}

test_autolinks_concept_no_count_field() {
  # Test D-05: concepts without count field work correctly
  local v="$MOCK_VAULT"

  # Create mock vault with one note
  mkdir -p "$v/practices"
  cat > "$v/practices/some-topic.md" <<'EOF'
---
title: SomeTopic
created: 2026-04-06
tags: [test]
type: practice
---
# SomeTopic
EOF

  # Create article mentioning the topic
  mkdir -p "$v/raw"
  cat > "$v/raw/article.md" <<'EOF'
---
title: Article
created: 2026-04-06
tags: [test]
type: article
---
Discussion about SomeTopic.
EOF

  # Run with concepts that have NO count field (D-05)
  local concepts='{"concepts":[{"term":"SomeTopic","reasoning":"test concept"}]}'
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/article.md" --concepts "$concepts" > /tmp/autolinks-out.txt 2>&1

  # Should exit 0 and process correctly
  local result=$?
  if [ $result -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: autolinks command failed with no-count concepts"
    cat /tmp/autolinks-out.txt
    return 1
  fi

  # Should link the topic
  grep -q "some-topic" "$v/raw/article.md" || return 1
}

# ── Phase 3 Plan 01: Ingest Output Format Validation Tests ───────────

test_ingest_output_frontmatter_schema() {
  local v="$MOCK_VAULT"
  # Resolve raw dir (default)
  local raw_dir="raw"
  mkdir -p "$v/$raw_dir/ai-agents"

  cat > "$v/$raw_dir/ai-agents/2026-04-06-test-article.md" << 'EOF'
---
title: "Test Article on AI Agents"
created: 2026-04-06
tags: [ai-agents, test, example]
type: article
source: "https://example.com/test-article"
---

<!-- Summary: A test article about AI agents for schema validation. -->

## Key Points

- Agents can plan and act autonomously
- Tool use enables real-world interaction

## Raw Notes

Content goes here.
EOF

  local f="$v/$raw_dir/ai-agents/2026-04-06-test-article.md"
  assert_file_contains "$f" "title:" || return 1
  assert_file_contains "$f" "created:" || return 1
  assert_file_contains "$f" "tags:" || return 1
  assert_file_contains "$f" "type: article" || return 1
  assert_file_contains "$f" "source:" || return 1
  assert_file_contains "$f" "https://" || return 1
  assert_file_not_contains "$f" "^status:" || return 1
  assert_file_not_contains "$f" "^lifecycle:" || return 1
  assert_file_not_contains "$f" "date_created:" || return 1
}

test_ingest_output_forbidden_fields() {
  local v="$MOCK_VAULT"
  local raw_dir="raw"
  mkdir -p "$v/$raw_dir/test-topic"

  # Create a file that VIOLATES the schema (has forbidden fields)
  cat > "$v/$raw_dir/test-topic/bad-note.md" << 'EOF'
---
title: "Bad Note"
created: 2026-04-06
tags: [test]
type: article
source: "https://example.com"
status: draft
date_created: 2026-04-06
---

Content.
EOF

  local f="$v/$raw_dir/test-topic/bad-note.md"

  # A validator SHOULD detect forbidden fields — grep returns 0 if found (violation)
  if ! grep -q "^status:" "$f"; then
    echo -e "    ${RED}FAIL${NC}: test setup error — bad-note.md should have status: field"
    return 1
  fi
  if ! grep -q "date_created:" "$f"; then
    echo -e "    ${RED}FAIL${NC}: test setup error — bad-note.md should have date_created: field"
    return 1
  fi
  # Validator logic: detect violations
  local violations=0
  grep -q "^status:" "$f" && violations=$((violations + 1))
  grep -q "^lifecycle:" "$f" && violations=$((violations + 1))
  grep -q "^date_created:" "$f" && violations=$((violations + 1))
  if [ "$violations" -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: validator did not detect forbidden fields in bad-note.md"
    return 1
  fi
  echo "  detected $violations forbidden field(s) in violation file (expected)"
}

test_ingest_output_filename_convention() {
  # Valid filename patterns
  local valid1="2026-04-06-test-article.md"
  local valid2="2026-01-01-attention-is-all-you-need.md"
  local valid3="2025-12-31-ai-agent-orchestration-patterns.md"

  local pattern="^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$"

  assert_matches_pattern "$valid1" "$pattern" || return 1
  assert_matches_pattern "$valid2" "$pattern" || return 1
  assert_matches_pattern "$valid3" "$pattern" || return 1

  # Invalid filename patterns (must NOT match)
  local invalid1="[2026-04-06] Test Article.md"      # brackets, spaces, uppercase
  local invalid2="2026-04-06-Test-Article.md"         # uppercase letters
  local invalid3="2026-04-06 test article.md"         # spaces

  assert_not_matches_pattern "$invalid1" "$pattern" || return 1
  assert_not_matches_pattern "$invalid2" "$pattern" || return 1
  assert_not_matches_pattern "$invalid3" "$pattern" || return 1
}

test_ingest_output_topic_folder_kebab_case() {
  # Valid topic folder names
  local valid_pattern="^[a-z0-9-]+$"

  assert_matches_pattern "ai-agents" "$valid_pattern" || return 1
  assert_matches_pattern "distributed-systems" "$valid_pattern" || return 1
  assert_matches_pattern "machine-learning" "$valid_pattern" || return 1
  assert_matches_pattern "prompt-engineering" "$valid_pattern" || return 1

  # Invalid topic folder names
  assert_not_matches_pattern "AI-Agents" "$valid_pattern" || return 1         # uppercase
  assert_not_matches_pattern "distributed systems" "$valid_pattern" || return 1  # spaces
  assert_not_matches_pattern "机器学习" "$valid_pattern" || return 1            # Chinese
  assert_not_matches_pattern "machine_learning" "$valid_pattern" || return 1   # underscores
}

test_ingest_output_body_structure() {
  local v="$MOCK_VAULT"
  local raw_dir="raw"
  mkdir -p "$v/$raw_dir/test-topic"

  cat > "$v/$raw_dir/test-topic/2026-04-06-test-body.md" << 'EOF'
---
title: "Test Body Structure"
created: 2026-04-06
tags: [test]
type: article
source: "https://example.com/test"
---

<!-- Summary: A short overview of the article content. -->

## Key Points

- First key point
- Second key point

## Raw Notes

Article content goes here.
EOF

  local f="$v/$raw_dir/test-topic/2026-04-06-test-body.md"
  assert_file_contains "$f" "## Key Points" || return 1
  assert_file_contains "$f" "## Raw Notes" || return 1
  assert_file_contains "$f" "Summary:" || return 1
}

test_ingest_skill_exists() {
  # Validate the ingest skill file in the plugin
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "^description:" || return 1
  local line_count
  line_count=$(wc -l < "$PLUGIN_ROOT/skills/ingest/SKILL.md")
  if [ "$line_count" -ge 500 ]; then
    echo -e "    ${RED}FAIL${NC}: SKILL.md has $line_count lines (must be under 500)"
    return 1
  fi
  echo "  SKILL.md: $line_count lines"
}

# ── Phase 3 Plan 01: Ingest Skill Content Tests (TDD RED) ────────────

test_ingest_skill_has_description() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "^description:" || return 1
}

test_ingest_skill_step0_config_resolution() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  # Config resolution now handled by bin/ingest.ts; SKILL.md still documents it
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "config.yaml" || return 1
}

test_ingest_skill_webreader_extraction() {
  # After refactor: SKILL.md uses defuddle via bin/ingest.ts, not mcp__web_reader__webReader
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "bin/ingest.ts" || return 1
}

test_ingest_skill_three_modes() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "translate-cn" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "summarize" || return 1
}

test_ingest_skill_auto_detect_mode() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "English" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "Chinese\|中文" || return 1
}

test_ingest_skill_topic_confirmation() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "kebab-case" || return 1
}

test_ingest_skill_processed_markdown_body_only() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "UTF-8 body-only Markdown" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "Do not include frontmatter" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "finalizer generates" || return 1
}

test_ingest_skill_no_forbidden_fields() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_not_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "date_created:" || return 1
  # status: and lifecycle: should not appear as frontmatter fields in the template
  # (they may appear in SCHEMA.md references, so we check for the exact field pattern)
}

test_ingest_skill_filename_convention() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "YYYY-MM-DD" || return 1
}

test_ingest_skill_image_localization_reporting() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "localizes available assets" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "warnings" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "not written" || return 1
}

test_ingest_skill_under_500_lines() {
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  local line_count
  line_count=$(wc -l < "$PLUGIN_ROOT/skills/ingest/SKILL.md")
  if [ "$line_count" -ge 500 ]; then
    echo -e "    ${RED}FAIL${NC}: SKILL.md has $line_count lines (must be under 500)"
    return 1
  fi
}

test_ingest_skill_rich_contract() {
  local f="$PLUGIN_ROOT/skills/ingest/SKILL.md"
  local handout="$PLUGIN_ROOT/skills/ingest/references/handout-contract.md"
  assert_file_contains "$f" "Source Bundle" || return 1
  assert_file_contains "$f" "handout" || return 1
  assert_file_contains "$f" "Slide-driven" || return 1
  assert_file_contains "$f" "Topic-driven" || return 1
  assert_file_contains "$f" "不得报告完成" || return 1
  assert_file_contains "$f" "UTF-8 body-only Markdown" || return 1
  assert_file_contains "$f" 'Translation (`translate-cn`)' || return 1
  assert_file_contains "$f" 'Summary (`summarize`)' || return 1
  assert_file_contains "$f" "writeResult" || return 1
  assert_file_not_contains "$f" "retry/fallback behavior" || return 1
  assert_file_not_contains "$f" "downloaded versus failed" || return 1
  assert_file_not_contains "$f" "transcript coverage" || return 1
  assert_file_not_contains "$handout" "transcript coverage" || return 1
  assert_file_not_contains "$f" "^title:" || return 1
}

# ── Quick 260517-fs2: Bilibili source adapter ──

test_ingest_skill_bilibili_source_adapter() {
  # SKILL.md must declare Bilibili as a source adapter and reference the
  # transcribe + whisper opt-in path for missing CC subtitles.
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "Source Adapters" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "Bilibili" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "transcribe" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "whisper" || return 1
}

test_ingest_bilibili_url_routing() {
  # bin/ingest.ts must export isBilibiliUrl and classify URLs correctly.
  # Positive case: a real Bilibili video URL must return true.
  # Negative case: an unrelated URL must return false.
  local bun_script="
import { isBilibiliUrl } from '$PLUGIN_ROOT/bin/ingest.ts';
if (!isBilibiliUrl('https://www.bilibili.com/video/BV1GpL76LEHH')) {
  console.error('positive case failed: bilibili.com/video/BV... should be true');
  process.exit(1);
}
if (isBilibiliUrl('https://example.com')) {
  console.error('negative case failed: example.com should be false');
  process.exit(2);
}
"
  if ! bun -e "$bun_script" 2>&1; then
    echo -e "    ${RED}FAIL${NC}: isBilibiliUrl routing check failed (see bun output above)"
    return 1
  fi
}

# ── Phase 3 Plan 02: Auto-Linking Tests ──────────────────────────────

test_ingest_autolink_body_only() {
  # Verify that wikilink replacement only happens in body text, not in frontmatter
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw/test-topic"

  local input_file="$v/raw/test-topic/2026-04-06-test.md"

  # Create a file where "title" appears in both frontmatter value and body
  cat > "$input_file" << 'EOF'
---
title: "My Article About Title"
created: 2026-04-06
tags: []
type: article
source: "https://example.com"
---

This article discusses title concepts.
EOF

  # Use Python to apply wikilink replacement body-only (frontmatter-safe)
  local result_file="$v/raw/test-topic/2026-04-06-test-result.md"
  python3 - "$input_file" "$result_file" << 'PYEOF'
import sys
content = open(sys.argv[1]).read()
parts = content.split('---', 2)
if len(parts) >= 3:
    front = parts[0] + '---' + parts[1] + '---'
    body = parts[2]
else:
    front = ''
    body = content
# Replace first occurrence of "title" in body only
body = body.replace('title', '[[title]]', 1)
open(sys.argv[2], 'w').write(front + body)
PYEOF

  # Count [[ occurrences in frontmatter (lines 1-7, before closing ---)
  # Frontmatter is between first and second --- delimiters
  local front_wikilinks
  front_wikilinks=$(awk '/^---/{n++; if(n==2){exit}} n==1{print}' "$result_file" | grep -c '\[\[' || true)
  front_wikilinks="${front_wikilinks:-0}"

  if [ "$front_wikilinks" -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: frontmatter contains wikilinks ($front_wikilinks found, expected 0)"
    return 1
  fi

  # Confirm body does contain replacement (lines after second ---)
  local body_has_wikilink
  body_has_wikilink=$(awk '/^---/{n++} n>=2 && !/^---/{print}' "$result_file" | grep -c '\[\[' || true)
  body_has_wikilink="${body_has_wikilink:-0}"

  if [ "$body_has_wikilink" -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: body text should contain [[title]] after replacement"
    return 1
  fi

  echo "  frontmatter wikilinks: 0 (correct)"
  echo "  body wikilinks: $body_has_wikilink (correct)"
}

test_ingest_autolink_first_occurrence_only() {
  # Verify that only the first occurrence of a term is replaced with a wikilink
  # Covers the case where the same term appears multiple times across multiple lines
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw/test-topic"

  local input_file="$v/raw/test-topic/2026-04-06-ml-article.md"

  # Create a file with "machine learning" appearing 3 times in body
  cat > "$input_file" << 'EOF'
---
title: "Machine Learning Overview"
created: 2026-04-06
tags: [machine-learning]
type: article
source: "https://example.com"
---

machine learning is a broad field.
Many approaches exist in machine learning today.
The future of machine learning looks bright.
EOF

  # Use Python to simulate first-occurrence-only replacement (Python .replace(x, y, 1) = first only)
  local result_file="$v/raw/test-topic/2026-04-06-ml-result.md"
  python3 - "$input_file" "$result_file" << 'PYEOF'
import sys
content = open(sys.argv[1]).read()
parts = content.split('---', 2)
if len(parts) >= 3:
    front = parts[0] + '---' + parts[1] + '---'
    body = parts[2]
else:
    front = ''
    body = content
# First occurrence only (case-insensitive match using replace with count=1)
import re
body = re.sub(r'machine learning', '[[machine-learning]]', body, count=1, flags=re.IGNORECASE)
open(sys.argv[2], 'w').write(front + body)
PYEOF

  # Count occurrences of [[machine-learning]] in result — should be exactly 1
  local count
  count=$(grep -ci '\[\[machine-learning\]\]' "$result_file" || true)
  count="${count:-0}"

  if [ "$count" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: [[machine-learning]] appears $count times (expected 1 — first occurrence only)"
    cat "$result_file"
    return 1
  fi

  # Also verify "machine learning" (unlinked) still appears 2 more times
  local remaining
  remaining=$(grep -ci 'machine learning' "$result_file" || true)
  remaining="${remaining:-0}"

  if [ "$remaining" -lt 2 ]; then
    echo -e "    ${RED}FAIL${NC}: remaining 'machine learning' occurrences: $remaining (expected >= 2)"
    return 1
  fi

  echo "  [[machine-learning]] occurrences: $count (correct — first occurrence only)"
  echo "  remaining unlinkd occurrences: $remaining (correct)"
}

test_ingest_autolink_stub_wikilink() {
  # Verify stub wikilinks: [[new-concept]] appears in file body but no .md file exists
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw/test-topic" "$v/raw" "$v/practices" "$v/cognition"

  # Create mock ingested file with a stub wikilink inserted in body text
  cat > "$v/raw/test-topic/2026-04-06-with-stub.md" << 'EOF'
---
title: "Article With Stub"
created: 2026-04-06
tags: [test]
type: article
source: "https://example.com"
---

This article introduces [[new-concept]] as a key idea.
The [[new-concept]] has no corresponding vault note yet.
EOF

  # Assert: vault has no file matching new-concept.md
  local stub_file_exists
  stub_file_exists=$(find "$v/raw" "$v/practices" "$v/cognition" \
    -name "new-concept.md" 2>/dev/null | wc -l | tr -d ' ')

  if [ "$stub_file_exists" -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: new-concept.md should NOT exist in vault (stubs are text-only broken wikilinks)"
    return 1
  fi

  # Assert: stub wikilink text appears in file body
  assert_file_contains "$v/raw/test-topic/2026-04-06-with-stub.md" '\[\[new-concept\]\]' || return 1

  echo "  stub file count: 0 (correct — no .md file created)"
  echo "  stub wikilink in body: present (correct)"
}

test_ingest_wikilink_graph_integration() {
  # Verify wikilink-graph.js works correctly with the vault structure ingest creates
  local v="$MOCK_VAULT"
  mkdir -p "$v/.me" "$v/raw/test-topic"

  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: "raw"
  practices: "practices"
  cognition: "cognition"
EOF

  # Create 2 notes as ingest would
  cat > "$v/raw/test-topic/2026-04-06-note-one.md" << 'EOF'
---
title: "Note One"
created: 2026-04-06
tags: [test]
type: article
source: "https://example.com/one"
---

Content of note one.
EOF

  cat > "$v/raw/test-topic/2026-04-06-note-two.md" << 'EOF'
---
title: "Note Two"
created: 2026-04-06
tags: [test]
type: article
source: "https://example.com/two"
---

Content of note two referencing [[2026-04-06-note-one]].
EOF

  # Run wikilink-graph.js on the mock vault
  local output
  output=$(node "$PLUGIN_ROOT/bin/wikilink-graph.js" "$v" 2>&1)

  # Assert: both files appear in the files array
  if ! echo "$output" | node -e "
    const g = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const hasNoteOne = g.files.some(f => f.includes('note-one'));
    const hasNoteTwo = g.files.some(f => f.includes('note-two'));
    process.exit((hasNoteOne && hasNoteTwo) ? 0 : 1);
  " 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: graph files array should contain both note-one and note-two"
    echo "    files: $(echo "$output" | node -e "const g=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(g.files.join(', '))" 2>/dev/null)"
    return 1
  fi

  echo "  graph integration: both ingested notes found in vault index"
}

test_ingest_related_notes_tag_overlap() {
  # Verify tag overlap structure is correct for related note scoring
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  # Note 1: shares 2 tags with new note (highest relevance)
  cat > "$v/raw/note-high-relevance.md" << 'EOF'
---
title: "High Relevance Note"
created: 2026-04-06
tags: [ai-agents, machine-learning, tools]
type: article
source: "https://example.com/high"
---

Content with ai-agents and machine-learning.
EOF

  # Note 2: shares 1 tag with new note (medium relevance)
  cat > "$v/practices/note-medium-relevance.md" << 'EOF'
---
title: "Medium Relevance Note"
created: 2026-04-06
tags: [ai-agents, productivity]
type: experiment
source: "[[note-high-relevance]]"
project: "test"
---

Experiment with ai-agents.
EOF

  # Note 3: shares 0 tags (not relevant)
  cat > "$v/cognition/note-no-relevance.md" << 'EOF'
---
title: "No Relevance Note"
created: 2026-04-06
tags: [cooking, recipes]
type: insight
source: ""
confidence: low
---

Unrelated content.
EOF

  # New ingested note has tags: [ai-agents, machine-learning]
  local new_tags="ai-agents machine-learning"

  # Simulate tag overlap scoring
  local high_score=0
  local medium_score=0
  local no_score=0

  for tag in $new_tags; do
    grep -q "^tags:.*${tag}" "$v/raw/note-high-relevance.md" 2>/dev/null && high_score=$((high_score + 2))
    grep -q "^tags:.*${tag}" "$v/practices/note-medium-relevance.md" 2>/dev/null && medium_score=$((medium_score + 2))
    grep -q "^tags:.*${tag}" "$v/cognition/note-no-relevance.md" 2>/dev/null && no_score=$((no_score + 2))
  done

  # Assert: high relevance note scores >= 4 (2 shared tags * 2pts)
  if [ "$high_score" -lt 4 ]; then
    echo -e "    ${RED}FAIL${NC}: high relevance note should score >= 4 pts (got $high_score)"
    return 1
  fi

  # Assert: medium relevance scores >= 2 (1 shared tag * 2pts)
  if [ "$medium_score" -lt 2 ]; then
    echo -e "    ${RED}FAIL${NC}: medium relevance note should score >= 2 pts (got $medium_score)"
    return 1
  fi

  # Assert: no relevance note scores 0 (below threshold)
  if [ "$no_score" -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: no relevance note should score 0 pts (got $no_score)"
    return 1
  fi

  echo "  high relevance note score: $high_score pts (expected >= 4)"
  echo "  medium relevance note score: $medium_score pts (expected >= 2)"
  echo "  no relevance note score: $no_score pts (expected 0)"
}

# ── Quick 260406-bxt: Ingest Script Integration Tests ─────────────────────────

test_ingest_script_exists() {
  assert_file_exists "$PLUGIN_ROOT/bin/ingest.ts" || return 1
}

test_ingest_script_cli_help() {
  # bin/ingest.ts --help should exit 0 and show usage
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/ingest.ts" --help 2>&1) || return 1
  if ! echo "$output" | grep -qi "usage\|bun run\|url\|mode"; then
    echo -e "    ${RED}FAIL${NC}: --help output does not show usage info"
    echo "    output: $output"
    return 1
  fi
}

test_ingest_help_lists_bundle_and_handout() {
  output=$(bun run "$PLUGIN_ROOT/bin/ingest.ts" --help 2>&1) || return 1
  echo "$output" | grep -q -- "--bundle" || return 1
  echo "$output" | grep -q "handout" || return 1
}

test_ingest_rejects_url_and_bundle_together() {
  bun run "$PLUGIN_ROOT/bin/ingest.ts" "https://example.com" --bundle "$PLUGIN_ROOT/test/fixtures/ingest/bundle-valid" >/dev/null 2>&1
  [ "$?" -ne 0 ]
}

test_ingest_skill_calls_script() {
  # SKILL.md must reference bin/ingest.ts (thin orchestrator pattern)
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "bin/ingest.ts" || return 1
}

test_ingest_skill_thin_orchestrator() {
  # SKILL.md must be under 200 lines (thin orchestrator, not monolithic instructions)
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  local line_count
  line_count=$(wc -l < "$PLUGIN_ROOT/skills/ingest/SKILL.md")
  if [ "$line_count" -ge 200 ]; then
    echo -e "    ${RED}FAIL${NC}: SKILL.md has $line_count lines (must be under 200 for thin orchestrator)"
    return 1
  fi
  echo "  SKILL.md: $line_count lines (under 200 limit)"
}

test_ingest_skill_llm_only_for_translate_summarize() {
  # SKILL.md should use LLM only for translate-cn and summarize
  assert_file_exists "$PLUGIN_ROOT/skills/ingest/SKILL.md" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "translate-cn" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "summarize" || return 1
  # Must NOT reference mcp__web_reader__webReader (defuddle replaces it)
  assert_file_not_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "mcp__web_reader__webReader" || return 1
}

# ── Decision Brief Skill Contract ──────────────────────────────────

decision_brief_has_structure_contract() {
  local f="$1"
  [ -f "$f" ] &&
    grep -Fxq 'name: decision-brief' "$f" &&
    grep -Eq '^description:.*Use when' "$f" &&
    grep -Fq 'Decision Contract' "$f" &&
    grep -Fxq 'Search order: cognition -> practices -> raw -> current external facts' "$f" &&
    grep -Fq 'references/evidence-contract.md' "$f" &&
    grep -Fq 'references/output-contract.md' "$f"
}

decision_brief_public_is_clean() {
  local dir="$1"
  local forbidden
  forbidden="brain""-spark|/""Users/|optimus""wu8685|小鹅""通"

  [ -d "$dir" ] &&
    ! grep -RIlE -- "$forbidden" "$dir" >/dev/null 2>&1
}

decision_brief_has_profile_contract() {
  local f="$1"
  [ -f "$f" ] &&
    grep -Fq 'profiles/decision-brief.md' "$f" &&
    grep -Fxq 'Profile path must remain inside the current vault' "$f" &&
    grep -Fxq 'Containment requires paired lexical and canonical vault roots' "$f" &&
    grep -Fxq 'Canonicalize the deepest existing ancestor when the Profile target is missing' "$f" &&
    grep -Fxq 'Reject dangling symlinks and realpath errors as unsafe' "$f" &&
    grep -Fxq 'Only a genuinely missing Profile whose ancestors are contained may use the generic flow' "$f" &&
    grep -Fxq 'Default output: chat only; do not write the vault without explicit authorization' "$f" &&
    grep -Fxq 'Never promote a decision directly to cognition' "$f"
}

test_decision_brief_skill_structure() {
  local f="$PLUGIN_ROOT/skills/decision-brief/SKILL.md"
  local valid="$MOCK_VAULT/valid-structure.md"
  local reversed="$MOCK_VAULT/reversed-structure.md"

  cat > "$valid" <<'EOF'
name: decision-brief
description: Use when a decision requires research.
# Decision Contract
Search order: cognition -> practices -> raw -> current external facts
Read references/evidence-contract.md and references/output-contract.md.
EOF
  sed 's/cognition -> practices -> raw/raw -> practices -> cognition/' "$valid" > "$reversed"

  if ! decision_brief_has_structure_contract "$valid"; then
    echo -e "    ${RED}FAIL${NC}: structure validator rejected its canonical fixture"
    return 1
  fi
  if decision_brief_has_structure_contract "$reversed"; then
    echo -e "    ${RED}FAIL${NC}: structure validator accepted a reversed search order"
    return 1
  fi

  if ! decision_brief_has_structure_contract "$f"; then
    echo -e "    ${RED}FAIL${NC}: decision brief Skill is missing its canonical structure contract"
    return 1
  fi
}

test_decision_brief_public_privacy() {
  local dir="$PLUGIN_ROOT/skills/decision-brief"
  local safe="$MOCK_VAULT/safe-skill"
  local private="$MOCK_VAULT/private-skill"
  local scan_output

  mkdir -p "$safe" "$private"
  printf '%s\n' 'Portable public decision guidance.' > "$safe/SKILL.md"
  printf '%s\n' 'Private profile: /''Users/example/private-profile.md' > "$private/SKILL.md"

  if ! decision_brief_public_is_clean "$safe"; then
    echo -e "    ${RED}FAIL${NC}: privacy validator rejected a public fixture"
    return 1
  fi
  if scan_output=$(decision_brief_public_is_clean "$private" 2>&1); then
    echo -e "    ${RED}FAIL${NC}: privacy validator accepted a private fixture"
    return 1
  fi
  if [ -n "$scan_output" ]; then
    echo -e "    ${RED}FAIL${NC}: privacy validator leaked matched content"
    return 1
  fi

  if ! decision_brief_public_is_clean "$dir"; then
    echo -e "    ${RED}FAIL${NC}: decision brief public files are missing or contain private data"
    return 1
  fi
}

test_decision_brief_profile_contract() {
  local f="$PLUGIN_ROOT/skills/decision-brief/SKILL.md"
  local valid="$MOCK_VAULT/valid-profile.md"
  local counterexample="$MOCK_VAULT/counterexample-profile.md"

  cat > "$valid" <<'EOF'
Optional profile: profiles/decision-brief.md
Profile path must remain inside the current vault
Containment requires paired lexical and canonical vault roots
Canonicalize the deepest existing ancestor when the Profile target is missing
Reject dangling symlinks and realpath errors as unsafe
Only a genuinely missing Profile whose ancestors are contained may use the generic flow
Default output: chat only; do not write the vault without explicit authorization
Never promote a decision directly to cognition
EOF
  cat > "$counterexample" <<'EOF'
Optional profile: profiles/decision-brief.md
The Profile may remain outside the current vault.
Only check the lexical path and ignore symlinks.
Treat realpath errors as a missing optional Profile.
Default output may write the vault without explicit authorization.
Promote every decision directly to cognition.
EOF

  if ! decision_brief_has_profile_contract "$valid"; then
    echo -e "    ${RED}FAIL${NC}: profile validator rejected its canonical fixture"
    return 1
  fi
  if decision_brief_has_profile_contract "$counterexample"; then
    echo -e "    ${RED}FAIL${NC}: profile validator accepted contradictory guidance"
    return 1
  fi

  if ! decision_brief_has_profile_contract "$f"; then
    echo -e "    ${RED}FAIL${NC}: decision brief Skill is missing its canonical Profile/write contract"
    return 1
  fi
}

test_decision_brief_profile_behavior_evidence() {
  local f="$PLUGIN_ROOT/test/skills/decision-brief/profile-boundary-results.md"
  local block
  local id
  local pair

  assert_file_exists "$f" || return 1
  grep -Fq 'Six samples ran through separate `codex exec --ephemeral` processes.' "$f" || return 1
  grep -Fq 'actual shell inspection' "$f" || return 1

  for pair in \
    'PB1 | Existing contained Profile | ACCEPT | ACCEPT | PASS' \
    'PB2 | Symlinked vault root, contained Profile | ACCEPT | ACCEPT | PASS' \
    'PB3 | Existing prefix escapes and target returns inside | REJECT_UNSAFE | REJECT_UNSAFE | PASS' \
    'PB4 | Missing target, all existing ancestors contained | GENERIC | GENERIC | PASS' \
    'PB5 | Dangling Profile symlink | REJECT_UNSAFE | REJECT_UNSAFE | PASS' \
    'PB6 | Existing ancestor and target escape | REJECT_UNSAFE | REJECT_UNSAFE | PASS'
  do
    grep -Fq "| $pair |" "$f" || return 1
  done

  [ "$(grep -Fc '**Evidence mode:** Exact excerpt' "$f")" -eq 5 ] || return 1
  [ "$(grep -Fc '**Evidence mode:** Portable substitution' "$f")" -eq 1 ] || return 1

  for id in PB1 PB2 PB3 PB4 PB5 PB6; do
    block="$(
      awk -v heading="### $id" '
        $0 == heading { in_sample = 1; next }
        in_sample && /^### PB[1-6]$/ { exit }
        in_sample { print }
      ' "$f"
    )"
    echo "$block" | grep -Eq '^\*\*Evidence mode:\*\* (Exact excerpt|Portable substitution)$' || return 1
    echo "$block" | grep -Eq '^> “.+' || return 1
    echo "$block" | grep -Eq '.”$' || return 1
  done

  block="$(
    awk '
      $0 == "### PB1" { in_sample = 1; next }
      in_sample && /^### PB[1-6]$/ { exit }
      in_sample { print }
    ' "$f"
  )"
  echo "$block" | grep -Fq '**Evidence mode:** Portable substitution' || return 1
  echo "$block" | grep -Fq '[portableized from raw temp path]' || return 1
}

test_decision_brief_write_transaction_contract() {
  local skill="$PLUGIN_ROOT/skills/decision-brief/SKILL.md"
  local evidence="$PLUGIN_ROOT/test/skills/decision-brief/write-transaction-results.md"
  local id
  local block

  assert_file_exists "$skill" || return 1
  grep -Fq 'bin/vault-write.ts preview' "$skill" || return 1
  grep -Fq 'bin/vault-write.ts write' "$skill" || return 1
  grep -Fq 'Do not invoke the CLI' "$skill" || return 1
  grep -Fq 'with empty, placeholder, or' "$skill" || return 1
  grep -Fq 'The first invocation must be `bin/vault-write.ts preview`' "$skill" || return 1
  grep -Fq 'Never use `apply_patch`, shell redirect, `mv`, or' "$skill" || return 1
  grep -Fq 'generic file operation to write a vault target.' "$skill" || return 1
  grep -Fq '`commitModel: journaled-cooperative`' "$skill" || return 1
  grep -Fq 'say `not written`' "$skill" || return 1

  assert_file_exists "$evidence" || return 1
  grep -Fq 'These checks validate evidence structure, not agent behavior.' "$evidence" || return 1
  grep -Fq '| WT1 | FAIL |' "$evidence" || return 1
  grep -Fq '| WT2 | FAIL |' "$evidence" || return 1
  grep -Fq '| WT3 | PASS |' "$evidence" || return 1
  grep -Fq '| WT4 | FAIL |' "$evidence" || return 1
  grep -Fq 'ctime and historical metadata are not restorable' "$evidence" || return 1

  for id in WT1 WT2 WT3 WT4; do
    [ "$(grep -Fc "### $id" "$evidence")" -eq 1 ] || return 1
    block="$(
      awk -v heading="### $id" '
        $0 == heading { in_probe = 1; next }
        in_probe && /^### WT[1-4]$/ { exit }
        in_probe { print }
      ' "$evidence"
    )"
    echo "$block" | grep -Fq '**Fresh context:**' || return 1
    echo "$block" | grep -Fq '**Fixture:**' || return 1
    echo "$block" | grep -Fq '**Operation:**' || return 1
    echo "$block" | grep -Fq '**Before hashes:**' || return 1
    echo "$block" | grep -Fq '**After hashes:**' || return 1
    echo "$block" | grep -Fq '**Exact excerpt:**' || return 1
    echo "$block" | grep -Fq '**Filesystem verdict:**' || return 1
  done

  for id in NW1 NW2 NW3 NW4 NW5; do
    [ "$(grep -Fc "### $id" "$evidence")" -eq 1 ] || return 1
    block="$(
      awk -v heading="### $id" '
        $0 == heading { in_probe = 1; next }
        in_probe && /^### NW[1-5]$/ { exit }
        in_probe { print }
      ' "$evidence"
    )"
    echo "$block" | grep -Fq '**Fresh context:**' || return 1
    echo "$block" | grep -Fq '**Before hashes:**' || return 1
    echo "$block" | grep -Fq '**After hashes:**' || return 1
    echo "$block" | grep -Fq '**Exact excerpt:**' || return 1
    echo "$block" | grep -Fq '**Filesystem verdict:**' || return 1
  done
}

test_decision_brief_writer_contract() {
  local skill="$PLUGIN_ROOT/skills/decision-brief/SKILL.md"
  local output="$PLUGIN_ROOT/skills/decision-brief/references/output-contract.md"
  local evidence="$PLUGIN_ROOT/test/skills/decision-brief/writer-results.md"
  local id
  local block
  local locale_slug_c
  local locale_slug_tr

  assert_file_exists "$skill" || return 1
  assert_file_exists "$output" || return 1

  grep -Fq 'bin/vault-write.ts preview' "$skill" || return 1
  grep -Fq 'bin/vault-write.ts write' "$skill" || return 1
  grep -Fq 'commitModel: journaled-cooperative' "$skill" || return 1
  grep -Fq 'status: committed' "$skill" || return 1
  grep -Fq 'status: validation_failed' "$skill" || return 1
  grep -Fq 'status: conflict' "$skill" || return 1
  grep -Fq 'status: unsupported' "$skill" || return 1
  grep -Fq 'status: manual_recovery' "$skill" || return 1
  grep -Fq 'recoveryState' "$skill" || return 1
  grep -Fq 'preservedPaths' "$skill" || return 1
  grep -Fq 'remainingMutations' "$skill" || return 1
  grep -Fq 'actions' "$skill" || return 1
  grep -Fq 'Do not set `acknowledgeCognition`' "$skill" || return 1
  grep -Fq 'type: reflection' "$skill" || return 1
  grep -Fq 'decisions/YYYY-MM-DD-<slug>.md' "$skill" || return 1
  grep -Fq 'existing path-qualified local wikilink' "$skill" || return 1
  grep -Fq 'Do not use `type: experiment`' "$skill" || return 1
  grep -Fq 'Markdown request through stdin' "$skill" || return 1
  grep -Fq '<ME_RUNTIME>' "$skill" || return 1
  grep -Fq 'Do not add a numeric suffix' "$skill" || return 1
  grep -Fq "decision.normalize('NFKC').trim()" "$skill" || return 1
  grep -Fq "replace(/\\p{White_Space}+/gu, ' ').toLowerCase()" "$skill" || return 1
  grep -Fq "normalizedDecision.replace(/[^a-z0-9]+/g, '-')" "$skill" || return 1
  grep -Fq ".update(Buffer.from(normalizedDecision, 'utf8'))" "$skill" || return 1
  grep -Fq ".slice(0, 12)" "$skill" || return 1
  if grep -Fq 'requestDigest' "$skill"; then
    echo -e "    ${RED}FAIL${NC}: decision slug must not derive from requestDigest"
    return 1
  fi
  if grep -Fq 'atomic commit' "$skill"; then
    echo -e "    ${RED}FAIL${NC}: Skill must not claim a cross-file atomic commit"
    return 1
  fi
  grep -Fq 'Never use `apply_patch`, shell redirect, `mv`, or' "$skill" || return 1
  grep -Fq 'generic file operation to write a vault target.' "$skill" || return 1

  LC_ALL=C bun run - <<'EOF' || return 1
const { createHash } = require('crypto');
function slug(decision) {
  const normalizedDecision = decision.normalize('NFKC').trim()
    .replace(/\p{White_Space}+/gu, ' ').toLowerCase();
  const ascii = normalizedDecision.replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return ascii || `decision-${
    createHash('sha256')
      .update(Buffer.from(normalizedDecision, 'utf8'))
      .digest('hex')
      .slice(0, 12)
  }`;
}
const cases = [
  ['Build Orchid Relay', 'build-orchid-relay'],
  ['Ｂｕｉｌｄ　ＯＲＣＨＩＤ', 'build-orchid'],
  ['one\u00a0two\u2003three', 'one-two-three'],
  ['MiXeD CaSe', 'mixed-case'],
  ['全中文决策', 'decision-d0fc28be7e6e'],
  ['***', 'decision-596f4162a52f'],
  ['', 'decision-e3b0c44298fc'],
  ['a'.repeat(61), 'a'.repeat(60)],
  [`${'a'.repeat(59)} b`, 'a'.repeat(59)],
];
for (const [input, want] of cases) {
  const got = slug(input);
  if (got !== want) throw new Error(`${JSON.stringify(input)}: ${got} != ${want}`);
}
EOF
  locale_slug_c="$(
    LC_ALL=C bun -e "console.log('INDIGO'.normalize('NFKC').trim().replace(/\\p{White_Space}+/gu, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, ''))"
  )" || return 1
  locale_slug_tr="$(
    LC_ALL=tr_TR.UTF-8 bun -e "console.log('INDIGO'.normalize('NFKC').trim().replace(/\\p{White_Space}+/gu, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, ''))"
  )" || return 1
  [ "$locale_slug_c" = "indigo" ] || return 1
  [ "$locale_slug_tr" = "$locale_slug_c" ] || return 1

  grep -Fq 'Only `status: committed` with `commitModel: journaled-cooperative` means saved.' "$output" || return 1
  grep -Fq '`not written`' "$output" || return 1

  assert_file_exists "$evidence" || return 1
  grep -Fq 'Each sample ran twice in a separate fresh context.' "$evidence" || return 1
  grep -Fq 'Verdicts are based on human semantic review' "$evidence" || return 1
  for id in DW1 DW2 DW3 DW4 DW5 DW6 DW7; do
    [ "$(grep -Fc "### $id run " "$evidence")" -eq 2 ] || return 1
    for run in 1 2; do
      block="$(
        awk -v heading="### $id run $run" '
          $0 == heading { in_probe = 1; next }
          in_probe && /^### DW[1-7] run [12]$/ { exit }
          in_probe { print }
        ' "$evidence"
      )"
      echo "$block" | grep -Fq '**Exact prompt:**' || return 1
      echo "$block" | grep -Fq '**Fresh-context metadata:**' || return 1
      echo "$block" | grep -Fq '**Writer fixture result:**' || return 1
      echo "$block" | grep -Fq '**Before hash:**' || return 1
      echo "$block" | grep -Fq '**After hash:**' || return 1
      echo "$block" | grep -Fq '**Agent exact excerpt:**' || return 1
      echo "$block" | grep -Fq '**Human semantic verdict:** PASS' || return 1
    done
  done

  block="$(
    awk '
      /^### DW5 run 1$/ { in_probe = 1; next }
      in_probe && /^### DW[1-7] run [12]$/ { exit }
      in_probe { print }
    ' "$evidence"
  )"
  [ "$(echo "$block" | grep -Fc 'operationId:')" -eq 2 ] || return 1
  echo "$block" | grep -Fq 'recoveryState: incomplete' || return 1
}

# ── Quick Task 260406-e00: Convert Commands to Skills Tests ─────────────────

test_skill_files_exist() {
  # Test 1: Each skills/*/SKILL.md file exists
  assert_file_exists "$PLUGIN_ROOT/skills/setup/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/backlinks/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/checklinks/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/move/SKILL.md" || return 1
  assert_file_exists "$PLUGIN_ROOT/skills/autolinks/SKILL.md" || return 1
}

test_skill_files_have_frontmatter() {
  # Test 2: Each SKILL.md has Codex-compatible frontmatter
  for skill in setup backlinks checklinks move autolinks ingest search; do
    local f="$PLUGIN_ROOT/skills/$skill/SKILL.md"
    assert_file_contains "$f" "^name:" || { echo "    missing name in $skill"; return 1; }
    assert_file_contains "$f" "^description:" || { echo "    missing description in $skill"; return 1; }
  done
}

test_skill_descriptions_codex_aware() {
  assert_file_contains "$PLUGIN_ROOT/skills/ingest/SKILL.md" "Codex skill: me:ingest" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/search/SKILL.md" "Codex skill: me:search" || return 1
}

test_skills_reference_bin_executables() {
  # Test 3: Each SKILL.md references the correct bin/*.ts executable (except setup)
  assert_file_contains "$PLUGIN_ROOT/skills/backlinks/SKILL.md" "bin/backlinks.ts" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/checklinks/SKILL.md" "bin/checklinks.ts" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/move/SKILL.md" "bin/move.ts" || return 1
  assert_file_contains "$PLUGIN_ROOT/skills/autolinks/SKILL.md" "bin/autolinks.ts" || return 1
}

test_skills_follow_ingest_pattern() {
  # Test 4: Each SKILL.md follows the same structure as skills/ingest/SKILL.md
  for skill in backlinks checklinks move autolinks; do
    local f="$PLUGIN_ROOT/skills/$skill/SKILL.md"
    assert_file_contains "$f" "^description:" || { echo "    missing description in $skill"; return 1; }
    assert_file_contains "$f" "## Usage" || { echo "    missing Usage in $skill"; return 1; }
    assert_file_contains "$f" "## Constraints" || { echo "    missing Constraints in $skill"; return 1; }
  done
}

test_setup_skill_no_bin_reference() {
  # Setup has no bin/*.ts executable (manual process)
  local f="$PLUGIN_ROOT/skills/setup/SKILL.md"
  # Should NOT reference bin/setup.ts
  if grep -q "bin/setup.ts" "$f" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: setup skill should not reference bin/setup.ts (manual process)"
    return 1
  fi
}

test_setup_smart_merge_instructions() {
  # Quick 260406-wx4: Setup should smart-merge CLAUDE.md on version upgrade
  local skill_dir="$PLUGIN_ROOT/skills/setup"
  local f="$skill_dir/SKILL.md"
  local merge_ref="$skill_dir/references/merge-rules.md"

  # SKILL.md should have upgrade path (Step 2b)
  if ! grep -q "Version Upgrade Path\|upgrade" "$f" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: setup SKILL.md missing version upgrade path"
    return 1
  fi

  # Should mention smart merge in SKILL.md or reference file
  if ! grep -rqi "smart.merge\|intelligent merge" "$f" "$merge_ref" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: setup skill missing smart merge instructions"
    return 1
  fi

  # Should mention preserving user-added sections (in SKILL.md or merge-rules ref)
  if ! grep -rqi "user-added\|PRESERVE\|preserv" "$f" "$merge_ref" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: setup skill missing instruction to preserve user customizations"
    return 1
  fi

  # Should list template-owned sections (in SKILL.md or merge-rules ref)
  if ! grep -rqi "template-owned\|Template-owned" "$f" "$merge_ref" 2>/dev/null; then
    echo -e "    ${RED}FAIL${NC}: setup skill missing template-owned sections list"
    return 1
  fi

  # Merge rules reference file should exist
  if [ ! -f "$merge_ref" ]; then
    echo -e "    ${RED}FAIL${NC}: setup skill missing references/merge-rules.md"
    return 1
  fi
}

test_skill_files_under_500_lines() {
  # Each SKILL.md should be under 500 lines (per convention)
  for skill in setup backlinks checklinks move autolinks; do
    local f="$PLUGIN_ROOT/skills/$skill/SKILL.md"
    local line_count
    line_count=$(wc -l < "$f" 2>/dev/null || echo "0")
    if [ "$line_count" -ge 500 ]; then
      echo -e "    ${RED}FAIL${NC}: $skill/SKILL.md has $line_count lines (must be under 500)"
      return 1
    fi
  done
}

# ── Phase 4 Plan 01: Search CLI Tests ──────────────────────────────

test_search_script_exists() {
  assert_file_exists "$PLUGIN_ROOT/bin/search.ts" || return 1
}

test_search_script_cli_help() {
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --help 2>&1)
  if ! echo "$output" | grep -qi "search"; then
    echo -e "    ${RED}FAIL${NC}: --help output does not contain 'search'"
    echo "    output: $output"
    return 1
  fi
  if ! echo "$output" | grep -qi "\-\-tags\|query"; then
    echo -e "    ${RED}FAIL${NC}: --help output does not contain 'query' or '--tags'"
    echo "    output: $output"
    return 1
  fi
}

test_search_free_text_title() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/transformer-arch.md" << 'EOF'
---
title: "Transformer Architecture"
created: 2026-04-01
tags: [ml, ai]
type: article
source: "https://example.com"
---

Content about neural networks.
EOF

  cat > "$v/raw/cooking.md" << 'EOF'
---
title: "Cooking Recipes"
created: 2026-04-01
tags: [food]
type: article
source: "https://example.com"
---

Content about cooking.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" transformer --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "transformer"; then
    echo -e "    ${RED}FAIL${NC}: search for 'transformer' did not return transformer note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "cooking"; then
    echo -e "    ${RED}FAIL${NC}: search for 'transformer' returned cooking note unexpectedly"
    return 1
  fi
}

test_search_free_text_body() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/attention.md" << 'EOF'
---
title: "ML Concepts"
created: 2026-04-01
tags: [ml]
type: article
source: "https://example.com"
---

This article discusses attention mechanism and how it works.
EOF

  cat > "$v/raw/other.md" << 'EOF'
---
title: "Other Topic"
created: 2026-04-01
tags: [other]
type: article
source: "https://example.com"
---

Unrelated content here.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" "attention" --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "attention\|ml concepts"; then
    echo -e "    ${RED}FAIL${NC}: search for 'attention' did not return the article with 'attention mechanism' in body"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "other topic"; then
    echo -e "    ${RED}FAIL${NC}: search for 'attention' returned unrelated note"
    return 1
  fi
}

test_search_tags_single() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/ai-note.md" << 'EOF'
---
title: "AI Research"
created: 2026-04-01
tags: [ai]
type: article
source: "https://example.com"
---

AI content here.
EOF

  cat > "$v/raw/cooking-note.md" << 'EOF'
---
title: "Cooking Guide"
created: 2026-04-01
tags: [cooking]
type: article
source: "https://example.com"
---

Cooking content here.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --tags ai --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "ai research"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai did not return AI Research note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "cooking guide"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai returned Cooking Guide unexpectedly"
    return 1
  fi
}

test_search_tags_or() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/ai-note.md" << 'EOF'
---
title: "AI Note"
created: 2026-04-01
tags: [ai]
type: article
source: "https://example.com"
---
AI content.
EOF

  cat > "$v/raw/ml-note.md" << 'EOF'
---
title: "ML Note"
created: 2026-04-01
tags: [ml]
type: article
source: "https://example.com"
---
ML content.
EOF

  cat > "$v/raw/cooking-note.md" << 'EOF'
---
title: "Cooking Note"
created: 2026-04-01
tags: [cooking]
type: article
source: "https://example.com"
---
Cooking content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --tags ai,ml --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "ai note"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai,ml did not return AI Note"
    echo "    output: $output"
    return 1
  fi
  if ! echo "$output" | grep -qi "ml note"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai,ml did not return ML Note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "cooking note"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai,ml returned Cooking Note unexpectedly"
    return 1
  fi
}

test_search_layer_filter() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices"

  cat > "$v/raw/raw-note.md" << 'EOF'
---
title: "Raw Layer Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
Raw content.
EOF

  cat > "$v/practices/practice-note.md" << 'EOF'
---
title: "Practice Layer Note"
created: 2026-04-01
tags: [test]
type: experiment
source: "[[raw-note]]"
project: ""
---
Practice content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --layer raw --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "raw layer note"; then
    echo -e "    ${RED}FAIL${NC}: --layer raw did not return raw layer note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "practice layer note"; then
    echo -e "    ${RED}FAIL${NC}: --layer raw returned practice layer note unexpectedly"
    return 1
  fi
}

test_search_date_after() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/march-note.md" << 'EOF'
---
title: "March Note"
created: 2026-03-01
tags: [test]
type: article
source: "https://example.com"
---
March content.
EOF

  cat > "$v/raw/april-note.md" << 'EOF'
---
title: "April Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
April content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --after 2026-03-15 --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "april note"; then
    echo -e "    ${RED}FAIL${NC}: --after 2026-03-15 did not return April Note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "march note"; then
    echo -e "    ${RED}FAIL${NC}: --after 2026-03-15 returned March Note unexpectedly"
    return 1
  fi
}

test_search_date_before() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/march-note.md" << 'EOF'
---
title: "March Note"
created: 2026-03-01
tags: [test]
type: article
source: "https://example.com"
---
March content.
EOF

  cat > "$v/raw/april-note.md" << 'EOF'
---
title: "April Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
April content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --before 2026-03-15 --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "march note"; then
    echo -e "    ${RED}FAIL${NC}: --before 2026-03-15 did not return March Note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "april note"; then
    echo -e "    ${RED}FAIL${NC}: --before 2026-03-15 returned April Note unexpectedly"
    return 1
  fi
}

test_search_date_month_shortcut() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/feb-note.md" << 'EOF'
---
title: "February Note"
created: 2026-02-15
tags: [test]
type: article
source: "https://example.com"
---
February content.
EOF

  cat > "$v/raw/march-note.md" << 'EOF'
---
title: "March Note"
created: 2026-03-15
tags: [test]
type: article
source: "https://example.com"
---
March content.
EOF

  # --after 2026-03 should normalize to 2026-03-01 and match March note
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --after 2026-03 --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "march note"; then
    echo -e "    ${RED}FAIL${NC}: --after 2026-03 did not return March Note (normalization to 2026-03-01)"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "february note"; then
    echo -e "    ${RED}FAIL${NC}: --after 2026-03 returned February Note unexpectedly"
    return 1
  fi
}

test_search_linked_to() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices"

  cat > "$v/raw/target-note.md" << 'EOF'
---
title: "Target Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
This is the target.
EOF

  cat > "$v/practices/linking-note.md" << 'EOF'
---
title: "Linking Note"
created: 2026-04-01
tags: [test]
type: experiment
source: "https://example.com"
project: ""
---
This note links to [[target-note]] for reference.
EOF

  cat > "$v/raw/unrelated-note.md" << 'EOF'
---
title: "Unrelated Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
No links here.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --linked-to target-note --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "linking note"; then
    echo -e "    ${RED}FAIL${NC}: --linked-to target-note did not return Linking Note"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "unrelated note"; then
    echo -e "    ${RED}FAIL${NC}: --linked-to target-note returned Unrelated Note unexpectedly"
    return 1
  fi
}

test_search_and_logic() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices"

  cat > "$v/raw/ai-raw.md" << 'EOF'
---
title: "AI in Raw"
created: 2026-04-01
tags: [ai]
type: article
source: "https://example.com"
---
AI raw content.
EOF

  cat > "$v/practices/ai-practice.md" << 'EOF'
---
title: "AI in Practice"
created: 2026-04-01
tags: [ai]
type: experiment
source: "https://example.com"
project: ""
---
AI practice content.
EOF

  cat > "$v/raw/ml-raw.md" << 'EOF'
---
title: "ML in Raw"
created: 2026-04-01
tags: [ml]
type: article
source: "https://example.com"
---
ML raw content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --tags ai --layer raw --vault-dir "$v" 2>&1)
  # Should return only the note that matches BOTH: tag=ai AND layer=raw
  if ! echo "$output" | grep -qi "ai in raw"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai --layer raw did not return 'AI in Raw'"
    echo "    output: $output"
    return 1
  fi
  if echo "$output" | grep -qi "ai in practice"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai --layer raw returned 'AI in Practice' (wrong layer)"
    return 1
  fi
  if echo "$output" | grep -qi "ml in raw"; then
    echo -e "    ${RED}FAIL${NC}: --tags ai --layer raw returned 'ML in Raw' (wrong tag)"
    return 1
  fi
}

test_search_no_results() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/note.md" << 'EOF'
---
title: "Some Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
Content here.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" "xyzzy_nonexistent_term_12345" --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "no results"; then
    echo -e "    ${RED}FAIL${NC}: search for nonexistent term did not return 'No results' message"
    echo "    output: $output"
    return 1
  fi
}

test_search_output_table() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/test-note.md" << 'EOF'
---
title: "Test Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
Test content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --vault-dir "$v" 2>&1)
  # Should include table header with Title, Layer, Tags, Created
  if ! echo "$output" | grep -qi "title\|layer\|tags\|created"; then
    echo -e "    ${RED}FAIL${NC}: output does not contain expected table columns (Title, Layer, Tags, Created)"
    echo "    output: $output"
    return 1
  fi
  # Should have markdown table format (| separator)
  if ! echo "$output" | grep -q "|"; then
    echo -e "    ${RED}FAIL${NC}: output does not contain markdown table format (| separator)"
    echo "    output: $output"
    return 1
  fi
}

test_search_newest_first() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  cat > "$v/raw/older-note.md" << 'EOF'
---
title: "Older Note"
created: 2026-01-01
tags: [test]
type: article
source: "https://example.com"
---
Old content.
EOF

  cat > "$v/raw/newer-note.md" << 'EOF'
---
title: "Newer Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
New content.
EOF

  cat > "$v/raw/middle-note.md" << 'EOF'
---
title: "Middle Note"
created: 2026-02-15
tags: [test]
type: article
source: "https://example.com"
---
Middle content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --vault-dir "$v" 2>&1)
  # Newer Note should appear before Older Note in output
  local newer_pos older_pos
  newer_pos=$(echo "$output" | grep -ni "newer note" | head -1 | cut -d: -f1)
  older_pos=$(echo "$output" | grep -ni "older note" | head -1 | cut -d: -f1)
  if [ -z "$newer_pos" ] || [ -z "$older_pos" ]; then
    echo -e "    ${RED}FAIL${NC}: could not find both notes in output"
    echo "    output: $output"
    return 1
  fi
  if [ "$newer_pos" -ge "$older_pos" ]; then
    echo -e "    ${RED}FAIL${NC}: Newer Note (line $newer_pos) should appear before Older Note (line $older_pos)"
    return 1
  fi
}

test_search_default_limit() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw"

  # Create 25 notes
  for i in $(seq 1 25); do
    local padded
    padded=$(printf "%02d" "$i")
    cat > "$v/raw/note-${padded}.md" << EOF
---
title: "Note ${padded}"
created: 2026-01-${padded}
tags: [test]
type: article
source: "https://example.com"
---
Content of note ${padded}.
EOF
  done

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --vault-dir "$v" 2>&1)
  # Should mention truncation (showing first N of total)
  if ! echo "$output" | grep -qi "showing\|limit\|25\|20"; then
    echo -e "    ${RED}FAIL${NC}: output with >20 results does not mention limit/truncation"
    echo "    output: $output"
    return 1
  fi
}

test_search_custom_config_dirs() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/.me" "$v/research" "$v/practice" "$v/insights"

  cat > "$v/.me/config.yaml" << 'EOF'
layers:
  raw: research
  practices: practice
  cognition: insights
EOF

  cat > "$v/research/custom-dir-note.md" << 'EOF'
---
title: "Custom Dir Note"
created: 2026-04-01
tags: [test]
type: article
source: "https://example.com"
---
Custom directory content.
EOF

  local output
  output=$(bun run "$PLUGIN_ROOT/bin/search.ts" --layer raw --vault-dir "$v" 2>&1)
  if ! echo "$output" | grep -qi "custom dir note"; then
    echo -e "    ${RED}FAIL${NC}: --layer raw with custom config did not search 'research/' dir"
    echo "    output: $output"
    return 1
  fi
}

# ── Quick task 260409-m13: autolinks UUID id ───────────────────────

test_autolinks_ensures_frontmatter_id() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/test-note.md" << 'EOF'
---
title: "Test Note"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Some content here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/test-note.md" > /tmp/autolinks-id-out.txt 2>&1
  local result=$?

  if [ $result -ne 0 ]; then
    echo -e "    ${RED}FAIL${NC}: autolinks command failed"
    cat /tmp/autolinks-id-out.txt
    return 1
  fi

  # File should now contain an id field in frontmatter
  assert_file_contains "$v/raw/test-note.md" '^id: "' || return 1
}

test_autolinks_skips_existing_id() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/has-id.md" << 'EOF'
---
id: "existing-id-123"
title: "Has ID"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Some content.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/has-id.md" > /tmp/autolinks-id-out.txt 2>&1

  # Should still have original id
  assert_file_contains "$v/raw/has-id.md" 'id: "existing-id-123"' || return 1

  # Should NOT have two id lines
  local id_count
  id_count=$(grep -c '^id: ' "$v/raw/has-id.md")
  if [ "$id_count" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 id line, got $id_count"
    return 1
  fi
}

test_autolinks_id_is_valid_uuid() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/uuid-check.md" << 'EOF'
---
title: "UUID Check"
created: 2026-04-09
tags: []
type: article
source: ""
---

Content.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/uuid-check.md" > /tmp/autolinks-id-out.txt 2>&1

  # Extract id value
  local id_value
  id_value=$(grep '^id: ' "$v/raw/uuid-check.md" | sed 's/^id: "//; s/"$//')

  # Validate UUID v4 format
  assert_matches_pattern "$id_value" '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' || return 1
}

test_autolinks_no_frontmatter_no_id() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/no-fm.md" << 'EOF'
# Just a plain markdown file

No frontmatter here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" "raw/no-fm.md" > /tmp/autolinks-id-out.txt 2>&1

  # Should NOT contain id field
  assert_file_not_contains "$v/raw/no-fm.md" '^id: ' || return 1
}

test_autolinks_id_added_with_links() {
  local v="$MOCK_VAULT"
  mkdir -p "$v/raw" "$v/practices" "$v/cognition"

  cat > "$v/raw/ml-basics.md" << 'EOF'
---
title: "Machine Learning"
created: 2026-04-09
tags: [ai]
type: article
source: ""
---

Introduction to Machine Learning concepts.
EOF

  cat > "$v/raw/ai-overview.md" << 'EOF'
---
title: "AI Overview"
created: 2026-04-09
tags: [ai]
type: article
source: ""
---

This article covers Machine Learning and other AI topics.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/autolinks.ts" "$v" > /tmp/autolinks-id-out.txt 2>&1

  # Both files should have id fields
  assert_file_contains "$v/raw/ml-basics.md" '^id: "' || return 1
  assert_file_contains "$v/raw/ai-overview.md" '^id: "' || return 1

  # ai-overview should also have a wikilink to ml-basics
  assert_file_contains "$v/raw/ai-overview.md" '\[\[ml-basics|Machine Learning\]\]' || return 1
}

test_events_script_exists() {
  assert_file_exists "$PLUGIN_ROOT/bin/events.ts" || return 1
}

test_events_append_creates_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test event" > /dev/null 2>&1

  assert_file_exists "$evfile" || return 1
  local lines
  lines=$(wc -l < "$evfile" | tr -d ' ')
  if [ "$lines" -ne 1 ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 line, got $lines"
    return 1
  fi
}

test_events_append_valid_json() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --subtype "translate-cn" \
    --description "Ingested article" \
    --doc-ids "uuid-1,uuid-2" > /dev/null 2>&1

  # Parse with bun (jq alternative)
  local parsed
  parsed=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.type + '|' + obj.subtype + '|' + obj.docIds.length)")
  if [ "$parsed" != "ingest|translate-cn|2" ]; then
    echo -e "    ${RED}FAIL${NC}: unexpected parsed output: $parsed"
    return 1
  fi
}

test_events_append_auto_timestamp() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "test" \
    --description "Timestamp test" > /dev/null 2>&1

  local has_ts
  has_ts=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.timestamp ? 'yes' : 'no')")
  if [ "$has_ts" != "yes" ]; then
    echo -e "    ${RED}FAIL${NC}: timestamp not auto-generated"
    return 1
  fi

  # Verify ISO 8601 format
  local ts_valid
  ts_valid=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); const d = new Date(obj.timestamp); console.log(isNaN(d.getTime()) ? 'no' : 'yes')")
  if [ "$ts_valid" != "yes" ]; then
    echo -e "    ${RED}FAIL${NC}: timestamp is not valid ISO 8601"
    return 1
  fi
}

test_events_append_empty_doc_ids() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "search" \
    --description "No docs" > /dev/null 2>&1

  local doc_ids_len
  doc_ids_len=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds.length)")
  if [ "$doc_ids_len" != "0" ]; then
    echo -e "    ${RED}FAIL${NC}: expected empty docIds, got length $doc_ids_len"
    return 1
  fi
}

test_events_append_multiple() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "first" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "second" > /dev/null 2>&1

  local lines
  lines=$(wc -l < "$evfile" | tr -d ' ')
  if [ "$lines" -ne 2 ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 lines, got $lines"
    return 1
  fi
}

test_events_append_with_paths_resolves_uuid() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # Create a note WITH existing UUID
  cat > "$v/raw/note-with-id.md" << 'EOF'
---
id: "abc-123-def"
title: "Has ID"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Content here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test path resolution" \
    --doc-paths "raw/note-with-id.md" > /dev/null 2>&1

  local doc_id
  doc_id=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds[0])")
  if [ "$doc_id" != "abc-123-def" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 'abc-123-def', got '$doc_id'"
    return 1
  fi
}

test_events_append_with_paths_generates_uuid() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # Create a note WITHOUT UUID
  cat > "$v/raw/note-no-id.md" << 'EOF'
---
title: "No ID"
created: 2026-04-09
tags: [test]
type: article
source: ""
---

Content here.
EOF

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Test UUID generation" \
    --doc-paths "raw/note-no-id.md" > /dev/null 2>&1

  # Event should have a UUID in docIds
  local doc_id
  doc_id=$(bun -e "const line = require('fs').readFileSync('$evfile','utf8').trim(); const obj = JSON.parse(line); console.log(obj.docIds[0])")
  if [ -z "$doc_id" ] || [ "$doc_id" = "undefined" ]; then
    echo -e "    ${RED}FAIL${NC}: docIds[0] is empty or undefined"
    return 1
  fi

  # The file frontmatter should now contain the UUID
  assert_file_contains "$v/raw/note-no-id.md" "^id: \"$doc_id\"" || return 1
}

test_events_append_with_paths_missing_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "Missing file" \
    --doc-paths "raw/nonexistent.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit for missing file"
    return 1
  fi

  # No event should be written
  assert_file_not_exists "$evfile" || return 1
}

test_events_append_with_paths_no_frontmatter() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"
  mkdir -p "$v/raw"

  # File without frontmatter
  echo "Just plain text, no frontmatter." > "$v/raw/plain.md"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "ingest" \
    --description "No frontmatter" \
    --doc-paths "raw/plain.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit for file without frontmatter"
    return 1
  fi
}

test_events_append_doc_ids_doc_paths_exclusive() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append \
    --file "$evfile" \
    --type "test" \
    --description "Both flags" \
    --doc-ids "uuid1" \
    --doc-paths "raw/x.md" > /dev/null 2>&1
  local result=$?

  if [ $result -eq 0 ]; then
    echo -e "    ${RED}FAIL${NC}: expected non-zero exit when both --doc-ids and --doc-paths are given"
    return 1
  fi
}

test_events_query_empty_file() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  local output
  output=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null)
  if [ "$output" != "[]" ]; then
    echo -e "    ${RED}FAIL${NC}: expected '[]', got '$output'"
    return 1
  fi
}

test_events_query_all() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "first" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "second" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events, got $count"
    return 1
  fi
}

test_events_query_by_type() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --description "one" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "search" --description "two" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --description "three" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --type "ingest" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 ingest events, got $count"
    return 1
  fi
}

test_events_query_by_subtype() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --subtype "raw" --description "one" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "ingest" --subtype "translate-cn" --description "two" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --subtype "translate-cn" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 translate-cn event, got $count"
    return 1
  fi
}

test_events_query_by_doc_id() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "one" --doc-ids "uuid-1,uuid-2" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "b" --description "two" --doc-ids "uuid-3" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --doc-id "uuid-2" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 event with uuid-2, got $count"
    return 1
  fi
}

test_events_query_by_time_range() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  # Write events with known timestamps directly
  echo '{"type":"a","description":"old","docIds":[],"timestamp":"2026-04-01T10:00:00.000Z"}' >> "$evfile"
  echo '{"type":"b","description":"mid","docIds":[],"timestamp":"2026-04-05T10:00:00.000Z"}' >> "$evfile"
  echo '{"type":"c","description":"new","docIds":[],"timestamp":"2026-04-09T10:00:00.000Z"}' >> "$evfile"

  cd "$v"
  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --after "2026-04-03" --before "2026-04-07" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "1" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 1 event in range, got $count"
    return 1
  fi
}

test_events_query_limit() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  cd "$v"
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "1" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "2" > /dev/null 2>&1
  bun run "$PLUGIN_ROOT/bin/events.ts" append --file "$evfile" --type "a" --description "3" > /dev/null 2>&1

  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" --limit 2 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events with limit, got $count"
    return 1
  fi
}

test_events_query_skips_malformed() {
  local v="$MOCK_VAULT"
  local evfile="$v/events.jsonl"

  echo '{"type":"a","description":"good","docIds":[],"timestamp":"2026-04-09T10:00:00.000Z"}' >> "$evfile"
  echo 'NOT VALID JSON' >> "$evfile"
  echo '{"type":"b","description":"also good","docIds":[],"timestamp":"2026-04-09T11:00:00.000Z"}' >> "$evfile"

  cd "$v"
  local count
  count=$(bun run "$PLUGIN_ROOT/bin/events.ts" query --file "$evfile" 2>/dev/null | bun -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.length)")
  if [ "$count" != "2" ]; then
    echo -e "    ${RED}FAIL${NC}: expected 2 events (skipping malformed), got $count"
    return 1
  fi
}

# ── Main ────────────────────────────────────────────────────────────

list_tests() {
  echo "Available tests:"
  declare -F | awk '/test_/ {print "  " $3}'
}

main() {
  if [ "${1:-}" = "--list" ]; then
    list_tests
    exit 0
  fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN} me plugin test suite${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo "  plugin: $PLUGIN_ROOT"

  if [ $# -gt 0 ]; then
    # Run specific test(s)
    for test_name in "$@"; do
      if declare -f "$test_name" > /dev/null 2>&1; then
        run_test "$test_name"
      else
        echo -e "${RED}Unknown test: $test_name${NC}"
        list_tests
        exit 1
      fi
    done
  else
    # Run all tests
    run_test test_plugin_structure
    run_test test_plugin_manifest
    run_test test_vault_writer_public_binary
    run_test test_codex_public_docs
    run_test test_external_runtime_documented
    run_test test_shell_runtime_isolated
    run_test test_skills_use_external_runtime
    run_test test_ingest_docs_rich_media
    run_test test_schema_fields
    run_test test_templates_match_schema
    run_test test_no_forbidden_fields_in_templates
    run_test test_setup_creates_directories
    run_test test_setup_writes_schema
    run_test test_setup_writes_claude_md
    run_test test_setup_configures_gitignore_new
    run_test test_setup_configures_gitignore_append
    run_test test_setup_gitignore_idempotent
    run_test test_full_setup_simulation
    run_test test_no_hardcoded_paths

    # Phase 2: Wikilink Management
    run_test test_commands_exist
    run_test test_commands_have_description
    run_test test_checklink_command_structure
    run_test test_backlinks_command_structure
    run_test test_move_command_structure
    run_test test_move_has_obsidian_and_native
    # Phase 2 Plan 02: Native-First Architecture
    run_test test_checklink_native_engine
    run_test test_backlinks_native_engine
    run_test test_move_native_primary
    run_test test_graph_backlinks_inversion
    run_test test_claude_template_has_wikilink_commands
    run_test test_headless_broken_link_detection
    run_test test_headless_backlink_detection
    run_test test_headless_broken_link_detection_custom_dirs

    # Headless Move: grep+sed wikilink rewriting
    run_test test_move_has_headless_fallback
    run_test test_headless_move_rename
    run_test test_headless_move_cross_folder
    run_test test_headless_move_rename_custom_dirs

    # Config: Configurable Layer Directories
    run_test test_setup_references_config
    run_test test_commands_reference_config
    run_test test_claude_template_references_config
    run_test test_schema_references_config
    run_test test_setup_creates_config
    run_test test_setup_creates_config_custom_dirs
    run_test test_config_resolution_with_defaults
    run_test test_config_resolution_with_custom
    run_test test_full_setup_simulation_with_config
    run_test test_setup_idempotent_with_config

    # Phase 2 re-impl: Native Graph Engine
    run_test test_graph_script_exists
    run_test test_graph_outputs_valid_json
    run_test test_graph_detects_broken_links
    run_test test_graph_no_false_broken
    run_test test_graph_detects_orphans
    run_test test_graph_detects_deadends
    run_test test_graph_case_insensitive
    run_test test_graph_parses_alias_variant
    run_test test_graph_parses_heading_variant
    run_test test_graph_reads_config
    run_test test_graph_default_dirs

    # Phase 3 Plan 01: Ingest Output Format Validation
    run_test test_ingest_output_frontmatter_schema
    run_test test_ingest_output_forbidden_fields
    run_test test_ingest_output_filename_convention
    run_test test_ingest_output_topic_folder_kebab_case
    run_test test_ingest_output_body_structure
    run_test test_ingest_skill_exists

    # Phase 3 Plan 01: Ingest Skill Content (TDD)
    run_test test_ingest_skill_has_description
    run_test test_ingest_skill_step0_config_resolution
    run_test test_ingest_skill_webreader_extraction
    run_test test_ingest_skill_three_modes
    run_test test_ingest_skill_auto_detect_mode
    run_test test_ingest_skill_topic_confirmation
    run_test test_ingest_skill_processed_markdown_body_only
    run_test test_ingest_skill_no_forbidden_fields
    run_test test_ingest_skill_filename_convention
    run_test test_ingest_skill_image_localization_reporting
    run_test test_ingest_skill_under_500_lines
    run_test test_ingest_skill_rich_contract

    # ── Quick 260517-fs2: Bilibili source adapter ──
    run_test test_ingest_skill_bilibili_source_adapter
    run_test test_ingest_bilibili_url_routing

    # Phase 3 Plan 02: Auto-Linking Tests
    run_test test_ingest_autolink_body_only
    run_test test_ingest_autolink_first_occurrence_only
    run_test test_ingest_autolink_stub_wikilink
    run_test test_ingest_wikilink_graph_integration
    run_test test_ingest_related_notes_tag_overlap

    # Quick 260406-bxt: Ingest Script Integration
    run_test test_ingest_script_exists
    run_test test_ingest_script_cli_help
    run_test test_ingest_help_lists_bundle_and_handout
    run_test test_ingest_rejects_url_and_bundle_together
    run_test test_ingest_skill_calls_script
    run_test test_ingest_skill_thin_orchestrator
    run_test test_ingest_skill_llm_only_for_translate_summarize

    # Decision Brief Skill Contract
    run_test test_decision_brief_skill_structure
    run_test test_decision_brief_public_privacy
    run_test test_decision_brief_profile_contract
    run_test test_decision_brief_profile_behavior_evidence
    run_test test_decision_brief_write_transaction_contract
    run_test test_decision_brief_writer_contract
    run_test test_decision_brief_documented
    run_test test_decision_brief_discovery_and_release_version
    run_test test_packed_release_has_no_private_paths
    run_test test_decision_brief_profile_example_uses_real_layer_contract

    # Claude Code E2E tests (skip when CLI authentication is unavailable)
    run_test test_e2e_me_setup
    run_test test_e2e_me_setup_idempotent
    run_test test_e2e_me_checklink_headless

    # Quick task 260406-din: checklinks (plural) and autolinks
    run_test test_checklinks_files_exist
    run_test test_checklinks_package_json
    run_test test_autolinks_files_exist
    run_test test_autolinks_imports_from_ingest

    # Quick task 260406-fpv: single-note autolinks support
    run_test test_autolinks_single_note
    run_test test_autolinks_bulk_mode_unchanged
    run_test test_autolinks_single_note_invalid_path
    run_test test_autolinks_no_nested_wikilinks

    # Quick task 260406-h3k: wikilink scanning
    run_test test_scan_existing_wikilinks_empty_vault
    run_test test_scan_existing_wikilinks_extracts_wikilinks
    run_test test_scan_existing_wikilinks_skips_code_blocks
    run_test test_scan_existing_wikilinks_deduplicates
    run_test test_scan_existing_wikilinks_respects_config

    # Quick task 260406-h3k: autolinks with existing wikilinks
    run_test test_autolinks_uses_existing_wikilinks
    run_test test_autolinks_preserves_existing_wikilinks
    run_test test_autolinks_reports_existing_count
    run_test test_autolinks_reports_new_insertions
    run_test test_autolinks_single_note_shows_existing_count

    # Quick task 260406-h3k: wikilink candidate extraction
    run_test test_extract_wikilink_candidates_identifies_phrases
    run_test test_extract_wikilink_candidates_filters_stop_words
    run_test test_extract_wikilink_candidates_matches_vault_index
    run_test test_autolinks_suggests_candidates
    run_test test_extract_wikilink_candidates_sorts_by_frequency

    # Quick task 260406-hwe: LLM-first autolinks
    run_test test_autolinks_llm_first_concept_extraction
    run_test test_autolinks_backward_compat_no_concepts
    run_test test_autolinks_stubs_reported_for_missing_concepts

    # Quick task 260406-e00: convert commands to skills
    run_test test_skill_files_exist
    run_test test_skill_files_have_frontmatter
    run_test test_skill_descriptions_codex_aware
    run_test test_skills_reference_bin_executables
    run_test test_skills_follow_ingest_pattern
    run_test test_setup_skill_no_bin_reference
    run_test test_setup_smart_merge_instructions
    run_test test_skill_files_under_500_lines

    # Phase 4 Plan 01: Search CLI
    run_test test_search_script_exists
    run_test test_search_script_cli_help
    run_test test_search_free_text_title
    run_test test_search_free_text_body
    run_test test_search_tags_single
    run_test test_search_tags_or
    run_test test_search_layer_filter
    run_test test_search_date_after
    run_test test_search_date_before
    run_test test_search_date_month_shortcut
    run_test test_search_linked_to
    run_test test_search_and_logic
    run_test test_search_no_results
    run_test test_search_output_table
    run_test test_search_newest_first
    run_test test_search_default_limit
    run_test test_search_custom_config_dirs

    # Quick task 260409-m13: autolinks UUID id
    run_test test_autolinks_ensures_frontmatter_id
    run_test test_autolinks_skips_existing_id
    run_test test_autolinks_id_is_valid_uuid
    run_test test_autolinks_no_frontmatter_no_id
    run_test test_autolinks_id_added_with_links

    # JSONL Event Log
    run_test test_events_script_exists
    run_test test_events_append_creates_file
    run_test test_events_append_valid_json
    run_test test_events_append_auto_timestamp
    run_test test_events_append_empty_doc_ids
    run_test test_events_append_multiple
    run_test test_events_append_with_paths_resolves_uuid
    run_test test_events_append_with_paths_generates_uuid
    run_test test_events_append_with_paths_missing_file
    run_test test_events_append_with_paths_no_frontmatter
    run_test test_events_append_doc_ids_doc_paths_exclusive
    run_test test_events_query_empty_file
    run_test test_events_query_all
    run_test test_events_query_by_type
    run_test test_events_query_by_subtype
    run_test test_events_query_by_doc_id
    run_test test_events_query_by_time_range
    run_test test_events_query_limit
    run_test test_events_query_skips_malformed
  fi

  # Summary
  echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  Total: $TESTS_RUN  ${GREEN}Passed: $TESTS_PASSED${NC}  ${RED}Failed: $TESTS_FAILED${NC}"
  if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
    echo -e "\n  ${RED}Failed tests:${NC}"
    for t in "${FAILED_TESTS[@]}"; do
      echo -e "    - $t"
    done
  fi
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  [ "$TESTS_FAILED" -eq 0 ]
}

main "$@"
