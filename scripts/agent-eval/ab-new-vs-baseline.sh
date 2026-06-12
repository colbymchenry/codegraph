#!/usr/bin/env bash
# A/B a codegraph retrieval/steering change: the NEW build (current HEAD) vs a
# BASELINE build (a git ref) — BOTH with codegraph attached — on the same
# implementation task, measuring how many Read vs codegraph calls the agent
# makes. ISOLATES the change (unlike run-all.sh's with-vs-without). The agent
# works on a throwaway copy of the target, so your repos are never touched.
#
# Reliable attach (works even when this is itself run nested inside a Claude
# session): each arm PRE-WARMS a persistent codegraph daemon for its target so
# claude connects to an already-bound, index-loaded daemon instantly — before
# the agent's first turn — and SKIPS codegraph's startup re-exec via
# CODEGRAPH_WASM_RELAUNCHED=1. Without this, on a multi-step task the agent
# dives into Read/grep before codegraph finishes its ~2-3s startup (worse under
# the CPU contention of a nested run) and runs with NO codegraph.
#
# Gotcha: claude's `system/init` snapshot can read status:"pending" / 0 tools
# even when the server then connects fine — judge by ACTUAL codegraph usage in
# parse-run.mjs's "by type", not the init line.
#
# Usage: ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]
#   <indexed-repo>  a repo with a .codegraph index (copied per arm)
#   "<task>"        an implementation task, e.g. "Add X to Y and wire it through"
#   [baseline-ref]  git ref for the BEFORE build (default: HEAD~1)
# Env: AGENT_EVAL_OUT (default: /tmp/ab-new-vs-baseline)
set -uo pipefail

TARGET="${1:?usage: ab-new-vs-baseline.sh <indexed-repo> \"<task>\" [baseline-ref]}"
TASK="${2:?task required}"
BASE_REF="${3:-HEAD~1}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-new-vs-baseline}"
PARSE="$ENGINE/scripts/agent-eval/parse-run.mjs"

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$TARGET/.codegraph" ] || { echo "target not indexed: run 'codegraph init $TARGET' first"; exit 1; }
if ! git -C "$ENGINE" diff --quiet || ! git -C "$ENGINE" diff --cached --quiet; then
  echo "engine repo has uncommitted changes — commit or stash first (this script checks files out)"; exit 1
fi
CHANGED=$(git -C "$ENGINE" diff --name-only "$BASE_REF" HEAD -- src 2>/dev/null)
[ -n "$CHANGED" ] || { echo "no src/ changes between $BASE_REF and HEAD — nothing to A/B"; exit 1; }

# On exit: kill any eval daemons + restore the engine to HEAD.
cleanup() {
  pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null
  git -C "$ENGINE" checkout HEAD -- $CHANGED 2>/dev/null
  ( cd "$ENGINE" && npm run build >/dev/null 2>&1 )
}
trap cleanup EXIT

mkdir -p "$OUT"
echo "###### engine=$ENGINE  baseline=$BASE_REF"
echo "###### changed: $(echo "$CHANGED" | tr '\n' ' ')"
echo "###### target=$TARGET"
echo "###### task=$TASK"
echo

# Two pristine copies so each arm starts clean (the agent edits its own copy).
rm -rf "$OUT/t-new" "$OUT/t-base"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .codegraph "$TARGET/" "$OUT/t-new/"
cp -R "$OUT/t-new" "$OUT/t-base"

prewarm() { # target — spawn a persistent daemon (current $BIN) and wait for its socket
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm: $1" || echo "  WARN: daemon never bound for $1 (arm may run without codegraph)"
}

run_arm() { # label, target-copy
  local label="$1" tgt="$2" c="$OUT/mcp-$1.json"
  # Connect to the pre-warmed daemon; skip the startup re-exec for a fast attach.
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$c"
  prewarm "$tgt"
  echo "############## ARM [$label] ##############"
  ( cd "$tgt" && claude -p "$TASK" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" \
      </dev/null > "$OUT/run-$label.jsonl" 2>"$OUT/run-$label.err" )
  node "$PARSE" "$OUT/run-$label.jsonl" 2>&1 | grep -E "by type|Result" || echo "  (parse failed — see $OUT/run-$label.jsonl)"
  pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  echo
}

echo "== NEW build (HEAD) =="
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-new" >/dev/null 2>&1 && echo "  indexed t-new"
run_arm new "$OUT/t-new"

echo "== BASELINE build ($BASE_REF) =="
git -C "$ENGINE" checkout "$BASE_REF" -- $CHANGED
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-base" >/dev/null 2>&1 && echo "  indexed t-base"
run_arm baseline "$OUT/t-base"

echo "###### DONE. Compare the [new] vs [baseline] 'by type' counts above"
echo "###### (especially Read vs mcp__codegraph__*). Full logs in: $OUT"
