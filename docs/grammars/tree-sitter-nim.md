# tree-sitter-nim.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-nim.wasm` is built from
[alaviss/tree-sitter-nim](https://github.com/alaviss/tree-sitter-nim) (MPL-2.0),
commit `ac72ba30d16edf0be021588a9301ede4accd6cf4` (2026-07-03).

Nim is **not** shipped by `tree-sitter-wasms` (0.1.13 carries 36 grammars and
none of them is nim), so the grammar is vendored: `nim` is listed in
`VENDORED_WASM_LANGS` in `src/extraction/grammars.ts` and `resolveWasmPath`
takes the `dist/extraction/wasm/` branch. (An `out/nim/tree-sitter-nim.wasm`
does exist in the third-party `tree-sitter-wasm@2.0.4` package — ABI 15 — and it
parses correctly, but it was rejected in favour of a build we can pin and
reproduce from the upstream commit.)

Built from the commit's **checked-in `src/parser.c`** — never
`tree-sitter generate` — so the tables are the revision's own. The external
scanner needs no patch, so both C sources are byte-identical upstream and
vendored.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `src/parser.c` | `810c6891bfd3ac5e45380cb673b7c490c5f1f7b749a8d27766d788bce5713b20` | unchanged |
| `src/scanner.c` | `0d3fb9955a3fe49f89037890bc4154f0862a6959338a0d9ef5e79bcb7e7e2892` | unchanged |
| `tree-sitter-nim.wasm` | — | `1fb6ed496b64dab14c7837e06b40459c70776a78d05e7a3e35a6271c962431f1` |

The wasm is **ABI 14** (the revision's `parser.c` was generated with
tree-sitter 0.25.6; `package.json` builds with `--abi=14`), 5,822,542 bytes.
ABI 14 is deliberate and fine here: `web-tree-sitter` 0.25 supports 13–15, and
the kotlin re-vendor likewise stayed at ABI 14.

## Rebuild

```
git clone --depth 1 https://github.com/alaviss/tree-sitter-nim
cd tree-sitter-nim
git checkout ac72ba30d16edf0be021588a9301ede4accd6cf4
tree-sitter build --wasm -o tree-sitter-nim.wasm .
cp tree-sitter-nim.wasm /path/to/codegraph/src/extraction/wasm/
```

- `tree-sitter-cli` **0.26.x** (`tree-sitter 0.26.12` was used). No emscripten
  and no Docker: the CLI downloads a **wasi-sdk** toolchain on the first
  `build --wasm` and caches it at `~/.cache/tree-sitter/wasi-sdk/` (~390 MB), so
  the first rebuild needs network access and later ones do not.
- The commit ships a `tree-sitter.json`, so no metadata shim is needed — unlike
  `tree-sitter-kotlin.md`, where the 0.3.8 tag predates it and cli 0.25.10
  requires one.
- Nim is **not** kernel-ported (`codegraph-kernel/src/langs.rs`), so there is no
  kernel↔wasm parity obligation yet. If it is ever ported, the crate must compile
  this same revision — that is the rule the `VENDORED_WASM_LANGS` comment gives
  for ts/js/java/python/go/c/cpp/rust/ruby/php/swift/kotlin/dart.

## Verification

`node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-nim.wasm <sample>.nim`
— the gate that catches a grammar corrupting the shared WASM heap:

```
grammar: tree-sitter-nim.wasm
  ABI version: 14
  parses: 20 clean / 0 with errors (of 20)
RESULT: PASS — grammar parses cleanly and reuses safely.
```

Beyond the gate, the same probe on two real files (12 parses each, decoy grammar
loaded first so the heap is the multi-grammar one real indexing uses) reports no
ERROR trees and **no degradation across iterations** — the Lua failure mode:

| file | lines | error parses |
|---|---|---|
| `lib/pure/json.nim` (nim-lang/Nim) | 1,398 | 0 / 12 |
| `compiler/semexprs.nim` (nim-lang/Nim) | 3,743 | 0 / 12 |

`compiler/semexprs.nim` is the interesting one: macros, templates, pragmas,
generics and converters all over it — the constructs that break a thin grammar.
