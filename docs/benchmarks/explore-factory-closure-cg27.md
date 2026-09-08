# Deterministic measurement — the factory-closure envelope (task CG-27)

**Date:** 2026-08-06 · **Baseline:** `feature/CG-24` @ `dc4fd75` ·
**Harness:** `scripts/agent-eval/probe-factory-closure.mjs` against a hermetic fixture
(`__tests__/fixtures/factory-closure-ts/`, copied to a temp dir and indexed per run, so two runs
on one build give identical numbers). No agent A/B: the claim under test is which SYMBOLS get
selected inside one file, and the agent runs are far too noisy to see that.

**Verdict: the premise does not survive measurement. CG-27 is closed as obsolete, CG-30 credited.**
The literal change the issue proposes is a large REGRESSION, and a more careful mechanism reaching
the same intent is noise (69 vs 68 inner definitions delivered across nine query shapes).

---

## The claim

`ENVELOPE_KINDS` in `src/mcp/tools.ts` drops a node covering >50% of its file from the cluster
ranges, so the granular symbols inside form their own clusters instead of merging into one blob.
It lists container kinds — `class`, `struct`, `interface`, `enum`, … — and **not `function` or
`method`**. A factory closure (`createFoo()` returning an object of closures) therefore survives
as a file-spanning range. That shape is common, not a one-repo quirk: Svelte 5 `.svelte.ts` rune
stores, React custom-hook modules, IIFE/module-pattern JS, and Zustand's
`create((set, get) => ({ … }))`.

CG-30 already bounds the BYTES such a member may spend, so what remained was a ranking claim:
a file-spanning range merges every inner symbol into one cluster, so selection cannot rank and
pick the relevant closures independently. The issue required that claim be measured before any fix.

## The fixture

`__tests__/fixtures/factory-closure-ts/` — a dashboard app with three stores written as factory
closures, two stateless services and a UI consumer competing for one envelope.

| file | lines | shape |
|---|---|---|
| `src/stores/dashboard-store.ts` | 385 | `createDashboardStore` spans 15–376 (**94%**), 11 closures inside; a tail type alias + helper at file scope |
| `src/stores/alerts-store.ts` | 141 | `createAlertsStore` spans 19–138 (**85%**), 9 closures inside |
| `src/stores/session-store.ts` | 148 | a factory and NOTHING else at file scope — no companion type, no tail helper |
| `src/services/metric-service.ts`, `src/services/filter-parser.ts` | 105, 62 | ordinary top-level functions — the control |

Both factory files are past `WHOLE_FILE_MAX_LINES` where it matters, so they render through the
cluster path and the envelope actually bites.

## Result 1 — the envelope is almost never selected in the first place

`shrinkCluster` orders a cluster's members by **(importance desc, size ASC)** and refuses any
member that overruns the cap once something is kept. A file-spanning member is therefore only ever
selected when it is the FIRST candidate — which requires it to be the *sole* member of the top
importance tier. In eight of the nine query shapes measured, some smaller member shared that tier
(a one-line type alias, a tail helper, another closure), so the factory sorted last and was never
kept. The envelope was inert.

## Result 2 — the proposed change is a large regression

Making the >50% drop kind-independent, measured on the primary query
(*"how does the dashboard store refresh its metrics and apply a filter"*):

| | baseline | drop the range |
|---|---|---|
| `dashboard-store.ts` (rank #1) delivered | 7,539 chars | **397** |
| inner closure definitions delivered | 7 of 11 | **0 of 11** |
| its own reservation left unspent | 0 | ~5,200 of 5,601 |

The mechanism, from the cluster dump: dropping the range **splits** the file into two clusters —
`378-384` (a one-line type alias plus a four-line helper, score 15, span 7) and `4-362` (every
closure, score 116, span 359). Cluster ranking breaks the `maxImportance` tie on **density**, so
the trivial cluster wins, is taken first, and is the only one that may be shrunk. The
answer-bearing cluster then does not fit the remainder and is **dropped whole** — later clusters
are never shrunk, by design.

The enclosing range is what was holding the file together as one cluster, inside which
`shrinkCluster` was already doing exactly the per-symbol ranking the issue asked for.

## Result 3 — the careful version of the same intent is noise

Deferring the envelope MEMBER inside `shrinkCluster` (leaving clustering granularity untouched, so
Result 2's split never happens) reaches the issue's intent by a better mechanism. Nine query
shapes, same fixture, same indexes — inner closure definitions delivered:

| query | target | baseline | deferred |
|---|---|---|---|
| how does the dashboard store refresh its metrics and apply a filter | dashboard | 7/11 | **8/11** |
| createDashboardStore | dashboard | 8/11 | 8/11 |
| how is the dashboard store created and wired up | dashboard | **9/11** | 8/11 |
| createDashboardStore exportCsv summarize | dashboard | 9/11 | 9/11 |
| where is the dashboard store constructed | dashboard | 7/11 | 7/11 |
| how are widgets loaded and the layout reconciled | dashboard | 4/11 | 4/11 |
| createSessionStore (adverse: the factory IS the sole top-tier member) | alerts | 6/9 | **7/9** |
| how are alerts refreshed and acknowledged | alerts | 9/9 | 9/9 |
| createAlertsStore | alerts | 9/9 | 9/9 |
| **total** | | **68** | **69** |

One better, one worse, seven unchanged — on a fixture built specifically to make this pattern
maximally visible. That is not a measurable selection improvement, so nothing shipped.

## Where the envelope DOES get selected, and why CG-30 already covers it

The adverse row above is the one configuration the ordering cannot neutralise: `createAlertsStore`
was the sole importance-10 member, so it was kept first at 3,939 chars against a 2,468 cap and
every closure was skipped. CG-30 then **windowed it on whole lines** rather than emitting it whole
or dropping the file — the response carried lines 16–108, a contiguous, readable head of the
factory carrying 6 of its 9 closure definitions. Bounded, sufficient, never empty. That is the
symptom this issue was filed against, already absorbed.

---

## Byproduct — a real defect this measurement exposed (filed separately)

Result 2's mechanism is not confined to the hypothetical change. Instrumenting the **epic tip**
across the deterministic 6-repo suite for files that drop a cluster while leaving most of their
reservation unspent:

| file | budget | spent | unspent | kept cluster | dropped cluster |
|---|---|---|---|---|---|
| `django/db/models/sql/query.py` | 10,135 | 1,923 | **8,212 (81%)** | 1379–1400, score 14 | 306–929, **score 290** |
| `okhttp .../RealInterceptorChain.kt` | 6,058 | 1,474 | **4,584 (76%)** | 16–44, score 44 | 113–373, score 171 |
| `okhttp .../Interceptor.kt` | 4,697 | 2,027 | 2,670 (57%) | 85–138, score 21 | 154–257, score 10 |
| `gin/routergroup.go` | 5,782 | 3,273 | 2,509 (43%) | 33–91, score 116 | 103–188, score 128 |

A file whose top cluster by density is trivial keeps that one, drops the cluster carrying 20x the
score, and leaves most of its own reservation unspent — because only the first-chosen cluster may
be shrunk. `query.py` is the file CLAUDE.md already names as the `_fetch_all` case.

## Reproducing

```bash
npm run build
node scripts/agent-eval/probe-factory-closure.mjs                      # primary query
node scripts/agent-eval/probe-factory-closure.mjs \
  --target src/stores/alerts-store.ts --factory createAlertsStore \
  --query "createSessionStore"                                          # the adverse configuration
npx vitest run __tests__/explore-factory-closure.test.ts                # the standing gate
```
