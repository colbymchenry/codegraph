# Release-to-main correctness repairs (September 2026)

Compared the installed `@colbymchenry/codegraph@1.6.0` npm bundle (release
`dfccdf62547fcd76d343344d823a0e1998d3a89f`) with main
`3ed73bc127323e63153bf6ec8354afa82ce36aaf`. Both ran with the bundle's Node
24.16.0 on Linux x64, identical fixture revisions/settings and separate
indexes. Native and forced-WASM probes were kept separate. Main was fetched
again before this change; the comparison base had not advanced.

## Confirmed losses and repairs

| Loss | Introducing change | Repair |
|---|---|---|
| Typed TSX-to-TS field calls, including Excalidraw's observer registration and mutation-to-render flow | `cece072` (#1792) | Use the same JS/TS language family in cached and uncached method lookup. |
| Destructured Zustand actions lose their callers | `cd4e65b` (#1759) | Trace the actual state binding before rejecting locally bound names. |
| Adding interface signatures makes store accessor calls ambiguous | `ee83636` (#1780) | Find the implementation inside the identified store, not a globally unique name. |
| Direct React Native bridge calls disappear | `de5adba` (#1790) | Retain qualified call sites and let the framework validate the module. |
| Dart extension-type getters disappear in WASM | `ee83636` (#1780) | Apply the bodyless-signature guard only to its intended JS/TS grammars. |

Each introducing commit was checked against its parent with the same minimal
fixture. The lost relationships were checked against source wiring rather
than inferred from edge-count differences. The Excalidraw path is
`Scene.mutateElement → Scene.triggerUpdate → App.triggerRender → App.render
→ StaticCanvas → renderStaticScene`.

## Remaining suite failures

The nine failing Steps assertions had two causes: external member-chain call
sites had been discarded before effect classification, and valid Zustand
selector bindings were blocked as opaque local calls. Qualified external
references now survive without becoming guessed internal call edges. Store
selectors require a Zustand factory import, resolve the selected member in
that store, and respect lexical scope and shadowing. Renamed selections and
closure captures are covered, including negative cases for unrelated
factories, stores, parameters, and local declarations.

The tenth failure was a stale callers-truncation fixture: it counted a filename
as an overload of its exact-named function. The fixture now contains two real
functions and checks that **both** truncated sections carry their markers.
The extraction parity expectations now assert the exact retained qualified
references and all argument calls. No assertion was removed or replaced by a
skip.

## Validation

- All ten formerly failing assertions pass on native and forced WASM.
- The final forced-WASM run passes 148 tests across eleven affected suites.
- Native resolver, framework, graph, context, sync-convergence, and explore
  budget checks pass. The final expanded guard/parity run passes 94 tests.
- All 655 extraction tests pass in seven sequential fresh-process batches;
  the union of passing test names is checked against all 655 original cases.
- Native/WASM TS/JS parity passes for the torture fixtures, CRLF forms, real
  source files, and optional/ordinary member chains. Dart parity also passes.
- The C deep-brace guard, shallow-file checks, worker checks, and built CLI
  stress checks pass. The two all-language 60,000-level cases remain outside
  the completed stress result, as explained below.

The original fresh-index corpus checks cover Express, Gin, Django and
Excalidraw. Source-grounded paths pass 11/12 on release, 9/12 on original main,
and 11/12 after repair. The remaining Django compiler path is absent in both
original versions. Original integrity, foreign-key and orphan checks pass on
all 44 retained corpus indexes; no-op sync preserves all fingerprinted edge
sets. Existing Gin and Django edit/restore drift is not repaired by this
change.

## Runtime limitations

The monolithic extraction suite's worker receives `SIGKILL` as its resident
memory grows to roughly 1.6–1.7 GB; sampled JS heap use is only 70–95 MB. Dense
C++ fixtures and subsequent indexing setup produce substantial native memory
growth. Lowering the JS heap or worker count does not resolve it. Fresh
batches keep peak child RSS below approximately 0.8 GB and run every assertion
successfully. This distinguishes the resource/lifetime sensitivity from the
ten reproducible assertion failures, but does not identify the exact native
allocation-retention cause.

Standalone Scala expressions nested 60,000 levels did not finish within a
45-second diagnostic budget in either native or WASM; equally deep block
expressions did not avoid the parser limitation. The existing stress tests
are unchanged. There is no claim of a full green monolithic suite or a repair
of this extreme-input parsing limit.

These checks do not cover other operating systems, a long-running watcher,
MCP transport latency, or the paid agent A/B harness. Shared-host timing was
noisy, particularly for Excalidraw, and is not used to claim a performance win.

## Independent-review follow-up (September 14–15, 2026)

The user-supplied Claude review of this PR reported 4,636 passing / 3 failing
tests, compared with 4,600 / 18 before the repairs, and confirmed the five
correctness fixes. Those full-suite figures are independent review evidence;
this follow-up did not repeat the completed full audit.

The two `CLAUDE_CONFIG_DIR` failures were path-alias mismatches. The test
fixtures now canonicalize their temporary home and working directories with
`realpathSync`, matching `chdir`'s behavior on macOS `/var` → `/private/var`.
The exact path, file content and idempotency assertions remain in place.
Both failures were reproduced on Linux using a symlinked `TMPDIR` before the
change; all seven override cases pass afterward. macOS was unavailable, so
this is a reproduced path-alias fix, not a claim of a macOS test run.

The PPID watchdog integration test now launches its wrapper and descendants
in its own temporary project. An editor's writer lock in the source checkout
can no longer end the child before the watchdog is exercised. The existing
assertions still require a live child, held-open stdin, detection of its
terminated parent and actual child shutdown. No live lock was changed and no
user server was stopped. The Linux check used a subprocess subreaper to
provide the orphan-reaping behavior otherwise supplied by `docker --init`.

The direct `name-matcher` ↔ `import-resolver` cycle is removed. The resolver
coordinator supplies import lookup through `ResolutionContext`, preserving
the existing import resolver and its caches. Two additional exact-target-set
tests cover store actions through a barrel re-export and renamed import,
including exclusion of another store's identically named action.

Follow-up validation:

- 233 native resolver/regression cases and 42 affected WASM cases pass.
- The installer suite passes 245 cases with its three existing platform
  skips; the separate symlink-root reproduction passes all seven selected
  override cases.
- The real PPID process case and 14 watchdog decision cases pass.
- `npm run build` passes, including the viewer and packaged grammar checks.
- The monolithic-worker and extreme Scala-input limitations above remain;
  these test-isolation changes do not repair native allocation retention.

## Bounded large TypeScript comparison

The comparison indexes `microsoft/vscode`'s `src/vs/platform` subtree at
`38246c086c8a825ca90190749dd88df6effec257`: 2,623 TypeScript files (26.7 MiB
of TypeScript source), plus 12 JavaScript and 457 YAML files. This is a large
subsystem, not all of VS Code; definitions outside the subtree are absent in
both arms. It is larger than the previously pinned Excalidraw fixture.

The baseline is main `3ed73bc127323e63153bf6ec8354afa82ce36aaf`; the fixed
arm is PR head `c7d2892180874f42b9f9f99119f2868fe093a816` plus the six-file
follow-up committed locally as `ec13d99`. This measures the whole PR versus
its base, not the isolated causal cost of qualified-chain retention or the
cycle refactor. Both builds use the bundled Node 24.16.0 and identical source.

Three sequential pairs were attempted per backend, with baseline/fixed order
reversed for the middle pair. Each run has a fresh
process and database, one assigned CPU, one parse worker, one resolver worker,
parallel resolution disabled, `RAYON_NUM_THREADS=1`, a 1 GiB JS heap limit,
and `--liftoff-only`. Source pages are warmed once before the first pair;
there is no separate discarded warm-up run. No other audit test/build runs
concurrently. Limits are 150 seconds and 1,500 MiB sampled RSS per process.
Successful native runs consumed about 9.8 minutes; the WASM continuation was
capped at 10 minutes, keeping benchmark subprocess time below 20 minutes.

Three native pairs and two WASM pairs completed. The third WASM baseline also
completed (111.7 seconds), but its fixed partner was stopped after 21.6 seconds
when the continuation budget expired. That pair is excluded from comparisons;
the interrupted run is not a product failure or a valid timing result.

The initial three WASM preflight attempts were rejected by a harness mistake:
`getKernel()` checks whether the native library is installed but deliberately
ignores the kill switch. The guard was corrected to `kernelSupports('typescript')`,
the extraction routing predicate. Those attempts performed no indexing and
are preserved but excluded. Completed native runs were not repeated.

Total process wall time includes startup, indexing, database checks and
close. Index wall/CPU time brackets `indexAll()`. The resolution stage wraps
`resolveReferencesBatched` and includes persistence and synthesis as well as
matching. Process CPU time includes its worker threads; RSS is sampled every
100 ms and checked against the process high-water mark. These controls
reduce local contention but cannot reserve the shared host's CPU.

Values are median (minimum–maximum) over **complete pairs only**. The last
column is the median of the per-pair percentage changes, not a ratio of the
two displayed medians. Positive values mean more time or memory.

| Backend / metric | Main baseline | Fixed PR | Paired change |
|---|---:|---:|---:|
| native / Process elapsed (s) | 92.0 (91.2–95.2) | 102.5 (101.6–102.8) | +11.3% |
| native / Index elapsed (s) | 87.8 (87.2–91.1) | 97.2 (96.4–98.7) | +10.6% |
| native / Index CPU (s) | 54.5 (53.9–55.9) | 60.8 (60.1–61.5) | +10.2% |
| native / Resolution elapsed (s) | 50.1 (39.0–52.1) | 59.5 (57.9–61.3) | +17.7% |
| native / Resolution CPU (s) | 37.6 (37.1–38.8) | 43.8 (42.8–44.1) | +13.8% |
| native / Process peak RSS (MiB) | 1235.7 (1168.9–1250.8) | 1194.3 (1149.1–1196.3) | -3.3% |
| native / Resolution peak RSS (MiB) | 1218.7 (1141.4–1230.5) | 1170.9 (1148.0–1181.4) | -3.1% |
| wasm / Process elapsed (s) | 112.4 (111.3–113.4) | 121.0 (117.2–124.8) | +7.7% |
| wasm / Index elapsed (s) | 108.2 (107.2–109.3) | 116.3 (113.0–119.6) | +7.5% |
| wasm / Index CPU (s) | 77.3 (77.1–77.4) | 83.3 (82.7–83.9) | +7.7% |
| wasm / Resolution elapsed (s) | 49.7 (45.3–54.0) | 56.5 (51.6–61.4) | +15.6% |
| wasm / Resolution CPU (s) | 37.8 (37.7–37.8) | 43.7 (43.5–43.9) | +15.7% |
| wasm / Process peak RSS (MiB) | 1163.4 (1119.2–1207.6) | 1127.4 (1051.8–1203.0) | -2.7% |
| wasm / Resolution peak RSS (MiB) | 1135.8 (1091.5–1180.0) | 1111.2 (1041.4–1181.1) | -1.8% |

The completed pairs show a consistent increase in CPU work: about **10.2%
native / 7.7% WASM** for indexing and **13.8% / 15.7%** for the resolution
stage, using median paired changes. Whole-process elapsed time increases by
11.3% / 7.7% here. Resolution wall time is much less stable (one WASM pair
actually decreases), so an exact wall-time penalty is not portable to another
host. Memory ranges overlap and pairwise RSS changes have both signs; this
does not establish a memory improvement or regression. The prior small-corpus
3.4-second observation does not establish that the added work is free at scale.

All 11 completed indexes pass integrity, foreign-key and orphan checks with
zero indexing errors. Each contains 75,767 nodes and 256,523 edges. Pending/failed
references after indexing increase from 156,817 to 166,516 (+9,699, **6.2%**);
references entering resolution increase from 342,370 to 352,069 (**2.8%**).
The additional retained references do not create guessed internal calls.
Complete row/multiplicity comparisons of the first pair in each backend also
confirm identical node and edge contents, excluding node update timestamps
and auto-increment row IDs. All 9,699 additions are qualified call references;
no unresolved reference was removed. Bounded-memory SQL was used after an
initial in-memory postprocessing attempt was interrupted; the index runs and
saved databases were unaffected.


The precision and correctness fixes remain warranted. This experiment finds
a bounded, repeatable CPU cost on this large subsystem, not an isolated
causal estimate for one retention rule and not a full-VS-Code/default-worker
benchmark. There is no new timing-based release gate or claim of unchanged
performance. The unavailable macOS run and earlier parser/worker limitations
remain explicit.

### Reproduction and retained evidence

The portable `scripts/benchmarks/measure-index.cjs` harness accepts a built
engine directory, fixture directory, existing output directory and backend.
Build both pinned engines first and stage their matching native kernels. Set
`BENCH_NODE`, `BENCH_ENGINE`, `BENCH_FIXTURE`, and `BENCH_OUT` to absolute paths;
use a new output directory and an unindexed fixture for each run. For WASM:

```sh
mkdir -p "$BENCH_OUT"
test ! -e "$BENCH_FIXTURE/.codegraph"
CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_UPDATE_CHECK=1 \
CODEGRAPH_KERNEL=0 CODEGRAPH_WASM_RELAUNCHED=1 \
CODEGRAPH_PARSE_WORKERS=1 CODEGRAPH_RESOLVE_WORKERS=1 \
CODEGRAPH_NO_PARALLEL_RESOLVE=1 RAYON_NUM_THREADS=1 \
taskset -c 0 "$BENCH_NODE" --liftoff-only --max-old-space-size=1024 \
  scripts/benchmarks/measure-index.cjs \
  "$BENCH_ENGINE" "$BENCH_FIXTURE" "$BENCH_OUT" wasm
mv "$BENCH_FIXTURE/.codegraph" "$BENCH_OUT/index"
```

For native, change `CODEGRAPH_KERNEL=1` and the final argument to `native`.
Use an available CPU from the host's affinity mask. Repeat sequentially in
baseline/fixed, fixed/baseline, baseline/fixed order. The outer runner enforces
the stated time/RSS ceilings, samples RSS, and preserves every database.

The full commands, outer runners, source/build fingerprints, every attempted
run, RSS samples and final JSON summaries are retained under
`/data/workspace/codegraph-regression/review-followup/`. `artifacts/perf-summary.json`
contains the complete-pair statistics; `artifacts/perf-manifest.json` records
all attempts, including the rejected preflights and interrupted last run.
The original audit artifacts and indexes remain unchanged.


## Store eligibility cache follow-up (2026-09-15)

The per-file `.getState` gate in `matchDestructuredStoreCall` now caches both
boolean answers per resolver context, capped at 8,192 files with FIFO eviction.
It is cleared with source caches during sync. Positive files still run all
existing lexical, shadow, import and store-action checks. Qualified references
and both extractors are unchanged; no diagnostic helper bypass was applied.

The pre-optimization PR is `c6036f09fb1af3c5f4ae680d4ca63a0978016871`;
implementation is `92a6c85de7050e99034a12bea1494375f5cbdab8`. Compiled-engine
fingerprints show only `name-matcher.js` changed, with an identical native kernel.

Three new real-SQLite tests pass on native and WASM: same-instance edit+sync
in both directions, independent projects sharing relative paths, rejection of
a same-named decoy, and retained qualified call coordinates/multiplicity.
Deliberately removing invalidation makes the negative-to-positive case fail;
that mutation was restored. Native focused checks passed 234/236 at normal
limits; two Objective-C cases timed out at five seconds (also in isolation),
then all four Objective-C assertions passed with a diagnostic 15-second
allowance. The baseline four passed in 0.66 seconds; the optimized diagnostic
run spent 75 seconds collecting tests. This is not a default-limit native-suite
green verdict. WASM verified 45 affected cases: 32 initially plus 13 Steps cases
passing in isolation after a combined-run setup timeout. No committed timeout
or assertion was weakened. TypeScript/assets passed; the viewer build reached
the first 240s bound, then completed separately with all 29 grammar asset checks.

Full native before/after indexes on saved Excalidraw `afa3a653` have identical
**node, edge and retained-reference contents and multiplicities**, excluding
only update timestamps and auto-increment IDs:693 files,12,779 nodes,54,045
edges,38,044 references. Integrity/FK/orphan/error checks pass. This preserves
the repaired render/store relationships and the source evidence.

Fresh VS Code platform timings were bounded to two reversed-order native pairs
on the previously pinned corpus, same physical root, one CPU and worker,
Node 24.16.0,1GiB heap/1,500MiB RSS. Three attempts reached 180s before resolution
completed; the repeated-limit stop rule cancelled the fourth. **No whole-index
speedup is established.** The correctness-only Excalidraw pair also varied:
index CPU 11.90→15.87s, resolution CPU 7.71→9.57s, elapsed 14.45→170.89s, peak
RSS 558.9→551.3MiB. Even CPU outside the changed stage rose 4.19→6.31s. This
single pair cannot isolate a cache-caused improvement or slowdown.

A bounded diagnostic replay through the actual store matcher and production
contexts, with all 207,446 saved JS/TS call references, fresh contexts and
reversed order, confirms the direct benefit without bypassing any helper:

| Pair | Before helper CPU | Cached helper CPU | Reduction |
| --- | ---: | ---: | ---: |
| Before then cached |7.265s|1.046s|85.6%|
| Cached then before |6.768s|0.990s|85.4%|

Both return identical results (zero matches on this corpus). The replay's
broader call set differs from the actual pipeline invocation set and excludes
other resolver work, extraction, persistence and synthesis. Its 5.8–6.2s saving
is **not** a whole-index estimate and does not establish that the earlier
8–10% penalty or diagnostic 4.7s has been recovered in full. WASM timings and
the full audit matrix were not repeated. Earlier Mac/parser/worker limitations
remain.

Commands, the preserved pre-change engine, scripts, all attempts, databases,
checks and full SQL comparisons are in
`/data/workspace/codegraph-regression/review-followup/cache-optimization/`;
`REPORT.md` and `artifacts/summary.json` consolidate the evidence.


## Completing the large benchmark and explaining the timeouts (2026-09-15)

**All four fresh native indexes and their full database checks completed.** The
old three stops were SIGTERM from the audit runner's 180-second wall timer, not
CodeGraph rejecting a large project or running out of memory. Those interrupted
artifacts are unchanged. They lack CPU/progress traces, so their precise wait
sites cannot be reconstructed retrospectively.

The completing comparison uses the same VS Code platform tree (`38246c086c8a825ca90190749dd88df6effec257`, source fingerprint
`3d629a40f93a90d29d5aa00bd06f2a7e119b4d628f20bb449cd815d972e4ccdb`),
3,092 supported files, Node 24.16.0, native parsing and fresh SQLite databases.
Pre-cache engine: `c6036f09fb1af3c5f4ae680d4ca63a0978016871`; cached engine:
`da5e6e76c908447d0abd3e6c05e11deb64984736`. Only compiled `name-matcher.js`
differs; the native kernel is identical. All qualified-reference retention
and the repaired matching guards are preserved.

Runs were sequential, cached/before with the old one-core restrictions, then
before/cached with both available CPUs and automatic parser/resolver sizing.
The latter is normal **CPU** configuration; both arms still use the same 1GiB
V8 heap cap and `--liftoff-only`. Automatic resolution correctly stays sequential
on this two-CPU VM. Both sides use identical lightweight phase/batch/DB-call
observers; no V8 sampling profiler, reference bypass, or runtime code edit.
There was **no elapsed-time termination condition**. Each child was polled until
completion, with progress, CPU, RSS, thread scheduler/wait state, pressure,
I/O and cgroup counters saved. No other servers or locks were touched.

| CPU configuration | Engine | Index elapsed | Index CPU | Resolution elapsed | Resolution CPU | Peak process RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| One core, forced sequential | Before cache | 144.19s | 61.33s | 89.51s | 44.15s | 1003.8MiB |
| One core, forced sequential | Cached | 133.86s | 57.58s | 79.20s | 40.43s | 1031.4MiB |
| Two cores, automatic workers | Before cache | 126.31s | 62.73s | 74.97s | 44.84s | 1006.9MiB |
| Two cores, automatic workers | Cached | 128.05s | 58.21s | 77.39s | 39.98s | 1037.5MiB |

Index times cover `await cg.indexAll()`, including maintenance. Resolution
includes setup, matching, persistence and synthesis. Full processes, including
subsequent integrity/FK/orphan scans and shutdown, took 176.70/191.21/178.91/191.50s
in execution order. In the new baseline attempts, a 180s process limit would
have confused an already completed index with an unfinished verification.

The cache saves **3.75–4.52s of whole-index CPU (6.1–7.2%)** in these pairs.
Matching CPU falls 30.62→26.69s and 31.14→26.43s; resolution CPU falls 8.4–10.8%.
This supports a real CPU benefit from the narrow cache. It does not establish a
universal wall-time improvement or that every part of the original 8–10% CPU
increase is recovered: one elapsed comparison improves 7.2%, the other worsens
1.4%, and these are only two pairs across two CPU configurations.

### What caused the long waits

The reproduced delays are predominantly **disk/page waits under memory and I/O
pressure**, not a matching loop that gets progressively more expensive:

- Main-thread samples repeatedly show `D` state in `folio_wait_bit_common`,
  `rq_qos_wait`, buffer/journal waits and block-request allocation. These are
  kernel storage/page waits. Index maintenance has an idle, responsive main
  event loop while its worker completes I/O; no resolver pool deadlock appears.
- Global I/O pressure reports all runnable work stalled for 57.5–63.8% of the
  sampled whole-process windows. This is a host metric, not an exact per-stage
  allocation, but the indexer's own wait states directly corroborate it.
- The VM has 3,916.6MiB total RAM. In the three runs with continuous meminfo
  capture, available memory reaches only 158.0, 142.2 and 92.0MiB. A spot check
  during the first completing run showed about 262MiB available. Memory-pressure
  counters also rise. The exact source of shared memory/storage pressure is not
  identified; no unrelated processes were modified.
- Visible CPU quota is unlimited; throttling counters remain zero. CPU steal
  is only 0.21–0.30% over these runs. CPU starvation is not the dominant observed
  delay. Thread CPU/scheduler samples and responsive maintenance heartbeats
  distinguish CPU work from waiting.
- Across four successive groups of 18 matching batches, cached one-core median
  CPU per batch is 365, 353, 268 and 269ms. In the two-core cached run it is 365,
  329, 270 and 253ms. CPU work does not grow with progress. Late elapsed batches
  can stretch while CPU remains low because the process waits for pages.
- Setup is only 0.06–0.07s. Matching, SQLite inserts/cleanup, index rebuilding,
  synthesis and final maintenance have separate observations. For example,
  one-core cached matching takes 45.29s elapsed but 26.69s CPU; synthesis takes
  15.26s elapsed/6.94s CPU, and final maintenance takes 25.04s elapsed.

Three diagnostic reports were requested during long final verification gaps;
they were delivered when the synchronous work yielded, so their JS stacks are
empty and are not used as hotspot evidence. Kernel wait samples, batch CPU and
phase logs are the actionable evidence. No healthy process was killed.

### Correctness and benchmark repair

All four runs have exactly the same 75,767 nodes, 256,523 edges and 166,516 retained
references, including 89,157 qualified names. Every retained reference has been
processed (`failed` denotes unresolved after attempted matching); zero remain
pending. Full SQL `EXCEPT` comparisons in both directions, grouping complete
rows with multiplicity, show zero additions/removals. Only node update timestamps
and auto-increment edge/reference IDs are excluded. Ordered SHA-256 fingerprints
also match for all three tables. Integrity checks are `ok`, with no foreign-key
violations, orphan edges, indexing errors or missing supported files.

No further resolver change was warranted by this evidence. The benchmark now
writes phase/batch progress, cumulative CPU/RSS and event-loop measurements as
it runs, names maintenance separately, and saves `index-result.json` **before**
full verification. `result.json` represents completion of checks and shutdown.
Database verification failures produce nonzero exit status. It refuses existing
fixture indexes and reused trace files, preserving prior evidence.

The portable Linux observer has no wall timeout, records the child/thread/host
resource counters every two seconds, and leaves the caller's CPU/environment
settings unchanged. For example, from a built checkout (all engine/fixture/output
paths absolute; the output directory must not exist):

```bash
CODEGRAPH_KERNEL=1 CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_UPDATE_CHECK=1 \
CODEGRAPH_WASM_RELAUNCHED=1 python3 scripts/benchmarks/observe-index.py /absolute/run-before -- \
  /absolute/node --liftoff-only --max-old-space-size=1024 \
  scripts/benchmarks/measure-index.cjs /absolute/built-before /absolute/pinned-fixture \
  /absolute/run-before native
```

Watch `progress.ndjson` and `resources.ndjson`; inspect CPU deltas, thread wait
states and phase progress before stopping an apparently slow child. Archive that
run's owned `.codegraph` directory before the next fresh run. Use the same source,
flags and observer on both sides; run sequentially. Do not treat an external
execution deadline as a product failure or compare incomplete databases.

The revised harness and observer passed actual native and WASM integration
checks on a two-file fixture: the real cross-file call and retained qualified
external reference exist; completed-index evidence precedes verification;
maintenance is identified; successful observer exits are recorded; and refusal
of an existing index leaves its SQLite bytes unchanged. JavaScript syntax,
Python compilation and diff checks pass. Product code and compiled engines are
unchanged by this follow-up, so prior focused resolver tests remain applicable;
no full-suite rerun, Mac validation, or new npm release is claimed.

Full commands, four complete databases, raw observations, diagnostic startup
failure (a worker inherited the preload; fixed before the four measured runs),
reports, graph comparisons and harness checks are retained in
`/data/workspace/codegraph-regression/review-followup/timeout-diagnosis/`.
`artifacts/summary.json` and `artifacts/provenance.json` consolidate the evidence.
