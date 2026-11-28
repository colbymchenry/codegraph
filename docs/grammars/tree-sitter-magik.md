# tree-sitter-magik.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-magik.wasm` is built from
[krn-robin/tree-sitter-magik](https://github.com/krn-robin/tree-sitter-magik)
(MIT, `Copyright (c) 2023 krn-robin`; package version `0.0.1`) at commit
`1718f3ac23354447897ad3c9587a32c9847526b5` ("Restrict allowed patterns for
character (#103)"), from that commit's checked-in `src/parser.c` — never
`tree-sitter generate`. **No patch is applied.** The grammar has no external
scanner, so `src/parser.c` is the only C source.

`src/` and `grammar.js` are unchanged from that commit through upstream
`main` at `2ccff2474031ce6e9ce3f94b021ff705a2ce880c`. Every later commit only
bumps CI and dev dependencies.

| file | sha256 |
|---|---|
| `grammar.js` | `eb9b8dc34c7a1b8bf53ecbf2cf9bd7d3f98b8dc6bbbd37df643407da40348c30` |
| `src/parser.c` | `b44ae84082a80864530ec1667132137babfb13af81effaf93134f85cf44c5951` |
| `tree-sitter-magik.wasm` (vendored) | `3e88fb6f9b5e760fa3aedaacad7942cca3ddfa6c7f2283b028d7de14716a3da9` |

The vendored wasm is ABI 15 with 1,988 parse states and 230 symbols. Those are
the `STATE_COUNT` and `SYMBOL_COUNT` of that `parser.c`, and its symbol-name
table matches `ts_symbol_names` entry for entry. Its `producers` section names
`clang 21.1.4-wasi-sdk`, the toolchain the tree-sitter CLI downloads for
`build --wasm`.

## Why this commit

This is upstream PR #103, the fix for character literals. Before it, the text
after `%` was lexed as a full Magik identifier, which includes the
`|…|`-quoted form. So the literal `%|` opened a quoted identifier that ran to
the next `|` in the file and swallowed the code in between. Now a character
literal is a letter-led name (`%space`, `%newline`) or exactly one character.
The first wasm proposed for codegraph was built from a local checkout before
#103 merged. This one is built from upstream after the merge, so no local
change is needed.

## Rebuild

```bash
git clone https://github.com/krn-robin/tree-sitter-magik
cd tree-sitter-magik
git checkout 1718f3ac23354447897ad3c9587a32c9847526b5
sha256sum src/parser.c   # b44ae840…c5951, as above
# compiles the checked-in src/parser.c; nothing is regenerated. The CLI
# downloads wasi-sdk itself (no emscripten or Docker needed).
npx -y tree-sitter-cli@0.26.11 build --wasm -o tree-sitter-magik.wasm .
cp tree-sitter-magik.wasm /path/to/codegraph/src/extraction/wasm/
node /path/to/codegraph/scripts/add-lang/check-grammar.mjs \
  /path/to/codegraph/src/extraction/wasm/tree-sitter-magik.wasm sample.magik
```

`0.26.11` is the `tree-sitter-cli` version that upstream's `package-lock.json`
pins at this commit. A rebuild with another CLI or wasi-sdk version can differ
in bytes but not in the parse tables, because `parser.c` fixes them. Compare
the rebuilt wasm's state and symbol counts with the ones above.
