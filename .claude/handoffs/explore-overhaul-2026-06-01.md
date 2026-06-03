---
name: explore-overhaul-2026-06-01
date: 2026-06-01 19:50
project: codegraph
branch: main
summary: Made codegraph_explore the sole primary tool (removed context + trace), added graph-connectivity ranking + 100K budget + full method bodies — then an agent-eval revealed the budget BACKFIRES and the real lever is COVERAGE (Zustand store methods aren't indexed).
---

# Handoff: codegraph_explore overhaul — explore as the one tool, and the coverage pivot

## Resume here — read this first
**Current state:** Big uncommitted working tree on `main`. `codegraph_context` and `codegraph_trace` tools are fully removed; `codegraph_explore` is the sole primary, now with graph-connectivity (RWR) ranking, a flat **100K** output budget, full method bodies, whole-central-file, and an always-on blast-radius section. A fresh-daemon agent-eval on the real repo (`~/Downloads/amniservices-mobile-app`) just proved two things: (1) the **100K budget BACKFIRES** — a broad explore hit **67K chars and overflowed the agent's per-tool token cap**, forcing it to Read; (2) the **real cause of the agent's reads is a COVERAGE gap**, not ranking/budget — Zustand store methods (`fetchUser`/`switchOrganization` inside `create((set,get)=>({...}))`) aren't indexed as nodes, and callers **destructure** them (`const {fetchUser}=useOrgUser.getState()`), so `codegraph_node`/`codegraph_callers` return "not found."
**Immediate next step:** Revert the 100K budget (it overflows) to ~28–35K, then build the Zustand coverage fix (extract store-literal methods as nodes + resolve destructured `getState()` calls). That's what actually deletes the reads.

> Suggested next message: "Revert the explore budget in getExploreOutputBudget (tools.ts) from 100K back to ~30K — the 67K response overflowed the agent's tool cap. Then build the Zustand coverage fix: extract methods inside `create((set,get)=>({...}))` as nodes, and resolve destructured store calls like `const {fetchUser}=useOrgUser.getState()`. Then kill the AmniSphere daemon and re-run the agent eval."

## Goal
Make `codegraph_explore` good enough to be a **Read-replacement** — one (maybe two) calls answer a structural/flow question with ~0 Read/Grep, for smart AND dumb models. Metric is wall-clock + tool-call count + Read count (NOT token cost). The user's golden era: one tool (`explore`), reflexively used, zero Reads.

## Key findings
- **The agent's reads are a COVERAGE gap, not ranking/budget.** Agent's own words (diagnostic eval): Zustand store actions inside the `create((set,get)=>({...}))` literal "aren't individually indexed," so `codegraph_node fetchUser` / `codegraph_callers fetchUser` → **"not found"**; callers **destructure** off `useOrgUser.getState()` so even grep needed `\bfetchUser\b`. Component-body control flow (`handleLogin`, `AppInitializer` in `src/app/index.tsx`, `src/components/providers/index.tsx`) isn't a node either.
- **The 100K budget backfires.** A broad explore returned ~67K chars and "overflowed the token cap" → agent Read instead. Big responses are *worse*. `getExploreOutputBudget` (tools.ts ~line 140) is now a flat 100K — revert toward ~28–35K (size to the agent's per-tool output limit).
- **Adoption is EXCELLENT — the agent WANTS codegraph.** In the fresh eval it made **16 codegraph calls** vs 5 Reads. So the problem is never "agent won't use it"; it's "the symbols aren't in the graph."
- **Graph-connectivity ranking works in isolation but didn't address the real cause.** `computeGraphRelevance` (tools.ts, before `handleExplore`) is RWR/personalized-PageRank from the matched seeds; probe shows it ranks `org-user.storage.ts` #1 and returns it whole. But it doesn't cleanly drop noise (LensSwitcher.swift matched "switch") because real codebases share infra + generic terms — **neither graph nor text alone separates; needs IDF×graph fusion**, a tuning long tail. Park it until coverage is fixed.
- **`context` + `trace` tools fully removed** (def + dispatch + handlers + CLI `context` command + permissions + server-instructions + tests). The shared engine `findRelevantContext` stays (explore runs on it). `synthEdgeNote` kept (shared); `handleTrace`/`sourceLineAt`/`sourceRangeAt`/`maybeInlineFlowTrace`/`handleContext`/`looksLikeFeatureRequest`/`formatTaskContext` deleted.
- **Read-gate PreToolUse hook was built then REMOVED** (user: "ideally zero hooks"). Deleted `src/hooks/`, `src/mcp/session-consult.ts`, the `mcp-read-gate` CLI cmd, installer wiring (`InstallOptions.readGate`, claude.ts helpers), and the marker security tests. Had an unverified `CLAUDE_SESSION_ID`==hook-`session_id` assumption.
- **Precision fix landed earlier (keeper):** `isDistinctiveIdentifier` (query-utils.ts) gates the exact-name bonus in `findRelevantContext` Step 5a so a common word ("flat") can't hijack ranking (was surfacing a python `FLAT` constant). Lives in the shared engine → benefits explore.
- **Blast-radius section added to explore** (`buildBlastRadiusSection`, tools.ts): per entry symbol, who-depends-on-it + covering test files, locations only. Always-on, compact. (2 tests in `__tests__/explore-blast-radius.test.ts`.)

## Gotchas
- **STALE-DAEMON FOOT-GUN (cost us hours).** `codegraph serve --mcp` connects to a per-repo daemon (`<repo>/.codegraph/daemon.sock`, 5-min idle timeout) that holds the loaded code. **A `npm run build` does NOT take effect until you kill the daemon.** Every agent-eval before the kill was testing STALE code (agent got 2277 chars where a fresh in-process probe got 54K). **Before ANY agent eval:** `pkill -f "serve --mcp"; rm -f <repo>/.codegraph/daemon.sock`. Worth fixing in the product (a rebuild should invalidate the daemon).
- **probe ≠ agent.** `probe-explore.mjs` loads `dist/` in-process (always current code); the agent uses the daemon (can be stale). Don't trust a probe result as "what the agent sees" unless the daemon was just killed.
- **Validating with a favorable query lies.** My probe query (`"org user storage…"`) returned the whole central file; the agent's near-identical query behaved totally differently. Use the agent's EXACT query, on a fresh daemon.
- **n=1 variance is large** — never conclude from one agent run (CLAUDE.md). The "4 vs 5 reads" between runs is noise.
- **Budget-table repos (excalidraw/django/etc.) NOT validated** — they're not on this machine. The ranking/budget changes could regress them; the CLAUDE.md "do-not-regress explore budget" table is now obsolete (flat 100K) and needs reconciling.
- All work is **uncommitted on `main`** — branch before committing (PR policy: main is REVIEW_REQUIRED).

## How to test & validate
- Build: `npm run build` (must exit 0).
- Cheap probe (current code, NOT what a stale daemon serves): `node scripts/agent-eval/probe-explore.mjs /Users/colby/Downloads/amniservices-mobile-app "<query>"`.
- Agent A/B (real metric, ~$2, KILL DAEMON FIRST): `pkill -f "serve --mcp"; rm -f /Users/colby/Downloads/amniservices-mobile-app/.codegraph/daemon.sock; CG_BIN=$(pwd)/dist/bin/codegraph.js AGENT_EVAL_OUT=/tmp/agent-eval-amni bash scripts/agent-eval/run-agent.sh /Users/colby/Downloads/amniservices-mobile-app <label> "<prompt>"` → parse `/tmp/agent-eval-amni/run-<label>.jsonl` for tool order + Read count.
- Diagnostic prompt that worked: append "for EACH Read/Grep note WHY codegraph wasn't enough; end with '## Why I read'." The agent's self-report is the best diagnostic.
- Affected unit tests (NOT the full suite — user is cost-conscious): `npx vitest run __tests__/{context-ranking,explore-blast-radius,context,mcp-tool-allowlist,security,worktree-detection,installer-targets}.test.ts __tests__/integration/mcp-input-limits.test.ts`.
- Pass bar: a flow question reaches ~0 Read within the explore-call budget, faster than without-codegraph, no regression on a control repo.

## Repo state
- branch `main`, last commit `8629f7a docs(changelog): promote [Unreleased] into [0.9.8]`
- uncommitted (all this session, none committed): `M src/mcp/tools.ts` (the big one — explore ranking/RWR/budget, context+trace removal, blast radius), `M src/context/index.ts` (precision fix), `?? src/context/markers.ts` (LOW_CONFIDENCE_MARKER leaf), `M src/search/query-utils.ts` (isDistinctiveIdentifier), `M src/mcp/server-instructions.ts`, `M src/installer/targets/shared.ts` (permissions), `M src/bin/codegraph.ts` (CLI context/trace removed), `M src/types.ts`, `M CHANGELOG.md`, `?? __tests__/context-ranking.test.ts`, `?? __tests__/explore-blast-radius.test.ts`, `M __tests__/{security,worktree-detection,mcp-tool-allowlist}.test.ts`, `M __tests__/integration/mcp-input-limits.test.ts`. (read-gate hook + session-consult.ts were created then deleted → no trace.)

## Open threads / TODO
- [ ] **Revert the 100K budget** in `getExploreOutputBudget` (tools.ts ~140) to ~28–35K — it overflows the agent tool cap at 67K.
- [ ] **Reconsider "whole central file always"** (tools.ts whole-file rule + `centralFiles`) — a 791-line whole file is what overflowed. Prefer the relevant methods full, not whole-huge-file.
- [ ] **Build the Zustand coverage fix (the real lever):** (a) extract methods defined inside `create((set,get)=>({...}))` as nodes (extraction); (b) resolve destructured store calls `const {fetchUser}=useOrgUser.getState()` (reference resolution). Then re-eval.
- [ ] Decide: keep `computeGraphRelevance` (graph ranking) or park it — it didn't address the coverage cause. Probe-validated, not agent-validated.
- [ ] Re-run the agent eval (FRESH DAEMON) after the coverage fix; confirm reads of `org-user.storage.ts`/components drop.
- [ ] Reconcile CHANGELOG `[Unreleased]` with the final direction (explore primary; context+trace removed; budget/ranking may change).
- [ ] Validate budget-table repos (excalidraw/django) before merging — not on this machine.
- [ ] Run the FULL test suite once (only ran affected files this session).
- [ ] Branch off `main` before committing this work.

## Recent transcript (oldest → newest)
### Turn — "do it" (build graph ranking)
- **User:** Build graph-connectivity ranking (RWR/PageRank fused with bm25) as explore's relevance core; keep the output wins; fix the whole-file path.
- **Claude:** `Edit(tools.ts)` → added `computeGraphRelevance` (RWR, undirected, α=0.25, 25 iters); rewired file ranking/central/gate to graph-primary + text-secondary. `probe` → `org-user.storage.ts` #1 + whole (796 lines), but LensSwitcher.swift/capture noise still present.
- **Outcome:** RWR surfaces the central file but doesn't cleanly drop noise; reported the honest limit (needs IDF×graph fusion).

### Turn — "how does amniservices do now?"
- **User:** Run the agent eval on the real repo with everything in place.
- **Claude:** `run-agent.sh (amni-with-q2)` → codegraph 5 / Read 5 / Grep 3; agent Read `org-user.storage.ts` anyway. `parse` → agent's first explore returned only **2277 chars** while `probe` returned 54K for the same query.
- **Outcome:** 2277-vs-54K discrepancy → suspected the agent wasn't running my build.

### Turn — "do the test again, ask the agent WHY it read"
- **User:** Re-run, but make the agent explain each Read / why codegraph wasn't enough.
- **Claude:** `ps` → found stale daemon `pid 8947` on AmniSphere socket + pile of lingering `serve --mcp`. `pkill -f "serve --mcp"; rm daemon.sock` → fresh. `run-agent.sh (amni-diag-q3)` with the "## Why I read" prompt, fresh daemon.
- **Outcome:** First valid run on my build. codegraph **16** / Read 5 / Grep 3. Agent's "Why I read": Zustand store methods not indexed (`node`/`callers` → not found), callers destructure off `getState()`, broad explore **overflowed at 67K**. → real cause = COVERAGE; budget BACKFIRES. Pivot the priorities.

### Turn — /handoff save (this)
- **User:** `/handoff save`.
- **Claude:** Wrote this file.
- **Outcome:** Checkpoint captured; next edge = budget revert + Zustand coverage fix.
