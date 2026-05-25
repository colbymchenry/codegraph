# Answer directly vs. delegate to an Explore agent (interactive A/B)

**Question:** Does answering a "how does X work?" question *directly* with CodeGraph in the
main session bloat main-session context — and would Claude Code be better off delegating that
exploration to a disposable **Explore agent** (which keeps main context lean by absorbing the
file reads in a sub-transcript)? And critically: **does the answer change at scale**, on a
codebase far larger than Excalidraw?

**Short answer:** No. With CodeGraph, main-session context is roughly **scale-invariant (~50k)**
because the retrieval is targeted and the `explore` payload is budget-capped — it does not
balloon on a 16× larger repo. Answering directly wins at **every** scale: same-or-leaner main
context than the delegation path, **zero file reads**, and ~28% fewer tokens. The
delegation-for-hygiene advantage stays marginal even on a large codebase.

## Methodology

- **Harness:** interactive Claude Code TUI driven via `scripts/agent-eval/itrun.sh` (tmux),
  **not** headless `claude -p`. This matters: headless spawns **0** Explore agents, so it cannot
  measure delegation behavior at all; only the interactive TUI does.
- **Arms:** `WITH` = CodeGraph in the MCP config; `WITHOUT` = empty MCP config (`--strict-mcp-config`).
- **Model:** `opus`. **n = 3 runs per arm.** Main **and** sub-agent transcripts parsed
  (`scripts/agent-eval/parse-session.mjs`); reads/bash are summed across main + sub-agents.
- **Repos:** Excalidraw (643 files, medium) and VS Code (~10.7k files, large — ~16× Excalidraw).
- **Build:** 0.9.4. **Date:** 2026-05-24.
- "main-session context" is the TUI's reported `Context X/Y` for the *main* thread (sub-agent
  context does not count against it). "billable tokens" = summed per-turn assistant usage
  (input + output + cache read + cache creation).

## Excalidraw (643 files, medium)

Question: *"How does Excalidraw render and update canvas elements?"*

| metric | WITH codegraph | WITHOUT |
|---|---|---|
| Explore agents spawned | 0 / 0 / 0 | 0 / 1 / 1 (delegated 2 of 3) |
| main-session context | 51k / 49k / 50k (~50k) | 48k / 34k / 26k (~36k) |
| total tool calls | 4 / 4 / 4 | 16 / 55 / 37 |
| Reads (main+sub) | 0 / 0 / 0 | 6 / 25 / 16 |
| billable tokens | ~127k | ~175k |

## VS Code (~10.7k files, large — ~16× Excalidraw)

Question: *"How does the extension host communicate with the main process?"*

| metric | WITH codegraph | WITHOUT |
|---|---|---|
| main-session context | 47k / 43k / 50k (~47k) | 54k / 29k / 31k (~38k) |
| Explore agents | 0 / 0 / 0 | 0 / 1 / 1 (delegated 2/3) |
| codegraph calls | ~8 (search + explore×2–3 + context) | 0 |
| Reads (main+sub) | 0 / 1 / 0 | 6 / 26 / 19 |
| billable tokens | ~126k | ~176k |

## Findings

**Main-session context is scale-invariant with CodeGraph.** With codegraph, main-session
context was **~47k on VS Code — essentially identical to Excalidraw's ~50k**, despite a 16×
bigger repo. It didn't balloon. Reason: codegraph's `explore` payload is **budget-capped** and
retrieval is **targeted** — answering one question pulls in the relevant *flow/area*, not more
just because the repo is huge. So codegraph makes main-session context roughly scale-invariant
(~50k). The delegation-for-hygiene advantage stays marginal even on a large codebase — exactly
the opposite of "it gets significant at scale."

The thing that *would* balloon at scale is reading many big files directly into main — and
Claude Code avoids that **without** codegraph by delegating to an Explore agent (29–31k main),
but at the cost of **17–26 reads** and ~28% more tokens. CodeGraph keeps main lean a *better*
way: a capped, targeted payload — no delegation, **0 reads**.

**On "the Explore agents use codegraph."** I couldn't reproduce it: across **6/6**
with-codegraph runs (both repos), Claude Code **never delegated** — it answered directly every
time. The Explore-agent path only appeared in the `without` arm (using grep/read, since codegraph
wasn't in that config). So with the current instructions + codegraph present, Claude Code stays
in the main session — the lean-main-via-Explore-agent best case simply isn't what happens;
lean-main-via-capped-codegraph is, and it's cheaper.

## Verdict

**"Answer directly with codegraph" wins for Claude Code too — at every scale.** No per-agent
split is needed; the unified "answer directly" instruction is right for Claude Code *and* for
Codex / Cursor / opencode (which have no Explore-agent mechanism and would otherwise read files
directly). This conclusion drove updating the README's `## CodeGraph` example block, which
previously told agents to "NEVER call `codegraph_explore` directly / ALWAYS spawn an Explore
agent" — i.e., it steered Claude Code toward the *worse* (17–26 read, ~28%-more-token) path.

**Caveat / future work (not a blocker):** an Explore agent that *itself uses codegraph* could in
principle get lean-main *and* low-work. But the "answer directly" instruction prevents delegation
in practice (0 delegations observed across 6 runs), the main-context gain would be marginal
(~50k → ~30k, both a few percent of a 1M window), and it adds a sub-agent round-trip. Worth a
future experiment, not a default.
