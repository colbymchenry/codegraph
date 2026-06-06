---
name: explore-flow-tool-adoption
date: 2026-05-24 00:55
project: codegraph
branch: architectural-improvements
summary: Investigated why codegraph's read savings don't convert to wall-clock; root cause is agent tool-CHOICE (under-uses trace). Shipped a chain of fixes; the breakthrough is "explore-surfaces-flow" — the first mechanism to show up in real agent runs by adapting the tool the agent already uses.
---

# Handoff: codegraph retrieval — tool adoption & explore-surfaces-flow

## Resume here — read this first
**Current state:** A long investigation into making agents answer flow questions faster with codegraph. 6 commits on `architectural-improvements` (all probe-validated, suite green 815). The breakthrough: **`codegraph_explore` now surfaces the execution flow** from the symbol-bag the agent already passes it (`PmsProductController getList PmsProductService list PmsProductServiceImpl` → leads output with `getList → service-interface → impl`, riding synth edges). It's the FIRST mechanism this whole arc to actually appear in real agent runs (spring-mall A/B: flow surfaced both runs, reads 2.0→1.5) — because it adapts the tool the agent USES instead of trying to make it use `trace`.

**Immediate next step:** The user is weighing how to push tool-USE quality next (their open question). Decide between: (a) **extend explore-flow to surface more reliably** (spring-halo's query didn't name a connected co-named chain → no flow), (b) accept we're at the model-behavior ceiling and **wrap up**, or (c) the user's ideas — better tool-description *examples* (≈ steering, low-leverage per the evidence) or a *query-builder tool* (adds a call + new-tool adoption problem). My read: keep ADAPTING THE USED TOOL (the only thing that's worked); examples/new-tools are the "change the agent" direction that failed all session.

> Suggested next message: "explore-flow only surfaced on 2 of 3 repos — dig into why spring-halo's explore query didn't produce a flow and make it surface more reliably" — OR — "we're at the model-behavior ceiling; let's stop and write the CHANGELOG/PR for this branch"

## Goal
Make an AI agent answer **flow questions** ("how does X reach Y", request→handler→service, state→render) fast: ~0 Read/Grep, few codegraph calls, lower wall-clock. `codegraph_trace` is the fastest tool (1 call = the path), but the agent under-uses it. Ultimate target = trace's speed, however the agent gets there.

## Key findings (the through-line)
- **The wall is agent tool-CHOICE, not the graph.** Matrix-wide, codegraph cuts reads −75% but wall-clock only −16% (`docs/benchmarks/codegraph-ab-matrix.md`). The floor is round-trips + the synthesis turn. The agent reliably calls `context`/`explore`, rarely `trace` (3/37 flow cells). Full analysis: `docs/benchmarks/call-sequence-analysis.md`.
- **Steering does NOT move it** (arms B/F/G, 3 wording variants): an MCP `initialize` instruction / tool description can't match a CLI `--append-system-prompt`'s salience, and forcing trace where it doesn't connect regresses. Reverted.
- **Sufficiency works** (committed): a self-sufficient `trace` (hop bodies + destination callees inlined) lets the unsteered agent stop — but only when it calls trace.
- **THE breakthrough — adapt the tool the agent uses.** `explore`'s query is a precise symbol-bag spanning the flow, so `explore` finds the call path AMONG its named symbols and leads with it. First mechanism to surface in real runs + drop reads.
- **What FAILED:** option 1 (context-surfaces-flow) — fuzzy DESCRIPTION can't disambiguate endpoints → confident WRONG-feature flow; reverted. trace multi-source-BFS over ambiguous names — same wrong-feature; reverted.

## Gotchas
- **Co-naming disambiguation must match qualifiedName SEGMENTS, not substrings** (`buildFlowFromNamedSymbols` in `src/mcp/tools.ts`): `list` is a substring of `getList` → kept every getList. Split `qualifiedName` on `::`/`.` and match segments.
- **BFS must cap consecutive UNNAMED hops at 1** — full-graph BFS wanders a god-function's fan-out (excalidraw `render()` → pointer handlers → mutateElement). ≤1 bridge crosses a missing intermediate without wandering.
- **`getCallees` returns non-`calls` edges too** (references) — filter `c.edge.kind === 'calls'`.
- **Resolver/synthesizer changes need a CLEAN reindex**: `rm -rf .codegraph && codegraph init -i` (the init edge count is contains-only — query the DB for the real count). The explore-flow change is query-time (no reindex).
- **n=2 A/B is noisy** — report ranges/patterns, never conclude from one run. Foreground `sleep` is blocked → run A/B batches with `run_in_background`.
- Java/Kotlin `qualifiedName` is `Class::method` (so `matchesSymbol` resolves `Class.method` qualified trace endpoints — the agent already passes these).

## How to test & validate
- Probe flow surfacing (no agent): `node scripts/agent-eval/probe-explore.mjs <repo> "<SymbolA SymbolB SymbolC>"` → look for the `## Flow` section. `probe-trace.mjs <repo> <from> <to>` for trace.
- Synthesizer: `sqlite3 <repo>/.codegraph/codegraph.db "select count(*) from edges where json_extract(metadata,'$.synthesizedBy')='interface-impl'"`; node count stable before/after reindex (synth adds edges only).
- Agent A/B (the real test): `bash scripts/agent-eval/run-arms.sh <repo> "<Q>" I <run>` (arm I = body-trace build, no steering). Parse via the `cmp2.mjs`-style scripts in `/tmp`. Pass = flow surfaces (`flowShown=Y`) + reads ≤ baseline.
- `npm test` (vitest, 815 pass); `__tests__/mcp-tool-allowlist.test.ts` covers the allowlist.

## Repo state
- branch `architectural-improvements`, last commit `bafae81 feat(mcp): codegraph_explore surfaces the execution flow from its named symbols`.
- uncommitted: clean (only untracked `.claude/handoffs/`).
- 6 session commits: `eab5cf3` self-sufficient trace + `CODEGRAPH_MCP_TOOLS` allowlist · `a6183d7` research log + arms harness · `bde8c19` node/trace line numbers · `98baf41` Java/Kotlin interface→impl synthesizer · `6f3c468` playbook · `bafae81` explore-surfaces-flow.
- NOT pushed/merged. No version bump. CHANGELOG `[Unreleased]` has all of it.

## Open threads / TODO
- [ ] **User's open question** (answer in the next turn): better tool-description *examples* vs a *query-builder tool* vs keep adapting the used tool. Evidence favors the last.
- [x] explore-flow reliability: now resolves QUALIFIED tokens (`Class.method`) — the agent's most precise input was being dropped by the file-ext strip (`2765c3c`). spring-halo's publish flow stays absent on purpose — it's **reactive/reconciler dispatch** (`publishPost` calls `ReactiveExtensionClient.get`/`awaitPostPublished`, not `PostService.publish`), so there's no static call chain. That's the next COVERAGE frontier (reactive runtimes — like MediatR, Vue Proxy), not an explore-flow bug.
- [ ] Ship-prep for the whole branch (this arc + the earlier framework sweep): CHANGELOG version block + `package.json` bump + PR to main. Releases go through `.github/workflows/release.yml` only — do NOT `npm publish`.
- [ ] Frontiers: MediatR (`_mediator.Send`→Handle) and Vue/Compose reactive runtimes are still unbridged dynamic dispatch.

## Recent transcript (oldest → newest)
### Turn — "improve the A/B matrix; trace works, reads near 0 — what else?"
- Diagnosed: reads at floor, wall-clock floor = round-trips + synthesis. Built `seq-matrix.mjs`; found trace adoption 3/37.
### Turn — "do explore/context/trace compete? one tool?"
- Ablation arms A–E (`run-arms.sh`/`arms-F.sh` + `CODEGRAPH_MCP_TOOLS` allowlist). explore = 68% of payload, load-bearing; trace path-scoped but under-adopted; trace alone insufficient.
### Turn — "prototype body-inlining trace + A/B"
- Arm F: self-sufficient trace wins WITH append-prompt steering. But steering isn't a shippable channel.
### Turn — "port the steering + re-run"
- Arms G (3 variants) all regressed vs baseline; arm H (body-trace, no steer) ≈ baseline. Steering reverted; body-trace + line-numbers + allowlist committed.
### Turn — "tee up connectivity (Spring interface-DI)"
- Built `interfaceOverrideEdges` (Java/Kotlin interface→impl, overload-aware). Probe: 3-hop trace connects. But A/B null — agent never called trace. Committed (probe-validated, adoption-gated).
### Turn — "make context surface the flow (option 1)"
- Failed: fuzzy query → wrong-feature flows. Reverted.
### Turn — "change explore to do trace in the backend"
- WIN: explore's query is a precise symbol-bag. `buildFlowFromNamedSymbols` (co-naming segment match + ≤1 bridge). Probe perfect (Spring + excalidraw full chains); A/B: flow surfaces + modest read drop. Committed `bafae81`.
### Turn — "update memory + handoff; what about better examples / a query-builder tool?"
- This handoff + memory update. Strategic answer pending (adapt-the-tool > change-the-agent).
