#!/usr/bin/env bash
# Build the current branch and link it as the global `codegraph` for
# hands-on testing. Replaces any existing global install for as long
# as the symlink is in place.
#
# Usage:
#   ./scripts/local-install.sh           # build + link
#   ./scripts/local-install.sh --undo    # unlink + restore the published version

set -euo pipefail

cd "$(dirname "$0")/.."

PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "${1:-}" = "--undo" ]; then
  echo "→ unlinking ${PKG}"
  npm unlink -g "${PKG}" >/dev/null 2>&1 || true
  echo "→ reinstalling published ${PKG}"
  npm install -g "${PKG}"
  echo "done: global codegraph -> $(command -v codegraph)"
  exit 0
fi

echo "→ building ${PKG} ${VERSION} (${BRANCH})"
npm run build

echo "→ linking globally"
npm link

LINKED=$(command -v codegraph || echo "(not on PATH)")
echo
echo "✓ global codegraph now points to this branch"
echo "  binary:  ${LINKED}"
echo "  branch:  ${BRANCH}"
echo "  version: ${VERSION}"
echo
echo "To restore the published version:"
echo "  ./scripts/local-install.sh --undo"
