# tree-sitter-typescript — provenance & patch

`src/extraction/wasm/tree-sitter-{typescript,tsx}.wasm` and the kernel's
vendored C (`codegraph-kernel/grammars/typescript/`) are both built from
[tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript)
(MIT) tag `v0.23.2` (commit `f975a621f4e7f532fe322e13c4f79495e0a7b2e7`) with
the patch in `tree-sitter-typescript.patch` applied to `common/define-grammar.js`.

Unlike the other patched grammars, this patch changes a grammar **rule**, so
the parser is **regenerated** with tree-sitter-cli 0.25.10 (ABI 15). The
tag's checked-in `parser.c` is not used. The kernel compiles the same
generated C (build.rs) in place of the `tree-sitter-typescript` crate, so the
two paths stay table-identical (`kernel-grammar-parity.test.ts`). The
external scanner (`common/scanner.h`) is unpatched.

| file | upstream sha256 | patched sha256 |
|---|---|---|
| `common/define-grammar.js` | `c2ac6894e0db6164f56dc339788d9da2da60ce1f81d888e6b74a74fc81db818f` | `736614516e8a522f9b84fbd385d1881fcbac54c702dfcac69e2caab53a30e299` |
| `common/scanner.h` | `da66ef2bd14a3f7ea743e25ba068c6c9aae2c3509db200ff80c4a0e6116e564c` | unchanged |
| `typescript/src/parser.c` | (regenerated) | `eafc3e8cd89fbbfdcec9182b22446f19c31756f3c8c1212cfd7bffdb4b761424` |
| `tsx/src/parser.c` | (regenerated) | `232fe5b8178180307a40b393713d82074920977b147638bae898874085bcee86` |
| `tree-sitter-typescript.wasm` | `3a44d634c9840dccec36f33b99592bd086a2f940e9cd80c64347c45b7dce662f` | `cfa98dd06ea15830b0e203fbd2c30b144fcbf9cd8234790d4e8d20ae368a3bd1` |
| `tree-sitter-tsx.wasm` | `8f647a1b2cafe9ab00fb2056d79021d2a144ba17a72f45511072311c1b05d08e` | `2e9b0cdb5a08babebb2ba26ecd8d1b69c41fb7fb55fd4527190d071866950992` |

## What the patch fixes

TypeScript 4.7 variance annotations, such as `interface Stream<out A, in E>`,
`<in out T>`, `<const in T>` and `<in const T>`, were parse errors (upstream
issue #370). `type_parameter` now takes an optional `in`, `out` or `in out`,
with `const` on either side. In large files these errors can pile up until
tree-sitter gives up and parses the whole file as a single `ERROR`.

`out` stays usable as a type-parameter name (`type F<out> = out[]`,
`<out = X>`, `<out, T>`, and `<in out>`, which means modifier `in` on a
parameter named `out`), as tsc accepts all of them. The rule is upstream PR
#364's, plus the name alias from brajevicm/tree-sitter-typescript@9fcaa13
(both upstream PRs, #361 and #364, break `<out>` as a name without it), plus
our own second `optional('const')` after the variance for `<in const T>`,
which neither upstream PR has.

### Known limits

Making `in` and `out` keywords where a type parameter can start means they
lex as keywords wherever an expression `<` could also open type parameters.
So a **type** or **JSX tag** literally named `out` or `in` in that position
no longer parses: `<out>x` (a type assertion to a type named `out`), and in
tsx the tags `<out>…</out>`, `<out/>`, `<in>…</in>`, and a member tag on a
binding named `out` such as `<out.Provider>`. No HTML element and no
conventional type has either name. The alternative was accepting `out` as a
type name everywhere, and that broke `[out: T]` tuple labels, which real code
uses (Effect's `JsonSchema.ts`). The parser also accepts some forms tsc
rejects, such as `<out extends X>` (as before) and `<out in>`.

## Measured

These numbers compare files parsed with the previous wasm and with the
patched one (web-tree-sitter 0.25.10). An identical tree means the same node
types, fields and byte ranges.

| corpus | files | files with an error | lines inside ERROR | trees changed |
|---|---|---|---|---|
| Effect-TS/effect 7a87ff9 | 2,054 | 239 → 185 | 165,462 → 165,032 | 121 (54 now error-free, none newly broken) |
| colinhacks/zod 2554b70 | 481 | 4 → 0 | 21 → 0 | 4 |
| microsoft/vscode ca43fc94 `src/` (.ts) | 11,265 | 11 → 11 | 11 → 11 | 0 |
| excalidraw/excalidraw dd2f8fc (.ts / .tsx) | 372 / 323 | 2 / 3 → same | 3 / 3 → same | 0 / 0 |

Most of Effect's whole-file failures remain. Their next error is upstream
tree-sitter-typescript #335: a generic call signature, such as an overload
`<A>(self: A): A`, on its own line after another member with no `;`. This
patch does not cover that.

Regenerating the unpatched grammar with 0.25.10 gives a tree identical to
the previous wasm on every file of Effect, Zod and VS Code, so regeneration
on its own changes nothing. The upstream corpus (112 tests) passes before
and after the patch.

## Rebuild

```bash
git clone https://github.com/tree-sitter/tree-sitter-typescript
cd tree-sitter-typescript
git checkout f975a621f4e7f532fe322e13c4f79495e0a7b2e7
npm ci --ignore-scripts          # tree-sitter-javascript 0.23.1, the grammar it extends
git apply /path/to/codegraph/docs/grammars/tree-sitter-typescript.patch
(cd typescript && npx -y tree-sitter-cli@0.25.10 generate)
(cd tsx && npx -y tree-sitter-cli@0.25.10 generate)
npx -y tree-sitter-cli@0.25.10 test
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-typescript.wasm typescript
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-tsx.wasm tsx
# kernel: copy common/scanner.h, {typescript,tsx}/src/{parser.c,scanner.c,tree_sitter/}
# and LICENSE into codegraph-kernel/grammars/typescript/ keeping that layout
# (scanner.c includes ../../common/scanner.h)
```

Check each `generate` exit code: piping it hides a failure, and `build`
would then compile the previous parser. `build --wasm` uses the
`emscripten/emsdk:4.0.4` Docker image when no local emcc is present. The wasm
bytes depend on the emsdk build, so a rebuild may not match the hashes above
byte for byte. `parser.c` is the reproducible artifact. After updating
either side, rebuild the kernel (`npm run build:kernel`) and run
`kernel-grammar-parity.test.ts`.

## Dropping the patch

When upstream merges a variance fix, bump to that release and check that
`<out>` still parses as a parameter name, `[out: T]` as a tuple label, and
`<in const T>` with `const` after the variance
(`__tests__/typescript-variance-parse.test.ts` covers all three). Then go back
to the crate and the checked-in `parser.c`. Tracking:
inth3shadows/codegraph#11.
