# Python grammar

Native and WASM use tree-sitter-python v0.23.6 (bffb65a). The checked-in
`codegraph-kernel/grammars/python` parser tables are unchanged from that release.
Its scanner stops looking through indented comments once neither INDENT nor
DEDENT can be emitted. Both backends must use that scanner.

To rebuild the WASM with Emscripten 4.0.8 on PATH and tree-sitter-cli 0.25.10:

```sh
git clone --depth 1 --branch v0.23.6 https://github.com/tree-sitter/tree-sitter-python /tmp/codegraph-python-grammar
cp codegraph-kernel/grammars/python/{parser.c,scanner.c} /tmp/codegraph-python-grammar/src/
cp codegraph-kernel/grammars/python/tree_sitter/*.h /tmp/codegraph-python-grammar/src/tree_sitter/
npx --yes tree-sitter-cli@0.25.10 build --wasm -o src/extraction/wasm/tree-sitter-python.wasm /tmp/codegraph-python-grammar
```

Do not regenerate parser tables. Run `kernel-wide-comments.test.ts`,
`kernel-grammar-parity.test.ts`, and `kernel-tsjs-parity.test.ts` after rebuilding.
The wide-comment checks exercise native and forced-WASM extraction in bounded
child processes and verify documentation, symbols and references.
