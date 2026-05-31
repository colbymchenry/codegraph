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
        main: "lib/dist/index.js",
        types: "lib/dist/index.d.ts",
        exports: {
          ".": {
            types: "./lib/dist/index.d.ts",
            default: "./lib/dist/index.js"
          }
        },
        os: [process.env.OSV], cpu: [process.env.ARCHV],
        files: [process.env.NODEFILE, "lib", "bin"],
        license: "MIT"
      }, null, 2) + "\n");
    ' "$pkgdir/package.json"
  targets+=("$target")
  echo "[pack-npm] ${SCOPE}/codegraph-${target}@${VERSION}"
done

# Copy type declarations from the first platform bundle into the main shim so
# consumers can `import type { ... } from "@colbymchenry/codegraph"` without
# hard-coding a platform-specific package path.
first_pkgdir="$NPM/codegraph-${targets[0]}"
if [ -d "$first_pkgdir/lib/dist" ]; then
  mkdir -p "$NPM/main/lib/dist"
  # copy only declaration files (no runtime JS — the shim execs the binary)
  find "$first_pkgdir/lib/dist" -type f \( -name '*.d.ts' -o -name '*.d.ts.map' \) -print0 | while IFS= read -r -d '' f; do
    rel="${f#$first_pkgdir/lib/dist/}"
    mkdir -p "$NPM/main/lib/dist/$(dirname "$rel")"
    cp "$f" "$NPM/main/lib/dist/$rel"
  done
fi
if [ ! -f "$NPM/main/lib/dist/index.d.ts" ]; then
  echo "[pack-npm] error: type declarations missing from main shim" >&2
  exit 1
fi

# Runtime proxy so consumers can `require()` or dynamically `import()`
# `@colbymchenry/codegraph` without hard-coding a platform-specific package
# path. Named imports (e.g. `import { CodeGraph }`) work under Node.js native
# ESM interop but may require bundler-specific configuration in Vite/Rollup.
cat > "$NPM/main/index.js" <<'PROXY'
// Auto-generated runtime proxy — forwards to the platform-specific bundle.
const pkg = require('./package.json');
const scope = pkg.name.split('/')[0];
const target = process.platform + '-' + process.arch;
const depName = scope + '/codegraph-' + target;
try {
  module.exports = require(depName);
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  const e = new Error(
    'No prebuilt CodeGraph bundle for ' + target + '.\n' +
    'Expected the optional package ' + depName + ' to be installed.\n' +
    'Try reinstalling:  npm i ' + pkg.name + '\n' +
    'Or use the standalone installer (no Node required):\n' +
    '  curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh'
  );
  e.code = 'CODEGRAPH_PLATFORM_MISSING';
  throw e;
}
PROXY

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
      main: "index.js",
      types: "lib/dist/index.d.ts",
      exports: {
        ".": {
          types: "./lib/dist/index.d.ts",
          require: "./index.js",
          default: "./index.js"
        }
      },
      bin: { codegraph: "npm-shim.js" },
      optionalDependencies: opt,
      files: ["index.js","npm-shim.js","README.md","lib"],
      license: "MIT"
    }, null, 2) + "\n");
  ' "$NPM/main/package.json"

echo "[pack-npm] ${SCOPE}/codegraph@${VERSION} (${#targets[@]} platform packages in optionalDependencies)"
echo "[pack-npm] output: $NPM"
