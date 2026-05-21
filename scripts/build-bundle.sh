#!/usr/bin/env bash
#
# Build a self-contained CodeGraph bundle: an official Node runtime + the
# compiled app + its production deps, so CodeGraph runs with NO system Node and
# NO native build — node:sqlite is built into the bundled Node. One archive per
# platform.
#
# Because dropping better-sqlite3 left zero native addons, the recipe is pure
# file-packaging (download the target's Node, copy the app, archive) — so any
# platform's bundle can be built on any OS. No cross-compile, no native runners.
#
# Usage:
#   scripts/build-bundle.sh <target> [node-version]
#     target:        darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                  | win32-x64 | win32-arm64
#     node-version:  e.g. v24.16.0 (default below; pin for reproducible builds)
#
# Output:
#   unix:    release/codegraph-<target>.tar.gz   (launcher: bin/codegraph)
#   windows: release/codegraph-<target>.zip      (launcher: bin/codegraph.cmd)
set -euo pipefail

TARGET="${1:?usage: build-bundle.sh <target> [node-version]}"
NODE_VERSION="${2:-v24.16.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCH="${TARGET##*-}"   # x64 | arm64
OSFAM="${TARGET%-*}"   # darwin | linux | win32

echo "[bundle] target=${TARGET} node=${NODE_VERSION}"

# 1. Download + extract the official Node runtime for the target platform.
if [ "$OSFAM" = "win32" ]; then
  NODE_DIST="node-${NODE_VERSION}-win-${ARCH}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.zip"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$WORK/node.zip" -d "$WORK"
  else
    tar -xf "$WORK/node.zip" -C "$WORK"   # bsdtar can read zip
  fi
  NODE_BIN="$WORK/${NODE_DIST}/node.exe"
else
  NODE_DIST="node-${NODE_VERSION}-${TARGET}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.gz"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.tar.gz"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  NODE_BIN="$WORK/${NODE_DIST}/bin/node"
fi
[ -f "$NODE_BIN" ] || { echo "[bundle] error: node binary not found ($NODE_BIN)" >&2; exit 1; }

# 2. Build the app (compiled JS + copied wasm/schema assets).
echo "[bundle] building app"
( cd "$ROOT" && npm run build >/dev/null )

# 3. Stage: app + production-only deps (pure JS/wasm → portable across platforms).
STAGE="$WORK/codegraph-${TARGET}"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"
echo "[bundle] installing production dependencies"
( cd "$STAGE/lib" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
rm -f "$STAGE/lib/package-lock.json"

# 4. Vendored Node + launcher (the launcher uses the bundled Node by relative
#    path, so no system Node is ever needed).
if [ "$OSFAM" = "win32" ]; then
  cp "$NODE_BIN" "$STAGE/node.exe"
  printf '@"%%~dp0..\\node.exe" "%%~dp0..\\lib\\dist\\bin\\codegraph.js" %%*\r\n' \
    > "$STAGE/bin/codegraph.cmd"
else
  cp "$NODE_BIN" "$STAGE/node"
  cat > "$STAGE/bin/codegraph" <<'LAUNCH'
#!/bin/sh
# Resolve symlinks (e.g. the ~/.local/bin/codegraph link install.sh creates) so
# we find the real bundle dir, not the symlink's location.
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
exec "$DIR/node" "$DIR/lib/dist/bin/codegraph.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/codegraph"
fi

# 5. Archive (.zip for Windows, .tar.gz otherwise).
mkdir -p "$OUT"
if [ "$OSFAM" = "win32" ]; then
  ARCHIVE="$OUT/codegraph-${TARGET}.zip"
  rm -f "$ARCHIVE"
  ( cd "$WORK" && zip -rqX "$ARCHIVE" "codegraph-${TARGET}" )
else
  ARCHIVE="$OUT/codegraph-${TARGET}.tar.gz"
  # --no-xattrs: don't embed macOS xattrs that make GNU tar warn on Linux.
  tar --no-xattrs -czf "$ARCHIVE" -C "$WORK" "codegraph-${TARGET}"
fi
echo "[bundle] wrote ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
