#!/usr/bin/env bash
#
# Build the native extraction kernel (codegraph-kernel) and stage the .node
# where the TS loader (src/extraction/kernel/loader.ts) finds it for
# from-source runs and tests:
#
#   codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node
#
# The kernel is OPTIONAL everywhere: when the .node is absent the extraction
# path falls back to the wasm pipeline. This script needs a Rust toolchain
# (rustup.rs); nothing else in the repo does.
#
# Usage:
#   scripts/build-kernel.sh                 # host platform
#   scripts/build-kernel.sh --target <rust-triple> [--platform <plat-arch>]
#
# The cross-compile form is what the release workflow uses (e.g.
# --target x86_64-apple-darwin --platform darwin-x64 on a macos-arm runner).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/codegraph-kernel"

TARGET=""
PLATFORM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target)   TARGET="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Map a rust triple (or the host) to the bundle-target naming used across the
# release pipeline (darwin-arm64, linux-x64, win32-arm64, ...).
if [ -z "$PLATFORM" ]; then
  if [ -n "$TARGET" ]; then
    case "$TARGET" in
      aarch64-apple-darwin)         PLATFORM="darwin-arm64" ;;
      x86_64-apple-darwin)          PLATFORM="darwin-x64" ;;
      x86_64-unknown-linux-gnu)     PLATFORM="linux-x64" ;;
      aarch64-unknown-linux-gnu)    PLATFORM="linux-arm64" ;;
      x86_64-pc-windows-msvc)       PLATFORM="win32-x64" ;;
      aarch64-pc-windows-msvc)      PLATFORM="win32-arm64" ;;
      *) echo "cannot map rust target '$TARGET' to a platform name; pass --platform" >&2; exit 1 ;;
    esac
  else
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64)  PLATFORM="darwin-arm64" ;;
      Darwin-x86_64) PLATFORM="darwin-x64" ;;
      Linux-x86_64)  PLATFORM="linux-x64" ;;
      Linux-aarch64) PLATFORM="linux-arm64" ;;
      MINGW*-x86_64|MSYS*-x86_64)   PLATFORM="win32-x64" ;;
      MINGW*-aarch64|MSYS*-aarch64) PLATFORM="win32-arm64" ;;
      *) echo "unrecognized host $(uname -s)-$(uname -m); pass --platform" >&2; exit 1 ;;
    esac
  fi
fi

echo "[kernel] building codegraph-kernel for ${PLATFORM}${TARGET:+ (target $TARGET)}"
cd "$CRATE"
if [ -n "$TARGET" ]; then
  rustup target add "$TARGET" >/dev/null 2>&1 || true
  cargo build --release --target "$TARGET"
  OUTDIR="$CRATE/target/$TARGET/release"
else
  cargo build --release
  OUTDIR="$CRATE/target/release"
fi

# cdylib name differs per OS; the staged name is always codegraph-kernel.node.
case "$PLATFORM" in
  darwin-*) LIB="$OUTDIR/libcodegraph_kernel.dylib" ;;
  linux-*)  LIB="$OUTDIR/libcodegraph_kernel.so" ;;
  win32-*)  LIB="$OUTDIR/codegraph_kernel.dll" ;;
esac
[ -f "$LIB" ] || { echo "[kernel] error: built library not found at $LIB" >&2; exit 1; }

DEST="$CRATE/prebuilds/$PLATFORM"
mkdir -p "$DEST"
cp "$LIB" "$DEST/codegraph-kernel.node"
echo "[kernel] staged $DEST/codegraph-kernel.node ($(du -h "$DEST/codegraph-kernel.node" | cut -f1))"
