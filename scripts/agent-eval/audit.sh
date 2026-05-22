#!/usr/bin/env bash
# One-shot CodeGraph quality audit:
#   set version -> ensure corpus repo -> wipe+reindex with that version ->
#   run with/without A/B -> restore the local dev link.
#
# Usage: audit.sh <version> <repo-name> <repo-url> "<question>" [headless|all]
#   <version>    "local" (build + npm link this repo) | "latest" | a version (e.g. 0.7.10)
#   <repo-name>  dir name under the corpus dir
#   <repo-url>   git URL (cloned --depth 1 when the repo dir is missing)
#   [mode]       headless (default) | all (also the interactive tmux arms)
# Env: CORPUS  corpus dir (default: /tmp/codegraph-corpus)
set -uo pipefail

VERSION="${1:?usage: audit.sh <version> <repo-name> <repo-url> \"<question>\" [mode]}"
NAME="${2:?repo-name required}"
URL="${3:?repo-url required}"
Q="${4:?question required}"
MODE="${5:-headless}"

HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../.." && pwd)"     # codegraph repo root
CORPUS="${CORPUS:-/tmp/codegraph-corpus}"
REPO="$CORPUS/$NAME"
PKG="@colbymchenry/codegraph"

echo "==================== CodeGraph audit ===================="
echo "version=$VERSION  repo=$NAME  mode=$MODE  corpus=$CORPUS"
echo

# 1. Set the codegraph version under test (mutates the global install).
if [ "$VERSION" = local ]; then
  echo "→ [1/4] building + linking local dev build (local-install.sh)"
  ( cd "$REPO_ROOT" && ./scripts/local-install.sh ) || { echo "local-install.sh failed"; exit 1; }
else
  echo "→ [1/4] installing $PKG@$VERSION globally"
  npm install -g "$PKG@$VERSION" || { echo "npm install -g $PKG@$VERSION failed"; exit 1; }
fi
ACTUAL="$(codegraph --version 2>/dev/null || echo '?')"
echo "  codegraph on PATH: $(command -v codegraph) -> $ACTUAL"

# 2. Ensure the corpus repo exists (clone shallow if missing, reuse if present).
mkdir -p "$CORPUS"
if [ -d "$REPO/.git" ]; then
  echo "→ [2/4] reusing existing checkout: $REPO"
else
  echo "→ [2/4] cloning $URL"
  git clone --depth 1 "$URL" "$REPO" || { echo "git clone failed"; exit 1; }
fi

# 3. Wipe + re-index with THIS version (the index must be built by the same
#    binary that serves it — different versions extract differently).
echo "→ [3/4] wiping .codegraph and re-indexing with $ACTUAL"
rm -rf "$REPO/.codegraph"
( cd "$REPO" && codegraph init -i ) || { echo "indexing failed"; exit 1; }

# 4. Run the with/without A/B.
echo "→ [4/4] running A/B harness (mode=$MODE)"
bash "$HARNESS/run-all.sh" "$REPO" "$Q" "$MODE"

# Restore the dev link (the normal working state in this repo).
echo
echo "→ restoring local dev link (local-install.sh)"
if ( cd "$REPO_ROOT" && ./scripts/local-install.sh >/dev/null 2>&1 ); then
  echo "  global codegraph restored to dev build"
else
  echo "  WARN: restore failed — run ./scripts/local-install.sh manually"
fi
echo "==================== audit complete ===================="
