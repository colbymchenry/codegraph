# Explore sufficiency

> One of three feedback metrics the agent-eval harness reports on every run.
> [`agent-eval-feedback-metrics.md`](agent-eval-feedback-metrics.md) is the entry
> point: which metric answers which question, which harness to run, and how to
> read the arm-comparison table.

**What it measures:** whether a `codegraph_explore` response was *enough* — read
off what the agent did next, which the harness was throwing away.

The agent tells us on every call. It reads a file, or it explores again, or it
answers. That next action is free ground truth, and it splits into buckets that
each point at a different fix:

| Next action | Bucket | What it means |
|---|---|---|
| another codegraph call | `explore again` | insufficient — the response did not answer |
| `Read` of a file we **returned** | `Read a file we returned` | **allocation**: right file, wrong bytes |
| `Read` of a file we did **not** return | `Read a file we did not return` | **recall**: the file never surfaced |
| `Grep` / `Glob` | `Grep/Glob` | recall, weaker signal — still hunting |
| `Edit`, a build, the final answer | `moved on / answered` | sufficient |

Harness-only. Nothing is emitted from the product and nothing leaves the machine
(decided 2026-08-03); it is parsed out of transcripts we already write.

---

## Running it

Every run prints it — `run-all.sh` and anything else that calls `parse-run.mjs`:

```bash
scripts/agent-eval/run-all.sh /tmp/codegraph-corpus/express \
  "How does res.send decide the Content-Type and ETag?"

# Or over a log you already have:
node scripts/agent-eval/parse-run.mjs /tmp/agent-eval/run-headless-with.jsonl
```

```
  Explore sufficiency — what the agent did NEXT (2 answered calls):
      1  50%  explore again                  insufficient: did not answer
      1  50%  Read a file we returned        allocation: right file, wrong bytes
      0   0%  Read a file we did not return  recall: file never surfaced
      0   0%  Grep/Glob                      recall (weak): still hunting for the file
      0   0%  moved on / answered            sufficient
    1. "res.send Content-Type ETag generation" [3 files] → codegraph_explore
    2. "response.js res.send function body" [3 files] → Read response.js
```

Interactive runs get the same block from `parse-session.mjs <project-dir>`.

The per-call lines matter as much as the counts: they name the query that fell
short and the file the agent went and read instead, which is usually enough to
reproduce the miss with `probe-explore.mjs`.

---

## The rules that keep it honest

**Only a later message counts as a reaction.** A `Read` fired in the *same*
assistant message as the explore was issued before the response existed, so it
is not a verdict on it. Those are stepped over and counted separately as
`concurrent`.

**Bookkeeping is stepped over.** `ToolSearch` (pulling a deferred tool schema)
and `TodoWrite` say nothing about the response; the call behind them is the
verdict.

**Subagents are a separate thread.** Claude Code interleaves a subagent's tool
calls into the same stream-json output, tagged `parent_tool_use_id` — verified
on a real excalidraw run where a delegated search's greps landed between the
parent's own calls. Reactions are matched within one thread, or a subagent's
first grep gets scored as the parent's verdict on an explore it never saw. In
interactive sessions the subagent lives in its own file instead; each
`agent-*.meta.json` carries the `toolUseId` of the Task that spawned it, and
`parse-session.mjs` stitches the threads back together with it.

**A delegation is judged by what the subagent did first.** `Agent`/`Task` →
first substantive call, shown as `Agent → Bash search`. Scoring the delegation
itself as "moved on" is the one error a tuning metric must not make: on the
excalidraw run below it reported 33% sufficient while the subagent was off
grepping for the file. A delegation that never runs a tool stays "moved on".

**Shell file access counts.** Both arms have Bash, and agents reach for
`sed -n '100,200p' lib/x.js` as readily as for `Read`; `grep`/`rg`/`find`/`ls`
count as search. Counting only the `Read` and `Grep` tools would score those
explores as sufficient. A heredoc or a redirect is writing, not reading.

**Returned means we shipped the source.** A file is "returned" if the response
carried its per-file section (the ``**` `` marker). A file the response only
*named* — a flow step, a blast-radius entry — is still a recall miss, flagged
`(named, not returned)`, because pointing without delivering is its own failure.

**A file an earlier explore shipped still counts as returned.** Re-reading it is
an allocation miss wherever we shipped it; filing that as recall would aim the
fix at the wrong end of the pipeline. The line says which
(`Read utils.js (returned by an earlier explore)`).

**Errored calls are counted, not bucketed.** An explore that came back
`isError` or never returned has no response to judge; it is reported separately.

---

## Validation

Hand-checked against real transcripts, then swept over every A/B log on this
machine: 76 single-question runs (176 calls) plus the 14 multi-turn with-arm
sessions of the 7-repo README corpus (62 calls), 0 crashes. That corpus
exercises every bucket:

```
explore again 29 (47%) · Read a file we returned 7 (11%) ·
Read a file we did not return 1 (2%) · Grep/Glob 14 (23%) · moved on 11 (18%)
```

Read it as a baseline, not a verdict: these are three-turn sessions on hard
flow questions, and "explored again" includes the legitimate second call on a
repo whose budget is 2–3 calls.

**That block is a snapshot, and it no longer re-derives.** `bench-readme.sh`
overwrites `/tmp/ab-readme` on every campaign, so the logs sitting there are not
the ones swept above. Pooling the 14 with-arm sessions on disk as of 2026-08-05
gives `explore again 47 (76%) · Read a file we returned 1 (2%) · Read a file we
did not return 1 (2%) · Grep/Glob 0 (0%) · moved on 13 (21%)` over the same 62
calls — checked against both the CG-8-era classifier and the current one, which
agree exactly, so the classifier did not move under it. **CG-13 re-establishes
the 7-repo baseline from a single campaign with all three metrics wired**; treat
that as the number to compare against, and archive a campaign's logs elsewhere
if you want a distribution to stay reproducible.

**`cg22/ab-express/run-baseline-1` — the allocation bucket, by hand.** Sequence:
explore *"res.send Content-Type ETag generation"* → explore *"response.js
res.send function body"* → `Read /…/t-base/lib/response.js`. The second explore
returned `lib/response.js`, and the agent read it anyway → `explore again`, then
`Read a file we returned`. That is the #1500 allocation bug (the 583-byte stub)
showing up as a bucket instead of as a hunch. The new-build arm of the same
question: one explore, `moved on / answered`, 100% sufficient.

**`cg15/ab-express/run-new-2` — the same verdict on a longer run.** Four
explores; the fourth returned `lib/utils.js` and the agent then read
`/…/t-new/lib/utils.js` at `offset: 195`. Right file, wrong window.

**`ab-readme/excalidraw/run2` — the recall bucket, by hand.** The third explore
returned `components/App.tsx` and `components/canvases/InteractiveCanvas.tsx`;
the agent's next action was `Read components/canvases/StaticCanvas.tsx` — the
sibling canvas, named in the response and not shipped. Bucketed
`Read a file we did not return (named, not returned)`. The fourth call in the
same session delegated, and the subagent's first move was a shell read of
`element/src/shape.ts`, which that explore *had* returned → allocation, shown as
`Agent → Bash Read shape.ts`.

**excalidraw `canvasNonce` — the recall bucket, end to end.** A fresh
`run-all.sh` arm on the documented data-flow frontier: three explores, the last
one delegating a subagent that immediately grepped for `sceneNonce` → 67%
`explore again`, 33% `Grep/Glob`, **0% sufficient**. That matches what
`CLAUDE.md` already records about this question (the residual reads and greps
are all nonce data-flow, deliberately uncovered) — the metric found it without
being told.

`node scripts/agent-eval/parse-run.mjs --selftest` covers the classifier over
synthetic transcripts with known answers: every bucket, the same-message rule,
the thread rule, delegation, shell reads and searches, and errored calls.

---

## What it does not say

- **Sufficient is not correct.** The agent moving on means the response was
  enough to stop it, not that the answer was right. Answer quality is not
  measured here.
- **A Read is a vote, not a proof.** An agent sometimes re-reads a file it
  already has. The bucket is still the right signal — it read *because
  something was missing* — but a single call is noisy; read the counts over a
  pass, not one run.
- **Bucket 1 is ambiguous by construction.** "Explored again" means the response
  did not answer; it does not say whether that was allocation or recall. The
  follow-up explore's query usually does.
- **Small-n.** Runs make 1–5 explore calls, so one run's percentages are coarse.
  Compare arms over a pass (`RUNS>=2`, and the 7-repo campaign), never n=1.
