# Explore allocation efficiency

> One of three feedback metrics the agent-eval harness reports on every run.
> [`agent-eval-feedback-metrics.md`](agent-eval-feedback-metrics.md) is the entry
> point: which metric answers which question, which harness to run, and how to
> read the arm-comparison table.

**What it measures:** of the bytes a `codegraph_explore` response spent, what
share went to files the agent's answer actually drew on.

```
allocation efficiency = bytes returned for files the final answer cited
                        ───────────────────────────────────────────────
                        all bytes returned
```

That is issue #1500 as a number. The envelope view
([`explore-allocation-ab-1500.md`](explore-allocation-ab-1500.md)) already
showed *how* a response was divided across files, but deciding which of those
files mattered took a human writing `--answer 'lib/response.js'` per question.
This reads the same intersection off the agent's own final answer, so every run
reports it for free.

**Read it as a relative metric.** Attribution is by citation, and an agent can
use a file's source without ever naming it — to rule the file out, or to build a
mental model it then writes up from somewhere else. So this compares two builds
on the *same* question; it is not an absolute claim that 15% of an envelope was
waste. [What it does not say](#what-it-does-not-say) is the full list.

Harness-only, like the other two feedback metrics: nothing is emitted from the
product, nothing leaves the machine. It is parsed out of transcripts we already
write.

---

## Running it

Every run prints it — `run-all.sh` and anything else that calls `parse-run.mjs`:

```bash
node scripts/agent-eval/parse-run.mjs /private/tmp/cg22/ab-express/run-baseline-1.jsonl
```

```
  Explore allocation — share of returned bytes the answer used (2 calls, 4 files):
    efficiency  81.9%  17,465 of 21,319 chars   (3/4 files cited; path-cited alone 64.9%)
    call 1:  84.0%  10,121/12,048 chars  2/3 files
    call 2:  79.2%  7,344/9,271 chars  2/3 files
    *  34.9%   7447  lib/response.js  path
    *  30.0%   6396  lib/utils.js  path
       18.1%   3854  lib/express.js  —
    *  17.0%   3622  lib/application.js  symbol `compileETag`
```

Interactive runs get the same block from `parse-session.mjs <project-dir>`.

**Per call as well as per run.** A run-level number hides the shape that matters
most — call 1 on target, call 3 pure noise. The per-call lines name which call
spent its budget on files nothing came back to.

`--answer <glob>` and `--envelope` still work and are unchanged: they are the
*hand-specified* ground truth, useful when you want to score against the files
you know answer the question rather than the ones the agent happened to name.

---

## How a file is judged used

Two citation channels, ranked so the weaker one stays separable — the summary
line always reports **path-cited alone** next to the combined number.

**1. Path.** The answer names the file: `lib/response.js:126-220`, an absolute
path, or the bare `utils.js:225` agents drop into prose. Bare basenames are
accepted only when the extension is one the envelope actually shipped, which is
what keeps `res.send` and `mime.contentType` — the same token shape — from
reading as file citations.

**2. Symbol.** The answer cites, inside a code span, a symbol that the file's
section header lists as **defined**. This catches answers written almost
entirely in symbol names. It is guarded three ways, all in the direction that
costs us efficiency rather than inflating it:

- **Definitions only.** The header renders `name(kind)` for every node in the
  shipped clusters, and that includes call sites (`mutateElement(calls)` on a
  file that merely calls it). Crediting those marked excalidraw's
  `dragElements.ts` used because the answer named `mutateElement`.
- **A definition beats an import alias.** `var compileETag = require('./utils')`
  is a `variable` node, so a file that only re-binds a name loses to the file
  that defines it, when both are in the envelope.
- **A name on 3+ returned files identifies none of them.** Without this,
  `send` or `get` marks half an envelope used.

Prose mentions do not count — only code spans. A backtick is the agent marking
the token as code, and that is the whole signal.

**A file returned twice is charged twice**, because it occupied the window
twice. Same accounting as the envelope view.

**The answer** is the `result` event's text (one per resumed segment of a
multi-turn session — all of them are answers, so all are pooled). An interactive
transcript has no `result` event, so it falls back to the last main-thread
assistant text; intermediate narration is deliberately excluded, or "let me look
at App.tsx" would count as a citation.

---

## Baseline

Swept over every A/B log on this machine, the same corpus CG-8 used: **103
sessions** with at least one answered explore (74 single-question, 29 multi-turn
3-question sessions), **297 explore calls**, 815 file sections, 0 crashes.

| Slice | n | pooled | median | p25 | p75 | min | path-cited only |
|---|---|---|---|---|---|---|---|
| all | 103 | 85.6% | 90.1% | 82.0% | 97.7% | 20.1% | 80.2% |
| single-question | 74 | 85.2% | 88.8% | 82.0% | 95.6% | 20.1% | 82.2% |
| multi-turn (3 turns) | 29 | 86.2% | 92.1% | 85.0% | 100.0% | 57.4% | 77.5% |

Per call: median 94.7%, p25 79.2%.

**The absolute level is high, and that is a property of the corpus, not good
news.** These are flow questions whose answers walk the reader through the
chain, naming most files on it. The metric is byte-weighted, so it is dominated
by whether the *largest* allocations landed on cited files — which is exactly
the #1500 question, and also why the typical run scores in the eighties. The
discrimination lives in the p25 and below, not around the median. **Never quote
the median as "codegraph wastes 10% of what it returns."**

**The tail is where the signal is.** The lowest run in the corpus is 20.1%:
`cg8-val` — excalidraw's `canvasNonce` question, the documented data-flow
frontier. Three explores returned 11 files / 60,694 chars; the answer drew on
two of them (`Scene.ts`, `StaticCanvas.tsx`) and reconstructed the rest by
reading `Renderer.ts` and `App.tsx`, which the envelope never shipped. That
reproduces the 16–30% range CG-1 measured by hand on the self-query, and it
reproduces it without anyone marking an answer set.

### New-build vs baseline-build — the intended use

Medians over the existing CG-15/CG-21/CG-22 A/B arms, both arms codegraph-on:

| Pass / repo | baseline | new |
|---|---|---|
| cg15 / express | 82.0% | **100.0%** |
| cg15 / excalidraw | 90.1% | 92.8% |
| cg15 / client-go | 84.1% | 80.8% |
| cg21 / express | 84.1% | **100.0%** |
| cg21 / excalidraw | 91.3% | 97.5% |
| cg21 / client-go | 67.1% | **95.0%** |
| cg22 / express | 81.9% | **100.0%** |
| cg22 / excalidraw | 89.3% | 79.2% |
| cg22 / client-go | 86.6% | 93.3% |

Express is the #1500 case and it moves the most: the baseline arm reliably spent
18% of its envelope on `lib/express.js`, a file no answer ever cited, and the
allocation fix cut it — 81.9 / 82.0 / 81.9% across three baseline runs, 100.0 /
92.5 / 100.0% across three new ones. That is the change stated as a number
rather than as "the express arm looks tighter now."

Two pairs go the other way (cg15/client-go −3pt, cg22/excalidraw −10pt). The
cg22/excalidraw spread is 89.3 / 85.6 / 90.8% baseline against 87.4 / 79.2 /
78.2% new — real, but n=3 on a question with known run-to-run variance. Report
the range, not the median of three.

---

## What it does not say

- **Uncited is not unused.** An agent reads a file, decides it is not the
  answer, and never mentions it. That was useful work and this metric calls it
  waste. The error is one-sided and it is why the number is only comparable
  between builds on the same question.
- **Cited is not "needed at that size."** The metric asks which *files* earned
  their bytes, not whether the right *lines within* a cited file were shipped.
  A file cited by the answer scores 100% of its section even if the agent then
  had to Read it for the part we clipped out. The sufficiency bucket
  `Read a file we returned` is what catches that; the two metrics are
  complementary, and CG-13 reports both.
- **A basename match can land on the wrong file.** `src/index.ts` in the
  envelope matches an answer citing `packages/element/src/index.ts`. Rare in
  practice, but it is a real false-positive channel.
- **Small-n.** Runs make 1–5 explore calls, so one run's percentage is coarse.
  Compare over a pass (`RUNS>=2`, and the CG-13 7-repo campaign), never n=1.
- **Efficiency is not value.** A response can be 100% efficient and useless — a
  single small file the answer names in passing. Read it alongside sufficiency
  ([`explore-sufficiency.md`](explore-sufficiency.md)) and occupancy
  ([`residual-context-occupancy.md`](residual-context-occupancy.md)), which is
  the point of wiring all three into the same run.

---

## Tests

`node scripts/agent-eval/parse-run.mjs --selftest` covers the metric over
synthetic transcripts with known answers, alongside the occupancy and
sufficiency checks (68/68). The allocation cases: the one-of-three-files shape,
bare-basename citations and the dotted-expression tokens that must *not* match,
symbol attribution crediting the definer and not a caller, a definition beating
an import alias, the 3-file ambiguity cutoff, prose-vs-code-span, per-call
versus pooled accounting, a file returned twice being charged twice, both
final-answer sources, and the end-to-end path through `parseSession`.
