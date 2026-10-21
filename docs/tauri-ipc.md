# Tauri Command Links

The Tauri synthesis pass links JavaScript/TypeScript calls imported from `@tauri-apps/api/core` or `@tauri-apps/api/tauri` to Rust commands. Named import aliases and namespace imports are supported. The first argument must be a static string literal.

A destination requires both `#[tauri::command]` and registration in `tauri::generate_handler![...]` passed directly to an `invoke_handler` call whose receiver chain originates at `tauri::Builder::default()`. Rust macro token trees and frontend import/call nodes are parsed, so comments and string decoys do not establish registration. Standard module paths such as `commands::save` are mapped under `src-tauri/src`; the external command key remains `save`.

Calls stay within the nearest conventional application root. Ambiguous keys, shadowed imports, dynamic keys, plugin commands, top-level calls without a callable owner, and unregistered/undecorated functions produce no edge. Edges use `provenance: heuristic`, `synthesizedBy: tauri-command`, invoke line/column and `registeredAt` evidence. Existing synthesis input tracking rebuilds the links when registration or invocation changes.

This initial contribution does not model global `window.__TAURI__` access, wrapper/re-export functions, aliased Rust macros, builder variables, nonstandard crate/module paths or frontend Vue/Svelte scripts. Explicit registration is source evidence, not a claim that an application ran or granted command permissions.

Fixture precision and sync behavior are tested. Required small/medium/large real-repository probes and agent A/B validation remain pending; framework support is not marked fully validated.
