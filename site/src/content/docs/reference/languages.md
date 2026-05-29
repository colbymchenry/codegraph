---
title: Languages
description: Every language CodeGraph parses, and the extensions it recognizes.
---

Language support is automatic from the file extension — there's nothing to configure.

| Language | Extensions | Status |
|---|---|---|
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | Full support |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc` | Full support |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Scala | `.scala`, `.sc` | Full support (classes, traits, methods, type aliases, Scala 3 enums) |
| Dart | `.dart` | Full support |
| Lean | `.lean` | Static extraction with optional Lean/Lake LSP definition resolution |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Vue | `.vue` | Full support (script + script-setup, Nuxt page/API/middleware routes) |
| Liquid | `.liquid` | Full support |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | Full support (classes, records, interfaces, enums, DFM/FMX forms) |
| Lua | `.lua` | Full support (functions, methods, locals, `require` imports, call edges) |
| Luau | `.luau` | Full support (Lua, plus typed signatures, `type` aliases, Roblox `require`) |

Lean files are indexed without requiring Lean locally. If `lake` or `lean` is available, CodeGraph runs a best-effort LSP definition pass for unresolved Lean references. Set `CODEGRAPH_LEAN_SEMANTICS=off` to force static-only indexing, or override the command with `CODEGRAPH_LEAN_LSP_COMMAND`. `CODEGRAPH_LEAN_LSP_TIMEOUT_MS` and `CODEGRAPH_LEAN_LSP_REF_LIMIT` cap the optional pass.
