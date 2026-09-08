# Index drift: incremental sync vs. full rebuild (CG-33)

Measured 2026-08-06. A live, auto-sync-maintained index **does not converge** to
a clean full rebuild of the identical working tree. On codegraph's own repo,
**4.3% of distinct edges were wrong**, in both directions, overwhelmingly
`calls` edges.

This matters because it is silent: nothing warns, nothing surfaces it, and the
README tells users the index is never stale and there is nothing to re-run.
Retrieval quality decays invisibly, and the user-visible symptom — an agent
falling back to Read — reads as "codegraph isn't very good" rather than "this
index needs rebuilding."

## Result

Subject: codegraph's own `.codegraph/codegraph.db`, long-lived and
incrementally synced, against a full rebuild of the same tree with the same
build. Edges compared as distinct `(source, target, kind)` triples.

| | count |
|---|---|
| distinct edge triples (rebuild) | 28,809 |
| in rebuild but **missing** from live | **751** |
| in live but **absent** from rebuild (stale) | **476** |
| **total divergent** | **1,227 — 4.3%** |

Missing edges by kind: `calls=635`, `contains=38`, `references=34`,
`instantiates=21`, `imports=13`, `extends=10`.

### Raw counts hide it

Raw edge **rows** were 39,845 live vs 40,122 rebuilt — a benign-looking +0.7%.
The divergence is bidirectional, so a net-count check nets it out and reports
almost nothing wrong. **Any drift detector must compare edge sets, not totals.**

### The indexer is deterministic

Control, rebuild vs rebuild on the same tree and build: **0 differing edges**
(28,809 both runs). So the live-vs-rebuild delta is not run-to-run noise.

### It is resolution, not residue

Node sets are identical — `files` 501 = 501, `nodes` 10,110 = 10,110,
heuristic edges 36 = 36 — and every integrity check is 0 on *both* indexes:
no duplicate nodes, no orphan edges, no nodes referencing a missing file row.

Nothing accumulates. Cross-file **resolution** goes stale.

## Mechanism — two causes, both confirmed

`ReferenceResolver` binds a reference to one of the same-named definitions
**project-wide**. Two things follow, and the drift needed both to be fixed.

**1. Scope.** Incremental sync re-resolves only the references *in* the changed
files. Adding or removing a definition of `pct` changes the correct answer for
every `pct(...)` reference in the repo, including references in files the sync
never touches — and those references resolved successfully once, which *deletes*
their `unresolved_refs` row, so nothing existed to revisit them with. (The #1240
retry only revisits refs parked as `status='failed'`.) The index kept an answer
that was correct against an older graph.

**2. Tie-break.** When nothing disambiguated the candidates, `findBestMatch`
kept the first one, and `getNodesByName` had no `ORDER BY` — so the winner was
decided by rowid, i.e. by the order files happened to be **written**. A full
index writes in scan order; a sync appends each file as it changes. The same
tree therefore resolved to different edges depending on how the index was built,
and no amount of re-resolution could converge, because re-resolving against the
identical graph still picked a different candidate.

### The fix

- `getNodesByName` orders by `(file_path, start_line)` — a property of the code,
  not of the write order (`src/db/queries.ts`).
- `sync` returns a `definitionDelta`: the names whose set of definitions the sync
  changed, computed as the symmetric difference of `file\0name` pairs sampled
  before and after the store phase (`ExtractionOrchestrator.sync`).
- For each delta name, `resurrectStaleResolutionEdges` deletes the resolution
  edges targeting a symbol of that name whose source is in an *unchanged* file,
  and re-inserts each as the reference that created it (the `metadata.refName`
  stamp). The existing orphan sweep then resolves them against the post-sync
  graph — the same input a rebuild resolves from. Kill switch:
  `CODEGRAPH_NO_REBIND=1`.

The delta is compared **per file**, not as one name set over the whole batch: a
commit that adds `collect` to a new file while an unrelated changed file already
defines `collect` cancels out of a batch-wide name set, and that miss was the
largest residual class in the first measurement of this fix.

Conservative by construction, because a wrong deletion is a permanent edge loss
while a missed rebind is only residual drift: an edge with no `refName` stamp
(synthesized, or built by an older engine) is never touched, edges whose source
file the sync already re-extracted are skipped, and a per-name ceiling of 500
edges declines the generic names.

### Result

Replaying real commits of this repo through `sync` one at a time, then diffing
against a clean rebuild of the final tree:

| replay | baseline (`main`) | + ORDER BY only | + rebind pass (shipped) |
|---|---|---|---|
| 16 commits | 48 (24 missing / 24 stale) | 20 | **0 — converged** |
| 80 commits | 1,634 (963 / 671) | 890 | **361 (359 / 2)** |

The direction that actively misleads — **stale** edges the index keeps asserting
— drops from 671 to **2** over 80 commits, a 99.7% reduction.

Index and sync wall-clock are unchanged (392-file repo: index 1.88–2.02s in both
arms, single-file sync 0.183s in both). The `ORDER BY` costs 18% per *uncached*
name lookup in a tight loop (237ms → 280ms over 10,127 lookups), which does not
reach wall-clock because `ReferenceResolver` memoizes the lookup per name. A
composite `(name, file_path, start_line)` index would make the sort free, but it
would widen every node index entry with a full path string on the write-heavy
indexing path — not worth 43ms.

### The residual, and why it is not chased

At 80 commits, 357 of the 361 remaining edges are a single pre-existing class:
references to very generic names (`push` 260, `join` 97) that failed at index
time and stay parked because `getRetryableFailedReferences` declines any name
with more than 500 failed refs (1,412 for `push`, 2,346 for `join`). That
ceiling is #1240/#999 policy, it is present on `main`, and what it declines to
create is cross-language garbage: a TypeScript test file "calling" an R method
named `push`, or a Rust method named `join`. **The full rebuild is the wrong one
here** — converging would mean teaching sync to manufacture thousands of wrong
edges. Left as is, deliberately.

### `codegraph status` — decided: no drift metric

The issue asked whether `status` should surface divergence. Decision: **no**.

A drift number cannot be computed without the full rebuild it would be
recommending, so anything cheap enough to run on `status` would be an estimate —
and an honest estimate is not available. Shipping a proxy would violate the
product rule that a screen must not overclaim, and post-fix it would fire on the
generic-name residual above, training users to ignore it. (`status` already
refuses to warn on parked failed refs for the same reason: every repo with
external-library imports has them, so the warning would be permanent noise.)

The check that *is* exact stays available and is documented below.

## Why it degrades retrieval

Graph mass (RWR) is **relative and normalized**, so call edges missing elsewhere
inflate an unaffected file's share of the mass. Explore ranks files by that mass
(`allocateExploreBudget` weights on it), so drift silently promotes files that
should rank low.

Observed on a private application repo under heavy development: a generated
ambient-types file carried graph mass **0.24750** on the drifted index vs
**0.13119** on a clean rebuild (~1.9×), and score **49.0** vs **27.0**. On the
drifted index it took **60.7%** of an explore envelope and starved the file the
agent had actually named by symbol, which rendered **251 chars of a 10,970
reservation**. After a full re-index — no code change — the same query answers
correctly. That incident is what prompted this measurement; see CG-24.

Severity scales with churn and index age. codegraph's own repo shows 4.3%;
a repo under heavier active development plausibly drifts further.

## Reproducing

`scripts/agent-eval/diff-index-drift.mjs` is read-only and diffs two indexes.
Snapshot the live index **before** rebuilding — the original artifact for this
investigation was destroyed by re-indexing over it:

```bash
cp .codegraph/codegraph.db /tmp/live.db          # snapshot FIRST
node dist/bin/codegraph.js index .               # full rebuild
node scripts/agent-eval/diff-index-drift.mjs /tmp/live.db .codegraph/codegraph.db
```

Exit code is 0 when converged, 1 when drifted. To re-confirm determinism, diff
two consecutive rebuilds — that must report 0.

To reproduce the *regression* rather than measure a live index, replay real
commits through `sync`: clone the repo, check out `HEAD~N`, index, then
`git checkout <sha> && codegraph sync` for each commit in order, snapshot the
database, and diff it against a rebuild of the final tree. That is what produced
the table above, and the unit-scale version of it is
`__tests__/sync-rebuild-convergence.test.ts`.

## Note on probing an index

The index file is `.codegraph/codegraph.db`. There is no `graph.db`. `sqlite3`
against a mistyped path **creates an empty database** rather than failing, and
every subsequent query then answers from an empty schema — which reads exactly
like a stale pre-migration index. That produced a wrong root cause during this
investigation. `diff-index-drift.mjs` checks `existsSync` before opening for
exactly this reason.
