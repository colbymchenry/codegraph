---
name: explore-overhaul-bench-2026-06-02
date: 2026-06-02 06:30
project: codegraph
branch: feat/explore-overhaul-store-coverage
summary: Finished the explore-overhaul arc (explore as sole primary + store coverage + overload disambiguation + method-atomic render + node file/line selector + explore reshaped to native-read windows) and validated it — all 7 README repos hit 0 Read/0 Grep at effort=high; only the README benchmark write-up remains.
---

# Handoff: explore-overhaul arc — validated 0-reads across all 7 README repos; README write-up is the last step

## Resume here — read this first
**Current state:** All code is committed + pushed on `feat/explore-overhaul-store-coverage` (4 commits, working tree clean). The why-Read agent sweep is DONE: **all 7 README repos × 4 runs = 28/28 runs hit 0 Read / 0 Grep on `--effort high`**, every run "codegraph was sufficient." WITH-`high` medians are captured (~59% fewer tool calls · 51% fewer tokens · ~15% cheaper · 0 reads vs the existing README WITHOUT) — the earlier cost REGRESSION (-3%) is recovered. The only open item is **updating the README benchmark section**, which is blocked on one methodology decision.
**Immediate next step:** Decide how to publish: (A) do a CLEAN both-arms run on `effort=high` with the PLAIN prompt (no why-Read) for an apples-to-apples table, or (B) write the WITH-`high` deltas in against the existing WITHOUT with a cross-effort caveat. Then edit `README.md` (benchmark table + per-repo breakdowns + average line + methodology date) and open the PR.

> Suggested next message: "Do the clean both-arms run on effort=high with the plain prompt for all 7 repos, then update the README benchmark table + per-repo breakdowns from those medians and open the PR."

## Goal
Make `codegraph_explore` a true Read-replacement — flow/architecture questions answered with ~0 Read/Grep — then re-validate the README benchmark on the current build and update its numbers. Definition of done: README benchmark reflects the current build with defensible (same-effort) numbers; branch merged via PR.

## Key findings
- **The arc (all shipped on the branch):** explore is the SOLE primary tool (`codegraph_context` + `codegraph_trace` removed in the prior session, this branch); store-action **coverage** (object-literal method extraction — a GENERAL AST rule in `tree-sitter.ts` `extractVariable`/`extractObjectLiteralFunctions`/`findInitializerReturnedObject`, covers Zustand/Redux/Pinia, not a per-lib hack); graph-ranking **gate fix** (a named/≥2-term file is never pruned); **`node` all-overloads + `file`/`line` selector**; **method-atomic render** (never half a method — drop whole methods/files); **explore reshape** to native-read windows.
- **Native-read ground truth (from the WITHOUT transcripts):** the agent natively reads **~6–9 files as ~100-line windows** (77% ranged, median 100 lines, 51–250 dominant), located by `func X(` signature greps. That's the unit explore now mimics.
- **Explore reshape (commit 50401a6, the latest mechanism):** `getExploreOutputBudget` caps EVERY tier at **~24K** (was 28/35/38K) + absolute **25K** hard ceiling (was 1.5×-of-budget) — because a bigger response gets **externalized** by the host to a file the agent Reads back (a 35K vscode explore did exactly that) AND costs cache-writes. Repo size scales the CALL budget, not the response. Per-file = one ~150–250 line window: per-symbol `bodyCap` 2×→1.5× and the spine is windowed too (so tokio's big-spine `worker.rs` doesn't starve `harness.rs`'s `poll`); central whole-file 4×→1.5× / 400→280 lines. Explore's named-symbol injection now uses **`cg.getNodesByName`** (direct index, not FTS) so a 50+-overload name (`poll`) surfaces the wanted def (`Harness::poll`) for the PascalCase-type-token bias to pick.
- **`node` file/line selector (commit 5bf6ad8):** `codegraph_node` takes optional `file`/`line` to pin an overload (the `file:line` a trail showed). `findSymbolMatches` (replaced `findSymbol`) enumerates ALL overloads via `cg.getNodesByName` (new passthrough `index.ts` → QueryBuilder), then file/line filters. The agent USES it in runs (`run file:worker.rs line:508`, `poll file:harness.rs`).
- **Cost regression was REAL, now recovered.** The pre-reshape n=4 benchmark (on `max` effort, bloated 35-42K explores) was **−3% cost avg** (vscode −52%) and reads were **NOT 0** (vscode 6,4,0,7; tokio 3,4,2,2) — which corrected my earlier n=2 "0 reads everywhere" optimism. The reshape (≤25K, no externalization) + 0 reads flipped cost back to **~15% cheaper**.

## Gotchas
- **STALE-DAEMON foot-gun:** before ANY agent eval, `pkill -f "serve --mcp"; rm -f <repo>/.codegraph/daemon.sock` so it serves the current `dist/`. `bench-why-repo.sh` does this per-run. A `npm run build` does NOT take effect until the daemon is killed.
- **Mac SLEEP corrupts long runs:** the first overnight re-bench (5h on `max`) was sleep-corrupted — the Mac napped 16–42 min BETWEEN runs (~3h of the 5h was paused), inflating wall-clock for the later repos. **Always wrap long runs in `caffeinate -dimsu`.** Cost/tokens/reads are sleep-INDEPENDENT (billed API totals), so the cost regression was real (confirmed on vscode which ran fully awake before any sleep); only TIME is corrupted.
- **`--effort` matters:** the user's Claude default is `max`, which is "too much." The eval is pinned to `--effort high` (levels: low/medium/high/xhigh/max). `bench-why-repo.sh` honors `EFFORT` (default `high`). The MAX-mode runs were discarded and redone on `high`.
- **why-Read prompt biases reads down (Hawthorne) + adds <0.3% to WITH cost/tokens.** So the 28/28 0-read sweep proves codegraph is *sufficient* (it CAN answer with 0 reads); it slightly understates a natural run's reads. Keep it OUT of any published benchmark numbers (use plain prompt for the table).
- **README methodology mismatch:** WITH numbers are `effort=high` + why-Read; the existing README WITHOUT is the user's OLD default effort + plain. Cross-effort → can't publish cleanly without same-effort both arms. The user does NOT want to re-run WITHOUT repeatedly, but the effort CHANGED, so a one-time WITHOUT-on-high is a new (justified) measurement.
- **PR policy:** `main` is REVIEW_REQUIRED — work on the branch, open a PR, `gh pr merge --squash --admin` for self-review. Branch + push only so far; **PR not opened** (user asked branch+push).

## How to test & validate
- Build: `npm run build` (exit 0). Full suite: `npx vitest run` → **1112 pass, 2 skip, 0 fail** (npm-shim network tests can flake offline — pre-existing).
- Affected tests: `npx vitest run __tests__/{explore-output-budget,adaptive-explore-sizing,context-ranking,explore-blast-radius,symbol-lookup,pr19-improvements,object-literal-methods}.test.ts`.
- Deterministic probe (current `dist/`, in-process — NOT the daemon): `node scripts/agent-eval/probe-explore.mjs /tmp/codegraph-corpus/<repo> "<query>"` → confirm ≤~25K chars + the flow files render. `node scripts/agent-eval/probe-node.mjs <repo> <symbol> code` (e.g. `poll file:harness.rs` via a small script).
- Agent why-Read sweep (the real metric): `EFFORT=high caffeinate -dimsu bash scripts/agent-eval/bench-why-repo.sh /tmp/codegraph-corpus/<repo> "<readme query>" 4` → parse `/tmp/ab-why/<repo>/with*.jsonl` for `Read`/`Grep` tool_use + the trailing `## Why I read` section.
- All 7 repos are cloned + indexed on the current build at `/tmp/codegraph-corpus/{vscode,excalidraw,django,tokio,okhttp,gin,alamofire}`. README queries are in `scripts/agent-eval/bench-readme.sh`.
- **Pass bar:** flow question → ~0 Read at the explore-call budget, faster than WITHOUT, no control regression.

## Repo state
- branch `feat/explore-overhaul-store-coverage`, last commit `9cf671a chore(agent-eval): add per-repo WITH-only why-Read benchmark harness`. Pushed, in sync with origin.
- 4 commits: `22333c1` (explore-primary + store coverage + overload disambiguation + docs) · `5bf6ad8` (method-atomic render + node file/line selector) · `50401a6` (explore reshape: inline-cap + concentrated flow-windows + direct-index injection) · `9cf671a` (why-Read eval harness).
- uncommitted: clean (only `.claude/handoffs/` scratch, intentionally not committed).
- CHANGELOG `[Unreleased]` already updated for the whole arc. README + CLAUDE.md + docs/design banners updated to drop removed context/trace.

## Open threads / TODO
- [ ] **README benchmark update** — decide (A) clean both-arms `effort=high` plain run vs (B) publish WITH-`high` deltas with caveat; then edit `README.md` (table + per-repo WITH/WITHOUT breakdowns + average + methodology date). WITH-`high` medians: vscode 4cg/742k/$0.70, excalidraw 6.5/834k/$0.74, django 3/509k/$0.59, tokio 6/921k/$0.77, okhttp 4.5/528k/$0.41, gin 4.5/573k/$0.48, alamofire 7.5/976k/$0.65 — all 0 reads.
- [ ] **Open the PR** (`gh pr create`) once the README is updated.
- [ ] Optional: delete dead dev probes `scripts/agent-eval/probe-{trace,context}.mjs` (their tools were removed; noted, not done).
- [ ] Memory `project_codegraph_read_displacement` is updated through the reshape; add the 28/28-on-high + cost-recovery result if you want it durable.

## Recent transcript (oldest → newest)
### Turn — "re-run the full benchmark to update README; ask why on reads"
- **Claude:** cloned+indexed all 7 repos; launched `RUNS=4 bench-readme.sh` (both arms). → ran overnight.
### Turn — "what's still running? 5h overnight"
- **Claude:** bench was on the LAST repo (alamofire), ~90%. n=4 aggregate showed **cost −3% (regression)** + reads **NOT 0** (vscode 6-7, tokio 2-4) — corrected my n=2 "0 everywhere." Diagnosed reads from transcripts: explore was 35-42K, too spread, dropped named flow methods.
### Turn — "is it the lock screen?"
- **Claude:** Yes for TIME (Mac slept 16-42min between runs → 5h mostly paused) but NOT cost (vscode ran awake; cost is billed API). → recommend `caffeinate`.
### Turn — "how do I stop Mac sleeping" → answered (Battery→Options / `caffeinate`).
### Turn — "do the queries WITHOUT codegraph, see exactly what it Reads, mimic it"
- **Claude:** characterized native reads (77% ranged, median 100 lines, signature greps) → spec: ~100-line flow-windows, ~6-9 files, ≤25K.
### Turn — "do it" (the reshape)
- **Claude:** `Edit(tools.ts)` → inline-cap 24K + concentrated windows + `getNodesByName` injection; updated budget tests; full suite green; probe vscode 35K→16K, tokio fits harness.rs. Committed `50401a6`, pushed.
### Turn — "why AST not LSP" (×2) + "reply to hd_nvim (ast-grep author)"
- **Claude:** explained the trade-off (breadth/speed/no-build/determinism/19-langs vs LSP type-precision-but-heavy); drafted the X reply (concede precision, reframe on goal/cost).
### Turn — "re-run, ask Why on each WITH read, report per repo" → "no WITHOUT" → "MAX too much, use high, start over"
- **Claude:** built `bench-why-repo.sh` (WITH-only, why-Read, `EFFORT` default high); ran all 7 on `high` one repo at a time, reporting each. **Result: 28/28 runs 0R/0G, all "sufficient."** Aggregated WITH-`high` medians → ~15% cheaper (regression recovered).
### Turn — "commit and push this"
- **Claude:** committed `bench-why-repo.sh` (`9cf671a`), pushed. → this handoff.
- **Outcome:** Arc complete + validated; README write-up + PR are all that remain.
