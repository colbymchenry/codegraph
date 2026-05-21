#!/usr/bin/env bash
# Bash completion smoke. Sources the installed script, sets the
# COMP_* env that bash-completion populates during a real Tab, calls
# `_codegraph`, and asserts COMPREPLY contents. This is the standard
# non-PTY pattern (used by oclif, click, gh's own completion tests).
set -euo pipefail

source /usr/share/bash-completion/bash_completion
# $BASH_PATH is exported by run.sh — wherever the installer wrote the script.
source "${BASH_PATH:-$HOME/.local/share/bash-completion/completions/codegraph}"

declare -i fail=0

# 0. Registration: sourcing must register the completion for the
#    `codegraph` command via `complete -F`. Without this, Tab does
#    nothing — even if the function below works when called directly.
if ! complete -p codegraph 2>/dev/null | grep -q '_codegraph'; then
  echo "FAIL [bash:registration]: sourcing didn't register a completion for 'codegraph'" >&2
  echo "  complete -p codegraph: $(complete -p codegraph 2>&1 || echo 'unregistered')" >&2
  fail=1
fi

# Drive a single completion attempt: pre-populates the COMP_* vars
# from a command line + cursor position, calls `_codegraph`, returns
# the joined COMPREPLY for the caller to assert against.
complete_line() {
  local line=$1
  local point=${2:-${#line}}
  local cur prev
  COMP_LINE=$line
  COMP_POINT=$point
  # Tokenize the line; cursor word is the last token (or empty if line ends in space).
  read -ra COMP_WORDS <<<"$line"
  if [[ "${line: -1}" == " " ]]; then
    COMP_WORDS+=("")
  fi
  COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))
  COMPREPLY=()
  _codegraph
  printf '%s\n' "${COMPREPLY[@]:-}"
}

assert_contains() {
  local label=$1 needle=$2 haystack=$3
  if ! grep -qx -- "$needle" <<<"$haystack"; then
    echo "FAIL [bash:$label]: expected '$needle' in completions, got:" >&2
    echo "$haystack" | sed 's/^/  /' >&2
    fail=1
  fi
}

assert_nonempty() {
  local label=$1 haystack=$2
  if [[ -z "${haystack//[[:space:]]/}" ]]; then
    echo "FAIL [bash:$label]: expected non-empty completions, got nothing" >&2
    fail=1
  fi
}

# 1. Top-level subcommand list.
out=$(complete_line "codegraph ")
assert_contains "top-level/init" "init" "$out"
assert_contains "top-level/query" "query" "$out"
assert_contains "top-level/completions" "completions" "$out"

# 2. Subcommand flag completion (-i, --index for `init`).
out=$(complete_line "codegraph init -")
assert_contains "init/-i" "-i" "$out"
assert_contains "init/--index" "--index" "$out"

# 3. Value-hint: --path expects a file. With no cwd files we should
#    still get *some* completion candidates (compgen -f lists cwd).
cd /tmp  # ensure compgen has something to enumerate
touch /tmp/.smoke-sentinel
out=$(complete_line "codegraph query --path ")
assert_nonempty "query/--path" "$out"
rm -f /tmp/.smoke-sentinel

# 4. Help/version are recognized at top level.
out=$(complete_line "codegraph -")
assert_contains "top-level/--help" "--help" "$out"
assert_contains "top-level/--version" "--version" "$out"

# 5. --version must appear exactly once — regression guard for the
#    pre-cb2389e bug where commander's auto-registered --version
#    collided with a hardcoded --version in the emitter.
ver_count=$(grep -cx -- "--version" <<<"$out" || true)
if [[ "$ver_count" != "1" ]]; then
  echo "FAIL [bash:--version-dedupe]: expected --version exactly once, got $ver_count" >&2
  fail=1
fi

# 6. Subcommand --help / -h. Commander doesn't surface help in
#    cmd.options; the introspect layer injects it. Regression guard
#    so a future refactor doesn't drop it.
out=$(complete_line "codegraph init -")
assert_contains "init/--help" "--help" "$out"
assert_contains "init/-h"     "-h"     "$out"

exit $fail
