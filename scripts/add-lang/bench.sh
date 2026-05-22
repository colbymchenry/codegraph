#!/usr/bin/env bash
# Add-lang benchmark for ONE repo:
#   clone -> wipe+index (with the codegraph on PATH) -> verify extraction ->
#   with/without retrieval A/B (reuses scripts/agent-eval/run-all.sh).
#
# Assumes the codegraph dev build is already built + linked on PATH — the skill
# runs `npm run build && ./scripts/local-install.sh` ONCE before looping repos.
# The A/B is skipped if extraction fails its critical checks (don't burn $ on a
# broken extractor); set FORCE_AB=1 to run it anyway.
#
# Usage: bench.sh <lang> <repo-name> <repo-url> "<question>" [headless|tmux|all]
# Env:   CORPUS   corpus dir (default /tmp/codegraph-corpus, shared with agent-eval)
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

command -v codegraph >/dev/null || { echo "no codegraph on PATH (build + ./scripts/local-install.sh first)"; exit 1; }

echo "==================== add-lang bench: $NAME ($LANG_TOKEN) ===================="
echo "codegraph: $(command -v codegraph) -> $(codegraph --version 2>/dev/null || echo '?')"

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
( cd "$REPO" && codegraph init -i ) || { echo "indexing failed"; exit 1; }

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
