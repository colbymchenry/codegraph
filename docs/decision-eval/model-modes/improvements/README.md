# JEV / Clef implementation and validation

[Back to results, routing, and setup](../README.md)

The measured improvements are **richer evidence for A1/A6** and **an effective context veto for D1**. The 2026-10-08 comparison used the same cases before and after the changes, checking persisted graph edges and the actual prompt hook. Automatic Cloudflare usage lookup was added afterward; the benchmark latency figures do not include that lookup.

## Decision requests

JEV, Clef, and Clef-flash receive evidence in `state` and typed questions with options in `questions`. A1/A6 select definitions to link; D1 decides whether a user request needs structural code context. “Off” means CodeGraph's normal heuristics with decision-model calls disabled.

The investigation checked both whether the input contained the necessary evidence and whether accepted model verdicts actually affected the feature.

Responses must match the requested type: probabilities and confidence are numeric values in `[0, 1]`, choices must be among the offered options, and scores must fit the supplied scale. A malformed response such as `noul: null` keeps the heuristic. Answer cache keys exclude entries created before this validation; Cloudflare usage accounting is preserved.

## A1/A6: evidence for definition selection

A1 chooses between definitions with the same name. A6 recovers unresolved references. Previously, the file opening was filtered to lines beginning with import-like syntax. Multiline imports could lose aliases or the final module path.

| Input | Before | Applied change |
|---|---|---|
| File opening | Up to 25 import-like lines from the first 60 lines, capped at 200 characters each | First 80 lines in order, capped at 4,000 characters total |
| Reference context | Two lines before/after, up to five lines | Four lines before/after, up to nine lines |
| Reference line length | Up to 240 characters | Unchanged |
| Definition candidates | Up to 32, with name, kind, file, line, and signature | Unchanged |
| Question and response interpretation | Existing definition-selection question | Unchanged |

The file opening includes other code as well as imports. This supplies aliases, module paths, and nearby calls together. Evidence beyond 80 lines or 4,000 characters can still be truncated.

The implementation reuses the existing `head` and `code` helpers. A3 shares the request builder and therefore receives the same input change, but remains disabled in automatic mode and was not part of this benchmark.

Code: [definition-selection requests](../../../../src/decision/questions/resolution.ts), [input limits](../../../../src/decision/questions/common.ts).

## D1: apply a confident “no context” verdict

Previously, a negative structural verdict only changed the keyword gate. Later symbol and prose checks still ran, potentially adding context when a translation or copy-editing request happened to mention a real code symbol.

A “no context needed” verdict with confidence **≥ 0.95** now ends the hook immediately. The automatic-mode acceptance threshold of **0.8** and the stronger veto threshold of **0.95** serve different purposes.

| Verdict | Behavior |
|---|---|
| No context needed, confidence ≥ 0.95 | Exit without injecting context |
| No context needed, 0.8 ≤ confidence < 0.95 | Replace the keyword verdict; retain later symbol and prose checks |
| Context needed, confidence ≥ 0.8 | Continue the existing context-building path |
| No acceptable response, error, or timeout | Keep the heuristic |

D1's `noul` value is the predicted likelihood of a structural question. For example, `noul = 0.05` becomes negative confidence `1 - 0.05 = 0.95`. This score does not itself guarantee an empirical accuracy rate.

The question wording is unchanged and the user prompt is capped at 2,000 characters. Remote prompt transmission requires `CODEGRAPH_DECISION_ALLOW_REMOTE_PROMPTS=1`.

Code: [prompt hook](../../../../src/bin/codegraph.ts), [D1 question](../../../../src/decision/questions/input.ts), [confidence conversion](../../../../src/decision/questions/common.ts).

## Rejected experiments and retained policy

| Experiment | Observation | Decision |
|---|---|---|
| Expanded A2 context | JEV stayed at 40/42; input cost rose about 2.5× | Keep the original input |
| Broader changes including candidate bodies and extra options | A2 JEV verdict accuracy fell from 40/42 to 34/42 | Reject |
| D1 candidates combining rewritten questions and lower veto thresholds | Fewer correct actual gate outcomes than the final version | Keep the original question and 0.95 veto |

Some candidates combined several changes, so these comparisons do not isolate the effect of each phrase. A2 always uses JEV, even within Cloudflare's free allowance. A1/A6 prefer Clef-flash and D1 prefers Clef when free usage can be reserved; otherwise they use JEV.

Acceptance floors are **0.6** for A1/A2, **0.7** for A6, and **0.8** for D1. A rejected Clef verdict falls back to JEV within the same deadline. If no response is accepted, the heuristic remains. Other points are disabled in automatic mode.

A1/A2/A6 affect the stored graph through **record → precompute → re-index with overrides**. D1 runs live in the prompt hook. See the [setup guide](../README.md#setup-guide).

## Runtime scope after cleanup

The cleanup removes evaluation-only collectors, 19 question templates without a runtime consumer, their fixtures, raw results, and the local Clef backend. Existing index overrides, live search and viewer integrations, and heuristic improvements remain. The automatic policy is unchanged; manually enabled integrations remain outside its default selection. Recording index decisions and precomputing overrides are operational features and remain available.

## Automatic Cloudflare usage lookup

1. Only a Clef-eligible automatic decision triggers a usage check. A2 and disabled points make no analytics request.
2. Query `aiInferenceAdaptiveGroups.sum.totalNeurons` for the current account, from UTC midnight to the lookup start time. There is no model filter, so other applications' reported usage is included.
3. Validate HTTP status, GraphQL errors, account and aggregate shapes, and a finite non-negative neuron count. A valid empty aggregate means no reported usage; missing data means `unknown`.
4. Cache the result in the shared SQLite database for 30 seconds, keyed by account, token hash, and UTC day. Raw API tokens are not stored. Expired successful data is not reused after a failed refresh. A lookup that crosses midnight is rejected.
5. Before inference, atomically reserve the full 65,536-token input allowance: approximately **1,429.86 neurons for Clef** or **536.22 for Clef-flash**. The local spent estimate never decreases when analytics is refreshed. Pending reservations are tracked separately, so a refresh cannot erase another process's in-flight request.
6. Settle a successful reservation using reported input tokens. Missing, invalid, failed, or timed-out usage keeps the full reservation. Requests without enough headroom fall back to JEV.

The decision deadline includes the lookup, which is capped at 500ms. The diagnostic `decision-status` command allows a five-second lookup and makes no inference request. `free`, `exhausted`, and `unknown` remain distinct in status output and optional decision ledgers. D1 reports `off` when remote prompt consent is absent. Manual dated allowance variables are ignored.

The free allocation exists on both Free and Paid accounts, so routing checks allowance rather than the subscription name. It does not need billing-management permission or enable paid overages. Explicit `cf` mode selects Cloudflare directly, outside this automatic policy. [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Analytics is not an atomic billing reservation: reporting delay, sampling, or concurrent usage on another machine can still cross the provider's free allowance. Local processes coordinate only when they share the same quota database. If analytics already includes an in-flight request, subsequent settlement can count it twice; this deliberately reduces available allowance instead of risking an undercount. Unknown reservations remain until the UTC day changes. These limits can cause an early fallback to JEV. [Analytics sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)

Code: [usage lookup](../../../../src/decision/cloudflare-usage.ts), [shared cache and reservations](../../../../src/decision/cache.ts), [routing](../../../../src/decision/live.ts), [policy](../../../../src/decision/policy.ts), [precompute command](../../../../scripts/decide-offline.mjs).

## Benchmark method and results

The fixed TypeScript monorepo snapshot had 2,297 files, 1,821 indexed files, 26,785 symbols, and 59,055 edges. Original and copied snapshots were checked using file hashes.

| Check | Scope and method |
|---|---|
| API comparison | 80 cases each for A1/A2/A6 plus 85 D1 prompts: 325 × 3 models × 4 candidates = 3,900 requests |
| Ground truth | A1: 64, A2: 42, A6: 64, D1: 85; 255 total. The 70 uncertain cases contributed to cost and latency, but not accuracy |
| Persisted graph | Re-indexed copies under seven conditions: off, plus before/after for each model. Compared actual stored targets at 170 labeled sites |
| Context gate | Actual CLI hook on 85 prompts, measuring context injection and end-to-end time, without answer caching and with a 1.5-second request limit |
| Original regression checks | 140 tests across seven files covering bounded input, multiline imports, D1 veto behavior, fallback, and routing |

| Correct outcomes | JEV | Clef | Clef-flash |
|---|---:|---:|---:|
| Persisted graph / 170 sites | 162 → **164** | 161 → **162** | 162 → 162 |
| Context gate / 85 prompts | 80 → **82** | 80 → **84** | 73 → **75** |

Model-verdict accuracy and actual feature accuracy were measured separately. Final A6 verdicts were 64/64 for all three models, while persisted graphs were 63/64 each. Tables and routing use actual feature outcomes. Clef-flash improved some individual decisions without changing its total graph score.

Of the final 975 requests, one Clef timeout fell back to the heuristic and remained in the accuracy score. Its unknown usage was priced at the maximum input size. Latency, cost, and the chart are in the [results README](../README.md).

The usage-lookup follow-up adds regression coverage for malformed responses, authorization failures, stale snapshots, credential changes, timeouts, UTC rollover, ledger migration, and concurrent reservations. It does not replace or rerun the model-quality benchmark.

Tests: [request inputs](../../../../__tests__/decision-questions.test.ts), [actual D1 hook](../../../../__tests__/decision-live-hook.test.ts), [routing](../../../../__tests__/decision-auto.test.ts), [usage and reservation checks](../../../../__tests__/decision-cloudflare-usage.test.ts).

## Interpretation limits

The same sample was used to select and revalidate the input changes and D1 veto threshold. This is not an independent holdout result; other repositories and languages may behave differently.

Graph scores cover 170 checked sites and context-gate scores cover 85 prompts. Overall edge accuracy, final coding-task success, and end-to-end performance of the mixed routing policy remain unmeasured. A further benchmark should apply the same criteria to new repositories and prompts.
