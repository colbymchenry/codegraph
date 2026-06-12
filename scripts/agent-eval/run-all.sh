#!/usr/bin/env bash
# With/without A/B (and optional interactive) eval for a codegraph version on a
# repo. Codegraph is the ONLY variable: both arms launch claude with
# --strict-mcp-config — with = codegraph-only MCP (pointed at $CG_BIN),
# without = empty MCP. Built-in Read/Grep/Bash stay available in both arms.
#
# Usage: run-all.sh <repo-path> "<question>" [headless|tmux|all]
# Env:   CG_BIN          codegraph binary (default: command -v codegraph)
#        AGENT_EVAL_OUT  output dir (default: /tmp/agent-eval)
#        MODEL / EFFORT  claude model/effort (default: sonnet / high — the
#                        standing A/B policy; see CLAUDE.md, don't raise)
set -uo pipefail

REPO="${1:?usage: run-all.sh <repo-path> \"<question>\" [headless|tmux|all]}"
Q="${2:?question required}"
MODE="${3:-headless}"
CG_BIN="${CG_BIN:-$(command -v codegraph)}"
OUT="${AGENT_EVAL_OUT:-/tmp/agent-eval}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

[ -n "$CG_BIN" ] || { echo "no codegraph binary on PATH (set CG_BIN)"; exit 1; }
[ -d "$REPO/.codegraph" ] || { echo "no .codegraph index at $REPO — index it first"; exit 1; }
case "$MODE" in headless|tmux|all) ;; *) echo "mode must be headless|tmux|all (got '$MODE')"; exit 1;; esac

# MCP config files (path form avoids inline-JSON quoting through tmux).
cat > "$OUT/mcp-codegraph.json" <<JSON
{"mcpServers":{"codegraph":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"]}}}
JSON
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

echo "###### codegraph: $CG_BIN"
echo "###### repo:      $REPO"
echo "###### question:  $Q"
echo

# Headless arm: claude -p with stream-json -> exact tool sequence + tokens/cost.
headless() {
  local label="$1" cfg="$2"
  echo "############################## HEADLESS [$label] ##############################"
  ( cd "$REPO" && claude -p "$Q" \
      --output-format stream-json --verbose \
      --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
      --max-budget-usd 4 \
      --strict-mcp-config --mcp-config "$cfg" \
      > "$OUT/run-$label.jsonl" 2>"$OUT/run-$label.err" )
  echo "exit $? -> $OUT/run-$label.jsonl ($(wc -l < "$OUT/run-$label.jsonl" | tr -d ' ') lines)"
  tail -2 "$OUT/run-$label.err" 2>/dev/null
  node "$HARNESS/parse-run.mjs" "$OUT/run-$label.jsonl" 2>&1 || true
  echo
}

if [ "$MODE" = headless ] || [ "$MODE" = all ]; then
  headless "headless-with"    "$OUT/mcp-codegraph.json"
  headless "headless-without" "$OUT/mcp-empty.json"
fi

if [ "$MODE" = tmux ] || [ "$MODE" = all ]; then
  echo "############################## INTERACTIVE [with] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-codegraph.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-with" "$Q" 2>&1 || echo "[itrun WITH failed]"
  echo
  echo "############################## INTERACTIVE [without] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-empty.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-without" "$Q" 2>&1 || echo "[itrun WITHOUT failed]"
  echo
fi
echo "############################## RUN-ALL COMPLETE ##############################"
