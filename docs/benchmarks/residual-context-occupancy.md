# Residual context occupancy

> One of three feedback metrics the agent-eval harness reports on every run.
> [`agent-eval-feedback-metrics.md`](agent-eval-feedback-metrics.md) is the entry
> point: which metric answers which question, which harness to run, and how to
> read the arm-comparison table.

**What it measures:** how many tokens of the context window a tool's responses
still occupy once the question has been answered — and therefore how much
headroom every following turn has to work in.

This is the metric issue [#1500](https://github.com/colbymchenry/codegraph/issues/1500)
was actually about. The reporter was looking at a live Cursor session: explore's
output was still resident after the answer, so it was charged against everything
that came next. Our A/B harness ran one headless question to completion and
reported cost, tokens, time, and tool calls — none of which can see that. A
single-question run reports *throughput*; occupancy is a *stock*, and it only
starts costing anything on the turns that follow.

The harness now measures it, over multi-turn sessions.

---

## Running it

```bash
# One repo, one three-turn session, both arms:
scripts/agent-eval/run-all.sh /tmp/codegraph-corpus/gin \
  "How does gin route requests through its middleware chain?||\
Where is the 404 / no-route case handled in that same chain?||\
What would I change to add a per-route middleware that runs before the global ones?"

# The 7 README repos (default: 3 turns per session, RUNS=4 per arm):
CORPUS=/tmp/codegraph-corpus RUNS=2 scripts/agent-eval/bench-readme.sh
node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme
```

`||` separates turns. Turn 1 runs normally; each later turn `--resume`s the same
session, so the earlier turns' tool output is still in the window — which is the
entire point. Segments land in `run-<label>.jsonl`, `run-<label>.t2.jsonl`, …
and `parse-run.mjs` stitches them back into one session (`--resume` does not
replay prior messages, so they concatenate cleanly).

`CG_TURNS=1` restores the original single-question A/B. `CG_WINDOW_TOKENS`
overrides the 200k nominal window for the share-of-window column.

Every arm prints:

```
Residual context occupancy at end of run:
  final context       54,950 tok   27.5% of 200k window
  codegraph           13,941 tok   25.4% of ctx    7.0% of 200k win   (31,312 chars, 2 results)
  Read                     0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  Grep/Glob                0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  Bash                     0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  → file-access            0 tok    0.0% of ctx    0.0% of 200k win   (0 chars, 0 results)
  other tools             33 tok    0.1% of ctx    0.0% of 200k win   (73 chars, 1 result)
  base (prompt+prose)  40,976 tok   74.6% of ctx   20.5% of 200k win
    of which fixed    37,726 tok  system + tool schemas + question, before any tool answered
  measure: 2.25 chars/tok measured ±0.9% · turns 6 · compactions 0
```

The comparison is codegraph's residual in the with-arm against **file-access**
(Read + Grep/Glob + Bash) in the without-arm — the two ways an agent gets the
same bytes into its head. Bash matters: on small repos the without-arm often
reaches for `cat`/`grep` through Bash rather than the Read tool, and counting
only Read would score those runs as reading nothing.

---

## How the tokens are measured

**Measured, not estimated.** For each assistant request,

```
ctx_k = usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

is the exact token count of that request's entire prompt. So `ctx_k − ctx_{k−1}`
is exactly what was appended since the previous request: the previous assistant
output plus the tool results and user text that followed it. Each gap's measured
delta is priced against the characters in it.

The ratio is calibrated on gaps that are **≥80% tool result by characters**, then
every result is priced at that ratio. Calibrating on *all* gaps was wrong: when
the assistant's own output is under-represented in the transcript — redacted or
empty thinking blocks are the common case — a proportional split hands the tool
result the whole delta. One 73-character `ToolSearch` result was charged the
entire 830-token gap, 5.5 tokens per character.

Getting this right matters more than it sounds. Explore output measures around
**2.2–2.3 chars/token** — it is dense, line-numbered source. The usual bytes/4
rule of thumb would under-count it by roughly 40%.

**Error bar.** On a gap that is ≥95% one tool result, the measured delta *is*
that result's token count, so the distance from the run-level ratio is the
attribution error for that result. The median over such gaps is printed after
the ratio: **±1–2%** on real runs.

### Residual is not the same as contributed

Content leaves the window two ways, and both are tracked:

- a `compact_boundary` system event — everything before it is replaced by a
  summary, so the resident set is cleared;
- **micro-compaction** — the context drops mid-run without a boundary event.
  Claude Code sheds the oldest tool results first, so eviction is applied FIFO.

A shortfall only counts as eviction past a tolerance (the larger of 200 tokens or
5%); below that it is attribution noise, and real shedding is thousands of tokens.

### Two transcript traps

Both were verified against real logs and are worth knowing before writing
anything else that reads these files:

1. **Claude Code emits one `assistant` event per content block**, all carrying
   the same `message.id` *and the same `usage`*. Summing usage per event
   double-counts every turn that emits both a thinking block and a tool_use.
   `parseSession()` dedupes by `message.id`.
2. **The streamed `output_tokens` is a partial snapshot** — observed as `out=2`
   on a turn that really generated ~1,100 tokens. It is unusable; the
   char-proportional method deliberately does not need it.

For the record, `result.usage` in Claude Code 2.1.198 is cumulative *within a
segment* (its in+cache+out equals the sum of that segment's per-request prompts),
not last-turn-only as it was when `CLAUDE.md` was written. `parseSession()` sums
per segment either way. That figure is "tokens processed" — every request
re-counts the whole prefix — which is exactly why it cannot answer the occupancy
question.

---

## The without-arm was never actually without codegraph

Establishing this baseline turned up a contamination channel that had been open
the whole time, and it invalidates any number this harness produced for an arm
that had Bash.

The without-arm gets an empty MCP config, so it has no codegraph tool. It still
has **Bash** — and the target repo still carries the `.codegraph/` index the
with-arm needs, with the `codegraph` binary on PATH. Agents find that. In the
first clean-looking 7-repo pass, **14 of 15 without-arm runs ran `codegraph
explore` through Bash**, one of them by way of `ls .codegraph && codegraph
explore …`. That arm was measuring codegraph-over-CLI against codegraph-over-MCP,
not codegraph against its absence.

It cuts the other way too. When the *with*-arm shells out, the output arrives as
a Bash result and is attributed to Bash — understating what codegraph itself
occupies. One of 15 with-arm runs did this.

The fix is in `run-all.sh`: both arms now run on a PATH where the CLI is hidden,
so the MCP server is the only way to reach codegraph and stays the A/B's single
variable. The binary usually shares a directory with tools the run needs — here
`claude` sits right next to it — so the directory is substituted in place by one
of symlinks to every entry except `codegraph`, which keeps PATH order and
precedence intact. The run aborts if `claude` or `node` did not survive.

Prevention alone would fail silently the next time the binary lands somewhere
new, so there is detection as well: `parse-run.mjs` flags any Bash command naming
codegraph, and `parse-bench-readme.mjs` drops contaminated without-arm runs from
the aggregate (`CG_INCLUDE_CONTAMINATED=1` keeps them).

**Anyone re-reading older A/B results from this harness should assume the
without-arm may have been using codegraph.**

---

## Baseline: the 7 README repos

### The regime — read this before any number below

| | This campaign | README's published table |
|---|---|---|
| Model | **`claude-sonnet-5`** | **Claude Opus 4.8** |
| Session shape | **3 turns** (README question + 2 in-flow follow-ups) | **1 question** |
| Runs | 4 per arm × 7 repos = **56 sessions** | 4 per arm, median |
| Ran | 2026-08-05, 137 min (`bgjob-6d357cd2`), raw under `/tmp/ab-readme` | 2026-07-21 |

**These two are not comparable, and the difference is model + turn count — not
contamination.** Sonnet is the deliberate floor model for this harness
(`CLAUDE.md`: an affordance that lands on Sonnet generalizes up; one that only
works on Opus does not generalize down). Three turns is what makes occupancy
chargeable at all. Both choices move the efficiency numbers, so the throughput
row below reads *lower* than the README's and neither figure invalidates the
other. Settling whether the published Opus figures still hold needs a matched
**Opus 4.8, single-question** rerun; that is deliberately out of scope here.

Reproduce with:

```bash
CORPUS=/tmp/codegraph-corpus scripts/agent-eval/bench-readme.sh   # RUNS=4 CG_TURNS=3
node scripts/agent-eval/parse-bench-readme.mjs /tmp/ab-readme
```

### The finding: codegraph's residual is 82% HIGHER, on all seven repos

```
repo        turns W→WO   final ctx W→WO   residual W→WO       % of ctx W→WO   % of window W→WO
vscode      12.5/44      113k→53k         67k→18k  (+276%)    59.7%→36.0%     33.7%→9.0%
excalidraw  9/32         87k→57k          43k→25k   (+71%)    49.5%→47.6%     21.5%→12.5%
django      7.5/16.5     60k→51k          18k→10k   (+71%)    29.3%→19.9%      8.8%→5.1%
tokio       9/33.5       87k→64k          45k→31k   (+45%)    52.1%→50.5%     22.7%→15.7%
okhttp      6/14         61k→59k          20k→16k   (+27%)    33.2%→27.6%     10.1%→8.0%
gin         6/15.5       56k→49k          15k→8k    (+79%)    26.3%→16.7%      7.3%→4.1%
alamofire   10/31        76k→65k          34k→32k    (+7%)    44.7%→50.6%     16.9%→15.8%

AVERAGE: retrieval residual 82% HIGHER with codegraph · share-of-context 27% HIGHER
```

W = codegraph's responses still resident. WO = Read + Grep/Glob + Bash results
still resident. `turns` is median assistant turns per session.

**Seven of seven.** There is no repo where codegraph leaves less behind. On
vscode it leaves **67k tokens resident against the without-arm's 18k** — a third
of a 200k window, gone before turn 4 starts. The only near-tie is Alamofire
(+7%), and it is a tie because that arm's share-of-context is actually *lower*
(44.7% vs 50.6%), not because the residual is small.

**Both things are true at once.** On six of seven repos the without-arm
*processes* far more total tokens than the with-arm — gin 660k vs 290k, okhttp
704k vs 302k — while leaving *less* behind. Throughput and stock are different
quantities and they point opposite ways here:

- codegraph front-loads **one large verbatim payload** (2 explore calls on gin,
  each tens of thousands of dense source characters) and that payload **stays
  resident** for every turn after it;
- Read/Grep/Bash churn **many small results** (gin: ~6 reads + ~5 bash per run),
  most of which are re-derivation the agent then discards, and which evict.

**This corroborates issue [#1500](https://github.com/colbymchenry/codegraph/issues/1500)
on our own harness.** The reporter's complaint was exactly this axis, and until
this campaign we had no measurement that could see it. Note for anyone reading
git history: the aggregator originally printed this as "-82% *lower* with
codegraph" — a sign bug, fixed at `520ed9d`. The honest number is the entire
point of the metric; do not soften it.

**Fixed overhead.** codegraph's tool schema + MCP instructions cost **+546 tok**
of context before any tool is called (median with-arm `ctxBase` minus median
without-arm `ctxBase`, averaged over repos). Paid whether or not the agent ever
calls codegraph. Small — the residual, not the schema, is where the context goes.

### Throughput in the same campaign (sonnet · 3 turns)

Reported for completeness and because the occupancy finding only means anything
read against it. **These are not the README's numbers and must not be quoted as
such.**

> **Corrected 2026-08-05.** The token column first published here was wrong, and
> wrong in one direction. It came off `result.usage`, which reports only the last
> turn in current Claude Code, so it under-counted whichever arm took more turns —
> always the without-arm. It reported a 23% token saving where the real figure is
> **56%**, and showed **vscode processing 98% *more* tokens with codegraph** when
> it in fact processes **41% fewer**. Re-derived below from the same raw logs
> (`/tmp/ab-readme-sonnet3turn`) with tokens summed per assistant turn.
> **Cost, time and tool calls were never affected** — they are unchanged.
> Occupancy is measured off the timeline, not this field, so every number in the
> table above stands.

```
repo        time W→WO        tools W→WO   tokens W→WO (saved)   cost W→WO (saved)
vscode      2m 59s→1m 59s    8→60         940k→1.6M   (41%)     $1.21→$1.62  (25%)
excalidraw  1m 45s→2m 1s     5→44         549k→1.3M   (57%)     $0.78→$1.03  (24%)
django      1m 4s→1m 30s     3→13         362k→715k   (49%)     $0.52→$0.45 (-17%)
tokio       1m 47s→4m 35s    5→43         568k→1.6M   (65%)     $0.67→$1.25  (47%)
okhttp      49s→1m 25s       2→11         299k→698k   (57%)     $0.35→$0.48  (27%)
gin         1m 6s→1m 43s     2→12         285k→652k   (56%)     $0.38→$0.43  (12%)
alamofire   1m 35s→1m 47s    6→29         539k→1.5M   (64%)     $0.67→$1.30  (49%)

AVERAGE saved: cost 24% · tokens 56% · time 20% · tool calls 84%
```

| | this campaign (sonnet, 3-turn) | README (Opus 4.8, 1-question) |
|---|---|---|
| cost saved | **24%** | 44% |
| tokens saved | **56%** | 62% |
| time saved | **20%** | 53% |
| tool calls saved | **84%** | 88% |

Tokens and tool-call reduction survive the regime change nearly intact. What the
harder regime costs is **cost and wall-clock**: three turns of follow-ups on a
weaker model give the with-arm less headroom to win, and **django costs 17% more**
— not hidden here. The with-arm is also not read-free in this regime: 4 of 28
with-arm sessions still touched Read (vscode run4 `rd5 bs7`, tokio run2 `rd3 bs2`,
django run4 `rd1`, alamofire run2 `rd1`), against the README's "zero file reads on
all seven repos" under Opus on a single question.

### Contamination gate: clean, and the channel is real

**0 CLI calls returned output in any of the 56 sessions.** The aggregate is
uncontaminated and no run was dropped.

But **29 attempts were blocked** — 26 in the without-arm (in **26 of its 28
sessions**) and 3 in the with-arm. Ninety-three percent of without-arm sessions
tried to reach codegraph through Bash and were stopped by the sanitized PATH +
PreToolUse hook (`no-cli-shim.sh`). That is not a hypothetical channel the
harness guards out of caution; it is the agent's *default* move once it notices
`.codegraph/` in the tree. **`no-cli-shim.sh` is load-bearing** — without it this
campaign would have been codegraph-over-CLI vs codegraph-over-MCP, exactly as the
earlier 14-of-15 pass was (see the section above). Check the contamination row
before believing any number from this harness.

### Secondary readings — absolute, not before/after

There is **no baseline-build arm in this campaign** — every number below is the
current build's absolute reading on these questions. Allocation efficiency in
particular is *relative* (attribution is by citation): it compares builds on the
same question and says nothing on its own about waste. For a before/after
allocation A/B see [`explore-allocation-ab-1500.md`](explore-allocation-ab-1500.md).

```
repo        calls  again    read-ret  read-miss  grep    MOVED ON   alloc eff  envelope
vscode      26     21 81%   0  0%     1  4%      1  4%   3 12%      63.2%      442k
excalidraw  18     14 78%   0  0%     0  0%      0  0%   4 22%      94.7%      338k
django      11      6 55%   1  9%     0  0%      0  0%   4 36%      96.2%      186k
tokio       16     12 75%   0  0%     0  0%      1  6%   3 19%      92.9%      343k
okhttp       8      4 50%   0  0%     0  0%      0  0%   4 50%      97.9%      151k
gin          8      4 50%   0  0%     0  0%      0  0%   4 50%      99.0%      116k
alamofire   23     19 83%   1  4%     0  0%      0  0%   3 13%      89.0%      306k

POOLED (110 answered explore calls):
  explore again 73% · Read a file we returned 2% · Read a file we did NOT return 1%
  · Grep/Glob 2% · moved on / answered 23%
POOLED allocation efficiency: 86.7% over 110 calls / 1.9M chars
```

- **Allocation efficiency 86.7%** pooled. vscode is the outlier at 63.2% — the
  largest envelope (442k chars) and the lowest citation share, which is where an
  allocation change would show up first.
- **`Read a file we returned` = 2%** (2 of 110). Right file, wrong bytes is
  nearly absent; the allocation misses this metric was built to catch are not
  what is driving vscode's number.
- **Recall misses** are 3% total (1 read-miss, 2 grep).
- **`explore again` = 73%** and is **ambiguous by construction** — it is
  indistinguishable between "the first call was insufficient" and "the agent is
  working through a 3-turn session and this is turn 2's first call." In a 3-turn
  regime that ambiguity is much larger than it was single-turn; treat the
  high-`again` repos (alamofire 83%, vscode 81%) as unresolved, not as failures.

---

## What this settles, and what it does not

**Settled.** The metric exists, it is measured rather than estimated, and it runs
over multi-turn sessions — the regime where occupancy is actually charged. As of
2026-08-05 there is a baseline across the 7 README repos (above) to compare
future changes against, and it says codegraph's residual is **higher**, on every
repo. (Before that campaign this section claimed such a baseline existed when it
did not; it does now, and it is one regime — `claude-sonnet-5`, 3 turns — not a
general result.)

**Not settled, and deliberately not claimed:**

- **The README's efficiency figures.** The baseline above ran sonnet / 3 turns;
  the README published Opus 4.8 / single-question. The gap between 24/23/20/84
  and 60/69/20/89 is regime, not regression, and this campaign cannot tell you
  which way the published numbers have moved. That needs a matched **Opus 4.8,
  single-question** rerun. Out of scope here, and `README.md` was deliberately
  left untouched.
- **A different host.** The reporter was in Cursor. We measure Claude Code.
  Window size, system prompt, and compaction policy all differ, so the *share*
  numbers do not transfer host to host; the ratio between the arms is the part
  that travels.
- **Three turns is short.** It is long enough for the residual to be charged
  against something, which single-turn runs could not do at all. It is not long
  enough to reach compaction on a 200k window, so the compaction and
  micro-compaction paths are implemented and instrumented but effectively
  untested by this baseline — no run here triggered either.
- **Deferred tool schemas land in `base`.** `codegraph_explore` is a deferred
  tool: the initial listing carries its name, and `ToolSearch` pulls the full
  schema in later. That injection is not a tool result, so its tokens are
  counted as base rather than attributed to codegraph. The fixed-overhead line
  (with-arm `ctxBase` minus without-arm `ctxBase`) prices the part that is
  present from the start.
- **Subagent contexts are not counted.** A `Task` subagent has its own window;
  only its summary returns to the parent. Runs that delegate are measured on the
  parent's window alone.
- **Occupancy is not sufficiency.** A small residual is only good if the answer
  was still right. This metric says nothing about whether the response was
  *enough* — that is [explore sufficiency](explore-sufficiency.md), which every
  run now prints alongside this block — nor about how much of the returned bytes
  the answer actually used (CG-9).

---

## Proposed README wording — for the maintainer, not applied

`README.md` is **deliberately untouched by this work.** Its benchmark table is
Opus 4.8 / single-question and nothing measured here can restate it. What follows
is a *proposal*: the occupancy finding as an honest counterweight to the
efficiency table, phrased so it does not depend on the sonnet-vs-Opus regime for
its claim. Accept, reject, or rewrite — this is not a pending edit.

Suggested placement: immediately after the "A note on cost" paragraph (README
line ~195), as a second `>` note under the same table.

> **A note on context.** The efficiency table above measures *throughput* —
> tokens processed, tools called, dollars spent to reach one answer. It does not
> measure what is still sitting in the window afterward, and on that axis
> CodeGraph costs more, not less. Across the same seven repos in multi-turn
> sessions, CodeGraph's responses leave **~80% more retrieval context resident**
> at the end of a session than the file-reading agent's do — on VS Code, 67k
> tokens against 18k. The mechanism is the same one that makes it fast:
> CodeGraph returns one dense, verbatim payload that answers the question and
> then stays in the window, where a grep-and-read agent churns many small results
> that get evicted. Fewer tokens *processed* and a larger persistent *footprint*
> are both real. If you are running long sessions in a small window, budget for
> it. Measured, per-repo:
> [`docs/benchmarks/residual-context-occupancy.md`](docs/benchmarks/residual-context-occupancy.md).

Three notes on the drafting, if it gets edited:

1. **No percentages from this campaign's efficiency table appear in it.** "~80%
   more resident" is the occupancy ratio between arms, which is the part that
   travels across models and hosts; the 24/23/20/84 throughput figures are
   sonnet-3-turn-specific and must not go near the README.
2. **It concedes the point rather than framing it as a feature.** That is
   deliberate — `CLAUDE.md`'s "honesty in the product is load-bearing" applies to
   the README before it applies to a product screen, and a reader who hits #1500
   in their own session and finds the README silent on it trusts nothing else in
   the table.
3. **The share numbers (33.7% of a 200k window) are Claude Code's** and do not
   transfer to another host, so the draft quotes absolute tokens and the arm
   ratio only.
