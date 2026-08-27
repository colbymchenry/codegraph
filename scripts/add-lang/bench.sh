#!/usr/bin/env bash
# Add-lang benchmark for ONE repo:
#   clone -> wipe+index (with the configured dev binary) -> verify extraction ->
#   with/without retrieval A/B (reuses scripts/agent-eval/run-all.sh).
#
# Assumes the codegraph dev build is already built. Set CG_BIN to its entrypoint
# so the benchmark never depends on, or changes, the maintainer's PATH.
# The A/B is skipped if extraction fails its critical checks (don't burn $ on a
# broken extractor); set FORCE_AB=1 to run it anyway.
#
# Usage: bench.sh <lang> <repo-name> <repo-url> "<question>" [headless|tmux|all]
# Env:   CG_BIN   codegraph entrypoint (default: codegraph resolved on PATH)
#        CORPUS   corpus dir (default /tmp/codegraph-corpus, shared with agent-eval)
set -uo pipefail

LANG_TOKEN="${1:?usage: bench.sh <lang> <repo-name> <repo-url> \"<question>\" [mode]}"
NAME="${2:?repo-name required}"
URL="${3:?repo-url required}"
Q="${4:?question required}"
MODE="${5:-headless}"

HARNESS="$(cd "$(dirname "$0")" && pwd)"
AGENT_EVAL="$(cd "$HARNESS/../agent-eval" && pwd)"
CORPUS="${CORPUS:-/tmp/codegraph-corpus}"
REPO="$CORPUS/$NAME"

CG_BIN="${CG_BIN:-$(command -v codegraph 2>/dev/null || true)}"
[ -n "$CG_BIN" ] || { echo "no codegraph binary (set CG_BIN to the dev entrypoint)"; exit 1; }

echo "==================== add-lang bench: $NAME ($LANG_TOKEN) ===================="
echo "codegraph: $CG_BIN -> $($CG_BIN --version 2>/dev/null || echo '?')"

# 1. Ensure the repo (shallow clone, reuse if present).
mkdir -p "$CORPUS"
if [ -d "$REPO/.git" ]; then
  echo "→ reusing checkout: $REPO"
else
  echo "→ cloning $URL"
  git clone --depth 1 "$URL" "$REPO" || { echo "git clone failed"; exit 1; }
fi

# 2. Wipe + index with the binary under test.
echo "→ wiping .codegraph and indexing"
rm -rf "$REPO/.codegraph"
( cd "$REPO" && "$CG_BIN" init -i ) || { echo "indexing failed"; exit 1; }

# 3. Verify extraction (cheap guard before the paid A/B).
echo "→ verifying extraction"
node "$HARNESS/verify-extraction.mjs" "$REPO" "$LANG_TOKEN"
VERIFY=$?

# 4. Retrieval A/B (skipped if extraction is broken, unless FORCE_AB=1).
if [ "$VERIFY" -ne 0 ] && [ "${FORCE_AB:-0}" != "1" ]; then
  echo "→ SKIPPING A/B — extraction failed critical checks (set FORCE_AB=1 to override)"
else
  echo "→ retrieval A/B (mode=$MODE)"
  bash "$AGENT_EVAL/run-all.sh" "$REPO" "$Q" "$MODE"
fi

echo "==================== bench complete: $NAME (verify exit=$VERIFY) ===================="
# Exit reflects extraction: 0 = pass/warn, 1 = critical fail, 2 = couldn't read status.
exit "$VERIFY"
