#!/bin/sh
#
# CodeGraph standalone installer.
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools, no npm required — ideal for a
# fresh Linux VPS over SSH.
#
#   curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
#
# Upgrade:   run `codegraph upgrade` (or just re-run the same command).
# Uninstall: curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Environment:
#   CODEGRAPH_VERSION      release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR  bundle location   (default: ~/.codegraph)
#   CODEGRAPH_BIN_DIR      symlink location  (default: ~/.local/bin)
set -eu

REPO="colbymchenry/codegraph"
INSTALL_DIR="${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}"
BIN_DIR="${CODEGRAPH_BIN_DIR:-$HOME/.local/bin}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/codegraph"
  rm -rf "$INSTALL_DIR"
  echo "CodeGraph uninstalled (removed $INSTALL_DIR and $BIN_DIR/codegraph)."
  exit 0
fi

# 1. Detect platform → target triple matching the release archives.
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "codegraph: unsupported OS '$os'." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "codegraph: unsupported architecture '$arch'." >&2; exit 1 ;;
esac
target="${os}-${arch}"

# 2. Resolve the version (latest release unless pinned).
#
# Resolve "latest" from the releases/latest *web* redirect, not the GitHub API:
# the unauthenticated API is rate-limited to 60 requests/hour per IP and returns
# 403 once exhausted — routine on shared/cloud hosts and CI (issue #325). The
# redirect (github.com/<repo>/releases/latest -> .../releases/tag/vX.Y.Z) has no
# such limit. Fall back to the API if the redirect can't be read.
version="${CODEGRAPH_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
    | sed -n 's#.*/releases/tag/##p')"
fi
if [ -z "$version" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$version" ] || { echo "codegraph: could not resolve latest version; set CODEGRAPH_VERSION (e.g. CODEGRAPH_VERSION=v0.9.4)." >&2; exit 1; }
# Release tags are vX.Y.Z; accept a bare X.Y.Z in CODEGRAPH_VERSION too.
case "$version" in v*) ;; *) version="v$version" ;; esac

# 3. Download + extract the bundle.
url="https://github.com/$REPO/releases/download/$version/codegraph-${target}.tar.gz"
echo "Installing CodeGraph $version ($target)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/cg.tar.gz" || { echo "codegraph: download failed: $url" >&2; exit 1; }

dest="$INSTALL_DIR/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
# Archives contain a top-level codegraph-<target>/ dir; strip it.
tar -xzf "$tmp/cg.tar.gz" -C "$dest" --strip-components=1

# 4. Symlink the launcher onto PATH and mark the current version.
mkdir -p "$BIN_DIR"
ln -sf "$dest/bin/codegraph" "$BIN_DIR/codegraph"
ln -sfn "$dest" "$INSTALL_DIR/current"

echo "Installed to $dest"
echo "Linked     $BIN_DIR/codegraph"

# 5. PATH sanity. Two ways this install can fail to be the codegraph that runs:
#   1. $BIN_DIR isn't on PATH at all.
#   2. A *different* codegraph sits earlier on PATH and shadows ours — most
#      often a stale `npm i -g @colbymchenry/codegraph`, whose launcher keeps
#      running its own version-pinned bundle, so `codegraph --version` disagrees
#      with what we just installed (issue #1071).
# Walk PATH once: note whether $BIN_DIR is present and which codegraph wins.
on_path=0
winner=""
oldifs="$IFS"; IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  if [ "$dir" = "$BIN_DIR" ]; then on_path=1; fi
  if [ -z "$winner" ] && [ -x "$dir/codegraph" ] && [ ! -d "$dir/codegraph" ]; then
    winner="$dir/codegraph"
  fi
done
IFS="$oldifs"

if [ "$on_path" -eq 0 ]; then
  echo ""
  echo "$BIN_DIR is not on your PATH. Add it:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
elif [ -n "$winner" ] && [ "$winner" != "$BIN_DIR/codegraph" ]; then
  echo ""
  echo "Warning: another codegraph is earlier on your PATH and will run instead:"
  echo "  $winner"
  echo "  (this install: $BIN_DIR/codegraph)"
  echo "If 'codegraph --version' shows an unexpected version, remove the other copy"
  echo "(e.g. 'npm rm -g @colbymchenry/codegraph') or put $BIN_DIR first on PATH."
fi

echo ""
echo "Done. Run: codegraph --help"
