#!/usr/bin/env bash
# Clone + index the 4 "not-trained-on" eval repos into $AGENT_EVAL_OUT/repos. These were
# selected via a no-tools memory-probe gate (Sonnet cannot answer their flow questions from
# memory — so the no-codegraph baseline is honest). Env: AGENT_EVAL_OUT=<scratch dir>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/../.." && pwd)"
BIN="$ENGINE/dist/bin/codegraph.js"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
ROOT="$OUT/repos"; mkdir -p "$ROOT"
export CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1
[ -f "$BIN" ] || { echo "engine not built: run 'npm run build' in $ENGINE first"; exit 1; }

clone_index() { # url name
  echo "=== $2: clone ==="; rm -rf "$ROOT/$2"
  git clone --quiet --depth 1 "$1" "$ROOT/$2" || { echo "  clone FAILED"; return 1; }
  echo "=== $2: index ==="
  node "$BIN" init "$ROOT/$2" 2>&1 | grep -iE 'indexed|nodes|edges|error' | tail -2
}
clone_index https://github.com/MTKruto/MTKruto.git mtkruto          # small  (~322 TS)
clone_index https://github.com/mvdicarlo/postybirb-plus.git postybirb  # medium (~608 TS)
clone_index https://github.com/shapeshift/web.git shapeshift        # complex (~3.2k TS, 35-pkg monorepo)
clone_index https://github.com/trezor/trezor-suite.git trezor       # large  (~8k TS monorepo)
echo "###### SETUP DONE -> $ROOT"
