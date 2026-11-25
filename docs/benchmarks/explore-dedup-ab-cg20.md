# Agent A/B — cross-call explore dedup (epic CG-2 / task CG-20)

**Date:** 2026-08-05 · **New:** `feature/CG-2` @ `7a7ea30` (CG-17 session state + CG-18 dedup)
· **Baseline:** `c65d56c` **by SHA** (main's tip when the epic branched) · **Harness:**
`scripts/agent-eval/ab-new-vs-baseline.sh`, `--model sonnet --effort high`, **both arms
codegraph-on**, `CODEGRAPH_NO_PROMPT_HOOK=1` on both.

This is the epic's hard gate. Returning *less* on a repeat call is the exact shape CLAUDE.md
says drives Read fallback and then teaches the agent to abandon codegraph for the rest of the
session, so the gate is about risk first and win second.

**Verdict: bars 1–3 pass cleanly and bar 4 is not met.** Read is **0 in all 24 runs of both
arms**, nothing abandons, and the two failure buckets never fire once. Residual context
occupancy is **flat** — and the measurement below shows it could never have been anything else,
because CG-18's own acceptance requires reclaimed bytes to be **re-spent on files the agent has
not seen** rather than banked. What the change actually moves is the *duplicate fraction* of
that residual: **−87% across the agent runs**, −86%/−94% deterministic.

Recommendation: **keep**, with bar 4 restated. Reasoning and the counter-case in
[§Verdict](#verdict).

---

## Method

Dedup only exists inside one MCP session, so a single-call task cannot exercise it at all. Both
targets were driven with the drill-down question from the CG-1/CG-22 A/B, which reliably
produces a second and third explore whose symbol bags overlap the first:

| Repo | Lang | Files | Tier | Question |
|---|---|---|---|---|
| `kubernetes/client-go` | Go | 2,454 | medium (2 calls / 28K) | "how does a shared informer keep its cache in sync and deliver events?" |
| `excalidraw/excalidraw` | TS/React | 672 | medium (2 calls / 28K) | "how does updating an element re-render the canvas on screen?" |

Each prompt is wrapped `Use codegraph to answer: <question>` — identical on every arm, the CG-22
wrapper. That is **not** a forced-Read-0: fallback stays free, which is exactly what bar 1
measures.

`RUNS=3` per invocation. client-go ran one batch (n=3/arm); excalidraw ran **two** (n=6/arm,
pooled) because it is where dedup bites hardest and therefore where the abandonment risk is
highest — its baseline sequence duplicates ~21% of the source it serves.

### Instruments

Three, because no single one answers the gate:

- **CG-7 residual occupancy** and **CG-8 sufficiency buckets**, from the `feature/CG-3` copy of
  `parse-run.mjs` (that branch is where all three feedback metrics live; this branch's copy
  predates them). Bars 2–4.
- **A duplicate-residual measure**, written for this gate. CG-7's occupancy counts the chars of
  codegraph results resident in the window but **cannot tell a byte the agent already holds from
  one it has never seen** — which is the only distinction dedup makes. This one reads the
  *rendered markdown* of every explore response in a run (so it measures both arms the same way;
  the CG-4 diagnostic sidecar exists only on the new build), reconstructs the `(file, source
  line)` pairs each call put in the window from the `<n>\t<text>` fences, and charges a line
  already delivered by an earlier call as a duplicate byte.

  It is deliberately **not** committed as a new `scripts/agent-eval/*.mjs`: a new file there
  scores into the self-query eval fixture's own corpus and moves its numbers (the CG-15 observer
  effect), and the natural home is `parse-run.mjs` **on `feature/CG-3`** beside the other three
  metrics. Fold it in there; the rule above is the whole specification.

---

## Deterministic core — no agent

Same index, same query sequence (lifted verbatim from a prior new-arm agent run), replayed
through **one** `ToolHandler` + **one** `ExploreSessionState` on each build. Re-measured on both
builds in this session rather than quoted.

### client-go — 3 calls

| | baseline `c65d56c` | new `7a7ea30` |
|---|---|---|
| response chars | 65,218 | **67,289 (+3.2%)** |
| source chars | 46,555 | 47,209 |
| **unique source** | 44,740 | **46,957 (+5.0%)** |
| **duplicate source** | **1,815 (3.9%)** | **252 (0.5%) — −86%** |

### excalidraw — 3 calls

| | baseline `c65d56c` | new `7a7ea30` |
|---|---|---|
| response chars | 72,364 | **68,442 (−5.4%)** |
| source chars | 50,063 | 44,578 |
| **unique source** | 39,575 | **43,973 (+11.1%)** |
| **duplicate source** | **10,488 (20.9%)** | **605 (1.4%) — −94%** |

The two repos bracket the mechanism. Where the baseline barely duplicates (client-go, 3.9%)
there is almost nothing to reclaim, and the reclaimed bytes plus the pointer text make the
response marginally *larger*. Where it duplicates heavily (excalidraw, 20.9%) the response gets
**smaller and denser at the same time** — 5.4% fewer bytes carrying 11.1% more unique source.

**The ceiling on any occupancy win is the baseline's duplicate fraction**, and that is the whole
argument about bar 4: even a design that banked every reclaimed byte instead of re-spending it
could not have removed more than 3.9% / 20.9% of the source in these two sequences.

### Explore latency — the change is not a slowdown

Median of 5 replays of the 3-call sequence, per build (CG-18 adds a truncated SHA256 per served
slice, so this needed checking):

| repo | baseline | new |
|---|---|---|
| client-go | 1,230 ms | 1,287 ms (+4.6%) |
| excalidraw | 458 ms | 445 ms (−2.8%) |

≤60 ms across three calls. Nothing here can explain a several-second agent gap — see
[§Counter-points](#counter-points).

---

## Agent A/B — the four bars

`explore` = `codegraph_explore` calls · `cgResidual` = codegraph chars still resident at end of
run, CG-7 · `dup%` = share of served source the agent had already been given.

| repo | arm | n | explore | **Read** | Grep | cgResidual (med) | per call | dur (med) | **dup%** |
|---|---|---|---|---|---|---|---|---|---|
| client-go | **new** | 3 | 2 / 3 / 2 | **0 / 0 / 0** | 0 | 19,446 | 9,641 | 31s | **0.7%** |
| client-go | baseline | 3 | 3 / 2 / 2 | 0 / 0 / 0 | 0 | 19,611 | 9,379 | 27s | 7.9% |
| excalidraw | **new** | 6 | 3,3,1,2,3,2 | **0 ×6** | 0 | 25,688 | 10,316 | 31s | **0.7–0.8%** |
| excalidraw | baseline | 6 | 2,2,2,1,3,2 | 0 ×6 | 0 | 20,123 | 10,158 | 23s | 3.3–7.6% |

### Bar 1 — Read count must not increase · **PASS**

**Read = 0 and Grep = 0 in all 24 runs, both arms, both repos.** Not "did not increase" — never
fired. The strongest form of this bar: back-references actually reached the agent in **8 of the
9 multi-call new-arm runs** (28 pointers total), and no run followed a pointer with a Read.

### Bar 2 — no abandonment · **PASS**

The failure mode is silent, so it was measured three ways, all clean across 24 runs:

- **Zero `isError` responses** in either arm. (One or two early in a session is what teaches
  abandonment; there were none.)
- **codegraph is the last tool called in every single run** — 0 Read/Grep/Glob/Bash calls after
  the final codegraph call, in both arms.
- Call counts do not collapse in the new arm: 2–3 on client-go, 1–3 on excalidraw, the same
  spread the baseline shows.

### Bar 3 — sufficiency buckets must not shift · **PASS**

The two buckets this epic could plausibly break are **"Read a file we returned"** (we clipped
the wrong thing) and **"Read a file we did not return"**. Over 40 answered explore calls:

| bucket | new | baseline |
|---|---|---|
| Read a file we returned | **0** | 0 |
| Read a file we did not return | **0** | 0 |
| Grep/Glob | **0** | 0 |
| explore again | 12 of 21 (57.1%) | 10 of 19 (52.6%) |
| moved on / answered | 9 | 9 |

The failure buckets are empty on both arms. The `explore again` difference is **one call** at
n=21/19 — noise, and CG-1 already established that these are voluntary drill-downs after a
complete answer, not insufficiency retries (which is why CG-19 was cut).

### Bar 4 — residual occupancy must actually drop · **NOT MET**

Per-run `cgResidual` is dominated by how many calls the agent chose to make, and both arms span
1–3 calls on excalidraw. Normalising that out, **residual per explore call is flat**: +2.8% on
client-go (9,641 vs 9,379), +1.6% on excalidraw (10,316 vs 10,158).

This is **by construction, not by accident**. CG-18's acceptance says in as many words:
"*Freed budget — bytes reclaimed by dedup should flow to files not yet shown, not shrink the
response*," and `emitFileSection` implements exactly that (a fully-held file frees both its
`sourceSpent` into the carry-forward pool and its `maxFiles` slot). A design that spends every
reclaimed byte cannot lower the byte count. **CG-18's acceptance and CG-20's bar 4 are
mutually unsatisfiable**; that contradiction, not a defect in the dedup, is what this bar found.

What the epic *does* move, measured on the same runs:

| | new | baseline |
|---|---|---|
| duplicate source chars, all agent runs | **2,432 of 329,222 (0.74%)** | 19,295 of 300,750 (6.4%) |

**−87% duplicated bytes**, at flat cost per call, with more unique source in their place.

---

## Counter-points

Kept in the record rather than smoothed:

- **excalidraw's new arm is slower at the median: 31s vs 23s**, and its median call count is
  2.5 vs 2. It is *not* server-side — explore's own latency is −2.8% there and the deterministic
  response for the identical 3-query sequence is **5.4% smaller** on the new build, so the extra
  call is not the agent compensating for a thinner answer (and bar 3's failure buckets are
  empty). But at n=6 with both arms spanning 1–3 calls, the difference is one call and **this
  measurement cannot attribute it to the build either way**. client-go shows the same-sized gap
  (31s vs 27s) at an *identical* median call count. Treat as unresolved; a bigger n is the only
  thing that settles it.
- **`dedup.savedChars` in the CG-4 diagnostic is a pre-clip figure and must not be read as
  bytes kept out of the window.** On client-go call 2 it reports **11,450 saved** while the
  baseline actually re-served only **1,042** duplicate chars of that file — the suppressed
  ranges are measured against the *unclipped candidate* render, most of which the budget
  allocator would have trimmed anyway. Section-level check on the same call: baseline emits 232
  lines of `shared_informer.go` overlapping call 1 by 22 lines; the new build emits 234 lines
  overlapping by **0**, and is 544 chars *larger*. Anyone tuning `EXPLORE_DEDUP`'s thresholds off
  `savedChars` will over-estimate the win by roughly 7×.
- **client-go's baseline duplicated less than expected** (3.9% deterministic, 0–20.6% across
  runs). On that query `tools/cache/**` already dominates graph relevance, so the pre-dedup
  render concentrated well on its own — the same reason CG-22 found only a small #1500 signal
  there.

---

## Verdict

| bar | result |
|---|---|
| 1. Read must not increase | **PASS** — 0 Reads in 24/24 runs, both arms |
| 2. No abandonment | **PASS** — 0 `isError`, codegraph last in every run, no call collapse |
| 3. Buckets must not shift to "Read a file we returned" / "another explore" | **PASS** — both failure buckets empty on both arms |
| 4. Residual occupancy actually drops | **NOT MET** — flat per call, and unreachable given CG-18's reallocation rule |

The epic's acceptance says *revert if bar 4 is not met, because the regression risk isn't worth
a marginal win*. **The regression half of that premise was measured and is zero** — 24 runs, no
Read, no abandonment, no bucket shift, back-references demonstrably reaching the agent. And bar
4 is unreachable by construction, not unmet by underperformance: the byte ceiling it was aiming
at is the baseline's duplicate fraction, 4–21%, and CG-18 was already accepted on the rule that
those bytes get **spent, not banked**.

So: **keep the change, and restate the epic's metric** as the duplicate fraction of residual
(−87% agent, −86%/−94% deterministic) at flat context cost — with excalidraw showing the
best case, 5.4% fewer response bytes carrying 11.1% more unique source.

This is a judgement call against the letter of bar 4, and it is cheap to reverse in either
direction:

- runtime: `CODEGRAPH_EXPLORE_DEDUP=0` disables dedup without a rebuild;
- source: `git revert 7a7ea30 ab38d1f 4e94860 fc31b1e` removes CG-17 + CG-18 entirely;
- the third option, if occupancy really is the goal: **bank the reclaimed bytes instead of
  re-spending them**, which reverses CG-18's freed-budget rule and buys at most the duplicate
  fraction above. That needs its own gate — it is a strictly *smaller* answer per call, which is
  the shape this task exists to be afraid of.

Logs: `/tmp/cg20/ab-client-go`, `/tmp/cg20/ab-excalidraw`, `/tmp/cg20/ab-excalidraw-b2`
(ephemeral — archive them if a distribution needs to stay reproducible).
