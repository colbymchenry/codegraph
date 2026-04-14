# ReScript Support for CodeGraph

## Why ReScript?

[ReScript](https://rescript-lang.org/) is a robustly typed language that compiles to efficient JavaScript. It combines a powerful type system with a syntax familiar to JavaScript developers. With strong adoption in production applications (particularly in the React ecosystem via `rescript-react`), ReScript projects benefit from semantic code intelligence for navigating module hierarchies, understanding type relationships, and tracing call graphs through pipe chains.

ReScript's module system (influenced by OCaml) means that codebases are organized differently from class-based languages — modules are the primary unit of composition, and functors enable powerful abstraction patterns. CodeGraph's structural understanding helps developers navigate these patterns effectively.

## What Was Implemented

### ReScript Extraction (tree-sitter)

Full extraction support for `.res` and `.resi` files using a WASM build of the `tree-sitter-rescript` grammar:

| Feature | NodeKind | Details |
|---------|----------|---------|
| Functions | `function` | `let` bindings with function body (`let foo = (x) => ...`) |
| Variables | `variable` | `let` bindings with non-function body (`let x = expr`) |
| Externals (FFI) | `function` | `external` declarations with type annotation |
| Modules | `namespace` | `module` declarations (primary organizational unit) |
| Module Types | `interface` | `module type` declarations (signatures without definitions) |
| Type Aliases | `type_alias` | `type t = ...` declarations |
| Variant Types | `enum` | Types with `variant_declaration` body, including enum members |
| Record Types | `struct` | Types with `record_type` body, including field extraction |
| Record Fields | `field` | Individual fields within record types |
| Enum Members | `enum_member` | Individual variant constructors |
| Imports | `import` | `open Module` and `include Module` statements |
| Exceptions | `type_alias` | `exception` declarations |
| Function Calls | — | `calls` edges for `call_expression` nodes |
| Pipe Expressions | — | `calls` edges for `x->f(y)` pipe chains |
| Decorators | — | `@module`, `@schema`, etc. extracted as metadata |
| Signatures | — | Parameter lists and return types for functions |
| Containment | — | `contains` edges (module → function, type → field, etc.) |
| Functors | — | Functor bodies traversed for nested declarations |
| Module Aliases | — | `module X = OtherModule` creates `references` edge |
| Docstrings | — | Preceding doc comments captured |
| ERROR Recovery | — | Valid structures inside tree-sitter ERROR nodes are extracted |

### MCP Symbol Disambiguation

Added `file` parameter to `codegraph_node`, `codegraph_callers`, `codegraph_callees`, and `codegraph_impact` tools to disambiguate when multiple symbols share the same name across different files. When `file` is provided but no match is found, an error is returned instead of silently falling back to a different symbol.

## Architecture

The implementation follows CodeGraph's established patterns:

- **ReScript extraction** is implemented as a `LanguageExtractor` in `src/extraction/languages/rescript.ts`, following the same per-language file pattern as TypeScript, Go, Rust, etc.
- **`visitNode()` hook** handles ReScript's wrapper node pattern where declarations use intermediate binding nodes (`let_declaration` → `let_binding`, `module_declaration` → `module_binding`, `type_declaration` → `type_binding`)
- **Pipe expression handling** extracts the piped function from `pipe_expression` nodes and creates `calls` edges, enabling call graph traversal through `x->Array.map(f)->Array.filter(g)` chains
- **ERROR node recovery** walks children of tree-sitter ERROR nodes to extract valid structures (common in `tree-sitter-rescript` for certain syntax patterns)
- **`tree-sitter-rescript.wasm`** (908KB) ships in `src/extraction/wasm/` (not in the `tree-sitter-wasms` npm package), following the same pattern as Pascal

### ReScript AST → CodeGraph Node Mapping

| CodeGraph Concept | ReScript AST Node Type | Notes |
|---|---|---|
| function | `let_declaration` (when body is `function`) | let bindings with function bodies |
| function | `external_declaration` | FFI bindings |
| namespace | `module_declaration` (with definition) | Primary organizational unit |
| interface | `module_declaration` (with `type` keyword, signature only) | Module types |
| type_alias | `type_declaration` | Generic type declarations |
| enum | `type_declaration` (with `variant_declaration` body) | Variant types |
| struct | `type_declaration` (with `record_type` body) | Record types |
| variable | `let_declaration` (when body is not `function`) | Value bindings |
| import | `open_statement` | `open Module` |
| import | `include_statement` | `include Module` |
| calls | `call_expression` | Direct function calls |
| calls | `pipe_expression` | `x->f(y)` pipe chains |

### Key Design Decisions

- **Modules → `namespace`**: ReScript has no classes; modules are the primary organizational unit, mapped to `namespace` NodeKind
- **`let` overloading**: `let_declaration` can be a function or a variable — determined by checking if the body is a `function` node
- **Functors**: `module Make = (Config: T) => { ... }` — functor bodies are traversed for nested declarations
- **Pipe chains**: `x->f(y)` creates a `calls` edge to `f`, enabling `codegraph_callers`/`codegraph_callees` to trace through pipe-heavy ReScript code
- **Decorators**: PPX attributes (`@module`, `@schema`, `@s.matches`) are extracted as decorator metadata on the associated node

## Grammar: tree-sitter-rescript.wasm

The WASM grammar was built from [`rescript-lang/tree-sitter-rescript`](https://github.com/rescript-lang/tree-sitter-rescript) via Docker + emscripten (908KB output).

### Rebuild Instructions

```bash
git clone https://github.com/rescript-lang/tree-sitter-rescript.git /tmp/tree-sitter-rescript
cd /tmp/tree-sitter-rescript

# Build WASM via Docker + emscripten (produces tree-sitter-rescript.wasm)
npx tree-sitter build --wasm

# Copy to CodeGraph
cp tree-sitter-rescript.wasm /path/to/codegraph/src/extraction/wasm/
```

The native dynamic library (for ast-grep, not CodeGraph) can be built with:

```bash
gcc -shared -fPIC -O2 -I /tmp/tree-sitter-rescript/src \
  -o rescript.dylib \
  /tmp/tree-sitter-rescript/src/parser.c /tmp/tree-sitter-rescript/src/scanner.c
```

### Default Include/Exclude Patterns

**Included:** `**/*.res`, `**/*.resi`

**Excluded:** `**/.rescript/**`, `**/lib/bs/**`, `**/lib/ocaml/**` (ReScript compiler output directories)

## Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Added `'rescript'` to `Language` type, `.res`/`.resi` to `DEFAULT_CONFIG.include`, ReScript compiler output dirs to `exclude` |
| `src/extraction/grammars.ts` | WASM loader, extension mappings (`.res`, `.resi`), display name |
| `src/extraction/languages/rescript.ts` | `LanguageExtractor` with `visitNode()` hook, `extractImport()`, helper functions for let bindings, modules, types, externals, pipe calls, ERROR node recovery |
| `src/extraction/languages/index.ts` | Registers `rescriptExtractor` in the `EXTRACTORS` map |
| `src/extraction/wasm/tree-sitter-rescript.wasm` | Pre-built WASM grammar (908KB) |
| `__tests__/extraction.test.ts` | 12 new tests covering all ReScript extraction features |

## Test Results

- **12 new tests**, all passing
- **0 regressions** — all pre-existing tests unchanged
- Tests cover: language detection, functions, variables, type declarations, variant types (enums), record types (structs), modules, module types (interfaces), open/include imports, external declarations, call expressions, and pipe expression calls
- **Real-world validation**: Tested against a ReScript codebase — 75 nodes, 71 edges, 28 call references from 4 core files

## Testing Instructions

### Prerequisites

- Node.js >= 18
- npm
- Git

### 1. Clone and build

```bash
git clone https://github.com/colbymchenry/codegraph.git
cd codegraph
npm install
npm run build
```

### 2. Link globally

```bash
npm link
```

Verify with:

```bash
codegraph --version
```

### 3. Index a ReScript project

```bash
cd /path/to/your/rescript-project
codegraph init -i
codegraph index
```

### 4. Query the code graph

```bash
codegraph status                              # Show index statistics
codegraph query "EventLog"                    # Search for a symbol
codegraph context "How does the event log work?"  # Build AI context
```

### 5. Set up the MCP server (for Claude Code)

```bash
codegraph install
```

This configures the MCP server, tool permissions, auto-sync hooks, and CLAUDE.md in one step. After that, start Claude Code in the project — CodeGraph tools will be available immediately.

### 6. Clean up

```bash
npm unlink -g @colbymchenry/codegraph       # Remove global link
rm -rf /path/to/rescript-project/.codegraph  # Remove project index
```
