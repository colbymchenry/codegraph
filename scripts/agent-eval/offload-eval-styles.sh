#!/usr/bin/env bash
# Offload reasoning-OUTPUT-STYLE A/B — all codegraph-on, isolating the Worker's
# output shape's effect on main-session tokens / latency / accuracy:
#   raw  : CODEGRAPH_OFFLOAD_DISABLE=1            (verbatim explore source, the floor)
#   refs : managed offload, default              (Cerebras map re-expanded to verbatim, ~24K)
#   map  : managed offload, STYLE=map            (compact reasoned map + file:line anchors, ~1-3K)
#   src  : managed offload, STYLE=src            (map + cited line ranges only, ~1-5K)
# Delegation BLOCKED by default (DISALLOW=Agent) so we measure the offload payload's
# effect on the main Sonnet agent, not whether it spawns a Haiku Explore subagent.
#
# Usage: offload-eval-styles.sh <indexed-repo> <reps> "<question>"
# Env:   RESULTS=<file>  AGENT_EVAL_OUT=<dir>  REP_START=1  DISALLOW=Agent  MODEL/EFFORT
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
TARGET="${1:?usage: offload-eval-styles.sh <indexed-repo> <reps> \"<question>\"}"
REPS="${2:?reps}"; Q="${3:?question}"
RUNS="$OUT/runs"; EXTRACT="$HERE/offload-eval-metrics.mjs"
RESULTS="${RESULTS:-$OUT/results-styles.jsonl}"
REPO=$(basename "$TARGET")
DISALLOW="${DISALLOW-Agent}"   # default: block delegation. `DISALLOW= ` to allow.
START="${REP_START:-1}"; END=$((START + REPS - 1))
mkdir -p "$RUNS"
command -v claude >/dev/null || { echo "no claude on PATH"; exit 1; }
[ -d "$TARGET/.codegraph" ] || { echo "not indexed: $TARGET"; exit 1; }
TARGET=$(cd "$TARGET" && pwd -P)

prewarm() { # path  extra-env
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null; rm -f "$1/.codegraph/daemon.sock" 2>/dev/null; sleep 0.6
  env ${2:-} CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm" || echo "  WARN daemon never bound"
}
kill_daemon() { pkill -9 -f "serve --mcp --path $TARGET" 2>/dev/null; rm -f "$TARGET/.codegraph/daemon.sock" 2>/dev/null; sleep 1; }

run() { # arm rep mcp-config usage-log-or-dash
  local arm="$1" rep="$2" cfg="$3" usage="$4" tag="$REPO-$1-$2"
  [ "$usage" != "-" ] && : > "$usage"
  ( cd "$TARGET" && claude -p "$Q" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
      ${DISALLOW:+--disallowedTools "$DISALLOW"} \
      --strict-mcp-config --mcp-config "$cfg" \
      </dev/null > "$RUNS/$tag.jsonl" 2>"$RUNS/$tag.err" )
  node "$EXTRACT" --run "$RUNS/$tag.jsonl" --usage "$usage" --arm "$arm" --rep "$rep" \
      --repo "$REPO" --tier styles --q "$Q" >> "$RESULTS"
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").pop());console.log(`  [${o.arm} #${o.rep}] ${o.durationSec}s | ${o.tokBillable} billable tok | read=${o.read} grep=${o.grep} explore=${o.explore} offload=${o.offloadFired} | AI ${o.ai.calls}c/${o.ai.totalTokens}t | ok=${o.ok}`)' "$RESULTS"
}

# MCP configs: env baked into the daemon-spawn command claude uses.
USAGE="$RUNS/$REPO-usage.jsonl"
mkcfg() { # file extra-env-pairs(JSON array entries, comma-led or empty)
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1"%s,"node","%s","serve","--mcp","--path","%s"]}}}' "$1" "$BIN" "$TARGET"
}
CFG_RAW="$RUNS/mcp-sty-raw-$REPO.json";   mkcfg ',"CODEGRAPH_OFFLOAD_DISABLE=1"' > "$CFG_RAW"
CFG_REFS="$RUNS/mcp-sty-refs-$REPO.json"; mkcfg ",\"CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE\"" > "$CFG_REFS"
CFG_MAP="$RUNS/mcp-sty-map-$REPO.json";   mkcfg ",\"CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE\",\"CODEGRAPH_OFFLOAD_STYLE=map\"" > "$CFG_MAP"
CFG_SRC="$RUNS/mcp-sty-src-$REPO.json";   mkcfg ",\"CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE\",\"CODEGRAPH_OFFLOAD_STYLE=src\"" > "$CFG_SRC"

echo "###### repo=$REPO reps=$START..$END model=${MODEL:-sonnet}/${EFFORT:-high} disallow=${DISALLOW:-<none>}"
echo "###### Q=$Q"
echo "== ARM raw ==";  prewarm "$TARGET" "CODEGRAPH_OFFLOAD_DISABLE=1"
for r in $(seq "$START" "$END"); do run raw  "$r" "$CFG_RAW"  "-"; done; kill_daemon
echo "== ARM refs =="; prewarm "$TARGET" "CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE"
for r in $(seq "$START" "$END"); do run refs "$r" "$CFG_REFS" "$USAGE"; done; kill_daemon
echo "== ARM map ==";  prewarm "$TARGET" "CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE CODEGRAPH_OFFLOAD_STYLE=map"
for r in $(seq "$START" "$END"); do run map  "$r" "$CFG_MAP"  "$USAGE"; done; kill_daemon
echo "== ARM src ==";  prewarm "$TARGET" "CODEGRAPH_OFFLOAD_USAGE_LOG=$USAGE CODEGRAPH_OFFLOAD_STYLE=src"
for r in $(seq "$START" "$END"); do run src  "$r" "$CFG_SRC"  "$USAGE"; done; kill_daemon
echo "###### DONE $REPO — judge: node $HERE/offload-eval-judge.mjs --results $RESULTS --truth $HERE/offload-eval-ground-truth.json --out $OUT/judged-styles.jsonl"