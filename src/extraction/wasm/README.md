# Vendored tree-sitter grammar wasm builds

Grammars in this directory are vendored because `tree-sitter-wasms` either
doesn't ship them or ships a build with an ABI too old for our `web-tree-sitter`
(old-ABI wasms corrupt the shared WASM heap — see the Lua note in
`../grammars.ts`). Every vendored grammar must be listed in the vendored-path
branch of `loadGrammarsForLanguages` in `../grammars.ts`, and `copy-assets`
(run by `npm run build`) ships `*.wasm` from here into `dist/`.

**Reproducibility:** each entry below records the exact source commit,
toolchain, and command used to produce the binary. When bumping a grammar,
verify it with `node scripts/add-lang/check-grammar.mjs <wasm-path> <sample>`
(ABI print + repeated-parse heap-corruption check) and update its entry.

## tree-sitter-clojure.wasm

- **Source:** https://github.com/sogaiu/tree-sitter-clojure
  commit `e43eff80d17cf34852dcd92ca5e6986d23a7040f` (master, 2025-08-26)
- **ABI:** 14
- **Toolchain:** tree-sitter CLI `0.26.9` (`npx --yes tree-sitter-cli`), which
  downloads its own wasi-sdk; no Docker/emscripten required
- **Command:**
  ```bash
  git clone https://github.com/sogaiu/tree-sitter-clojure
  cd tree-sitter-clojure && git checkout e43eff80d17cf34852dcd92ca5e6986d23a7040f
  npx --yes tree-sitter-cli build --wasm   # → tree-sitter-clojure.wasm
  ```
- **Why vendored:** no Clojure grammar in `tree-sitter-wasms`, and upstream
  publishes no prebuilt wasm (the npm `tree-sitter-clojure` package is the
  unmaintained oakmac grammar at ABI 9, which doesn't load in modern
  web-tree-sitter).

## tree-sitter-pascal.wasm · tree-sitter-scala.wasm · tree-sitter-lua.wasm · tree-sitter-luau.wasm

Vendored before this README existed; provenance not recorded at the time.
Lua is the upstream ABI-15 build (the `tree-sitter-wasms` Lua is ABI 13 and
fails the heap-corruption check — see `../grammars.ts`). When any of these is
next bumped, record its full recipe here in the format above.
