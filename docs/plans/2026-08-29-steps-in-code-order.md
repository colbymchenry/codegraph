# Steps, in the code's order — plan

**Status: BUILT** 2026-08-29 on `feature/steps-servers`, P0–P6. Written the same day (at tip `5797d7e`) as a plan for a
fresh session; what follows is that plan, kept as written, with the notes below on where the build differs from it.
The reading is `&view=order` on the Steps tab, `src/ui-server/api/program.ts` + `ui/src/lib/program-model.ts`, and
spec §3.13.1 is the description of what was built.

**Where the build differs from the plan:**
- **A guard carries the decision it belongs to** (`BranchGuard.branch`), not just its text and line — §4.1's
  "same `line`, same `text`" pairing does not tell one `switch` case from another, nor two `try`/`catch` blocks apart.
  It also carries how the arm it is in leaves (`armExit`) and, for an early exit, how the arm not taken leaves (`exit`),
  which is where `WireArm.ends` comes from.
- **A function is read ONCE per rail** (`again` on the item), not redrawn at every call: expanding per path turned an
  87-step screen into 3,849 items and 618 KB. Once-only is 476 items and 94 KB (+3% wall clock on that picture).
- **A step the walk entered reads on into its own body** under its box, so the rail holds the same steps the tree does
  (§4.1.7 only said this for boundaries under `through`).
- **`WireItem`'s blocks are one kind with a discriminator** (`block: 'inline' | 'loop' | 'later' | 'together'`) rather
  than four item kinds, and they carry facts (`by`, `via`, `loop`) rather than words — the viewer says them.
- **The reading is drawn on the CANVAS, not as a nested document.** §4.2's rail — a column of boxes with forks as rows
  of arm columns — was built first and rejected on sight by the maintainer: *"this is very hard to read… go back to the
  way it looked, but since the 200 and 401 come after the signing of the jwt those should branch out of it."* The right
  picture is the same Svelte Flow canvas with the same boxes, laid out by WHEN things happen: a line means **and then**,
  a row down is one more thing already done, and the fork's condition rides on the line (drawn at rest — on this
  picture the conditions are the content). `ui/src/lib/program-model.ts` turns the block tree into that graph;
  `StepsRail`/`RailBlock` are gone.
- **Loops needed their own reading** (`loopsForFile`), and loops and forks nest by which construct BEGINS first, since
  neither reading knows about the other.
- The open questions of §7 were answered: order for functions/endpoints and the tree for screens (1); read each
  function once rather than capping the fold depth (2); a loop's body once, marked (3); the fork carries its condition
  and the arms say WHEN / WHEN NOT (4).

The Steps tab as it stood (spec §3.13, `src/ui-server/api/steps.ts`, `ui/src/views/StepsView.svelte`) is the base;
everything here is a second *reading* of the same walk, not a new walk.

**The ask, in the maintainer's words:** on proshop's `POST /api/users/login` the picture draws `User.findOne · jwt.sign ·
200 · 401` in one row under the handler. That is true — all four are one step from `authUser` — and it is not what a
person wants from a handler. They want *the flow of the code*: first the lookup, then **if** the password matches, sign a
token and answer 200, **else** answer 401. "I think this should show the flow/order of the code. That would be way more
useful to me." Build that.

Read first, in this order: spec §3.13 and §3.14 (`docs/design/codegraph-ui-design-spec.md`), then
`docs/plans/2026-08-28-steps-and-screens-for-apis-and-web.md` §2 and §6 (how the pictures work and the gotchas), then the
auto-memory note `steps-for-apis-2026-08-28` (the two facts that made Steps work, the screenshot harness), then the files in
§3 below. `CLAUDE.md` for tests, docs and the no-kernel-work rule (this plan is all request-time: no extractor changes).

---

## 1. The reading to build

For `authUser` in `bradtraversy/proshop_mern` (`backend/controllers/userController.js`):

```js
const user = await User.findOne({ email })
if (user && (await user.matchPassword(password))) {
  res.json({ _id: user._id, …, token: generateToken(user._id) })
} else {
  res.status(401)
  throw new Error('Invalid email or password')
}
```

the picture reads top to bottom, as a rail that forks where the code forks:

```
● POST /api/users/login · authUser          FIRES FROM POST /api/users/login
│
├─ User.findOne({ email })                  database · User · read
│
╞═ user && (await user.matchPassword(password))
│    ┌─ WHEN ──────────────────────────┐   ┌─ WHEN NOT ─────────────────────────┐
│    │ jwt.sign({ id }, …)  auth        │   │ 401 · res.status(401)   response    │
│    │   via generateToken · inside     │   │   then throw new Error('Invalid …') │
│    │   res.json(…)                    │   └─────────────────────────────────────┘
│    │ 200 · res.json({ _id, …, token })│
│    └─────────────────────────────────┘
```

Every reading the Steps tab has today survives on each box — kind, `FIRES FROM`, `via`, `WHEN`, what it passes, the status,
`inside res.json(…)` — but the *arrangement* is the code's: **sequence down the rail, branches as forks, an arm that
replies (or returns / throws) ends there, arms that fall through rejoin.** A helper the walk folded (`generateToken`) is
drawn *in place*: its own steps appear where it is called, marked `via generateToken`. A boundary (another endpoint the
handler calls, another screen) sits in the sequence where the call is, still not entered unless `through` asks.

The reading is the **outline of a function**, not a control-flow graph: statements in source order, `if` / `else` /
`switch` / `try` / early exits as forks, loops as a marked block (the body once, "for each …"), callbacks that run later
(`.then`, `setTimeout`, `useEffect`) as a marked block ("later"), `Promise.all([a(), b()])` as siblings marked "together".
Source order is execution order for straight-line code and for arguments before their call; where it is not (callbacks,
concurrency) the block says so rather than pretending.

**What stays:** the existing tree ("what it sets in motion", rows = distance) remains as the other reading, one toggle
away — it is the right picture for a screen, where handlers fire on events and have no order. **Default:** in order when
the anchor's root is a function / method (a handler, an endpoint, any symbol); the tree when the anchor is a screen.
Both read the same URL (`&view=order` / `&view=tree`), the same panel, the same double-click and `Start here →`.

---

## 2. Why the current picture cannot say it

`buildSteps` is breadth-first from the anchor's root: a node is a *step* when it is a screen, a handler, a bridge, an
event, a store action or an effect; everything else folds into the link's `via`. Rows are distance from the anchor.
Since 2026-08-29 a row is ordered by the position of the hop that first reached each step, with a hop written inside
another call's arguments before that call (`WireStep.order`, `hopCompare` in `steps.ts`) — that is how `jwt.sign` sits
left of `200`. The link carries the whole guard chain as one `when` string and the enclosing call as `within`.

So the walk already knows, per step, **where** it is reached (line, column, span) and **under what** (the guard chain).
What it throws away is the *structure* between siblings: which guards are the same `if`, which arm is the `else` of
which, what ends an arm. The tree cannot draw `authUser → 200 under jwt.sign` because that would be a lie (a `jwt.sign →
200` edge); the rail can, because a rail is not a graph of causes but the order of statements.

---

## 3. Facts to build on (verified 2026-08-29; re-verify, these files move)

| Need | Where it is today | Notes |
|---|---|---|
| The steps, links, sites, `via`, `when`, `trigger`, `status`, `order`, `within` | `src/ui-server/api/steps.ts` `buildSteps` → `WireStepsPayload` (mirrored in `ui/src/lib/wire.ts`) | one box per (function, category), per status for replies; boundaries `cut: 'screen'`; `through=1` |
| Per-site position + span + enclosing call | `graph/branch-guards.ts` `callSitesForFile` → `CallSiteText { callee, args, argList, span, within, status }` | `span` = the call's start/end; `within` = the call whose arguments contain it (stops at a function / block) |
| Per-site guard chain, structured | `guardsForFile` → `BranchGuard[]` (`text`, `negated`, `form`, `line`), joined by `guardLabel` into the `when` string | **the plan needs the array, not the string** — `SiteReader.when` returns the string; add `guards(caller, site): BranchGuard[]` beside it (`api/when.ts`) |
| The rules that produce guards, per language | `RULES_BY_LANGUAGE` / `interface Rules` in `branch-guards.ts`: `boundaries`, `inlineFunctions`, `bindingParents`, `blocks`, `enclosing`, `earlyExits` | JS/TS, Swift, Python, Java, Kotlin, C#, Go, C; an early `return` / `throw` / `raise` before a site is already a negated guard in that site's chain (`earlyExits`) |
| What fires a site (later-running callbacks) | `triggersForFile` → `SiteTrigger { kind: 'prop' \| 'option' \| 'callback', name, of }`; `LATER_CALLEES` | `kind: 'callback'` of `then` / `setTimeout` / `useEffect` / `addListener` = runs later |
| The hop that first reached a step | `HopSite` in `steps.ts` (`file`, `line`, `column`, `end`, `within`), carried on `Fold.first`, sorted by `hopCompare` / `hopInside` | this is the position the rail places a step at |
| Words for conditions | `ui/src/lib/conditions.ts`: `clauses`, `splitTop`, `conditionTokens`, `whenTokens`, `commonTokens`, `scenarios` | WHEN / AND / OR / NOT as words; scenario rows per site |
| Box words and looks | `ui/src/lib/steps-model.ts` (`kindWord`, `stepLabel`, `stepSub`, `triggerWords`), `ui/src/components/steps/StepNode.svelte` | reuse the box verbatim; only the arrangement is new |
| The view, URL, panel | `ui/src/views/StepsView.svelte` (`rewrite`, `navigate`, the panel with `Start here →`, the summary's `through` checkbox), `ui/src/lib/navigation.ts` `stepsHref` / `StepsHrefOptions`, `ui/src/lib/router.svelte.ts`, `App.svelte` | add `view` to the options and the route |
| Tests to copy the shape of | `__tests__/ui-steps-api-servers.test.ts` (four frameworks in one fixture), `ui-steps-cross-tier.test.ts`, `nextjs.test.ts`, `ui-steps-model.test.ts` (pure model), `ui-conditions.test.ts` | |
| Headless pictures | the auto-memory note: `shoot.mjs` (Playwright over `codegraph ui --no-open`, one shot per hash URL; **never `npm run build` while a `codegraph ui` runs**); `scripts/try-repo.sh <preset>` to clone + index + open | proshop, express-realworld, nest-boilerplate, next-saas-starter, fastapi-template are the presets |

The walk's caps and budgets (`MAX_CALL_SITES`, `MAX_WHEN_SITES`, fold depth, fan-out, steps per picture) apply unchanged;
the rail draws the same steps the tree does, so it costs one more structured read per site, nothing more.

---

## 4. Design

### 4.1 The program: a block tree derived from the walk

Add to the payload (same request, `view=order` asks for it; the tree's `steps` / `links` stay so the panel works):

```ts
/** The anchor's body as the code reads: items in order, forks where it forks. */
interface WireProgram { root: WireBlock; truncated: number }
type WireBlock = WireItem[];
type WireItem =
  | { kind: 'step'; step: string /* WireStep.id */; link: string /* WireStepLink.id */; site: WireStepSite; via: WireNodeRef[]; within?: string }
  | { kind: 'fork'; on: string /* the condition as written */; form: 'if' | 'switch' | 'ternary' | 'try' | 'exit' | 'guard'; arms: WireArm[] }
  | { kind: 'loop'; on: string /* `item of items` */; body: WireBlock }
  | { kind: 'later'; by: string /* `then` / `useEffect` */; body: WireBlock }
  | { kind: 'together'; body: WireBlock }            // Promise.all / Promise.allSettled arguments
  | { kind: 'inline'; via: WireNodeRef; when: string; body: WireBlock }   // a folded helper, drawn where it is called
  | { kind: 'cut'; why: WireStep['cut'] };           // a cap or a boundary, where the walk stopped
interface WireArm { when: string /* this arm's own clause: `…` or `NOT …`, or `case 'x'` */; ends: 'reply' | 'return' | 'throw' | null; body: WireBlock }
```

**How it is built (server, `src/ui-server/api/program.ts`, called from `buildSteps` when asked):**

1. **Collect the sites per function.** For the anchor's root and every function the walk folded into (the `via` chain
   members) or entered (a step with a root), take every hop and effect site the walk made *from that function*: the
   step it reached (or the helper it folded into), the site's position (`span.start`, column-exact), and its structured
   guard chain (`guards(caller, site)` — the new `SiteReader` method — outermost first). One structure per function,
   keyed by the function's node id; the walk already visits each function once, so record while walking rather than
   re-walking.
2. **Order** each function's sites by `hopCompare` (source position; a site inside another site's arguments first).
3. **Fold the guard chains into forks.** Walk the ordered sites keeping a stack of open forks. For a site with guard
   chain `g1…gn`: the longest prefix shared with the open stack stays open; deeper open forks close; each remaining
   guard opens a fork (for an `if` — `form: 'if'`, `on: g.text`) with the arm this site is in (`when: g.negated ? NOT g.text
   : g.text`). A later site whose chain has the *same* guard (same `line`, same `text`) with the opposite `negated`
   joins the **same fork as its other arm** — that is how `else` and the `||`-arm are found without a CFG; a `switch`
   guard (`form: 'switch'`) opens one arm per `case` text. A negated guard that `earlyExits` produced (a `return` / `throw`
   before the site) is a fork whose *other* arm is the exit: `arms: [{ when: g.text, ends: 'return' | 'throw', body: [] },
   { when: NOT g.text, body: […] }]` — draw the exit as a terminal, not a box.
4. **End an arm.** An arm whose last item is a reply step (`effect.category === 'response'`) or whose guard came from a
   `throw` / `return` ends (`ends`); the rail does not rejoin below it.
5. **Inline the folds.** A hop that folded into a helper becomes `{ kind: 'inline', via: helper, body: program(helper) }` at
   the hop's position, recursively, to the walk's fold depth; the helper's own guards are relative to its body (the
   fold's outer `whens` are already on the position in the caller). A step reached through a helper appears **only** in
   the inline block (never also at the top level).
6. **Later and together.** A site whose trigger is `kind: 'callback'` of a `LATER_CALLEES` callee, or that sits inside an
   inline function (the `Rules.inlineFunctions` climb) passed to `.then` / `setTimeout` / `useEffect`, goes under a
   `later` item at the position of the registering call; sites inside `Promise.all([...])` arguments go under `together`.
   Loops: a site inside a `for` / `while` / `forEach` body goes under `loop` (the guard reader knows the loop node types
   per language — `Rules.blocks` includes loop bodies; add the loop header text as `on`).
7. **Boundaries and cuts** are `step` items (a screen / endpoint step, `cut: 'screen'`) — the rail shows them where the
   call is; `through` enters them by appending their program as an `inline` block, as the tree enters them today.

This is a derivation from data the walk has; the only new reading is the structured guard array. **No CFG, no
extractor, no kernel work.** It is honest by construction: a fork exists only where a guard was read; a site with an
unreadable chain (a language without rules, a drifted file) sits in sequence with no fork, which is the same silence
the tree shows today.

### 4.2 The view

`ui/src/views/StepsView.svelte` gains the mode; the rail is a new component `ui/src/components/steps/StepsRail.svelte`
(or `SequenceView`) rendered instead of the Svelte Flow canvas when `view === 'order'`. No layout engine: the rail is
flex / grid — a column of boxes; a fork is a row of arm columns under a condition pill, each arm a column; a rejoin is a
hairline back to the rail; an arm that `ends` stops at its terminal (the reply box, or a small `return` / `throw` mark
in `--ink-3`). `loop`, `later`, `together`, `inline` are bracketed blocks with a left rule and a one-word label in
`--ink-3` (`for each item`, `later · then`, `together`, `via generateToken`). Boxes are `StepNode`'s markup and styles
verbatim (kind classes, accent rule for bridge / event, dashed effect, `⇢` / `⇠`), sized to content — reuse the
component with a `rail` prop or extract its inner markup; the click / double-click contract is identical (select →
panel; double-click → `Start here`). Keep the **pill** words: the fork's condition in the conditions vocabulary
(`conditionTokens`), `WHEN` / `WHEN NOT` on the arms, ≤ 36 chars with `…` and the full text on hover, as §3.12 pills.

Words (`kindWord` stays): the toggle reads **"Read as: in order · what it sets in motion"**; the legend for the rail:
"Boxes read top to bottom in the code's order; a fork is an `if`, `switch`, `try` or an early exit, its arms side by
side; an arm that replies, returns or throws ends there; `via x` is a helper drawn where it is called; `later` runs
after the handler returns." Sentence case, no tracking (spec §2).

The panel is unchanged — the same `WireStep` / `WireStepLink` shapes, `Start here →`, `Open as a flow →`, the scenario
rows. The summary keeps `depth`, `through`, the counts; `Continue through` enters boundaries in the rail too.

### 4.3 URL and defaults

`StepsHrefOptions.view?: 'order' | 'tree'`; the router parses `view`; `rewrite()` carries it; the default when absent:
`order` for a function / method / endpoint anchor, `tree` for a screen anchor (the anchor's root kind decides, server
side, in the payload as `defaultView` so the viewer never guesses). The Screens tab's double-click and the chooser open
the default.

---

## 5. Work plan, in order

**P0 — structured guards on the reader.** `api/when.ts` `SiteReader.guards(caller, site): Promise<BranchGuard[]>` (the
array `guardsForFile` already computes; `when` keeps returning the joined string). Test: `branch-guards.test.ts` already
covers the chains; add one assertion on the array for an `if` / `else` pair sharing `line` and `text` with `negated`
flipped, and for an early `return`.

**P1 — record per-function sites during the walk.** In `buildSteps`, alongside `link()`, push `{ fn, stepId, linkId,
hop: HopSite, guards: BranchGuard[], trigger }` into a per-function list (`programs: Map<fnId, SiteRecord[]>`), for hops
out of every fold node (steps *and* folds — a fold into a helper is a record in the caller and the helper's own
records are the helper's). Cost: one `guards` read per hop, within `MAX_WHEN_SITES`.

**P2 — the block builder.** `src/ui-server/api/program.ts`: `buildProgram(records, roots) → WireProgram`, pure over the
records (no graph access), unit-tested on hand-made records: straight line; `if` / `else`; early return; nested ifs;
`switch`; `try` / `catch`; a helper inlined; a site inside arguments; `later`; `together`; a loop; a cap. Then wire it
into the payload behind `view=order`.

**P3 — the rail.** `StepsRail.svelte`, the toggle, `view` in the URL, the legend and summary words, the default per
anchor kind. Snapshot-free tests: the pure layout of arms is trivial, so test the *model* (`ui/src/lib/program-model.ts`:
the block → rows/columns with the pills' words) in `__tests__/ui-program-model.test.ts`, and drive one real picture with
the harness (P5).

**P4 — languages beyond JS.** Nothing to add for guards (P5 of the previous plan built them for Python, Java, Kotlin,
C#, Go, C); check `later` / `loop` / `together` node types per language in `Rules` and add the loop-header text. Test:
extend `ui-steps-api-servers.test.ts` with an `in order` assertion per framework (FastAPI's `raise HTTPException` is an
early exit; Spring's `if (…) return ResponseEntity.badRequest()` too).

**P5 — validation pictures.** With the harness: proshop `POST /api/users/login` (the §1 reading), `POST
/api/products/:id/reviews` (three outcomes: `!product` → 404 early exit, `alreadyReviewed` → 400, else create + 201),
express-realworld `POST /api/users/login`, nest-boilerplate `POST /api/v1/auth/email/login` (guards, DI, thrown
exceptions), next-saas-starter `signIn` (a server action: validation → lookup → `redirect`), fastapi-template `POST
/login/access-token`. Read each against the source; a fork that is not in the code, or an order that is not the code's,
is a bug, not a style choice. Re-shoot the mobile app (`/capture/review`) to confirm the tree mode is untouched.

**P6 — docs.** Spec §3.13 gains "3.13.1 In order" with the §1 rendering and the rules of §4.1; `CHANGELOG.md`
`[Unreleased]` gets one user-facing bullet ("The Steps tab reads a handler in the code's order …"); `CLAUDE.md`'s
`src/ui-server/` note names `api/program.ts`; the previous plan's status header points here.

*Done when:* proshop's login reads as §1 in the browser, the reviews endpoint shows its three arms with the 404 as an
early exit, and the tree mode is byte-for-byte the picture it is today.

---

## 6. Gotchas, known from building the tree

- **Source order is execution order only for straight-line code.** Arguments before their call (the nesting rule,
  already in `hopCompare`); `await` does not reorder; a callback registered now runs later (`later`); `Promise.all` is
  concurrent (`together`). Do not draw an order the code does not fix — say `later` / `together` instead.
- **A nested `const handleX = async () => …` is not a node** (only `function` declarations and `useCallback`-bound
  arrows are); its body's sites attribute to the enclosing component, and the guard climb treats the inline arrow as
  transparent. The rail inherits that: such a handler's sites appear in the component's program. The fix is an
  extractor rule with the Rust kernel twin — out of scope here; note it where it shows.
- **The reply box is per (function, status)** since `ca9a7fd`; a status set by the statement before the reply
  (`res.status(401); throw …`) is that reply's (`statusSetBefore`), and a bare `res.json` is a 200
  (`implicitResponseStatus`). In the rail the 401 arm reads `401 · res.status(401)` then `throw new Error(…)` as its
  terminal — the throw is the arm's `ends`, read from the early-exit guard on the *next* site, or from the site's own
  statement's successor; either way it is a mark, not a step.
- **Site keys.** A site is `(line, column)`; synthesized edges carry the call's column (the tier synthesizer sets it);
  an edge with no column lands on the first non-blank column of the row, which for `const x = await fetch(…)` is
  `const` — `callAt` climbs to the first call from there. Pass the callee name (`want`) when you know it.
- **Budgets.** `MAX_WHEN_SITES` / `MAX_CALL_SITES` bound the tree reads per request; the rail adds one `guards` read per
  hop — the same sites the `when` read already parsed, so it is cheap, but count it. A drifted file yields no guards
  (`hasDriftedOnDisk`): the rail then shows sequence without forks, and should say "conditions not read: the file
  changed since the index".
- **Two passes per fold** (spec §3.13): a node that is a step is never also folded through its `contains` edge; the
  program's records must come from the same pass that made the link, or a step appears twice.
- **The index keeps only the last segment of a deep member call**; every call text in the rail must come from
  `callSitesForFile` (as the tree's do), never from the edge's `refName`.
- **Never `npm run build` while a `codegraph ui` server is running** (it loads modules lazily and hangs); the harness in
  the memory note kills its server group on exit for that reason.

---

## 7. Open questions for the maintainer

1. **Default reading per anchor** — the plan says *in order* for functions / endpoints, *tree* for screens. Or *in
   order* everywhere, with a screen's program being its render body plus each handler's program under `later ·
   onPress`?
2. **How far to inline.** A helper drawn in place at every call is faithful but wide; the tree's fold depth (8) may be
   too deep for a rail. Proposal: inline to depth 3, then a `cut` item with `Start here →`.
3. **Loops.** Body once with `for each …`, or unrolled never. Proposal: once, marked.
4. **Should the rail replace the pills' "→ …x" placement rule?** The rail's forks carry the condition once, on the
   fork; the arm's `WHEN` / `WHEN NOT` is the pill. The scenario rows in the panel stay as they are.

---

## 8. What the validation pictures found (2026-08-29, P5)

Read against the source, endpoint by endpoint. Every reading below is the one the rail draws today.

| Repo | Anchor | Reads as | Verdict |
|---|---|---|---|
| `bradtraversy/proshop_mern` | `POST /api/users/login` | `User.findOne` · fork on the password check · [`via generateToken` → `jwt.sign`, then `200`] \| [`401`], both arms answering | §1 exactly |
| " | `POST /api/products/:id/reviews` | `Product.findById` · fork on `product` · [fork on `alreadyReviewed` → `400` \| `201`] \| [`404`] | three outcomes, right |
| `gothinkster/node-express-realworld-example-app` | `POST /users/login` | `via login` → two `422` guards, `prisma.user.findUnique`, `if user` → `bcrypt.compare` → `if match` → `via generateToken`, then `403`; then the handler's own `200` | right, after the span fix |
| `brocoders/nestjs-boilerplate` | `POST /auth/email/login` | `via validateLogin` → `findByEmail`, `!user` → `422`, two throwing guards, `bcrypt.compare`, then `sessionRepository.create` and `via getTokensData` → **`together Promise.all`** of two `jwtService.signAsync` | right, after dropping the `update` name-match |
| `leerob/next-saas-starter` | `signIn` (server action) | drizzle `select`, `length === 0` → return, `!isPasswordValid` → return, **`together Promise.all`** of `setSession` (→ `signToken` → `SignJWT`) and `logActivity` (→ `db.insert`), then `redirectTo === 'checkout'` → the whole checkout session \| `/dashboard` | right, after the lending fix |
| `fastapi/full-stack-fastapi-template` | `POST /login/access-token` | `via authenticate` → `session.exec`, `not db_user` → return, `not verified` → return, `updated_password_hash` → `session.add`/`commit`/`refresh`; then `not user` → `400`, `elif not user.is_active` → `400`; then `via create_access_token` → `jwt.encode` | right, after the `elif` fix |
| `amniservices-mobile-app` | `/capture/review` | unchanged: 87 steps, 160 links, the tree, `defaultView: 'tree'` | the regression check |

Each of those was read first as the rejected rail and then as the canvas graph; the readings are the same, the picture
is not. What the canvas gives that the rail could not: proshop's login fits the sketch the maintainer drew
(`User.findOne` → the fork → `jwt.sign` → `200` | `401`), and nest-boilerplate's login reads down the page —
`findByEmail` → `WHEN NOT user → 422` | `WHEN user AND user.provider === …` → `bcrypt.compare` → `WHEN
isValidPassword` → `sessionRepository.create` → `together · Promise.all` → `jwtService.signAsync`.

**Three defects the pictures caught, all in the walk and both readings** — a hop's span taken from a call that was not
the one asked for (an inline Express handler's edges carry the route's line, so the registration's span swallowed the
body); a name-match the call as written disproves (`crypto.createHash('sha256').update(…)` followed into the caller's
own `AuthService.update`); and a value lent nothing because one plain `references` edge counted as a body of its own
(`const signIn = validatedAction(schema, async (data) => { … })` drew one call out of nine). Plus an `elif` whose body
raises being read as ending the arm it is written in.

**Left open, deliberately:**
- **A mongoose document's `product.save()` is not in the effects table** (`api/effects.ts`), so proshop's review
  endpoint draws its `201` but not the write before it. A JS rule for `<lowercase receiver>.save` would catch it and
  would also catch `canvas.save()` / `ctx.save()` / `sharp(...).toFile`-adjacent idioms in any web app — a call for
  the maintainer, not a silent widening.
- **A nested `const handleX = async () => …` is still not a node** (the plan's §6): its sites belong to the enclosing
  component. Fixing it is an extractor change with a Rust kernel twin.
- The **`via` name of an inlined helper is its bare name** (`via create`), which is ambiguous when two classes have a
  `create`. The panel disambiguates; the rail could say the class.
