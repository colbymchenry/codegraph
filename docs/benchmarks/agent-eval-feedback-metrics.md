# The three explore feedback metrics — start here

The agent-eval harness reports three metrics on every run. They are not three
views of one number; each answers a different question, and a retrieval change
can move one without moving the others. This page says which is which, which
harness to run, and how to read the output. The per-metric docs carry the
derivations and the caveats — read the one that matters once a number moves.

| Metric | The question it answers | Doc |
|---|---|---|
| **Residual context occupancy** (CG-7) | How much of the window does this arm's retrieval still hold when the run ends — i.e. what does every following turn have to work in? | [`residual-context-occupancy.md`](residual-context-occupancy.md) |
| **Explore sufficiency** (CG-8) | Was a response *enough*? Read off what the agent did next: explored again, read a file, or answered. | [`explore-sufficiency.md`](explore-sufficiency.md) |
| **Allocation efficiency** (CG-9) | Of the bytes a response spent, what share went to files the answer actually drew on? | [`explore-allocation-efficiency.md`](explore-allocation-efficiency.md) |

All three are **harness-only**: parsed out of transcripts we already write.
Nothing is emitted from the product and nothing leaves the machine.

---

## Which harness

Pick by the question you are actually asking. All three metrics print in both.

**Isolating a retrieval change — `ab-new-vs-baseline.sh`.** New build (HEAD) vs
a baseline build (a git ref), **both arms codegraph-on**, same task. This is
the harness the three metrics were built for: with codegraph on in both arms,
every number is measuring the change rather than adoption.

```bash
RUNS=3 scripts/agent-eval/ab-new-vs-baseline.sh /tmp/codegraph-corpus/express \
  "Add a charset option to res.send and wire it through" main
```

It builds each arm, indexes a throwaway copy of the target, **pre-warms a
codegraph daemon per run**, runs the task `RUNS` times per arm, prints the three
metric blocks under each run, and ends with the side-by-side table below. The
pre-warm is load-bearing and must not be removed: without it the agent dives
into Read/grep before codegraph finishes its ~2–3s startup, and the run measures
attach latency instead of retrieval.

**With vs without codegraph — `run-all.sh`.** Codegraph-on against an empty MCP
config. A different question: displacement and adoption, not the effect of a
change. Multi-turn is where occupancy is actually charged, so separate turns
with `||`.

```bash
scripts/agent-eval/run-all.sh /tmp/codegraph-corpus/gin \
  "How does gin route requests through its middleware chain?||\
Where is the 404 / no-route case handled in that same chain?"
```

`CG_ARMS=with|without` re-runs one arm without redoing the other; the comparison
table still renders against whichever arm's logs are already in `$AGENT_EVAL_OUT`.

**A campaign — `bench-readme.sh`.** The 7 README repos, three turns each,
`RUNS` per arm, through `run-all.sh` — so every run in a campaign carries all
three metrics. Aggregate with `parse-bench-readme.mjs`. One has been run:
[the 2026-08-05 baseline](residual-context-occupancy.md#baseline-the-7-readme-repos)
(sonnet, 3 turns, 4 runs/arm) — read its regime box before comparing anything to
it, and note that it is **not** the regime the README's table was published in.

**A log you already have.** `parse-run.mjs <run.jsonl> [run.tN.jsonl …]` prints
the three blocks for any stream-json log; `--brief` drops the numbered call
transcript. `parse-session.mjs <project-dir>` does sufficiency and allocation
for an *interactive* session. `compare-arms.mjs <out-dir> <label>…` builds the
table from logs on disk, at any time, for any labels.

**Model policy, both harnesses, not negotiable:** `--model sonnet --effort high`
on every arm, both arms the same model. Sonnet is the deliberate floor — an
affordance that lands on it generalizes up to every host; one that only works on
a stronger model does not generalize down to the agents most users have.

---

## Reading the output

Each run prints its three blocks (see the per-metric docs for the shape of
each), then one table puts the arms side by side:

```
====== ARM COMPARISON — /private/tmp/cg22/ab-express ======
                                                           new                baseline
  runs                                                       3                       3

  behavior
    duration (s)                                    24 [18–35]              26 [24–30]
    Read                                                     0                       1
    codegraph calls                                    2 [1–2]                       2

  residual context occupancy (CG-7) — tokens still resident at end of run
    codegraph residual (tok)             11,549 [7,193–12,591]  10,388 [10,373–10,447]
    file-access residual (tok)                     231 [0–242]     1,661 [1,306–1,663]
    → retrieval residual (tok)           11,780 [7,193–12,833]  12,034 [11,753–12,051]
    → share of final context               23.3% [15.8%–24.9%]     23.8% [23.4%–23.9%]

  explore sufficiency (CG-8) — pooled over every answered explore call
    answered explore calls                                   5                       6
    explore again                                       2  40%                  3  50%
    Read a file we returned                              0  0%                  3  50%
    Read a file we did not return                        0  0%                   0  0%
    Grep/Glob                                            0  0%                   0  0%
    moved on / answered                                 3  60%                  0  0%

  explore allocation efficiency (CG-9) — share of returned bytes the answer cited
    pooled efficiency                                    96.9%                   82.0%
    per-run efficiency                     100.0% [92.5%–100.0%]   81.9% [81.9%–82.0%]

  contamination — the CLI must never be how codegraph is reached
    CLI calls that RETURNED output                           0                       0
    CLI attempts blocked                                     0                       0
```

That is the real CG-22 express pass, and it is a worked example of all three
reading together: the baseline spent 18% of its envelope on a file no answer
ever cited, so the agent read a file we had already returned in **3 of 6** calls
and the run ended at **82%** efficiency. The new build ships the right bytes —
0 of 5 in that bucket, 96.9% — for about the same residual. Occupancy alone
would have called these arms equivalent.

**The table is "did it move?"; the per-run blocks are "why?"** Only the blocks
name the query that fell short and the file the agent went and read instead,
which is usually enough to reproduce a miss with `probe-explore.mjs`.

### Which bucket points at which fix

The sufficiency buckets are chosen so each maps to a distinct fix, and two of
them tie directly to the other metrics:

- `Read a file we returned` → **allocation**: right file, wrong bytes. Expect
  allocation efficiency to be soft on the same runs, and note the asymmetry —
  efficiency scores a cited file at 100% of its section even if the agent then
  had to read it for the part we clipped. This bucket is what catches that.
- `Read a file we did not return` / `Grep/Glob` → **recall**: the file never
  surfaced. Allocation efficiency cannot see this at all; the envelope was
  simply missing something.
- `explore again` → ambiguous by construction. It says the response did not
  answer, not whether that was allocation or recall. The follow-up query
  usually says which.
- `moved on / answered` → sufficient, which is not the same as correct.

**Efficiency is not value, and occupancy is not sufficiency.** A response can be
100% efficient and useless — one small file the answer names in passing — and a
small residual is only good if the answer was still right. Read all three, which
is the point of wiring them into the same run.

---

## Caveats that survive the summary view

Each metric's doc has the full list. These are the ones that change how you
should read the table itself:

- **Allocation efficiency is relative, not absolute.** Attribution is by
  citation, and an agent can use a file without ever naming it — to rule it out,
  or to build a model it writes up from elsewhere. The error is one-sided. Only
  compare builds on the **same question**, and never quote the number as
  "codegraph wastes N% of what it returns." The corpus median sits in the
  eighties because these are flow questions whose answers walk the whole chain;
  the discrimination lives at p25 and below.
- **Occupancy shares do not transfer between hosts.** These are Claude Code on a
  nominal 200k window (`CG_WINDOW_TOKENS` overrides it). Window size, system
  prompt, and compaction policy all differ elsewhere. The *ratio between the
  arms* is the part that travels; the percentages are not a claim about Cursor.
- **Compare the right pair.** In a with/without A/B that is codegraph's residual
  against the without-arm's **file-access** residual (Read + Grep/Glob + Bash) —
  the two ways an agent gets the same bytes into its head. Counting only the
  Read tool scores as "read nothing" a run that reached for `cat` through Bash.
- **Sufficient is not correct**, and a Read is a vote rather than a proof. The
  bucket is still the right signal — the agent read *because something was
  missing* — but a single call is noisy.
- **Small-n, always.** Runs make 1–5 explore calls, so one run's percentages are
  coarse. The table prints `median [min–max]` for exactly this reason: report
  the range. Use `RUNS>=2`, and a campaign for a verdict.
- **Subagent contexts are not counted in occupancy.** A `Task` subagent has its
  own window and only its summary returns. Sufficiency *does* follow the
  subagent thread (a delegation is judged by what the subagent did first), so
  the two metrics treat delegation differently on purpose.
- **Deferred tool schemas land in occupancy's `base`.** `codegraph_explore` is
  deferred: `ToolSearch` pulls the schema in later, and that injection is not a
  tool result. The fixed-overhead line prices the part present from the start.

---

## Contamination — read this row first

Both harnesses run every arm with the codegraph CLI blocked: a PATH with the
binary symlinked out, plus a `PreToolUse` hook that blocks absolute-path
invocations (`no-cli-shim.sh`, shared by both). Both layers exist because both
were needed — an agent denied `codegraph` on PATH ran `find / -iname
"*codegraph*"` and invoked it by absolute path.

The contamination row is the detection half, and it is not redundant with the
prevention half: prevention fails silently the next time the binary lands
somewhere new.

- In a **with/without** A/B, a CLI call means the without-arm was not without
  codegraph. 14 of 15 without-arm runs in one 7-repo pass did this before the
  shim existed; **any older result from this harness should be assumed
  contaminated**.
- In a **new/baseline** A/B, both arms are codegraph-on, so a CLI call is not a
  leak but an **attribution** failure that breaks all three metrics at once:
  output arriving through Bash is charged to Bash in the occupancy table, and an
  explore issued through the CLI is not a tool call at all, so it never reaches
  the sufficiency classifier or the allocation parse. The run silently drops
  calls from every number above it.

`CLI attempts blocked` is benign — the agent tried, nothing entered the window.
`CLI calls that RETURNED output` is not.

---

## Tests

```bash
node scripts/agent-eval/parse-run.mjs --selftest     # 68/68
```

Covers all three metrics over synthetic transcripts with known answers: the
occupancy math (calibration, eviction, compaction), every sufficiency bucket
plus the same-message / thread / delegation rules, and the allocation citation
channels with their guards. See each metric's doc for the case list.
