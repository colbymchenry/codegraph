#!/usr/bin/env bash
# Sufficiency A/B for an IMPLEMENTATION task (the agent edits): when it uses
# codegraph (explore/node) to understand before editing, does it still Read? Like
# ab-sufficiency.sh but copies+indexes a FRESH target per run (the agent mutates
# it), so runs don't see each other's edits.
#
# WITH codegraph (pre-warmed) vs WITHOUT (empty MCP), N runs each. Reports
# explore/node vs Read/Grep + the files Read, and whether the build still passes.
#
# Usage: ab-impl.sh <indexed-repo> "<task>" [runs] [build-cmd]
# Env: AGENT_EVAL_OUT (default: /tmp/ab-impl)
set -uo pipefail
REPO="${1:?usage: ab-impl.sh <indexed-repo> \"<task>\" [runs] [build-cmd]}"
Q="${2:?task required}"
RUNS="${3:-2}"
BUILD_CMD="${4:-}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-impl}"
command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$REPO/.codegraph" ] || { echo "no .codegraph index at $REPO"; exit 1; }
cleanup(){ pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null; }
trap cleanup EXIT
mkdir -p "$OUT"
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built engine"
echo "###### repo=$REPO  runs/arm=$RUNS"
echo "###### task=$Q"; echo
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

prewarm(){
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" >/dev/null 2>&1
}

analyze(){
  node -e '
    const fs=require("fs");
    const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let ex=0,nf=0,ns=0,oc=0,gr=0,ed=0,exposed="?";const reads=[];
    for(const l of L){try{const o=JSON.parse(l);
      if(o.type==="system"&&o.subtype==="init")exposed=(o.tools||[]).filter(t=>/codegraph/.test(t)).length;
      for(const b of (o.message?.content||[])){if(b.type!=="tool_use")continue;
        if(b.name==="mcp__codegraph__codegraph_explore")ex++;
        else if(b.name==="mcp__codegraph__codegraph_node"){if(b.input&&b.input.symbol)ns++;else nf++;}
        else if(/mcp__codegraph__/.test(b.name))oc++;
        else if(b.name==="Read")reads.push((b.input?.file_path||"").split("/").pop());
        else if(b.name==="Grep")gr++;
        else if(b.name==="Edit"||b.name==="Write")ed++;
      }}catch{}}
    console.log(`    explore=${ex} node[sym]=${ns} node[file]=${nf} other_cg=${oc} | Read=${reads.length}${reads.length?" ("+reads.join(", ")+")":""} Grep=${gr} Edit=${ed}  [cg exposed=${exposed}]`);
  ' "$1"
}

run(){ # label, withCodegraph(0/1)
  local label="$1" wcg="$2"
  for i in $(seq 1 "$RUNS"); do
    local tgt="$OUT/t-$label-$i" cfg="$OUT/mcp-$label.json"
    rm -rf "$tgt"
    rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .codegraph "$REPO/" "$tgt/"
    node "$BIN" init "$tgt" >/dev/null 2>&1
    if [ "$wcg" = "1" ]; then
      printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$cfg"
      prewarm "$tgt"
    else cp "$OUT/mcp-empty.json" "$cfg"; fi
    ( cd "$tgt" && claude -p "$Q" --output-format stream-json --verbose \
        --permission-mode bypassPermissions --model opus --max-budget-usd 4 \
        --strict-mcp-config --mcp-config "$cfg" </dev/null > "$OUT/$label-$i.jsonl" 2>"$OUT/$label-$i.err" )
    echo "[$label] run $i:"; analyze "$OUT/$label-$i.jsonl"
    if [ -n "$BUILD_CMD" ]; then ( cd "$tgt" && eval "$BUILD_CMD" >/dev/null 2>&1 && echo "      build: PASS" || echo "      build: FAIL" ); fi
    pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  done
  echo
}

echo "== WITH codegraph =="; run with 1
echo "== WITHOUT (Read/Grep only) =="; run without 0
echo "###### DONE: $OUT"
