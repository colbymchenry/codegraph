# JEV / Clef modes: results and routing

**A2 always uses JEV. A1/A6 use Clef-flash and D1 uses Clef when verified free allowance covers the request. Otherwise they use JEV. Points with no demonstrated benefit keep the default heuristic.**

Benchmark: 2026-10-08 · TypeScript monorepo · 2,297 files (1,821 indexed) · 26,785 symbols · 59,055 edges. Before/after comparison: 325 fixed cases × 3 models across four decision points; 255 labeled cases and 70 uncertain cases excluded from accuracy.

## Benchmark

| Metric | Off | JEV | Hosted Clef | Hosted Clef-flash |
|---|---:|---:|---:|---:|
| Persisted graph accuracy / 170 sites | 147/170 (86.5%) | 164/170 (96.5%) | 162/170 (95.3%) | 162/170 (95.3%) |
| Actual context-gate accuracy / 85 prompts | 72/85 (84.7%) | 82/85 (96.5%) | 84/85 (98.8%) | 75/85 (88.2%) |
| Context-gate end-to-end latency, p95 | 345ms | 652ms | 1,212ms | 702ms |
| Additional API cost ceiling, same 325 cases¹ | $0 | $0.01587 | $0.08959 | $0.02772 |

![Graph and context-gate accuracy, gate latency, and API cost ceilings across four modes](assets/benchmark.svg?v=3)

¹ List-price estimates before free credits, excluding the agent's own costs. One Clef timeout fell back to the heuristic; its unreported usage was charged at the maximum input size for this estimate. Clef calls covered by the free allowance add no inference charge. These measurements predate automatic usage lookup; a cold lookup now adds up to 500ms within the existing decision deadline.

## What improved

| Correct outcomes | JEV | Clef | Flash |
|---|---:|---:|---:|
| Persisted graph / 170 sites | 162 → **164** | 161 → **162** | 162 → 162 |
| Context gate / 85 prompts | 80 → **82** | 80 → **84** | 73 → **75** |

- **A1/A6 input:** include the file opening, preserving multiline imports, plus up to nine lines around the reference to distinguish definitions with the same name.
- **D1 behavior:** a “no structural context needed” verdict with confidence ≥ 0.95 now stops later symbol checks from adding unnecessary context.
- **Selection:** compare stored edges, actual context injection, latency, and cost on the same cases. Expanded A2 input cost about 2.5× as much with no accuracy gain, so it was rejected. D1 keeps its original question.

See [implementation and validation details](improvements/README.md).

## Where to use each mode

The first four rows were revalidated in this benchmark; the remaining rows are earlier measurements. Routing considers both accuracy and actual feature latency.

| Decision point | Off | JEV | Clef | Flash | Verified free allowance | Exhausted or unknown |
|---|---:|---:|---:|---:|---|---|
| Same-name definition selection (A1) | 58/64 | 61/64 | 60/64 | **62/64** | **Clef-flash** | **JEV** |
| Unknown-receiver method linking (A2) | 28/42 | **40/42** | 39/42 | 37/42 | **JEV** | **JEV** |
| Unresolved-reference recovery (A6) | 61/64 | **63/64** | **63/64** | **63/64** | **Clef-flash** | **JEV** |
| Prompt context gate (D1) | 72/85 | 82/85 | **84/85** | 75/85 | **Clef** | **JEV** |
| Search intent (C2) | 15/15 | 15/15 | 15/15 | 15/15 | **Off** | **Off** |
| Required-file search recall (C3) | 94.4% | 91.7% | 94.4% | 94.4% | **Off** | **Off** |
| Low-confidence search guidance (C5) | 12/12 | 12/12 | 11/12 | 9/12 | **Off** | **Off** |
| Synchronous viewer latency² (F1) | **40ms** | 1,385ms | 4,111ms | 1,620ms | **Off** | **Off** |
| Dead-code classification³ (E1) | 67/73 | 67/73 | **71/73** | 68/73 | Off; deferred | Off; deferred |

² One cold request with five decisions per model and identical output, not average viewer latency. ³ Classification only; integration into the feature remains unvalidated. Other points without demonstrated benefit also remain off.

## Automatic usage checks

`CODEGRAPH_DECISIONS=auto` queries the account's Workers AI usage since **00:00 UTC**, including other applications and models. Cloudflare provides **10,000 free neurons per account per day**, including on Workers Paid. Beyond that allowance, paid accounts incur charges and free accounts require an upgrade. [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

| Check result | Behavior |
|---|---|
| `free`, with room for the full request reservation | Use the selected Clef model; A2 still uses JEV |
| `exhausted`, or insufficient room for the reservation | Use JEV |
| `unknown`: missing credentials, permission error, timeout, invalid data, or unavailable local quota store | Use JEV; report unknown allowance as `null`, not zero |
| Clef confidence below the point's threshold | Try JEV within the remaining deadline |
| No usable response or credentials, or deadline exhausted | Keep the heuristic |

Usage snapshots are shared locally for **30 seconds**, scoped to the account, token, and UTC day. In-flight reservations survive refreshes; successful requests settle against reported tokens, while requests with unknown usage keep their reservation. Old `CODEGRAPH_CF_FREE_NEURONS` / `CODEGRAPH_CF_FREE_DAY` settings are no longer used.

This is a conservative client-side check, not a provider-enforced spending cap. Analytics can lag or be sampled, and another application or machine can consume allowance after the check. Overlapping analytics and local accounting can switch to JEV early. JEV also has its own API cost. Explicit `cf` mode bypasses automatic routing and can incur Cloudflare charges. [Analytics sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

## Setup guide

1. Copy [`.env.example`](../../../.env.example) to `.env` in this checkout. Add your JEV key and, for hosted Clef, your Cloudflare account ID and API token. Keep `.env` out of Git; restrict its file permissions where supported.
2. In Cloudflare's **My Profile → API Tokens**, create or edit your Workers AI token. Retain its inference permissions and add **Account → Account Analytics → Read**, scoped to the same account. A new token needs Workers AI inference access as well, such as **Account → Workers AI → Edit**. Save the token summary. Permission changes may take a few minutes to take effect. [Analytics token guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)
3. Build with Node **22.5–24**, then check access without making an inference request:

```sh
npm run build
node --env-file=.env dist/bin/codegraph.js decision-status
```

The JSON reports `free`, `exhausted`, or `unknown`, observed usage, `checkedAt` (Unix milliseconds), available neurons after local accounting, and the current routes for A1/A2/A6/D1. `unknown` with `api_error` or `http_403` usually calls for checking the token's account scope and analytics permission. A successful token verification alone does not verify analytics access. For a timeout or a recent permission change, rerun after the 30-second cache expires.

D1 reports `off` until remote prompt transmission is explicitly enabled. The supported providers are JEV and hosted Clef/Clef-flash; the former local Clef server and its mode have been removed.

Minimal configuration:

```dotenv
CODEGRAPH_DECISIONS=auto
JEV_API_KEY=your_jev_api_key
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_workers_ai_and_analytics_token
# Opt in to sending user prompts to a remote model for D1:
CODEGRAPH_DECISION_ALLOW_REMOTE_PROMPTS=1
```

Automatic mode sends selected code snippets to remote models when precomputing A1/A2/A6. D1 requires the separate prompt opt-in above. Usage lookup sends only the account ID and time range.

### Shared .env for global commands and agents

Load the same file for every CLI, MCP server, and prompt hook using Node's [`--env-file`](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html#--env-fileconfig). Use absolute paths in agent settings; a project's working directory must not change which credentials are loaded. Existing process environment variables take precedence over values in the file.

A global `codegraph` launcher for this source build can contain:

```sh
#!/bin/sh
exec /absolute/path/to/node --env-file=/absolute/path/to/.env \
  /absolute/path/to/checkout/dist/bin/codegraph.js "$@"
```

Place the executable launcher on your `PATH`, or use the equivalent Node command in the agent's MCP configuration with `serve --mcp` appended. Preserve existing project arguments such as Cursor's `--path`. The D1 hook appends `prompt-hook`. Rebuild after source changes and reconnect running MCP clients so they load the new build. A package upgrade may replace a launcher installed under the same name.

Use one shared `CODEGRAPH_CF_USAGE_DB` across local processes; the default is `~/.codegraph/decision-usage.sqlite`. An optional `CODEGRAPH_DECISION_LEDGER` path records the selected backend and usage-check result without storing the prompt. Do not delete the quota database to restore allowance: that discards local reservations.

### Apply to a project

After configuring the global launcher and your agent, initialize each project once, then reconnect the agent in that project:

```sh
codegraph init /absolute/path/to/project --yes
codegraph decision-status
```

Skip `init` if the project already has a `.codegraph/` index. D1 runs live through Claude Code's configured `UserPromptSubmit` hook when remote prompts are enabled. Ordinary MCP queries, including Codex and Cursor queries, do not run that hook.

A1/A2/A6 use **record → precompute → re-index with overrides**. They require the following extra step; a normal `init` or `index` does not call these models. With the shared launcher above, run from any directory (use Node 22.5–24 for `codegraph_node`):

```sh
codegraph_checkout="/absolute/path/to/checkout"
codegraph_node="/absolute/path/to/node"
project_path="/absolute/path/to/project"
decision_run=$(mktemp -d "$project_path/.codegraph/decisions.XXXXXX")
: > "$decision_run/records.jsonl"

CODEGRAPH_DECISION_RECORD="$decision_run/records.jsonl" codegraph index "$project_path"
"$codegraph_node" --env-file="$codegraph_checkout/.env" \
  "$codegraph_checkout/scripts/decide-offline.mjs" \
  --records "$decision_run/records.jsonl" --root "$project_path" \
  --output "$decision_run/overrides.json"
CODEGRAPH_DECISION_OVERRIDES="$decision_run/overrides.json" codegraph index "$project_path"
```

Precomputation sends selected code snippets to the configured providers and can incur JEV charges. Generated files stay in the project's ignored `.codegraph/` directory. Use the same project-specific `CODEGRAPH_DECISION_OVERRIDES` value for later `index`, `sync`, or that project's MCP process to retain these decisions; regenerate them after code changes. Keep that path out of a shared `.env` used by other projects.

To return to the default graph, run `CODEGRAPH_DECISIONS=off CODEGRAPH_DECISION_OVERRIDES= codegraph index "$project_path"`. Set `CODEGRAPH_DECISIONS=off` in the shared `.env` and reconnect agents to disable remote decisions globally.

The checkout retains runtime features, regression tests, and these summarized results. Decision-mode evaluation scripts, raw datasets, and collectors with no runtime consumer have been removed. The recording and precompute commands above remain part of applying graph decisions.

These results use one fixed repository sample to select and revalidate the changes. Independent samples, overall edge accuracy, final coding-task success, and the end-to-end accuracy of the mixed routing policy have not been measured separately.
