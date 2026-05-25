---
title: Framework Routes
description: CodeGraph links URL patterns to the handlers that serve them.
---

CodeGraph detects web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions. Querying the callers of a view or controller then surfaces the URL pattern that binds it.

| Framework | Shapes recognized |
|---|---|
| **Django** | `path()`, `re_path()`, `url()`, `include()` in `urls.py` (CBV `.as_view()`, dotted paths) |
| **Flask** | `@app.route('/path', methods=[…])`, blueprint routes |
| **FastAPI** | `@app.get(…)`, `@router.post(…)`, all standard methods |
| **Express** | `app.get(…)`, `router.post(…)` with middleware chains |
| **NestJS** | `@Controller` + `@Get/@Post/…`, GraphQL resolvers, message/event patterns, WebSocket subscriptions |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple syntax |
| **Drupal** | `*.routing.yml` routes; `hook_*` implementations in `.module`/`.theme`/`.install`/`.inc` |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket syntax |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` on methods |
| **Gin / chi / gorilla / mux** | `r.GET(…)`, `router.HandleFunc(…)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` attributes on action methods |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | Route component nodes |

Route resolution is automatic — there's nothing to configure. If a framework file is recognized, its routes appear in the graph after the next index or sync.
