#!/usr/bin/env bash
#
# Agent benchmark: the same question asked of a headless Claude Code agent in
# arms that differ only in what codegraph serves it, scored against the
# compiler's answer. Results and method: docs/scip.md, "Agent benchmark".
#
#   scripts/scip-eval/agent-bench/bench.sh setup <task>          fresh repo copies; B and C build their own graphs
#   scripts/scip-eval/agent-bench/bench.sh run <task> [arm...]   BENCH_REPEAT runs per arm (default 1; arms A B C), one after another
#   node scripts/scip-eval/agent-bench/score.js <task> [arm...]  correctness, tool calls, tokens, cost, time; per run and averaged
#   node scripts/scip-eval/agent-bench/calls.js <task> <arm> [n] run n's tool calls, in order (default the first)
#
# Arms:
#   A  no codegraph: no MCP server, and the CLI is off PATH and blocked by a hook (agent-eval/no-cli-shim.sh)
#   B  upstream codegraph @colbymchenry/codegraph@1.6.1 (installed under $BENCH_RUNS/upstream, not globally)
#   C  the installed fork (`codegraph` on PATH: build the bundle and install it first)
#   D  this checkout's build (npx tsc -p .) on a copy of C's repo and graph — for trying a change before installing it
#   H  C plus the UserPromptSubmit hook a real install has (`codegraph prompt-hook`), on a copy of C's repo and graph
# Each run: BENCH_MODEL (default sonnet), effort high, $2 cap, project settings only (no user hooks or plugins), no skills,
# only that MCP config. Logs: <task>-<arm>/run-<n>.jsonl, under <task>-<arm>/<model>/ for a model other than sonnet.
# Tasks: tasks/<T>/{prompt.txt,truth.txt,corpus}; corpora are corpora.sh's clones under ~/.cache/codegraph-scip-eval.
# Needs: claude, jq, rsync, node 22/24 on PATH; scripts/scip-eval/corpora.sh run for the task's corpus.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
RUNS="${BENCH_RUNS:-$HOME/.cache/codegraph-scip-eval/bench}"
EVAL="${SCIP_EVAL_DIR:-$HOME/.cache/codegraph-scip-eval}"
UP_VERSION=1.6.1
UP="$RUNS/upstream/node_modules/.bin/codegraph"

usage() { grep -E '^#   (scripts/|node )' "$0" | sed 's/^#   //'; exit 2; }

setup() {
  local task=$1 corpus src fork
  corpus="$(cat "$HERE/tasks/$task/corpus")"; src="$EVAL/$corpus"
  [ -d "$src" ] || { echo "no $src: run scripts/scip-eval/corpora.sh $corpus first" >&2; exit 1; }
  [ -x "$UP" ] || npm i --no-audit --no-fund --prefix "$RUNS/upstream" "@colbymchenry/codegraph@$UP_VERSION" >/dev/null
  fork="$(command -v codegraph)" || { echo "no codegraph on PATH (the fork's bundle)" >&2; exit 1; }
  for arm in A B C; do
    rm -rf "$RUNS/$task-$arm" && mkdir -p "$RUNS/$task-$arm/repo"
    rsync -a --exclude .codegraph --exclude target "$src/" "$RUNS/$task-$arm/repo/"
  done
  "$UP" init -y "$RUNS/$task-B/repo" >/dev/null 2>&1 || { echo "upstream init failed" >&2; exit 1; }
  "$fork" init -y --scip "$RUNS/$task-C/repo" 2>&1 | grep -E "resolved calls|merged|failed|skipped"
}

MODEL="${BENCH_MODEL:-sonnet}"

run_arm() {
  local task=$1 arm=$2 out="$RUNS/$1-$2" cfg s n log fork
  local repo="$out/repo"
  log="$out$([ "$MODEL" = sonnet ] || echo "/$MODEL")"
  if [ "$arm" = D ] || [ "$arm" = H ]; then # a fresh copy of C's repo and graph each run; earlier runs' logs stay
    rm -rf "$repo" && mkdir -p "$out" && rsync -a --exclude .codegraph/daemon.sock "$RUNS/$task-C/repo/" "$repo/"
  fi
  [ -d "$repo" ] || { echo "no $repo: run setup $task first" >&2; return 1; }
  fork="$(readlink -f "$(command -v codegraph)")"
  case "$arm" in
    A) cfg='{"mcpServers":{}}' ;;
    B) cfg="{\"mcpServers\":{\"codegraph\":{\"command\":\"$UP\",\"args\":[\"serve\",\"--mcp\",\"--path\",\"$repo\"]}}}" ;;
    C|H) cfg="{\"mcpServers\":{\"codegraph\":{\"command\":\"$fork\",\"args\":[\"serve\",\"--mcp\",\"--path\",\"$repo\"]}}}" ;;
    D) cfg="{\"mcpServers\":{\"codegraph\":{\"command\":\"$(command -v node)\",\"args\":[\"$ROOT/dist/bin/codegraph.js\",\"serve\",\"--mcp\",\"--path\",\"$repo\"]}}}" ;;
    *) echo "arm must be A, B, C, D or H" >&2; return 2 ;;
  esac
  # shellcheck source=../../agent-eval/no-cli-shim.sh
  . "$ROOT/scripts/agent-eval/no-cli-shim.sh"
  cg_no_cli_setup "$out" || return 1
  if [ "$arm" = H ]; then # the hook runs outside Bash, so the CLI block doesn't reach it; the binary is off PATH, so by its path
    jq --arg c "$fork prompt-hook" '.hooks.UserPromptSubmit = [{hooks: [{type: "command", command: $c}]}]' "$ARM_SETTINGS" > "$out/h-settings.json"
    ARM_SETTINGS="$out/h-settings.json"
  fi
  mkdir -p "$log"
  n=1; while [ -e "$log/run-$n.jsonl" ] || { [ $n = 1 ] && [ -e "$log/run.jsonl" ]; }; do n=$((n + 1)); done
  echo "[$task-$arm $MODEL #$n] start $(date +%T)"
  s=$(date +%s)
  ( cd "$repo" && PATH="$ARM_PATH" CODEGRAPH_NO_UPDATE_CHECK=1 claude -p "$(cat "$HERE/tasks/$task/prompt.txt")" \
      --output-format stream-json --verbose --permission-mode bypassPermissions --model "$MODEL" --effort high --max-budget-usd 2 \
      --setting-sources project --disable-slash-commands --settings "$ARM_SETTINGS" \
      --strict-mcp-config --mcp-config "$cfg" > "$log/run-$n.jsonl" 2> "$log/run-$n.err" )
  echo "[$task-$arm $MODEL #$n] exit $? in $(( $(date +%s) - s )) s"
}

case "${1:-}" in
  setup) [ -n "${2:-}" ] || usage; setup "$2" ;;
  run) [ -n "${2:-}" ] || usage; task=$2; shift 2
    for _ in $(seq "${BENCH_REPEAT:-1}"); do for arm in "${@:-A B C}"; do for a in $arm; do run_arm "$task" "$a"; done; done; done ;;
  *) usage ;;
esac
