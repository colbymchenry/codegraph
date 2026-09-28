# Zig indexing scope and validation

Zig follows the shared tree-sitter extraction and reference-resolution pipeline.
The vendored WASM recognizes syntax; TypeScript language hooks extract nodes
and dependencies. No Zig installation is required to index a project. Zig
0.16.0 is used only for optional compiler-backed validation.

## Supported indexing behavior

- Functions, methods, structs, enums, unions, opaque types, error sets, fields,
  enum/error members, type aliases, constants, variables and test declarations.
- Quoted identifiers, lexical ownership, declaration visibility, container
  methods and bounded inference of receiver types.
- Generic functions returning a literal container, initializer calls, field
  defaults, struct instantiations and type dependencies.
- Literal relative imports, scoped bindings, public alias chains and bounded
  literal `build.zig` module registrations. `root` resolves only when project
  evidence identifies an unambiguous root; `std` and `builtin` stay external.
- Incremental rebinding when imports or aliases change, removal of stale call
  edges, worker resolution and persistence across database reopening.
- `.zon` manifests are tracked as files, without fabricated declaration nodes.

The implementation reuses existing node/edge metadata and requires no database
schema migration. Re-index an existing project to discover its Zig files.

## Grammar provenance

The grammar source archive, patch, tool versions, SHA256 checksums and license
are recorded in [the grammar build instructions](grammars/tree-sitter-zig.md).
The checked-in grammar and its MIT notice are copied into production packages.
The grammar is prebuilt; normal application builds do not rebuild it.

## Reproducible validation

From a normal development checkout with dependencies available:

```sh
npm run build
ZIG_COMPILER=zig npx vitest run \
  __tests__/zig-extraction.test.ts __tests__/zig-production.test.ts \
  __tests__/zig-static-semantics.test.ts __tests__/zig-instance-fields.test.ts \
  __tests__/zig-acceptance.test.ts \
  --reporter=default --reporter=json --outputFile=/tmp/zig-runtime-report.json
node scripts/check-zig-test-report.mjs /tmp/zig-runtime-report.json
node scripts/check-zig-package.mjs .
CODEGRAPH_PARALLEL_RESOLVE_MIN=0 node scripts/check-zig-package.mjs .
ZIG_COMPILER=zig node scripts/check-zig-ast.mjs
ZIG_COMPILER=zig node scripts/check-zig-ast.mjs --recovery-contract
```

The runtime report gate requires all five suites, at least 125 tests, no
failures and no skipped/todo tests. With Zig 0.16.0 available, controlled source
fixtures are independently checked by the compiler. The strict `std.zig.Ast`
differential contains 36 files: 34 accepted by both parsers and two rejected by
both. Recovery cases are checked separately and do not count as syntax parity.
The ordinary test suite can run without Zig; independent compiler invocations are then omitted, while graph assertions still run.

`zig-real-world-eval.test.ts` accepts externally supplied corpus paths through
its environment variables and snapshots source files without modifying the
original projects. Private source paths, filenames and symbols are not embedded
in the repository. Historical evaluation covered small, medium and large
snapshots (135, 294 and 1,517 Zig files), nine connected multi-step flow probes,
and stable graph counts after repeated indexing. Agent comparisons with Sonnet
high used two runs per arm and three prompts per corpus: successful CLI
contamination was zero, but residual reads and individually slower runs remain.
These observations do not establish universal retrieval-speed improvement.

## Explicit boundaries

This is static code indexing, not a Zig compiler or interpreter. It does not
evaluate arbitrary `comptime` code, computed build graphs/imports, generic type
execution or arbitrary vtable dispatch. `@embedFile` resolves only indexed
files, and C include search paths require separate build-system evidence.

Tree-sitter accepts three named malformed-source fixtures that Zig's AST rejects:
`reserved_declaration`, `unparenthesized_initializer` and `reserved_field`.
`__tests__/fixtures/zig-recovery-cases.json` records the exact expected nodes and
calls, including rejection of unrelated same-named targets. These fixtures make
recovery behavior explicit; they are not supported valid Zig syntax, and parser
acceptance alone must not be used as a syntax-validity guarantee.

Tests exercise both conservative negative resolution and successful edges.
Runtime availability and successful parsing alone are not acceptance evidence.
