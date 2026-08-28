# Explore budget allocation — the instrument and the baseline

`codegraph_explore` has a fixed byte envelope (`getExploreOutputBudget().maxOutputChars`,
hard-capped at 25K so the host never externalizes the result). **How that envelope gets
divided among files** is decided by a long chain of gates, tiers and caps spread across
`handleExplore` — and until CG-4 that chain was unobservable. You could read an explore
response and guess; you could not say "this file took 16% and that one took 20%."

This document covers the diagnostic that makes it measurable, and the baseline it recorded.

## The diagnostic

Set `CODEGRAPH_EXPLORE_DEBUG` and every `codegraph_explore` call (MCP tool or
`codegraph explore` CLI) emits one report:

| value | sink |
|---|---|
| `1` / `true` / `on` / `yes` / `stderr` | human-readable table on stderr |
| `json` | one pretty-printed JSON report on stderr |
| anything else | treated as a path — one JSON report per line, appended (JSONL) |
| unset / `0` / `false` / `off` / `no` / empty | **off** |

Per file it reports: relevance score, graph (RWR) mass, distinct query-term hits, ranking
flags (named / entry / central / spine / low-value / generated), render mode, bytes of
source allocated, bytes actually delivered, both shares, and whether it was clipped. For
files that never rendered it reports why (`max-files`, `budget-90pct`, `budget-whole-file`,
`budget-clusters`, `unreadable`, `no-ranges`). Totals cover the envelope (delivered vs
allocated vs `maxOutputChars` vs hard ceiling), the source/meta split, the file-selection
funnel at each stage, and the thresholds applied (score floor, graph-relevance gate).

**It is off by default and produces byte-identical output when off** — it ships in the
product binary, and a diagnostic that perturbs the response by one byte would invalidate
every A/B measurement taken with it on. `ExploreDiagnostics.start()` returns `null` unless
the env var is set, so every call site is a `diag?.` no-op. Pinned by
`__tests__/explore-diagnostics.test.ts`.

Two envelope numbers, deliberately kept separate:

- **allocated** — what the render loop chose to emit, before the final hard-ceiling cut.
  This is the allocator's own decision, and the number budget work is about.
- **delivered** — what the agent actually received.

They diverge exactly when the ceiling truncates. Conflating them is how a dropped trailing
file goes unnoticed.

## Baseline (2026-08-03, this repo at `main`)

```
codegraph explore "how does explore allocate its output budget across files" --path .
```

469 files indexed → small tier (`maxOutputChars` 18,000, `maxCharsPerFile` 3,800,
`defaultMaxFiles` 5). Envelope: **23,196 delivered / 23,193 allocated against an 18,000
budget — 29% over**, absorbed only because the 25K hard ceiling sits above it.

| # | share | bytes | score | graph | hits | flags | render | file |
|---|---|---|---|---|---|---|---|---|
| 4 | 21.2% | 4,928 | 10 | 0.125 | 1 | entry | whole | `scripts/agent-eval/offload-eval-hook.mjs` |
| 5 | 20.1% | 4,665 | 10 | 0.125 | 1 | entry | whole | `scripts/agent-eval/offload-eval-metrics.mjs` |
| 3 | 19.8% | 4,585 | 22 | 0.125 | 1 | entry central | whole | `scripts/agent-eval/parse-session.mjs` |
| 1 | **15.8%** | 3,659 | **54** | **0.322** | **4** | entry central | clusters* | `src/mcp/tools.ts` |
| 2 | 15.0% | 3,479 | 34 | 0.082 | 2 | entry | clusters* | `src/index.ts` |

\* clipped. Ranked but never rendered: `scripts/agent-eval/offload-eval-cost.mjs` (#6) and
`src/resolution/lru-cache.ts` (#7), both cut by `maxFiles`.

Files: 17 grouped → 10 past the score floor (≥3) → 10 past the low-value filter → 7 past
the relevance gate (graph ≥ 0.0193, 6% of max 0.3215) → 5 in the output.

### What the baseline shows

**Score does not drive allocation.** `src/mcp/tools.ts` — the file that actually answers
the query — carries 5.4× the relevance score, 2.6× the graph mass and 4× the term hits of
any `.mjs` script, and gets a *smaller* share than each of them. The three agent-eval
scripts take **61%** of the envelope between them; the answer file takes 16%.

The mechanism is that the two allocation paths are decided by **file size, not relevance**:
a small file clears `WHOLE_FILE_MAX_LINES`/`WHOLE_FILE_MAX_CHARS` and ships entirely, while
a large file falls through to cluster selection and is clipped at `maxCharsPerFile`. So a
weakly-relevant 130-line script gets 100% of itself; the strongly-relevant 5,000-line file
gets 3,800 chars. Rank ordering is correct (tools.ts sorts #1) and buys nothing, because
rank has no effect on how many bytes a file receives.

**The envelope is over-subscribed.** 23,193 allocated against an 18,000 budget means the
per-file caps do not compose into the total cap; the total is enforced only by the 25K
ceiling silently dropping whole trailing sections. Under a slightly different index state
(one more candidate file) the same query allocated 27,518 chars and the ceiling dropped a
7,678-char section — the single largest allocation in the response — with the only trace
being the truncation notice at the end.

This is the gap the rest of the epic closes: relevance-proportional allocation with a
relative cliff (CG-12), on top of scoring that stops rewarding incidental name collisions
(CG-10 — landed; see below).

## CG-10 — relevance scoring

CG-10 changes **what gets into the response**, ahead of how bytes are split among what's
in. Four levers, all multiplicative so they compose without ordering surprises.

### 1. Kind weighting

The tier a symbol reached us by (named seed `+50`, query match `+10`, adjacent to one `+3`,
peripheral `+1`) says *how it got here*; `RELEVANCE_KIND_WEIGHT` says *whether the match is
evidence*. Callables and types weigh 1.0, members ~0.5, and `constant`/`variable`/
`parameter` 0.15–0.35 — a local named `explore` is a name collision until something
corroborates it.

**Isolation.** For a weak-kind symbol in the top two tiers, "is anything using it?" is the
corroboration: no usage edge anywhere in the graph (`contains` excluded — lexical nesting
is not usage) drops it to 0.08. Cost is bounded — only weak kinds in the tiers whose weight
can carry a file pay for the probe, and the subgraph's own edges answer most cases for
free. Measured: no latency change (210 vs 211 ms/call, n=12 interleaved).

**Peripheral cap.** Nodes ≥2 hops from any match now accumulate into a separate bucket
capped at 5. Uncapped, every such node added a flat `+1`, so a file grew more relevant by
being bigger — `parse-session.mjs` reached score 22 off one incidental constant plus twelve
unrelated symbols. Size is not evidence.

### 2. Relative score floor

`score >= 3` admits noise on any repo where the top file scores 50+. The floor is now
`clamp(topScore × 0.2, 1, 10)`:

- **relative** — on a diffuse question no file dominates, every candidate sits near the top,
  and the whole spread survives; on a precise one it cuts the tail.
- **capped at 10** — one direct query match on a callable. A single full-strength match is
  never incidental, so no amount of concentration elsewhere may exclude it. Without this
  cap, one named-seed-heavy file pushed the floor to 21 and dropped a file the agent had
  named by *class* name (classes enter at `+10`, not `+50` — named seeds are callables).
- **backfill** — if fewer than 3 files survive, the best of what the floor cut comes back,
  but only from files with real evidence (≥ the absolute floor). If *nothing* survives, the
  backfill drops that requirement: returning "no relevant code found" when the gather did
  find candidates sends the agent straight back to grep.

### 3. Generated status in the score, not the tiebreak

`rankPenalty(file)` multiplies both the relevance score and the graph mass by 0.3 for
generated files (0.5 for low-value ones). Applying it to the score alone would not have
fixed #1500: the generated CRUD carries **more** graph mass than the hand-written use-case,
and graph mass outranks score in the comparator. The penalty is self-normalizing — in an
all-generated repo everything scales together and relative ranking is untouched — and it
never hard-excludes: ask about the generated API by name and the named-seed tier still puts
it first.

### 4. `excludeLowValueFiles` — the finding

The per-tier flag the task asked to reconsider was **dead config**: declared on
`ExploreOutputBudget` and set per tier, but read nowhere. A later change had already made
the test/spec/icon/i18n exclusion unconditional at all tiers. The flag is removed.

The substantive gap was in the *detector*, not the gating: `isLowValue` matched
`/\/(tests?|__tests?__|spec)\//`, anchored on a leading slash, so a **repo-root** `test/`
directory — express, cobra, and most of npm and Go — never matched. Express's "how does
express route a request to a handler?" spent 59% of its envelope on three test files while
`lib/application.js` was clipped. Anchored at `^` as well, that query now returns
`lib/application.js` + `lib/response.js` and no tests.

Two related changes: the filter now runs **before** the score floor and judges "are there
other candidates?" on the whole gather rather than the post-floor set (judging it after was
how the floor's keep-minimum pulled test files back in as the "spread"); and low-value
files that survive the filter's `≥2 non-test candidates` escape hatch are down-weighted via
`rankPenalty` rather than left at full strength.

### Measured effect

Before/after on the same indexes, deterministic (`CODEGRAPH_EXPLORE_DEBUG` diagnostic, both
arms same build system, baseline = `bd86ad2`):

| repo · query | before | after |
|---|---|---|
| this repo · self-query fixture | 72% to eval scripts, `tools.ts` 18.5% | scripts **0%**, `tools.ts` #1 |
| this repo · `handleExplore buildFlowFromNamedSymbols …` | 82% to eval scripts | `tools.ts` 48% + `index.ts` 32% |
| this repo · "how is error handling done" | 58% to eval scripts, `tools.ts` delivered 0 | transport/tools/cobol/api |
| this repo · "what languages does codegraph support" | 63% to `scripts/add-lang/*` | grammars/index/cli |
| this repo · "main components of the indexing pipeline" | — | **byte-identical** |
| payroll-go fixture | generated 57.4%, answer 25.6% | answer **61.5%**, generated **23.5%** |
| express · route a request | 59% to `test/*` | `application.js` + `response.js` |
| cobra · 3 queries | — | **byte-identical** |

The two byte-identical rows are the control: where the answer was already concentrated, the
new floor prunes the same tail earlier and cheaper and arrives at the same response.

**Known thin case.** Express's "how does the app object get created and what does it
expose" drops from 4 files (top one an `examples/` file at 38%) to `lib/express.js` alone,
2.6 KB against a 13 KB budget. `lib/application.js` matched on nothing but an unused
file-scope `var app` — indistinguishable, at the symbol level, from the eval scripts' unused
`const explore`; express models its API surface as properties assigned to that object,
which the graph has no edges for. That is extraction coverage, not ranking. Backfilling it
was tried and rejected: node-count ties handed the slot to `examples/route-middleware`
instead, at 48% of the envelope. Thin-and-precise beats padded-with-noise — a wrong file
does not save the agent the follow-up call it would pad against.

## CG-12 — score-proportional allocation

CG-10 fixed *what* gets into the response. This fixes *how the bytes are split among what
got in* — which, until now, was not really decided at all. Every admitted file was capped at
the same flat `maxCharsPerFile`, and the whole-file rule handed anything under
`maxCharsPerFile × 3` its entire contents. So the envelope followed **file size**:

- self-query: `memory-budget.ts` (score 18) shipped whole at 5,672 and took **51.2%**;
  `tools.ts` (score 41, 4× the graph mass, 3× the term hits — it literally holds the
  allocator) was clipped at 3,800 and got **32.9%**.
- payroll-go: two generated CRUD files shipped whole at ~4.5 KB each *and* consumed two of
  the tier's four file slots, so `BuildPayslip` — the hand-written "calculate" half of the
  question — ranked #6 and never rendered at all.

### The model

`allocateExploreBudget` (`src/mcp/tools.ts`) runs once, after ranking, before anything
renders. It reserves each file a share of the envelope; the render loop then spends a
reservation instead of racing for whatever the files above it left.

1. **Weight** = `score × worth × (spine ? 2 : 1)`. `worth` is `rankPenalty` applied a
   *second* time: ranking answers "is this file about the query", allocation answers "will
   these bytes teach the agent anything". Generated CRUD can legitimately rank — it
   name-collides on every domain word, and it is big and densely self-referential, so it
   scores on the structural keys the comparator leads with — while its bytes stay mechanical
   boilerplate. That second penalty is what finally sinks it.
2. **Relative cliff** at 15% of the top weight, itself capped at `SCORE_FLOOR_MAX`. A file
   under it gets **zero source** — path, symbols and line numbers only. It costs ~100 chars
   instead of ~4,500, and it does **not consume a `maxFiles` slot**, so the slot passes to a
   file that earns its bytes. That slot hand-off is what got `BuildPayslip` into the
   response. The cap matters as much as the fraction: one 500-scoring god-file would
   otherwise put the cliff at 75 and silence every peer the score floor had just admitted.
3. **Floor then split.** Every admitted file gets `MIN_CHARS` (700 — enough for one complete
   method); the remainder splits by weight. The floor is what keeps a diffuse survey
   question returning a spread; the remainder is what concentrates a precise one.
4. **Safety valve**, not a per-file cap: no file exceeds 70% of the envelope. The flat
   per-file cap is retired as the primary guard — the proportional split already bounds a
   file by its weight share.

The reservation then governs **every** render path — whole-file, clusters, focused/skeleton
— where before the whole-file branch was 3× more generous than the cluster branch, which is
the 3× swing that decided the split by file size.

Two supporting changes were needed to make the reservation actually bite:

- **Oversize clusters shrink by member.** A cluster is a merge of whole symbol ranges, and
  on a densely-packed file every symbol merges into one blob spanning the file (cycle.go's
  209-line `Service`). The old rule took the top-ranked cluster whole however big it was, so
  a single-cluster file simply ignored its budget — it took ~40% more than allotted and the
  file below it was then dropped for lack of room. Shrinking drops whole **members** by
  importance, so a body is still never cut.
- **The arrival-order stops are gone.** `budget-90pct` and the `!fileNecessary && totalChars
  > maxOutputChars` checks dropped files by the order they were reached: whichever files
  ranked first spent the envelope, and everything after them was cut on a cap it had no say
  in. Only an absolute hard-ceiling stop remains.

### Measured effect (CG-12)

| repo · query | before (post-CG-10) | after |
|---|---|---|
| this repo · self-query fixture | `tools.ts` 32.9%, `memory-budget.ts` 51.2% | **`tools.ts` 60.6%**, memory-budget 17.2% |
| payroll-go fixture | answer 61.5%, generated 23.5%, `BuildPayslip` absent | answer **78.7%**, generated **0%**, `BuildPayslip` **delivered** |
| express · route a request | 2 files, top 43.1% | 1 file, top **82.3%** (`response.js` cliffed — 0 term hits) |
| express · app registers middleware | 1 file, 71.6% | **byte-identical** |
| cobra · parse flags and execute | 2 files, `command.go` 40.1% | 2 files, `command.go` **77.2%** |
| cobra · DIFFUSE "main components" | 3 files, top 48.1% | 3 files, top 50.0% — spread preserved |
| gin · request reaches a handler | 3 files, top `ginS/gins.go` 48.8% | 3 files, top **`routergroup.go`** 53.8% |
| gin · DIFFUSE "what it provides" | 3 files, top `recovery.go` 43.0% | **4 files**, top `context.go` 33.3% |

The two diffuse rows are the over-correction control: file counts hold (3→3, 3→4), so a
survey question still gets a spread. The two gin rows also moved the top file to a more apt
one — `routergroup.go` over the thin `ginS` singleton wrapper, `context.go` over
`recovery.go` — because concentration is decided by weight rather than by which file
happened to be small.

**Exception to "no previously-unclipped file becomes clipped".** `memory-budget.ts` was
unclipped-whole at 5,672 and now clusters within its 3.1 KB reservation. That is the epic's
own diagnosis of the bug rather than a regression: it scored 18 against `tools.ts`'s 58 and
was taking the larger slice purely for being small enough to ship whole. The guarantee holds
where it was meant to — no file loses bytes to a *tighter cap*; the only files that lose are
ones the proportional split says were over-served.

## The regression fixtures (CG-6)

Two fixtures pin the failure mode so it can never silently return. They were written to
**fail** — that is what they were for. CG-10 closed the ranking half of both and CG-12 the
byte-split half; **both now pass** and are live regressions. The numbers quoted below are
the **pre-CG-10 baseline**; see the two "Measured effect" tables above for where they stand.

They are declared in `scripts/agent-eval/allocation-fixtures.json` and run by
`scripts/agent-eval/probe-allocation.mjs`, which drives the CG-4 diagnostic through a JSONL
sidecar (so it measures the shipping allocator, not a re-derivation), groups the rendered
files into `answer` vs `incidental`, and checks declared share thresholds. Needs a current
`npm run build`; exits 1 while any assertion fails.

```bash
node scripts/agent-eval/probe-allocation.mjs                # both
node scripts/agent-eval/probe-allocation.mjs payroll-go     # one
node scripts/agent-eval/probe-allocation.mjs --json         # machine-readable
```

### 1. `payroll-go` — the reporter's shape

`__tests__/fixtures/payroll-go/` is a synthetic Go service: generated FKIT CRUD beside a
hand-written payroll use-case, entered from an HTTP route. Full description in that
directory's README. The essentials:

- Generated files with **ordinary names** carrying `// Code generated ... DO NOT EDIT.` —
  invisible to path-only detection, which is what makes this a #1500 fixture rather than a
  `.pb.go` one — beside `payrollpb/*.pb.go` covering the path-detectable channel.
- Deliberate collisions: `BuildPayslip`, `Upsert` and `Store` each exist twice, generated
  and hand-written, and the generated layer name-collides on every query term.
- `cycle.go` (227 lines) sits above the whole-file window so it clips; the generated files
  sit below it so they ship whole.

Query — an architecture question naming none of the answering symbols: *"how does payroll
cycle create and calculate payslips?"*

| | allocated | delivered |
|---|---|---|
| hand-written | 48.4% | **25.6%** (all of it domain types) |
| generated CRUD | 39.9% | **57.4%** |

`cycle.go` is allocated the single largest slice (7,052 chars, 30.6%) and delivers **zero**
— the 19,500 hard ceiling drops its whole section. `payslip_builder.go` (rank #8) never
renders. So `runPayrollCycleAll`, the hand-written `BuildPayslip` and the real `Upsert`
never reach the agent, and every byte that did arrive describes either CRUD or types.

This fixture is hermetic: the probe copies the tree to a temp dir and re-indexes per run,
so two runs on one build are byte-identical (verified). `__tests__/explore-allocation-1500.test.ts`
runs the same assertions in vitest.

**After CG-10** the generated files rank #3/#4 instead of #1/#2, `cycle.go` delivers 38.9%
(it delivered nothing), and `runPayrollCycleAll` + the real `s.store.Upsert(ctx, slip)`
reach the agent. Those assertions are now live regressions. What remains `it.fails` is
`payslip_builder.go`: it ranks #6, the tier's `maxFiles` is 4, and the render loop still
spends by file size — CG-12's job.

**Finding, deliberately left unfixed:** `runPayrollCycleAll` calls `s.store.Upsert` on a
`*payslipstore.Store`, but the graph resolves that edge to the **generated**
`internal/gen/fkit/payroll/store.go` `Store.Upsert`. Same-name method resolution across two
packages that both define `Store.Upsert` picks the wrong receiver. It is upstream of
allocation — a wrong edge pulls the generated store into the subgraph. CG-10 mitigates the
*symptom* (the generated store is penalized on both score and graph mass, so it no longer
displaces the real one) without fixing the resolution bug itself, which belongs with the
same-name method resolution work (see `samename-method-resolution-1079`).

### 2. `self-query` — the same bug with no generated code in sight

The baseline above, promoted to a fixture: this repo, *"how does explore allocate its output
budget across files"*. `scripts/agent-eval/*.mjs` mention `explore` and `BUDGET`
incidentally — they are eval harnesses, not the allocator — and they are small enough to
ship whole, while `src/mcp/tools.ts` is large enough to be clipped.

At 493 indexed files (small tier): the script corpus takes **71.8%** of the delivered
envelope (79.4% allocated) against `tools.ts`'s **18.5%**, despite `tools.ts` scoring 46 vs
10, carrying 2.3× the graph mass and 3× the distinct term hits.

This fixture reads the **live** index of this repo, so unlike `payroll-go` its exact numbers
move as the repo changes. Its assertions are relative for that reason (answer group vs
incidental group, largest delivered file), never fixed percentages. Two things to know:

- The `<500`-file tier boundary is close. This repo indexes 493 files including the new
  fixture; crossing 500 flips `maxOutputChars` 18,000 → 24,000, `maxFiles` 5 → 8 and
  `maxCharsPerFile` 3,800 → 6,500, which moves every number in the table above. Re-baseline
  after the crossing rather than treating the drift as a regression.
- Adding the `payroll-go` fixture itself moved the count 472 → 493. Its Go files match none
  of this query's terms, so they change the tier arithmetic and nothing else.

### Reproducing

The query explores this repo, so **uncommitted edits to `src/mcp/tools.ts` change the
result** — the index picks them up and scores shift (the same query on the CG-4 working
tree reported tools.ts at 13–19% depending on the sync state). Measure against a clean
tree: restore `src/mcp/tools.ts` from `main`, remove `src/mcp/explore-diagnostics.ts`,
`codegraph sync`, then run the built `dist/` binary (which still carries the instrument).
Restore afterwards.

---

## CG-14 — locking the allocation down

The allocation change is one function plus three render-loop bounds, and every way it can
regress is silent: nothing throws, the response just gets less useful and the agent falls
back to Read. So the coverage is built around the question "would this test go red if the
lever were removed?" rather than around line coverage.

### Where the coverage lives

| File | Owns |
|---|---|
| `__tests__/explore-proportional-allocation.test.ts` | `allocateExploreBudget` in isolation — the split, the cliff, the tier invariant, envelope safety, spine weighting, degenerate inputs |
| `__tests__/explore-allocation-e2e.test.ts` | The same behaviours through the real render loop on real indexed projects — the self-query fixture's shape, degenerate result sets, the diffuse-query control |
| `__tests__/explore-allocation-1500.test.ts` | The reporter's Go shape (CG-6 fixture 1), plus the hard-ceiling stress case |
| `scripts/agent-eval/probe-allocation.mjs` | Both CG-6 fixtures against the built `dist/`, including the **live** self-query arm that reads this repo's own index |

The split between the last two is deliberate. The self-query fixture reads a moving target
(this repo), so its exact numbers drift with the tree and it belongs out of band, where a
drift is a number to re-baseline rather than a red suite. `npm test` owns a synthetic
**mirror** of it instead: same three roles, same size asymmetry, fixed.

### The two bounds are not the same bound

Worth stating once, because a test that conflates them looks right and passes for the wrong
reason:

- **`maxOutputChars` bounds the RESERVATIONS.** `sum(allowances) <= pool <= maxOutputChars`,
  exactly, at every tier and every candidate shape.
- **`hardCeiling` — `min(maxOutputChars * 1.5, 25000)` — bounds the RESPONSE.** The render
  loop is allowed a bounded overshoot (the whole-file grace, an oversize first cluster), so
  a response legitimately exceeds the envelope. `payroll-go` does exactly that: 19.3K
  delivered against a 13,000 envelope and a 19,500 ceiling.

Only the 25K is absolute. Above it the host writes the result to a file the agent Reads
back, which is the failure the tool exists to prevent.

### Mutation-tested, not just green

Each lever was removed from `src/mcp/tools.ts` in turn and the suite re-run. Every one is
covered by at least one failing test — a lever with no red test is a lever that can be
deleted by accident:

| Mutation | Tests that go red |
|---|---|
| Render loop reverted to pre-CG-12 (`fileBudget = maxCharsPerFile`, whole-file bound `maxCharsPerFile * 3`) | 5 e2e + 2 payroll |
| Proportional split replaced with an equal one | 4 unit |
| Cliff disabled (`cliffAt = 0`) | 7 unit + 3 payroll |
| Spine boost and cliff exemption removed | 3 unit |
| `MIN_CHARS` floor removed | 2 unit |
| `MAX_SHARE` ceiling removed | 4 unit |

The first row is the one that matters most: it reproduces #1500 on the synthetic fixture
verbatim, with the half-as-relevant file taking the larger share purely on size.

| file | score | pre-CG-12 | CG-12 |
|---|---|---|---|
| `src/mcp/allocator.ts` | 77.5 | 4,843 (39.7%) | 9,335 (80.1%) |
| `src/util/budget-math.ts` | 36.0 | 6,079 (49.8%) | 1,037 (8.9%) |

### Two defects the coverage surfaced

Both were found by writing the invariant rather than by reading the code:

1. **Rounded shares could exceed the pool.** `Math.round` on each file's proportional slice
   let the reservations sum past `pool` by up to half a char per file — small, but it made
   "reservations fit the envelope" false rather than exact. Both terms now floor.
2. **A non-finite score produced a NaN allowance.** An `Infinity` weight makes every share
   `Infinity / Infinity`. Scores are finite sums in the pipeline so it was unreachable, but
   the failure mode is a NaN handed to the render loop. `weightOf` now fails safe to 0.

### Calibration vs. invariant

`EXPLORE_ALLOCATION` is exported so the tests can read it. Invariant tests (envelope safety,
tier monotonicity, the floor) reference the constants and hold at any value; one test pins
the literals, so re-tuning a constant is a visible decision that says *re-run the probe*
rather than a silent re-calibration of the fixtures.

## CG-15 — what the agent A/B found: a reservation can go unspent

The agent A/B (full record: [`../benchmarks/explore-allocation-ab-1500.md`](../benchmarks/explore-allocation-ab-1500.md))
passed on both medium repos — client-go and excalidraw at Read 0 in every run, excalidraw
**34s → 24s median with one fewer explore call**, the generated clientsets that took 10.5% of a
baseline envelope gone from every new run — and **failed on the small control**, express, in 1
run of 3: 4 Reads of `lib/utils.js` where the baseline made 1 Read of a different file.

It is not agent variance. Replaying that run's own query deterministically:

| `lib/utils.js` (5,293 B, 272 lines) | baseline | CG-12 |
|---|---|---|
| delivered | **6,380 (46.1%) whole** | **583 (7.7%) cluster stub** |
| source envelope (budget 13,000) | 13,849 | 9,241 |

The diagnostic says the allocator was right and the render loop was not:

```
allocation 12,398 reserved of 12,400 pool · nothing cliffed
 #  deliv%   bytes  reserved  score   flags                render    file
 1    5.7%     583     3,870   56.0   named entry central  clusters  lib/utils.js
```

`utils.js` is the **top-ranked** file and was **reserved 3,870 chars — of which it spent 583.**
The whole-file bound (`src/mcp/tools.ts:4008`) is
`allowance + min(GRACE_MAX, allowance * GRACE_FRACTION)` = `3,870 + 580` = 4,450, just under the
file's 5,293 bytes, so the whole-file render is declined; the fallback cluster render has three
matched symbols to work with and emits 583 chars. The remaining 3,287 chars of the reservation
are **not redistributed — they are lost**, which is why the response shrank by a third against
an unchanged budget.

This is CG-12's own acceptance criterion (*"no file that was previously unclipped becomes
clipped"*) failing. CG-14 recorded one instance as a documented exception (`memory-budget.ts`);
this is the same defect in the wild, where it costs an agent round-trip. It is **not** systemic:
on both medium repos the render loop saturates (`[over budget] [TRUNCATED]`, 23,599 of a 23,600
pool reserved) so there is nothing left to lose. It needs a file whose reservation lands below
its own size while its matched-symbol set is thin — likeliest on small repos, where per-file
reservations are smallest.

### The two candidate fixes

Widening the envelope is explicitly **not** one of them — that is the dial iter2 already proved
doesn't work, and the bytes here were reserved for this file already.

1. **Let a large-enough reservation buy the whole file.** Render whole when
   `allowance >= k * fileSize` for some `k < 1` (utils.js sits at 0.73), letting the bounded
   overshoot the hard ceiling already tolerates absorb the difference. Smaller change, matches
   the observed shape.
2. **Redistribute the shortfall.** Once the render loop knows a file's realised size, hand what
   it cannot spend to the next-ranked file. The stronger invariant — *the pool is spent* — and
   it fixes the shrinking-envelope symptom directly rather than case by case.

They compose; (1) alone would have carried this case. Whichever lands needs the express shape as
a hermetic fixture — a mid-sized top-ranked file with few matched symbols, sized just above its
reservation — because nothing in the current suite has that shape, which is how it shipped.

## CG-21 — spending the reservation

Both fixes landed, because they cover different halves of the same failure and neither is
sufficient alone. The unifying rule: **a reservation is a promise the render loop has to keep,
not a cap it may quietly under-use.**

### 1. A reservation that has already bought most of the file buys the rest

`WHOLE_FILE_BUY_FRACTION` (0.6). The pre-existing grace is calibrated as a *sliver* — it rescues
a file that essentially fits. Between "fits" and "several times its reservation" there was a
hole, and `lib/utils.js` (reserved/size = 0.73) sat squarely in it. So the test is not *does the
file fit the reservation* but *has the reservation already bought most of the file*: above 0.6
the loop pays at most two-thirds of a reservation extra rather than lose the whole thing, on a
file that already earned those bytes.

**Funding is the part that is easy to get wrong.** The merit test is a *ratio*, so wherever
several files sit near it they all qualify — and N independent overshoots inflate the response
until the render ceiling drops whatever is last. Funding each buy from the file's own
headroom was tried and measured on the payroll fixture: three files bought whole and
`payslip_builder.go` — the file that computes the payslip the question asks about — was
**dropped entirely** so three higher-ranked files could each ship their final sliver. A dropped
section is strictly worse than a clustered one.

So the buy rule is **two independent tests**, and keeping them apart is the whole design:

| | reads | answers |
|---|---|---|
| **merit** | the file's own `reserved` | did this file's relevance earn most of itself? |
| **funding** | one shared overshoot pool (`WHOLE_FILE_BUY_OVERSHOOT_FRACTION`, 15% of the envelope) | do the bytes exist, *with every reservation below it still payable*? |

Merit reads `reserved` rather than the post-carry allowance, so borrowed slack can never promote
a weak file to whole. Funding is measured against what the allocator **promised** rather than
against `renderCeiling` — the ceiling sits 50% above the envelope and says nothing about who is
owed what, so funding a buy out of it just moves the shortfall onto whichever file the loop
reaches last. The `owedBelow` term is what makes it a *displacement* guard rather than a size
cap, and it is self-limiting: each buy grows `sourceSpent`, so the pool cannot be spent twice.

### 2. What a file cannot spend goes to the file below it

Below the buy fraction the shortfall is real — the file is several times its reservation and
clustering is the right render — but the bytes still must not evaporate. The render loop carries
two running totals, everything **promised** so far and everything **emitted** so far, and their
gap is slack the next file may add to its own reservation.

Two totals rather than a `spent` variable threaded through the loop's dozen `continue`s, so no
exit path can forget to account — unreadable, drifted off disk, skipped for the ceiling, thin
matched set. It is symmetric: a buy that overshoots makes `sourceSpent` outrun `reservedSoFar`,
which suppresses slack until a later under-spend covers the debt, so the pool is conserved in
both directions and no file is ever cut *below* what it was promised. Slack flows in **rank**
order (the only file a single-pass loop can still pay), clamped by `MAX_SHARE` so an
under-spending leader cannot hand a weak tail file the whole response.

### Measured effect (CG-21)

Express, the reproducer, same index and same 13,000 budget:

| `lib/utils.js` (5,293 B, 272 lines) | baseline | CG-12 | **CG-21** |
|---|---|---|---|
| delivered | 6,380 (46.1%) whole | 583 (7.7%) stub | **6,268 (39.3%) whole** |
| source envelope | 13,849 | 9,241 | **14,505** |

And the self-query, where the epic's own acceptance criterion was outstanding:

| file | pre-CG-12 | CG-12 | **CG-21** |
|---|---|---|---|
| `src/mcp/tools.ts` (score 58) | 32.9% | 60.6% | **52.6%** (10,945, clusters) |
| `src/resolution/memory-budget.ts` (score 18) | 51.2% **whole** | 17.2% clustered | **27.3% whole** (5,672) |

**The `memory-budget.ts` exception is resolved, not re-justified.** CG-14 recorded it as a
documented exception to *"no file that was previously unclipped becomes clipped"*; its
reserved/size ratio is 0.73 — the same window as express's `utils.js` — so the buy rule covers
it. The answer file still wins the envelope **and** nothing that used to ship whole is clipped,
which is the first time both halves of CG-12's acceptance criterion hold at once.

The synthetic mirror in `explore-allocation-e2e.test.ts` deliberately does **not** move: its
helper sits at ratio ~0.17, far below the buy fraction, so it still clusters — correctly. That
divergence is the point of the fraction: `memory-budget.ts` was over-served by a *sliver*, the
synthetic helper by a *multiple*.

### Coverage

Two new hermetic fixtures, one per lever, because the existing suite could not see either. The
payroll and self-query fixtures both **saturate** (`[over budget] [TRUNCATED]`, 23,599 of a
23,600 pool reserved), and a saturated response has no unspent reservation to lose.

| Fixture | Shape | Guards |
|---|---|---|
| `CG-21 — a reservation under the file size still buys the file` | mid-sized rank-1 file, thin matched set, sized just above its reservation and *outside* the grace bound | the buy rule |
| `CG-21 — an unspendable reservation flows to the next file down` | rank-1 file far too big to buy (ratio 0.24) under-spends; a dense rank-2 file absorbs it | the carry-forward |

Each carries a `fixture shape` block that asserts the window it depends on
(`0.6 × size <= reserved < size`, outside the grace bound, inside the 220-line whole-file cap).
Those are load-bearing, not scaffolding: every gate passes **vacuously** if a target ever drifts
small enough for grace to cover it, which is precisely the way this defect hid.

Mutation-tested, same method as CG-14:

| Mutation | Tests that go red |
|---|---|
| Buy arm removed (`buysWhole = fileContent.length <= graceBound`) | 3 (new buy fixture) |
| Carry-forward removed (`allowance = reserved`) | 2 (new carry-forward fixture) |
| Funding guard removed (`… && true`) | 4 — including payroll's `payslip_builder.go` dropped |

Two traps the first drafts fell into, both of which made a test pass on the defect:

- **The spine ceiling hides a per-file assertion.** `SPINE_CEILING` already lets a flow-path
  cluster reach 1.5× its allowance, so "delivered > reserved" is true without any carry-forward.
  The carry-forward fixture is built spine-free and asserts a 1.1× margin — measured 9,297 vs
  7,479 across the mutation.
- **"Spend the whole pool" is not the invariant.** A file smaller than its reservation
  legitimately under-spends it (the fixture's `response.ts`: 1,635 delivered of 5,292 reserved).
  The assertion is per-file — *delivered >= min(reservation, file size)* — which is what express's
  `utils.js` violated and a pool-sum assertion does not express.

### A third condition, found by review rather than by a test

A buy must also **fit the render ceiling**. The whole-file branch refuses to slice a file
mid-method, so a whole render that overruns `renderCeiling` is skipped *entirely* — meaning a
buy approved by the funding pool but refused by the ceiling trades a clustered section for **no
section**. That is the same trade the funding pool exists to refuse, arriving by another route.

It is reachable only on the 24K tiers, which is why neither new fixture can see it:

| tier | envelope | `renderCeiling` = `min(1.5x, 25000) - 600` | funding line = `reservedTotal + 0.15x` |
|---|---|---|---|
| small | 13,000 | 18,900 | ~14,350 — cannot cross |
| medium/large | 24,000 | **24,400** | ~27,200 when saturated — **crosses by ~2.8K** |

So `buysWhole` carries `totalChars + size + FILE_OVERHEAD <= renderCeiling` as well; failing it
drops through to the cluster path, which is bounded by `headroom` and always renders something.
The grace arm is deliberately untouched — a file within a sliver of its reservation that still
does not fit is genuinely at the end of a full response, and that behaviour predates the epic.
Verified inert on all three A/B repos (excalidraw and client-go byte-identical across 3 queries
each, express reproducer unchanged), so it did not invalidate the measurement below.

### The agent A/B (CG-15's gate, re-run)

> **The epic's gate is CG-22, not this section.** This run was measured by the task that wrote
> the fix; CG-22 re-ran it at CG-15's exact setup (`RUNS=3`, fresh clones, baseline pinned to
> `49c11fc` by SHA) and it **passes all four bars there too** — Read = 0 in all 12 new-arm runs
> while the baseline reads in 3 of 3 express runs, and the deterministic reproducer holds with
> both builds re-measured in one session (`lib/utils.js` 6,380 B whole on both, envelope
> 13,849 → 14,913). See
> [`../benchmarks/explore-allocation-ab-1500.md`](../benchmarks/explore-allocation-ab-1500.md)
> § CG-22. The two counter-points that section records — excalidraw's answer share running
> below its baseline, and client-go's +1.5s median — are unresolved-but-attributed, not hidden.

Full record: [`../benchmarks/explore-allocation-ab-1500.md`](../benchmarks/explore-allocation-ab-1500.md)
§ "Re-run after CG-21". **All four bars pass**, at n=6 per arm on express and excalidraw:

- **Read = 0 in all 15 new-arm runs.** The express regression that routed the defect here (4
  Reads of `lib/utils.js`) does not reproduce in 6 attempts — and the *baseline* reads in 4 of
  6, so the control now beats the arm it previously lost to. Median 24.5s → 21.5s.
- **client-go** — the reporter's shape — holds 92.7–96.2% answer share against a baseline run
  at 53.8%.
- **Excalidraw's ~8s median gap is not attributable to the change.** Explore's own latency is
  374 ms vs 372 ms (n=5, same query and index); deterministic responses differ by +2% with one
  byte-identical; and the *unchanged* `main` build's own median moved 34s → 26.5s between the
  CG-15 session and this one — the same magnitude as the gap. Agent wall-clock on this repo is
  noise-dominated at this sample size, which is the known shape (host-model thinking dominates,
  not tool latency).
