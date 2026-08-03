# Shader grammar provenance

CodeGraph vendors two MIT-licensed Tree-sitter WASM grammars for shader parsing.
Their complete license texts ship in `THIRD_PARTY_NOTICES.md`.

| Language | Upstream revision | Build |
|---|---|---|
| GLSL | `Caellian/tree-sitter-glsl@09b8cbc3a36bce116d641f1bc176268c0899e6e0` | Tree-sitter CLI 0.26.8, ABI 15, SHA-256 `EBFB8027DF9DC4B31DD967DB4B119D224ECC798740E76790EE186A78F198F117` |
| HLSL | `tree-sitter-grammars/tree-sitter-hlsl@bab9111922d53d43668fabb61869bec51bbcb915` | Parser regenerated with Tree-sitter CLI 0.26.8, ABI 15, SHA-256 `DEFDC4C7ED6971A9C6A7B8411237DD001CA94F79FABD7383866DE5F6433D7F12` |

Rebuild from a clean checkout of each revision with:

```sh
tree-sitter generate   # required for HLSL to replace the upstream ABI-14 parser
tree-sitter build --wasm
```

The resulting files are stored as `tree-sitter-glsl.wasm` and
`tree-sitter-hlsl.wasm` under the extraction WASM assets and are copied into the
published build by the normal `copy-assets` step.
