# tree-sitter-fsharp.wasm — provenance & rebuild

`src/extraction/wasm/tree-sitter-fsharp.wasm` is the prebuilt grammar attached to
release `0.3.12` of
[ionide/tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp), the
maintained fork of `microsoft/tree-sitter-fsharp`. It is vendored unmodified.

- SHA-256: `ff1a927387fec25e184d120d9e18ec7cd5271b30f6380f02d494d3548a99f7b7`
- ABI 15; `node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-fsharp.wasm <sample.fs>`
  parses 20 of 20 runs clean in the shared multi-grammar runtime.

`tree-sitter-wasms` ships no F# grammar, so there is nothing to resolve it from
at install time; the file has to live in the repository like the other vendored
grammars.

The file is large (11.4 MB) because the F# parser tables are. The release also
ships `tree-sitter-fsharp_signature.wasm` (2.7 MB) for `.fsi` signature files;
it is not vendored. The main grammar mis-parses `val` declarations, so `.fsi`
files are not indexed — every symbol they declare is in the `.fs` anyway.

## Rebuild / update

Download `tree-sitter-fsharp.wasm` from the release page of the new version,
replace the file, update the SHA-256 above and re-run the health check.
