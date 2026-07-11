# Main-thread stall budget — extraction & resolution follow-up

**Status: IMPLEMENTED** (same branch as the #1212 tail fix — attribution runs
promoted "suspects" to proven culprits fast enough to justify shipping
together). What landed, per suspect:

- **Post-index maintenance — the proven killer, not on the original suspect
  list.** The first full kernel `init` on the FIXED tail completed every
  synthesis pass (cFnPtr alone ran 433s at default heap, yielding throughout)
  and was then SIGKILLed by the default-window watchdog at
  `db.runMaintenance()`: `PRAGMA optimize` + `wal_checkpoint(PASSIVE)` over a
  4.2GB DB with a 593MB WAL is minutes of synchronous IO on 2 cores.
  `runMaintenance` now runs on a worker thread with its own connection
  (checkpointing from a second connection is standard; `PRAGMA optimize`
  persists stats in sqlite_stat tables), with a bounded in-line fallback that
  skips the checkpoint (close() checkpoints after the CLI disarms the
  watchdog).
- **Per-file store commits:** `storeExtractionResult` chunks its node/edge/ref
  inserts (2,000 rows) with time-budgeted yields between; the ordered-commit
  pump serializes async stores on a promise chain (preserving the #1015
  file-order determinism invariant) and its backpressure now also waits on the
  commit chain so the parse buffer stays bounded.
- **Resolver warm-up:** `warmCachesYielding` streams the DISTINCT name set
  with yields (the sync `warmCaches` stays for non-async callers). The 28.2s
  `sync` stall dropped to ≤4s total across the whole sync.
- **Resolution batch-tail:** edge inserts and keyed deletes run in 1,000-row
  sub-transactions with yields between (crash semantics unchanged — the batch
  was already several transactions, and #1187's sweep re-resolves leftovers).
- **Scan:** attributed (phase timings now in the code, `[phase-timing]` on
  `CODEGRAPH_SYNTH_TIMINGS`) — it is the synchronous git enumeration
  (`getGitVisibleFiles`/`collectGitFiles`), NOT a hash loop. See "Accepted
  residuals" below for why it was left synchronous.

**Verification:** full-graph parity (every node id + edge, sorted dump diff)
byte-identical on fresh redis and vim indexes, baseline vs fixed; full test
suite green; kernel `sync` worst stall 28.2s → ~4s; ES synthesis tail worst
stall ≤2.7s.

**Acceptance gate PASSED:** fresh full kernel `init` (70,129 indexed files,
2,048,673 nodes / 6,402,391 edges) completed in **27m 8s** on the 2-core/6GB
container at Node's default heap with the default 60s watchdog — `EXIT 0`,
identical node/edge counts to the pre-fix partial runs, maintenance 48.8s
off-thread with the WAL fully checkpointed (0 bytes). v1.3.0 could not finish
this repo at all (OOM at default heap; watchdog kill at the maintenance step
even with the tail fixed). Post-run, the one genuine synchronous span the run
exposed — the merged synthesized-edge insert (~275k rows, 20.2s in one
transaction) — was chunked (2k rows + yield) like the rest; redis parity
re-verified byte-identical after.

## Accepted residuals (measured, documented, deliberately not fixed)

- **Git enumeration (scan): 2.2–10.5s** single sync span on ~95k-file repos.
  Fixing it means async-ifying `collectGitFiles`' recursive gitlink/submodule
  logic (#1038/#1065) or forking sync/async variants — high regression risk
  for a CPU-bound span ~6× under the watchdog window even on a 2-core
  container (its cost does not get the Windows/Defender per-file-IO
  multiplier; it scales with CPU only).
- **End-of-sync aggregates: ~2.7s** (count recompute / vocab backfill on a
  4.2GB DB).
- **Warm-up first chunk: ~2.6s** — the DISTINCT name scan's initial sort
  chunk before the first cursor row arrives; the rest of the scan yields.
- **Worker-contention timer lag on tiny containers** — with 2 cpuset cores,
  the off-thread checkpoint (and the parse pool early in the run) can delay
  main-loop timers 15–20s even though the main thread executes nothing. The
  stall monitor and the watchdog heartbeat both measure timer latency, so on
  a ~1-core box a long checkpoint could still starve heartbeats; if that ever
  reproduces, the mitigations are a niced worker or heartbeat-side allowance,
  not more yields.

If any of these ever shows up in a real watchdog kill, the async-refactor
shape for the scan is: thread a `MaybeYield` through `collectGitFiles`'
per-line loop and make `getGitVisibleFiles` async, keeping `scanDirectory`
(sync) on the walk fallback only.

---

*Original plan below, kept for the record.*

## Context

The #850 liveness watchdog SIGKILLs the indexer when its event loop stalls past
the window (default 60s). #1091 → #1122/#1137 → #1212 each moved the fix deeper:
per-batch yields, per-ref yields, then (with #1212) yields + streamed queries +
language gates across the entire dynamic-edge synthesis tail, which eliminated
the 14–57s single-pass stalls and the two whole-graph OOMs.

While validating #1212 with an event-loop stall monitor over *full* `init` runs
(Linux kernel, 70k indexed files / 2.05M nodes, 2-core 6GB container; and
llvm-project, 180k tracked files, macOS), the phases **before** the synthesis
tail showed recurring single stalls that nothing currently yields through:

| Run | Phase | Observed single stalls |
|---|---|---|
| kernel (2 cores) | initial scan (t+14s, t+22s) | 5.1s, 10.5s |
| kernel (2 cores) | extraction (t+980–1080s) | 3.0–3.3s |
| kernel (2 cores) | extraction→resolution boundary (t+1354s) | 8.5s |
| llvm (mac, fast) | extraction / early resolution (t+1000–1320s) | 5–14s, recurring |
| kernel (2 cores) | `codegraph sync` on the same DB (110 files) | **28.2s** (single stall) |

None of these approaches 60s on the tested hardware, and none are regressions —
they pre-date #1212. But the #1212 pattern (Windows NTFS + Defender, small VMs)
multiplies per-file and per-transaction costs several-fold, and 14s × a few-fold
is a watchdog kill. These are the spans that will produce the *fourth* iteration
of this bug class if left unmeasured.

## Suspects (with code locations)

1. **Per-file store commits on the main thread** —
   `ExtractionOrchestrator.storeExtractionResult` (`src/extraction/index.ts:2065`)
   runs one synchronous transaction per file (`insertNodes` + `insertEdges` +
   unresolved-ref batch + FTS triggers). A giant generated file (llvm has
   many multi-MB generated `.inc`/`.cpp`) inserts tens of thousands of nodes in
   one unyielding span. The parse pool (#1015) moved *parsing* off-thread; the
   *commit* is still a single main-thread block per file.
2. **Resolver cache warm-up** — `warmCaches` (`src/resolution/index.ts:319`)
   calls `getAllNodeNames()` (`src/db/queries.ts:1879`, `SELECT DISTINCT name`
   over the whole node table) plus `getAllFilePaths()` synchronously. On the
   kernel's 2M-row table the DISTINCT alone is seconds; it is the prime suspect
   for the 8.5s boundary stall and the 28.2s `sync` stall (sync also enters
   resolution via the orphan sweep, #1191).
3. **Resolution batch-tail DB ops** — between the per-ref yields,
   `resolveAndPersistBatched` (`src/resolution/index.ts`) runs per-5000-ref
   synchronous spans: `insertEdges(batch)`,
   `deleteSpecificResolvedReferences` × 2 (a 5000-statement transaction), and
   `getUnresolvedReferencesCount()`. On a multi-GB DB each is a solid block.
4. **Initial scan** (kernel t+14/22s) — file enumeration + content hashing
   before extraction starts. Unattributed; measure before assuming.

## Diagnosis plan (before any fix)

Extend the env-gated timing that located #1212 (`CODEGRAPH_SYNTH_TIMINGS`) to
the suspects — or add a sibling `CODEGRAPH_PHASE_TIMINGS` — so each suspect
logs spans >250ms with a label:

- wrap `storeExtractionResult` (log file path + node count when slow — this
  also identifies the offending generated files),
- wrap `warmCaches` (split `getAllNodeNames` vs `getAllFilePaths`),
- wrap the three batch-tail ops in `resolveAndPersistBatched`,
- wrap the scan phase.

Re-run the stall monitor + timings on the two existing indexes (assets below).
Attribution first: the fix for each suspect is different, and #1180 showed the
first guess is often wrong.

## Fix sketches (per suspect, once confirmed)

1. **Chunked per-file commits:** split a file's node/edge/ref inserts into
   bounded sub-transactions (e.g. 2–5k rows) with `maybeYield()` between chunks.
   **Invariant to preserve:** files must still commit in scan order, whole-file
   at a time from the resolver's perspective (#1015 — resolution disambiguates
   same-named candidates by insertion order; chunking *within* one file keeps
   the order stable). The existing index-completeness marker (`index_state`)
   already covers a mid-file kill.
2. **Yielding warm-up:** stream `SELECT DISTINCT name` with a cursor
   (`stmt.iterate()`), building the Set with a periodic `maybeYield()` — an
   async `warmCachesYielding()` used from the async entry points
   (`resolveAndPersistBatched`, the sync path), leaving the sync `warmCaches()`
   for callers that can't await. Memory is unchanged (the Set already exists).
3. **Chunked batch-tail ops:** split the keyed-delete transaction and the edge
   insert into sub-transactions with yields between, same pattern as (1).
   `getUnresolvedReferencesCount` is an indexed aggregate; leave it unless
   timing says otherwise.
4. **Scan:** measure first; likely chunk the hash loop with yields.

## Acceptance criteria

- Instrumented full `init` on the kernel index (2-core/6GB container) and
  llvm-project shows **no single event-loop stall > ~2s** in any phase.
- `codegraph sync` on the kernel DB shows the same bound (kills the 28.2s span).
- Graph parity: byte-identical node/edge sets on a re-index of at least
  elasticsearch + redis (the #1212 parity harness in the session scratchpad
  automates the synthesized-edge half; extraction parity = compare
  `getNodeAndEdgeCount` + a sorted node-id dump).
- No end-to-end throughput regression beyond noise (< ~5%) on the same runs —
  chunked transactions can slow bulk inserts; measure, don't assume.

## Repro assets (from the #1212 investigation, 2026-07-08)

- Docker container `cg1212` (2 cores / 6GB, node:22-bookworm) with the Linux
  kernel cloned at `/work/linux` and its 4.2GB index.
- llvm-project (180,074 files) + elasticsearch (45k) + redis + vim clones with
  indexes in the session scratchpad.
- `stall-monitor.cjs` (preload; logs event-loop gaps >1s with timestamps),
  `synth-only.mjs` / `synth-watchdog.mjs` (drive resolution+synthesis directly
  against an existing index — ~2 min iteration instead of a 40-min re-index),
  `parity.mjs` (synthesized-edge set differ).
- The #1091 methodology note applies: a real CLI run at a lowered
  `CODEGRAPH_WATCHDOG_TIMEOUT_MS` is the authoritative kill/no-kill test.
