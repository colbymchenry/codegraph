---
name: explore-per-symbol-sizing
date: 2026-05-29 23:20
project: codegraph
branch: main
summary: Shipped per-symbol adaptive codegraph_explore sizing (PR #569) — show the answer (named methods + mechanism) in full, collapse redundant interchangeable siblings to signatures, keep named methods alive in non-sibling god-files; flipped Django/OkHttp from cost laggards to clear wins and lifted the README averages to 25%/57%/23%/62%.
---

# Handoff: per-symbol adaptive codegraph_explore sizing (shipped)

## Resume here — read this first
**Current state:** **DONE + shipped.** PR #569 squash-merged to `main` (`b026e64`); local is on `main`, `dist/` rebuilt, working tree clean. README benchmarks + averages + header, CHANGELOG, and `docs/design/adaptive-explore-sizing.md` all updated with the new full-7-repo sweep. The only loose end: **two squash-merged feature branches still linger** (`feat/adaptive-explore-sizing` from #564, `feat/explore-per-symbol-sizing` from #569) — local **and** remote — because squash-merges don't register as "merged" in git's ancestor sense.
**Immediate next step:** Delete those two merged branches (local + remote), or pick up one of the Open-threads frontiers (Gin's small WITH-cost bump, alamofire DataRequest residual, or stabilizing per-repo benchmark numbers with median-of-8).

> Suggested next message: "Delete the merged branches feat/adaptive-explore-sizing and feat/explore-per-symbol-sizing — local and remote."

## Goal
Make `codegraph_explore`'s cost a clear win on **every** README benchmark repo, especially the two laggards the README showed thinnest (Django 9% cheaper, OkHttp 4%). The optimization target per CLAUDE.md is **tool-calls/reads + latency** (NOT raw cost) — but the user explicitly wanted the cost margins up too. Definition of done = both laggards clearly cheaper with ~0 reads, no regression elsewhere, README refreshed, shipped. **Achieved.**

## Key findings
- **The feature, in `src/mcp/tools.ts` (`handleExplore` + `buildFlowFromNamedSymbols`):** explore sizes output to the *answer*, not the file count. Builds on PR #564's gate (off-spine + polymorphic-sibling, with a named-callable *spare* + supertype-family *override*).
- **PR #569 added four things** (all in `tools.ts`):
  1. **Uniqueness-aware spare** — `buildFlowFromNamedSymbols` now returns `uniqueNamedNodeIds` (callables whose token had ≤3 defs). The whole-file spare uses it, so `as_sql` (110 defs) no longer keeps every Compiler/Expression variant full; `getResponseWithInterceptorChain` (1 def) still spares RealCall.
  2. **Per-symbol focused view** — a collapsed family file renders FULL bodies for symbols with `prio()` < 99 (on-spine=0, unique-named=1, `fileDefinesSuper && named`=2), signatures for the rest. Bounded: `bodyCap = maxCharsPerFile*2`, `SIG_MAX = max(12, maxSymbolsInFileHeader*2)`. Header tag flips to `· focused (…)` when any body shown, else `· skeleton (…)`.
  3. **All-tier test-file exclusion** — removed the `budget.excludeLowValueFiles` gate on the `isLowValue` hard-exclude (was <500-file tiers only); guards (query-mentions-tests, ≥2 non-test remain) kept.
  4. **Named-cluster survival in non-sibling god-files** — inject agent-named method defs into `rangeNodes` even if the gather missed them; rank named ranges at importance **9** (above glue 6 / connected 3); `fileBudget = min(maxCharsPerFile, maxOutputChars - totalChars - 200)` in cluster selection so high-importance named clusters survive instead of being source-order-trimmed.
- **Validated (headless A/B, Opus 4.8, median of 4, full 7-repo sweep) — now in README:** avg **25% cheaper · 57% fewer tokens · 23% faster · 62% fewer tool calls** (was 22/47/20/50). Per-repo cost: VS Code 33, Excalidraw 27, Django **23** (was 9, median 0 reads), Tokio 35, OkHttp **11** (was 4, 0 RealCall read-backs), Gin 15, Alamofire 28.
- **PR #564 (already merged, `f1b14f0`)** was the prior round: named-callable spare + supertype-family override (fixed the read-back regression where RealCall.kt / compiler.py were skeletonized then Read back).

## Gotchas
- **A/B per-repo variance is large (±~10–13 pts).** The WITHOUT arm swings run-to-run (how hard native greps). Excalidraw/Gin look *lower* than the prior README purely from a cheaper native baseline this batch — NOT regressions (reads still 0/low). **Averages are the stable signal.** Never conclude from n=1; the README is median-of-4.
- **The alamofire `DataRequest` residual is NOT cleanly closable.** A "spare a file when the agent names its class" type-spare *broke OkHttp* (it spared all 5 interceptor classes → 0 skeletons). A named sibling class is structurally indistinguishable from "the one main type." Left as-is (alamofire is 28% cheaper; ~1 DataRequest read/run).
- **Gin's WITH-cost ticked up ($0.36→$0.48 across batches)** — partly the named-injection adding content to an already-0-read repo. Still 15% cheaper. Possible over-eager named-injection on small repos.
- **Validate retrieval changes with a real-agent A/B, not just the probe.** The deterministic `probe-explore.mjs` query forms a *different spine* than the agent's real query → it hid both the Django and the OkHttp read-backs. (Dead-end #6 in the design doc.)
- **Always `npm run build` before probing/A/B** — probes + the A/B MCP server load `dist/`, not `src/`. Corpus indexes (`/tmp/codegraph-corpus/*`) are valid without re-index since all changes are query-time.
- **`adaptive-sizing-skeletonizing.md` handoff is gone from `main`'s working dir** — it was untracked, got swept into commit `3c38729` on `feat/adaptive-explore-sizing`, so it lives only on that branch now. Deleting that branch deletes it (it's obsolete — that work shipped).
- **5 `npm-shim` test failures are pre-existing/network** (lack `--probe-net` on the global binary) — not a regression; don't let them block.

## How to test & validate
- Build first: `npm run build` (must be green).
- Deterministic probe: `node scripts/agent-eval/probe-explore.mjs /tmp/codegraph-corpus/<repo> "<symbol-bag query>"` → inspect `#### file — … · focused/skeleton` headers + sizes. okhttp = 5 `· skeleton`; django compiler.py `· focused` with `def execute_sql`/`def as_sql`/`def _fetch_all` bodies present; excalidraw/tokio/vscode/gin = 0 skeleton/focused (inert).
- A/B one repo: `bash /tmp/ab-one.sh <repo> <runs> "<question>"` → writes `/tmp/ab-readme/<repo>/run<n>/`. Aggregate one repo: `node /tmp/one-agg.mjs <repo>`. Full 7: `RUNS=4 bash scripts/agent-eval/bench-readme.sh` then `node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme` (averages) + `node /tmp/full-agg.mjs` (per-repo reads/grep/tools/cost/time).
- Unit: `npx vitest run __tests__/adaptive-explore-sizing.test.ts` → **8/8** (skeleton, named-callable spare=RealCall, supertype-family override→focused=codec.ts, uniqueness/shared-method, on-spine exemplar full, distinct step full, flag=0 disables).
- **Methodology:** a real win = cost DOWN **and** reads NOT up vs the same build's WITHOUT arm; confirm inert repos stay 0 skeleton/focused (the change only *adds* spare conditions + per-symbol rendering of already-collapsed files → strict subset of the original gate).

## Repo state
- branch `main`, last commit `b026e64 feat(mcp): per-symbol adaptive codegraph_explore sizing (#569)`.
- uncommitted: clean (this handoff file will be a new untracked `.claude/handoffs/` entry).
- merged-but-undeleted branches: `feat/adaptive-explore-sizing` (#564) + `feat/explore-per-symbol-sizing` (#569), both local + remote.

## Open threads / TODO
- [ ] Delete the two squash-merged branches (local + remote): `feat/adaptive-explore-sizing`, `feat/explore-per-symbol-sizing`.
- [ ] (optional) Stabilize the README per-repo numbers with a 2nd full-7 batch → publish median-of-8 (smooths the WITHOUT-arm variance that makes Excalidraw/Gin look lower).
- [ ] (frontier) Gin's small WITH-cost bump from named-injection on an already-0-read repo — consider gating named-injection by repo size / whether reads were happening.
- [ ] (frontier) Alamofire `DataRequest` ~1 read/run — only closable by distinguishing "main type" from "interchangeable sibling," which has no clean static signal (don't re-attempt the type-spare; it breaks okhttp).
- [ ] (frontier) Big non-sibling god-file clustering generally (#185 family) — `query.py`/`Session.swift`-style files; the fileBudget fix helped Django but the merge/selection logic is still the lever for other repos.

## Recent transcript (oldest → newest)
### Turn — "Add the regression test for the skeletonization"
- **Claude:** Wrote `__tests__/adaptive-explore-sizing.test.ts` (OkHttp-in-miniature fixture); validated via probe; 5 cases. (This was for PR #564's gate.)
- **Outcome:** Test landed; led into re-validating the README.
### Turn — re-validate README, found Django/OkHttp cost laggards → built fixes
- **Claude:** A/B sweeps via `bench-readme.sh`; diagnosed read-backs (RealCall via `Lockable` 9-impl mixin; compiler.py base+subclasses). Shipped PR #564 (named-callable spare + supertype-family override). Then A+B+C (uniqueness + per-symbol focused + test exclusion).
- **Outcome:** Django/OkHttp flipped to wins; alamofire type-spare attempt broke okhttp → reverted.
### Turn — "Pursue the deeper Django fix"
- **Claude:** Cluster-debug showed `_fetch_all` (L2237) never formed a cluster + got source-order-trimmed. Fixed via named-injection + importance 9 + `fileBudget`. A/B: Django reads tail 3→1, 11%→17%; controls (okhttp 14%, excalidraw 31% / 0 reads) held. Committed `e71eb90`.
- **Outcome:** Django residual closed.
### Turn — "push + PR + squash-merge, update README incl. averages + header"
- **Claude:** Ran final full-7 sweep (`bench-readme.sh`, 56/56). Clarified a confusing "WITHOUT got cheaper" phrasing (WITH cg is cheaper in all 7; the % is the *gap*, which shrinks when the native baseline is cheap that batch). User said publish this batch.
- **Outcome:** Updated README (headline 25%/62%, average line, 7 summary rows, 7 detail tables, methodology date) + CHANGELOG + design doc. Built clean branch off `origin/main` (dropping the already-squashed commits + the handoff artifact), pushed, opened PR #569, squash-merged → `b026e64`. Synced local to main, rebuilt dist. Offered branch cleanup → user ran `/handoff save`.
