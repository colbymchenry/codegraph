# CG-38 — an agent-named symbol in the tail of a large file never rendered

**Status: fixed.** Two independent causes, both longstanding. Not a CG-24 regression —
the controlled bisect (index held fixed, engine varied across every epic merge point)
found the symptom at every build including pre-epic.

## The report

On a 1,414-line Svelte store, `codegraph_explore` never returned `queueMessage`
(L1087) or `flushQueuedMessages` (L1102) — on a bare symbol bag *or* a prose
question — even though their file won rank #1 with score 127 and 67.3% of the
envelope. What came back instead was the same-stem `QueuedMessage` **interface** at
L70. The agent had to Read the file to find the two functions it had asked for by
name, which is the one outcome explore exists to prevent.

CLAUDE.md's *"guarantee named symbols render"* — the importance-9 named-def
injection — was not holding.

## What it actually was

### 1. The named-symbol IDENTITY was discarded with the narrative

`buildFlowFromNamedSymbols` returns two unrelated things: the Flow prose, and the
SET of node ids the agent named. Downstream, that set is what injects a named def
into its file's cluster ranges and ranks it **importance 9** — the entire mechanism
behind the guarantee.

Its last gate was:

```ts
if (!hasMain && synthLines.length === 0 && !boundaryText && !polyText) return EMPTY;
```

`EMPTY` zeroes `namedNodeIds` too. So whenever the named symbols happened not to
produce anything to *print*, the guarantee silently switched off. Two sibling
closures in one factory are exactly that case: `queueMessage` and
`flushQueuedMessages` never call each other, so there is no chain, no synthesized
hop and no dispatch boundary — and both defs lost importance 9. The file then
rendered from its head, which is how a 6-line interface displaced two functions
1,000 lines below it.

Measured: `flow.namedNodeIds` was **empty** on the reported query, while
`findAllSymbols` resolved both tokens to exactly 1 node each.

The fix separates the two outputs (`identityOnly()`), restricted to **shape-precise
tokens** (camelCase / PascalCase / snake_case / qualified — the same test the gather
path uses). With a narrative present, the prose is itself corroboration and that path
is unchanged; with nothing corroborating it, only an unambiguous symbol reference may
promote, so an English word in a prose question that happens to exact-match a
callable cannot earn importance 9.

### 2. The ceiling trim cut in SOURCE ORDER

Restoring importance 9 was not enough — the symbols still did not render.

`shrinkCluster` *had* kept them: on the reported query it emitted a block spanning
`1022-1121`, which covers both. But the shrink's output measured **26,297 chars
against a 16,532 cap**, so `windowToCeiling` fired, and it fills parts in source
order and drops everything after the first overrun:

```
shrunk:   101-107, 197-226, ..., 648-989, 1022-1121      (26,297)
windowed: 101-107, 197-226, ..., 648-839                 (16,532)   ← tail gone
```

A trim that cuts in source order will always take the END of a large file first —
which is precisely where an agent-named symbol is most likely to be, and least
likely to be reachable any other way. `windowToCeiling` already had the concept it
needed (`focusLine`, for the spine's next-hop call site, CG-30); it just wasn't told
about named defs. It now takes a `focusLines` list — spine call site plus every
member at importance ≥ 9, capped at 6 — and:

- tries the **full-ceiling** fill FIRST, holding back 40% only when a focus line is
  actually left uncovered (so a cluster whose head already reaches its focus keeps
  the whole ceiling for source — an improvement on the old unconditional hold-back);
- **splits** the reserve evenly between the uncovered focus lines with carry-forward,
  rather than handing it out greedily in source order. Greedy reproduced the bug one
  level down: on the prose query, four focus lines resolved and the two earliest took
  the entire reserve, dropping `flushQueuedMessages` again.

## The accounting gap — found, measured, deliberately NOT shipped

`shrinkCluster`'s fit test uses the raw source span
(`slice().join('\n').length`) while the render adds `contextPadding` around every
block and a line-number prefix to every line. On the reported file that estimate ran
**~60% under** (16.5K accounted, 26.3K rendered).

An exact projection (prefix-summed line costs, mirroring the merge + padding
`buildSection` performs) was built and measured. **It is worse, and it is not
shipped:**

| | main | exact accounting | exact + spend-the-remainder |
|---|---|---|---|
| django | 20,719 | 20,747 | 20,747 |
| excalidraw | 19,704 | **19,606** | **19,606** |
| okhttp | 18,651 | 18,766 | 18,766 |
| tokio | 21,582 | **21,424** | 21,555 |
| gin | 11,952 | 12,082 | 12,082 |
| alamofire | 11,849 | 11,849 | 11,849 |
| `probe-allocation` | 4 PASS | **payroll-go FAIL** | **payroll-go FAIL** |

The mechanism: exact accounting stops at the last member that fits **whole**, and the
released bytes carry forward to lower-ranked files. On `payroll-go` that moved 1,296
chars out of the rank-#2 answer file `cycle.go` and into the rank-#5
`payslipstore/store.go`, taking `runPayrollCycleAll`'s `s.store.Upsert(ctx, slip)`
call — the "create" half of the query — with it.

So the slack is doing no harm where it is: `bound()` clamps the render to the ceiling
exactly, so the over-keep costs no bytes. What the slack must **not** do is decide
*which* members survive — and that is the ceiling trim's job, which is what this task
fixed. The comment on `shrinkCluster` now says so, so the next reader does not
"fix" it.

## The index-dependence lead — explained, and orthogonal

The issue's sharpest lead was that flagging the ambient `.d.ts` as `generated` seemed
to make an unrelated file's render *worse*. Flipping `files.generated` on that one row
(the CG-25 method — holds the index constant, attributes the delta to the ranker
alone) confirms the mechanism is real:

| | `generated=1` | `generated=0` |
|---|---|---|
| `.d.ts` graphScore | 0.1875 | 0.75 |
| `maxGraph` | 0.3297 | 0.75 |
| gate (6% of max) | 0.0198 | 0.0450 |
| files ranked | 3 | 2 |
| rank-#1 allowance | 9,100 | 8,166 |

`rankPenalty` scales `fileGraphScore`, `fileGraphScore` sets `maxGraph`, and the
relevance gate is 6% of `maxGraph` — so a penalty on one file does move the admitted
set and every other file's allowance. Confirmed.

But it is **not** what hid the symbols. On main they are absent at *both* flag states
(render stops at L316 / L381); with the fix they are present at *both*. The
allocation moves; the guarantee does not depend on it. Pinned by the last case in
`__tests__/explore-named-symbol-render.test.ts`.

## Results

Real repro (`queueMessage` L1087 / `flushQueuedMessages` L1102), all shapes:

| query shape | main | fixed |
|---|---|---|
| symbol bag | absent | **both render** |
| prose, symbols named | absent | **both render** |
| symbols + decoy interface | absent | **both render** |
| prose, no symbols named | absent | **both render** |

Fixture (`__tests__/fixtures/tail-render-ts`, 7 symbol checks over 3 query shapes):
**7/7 fail on main, 7/7 pass** — deterministic over 4 consecutive runs per arm.

Standing bars, all held:

- `probe-allocation.mjs` — payroll-go / starved-cluster / dense-header / self-query all PASS
- `probe-file-spend.mjs` — no starvation flags
- `probe-suite-envelope.mjs` — **byte-identical to main on all six repos** (20,719 /
  19,704 / 18,651 / 21,582 / 11,952 / 11,849), same file counts
- full suite green

The suite being byte-identical is the point: the focus windows only change what a
render does once it has *already* overrun its ceiling, which none of the six suite
queries does.

## Instruments

- `scripts/agent-eval/probe-named-symbol.mjs` — the measurement the epic lacked.
  Per-SYMBOL and binary: is the symbol's **definition line** among the response's
  rendered lines? The name alone proves nothing — it appears in the section header's
  symbol list and at call sites whether or not the body was sent, which is exactly how
  this hid through a whole epic of aggregate probes.
- `__tests__/fixtures/tail-render-ts` — mirrors the reported file's geometry: decoy
  same-stem interface at L70, factory closure at L104 spanning ~92% of the file (so
  every symbol merges into ONE cluster), targets at L1088/L1096/L1102, plus a
  2,500-line generated `.d.ts` for the ranker to penalise. Generated by script; edit
  the geometry, not individual lines.
- `__tests__/explore-named-symbol-render.test.ts` — the standing gate, including the
  fixture-shape assertions (if the fixture rots, the gate means nothing).

## Method note

A `git stash -- <path>` "baseline" reverts to **HEAD**, not to `main`. With a WIP
commit on the branch that silently measures your own change against itself — it
produced a clean "passes on main" here that was pure fiction. Use the file swap
(`git show main:<path> > <path>`), as `.kommandr/memory/baseline-builds-use-fresh-file-swap`
already says for builds.
