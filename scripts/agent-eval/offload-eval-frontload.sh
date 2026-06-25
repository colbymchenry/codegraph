#!/usr/bin/env bash
# FRONTLOAD arm (approach 1): codegraph attached (offload-disabled) + the front-load
# UserPromptSubmit hook (offload-eval-hook.mjs), n reps, appended to $RESULTS. Compare against
# the matrix's raw/nocg baselines. Usage: offload-eval-frontload.sh <indexed-repo> <tier> <reps> "<Q>"
# Env: MODEL=sonnet EFFORT=high  RESULTS=<file>  AGENT_EVAL_OUT=<scratch dir>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
TARGET="${1:?repo}"; TIER="${2:?tier}"; REPS="${3:?reps}"; Q="${4:?question}"
RUNS="$OUT/runs"
EXTRACT="$HERE/offload-eval-metrics.mjs"
RESULTS="${RESULTS:-$OUT/results-fl.jsonl}"
REPO=$(basename "$TARGET")
mkdir -p "$RUNS"
[ -d "$TARGET/.codegraph" ] || { echo "not indexed: $TARGET"; exit 1; }
TARGET=$(cd "$TARGET" && pwd -P)

CFG="$RUNS/mcp-fl-$REPO.json"
printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_OFFLOAD_DISABLE=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$TARGET" > "$CFG"
# Generate the hook settings pointing at the persisted hook; enable its debug log so we can
# count injections (claude passes this env down to the spawned hook process).
HOOKCFG="$RUNS/frontload-settings.json"
printf '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"node %s/offload-eval-hook.mjs"}]}]}}' "$HERE" > "$HOOKCFG"
export CG_FRONTLOAD_DEBUG="$RUNS/hook-debug.log"

prewarm() {
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null; rm -f "$1/.codegraph/daemon.sock" 2>/dev/null; sleep 0.6
  env CODEGRAPH_OFFLOAD_DISABLE=1 CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm" || echo "  WARN no daemon"
}

echo "###### FRONTLOAD repo=$REPO tier=$TIER reps=$REPS"
prewarm "$TARGET"
for r in $(seq 1 "$REPS"); do
  tag="$REPO-frontload-$r"
  ( cd "$TARGET" && claude -p "$Q" --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
      --strict-mcp-config --mcp-config "$CFG" --settings "$HOOKCFG" \
      </dev/null > "$RUNS/$tag.jsonl" 2>"$RUNS/$tag.err" )
  node "$EXTRACT" --run "$RUNS/$tag.jsonl" --usage "-" --arm frontload --rep "$r" --repo "$REPO" --tier "$TIER" --q "$Q" >> "$RESULTS"
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop());console.log(`  [frontload #${o.rep}] ${o.durationSec}s | main $${o.costUsdMain} ${o.tokBillable}tok | read=${o.read} grep=${o.grep} agentExplore=${o.explore} | ok=${o.ok}`)' "$RESULTS"
done
pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null
echo "###### FRONTLOAD DONE $REPO (cumulative hook injections: $(grep -c INJECTED "$CG_FRONTLOAD_DEBUG" 2>/dev/null))"
