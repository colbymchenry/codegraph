# tree-sitter-swift — provenance & the kernel's scanner patch

The kernel's vendored C (`codegraph-kernel/grammars/swift/`) is the `src/` of
the [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift)
(MIT) **0.7.3 crates.io tarball** — the same files
`src/extraction/wasm/tree-sitter-swift.wasm` is built from (see
`docs/design/swift-kernel-port-checklist.md` §Grammar prep for why the
tarball and not the tag) — with the patch in `tree-sitter-swift.patch`
applied to `src/scanner.c`. The wasm is built from the unpatched tarball.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `src/parser.c` | `d3edff6effe31b9a507f496577407987343b101b23eb7bee7a9b050e8ab5d27a` | unchanged |
| `src/scanner.c` | `f3d6271d64f58c39eed544104a70ca2cf9ecbf80c5d900620f1afd38836542cb` | `8acafef098ea4a52ebfc4cdf2fe26706113a22ac8ba2faf7d952755ff350cad6` |

## What the patch fixes

The external scanner produces its own `!` token, and steps aside for a `!`
written straight after `try` so the parser can read `try!`. It finds those
positions through a 64-bit mask whose entry for `!` is built as
`1UL << FAKE_TRY_BANG`, bit 32. Where `unsigned long` is 32 bits that shift
overflows, and each compiler folds it differently:

- **MSVC** — both Windows kernels (`x86_64`/`aarch64-pc-windows-msvc`) — folds
  it to 0 (warning C4293). The scanner never steps aside, so
  `try! Message2(data: d)` parsed as `try` followed by a call of `!Message2`:
  the call was named `! Message2` and linked nothing, and a call through a
  type, `try! Settings.Defaults.load()`, lost its receiver.
- **clang for wasm32** (the wasm) folds it to bit 31, `_directive_endif`,
  which is valid at every expression start — right after `try` too — so the
  wasm reads `try!` correctly. Its one other effect: a prefix `!` at an
  expression start is lexed by the parser's own lexer, which leaves an
  anonymous `!` token under `bang` where the scanner's token is hidden. No
  walker reads it.
- **macOS and Linux** kernels (64-bit `unsigned long`) were always correct.

The patch is upstream 0.7.4's one-line fix, `1ULL`. Measured on 2026-10-09
over 1,172 Swift files (Alamofire, SDWebImage, protobuf, realm-swift,
swift-nio, vapor and six smaller projects): the patched native build parses
every error-free file to the same tree as the wasm, apart from that anonymous
`!`. The 8 files that differ have parse errors on both, and the kernel defers
a file with parse errors to the wasm. The unpatched MSVC build misparsed 157
error-free files, every one at a `try!`.

## Rebuild

```
curl -sL https://crates.io/api/v1/crates/tree-sitter-swift/0.7.3/download -o ts-swift-0.7.3.crate
tar xzf ts-swift-0.7.3.crate && cd tree-sitter-swift-0.7.3
git apply /path/to/codegraph/docs/grammars/tree-sitter-swift.patch
cp src/parser.c src/scanner.c /path/to/codegraph/codegraph-kernel/grammars/swift/
cp src/tree_sitter/*.h /path/to/codegraph/codegraph-kernel/grammars/swift/tree_sitter/
```

Then rebuild the kernel (`npm run build:kernel`) and run
`__tests__/kernel-grammar-parity.test.ts` and `scripts/kernel-parity.mjs
--lang swift` on a Swift repo: the wasm and the kernel must parse the same.
A bump to a release that carries the fix (0.7.4 or later) can drop the patch
and the vendored copy: pin the crate in `codegraph-kernel/Cargo.toml` again
and rebuild the wasm from the same tarball, together.
