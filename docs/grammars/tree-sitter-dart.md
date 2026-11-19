# tree-sitter-dart — provenance

The kernel's vendored C (`codegraph-kernel/grammars/dart/`) is the `src/` of
[UserNobody14/tree-sitter-dart](https://github.com/UserNobody14/tree-sitter-dart)
(MIT) at master commit `0038280b774b65c1b89ba7fec50624d8baed9fe1`
(2026-10-18, "fix(parser): require single-record type commas (#109)"),
byte for byte, and `src/extraction/wasm/tree-sitter-dart.wasm` is built from
the same files. There is no patch.

| file | sha256 (LF, as the commit has it) |
|---|---|
| `src/parser.c` | `9570f47f9912a4b169f5d959f6db06859087eb95c3f1203e312a33c12da66309` |
| `src/scanner.c` | `07a7b7818b175e9460523e705dd88d20f7b5141bac95c593d4426e6d52284996` |
| `src/tree_sitter/parser.h` | `180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2` |
| `src/tree_sitter/alloc.h` | `b29c1c9fb7cc82f58c84b376df1297d6e2737a1d655fd356db0859e3c29c2fea` |
| `src/tree_sitter/array.h` | `31e60a1bff6f715afacce03b5b70efe42b58371b4f9595dd4af52a577ff9608c` |
| `LICENSE` | `d270cb3a4985d75033bd77d875ccebff1d66e32788a3f727891e28d76132dd46` |
| `tree-sitter-dart.wasm` (built) | `69be3d03b4b1e405ce984dc4ba40704a9c50ff81e120b55144499c81986da1f8`, 1,199,200 bytes |

The commit's own `tree-sitter-dart.wasm` dates from 2024 and is not used.

## Why 0038280

It is the newest master commit (#3270). It holds upstream PR 105 (Dart 3.12
and 3.13 syntax: primary constructors in class and enum headers, their body
part `this : … { … }`, concise constructors such as `new named()` and
`factory make()`, `;` bodies) and upstream PR 109, which stops `f(a < (b), c >
.zero())` reading as a generic call; PR 106 between them changes CI only. It
also brings in what landed upstream since d4d8f3e (2025-10-04): Dart 3.10 dot
shorthands (PR 93), operator precedence (PR 102), generic method calls with one
type argument (PR 104), record return types after an annotation (PR 98), and
parses of syntax d4d8f3e failed on, such as null-aware elements, empty object
patterns and an unnamed `library;`.

What the extractors read differently because of it (both engines):

- A named constructor called with type arguments outside a statement's start,
  `Future<void>.delayed(d)`, parses as comparisons and a dot shorthand,
  `(Future < void) > .delayed(d)`, and one with two type arguments in a list of
  arguments or elements is split at their comma (upstream issue 107; its fix,
  upstream PR 110, is not merged). `dartMisparsedCtor` / `misparsed_ctor` read
  both as the call. When upstream fixes it, the recovery stops matching and can
  go.
- A generic call, `ref.read<Repo>(p)`, parses as a call where d4d8f3e often
  read two comparisons. `dartMisparsedGenericCall` still covers that shape,
  which 0038280 leaves only to a type argument list split over lines.
- `primary_constructor` (a class or enum header's), `primary_constructor_body_signature`,
  and the concise constructor forms; a `const` constructor's signature now has
  a `name` field.

## Rebuild

```
git clone https://github.com/UserNobody14/tree-sitter-dart && cd tree-sitter-dart
git checkout 0038280b774b65c1b89ba7fec50624d8baed9fe1
cp src/parser.c src/scanner.c /path/to/codegraph/codegraph-kernel/grammars/dart/
cp src/tree_sitter/*.h /path/to/codegraph/codegraph-kernel/grammars/dart/tree_sitter/
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-dart.wasm .
cp tree-sitter-dart.wasm /path/to/codegraph/src/extraction/wasm/
```

`build --wasm` compiles the checked-in `src/parser.c`; it does not regenerate
it. The wasm of 2026-11-18 was built on Windows with emsdk 4.0.4 (no Docker:
emsdk installed, `emsdk_env` sourced, then the command above). It imports
`env.iswspace`, `env.memory`, `env.__memory_base`, `env.__table_base` and
`env.__indirect_function_table`, the same set a rebuild of d4d8f3e with that
toolchain imports. The tree-sitter-wasms 0.1.13 file it replaces, built by an
older CLI, also exported the external scanner's five functions and imported
them back through `GOT.func`.

Then rebuild the kernel (`npm run build:kernel`) and run
`__tests__/kernel-grammar-parity.test.ts`, `__tests__/kernel-dart-parity.test.ts`
and `scripts/kernel-parity.mjs --lang dart --max-deferral 0.3` on a Dart repo:
the wasm and the kernel must parse the same.
