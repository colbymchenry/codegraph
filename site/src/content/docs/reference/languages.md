---
title: Languages
description: Every language CodeGraph parses, and the extensions it recognizes.
---

Language support is automatic from the file extension — there's nothing to configure.

| Language | Extensions | Status |
|---|---|---|
| TypeScript | `.ts`, `.tsx` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | Full support |
| ArkTS (HarmonyOS) | `.ets` | Full support (everything TypeScript has, plus ArkUI `@Component` / `@ComponentV2` structs and their decorators, `build()` view trees, state → `build()` re-renders, `@ohos.events.emitter` events, `router.pushUrl` page links, and ohpm workspace modules) |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support (MediatR `Send` / `Publish` link to their handlers) |
| ASP.NET Razor / Blazor | `.cshtml`, `.razor` | Markup links: `@model`, `@inherits`, `@inject`, `@typeof` and Blazor component tags link to the C# types they name, and what an inline `<script>` block calls links to the JavaScript that defines it |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc` | Full support |
| Objective-C | `.m`, `.mm`, `.h` | Partial support (classes, protocols, methods, `@property`, `#import`, message sends; `.mm` ObjC++ may parse incompletely) |
| Metal | `.metal` | Full support (vertex/fragment/kernel functions, structs, type aliases, call edges — MSL parses as C++, with `[[attribute]]` annotations handled) |
| CUDA | `.cu`, `.cuh` | Full support (kernels and device/host functions, structs, classes, host → kernel calls through `<<<grid, block>>>` launches; CUDA in a plain `.h` / `.hpp` header is recognized by its content) |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Scala | `.scala`, `.sc` | Full support (classes, traits, methods, type aliases, Scala 3 enums) |
| Dart | `.dart` | Full support |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Vue | `.vue` | Full support (script + script-setup, Nuxt page/API/middleware routes) |
| Astro | `.astro` | Full support (frontmatter + script extraction, template component/call references, `src/pages/` routes) |
| Liquid | `.liquid` | Full support |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | Full support (classes, records, interfaces, enums, DFM/FMX forms) |
| Lua | `.lua` | Full support (functions, methods, locals, `require` imports, call edges) |
| R | `.R`, `.r` | Full support (functions, S4/R5/R6 classes with methods, `library`/`require` imports, `source()` file references, call edges) |
| Luau | `.luau` | Full support (Lua, plus typed signatures, `type` aliases, Roblox `require`) |
| CFML | `.cfc`, `.cfm`, `.cfs` | Full support (tag-based `<cfcomponent>` / `<cffunction>` and script `component { ... }` styles, `extends` / `implements`, embedded `<cfscript>`, call edges) |
| COBOL | `.cbl`, `.cob`, `.cpy` | Full support (programs, sections and paragraphs with PERFORM / GO TO calls, `CALL 'literal'` cross-program calls, COPY copybooks including standalone `.cpy` files, DATA DIVISION records and fields, EXEC CICS LINK / XCTL and EXEC SQL INCLUDE targets; fixed and free format) |
| Visual Basic .NET | `.vb` | Full support (classes, Modules, interfaces, structures, enums, properties, events, `Declare` P/Invoke, `Handles` / `WithEvents`, `Inherits` / `Implements` edges, call edges, LINQ) |
| Erlang | `.erl`, `.hrl`, `.escript`, `.app.src`, `.app` | Full support (functions grouped by arity, `-spec` signatures, records, `-type` / `-opaque` aliases, `-define` macros, `-include` / `-import` edges, local and `mod:fn` remote calls, `spawn` / `apply`-style calls, `gen_server:call` / `cast(?MODULE)` to the module's own handlers, `-behaviour` links) |
| Solidity | `.sol` | Full support (contracts, libraries, interfaces, structs, enums, modifiers, events, errors, state variables, `import` / `using` directives, `emit` / `revert` calls) |
| Terraform / OpenTofu | `.tf`, `.tfvars`, `.tofu` | Full support (resources, data sources, modules, variables, outputs, providers, `locals`; `var.` / `local.` / `module.` and resource references with Terraform's per-directory scoping; module calls linked to the child module's variables, outputs and files; `.tfvars` assignments linked to the variables they set) |
| Nix | `.nix` | Full support (functions, `let` / attrset bindings, `inherit`, `import ./path` file edges, NixOS module `imports` lists and `callPackage` file edges, call edges, and module-system options linked from where they're set to the module that declares them) |
