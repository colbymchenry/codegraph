---
name: codegraph-retrieval
description: Use when changing codegraph_explore or any MCP tool's output or error shape, either explore budget, a dynamic-dispatch synthesizer, a framework resolver or router, or when validating retrieval quality on real repositories.
---

# Retrieval performance and dynamic-dispatch coverage

CodeGraph's core value is letting an agent answer **structural/flow** questions ("how does X reach Y", trace, impact, callers) with a few **fast** codegraph calls and **zero Read/Grep**. The optimization target is **wall-clock latency + tool-call count** — *don't optimize for token cost*. (Cost is **lower**, not "flat" as earlier framing claimed: a current-build with-vs-without A/B across the 7 README repos, median of 4, saved on average **35% cost · 57% tokens · 46% time · 71% tool calls** — reproducing the published README. The mechanism is **far fewer turns over a much smaller accumulated context** — NOT cache-ability: the without-arm's huge token volume is *mostly* cheap cache-reads, which is why token-count savings (57%) look bigger than cost savings (35%). Measure tokens by **summing per-turn assistant usage**, not `result.usage` (last-turn only in current Claude Code). See `docs/benchmarks/call-sequence-analysis.md`.) The mechanism that drives everything here: **an agent falls back to Read/Grep the instant a codegraph answer is insufficient.** So every change is judged by one question — is codegraph's answer sufficient enough to *stop* the agent from reading?

**Target behavior:** a flow question resolves in **1 codegraph call on small repos, scaling to 3–5 on large**, with **Read/Grep = 0**. When reviewing a PR or trying something new, do not regress this.

## Adapt the tool to the agent — don't try to change the agent

The lever that decides whether a retrieval change lands. **Test before building anything here: does this make a tool the agent _already calls_ do more with the input it _already gives_? If it instead needs the agent to behave differently — pick a different tool, query differently, learn from examples — it hits the low-salience wall and won't land.**

CodeGraph's only channels to influence the agent are low-salience: the MCP `initialize` instructions (`server-instructions.ts`) and the tool descriptions. Changing them does **not** reliably move the agent's tool _choice_ or query style — validated: trace-first steering ported into the server-instructions + tool descriptions (3 wording variants) never reproduced what a CLI `--append-system-prompt` achieved, and **regressed** wall-clock vs baseline. New tools fare worse (rarely chosen — the agent under-picks even `trace`); "better examples" is the same steering. The agent's tool-choice does improve on its own as host models get better at tool use — but that is not ours to force.

What works is meeting the agent where it already is:
- **explore-flow** — `codegraph_explore` is the PRIMARY tool the agent reliably calls; its query is a precise bag of symbol names (incl. qualified `Class.method`) spanning the flow the agent is after; explore finds the call path _among those named symbols_ (riding synthesized edges) and leads its output with it. (`buildFlowFromNamedSymbols`: segment/co-naming disambiguation; ≤1 unnamed bridge so it never wanders a god-function's fan-out. Overload-aware: a PascalCase type token in the query biases an overloaded name to that type's own def — `DataRequest task` → DataRequest's `task`, not the abstract base; named-symbol files sort first.)
- **Sufficiency** — make the tool's output complete enough that the agent stops. `codegraph_node` returns the full body + the caller/callee trail, and for an AMBIGUOUS name returns **every overload's body in one call** (so the agent never Reads a file to find the right overload — validated on Alamofire/gin). This is the after-explore depth tool (labeled SECONDARY).
- **Errors teach abandonment** — one or two `isError: true` responses early in a session and the agent stops calling codegraph entirely (maintainer-observed, repeatedly). `isError` is reserved for genuine "stop trying" cases: security refusals (`PathRefusalError`) and real malfunctions (which carry a retry-once note). Every expected/recoverable condition — project not indexed, symbol not found, file not in the index — returns a **SUCCESS-shaped response carrying the guidance** (`NotIndexedError` → `textResult`, see `ToolHandler.execute`'s catch). The same principle is why the tool surface is **always exposed, even at an un-indexed root** (the old empty-`tools/list` gate was removed in #964 — it broke monorepos where only sub-projects carry a `.codegraph/`, and hid the tools from a session that started before `codegraph init`): safety comes from the response SHAPE (success-shaped guidance, never `isError`), not from hiding tools. An un-indexed root's `initialize` sends a per-project variant (`SERVER_INSTRUCTIONS_NO_ROOT_INDEX` — "pass `projectPath` to a project that has a `.codegraph/`"), not an "inactive" note; indexing is still deliberately the user's call, never the agent's.

What fails is the inverse — folding a precise answer into a **fuzzy-input** tool: the now-removed `codegraph_context` took a description, not symbols, so it couldn't disambiguate a flow's endpoints and surfaced the _wrong feature_ (which is why it was cut). Precise output needs precise input — explore takes a symbol bag for exactly this reason. (`codegraph_trace` was likewise removed: explore-flow does its job and the agent under-picked it.)

The remaining lever under this axis is **coverage**: every flow made to connect statically (a new dynamic-dispatch synthesizer, or extracting symbols static parsing skipped — e.g. object-literal store actions in `create((set,get)=>({...}))`) is then surfaced automatically by explore-flow, no agent change needed. Reactive/reconciler runtimes (Halo's `ReactiveExtensionClient`, MediatR, Vue Proxy) are the frontier — flows there have no static edges, so nothing surfaces (correctly — silent beats wrong). Full investigation + A/B record: `docs/benchmarks/call-sequence-analysis.md` + auto-memory `project_codegraph_read_displacement`.

## Explore budget — keep BOTH budgets monotonic with repo size

Two functions in `src/mcp/tools.ts` scale explore with indexed file count. This is the expected resolution (a regression here silently forces agents back to Read):

| Repo | files | explore calls | chars/call | per-file |
|---|---|---|---|---|
| express (small) | 147 | 1 | 18K | 3800 |
| excalidraw/django (medium) | 643–3043 | 2 | 28K | 6500 |
| vscode (large) | 10446 | 3 | 35K | 7000 |
| ~20k / ~40k | — | 4 / 5 | 38K | 7000 |

- `getExploreBudget(fileCount)` → **call** budget: `<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5` (max 5).
- `getExploreOutputBudget(fileCount)` → **per-call** output (chars / files / per-file). **Invariant: a larger tier must never get a smaller `maxCharsPerFile` than a smaller tier.** (Regression that motivated this doc: the `<5000` tier's 2500 was *below* the `<500` tier's 3800, so on a god-file repo — excalidraw's 415 KB `App.tsx` — one explore returned <1% of the file and forced a Read.)
- Explore output must **never tell the agent to "use Read"** — steer to another `codegraph_explore` and "treat returned source as already Read."

## Dynamic-dispatch coverage — the flow must EXIST in the graph end-to-end

Static tree-sitter extraction misses computed/indirect calls, so flows break at dynamic dispatch and the agent reads to reconstruct them. Synthesizers/resolvers bridge these so `codegraph_explore` connects them end-to-end (`src/resolution/callback-synthesizer.ts`, `src/resolution/frameworks/`). Channels today: callback/observer, EventEmitter, **React re-render** (`setState`→`render`), **JSX child** (`render`→child component), **React Native native→JS events** (`sendEvent(withName:)` / JVM `emit` → the `addListener` handler, named or inline, `rn-event-channel`), django ORM descriptor. The JS→native direction is a *resolver* (`frameworks/react-native.ts`: `RCT_EXPORT_METHOD`, `RCT_EXTERN_MODULE` Swift shims, TurboModules), which trusts receiver evidence — an alias bound to `NativeModules.X` — over the import resolver. All synthesized edges are `provenance:'heuristic'` with `metadata.synthesizedBy` + `registeredAt` (the wiring site), surfaced inline in `codegraph_explore`'s Flow section and the `codegraph_node` trail.

**Principle: partial coverage is WORSE than none.** Bridging one boundary but not the next reveals a hop the agent then drills + reads to finish. Measured on excalidraw: react-render alone *raised* reads to 5–7; only completing the flow (adding the jsx-child hop) dropped it to 0–1. **Always close the flow end-to-end and re-measure** — never ship a half-bridged flow.

## Framework coverage

**Before adding or extending a router, a web framework, or a language's `WHEN` rules, read `docs/design/framework-coverage.md`.** It is the standing answer to "what is supported and what is left" across the three axes (route nodes → Entry points, `navigates` edges → Screens, branch-guard rules → the `WHEN` labels), with what each remaining item needs, the traps that have already cost debugging time, and the queries to re-verify it. Update it in the same change that moves a row.

## Validation methodology & worked examples

**Required** for every new language/framework: validate on small/medium/large real repos with >=3 flow prompts; deterministic probes (`scripts/agent-eval/probe-*.mjs`) then agent A/B (`scripts/agent-eval/run-all.sh` / `ab-new-vs-baseline.sh`). Pass bar: ~0 Read/Grep within the explore-call budget, faster than without-codegraph, no control-repo regression.

Full methodology (feedback metrics, CLI contamination guard, Sonnet/`--effort high` model policy, daemon pre-warm), the Excalidraw worked example, and coverage matrix live in:
- `docs/AGENTS.md` (nested; also loaded when cwd is under `docs/`)
- `docs/design/dynamic-dispatch-coverage-playbook.md`
- `docs/design/callback-edge-synthesis.md`
- `docs/benchmarks/call-sequence-analysis.md` / `docs/benchmarks/agent-eval-feedback-metrics.md`
