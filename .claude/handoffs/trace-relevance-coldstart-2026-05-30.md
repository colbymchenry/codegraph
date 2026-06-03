---
name: trace-relevance-coldstart-2026-05-30
date: 2026-05-30 23:30
project: codegraph
branch: feat/trace-relevance-closure-collection
summary: Turned Alamofire (README's weakest repo) into a clean win via a trace endpoint-disambiguation fix + god-file explore rendering, then eliminated the MCP cold-start race that was causing benchmark inconsistency (handshake ~811ms→~90ms); PR #580 has 6 commits, all that's left is a clean README sweep + squash-merge.
---

# Handoff: trace-relevance + closure-collection + cold-start (PR #580)

## Resume here — read this first
**Current state:** PR #580 (branch `feat/trace-relevance-closure-collection`, 6 commits, pushed, in sync with remote) is feature-complete and validated — full suite 1090 pass (only the 5 pre-existing npm-shim network fails), 28/28 MCP+daemon tests. The MCP cold-start race (the dominant benchmark-inconsistency source) is ELIMINATED via the proxy-local-handshake (tool registration ~90ms cold+warm, was ~811ms). The README benchmark table still shows the OLD pre-fix numbers.
**Immediate next step:** Run a median-of-4 README sweep on this build (the race is gone, so numbers should be naturally consistent), update the README table/averages/headline, then squash-merge PR #580.

> Suggested next message: "Run `RUNS=4 bash scripts/agent-eval/bench-readme.sh` on this build, parse with `node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme` (race-aware), update the README benchmark table + averages + the 7 per-repo detail tables + methodology date, then squash-merge PR #580 with `gh pr merge 580 --squash --admin`."

## Goal
Started as "Alamofire is the README's weakest benchmark repo (13% fewer tool calls vs the ~62% average) — fix it." Became: make CodeGraph's retrieval **consistent and faster**. Definition of done = PR #580 merged (trace fix + dynamic-dispatch coverage + god-file rendering + cold-start elimination), README refreshed with stable median-of-4 numbers. Optimization target per CLAUDE.md is **tool-calls/reads + latency**, NOT raw cost.

## Key findings
The 6 commits on the branch (oldest→newest):
- `e86d573` **Trace endpoint relevance** (THE Alamofire win) + closure-collection synthesizer + explore synth-links.
- `c64c4b3` **God-file multi-phase explore rendering** (6 sub-layers).
- `5d7388c` Skeleton/focused tag steers to `codegraph_explore`, not Read (spiral fix #1).
- `dc19eab` Bench parser race-aware (excludes "No such tool available" runs).
- `91e28df` serve --mcp cold-start ~811ms→~600ms (defer CodeGraph load + 25ms poll).
- `82ae484` **Proxy-local-handshake** — handshake ~600ms→~90ms, cold-start race eliminated.

Root-causes found by reading A/B TRANSCRIPTS (not the noisy median):
- **Trace bug:** `handleTrace`'s `scorePair` ranked only by shared-dir-prefix, so overloaded names (`request`=44 defs, `task`=8) resolved to empty `EventMonitor.request(){}` / `RedirectHandler.task` STUBS over the real `Session.request` → agent saw garbage, said "the trace collided with same-named symbols", read by hand. Fix: `nodeRelevance` term in `handleTrace` (penalize ≤1-line stubs −40, test files −150). Result n=8: WITH tools 12→8 median, read variance 0–12→1–4 (the meltdowns WERE the trace-collision flounder). General bug (Swift/Java/C#/Go protocol-stub flooding).
- **Closure-collection synthesizer** (`src/resolution/callback-synthesizer.ts` `closureCollectionEdges`): Swift `validators.write{$0.append}`…`didCompleteTask` `validators.forEach{$0()}`. The element-invoke `$0(`/`it(` is the precision gate → 9 edges on Alamofire, **0 on every non-Swift control**. Surfaced inline in trace + a "Dynamic-dispatch links" section in `buildFlowFromNamedSymbols` (so it shows when the agent named only `validate`, not `didCompleteTask`).
- **God-file rendering** (`handleExplore` in `src/mcp/tools.ts`, 6 layers): (1) on-spine god-files render spine-full + off-path methods as signatures (true-spine); (2) named-seed gather — inject each named token's substantive def into the subgraph (FTS buried `validate` → Validation.swift was never gathered); (3) a file that DEFINES a named symbol scores +50 (beats incidental Combine.swift's +23 connected-node score); (4) the 90%-budget early-break and (5) the total-output cap both EXEMPT necessary (entry/spine/uniqueNamed) files; (6) final ceiling 1.5×maxOutputChars. Renders build+validators-exec+validate in ONE explore.
- **Spiral cause #1 (fixed):** the skeleton tag said "Read for a full body" → agent Read the skeletonized central files → over-investigation spiral. Now steers to `codegraph_explore`.
- **Spiral cause #2 / the BIG inconsistency (fixed):** MCP **cold-start race**. `serve --mcp` wasn't ready when the headless agent fired → "No such tool available" → grep/Read flounder (19–30 tool spirals). Root-caused: NOT module load (mcp/index 38ms, CodeGraph chain 30ms), NOT the `--liftoff-only` re-exec (NO_RELAUNCH ≈ same) — it's the proxy WAITING for the spawned daemon to bind. Fixed: proxy answers initialize/tools-list from STATIC constants (`runLocalHandshakeProxy` in `proxy.ts`), forwards tool CALLS to the daemon (connected in background), lazy in-process engine fallback preserves the old fall-back-to-direct robustness. `connectWithHello` distinguishes 'version-mismatch' (fail fast → local) from 'not-yet' (poll). Handshake 91ms cold / 88ms warm.

## Gotchas
- **A/B variance is HUGE — never conclude from n=1, or even one n=4 batch.** The median-of-4 caught regressions the lucky dedicated batches HID (the god-file rework looked great in one batch at 0.5 reads/5.5 tools; the median showed 13 tools dragged by 2 spirals). Report ranges.
- **Kill stale daemons before any cold-start measurement:** `pkill -9 -f "dist/bin/codegraph.js"; rm -f /tmp/codegraph-corpus/<repo>/.codegraph/daemon.*`. A zombie daemon holding the lock causes a 6s retry-exhaust that looks like a 7× regression (it bit me — the "6239ms" false alarm).
- **`timeout` is NOT on macOS** (no coreutils) — measure cold-start with a `node` spawn + a `setTimeout` kill-timer (see the transcript's measurement snippets).
- Corpus repos: `/tmp/codegraph-corpus/<repo>` (all 7 README repos indexed). Explore/trace changes are **query-time** (no re-index). The closure-collection synthesizer is **index-time** but produces 0 edges on non-Swift, so it's inert there.
- Global `codegraph` is npm-linked to the dev dist (`node dist/bin/codegraph.js`). **Always `npm run build` before any probe/A/B** (they load `dist/`, not `src/`).
- `engine.ts`/`tools.ts` now `import type CodeGraph` + lazy `require('../index')` (CommonJS, cached) so the daemon binds before the sqlite/query chain loads; `findNearestCodeGraphRoot` now comes from the light `../directory`.
- The old `runProxy`/`pipeUntilClose` in `proxy.ts` are now DEAD (superseded by `runLocalHandshakeProxy`) — left in place; safe to prune in a follow-up.
- 5 `npm-shim.test.ts` failures are pre-existing/network (need `--probe-net`) — NOT regressions; ignore.
- Uncommitted `.gitignore` change (`tmux-web/`) is unrelated/not mine — do NOT commit it on this branch.
- `parse-bench-readme.mjs` excludes raced runs by default; `CG_INCLUDE_RACED=1` keeps them to see the raw distribution. Now a safety net (race eliminated at source).

## How to test & validate
- `npm run build` → must be clean (exit 0).
- `npx vitest run` → **1090 pass**, only the 5 npm-shim network fails.
- `npx vitest run __tests__/mcp-daemon.test.ts` → **7/7** (sharing, #277 survive-client-death, version-mismatch fallback, idle-timeout).
- Cold-start handshake (after killing daemons): node-spawn a `serve --mcp`, send `initialize`, time the id:1 response → **~90ms** (was ~811ms). Then a `tools/call` (e.g. `codegraph_status`) returns a real result (forwarded to the daemon, ~3.4s on vscode's first index load — a call that returns LATE, not a missing-tool error).
- A/B sweep: `RUNS=4 bash scripts/agent-eval/bench-readme.sh` → `node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme`.
- **Methodology:** handshake <150ms = race eliminated; in an A/B, grep the WITH jsonls for "No such tool available" (should be 0 now); WITH reads/tools < WITHOUT with no control regression.

## Repo state
- branch `feat/trace-relevance-closure-collection`, last commit `82ae484 perf(mcp): proxy answers initialize/tools-list locally — cold-start handshake ~600ms→~90ms`. In sync with remote (0/0). PR **#580** open.
- uncommitted: ` M .gitignore` (unrelated tmux-web/ edit, not mine) + the new untracked `.claude/handoffs/` files. All code committed.

## Open threads / TODO
- [ ] Run median-of-4 README sweep on THIS build (race gone → should be naturally consistent, no exclusions needed).
- [ ] Update README: benchmark summary table (7 rows × cost/tokens/time/tools), the 7 per-repo detail tables (Time/Reads/Grep/Tools/Tokens/Cost), the average line, the headline (line 7), and the methodology date (line 86).
- [ ] Squash-merge PR #580 (`gh pr merge 580 --squash --admin` per the PR-merge-policy memory).
- [ ] Add CHANGELOG entries under `[Unreleased]` for the cold-start fixes (trace fix + closure-collection + god-file already have entries from earlier commits — verify).
- [ ] (cleanup) Prune dead `runProxy`/`pipeUntilClose` in `proxy.ts`.
- [ ] (frontier, deferred) Alamofire `task` overload still seeds `RedirectHandler.task` (a harmless false-positive in named-seed ranking) — same nodeRelevance idea could de-rank it.

## Recent transcript (oldest → newest)
### Turn — "which repos drag the averages? Alamofire looks worst"
- **Claude:** Computed per-column deviations from the README table → Alamofire #1 drag (tool-calls 13% vs 62% avg, time 7% vs 23%), gin #2; both ~110-file repos.
- **Outcome:** Targeted Alamofire.
### Turn — "dig into Alamofire A/B logs"
- **Claude:** Read `/tmp/ab-readme/alamofire/run*/run-headless-with.jsonl` → found validate-flow break (`validators` closure-array) + per-run reasoning. Built closure-collection synthesizer + explore synth-links. A/B: flat (adoption variance).
- **Outcome:** Synthesizer correct + sufficient (forced codegraph-only 3/3) but didn't move the noisy median.
### Turn — "keep working till you figure it out"
- **Claude:** Read transcripts again → "the trace collided with same-named symbols (44 requests, 8 tasks)". Found `scorePair` picked empty stubs. Added `nodeRelevance`. A/B n=8: tools 12→8, variance collapsed.
- **Outcome:** The real Alamofire win. Committed `e86d573`; opened PR #580; squash-merge deferred.
### Turn — "do the file-ranking + gather layers"
- **Claude:** Built the 6-layer god-file rendering (`c64c4b3`). A/B flat-to-worse → debugged spirals → found the skeleton tag said "Read for more" (fixed `5d7388c`) → spirals persisted → root-caused the MCP cold-start race ("No such tool available").
- **Outcome:** Race is the dominant inconsistency, not the code.
### Turn — "keep iterating until consistent / do both (parser + startup)"
- **Claude:** Bench parser race-aware (`dc19eab`). Deferred CodeGraph load off the bind path + 25ms poll (`91e28df`, 811→600ms).
- **Outcome:** Consistency handled (parser) + 25% startup.
### Turn — "how to optimize cold-start? / implement it"
- **Claude:** Profiled (module loads 30-40ms, re-exec not it — it's the daemon-spawn wait). Implemented `runLocalHandshakeProxy` (`82ae484`): proxy answers initialize/tools-list locally + forwards calls + lazy local-engine fallback. Fixed 4 daemon tests (emit "Attached to shared daemon" + fast-fail version-mismatch + updated 1 assertion). Handshake 90ms; 28/28 MCP tests; full suite 1090 pass.
- **Outcome:** Cold-start race ELIMINATED. All cold-start work committed + pushed. README sweep + squash-merge pending.
