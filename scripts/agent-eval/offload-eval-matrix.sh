#!/usr/bin/env bash
# Drive the 3-arm campaign (offload/raw/nocg) across all 4 tiers, n reps each, into one
# results.jsonl. Reads the canonical question per repo from offload-eval-ground-truth.json.
# Env: REPS (default 3)  AGENT_EVAL_OUT=<scratch dir>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
GT="$HERE/offload-eval-ground-truth.json"
REPS="${REPS:-3}"
export RESULTS="$OUT/results.jsonl"
: > "$RESULTS"
for repo in mtkruto postybirb shapeshift trezor; do
  case "$repo" in mtkruto) tier=small;; postybirb) tier=medium;; shapeshift) tier=complex;; trezor) tier=large;; esac
  Q=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]].question)" "$GT" "$repo")
  echo ""; echo "### $repo ($tier)  $(date +%H:%M:%S)"
  bash "$HERE/offload-eval-3arm.sh" "$OUT/repos/$repo" "$tier" "$REPS" "$Q"
done
echo ""; echo "###### MATRIX DONE -> $RESULTS ($(wc -l < "$RESULTS") runs).  Judge + summarize with:"
echo "  node $HERE/offload-eval-judge.mjs --results $RESULTS --truth $GT --out $OUT/judged.jsonl"
echo "  node $HERE/offload-eval-summarize.mjs $OUT/judged.jsonl"
