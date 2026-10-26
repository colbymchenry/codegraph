# tree-sitter-kotlin.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-kotlin.wasm` and the kernel's vendored C
(`codegraph-kernel/grammars/kotlin/`) are both built from
[fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin) (MIT)
tag `0.3.8` (commit `e1a2d5ad1f61f5740677183cd4125bb071cd2f30`), from the
tag's checked-in `src/parser.c` — never `tree-sitter generate` — with the
patch in `tree-sitter-kotlin.patch` applied to `src/scanner.c`.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `src/parser.c` | `54104a7ef1555c265b746c790e0f8bb953cc17806e9df0c3af82f7f62c06a70a` | unchanged |
| `src/scanner.c` | `27f73337ec357fc341fa57538f34c14277b0346980c3405dc30beab6202ec6d0` | `2ca842dd04b60b0a6df59a03e9ad01209d8c5641f079a79a84d65708669b6cb6` |
| `tree-sitter-kotlin.wasm` | `c80c88867a589a1a0959bcea89de84b7e9684b3693b2cdb2944812458e62ff48` | `e2ef7c0c83e5fd4bece547d2acd41b9f89da2fed5644d74be139b9765d4c74af` |

## What the patch fixes

The external scanner decides where to insert an automatic semicolon. On the
same line as the end of an expression it inserted one before any word
starting with `e` that was not `else` — so an infix call with such a name
(Exposed's `Users.id eq id1`, used in nearly every Exposed query) ended the
statement early and the rest became a parse error. On a file with many of
them, error recovery could swallow the whole class: Exposed's r2dbc
`UpsertTests` came out as one loose function nesting every test.

On the same line nothing but `;` or `import` starts a new statement, so the
patched scanner inserts no semicolon before any `e` word. Measured on
Exposed, files with a parse error went from 229 to 71 of 1,004; koin,
nowinandroid, moshi, okio, okhttp and kotlinx.coroutines parsed exactly as
before (one okhttp file fixed, none broken).

## Rebuild

```
git clone --depth 1 --branch 0.3.8 https://github.com/fwcd/tree-sitter-kotlin
cd tree-sitter-kotlin
git apply /path/to/codegraph/docs/grammars/tree-sitter-kotlin.patch
# the 0.3.8 tag predates tree-sitter.json, which cli 0.25.10 requires —
# add the METADATA-ONLY shim (grammar name/scope; nothing regenerated):
#   {"grammars":[{"name":"kotlin","scope":"source.kotlin","path":".",
#     "file-types":["kt","kts"]}],"metadata":{"version":"0.3.8","license":"MIT"}}
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-kotlin.wasm .
cp src/scanner.c /path/to/codegraph/codegraph-kernel/grammars/kotlin/scanner.c
```

Built without the patch, the same command reproduces the upstream wasm above
byte for byte. After updating either side, rebuild the kernel
(`npm run build:kernel`) and check `scripts/kernel-parity.mjs` on a Kotlin
repo: the wasm and the kernel must parse the same.
