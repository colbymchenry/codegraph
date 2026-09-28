# Zig grammar: source, build and validation

The vendored `src/extraction/wasm/tree-sitter-zig.wasm` is built from
[`@tree-sitter-grammars/tree-sitter-zig` 1.1.2](https://www.npmjs.com/package/@tree-sitter-grammars/tree-sitter-zig/v/1.1.2),
whose published `gitHead` is `b670c8df85a1568f498aa5c8cae42f51a90473c0` in
[tree-sitter-grammars/tree-sitter-zig](https://github.com/tree-sitter-grammars/tree-sitter-zig/tree/b670c8df85a1568f498aa5c8cae42f51a90473c0).
The upstream MIT license is preserved in [LICENSE.tree-sitter-zig](LICENSE.tree-sitter-zig) and shipped as `dist/extraction/wasm/LICENSE.tree-sitter-zig`.

| Input or output | Pinned value |
| --- | --- |
| Source archive | `https://registry.npmjs.org/@tree-sitter-grammars/tree-sitter-zig/-/tree-sitter-zig-1.1.2.tgz` |
| Archive SHA-256 | `2512a88611e400dbafb9cb79b247c7f2671ed034e1714b33df29712ee93e534c` |
| Local patch | `scripts/grammars/zig-empty-containers.patch` |
| Generator | Tree-sitter CLI 0.27.0, `generate --abi 15` |
| Compiler | Zig 0.16.0, `zig cc -target wasm32-wasi` |
| Export | `tree_sitter_zig` |
| WASM SHA-256 | `95d8eef504bde9cca06b7950d6a8ae177ce318d16080deac96f653b29c629f98` |

The four-line grammar patch makes the member list optional in struct, enum,
union and opaque declarations. Upstream 1.1.2 otherwise recovers an empty
container by inserting a missing identifier. Fixing the grammar avoids
special-case source rewriting or synthetic-field filtering in the extractor.

## Rebuild

With the pinned tools already available (this script does not install tools):

```bash
TREE_SITTER_CLI=/absolute/path/to/tree-sitter \
  bash scripts/build-zig-grammar.sh
npm run build
npx vitest run __tests__/zig-extraction.test.ts __tests__/zig-production.test.ts
```

An optional first argument selects a different output WASM path. The script
checks tool versions and the source archive hash, applies the checked-in patch,
generates the C parser, compiles it, and validates 100 repeated parses with the
project's `web-tree-sitter` runtime before copying the output. Two independent
build directories produced identical WASM bytes on macOS arm64 on 2026-09-28.

## Validation and limits

The dedicated regressions check empty containers, import aliases and lexical
scope, negative resolution, incremental target removal/restoration, generic
returned containers, fields, type dependencies, nested initializer calls and
error-union return types. Real-world evaluation separately checks extraction
errors and tree-sitter `ERROR`/`MISSING` recovery; these are different gates.

See [Zig indexing scope and validation](../zig-production-audit.md) for reproducible test commands and known syntax-recovery differences. These gates validate graph extraction, not compilation or application behavior.

The analyzer resolves literal relative `.zig` imports, including member aliases
and block-local bindings. It supports bounded literal `build.zig` registrations
and public alias chains; it does not evaluate arbitrary build code,
computed import paths, generic type execution or arbitrary vtable dispatch.
External compiler modules remain outside the graph. `@embedFile` can resolve
only files admitted to the index; C include search paths require separate
build-system evidence. A negated call is still normalized by extraction because
this upstream grammar places `!` inside the callee type expression.

Syntax acceptance can be compared directly with Zig 0.16.0 `std.zig.Ast` using
`ZIG_COMPILER=/path/to/zig node scripts/check-zig-ast.mjs` after the normal build.
This validates controlled positive and negative fixtures without rebuilding the
WASM. The validation contract and remaining recovery differences are in
[the audit](../zig-production-audit.md).
