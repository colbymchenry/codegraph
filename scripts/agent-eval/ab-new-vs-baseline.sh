#!/usr/bin/env bash
# A/B a codegraph retrieval/steering change: the NEW build (current HEAD) vs a
# BASELINE build (a git ref) — BOTH with codegraph attached — on the same
# implementation task, measuring how many Read vs codegraph calls the agent
# makes. This ISOLATES the change (unlike run-all.sh, which is with-vs-without
# codegraph). The agent works on a throwaway copy of the target, so its edits
# never touch your repos.
#
# *** RUN THIS IN A REAL TERMINAL — NOT nested inside a Claude Code session. ***
# A `claude -p` spawned from within another Claude session (e.g. from a Bash
# tool call) cannot reliably attach the codegraph MCP server: the server is
# healthy (full handshake ~165ms) but the nested client marks it
# status:"pending" / 0 tools under CPU/timing contention, and degrades to
# consistent failure over a long session. NO_DAEMON + `< /dev/null` do NOT fix
# it — it's the nested client, not the server. See codegraph/CLAUDE.md
# ("Running agent-evals — do NOT nest").
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

# Always restore the engine to HEAD on exit, even if interrupted mid-arm.
restore() { git -C "$ENGINE" checkout HEAD -- $CHANGED 2>/dev/null; ( cd "$ENGINE" && npm run build >/dev/null 2>&1 ); }
trap restore EXIT

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

cfg() { printf '{"mcpServers":{"codegraph":{"command":"%s","args":["serve","--mcp","--path","%s"]}}}' "$BIN" "$1" > "$2"; }

run_arm() { # label, target-copy
  local label="$1" tgt="$2" c="$OUT/mcp-$1.json"
  cfg "$tgt" "$c"
  echo "############## ARM [$label] ##############"
  ( cd "$tgt" && claude -p "$TASK" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model opus --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" \
      < /dev/null > "$OUT/run-$label.jsonl" 2>"$OUT/run-$label.err" )
  node "$PARSE" "$OUT/run-$label.jsonl" 2>&1 | grep -E "tools exposed|by type|Result" || echo "  (parse failed — see $OUT/run-$label.jsonl)"
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
