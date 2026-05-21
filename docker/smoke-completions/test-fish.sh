#!/usr/bin/env bash
# Fish completion smoke. `complete -C "<line>"` returns suggestions on
# stdout, one per line, tab-separating the candidate from its description.
# Fish auto-loads anything in ~/.config/fish/completions/ so no source needed.
set -euo pipefail

declare -i fail=0

assert_contains() {
  local label=$1 needle=$2 haystack=$3
  # Each fish completion line is "name<TAB>description"; match the name column.
  if ! awk -F '\t' -v n="$needle" '$1 == n {found=1} END {exit !found}' <<<"$haystack"; then
    echo "FAIL [fish:$label]: expected '$needle' in completions, got:" >&2
    echo "$haystack" | sed 's/^/  /' >&2
    fail=1
  fi
}

assert_nonempty() {
  local label=$1 haystack=$2
  if [[ -z "${haystack//[[:space:]]/}" ]]; then
    echo "FAIL [fish:$label]: expected non-empty completions, got nothing" >&2
    fail=1
  fi
}

# 1. Top-level subcommand list.
out=$(fish -c 'complete -C "codegraph "')
assert_contains "top-level/init" "init" "$out"
assert_contains "top-level/query" "query" "$out"
assert_contains "top-level/completions" "completions" "$out"

# 2. Subcommand flag completion.
out=$(fish -c 'complete -C "codegraph init -"')
assert_contains "init/--index" "--index" "$out"

# 3. Value-hint: --path should trigger file completion. With files in
#    cwd, fish lists them.
out=$(fish -c 'cd /tmp; touch .smoke-sentinel; complete -C "codegraph query --path "; rm -f .smoke-sentinel')
assert_nonempty "query/--path" "$out"

exit $fail
