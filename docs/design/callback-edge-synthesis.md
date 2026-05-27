# Design + status: general callback / observer edge synthesis

**Status:** Phases 1–3 implemented & validated as a **prototype, uncommitted on `main`**
(as of 2026-05-22). This doc is the handoff for continuing the work.
**Motivation:** close the dynamic-dispatch hole that static extraction leaves for
observer / event-emitter / signal patterns, where a *dispatcher* invokes callbacks
registered elsewhere through a shared store — so flows like "how does an update
reach the screen" actually exist in the graph.

---

## TL;DR for a new session

We synthesize `dispatcher → callback` edges that static parsing misses. It works:

- **Field observer** (excalidraw `Scene.onUpdate`/`triggerUpdate`): synthesizes
  `triggerUpdate → triggerRender`. `trace(mutateElement, triggerRender)` now = 3 hops.
- **EventEmitter** (express `on('mount', …)`/`emit('mount')`): synthesizes `use → onmount`.
- Precision is high: excalidraw got **1** synthesized edge out of 27k (the correct one);
  node count moved +3 after Phase 3 (no explosion).

**Files touched (all uncommitted on `main`):**
- `src/resolution/callback-synthesizer.ts` — the whole-graph synthesis pass (Phase 1 + 2).
- `src/resolution/index.ts` — calls `synthesizeCallbackEdges()` at the end of
  `resolveAndPersistBatched()` (after base edges are persisted) + the import.
- `src/extraction/tree-sitter.ts` — `visitFunctionBody` now extracts **named** nested
  functions (Phase 3), so inline named handlers become linkable nodes.

**How to reproduce / test:**
```bash
npm run build
rm -rf /tmp/codegraph-corpus/excalidraw/.codegraph
( cd /tmp/codegraph-corpus/excalidraw && codegraph init -i )
# synthesized edges (provenance='heuristic', metadata.synthesizedBy in {callback,event-emitter}):
sqlite3 /tmp/codegraph-corpus/excalidraw/.codegraph/codegraph.db \
  "select s.name||' → '||t.name||'  '||coalesce(e.metadata,'') from edges e \
   join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic';"
# end-to-end trace (uses the dev probes):
node scripts/agent-eval/probe-trace.mjs /tmp/codegraph-corpus/excalidraw triggerUpdate triggerRender
```
Probe scripts (dev-only, in `scripts/agent-eval/`): `probe-node.mjs` (symbol + trail),
`probe-trace.mjs` (call path), `probe-context.mjs`, `probe-explore.mjs`. EventEmitter
fixture lives at `/tmp/cb-fixture/bus.js` (ephemeral — recreate or move into `__tests__/`).

---

## The hole

```ts
class Scene {
  private callbacks = new Set<Callback>();
  onUpdate(cb: Callback) { this.callbacks.add(cb); }          // REGISTRAR
  triggerUpdate() { for (const cb of this.callbacks) cb(); }  // DISPATCHER
}
this.scene.onUpdate(this.triggerRender);                      // REGISTRATION SITE
```

The runtime edge `triggerUpdate → triggerRender` does not exist statically:
`triggerUpdate`'s only literal call is `cb()` (anonymous). Measured: `triggerUpdate`'s
only callee was `randomInteger`; `trace(triggerUpdate, triggerRender)` returned no path.

## Why it's a whole-graph pass, not a `FrameworkResolver.resolve()`

`resolve(ref)` answers "what does this **named** ref point to," one ref at a time. The
callback edge has **no ref to resolve** (`cb()` is anonymous) and needs **cross-file,
multi-site correlation** (registrar, registration, dispatcher). So it's a whole-graph
pass after base resolution, language-level (any OO observer), living in
`src/resolution/callback-synthesizer.ts` — **not** under `frameworks/`.

> Sibling mechanism for the *other* dynamic-dispatch class — **named** attribute/
> descriptor dispatch (e.g. django `self._iterable_class(...)`) — is the
> `claimsReference` hook (`resolution/types.ts` + `resolution/index.ts` pre-filter)
> + a `FrameworkResolver.resolve()` (django ORM resolver in `frameworks/python.ts`).
> That one *does* fit `resolve()` because the ref is named. Both are part of the same
> coverage effort; see the "Related work" section.

---

## As-built algorithm (and where it diverged from the original design)

### Field-observer channels (`fieldChannelEdges`, Phase 1)
1. **Candidates** by method/function **name** — registrar `^(on[A-Z]\w*|subscribe|
   addListener|addEventListener|register|watch|listen|addCallback)$`; dispatcher
   contains `(emit|trigger|notify|dispatch|fire|publish|flush)`.
2. **Confirm by body** (read via `ctx.readFile` + slice node lines): registrar has
   `this.<F>.add|push|set(`; dispatcher has `for (… of [Array.from(]this.<F>)` + a call,
   or `this.<F>.forEach(`.
3. **Pairing — DIVERGENCE:** the design said pair by *class*; the build pairs by
   **same file + same field `F`** (file as a class proxy — getting the containing class
   reliably was harder). Works for the common 1-class-per-file case; revisit for
   multi-class files.
4. **Registrations:** `queries.getIncomingEdges(registrar.id, ['calls'])` → for each,
   read the caller's source at the edge line and **regex-recover the arg**
   (`<registrarName>\s*\(\s*(?:this\.)?(\w+)`). DIVERGENCE: design preferred tree-sitter
   re-parse; build uses regex (named refs only — arrows/inline args are missed here).
5. **Synthesize** `dispatcher → fn` (`getNodesByName(arg)` → method|function). Capped at
   `MAX_CALLBACKS_PER_CHANNEL = 40`.

### EventEmitter channels (`eventEmitterEdges`, Phase 2)
- **File-oriented scan** (`ctx.getAllFiles()` + `readFile`, substring pre-filter on
  `.emit(`/`.on(`/etc). `ON_RE` = `\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*
  (?:function\s+(\w+)|(?:this\.)?(\w+))`; `EMIT_RE` = `\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]`.
- Dispatcher = **enclosing function** of the `emit('e')` call (`enclosingFn` finds the
  tightest function/method/component node containing the line). Handler = `getNodesByName`
  of the on-handler name.
- Correlate by **event-name literal**; synthesize dispatcher → handler.
- **Precision — DIVERGENCE:** design proposed receiver-type matching; build uses an
  **event fan-out cap** (`EVENT_FANOUT_CAP = 6`) — skip events with >6 handlers or
  dispatchers (generic names like `error`/`change` would over-link without type info).

### Provenance — DIVERGENCE
`Edge.provenance` is a fixed enum (`'tree-sitter'|'scip'|'heuristic'`), so synthesized
edges use **`provenance: 'heuristic'`** + `metadata: { synthesizedBy: 'callback'|
'event-emitter', via/event/field }`. The design's `'callback-synthesis'` provenance and
high/medium/low **confidence tiers were NOT implemented** — the fan-out cap +
registrar-name uniqueness + named-only handlers are the precision guards instead.

### Phase 3 — inline callback extraction (`tree-sitter.ts`)
The real blocker for EventEmitter on real repos: inline handlers
(`on('mount', function onmount(){})`) weren't **nodes**, so nothing could link to them.
Root cause: `visitFunctionBody` walked *through* nested functions without extracting them.
Fix: in `visitForCallsAndStructure`, when a body node is a `functionType` and
`extractName` returns a real name, call `extractFunction` (which extracts it and walks
its own body) and return. **Named only** — anonymous arrows fall through to the existing
recursion (so their inner calls stay attributed to the enclosing fn). This bounded it:
excalidraw +3 nodes, no explosion, no regression.

---

## Validation results (actual)

| Repo | Result |
|---|---|
| excalidraw | 1 synthesized edge `triggerUpdate → triggerRender` (of 27,214); `trace(mutateElement, triggerRender)` = 3 hops; nodes 9,286 → 9,289 |
| express | after Phase 3: `use → onmount` `{event-emitter, event:"mount"}` (`onmount` now extracted at `application.js:109`) |
| `/tmp/cb-fixture/bus.js` | `tick → handleRefresh`, `persist → handleSave` (named-method EventEmitter handlers) |
| excalidraw / express | no Phase-1 regression; node counts stable |

---

## Remaining work (prioritized for the next session)

1. **Anonymous-arrow handlers** — `on('e', () => foo())` still produce no edge (no node,
   intentionally not extracted in Phase 3). The fix is **synthesizer link-through-body**:
   parse the arrow's body and link `dispatcher → (calls inside the arrow)`. Highest
   remaining recall win; handles the most common modern callback shape.
2. **Wire into `resolveAndPersist`** (incremental sync) — synthesis currently runs only
   in `resolveAndPersistBatched` (full index). Incremental re-index won't refresh
   synthesized edges.
3. **Receiver-type matching** for EventEmitter precision (replace/augment the fan-out
   cap) — use `type_of` edges so `x.emit('change')` only links to `y.on('change', fn)`
   when `x`,`y` are the same type. Lets the fan-out cap relax.
4. **Tree-sitter arg recovery** (replace the regex in field-channel Stage 4) — robust for
   arrows, multi-arg, line-wrapped calls.
5. **Single-callback fields** (`this.onChange = cb; … this.onChange()`) — scalar-store
   variant of the field observer; not built.
6. **Broad precision/recall audit** — run across the full corpus; tally synthesized edges
   per repo, spot-check, confirm no explosion on EventEmitter-heavy repos.
7. **Tests + CHANGELOG** — the fixture is a ready vitest case for the synthesizer; add
   extractor tests for Phase 3 (named-nested-fn extraction; confirm other languages
   unaffected — the change is in the shared walker), resolver tests for the django side.

## Edge cases / model
- **Over-approximation across instances** is accepted (reachability, not instance
  precision). `unregister`/`off` ignored.
- Synthesized edges are **additive** — never replace static edges; tooling can filter on
  `provenance='heuristic'` + `metadata.synthesizedBy`.

## Related work (same coverage effort)
This is one half of closing dynamic-dispatch coverage. The other artifacts on `main`:
- **Named attribute/descriptor resolver**: `claimsReference` (`resolution/types.ts`,
  pre-filter in `resolution/index.ts`) + django ORM resolver (`frameworks/python.ts`,
  `_iterable_class` → `ModelIterable.__iter__`).
- **Retrieval/UX changes** (separate from coverage): `explore` whole-small-file + glue
  fixes, `node`-with-trail, `codegraph_trace`, `context` call-paths — all in
  `src/mcp/tools.ts` / `src/context/index.ts`.
- **Full investigation context + findings:** auto-memory
  `project_codegraph_read_displacement` (why coverage — not prompting/hooks/new-tools —
  is the lever for getting agents to use codegraph over Read).
