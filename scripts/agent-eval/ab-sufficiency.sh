#!/usr/bin/env bash
# Sufficiency A/B: on a real understanding/flow question, WHEN the agent uses
# codegraph (explore/node), does it still Read? Premise under test: explore/node
# return source WITH line numbers, so a Read should not be needed.
#
# WITH codegraph (pre-warmed daemon, reliable nested attach) vs WITHOUT (empty
# MCP, Read/Grep only), N runs each, on a throwaway copy of the repo. Reports
# explore/node vs Read/Grep, and LISTS the files Read in the WITH arm so a true
# sufficiency gap (an indexed source file) is distinguishable from out-of-scope
# (configs, docs, a file codegraph didn't index).
#
# Usage: ab-sufficiency.sh <indexed-repo> "<question>" [runs-per-arm]
# Env: AGENT_EVAL_OUT (default: /tmp/ab-sufficiency)
set -uo pipefail
REPO="${1:?usage: ab-sufficiency.sh <indexed-repo> \"<question>\" [runs]}"
Q="${2:?question required}"
RUNS="${3:-2}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-sufficiency}"
TGT="$OUT/target"
command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$REPO/.codegraph" ] || { echo "no .codegraph index at $REPO"; exit 1; }
cleanup(){ pkill -9 -f "serve --mcp --path $TGT" 2>/dev/null; }
trap cleanup EXIT
mkdir -p "$OUT"
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"

# Throwaway copy + fresh index (the agent works here; a read-only question won't
# edit, but isolate anyway). Excludes the source repo's index/build/vcs.
rm -rf "$TGT"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .codegraph "$REPO/" "$TGT/"
node "$BIN" init "$TGT" >/dev/null 2>&1 && echo "indexed copy ($(node "$BIN" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).fileCount+" files")}catch{console.log("?")}})' 2>/dev/null || echo '?'))"

echo "###### repo=$REPO  runs/arm=$RUNS"
echo "###### Q=$Q"; echo
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"
printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$TGT" > "$OUT/mcp-cg.json"

prewarm(){
  pkill -9 -f "serve --mcp --path $TGT" 2>/dev/null
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$TGT" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$TGT" >/dev/null 2>&1
}

analyze(){
  node -e '
    const fs=require("fs");
    const L=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
    let ex=0,nf=0,ns=0,oc=0,gr=0,exposed="?";const reads=[];
    for(const l of L){try{const o=JSON.parse(l);
      if(o.type==="system"&&o.subtype==="init")exposed=(o.tools||[]).filter(t=>/codegraph/.test(t)).length;
      for(const b of (o.message?.content||[])){if(b.type!=="tool_use")continue;
        if(b.name==="mcp__codegraph__codegraph_explore")ex++;
        else if(b.name==="mcp__codegraph__codegraph_node"){if(b.input&&b.input.symbol)ns++;else nf++;}
        else if(/mcp__codegraph__/.test(b.name))oc++;
        else if(b.name==="Read")reads.push((b.input?.file_path||"").split("/").pop());
        else if(b.name==="Grep")gr++;
      }}catch{}}
    console.log(`    explore=${ex} node[sym]=${ns} node[file]=${nf} other_cg=${oc} | Read=${reads.length}${reads.length?" ("+reads.join(", ")+")":""} Grep=${gr}  [cg exposed=${exposed}]`);
  ' "$1"
}

run(){ # label, cfg, prewarm(0/1)
  local label="$1" cfg="$2" pw="$3"
  for i in $(seq 1 "$RUNS"); do
    [ "$pw" = "1" ] && prewarm
    ( cd "$TGT" && claude -p "$Q" --output-format stream-json --verbose \
        --permission-mode bypassPermissions --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
        --strict-mcp-config --mcp-config "$cfg" </dev/null > "$OUT/$label-$i.jsonl" 2>"$OUT/$label-$i.err" )
    echo "[$label] run $i:"; analyze "$OUT/$label-$i.jsonl"
  done
  echo
}

echo "== WITH codegraph (premise: explore/node used -> Read ~0) =="; run with "$OUT/mcp-cg.json" 1
echo "== WITHOUT (Read/Grep only — the contrast) =="; run without "$OUT/mcp-empty.json" 0
echo "###### DONE. In the WITH arm: are explore/node>0 and Read~0? Any Read of an INDEXED source file = sufficiency gap. Logs: $OUT"
