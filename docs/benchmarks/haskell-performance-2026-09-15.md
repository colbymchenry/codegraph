# Haskell corpus performance — 2026-09-15

The final optimized build completed the five-corpus normal matrix, full test
suite, and all three GHC core runs. Full GHC exceeded the 600-second cap in both
arms. The separate diagnostic profile identifies optimization targets; only the
normal repeated runs below support the reported speedup. Read-only comparisons
found matching node rows and no missing persisted baseline edge tuples in both
GHC scopes; the incomplete baselines cannot establish full graph parity.

This campaign compares the Haskell implementation at
`82eca65a2fc89151d64a2b539e106fa538f93972` with the resolver optimizations
accompanying this report. It revisits the four corpora used in the
[September 13 audit](haskell-audit-2026-09-13.md), adds GHC as a larger stress
case, and uses Express as a non-Haskell control. This is an indexing,
incremental-consistency, and deterministic-retrieval comparison. It is not an
agent A/B benchmark or a new language/framework capability claim.

## Builds and environment

| Item | Setting |
|---|---|
| Baseline source | `82eca65a2fc89151d64a2b539e106fa538f93972` |
| Optimized source | Same baseline plus changes committed with this report |
| Optimized resolver Git blob | `c97ee7cdb28e0c3f387700c41bf020064a66ab7f` |
| Runtime | Node.js 24.18.0 |
| Host | Apple M5 Pro, 48 GiB memory, 18 logical CPUs, macOS |
| Extraction backend | `CODEGRAPH_KERNEL=0` in both arms |
| Normal-run parallelism | Default parser and resolver settings in both arms |
| Run scheduling | Serial measured workloads; independent builds/tests kept outside timed runs |
| Package version | Unchanged |

Each arm uses a frozen built engine, so edits to the development checkout cannot
change a running comparison. The SHA-256 of its compiled
`dist/resolution/import-resolver.js` identifies the two frozen artifacts:

- Baseline: `0b2306d968a56a05260179de00eacc2d610d83e79e0062622de8dc1bcf88ab4e`.
- Final optimized (`optimized-v2`): `c7e3c8b04cdc04a5e15fc10d746c49290ddfbbc94d6489e8a6ad4880fbe9440d`.

The initial optimized build, V1, is retained as historical diagnostic evidence.
Its normal timings are excluded from the final matrix, which compares the same
baseline runs with three fresh V2 runs for each corpus in the five-corpus comparison.

The baseline already includes the prior review's traversal budget, lexical-scope
fixes, and canonical-combinator checks. Comparing against an older PR revision
would mix correctness changes into this performance comparison.

## Pinned corpora

These counts describe tracked source inventory, before CodeGraph filtering.
They must not be substituted for the indexed-file counts in the final results.

| Corpus | Revision | Tracked files | Tracked `.hs` / `.lhs` |
|---|---|---:|---:|
| xmonad | `1a875b3413e72a766ce2b1d4c39b8f796c1ac311` | 63 | 30 / 1 |
| [pandoc](https://github.com/jgm/pandoc) | `b913622e1ff87c69ab8b1a606577122e220925cd` | 2,842 | 367 / 0 |
| [haskell-language-server (HLS)](https://github.com/haskell/haskell-language-server) | `c98343b869786994a0ece7830910551bd8a0c195` | 1,945 | 1,443 / 7 |
| Private corpus | Same pinned revision as the September 13 audit | 1,572 | 1,415 / 0 |
| [GHC mirror used](https://github.com/ghc/ghc) | `82c73b223a985bc0bcc00cb6252b2b535082d831` | 26,973 | 14,014 / 28 |
| [Express control](https://github.com/expressjs/express) | `3ce6d0eb86e9d93529ff3191c6bb5db8ce6e72c8` | 214 | 141 JavaScript files |

GHC is measured in two scopes:

- **GHC core:** the same source archive with `testsuite/` excluded through
  `codegraph.json`; three fresh indexes per arm were intended, conditional on
  the first attempt completing within 600 seconds. Capped attempts do not count
  as completed samples. The inventory above still describes the full archive,
  not the smaller indexed scope.
- **Full GHC stress:** `testsuite/` included; one attempt per arm with a
  600-second process cap. Timeout-prone and deliberately unusual parser fixtures
  are part of this stress case. Neither arm initializes GHC's Git submodules.

All corpus copies come from Git archives of the pinned revisions. Tracked
`.gitignore` files remain present, `.git` is absent, and every run starts without
`.codegraph/`. Dependencies are not installed in corpus copies. Existing source
checkouts and their indexes are not used as benchmark output directories.

The private corpus remains local. This public report includes its label and
aggregate counts only; its source, symbol names, query text, source paths, and
revision identifier are not copied into this report.

## Measurements and correctness checks

The reusable harness is
[`scripts/benchmarks/haskell-corpus.cjs`](../../scripts/benchmarks/haskell-corpus.cjs).
For each successful run it records:

1. Initialization and full `indexAll` wall time and CPU time separately. The
   primary index duration excludes initialization and all subsequent checks.
2. The resolution-and-synthesis stage, measured around the engine's existing
   `resolveReferencesBatched` method, and peak process RSS. Index-phase peak RSS
   is saved separately from peak RSS over the complete verification process.
3. Three no-change synchronizations, timed individually, with graph fingerprints
   checked after each. Their durations are not added to the index duration.
4. A comment-only edit and an exported identity-function edit, each followed by
   restoration and another synchronization. Each edit and restoration gets its
   own duration and fingerprint. xmonad, pandoc, and the private corpus exercise
   these edits in every run; HLS exercises them in the first normal run of each
   arm. Express and both GHC scopes skip source-edit probes.
5. Three deterministic flow queries per corpus, using fresh `ToolHandler`
   instances. The actual compact Flow section returned by `codegraph_explore`
   and the separate `resolveNamedSymbolFlow` result are recorded independently.
6. SQLite `quick_check`, foreign-key checks, orphan-edge counts, file errors,
   reference statuses, and heuristic-edge counts by mechanism.

Appending a comment can change source extents, so its edited fingerprint need
not equal the original. **The restored fingerprint must equal the original.**
The exported identity edit must introduce its declaration; removing it must
restore the graph. The harness restores the file in `finally`, and also restores
the source on an intentional interrupt. An interrupted index is marked as such;
restoring its source file does not make its partial database a completed result.

Fingerprints stream rows in a deterministic SQL order rather than loading the
entire graph into memory. They include:

- The historical node projection, retained for comparison with previous audit
  artifacts: ID, kind, name, qualified name, path, and start/end lines.
- Every node column except `updated_at`, covering signatures, lexical ranges,
  export flags, decorators, and other semantic fields as well.
- Edge source, target, kind, line, column, metadata, and provenance. Surrogate
  edge row IDs are excluded. Stored metadata JSON is hashed exactly, without
  reordering its object properties or discarding fields.

The older diagnostic report predates the full-node fingerprint addition. Its
historical node/edge projection can be compared with newer reports, but that
comparison alone does not establish equality of every node field.

The harness checkpoints the initial index result before graph verification and
appends progress events to a separate NDJSON file. A later verification timeout
therefore cannot be mistaken for an index timeout. Partial indexes retain their
diagnostics, and failed/interrupted attempts remain visible instead of being
silently removed from the sample set.

## Profile findings and optimization

A separate HLS diagnostic run disabled parallel resolution and enabled V8 CPU
profiling, resolver stage timers, and canonical-origin counters. Its initial
index completed in 162.053 seconds. The process was intentionally stopped with
`SIGTERM` during the later topology-edit probe after initial indexing and the
comment restoration had completed. The approximately 199-second CPU profile
therefore includes indexing and part of the synchronization workload.

| Function or operation | Self time in the diagnostic profile |
|---|---:|
| `resolveImportPath` | 86.2 s |
| Wildcard `parentVariants.flatMap` callback | 49.8 s |
| `findExportedSymbolWalk` | 14.3 s |
| `normalizeHaskellReferenceName` | 10.5 s |

The final diagnostic counters also show 1,222 combinator-origin checks for
397 distinct file/name pairs, costing 21.1 seconds across that mixed workload.
These counters overlap the CPU-profile categories and must not be added to
them. The single diagnostic run explains where to optimize; its elapsed time
is excluded from normal baseline medians and ranges. In particular, comparing
its sequential/profiling index time with a normal optimized run would not be a
valid speedup calculation.

The measured costs led to these changes:

- **Import-path cache keys:** nested maps use the language, importer path, and
  module specifier as separate keys. Repeated facade hops reuse those strings
  instead of constructing and hashing a long composite key each time. Cache
  clearing and cached misses retain their previous meaning.
- **Wildcard traversal allocations:** fixed-shape lookup objects and a small
  loop replace per-hop object spreads, `flatMap`, and temporary candidate maps.
  Pure name-spelling variants travel through wildcard hops; a named rename
  computes fresh variants for its new name.
- **Visibility predicates:** an unrestricted wildcard preserves its inherited
  predicate without adding an identity wrapper. Parent restrictions, namespace
  restrictions, and explicit allow/deny lists still apply. Traversal stops once
  two fully permitted, distinct targets establish ambiguity.
- **Canonical-origin proofs:** a bounded cache stores only complete top-level
  booleans. Its key includes the context, file, full normalized reference name,
  namespace, implicit-Prelude setting, and identities of both policy collections.
  Existing cache invalidation drops these results when source/topology changes.
  Indexed import/re-export routes avoid scanning irrelevant names, and a
  noncanonical competitor stops the proof immediately.
- **Final outer-import stop:** V2 adds an eight-line early stop in
  `wildcardTargets`: an ambiguous imported module or two distinct permitted
  entities already rule out a unique answer. Both consumers reject that result,
  so later imports cannot change it. Five regression cases cover both consumers,
  repeated cache reads, duplicate facades, hidden names, and skipped expensive
  siblings. Two routes to the same entity do not trigger the stop.

Neither depth limits nor the shared 10,000-visit budget were raised. Budget
exhaustion remains a conservative failure to establish a unique/canonical
target. Recursive proof or exported-symbol results are not newly memoized:
ancestry, accumulated visibility restrictions, and remaining budget make those
intermediate answers context-dependent.

## Reproduce a normal run

Build each engine before measurement with `npm ci` and `npm run build`; preserve
the two resulting engine directories. Use the baseline revision above and the
optimized source revision associated with the final report. Run one measured
process at a time. Keep profile-only environment variables unset for normal
comparisons.

The following example uses a disposable xmonad copy. Replace the engine/source
paths with your prepared checkouts and use a new output path for every run:

```bash
TASK_BENCH_ROOT=$(mktemp -d /tmp/codegraph-haskell-bench.XXXXXX)
TASK_XMONAD_SOURCE=/absolute/path/to/xmonad-source
TASK_ENGINE_ROOT=/absolute/path/to/frozen-engine
mkdir "$TASK_BENCH_ROOT/xmonad-1"
git -C "$TASK_XMONAD_SOURCE" archive 1a875b3413e72a766ce2b1d4c39b8f796c1ac311 |
  tar -xf - -C "$TASK_BENCH_ROOT/xmonad-1"
cat > "$TASK_BENCH_ROOT/options.json" <<'JSON'
{
  "queries": [
    "manage float windows",
    "kill withFocused killWindow",
    "refresh windows modifyWindowSet"
  ],
  "editFile": "src/XMonad/ManageHook.hs",
  "explicitExports": false
}
JSON
env -u HASKELL_PROFILE -u CODEGRAPH_RESOLVE_PROFILE \
  -u CODEGRAPH_NO_PARALLEL_RESOLVE -u CODEGRAPH_RESOLVE_WORKERS \
  CODEGRAPH_KERNEL=0 \
  node scripts/benchmarks/haskell-corpus.cjs \
  "$TASK_ENGINE_ROOT" "$TASK_BENCH_ROOT/xmonad-1" \
  "$TASK_BENCH_ROOT/result-1.json" "$TASK_BENCH_ROOT/options.json"
```

For the normal matrix, repeat with three fresh source archives per arm. GHC
core's intended repeats are conditional on its first attempt completing within
the cap; report timeouts instead of replacing them with successful samples.
The harness refuses an
existing `.codegraph/` directory or result JSON. `skipSyncEdits: true` disables
both edit probes. GHC core additionally uses
`"config": { "exclude": ["testsuite/"] }`; the full GHC case omits that
exclusion. `editReplacementFile` can supply a reviewed replacement source for
an explicit export layout that the built-in edit helper cannot safely rewrite.

For a separate diagnostic, use a fresh corpus and output path with
`HASKELL_PROFILE=1`, `CODEGRAPH_RESOLVE_PROFILE=2`,
`CODEGRAPH_SYNTH_TIMINGS=1`, `CODEGRAPH_NO_PARALLEL_RESOLVE=1`, and Node's
`--cpu-prof` flag. Keep those results separate from the normal matrix. The
canonical wrappers time exported functions without replacing the resolver's
context object, preserving its existing cache identities.

### Exact public-corpus options

The xmonad example above contains its exact queries and edit options. For the
other public corpora, use these strings as the three-element `queries` array;
apostrophes and qualified names are significant.

| Corpus | Query 1 | Query 2 | Query 3 |
|---|---|---|---|
| pandoc | `readMarkdown readWithM parseMarkdown` | `writeHtml5 writeHtml' pandocToHtml` | `writeLaTeX pandocToLaTeX blockListToLaTeX` |
| HLS | `Ide.Main.defaultMain runLspMode Development.IDE.Main.defaultMain` | `getIdeas moduleEx getParsedModuleWithComments` | `hover request logAndRunRequest getAtPoint` |
| GHC, both scopes | `hsc_typecheck tcRnModule' tcRnModule` | `hscDesugar hscDesugar' deSugar` | `hscSimplify hscSimplify' core2core` |
| Express | `json stringify` | `render tryRender` | `set compileQueryParser` |

`editFile` is relative to the disposable corpus root. Omitting `skipSyncEdits`
means false; true skips source edits/restorations but retains indexing,
no-change syncs, and retrieval probes. Default CodeGraph filtering still applies.

| Corpus/scope | `editFile` | `explicitExports` | `skipSyncEdits` |
|---|---|---|---|
| pandoc | `src/Text/Pandoc/Transforms.hs` | `true` | `false`, all repeats |
| HLS | `ghcide/src/Development/IDE/Core/Tracing.hs` | `true` | `false` in repeat 1; `true` in repeats 2–3 |
| GHC core | `compiler/GHC/Cmm/InitFini.hs` | `true` | `true` |
| Full GHC, V2 | `compiler/GHC/Cmm/InitFini.hs` | `true` | `true` |
| Express | Omitted | Omitted | `true` |

GHC core additionally sets `"config": { "exclude": ["testsuite/"] }`; full
GHC omits that override. The retained full-GHC baseline had `skipSyncEdits`
omitted/false, but stopped during indexing before edits. That flag difference
does not affect its initial-index observation. Full-GHC V1 also skipped edits.
The exact public inputs come from the retained options and run-specific
snapshots; private-corpus options are intentionally excluded.

## Normal results

The five-corpus comparison uses three fresh indexes per arm. Times below are seconds,
reported as median [minimum–maximum]. The sequential diagnostic and preliminary
xmonad smoke, and all V1 optimized timings, are excluded. HLS indexing fell
**52.2%**, from 87.564 to 41.850 s. Pandoc and xmonad also improved. The private
corpus shows no overall indexing gain: its median rose 2.1%, with overlapping
ranges. Express remains essentially unchanged at 0.496 → 0.499 s.

| Corpus | Baseline index | Optimized index |
|---|---:|---:|
| xmonad | 0.686 [0.670–0.700] | 0.547 [0.546–0.730] |
| pandoc | 14.953 [14.574–15.010] | 12.268 [12.049–12.884] |
| HLS | 87.564 [85.504–88.502] | 41.850 [40.739–43.037] |
| Private corpus | 7.722 [7.550–7.861] | 7.885 [7.542–8.093] |
| Express control | 0.496 [0.491–0.551] | 0.499 [0.487–0.503] |

Each of those five corpora contributes **nine no-change sync samples per arm**
(three per run). Comment and topology edits, and their corresponding restores,
have three samples per arm for xmonad, pandoc, and the private corpus; HLS has
one of each per arm. Express skips edits. Edit timings exclude restoration.

| Corpus | No-change sync, baseline → optimized, s | Topology edit, baseline → optimized, s | Edit samples/arm |
|---|---|---|---:|
| xmonad | 0.014 [0.013–0.017] → 0.013 [0.012–0.015] | 0.275 [0.273–0.277] → 0.185 [0.183–0.185] | 3 |
| pandoc | 0.058 [0.053–0.096] → 0.061 [0.053–0.098] | 6.441 [6.367–7.062] → 3.281 [3.267–3.419] | 3 |
| HLS | 0.071 [0.068–0.086] → 0.072 [0.068–0.087] | 67.593 → 28.696 | 1 |
| Private corpus | 0.068 [0.067–0.103] → 0.070 [0.067–0.078] | 3.807 [3.758–3.837] → 3.467 [3.423–3.696] | 3 |
| Express control | 0.017 [0.016–0.022] → 0.018 [0.017–0.022] | Not measured | 0 |

HLS topology restoration took 71.565 → 29.275 s, also one sample per arm.
Its edit improvement is therefore a single paired observation, not a
three-run estimate. No-change sync remains effectively unchanged.

All 30 indexes in the five-corpus comparison passed database integrity checks
and indexed with zero file errors. Full-node and edge fingerprints match across
arms and repetitions;
every no-change sync and restored edit returns to the initial fingerprint.
Named graph-query chains and actual surfaced Flow summaries also match across
arms and repetitions. The resulting graph sizes and retrieval gaps are:

| Corpus | Indexed files | Nodes | Edges | Queries with surfaced Flow / 3 |
|---|---:|---:|---:|---:|
| xmonad | 40 | 1,075 | 3,195 | 0 |
| pandoc | 600 | 18,498 | 66,395 | 2 |
| HLS | 1,587 | 22,128 | 44,713 | 2 |
| Private corpus | 1,425 | 45,974 | 96,021 | 3 |
| Express control | 148 | 1,124 | 3,154 | 0 |

The xmonad and Express queries retain missing/partial paths; pandoc query 1 and
HLS query 3 also lack the requested complete path. None of these queries gained
or lost coverage in the optimized build. Surfaced-Flow counts are structural
diagnostics, not a claim of semantic completeness or agent sufficiency.

### GHC core: three V2 runs complete

V2 completed all three core indexes: **384.681 s median
[380.567–437.483]**. Resolution and synthesis took 363.774 s
[359.703–408.292]; the complete benchmark processes, including verification and
retrieval probes, took 391.735 s [387.512–443.811]. The baseline attempt timed
out at 600 seconds, so there is no completed baseline median or paired timing
ratio for this scope.

| Completed V2 core runs | Indexed files | Nodes | Edges | Peak index RSS, median [range] |
|---:|---:|---:|---:|---:|
| 3 | 2,795 | 117,910 | 277,022 | 5,131.8 [4,957.4–5,144.1] MiB |

Each index has zero fatal file errors and retains 20 parse warnings from C
headers. SQLite integrity, foreign-key, and orphan checks passed in all three;
no pending references remain. Full-node and edge hashes match exactly across
the three fresh indexes. All **nine no-change syncs** preserved those hashes,
with a median of 0.174 s [0.152–0.242]. Source edits were skipped.

None of the three queries surfaces a Flow in any run. Each separate named graph
query connects only its first two requested symbols, identically across all
three indexes. These runs establish repeatable indexing and stable no-change
synchronization, while the requested end-to-end retrieval paths remain
incomplete.

A read-only comparison of the interrupted core baseline with completed V2 run 1
found identical full-node rows and parse-warning counts. Every persisted
baseline edge tuple is present in V2: zero are missing. The baseline retained
149,907 edge rows and 513,253 pending references, whereas V2 has 277,022 edge
rows and no pending references. This establishes preservation of the observed
baseline subset; it cannot establish completed-baseline edge parity or validate
edges that baseline resolution had not reached.

### Full GHC: both arms exceed the cap

The final V2 stress attempt timed out after **600.301 s of process time**, while
still resolving references. The last progress checkpoint reached 383,483 of
787,876 references. The baseline also timed out at the 600-second cap. Neither
attempt reached the harness's completed-index, synchronization, or retrieval
checks, so there is no completed index duration, timing ratio, or flow result
for this scope.

A read-only SQLite comparison, including retained WAL data, found identical
full-node hashes and parse-diagnostic counts between baseline and final V2:

| Full GHC retained state | Baseline | Final V2 |
|---|---:|---:|
| File records | 14,891 | 14,891 |
| Nodes | 232,604 | 232,604 |
| Persisted edge rows | 263,293 | 329,254 |
| Pending references | 724,393 | 404,393 |
| Parse warnings / errors | 44 / 2 | 44 / 2 |

Both databases remain in `index_state=indexing`. Comparing exact persisted edge
tuples (source, target, kind, line, column, metadata, provenance) found **zero
baseline tuples missing from V2**. This is directional subset evidence from two
incomplete indexes, not edge equality or validation of unobserved baseline
edges. Matching node rows also do not imply error-free parsing or successful
indexing. The different retained edge and reference counts are progress
diagnostics, not a completed-workload speedup measurement.

### Historical GHC attempts and partial extraction checks

The baseline and V1 each reached the 600-second cap in **both** GHC scopes: four
interrupted indexes, excluded from completed-run medians. Core's intended three runs per arm
were conditional on the initial attempt completing; a timeout does not count
as a successful first sample.

A separate read-only inspection of those four retained databases found matching
full-node hashes between baseline and V1 within each scope:

| Historical partial scope | Retained file records | Retained nodes | Recorded parse diagnostics per arm |
|---|---:|---:|---|
| Full GHC | 14,891 | 232,604 | 44 warnings and 2 errors across 46 files |
| GHC core | 2,795 | 117,910 | 20 warnings across 20 files |

These are retained extraction counts, not completed-index results. All four
databases still report `index_state=indexing` and retain pending references.
Their node equality does **not** establish edge parity, complete parsing,
coverage, or successful indexing. This historical baseline/V1 inspection compared
node rows only; the separate baseline/final-V2 edge-subset checks are described
above.

Final V2 validation passed: **4,716 tests**, with 192 skipped, across 264 passed
and 16 skipped suites. The build and `npm pack --dry-run` also passed; the
1,116-file package listing contains the Haskell grammar.

## Limits of this evidence

- Measurements describe one macOS host and the configured WASM extraction
  path. Linux, Windows, the native kernel path, and other hardware are not
  measured by this campaign.
- Fresh source copies and databases do not imply cold operating-system file
  caches. No machine-wide cache purge is performed. Report ranges and preserve
  run order to make variance visible.
- Three repetitions support a local comparison, not a universal timing bound.
  A single capped full-GHC attempt supports only that attempt's stress outcome;
  it cannot establish a median, completed-index parity, or complete coverage.
- GHC core excludes the test suite, while full GHC includes deliberately hard
  parser inputs. The two scopes answer different questions and must not share
  a performance row or a claimed gain.
- `.lhs` inventory counts do not imply literate-Haskell support. Missing
  submodules and unsupported/ignored files limit the code available to index.
- Matching graphs establish preservation of the compared output, not its
  completeness or universal precision. Successful tool execution and a separate
  graph path do not prove that the returned explore response contains a
  sufficient end-to-end explanation. Empty/partial flows need explicit review.
- The prescribed Sonnet agent A/B was unavailable because the required Claude
  CLI was absent. No agent latency, Read/Grep displacement, tool-call, token,
  cost, or agent-sufficiency claim follows from these deterministic probes.
