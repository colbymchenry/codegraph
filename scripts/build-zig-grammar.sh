#!/usr/bin/env bash
# Rebuild the vendored Zig grammar without installing or upgrading tools.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="${TREE_SITTER_CLI:-tree-sitter}"
ZIG="${ZIG_COMPILER:-zig}"
OUTPUT="${1:-$ROOT/src/extraction/wasm/tree-sitter-zig.wasm}"
[[ "$("$TS" --version)" == 'tree-sitter 0.27.0' ]] || { echo 'Requires tree-sitter-cli 0.27.0' >&2; exit 1; }
[[ "$("$ZIG" version)" == '0.16.0' ]] || { echo 'Requires Zig 0.16.0' >&2; exit 1; }
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codegraph-zig-grammar.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
curl --fail --silent --show-error --location \
  'https://registry.npmjs.org/@tree-sitter-grammars/tree-sitter-zig/-/tree-sitter-zig-1.1.2.tgz' \
  --output "$BUILD_DIR/source.tgz"
node - "$BUILD_DIR/source.tgz" <<'JS'
const fs = require('node:fs'), crypto = require('node:crypto');
const actual = crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');
if (actual !== '2512a88611e400dbafb9cb79b247c7f2671ed034e1714b33df29712ee93e534c') {
  throw new Error('Zig grammar source archive checksum mismatch');
}
JS
tar -xzf "$BUILD_DIR/source.tgz" -C "$BUILD_DIR" \
  package/grammar.js package/tree-sitter.json package/LICENSE
cd "$BUILD_DIR/package"
patch -p1 < "$ROOT/scripts/grammars/zig-empty-containers.patch"
"$TS" generate --abi 15
"$ZIG" cc -target wasm32-wasi -Os -shared -fPIC -fno-exceptions \
  -Wl,--no-entry -Wl,--export=tree_sitter_zig -I src src/parser.c \
  -o "$BUILD_DIR/tree-sitter-zig.wasm"
# Verify the module through the same runtime used by extraction before copying.
printf 'const Empty = struct {};\npub fn run() void {}\n' > "$BUILD_DIR/sample.zig"
cd "$ROOT"
node --liftoff-only scripts/add-lang/check-grammar.mjs \
  "$BUILD_DIR/tree-sitter-zig.wasm" "$BUILD_DIR/sample.zig" 100
cp "$BUILD_DIR/tree-sitter-zig.wasm" "$OUTPUT"
echo "Wrote $OUTPUT"
