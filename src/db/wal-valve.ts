/**
 * WAL checkpoint valve — bounds WAL growth while auto-checkpointing is
 * deferred during a bulk index (#1231).
 *
 * Why deferral: SQLite's default `wal_autocheckpoint` (1000 pages) re-writes
 * hot B-tree/FTS pages into the main DB file over and over during a bulk
 * index — measured at ~95% of ALL disk I/O, and the difference between 45s
 * and 19+ minutes on HDD-class storage (150 random IOPS). Deferring
 * checkpoints turns the store into pure sequential WAL appends; each backfill
 * pass writes distinct pages once, in page order (≈ sequential).
 *
 * Why a valve: unbounded deferral is its own failure mode, both measured in
 * the #1231 repro. The WAL duplicates hot pages per COMMIT, so it grows far
 * faster than the DB (5.9GB WAL for a ~340MB DB on a 3.3k-file index) —
 * filling the disk, and poisoning every subsequent read that must page
 * through it (the first resolution-phase read blocked the main thread >60s
 * and the #850 liveness watchdog killed the healthy index). The valve
 * watches WAL growth on a timer and, past a soft threshold, backfills with
 * `PRAGMA wal_checkpoint(PASSIVE)` on a worker-thread connection — PASSIVE
 * never blocks the writer, and off-thread means the main thread (and the
 * watchdog heartbeat) keep turning regardless of how long a backfill takes.
 *
 * The load-bearing subtlety: a WAL file's SIZE never shrinks. After a full
 * backfill, the writer's next commit RESTARTS the WAL from the top and the
 * frames recycle inside the same file — so raw size says nothing about the
 * un-backfilled backlog, and a size-triggered valve degenerates into firing
 * (and pausing the writer) forever once the file passes its threshold
 * (measured: guava crawled at ~9min per 160 files). Instead the valve
 * tracks `sizeAtLastFullBackfill` — refreshed whenever a checkpoint reports
 * `log === checkpointed` (everything backfilled) — and triggers on GROWTH
 * beyond that baseline, which only happens when genuinely un-backfilled
 * frames push past the file's high-water mark.
 *
 * Backpressure: if the writer outruns the checkpointer past a hard cap of
 * growth (2× soft), {@link backpressure} pauses the writer (at a safe,
 * between-transactions boundary) until a FULL backfill lands. One in-flight
 * pass is not enough: on a disk saturated by the writer, every concurrent
 * PASSIVE pass is already stale by the time it finishes (the writer appended
 * past its snapshot), so neither SQLite's WAL wrap nor the baseline ever
 * trigger and the WAL grows without bound (measured: 5.9GB on guava at 150
 * IOPS, then a >60s read stall and a watchdog kill). With the writer parked,
 * the next pass covers everything, the WAL wraps on the following commit,
 * and the pause is the disk's honest catch-up cost — the correct terminal
 * mode when hardware genuinely can't keep up with the append rate.
 */

import type { DatabaseConnection } from './index';

/** Soft WAL-growth threshold (MB) that triggers an off-thread passive checkpoint. */
const DEFAULT_WAL_VALVE_MB = 256;
/** Hard cap = this × soft threshold; past it the writer pauses for a full backfill. */
const HARD_CAP_MULTIPLIER = 2;
/** File cap = this × soft threshold; past it the barrier also TRUNCATEs the file. */
const FILE_CAP_MULTIPLIER = 4;
/** Passes attempted per writer pause before giving up (a pinned reader could stall forever). */
const MAX_PAUSED_BACKFILL_PASSES = 20;
/** How often the timer looks at the WAL file size. */
const CHECK_INTERVAL_MS = 2000;

/**
 * Resolve the valve's soft threshold from the `CODEGRAPH_WAL_VALVE_MB`
 * override; non-numeric / non-positive values fall back to the default.
 */
export function resolveWalValveMb(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_WAL_VALVE_MB;
}

export class WalCheckpointValve {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  /** Writer pause in progress (hard cap breached): passes loop until a full backfill. */
  private pause: Promise<void> | null = null;
  /**
   * WAL file size observed when a checkpoint last reported the ENTIRE WAL
   * backfilled. Growth is measured against this baseline — see the header
   * comment for why absolute size cannot be used.
   */
  private sizeAtLastFullBackfill = 0;
  private readonly softBytes: number;
  private readonly hardBytes: number;
  private readonly fileCapBytes: number;

  /**
   * Futility latch: consecutive backfill give-ups (a reader pinning the WAL)
   * disable further writer pauses for a cooldown, so a pinned phase degrades
   * to the pre-valve behavior (unbounded WAL, folded when the pinner exits)
   * instead of burning a 20-pass checkpoint attempt — each pass a worker
   * thread + fresh connection — at EVERY over-cap boundary. That churn is
   * what turned a pinned kernel-scale resolution from slow into OOM-killed
   * (§7a.1 run 1: 22GB WAL, exit 137 at an envelope the pre-fix build
   * survived).
   */
  private consecutiveGiveUps = 0;
  private futileUntil = 0;

  constructor(
    private readonly db: DatabaseConnection,
    softMb: number = resolveWalValveMb(process.env.CODEGRAPH_WAL_VALVE_MB),
    private readonly intervalMs: number = CHECK_INTERVAL_MS,
    log: (msg: string) => void = () => {}
  ) {
    this.softBytes = softMb * 1024 * 1024;
    this.hardBytes = this.softBytes * HARD_CAP_MULTIPLIER;
    this.fileCapBytes = this.softBytes * FILE_CAP_MULTIPLIER;
    // CODEGRAPH_WAL_VALVE_DEBUG=1 surfaces valve decisions to stderr without
    // needing the caller's verbose plumbing — the observability gap that let
    // §7a.1 run 1 fail silently (give-ups were verbose-gated and invisible).
    this.log = process.env.CODEGRAPH_WAL_VALVE_DEBUG
      ? (m) => console.error(`[wal-valve] ${m}`)
      : log;
  }

  private readonly log: (msg: string) => void;

  private mb(n: number): string {
    return `${Math.round(n / 1024 / 1024)}MB`;
  }

  /** Un-backfilled growth estimate: bytes the WAL has grown past the last full backfill. */
  private growthBytes(): number {
    return this.db.getWalSizeBytes() - this.sizeAtLastFullBackfill;
  }

  /** Begin watching the WAL. Idempotent; the timer never holds the loop open. */
  start(): void {
    if (this.timer) return;
    // One armed line per run under either diagnostics env: §7a.1's failed
    // kernel-scale runs burned three 25-minute cycles before "is the valve
    // even alive?" could be answered.
    if (process.env.CODEGRAPH_SYNTH_TIMINGS || process.env.CODEGRAPH_WAL_VALVE_DEBUG) {
      console.error(`[wal-valve] armed soft=${this.mb(this.softBytes)} hard=${this.mb(this.hardBytes)} wal=${this.mb(this.db.getWalSizeBytes())}`);
    }
    let ticks = 0;
    this.timer = setInterval(() => {
      if ((++ticks % 15) === 0) {
        this.log(`alive: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)} inflight=${this.inflight ? 'y' : 'n'} paused=${this.pause ? 'y' : 'n'}`);
      }
      this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop watching. Any in-flight checkpoint keeps running — await drain(). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll: fire an off-thread passive checkpoint when growth passes the soft threshold. */
  check(): void {
    if (!this.pause && !this.inflight && this.growthBytes() > this.softBytes) this.fire();
  }

  /**
   * Writer-side backstop, called at a between-transactions boundary. Returns
   * null (no wait) while growth is under the hard cap; past it, returns a
   * promise that resolves only once a FULL backfill has landed — see the
   * header comment for why a single pass is not enough on a saturated disk.
   */
  backpressure(): Promise<void> | null {
    if (this.pause) return this.pause;
    if (Date.now() < this.futileUntil) return null; // pinned reader — parking is churn, not progress
    // Two independent triggers:
    //  - growth: un-backfilled BACKLOG past the hard cap (the original valve).
    //  - file size: a WAL can stay fully backfilled and still grow without
    //    bound — the writer only restarts at frame 0 if a commit finds no
    //    reader marks, which §7a.1's instrumented run showed never happens
    //    in practice (file marched 361→721MB through two COMPLETE
    //    backfills). Past the file cap, park and TRUNCATE at the barrier —
    //    the backfill part is instant when the backlog is already folded.
    if (this.growthBytes() <= this.hardBytes && this.db.getWalSizeBytes() <= this.fileCapBytes) return null;
    this.log(`backpressure: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)} — pausing writer for full backfill`);
    const t0 = Date.now();
    this.pause = this.backfillFully().finally(() => {
      this.pause = null;
      this.log(`backpressure released after ${Date.now() - t0}ms: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`);
    });
    return this.pause;
  }

  /** Await any in-flight checkpoint and writer pause. */
  async drain(): Promise<void> {
    while (this.pause || this.inflight) {
      if (this.pause) await this.pause;
      if (this.inflight) await this.inflight;
    }
  }

  /**
   * Phase-boundary fold: backfill the ENTIRE WAL now (off-thread, awaited).
   * Called between bulk phases — e.g. after parsing, before resolution's
   * first reads — so the next phase never pages a bulk-write-sized WAL on
   * the main thread (the post-parse read against a multi-GB WAL is what
   * blew the #850 watchdog's 60s window in the #1231 repro). The await
   * keeps the event loop (and the watchdog heartbeat) turning.
   */
  async foldNow(): Promise<void> {
    await this.drain();
    if (this.growthBytes() <= 0) return;
    this.log(`foldNow: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`);
    this.pause = this.backfillFully().finally(() => { this.pause = null; });
    await this.pause;
  }

  /**
   * With the writer parked on the returned promise, loop passive passes until
   * one reports the entire WAL backfilled (typically the second: the first
   * drains the pass that was already running against a stale snapshot). Gives
   * up after a bounded number of passes — e.g. a reader pinning the WAL —
   * because unbounded WAL growth degrades; a wedged writer never recovers.
   */
  private async backfillFully(): Promise<void> {
    for (let i = 0; i < MAX_PAUSED_BACKFILL_PASSES; i++) {
      if (this.inflight) await this.inflight; // fold in the stale in-flight pass first
      const res = await this.db.checkpointWalPassive();
      if (!res) return; // checkpoint machinery unavailable — don't spin
      this.log(`backfill pass ${i + 1}: busy=${res.busy} log=${res.log} checkpointed=${res.checkpointed} wal=${this.mb(this.db.getWalSizeBytes())}`);
      if (res.busy === 0 && res.log === res.checkpointed) {
        // Backfill complete AND we are at a parked barrier (backfillFully only
        // runs under a writer pause): the no-reader window is guaranteed, so
        // chop the FILE too — a fully-backfilled WAL otherwise keeps growing
        // whenever commits land while pool readers hold marks (§7a.1: 22GB
        // on-disk at kernel scale despite backfills). A racing reader turns
        // this into a no-op (busy=1); the passive result above still stands.
        const trunc = await this.db.checkpointWalTruncate();
        if (trunc) this.log(`truncate: busy=${trunc.busy} wal=${this.mb(this.db.getWalSizeBytes())}`);
        this.sizeAtLastFullBackfill = this.db.getWalSizeBytes();
        this.consecutiveGiveUps = 0;
        this.futileUntil = 0;
        return;
      }
    }
    this.consecutiveGiveUps++;
    if (this.consecutiveGiveUps >= 2) {
      this.futileUntil = Date.now() + 60_000;
    }
    const msg = `backfill gave up after ${MAX_PAUSED_BACKFILL_PASSES} passes (streak ${this.consecutiveGiveUps}${this.futileUntil ? ', parking disabled 60s' : ''}) — a reader is pinning the WAL`;
    this.log(msg);
    // Give-ups are rare and load-bearing for §7a.1-class diagnosis — surface
    // them on any timing-instrumented run, not just valve-debug ones.
    if (process.env.CODEGRAPH_SYNTH_TIMINGS && !process.env.CODEGRAPH_WAL_VALVE_DEBUG) {
      console.error(`[wal-valve] ${msg}`);
    }
  }

  private fire(): void {
    this.log(`fire: wal=${this.mb(this.db.getWalSizeBytes())} baseline=${this.mb(this.sizeAtLastFullBackfill)}`);
    const p = this.db
      .checkpointWalPassive()
      .then((res) => {
        this.log(`timer pass: ${res ? `busy=${res.busy} log=${res.log} checkpointed=${res.checkpointed}` : 'null (machinery unavailable)'} wal=${this.mb(this.db.getWalSizeBytes())}`);
        // Full backfill (busy 0, every log frame checkpointed) ⇒ the writer's
        // next commit wraps the WAL; the file's current size becomes the new
        // growth baseline. A partial pass (writer appended during it, or a
        // read transaction pinned frames) leaves the baseline alone, so the
        // next tick fires again and copies the remainder. In non-WAL mode
        // SQLite reports log = checkpointed = -1, which is harmless here.
        if (res && res.busy === 0 && res.log === res.checkpointed) {
          this.sizeAtLastFullBackfill = this.db.getWalSizeBytes();
          // NO truncate here. A truncate checkpoint that starts against an
          // ACTIVE writer wins the lock race and then blocks that writer for
          // its entire backfill — after a multi-GB single-transaction burst
          // (edge-index recreate) that exceeds the writer's 5s busy_timeout
          // and fails the index with "database is locked" (§7a.2 record run).
          // The file chop happens exclusively at parked barriers
          // (backpressure/foldNow), where the writer is awaiting us by
          // construction and cannot collide.
        }
      })
      .catch(() => { /* best-effort */ })
      .finally(() => {
        if (this.inflight === p) this.inflight = null;
      });
    this.inflight = p;
  }
}
