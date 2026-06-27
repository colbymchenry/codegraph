# C++ Graph Generation Detailed Design

**Audience:** maintainers working on C++ indexing, call resolution, include
resolution, or dynamic-dispatch coverage.
**Status:** describes the current implementation.

CodeGraph treats C++ as a first-class tree-sitter language with additional
resolver and synthesizer support. The C++ graph is built from four cooperating
parts:

1. language detection and grammar loading;
2. tree-sitter extraction of symbols and unresolved references;
3. import/name resolution into concrete graph edges;
4. synthetic override edges for vtable-style dispatch.

The implementation is intentionally not a Clang replacement. It does not compile
translation units or expand macros. It builds a practical static graph from
source text and conservative heuristics.

---

## Current support surface

The extension map treats these files as C++:

| Extension | Language |
|---|---|
| `.cpp` | `cpp` |
| `.cc` | `cpp` |
| `.cxx` | `cpp` |
| `.hpp` | `cpp` |
| `.hxx` | `cpp` |
| `.h` | initially `c`, promoted to `cpp` by content heuristics |

`.h` files are promoted to C++ when the first 8KB contains C++-only constructs:
`namespace`, `class X`, `template <...>`, access specifier labels, `virtual`, or
C++ `using` forms. If Objective-C markers such as `@interface` are present, the
same `.h` path can instead be classified as Objective-C.

The C++ tree-sitter WASM comes from `tree-sitter-wasms`. Grammars are loaded only
for languages present in the scanned file set. When `c` is needed, the indexer
also loads `cpp` so `.h` promotion and mixed C/C++ projects have the right parser
available.

---

## Pipeline

```text
scanDirectory
  |
  v
detectLanguage(path, source)
  |
  v
TreeSitterExtractor(file, source, "cpp")
  |
  +--> file/class/struct/enum/function/method/type_alias/import/variable nodes
  +--> contains edges
  +--> unresolved refs: calls, imports, extends, instantiates, type refs
  |
  v
QueryBuilder persists extraction result
  |
  v
ReferenceResolver.resolveAndPersistBatched()
  |
  +--> #include refs become file -> file imports edges
  +--> named refs become calls/references/extends/etc. edges
  |
  v
synthesizeCallbackEdges()
  |
  +--> cpp-override calls edges: base method -> derived override
```

The extraction pass is syntax-local. It can see what is written in one file. The
resolution pass has whole-project context and turns names and include paths into
target node IDs. The synthesizer runs after base edges exist and adds runtime
reachability edges that do not exist as direct syntax.

---

## Language extractor configuration

The C++ extractor is defined in `src/extraction/languages/c-cpp.ts` as
`cppExtractor`.

| Extractor field | Current C++ value | Graph effect |
|---|---|---|
| `functionTypes` | `function_definition` | Free functions with bodies become `function` nodes. |
| `classTypes` | `class_specifier` | C++ classes become `class` nodes. |
| `methodTypes` | `function_definition` | Function definitions inside class-like scopes become `method` nodes. |
| `structTypes` | `struct_specifier` | Structs become `struct` nodes. |
| `enumTypes` | `enum_specifier` | Enums become `enum` nodes. |
| `enumMemberTypes` | `enumerator` | Enum members become `enum_member` nodes. |
| `typeAliasTypes` | `type_definition`, `alias_declaration` | `typedef` and `using` aliases become type-alias or promoted struct/enum nodes. |
| `importTypes` | `preproc_include` | `#include` directives become import refs. |
| `callTypes` | `call_expression` | Calls become unresolved `calls` refs. |
| `variableTypes` | `declaration` | Top-level declarations become variable/constant nodes where names can be extracted. |
| `nameField` | `declarator` | Names are resolved from declarators. |
| `bodyField` | `body` | Function/method body traversal uses the C++ grammar's body field. |
| `paramsField` | `parameters` | Signature and parameter-related extraction can use parameter lists. |

The extractor also supplies C++-specific hooks:

- `resolveName`: extracts the leaf name from out-of-class definitions such as
  `Foo::bar(...)`.
- `getReceiverType`: extracts `Foo` from `Foo::bar(...)`, allowing top-level
  out-of-class definitions to be stored as methods owned by `Foo`.
- `getVisibility`: reads nearby access specifiers and maps them to
  `public`, `private`, or `protected`.
- `resolveTypeAliasKind`: promotes `typedef enum { ... } Name;` and
  `typedef struct { ... } Name;` to enum/struct nodes when the underlying type is
  anonymous.
- `isMisparsedFunction`: filters macro-caused false function nodes, especially
  names beginning with `namespace` and C++ control keywords that tree-sitter may
  misinterpret inside macro-confused scopes.
- `extractImport`: parses system and quoted `#include` paths.

---

## Symbol nodes

Every extracted node uses the common `Node` shape from `src/types.ts`. For C++,
the important node kinds are:

| Node kind | Example source | Notes |
|---|---|---|
| `file` | `src/db.cc` | Created by the common extractor/orchestrator path. |
| `class` | `class DB { ... };` | Inheritance is emitted as unresolved `extends` refs. |
| `struct` | `struct Options { ... };` | Also class-like for containment. |
| `enum` | `enum Status { ... };` | Enum members are extracted when tree-sitter exposes them. |
| `enum_member` | `kOk` | Contained by the enum. |
| `function` | `Status Open(...) { ... }` | Free functions with bodies. |
| `method` | `void DB::Close() { ... }` or inline class method definitions | Out-of-class methods use receiver-qualified names. |
| `type_alias` | `using Key = std::string;` | Some typedefs are promoted to `struct` or `enum`. |
| `variable` / `constant` | top-level declarations | Best-effort, lower priority than callable/type nodes. |
| `import` | `#include "db.h"` | Local import declaration node plus an unresolved import ref. |

Containment is represented with `contains` edges:

```text
file(db.h) -> class(DB)
class(DB) -> method(Open)
class(DB) -> method(Close)
file(status.h) -> enum(Status)
enum(Status) -> enum_member(kOk)
```

Out-of-class definitions are normalized so `void DB::Close() {}` becomes a
`method` named `Close` with qualified name `DB::Close`. If a class/struct node
named `DB` exists in the same file, a `contains` edge can be attached from that
owner to the method. Cross-file ownership is resolved through graph search and
call/reference edges rather than by rewriting the containment tree.

---

## Reference extraction

The extractor emits unresolved references when it sees syntax that names another
symbol but cannot yet pick the target node.

| Source shape | Unresolved reference kind | Later edge kind |
|---|---|---|
| `#include "x.h"` | `imports` | `imports` |
| `foo()` | `calls` | `calls` |
| `obj.method()` | `calls` | `calls` |
| `new Foo(...)` / constructor-like forms | `instantiates` | `instantiates` |
| `class Derived : public Base` | `extends` | `extends` |
| type annotations and selected declarations | `references` / `type_of` / `returns` depending on extractor path | same or promoted by resolver |

C++ inheritance has a dedicated branch in `extractInheritance()`. Tree-sitter C++
models bases under `base_class_clause`, so the generic Java/TypeScript
`extends_clause` logic is not enough. The C++ branch emits one `extends`
unresolved ref per `type_identifier`, `qualified_identifier`, or `template_type`
inside the base clause and skips access specifier keywords.

Example:

```cpp
class MergingIterator : public Iterator {
 public:
  void Next() override;
};
```

Extraction emits:

```text
node: class MergingIterator
unresolved: MergingIterator --extends--> Iterator
node: method Next
```

Resolution later turns the unresolved `extends` ref into an edge to the `Iterator`
class node if a matching node exists.

---

## Include resolution

C++ `#include` handling is split between extraction and resolution.

During extraction, `extractImport()` reads:

- system includes: `#include <vector>` -> module name `vector`;
- quoted includes: `#include "include/db.h"` -> module name `include/db.h`.

During resolution, `resolveViaImport()` has a C/C++ special case for unresolved
refs where `referenceKind === 'imports'`. It bypasses symbol lookup and resolves
directly to a `file` node. This is necessary because an include names a file, not
a symbol exported from that file.

Resolution order:

1. For quoted includes, prefer the including file's own directory:
   `src/foo.cc` + `"foo.h"` checks `src/foo.h` first.
2. Fall back to `resolveImportPath()`.
3. `resolveImportPath()` uses include directories from the resolution context.
4. Include directories come from `compile_commands.json` where available, with
   heuristic fallback to project directories that contain headers.
5. Absolute include directories outside the project are ignored.
6. If a matching indexed file node exists, create a file-to-file `imports` edge.

System headers such as `<vector>` and `<cstdio>` normally resolve to `null`
because they are external to the indexed project.

End-to-end target shape:

```text
file(src/main.cpp) --imports--> file(include/utils.h)
```

Tests in `__tests__/resolution.test.ts` pin same-directory lookup, `.hpp`
lookup, include-subdirectory lookup, include-dir discovery from
`compile_commands.json`, heuristic include-dir discovery, external system-header
skipping, and the end-to-end `main.cpp -> include/utils.h` file edge.

---

## Call and name resolution

C++ call extraction produces names from `call_expression` syntax and stores them
as unresolved `calls` refs. Resolution is then delegated to the shared
`ReferenceResolver` strategies:

1. framework resolvers, if any claim the reference;
2. import-based resolution;
3. name matching through `matchReference()`.

The known-name prefilter understands `::` paths. For a qualified C++ name such as
`ns::Type::method`, it checks both early segments and the final leaf segment so
the resolver does not discard a valid ref before name matching gets a chance.

Because CodeGraph does not run the C++ compiler, call resolution is best-effort:

- overloads are ranked by existing name-matching and proximity heuristics;
- templates are not instantiated;
- macro-expanded calls are only visible if tree-sitter exposes call syntax in
  the source text;
- external library calls are usually ignored unless the target exists inside the
  indexed project.

This is enough for project-local architecture, dependency, and impact queries,
but it should not be treated as compiler-grade binding.

---

## Virtual dispatch and override synthesis

Static extraction can resolve this:

```cpp
iter->Next();
```

to a visible base method when the receiver type is known or the name matcher
finds a base symbol. It cannot see the runtime vtable hop from the base method to
derived overrides. CodeGraph adds that reachability through `cppOverrideEdges()`
inside `src/resolution/callback-synthesizer.ts`.

Algorithm:

1. Iterate all `class` nodes.
2. Collect contained `method` nodes whose language is `cpp`.
3. For each outgoing `extends` edge from the class, fetch the base class.
4. Collect the base class's contained methods.
5. For each subclass method with the same name as a base method, synthesize:

   ```text
   base_method --calls--> subclass_method
   ```

6. Mark the edge:

   ```json
   {
     "provenance": "heuristic",
     "metadata": {
       "synthesizedBy": "cpp-override",
       "via": "<method name>",
       "registeredAt": "<derived file>:<derived line>"
     }
   }
   ```

The pass is gated to C++ nodes and capped per class with the shared
`MAX_CALLBACKS_PER_CHANNEL` limit. It is an over-approximation: every matching
override is considered reachable from the base method. That is the right trade-off
for architecture exploration and impact analysis because the question is usually
"what implementations could this dispatch reach?"

Example:

```text
class Iterator contains method Next
class MergingIterator extends Iterator
class MergingIterator contains method Next

synthesized:
Iterator::Next --calls--> MergingIterator::Next
```

This lets `codegraph_explore "Iterator Next MergingIterator"` surface the runtime
relationship even though there is no direct source-level call from the base method
body to the override body.

Current limitation: pure virtual declarations without function bodies are not
extracted as method nodes by the current `function_definition`-based extractor.
The override synthesizer can only bridge from base methods that exist as nodes.

---

## Macro-confused source

C++ macro-heavy projects can make tree-sitter produce misleading syntax. The
current mitigation is deliberately narrow:

- `isMisparsedFunction()` drops function names that begin with `namespace`;
- it also drops keyword-like names such as `switch`, `if`, `for`, `while`,
  `do`, `case`, and `return`;
- when such a false function node has a body, the extractor still visits the body
  so real nested classes, structs, enums, functions, and calls are not lost.

This specifically protects projects where macros such as namespace-opening macros
cause tree-sitter to misparse a namespace block as a `function_definition`.

---

## Query-visible behavior

After a successful C++ index:

- `codegraph_search` can find C++ classes, structs, enums, free functions, and
  methods by simple or qualified names.
- `codegraph_node` can return a symbol's location, signature where available,
  callers/callees trail, and source body if requested.
- `codegraph_callers` and `codegraph_callees` traverse resolved `calls`,
  `references`, and `imports` edges.
- `codegraph_impact` follows dependents through resolved graph edges.
- `codegraph_files` reports indexed C++ files with language and symbol counts.
- `codegraph_explore` can include C++ source slices, relationship maps, include
  dependencies, inheritance, and synthesized override links.

The C++ graph is therefore useful for:

- "where is this class/function defined?"
- "what includes this header?"
- "what code calls this function?"
- "what subclasses can this virtual method reach?"
- "what tests or files are affected if this header or method changes?"

---

## Validation checklist

Use this checklist when changing C++ graph generation:

1. **Language detection**
   - `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` classify as `cpp`.
   - `.h` with `class`, `namespace`, `template`, `virtual`, access labels, or
     C++ `using` promotes to `cpp`.
   - Objective-C `.h` still promotes to `objc` when Objective-C markers exist.

2. **Extraction**
   - Classes, structs, enums, enum members, functions, methods, aliases, imports,
     and top-level declarations still appear as nodes.
   - Macro-confused namespace artifacts do not create bogus function nodes.
   - Structural nodes inside macro-confused bodies are still visited.
   - Out-of-class `Type::method()` definitions keep the leaf method name and
     receiver-qualified name.

3. **Includes**
   - Quoted same-directory headers win over include-dir headers.
   - `compile_commands.json` `-I` paths inside the project are used.
   - Absolute system include dirs outside the project are ignored.
   - `<vector>` and other external headers do not create project-local edges.

4. **Inheritance and override dispatch**
   - `base_class_clause` emits `extends` refs for all base types.
   - Resolved `extends` edges exist after resolution.
   - `cpp-override` heuristic edges are present only when base and derived method
     nodes both exist and names match.
   - Fan-out remains bounded; no generic explosion on large projects.

5. **Queries**
   - `codegraph_explore` surfaces the relevant C++ files without requiring file
     reads for already returned source.
   - `callers`, `callees`, and `impact` include include-file and override paths
     where expected.

Recommended commands:

```bash
npm run build
npm test -- __tests__/resolution.test.ts
npm test -- __tests__/extraction.test.ts
```

For real-repo validation, reindex a C++ corpus such as LevelDB and inspect:

```sql
select count(*) from nodes where language = 'cpp';
select count(*) from edges where kind = 'extends';
select s.qualified_name, t.qualified_name, e.metadata
from edges e
join nodes s on s.id = e.source
join nodes t on t.id = e.target
where e.provenance = 'heuristic'
  and e.metadata like '%cpp-override%';
```

---

## Known limitations

- No compiler-grade type checking or overload resolution.
- No template instantiation.
- No preprocessor expansion.
- Pure virtual declarations without bodies are not method nodes today, so they
  cannot serve as the source side of `cpp-override` synthesis.
- C callback structs and function-pointer fields are intentionally not broadly
  synthesized yet; the fan-out can become too noisy without stronger type data.
- Macro-heavy code can still hide symbols if tree-sitter cannot recover a useful
  tree shape.
- Cross-file ownership for out-of-class method definitions is limited; method
  qualified names carry the receiver, but containment is strongest when the owner
  type appears in the same file.

---

## Related implementation files

- `src/extraction/grammars.ts`
- `src/extraction/languages/c-cpp.ts`
- `src/extraction/tree-sitter.ts`
- `src/resolution/import-resolver.ts`
- `src/resolution/index.ts`
- `src/resolution/callback-synthesizer.ts`
- `__tests__/resolution.test.ts`
- `docs/SEARCH_QUALITY_LOOP.md`
- [`dynamic-dispatch-coverage-playbook.md`](./dynamic-dispatch-coverage-playbook.md)
