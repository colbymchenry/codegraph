# CodeGraph AI offload — accuracy & adoption eval harness

Measures the managed **offload** (`codegraph_explore` → reasoning model synthesis) and the
**front-load hook** (approach 1) against plain codegraph and no-codegraph, across repo sizes,
on **time · main-session tokens/cost · CodeGraph-AI tokens/cost · accuracy**.

All agent arms run `claude -p --model sonnet --effort high` (the deliberate floor model — an
affordance that lands on Sonnet generalizes up). Everything writes to a scratch dir
(`AGENT_EVAL_OUT`, default `/tmp/cg-offload-eval`); nothing here is shipped to users.

## Repos (selected via a memory-probe gate — NOT trained on)

Famous repos (express, excalidraw, n8n, …) are useless for *accuracy* evals: Sonnet answers their
flow questions from memory, so the no-codegraph baseline is dishonest. These four passed a no-tools
probe (Sonnet could not name their real flow internals) and are cloned fresh by `offload-eval-setup.sh`:

| tier | repo | ~src files | canonical flow |
|---|---|---|---|
| small | MTKruto/MTKruto | 322 TS | `sendMessage` → invoke → TL serialize → transport |
| medium | mvdicarlo/postybirb-plus | 608 TS | submission → queue → per-website `.post()` |
| complex | shapeshift/web | 3.2k TS (35-pkg monorepo) | swap → swapper registry → concrete swapper |
| large | trezor/trezor-suite | 8k TS monorepo | send-form → sign thunk → `@trezor/connect` |

Verified ground-truth flows (the judge's reference) live in `offload-eval-ground-truth.json`.

## Arms

- **offload** — codegraph + managed offload ON (requires `codegraph login`); records AI tokens/credits via `CODEGRAPH_OFFLOAD_USAGE_LOG`.
- **raw** — codegraph, `CODEGRAPH_OFFLOAD_DISABLE=1` (returns raw source).
- **nocg** — empty MCP config; Read/Grep baseline.
- **frontload** — codegraph (offload-disabled) + a `UserPromptSubmit` hook (`offload-eval-hook.mjs`) that runs raw explore on the prompt and injects the result into context (approach 1).

## Run it

```bash
npm run build                       # the harness shells out to dist/
codegraph login                     # only needed for the offload arm
export AGENT_EVAL_OUT=/tmp/cg-offload-eval

bash scripts/agent-eval/offload-eval-setup.sh            # clone + index the 4 repos
bash scripts/agent-eval/offload-eval-matrix.sh           # 3 arms × 4 tiers × REPS (default 3)
node scripts/agent-eval/offload-eval-judge.mjs \
     --results $AGENT_EVAL_OUT/results.jsonl \
     --truth  scripts/agent-eval/offload-eval-ground-truth.json \
     --out    $AGENT_EVAL_OUT/judged.jsonl
node scripts/agent-eval/offload-eval-summarize.mjs $AGENT_EVAL_OUT/judged.jsonl

bash scripts/agent-eval/offload-eval-frontload-matrix.sh # frontload arm + judge + merged summary
```

Single repo: `offload-eval-3arm.sh <indexed-repo> <tier> <reps> "<question>"` (or `-frontload.sh`).

## Files

- `offload-eval-setup.sh` — clone + index the 4 repos.
- `offload-eval-3arm.sh` / `-frontload.sh` — one repo, the arms.
- `offload-eval-matrix.sh` / `-frontload-matrix.sh` — drive all 4 tiers.
- `offload-eval-hook.mjs` — the front-load `UserPromptSubmit` hook (resolves its own engine; `CG_FRONTLOAD_DEBUG=<path>` to log injections; `CG_FRONTLOAD_BUDGET` to cap injected chars).
- `offload-eval-metrics.mjs` — one run's stream-json + usage log → one JSON metrics line.
- `offload-eval-judge.mjs` — Sonnet judge: end-to-end (agent final vs ground truth) + per-answer offload fidelity.
- `offload-eval-summarize.mjs` — per-tier, per-arm table + cross-repo roll-up.
- `offload-eval-ground-truth.json` — source-verified canonical flows.

## Findings (2026-06, n=3 — direction consistent, magnitudes noisy)

- **Raw codegraph is the efficiency win** — ~nocg accuracy, fewer reads, faster, no AI cost.
- **The offload is the least-accurate arm in all 4 tiers** — synthesized fidelity 12–27/100 with
  fabrication in 3/4 (e.g. invented website services; traced `ClientPlain`/`SessionPlain` instead of
  the real encrypted path). Its speed/cost win is narrow (medium-only) and inversely correlated with
  accuracy. **Use raw until offload fidelity is fixed.**
- **The front-load hook SOLVES adoption** — reads → 0–1 in every tier (incl. large, where the agent
  otherwise read 12–24 files); fired 12/12, 0 errors. Wins on medium/complex (100% pass). But it
  **regresses small/large to partial** — it suppresses the reads that compensate for explore's gaps at
  **dynamic boundaries** (async queues, redux thunks, facade/factory indirection).
- **Master lever for BOTH:** explore's dynamic-dispatch coverage. Fix it → front-load is complete
  everywhere and the offload has the full flow to synthesize.
