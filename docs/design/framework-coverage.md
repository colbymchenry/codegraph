# Framework & language coverage — what is done, what is left

**Last verified: 2026-08-29** against the build at that date. Re-verify with the
queries in [Checking this file is still true](#checking-this-file-is-still-true)
before trusting a row; this is a snapshot, not a live view.

This file exists to be read cold. It says, for every framework and language the
README claims, **which of the three pictures it can draw today** and what is
missing from the ones it cannot — so a fresh session can pick up the next piece
without re-deriving the map.

---

## The three axes

A framework's support is not one thing. Three separate facts in the graph
unlock three different pictures, and a framework can have any subset:

| Fact in the graph | Unlocks | Produced by |
|---|---|---|
| **`route` nodes** bound to a handler or component | the **Entry points** tab; an endpoint or page can be a Steps anchor | a framework resolver's `extract()` |
| **`navigates` edges** from the code that sends a user somewhere to the route it names | the **Screens** tab — without a single one, `buildScreens` returns `routed: false` and the tab stays hidden | a resolver's `resolve()` (calls) + a synthesizer (markup) |
| **branch-guard rules** for the language | the `WHEN` label on every arrow, in Steps, Screens and `codegraph_explore`'s Flow section | `src/graph/branch-guards.ts` |

The Screens picture is a pure function of the first two: *any* framework that
produces route nodes and `navigates` edges lands on the tab, with no view code
to write. That is why "add a router" is a small, self-contained job.

---

## Routers — routes AND navigation (done)

Six. Each reads a literal destination and leaves a computed one, a path no
route serves, and a conditional whose arms disagree unresolved rather than
guessed.

| Router | Resolver | Markup synthesizer | Tests | Validated on |
|---|---|---|---|---|
| Expo Router | `frameworks/expo-router.ts` | `expo-router-synthesizer.ts` | `expo-router.test.ts` | — |
| Next.js | `frameworks/nextjs.ts` | `next-router-synthesizer.ts` | `nextjs.test.ts` | next-saas-starter |
| React Router | `frameworks/react-router.ts` | `react-router-synthesizer.ts` | `react-router.test.ts` | proshop (44 edges) |
| TanStack Router | `frameworks/tanstack-router.ts` | `tanstack-router-synthesizer.ts` | `tanstack-router.test.ts` | TanStack examples, fastapi-template frontend |
| Vue Router / Nuxt | `frameworks/vue-router.ts` | `vue-router-synthesizer.ts` | `vue-router.test.ts` | vue-realworld (23 edges) |
| SvelteKit | `frameworks/sveltekit-router.ts` | `sveltekit-synthesizer.ts` | `sveltekit-router.test.ts` | sveltekit-realworld (31 edges) |

Shared machinery all six use, in `frameworks/expo-router.ts`: `RouteTable` /
`RootedRouteTable`, `routesForFile`, `addRouteTo`, `matchRoute`, `appRootFor`,
`parseHrefExpression`, `readHrefViaLocal`, `nthArgumentText`, `readStringAt`,
`toHref`. Plus `pageForHref` in `frameworks/nextjs.ts` (framework-agnostic
despite where it lives) and the object-literal walker in
`frameworks/object-literal.ts`.

---

## What is left

Ordered by cost-to-value. Each row says what is missing, not merely that
something is.

### 1. Astro — the last web framework with routes but no navigation

**Has:** `src/pages/` file routes (`.astro` pages + `.ts` endpoints,
`[param]`/`[...rest]`), in `frameworks/astro.ts`.
**Missing:** `navigates` edges. Astro is an MPA — navigation is a plain
`<a href="/about">`, plus `Astro.redirect('/x')` in frontmatter and
`redirect` entries in `astro.config`.
**Size:** smallest job on this list. `sveltekit-synthesizer.ts`'s
`svelteKitLinkEdges` is the same pass over the same tag against a different
table; the resolver half is one `Astro.redirect` reader.
**Validate on:** any `withastro/astro` example, or the Astro docs site.

### 2. Server-rendered frameworks — a redirect is a transition, not just a response

**Fourteen frameworks** have route nodes and no navigation: Django, Flask,
FastAPI, Express, NestJS, Laravel, Drupal, Rails, Spring, Play, Gin/chi/gorilla,
Axum/actix/Rocket, ASP.NET, Vapor.

Be precise about what is missing. `redirect_to`, `HttpResponseRedirect`,
`res.redirect`, PHP's `redirect()` are **already recognised as `response`
effects** (`ui-server/api/effects.ts`), so they draw as a box in the Steps
picture. What is missing is the edge to the page they name — so two pages never
connect on the Screens tab.

For a pure API this is correct and nothing should change: an endpoint is not a
screen. It matters for the **server-rendered** half, where a classic MVC app
gets no Screens picture at all today:

| Framework | The destination to read | Why it is harder than a client router |
|---|---|---|
| Rails | `redirect_to :dashboard`, `redirect_to users_path` | destinations are named helpers (`*_path`/`*_url`) generated from `routes.rb`, not literals |
| Django | `redirect('profile')`, `reverse('profile')` | same — a route *name*, like Vue's `{ name }`, which `vue-router.ts` already shows how to index |
| Laravel | `redirect()->route('home')`, `->view()` | route names again |
| Spring | `"redirect:/x"`, `RedirectView` | a literal inside a string return value |
| ASP.NET | `RedirectToAction("Index", "Home")` | controller + action pair, not a path — needs the route table's reverse mapping |
| Flask | `redirect(url_for('profile'))` | nested call; the name is `url_for`'s argument |

The Vue name-index (`VueAppRoutes.byName`) is the closest existing precedent for
all of these.

### 3. Phoenix — Elixir now indexes, the router does not

Elixir extraction is in (`defmodule` / `def` / `alias` / `Mod.fun` / `|>` /
`GenServer.call`). **Missing:** Phoenix and Phoenix LiveView **route nodes**.
`scope "/", AppWeb do get "/", PageController, :index end`, `live "/x", FooLive`,
and `push_navigate(to: "/x")` / `<.link navigate={...}>` are unread, so a Phoenix
app has no Entry points and no Screens tab. Same shape as Rails `routes.rb`: a
router DSL whose destinations are controller-or-LiveView modules, not file paths.

**Validate on:** `phoenixframework/phoenix` (the framework itself) and any
`phx.new` app, or BlockScout / Plausible.

### 4. Native UI — no route nodes at all

| Platform | Routes would come from | Navigation would come from |
|---|---|---|
| SwiftUI | `NavigationStack(path:)`, `.navigationDestination(for:)` | `NavigationLink(value:)`, `path.append(…)` |
| Jetpack Compose | `NavHost { composable("route") { … } }` | `navController.navigate("route")` |
| Flutter / Dart | `MaterialApp(routes: {…})`, `GoRouter([...])` | `Navigator.push`, `context.go('/x')` |

All three are named in `scripts/try-repo.sh`'s presets as not modelled
(`icecubes`, `nowinandroid`). Compose and go_router are the most tractable —
both name routes with string literals, which is the same shape every router
above reads.

### 5. ArkTS / HarmonyOS — closest to done of anything here

**Has:** the hard half already. `arkuiRouterEdges` in
`callback-synthesizer.ts` resolves `router.pushUrl('/pages/Detail')` to the
target page struct.
**Missing:** it emits a **`calls`** edge and no `route` node, so it never
reaches the Screens tab.
**Size:** an edge-kind change plus route nodes for `pages/` entries — no new
analysis.

---

## Languages

All ~30 languages in the README have full structural extraction; nothing is
outstanding on that axis. The gap that is language-shaped is the **`WHEN`
label**.

**Guard rules exist** (`RULES_BY_LANGUAGE` in `src/graph/branch-guards.ts`) for:
TypeScript, TSX, JavaScript, JSX, Swift, Python, Java, Kotlin, C#, Go, C, C++,
Objective-C.

(Metal and CUDA parse **as** C++ and ArkTS does **not** parse as TypeScript, so
the first two inherit the C rules and the third has none.)

**No rules** — boxes draw, arrows carry no condition, and no arguments or
trigger labels are read: PHP, Ruby, Rust, Scala, Dart, Erlang, Elixir, Lua, Luau, R,
Solidity, COBOL, CFML, VB.NET, Nix, Terraform, Pascal/Delphi, Liquid, Razor,
Twig, ArkTS, and the `.svelte` / `.vue` / `.astro` template languages.

A language with no rules yields **nothing**, never a wrong label — that is the
design, so an absent row here is a missing feature, not a bug.

**Ruby and Rust sting most**: both have server frameworks in the README's table
(Rails, Axum/actix/Rocket), so their Steps pictures draw responses and database
calls with no conditions on any arrow. `scripts/try-repo.sh`'s `bookstack`
preset says exactly this for PHP.

---

## Traps a new router will hit

Each of these cost real debugging time; they are not hypothetical.

1. **A `references` edge cannot cross a language family.** `applyLanguageGate`
   in `name-matcher.ts` filters `references` candidates to
   `sameLanguageFamily`, so a `.js` router config can never name a `.vue`
   component — it silently binds to a same-named `.js` function in a store
   instead. Bind a route to its component with **`calls`**, which
   `route-roots.ts` reads as "the page a screen file exports".
2. **One address, one screen.** A layout and the index route beside it resolve
   to the same path (`+layout.svelte` vs `+page.svelte`, `dashboard.route.tsx`
   vs `dashboard.index.tsx`, `_auth.invoices.tsx` vs `_auth.invoices.index.tsx`).
   Emitting both puts one address on the map twice. Decide **per file** — the
   sibling is not visible at extraction time.
3. **The route table must be per app.** A repository with two apps has two `/`
   and two `/login`; a global table hands the address to whichever was indexed
   first. Measured at **82% of navigations pointing into a different app** on a
   477-app monorepo before `RootedRouteTable` / `routesForFile`. The `roots`
   list decides only *whether* to resolve.
4. **Read fields from the object, not from a window around one.** A Vue route's
   `name` is written above its `path`, so a text window handed every entry its
   predecessor's name — silently, for every route in the file. Use
   `frameworks/object-literal.ts`.
5. **A receiver is required for a generic verb.** `push` and `replace` are two
   of the most common method names in JavaScript; claiming a bare one puts every
   `paths.push('/tmp/x')` one string-match away from a route.
6. **One component can be several screens.** A listing rendered at `/`,
   `/search/:keyword` and `/page/:n` is one component and three addresses;
   `screenOfComponent` maps a component to **every** route it serves, and
   `collapseSharedChrome` counts distinct screen COMPONENTS, not addresses —
   counting addresses collapsed one component's four routes into an origin and
   took the navigation away from all of them.
7. **A destination can name several routes.** `parseHrefExpression` returns
   one `HrefLiteral` carrying `alternates`, and `destinationsForHref` turns it
   into one `{ node, href }` per arm. A synthesizer emits an edge apiece; a
   resolver puts the first on the `ResolvedRef` and the rest in `alsoTargets`,
   which `createEdges` fans out — the reference still resolves ONCE, so the
   pipeline's cleanup and counts are untouched. Label each edge with the arm
   that named it, or an edge points at one route while naming another's path.
8. **Read markup with the same reader as calls.** A synthesizer that peeks at
   the first character of `to={…}` misses every conditional and template the
   `push(…)` path handles. Use `parseHrefExpression` on the balanced brace
   contents.
9. **A condition is read the same way for markup as for a call.** The Screens
   walk used to skip the `when` on any synthesized edge, so every
   `<Link to>` read as *always* while the `push()` beside it carried its guard.
   The reader works fine at a markup site — a JSX `{step1 ? <Link/> : …}` is a
   ternary like any other — and the site's own verb (`link`, `a`) is the honest
   label; `return` belongs only to an edge whose destination came from
   elsewhere, which is what `registeredAt` pointing at another line means.
10. **A route is not always a screen.** The Screens picture is about
   navigation, so it draws only routes named by a path; a route named with the
   HTTP method that reaches it is an endpoint and belongs on Entry points. Nuxt
   is the exception that names an endpoint like a page (`/api/users` from
   `server/api/`), and is excluded by file path.
11. **Detection runs before any file is indexed.** `declaredDependencies` caches
   per file-count for exactly this reason — an earlier version cached the empty
   pre-index answer and every framework whose dependency lived one directory
   down stayed undetected.

---

## The bar for calling one done

Per `CLAUDE.md`'s validation methodology, and what was actually done for the
four routers added on 2026-08-29:

1. **A real repo, not only a fixture.** Every defect in this session's work was
   caught by a real repository and none by the fixture written first.
2. **Recall against ground truth.** `grep` every navigation site in the source
   and account for each one: resolved, or correctly unresolved because it is
   computed.
3. **Precision, site by site.** For every synthesized edge, read the line its
   `registeredAt` names and confirm the tag or call there names that
   destination. Target: zero false positives.
4. **Controls re-indexed.** Node, edge, route and `navigates` counts on repos
   the change should not touch — a change to shared machinery is not done until
   they are byte-identical or the difference is explained.
5. **Full suite green**, and a CHANGELOG entry in the user-facing voice.

---

## Checking this file is still true

```bash
# Which frameworks emit navigates edges
grep -rn "edgeKind: 'navigates'\|kind: 'navigates'" src --include="*.ts" | sed 's|:.*||' | sort -u

# Which languages have branch-guard rules
sed -n "/^const RULES_BY_LANGUAGE/,/^\]);/p" src/graph/branch-guards.ts

# Whether a repo's Screens tab is on, and how many transitions it has
scripts/try-repo.sh <preset>        # prints the navigation count and says which tab is on
```

```sql
-- In a repo's .codegraph/codegraph.db
select count(*) from edges where kind='navigates';
select name, file_path from nodes where kind='route' order by name;   -- duplicates = a layout drawn as a screen
```
