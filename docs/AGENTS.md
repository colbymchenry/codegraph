# AGENTS.md (docs/)

Nested Codex guidance under `docs/`. Loaded with the repo-root `AGENTS.md` when cwd is under `docs/` (Codex walks root to cwd; shared `project_doc_max_bytes` budget).

Root `AGENTS.md` already carries the non-negotiable retrieval principles (adapt-the-tool, explore budgets, end-to-end synthesis). This file holds the longer validation methodology and Excalidraw worked example that were moved out of root to fit the budget.

### Validation methodology (REQUIRED for every new language/framework)

For each **language × framework**, validate on **small, medium, and large** real repos with **≥3 different flow prompts** each:

1. **Pick the canonical flow** for the framework ("how does X reach Y": state→render, request→handler→view, query→SQL, action→reducer→store…).
2. **Deterministic probes** (`scripts/agent-eval/probe-{node,explore}.mjs` against the built `dist/`): `codegraph_explore` with the flow's symbol names connects from→to end-to-end with no break (its Flow section shows the path); **no node explosion** (`select count(*) from nodes` stable before/after re-index); synthesized-edge **precision** spot-check (`select … where provenance='heuristic'`).
3. **Agent A/B** (`scripts/agent-eval/run-all.sh <repo> "<Q>"`): with vs without codegraph, **≥2 runs/arm** (run-to-run variance is large — never conclude from n=1). Record **duration, total tool calls, Read, Grep**. Optional forced-Read-0 sufficiency proof via the block-read hook (`scripts/agent-eval/hook-settings.json`).
   - **Every run also reports three feedback metrics** — residual context occupancy, explore sufficiency (what the agent did NEXT after each explore), and allocation efficiency (share of returned bytes the answer cited) — under each run, plus a side-by-side arm table (`compare-arms.mjs`). Entry point: `docs/benchmarks/agent-eval-feedback-metrics.md`. Reading them: `Read a file we returned` is an allocation miss, `Read a file we did NOT return`/`Grep` is recall; allocation efficiency is **relative** (attribution is by citation) so it is only valid between builds on the same question; occupancy *shares* are Claude Code / 200k and don't transfer to another host — the arm ratio does.
   - **The `codegraph` CLI is blocked in every arm** (`no-cli-shim.sh`: sanitized PATH + a PreToolUse hook, shared by both harnesses). Without it 14 of 15 without-arm runs in one 7-repo pass reached codegraph through Bash. Check the contamination row before believing any number: `CLI calls that RETURNED output` > 0 invalidates the run (in a new-vs-baseline A/B it silently drops calls from all three metrics, since a CLI explore is not a tool call).
   - **Model policy — every A/B arm runs Claude with `--model sonnet --effort high`. Always. Never Opus/Fable.** All `scripts/agent-eval/*.sh` default to this (`MODEL`/`EFFORT` env override exists — don't raise it without an explicit reason from the maintainer). Two reasons, and the second matters more than cost: (a) Sonnet doesn't burn tokens; (b) **Sonnet is the deliberate floor model** — codegraph's real users attach it to whatever agent they already run (Cursor Composer, Gemini, etc.), so we validate on a "dumber" model on purpose: a stronger model's tool-use covers up the salience/sufficiency problems a weaker one exposes. An affordance that lands on Sonnet generalizes up to every host; one that only works on Opus/Fable doesn't generalize down to the agents most users actually have. Both arms always use the same model.
   - **MCP attach is a startup-latency issue, not a hard block.** On a multi-step task the agent dives into Read/grep before codegraph finishes its ~2-3s startup (worse when the eval is itself run nested inside a Claude session, under CPU contention), so it runs with no codegraph. Fix: **pre-warm a persistent daemon** for the target (`CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS` high; spawn `serve --mcp --path <target> </dev/null &`; wait for `.codegraph/daemon.sock`) **and skip the startup re-exec** (`CODEGRAPH_WASM_RELAUNCHED=1`) so claude connects before the agent's first turn. Don't trust claude's `init` snapshot — it can read `status:"pending"` / 0 tools even when it then connects; judge by actual codegraph usage in `parse-run.mjs`'s `by type`. To isolate a change — **new-build vs baseline-build, both codegraph-on** (vs run-all.sh's with-vs-without) — use `scripts/agent-eval/ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]` (it bakes in the pre-warm).
4. **Pass bar:** a normal flow question reaches **~0 Read/Grep within the repo's explore-call budget**, runs **faster** than without-codegraph, and shows **no regression on a control repo**. Record the numbers in `docs/design/dynamic-dispatch-coverage-playbook.md` (the coverage matrix).

Full playbook + per-mechanism design: `docs/design/dynamic-dispatch-coverage-playbook.md` and `docs/design/callback-edge-synthesis.md`.

### Worked example — Excalidraw (TS/React, medium, 643 files)

The template to replicate per language/framework. Question: *"how does updating an element re-render the canvas on screen?"* (the full flow crosses three React boundaries: observer callback, `setState`→`render`, and JSX child).

| Stage | duration | Read | Grep | codegraph |
|---|---|---|---|---|
| Without codegraph | 115–139s | 9–10 | 10–11 | 0 |
| Broken (explore-budget regression) | 131–139s | 5–10 | 3–5 | 6–14 |
| Fixed (budget + msgs + synthesis) | 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first steering | **51–74s** | **0–2** | 0–4 | **3–4** |

n=4 unhooked runs/stage, same prompt. After steering flow questions to `codegraph_trace` first: **best run 0 Read / 0 Grep / 3 codegraph / 51s**; **2 of 4 fully clean** (0 Read, 0 Grep). Steering eliminated the over-drill variance — call count tightened from 3–10 to 3–4, trace adoption went 3/4 → 4/4, and the `search`+`callers` path-reconstruction floundering dropped to 0. Run-to-run variance is still real; report the range, never a single run. **Residual reads/greps are all the nonce data-flow** (`canvasNonce` — a local prop with no graph edges); that's the def-use/data-flow frontier, left deliberately uncovered (tracking every local would explode the graph). Validated: `trace(mutateElement, renderStaticScene)` connects in **6 hops** across all three boundaries (`mutateElement → triggerUpdate → [callback] triggerRender → [react-render] render → [jsx] StaticCanvas → renderStaticScene`), each hop showing inline source + the wiring site; node count stable at 9,289; 1 callback + 46 react-render + 280 jsx-render synthesized edges (no explosion, precision-checked).


Also see: `docs/design/dynamic-dispatch-coverage-playbook.md`, `docs/design/callback-edge-synthesis.md`, `docs/benchmarks/call-sequence-analysis.md`, `docs/benchmarks/agent-eval-feedback-metrics.md`.
