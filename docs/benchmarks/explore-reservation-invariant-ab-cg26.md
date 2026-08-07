# Agent A/B — the end-to-end reservation invariant (task CG-26)

**Date:** 2026-08-06 · **New:** `bugfix/CG-26` @ `7cbde95` · **Baseline:** `bugfix/CG-31` @ `c54e008` ·
**Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `--model sonnet --effort high`,
**both arms codegraph-on**, CLI blocked (0 contamination in every run),
`CODEGRAPH_NO_PROMPT_HOOK=1`. Every index measured on was **fully rebuilt**, never
incrementally synced (CG-33).

Baseline is the CG-31 tip, not `main`, so every number here isolates CG-26. Read the three
in sequence: `explore-oversize-member-ab-cg30.md` → `explore-displacement-guard-ab-cg31.md` →
this one.

**The invariant:** every admitted file receives at least its reservation before any file draws
on carry-forward slack. CG-30 bounded an oversize cluster member; CG-31 gave the cluster path a
displacement guard. This closes the three holes left over — and each one was starving a file that
had been admitted, reserved, and in the worst case *rendered*.

**Verdict: no behavioural regression on three repos, and the response is honest about its own
budget for the first time.** No repo truncates. No repo loses a file; okhttp gains one. Two repos
trade a few hundred source chars on their LAST-ranked file for the pointer list that names what
the response could not cover — bytes the CG-31 tip only had because it over-filled a ceiling it
mis-measured and then discarded the whole epilogue.

---

## The three holes

**1. The whole-file arms had no displacement guard.** The BUY arm's fit test read
`totalChars + fileContent.length + FILE_OVERHEAD <= renderCeiling` — room before the ceiling,
which belongs to every file the loop has not reached — while its own source-space sibling
(`owedBelow`) refused exactly that trade. GRACE was not fit-tested at all. Measured on okhttp:
`CallServerInterceptor.kt` shipped **8,499 chars against a 5,964 funded ceiling**, and the rank-6
file below it delivered nothing. Both arms now test the render they actually produce against
`fundedHeadroom`, and a whole render that does not fit **falls through to clustering** instead of
skipping the file — a clustered section traded for no section is the trade the funding pool exists
to refuse.

**2. Section overhead was charged at a flat 200 chars.** A real header — path plus up to
`maxSymbolsInFileHeader` symbol names — runs 300–500. Everything downstream is expressed in those
units (`headroom`, `fundedHeadroom`, every fit test), so the under-count was not a rounding error:
it funded promises out of bytes that did not exist. okhttp allocated **26,601 chars against a
24,400 ceiling** and the final truncation threw a fully-rendered section away. Sections are
charged their real cost now; `owedPayableBelow` holds back each pending file's reservation *plus a
per-file overhead estimated from that file's own symbols*; and a marginal overrun **trims the
weakest cluster** — or windows the last one into the room that is left — rather than skipping a
file over a ~300-char accounting difference.

**3. `owedPayableBelow` held all-or-nothing.** CG-31 was right that a promise the ceiling cannot
reach is not a claim on this file's bytes — but it dropped the *partial* case. When the last
admitted file's FULL reservation no longer fit, nothing at all was held for it. On the
precise-query fixture the rank-5 file took 4,134 chars against a 2,948 reservation while rank 6 —
admitted, reserved 2,539 — was left **4 chars** and skipped. It now holds the remainder, while
that remainder is still worth a section (`MIN_CHARS`).

## The epilogue, budgeted instead of discarded

CG-31 handed this forward: the loop reserved a flat **600** chars for an epilogue that measures
1,064 (gin), 1,788 (django), 2,231 (excalidraw), and four of six suite repos survived by
discarding the epilogue **whole** — shipping with no pointer list and no reminders at all. A
margin sweep was run and deliberately not shipped, because tuning one constant against the suite
is the trap CG-30's record warns about.

The fix is not a bigger constant. The epilogue is **two things**:

- a **floor** the render loop reserves, sized from the real strings: the one line that says an
  uncovered area exists and that another explore — not a Read — reaches it, plus a pointer for
  every file whose bytes were deliberately WITHHELD (a cliffed file's bytes were traded away on
  the promise that the agent can still name it — CG-12; if the ceiling eats that name the trade
  was a silent drop);
- an **elastic tail** — the rest of the pointer list and the reminders — fitted, in priority
  order and entry by entry, to the room that is actually left once the loop is done.

So a saturated response now lands with as much of its epilogue as it can pay for, instead of none
of it, and `renderCeiling` is `hardCeiling − floor` rather than `hardCeiling − 600`.

## Deterministic measurement — the primary evidence

Same clean-rebuilt index, same query, both builds. One `codegraph_explore` per repo.
Reproduce with `node scripts/agent-eval/probe-suite-envelope.mjs` (added by this task).

| repo | base source | new source | Δ | base files | new files | ceiling behaviour |
|---|---|---|---|---|---|---|
| django | 20,791 | **20,878** | +87 | 6 | 6 | was discarding its epilogue |
| tokio | 21,521 | **21,607** | +86 | 5 | 5 | was discarding its epilogue |
| okhttp | 19,034 | 18,870 | −164 | 5 | **6** | +1 file delivered; keeps its pointer list |
| excalidraw | 20,204 | 19,652 | −552 | 8 | 8 | keeps its pointer list |
| gin | 10,776 | 10,776 | 0 | 4 | 4 | byte-identical |
| alamofire | 11,662 | 11,662 | 0 | 2 | 2 | byte-identical |

Queries are the CG-30/CG-31 ones, unchanged.

**Read the two negatives honestly.** They are not starvation — they are the reverse. At the CG-31
tip both responses were *over-filled*: the loop under-counted its own section overhead, spent past
the render ceiling, and the hard-ceiling cut then took the epilogue away to pay for it. okhttp
also had a file rendered and dropped. Now the accounting is exact, so the loop stops where it
said it would, and the ~500 chars go to the pointer list naming the files the response could not
cover (2 on excalidraw, both `max-files` skips). No admitted file is starved in either.

**gin and alamofire are byte-identical between the builds** — neither saturates, so neither the
guard nor the epilogue fit engages. That is what a control should show.

**Fixtures.** `__tests__/explore-reservation-invariant.test.ts` (14 tests; **3 fail on the CG-31
tip**) pins the invariant on all three render paths and in both directions — the rank-#1 file when
files below it overspend, and an admitted lower-ranked file when the top one does — plus the two
things the ceiling must no longer do (allocate past itself; drop a rendered section) and the
concentration it must not flatten. `__tests__/explore-displacement-guard.test.ts` (CG-31, 11
tests) still passes unchanged.

**Allocation fixtures** — `scripts/agent-eval/allocation-fixtures.json`: **both PASS**. The
self-query gate changed shape and the reason is recorded in `afterCG26`: the envelope-denominated
`answerShareAtLeast` reads 47.5% here against 51.0% at the CG-31 tip while `tools.ts` delivers
**byte-identical** source in both arms. What moved is the denominator — the response now delivers
a fifth admitted file (`memory-budget.ts`, rank 4, paid its full 3,123-char reservation; the CG-31
tip rendered it and let the ceiling drop the section) and keeps epilogue prose it used to discard.
Both are the improvements this epic exists to make. The gate is now denominated in delivered
SOURCE, where the answer group reads 55.5%, and it passes on both arms.

## Agent runs

| | django new | django base | excalidraw new | excalidraw base | okhttp new | okhttp base |
|---|---|---|---|---|---|---|
| runs | 2 | 2 | 2 | 2 | 2 | 2 |
| duration (s) | **42** | 43 [36–50] | 53 [45–62] | 45 [37–54] | 49 [39–59] | 42 [32–52] |
| tool calls | 4 [3–4] | 4 [3–5] | **3** [2–4] | 5 [4–5] | 4 | 4 [3–5] |
| Read | **0** | 0 | **0** | 0 | **0** | 0 |
| Grep/Glob | 0 | 0 | 0 | 0 | 0 | 0 |
| codegraph calls | 3 [2–3] | 3 [2–3] | **3** [2–3] | 4 [3–4] | 3 | 3 [2–4] |
| occupancy share | **36.6%** | 37.6% | **38.2%** | 47.2% | 44.8% | 40.8% |
| allocation efficiency | **99.2%** | 94.7% | 81.9% | 82.5% | 75.8% | 87.6% |

Prompts are the deterministic queries with "Trace the flow end to end." appended.

**Read is 0 in all 12 runs, in both arms.** Sufficiency, pooled per call: **0 "Read a file we
returned" and 0 recall misses on every repo in both arms** — the responses that deliver a few
hundred fewer chars do not send the agent back to the file.

**Where the new arm looks worse, and why it is not read as a regression:**

- *okhttp allocation efficiency, 75.8% vs 87.6%, and occupancy 44.8% vs 40.8%.* The new arm's
  envelope is 99,411 chars against 89,297 — it returns one more file and more source overall, and
  the metric is the share of returned bytes the answer *cited*. Same trade the CG-31 record noted
  on this repo; the metric's own documentation says it is relative and must not be read as waste.
- *Duration on excalidraw and okhttp.* n=2 with fully overlapping ranges (45–62 vs 37–54;
  39–59 vs 32–52), on a machine also running the other arm's build. excalidraw's new arm does the
  same work in **3 tool calls against 5** and holds **9 points less context**.

## Residuals

None from this task. The render-loop budget is now exact end to end: `totalChars` counts
`flow.text`, the real per-section cost, and the epilogue floor; `allocatedChars ≤ hardCeiling` on
every suite repo; and the final section-boundary truncation is now unreachable in normal
operation (it stays as the backstop).

One thing deliberately NOT changed: the pointer list still caps at 10 files. Trimming happens
from the bottom of the rank order and the "+N more files" tail is rewritten to confess every entry
dropped, so the count is never silently wrong.
