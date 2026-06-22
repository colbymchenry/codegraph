# Qt Quick / QML Support Design

## Summary

Add first-class `.qml` language support to CodeGraph so Qt Quick projects can be indexed with practical static coverage. The first version targeted QML object trees plus embedded JavaScript behavior inside QML files. Follow-up closure extends that baseline with conservative QML module, dynamic-loading, and explicit C++/QML bridge relationships.

**Implementation status:** QML-internal graph generation, QML-side closure, `qmldir` module import scope, literal local dynamic loading, and explicit Qt bridge fact resolution are implemented. The extractor covers component trees, ids, properties, signals, functions, handlers, imports, embedded JavaScript static references, nested handler bodies, object-literal callbacks, function-valued callbacks, directory-local component references, typed QML property references, and conservative false-positive suppression for broad cross-file property/name matches. Runtime-built URLs, runtime-computed Qt registration metadata, full C++ overload resolution, moc-generated code execution, and QML JavaScript helper alias function resolution remain unsupported.

Local JavaScript helper imports such as `import "utils.js" as Utils` are indexed
as file-level imports. Cross-file resolution from QML member calls such as
`Utils.format(...)` to JavaScript function symbols remains out of scope for the
first version.

QML object type references are emitted for inline components declared in the
same `.qml` file with `component Name : ...`, directory-local component
references covered by the QML-side closure pass, and visible components from
explicit `qmldir` module registries. Common Qt Quick platform types and
same-named project files are not linked by broad name matching alone.

The goal is to make `codegraph_explore`, `codegraph_callers`, `codegraph_callees`, and `codegraph_impact` useful on real Qt Quick codebases by extracting:

- QML component trees
- `id`, `property`, `signal`, and `function` declarations
- signal handlers such as `onClicked`
- static property-binding references
- embedded JavaScript call edges inside functions, handlers, and bindings

## Confirmed decisions

The first QML version is a standard CodeGraph language integration, not a
special-case scanner. It follows the same structural path as the other
tree-sitter-backed languages:

```text
.qml files
  -> detectLanguage("qml")
  -> load QML tree-sitter WASM grammar
  -> TreeSitterExtractor + qmlExtractor (visitNode hook — see below)
  -> nodes / edges / unresolvedReferences
  -> ReferenceResolver
  -> GraphQuery / ContextBuilder / MCP tools
```

**Critical implementation constraint:** QML's declarative object tree has no
match in the standard `functionTypes`/`classTypes`/`methodTypes` field arrays.
The QML extractor **must** implement the `visitNode(node, ctx): boolean` hook
and return `true` for every handled QML node type. This is not optional — it
is the only viable dispatch path for this language.

Confirmed scope:

- QML is added as a normal source language.
- The implementation uses a real QML tree-sitter grammar.
- The implementation does not use a bespoke regex scanner or a separate
  QML-only pipeline.
- The first version focuses on QML-internal graph generation.
- C++/QML bridging is explicitly deferred.

Confirmed first-version non-goals, before the follow-up closure:

- No C++ `setContextProperty` to QML consumer resolution.
- No `qmlRegisterType` / `qmlRegisterSingletonType` to QML type resolution.
- No `Q_PROPERTY`, `Q_INVOKABLE`, or C++ signal bridge resolution.
- No binding runtime evaluation.
- No precise dynamic loading resolution for string-built `Loader.source`,
  `Qt.createComponent(url)`, or equivalent runtime URLs.

Follow-up closure now implements conservative static bridge resolution for
explicit Qt facts (`setContextProperty`, `qmlRegisterType`,
`qmlRegisterSingletonType`, `qmlRegisterUncreatableType`, `Q_PROPERTY`,
`Q_INVOKABLE`, public slots with Qt exposure evidence, and C++ signals) through
the normal unresolved-reference and framework-resolver pipeline. Runtime Qt
registration computation, moc execution, full overload resolution, and runtime
URL evaluation remain non-goals.

## Goals

- Recognize `.qml` as a supported source language.
- Parse QML with a tree-sitter-based WASM grammar that fits the existing extraction architecture.
- Index common Qt Quick structures without adding new database schema or graph edge kinds.
- Preserve the existing extraction pipeline shape: file detection, grammar loading, extractor dispatch, unresolved reference resolution, and test/documentation updates.

## Non-Goals

- No C++ to QML or QML to C++ bridge in this version.
- No complete runtime evaluation of bindings, dynamic object creation, or context-property injection.
- No full cross-file symbol resolution for QML importing external JS helpers or QML modules.
- No new graph node kinds or edge kinds specific to QML.

## Recommended Approach

Use a dedicated `qml` language backed by a QMLJS tree-sitter WASM grammar and a new `src/extraction/languages/qml.ts` extractor.

This is preferred over regex extraction, a custom standalone `QmlExtractor`, or
treating QML as JavaScript because:

- QML object trees are not JavaScript syntax and need structural AST support.
- Embedded JavaScript exists inside QML-specific containers, so extractor-owned traversal is simpler than trying to reuse the JavaScript extractor as a second parser pass.
- The repository already has a stable pattern for adding languages through `Language`, `EXTENSION_MAP`, grammar loading, extractor registration, tests, and documentation.
- A standalone extractor would make QML diverge from the language path used by
  C++, Java, TypeScript, and other grammar-backed languages.
- Regex or lightweight scanning would be too fragile for nested objects,
  handlers, bindings, inline components, and `Connections`.

## Architecture

### Language surface

Add `qml` to:

- `src/types.ts` — append `'qml'` to the `LANGUAGES` array **and** add
  `qml: 'QML'` to the `Record<Language, string>` inside
  `getLanguageDisplayName` (TypeScript enforces exhaustiveness — the compiler
  will flag every missing entry after you add `'qml'` to `LANGUAGES`, use
  those errors as a checklist)
- `src/extraction/grammars.ts` — add `qml: 'tree-sitter-qmljs.wasm'` to
  `WASM_GRAMMAR_FILES`, add `'.qml': 'qml'` to `EXTENSION_MAP`, and add
  `'qml'` to the vendored-path condition in `loadGrammarsForLanguages`
- `src/extraction/languages/qml.ts` — new extractor file (see
  [Extractor implementation](#extractor-implementation) below)
- `src/extraction/languages/index.ts` — add `qml: qmlExtractor` to the
  `EXTRACTORS` map
- `src/extraction/extraction-version.ts` — **bump `EXTRACTION_VERSION`** (a
  new language extractor always warrants a bump; existing indexes will not
  contain QML data and users need to re-index)
- supported-language documentation

`.qml` files should be treated as normal source files, not file-level-only files.

### Grammar integration

The grammar is **tree-sitter-qmljs**, vendored under
`src/extraction/wasm/tree-sitter-qmljs.wasm`.

**Why vendor:** every grammar CodeGraph has needed to vendor so far
(lua, csharp, pascal, scala) was blocked by the same ABI-13 vs ABI-15
incompatibility under `web-tree-sitter` 0.25. `@lumis-sh/wasm-qmljs` ships
ABI-13 and is expected to exhibit the same issue. Treat vendoring as the
default plan; Phase 0 confirms or refutes it.

To vendor:
1. Build or download the ABI-15 WASM from the upstream
   [`tree-sitter-qmljs`](https://github.com/nickel-lang/tree-sitter-qmljs)
   repository.
2. Place it at `src/extraction/wasm/tree-sitter-qmljs.wasm`.
3. `copy-assets` (called by `npm run build`) automatically copies every
   `*.wasm` under `src/extraction/wasm/` into `dist/` — no script change
   needed as long as the file is in that directory.
4. Add `'qml'` to the vendored-path condition in `loadGrammarsForLanguages`
   inside `src/extraction/grammars.ts`.

If Phase 0 confirms that `@lumis-sh/wasm-qmljs` loads cleanly under
`web-tree-sitter` 0.25, replace the vendored file with a
`require.resolve('@lumis-sh/wasm-qmljs/...')` call and remove `'qml'` from
the vendored-path condition.

## Extractor implementation

### visitNode hook — mandatory pattern

QML extraction **must** use the `visitNode(node, ctx): boolean` hook. All
field arrays (`functionTypes`, `classTypes`, etc.) are left empty. The hook
returns `true` for every handled QML node type to skip the default dispatcher,
and `false` for unknown nodes so the default dispatcher still walks their
children.

```typescript
visitNode(node, ctx): boolean {
  switch (node.type) {
    // Verify these type strings against the real AST in Phase 0
    case 'ui_object_definition':
    case 'ui_object_binding':
      extractQmlComponent(node, ctx);
      return true;
    case 'ui_property':
      extractQmlProperty(node, ctx);
      return true;
    case 'ui_signal':
      extractQmlSignal(node, ctx);
      return true;
    case 'ui_on_signal_handler':
      extractQmlHandler(node, ctx);
      return true;
    case 'function_declaration':
      extractQmlFunction(node, ctx);
      return true;
    case 'ui_import':
      extractQmlImport(node, ctx);
      return true;
    default:
      return false;
  }
}
```

### Scope management — pushScope / popScope

`isInsideClassLikeNode()` checks the top of the `nodeStack` to decide whether
a property or method node belongs to a class-like parent. `component` is now
included in that check (alongside `class`, `struct`, etc.). For this to work,
every `extractQmlComponent` call must bracket its child traversal with scope
management:

```typescript
function extractQmlComponent(node, ctx) {
  const id = ctx.createNode('component', name, ...);
  ctx.pushScope(id);
  // visit children — their property/method nodes now see 'component' as parent
  for (let i = 0; i < node.namedChildCount; i++) {
    ctx.visitNode(node.namedChild(i)!);
  }
  ctx.popScope();
}
```

Without `pushScope`/`popScope`, nested properties and methods will not be
associated with the component and will be silently dropped.

### visitFunctionBody — ownerNodeId is required

When traversing a handler or embedded function body for `calls` edges, the
second argument to `ctx.visitFunctionBody` **must** be the owning node's ID:

```typescript
function extractQmlHandler(node, ctx) {
  const handlerId = ctx.createNode('method', 'onClicked', ...);
  const body = node.childForFieldName('body') ?? node;
  ctx.visitFunctionBody(body, handlerId);  // ownerNodeId MUST be passed
}
```

Omitting `ownerNodeId` (or passing `''`) attributes all discovered call edges
to the file node rather than the handler, making `codegraph_callees(onClicked)`
return empty.

### Node naming

- Top-level QML component: basename of the file without extension
  (`LoginPage.qml` → `LoginPage`).
- Objects with an explicit `id`: use the id value.
- Anonymous objects: `${typeName}@${startLine}` (e.g. `Rectangle@42`).

**Node ID stability note:** `generateNodeId` encodes `startLine` in every
node ID for all languages. IDs for anonymous objects will drift whenever lines
above them are inserted or removed. An explicit `id` declaration prevents this
for that specific node but not for sibling anonymous objects. This is a
known limitation of the current ID scheme, not a QML-specific bug.

## Graph Model

### Nodes

| QML structure | Node kind | Notes |
|---|---|---|
| `.qml` file | `file` | Created by the common extractor path. |
| QML object / component instance | `component` | Examples: `ApplicationWindow`, `Rectangle`, `MouseArea`, `Connections`. |
| `id: root` | `variable` | Kept as a queryable symbol even when the object node also uses the id for naming. |
| `property int count` | `property` | Includes `readonly`, `required`, and `default` property forms when the grammar exposes them. |
| `signal accepted(...)` | `method` | Existing schema has no `signal` kind; `method` is closest to a callable member. |
| `function reload()` | `function` | Embedded JavaScript function owned by the containing component. |
| `onClicked: ...` | `method` | Signal handlers are method-shaped members of the containing component. |
| `Component.onCompleted: ...` | `method` | Attached handlers keep the attached prefix in the node name. |
| `import QtQuick` / `import Login 1.0` | `import` | Produces an import node plus an unresolved import reference. |

### Edges

- object nesting: `contains`
- component-owned `id`, `property`, `signal`, `function`, and handler symbols:
  `contains`
- imports: `imports`
- embedded JavaScript calls: `calls`
- `id`, property, handler target, binding, `Connections.target`, `Loader`
  source-component, and other static name reads: `references`
- QML component instantiation: initially `references`, not `instantiates`

QML component instantiation intentionally starts as `references`. QML type names
can refer to Qt built-ins, imported module types, or project-local QML files.
Without a QML module registry in the first version, `references` is the more
honest edge. A later module-resolution pass may promote project-local component
uses to `instantiates`.

Node naming:

- The top-level QML component prefers the file basename, e.g.
  `LoginPage.qml` -> `LoginPage`.
- Object nodes prefer an explicit `id` when present.
- Anonymous objects use the QML type plus source location, e.g.
  `Rectangle@42`.
- Qualified names include file path and object nesting so sibling anonymous
  objects do not collide.

No new `binding` or `signal_connection` edge kind is added in this phase.

## Extraction Rules

### Object tree

Top-level objects such as `Item {}` or `Rectangle {}` become `component` nodes.

Nested objects such as `MouseArea {}` or `Text {}` also become `component` nodes, linked to their parent object with `contains`.

Node naming:

- prefer explicit `id` when present
- otherwise use the QML type name
- qualified names include file path and object nesting so sibling anonymous objects remain distinct

### `id`

`id: foo` creates a `variable` node scoped to the containing object. Static uses of `foo` inside the same file emit unresolved references that later resolve through the normal resolver path.

The object node may also use `foo` as its display name, but the `variable` node
is still emitted so `codegraph_search` can find ids such as `root` or
`mainStack` directly.

### `property`

Declarations such as `property int count: 1` and `required property string title` create `property` nodes.

Initializer and binding expressions are traversed for:

- `calls` edges when a function call is statically visible
- `references` edges for identifiers, member roots, and target objects that can be named statically

Bindings do not get their own node kind in this version. The dependency edges originate from the owning `property` node.

### `signal`

Signals such as `signal accepted(string name)` create `method` nodes attached to the containing component.

This keeps them close to handlers like `onAccepted` without expanding the schema.

### QML functions

Embedded JavaScript functions such as:

```qml
function reloadData() {
  backend.fetch()
  updateState()
}
```

create `function` nodes. Their bodies are walked for static JavaScript calls and name references.

### Signal handlers

Handlers such as:

```qml
onClicked: doThing()
onPressed: {
  prepare()
  count = count + 1
}
```

create `method` nodes named after the handler, such as `onClicked` or `onPressed`, owned by the containing component.

Attached handlers such as `Component.onCompleted` keep the full handler name so
they remain distinguishable from ordinary `onCompleted`-style local handlers.

Their expression or block bodies are traversed for:

- `calls` edges to statically named functions
- `references` edges to `id`s, properties, and other resolvable names

### `Connections`

For:

```qml
Connections {
  target: backend
  function onDone() { refresh() }
}
```

extract:

- `Connections` as a `component`
- `target: backend` as a `references` edge
- handler functions such as `onDone` as `method` nodes with body traversal for `calls` and `references`

### Anonymous components and delegates

Support common inline forms such as:

- `Component { ... }`
- `delegate: Item { ... }`
- `Loader { sourceComponent: rowDelegate }`

Inline objects still become `component` nodes in the containment tree. Static names like `rowDelegate` emit `references`.

### Additional QML base syntax coverage

The first version should cover the practical QML language surface used by normal
Qt Quick projects, while still avoiding runtime evaluation.

Covered as first-version syntax:

- `property alias name: target.property`
- grouped properties such as `font { pixelSize: 14 }`
- attached properties such as `Layout.fillWidth: true`
- typed/list properties such as `property list<Item> items`
- inline components such as `component PrimaryButton: Button { ... }`
- QML enums such as `enum Mode { Light, Dark }`
- pragmas such as `pragma Singleton` and `pragma ComponentBehavior: Bound`
- JavaScript imports such as `import "utils.js" as Utils`
- state and transition object trees such as `State { ... }` and
  `Transition { ... }`

Graph treatment:

- `property alias` creates a `property` node and a `references` edge to the
  aliased target when the target is static.
- grouped and attached properties are not new node kinds; their expressions are
  scanned for static references and calls.
- inline components create `component` nodes named by their inline component
  identifier.
- QML enum declarations create `enum` nodes and enum members create
  `enum_member` nodes when the grammar exposes member ranges.
- pragmas are not graph nodes by default. `pragma Singleton` may be recorded in
  the top-level component node metadata/decorators if it is easy to expose
  through the existing `Node.decorators` field.
- JavaScript imports create `import` nodes. Static calls like `Utils.format()`
  emit unresolved `calls` references; full JS helper-file binding is deferred.
- states and transitions are treated as ordinary `component` subtrees with
  static binding/reference extraction.

`qmldir` files are not part of first-version `.qml` parsing. They can be
recognized later as a lightweight module registry input when QML module
resolution becomes part of the scope.

## JavaScript Handling Inside QML

This version supports embedded JavaScript inside QML files.

Supported shapes:

- `function foo() { ... }`
- handler expressions and blocks
- property-binding expressions with static identifiers and calls

First-version extraction is static and conservative:

- `foo()` emits a `calls` reference to `foo`.
- `obj.foo()` emits a `calls` reference to `obj.foo` and a `references`
  reference to `obj`.
- `root.title` emits a `references` reference to the static root/member name.
- `modelData.id`, `parent.width`, and similar framework-provided names may be
  recorded as references, but are not force-resolved to project symbols unless
  the target is explicit.
- Dynamic member calls such as `viewModel[methodName]()` are not resolved to a
  concrete method.
- String-built component URLs are not resolved to files in this version.

Implementation guidance:

- the QML extractor identifies AST subtrees that contain embedded JavaScript
- those subtrees are traversed in-place by QML-specific logic using shared helper patterns where possible
- do not run a separate whole-file JavaScript parser over the QML source

This keeps source locations, scope ownership, and node attribution aligned with the surrounding QML object model.

## Data Flow

1. `detectLanguage()` maps `.qml` to `qml`
2. grammar loader loads the QMLJS WASM grammar
3. tree-sitter parses the file
4. `qml` extractor emits standard `nodes`, `edges`, and `unresolvedReferences`
5. the existing resolver attempts to resolve static names inside the file and any import-like references already supported by the generic resolver
6. graph queries and MCP tools consume the resulting graph with no QML-specific changes

## Resolver Scope

The first resolver scope is intentionally conservative. It should make
single-file QML structure and static references useful without pretending to
understand Qt runtime registration or C++ context injection.

Supported in the first version:

- same-file `id` references, such as `root.title` and `mainStack.push(...)`
- same-file QML function calls, such as `submit()` to `function submit`
- same-file signal handlers referencing local functions, properties, ids, or
  component-local symbols
- QML import nodes and unresolved import refs for `import Login 1.0` and
  `import QtQuick.Controls`
- JavaScript helper imports such as `import "utils.js" as Utils`, represented as
  import nodes plus unresolved calls/references for static uses like
  `Utils.format()`

Explicitly unsupported in the first version, before follow-up closure:

- C++ `setContextProperty` to QML consumer resolution
- `qmlRegisterType` / `qmlRegisterSingletonType` to QML type resolution
- `Q_INVOKABLE`, `Q_PROPERTY`, or C++ signal bridge resolution
- `qmldir` to concrete QML type resolution
- dynamic `Loader.source`, `Qt.createComponent(url)`, or string-built component
  URLs
- cross-file QML module URI resolution unless a later QML module registry design
  introduces it explicitly

Follow-up closure now resolves explicit `qmldir` module components, literal
local `Loader.source` and `Qt.createComponent("...qml")` targets, and explicit
Qt bridge facts. The target behavior remains conservative: static graph edges
resolve when the target is visible and unambiguous; runtime-built URLs,
runtime-computed bridge metadata, and JavaScript helper alias calls remain as
unresolved references or conservative import/reference facts.

## Error Handling

- If the QML grammar fails to load, treat `qml` the same way other unavailable grammars are handled now: emit a warning and leave parsing unavailable.
- If a QML construct is unsupported, skip only that construct and continue extracting the rest of the file.
- Keep extraction conservative. Missing an edge is acceptable; inventing a false edge across components is worse.
- If a file has parse errors, record an `ExtractionError` for that file and
  continue indexing other files.
- If a QML AST node is unknown, skip special handling for that node but continue
  walking children where possible.
- For framework-provided names such as `parent`, `model`, `modelData`, `Qt`, and
  `Math`, avoid fuzzy resolution to project-local symbols. These names may be
  recorded as references, but should not be forced into unrelated graph targets.

## Testing Strategy

### Unit tests

- `.qml` detection through `detectLanguage('Foo.qml')`
- `isLanguageSupported('qml')`
- `getSupportedLanguages()` includes `qml`
- `isSourceFile('Foo.qml')`
- `getLanguageDisplayName('qml')`
- grammar load path behaves correctly

### Extraction tests

Cover minimal fixtures for:

- top-level object extraction
- nested object containment
- `id` extraction and intra-file references
- `property` declarations and binding references
- `signal` declarations
- embedded `function` extraction with `calls`
- `onXxx` handler extraction with `calls` and `references`
- `Connections` target and handler extraction
- inline `Component`, `delegate`, and `Loader.sourceComponent`
- `property alias`
- grouped and attached properties
- inline component declarations
- QML enums
- pragmas, especially `pragma Singleton`
- JavaScript helper imports such as `import "utils.js" as Utils`
- `State` and `Transition` object trees

Assertions should verify:

- node kinds and names
- qualified names and ownership
- `contains`, `calls`, and `references` edges
- no regression in unsupported-file filtering

### Integration tests

Create a small Qt Quick sample project and verify that:

- `explore` can surface the object tree and embedded behavior
- `callers` finds handlers or functions that reference a target symbol
- `impact` reaches bindings and handlers that depend on a changed property or function

Suggested fixture:

```text
Main.qml
LoginPage.qml
Controls/PrimaryButton.qml
utils.js
```

The fixture should validate that `CodeGraph.indexAll()` stores `.qml` files,
creates `component`, `property`, `function`, and `method` nodes, preserves the
`contains` tree, and lets `callers` / `callees` / `impact` traverse from a QML
handler to a QML function or property dependency.

## Delivery Phasing

This phasing section is retained as historical first-version implementation
guidance. Phases 0-3 are complete for QML-internal graph generation and
QML-side closure; remaining follow-up work is tracked in the follow-up task
plan and closure design.

### Phase 0: AST exploration and grammar decision

Confirm the real QML grammar AST before implementing extraction rules.

Work:

- run focused AST dumps for representative QML snippets
- cover objects, imports, properties, aliases, signals, handlers,
  `Connections`, inline components, enums, and pragmas
- verify that the selected QMLJS WASM grammar loads under `web-tree-sitter`
- decide whether to load from `@lumis-sh/wasm-qmljs/tree-sitter-qmljs.wasm` or
  vendor the WASM under `src/extraction/wasm/` (default assumption: vendor,
  due to ABI-13 incompatibility history — see Grammar integration)

Acceptance:

- AST node type strings are recorded for **every** first-version syntax
  construct (objects, properties, signals, handlers, imports, enums, pragmas,
  inline components, `Connections`, `property alias`). These strings are the
  switch-case keys in `visitNode` — do not start Phase 2 without them.
- `npm run build` succeeds with the WASM in place and
  `dist/extraction/wasm/tree-sitter-qmljs.wasm` is present in the build output
- Grammar loading path is verified: `isLanguageSupported('qml')` returns `true`
  and `loadGrammarsForLanguages(['qml'])` completes without error
- Grammar packaging decision is documented and testable

### Phase 1: language wiring

- add `qml` language wiring (see Language surface checklist above)
- integrate QMLJS grammar (vendor under `src/extraction/wasm/` by default)
- add a `src/extraction/languages/qml.ts` extractor skeleton with the
  `visitNode` hook wired but returning `false` (Phase 1 — no extraction yet)
- register the extractor in `src/extraction/languages/index.ts`
- **bump `EXTRACTION_VERSION`** in `src/extraction/extraction-version.ts` —
  adding a new language extractor requires a re-index of existing projects
- add a `[Unreleased]` CHANGELOG entry describing QML support
- add unit tests for language detection and grammar support

Acceptance:

- `.qml` is detected as `qml`
- `.qml` is treated as a source file
- `qml` is reported as supported
- the grammar loads successfully
- a minimal `Item {}` file produces a `file` node and a top-level
  `component` node

### Phase 2: QML structure extraction

Extract the first-version QML syntax surface:

- object trees and nested components
- `id`
- `property`, `property alias`, `required property`, and `readonly property`
- `signal`
- embedded QML `function`
- signal handlers and attached handlers
- QML imports and JavaScript helper imports
- inline components
- QML enums
- `Connections`
- `Loader.sourceComponent`, delegates, states, and transitions

Acceptance:

- extraction tests cover every listed construct
- node naming and qualified names are stable
- `contains` edges preserve the QML object tree
- unsupported or unknown AST nodes do not abort extraction of the rest of the
  file

### Phase 3: static QML calls and references

Make QML-internal relationships useful to graph queries.

Work:

- extract `calls` from binding expressions, functions, and handlers
- extract `references` from binding expressions, functions, handlers,
  `Connections.target`, and static loader/delegate references
- resolve same-file ids, functions, properties, and handler-owned symbols where
  the target is visible and unambiguous
- guard framework-provided names such as `parent`, `model`, `modelData`, `Qt`,
  and `Math` from noisy project-local fuzzy resolution
- add an end-to-end Qt Quick fixture

Acceptance:

- `onClicked -> submit()` appears in callees
- callers of `submit()` include the handler
- impact on a QML property or function can reach dependent bindings or handlers
- no obvious false edges are created from Qt built-ins to unrelated project
  symbols

## Success Criteria

QML base graph support is complete when:

- `.qml` files are indexed as source files
- common QML files produce stable component trees
- QML ids, properties, functions, signals, handlers, and imports are searchable
- static QML-internal calls and references are represented in the graph
- `codegraph_explore` can explain a QML page structure and local interaction
  chain
- `codegraph_callers`, `codegraph_callees`, and `codegraph_impact` have practical
  value for QML-internal relationships
- the base implementation does not claim complete Qt runtime or C++ meta-object
  closure

## Open Risks

- The chosen grammar may expose AST shapes that do not align cleanly with current extractor expectations.
- QML bindings mix declarative object syntax with embedded JavaScript, so call extraction must be careful about scope and ownership.
- Over-resolving common names such as `parent`, `model`, or framework-provided pseudo-properties could create noisy false edges. These should remain conservative unless the static target is explicit.
- Some Qt Quick project flows remain unresolved because runtime-computed
  registration metadata, moc-generated code, runtime URLs, full overload
  resolution, and JavaScript helper alias function resolution are intentionally
  out of scope.
