# Deterministic measurement — cluster starvation inside one file (task CG-36)

**Date:** 2026-08-06 · **Baseline:** `feature/CG-24` @ `76ab1fe` (the CG-24 epic tip) ·
**Harness:** `scripts/agent-eval/probe-file-spend.mjs` and `probe-suite-envelope.mjs` over the
deterministic 6-repo corpus at `/tmp/codegraph-corpus`, clean full-rebuilt indexes (CG-33), plus
two hermetic fixtures through `probe-allocation.mjs`. No agent A/B: the claim is which bytes go
to which file, and the agent runs are far too noisy to see a 2K shift.

**Verdict: the defect is real, the diagnosis in the issue was half wrong, and the fix holds.**
All 8 starvation flags across the suite clear; net **+1,012 source chars**. One repo (okhttp)
trades its weakest file for +7,196 chars in the two that answer the question — stated in full
below rather than smoothed over.

---

## The defect

A file's ranked clusters were all-or-nothing past the first one. The top-ranked cluster was
always taken — shrunk to the highest-importance whole symbol ranges that fit when it overran —
and every cluster below it was rendered **whole** and then either fit the remainder or was
dropped entirely. On a file whose top-ranked cluster is trivial, that discards the answer.

What made it invisible: the response stays FULL. The unspent reservation carries forward exactly
as CG-31 designed, so a lower-scoring file takes the bytes and every envelope-share measure still
reads healthy. Measured on the epic tip:

| repo | file | score | reserved | spent | share |
|---|---|---|---|---|---|
| django | `db/models/sql/query.py` | 83 | 7,947 | 1,923 | **24%** |
| django | `contrib/admin/filters.py` | 18 | 2,271 | 8,057 | **355%** |
| okhttp | `.../RealInterceptorChain.kt` | 86 | 6,058 | 1,474 | **24%** |
| okhttp | `.../CallServerInterceptor.kt` | 20 | 1,974 | 5,832 | **295%** |

A score-83 file spends a quarter of its reservation while a score-18 file takes 3.5× its own.

## What the issue got wrong

The issue named two candidate fix points and suspected the first: cluster ranking breaks ties on
**density** (`score / span`) after `hasSpine` → `maxImportance`, which structurally favours a
small trivial cluster over a large answer-bearing one. Dumping the cluster set says otherwise —
in **both** real cases the loser lost on `maxImportance`, not on density:

```
django/db/models/sql/query.py   budget 10,135   spent 1,923
  KEPT    1379–1400   span   22   score  14   maxImp 6   (check_related_objects — a glue symbol)
  DROPPED  306– 929   span  624   score 290   maxImp 3   (133 members: the whole Query class)

okhttp .../RealInterceptorChain.kt   budget 6,058   spent 1,474
  KEPT      16–  44   span   29   score  44   maxImp 6   (package decl + import block)
  DROPPED  113– 373   span  261   score 171   maxImp 3   (73 members: the chain itself)
```

`maxImportance` first is deliberate and protective — it is what stops Alamofire's `Session.swift`
from losing its budget to the top-of-file property list — so **ranking was not touched**. The
lever is the second fix point: stop dropping the loser whole.

## The change

Two sites, one rule — *hold the remainder while it is still worth a section*, which is CG-26's
between-FILES lesson applied between CLUSTERS.

1. **Selection.** A later cluster is now shrunk into what is left of the file's budget, by the
   same whole-member rule the first cluster already used. Below `MIN_CHARS` (700) the remainder
   cannot hold a readable block, so it stays a drop rather than a stutter of fragments the next
   call's dedup has to shred around. The never-empty windowing floors may overrun that room; the
   first cluster is allowed that overshoot, a later one is not.
2. **The ceiling trim.** When the exact section cost overruns `renderCeiling`, the weakest chosen
   cluster is re-rendered into the room that remains before being dropped. This one is worth
   naming on its own: on excalidraw's `typeChecks.ts` the section-cost estimate missed by
   **13 chars** and a 1,512-char cluster — the file's highest-*scoring* one, last in rank order
   only because rank breaks ties on density — was thrown away to pay for it. Recovered 1,501 of
   excalidraw's 1,449-char loss.

## Suite result

`node scripts/agent-eval/probe-file-spend.mjs`, 6 repos, clean rebuilds. Only files whose spend
moved are listed; score is the candidate's ranking score, reserved its allocation.

| repo | file | score | reserved | before | after |
|---|---|---|---|---|---|
| django | `db/models/sql/query.py` | 83 | 7,947 | 1,923 | **10,082** |
| django | `contrib/admin/filters.py` | 18 | 2,271 | 8,057 | 2,198 |
| django | `utils/autoreload.py` | 12 | 1,747 | 3,145 | 1,709 |
| django | `db/models/fields/related_descriptors.py` | 11 | 1,660 | 2,516 | 1,493 |
| excalidraw | `element/src/typeChecks.ts` | 23 | 2,740 | 3,102 | 2,573 |
| excalidraw | `excalidraw/types.ts` | 14 | 1,942 | 819 | 1,372 |
| okhttp | `.../RealInterceptorChain.kt` | 86 | 6,058 | 1,474 | **6,038** |
| okhttp | `.../Interceptor.kt` | 64 | 4,697 | 2,027 | **4,659** |
| okhttp | `.../RealCall.kt` | 52 | 3,972 | 3,628 | 3,922 |
| okhttp | `.../Call.kt` | 54 | 4,097 | 4,097 | 2,073 |
| okhttp | `.../CallServerInterceptor.kt` | 20 | 1,974 | 5,832 | 1,959 |
| okhttp | `androidMain/.../AndroidDns.kt` | 21 | 1,999 | 1,812 | **0** |
| tokio | `task/local.rs` | 40 | 4,361 | 4,599 | 4,798 |
| tokio | `runtime/task/harness.rs` | 14 | 1,981 | 2,565 | 2,341 |
| gin | `routergroup.go` | 87 | 5,782 | 3,273 | **5,632** |
| gin | `tree.go` | 17 | 1,693 | 892 | 1,969 |
| gin | `ginS/gins.go` | 26 | 2,213 | 4,431 | 2,171 |
| alamofire | `Source/Core/Session.swift` | 34 | 2,792 | 2,797 | 3,396 |
| alamofire | `Source/Core/Request.swift` | 148 | 9,100 | 8,865 | 8,453 |

Bytes move up the score order in every repo. Envelope totals:

| repo | source before | after | Δ | files | ceiling |
|---|---|---|---|---|---|
| django | 20,878 | 20,719 | −159 | 6 → 6 | 24,963 ≤ 25,000 |
| excalidraw | 19,652 | 19,704 | +52 | 8 → 8 | 24,813 ≤ 25,000 |
| okhttp | 18,870 | 18,651 | −219 | 6 → **5** | 24,985 ≤ 25,000 |
| tokio | 21,607 | 21,582 | −25 | 5 → 5 | 24,777 ≤ 25,000 |
| gin | 10,776 | 11,952 | **+1,176** | 4 → 4 | 14,655 ≤ 19,500 |
| alamofire | 11,662 | 11,849 | +187 | 2 → 2 | 12,862 ≤ 19,500 |
| **total** | **103,445** | **104,457** | **+1,012** | | |

Starvation flags: **8 → 0**.

## The one cost, stated plainly

okhttp drops its rank-6 file, `androidMain/.../AndroidDns.kt` (score 21, a platform DNS helper on
a question about the interceptor chain), and 219 source chars, in exchange for +4,564 to
`RealInterceptorChain.kt` and +2,632 to `Interceptor.kt` — the two files that answer the question.

This is not a new defect and it is not the fix over-reaching. okhttp's reservations are
**structurally over-subscribed**: the allocator splits `maxOutputChars` charging a flat
`FILE_OVERHEAD` of 200 per file while a real header runs 300–500, so the sum of promises
(~22,800 source + ~2,100 of real headers) exceeds what the ~24,760-char render ceiling can hold.
`owedPayableBelow` already refuses to hold bytes back for a file it can see will be dropped, and
AndroidDns.kt is the file past that line. On the epic tip it survived only because the files above
it under-spent — by luck, not by design. Closing the over-subscription means charging the
allocator per-file header estimates rather than the flat 200; that is a wider change than this
issue, and CG-26 deliberately kept `FILE_OVERHEAD` as the allocator's own constant.

## What did NOT change

- **Cluster ranking.** `hasSpine` → `maxImportance` → density → score → span, untouched.
- **Alamofire `Session.swift`.** The shape density-first exists for; it *gains* 599 chars.
- **The factory-closure outcome (CG-27).** `probe-factory-closure.mjs`: 7 of 11 inner closure
  definitions delivered, identical to the epic tip.
- **The reservation invariant (CG-31/CG-26).** `explore-reservation-invariant.test.ts` green;
  every repo stays at or under its hard ceiling.
- **All four allocation fixtures pass** — `payroll-go`, `self-query`, and the two added here.

## What ships so this stays measurable

- `scripts/agent-eval/probe-file-spend.mjs` — the standing per-file reservation-vs-delivered
  sweep. It flags a **pair**, never a single file: a large share unspent *while* a materially
  lower-scoring file overspends. Either alone is legitimate (a small file has less to say;
  carry-forward is the mechanism that hands its slack down), which is why the envelope probe
  could never see this. Exit code 1 on any flag, so it gates.
- `__tests__/fixtures/starved-cluster-ts/` — django's and okhttp's shape reduced to a fixture.
  Fails on the epic tip (28.8% of reservation, neither `proceed` nor `writeAndRead` delivered),
  passes with the fix.
- `__tests__/fixtures/dense-header-ts/` — the `Session.swift` shape, byte-identical on both
  builds. The counterweight: it fails if a future change lets density outrank importance again.
- `spendShareAtLeast` in `probe-allocation.mjs`, and `__tests__/explore-cluster-starvation.test.ts`
  pinning both fixtures in `npm test`.

## Method note

None of this is visible in the rendered markdown. To see it you must dump the cluster set —
patch `dist/mcp/tools.js` just before `let assembled = assembleSection(chosenIndices);` and log
`fileBudget` / `projectedChars` / each ranked cluster's span, score, `maxImportance`, chosen flag
and members. Reading only the response makes member-selection effects look like budget effects.
Equally, a source-chars diff between builds is not automatically a regression: excalidraw's
−1,449 on the first cut was the elastic epilogue expanding into room a 13-char accounting error
had released, not source lost to allocation.
