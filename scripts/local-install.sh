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
  LINK="${HOME}/.local/bin/codegraph"
  PREVIOUS="${LINK}.previous-target"
  if [ -f "$PREVIOUS" ]; then
    TARGET=$(<"$PREVIOUS")
    if [ -e "$TARGET" ]; then
      ln -sfn "$TARGET" "$LINK"
      rm -f "$PREVIOUS"
      echo "done: restored codegraph -> $(command -v codegraph || echo \"$LINK\")"
      exit 0
    fi
  fi
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
NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
NPM_BIN="${NPM_PREFIX}/bin"
if [ -n "$NPM_PREFIX" ] && [ -d "$NPM_BIN" ] && [ -w "$NPM_BIN" ]; then
  npm link
else
  LINK="${HOME}/.local/bin/codegraph"
  PREVIOUS="${LINK}.previous-target"
  mkdir -p "$(dirname "$LINK")"
  if [ -L "$LINK" ]; then
    printf '%s\n' "$(readlink -f "$LINK")" > "$PREVIOUS"
  elif [ -e "$LINK" ]; then
    echo "refusing to replace existing non-symlink ${LINK}" >&2
    exit 1
  fi
  ln -sfn "$PWD/dist/bin/codegraph.js" "$LINK"
  echo "npm global prefix is not writable; linked directly to ${LINK}"
fi

LINKED=$(command -v codegraph || echo "(not on PATH)")
echo
echo "✓ global codegraph now points to this branch"
echo "  binary:  ${LINKED}"
echo "  branch:  ${BRANCH}"
echo "  version: ${VERSION}"
echo
echo "To restore the published version:"
echo "  ./scripts/local-install.sh --undo"
