#!/usr/bin/env bash
# 3-arm offload eval for ONE indexed repo + ONE question, n reps each.
#   ARM offload : codegraph attached, managed offload ON  (per-run AI usage log)
#   ARM raw     : codegraph attached, CODEGRAPH_OFFLOAD_DISABLE=1 (raw source)
#   ARM nocg    : no codegraph (empty MCP config) -> Read/Grep baseline
# All arms: claude -p sonnet --effort high. One JSON metrics line/run -> $RESULTS.
#
# Usage: offload-eval-3arm.sh <indexed-repo> <tier> <reps> "<question>"
# Env:   MODEL=sonnet EFFORT=high  RESULTS=<file>  AGENT_EVAL_OUT=<scratch dir>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
TARGET="${1:?usage: offload-eval-3arm.sh <indexed-repo> <tier> <reps> \"<question>\"}"
TIER="${2:?tier}"; REPS="${3:?reps}"; Q="${4:?question}"
RUNS="$OUT/runs"
EXTRACT="$HERE/offload-eval-metrics.mjs"
RESULTS="${RESULTS:-$OUT/results.jsonl}"
REPO=$(basename "$TARGET")
mkdir -p "$RUNS"
command -v claude >/dev/null || { echo "no claude on PATH"; exit 1; }
[ -d "$TARGET/.codegraph" ] || { echo "not indexed: $TARGET (run offload-eval-setup.sh first)"; exit 1; }
# Physical path so pkill matches the daemon's real cmdline (macOS /tmp->/private/tmp symlink
# otherwise makes the kill miss the daemon, and the next arm connects to the SURVIVING daemon
# — contaminating the raw arm with offload).
TARGET=$(cd "$TARGET" && pwd -P)

prewarm() { # path  extra-env (e.g. "FOO=bar")
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null; rm -f "$1/.codegraph/daemon.sock" 2>/dev/null; sleep 0.6
  env ${2:-} CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm" || echo "  WARN daemon never bound"
}

run() { # arm rep mcp-config usage-log-or-dash
  local arm="$1" rep="$2" cfg="$3" usage="$4" tag="$REPO-$1-$2"
  [ "$usage" != "-" ] && : > "$usage"
  # DISALLOW (optional): block sub-agent delegation across all arms so the A/B
  # measures the retrieval mode, not whether Sonnet decides to spawn a codegraph-blind
  # Explore subagent (which thrashes regardless and adds huge variance).
  ( cd "$TARGET" && claude -p "$Q" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
      ${DISALLOW:+--disallowedTools "$DISALLOW"} \
      --strict-mcp-config --mcp-config "$cfg" \
      </dev/null > "$RUNS/$tag.jsonl" 2>"$RUNS/$tag.err" )
  node "$EXTRACT" --run "$RUNS/$tag.jsonl" --usage "$usage" --arm "$arm" --rep "$rep" \
      --repo "$REPO" --tier "$TIER" --q "$Q" >> "$RESULTS"
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop());console.log(`  [${o.arm} #${o.rep}] ${o.durationSec}s | main $${o.costUsdMain} ${o.tokBillable} tok | read=${o.read} grep=${o.grep} explore=${o.explore} offload=${o.offloadFired} | AI ${o.ai.calls}call/${o.ai.totalTokens}tok/$${o.ai.costUsd.toFixed(4)} | ok=${o.ok}`)' "$RESULTS"
}

CFG_OFF="$RUNS/mcp-offload-$REPO.json"; CFG_RAW="$RUNS/mcp-raw-$REPO.json"; CFG_NOCG="$RUNS/mcp-nocg.json"
USAGE="$RUNS/$REPO-usage.jsonl"
printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_OFFLOAD_USAGE_LOG=%s","node","%s","serve","--mcp","--path","%s"]}}}' "$USAGE" "$BIN" "$TARGET" > "$CFG_OFF"
printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_OFFLOAD_DISABLE=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$TARGET" > "$CFG_RAW"
printf '{"mcpServers":{}}' > "$CFG_NOCG"

# REP_START lets a later batch ADD reps without clobbering earlier jsonls
# (e.g. REP_START=4 REPS=3 -> reps 4,5,6; default starts at 1).
START="${REP_START:-1}"; END=$((START + REPS - 1))
echo "###### repo=$REPO tier=$TIER reps=$START..$END model=${MODEL:-sonnet}/${EFFORT:-high}"
echo "###### Q=$Q"
echo "== ARM offload =="; prewarm "$TARGET" "CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE"
for r in $(seq "$START" "$END"); do run offload "$r" "$CFG_OFF" "$USAGE"; done
pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null; sleep 1
echo "== ARM raw =="; prewarm "$TARGET" "CODEGRAPH_OFFLOAD_DISABLE=1"
for r in $(seq "$START" "$END"); do run raw "$r" "$CFG_RAW" "-"; done
pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null; sleep 1
echo "== ARM nocg =="
for r in $(seq "$START" "$END"); do run nocg "$r" "$CFG_NOCG" "-"; done
echo "###### DONE $REPO"
