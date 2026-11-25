# Agent A/B — score-proportional explore allocation (#1500 / epic CG-1)

Three measurements, in order. **The epic's gate is the last one** ([§CG-22](#cg-22--the-gate-re-run-at-cg-15s-exact-setup)):

| § | Task | Build | Verdict |
|---|---|---|---|
| [CG-15](#method) | first run of the gate | `edce18f` | **FAILS** bars 1 + 4 on express — routed the defect to CG-21 |
| [CG-21](#re-run-after-cg-21--the-gate-passes) | re-run while fixing | `fca7d87` | passes, n=6 on two repos, n=3 on client-go |
| [CG-22](#cg-22--the-gate-re-run-at-cg-15s-exact-setup) | **the gate** | `abee46c` | **PASSES** all four bars, CG-15's exact setup |

---

## CG-15 — the run that failed

**Date:** 2026-08-04 · **New:** `feature/CG-1` @ `edce18f` · **Baseline:** `main` @ `49c11fc`
· **Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `RUNS=3`, `--model sonnet --effort high`
on every arm · **Both arms codegraph-on.**

This is the epic's pass gate. The deterministic probes (CG-6/CG-14) prove the budget moved;
only an agent A/B proves the agent stopped reading.

**Verdict: the gate does not pass.** Bars 2 and 3 hold; **bar 1 (Read stays at 0) and bar 4
(no regression on the control) fail on express**, with a reproducible, non-agent cause. Per
the CG-15 acceptance rule the allocation design goes back to CG-12 — the budget is *not* to be
widened to compensate. Root cause and the smallest honest fix are in [§Root cause](#root-cause).

> **Superseded.** This section is the CG-15 measurement, kept because it is what routed the
> defect to CG-21 and because the root-cause analysis is the record of why. The defect was
> fixed and the A/B re-run twice: [§CG-21](#re-run-after-cg-21--the-gate-passes) alongside the
> fix, and [§CG-22](#cg-22--the-gate-re-run-at-cg-15s-exact-setup) — the epic's gate — at this
> section's exact setup. Nothing below was re-baselined.

---

## Method

`ab-new-vs-baseline.sh` builds and indexes each arm separately (CG-5's generated-file flag is
an index-time decision, so each arm must index with its own build), pre-warms a persistent
daemon per run, and runs the same flow question 3× per arm. Both arms run with
`CODEGRAPH_NO_PROMPT_HOOK=1` — the machine's ambient front-load hook resolves to whatever is
in `dist/` and would inject context through a second, uncontrolled channel.

Each prompt names codegraph as the lookup tool. That is **not** a forced-Read-0: the agent
stays free to Read whenever explore's answer is insufficient, which is exactly what bar 1
measures. It removes the one noise source that would otherwise swamp the signal — in a
pre-run without it, one express run made **0 codegraph calls and 3 Reads**, measuring adoption
(an axis this change does not touch) rather than allocation.

Envelope share is measured with `parse-run.mjs --envelope --answer <glob>`, which parses the
rendered markdown of the responses the agent actually received. The CG-4 diagnostic sidecar
only exists on the new build, so it cannot measure the baseline arm; the markdown parse is the
only instrument that measures both arms the same way.

That `--answer <glob>` is hand-specified ground truth. Every run now also reports the same
intersection inferred from the agent's own final answer, so it needs no per-question setup —
see [`explore-allocation-efficiency.md`](explore-allocation-efficiency.md), which re-scores
the arms below (express: 82% baseline → 100% new).

| Repo | Lang | Files | Generated | Tier | Role |
|---|---|---|---|---|---|
| `kubernetes/client-go` | Go | 2,454 | 2,001 | medium (2 calls / 28K) | **the #1500 shape** — generated CRUD beside hand-written machinery |
| `excalidraw/excalidraw` | TS/React | 672 | 0 | medium (2 calls / 28K) | god-file concentration (`App.tsx`, 450 KB) |
| `expressjs/express` | JS | 147 | 0 | small (1 call / 18K) | **control** |

---

## Results

`explore` = codegraph_explore calls · `Read` = Read tool calls · `answer%` = share of the
source envelope going to the files that answer the question. Three runs per arm, reported as
the range — run-to-run variance is large and a single run means nothing.

### client-go — "how does a shared informer keep its cache in sync and deliver events?"

Answer set `tools/cache/**`; generated set `kubernetes/**`, `listers/**`, `applyconfigurations/**`,
`informers/**`, `**/fake/**`.

| arm | explore | **Read** | duration | answer% | generated% |
|---|---|---|---|---|---|
| **new** | 2 / 2 / 6 | **0 / 0 / 0** | 39–61s (med 50) | 74.2 / 96.9 / 82.6 | 4.0 / 0.0 / 5.2 |
| baseline | 3 / 2 / 3 | 0 / 0 / 0 | 48–52s (med 49) | 78.1 / 97.1 / 71.3 | 10.5 / 0.0 / 5.1 |

No Read in either arm. The medians overlap: on this query `tools/cache/**` already dominates
graph relevance, so the baseline concentrated well without help. The #1500 signal is visible
but small — the generated clientsets and per-resource informers
(`informers/events/v1beta1/interface.go`, `kubernetes/typed/events/v1/fake/…`) take 10.5% of
one baseline run's envelope and **never appear in any new run**.

### excalidraw — "how does updating an element re-render the canvas on screen?"

Answer set: `mutateElement.ts`, `App.tsx`, `renderer/**`, `scene/**`, `components/canvases/**`.

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 2 / 3 / 2 | **0 / 0 / 0** | **23–32s (med 24)** | 74.4 / 67.8 / 84.7 |
| baseline | 3 / 3 / 4 | 0 / 0 / 0 | 33–39s (med 34) | 74.1 / 64.0 / 79.5 |

The clearest win: **29% faster at the median with one fewer explore call per run**, no Read in
either arm. Concentration is why — the new arm resolves the flow in 2 calls where the baseline
takes 3–4. (One baseline run burned a turn on a hallucinated `codegraph_..._explore` tool name;
counted as-is.)

### express — control — "how does res.send decide Content-Type and ETag?"

Answer set `lib/**` (both arms deliver 100%; the whole answer lives in `lib/`, so this repo
tests concentration *within* the answer set, not against noise).

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 1 / 4 / 2 | **0 / 4 / 0** | 18 / 52 / 24s | 100 / 100 / 100 |
| baseline | 2 / 2 / 2 | 1 / 1 / 1 | 23 / 28 / 27s | 100 / 100 / 100 |

Two of three new runs are strictly better than every baseline run (0 Reads vs 1, faster). The
third is the failure: **4 Reads of `lib/utils.js` and 52s**, a fallback the baseline never
made. It is not agent variance — see below.

---

## Root cause

Deterministic replay of the divergent run's own query on both builds, same index, no agent:

```
codegraph explore "res.send Content-Type ETag generateETag setETag" --path <express>
```

| file | baseline | new |
|---|---|---|
| `lib/utils.js` (5,293 B, 272 lines) | **6,380 (46.1%) — whole** | **583 (7.7%) — cluster stub** |
| `lib/response.js` | 3,935 (28.4%) | 6,001 (64.9%) |
| `lib/application.js` | 1,607 (11.6%) | 2,532 (27.4%) |
| `lib/express.js` | 1,927 (13.9%) | — |
| **source envelope** | **13,849** | **9,241** |

`lib/utils.js` is where `compileETag`, `createETagGenerator`, `etag` and `wetag` live — half the
answer. The CG-4 diagnostic on the new build:

```
envelope 10,295 delivered · 10,292 allocated of 13,000 budget
allocation 12,398 reserved of 12,400 pool · cliff at weight 10.00 · nothing cliffed
 #  deliv%   bytes  reserved  score   flags                render     file
 1    5.7%     583     3,870   56.0   named entry central  clusters   lib/utils.js
 2   57.0%   5,868     5,875   91.4   entry                clusters*  lib/response.js
 3   23.0%   2,369     2,653   34.5   entry central        clusters*  lib/application.js
```

`utils.js` is the **top-ranked** file (score 56.0, named + entry + central) and was **reserved
3,870 chars — and spent 583 of them.** Nothing was cliffed. The allocator did its job; the
render loop threw the reservation away.

The mechanism is the whole-file bound at `src/mcp/tools.ts:4008`:

```ts
const WHOLE_FILE_MAX_CHARS = allowance + Math.min(WHOLE_FILE_GRACE_MAX,
                                                  round(allowance * WHOLE_FILE_GRACE_FRACTION));
```

= `3,870 + min(800, 580)` = **4,450** < the file's 5,293 bytes, so the whole-file render is
declined. Pre-CG-12 the bound was `maxCharsPerFile * 3` = 11,400, which the file cleared
comfortably. The fallback cluster render only has 3 matched symbols to work with, so it emits
583 chars and **3,287 chars of the reservation are simply lost** — which is also why the whole
response shrank from 13.8K to 9.2K against an unchanged 13,000-char budget.

This is CG-12's own acceptance criterion — *"no file that was previously unclipped becomes
clipped"* — failing, and here it is the direct cause of an agent Read. CG-14 recorded one
instance of it (`memory-budget.ts`) as a documented exception; this is the same defect
observed in the wild, where it costs a round-trip.

**Not systemic.** On both medium repos the render loop saturates (`[over budget] [TRUNCATED]`,
23,599 of a 23,600 pool reserved), so there is no unspent budget to lose. The failure needs a
file whose proportional reservation lands *below its own size* while its matched-symbol set is
thin — likelier on small repos, where per-file reservations are smallest.

### The fix belongs in CG-12, not here

Per this task's acceptance rule the budget must **not** be widened to compensate. The defect is
that a reservation can go unspent, so the fix is one of:

1. **Let a large-enough reservation buy the whole file.** If `allowance >= k * fileSize` for
   some k < 1 (utils.js: 3,870 / 5,293 = 0.73), render whole and let the bounded overshoot the
   ceiling already tolerates absorb it — the bytes were reserved for this file anyway.
2. **Redistribute what a file cannot spend.** After the render loop knows a file's realised
   size, hand the shortfall to the next-ranked file instead of dropping it. This also fixes the
   shrinking-envelope symptom directly.

(1) is the smaller change and matches the observed shape; (2) is the more complete invariant
("the pool is spent"). They compose.

---

## Bars

| # | Bar | Verdict |
|---|---|---|
| 1 | **Read stays at 0** | **FAIL** — client-go 0/0/0 and excalidraw 0/0/0 both arms, but express run 2 makes 4 Reads the baseline never made, from a reproducible non-agent cause |
| 2 | Correct-file share > 50% | **PASS** — new 67.8–100% across all 9 runs; self-query fixture 16% → 59.9%. (Caveat: on these three repos the *baseline* was already above 50%; the ~16% figure is the self-query fixture, not these repos) |
| 3 | No wall-clock regression | **PASS at the median** — excalidraw 34s → 24s, express 27s → 24s, client-go 49s → 50s. The 52s express outlier is the failing run |
| 4 | No regression on the control | **FAIL** — express, 1 run of 3 |

Bar 1 is the hard gate and it fails, so the epic does not pass on this measurement regardless
of bars 2 and 3.

## Reproduce

```bash
# clone fresh (never eval on a private repo), index, then:
RUNS=3 AGENT_EVAL_OUT=/tmp/ab-express \
  scripts/agent-eval/ab-new-vs-baseline.sh <express> "<question>" main

node scripts/agent-eval/parse-run.mjs /tmp/ab-express/run-new-2.jsonl --answer 'lib/**'

# the deterministic core of the failure, no agent needed:
CODEGRAPH_EXPLORE_DEBUG=1 node dist/bin/codegraph.js \
  explore "res.send Content-Type ETag generateETag setETag" --path <express>
```

---

# Re-run after CG-21 — the gate passes

**Date:** 2026-08-04 · **New:** `feature/CG-1` @ `fca7d87` (CG-21) · **Baseline:** `main`
(unchanged) · same harness, same three prompts, same repos, `--model sonnet --effort high`,
both arms codegraph-on. **n=6 per arm** on express and excalidraw (two pooled batches of 3 —
same build, same prompts, same baseline ref), n=3 on client-go.

**Verdict: all four bars pass.** Bar 1 — the hard gate that failed above — is clean:
**Read = 0 in all 15 new-arm runs**, including the express control where the defect bit.

### Read and wall-clock

`explore` / `Read` are per-run counts; duration is the median with the range beneath.

| repo | arm | n | explore | **Read** | duration |
|---|---|---|---|---|---|
| **express** (control) | **new** | 6 | 2,2,2,2,1,1 | **0 ×6** | **21.5s** (18–30) |
| | baseline | 6 | 2,1,2,2,2,2 | **1 in 4 of 6** | 24.5s (19–29) |
| **excalidraw** | **new** | 6 | 3,2,2,3,4,2 | **0 ×6** | 34.5s (28–43) |
| | baseline | 6 | 2,4,2,2,2,2 | 0 ×6 | 26.5s (24–45) |
| **client-go** | **new** | 3 | 2,4,4 | **0 ×3** | 45s (44–52) |
| | baseline | 3 | 4,2,4 | 0 ×3 | 43s (40–49) |

The express row is the fix, measured end to end: the CG-12 arm made **4 Reads of
`lib/utils.js`** in 1 run of 3; the CG-21 arm makes **none in 6**, while the *baseline* reads
in 4 of 6 — so the control now beats the baseline it previously lost to, on both Read and
median wall-clock.

### Envelope share (bar 2)

| repo | new | baseline |
|---|---|---|
| express | 100% ×6 | 100% ×6 |
| excalidraw | 65.8 / 79.6 / 78.9% | 82.8 / 78.9 / 85.1% |
| client-go | **96.0 / 96.2 / 92.7%** | 86.7 / **53.8** / 80.2% |

client-go — the #1500 shape — is where the change is supposed to show, and does: the new arm
never drops below 92.7% while the baseline has a 53.8% run. Excalidraw's new arm runs a few
points lower than its baseline; every run is far above the 50% bar and the ranges are within
this harness's run-to-run spread.

### The excalidraw wall-clock gap is not the build

Excalidraw's new arm is ~8s slower at the median, which reads like a bar-3 failure until it is
attributed. Three measurements say it is session variance, not the change:

1. **Explore's own latency is unchanged.** Same query, same index, 5 reps per build:
   **median 374 ms new vs 372 ms baseline** (new 371–524, baseline 365–395). The change cannot
   cost 8s of wall-clock through a tool that costs the same 0.37s.
2. **The responses are the same size.** Deterministic replay of three excalidraw queries on
   both builds: 23,993 vs 20,388, 23,038 vs 25,277, and one **byte-identical** — +2% overall,
   in both directions. No truncation in any of the 12 runs, either arm.
3. **The identical baseline build moved 34s → 26.5s between sessions.** `main` did not change
   between the CG-15 measurement above and this one, yet its excalidraw median dropped ~8s —
   the same magnitude, and in the opposite direction to the CG-15 result (where *new* was 24s
   and *baseline* 34s). Between-session variance on this repo is as large as the effect.

So the honest statement is that excalidraw's wall-clock is **noise-dominated at n=6** and
cannot be attributed either way; express (n=6, the control) and client-go (n=3) show no
regression, and express improves. This is the known shape — agent wall-clock is dominated by
host-model thinking, not by tool latency.

### Bars

| # | Bar | Verdict |
|---|---|---|
| 1 | **Read stays at 0** | **PASS** — 0 in all 15 new-arm runs across 3 repos. The CG-15 failure (4 Reads of `lib/utils.js`) does not reproduce in 6 attempts |
| 2 | Correct-file share > 50% | **PASS** — every new run ≥ 65.8%; client-go 92.7–96.2% vs a baseline run at 53.8% |
| 3 | No wall-clock regression | **PASS** — express 24.5s → 21.5s, client-go 43s → 45s (overlapping). Excalidraw's +8s is not attributable to the build (see above) |
| 4 | No regression on the control | **PASS** — express is the control and improves on both axes |

Bars were **not** re-baselined: they are the same four from CG-15, applied to a larger sample.

### Deterministic core

The reproducer that routed the defect to CG-21, on the shipped build:

| `lib/utils.js` (5,293 B, 272 lines) | baseline | CG-12 | **CG-21** |
|---|---|---|---|
| delivered | 6,380 (46.1%) whole | **583 (7.7%) stub** | **6,268 (39.3%) whole** |
| source envelope (13,000 budget) | 13,849 | **9,241** | **14,505** |

```
allocation 12,398 reserved of 12,400 pool · nothing cliffed
 #  deliv%   bytes  reserved  score   flags                render   file
 1   39.3%   6,268    3,870   56.0   named entry central  whole    lib/utils.js
 2   36.8%   5,868    5,875   91.4   entry                clusters lib/response.js
 3   14.8%   2,369    2,653   34.5   entry central        clusters lib/application.js
```

Design and coverage: [`../design/explore-budget-allocation.md`](../design/explore-budget-allocation.md) § CG-21.

---

# CG-22 — the gate, re-run at CG-15's exact setup

**Date:** 2026-08-04 · **New:** `feature/CG-1` @ `abee46c` (`src/` identical to CG-21's
`fca7d87`; the two commits since are docs) · **Baseline:** `main` @ `49c11fc`, passed to the
harness as that SHA rather than as `main`, so the ref cannot drift · `RUNS=3`,
`--model sonnet --effort high` on every arm, both arms codegraph-on,
`CODEGRAPH_NO_PROMPT_HOOK=1` on both · same three repos, same three questions.

**This is the epic's gate.** CG-21's re-run above was measured by the task that wrote the fix;
this one re-measures it at the setup the failing run used, from a clean clone of each repo.

**Verdict: all four bars pass.** **Read = 0 in all 12 new-arm runs**, including the express
control where CG-15 failed — while the *baseline* reads in 3 of 3 express runs and in 1 of 6
client-go runs.

Repos re-cloned fresh at their current tips, so the file counts move slightly against the
CG-15 table (express 147 — unchanged; excalidraw 677, was 672; client-go 2,454 — unchanged).
Every repo stays in the same budget tier, so the allocator sees the same envelope.

## Results

`explore` / `Read` are per-run counts in run order; duration is the median with the range
beneath; `answer%` is the share of the source envelope going to the files that answer the
question, per run.

### express — control — "how does res.send decide Content-Type and ETag?"

Answer set `lib/**`.

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 1, 2, 2 | **0, 0, 0** | **24s** (18–35) | 100, 100, 100 |
| baseline | 2, 2, 2 | **1, 1, 1** | 26s (24–30) | 100, 100, 100 |

The bar-1 failure is gone at its own site. In every new-arm run the agent received
`lib/utils.js` **whole** — 6,643 / 7,673 / 6,455 chars, against the baseline's 6,396 / 6,380 /
6,396 — and never opened it. The baseline reads `lib/utils.js` in all three runs.

### excalidraw — "how does updating an element re-render the canvas on screen?"

Answer set: `mutateElement.ts`, `App.tsx`, `renderer/**`, `scene/**`, `components/canvases/**`.

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 2, 2, 2 | **0, 0, 0** | 26s (26–27) | 81.9, 69.3, 66.6 |
| baseline | 4, 2, 2 | 0, 0, 0 | 26s (21–32) | 92.7, 75.5, 81.0 |

Both arms clean, medians equal. Stated plainly because it is the one number that moves the
wrong way: the new arm's answer share runs **below** its baseline here (66.6–81.9 vs
75.5–92.7), the same direction CG-21 saw. Every run is far above the 50% bar, and this repo's
"answer set" is five globs over a god-file codebase where the baseline's extra breadth lands
inside them by luck of size, not by relevance — but it is not an improvement on this repo and
is not reported as one.

### client-go — the #1500 shape — "how does a shared informer keep its cache in sync and deliver events?"

Answer set `tools/cache/**`. **n=6 per arm** — two pooled batches of 3 (same build, same
prompt, same baseline SHA), run to tighten the wall-clock bound after batch 1 came out 4s
apart at the median.

| arm | explore | **Read** | duration | answer% |
|---|---|---|---|---|
| **new** | 3, 3, 2, 4, 2, 2 | **0 ×6** | 36.5s (30–46) | 95.2, 97.8, 92.3, 96.8, 96.8, 89.8 |
| baseline | 2 ×6 | **2 Reads in 1 of 6** | 35s (31–42) | 95.4, 100, 100, 85.6, 97.0, 97.0 |

The new arm never drops below 89.8% and never reads; the baseline has an 85.6% run and one run
that reads twice. **The generated layers stay out of both arms this session** — no
`kubernetes/**`, `listers/**`, `applyconfigurations/**` or `**/fake/**` file takes envelope in
any of the 12 runs, where CG-15's baseline gave them 10.5% of one run. That is the #1500 signal,
and it is *smaller here than in the earlier sessions* because this session's baseline sampled
well (85.6–100% answer share, against 53.8–86.7% in CG-21's). Reported as measured.

The new arm spends one extra explore call in 3 of 6 runs. Inspecting the sequences, the extra
call is a **deeper drill-down** (`processDeltas sharedProcessor run distribute …`) after a
complete answer, not a recovery from an insufficient one — every one of those runs still ends
at Read 0.

## Wall-clock, attributed

client-go is the only repo where the new arm's median is higher (36.5s vs 35s at n=6). Two
deterministic measurements say it is not the build:

1. **Explore's own latency is identical.** Same query, same repo, 5 reps per build:
   client-go **669 ms new vs 668 ms baseline** (new 666–671, baseline 663–673); express
   **204 ms vs 203 ms** (new 203–207, baseline 201–206). A 1 ms tool cannot cost 1.5s of agent
   wall-clock.
2. **The new build's response is not bigger.** Deterministic replay of the client-go drill-down
   query: source envelope **15,813 new vs 18,898 baseline**, with `shared_informer.go` taking
   50.2% instead of 35.7% — more concentrated *and* smaller.

The ranges overlap almost completely (new 30–46, baseline 31–42), which is the known shape:
agent wall-clock is dominated by host-model thinking, not tool latency.

## Deterministic core — the reservation defect is gone

The reproducer named in CG-22's acceptance, run on both builds in this session, same query,
each build indexing its own copy:

```
CODEGRAPH_EXPLORE_DEBUG=1 codegraph explore \
  "res.send Content-Type ETag generateETag setETag" --path <express>
```

| `lib/utils.js` (5,293 B, 272 lines) | baseline `49c11fc` | CG-12 | **HEAD** |
|---|---|---|---|
| delivered | 6,380 (46.1%) whole | **583 (7.7%) stub** | **6,380 (42.8%) whole** |
| source envelope (13,000 budget) | 13,849 | **9,241** | **14,913** |

Both conditions hold: the reservation is **spent** (reserved 3,870, whole-file render), and the
envelope does not shrink against an unchanged budget — 14,913 against the baseline's 13,849.
The baseline column was re-measured here, not quoted from CG-15, so the comparison is
within-session. The CG-4 diagnostic on HEAD:

```
envelope 15,967 chars delivered · 15,964 allocated of 13,000 budget (hard ceiling 19,500)
allocation 12,398 reserved of 12,400 pool · cliff at weight 10.00 · nothing cliffed
 #  deliv%   bytes  reserved  score   flags                render     file
 1   39.3%   6,268    3,870   56.0   named entry central  whole      lib/utils.js
 2   36.8%   5,868    5,875   91.4   entry                clusters*  lib/response.js
 3   14.8%   2,369    2,653   34.5   entry central        clusters*  lib/application.js
```

(6,268 is the diagnostic's source-only count; 6,380 is the rendered section including its
header, which is what the envelope parser and the baseline column measure. Same render.)

## Bars

| # | Bar | Verdict |
|---|---|---|
| 1 | **Read stays at 0** | **PASS** — 0 in all 12 new-arm runs (express 3, excalidraw 3, client-go 6). The express run that failed CG-15 with 4 Reads of `lib/utils.js` reads nothing, and the baseline reads in 3 of 3 express runs |
| 2 | Correct-file share > 50% | **PASS** — every new run ≥ 66.6%; express 100% ×3, client-go 89.8–97.8% |
| 3 | No wall-clock regression at the median | **PASS** — express 26s → 24s, excalidraw 26s → 26s, client-go 35s → 36.5s at n=6 with fully overlapping ranges and identical explore latency (669 vs 668 ms) |
| 4 | No regression on the control | **PASS** — express improves on both axes: Read 3 of 3 → 0 of 3, median 26s → 24s, envelope 100% answer-set in both arms |

Bars were **not** re-baselined; they are CG-15's four, unchanged.

## Honest notes on the setup

- **The prompt wrapper is reconstructed.** The record preserved the three questions verbatim
  but not the sentence that names codegraph as the lookup tool. Every arm and every repo here
  used the identical wrapper `Use codegraph to answer: <question>`, so the comparison is
  internally exact; it may differ by a few words from CG-15's.
- **Excalidraw is at a newer tip** (677 files, was 672) — same tier, same budget.
- Full suite green on the measured build: 171 files, **2,868 passed**, 6 skipped, 0 failures.

## Reproduce

```bash
# clone fresh (never eval on a private repo), index with the build under test, then per repo:
RUNS=3 MODEL=sonnet EFFORT=high AGENT_EVAL_OUT=/tmp/ab-express \
  scripts/agent-eval/ab-new-vs-baseline.sh <express> \
  "Use codegraph to answer: how does res.send decide Content-Type and ETag?" 49c11fc

node scripts/agent-eval/parse-run.mjs /tmp/ab-express/run-new-2.jsonl --answer 'lib/**'

# the deterministic core, no agent needed:
CODEGRAPH_EXPLORE_DEBUG=1 node dist/bin/codegraph.js \
  explore "res.send Content-Type ETag generateETag setETag" --path <express>
```
