# Agent A/B — bounded oversize cluster member (task CG-30)

**Date:** 2026-08-06 · **New:** `bugfix/CG-30` · **Baseline:** `main` @ `d6d1728` ·
**Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `--model sonnet --effort high`,
**both arms codegraph-on**, CLI blocked (0 contamination in every run),
`CODEGRAPH_NO_PROMPT_HOOK=1`.

CG-30 bounds how far a cluster's top member may overshoot what its file may spend: past 1.5x it
is windowed on whole lines instead of emitted whole. The risk the A/B exists to price is the one
CLAUDE.md names — a section that is no longer sufficient sends the agent to Read, and one or two
of those teach it to stop calling codegraph at all.

**Verdict: no regression, and the deterministic win is unambiguous.** The behavioural bar holds
(Read/Grep ~0, no abandonment, allocation efficiency 100% on the repo where the bound engages),
the cost is a ~10% median duration increase on django inside overlapping ranges, and the one
allocation-miss call the new arm produced is matched by two recall-miss calls in the baseline.

> **Harness note, recorded because it cost a re-run:** `ab-new-vs-baseline.sh` checks the engine
> out at the BASELINE ref while its baseline arm runs and restores it on exit. **Do not commit
> while it is running** — a commit made mid-run captures baseline sources. The first django/gin
> batches were void for exactly this reason (their `changed:` line listed only
> `explore-diagnostics.ts`, i.e. both arms ran identical retrieval code) and were re-run. Check
> that line before believing any A/B in this harness.

---

## Deterministic measurement — where the bound actually engages

Same index, same query, both builds. This is the primary evidence; the agent runs below only
price the risk.

**django** — `codegraph explore "How does a QuerySet turn into SQL and fetch rows from the
database?"`

| | baseline | new |
|---|---|---|
| `django/db/models/query.py` | 7,784 chars on a 3,669 budget — **2.12x** | 5,464 — **1.49x**, windowed |
| `django/contrib/admin/filters.py` | 3,633 (inherited 2,271 spendable) | **8,057** (inherited 9,160) |
| source delivered | 17,929 chars, 5 files | **20,033** chars, 5 files |

The reported CG-30 signature, reproduced on a public repo and then closed: the rank-#1 file took
2.12x its budget, and the files below it inherited the shortfall. Bounding it hands those bytes
straight down the rank order — the response carries the same five files and 2,104 more chars of
actual source.

**gin (control)** — the two builds produce **byte-identical** explore output (13,457 chars) for
the route-dispatch query. Nothing in gin is oversize enough for the bound to engage (max
observed 0.94x of spendable), which is exactly what a control should show — and it means every
gin number in the agent table below is run-to-run variance, not the change.

**Fixture** — `__tests__/fixtures/oversize-member-ts`, three report builders competing for one
envelope, each a single long function:

| File | baseline | new |
|---|---|---|
| `monthly.ts` (24.5K, one ~490-line function) | 12,391 chars on a 3,334 budget — **3.7x** | 4,941 — **1.48x**, windowed |
| `quarterly.ts` (11.4K, one ~200-line function) | **dropped** — `budget-clusters`, no headroom left | 4,004 delivered |
| response | 19,223 chars, 3 files | 15,852 chars, 4 files |

The two rows are the same defect from both sides: a member bigger than the file's share eats the
envelope, and a member bigger than the whole response ceiling makes the file vanish. Pinned by
`__tests__/explore-oversize-member.test.ts` (9 tests; 4 fail on `main`).

## Agent runs

| | django new | django base | gin new | gin base | excalidraw new | excalidraw base |
|---|---|---|---|---|---|---|
| runs | 5 | 5 | 3 | 3 | 2 | 2 |
| duration (s) | 39 [36–71] | 35 [35–60] | 39 [37–51] | 34 [28–46] | 52 [43–60] | 41 [40–42] |
| tool calls | 3 [3–10] | 4 [3–23] | 4 [3–4] | 3 | 4 [3–5] | 4 [3–4] |
| codegraph calls | 2 [2–3] | 2 [0–3] | 2 [2–3] | 2 | 3 [2–4] | 3 [2–3] |
| Read | 0 [0–5] | 0 [0–13] | 0 [0–1] | 0 | 0 | 0 |
| Grep/Glob | 0 | 0 | 0 | 0 | 0 | 0 |
| occupancy share | 33.1% [30.7%–49.5%] | 34.4% [29.3%–47.3%] | 28.9% [26.4%–37.3%] | 30.1% [28.6%–31.9%] | 43.0% | 39.3% |
| allocation efficiency | 100.0% | 98.6% | 88.5% | 98.3% | 85.8% | 90.5% |

django is pooled over two batches (n=2 + n=3). Questions: django "How does a QuerySet turn into
SQL and fetch rows from the database? Trace the flow end to end."; gin "How does a registered
route handler get invoked for an incoming HTTP request?…"; excalidraw "How does updating an
element re-render the canvas on screen?…".

**Sufficiency, pooled per call — the bar that matters.** django: new 1 "Read a file we returned"
in 10 answered calls (the allocation-miss signal a window would trip first) against the
baseline's 1 "Read a file we did not return" + 1 Grep in 10 — a shift in miss type, not an
increase. gin: 1 allocation miss in 7 against 0 in 6, on a repo where the two builds emit
identical bytes, so it is variance by construction. excalidraw: 0 misses in either arm.

**Where the new arm looks worse, and why it is not read as a regression:**

- *django duration, ~10% slower median.* Ranges overlap (36–71 vs 35–60) at n=5, and one
  baseline run lost its codegraph attach entirely (0 codegraph calls, 13 Reads, 23 tool calls),
  which distorts that arm's spread in both directions.
- *gin allocation efficiency 88.5% vs 98.3%.* The builds are byte-identical on gin. This is the
  metric's documented relativity — attribution is by citation and the agent's follow-up queries
  differ per run — not an effect of the change.
- *excalidraw occupancy/duration.* Call-count noise: one of the two new-arm runs made a 4th
  explore call where the baseline made 2–3, and duration, envelope and occupancy all follow it.
  Per-call envelope is flat (20,015 vs 19,446 chars/call), Read/Grep stay 0, tool calls match.
  CLAUDE.md's own worked example records 3–10 codegraph calls on this prompt.

## Caveat carried forward

The `self-query` probe fixture in `scripts/agent-eval/allocation-fixtures.json` flips to FAIL
under this change. Allocation is unchanged between arms and `tools.ts` delivers the identical
8,282 chars in both — what changed is that an over-reserved incidental file now *delivers*
instead of being cut by the hard-ceiling truncation, which is what its previous PASS depended
on. Recorded as that fixture's `afterCG30` block. The over-reservation itself is epic CG-24's
subject; it should not be answered by loosening this bound.
