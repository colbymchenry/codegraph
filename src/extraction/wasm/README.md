# Haskell grammar

`tree-sitter-haskell.wasm` is a vendored runtime dependency: the installed
`tree-sitter-wasms@0.1.13` package has no Haskell grammar. `npm run copy-assets`
ships it and its MIT notice into `dist/extraction/wasm/`; it does not rebuild it.
The other vendored grammars are registered in `VENDORED_WASM_LANGS` in
`src/extraction/grammars.ts`.

- Source: [tree-sitter/tree-sitter-haskell](https://github.com/tree-sitter/tree-sitter-haskell), commit `0975ef72fc3c47b530309ca93937d7d143523628`.
- Build: `tree-sitter-cli` 0.25.10, emsdk 4.0.4, ABI 15, with the adjacent Unicode patch.
- SHA-256: `9e84bef816978de2342dada8cf277991ce50bfecc44993db089f5d754429921b`.

## Rebuild and validate

```bash
CODEGRAPH_REPO=/path/to/codegraph
git clone https://github.com/tree-sitter/tree-sitter-haskell /tmp/ts-haskell
cd /tmp/ts-haskell
git checkout 0975ef72fc3c47b530309ca93937d7d143523628

npx --yes tree-sitter-cli@0.25.10 generate
git apply "$CODEGRAPH_REPO/src/extraction/wasm/tree-sitter-haskell-unicode-ranges.patch"
npx --yes tree-sitter-cli@0.25.10 build --wasm --docker -o tree-sitter-haskell.wasm

cp tree-sitter-haskell.wasm "$CODEGRAPH_REPO/src/extraction/wasm/"
cp LICENSE "$CODEGRAPH_REPO/src/extraction/wasm/tree-sitter-haskell.LICENSE"

cd "$CODEGRAPH_REPO"
node scripts/add-lang/check-grammar.mjs \
  src/extraction/wasm/tree-sitter-haskell.wasm \
  /path/to/valid-sample.hs
shasum -a 256 src/extraction/wasm/tree-sitter-haskell.wasm
```

The Unicode patch expands the scanner's compressed `First`/`Last` ranges so
valid letter scripts such as Chinese are accepted. Apply it after every
regeneration; two clean builds must produce the recorded hash. The health
check must report `PASS` on a valid sample before shipping the artifact.

Remove this copy only after a dependency supplies an equivalent tested build,
then update `VENDORED_WASM_LANGS` and the packaging checks together.
