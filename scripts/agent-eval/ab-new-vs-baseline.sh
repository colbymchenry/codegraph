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
# Env:
#   AGENT_EVAL_OUT  output dir (default: /tmp/ab-new-vs-baseline)
#   RUNS            runs per arm (default 1). Run-to-run variance is large —
#                   use >=2 and report the range, never a single run. Both arms
#                   build/index ONCE and then run RUNS times, so raising this is
#                   far cheaper than re-invoking the script.
#   MODEL / EFFORT  default sonnet / high. Never raise without a reason: sonnet
#                   is the deliberate floor model (see CLAUDE.md).
#
# Both arms run with CODEGRAPH_NO_PROMPT_HOOK=1: the machine's ambient
# UserPromptSubmit front-load hook resolves to whichever build is currently in
# dist/, so leaving it on injects context through a second, uncontrolled channel
# and confounds the tool-call counts this script exists to compare.
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
# INT/TERM too: killing the script mid-baseline-arm otherwise leaves the engine
# checked out at the baseline ref, which silently poisons every later build.
trap cleanup EXIT INT TERM

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

run_arm() { # label, target-copy — runs the task $RUNS times against one build
  local label="$1" tgt="$2" c="$OUT/mcp-$1.json"
  # Connect to the pre-warmed daemon; skip the startup re-exec for a fast attach.
  # CODEGRAPH_EXPLORE_DEBUG points explore's per-file allocation diagnostic at a
  # sidecar (no-op on builds predating it; never perturbs the response).
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","CODEGRAPH_EXPLORE_DEBUG=%s","node","%s","serve","--mcp","--path","%s"]}}}' \
    "$OUT/explore-$label.jsonl" "$BIN" "$tgt" > "$c"
  rm -f "$OUT/explore-$label.jsonl"
  echo "############## ARM [$label] ##############"
  for i in $(seq 1 "${RUNS:-1}"); do
    # Re-warm per run: the previous run's daemon is killed below, and a cold
    # attach is exactly the failure this pre-warm exists to prevent.
    prewarm "$tgt"
    ( cd "$tgt" && CODEGRAPH_NO_PROMPT_HOOK=1 claude -p "$TASK" \
        --output-format stream-json --verbose --permission-mode bypassPermissions \
        --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" \
        </dev/null > "$OUT/run-$label-$i.jsonl" 2>"$OUT/run-$label-$i.err" )
    echo "-- run $i --"
    node "$PARSE" "$OUT/run-$label-$i.jsonl" 2>&1 | grep -E "by type|Result" || echo "  (parse failed — see $OUT/run-$label-$i.jsonl)"
    pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  done
  echo
}

echo "== NEW build (HEAD) =="
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-new" >/dev/null 2>&1 && echo "  indexed t-new"
run_arm new "$OUT/t-new"

echo "== BASELINE build ($BASE_REF) =="
# Per-file: a file ADDED since baseline has no pathspec on the ref — and a
# single multi-file checkout with one bad pathspec checks out NOTHING, which
# silently ran the NEW build in the baseline arm. Absent-on-baseline → remove.
for f in $CHANGED; do
  git -C "$ENGINE" checkout "$BASE_REF" -- "$f" 2>/dev/null || rm -f "$ENGINE/$f"
done
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-base" >/dev/null 2>&1 && echo "  indexed t-base"
run_arm baseline "$OUT/t-base"

echo "###### DONE. Compare the [new] vs [baseline] 'by type' counts above"
echo "###### (especially Read vs mcp__codegraph__*). Full logs in: $OUT"
