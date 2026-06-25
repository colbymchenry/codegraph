#!/usr/bin/env bash
# Does the agent PICK codegraph_node to read a file, vs the built-in Read tool?
# Build A/B: NEW build (HEAD, codegraph_node has Read parity) vs BASELINE build
# (a ref where it doesn't), BOTH codegraph-attached + pre-warmed, same task. The
# metric is tool CHOICE: Read calls vs codegraph_node[file] calls per run.
#
# Usage: ab-adoption.sh <indexed-repo> "<task>" [runs-per-arm] [baseline-ref]
# Env: AGENT_EVAL_OUT (default: /tmp/ab-adoption)
set -uo pipefail
TARGET="${1:?usage: ab-adoption.sh <indexed-repo> \"<task>\" [runs] [baseline-ref]}"
TASK="${2:?task required}"
RUNS="${3:-2}"
BASE_REF="${4:-HEAD~1}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-adoption}"

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$TARGET/.codegraph" ] || { echo "target not indexed: run 'codegraph init $TARGET' first"; exit 1; }
git -C "$ENGINE" diff --quiet && git -C "$ENGINE" diff --cached --quiet || { echo "engine has uncommitted changes — commit/stash first"; exit 1; }
CHANGED=$(git -C "$ENGINE" diff --name-only "$BASE_REF" HEAD -- src 2>/dev/null)
[ -n "$CHANGED" ] || { echo "no src/ changes between $BASE_REF and HEAD"; exit 1; }

cleanup() {
  pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null
  git -C "$ENGINE" checkout HEAD -- $CHANGED 2>/dev/null
  ( cd "$ENGINE" && npm run build >/dev/null 2>&1 )
}
trap cleanup EXIT
mkdir -p "$OUT"
echo "###### target=$TARGET  runs/arm=$RUNS  baseline=$BASE_REF"
echo "###### changed: $(echo "$CHANGED" | tr '\n' ' ')"
echo "###### task=$TASK"; echo

prewarm() {
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" >/dev/null 2>&1
}

# Per-run tool-choice counts: Read vs codegraph_node[file] vs [symbol].
count() {
  node -e '
    const fs=require("fs");
    const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let read=0,cgFile=0,cgSym=0,cgOther=0,exposed="?";
    for(const l of lines){try{const o=JSON.parse(l);
      if(o.type==="system"&&o.subtype==="init"){exposed=(o.tools||[]).filter(t=>/codegraph/.test(t)).length;}
      const blocks=o.message?.content||[];
      for(const b of (Array.isArray(blocks)?blocks:[])){
        if(b.type!=="tool_use")continue;
        if(b.name==="Read")read++;
        else if(b.name==="mcp__codegraph__codegraph_node"){ if(b.input&&b.input.symbol)cgSym++; else cgFile++; }
        else if(/mcp__codegraph__/.test(b.name))cgOther++;
      }
    }catch{}}
    console.log(`    Read=${read}  codegraph_node[file]=${cgFile}  codegraph_node[symbol]=${cgSym}  other_cg=${cgOther}  (cg exposed=${exposed})`);
  ' "$1"
}

run_arm() { # label, N
  local label="$1" n="$2"
  local c="$OUT/mcp-$label.json"
  for i in $(seq 1 "$n"); do
    local tgt="$OUT/t-$label-$i"
    rm -rf "$tgt"
    rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .codegraph "$TARGET/" "$tgt/"
    node "$BIN" init "$tgt" >/dev/null 2>&1
    printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$c"
    prewarm "$tgt"
    echo "----- [$label] run $i -----"
    ( cd "$tgt" && claude -p "$TASK" \
        --output-format stream-json --verbose --permission-mode bypassPermissions \
        --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" \
        </dev/null > "$OUT/run-$label-$i.jsonl" 2>"$OUT/run-$label-$i.err" )
    count "$OUT/run-$label-$i.jsonl"
    pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  done
  echo
}

echo "== NEW build (HEAD: codegraph_node has Read parity) =="
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"
run_arm new "$RUNS"

echo "== BASELINE build ($BASE_REF) =="
git -C "$ENGINE" checkout "$BASE_REF" -- $CHANGED
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"
run_arm baseline "$RUNS"

echo "###### DONE — compare [new] vs [baseline]: does codegraph_node[file] rise / Read fall? Logs: $OUT"
