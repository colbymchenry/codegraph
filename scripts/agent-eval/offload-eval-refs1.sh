#!/usr/bin/env bash
# ONE offload run on ONE indexed repo at a given offload STYLE (plain|refs), so we can
# watch a single agent transcript at a time (the user's one-run-at-a-time methodology).
# The OFFLOAD reasoning runs in the prewarmed DAEMON process, so the style env must be
# set on BOTH the daemon and the client MCP config. Writes one metrics line to RESULTS
# and leaves the raw stream-json at $RUNS/<repo>-<style>-<n>.jsonl for inspection.
#
# Usage: offload-eval-refs1.sh <indexed-repo> <style> <n> "<question>"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ENGINE="$(cd "$HERE/../.." && pwd)"; BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"; RUNS="$OUT/runs"; EXTRACT="$HERE/offload-eval-metrics.mjs"
TARGET="${1:?repo}"; STYLE="${2:?style}"; N="${3:?run-tag}"; Q="${4:?question}"
RESULTS="${RESULTS:-$OUT/results-refs.jsonl}"; REPO=$(basename "$TARGET"); TARGET=$(cd "$TARGET" && pwd -P)
mkdir -p "$RUNS"; command -v claude >/dev/null || { echo "no claude"; exit 1; }
USAGE="$RUNS/$REPO-$STYLE-usage.jsonl"; : > "$USAGE"
CFG="$RUNS/mcp-$REPO-$STYLE.json"
# `raw` is a pseudo-style: codegraph attached but the offload DISABLED (the ceiling —
# verbatim source, no reasoning model). Any other value is an offload style (plain|refs).
if [ "$STYLE" = "raw" ]; then
  DAEMON_ENV="CODEGRAPH_OFFLOAD_DISABLE=1"
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_OFFLOAD_DISABLE=1","node","%s","serve","--mcp","--path","%s"]}}}' \
    "$BIN" "$TARGET" > "$CFG"
  USAGE="-"
else
  DAEMON_ENV="CODEGRAPH_OFFLOAD_STYLE=$STYLE CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE"
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_OFFLOAD_STYLE=%s","CODEGRAPH_OFFLOAD_USAGE_LOG=%s","node","%s","serve","--mcp","--path","%s"]}}}' \
    "$STYLE" "$USAGE" "$BIN" "$TARGET" > "$CFG"
fi

# Prewarm a persistent daemon carrying the SAME offload config (it does the reasoning).
pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null; sleep 0.6
env $DAEMON_ENV CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 \
  node "$BIN" serve --mcp --path "$TARGET" </dev/null >/dev/null 2>&1 &
node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$TARGET" \
  && echo "daemon warm ($STYLE)" || echo "WARN daemon never bound"

tag="$REPO-$STYLE-$N"
echo "== run $tag =="
# DISALLOW (optional): block tools that confound the offload-sufficiency signal —
# chiefly "Agent" (sub-agent delegation: the spawned Explore subagent has low MCP
# salience, ignores codegraph, and thrashes via Bash+Read, making the A/B noise).
( cd "$TARGET" && claude -p "$Q" --output-format stream-json --verbose --permission-mode bypassPermissions \
    --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
    ${DISALLOW:+--disallowedTools "$DISALLOW"} \
    --strict-mcp-config --mcp-config "$CFG" </dev/null > "$RUNS/$tag.jsonl" 2>"$RUNS/$tag.err" )
node "$EXTRACT" --run "$RUNS/$tag.jsonl" --usage "$USAGE" --arm "offload-$STYLE" --rep "$N" \
    --repo "$REPO" --tier "complex" --q "$Q" >> "$RESULTS"
node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop());console.log(`  [${o.arm} #${o.rep}] ${o.durationSec}s | main $${o.costUsdMain} ${o.tokBillable} tok | read=${o.read} grep=${o.grep} explore=${o.explore} offload=${o.offloadFired} | AI ${o.ai.calls}call/${o.ai.totalTokens}tok/$${o.ai.costUsd.toFixed(4)} | ok=${o.ok}`)' "$RESULTS"
pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null
echo "raw transcript: $RUNS/$tag.jsonl"
