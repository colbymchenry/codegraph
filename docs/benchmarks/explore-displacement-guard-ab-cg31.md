# Agent A/B — cluster-path displacement guard (task CG-31)

**Date:** 2026-08-06 · **New:** `bugfix/CG-31` · **Baseline:** `bugfix/CG-30` @ `0d014a6` ·
**Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `--model sonnet --effort high`,
**both arms codegraph-on**, CLI blocked (0 contamination in every run),
`CODEGRAPH_NO_PROMPT_HOOK=1`. Every index measured on was **fully rebuilt**, never
incrementally synced (CG-33).

Baseline is the CG-30 tip, not `main`, so every number here isolates CG-31. CG-30's own A/B
against `main` is `explore-oversize-member-ab-cg30.md`; read them in sequence for the combined
picture the two issues asked for.

CG-31 stops a clustered render from spending a reservation still owed to a file the render loop
has not reached. The whole-file BUY arm has always refused that trade (`owedBelow`); the cluster
path read what was left before the hard ceiling instead of what was still promised.

**Verdict: no regression, and this one is a straight win on both halves.** Four of six suite
repos deliver MORE source and one more file each; the other two are byte-identical. The agent
runs are faster in all three repos measured, with Read at or below baseline.

---

## The two corrections the measurement forced

Worth recording, because the first version of the guard was **wrong in the direction the guard
itself is about**, and only a suite measurement showed it.

**1. Holding back the full owed sum was too much.** The allocator splits the envelope; the render
loop spends against a ceiling that also has to hold the response's own prose, so on a saturated
response the promises are over-subscribed and the tail is going to be dropped whatever happens
above it. Bytes held for a file that is then dropped are bytes nobody receives. Measured: django
−2,319 source, tokio −1,298, both handed to a section the ceiling threw away.
`owedPayableBelow` now holds back only the prefix of what is owed below that the response can
still pay, in rank order.

**2. The final truncation was eating the guard's work.** It cut at the last file-section header,
which drops that whole section *and* the trailing notes. Dropping the notes alone is almost
always enough. The epilogue is a pointer list and two reminders; a section is source the agent
otherwise has to Read. Cutting the epilogue first is what turned the remaining deficits into
gains — and it is the same starvation CG-31 is about, arriving one layer below the guard.

A third, smaller fix: `flow.text` is prepended to `lines` to make the final output but was never
counted in `totalChars`, so the render loop spent against a ceiling it was ~2K under on
symbol-bag queries.

## Deterministic measurement — the primary evidence

Same clean-rebuilt index, same query, both builds. One `codegraph_explore` per repo.

| repo | base source | new source | Δ | base files | new files |
|---|---|---|---|---|---|
| django | 20,033 | **20,791** | +758 | 5 (truncated) | **6** |
| excalidraw | 18,776 | **20,204** | +1,428 | 7 (truncated) | **8** |
| okhttp | 15,628 | **19,034** | +3,406 | 4 (truncated) | **5** |
| tokio | 20,340 | **21,521** | +1,181 | 4 (truncated) | **5** |
| gin | 10,776 | 10,776 | 0 | 4 | 4 |
| alamofire | 11,662 | 11,662 | 0 | 2 | 2 |

Queries: django "How does a QuerySet turn into SQL and fetch rows from the database?";
excalidraw "How does updating an element re-render the canvas on screen?"; gin "How does a
registered route handler get invoked for an incoming HTTP request?"; alamofire "How does a
request get built and sent through the session?"; okhttp "How does a call go through the
interceptor chain to the network?"; tokio "How does a spawned task get scheduled and run by a
worker?".

No repo delivers less. **Four of six stopped truncating**, which is where the extra file comes
from: each of those responses had been throwing a fully-rendered section away.

**gin and alamofire are byte-identical between the builds** — nothing in them is oversize enough
for the guard to engage and neither response was truncated. That is what a control should show,
and it means every gin number in the agent table below is run-to-run variance.

**Fixture** — `__tests__/fixtures/displacement-ts`, four pipeline stages competing for one
envelope, the first a single ~20K function. Padded past 500 indexed files on purpose: the
displacement only exists on the 24K tier, where the reservations plus the preamble genuinely
saturate the render ceiling.

| | baseline | new |
|---|---|---|
| `ingest.ts` | 9,301 chars on a 6,289 spendable, then **dropped whole** by the ceiling — 0 delivered | 4,851, bounded |
| `types.ts` / `sink.ts` | skipped `budget-whole-file` | delivered |
| admitted files delivered | **3 of 6** | **6 of 6** |
| envelope | 14,908 | 22,066 |

Pinned by `__tests__/explore-displacement-guard.test.ts` (11 tests; 3 fail on the baseline).

**Allocation fixtures** — `scripts/agent-eval/allocation-fixtures.json` flips back to
**BOTH PASS**. Its `afterCG30` verdict blamed an over-RESERVED incidental file; the reservation
is identical in both arms — the file was over-SPENDING, which is exactly this defect. Recorded
honestly in `afterCG31`.

## Agent runs

| | django new | django base | okhttp new | okhttp base | gin new | gin base |
|---|---|---|---|---|---|---|
| runs | 3 | 3 | 2 | 2 | 2 | 2 |
| duration (s) | **36** [33–51] | 46 [35–49] | **42** [40–44] | 52 [50–53] | **33** [31–35] | 39 |
| tool calls | 3 [3–4] | 3 [3–4] | **4** [3–4] | 5 [4–5] | **4** [3–4] | 5 [4–5] |
| Read | 0 [0–1] | 0 | **0** | 1 [0–2] | 1 [0–1] | 1 [0–2] |
| Grep/Glob | 0 | 0 | 0 | 0 | 0 | 0 |
| codegraph calls | 2 | 2 [2–3] | 3 [2–3] | 3 [2–3] | 2 | 3 [2–3] |
| occupancy share | **32.1%** [31.1%–36.1%] | 33.8% [28.7%–42.1%] | **40.0%** [36.6%–43.3%] | 40.8% [40.3%–41.4%] | **29.7%** [28.3%–31.1%] | 33.5% [29.8%–37.2%] |
| allocation efficiency | 96.8% | 98.9% | 88.2% | 97.2% | **91.2%** | 85.0% |

Prompts are the deterministic queries above with "Trace the flow end to end." appended.

**Sufficiency, pooled per call.** okhttp: **0** "Read a file we returned" in 5 against the
baseline's 1 in 5 — the arm that returns 3,406 more chars needs fewer follow-up Reads, which is
the mechanism working. django: 1 in 6 against 0 in 7. gin: 1 in 4 against 1 in 5, on a repo where
the builds emit identical bytes. Neither arm produced a single recall miss (a Read of a file we
did NOT return, or a Grep) on any repo.

**Where the new arm looks worse, and why it is not read as a regression:**

- *okhttp allocation efficiency, 88.2% vs 97.2%.* The new arm's envelope is 85,197 chars against
  the baseline's 66,014 — it returns substantially more source, and the metric is the share of
  returned bytes the answer *cited*. A larger, more complete response with a smaller cited share
  and Read driven to 0 is the trade this tool exists to make. The metric's own documentation says
  it is relative and must not be read as waste.
- *django, 1 allocation miss in 6 answered calls against 0 in 7.* One run, n=3, and django is the
  repo whose duration range overlaps most (33–51 vs 35–49).

## Residual carried forward — for CG-26

Four repos stopped truncating; **okhttp, django, excalidraw and tokio now land at 24,758–24,998
chars against a 25,000 hard ceiling.** That is deliberate (the ceiling exists so the host never
externalizes the result) but it means the render loop's 600-char margin for the epilogue is still
wrong — the epilogue measures 1,064 (gin), 1,788 (django), 2,231 (excalidraw). The response now
survives that by dropping the epilogue rather than a section, which is strictly better, but the
honest fix is for the loop to budget for the epilogue in the first place.

A margin sweep was run and deliberately **not** shipped: at 1,200 django stops truncating on its
own but tokio loses 286 chars; at 2,400 django loses 1,895. Tuning one constant against the suite
is the trap CG-30's own record warns about. Sizing the margin from the epilogue the response is
actually going to emit is the real fix and belongs with the end-to-end reservation invariant.

Second residual: the whole-file BUY arm's fit test (`totalChars + fileContent.length +
FILE_OVERHEAD <= renderCeiling`) has no `owedBelow` term of its own — its displacement guard is
source-space only. It was left alone here to keep this change attributable; the epilogue-first cut
removes the failure mode it would have caused.
