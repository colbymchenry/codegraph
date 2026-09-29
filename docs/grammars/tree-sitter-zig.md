# tree-sitter-zig.wasm — provenance and rebuild

`src/extraction/wasm/tree-sitter-zig.wasm` is built from
[`tree-sitter-grammars/tree-sitter-zig`](https://github.com/tree-sitter-grammars/tree-sitter-zig)
(MIT) at commit `6479aa1` with `tree-sitter-zig.patch` applied. The patch adds
the Zig 0.16 grammar changes needed by current projects and updates the
highlight query for names that stopped being language keywords. The same
change, including its corpus tests, is proposed upstream in
[`tree-sitter-zig#38`](https://github.com/tree-sitter-grammars/tree-sitter-zig/pull/38).

The checked-in WASM has this SHA-256:

```text
fb51d65772bd18487d86aeac9e4630b81cf878c9be20038c96c00c2d108e4f57
```

## What the patch changes

- accepts error sets as struct and union field types;
- treats `async`, `await`, `suspend`, and `resume` as ordinary identifiers,
  while retaining `nosuspend` as a keyword;
- accepts Zig 0.16 anonymous-struct inline-assembly clobbers while preserving
  the older string-list form;
- accepts conditional element types in slices and pointers;
- accepts reserved identifiers as block and break labels;
- removes the obsolete coroutine names from the highlight query.

## Rebuild

The commands below use the grammar repository's locked Tree-sitter CLI
`0.25.9`. Emscripten must be available for the WASM build.

```bash
git clone https://github.com/tree-sitter-grammars/tree-sitter-zig
cd tree-sitter-zig
git checkout 6479aa1
git apply --unidiff-zero /path/to/codegraph/docs/grammars/tree-sitter-zig.patch
npm ci --legacy-peer-deps
npx tree-sitter generate
npx tree-sitter test
npx tree-sitter build --wasm -o tree-sitter-zig.wasm
shasum -a 256 tree-sitter-zig.wasm
```

The final command must print the SHA-256 above before the WASM is copied into
CodeGraph. The corpus cases for each Zig 0.16 change are included in the patch,
so the test command exercises them before rebuilding the WASM.

## CodeGraph validation

CodeGraph separately tests the semantic layer built on this grammar: type and
member extraction, generic factories, tests, imports, cross-file calls, and
function values. The grammar corpus proves syntax support; CodeGraph's tests
prove the graph produced from that syntax.
