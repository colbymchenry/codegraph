#!/usr/bin/env bash
#
# Rebuild the committed SCIP fixture indexes (__tests__/fixtures/scip-*/index.scip)
# from their project/ sources, with the arguments the adapters pass (src/scip/indexers/).
# Run it after editing a fixture's sources; CI only reads the committed indexes.
#
# Usage: scripts/scip-eval/fixtures.sh [go|python|rust|typescript ...]   (default: all)
# Needs: scip-go, scip-python, rust-analyzer on PATH; npx for scip-typescript.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/__tests__/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

build() {
  local lang=$1 dir=$2
  echo "== $lang ($dir)"
  cd "$FIX/$dir/project"
  case $lang in
    go) scip-go index --quiet --output "$FIX/$dir/index.scip" ;;
    python)
      echo '[]' > "$TMP/env.json" # no venv: project code still resolves
      scip-python index . --project-name shop --environment "$TMP/env.json" --output "$FIX/$dir/index.scip" >/dev/null ;;
    rust) rust-analyzer scip . --output "$FIX/$dir/index.scip" ;;
    typescript) npx -y @sourcegraph/scip-typescript@0.4.0 index --output "$FIX/$dir/index.scip" >/dev/null ;;
  esac
}

langs=("$@")
[ ${#langs[@]} -gt 0 ] || langs=(go python rust typescript)
for lang in "${langs[@]}"; do
  case $lang in
    go) build go scip-go ;;
    python) build python scip-py ;;
    rust) build rust scip-rust ;;
    typescript) build typescript scip-ts ;;
    *) echo "unknown language: $lang" >&2; exit 2 ;;
  esac
done
