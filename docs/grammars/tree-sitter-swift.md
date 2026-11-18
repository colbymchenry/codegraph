# tree-sitter-swift — provenance & the scanner patch

The kernel's vendored C (`codegraph-kernel/grammars/swift/`) is the `src/` of
the [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift)
(MIT) **0.7.4 crates.io tarball** — the same files
`src/extraction/wasm/tree-sitter-swift.wasm` is built from (see
`docs/design/swift-kernel-port-checklist.md` §Grammar prep for why the
tarball and not the tag) — with the patch in `tree-sitter-swift.patch`
applied to `src/scanner.c`. Both the kernel's copy and the wasm are built from
the patched scanner.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `src/parser.c` | `1d332e60ec28e6b398db36e06bf05414061dfbbd3e981b33ff1edfd5159e3e08` | unchanged |
| `src/scanner.c` | `b0abca0bb8d9e34da210ef0fac14f67c4fb40cb2625c4e51bd42ea80ac59d1b1` | `2b78cad2a49da126388acfa67fdac585226f89cd2feaf4326e98289bc253bf87` |

(sha256 of the files as the tarball ships them, LF line endings.)

## Why 0.7.4

0.7.3 read the `{` that opens the body of `if try await f() {` (and
`while try await …`, `if let v = try await f(x) {`) as a trailing closure on
`f`, so the condition became an `ERROR` node (#3212): a method's range could
run past its own closing brace, the next member of its type was indexed as a
local function, and calls were recorded under names made of source text.
Upstream fixed it in commit `28fe3a8a85` ("Fix `if let x = try await f() { ...
}` parsing the block as a trailing closure"), released in 0.7.4. 0.7.4 also
writes `1ULL << FAKE_TRY_BANG` in the scanner, the fix the previous patch here
carried for MSVC (where `1UL << 32` folded to 0 and `try!` lost its `!`).

What else 0.7.4 changes that the extractor reads: `nil` is a named
`nil_literal` node (a literal receiver, as `nil` was), and Swift 6.2's strict
memory safety adds an `unsafe` expression wrapper (`unsafe_expression`, a
call wrapper like `try` and `await`). Both engines handle them.

## What the patch fixes

0.7.4's `tree_sitter_swift_external_scanner_create` reports a failed `calloc`
with `fprintf(stderr, …)` and `exit(1)`. A wasm parser has no stdio, and
tree-sitter-cli refuses to build a scanner that imports `fwrite`, `exit` or
`stderr`. The patch returns `calloc`'s result, as 0.7.3 did. The kernel's
copy carries the same patch so that both are built from one scanner.

## Rebuild

```
curl -sL https://crates.io/api/v1/crates/tree-sitter-swift/0.7.4/download -o ts-swift-0.7.4.crate
tar xzf ts-swift-0.7.4.crate && cd tree-sitter-swift-0.7.4
git apply /path/to/codegraph/docs/grammars/tree-sitter-swift.patch
cp src/parser.c src/scanner.c /path/to/codegraph/codegraph-kernel/grammars/swift/
cp src/tree_sitter/*.h /path/to/codegraph/codegraph-kernel/grammars/swift/tree_sitter/
# The crate tarball has no tree-sitter.json (metadata only, no effect on the
# tables): write one naming the grammar `swift`, then
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-swift.wasm .
cp tree-sitter-swift.wasm /path/to/codegraph/src/extraction/wasm/
```

Then rebuild the kernel (`npm run build:kernel`) and run
`__tests__/kernel-grammar-parity.test.ts` and `scripts/kernel-parity.mjs
--lang swift --max-deferral 0.3` on a Swift repo: the wasm and the kernel must
parse the same. The wasm of 2026-11-17 was built on Windows with emsdk 4.0.4;
a rebuild of the 0.7.3 tarball with that toolchain parsed all 597 Swift files
of Alamofire, SnapKit, Kingfisher and vapor to the same trees as the wasm it
replaces.
