# QML Graph Support Follow-up Tasks

## Context

The first QML graph generation version is implemented for QML-internal graph
coverage. It uses the normal tree-sitter `LanguageExtractor` pipeline and keeps
C++/QML bridge resolution, `qmldir` module resolution, and dynamic component URL
resolution deferred.

`test-qml-project/` may be used for validation, but files under that directory
must not be staged or committed.

## Priority 1: Workspace and Documentation Hygiene

- Review the remaining dirty or untracked workspace files and decide which
  should be kept, split, or discarded in separate commits.
- Keep unrelated pre-existing changes out of QML implementation commits.
- Update QML design documentation so it matches current behavior:
  - top-level component names come from the `.qml` file basename
  - object `id` bindings are still indexed as `variable` nodes
  - `Connections.target` supports member-expression references
  - same-file inline component type references are supported
  - local JavaScript helper imports are file-level dependencies
  - cross-file QML component resolution remains deferred

## Priority 2: Real-project Validation

- Run CodeGraph against `test-qml-project/` and capture validation notes outside
  that directory.
- Validate at least:
  - `.qml` file detection and indexing
  - component tree extraction
  - handler-to-function call chains
  - property and id references
  - same-file inline component references
  - local JavaScript helper imports
  - absence of obvious false edges from Qt built-in component names to same-named
    project files

### Validation Note: `eager_base_tree`

Validation was run against a temporary copy of:

```text
test-qml-project/unifiedpromax/src/components/general/eager_base_tree
```

The source directory was not modified or staged. The full `unifiedpromax` tree
and full `src/` subtree were too large for a quick validation pass in this
session, so validation was scoped to one representative `src/components/general`
submodule as agreed.

Observed result from the temporary copy:

- Indexed files: 52
- Languages: 36 C/C++ files, 16 QML files
- QML component nodes: 124
- QML property nodes: 250
- QML variable/id nodes: 39
- QML method nodes: 54
- QML function nodes: 29
- QML import nodes / import edges: 74
- QML call edges from QML-owned nodes: 26
- QML reference edges from QML-owned nodes: 894
- Sample top-level QML components found:
  - `TreeActionButton`
  - `TreeDialogScaffold`
  - `TreeNodeRow`
  - `TreeSearchBar`
  - `TreePanelHeader`

This validates that the current QML extractor can index a real Qt Quick
submodule and produce searchable component, property, id, method/function,
import, call, and reference graph facts without relying on C++/QML bridge
support.

## Priority 3: QML Module and Import Scope Design

- Design `qmldir` and QML import scope support before enabling cross-file QML
  component type resolution.
- Model directory-local components, module URI imports, aliases, and versioned
  imports conservatively.
- Add regression tests that prevent same-name built-in/project-file collisions.

## Priority 4: C++ / QML Bridge Design

- Design bridge extraction and resolution for:
  - `qmlRegisterType`
  - `qmlRegisterSingletonType`
  - `setContextProperty`
  - `Q_PROPERTY`
  - `Q_INVOKABLE`
  - C++ signals consumed from QML
- Keep this bridge outside the QML extractor itself; it should be resolver or
  framework-bridge work that consumes normal C++ and QML graph facts.

## Priority 5: Dynamic QML Loading

- Evaluate static coverage for `Loader.source`, `Loader.sourceComponent`, and
  `Qt.createComponent(...)`.
- Only resolve literal or statically safe targets. Leave string-built runtime
  URLs unresolved unless a conservative rule is available.

## Priority 6: Release Notes

- Add a `[Unreleased]` changelog entry describing QML / Qt Quick indexing.
- Mention the supported first-version scope and explicitly exclude C++/QML
  bridging, `qmldir`, and dynamic URL resolution until those phases land.
