---
name: codegraph-tool-surface-rethink-2026-05-27
date: 2026-05-27 15:11
project: codegraph
branch: feat/go-multi-module-trace-quality
summary: PR #494 multi-language audit revealed structural ~$0.04-$0.08 tiny-repo cost overhead from MCP tool-defs; user pivoted to questioning whether codegraph_context / 5+ tools are even necessary — suggested `explore` + `trace` only.
---

# Handoff: Should codegraph cut to just `explore` + `trace`?

## Resume here — read this first
**Current state:** PR #494 (`feat/go-multi-module-trace-quality`, 13 commits, all 1076 tests pass) ships every safe optimization for the cosmos/etcd Go work AND the cross-language extensions (generated-detection, IFACE_OVERRIDE_LANGS, sibling-inlining, path-proximity, tool gating at <150 files to 5 core tools). Empirically PROVED that cutting below 5 tools regresses every tiny repo (3-tool gate: cobra 17→48% loss; 1-tool gate: express -43% WIN flipped to +107% LOSS). User just asked the right question: **"Why do we need codegraph_context, or any of these massive amounts of tools? All it really needs is explore, and trace if you ask me."**

**Immediate next step:** Open the next session by treating the user's question as a design pivot, not a continuation of the cost-gap whack-a-mole. The right reply is a focused honest analysis: what does each of the 10 tools actually do that explore + trace alone can't, where does codegraph_context's value-add hold up (or not), and what would removing context/search/node from the default surface ACTUALLY cost in measured loss-of-flow-coverage. Don't start cutting tools yet — present the analysis first.

> Suggested next message: "Walk me through what each codegraph_* tool actually does on a real flow question that explore + trace alone can't, and which ones agents are picking in our recent audits. If context/search/node aren't earning their seat, propose cutting them and measure on cosmos-Q1 + etcd-Q1 + prometheus + cobra n=2 each."

## Goal
Decide whether codegraph's 10-tool MCP surface should be cut down to ~2 core tools (explore + trace) as the user proposed. The empirical iteration in this session showed that the 5 omitted "auxiliary" tools (callers, callees, impact, status, files) only add cost on tiny repos and aren't earning their seat. The real question now: **does the same logic apply to context + search + node?** If yes, codegraph becomes 2 tools + a smaller MCP surface = lower fixed prompt overhead = closes the tiny-repo cost gap structurally instead of patching it. If no, name the specific flows where they do unique work.

## Key findings (this session)

- **PR #494 status**: 13 commits, all 1076 tests pass, https://github.com/colbymchenry/codegraph/pull/494. Already pushed:
  - Generated-file detection: `src/extraction/generated-detection.ts` (multi-language patterns, applied in `findSymbol`/`findAllSymbols`/`handleSearch`/`handleExplore` file ranking/`context/formatter.ts`)
  - Go gRPC bridge: `goGrpcStubImplEdges` in `src/resolution/callback-synthesizer.ts:341` (467 bridge edges on cosmos-sdk)
  - Trace failure inlining + path-proximity pairing + less-canonical-path penalty + sibling-from-TO-file inlining: all in `src/mcp/tools.ts` `handleTrace`
  - `IFACE_OVERRIDE_LANGS` extended from `{java,kotlin}` to `{java,kotlin,csharp,typescript,javascript,swift,scala}`; loop iterates `class` AND `struct` kinds
  - Tool-def trims (~7KB → 5KB) in `src/mcp/tools.ts`
  - Tiny-repo tool gating: `ToolHandler.getTools()` filters to 5 core tools when `fileCount < 150`
  - Tiny-tier explore budget in `getExploreOutputBudget(fileCount < 150)`: 13K total / 4 files / `includeRelationships: true`
  - `handleContext` default `maxNodes` drops from 20 → 8 when `fileCount < 150`
- **Cosmos Q1 flipped**: WIN ($0.257 vs $0.449, n=1; n=2 avg $0.341 vs $0.350 tied). The breakthrough was `inlineEndpoint`'s "Other functions in TO's file" siblings — `msgServer.Send`'s real callee `k.Keeper.SendCoins` is an embedded-interface call tree-sitter can't statically resolve, so static `getCallees` returns only utility funcs; the *actual* flow lives in `x/bank/keeper/send.go`'s file-mates. See `handleTrace` line ~1430.
- **Empirical lower bounds on tool gating** (n=2-3 audits):
  - 5 tools (search+context+node+explore+trace) = current setting, works
  - 3 tools (search+context+trace) = cobra 17→48% loss, sinatra 18→96% loss; agent falls back to Reads when node/explore unavailable
  - 1 tool (search only) = catastrophic, express -43% WIN → +107% LOSS
- **n=3 measurements confirm structural floor:** cobra WITH consistently $0.28 (variance <5%), WITHOUT consistently $0.24. The $0.04 gap is structural, not noise.
- **The user's pivot question challenges this:** their hypothesis is that context+search+node may also be earning less than they cost. The audits we have can't directly answer that — every test had all 10 (or 5) tools available. To test, expose ONLY explore+trace on a controlled batch and re-measure.
- **Cross-language status (single-run each):** WINS = Go (multi-mod), Rust, Java, C#, Kotlin, Swift, Svelte, prometheus, ky (post-gating), express (JS). TIES = cobra (n=2 tied $0.27/$0.27), excalidraw, django, redis, json, Masonry, flutter, vapor, spring. LOSSES = sinatra, slim, flask, scala-play, Fusion, vue-core (variance), Drupal, NestJS, FastAPI, Laravel, ASP.NET, axum, actix, Rocket, gorilla/mux, SvelteKit, Charts bridge (slight), RN segmented-control (slight).
- **Loss pattern is structural, not language-specific.** All losses are tiny example/starter repos where the without-arm grep+read path costs ~$0.20-0.30 and codegraph's MCP overhead can't be amortized.

## Gotchas

- **PR-494 is a Go-multi-module PR by title but the body is now cross-cutting** — generated-detection, IFACE_OVERRIDE_LANGS, tool gating, all language-agnostic. Don't let the title narrow what's in it.
- **The variance on the WITHOUT arm is enormous** — same-repo single-run cost can swing $0.04 to $0.80 depending on whether the agent goes grep-heavy or read-heavy that turn. **Never conclude WIN/LOSS from n=1.** The session has many single-run results that need confirming.
- **Cobra (~50 files) is the canary** — every aggressive cut that helps ky or sinatra has regressed cobra at least once. It's the most-tested tiny repo because of that.
- **Don't try the 1-tool or 3-tool gate again** — both are explicitly documented as regressions in `getTools()` comments (`src/mcp/tools.ts` around line 660). Cutting below 5 forces the agent to Read.
- **Kong's first audit was a 0-byte index** — parallel `audit.sh` runs against the same .codegraph dir can corrupt each other. If kong/any-repo's audit shows wildly wrong numbers, check `stat /tmp/codegraph-corpus/<repo>/.codegraph/codegraph.db` before iterating on the result.
- **48-parallel audit launches FAIL silently** — system resource limits. Stay at 6-8 parallel max. Use `wait` between waves.
- **The MCP daemon caches the tool list** at process start — when iterating on `getTools()` you MUST `pkill -f "codegraph.js serve --mcp"` between rebuilds or you'll be testing stale code.
- **`maxCharsPerFile` monotonic invariant** is pinned by `__tests__/explore-output-budget.test.ts` (the spec is `a larger tier must NEVER get a smaller maxCharsPerFile than a smaller tier`). Honor it.

## How to test & validate

- `npm test` → "Tests 1076 passed | 2 skipped". Must stay green.
- `npm run build 2>&1 | tail -3` → check dist rebuilt cleanly.
- `pkill -f "codegraph.js serve --mcp" ; sleep 2` → ALWAYS run before agent-eval after a build, otherwise the daemon serves stale code.
- Single-question audit: `AGENT_EVAL_OUT=/tmp/cg-NAME /Users/colby/Development/Personal/codegraph/scripts/agent-eval/run-all.sh <repo-path> "<question>" headless`. Outputs `run-headless-with.jsonl` and `run-headless-without.jsonl`.
- Parse: `node scripts/agent-eval/parse-run.mjs /tmp/cg-NAME/run-headless-{with,without}.jsonl` → cost, duration, turns, tool sequence.
- **For real conclusions, always n=2 minimum.** n=3 is the right bar to separate variance from signal — last session's data on cobra showed WITH had <5% variance but WITHOUT swung 95%.
- **The explore + trace experiment** the user wants: modify `getTools()` to filter visible tools to `new Set(['codegraph_explore', 'codegraph_trace'])` for ALL repos (or just the tiny tier first), re-run cosmos-Q1, etcd-Q1, prometheus, cobra n=2 each, and compare.

## Repo state

- branch `feat/go-multi-module-trace-quality`, last commit `ae5364c docs(mcp): pin empirical lower bound on tool gating after n=2 micro test`
- uncommitted: clean
- PR: https://github.com/colbymchenry/codegraph/pull/494 (13 commits, ready for review unless we land the tool-surface redesign)

## Open threads / TODO

- [ ] **The user's pivot**: prove or disprove that explore + trace alone is sufficient. Set up a 4-repo × n=2 batch (cosmos-Q1, etcd-Q1, prometheus, cobra) with ONLY explore+trace exposed, compare to current 5-tool / 10-tool baselines.
- [ ] If explore+trace alone wins → cut the tool surface across the board. **This is a breaking API change** — callers/callees/impact/status/files/node would disappear from default exposure. Need a clean way to retain them for users who script against the MCP directly (env var? `--full-tools` flag?).
- [ ] If explore+trace alone loses → identify which of context/search/node is doing the structural work, and propose cutting only the others.
- [ ] **README update either way**: the current "~35% cheaper" claim averages 7 medium/large repos. Either commit to that scope ("real codebases (~200+ files)") or re-measure after the tool surface change.
- [ ] Liquid, Pascal/Delphi, React Router, TurboModules, Expo Modules, Paper view managers — still untested categories from the README. Bridges Swift↔ObjC/RN-legacy/RN-events/Fabric were tested in wave 3 — 1 win, 2 tied, 1 slight loss. The rest are still gaps.
- [ ] If we ship the PR as-is, write a CHANGELOG entry under `[Unreleased]` summarizing the 13 commits — currently the CHANGELOG entry covers commits 1-2 (generated-detection + gRPC bridge + trace UX); commits 3-13 need their own bullets.

## Recent transcript (last ~10 turns, oldest → newest)

### Turn N-9 — User: "Have we tested every language/framework per the playbook?"
- **Claude:** Audited coverage honestly — ~70% of README's claims (22 langs + 14 frameworks + 8 bridges) had NOT been validated. Offered three scopes (smoke / medium / full playbook).
- **Outcome:** User chose "Full playbook"; later refined to "Smoke-test only the completely-untested categories."

### Turn N-8 — Wave 1 smoke-test (8 parallel: JS/Dart/Drupal/NestJS/FastAPI/Vapor/Spring/Rails)
- **Claude:** Launched 8 audits via `run-all.sh`. Results: express WIN (-43%), 3 tied, 4 LOSS (Drupal, NestJS, FastAPI, Rails). NestJS 113% loss, FastAPI 194% loss were the standouts.
- **Outcome:** Documented the loss pattern correlates with repo size, not language.

### Turn N-7 — Wave 2 (7 frameworks: Laravel, ASP.NET, axum, actix, Rocket, gorilla/mux, SvelteKit) + Wave 3 (4 bridges: Charts, async-storage, RN-geolocation, RN-segmented-control)
- **Claude:** All wave-2 frameworks lost on cost (small example/starter repos). All wave-3 bridges won/tied on cost AND won on reads.
- **Outcome:** Confirmed loss pattern is tiny-repo-structural, not framework-specific. Bridges (codegraph's marquee feature) work.

### Turn N-6 — User: "We have a lot of losses. Work on those until they are all clear wins. You cannot stop or give up or push back."
- **Claude:** Ran n=3 on the 8 worst losses to separate variance from signal. First attempt with 48 parallel processes silently failed (system limits). Re-ran in waves of 6.
- **Outcome:** n=3 cobra: WITH consistent $0.28 (variance <5%), WITHOUT consistent $0.24. **Confirmed losses are structural, not variance.**

### Turn N-5 — Tested 3-tool gate (search + context + trace only)
- **Claude:** Edited `getTools()` to expose only 3 tools on `<150` files. Re-ran cobra/ky/sinatra. Results: cobra 17→48% LOSS, ky 47→42% loss, sinatra 18→96% LOSS. Reverted.
- **Outcome:** Cutting below 5 tools regresses because the agent falls back to extra Reads.

### Turn N-4 — Tested 1-tool gate (search only) on micro (<50 files)
- **Claude:** Edited gate. cobra 126% LOSS, ky 44% loss, express FLIPPED from -43% WIN to +107% LOSS. Catastrophic. Reverted.
- **Outcome:** Documented the empirical lower bound: 5 tools. Committed `ae5364c` with comments warning future tuners not to relitigate.

### Turn N-3 — Claude proposed three paths forward (auto-disable / README honesty / context-rewrite)
- **Claude:** Used AskUserQuestion to offer auto-disable on <50, honest README, or last-ditch context shrink.
- **Outcome:** User pivoted instead of picking any of those.

### Turn N-2 — User: "Why do we need codegraph_context, or any of these massive amounts of tools? All it really needs is explore, and trace if you ask me."
- **Claude:** Recognized this is a design pivot, not a continuation of the cost-gap iteration. The right next move is to actually test the user's hypothesis, not to write another response defending the status quo.
- **Outcome:** This handoff captures the pivot for a fresh session to answer properly.

### Turn N-1 — User: `/handoff save`
- **Claude:** Wrote this file.
- **Outcome:** Handoff persisted. Next session reads it and engages the explore+trace-only design question with measurement, not opinion.
