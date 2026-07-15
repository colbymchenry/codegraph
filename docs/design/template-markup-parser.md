# Scope: Template-markup parser (Razor / Blazor / Thymeleaf)

Status: **P1+P2+@code IMPLEMENTED** (commits 59b8de2 directives/tags, 90c5f39 @code
delegation) on `feat/cross-language-impact-coverage`. Razor/Blazor markup is parsed
(`src/extraction/razor-extractor.ts`). Remaining: `@using` namespace disambiguation
for DTO-vs-entity name collisions (the residual ASP.NET gap), and Thymeleaf/Django
(P4, deferred — weak code links). Authored 2026-06-04.

## Problem

The impact graph is built from code the engine parses. **Template markup is not
parsed**, so any code-behind, component, view-model, or DTO that is referenced
*only* from markup looks like it has no in-repo dependent. On convention-heavy
frameworks this is the dominant residual gap after framework-entry exclusions:

| Framework | App | FAIR coverage (entries excluded) | Residual cause |
|---|---|---|---|
| ASP.NET | eShopOnWeb | **77.2%** (115/149) | Razor `.cshtml` + Blazor `.razor` reference `.cs` we don't parse |
| Spring | petclinic | 65.2% | mostly Spring Data proxies + JPA, **not** templates (Thymeleaf links are weak) |
| Django | django-realworld | 74.1% | signals / DRF / string-config, **not** templates |

**This feature is primarily an ASP.NET (Razor + Blazor) win.** Thymeleaf and Django
templates link to code only weakly (template→template fragments + fuzzy
model-attribute strings), and those frameworks' real gaps are elsewhere — so they
are explicitly lower priority here.

### Quantified target (eShopOnWeb, the 34 residual zeros after entry-exclusion)

- **~20 markup-coverable** by this feature:
  - 5 MVC `ViewModels/*` ← Razor `@model X`
  - 7 `BlazorShared/Models/*` (DTOs) ← Blazor `@bind` / component params
  - 6 `BlazorAdmin/*` C# components ← Blazor `<Component/>` tags
  - 1 `BasketComponent` ViewComponent ← `<vc:basket>` / `Component.InvokeAsync`
  - 1 Razor page helper
- **~13 NOT covered** (separate frontier — reflection/proxy + value-reads): AutoMapper
  `MappingProfile`, Swagger `CustomSchemaFilters`/`ImageValidators`, `ExceptionMiddleware`,
  health checks, `Constants` (static-member reads), `Buyer` entity.

**Honest ceiling: ASP.NET ~77% → ~90%**, not 95%. The last ~10% is reflection/proxy
(AutoMapper, Swagger, DI/middleware registration) + C# static-const reads — a
*separate* feature (reflection modeling + extending the static-member pass to C#).

## Reference patterns to extract (prioritized)

| Pri | Format | Markup construct | Edge to emit | Resolves to |
|---|---|---|---|---|
| P1 | Razor `.cshtml`/`.razor` | `@model Foo` / `@inherits X<Foo>` | `references` | the model/VM class `Foo` |
| P1 | Razor/Blazor | `@inject IBar bar` | `references` | the service type `IBar` |
| P2 | Blazor `.razor` | `<MyComponent .../>` (PascalCase element) | `references` | component class (`.razor` or `.cs : ComponentBase`) |
| P2 | Blazor `.razor` | `@typeof(MainLayout)`, `@inherits LayoutBase` | `references` | the type |
| P3 | Razor `.cshtml` | `<partial name="_X"/>`, `<vc:basket>`, `Component.InvokeAsync("X")` | `references` | the partial view / `XViewComponent` |
| P3 | Razor `.cshtml` | `asp-page="./Register"`, `asp-controller`/`asp-action` | `references` | the page / controller action |
| P4 (defer) | Thymeleaf `.html` | `th:replace="~{frag :: x}"` | `references` | template fragment (template→template only) |
| P4 (defer) | Django `.html` | `{% extends %}` / `{% include %}` / `{% url 'n' %}` | `references` | template / named route |

`asp-for="Prop"`, `th:field="*{prop}"` (property-string bindings) are the data-flow
frontier — **out of scope** (would need model-type inference; low value, high noise).

## Architecture — follow the existing standalone-extractor pattern

The engine already has non-tree-sitter extractors (`svelte-extractor.ts`,
`vue-extractor.ts`, `liquid-extractor.ts`): a class taking `(filePath, source)`,
returning `{ nodes, references }`, wired in two places. Mirror exactly:

1. **`src/extraction/grammars.ts`** — map extensions to a synthetic language:
   `.cshtml`/`.razor` → `'razor'`, (later) `.html` under `templates/` → `'thymeleaf'`.
   (Django `.html` is ambiguous with plain HTML — gate on a `templates/` path or a
   `{% %}`/`{{ }}` content sniff, like the framework resolvers do.)
2. **`src/extraction/tree-sitter.ts`** — dispatch by extension to a new
   `RazorExtractor` (and `ThymeleafExtractor`), exactly as `SvelteExtractor` is
   dispatched (~line 4025).
3. **`src/extraction/razor-extractor.ts`** (new) — regex/line scan (markup is
   highly stylized; no grammar needed, same as Liquid/Svelte template scanning):
   - Emit ONE `component` node for the file (so `.razor` components are linkable as
     `<X/>` targets and the file is a graph citizen).
   - Emit `references` per the P1–P3 patterns above, `fromNodeId` = the file/component
     node, `referenceKind: 'references'`, `language: 'razor'`.
   - **Code-behind link:** a `Foo.razor` + `Foo.razor.cs` (partial class) — emit a
     `references` (or rely on same-basename) so the markup's refs also credit the
     code-behind. (eShop's Blazor components are plain `.cs : ComponentBase`, named
     `<ToastComponent/>` → resolves by class name; the `.razor.cs` partial case is
     the other shape.)

**Resolution: no new resolver needed.** The emitted refs are ordinary `references`
to a class/component by name; the existing name-matcher resolves them (`@model
RegisterModel` → class `RegisterModel`; `<ToastComponent/>` → class `ToastComponent`).
Apply the **same cross-family language gate** already in place — a `razor` ref must
resolve to a `csharp` symbol, so add `razor` to the `web`/dotnet family or treat
`razor`↔`csharp` as same-family (otherwise the gate from commit 082353e drops it).
**This is the one resolver-side change** and must be done or every edge is gated away.

## Node/edge shape & invariants

- +1 `component` node per template file (real new symbol — like `.svelte`/`.vue`).
  Node count grows by the template-file count only; **no per-tag node explosion**
  (component tags become `references` edges, not nodes).
- All edges are `references` (counted by impact / `affected` / `getFileDependents`,
  not by `callers`/`callees` — matches how `route`/`component` edges already behave).
- Idempotent re-index; node count stable across re-runs.

## Phasing

- **P1 (highest value/effort ratio):** Razor `@model` + `@inject` for `.cshtml` AND
  `.razor`. Covers the 5 ViewModels + injected services. + the resolver family-gate fix.
- **P2:** Blazor `<PascalComponent/>` tags + `@typeof`/`@inherits` + code-behind link.
  Covers the 6 Blazor `.cs` components + the 7 DTOs (via component params/`@bind`).
- **P3:** Razor `<partial>` / `<vc:>` / `Component.InvokeAsync` / `asp-page`.
- **P4 (defer / probably skip):** Thymeleaf + Django templates — weak code links,
  low coverage payoff; revisit only if a Thymeleaf/Django app is a priority.

## Edge cases & risks

- **PascalCase tag vs HTML element:** only `[A-Z]`-initial tags are Blazor components
  (HTML is lowercase) — safe discriminator. Skip known framework components
  (`<Router>`, `<Found>`, `<LayoutView>`, `<RouteView>`, `<CascadingValue>`) via a
  builtin set, or just let them fail to resolve (no false edge — they're not in-repo).
- **`_Imports.razor` `@using`:** namespace imports, not code refs — ignore (or emit
  `imports` to the namespace, low value).
- **Generic components `<Grid TItem="CatalogItem">`:** capture the type-arg as a
  `references` to `CatalogItem` (bonus DTO coverage).
- **Name collisions:** component/model names are usually unique; rely on the
  name-matcher's existing proximity scoring. Same-named class in another language is
  blocked by the family gate.
- **Razor `@{ ... }` C# blocks:** contain real C# (calls, `new`) — P-future; regex
  scanning the C# inside markup is noisy. Defer (the directives above are the wins).
- **`.razor` is NOT `.cs`:** must add to `grammars.ts` + the indexer's include globs
  (verify `.razor`/`.cshtml` aren't in a default-exclude).

## Validation (per the engine's methodology)

1. Build `RazorExtractor`; unit tests in `__tests__/extraction.test.ts` (a `.cshtml`
   with `@model X` covers `X`; a `.razor` with `<ToastComponent/>` covers it; an HTML
   `<div>` does NOT create an edge).
2. Re-measure eShopOnWeb FAIR coverage before/after (`/tmp/faircov.cjs`): target
   77% → ~90%; **node count stable** (only +template-file component nodes); residual
   zeros are the reflection/value-read set only.
3. No regression on a non-.NET control (gin/requests) and on the Razor-free C#
   repos (cs-mediatr/cs-polly unchanged).
4. Record in this doc + the coverage handoff.

## Effort

- P1: ~0.5 day (extractor skeleton + `@model`/`@inject` scan + family-gate fix + tests).
- P2: ~1 day (Blazor tags + code-behind + generic type-args).
- P3: ~0.5 day. P4 (Thymeleaf/Django): ~1–2 days, low ROI — defer.
- **Total for the ASP.NET win (P1+P2+P3): ~2 days → ASP.NET ~90%.**

## Non-goals (and what's still needed for 95% on convention apps)

This feature does NOT close: reflection/proxy registration (Spring Data repository
proxies, AutoMapper profiles, Swagger filters, DI container / middleware), property-
string data bindings (`asp-for`/`th:field`), or C# static-const value reads
(`Constants.X`). Convention apps reaching literal 95% additionally need a **reflection/
DI-registration modeling** pass and **extending the static-member pass to C#/TS** —
tracked separately. Markup parsing is the single biggest, most self-contained step.
