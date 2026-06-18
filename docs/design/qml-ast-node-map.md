# QML AST Node Map

This document records observed QMLJS tree-sitter node names and fields for
planned CodeGraph QML extraction. The grammar source is
`@lumis-sh/wasm-qmljs@0.26.0`.

## Verified Grammar

- Package: `@lumis-sh/wasm-qmljs@0.26.0`
- WASM export: `@lumis-sh/wasm-qmljs/tree-sitter-qmljs.wasm`
- Runtime: `web-tree-sitter`

## Core Nodes

| QML syntax | Tree-sitter node |
|---|---|
| File root | `program` |
| `pragma Singleton` | `ui_pragma` |
| `import QtQuick` | `ui_import` |
| Object declaration `Item {}` | `ui_object_definition` |
| Object body | `ui_object_initializer` |
| Binding `name: value` | `ui_binding` |
| Property `property int count` | `ui_property` |
| Signal `signal accepted(...)` | `ui_signal` |
| Function `function initialize() {}` | `function_declaration` |
| Enum `enum Mode { Light, Dark }` | `enum_declaration` / `enum_body` |
| Array object binding `states: [ State {} ]` | `ui_object_array` |
| JavaScript call `foo()` | `call_expression` |
| JavaScript member read `root.count` | `member_expression` |
| Attached handler `Component.onCompleted` | `nested_identifier` |

## Field Names

| Parent node | Field | Meaning |
|---|---|---|
| `ui_import` | `source` | Module name or JS helper string |
| `ui_import` | `version` | Optional module version |
| `ui_import` | `alias` | Optional JS import alias |
| `ui_object_definition` | `type_name` | QML type name |
| `ui_object_definition` | `initializer` | QML object body |
| `ui_property` | `type` | Property type token |
| `ui_property` | `name` | Property name |
| `ui_property` | `value` | Optional initializer expression |
| `ui_signal` | `name` | Signal name |
| `ui_signal` | `parameters` | Signal parameters |
| `ui_binding` | `name` | Binding name, including handler names |
| `ui_binding` | `value` | Binding expression or object array |
| `function_declaration` | `name` | Function or handler function name |
| `function_declaration` | `parameters` | Function parameters |
| `function_declaration` | `body` | Function body block |

## Inline Component Recovery

The grammar recovers `component PrimaryButton : Button { ... }` with an outer
`ERROR` node. In the observed AST, that `ERROR` contains a `ui_object_definition`
whose `type_name` is `component`, plus an inner `ERROR` containing the inline
component name (`PrimaryButton`) and base type (`Button`) identifiers. The body
still appears as the `ui_object_definition` initializer. The observed `ERROR`
nodes do not expose usable named fields, so recovery must rely on source text
and child ordering.

The planned QML extractor recovery should handle inline components in a
constrained way:

1. Detect an `ERROR` node whose source starts with `component <Name> :`.
2. Create a CodeGraph `component` node kind named `<Name>` at the `ERROR` node
   location. This is not a QMLJS tree-sitter AST node named `component`.
3. Recover the base type from the identifier after `:` when needed.
4. Visit the recovered `ui_object_definition` initializer children under that
   inline component scope.
5. Do not use this recovery for arbitrary `ERROR` nodes.

This keeps inline component support inside the normal QML language extractor
instead of adding a separate scanner.
