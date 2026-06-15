# Qt Quick / QML Support Design

## Summary

Add first-class `.qml` language support to CodeGraph so Qt Quick projects can be indexed with practical static coverage. The first version targets QML object trees plus embedded JavaScript behavior inside QML files. It does not attempt C++/QML bridging.

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
  -> TreeSitterExtractor + qmlExtractor
  -> nodes / edges / unresolvedReferences
  -> ReferenceResolver
  -> GraphQuery / ContextBuilder / MCP tools
```

Confirmed scope:

- QML is added as a normal source language.
- The implementation uses a real QML tree-sitter grammar.
- The implementation does not use a bespoke regex scanner or a separate
  QML-only pipeline.
- The first version focuses on QML-internal graph generation.
- C++/QML bridging is explicitly deferred.

Confirmed first-version non-goals:

- No C++ `setContextProperty` to QML consumer resolution.
- No `qmlRegisterType` / `qmlRegisterSingletonType` to QML type resolution.
- No `Q_PROPERTY`, `Q_INVOKABLE`, or C++ signal bridge resolution.
- No binding runtime evaluation.
- No precise dynamic loading resolution for string-built `Loader.source`,
  `Qt.createComponent(url)`, or equivalent runtime URLs.

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

- `src/types.ts` language union
- `src/extraction/grammars.ts` extension detection and grammar loading
- `src/extraction/languages/index.ts` extractor registry
- supported-language documentation and extraction-version metadata

`.qml` files should be treated as normal source files, not file-level-only files.

### Grammar integration

Evaluate the QMLJS grammar shipped as a WASM artifact, with `@lumis-sh/wasm-qmljs` as the leading candidate and `tree-sitter-qmljs` as the grammar source reference.

The integration requirements are:

- compatible with `web-tree-sitter`
- stable AST node names for QML object declarations, property declarations, handlers, and embedded JavaScript expressions or blocks
- distributable through the existing bundle/copy-assets path

If the upstream package shape does not match the current grammar loader expectations, vendor the `.wasm` file under `src/extraction/wasm/` the same way this repo already does for languages that need custom packaging.

## Graph Model

First version stays within the existing graph schema.

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

Explicitly unsupported in the first version:

- C++ `setContextProperty` to QML consumer resolution
- `qmlRegisterType` / `qmlRegisterSingletonType` to QML type resolution
- `Q_INVOKABLE`, `Q_PROPERTY`, or C++ signal bridge resolution
- `qmldir` to concrete QML type resolution
- dynamic `Loader.source`, `Qt.createComponent(url)`, or string-built component
  URLs
- cross-file QML module URI resolution unless a later QML module registry design
  introduces it explicitly

The target behavior is: QML-internal static graph edges resolve when the target
is visible and unambiguous; cross-module and cross-language relationships remain
as unresolved references or conservative import/reference facts.

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

### Phase 0: AST exploration and grammar decision

Confirm the real QML grammar AST before implementing extraction rules.

Work:

- run focused AST dumps for representative QML snippets
- cover objects, imports, properties, aliases, signals, handlers,
  `Connections`, inline components, enums, and pragmas
- verify that the selected QMLJS WASM grammar loads under `web-tree-sitter`
- decide whether to load from `@lumis-sh/wasm-qmljs/tree-sitter-qmljs.wasm` or
  vendor the WASM under `src/extraction/wasm/`

Acceptance:

- AST node names and field shapes are known for the first-version syntax set
- the grammar loading path is known and testable
- grammar packaging risk is resolved before extraction logic is built

### Phase 1: language wiring

- add `qml` language wiring
- integrate QMLJS grammar
- add a `src/extraction/languages/qml.ts` extractor skeleton
- register the extractor in `src/extraction/languages/index.ts`
- update supported-language display and extraction-version metadata
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
- the implementation does not claim C++/QML cross-language closure

## Open Risks

- The chosen grammar may expose AST shapes that do not align cleanly with current extractor expectations.
- QML bindings mix declarative object syntax with embedded JavaScript, so call extraction must be careful about scope and ownership.
- Over-resolving common names such as `parent`, `model`, or framework-provided pseudo-properties could create noisy false edges. These should remain conservative unless the static target is explicit.
- The first version may leave important Qt Quick project flows unresolved because
  C++ context properties and registered QML types are intentionally out of scope.
