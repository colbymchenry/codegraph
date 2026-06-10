#!/usr/bin/env bash
# A/B the PreToolUse(Read) REDIRECT hook (P1): does steering Read → codegraph_node
# file-view actually move the agent off Read during implementation? BOTH arms use
# the CURRENT build with codegraph attached and pre-warmed; the only difference is
# the hook. Isolates the hook's behavioral effect from the build/file-view change
# (use ab-new-vs-baseline.sh for the build A/B).
#
#   arm [nohook] — codegraph on, no hook   (does the better file-view get picked on its own?)
#   arm [hook]   — codegraph on, + redirect hook   (does routing close it?)
#
# Reliable attach (works nested): each arm pre-warms a persistent daemon and skips
# the startup re-exec (CODEGRAPH_WASM_RELAUNCHED=1), so claude connects before the
# agent's first turn. Judge by ACTUAL codegraph usage in parse-run.mjs's "by type",
# not claude's init snapshot (which can read pending even when it then connects).
#
# Usage: ab-hook.sh <indexed-repo> "<implementation task>" [runs-per-arm]
#   <indexed-repo>  a repo with a .codegraph index (copied per arm; never mutated)
#   "<task>"        a GENUINELY-NEW implementation task (verify it isn't already done)
#   [runs-per-arm]  default 2 (n=1 is noisy — the doctrine says >=2)
# Env: AGENT_EVAL_OUT (default: /tmp/ab-hook)
set -uo pipefail

TARGET="${1:?usage: ab-hook.sh <indexed-repo> \"<task>\" [runs-per-arm]}"
TASK="${2:?task required}"
RUNS="${3:-2}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
HOOK="$ENGINE/scripts/agent-eval/redirect-read-hook.sh"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-hook}"
PARSE="$ENGINE/scripts/agent-eval/parse-run.mjs"

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
command -v jq >/dev/null || { echo "jq not on PATH (the hook needs it)"; exit 1; }
[ -d "$TARGET/.codegraph" ] || { echo "target not indexed: run 'codegraph init $TARGET' first"; exit 1; }
chmod +x "$HOOK"

cleanup() { pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null; }
trap cleanup EXIT

mkdir -p "$OUT"
echo "###### engine=$ENGINE"
echo "###### target=$TARGET   runs/arm=$RUNS"
echo "###### task=$TASK"
echo

( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"

# A settings file carrying ONLY the PreToolUse(Read) redirect hook.
HOOK_SETTINGS="$OUT/hook-settings.json"
jq -n --arg cmd "bash $HOOK" \
  '{hooks:{PreToolUse:[{matcher:"Read",hooks:[{type:"command",command:$cmd}]}]}}' > "$HOOK_SETTINGS"

prewarm() { # target — spawn a persistent daemon and wait for its socket
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.codegraph/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm: $1" || echo "  WARN: daemon never bound for $1"
}

run_one() { # arm-label, run-index, use-hook(0|1)
  local label="$1" idx="$2" hook="$3"
  local tgt="$OUT/t-$label-$idx" c="$OUT/mcp-$label.json"
  rm -rf "$tgt"
  rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .codegraph "$TARGET/" "$tgt/"
  node "$BIN" init "$tgt" >/dev/null 2>&1
  printf '{"mcpServers":{"codegraph":{"command":"env","args":["CODEGRAPH_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$c"
  prewarm "$tgt"
  local extra=()
  [ "$hook" = "1" ] && extra=(--settings "$HOOK_SETTINGS")
  echo "----- [$label] run $idx -----"
  # ${extra[@]+...} guard: bash 3.2 (macOS) under `set -u` errors on an empty
  # array expansion otherwise, which would skip the no-hook arm's claude run.
  ( cd "$tgt" && claude -p "$TASK" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model opus --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" ${extra[@]+"${extra[@]}"} \
      </dev/null > "$OUT/run-$label-$idx.jsonl" 2>"$OUT/run-$label-$idx.err" )
  node "$PARSE" "$OUT/run-$label-$idx.jsonl" 2>&1 | grep -E "by type|Result" || echo "  (parse failed — see $OUT/run-$label-$idx.jsonl)"
  pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  echo
}

for i in $(seq 1 "$RUNS"); do run_one nohook "$i" 0; done
for i in $(seq 1 "$RUNS"); do run_one hook   "$i" 1; done

echo "###### DONE. Compare [nohook] vs [hook] 'by type' — Read should fall and"
echo "###### mcp__codegraph__codegraph_node should rise in the [hook] arm. Logs: $OUT"
