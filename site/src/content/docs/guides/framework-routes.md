---
title: Framework Routes
description: CodeGraph links URL patterns to the handlers that serve them.
---

CodeGraph detects web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions. Querying the callers of a view or controller then surfaces the URL pattern that binds it.

| Framework | Shapes recognized |
|---|---|
| **Django** | `path()`, `re_path()`, `url()`, `include()` in `urls.py` (CBV `.as_view()`, dotted paths) |
| **Flask** | `@app.route('/path', methods=[...])`, blueprint routes |
| **FastAPI** | `@app.get(...)`, `@router.post(...)`, all standard methods |
| **Express** | `app.get(...)`, `router.post(...)` with middleware chains |
| **Hono** | Imported `Hono` instances, method/path arrays, `basePath()` and same-file `.route()` mounts |
| **Elysia** | Imported `Elysia` instances, method calls, `.route()`, literal constructor prefixes and `.group()` callbacks |
| **Fastify** | Imported factories, shorthand methods, `.route({ method, url, handler })`, inline `.register()` callbacks with literal prefixes |
| **Hyper-Express** | Imported `Server` / `Router`, method calls, `.route(path)` chains and same-file `.use()` mounts |
| **Koa router** | `@koa/router` / `koa-router` instances, named routes, literal prefixes and same-file `.use(path, child.routes())` mounts |
| **H3** | Imported `H3`, `createRouter` / `createApp`, method calls, `.on()` / `.all()` and same-file router mounts |
| **Bun** | `Bun.serve()` or imported `serve()` with a literal `routes` table; direct handlers, method tables and static responses |
| **Effect v4** | `HttpRouter.add(method, path, handler)` / `.route()` from `effect/unstable/http` or its `HttpRouter` submodule |
| **Vixeny** | Option-free `wrap()()` builders with `.get/.post/.put/.delete` or `.route({ method, path, f })` |
| **NestJS** | `@Controller` + `@Get/@Post/...`, GraphQL `@Resolver` + `@Query/@Mutation`, `@MessagePattern`/`@EventPattern`, `@SubscribeMessage` |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple syntax |
| **Drupal** | `*.routing.yml` routes (`_controller`, `_form`, entity handlers); `hook_*` implementations in `.module`/`.theme`/`.install`/`.inc` |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket `=>` syntax |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` on methods |
| **Play** | `GET`/`POST`/… verb routes in `conf/routes` → `Controller.method` actions (Scala + Java) |
| **Gin / chi / gorilla / mux** | `r.GET(...)`, `router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` attributes on action methods |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | Route component nodes |
| **Next.js** | App Router and Pages Router pages; `app/api/**/route.ts` method exports and `pages/api/**` default handlers |
| **Vue Router** / **Nuxt** | Vue route tables; `.vue` pages in `pages/` or Nuxt 4 `app/pages/`, dynamic/optional/catch-all segments and route groups; `server/api/` and `server/routes/` with method suffixes; route middleware |
| **Astro** | `src/pages/` file-based routes (`.astro` pages + `.ts` endpoints, `[param]`/`[...rest]` syntax) |

Route resolution is automatic — there's nothing to configure. If a framework file is recognized, its routes appear in the graph after the next index or sync.

The JavaScript HTTP readers require a recognized package import (ES modules or CommonJS), except for the global `Bun.serve`. They follow immutable local router bindings and literal declarations, without executing your application. Named handlers produce references; direct calls inside inline handlers produce call edges. Static responses have an endpoint without an invented handler. Member handlers remain unresolved by this reader.

Computed paths, spread configuration, cross-file mounts, plugin factories, mutable router aliases, and runtime method replacement are outside this static reading. Imports and captured router bindings must precede their use in source. Vixeny builders with options are omitted because their effective paths depend on the terminal operation. Nuxt custom route configuration, page metadata overrides, non-Vue page extensions, and custom server handler wrappers are not interpreted. Re-index after upgrading to add the new endpoints to an existing graph.
