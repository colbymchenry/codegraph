# Steps & Screens for APIs and web apps — handoff

**Status:** plan, written 2026-08-28 at the end of the session that built the Steps view and the
readings it rests on (Expo + React Native app, `amniservices-mobile-app`). **Updated the same day, later
sessions: P0–P6 are built** (see the per-item notes marked *Built*); P7 has its first agent A/B (proshop, small) and
the medium / large rows are open.
**Next: BUILT (2026-08-29).** `docs/plans/2026-08-29-steps-in-code-order.md` — the Steps tab reading a handler in the
code's order (a rail with forks) instead of the tree by distance; a derivation from this walk, no new walk. P0–P6 are
in (`src/ui-server/api/program.ts`, `ui/src/lib/program-model.ts`, spec §3.13.1); validating it against four real
servers also fixed three defects in THIS walk — a hop's span read from the wrong call, a name-match the call as
written disproves, and a value with one `references` edge going unlent the file's calls. Every claim about what a
resolver emits *today* was verified against the source on this date — re-verify before building on it,
the resolvers move. What was learned building it, beyond the plan: the index keeps only the LAST
segment of a deep member call (`create` for `prisma.user.create`) and name-matches it — often to the
wrong `create` at confidence 0.4 — so the Steps walk reads every call **as written** from the tree at
request time (`callSitesForFile`) and classifies on the chain; and the declared types of a class's
members (`private readonly usersService: UsersService`, `OwnerRepository owners`) are read from the
class body (`memberTypesInTree`) to send `this.usersService.findByEmail(…)` where the type says and to
call `owners.save` the database. Validation pictures: `gothinkster/node-express-realworld-example-app`,
`brocoders/nestjs-boilerplate`, `nestjs/nest/sample`, `fastapi/full-stack-fastapi-template`,
`Netflix/dispatch`, `spring-projects/spring-petclinic`, `spring-petclinic/spring-petclinic-kotlin`,
`dotnet-architecture/eShopOnWeb`, `jqlang/jq`, `redis/redis`, `android/nowinandroid`,
`Dimillian/IceCubesApp`, `TryGhost/Ghost` — each shot headlessly (`codegraph ui --no-open` + Playwright)
and read against the mobile app's picture.

**Goal.** The two pictures — **Screens** (`#/screens`, design spec §3.12) and **Steps**
(`#/steps`, §3.13) — must be as good on an Express / NestJS / Fastify API, a Next.js / React Router /
SvelteKit web app, and a monorepo that has both, as they are on the mobile app today. "As good" is
defined precisely in §1 below; it is not "draws something".

Companion reading, in this order: `docs/design/codegraph-ui-design-spec.md` §1 (principles), §3.12,
§3.13, §3.14; `CHANGELOG.md` `[Unreleased]` (the user-facing description of what shipped);
`docs/design/dynamic-dispatch-coverage-playbook.md` (the coverage rules and the validation method —
**"partial coverage is worse than none"** governs everything here); `CLAUDE.md` (tests, kernel, docs).

---

## 1. The bar: what "up to par" means

On the mobile app, selecting `/capture/review` and walking to the upload gives the reader, per link:

| Reading | Example | Where it comes from |
|---|---|---|
| **The step itself, typed** | `⇢ finalizeCaptureSession` (native call), `⇠ onZipComplete` (native event), `setZipUri` (store action), `axios.post(\`…/oauth/token\`, {…})` (leaves the index) | `src/ui-server/api/steps.ts` classification |
| **FIRES FROM** — what triggers it | `onSubmit · useFormik(…) in LoginButton`, `onPress · <Button>`, `addListener('onZipComplete')` | `graph/branch-guards.ts` `triggersForFile` — read at request time from the cached tree |
| **via** — the plumbing folded into the arrow | `via LoginButton → handleLogin`, `via uploadARCapture` | the walk's fold (`steps.ts`) |
| **WHEN** — the conditions, as words, one row per scenario | `WHEN NOT (busy \|\| late)` once, then `AND NOT user?.organization_id` · site, `AND user?.organization_id AND (…)` · site … | `guardsForFile` + `ui/src/lib/conditions.ts` (`scenarios`, `whenTokens`) |
| **with what** — the arguments as written | `SecureStore.setItemAsync('userEmail', values.email)`, `client.post('/frames', { uri })` | `callArgumentsForFile` |
| **Honesty** | other screens are boundaries (`…`), caps announced on the step they hit, synthesized hops dashed, a crossing needs evidence | `steps.ts` caps + `evidenced` rule |

An API or web project reaches the bar when its canonical flow — **request → guard/middleware →
handler → service → database → queue/email/other service → response** for an API, **page → data
fetch → user action → server action/route → database → redirect** for a web app — shows every one of
those readings on every link, on a real mid-size repo, with the caps and the boundaries behaving as
they do on the mobile app. Numbers to record per framework are in §7.

---

## 2. How the pictures work today — the facts they rest on

Read this before touching anything. Each picture is a pure function of a small set of graph facts;
extending the pictures to a new framework is almost entirely a matter of making the **same facts
exist** for it, plus wording.

### 2.1 Screens (`src/ui-server/api/screens.ts`, `ui/src/lib/screens-model.ts`)

| Needs | Today comes from |
|---|---|
| `route` nodes named by path (`/capture/review`) | `resolution/frameworks/expo-router.ts` (file-path routing); React Router / Next.js *pages* routes from `frameworks/react.ts` also exist but carry no navigation |
| route → the component that renders it (`calls` / `instantiates` edge out of the route) | expo-router resolver (default export of the screen file) |
| `navigates` edges from the function that pushes a path to the route it names, with `metadata.href` / `navMethod` | expo-router resolver (literal / template / pathname-object hrefs) + `resolution/expo-router-synthesizer.ts` (helper return values → `provenance: 'heuristic'`) |
| the attribution walk BACK from the navigation call to a screen's component, folding the chain into `via` | `screens.ts` (`attribute`, caps: 7 hops / 30 callers / 800 visited) |
| `when` per site | `createSiteReader(...).when` in `api/when.ts` → `guardsForFile` |

If there are no `navigates` edges the endpoint answers `routed: false` and the view says "No screen
navigation in this graph". **That is what every API and every non-Expo web app gets today.**

### 2.2 Steps (`src/ui-server/api/steps.ts`, `ui/src/lib/steps-model.ts`, `ui/src/views/StepsView.svelte`)

The walk: from the anchor, breadth-first over `calls` / `instantiates` / `navigates` /
function-as-value `references` (`metadata.fnRef`) / function→function `contains`, folding every node
that is not a step into `via`. A node **is** a step when it is one of:

| Kind | Evidence today | Server rule |
|---|---|---|
| `screen` | target is a `route` node | any edge into a route (a `navigates` edge in practice) |
| `trigger` (handler) | a function passed as a value (`fnRef`), **or** called from under an event binding — JSX prop, `on*` option, runs-later callback (`triggerInTree`) — and not a component, not a store action | `steps.ts` classification, `looksLikeComponent` |
| `bridge` ⇢ | language family changes JS→native **and** the edge is evidenced: `metadata.bridge === 'react-native'`, `resolvedBy === 'framework'`, or `provenance: 'heuristic'` | `crossing()` + `evidenced`; a plain name-matched cross-family call is dropped |
| `event` ⇠ | native→JS, evidenced (`synthesizedBy: 'rn-event-channel'`) | same |
| `store` | function in a store **file** (`STORE_FILE` regex: `stores?/`, `storage/`, `.store.ts`, `.slice.ts`…) — file-name evidence, the legend says so | `isStoreFile` |
| `effect` | an unresolved call, or a call that resolved to a `constant`/`variable`, whose text matches the curated `EFFECTS` table: `network`, `storage`, `device`, `telemetry` | `effectCategory`; one box per (function, category), `apis[]` listed |

Boundaries and caps (all announced on the step, `cut`): another **screen** (`through=1` enters it), a
native event landing in a **component** of another screen, depth (8 default, ≤14), fan-out per node
(80), folded nodes per step (300), steps per picture (120 default, ≤400); hubs (fan-in ≥ 40) and shared
chrome (a component rendered by ≥ 5 parents) are dead ends counted in `truncated`. HOC wrappers
(`memo(X)`) are seen through via the file-scope function reference within the wrapper's lines.

**Where the anchor's root comes from:** for a `route` anchor the walk starts at the component the
route renders — found as the first `calls`/`instantiates` edge OUT of the route node (`componentOf`
in `buildSteps`). This is correct for Expo Router and **wrong for every API framework** (§3, P0).

### 2.3 The request-time readings (`src/graph/branch-guards.ts`)

Nothing about these is stored in the index; they parse the file (LRU of 8 trees, 256 KB cap) and
answer per call site `(line, column)`:

- `guardsForFile` → the branch conditions (JS-family + Swift rules; a disjunctive guard keeps its parens).
- `callArgumentsForFile` → the argument list abbreviated (strings whole, objects as keys, `[…]`, `() => …`, `f(…)`, Swift labels).
- `triggersForFile` → `{ kind: 'prop' | 'option' | 'callback', name, of }`: JSX attribute (event prop, or any prop given a function), `on*` object key (with the call it configures, through arrays), argument of a runs-later callee (`LATER_CALLEES`). Named handlers (`const handleX = useCallback(…)`) are boundaries.

All three are **JS-family only** (`supportsBranchGuards`), Swift for guards. Python / Java / Go / Ruby
/ PHP have no rules — an API in those languages gets no WHEN, no arguments, no FIRES FROM (§3, P5).

### 2.4 The rest of the surface

- Wire types are mirrored by hand in `ui/src/lib/wire.ts`; the adapter method `steps` is **optional**
  (`ui/src/lib/adapter.ts`), `NavigationDriver.stepsHref` is **required** (a host driver must add it).
- Conditions vocabulary: `ui/src/lib/conditions.ts` (`WHEN`/`AND`/`OR`/`NOT` tokens, `scenarios`, common-prefix factoring). Both views use it.
- Tests: `__tests__/ui-steps-api.test.ts` (real RN + Expo fixture, end to end — **copy its shape for every new framework**), `ui-steps-model.test.ts`, `ui-conditions.test.ts`, `branch-guards.test.ts` (guards, arguments, triggers), `ui-screens-model.test.ts`, `expo-router.test.ts` (routed fixture + `buildScreens`).
- **Kernel parity:** TypeScript/JS *extraction* runs in the Rust kernel (`codegraph-kernel/src/tsjs/`); the TS extractor is the wasm fallback. Any extractor change → mirror in Rust, `npm run build:kernel`, test on both paths (`CODEGRAPH_KERNEL=0` for wasm) plus `kernel-tsjs-parity.test.ts`. Resolvers, synthesizers and the request-time readings are TS-only — no parity work.
- Verify visually: `npm run build` → `codegraph index` in the target project → `codegraph ui --no-open --port 4747 <project path>` → `GET /api/steps?symbol=<route name>` → headless playwright (`createRequire` from a repo that has it; `waitUntil: 'load'`, not `networkidle` — the viewer holds an SSE stream). See the auto-memory note `codegraph-viewer-workflow`.

---

## 3. What an API / web project gives us today (verified 2026-08-28)

| Framework | Route nodes | Route → handler | Navigation | Notes |
|---|---|---|---|---|
| **Express / Koa** (`frameworks/express.ts`) | `GET /path` from `app|router.METHOD('/path', …)` | **named handler**: a `references` edge route → handler (last argument; earlier arguments = middleware, **not linked**). **Inline arrow handler**: the route node itself gets `calls` edges to every function its body calls (regex; `RESERVED_CALLS` filtered) — the route *is* the handler | none | `router.use('/prefix', sub)` mounting is not prepended to paths (label only) |
| **NestJS** (`frameworks/nestjs.ts`) | `GET /users/:id` = `@Controller` prefix + `@Get` path; also GraphQL `@Query/@Mutation`, `@MessagePattern/@EventPattern`, `@SubscribeMessage` | `references` edge route → the decorated method; DI `this.svc.method()` resolves via receiver type (playbook: "no dynamic-dispatch hole") | none | `@UseGuards/@UseInterceptors/@UsePipes`, `@OnEvent`, `@Process/@Processor`, `@Cron` are **not** modelled — no guard chain, no event/queue channel |
| **Next.js** (`frameworks/react.ts`) | `pages/**` and `app/**` files with `export default` → a route named by path (`/blog/:slug`) | none (the page component is the default export in the same file, not linked from the route) | none — no `navigates` for `<Link href>`, `router.push`, `redirect()` | `app/api/**/route.ts` handlers (`export async function GET`) are **not** routes; server actions (`'use server'`) unknown; `middleware.ts` unknown |
| **React Router** | `<Route path component={C}/>` / `element={<C/>}`, object data-router (literal form) | `references` to the component | none | |
| **SvelteKit / Vue / Nuxt / Astro** | file routes | `svelteKitLoadEdges`, `vueTemplateEdges`, Pinia/Vuex channels | none | |
| **FastAPI / Django / Flask / Spring / Laravel / Rails / Gin / Axum** | routes + handler edges (resolvers); FastAPI `APIRouter(prefix=)` + literal `include_router(prefix=)` composed since 2026-08-28 (`python.ts` `postExtract`) | yes | — | WHEN / arguments / triggers built for Python, Java, Kotlin, C#, Go, C (P5) |

What the viewer does with that today: **Entry points** lists every route with its handler (this is the
"Screens" of an API today); **Screens** answers "no screen navigation" for all of them; **Steps**
anchored on an API route finds no root (`componentOf` looks for `calls`/`instantiates` out of the route;
Express named / Nest give `references`; an Express inline route's *first callee* becomes the root —
wrong) and draws the anchor alone. So the first task is small and unblocking.

Synthesizer channels that already exist and matter here (`resolution/callback-synthesizer.ts`):
`eventEmitterEdges` (JS `.on('x', fn)` ↔ `.emit('x')`), `springEventEdges`, `laravelEventEdges`,
`celeryDispatchEdges`, `sidekiqDispatchEdges`, `mediatrDispatchEdges`, `reduxThunkEdges`,
`rtkQueryEdges`, `objectRegistryEdges`, `ginMiddlewareChainEdges`, `svelteKitLoadEdges`. There is **no**
channel for: BullMQ / Bull (`queue.add('job')` ↔ `@Process('job')` / `new Worker('q', fn)`), Nest
`EventEmitter2` (`emit('x')` ↔ `@OnEvent('x')`), socket.io / Nest gateways, **client `fetch` → server
route**, tRPC, Next server actions. Those are the cross-tier hops — the API equivalent of the RN
bridge — and they are where a web app's "capture → upload" story breaks today.

---

## 4. The mapping — same pictures, same words, different facts

Keep the visual language exactly (spec §2 and §3.13): boxes, labelled arches, one accent, dashed = a
place the graph cannot follow into, accent rule = the code crosses a boundary. Only the *evidence* and
the *words* change.

| Mobile app (built) | HTTP API | Web app (Next.js / React Router / SvelteKit) |
|---|---|---|
| **screen** `/capture/review` — a box; other screens are boundaries | **endpoint** `POST /users` — a box; another endpoint reached by an internal HTTP call is a boundary | **page** `/blog/[slug]` — a box; another page reached by `<Link>` / `router.push` / `redirect()` is a boundary — this is the Screens picture proper |
| the entry screen `/`; Screens = transitions between screens | no entry; **Entry points** is the list. A "Routes" picture (endpoints + calls between them) only if a repo actually has inter-endpoint calls — measure before building | `/` (or the root layout); Screens = `<Link>` / `router.push` / `redirect` / `<a href>` between pages (P4) |
| **handler** `handleLogin` — FIRES FROM `onSubmit · useFormik(…)` | **handler** `createUser` — FIRES FROM `POST /users` **after** `authenticate, validate(schema)` (Express middleware args), `@UseGuards(JwtGuard)` (Nest); a queue consumer FIRES FROM `@Process('email')` / `new Worker('email')`; a cron FIRES FROM `@Cron('0 * * * *')`; an event listener FIRES FROM `@OnEvent('user.created')` | a page's data fetch FIRES FROM **page load** (`getServerSideProps`, RSC render, `load()`); a client handler FIRES FROM `onSubmit · <form>` / `action={createPost}`; a server action FIRES FROM the form/handler that calls it |
| **⇢ native call** (JS→Swift, RN bridge evidence) | **⇢ another tier**: outbound HTTP to another service (`fetch('https://…')` = effect `network`; to **our own** route with a literal path = a link to that endpoint box), queue publish (`queue.add('email', {…})` → ⇢ the consumer) | **⇢ server**: client `fetch('/api/users')` → the `route.ts` handler; a server action call from a client component; a tRPC mutation → its procedure |
| **⇠ native event** (`sendEvent(withName:)` → listener) | **⇠ from a queue / bus**: the consumer landing (`@Process('email')`), an event landing (`@OnEvent`), a websocket message landing | **⇠ from the server**: SSE / websocket / push landing in a client handler; `revalidatePath` (announce, don't draw) |
| **store action** (by store file) | **data**: an ORM / repository / query call — `prisma.user.findMany({ where, select })`, `this.userRepo.save(user)`, `User.findOne(…)`, `knex('users').insert(…)`, `db.query(sql)` — evidence = the receiver's import origin (prisma / typeorm / mongoose / drizzle / knex / pg / mysql2 / sequelize / kysely) or a known repository type; **the model or table comes from the receiver or the first argument**, read vs write from the method name | same as API on the server side; on the client, a store (Zustand / Redux / React Query cache) as today |
| **outside the index**: `network`, `storage`, `device`, `telemetry` | add **`database`** (above), **`queue`** (bull/bullmq `add`, `sqs.send`, `kafka.produce`, `pubsub.publish`), **`email`** (nodemailer, sendgrid, resend, ses), **`payments`** (stripe, braintree), **`cache`** (redis / ioredis / memcached / `cache.set`), **`auth`** (jwt sign/verify, bcrypt/argon), **`response`** (below), `storage` gains S3 / GCS / fs | same, plus `response` = `NextResponse.json`, `redirect()`, `notFound()` |
| — | **response** as a step: every `res.status(404).json({ error })`, `throw new NotFoundException(…)`, `reply.code(201).send(…)`, `return c.json(…)`, `raise HTTPException(…)` is a scenario row with its **WHEN** and its **arguments** (the body). Together they are the endpoint's contract *as the code has it* — the single most valuable reading for an API, and it falls out of the existing scenario rows once `response` is an effect category | `redirect('/login')` is both a response and a navigation (draw as the navigation) |
| **WHEN** (guards, words, scenario rows) | same — plus the guard/middleware chain is the *shared prefix* said once (`FIRES FROM POST /users after authenticate`) | same |
| **with what** (arguments) | same; especially `res.status(404).json({ error })`, `prisma.user.create({ data: { email, name } })`, `fetch(\`/api/users/${id}\`, { method: 'POST' })` | same |
| **via** (folded plumbing) | controller → service → repository chains fold into `via` as hooks do today; the panel promotes it (`--ink-2`) | same |

Words in the legend and the panel switch on the anchor: when the anchor's route name leads with an HTTP
verb (`splitRouteName` in `api/routes.ts`), `screen` reads **endpoint**, `store` reads **data**,
`bridge` reads **crosses a tier**, `event` reads **arrives from a queue / bus / the server**. Keep
`kindWord()` in `steps-model.ts` as the one place that decides.

---

## 5. Work plan, in order

Each item: what, where, the evidence rule (never guess — a wrong edge is worse than none), the test,
and what "done" looks like on the picture. Do them in this order; P0 unblocks everything, P1–P3 make an
API picture worth looking at, P4 makes a web app a Screens app, P5 widens the languages, P6 is words,
P7 is the proof.

### P0 — The root of an API route (small, unblocking)

*Built* — `src/ui-server/api/route-roots.ts` (`routeRoots`, shared by `steps.ts` and `screens.ts`), the
chooser lists endpoints by router file, `WireStep.screen` gained `endpoint` / `inline`; test
`__tests__/ui-steps-api-servers.test.ts` (Express named + inline, Nest, FastAPI, Spring in one fixture).

*Where:* `src/ui-server/api/steps.ts` (`buildSteps`, the `componentOf` map), and the same map in
`screens.ts` for consistency.

*Rule:* the root of a route anchor is, in order: (1) the target of the route's `references` edge whose
target is a function/method (Express named handler, Nest method, React Router component); (2) the
route's `calls`/`instantiates` target **only when it is a component** (`looksLikeComponent`, Expo/React
pages); (3) the route node itself when it carries `calls` edges and nothing else (Express inline arrow —
walk its callees as if the route were the handler; label the anchor `POST /users` and say "inline
handler" in the sub line). Cross-check with the routing manifest (`cg.getRoutingManifest`,
`api/routes.ts` resolves `handlerId` by file+line+name) and prefer it when both exist.

*Also:* the Steps chooser (`StepsView.svelte`, the `!asked` branch) lists **routes** from `/api/routes`
when `/api/screens` is not routed — grouped by router file, `METHOD path`, most-connected first.

*Test:* extend `ui-steps-api.test.ts` with an Express fixture (one named-handler route with middleware
args, one inline-arrow route) and a Nest fixture (controller with `@Controller('users')` +
`@Get(':id')` + `@Post()`; a service injected via constructor; a repository). Assert the root, the first
row, and that the walk reaches the service and the repository call.

*Done when:* `#/steps?symbol=POST%20/users` on the fixture draws the handler's steps, not the anchor alone.

### P1 — Effects for servers: `database`, `response`, `queue`, `email`, `payments`, `cache`, `auth`

*Built* — `src/ui-server/api/effects.ts` (`classifyEffect`, `responseStatus`; rules per language family,
`process` and Android rows added beyond the plan; `effect.model` / `access`, `site.status`, a response box
per status since 2026-08-29 — the outcome is the box's identity, the line's pill its condition); tests `__tests__/ui-effects.test.ts`. Matching is on the call as written and on the
receiver's declared type when the call leaves the index through it — see the status note at the top.

*Where:* `EFFECTS` in `steps.ts` (make it a module of its own, `api/effects.ts`, with a table per
category and unit tests — it is about to grow); `stepSub`/legend words in `steps-model.ts` / `StepsView.svelte`.

*Rules:*
- `database`: the receiver is a **known ORM client** — decide by the reference text *and* the import
  origin of the receiver's binding when the graph has it (`prisma.*` where `prisma` is imported from
  `@prisma/client` or a project file that constructs `new PrismaClient()`; `this.repo`/`this.*Repository`
  typed `Repository<T>` (TypeORM); `Model.find*/create/update*/delete*` on a Mongoose model; `knex(…)`,
  `db.select/insert/update/delete` (Drizzle), `pool.query`/`client.query` (pg), `sequelize`/`Model.*`,
  `kysely`). The step's label is the call with its arguments as today; add `effect.model` = the model /
  table when it can be read (`prisma.user` → `user`; `Repository<User>` → `User`; `knex('users')` →
  `users`; raw SQL: first table after `FROM|INTO|UPDATE|JOIN`), and `effect.access = 'read' | 'write'`
  from the method name (`find*/get*/count/aggregate/select` vs `create/update/upsert/delete/save/insert/remove`).
  Box: `prisma.user.create({ data })` / sub `data · write · user · createUser`.
- `response`: `res.status(…).json|send|end`, `res.json|send|sendStatus|redirect|render`,
  `reply.code|send`, `c.json|text|redirect` (Hono), `NextResponse.json|redirect`, `throw new
  *Exception(…)` / `throw new HttpError(…)` / `next(err)`, Python `raise HTTPException`, Spring
  `ResponseEntity.*`, Go `c.JSON(…)`/`http.Error`. One box per (function, `response`) with `apis[]` as
  today — **but the panel's scenario rows are the contract**, so keep every site with its WHEN and
  arguments. Read the status code out of the arguments when literal (`status(404)`) and put it on the
  site (`site.status`) so a row can say `404 · { error }`.
- `queue`, `email`, `payments`, `cache`, `auth`: receiver/method tables like `network` today. Keep the
  table curated and documented; false positives here are visible noise.

*Test:* `api/effects.test.ts` over the table; extend the P0 fixtures with a Prisma create, a
`res.status(404).json`, a `throw new NotFoundException`, a `queue.add('email', {…})`.

*Done when:* `POST /users` shows `prisma.user.create({ data })`, `queue.add('email', {…})`, and the
`response` box whose rows read `WHEN NOT user → 404 · { error: 'not found' }` / `always → 201 · user`.

### P2 — Triggers for servers: the request, the guard chain, jobs, events, cron

*Built* — `request` / `decorator` trigger kinds with `after` (the chain); Express-family middleware from the
registration's arguments, guard decorators from `decoratorsForFile` (the index keeps no decorators), FastAPI
`dependencies=[…]`; consumer decorators on a function anchored by name. The queue-consumer *reachability*
(producer → `@Process`) is P3's.

*Where:* `triggerInTree` in `graph/branch-guards.ts` gains a `decorator` form; `steps.ts` sets the
anchor's / handler's trigger from the **route registration**, not from a JSX prop.

*Rules:*
- The trigger of a route's handler is the route itself: `{ kind: 'request', name: 'POST', of: '/users' }`
  → `FIRES FROM POST /users`. The middleware / guard chain is read at the **registration site**: Express —
  every argument before the handler in `app.post('/users', authenticate, validate(schema), createUser)`
  (the resolver already knows the site line; read the arguments with `callArgumentsForFile` and drop the
  last); Nest — `@UseGuards(...)`, `@UseInterceptors(...)`, `@UsePipes(...)` on the method **and** on the
  class (class-level applies to every method); Fastify `{ preHandler: [...] }`; Koa `router.post(path,
  mw, handler)`; Hono `app.post(path, mw, handler)`. Render as `FIRES FROM POST /users · after
  authenticate, validate(…)` and put the chain on the link (`trigger.after: string[]`). Global
  `app.use(mw)` before the route is a chain element too — read in file order, announce it as "global".
- Queue consumers, event listeners, cron, message patterns, websocket handlers as triggers: Nest
  decorators `@Process('x')`, `@OnEvent('x')`, `@Cron(expr)`, `@MessagePattern('x')`,
  `@SubscribeMessage('x')`; Bull/BullMQ `queue.process('x', fn)` / `new Worker('q', fn)`; node-cron
  `cron.schedule(expr, fn)`; socket.io `socket.on('x', fn)`; Kafka/SQS consumers. The `option` and
  `callback` forms already cover several of these (`process('x', fn)` = callback of `process` with first
  literal `'x'` → add the names to `LATER_CALLEES`); decorators need the new form: climb from the site to
  the decorated method/class and read `decorator` nodes (`@Name(args)`).

*Test:* `branch-guards.test.ts` `triggers` block: Express registration with middleware, Nest guards on
class and method, `@Process`, `@Cron`, `queue.process`, `socket.on`.

*Done when:* the handler box's sub line reads `POST /users · after authenticate, validate(…)` and a
consumer reads `FIRES FROM @Process('email')`.

### P3 — Cross-tier channels (the RN bridge, for the web)

*Built* (2026-08-28, later session) — `src/resolution/tier-synthesizer.ts` (one pass, three channels: `http-client` with
`tier: 'client→server'`, `queue-job`, `event-bus` for a bus and for sockets both ways; registered before the emitter pass), Next
server actions marked at request time from the `'use server'` directive (`api/when.ts` `directive`), `crossing()` in `steps.ts`
reading `tier` / `channel`, an endpoint reached across a tier drawn as a bridge box that is a boundary like a screen, a channel's
call never also an effect, a top-level `new Worker` landing on its constant with the file-scope calls lent to it; Express mounts
(`app.use('/api', router)`, nested, by import or `require`) composed onto route names in `postExtract`, and the chained
`router.route('/x').get(h).put(h2)` form extracted; `e2e/` counts as a test directory. Test: `__tests__/ui-steps-cross-tier.test.ts`.
Later the same day: FastAPI `APIRouter(prefix=)` + literal `include_router(prefix=)` composed (`python.ts` `postExtract`;
`fastapi/full-stack-fastapi-template` 23 routes now read `GET /items/{id}` instead of `GET /`; its `settings.API_V1_STR`
mount is skipped, not guessed) and the ASP.NET endpoint-group form (`csharp.ts`: `groupBuilder.MapPost(Handler[, "path"])`
under the class, the app's `$"/api/{groupName}"` head read in `postExtract`, `RoutePrefix` honoured — the
`jasontaylordev/CleanArchitecture` shape). Verified on `bradtraversy/proshop_mern` (30 routes, 23 client→route edges, every one correct on inspection; `login` reads
`login → ⇢ POST /api/users/login (authUser) → User.findOne({ email }) → 401 rows → jwt.sign via generateToken`, which needed
`routeRoots` to accept a function-valued constant — `const authUser = asyncHandler(async (req, res) => …)` — and the walk to lend
such a value the file-scope calls and unresolved refs within its lines; and framework detection to read a workspace's
`package.json` (`frameworks/package-deps.ts`), proshop keeping `react` in `frontend/`) and `nestjs/nest`
(`sample/26-queues` `transcode` → `@Process('transcode')`, `sample/30-event-emitter` → `@OnEvent`; the `integration/*/e2e`
helpers no longer count). **Not built:** tRPC (a procedure's inline handler is not a node — extractor work with the kernel twin).
**Gap found:** a nested `const handleSubmit = async (e) => …` inside a component is not a node (only `function` declarations and
`useCallback`-bound arrows are — `tree-sitter.ts` `reactHookBoundName`), so such a handler's `fetch` attributes to the component and
the link carries no FIRES FROM; the fix is an extractor rule for a nested arrow bound by a declarator, in TS and in the Rust kernel.

*Where:* new synthesizers in `resolution/callback-synthesizer.ts` (register in the channel list with a
language gate), or a resolver for the resolvable ones; each tagged `provenance: 'heuristic'`,
`synthesizedBy`, `registeredAt`. **Close both directions before shipping any of them** (playbook).

1. **HTTP call → own route.** A JS/TS call `fetch('/api/users/…')`, `axios.post('/api/users')`,
   `api.get('/users')` (a project axios instance with a literal `baseURL`) whose path literal (or
   template with `${…}` segments as `:param`) matches a route node `METHOD path` in the same index
   (method from the call: `fetch(url, { method: 'POST' })`, `axios.post`, else GET). Prefix-aware:
   Express `router.use('/api', usersRouter)` mounts (P0's resolver gap — fix the label there too),
   Next `app/api/**/route.ts` (P4). Edge: caller → route, kind `calls`, `metadata.tier: 'client→server'`,
   confidence by how much of the path was literal. **Steps then draws the route as a `bridge` box
   (`⇢ POST /api/users`) and, with `through=1`, walks on into the handler** — the capture→upload story
   for a web app. Evidence bar: the path must be literal enough to match exactly one route; a bare
   `fetch(url)` with a variable url produces nothing.
2. **Next server actions** (P4 prerequisite): a function in a `'use server'` file, or marked with the
   directive, called from a client component / passed as `action={fn}` → the call edge exists already
   (it is a normal import); mark it `tier: 'client→server'` at resolution (the callee's file has the
   directive) so Steps classifies it as `bridge` with evidence.
3. **tRPC**: `trpc.users.create.useMutation()` / `.mutate(…)` ↔ `router({ users: router({ create:
   procedure.mutation(…) }) })`: match the dotted path against the router object keys (object-literal
   member resolution exists: `resolveObjectLiteralMember`). Client → procedure handler, `tier`.
4. **Queues / buses**: BullMQ `queue.add('job', …)` ↔ `@Process('job')` / `worker = new Worker('q',
   fn)`; Nest `EventEmitter2.emit('x')` ↔ `@OnEvent('x')`; socket.io `server.emit('x')` ↔ `socket.on('x')`
   and Nest `@SubscribeMessage('x')`. Same shape as `rnEventEdges` (literal on both sides, fan-out cap,
   `event` metadata); Steps classifies the landing as `event` ⇠ when the edge is synthesized and crosses
   into a handler — extend `crossing()` to accept a `tier`/`channel` marker, since both sides are TS.

*Test:* a monorepo fixture (`apps/web` Next page with a `fetch('/api/users')` + `apps/api` Express
`app.post('/api/users')`), a BullMQ producer/consumer, a Nest `emit`/`@OnEvent` pair. Assert the edges
(source, target, metadata) and that `buildSteps` from the page reaches the database effect **through**
the route with `through=1`.

*Done when:* from the web app's page, the picture reads `page → handler → ⇢ POST /api/users … →
prisma.user.create → response`, dashed where synthesized, with `registeredAt` in the panel.

### P4 — Next.js as a Screens app

*Built* (2026-08-28, later session) — `frameworks/nextjs.ts` split out of `react.ts` (App Router pages and `route.ts` handlers,
Pages Router pages and `pages/api`, `(group)` stripped, `[slug]` → `:slug`, `[...all]` → `:all*`, parallel / intercepting
routes skipped; a page's `calls` ref to its default export via `defaultExportName`; `resolve()` claiming `router.push|replace|
prefetch`, `redirect`, `permanentRedirect`, `NextResponse.redirect(new URL(…))` through the Expo href readers — now exported —
against a Next-only route table gated on the app's root), `next-router-synthesizer.ts` (`<Link href>`, internal `<a href>` →
dashed `navigates` from the component), `scoreMatch` accepting `:param` / `:all*`, the `load` trigger and `project: 'web'` for a
Next page in `steps.ts`, `{ status: 201 }` read off the call site for response rows. Test `__tests__/nextjs.test.ts`.
Route-handler references resolve by name with the same-file preference (`GET` / `POST` are common names). **Not built:** `revalidatePath`
as a refresh, `middleware.ts` `config.matcher` as a global guard, a helper's return value as a destination (Expo has it).
**Verified on `leerob/next-saas-starter`:** 8 pages + 4 endpoints, Screens routed (12 screens, 15 links), `<Link>`s in the
layout, `redirect()` in the actions, `NextResponse.redirect` in the middleware and the checkout handler all bound. Two
gaps it showed, both the wrapped-arrow idiom: `export const signIn = validatedAction(schema, async (data) => { … })` holds
its `redirect` on the FILE node (Screens now re-attributes a file-scope navigation to the value spanning it), and
`useActionState(signIn, …)` leaves no function-as-value edge (a plain call argument — Screens now falls back to the
functions that MENTION the value in the files importing it, read from the source; the principled fix is an extractor
fnRef rule for `useActionState` / `useFormState` / `startTransition` arguments, with the Rust kernel twin).
With both: 12 screens, 17 links, 8 origins — `/sign-in → /dashboard via Login > signIn WHEN userWithTeam.length !== 0 &&
isPasswordValid && redirectTo !== 'checkout'`, `/dashboard/security → /sign-in via deleteAccount WHEN isPasswordValid`.

*Where:* `resolution/frameworks/react.ts` (split a `nextjs.ts` out of it — the pages/app routing is
already there), a `next-router-synthesizer.ts` modelled on `expo-router-synthesizer.ts`.

*Rules:*
- Routes: App Router `app/**/page.{tsx,jsx,js}` → page route named by path (`(group)` stripped,
  `[slug]` → `:slug`, `[...all]`, parallel/intercepting routes announced not modelled);
  `app/**/route.ts` exports `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS` → one route node each, `METHOD
  /api/…`, with a `references` edge to the exported function; Pages Router `pages/**` and `pages/api/**`
  (default export = handler; method from `req.method` switches — announce as `ANY`). `layout.tsx`,
  `loading.tsx`, `error.tsx` are not routes; `middleware.ts` with `config.matcher` is a global guard (P2 chain).
- Route → component: the page file's default export (`defaultExportName` exists in expo-router's
  resolver — reuse) → `calls` edge, exactly as Expo Router.
- `navigates`: `<Link href="/x">` (JSX attribute literal / template / object `{ pathname }`),
  `router.push|replace('/x')` from `next/navigation` and `next/router`, `redirect('/x')` /
  `permanentRedirect` (server), `NextResponse.redirect(new URL('/x', req.url))` in middleware and route
  handlers, `<a href="/x">` to an internal path, `revalidatePath('/x')` (announce as a *refresh*, not a
  navigation). Helper return values through the existing return-value synthesizer pattern.
- Triggers on a page: the page's server work FIRES FROM **page load** (`{ kind: 'load', name: 'GET',
  of: '/blog/[slug]' }`) — the RSC body, `getServerSideProps`, `generateMetadata`; client handlers as today.

*Test:* an `expo-router.test.ts`-shaped Next fixture: two pages, a `<Link>`, a `router.push` behind a
condition, a `redirect()` in a server action, a `route.ts` `POST`; assert routes, `navigates` metadata
(`href`, `navMethod`), `buildScreens` (`routed: true`, the transition with its `when` and `via`), and
`buildSteps` from a page reaching the server action (`⇢`) and the Prisma call.

*Done when:* a Next app lands on the Screens tab like the mobile app does, and a page's Steps picture
shows load-time data, handlers, server actions and route handlers as boundaries.

### P5 — WHEN / arguments / triggers for Python, Java, Go (then Ruby, PHP, C#)

*Built* for Python, Java, Kotlin, C#, Go, C / C++ / Objective-C (guards, arguments, the call as written,
decorators, member types); Ruby and PHP still yield nothing. Test `__tests__/branch-guards-languages.test.ts`.

*Where:* `graph/branch-guards.ts` — `Rules` per language for guards (`if`/`elif`/`else`, early
`return`/`raise`/`continue`, `try`/`except`, `match`; Java `if`/`switch`/`throw`; Go `if err != nil {
return }` as the idiomatic early exit, `switch`/`select`); argument containers (`argument_list`,
`keyword_argument` → `name=value`); triggers (FastAPI `@router.post('/x', dependencies=[Depends(auth)])`,
Flask `@app.route`, Django URLconf + `@login_required`; Spring `@PreAuthorize`, `@Transactional`;
Gin middleware chain — `ginMiddlewareChainEdges` already knows it). Request-time only — no kernel work.
`supportsBranchGuards` widens per language as rules land; a language without rules must still yield
*nothing*, never a wrong label (§1 principle 6).

*Test:* `branch-guards.test.ts` blocks per language, mirroring the JS ones.

*Done when:* a FastAPI route's Steps picture carries the same four readings as an Express one.

### P6 — Words and the chooser

*Built* — `project` on the wire, `kindWord` / `kindWords` / `countWords`, the legend per project kind, the
endpoint chooser. The Screens tab stays hidden for an API (no `navigates`).

*Where:* `ui/src/lib/steps-model.ts` (`kindWord`, `stepSub`, `stepLabel`), `StepsView.svelte` legend
and summary, `api/steps.ts` (`WireStepsPayload.project: 'app' | 'api' | 'web'` decided from the route
names and the frameworks detected, so the viewer does not guess).

- Endpoint boxes: `POST /users` mono, sub = handler name · file (like a screen's component). Response
  boxes: dashed like other effects, label the status codes when literal (`404 · 201`).
- Kind words per project kind (§4 table). The legend re-words itself from the same table. Keep the
  sentence-case, no-tracking rule (spec §2) — capitals are only the condition keywords.
- The chooser: routes grouped by router file, then pages; "most connected" by fan-out of the handler.
- The Screens tab for an API: hide it (as today when `routed: false`) unless P3's inter-endpoint links
  produce a picture with more than a handful of arrows — measure on the validation repos first; the
  Entry points view is the honest list until then.

### P7 — Validation set and the numbers

*First numbers* (2026-08-28, later session) — the deterministic half is in the playbook §6 rows (Next.js, MERN, Nest
channels, FastAPI prefixed routers, ASP.NET endpoint groups: node counts, edge precision spot-checks, pictures). One agent
A/B so far, `bradtraversy/proshop_mern` (small, Express + React), `scripts/agent-eval/run-all.sh`, Sonnet/high, 2 runs per
arm, a daemon pre-warmed before each with-run, the CLI shim on (0 leaks): *"How does submitting the login form reach the
database, and what does the API respond with when the password is wrong?"* — with codegraph 14s / 14s, 2 tool calls, 0 Read,
0 Grep, 1–2 explores, the full path named (`submitHandler → login → POST /api/users/login → authUser → User.findOne →
matchPassword → 401`); without 18s / 37s, 14 / 8 tool calls, 7 / 1 Read plus Bash `cat`s and a subagent. Tokens 153k/165k vs
237k/369k. The pass bar (§4 of the playbook) holds on the small repo. **Still open:** the medium / large rows (Ghost,
immich, cal.com / twenty), ≥3 prompts per framework, and a control repo. The driver lives in the session scratchpad
(`ab-proshop.sh`: pre-warm `serve --mcp` with `CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` high and `CODEGRAPH_WASM_RELAUNCHED=1`,
then `run-all.sh` per run with its own `AGENT_EVAL_OUT`); re-create it from the memory note.

Small fixtures live in the tests. For the real bar, index these and record the results in
`docs/design/dynamic-dispatch-coverage-playbook.md` (new rows) exactly as the playbook asks
(**≥3 flow prompts × small/medium/large, node count stable, synthesized-edge precision spot-check,
agent A/B with `--model sonnet`, ≥2 runs per arm**):

| Framework | Small | Medium / large | Canonical flow to draw |
|---|---|---|---|
| Express | `gothinkster/node-express-realworld-example-app` | `TryGhost/Ghost` | `POST /api/articles` → `auth` → handler → service → DB → 201 / 422 |
| NestJS | `nestjs/nest/sample/01-cats-app` (and `sample/*`) | `immich-app/immich`, `amplication/amplication` | `POST /assets` → `@UseGuards(Auth)` → controller → service → repository → queue job → `@Process` consumer |
| Next.js | `vercel/next.js/examples/*` (app-dir + prisma) | `calcom/cal.com` (Next + Prisma + tRPC), `twentyhq/twenty` (Nest + Next monorepo — the cross-tier story) | page load → data → form action → server action / route handler → DB → `redirect` |
| FastAPI | `tiangolo/full-stack-fastapi-template` | — | `POST /users` → `Depends(get_current_user)` → CRUD → session commit → `HTTPException` rows |
| Spring | `spring-projects/spring-petclinic` | — | controller → service → JPA repository → view / `ResponseEntity` |

Acceptance per framework: the canonical flow drawn end to end with all four readings on every link;
boundaries where they should be; no picture over the caps at depth 8 on the small repo; every
synthesized edge in the picture spot-checked against the source; the agent A/B not regressing the
control repos.

---

## 6. Conventions and gotchas (learned the hard way this session)

- **Extractor changes need the Rust twin** (§2.4). A TS-only extractor patch silently does nothing on
  a machine with the kernel binary staged — tests pass under `CODEGRAPH_KERNEL=0` and fail by default.
- **Function-as-value capture is what makes handlers visible**: JSX attribute values, `on*` options,
  object shorthand members (`return { handleX }`) are capture sites (`TS_JS_SPEC.dispatch` in
  `extraction/function-ref.ts`, mirrored in `codegraph-kernel/src/tsjs/fnref.rs`). The gate is
  "defined in this file or imported" — a handler that comes out of a hook destructure in another file is
  found through `contains`, and P0's route handlers through `references`. When a handler folds that
  should be a box, check which of these it fell through.
- **Evidence over inference.** A cross-family edge without `resolvedBy: 'framework'`, `bridge`, or
  `provenance: 'heuristic'` is name-matcher noise (`arr.flat()` landing on a Swift `flat`) and Steps
  drops it. Keep that rule for tiers: a `fetch` with a variable URL is nothing, not a guess.
- **Two passes per fold** (classify arrivals, then fold the rest) so a node that is a step is never also
  folded through its `contains` edge; keep `defines …` sites out of the rows when a call site exists.
- **Readings are per site.** `WireStepSite.when`, `.args`, `.trigger` — the link's `when`/`trigger` is
  only the summary. Scenario rows and the common-prefix factoring are in `ui/src/lib/conditions.ts`.
- **Caps are announced, never silent** (`cut`, `truncated`). A new cap must say so on the step it hits.
- **Docs to update with every change**: the design spec section, `CHANGELOG.md` `[Unreleased]` in the
  user-facing style the file prescribes (no paths / symbol names / numbers), `CLAUDE.md` if a module or a
  rule is added. The coverage playbook gets a row per validated framework.
- **The UI package seam**: `ui/src/lib/adapter.ts` (`steps` optional), `navigation.ts`
  (`stepsHref` required — the Pro app's driver must add it), `check-ui-package.mjs` prunes the app shell;
  nothing outside `adapter.ts` may reach the network.
- **Known flake**: `__tests__/mcp-daemon.test.ts` "daemon idle-times-out" fails under full-suite load
  (~1 in 3 runs) and passes alone. Not related to any of this.
- **Do not commit or push** unless asked; the session's work is uncommitted on `main`'s working tree of
  `~/Development/CodeGraph/codegraph` (27 modified, 12 new files as of this writing) — branch first
  (`feature/…`) when you do.

---

## 7. Open questions for the maintainer

1. **A "Routes" picture for pure APIs, or Entry points as the list?** Recommendation: measure
   inter-endpoint links on the validation repos after P3; build the picture only if it has arrows.
2. **`response` as steps** (recommended: yes — the contract-as-code reading) vs. folded into the handler.
3. **How much schema on `database` boxes**: model + read/write from the call (cheap, proposed) vs.
   fields from the ORM schema (Prisma `schema.prisma`, TypeORM entities) — a later, separate reading.
4. **Project kind on the wire** (`app | api | web`) decided server-side from routes + frameworks, or a
   viewer toggle? Recommended: server-side, with the viewer allowed to override in the URL.
