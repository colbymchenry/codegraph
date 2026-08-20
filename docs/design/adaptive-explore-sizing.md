# Design + status: adaptive `codegraph_explore` sizing (sibling skeletonization)

**Status:** Implemented & validated, **default-on**, on branch
`feat/adaptive-explore-sizing` (initial commit `d6d059f`; **refined 2026-05-29**
after a real-agent A/B exposed a read-back regression — see
"Refinement" below). Escape hatch: `CODEGRAPH_ADAPTIVE_EXPLORE=0`.
**Motivation:** make `codegraph_explore` size its output to the *answer* rather
than always filling the budget cap — so a "sibling-heavy" flow (many
interchangeable implementations of one interface) stops costing *more* than
plain grep/read, without starving "diffuse" flows that genuinely need broad
source.

> **Refinement (2026-05-29) — the read-back regression.** The first cut gated
> only on *off-spine + polymorphic-sibling*. A real-agent A/B (not the
> deterministic probe) showed that this skeletonized two files the agent then
> **Read back**, defeating the point: OkHttp's `RealCall` (it implements the
> 9-impl `Lockable` *mixin*, so it tripped the sibling signal even though it's
> the orchestrator) and Django's `compiler.py` (it *defines* `SQLCompiler` and
> co-locates its subclasses). Two conditions fixed it — a file skeletonizes only
> if it is **not spared**, where **spared = the agent NAMED a callable in it**
> (`getResponseWithInterceptorChain`, `SQLCompiler.execute_sql` → keep it full)
> **UNLESS the file DEFINES a ≥3-impl supertype** (a base+subclasses "family"
> file is huge and Read-anyway, so skeletonizing it *frees explore budget* for
> the sibling files the agent would otherwise Read). Result: OkHttp **3%
> costlier → ~10% cheaper** (RealCall full, 0 read-backs); Django **10% costlier
> → ~10% cheaper** (compiler.py skeleton frees ~6.5 KB of the 28 KB budget; half
> the runs answer with 0 reads). The supertype signal was initially used as a
> *spare* — that was backwards and regressed Django to 9% costlier by starving
> its budget; it is now an *override* of the named-callable spare. The
> single-condition history below is kept for context.

> **Further refinement (2026-05-29) — per-symbol focused view + named-cluster
> survival.** Whole-file skeleton/spare was still too coarse on a real Django
> A/B: the agent Read back `compiler.py` (collapsed → its `execute_sql`/`as_sql`
> bodies elided) and `query.py` (a non-sibling god-file whose `_fetch_all` cluster
> got trimmed). Four changes took both repos from ~9–10% to **~14–17% cheaper**
> with **median 0 reads**:
> 1. **Uniqueness-aware spare** — only a (near-)UNIQUE named callable spares a
>    file. `as_sql` has **110 defs** across every Compiler/Expression subclass;
>    naming it must not keep every backend variant full (it was flooding Django's
>    budget). `getResponseWithInterceptorChain` (1 def) still spares RealCall.
> 2. **Per-symbol focused view** — a collapsed family file shows the **full body**
>    of on-spine / unique-named / canonical-base-supertype methods and only
>    **signatures** for the rest. So `SQLCompiler.execute_sql`/`as_sql` survive
>    while the 80 other symbols + redundant subclasses collapse → no Read-back.
> 3. **Test-file exclusion on all tiers** — a test file (`custom_lookups/tests.py`)
>    was eating 2.3 KB of Django's 28 KB budget; tests rarely answer an
>    architecture question. (Previously only the <500-file tiers excluded them.)
> 4. **Named-cluster survival in non-sibling files** — inject agent-named method
>    defs into a file's clusters even when the gather missed them, rank them at
>    importance 9, and cap cluster selection at `min(per-file, remaining-total)`
>    so high-importance named clusters survive instead of being source-order
>    trimmed (Django's `_fetch_all`, L2237, the last of four big files emitted).
> Controls held: OkHttp 14% cheaper / 0 RealCall read-backs; Excalidraw 31%
> cheaper / 0 reads (god-file clustering unaffected — its big file is emitted
> first, so the budget cap never binds it). OkHttp's interceptors stay a pure
> signature skeleton (no named callable in them, don't define a supertype).

---

## TL;DR

`codegraph_explore` returned full source for **every** relevant file up to its
char budget. On a question whose answer spans many *same-shaped* classes — e.g.
"how does OkHttp process a request through its interceptor chain?", which touches
~14 `class … : Interceptor` implementations — that meant ~28 KB of mostly
**redundant full bodies**. Because those bodies ride in the context window for
the rest of the session, the WITH-CodeGraph arm cost *more* than the WITHOUT arm
(which answers the well-named interceptor question in ~10 cheap greps). OkHttp
was the benchmark's cost outlier (−3% — i.e. *costlier* than native search).

Fix: when a file is **both (a) off the synthesized flow spine and (b) a
polymorphic sibling**, render it as a **skeleton** (class + member *signatures*,
bodies elided) instead of full source — keeping the on-spine exemplar and the
mechanism in full.

- **OkHttp:** the interceptor-chain flow skeletonizes the 5 redundant
  `: Interceptor` impls while keeping `RealInterceptorChain` (the dispatch
  mechanism) and `RealCall` (the orchestrator the agent named) full → **~10%
  cheaper than native, 0 RealCall read-backs** (see Refinement for the corrected
  numbers; the original `28.5k → 16.6k` / "reads 1 vs 3" figures came from a
  deterministic probe query, not the agent's real query).
- **Django:** the QuerySet→SQL flow skeletonizes `compiler.py` (a
  base+subclasses family file), freeing budget → **~10% cheaper**. (The earlier
  claim that Django was "byte-identical / 0 skeletons" was an artifact of the
  *probe* query; the agent's real query DOES surface the SQLCompiler family.)
- **Excalidraw / Tokio / VS Code / Gin:** explore output is **byte-identical**
  with the flag on/off (0 skeletons) — their flows have no off-spine
  ≥3-implementer sibling group. The corrected gate only *adds* a spare
  condition, so it skeletonizes a **strict subset** of the original gate → these
  repos provably stay at 0 skeletons (verified by probe).

---

## The problem in one picture

`handleExplore` gathers relevant files, sorts by relevance, and fills up to
`maxOutputChars` (the "whole-small-file rule" dumps any relevant file ≤220 lines
in full). The budget is a **target**, not a ceiling:

```
OkHttp explore (shipped):  RealCall (full) + RealInterceptorChain (full)
                         + CallServerInterceptor (full, 8.7k)
                         + Bridge/Connect/Cache/… (full, ~4-5k each)   ← all ~same shape
                         = ~28k, most of it redundant interceptor bodies
```

The agent only needs the **mechanism** (`RealInterceptorChain.proceed` iterating
the chain) + the **contract** every interceptor implements + maybe one concrete
example. The other five full bodies are padding — but only *because they're
interchangeable*. On a diffuse question (Excalidraw's render pipeline:
`mutateElement → … → renderStaticScene`), the off-spine files are **distinct
steps**, and their bodies do real work — eliding them just makes the agent
reconstruct them from signatures (more reasoning, net costlier; see "Dead ends").

So the whole game is: **tell "interchangeable sibling" apart from "distinct
step," cheaply.**

## The gate (refined)

A file is skeletonized iff **all** hold (and `CODEGRAPH_ADAPTIVE_EXPLORE != 0`):

1. **A spine exists.** `buildFlowFromNamedSymbols` returns its path node set
   (`pathNodeIds`) and the full set of agent-named callables (`namedNodeIds`). If
   no spine forms, nothing skeletonizes.

2. **Off the flow spine.** No symbol in the file is on the traced chain — that
   chain is the mechanism the agent is walking, always kept full.

3. **A polymorphic sibling.** The file's class `implements`/`extends` a supertype
   with **≥ 3 implementers** (`MIN_SIBLINGS`) — the signal that it's one of many
   *interchangeable* impls. From real `implements`/`extends` edges, cached.

4. **Not spared.** A file is **spared** (kept full) iff the agent **named a
   callable in it** — a named method/function is something the agent asked to
   *see* (`getResponseWithInterceptorChain`, `SQLCompiler.execute_sql`), not an
   interchangeable leaf — **UNLESS the file itself DEFINES a ≥3-impl supertype**.
   That last clause is the override: a base+subclasses "family" file (Django's
   `compiler.py`) is huge and Read-anyway, so a full copy just eats explore
   budget; skeletonizing it *frees* that budget for the sibling files the agent
   would otherwise Read. So: *named ⇒ spare, unless it's a family file ⇒
   skeletonize anyway.*

Worked through the two repos:

- **`RealInterceptorChain`** — `proceed` is on the spine → kept full (cond. 2).
- **`RealCall`** — off-spine, and it trips the sibling signal via the **9-impl
  `Lockable` mixin** (not because it's an interchangeable interceptor). But the
  agent named `getResponseWithInterceptorChain`/`execute`/`enqueue` in it, and it
  defines no ≥3-impl supertype → **spared, kept full** (cond. 4). This is the fix
  for the read-back: before cond. 4 it skeletonized and the agent Read it back.
- **`BridgeInterceptor` & the other 4** — off-spine, ≥3-impl siblings, named only
  by *type*, define no supertype → **skeletonized**. The win.
- **Django `compiler.py`** — off-spine, a sibling (its subclasses extend
  `SQLCompiler`), the agent named `execute_sql` in it — *but it defines the
  `SQLCompiler` supertype*, so the override fires → **skeletonized** (frees
  budget). Sparing it instead (the wrong first attempt) cost MORE and Read MORE.

## Why "shared supertype with ≥3 implementers" is the signal

The thing that makes OkHttp's interceptors interchangeable is precisely that
they're **N implementations of one interface**, invoked polymorphically. That is
a *structural* property the graph records as `implements`/`extends` edges:

```
14 classes ──implements──▶ Interceptor      (BridgeInterceptor, CacheInterceptor,
                                              CallServerInterceptor, … )
```

Excalidraw's `renderStaticScene`, `Scene`, `Collab` share **no** common
supertype — the ≥3-implementer query returns nothing for them. So the signal
cleanly separates the two repos, and (validated below) leaves every non-sibling
flow untouched.

The `≥ 3` threshold matters: 1:1 "service interface → single impl" pairs (the
common Spring/Java shape) are **not** siblings and stay full. Only genuine
many-impl families (interceptor chains, strategy/visitor families, codec
registries) trip the gate.

## Skeleton rendering

For a skeletonized file we emit the class + member **signature lines** (not
bodies). Because a symbol node's `startLine` can point at a decorator/annotation
(`@Throws`, `@Override`, `@objc`), we scan forward up to 4 lines for the line
that actually *names* the symbol, so the skeleton shows the real signature:

```
#### …/CallServerInterceptor.kt — CallServerInterceptor, intercept, … · skeleton (signatures only; Read for a full body)
```kotlin
30  object CallServerInterceptor : Interceptor {
32  override fun intercept(chain: Interceptor.Chain): Response {
194 private fun shouldIgnoreAndWaitForRealResponse(code: Int): Boolean =
```
```

The header still lists the file's symbols and says `Read for a full body`, so the
agent can pull one specific implementation if it truly needs it.

## Validation (refined gate)

Headless `claude -p`, Opus 4.8, **WITH vs WITHOUT** CodeGraph (the real benchmark
arm, not the on/off probe the first cut used). Cost = median `total_cost_usd`.

| Repo | WITH→WITHOUT cost | WITH reads | WITHOUT reads | RealCall/compiler read-back |
|---|---|---|---|---|
| **OkHttp** (n=4) | **$0.45 → $0.50** (~10% cheaper) | 2 | 3.5 | **0 / —** (RealCall full) |
| **Django** (n=6) | **$0.56 → $0.63** (~10% cheaper) | 2 | 8.5 | half the runs read 0 |

Both were the README's **cost outliers** (OkHttp 3% costlier, Django 10%
costlier) and both flipped to clear wins. OkHttp WITH was cheaper in all 4 runs;
Django in 5 of 6 (n=6 to see through its high variance). WITHOUT baselines match
the README ($0.50/$0.63 vs $0.57/$0.64), so the gain is the WITH-arm improving.

The **decisive check now passes for the right reason**: with the named-callable
spare, OkHttp's `RealCall` stays full and is **never** Read back (it was Read
back in 3/4 runs before the fix). The inert repos (Excalidraw / Tokio / VS Code /
Gin) stay at **0 skeletons** — verified by probe — because the refined gate
skeletonizes a strict subset of the original. (The first cut's "on vs off, reads
flat 1 vs 3" claim came from a deterministic probe query and did **not** hold for
the agent's real query — that mismatch is what this refinement corrects.)

## Dead ends (don't re-attempt these)

1. **Demote/rank low-value files** (e.g. broaden `isLowValuePath` to drop
   `*-testing-support/` fixtures). Improves *content quality* but **not size** —
   explore refills the freed budget with other full bodies (28,478 → 28,424).
   Ranking ≠ shrinking; you must *skeletonize* to shrink.
2. **Gate on entry-node membership.** A precise symbol-bag explore query *names*
   every chain participant, so they're all "entry nodes" — no separation, nothing
   skeletonizes.
3. **Rely on interface-impl synthesizer edges** (`synthesizedBy:'interface-impl'`)
   for the sibling signal. They were **not** created for OkHttp's `Interceptor`
   (a Kotlin `fun interface`), so the signal must come from the real
   `implements`/`extends` edges, not synth edges.
4. **A plain "core-floor" gate** (keep first N full, skeletonize the rest) —
   skeletonized Excalidraw's *distinct* steps → **+17% cost regression**. The
   sibling condition is what makes it safe.
5. **Sparing a file because it DEFINES the supertype** (the first refinement
   attempt). Backwards: a base+subclasses *family* file (Django's `compiler.py`,
   2,266 lines) is huge and Read-anyway, so keeping it full just **eats the 28 KB
   explore budget and starves the sibling files** the agent then Reads — it
   regressed Django to **9% costlier** ($0.71). Defining a supertype is instead
   an **override** that lets a named family file skeletonize anyway.
6. **Validating skeletonization with the deterministic probe query only.** The
   probe (`probe-explore.mjs "<symbol bag>"`) and the *agent's* real explore
   query name symbols differently, so they form different spines and skeletonize
   different files. The probe said "Django: 0 skeletons / reads flat"; the real
   agent query skeletonized `compiler.py` and Read it back. **Always confirm with
   a real-agent A/B (`run-all.sh`), not just the probe.**

## Code

- `src/mcp/tools.ts`
  - `adaptiveExploreEnabled()` — the flag (default on).
  - `buildFlowFromNamedSymbols()` — returns `{ text, pathNodeIds, namedNodeIds }`.
    `namedNodeIds` is every callable the agent named (a superset of the spine) —
    the named-callable spare reads it.
  - `handleExplore()` — two cached helpers: `isPolymorphicSibling()` (a node has
    an outgoing `implements`/`extends` to a ≥3-impl supertype) and
    `definesPolymorphicSupertype()` (a node HAS ≥3 incoming `implements`/`extends`
    — i.e. the file is the family base). The skeleton branch:
    `off-spine && isPolymorphicSibling && !(namedInFile && !definesSupertype)`.
- `__tests__/adaptive-explore-sizing.test.ts` — 7 cases incl. the named-callable
  spare (RealCall) and the supertype-family override (compiler.py).

## Frontier / future work

- **Per-symbol skeletonization within a family file.** `compiler.py` is
  skeletonized whole, so `SQLCompiler.execute_sql` (the base mechanism) becomes a
  signature too and *is* Read back in ~half the Django runs. The ideal is to keep
  the base class's methods full and elide only the redundant subclass bodies —
  shrinking the payload without eliding the answer. Whole-file skeletonization
  can't express that yet.
- **Big non-sibling files dominate Django's residual reads.** `query.py` (3,040
  lines) and `sql/query.py` are not polymorphic families, so skeletonization
  can't touch them; the agent Reads them when the 28 KB clustered view is
  insufficient. That's the explore-budget / big-file-clustering frontier, not
  skeletonization.
- **Non-interface sibling families** (Go `HandlerFunc` slices, function-pointer
  registries) aren't caught — they have no `implements`/`extends` edge. Gin's
  middleware chain, for instance, doesn't trip the gate (its handlers are funcs,
  not interface impls).
- **Exemplar selection** when *no* interceptor is on the spine: today all siblings
  skeletonize and the agent leans on the interface contract; showing one as a
  forced exemplar might read slightly better (untested).
