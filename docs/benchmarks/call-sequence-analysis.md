# Call-sequence analysis — why read savings don't convert to wall-clock

**Date:** 2026-05-23 · **Branch:** `architectural-improvements` · **Source data:** the surviving
stream-json logs from the A/B matrix (`/tmp/ab-matrix/<Cell>/run-headless-{with,without}.jsonl`,
37 cells × 2 arms). Re-mined — **no re-runs** — with `scripts/agent-eval/seq-matrix.mjs`.

## Why this exists

The [A/B matrix](codegraph-ab-matrix.md) showed codegraph cuts **reads 75%** but **wall-clock only
~16%**, and 63% of the wall-clock win comes from just 3 large-repo cells. Reads are at the floor
(~0), so the remaining wall-clock is **round-trips + the synthesis turn** — neither of which read
count can explain. The matrix records tool *counts*, not the call **sequence** or per-call
**payload size**. This analysis recovers both, to find where the wall-clock actually goes.

## TL;DR — the bottleneck is trace ADOPTION, not trace completeness

1. **Trace is called in 3 of 37 cells** — even though every question is a canonical flow question
   ("trace the controller → service → repository", "how does X reach Y"). The agent overwhelmingly
   reaches for **`context → search → search → explore`** instead — the exact path-reconstruction
   anti-pattern the instructions tell it to avoid.
2. **`explore` averages 17.9K chars/call; `trace` averages 0.8K** — a **22× payload difference**.
   The path-scoped tool that solves the small-repo-bloat problem exists and is tiny. It's just not
   being invoked.
3. **Small repos still get bloated payloads** because of the explore-default: a **6-file** repo
   (`flutter_module_books`) pulls **17.4K**; a 10-file repo pulls 18.0K. This is precisely the
   "too much context on small codebases" failure mode — happening right now, via explore.
4. **Round-trips are 25% fewer with codegraph (283 vs 375 turns)** but wall-clock is only 16%
   faster — because the with-arm's turns each carry a ~18K explore payload, inflating TTFT and
   eroding the turn savings.
5. **Root cause:** `src/mcp/server-instructions.ts` leads with *"answer directly … `codegraph_context`
   first, then ONE `codegraph_explore`"* as the headline pattern. The trace-first guidance is buried
   in a table + a chain list below it. Agents anchor on the prominent headline → context→explore.

**Decision:** the next experiment is **trace-first steering / adoption**, not enriching trace. We
can't evaluate trace's completeness when it's used 3/37 times. Get adoption up first, then measure
whether the residual `node`/`explore` follow-ups need a richer trace.

## Finding 1 — trace adoption: 3/37

| metric | value |
|---|---|
| flow-question cells | 37 (all of them) |
| cells that called `codegraph_trace` | **3** (`cpp-leveldb`, `excalidraw`, `c-redis`) |
| dominant pattern instead | `context` → `search`×N → `explore` |

The 3 trace cells, and what followed the trace call:

| repo | files | cg sequence | turns (with/without) |
|---|--:|---|---|
| cpp-leveldb | 134 | `trace, node, node` | 5 / 8 |
| excalidraw | 643 | `context, trace, trace, explore` | 6 / **19** |
| c-redis | 884 | `context, trace, explore, node` | 10 / 15 |

Even when trace *is* used, the agent follows it with `node`/`explore` to fetch bodies — so a
secondary lever (after adoption) is making one trace call self-sufficient enough to kill those
follow-ups. But that's step 2.

## Finding 2 — payload size: path-scoped trace (0.8K) vs breadth-scoped explore (17.9K)

Across all cells, per codegraph tool — call count and **average payload per call**:

| tool | calls | avg/call | total |
|---|--:|--:|--:|
| `explore` | 32 | **17.9K** | 573K |
| `context` | 36 | 4.3K | 156K |
| `search` | 39 | 1.3K | 50K |
| `files` | 5 | 3.4K | 17K |
| `node` | 19 | 2.0K | 38K |
| `trace` | 4 | **0.8K** | 3.4K |

`context` (used in 36/37 cells) is the default opener; `explore` is the default closer. Together
they are the ~22K breadth dump. `trace` — the tool that would replace that with the actual path —
is 22× smaller and barely used. This is the user's premise confirmed in numbers: explore is
breadth-scoped (returns the neighborhood), trace is path-scoped (returns the line).

## Finding 3 — payload grows with repo size, and over-returns on small repos

With-arm **total** codegraph payload by repo-size tier:

| tier | cells | avg total payload | range |
|---|--:|--:|--:|
| S (<200 files) | 19 | 12.7K | 3.0–31.2K |
| M (<2000) | 9 | 32.4K | 5.4–58.2K |
| L (≥2000) | 9 | 34.0K | 20.2–43.1K |

The small-repo waste is concrete — these all have a 2–3 file flow but pull a full neighborhood:

| repo | files | with-arm payload | sequence |
|---|--:|--:|---|
| flutter_module_books | 6 | 17.4K | `context, explore` |
| computer-database | 10 | 18.0K | `context, search, status, explore` |
| aspnet-realworld | 78 | 22.2K | `context, explore` |
| django-realworld | 44 | 14.8K | `context, explore` |

`explore`'s per-call budget is already adaptive (#185), but it doesn't help here because the agent
isn't choosing the path-scoped tool — it's choosing breadth.

## Finding 4 — round-trips, and the ToolSearch tax

| metric | with | without |
|---|--:|--:|
| total turns (37 cells) | 283 | 375 |
| avg turns / cell | 7.6 | 10.1 |

25% fewer turns, but only ~16% faster wall-clock — the gap is the per-turn cost of the big explore
payloads. Also: **every with-arm run opens with a `ToolSearch` round-trip** (MCP tools are deferred
in this harness), a fixed 1-turn tax before any codegraph call. Worth confirming whether the
production install defers codegraph tools the same way.

## Conclusion → the experiment to run next

Measure-first changed the plan. The hypothesis was "enrich trace so one call is self-sufficient."
The data says trace is **used 3/37 times**, so completeness is moot until adoption is fixed.

**Experiment: trace-first steering A/B.**
- **Change:** rewrite the `server-instructions.ts` headline so a *flow* question (how does X reach Y
  / trace / from→to) routes to `codegraph_trace` **first**, demoting the context→explore pattern to
  non-flow/onboarding questions. Mirror into `instructions-template.ts` + `.cursor/rules/codegraph.mdc`.
- **Metric:** trace-adoption rate (target ≫ 3/37), with-arm total payload (expect ↓ sharply,
  especially small repos), turns (expect ↓), wall-clock (expect the 16% gap to widen toward the
  25% turn gap as 18K explore payloads are replaced by <1K traces).
- **Control:** a non-flow "what's the deal with module X" question must still go context→explore —
  don't over-steer everything to trace.
- **Then, step 2:** with adoption up, measure the `node`/`explore` follow-ups after trace
  (cpp-leveldb/excalidraw/c-redis all had them). If they're frequent, enrich trace (per-hop body
  snippet, capped per hop) so one trace call ends the flow investigation.

## Reproduce

```bash
node scripts/agent-eval/seq-matrix.mjs            # regenerates every table above from /tmp/ab-matrix
```

---

# Ablation experiment — do `context`, `explore`, and `trace` compete? Is `trace` enough?

**Date:** 2026-05-23 · 52 runs, ~$20. Tool surface trimmed **server-side** via the new
`CODEGRAPH_MCP_TOOLS` allowlist (so an ablated tool is genuinely absent from ListTools, not
denied-on-call); trace-first steering injected with `--append-system-prompt`. 6 repos (2 S / 2 M /
2 L) × 2 runs; arm E is a **non-flow** survey question on 2 repos. Driver `arms-matrix.sh`,
analysis `parse-arms.mjs`.

| arm | tools | steering | adoption | reads | cgOut | turns | dur |
|---|---|---|--:|--:|--:|--:|--:|
| **A** control | all | none | 2/12 | 1.25 | 28.8K | 7.6 | 38s |
| **B** steer | all | trace-first | **8/12** | 1.00 | **32.0K** | 7.9 | 43s |
| **C** no-explore | hide explore | trace-first | 8/12 | **2.08** | **9.2K** | 9.0 | 44s |
| **D** trace-centric | hide explore+context | trace-first | 8/12 | 2.00 | 6.6K | 10.5 | 46s |
| **E** control-probe | hide explore+context | trace-first | 0/4 | 2.50 | 27.8K | **20.0** | **72s** |

## What it says

1. **Steering works for adoption, not for payload.** B lifted trace use **2/12 → 8/12** (and 4/4 on
   the genuinely path-shaped questions — the 2 non-adopters, flutter "what widgets" and vapor "name
   the route", aren't from→to questions). But B's payload (32.0K) is *bigger* than control (28.8K)
   and it's slightly slower — because the agent calls trace **and still calls explore**. Steering
   adds a trace hop without displacing the explore dump.
2. **`explore` is the payload, and it's load-bearing — but 3–5× too heavy.** Removing it (C) cuts
   payload **71%** (32K→9.2K) — confirming it's the bloat. But reads **double** (1.0→2.1) and turns
   rise: the agent Reads files to recover the bodies explore had inlined. So explore isn't
   redundant; it's the only one-call body-supplier, just delivered with a 32K sledgehammer.
3. **`context` is the most redundant of the three — as a body-supplier.** Removing it on top of
   explore (D vs C) left reads flat (2.08→2.00) but raised turns (9.0→10.5). It supplies no unique
   bodies; it earns its keep only as a round-trip-saver (the composed orient call).
4. **Removing tools makes flow questions SLOWER, not faster.** Turns climb monotonically
   A→D (7.6→10.5) and duration with them — the Read + trace-follow-up round-trips cost more
   wall-clock than the saved payload. Leaner payload ≠ faster.
5. **`trace` is definitively NOT sufficient.** The non-flow probe (E) thrashed without the survey
   tools — **20 turns, 72s** reconstructing an overview from search/node/files. Survey questions
   need a survey tool; trace can't substitute.

## Verdict on the three design questions

- **Do we need all three?** Yes — but for different reasons. trace = flow tool (real, under-adopted).
  explore = the one-call body-supplier (load-bearing, over-heavy). context = round-trip-saving
  opener (redundant for bodies, useful for orientation).
- **Are they competing?** Yes: explore competes with trace and *wins by default* — even when steered,
  the agent traces **and** explores, so the payload win never lands until explore is displaced.
- **Could trace be all we need?** No. E rules it out for non-flow questions; C/D rule it out even
  for flow (reads double without explore's bodies).

**Three cheap fixes are now ruled out by data:** "trace is all we need" (false), "just steer to
trace" (B: slower + bigger than control), and "remove explore" (C/D: more reads/turns, slower).

## The fix the data points to → next experiment

The only path that wins: **make `trace` self-sufficient by inlining per-hop bodies** (capped per
hop → still path-scoped) so one trace call supplies what explore does *and* what the Read fallback
recovers — displacing both for flow questions. Keep **one** survey tool (context; demote explore to
deep-survey, not the flow default) for the non-flow class E proved is load-bearing.

- **Experiment:** enriched body-inlining `trace` + steering vs control.
- **Target:** C/D's lean payload (~7–9K, not 32K) **without** C/D's extra reads/turns, and **beat A
  on wall-clock** (the bar B/C/D all failed).
- **Metric:** payload, reads (must stay ≈ A's ~1.0, not rise to 2.0), turns, duration.

## Reproduce (ablation)

```bash
bash scripts/agent-eval/arms-matrix.sh     # 52 runs into /tmp/arms (RUNS=2 default)
node scripts/agent-eval/parse-arms.mjs     # the arm-comparison tables above
```

---

# Validation — body-inlining trace (arm F)

The ablation pointed to one fix: make `trace` self-sufficient by inlining per-hop **bodies**
(capped per hop → still path-scoped) so one trace call displaces both the explore dump and the
Read fallback. Implemented in `handleTrace` (`sourceRangeAt`, 28 lines / 1200 chars per hop, with a
`… (+N more lines)` marker). Arm **F** = arm B's surface (all tools + trace-first steering) run on
the body-inlining build, so **F vs B isolates the enrichment**.

| arm | adoption | reads | cgOut | turns | dur | cost |
|---|--:|--:|--:|--:|--:|--:|
| A all/none | 2/12 | 1.25 | 28.8K | 7.6 | 38s | $0.390 |
| B all/steer (thin trace) | 8/12 | 1.00 | 32.0K | 7.9 | 43s | $0.411 |
| **F all/steer (body trace)** | 5/12 | **1.17** | **25.1K** | **6.8** | **37s** | **$0.348** |
| C no-explore | 8/12 | 2.08 | 9.2K | 9.0 | 44s | $0.356 |
| D trace-centric | 8/12 | 2.00 | 6.6K | 10.5 | 46s | $0.368 |

**F is the best-balanced arm:** lowest turns (6.8), fastest (37s), cheapest, payload leaner than
A/B — and it hits the target the ablation set: **C/D-class efficiency without C/D's Read penalty**
(F reads 1.17 vs C/D's ~2.0). It gets there not by *removing* a tool but by giving the agent a
complete trace so it *stops early*.

**The win is clearest where trace connects** — excalidraw (the validated 6-hop path):

| arm | sequence | turns | reads | dur |
|---|---|--:|--:|--:|
| B (thin) | `trace → context → explore → Grep → Read` | 7 | 1 | 47s |
| **F (body) r1** | `trace → context` | **4** | **0** | **31s** |
| F (body) r2 | `trace → trace → explore` | 5 | 0 | 42s |

The body-trace ended the investigation in `trace → context` (run 1) — 0 reads, 0 grep, 0 explore.

**Connectivity is the cap.** On flows that break at *unbridged* dynamic dispatch — aspnet-realworld
(MediatR `_mediator.Send → Handle`), vapor-spi (closure routing) — trace returns "no path" and the
agent falls back to explore, so F ≈ B (no regression, no gain). F's aggregate lift is therefore
**gated by dynamic-dispatch coverage**: the more flows the graph connects end-to-end, the more often
the self-sufficient trace fires. (n=2/arm — adoption and per-repo numbers are noisy; excalidraw and
spring-halo, the connecting repos, are 2/2 trace in both B and F.)

## Verdict & ship list

1. **Ship the body-inlining trace** — strict improvement (best-balanced arm; clean 0-read/4-turn win
   on connecting traces; no regression on non-connecting ones).
2. **Strengthen the steering.** Arm A (shipped server-instructions, which *already* say "trace first
   for flow") adopted trace only 2/12 — the guidance is too buried. The explicit
   `--append-system-prompt` used in B–F lifted it. Port that into `server-instructions.ts` +
   `instructions-template.ts` + `.cursor/rules/codegraph.mdc` (house rule: all three together),
   flow-gated so non-flow survey questions still go context/explore (arm E proved they must).
3. **Next frontier to widen F's reach:** bridge more dynamic dispatch (MediatR/.NET, Vapor routing) —
   every newly-connected flow converts an F≈B repo into an F-win repo.

## Reproduce (arm F)

```bash
bash scripts/agent-eval/arms-F.sh          # 12 runs (RUNS=2); needs the body-inlining build
node scripts/agent-eval/parse-arms.mjs     # F appears alongside A/B/C/D/E
```

---

# Steering port — the negative result (arm G)

F's win used `--append-system-prompt`, which real users don't get. Arm **G** = arm A's invocation
(NO append-prompt) on a build where the steering was ported into the production channels
(`server-instructions.ts` + the `context`/`trace` tool descriptions + `instructions-template.ts` +
`.cursor/rules`). Three wording iterations, 12 runs each:

| arm | adoption | reads | payload | turns | dur |
|---|--:|--:|--:|--:|--:|
| A (shipped instructions) | 2/12 | 1.25 | 28.8K | 7.6 | **38s** |
| F (body-trace + append-prompt) | 5/12 | **1.17** | 25.1K | 6.8 | **37s** |
| G v1 — anti-explore wording | 6/12 | 2.08 | 13.8K | 8.8 | 46s |
| G v2 — restore explore as fallback | 6/12 | 1.67 | 22.0K | 7.8 | 46s |
| G v3 — restore context as opener | 6/12 | 2.08 | 11.7K | 8.9 | 46s |

**Production-instruction steering does not reproduce F, and regresses the A baseline.** All three G
variants pin at **~46s** (slower than A's 38s and F's 37s) with reads at 1.7–2.1 (vs A 1.25, F 1.17).
Wording only shuffled the slack between Read and explore — v1 suppressed explore → Read; v2/v3
restored explore → over-investigation — never landing F's lean `trace → context`.

**Two root causes:**
1. **Salience.** The same trace-first wording works as a top-of-prompt `--append-system-prompt` (F)
   but not as an MCP `initialize` instruction / tool description (G). An MCP server has no
   higher-salience channel — this is an architectural limit, not a wording bug.
2. **Forcing trace-first backfires where trace doesn't connect.** Steering pushed trace onto
   MediatR (`_mediator.Send`) and Spring interface-DI (`@Autowired` iface → impl) flows, where trace
   returns no-path; the forced trace is then a wasted round-trip *before* the fallback → slower.
   The **unsteered** agent (A) is better-calibrated: it traces only when trace will obviously
   connect (2/12) and explores otherwise.

## Arm H — body-trace alone (the ship candidate) regresses

The clean ship test: body-inlining trace + ORIGINAL instructions + no steering (= A's invocation,
only the trace *tool* changed). H vs A isolates the body-trace feature with nothing else moving.

| arm | adoption | reads | payload | turns | dur |
|---|--:|--:|--:|--:|--:|
| A (no body-trace) | 2/12 | 1.25 | 28.8K | 7.6 | **38s** |
| H (body-trace, no steering) | 3/12 | 1.50 | 29.7K | 8.0 | **45s** |
| F (body-trace + append-prompt) | 5/12 | 1.17 | 25.1K | 6.8 | 37s |

**Body-trace alone does NOT beat A — it mildly regresses** (45s vs 38s). The sequences show why:
unsteered, the agent treats trace as just one more call in its usual loop — excalidraw H was
`context → trace → explore → node×3 → Grep → Read` (77s) — so the bigger body-trace payload is pure
added cost, not offset by fewer follow-ups. The body-trace only pays off when the agent **leads with
trace and stops after it**, which only the append-prompt (F) achieved.

## Final verdict

The body-inlining trace is a real win (F) but its value is **entirely contingent on
lead-with-and-stop-after-trace steering we cannot deliver through any production MCP channel**
(append-prompt salience ≫ server-instructions / tool-descriptions; G failed three times). On its own
(H) it regresses. So:

- **SHIP: the `CODEGRAPH_MCP_TOOLS` allowlist** — independent, clean, validated.
- **DON'T ship the body-inlining trace or the steering as-is** — measured neutral-to-negative
  without a steering channel we don't have.
- **The real lever is connectivity, not steering** — trace earns its keep only when flows connect
  end-to-end; dynamic-dispatch synthesizers (MediatR/.NET, Spring interface-DI, Vapor closures) help
  the *unsteered* agent, which already traces when trace will connect.
- **One untested lever** to rescue the body-trace: steer via the trace tool's OWN OUTPUT (the
  highest-salience channel — the agent reads it fresh, right at the decision point) with a strong
  leading "complete flow — answer from this, don't explore" banner. Instructions/descriptions are
  too far from the action; the tool result is not. Unproven; the only remaining shot at making the
  body-trace pay off in production.

measure-first paid off three times: it killed three cheap fixes in the ablation, stopped a steering
change that would have shipped an ~8s/query regression (G), and stopped shipping the body-trace
itself on a confounded assumption (H showed it needs steering we can't deliver).

## Reproduce (arm G)

```bash
ARM=G bash scripts/agent-eval/arms-F.sh    # production-instruction steering, no append-prompt
node scripts/agent-eval/parse-arms.mjs
```

---

# Arm I — sufficiency, not steering (the shippable win)

An LLM stops investigating when its context is *sufficient*, not when it's told to stop. So arm I
makes the trace OUTPUT complete instead of steering — same invocation as H (original instructions,
**no steering**), only the trace tool changed:
1. **Hop bodies no longer clipped** at 28 lines (that clip is why H re-fetched `mutateElement`).
2. **The destination's own callees are inlined** — the "last mile" the agent otherwise explores/Reads
   for (excalidraw: `renderStaticScene → _renderStaticScene / renderStaticSceneThrottled`).

| arm | adoption | reads | greps | payload | turns | dur | cost |
|---|--:|--:|--:|--:|--:|--:|--:|
| A baseline | 2/12 | 1.25 | 1.17 | 28.8K | 7.6 | 38s | $0.390 |
| H body-trace alone | 3/12 | 1.50 | 0.42 | 29.7K | 8.0 | 45s | $0.398 |
| **I body-trace + dest callees** | 2/12 | **1.17** | **0.25** | 27.2K | **7.0** | 39s | **$0.359** |
| F body-trace + append-steer | 5/12 | 1.17 | 0.17 | 25.1K | 6.8 | 37s | $0.348 |

**I ≥ A on every axis** (reads, greps, turns, cost down; wall-clock flat) and **≈ F on outcomes with
zero steering** — despite *lower* trace adoption (2/12 vs F's 5/12). The destination-callees fix
turned the body-trace from a net-negative (H, 45s) into a net-positive (I, 39s): one richer trace
call now displaces the explore+node+Read follow-ups it used to trigger. excalidraw I-r2 was
`context → trace → explore` — **0 reads, 5 turns**, stopped because the data was present. The residual
reads (I-r1) are the `canvasNonce` data-flow — the def-use frontier the graph deliberately omits.

This confirms the thesis: **completeness stops the agent; steering doesn't.** Every steering arm
(B/F append-prompt, G instructions) was either unshippable or a regression; the sufficiency arm (I)
ships and needs no steering.

## Revised final verdict (supersedes the arm-G/H verdict above)

- **SHIP: body-inlining trace + destination callees** (arm I) — ≥ A on all axes, no steering, no
  regression; makes the self-sufficient-trace property real (one trace call answers the flow).
- **SHIP: the `CODEGRAPH_MCP_TOOLS` allowlist** — independent, validated.
- **DON'T ship steering** (instructions or tool descriptions) — three variants regressed; MCP can't
  deliver append-prompt salience, and forcing trace where it doesn't connect backfires.
- **Connectivity is the multiplier** — arm I helps most where the trace connects; MediatR/.NET,
  Spring interface-DI, and Vapor closures are the next synthesizers, and they help the *unsteered*
  agent (which already traces when trace will connect).

## Reproduce (arm I)

```bash
ARM=I bash scripts/agent-eval/arms-F.sh    # body-trace + destination callees, no steering
node scripts/agent-eval/parse-arms.mjs
```

---

# Current-build with/without A/B — the 7 README repos (2026-05-24)

Re-ran the published README benchmark on the **current build** (all 7 repos freshly reindexed),
same queries, **median of 4 runs/arm** (headless: codegraph-only MCP vs empty MCP):

| repo | time with→without | tools w→wo | tokens w→wo (saved) | cost w→wo (saved) |
|---|---|--:|--:|--:|
| vscode | 1m10s→2m26s | 8→55 | 601k→2.8M (78%) | $0.60→$0.80 (26%) |
| excalidraw | 48s→2m58s | 3→79 | 344k→3.5M (90%) | $0.43→$0.90 (52%) |
| django | 1m19s→1m38s | 9→19 | 739k→1.2M (36%) | $0.59→$0.67 (12%) |
| tokio | 53s→3m2s | 4→53 | 379k→2.6M (86%) | $0.42→$2.41 (82%) |
| okhttp | 42s→1m1s | 6→11 | 636k→730k (13%) | $0.47→$0.47 (2%) |
| gin | 44s→1m0s | 6→10 | 444k→675k (34%) | $0.37→$0.47 (21%) |
| alamofire | 1m17s→2m27s | 12→69 | 1.0M→2.8M (64%) | $0.61→$1.14 (47%) |

**Average saved: 35% cost · 57% tokens · 46% time · 71% tool calls** — reproduces the published
README headline (35% / 59% / 49% / 70%); the current build holds the benchmark with no regression.

**Cost is lower, not "flat"** (corrects the earlier note). But the **mechanism is volume, not
cache-ability**: codegraph answers in far fewer turns over a much smaller accumulated context, while
the without-arm fans out across many more turns (55–79 tool calls on the big repos), each
re-processing a large, growing context. The without-arm's token volume is *mostly* cheap cache-reads,
which is why **token-count savings (57%) look bigger than cost savings (35%)**. Per-repo margin tracks
how hard the without-arm thrashes that run (tokio blew up to $2.41/3m; django thrashed less).

**Measurement gotcha:** `result.usage` in this Claude Code version is the **last turn only**, not
cumulative — using it under-counts tokens badly (an earlier excalidraw cut reported "−34% tokens"
off this bug; the real figure is ~90%). Sum **per-turn assistant `usage`** for the true total.
`total_cost_usd` and `duration_ms` are already cumulative/correct.

Reproduce:
```bash
bash scripts/agent-eval/bench-readme.sh      # 7 repos × with/without × 4 runs (RUNS=4) → /tmp/ab-readme
node scripts/agent-eval/parse-bench-readme.mjs   # medians + % saved (summed per-turn tokens)
```
