# QML Follow-up Closure Design

## Summary

Close the remaining QML graph support work without leaving CodeGraph's normal
pipeline. The follow-up is not just C++/QML bridging. It covers documentation
hygiene, read-only real-project validation, QML module/import scope,
statically safe dynamic QML loading, C++/QML bridge modeling, tests, and release
notes.

The implementation must stay on the existing graph-tool path:

```text
files
  -> ExtractionOrchestrator / TreeSitterExtractor / framework extractors
  -> nodes, edges, unresolvedReferences
  -> ReferenceResolver / framework resolvers / finalization
  -> persisted graph edges
  -> GraphQueryManager / GraphTraverser / ContextBuilder
  -> CLI / MCP tools
```

No QML-only query path, side database, direct MCP special case, or broad
post-query name matching should be introduced.

## Current Facts

Recently completed QML-side work closed the extraction/resolution gaps inside
QML files and directory-local QML usage:

- base `.qml` language wiring and grammar support
- QML component trees, ids, properties, signals, functions, handlers, imports
- embedded JavaScript static references and calls
- nested handler bodies, function-valued handlers, object-literal callbacks,
  formatter callbacks, and function callbacks passed as call arguments
- directory-local component type references
- suppression of broad cross-file property/name matches, such as accidental
  `text` property links

The follow-up document still leaves these items open:

- workspace and documentation hygiene
- more deliberate real-project validation
- `qmldir` and QML module/import scope
- dynamic QML loading
- C++/QML bridge design and implementation
- changelog/release notes

Existing validation notes include some QML-to-C++ ViewModel call edges that
resolved through generic graph behavior. Those are useful evidence, but they
are not a bridge design. The proper bridge must consume explicit Qt exposure
facts and resolve QML references through those facts.

## Non-negotiable Architecture Constraints

- QML extraction remains a normal `LanguageExtractor`.
- Qt-specific bridge facts are represented as standard graph facts or
  resolver/framework metadata consumed by `ReferenceResolver`.
- New relationships are emitted as existing edge kinds: `references`, `calls`,
  `imports`, or existing structural edges when appropriate.
- No schema changes unless a later review proves existing edge/node kinds cannot
  represent a required relationship.
- No runtime evaluation of QML, JavaScript, or C++.
- A missing edge is preferable to a fabricated edge.
- `test-qml-project/` is validation-only. Do not modify, stage, or commit files
  under it.

## Phase 0: Workspace and Documentation Baseline

Before implementing any behavior, update project documentation so it matches
the actual current state.

Required documentation outcomes:

- The original QML design document distinguishes completed QML-side graph
  support from still-deferred module, dynamic loading, and bridge work.
- The follow-up plan records that QML-side closure has landed, while
  `qmldir`, dynamic loading, bridge work, validation, and release notes remain.
- Pre-existing dirty files are either left untouched or explicitly separated
  from follow-up implementation commits.

This phase should not change runtime code.

## Phase 1: Read-only Real-project Validation

Use `test-qml-project/` only as input. Validation output must be written outside
that directory.

Validation should classify observed graph gaps by mechanism:

- QML-side extraction or same-file resolution
- directory-local or `qmldir` import scope
- dynamic component loading
- C++/QML bridge
- JavaScript helper import resolution
- false-positive suppression

For each selected sample, record:

- indexed file counts and language mix
- QML node and edge counts
- representative successful chains
- representative missing chains
- suspicious or false-positive edges, if any
- whether each missing chain belongs to an already-closed QML-side category or
  a still-open follow-up category

This phase produces evidence and acceptance criteria for the later phases.

## Phase 2: QML Module and Import Scope

This phase resolves QML component references through explicit QML import scope.
It must not use broad same-name matching.

Supported inputs:

- directory-local imports already represented by QML import nodes
- module URI imports, such as `import My.Controls 1.0`
- aliased module imports, such as `import My.Controls 1.0 as Controls`
- `qmldir` files as lightweight module registry inputs
- explicit component rows, singleton rows, and versioned rows where the target
  is a concrete `.qml` file

Resolution behavior:

- `FancyButton {}` resolves to a top-level QML component only when the
  component is visible in local/import scope.
- `Controls.FancyButton {}` resolves only when `Controls` is an alias for a
  matching imported module.
- Qt built-in component names do not resolve to project files by name alone.
- `qmldir internal` entries are not externally visible.
- malformed or plugin-only `qmldir` rows are ignored.

Pipeline placement:

- QML extractor emits ordinary unresolved `references` for component type
  usage.
- `ReferenceResolver` or a QML framework resolver builds a cached module
  registry from indexed files and file contents.
- Resolution returns normal `ResolvedRef` objects with `resolvedBy: 'import'`
  or another existing resolver provenance.

Tests:

- positive module URI resolution
- positive alias resolution
- negative built-in collision
- negative `qmldir internal`
- negative unimported module component
- version handling documented by tests, even if versions are initially treated
  as non-disambiguating metadata

## Phase 3: Dynamic QML Loading

This phase handles statically safe dynamic component references only.

Supported:

- `Loader { source: "Panel.qml" }`
- `Qt.createComponent("Panel.qml")`
- `Loader.sourceComponent: localComponent` when it is already representable as
  a static QML reference

Unsupported:

- `"Panel" + name + ".qml"`
- variables, property references, or function return values used as URLs
- remote URLs and scheme URLs
- absolute paths outside the project
- runtime-generated component objects

Pipeline placement:

- The QML extractor emits unresolved `references` for literal local `.qml`
  targets.
- The resolver normalizes the target relative to the source file and resolves
  only to a top-level QML component in that file.
- Non-literal forms remain unresolved references or are skipped if emitting them
  would create noise.

Tests:

- literal `Loader.source` resolves
- literal `Qt.createComponent` resolves
- string-built URL does not resolve
- non-loader `source: "Panel.qml"` does not become a QML component load
- absolute/scheme URLs do not resolve

## Phase 4: C++/QML Bridge

This phase must be designed as a resolver/framework bridge input layer, not as
ad hoc QML name matching.

### Bridge Inputs

The bridge registry should consume explicit Qt exposure facts from C++ source
and existing C++ graph symbols:

- `qmlRegisterType<T>(uri, major, minor, qmlName)`
- `qmlRegisterSingletonType<T>(uri, major, minor, qmlName, ...)`
- `qmlRegisterUncreatableType<T>(uri, major, minor, qmlName, reason)`
- `setContextProperty(name, object)`
- `setContextObject(object)` only when the object type is statically known
- `Q_PROPERTY(type name READ ... WRITE ... NOTIFY ...)`
- `Q_INVOKABLE` methods
- public slots where the parser can identify them conservatively
- signals

The first implementation may stage these inputs, but the design should treat
them as one bridge model so later work does not need to replace the foundation.

### Bridge Registry Model

The registry should answer these questions:

- Which QML module URI/name/version exposes which C++ class?
- Which QML singleton name exposes which C++ class?
- Which context property name maps to which C++ class?
- Which C++ members are QML-visible methods?
- Which C++ members are QML-visible properties?
- Which C++ signals are QML-visible?

The registry can be an in-memory resolver cache derived from indexed files. It
does not need a new persistent table unless repeated validation shows a runtime
or memory problem.

### QML Reference Resolution

Bridge resolution should connect only through explicit registry facts:

- `MyType {}` -> registered C++ class
- `Singleton.method()` -> registered singleton visible method
- `viewModel.method()` -> context property visible method
- `viewModel.someProperty` -> `Q_PROPERTY`
- `onSomeSignal` and `Connections { function onSomeSignal() {} }` -> signal
- `onSomePropertyChanged` may connect to property notify metadata when the
  `Q_PROPERTY` declaration explicitly names that notify signal

Avoid treating arbitrary same-name C++ methods as bridge targets.

### Bridge Non-goals

- full overload resolution
- runtime-computed registration metadata
- runtime object ownership or lifetime analysis
- executing moc-generated code
- discovering arbitrary wrapper helpers unless they are separately designed as
  conservative framework patterns
- resolving QML references that do not have a statically known receiver

Tests:

- context property method positive and same-name negative
- context property `Q_PROPERTY` positive
- registered type component positive and unimported negative
- registered singleton method/property positive
- `Q_INVOKABLE` positive and non-invokable/private method negative
- signal handler / `Connections` positive and same-name negative
- `qmlRegisterUncreatableType` creates a type reference but not an
  instantiable component unless the design explicitly allows it

## Phase 5: JavaScript Helper Imports

The existing QML design leaves `import "utils.js" as Utils` to JavaScript
function resolution out of scope. This closure plan should keep it separate
from the Qt bridge work.

Recommendation: do not include JS helper symbol resolution in the first
follow-up implementation. Record it as a future enhancement unless validation
shows it blocks the main QML workflows more than module scope or C++ bridge
gaps.

## Phase 6: Release Notes

Release notes should be written only after tests and validation establish the
actual landed behavior.

The changelog should state:

- what static QML relationships are now connected
- which Qt bridge inputs are supported
- which dynamic loading forms are supported
- which runtime or ambiguous forms remain unsupported

Avoid wording that claims complete Qt runtime or meta-object closure.

## Implementation Ordering

Recommended order:

1. documentation baseline
2. read-only validation baseline
3. QML module/import scope
4. dynamic QML loading
5. C++/QML bridge registry and resolution
6. validation rerun
7. release notes

Module/import scope should come before dynamic loading because dynamic loading
also needs path/import visibility rules. The bridge should come after those
because it has the highest false-positive risk and should not be mixed with
QML-side closure.

## Acceptance Criteria

- Documentation accurately separates completed QML-side work from remaining
  follow-up work.
- Validation notes are updated without modifying `test-qml-project/`.
- QML module/import scope resolves only explicit visible components.
- Dynamic QML loading resolves only literal local safe targets.
- C++/QML bridge resolution uses explicit bridge registry facts.
- False-positive tests cover built-in QML names, generic property names, and
  same-name C++ methods/classes.
- Existing MCP and graph tools benefit through normal persisted graph edges,
  with no QML-specific output path.
- `npm run build` and targeted Vitest suites pass after implementation.

## Confirmed Design Decisions

- `qmlRegisterUncreatableType` creates type-reference bridge facts only. It
  should not make `SomeType {}` look like a valid instantiable QML component.
  Static type/member references can resolve to the C++ class, but QML object
  instantiation should remain unresolved or be treated as an invalid usage.
- QML import versions are recorded, but the first implementation should not use
  strict version matching unless multiple candidates share the same module URI
  and component name. In the common single-candidate case, URI/name matching is
  enough. When multiple versioned candidates exist, use the import version to
  disambiguate; if versions are missing or incomparable, do not guess.
- Public slots are QML-visible only when the class has Qt meta-object exposure
  evidence, such as `Q_OBJECT`, Qt macro sections, registration through
  `qmlRegister*`, context exposure through `setContextProperty` /
  `setContextObject`, `Q_PROPERTY`, `Q_INVOKABLE`, signals, or slots. Plain C++
  public methods are not bridge targets by name alone.
- QML JavaScript helper alias resolution stays out of this closure plan.
  `import "utils.js" as Utils` remains a file-level dependency; resolving
  `Utils.format()` to a JavaScript function is a future enhancement outside the
  Qt/QML module, dynamic loading, and C++ bridge work.
