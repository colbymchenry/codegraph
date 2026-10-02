# Faster graph builds: the write pipeline (D, E, G, idle time)

**Status:** executed 2026-10-02 — G shipped, D built and **rejected** on measurement, E not reproduced (instrumented). Results below; the original plan follows, wrong estimates struck through.

## Results (vscode full `codegraph index` with SCIP, one run each)

| build | wall | resolution phase | edge-index rebuild | graph |
|---|---|---|---|---|
| before G (fix A + ANALYZE order) | 162.0 s | — | — | — |
| **G** | **153.5 s** | 81.8 s | 6.0 s | synthesized edges identical (27,355) |
| G + D | 160.9 s | 88.7 s | 16.6 s (dedupe 7.2 s, identity 2.0 s) | all 2,058,339 edges identical (every column) |

- **G:** the Flutter and C++ passes now check the class's language before loading its methods; both dropped below the timing log's threshold (were 3.5 s and 3.3 s).
- **D: rejected.** The graph was identical, but the build was ~7 s *slower*. In the real build the batch loop finished only ~3.4 s earlier (the isolated benchmark promised ~12 s: inserts interleave with the resolver's other main-thread work, so they were not the loop's critical path), while closing the window cost 10.6 s more — dedupe took 7.2 s on the real table against 2.9 s on the scratch copy. Reverted. Found on the way, worth keeping if D is ever retried: the window's only by-source edge read is the supertype walk (`resolution/index.ts`), and SQLite uses a partial index only when the query repeats its condition verbatim (bound kinds, or the same kinds reordered, scan the table).
- **E: not reproduced.** With per-index timing (`[index-timing]` under `CODEGRAPH_SYNTH_TIMINGS`, kept) the edge indexes rebuilt in 6.0 s in total, 0.4–2.3 s each — what they cost in isolation. The earlier 15.4–19.6 s builds ran under other load (profiler, concurrent indexing); the log will name the index and WAL size if it recurs.
- **Lesson:** the isolated insert benchmark measured the right operation and the wrong thing — what matters is whether it sits on the build's critical path. Measure in a real build before building on an isolated number.

**Status (original):** plan, nothing built. Measured 2026-10-02 on a vscode copy (14,858 files, ~2M edges) and Playwright (1,678 files), Node 22.23.3, warm cache.
**Scope:** upstream code (`src/db/`, `src/resolution/`, `src/index.ts`). The fork may carry these changes; each one will conflict on upstream merges until offered upstream.

## Where a vscode build spends its time

Full `codegraph index`, no SCIP: **143 s**.

| phase | wall | bound by |
|---|---|---|
| parse | 24 s | the one store-writer thread: busy 22 of 24 s; parse workers ~65% idle |
| post-parse index rebuild | 8.7 s | SQLite |
| resolution | 86 s | the main thread: busy 66 of 86 s (edge inserts 21.7 s, edge-index rebuild 15.4 s, batch reads 6.6 s, ref deletes/marks ~6 s); 6 resolver workers ~50% idle |
| synthesis | 15 s | slowest passes: `crossTierEdges` 11.8 s, `objectRegistryEdges` 10.4 s (CPU, run in parallel) |

Every write goes through one SQLite writer, and the phases run one after another; the idle time is threads waiting on that writer. A larger page cache did not help (64 vs 512 MB: same insert time), nor did a smaller WAL.

## D — cheaper edge inserts during resolution

**Problem.** Resolution inserts ~2M edges with `INSERT OR IGNORE` while `idx_edges_identity` (source, target, kind, line, col) stays in place: dedup needs it, and supertype walks mid-resolution read `implements`/`extends` edges by `source` through its prefix. Source ids are hashes, so every insert lands at a random position in that B-tree.

**Measured** (2.06M real vscode edges into a scratch table, original order, 5k-row transactions):

| index during insert | insert | then dedupe | then unique index | total |
|---|---|---|---|---|
| identity (today) | 18.9 s | — | — | 18.9 s |
| `(source)` only | 16.2 s | — | 2.3 s | 18.5 s — key width is not the cost |
| **partial `(source) WHERE kind IN ('implements','extends')`** | **6.2 s** | **2.9 s** | **2.3 s** | **11.4 s** |
| none | 5.3 s | — | 2.1 s | (no mid-window reads, no dedup) |

**Design.**
1. `beginBulkEdgeLoad` also drops `idx_edges_identity` and creates `idx_edges_struct ON edges(source) WHERE kind IN ('implements','extends')`.
2. Inserts become plain `INSERT` during the window (duplicates allowed in the table).
3. `endBulkEdgeLoad`: delete duplicates keeping the lowest rowid per identity (`GROUP BY source, target, kind, IFNULL(line,-1), IFNULL(col,-1)`), create `idx_edges_identity`, drop `idx_edges_struct`, then the other indexes as today.
4. Crash inside the window: `healBulkSecondaryIndexes` must also dedupe before recreating the unique index (a plain `CREATE UNIQUE INDEX` fails on duplicates).

**Must verify first.**
- Every query run inside the window that reads edges by `source`: confirm all are `implements`/`extends` (the comment in `db/index.ts` says so; check with `EXPLAIN QUERY PLAN` logging during a Playwright build, or grep `getOutgoingEdges` callers reachable from the resolver). A `calls`-by-source read in the window would become a full scan.
- Which edge the old `INSERT OR IGNORE` kept: the first inserted. "Lowest rowid" keeps the same one, so `metadata`/`provenance` of a duplicate match today's.
- Dedupe cost on repos with many duplicates (count attempted vs kept during a run).

~~**Expected:** ~7.5 s off vscode's resolution phase (−9% of the build).~~ **Measured:** +7 s (slower) — see Results. **Test:** edge-for-edge identical graph (all columns) on Playwright, Django, vscode; crash-heal test (kill inside the window, reopen, unique index present, no duplicates).

## E — the edge-index rebuild is 3× slower in the build than in isolation

**Problem.** `edge-index-recreate` takes 15.4–19.6 s in a vscode build; the same four indexes on the same ~2M rows take 4.3–4.9 s alone.

**Ruled out:** page-cache size (no change), WAL size (2.4 GB WAL: 4.9 s), table fragmentation (on a copy of the real 1.9 GB database the target index rebuilds in 2.1 s, `kind` in 0.6 s).

**Next steps.**
1. Time each `CREATE INDEX` inside `endBulkEdgeLoad` during a real build (per-statement log under `CODEGRAPH_SYNTH_TIMINGS`).
2. Record at that moment: WAL size, whether the WAL valve or a checkpoint is running, other open connections (resolver/synthesis workers reading).
3. Hypotheses to test in that order: a concurrent checkpoint or reader holding the WAL (the rebuild then reads through a long WAL with readers pinning it); the `setImmediate` yields letting other main-thread work run between statements (wall ≠ statement time — but the CPU profile put 15.4 s inside `exec`, so this is the weaker one).

~~**Expected:** up to ~10 s if the cause is contention that can be scheduled around~~ **Measured:** not reproduced — see Results. (Original: up to ~10 s if the cause is contention that can be scheduled around (e.g. pause the valve, or rebuild after workers close their connections). Do E before deciding on the writer worker below: it changes how much writer time there is.

## G — whole-graph synthesis passes that filter by language too late

**Problem.** Passes are gated per repo (`has('dart')`), and one fixture file opens the gate: vscode's single `extensions/vscode-colorize-tests/test/colorize-fixtures/test.dart` costs 3.5 s (`flutterEdges`), 23 C++ files cost 3.3 s (`cppEdges`). Both passes loop over **every** class in the repo (`iterateNodesByKind('class')`), load each class's methods, and only then filter by language.

**Design.** Check the class's language first (`if (cls.language !== 'dart') continue;` / `'cpp'`) before loading children — exact, not a heuristic threshold. Then audit the other gated passes for the same shape (`ifaceEdges`, `rnEventEdgesList`, `fieldEdges`, `registryEdges`).

**Must verify.** For `cppOverrideEdges`, sub- and base-class methods are already filtered to `cpp`; skipping non-cpp classes up front must give the same edges (a cpp class is the only one with cpp methods). For `flutterBuildEdges`, read the whole pass to confirm what else it matches.

**Expected:** ~5–7 s of synthesis CPU on vscode; wall time less (passes run 6 at a time). **Measured:** build 162.0 → 153.5 s (one run each; part of that may be run-to-run variation), synthesized edges identical. **Test:** synthesized-edge sets identical on vscode, a Flutter repo, and a C++ repo.

## Idle time — after D, E, G

Ordered by expected gain per effort; decide with numbers after D and E land.

1. ~~**Make the writer's work smaller** — D, E (above). Every second off the writer comes off the wall clock.~~ D showed the opposite: the main thread's insert time was not the critical path. Before items 2–3, measure what the batch loop actually waits on (resolver results vs. writes) with timestamps per batch.
2. **Resolution writes off the main thread.** Parsing already has a store-writer worker; resolution writes inline, so the main thread alternates between handing out batches and writing. A writer worker would let it keep the resolvers fed. Main cost: a second protocol (like `store-writer.ts`) for edges, ref deletes and ref marks, with backpressure.
3. **Read the next batch ahead.** `getUnresolvedReferencesBatchAfter` (6.6 s) can run on a read connection while the writer writes (WAL), hiding most of it.
4. **Overlap phases where dependencies allow** — e.g. rebuild indexes nothing reads yet in the background. Needs a map of which phase reads which index first.

**Floor:** writes are ~28 s of the 86 s resolution phase; with one SQLite writer and perfect overlap resolution stays around 30–40 s (estimate). Going below means several databases merged at the end — an architecture change, not proposed.

**Does this need an architecture review?** A focused one of the write pipeline (one writer, sequential phases, the main thread both dispatching and writing) — after E is explained and D measured in a real build, since either changes the picture.

## Order

1. G — smallest, exact, independent.
2. E's measurement (steps 1–2): an hour, decides how much rebuild time there is to win.
3. D — design is clear; the window-read audit is the gate.
4. Re-profile vscode; then decide on idle-time items 2–3.
