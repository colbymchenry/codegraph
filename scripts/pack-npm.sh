#!/usr/bin/env bash
#
# Assemble the npm thin-installer packages from built bundles (esbuild pattern).
#
# Produces, under release/npm/:
#   codegraph-<target>/   one per built bundle — the vendored Node + app, tagged
#                         with os/cpu so npm installs only the matching one.
#   main/                 the @colbymchenry/codegraph shim package: a tiny bin
#                         that execs the matching platform bundle, with every
#                         platform package in optionalDependencies.
#
# The release pipeline then `npm publish`es each dir. This does NOT touch the
# repo's package.json — the dev/from-source path keeps working; the *published*
# main package's shape is generated here.
#
# Prereq: run build-bundle.sh for each target first (release/codegraph-*.tar.gz).
# Usage:  scripts/pack-npm.sh [version]    (default: version from package.json)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
SCOPE="@colbymchenry"
REL="$ROOT/release"
NPM="$REL/npm"

rm -rf "$NPM"
mkdir -p "$NPM/main"

shopt -s nullglob
archives=("$REL"/codegraph-*.tar.gz "$REL"/codegraph-*.zip)
[ ${#archives[@]} -gt 0 ] || { echo "[pack-npm] no bundles in $REL — run build-bundle.sh first" >&2; exit 1; }

targets=()
for archive in "${archives[@]}"; do
  fname="$(basename "$archive")"
  case "$fname" in
    *.tar.gz) base="${fname%.tar.gz}" ;;   # codegraph-<target>
    *.zip)    base="${fname%.zip}" ;;
  esac
  target="${base#codegraph-}"             # <target>, e.g. darwin-arm64 / win32-x64
  os="${target%-*}"                       # darwin | linux | win32
  arch="${target##*-}"                    # arm64 | x64
  pkgdir="$NPM/$base"
  mkdir -p "$pkgdir"
  case "$fname" in
    *.zip)
      tmpx="$(mktemp -d)"
      unzip -q "$archive" -d "$tmpx"
      mv "$tmpx/codegraph-${target}"/* "$pkgdir"/
      rm -rf "$tmpx"
      nodefile="node.exe"
      ;;
    *)
      tar -xzf "$archive" -C "$pkgdir" --strip-components=1
      nodefile="node"
      ;;
  esac
  VERSION="$VERSION" SCOPE="$SCOPE" TARGET="$target" OSV="$os" ARCHV="$arch" NODEFILE="$nodefile" \
    node -e '
      const fs=require("fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({
        name: `${process.env.SCOPE}/codegraph-${process.env.TARGET}`,
        version: process.env.VERSION,
        description: `CodeGraph self-contained bundle for ${process.env.TARGET}`,
        os: [process.env.OSV], cpu: [process.env.ARCHV],
        files: [process.env.NODEFILE, "lib", "bin"],
        license: "MIT"
      }, null, 2) + "\n");
    ' "$pkgdir/package.json"
  targets+=("$target")
  echo "[pack-npm] ${SCOPE}/codegraph-${target}@${VERSION}"
done

# Main shim package.
cp "$ROOT/scripts/npm-shim.js" "$NPM/main/npm-shim.js"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$NPM/main/README.md"
VERSION="$VERSION" SCOPE="$SCOPE" TARGETS="${targets[*]}" \
  node -e '
    const fs=require("fs");
    const opt={};
    for (const t of process.env.TARGETS.split(/\s+/).filter(Boolean))
      opt[`${process.env.SCOPE}/codegraph-${t}`]=process.env.VERSION;
    fs.writeFileSync(process.argv[1], JSON.stringify({
      name: `${process.env.SCOPE}/codegraph`,
      version: process.env.VERSION,
      description: "Local-first code intelligence for AI agents (MCP). Self-contained — bundles its own runtime.",
      bin: { codegraph: "npm-shim.js" },
      optionalDependencies: opt,
      files: ["npm-shim.js","README.md"],
      license: "MIT"
    }, null, 2) + "\n");
  ' "$NPM/main/package.json"

echo "[pack-npm] ${SCOPE}/codegraph@${VERSION} (${#targets[@]} platform packages in optionalDependencies)"
echo "[pack-npm] output: $NPM"
