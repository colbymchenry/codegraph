---
title: Resolution & Frameworks
description: How CodeGraph connects references and links routes to handlers.
---

Extraction produces nodes and raw edges; **resolution** turns names into real connections.

## Reference resolution

After parsing, CodeGraph resolves:

- **Imports** → the source files they point at (including tsconfig path aliases and cargo workspace members).
- **Calls** → their definitions, by import resolution and name matching.
- **Inheritance** → `extends` / `implements` between types.

## Framework awareness

CodeGraph recognizes web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions — so querying the callers of a view or controller surfaces the URL pattern that binds it. See [Framework Routes](/codegraph/guides/framework-routes/) for the full list of recognized frameworks.

## Dynamic-dispatch coverage

Static parsing misses computed and indirect calls, so flows can break at dynamic dispatch. CodeGraph bridges several of these boundaries with synthesizers so a flow connects end-to-end:

- Callback / observer registration
- `EventEmitter` channels
- React re-render (`setState` → `render`)
- JSX child (`render` → child component)
- Interface → implementation dispatch

Every synthesized edge is marked `provenance: 'heuristic'` with the site that wired it, and is shown inline wherever a path crosses it.
