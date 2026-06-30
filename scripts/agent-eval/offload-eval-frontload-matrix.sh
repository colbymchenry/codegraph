#!/usr/bin/env bash
# Run the FRONTLOAD arm across all 4 tiers (n reps), then judge + merge with the existing
# matrix (offload/raw/nocg in $OUT/judged.jsonl, if present) + emit a combined summary.
# Env: REPS (default 3)  AGENT_EVAL_OUT=<scratch dir>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${AGENT_EVAL_OUT:-/tmp/cg-offload-eval}"
GT="$HERE/offload-eval-ground-truth.json"
REPS="${REPS:-3}"
export RESULTS="$OUT/results-fl.jsonl"
: > "$RESULTS"; rm -f "$OUT/runs/hook-debug.log"
for repo in mtkruto postybirb shapeshift trezor; do
  case "$repo" in mtkruto) tier=small;; postybirb) tier=medium;; shapeshift) tier=complex;; trezor) tier=large;; esac
  Q=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]].question)" "$GT" "$repo")
  echo ""; echo "### $repo ($tier)  $(date +%H:%M:%S)"
  bash "$HERE/offload-eval-frontload.sh" "$OUT/repos/$repo" "$tier" "$REPS" "$Q"
done
echo ""
echo "frontload: $(wc -l < "$RESULTS") runs | hook injections: $(grep -c INJECTED "$OUT/runs/hook-debug.log" 2>/dev/null) | errors: $(grep -c ERROR "$OUT/runs/hook-debug.log" 2>/dev/null)"
echo "=== JUDGE frontload ==="
node "$HERE/offload-eval-judge.mjs" --results "$RESULTS" --truth "$GT" --out "$OUT/judged-fl.jsonl" --concurrency 4 2>&1 | tail -4
if [ -f "$OUT/judged.jsonl" ]; then cat "$OUT/judged.jsonl" "$OUT/judged-fl.jsonl" > "$OUT/judged-all.jsonl"; else cp "$OUT/judged-fl.jsonl" "$OUT/judged-all.jsonl"; fi
echo "=== COMBINED SUMMARY ==="
node "$HERE/offload-eval-summarize.mjs" "$OUT/judged-all.jsonl"
echo "###### FRONTLOAD MATRIX DONE"
