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
| **Elysia** (Bun) | Chains of `.get(...)`, `.post(...)`, `.route('TRACE', ...)` and `.ws(...)` on `new Elysia(...)`, `.group()` and `.guard()` callbacks, and functional plugins; each route is named by the full path a request takes, with the prefixes of `new Elysia({ prefix })`, `.group()` and a `.use(plugin)` in another file |
| **NestJS** | `@Controller` + `@Get/@Post/...`, GraphQL `@Resolver` + `@Query/@Mutation`, `@MessagePattern`/`@EventPattern`, `@SubscribeMessage` |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple syntax |
| **Drupal** | `*.routing.yml` routes (`_controller`, `_form`, entity handlers); `hook_*` implementations in `.module`/`.theme`/`.install`/`.inc` and `#[Hook]` methods; `*.services.yml` services, and calls through `\Drupal::service()`; plugin definitions, as attributes or annotations |
| **CodeIgniter 3** | Every public controller method by convention, `$route[...]` in `routes.php`, HMVC modules; `$this->load` models, libraries and views |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket `=>` syntax |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` on methods |
| **Play** | `GET`/`POST`/… verb routes in `conf/routes` → `Controller.method` actions (Scala + Java) |
| **Gin / chi / gorilla / mux** | `r.GET(...)`, `router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` attributes on action methods |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | Route component nodes |
| **Next.js** | App Router `page.tsx` and Pages Router pages; `route.ts` exports (`GET`, `POST`, …) and `pages/api/*` handlers as endpoints; the `proxy.ts` or `middleware.ts` that runs before them, by its `config.matcher` |
| **Vue Router** / **Nuxt** | `pages/` file-based routes, `server/api/` endpoints, route middleware |
| **Astro** | `src/pages/` file-based routes (`.astro` pages + `.ts` endpoints, `[param]`/`[...rest]` syntax) |

Route resolution is automatic — there's nothing to configure. If a framework file is recognized, its routes appear in the graph after the next index or sync.

## Beyond routes

Some framework wiring connects code that never names its other end, so static parsing can't follow it. CodeGraph links these too, and `codegraph_explore`, callers and impact follow them:

- **Next.js** — nothing imports an app's `proxy.ts` or `middleware.ts`, yet it runs before every route its `config.matcher` accepts. Each of those routes is linked to it, so its callers are the routes it runs before, and impact shows which routes a change to it reaches.
- **C# with MediatR** — a `Send` or `Publish` call on the mediator reaches the `Handle` method of the handler for what it sends, whether the handler implements MediatR's interfaces, your project's own, like `ICommandHandler<T>`, or a package's, like the Mediator library's.
- **ASP.NET Razor** — a view's inline `<script>` blocks link to the JavaScript they call, so a helper used only from views doesn't look unused. `codegraph_explore`'s blast radius lists the views that use a symbol apart from its other callers.
- **Tauri** — a frontend `invoke('save_file')`, a tauri-specta typed command like `commands.saveFile()`, or your own wrapper around `invoke` reaches the Rust `#[tauri::command]` function that answers it, once the app registers it with `generate_handler!` or tauri-specta's `collect_commands!`. Events link both ways: an `emit` reaches the `listen` handlers for that event, from Rust to the frontend and back.
- **Drupal** — a call through `\Drupal::service('x')` or `$container->get('x')` reaches the method on that service's class.
- **CodeIgniter 3** — a call through what `$this->load` loaded, like `$this->users_model->find()`, reaches that class's method, and `$this->load->view()` links to the view's file.
