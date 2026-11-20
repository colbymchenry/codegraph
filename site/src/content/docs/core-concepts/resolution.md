---
title: Resolution & Frameworks
description: How CodeGraph connects references and links routes to handlers.
---

Extraction produces nodes and raw edges; **resolution** turns names into real connections.

## Reference resolution

After parsing, CodeGraph resolves:

- **Imports** → the source files they point at (including tsconfig path aliases, cargo workspace members, and PHP includes built from the including file's folder, like `__DIR__ . '/inc/a.php'`, or from the [web server's root](/codegraph/getting-started/configuration/#php-includes-from-the-web-root)).
- **Calls** → their definitions, by import resolution and name matching.
- **Inheritance** → `extends` / `implements` between types.

## Framework awareness

CodeGraph recognizes web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions — so querying the callers of a view or controller surfaces the URL pattern that binds it. See [Framework Routes](/codegraph/guides/framework-routes/) for the full list of recognized frameworks, and [Beyond routes](/codegraph/guides/framework-routes/#beyond-routes) for the framework wiring CodeGraph follows that isn't a URL, from MediatR handlers to Tauri commands.

## Dynamic-dispatch coverage

Static parsing misses computed and indirect calls, so flows can break at dynamic dispatch. CodeGraph bridges several of these boundaries with synthesizers so a flow connects end-to-end:

- Callback / observer registration
- `EventEmitter` channels
- React re-render (`setState` → `render`)
- JSX child (`render` → child component)
- Interface → implementation dispatch
- MediatR `Send` / `Publish` → the handler for what is sent (C#)
- Tauri `invoke` → the Rust `#[tauri::command]` that answers it, and Tauri events in both directions
- A Next.js route → the `proxy.ts` or `middleware.ts` that runs before it

Every synthesized edge is marked `provenance: 'heuristic'` with the site that wired it, and is shown inline wherever a path crosses it.
