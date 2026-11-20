# tree-sitter-fsharp.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-fsharp.wasm` is the `fsharp` grammar of
[ionide/tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp), the
maintained fork of `microsoft/tree-sitter-fsharp`, built unmodified — no patch.

| | |
|---|---|
| Source | https://github.com/ionide/tree-sitter-fsharp |
| Version | tag `0.3.12`, commit `aefd0c8741bdf3aeb827a228aa4a996a6536697e` (2026-09-12) |
| License | MIT — `Copyright (c) 2023 Nikolaj Sidorenco` (the repository's `LICENSE`) |
| Grammar | `fsharp/` (the repository's `tree-sitter.json` lists `fsharp` and `fsharp_signature`; only `fsharp` is built) |
| Toolchain | `tree-sitter-cli` 0.27.0, the version the tag's `package-lock.json` pins; `build --wasm` fetches its own wasi-sdk clang and binaryen `wasm-opt` (version_132) |
| ABI | 15 |
| `wasm` SHA-256 | `ff1a927387fec25e184d120d9e18ec7cd5271b30f6380f02d494d3548a99f7b7` (11,430,318 bytes) |

Input sources at that commit:

| file | sha256 |
|---|---|
| `fsharp/src/parser.c` | `c1818692b883636a992d7648023c29cda96d3af0ebe798bca6b7ec6d31b9f45c` |
| `fsharp/src/scanner.c` | `4e53e98f5f32715abf2ecee72f4ad9cee23fe040e0930215b196aed1a5956646` |
| `common/scanner.h` | `5e14db207730d34e7f054df0afbb294f8798c9b8214734df025b239ef41e7592` |

The checked-in `parser.c` is what `tree-sitter generate` writes from
`fsharp/grammar.js` with the same CLI (regenerated and compared, byte for
byte), and the build below reproduces the vendored wasm byte for byte on
Linux x86_64. It is the same binary the release attaches as
`tree-sitter-fsharp.wasm`, built by the tag's `publish.yml` with the same
command.

`tree-sitter-wasms` ships no F# grammar, so there is nothing to resolve it from
at install time; the file has to live in the repository like the other vendored
grammars.

The file is large (11.4 MB) because the F# parser tables are. It is loaded only
for a project that has F# in it: a `.fsx` file, or a `.fs` file whose head is
F# (see "Telling F# from GLSL and Forth" below).

The tag also has a `fsharp_signature` grammar (2.7 MB) for `.fsi` signature
files; it is not vendored. The main grammar mis-parses `val` declarations, so
`.fsi` files are not indexed — every symbol they declare is in the `.fs` anyway.

## Rebuild / update

```bash
git clone https://github.com/ionide/tree-sitter-fsharp
cd tree-sitter-fsharp
git checkout aefd0c8741bdf3aeb827a228aa4a996a6536697e   # tag 0.3.12
npm install --no-save tree-sitter-cli@0.27.0
# optional: regenerate parser.c from grammar.js (the result equals the checked-in one)
(cd fsharp && npx tree-sitter generate)
npx tree-sitter build --wasm fsharp      # writes ./tree-sitter-fsharp.wasm
sha256sum tree-sitter-fsharp.wasm        # ff1a9273…f7b7 for 0.3.12
cp tree-sitter-fsharp.wasm path/to/codegraph/src/extraction/wasm/
```

No emscripten or Docker is needed: tree-sitter-cli 0.26+ downloads wasi-sdk
into `~/.cache/tree-sitter` on first use.

To move to a newer release, check out its tag, use the `tree-sitter-cli`
version its `package-lock.json` pins, rebuild, update the table above and run
the health check:

```bash
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-fsharp.wasm <sample.fs>
```

(0.3.12 parses 20 of 20 runs clean in the shared multi-grammar runtime.) Then
run the F# suites: `npx vitest run __tests__/extraction.test.ts -t "F#"`,
`__tests__/fsharp-scope.test.ts` and `__tests__/fsharp-lexical-scope.test.ts`.

## Telling F# from GLSL and Forth

`.fs` is also the usual extension for GLSL fragment shaders (`shader.vs` /
`shader.fs`) and for Forth. A `.fs` file is still discovered by its extension,
like any other, but where its bytes are read for indexing, the first 32 KB are
checked (`isForeignToExtension`, the same gate that skips an MPEG transport
stream named `.ts`, #1910): a file that does not read as F# is skipped —
counted as skipped, never stored, never parsed — and an indexed F# file that
turns into one is dropped on the next sync. Discovery opens no file. The
grammar preload reads `.fs` heads only up to the first F# file, so a shader or
Forth repository never loads the 11.4 MB grammar. `.fsx` (F# script) has no
such clash and is always F#.

A `.fs` file is F# unless it says otherwise:

1. a line only F# writes decides for F#: a `namespace` or `module`
   declaration, an `open` of a namespace, a `let` binding, a `type` definition,
   a `[<Attribute>]`, or a script directive like `#r "…"`. A GLSL line beside one
   is a shader kept in an F# string;
2. otherwise a GLSL line decides against it: `#version`, `#define`, `#ifdef`,
   `precision mediump float`, `uniform` / `varying` / `attribute` declarations,
   `layout(location = …)`, `in` / `out` declarations like `in vec2 uv;`,
   `void main(`, or a C-style function or variable that names its type first
   (`vec3 shade(vec3 n, vec3 l) {`, `const float k = 0.5;`) — an include of
   helper functions has nothing else — a C block comment (`/* … */`: F#
   starts no line with `/`), or a vector or matrix constructor (`vec4(1.0)`,
   `mat3(…)`), which F# does not have;
3. otherwise a Forth line does: a `\ ` comment at the start of a line, a colon
   definition (`: square dup * ;`, or `: name` with a later line closed by `;`),
   a stack comment (`( n -- f )`), `require x.fs`, a base switch alone on its
   line (`hex`), or two numbers before a word (`20 1 oprrnnn`), where F# needs a
   comma or a semicolon;
4. otherwise it is F#: the last file of a program may hold nothing but
   expressions, like the `Program.fs` of `dotnet new console -lang F#`
   (`printfn "Hello from F#"`). A file of nothing but comments is not indexed:
   there is nothing in it.

Forth's `type` is a word that prints a string, never followed by a name and
`=`, and neither GLSL nor Forth writes a line of the first kind.

Measured: all 432 `.fs` files with code in FSharp.Data, Giraffe and Paket read
as F#; none of LearnOpenGL's 158 shaders or gforth's 546 Forth files do.

The answer depends only on the file's own bytes, so a full index, a sync of one
edited file and a fresh re-index agree. A project can always decide for itself
in `codegraph.json`: `{ "extensions": { ".fs": "fsharp" } }` indexes every
`.fs` file as F#, and that mapping is never second-guessed.
