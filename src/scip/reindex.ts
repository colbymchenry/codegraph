/**
 * Background SCIP reindex for a watched project.
 *
 * Each synced edit restarts an idle timer; once the project has been quiet for
 * it, every language that ALREADY has an installed index is re-indexed, niced,
 * one at a time, then merged. When every index can be patched — only the
 * changed files and their importers re-indexed (produce.ts incrementalPlan),
 * a few seconds — the wait is `patchIdleMs` and a patch may run every
 * `incrementalIntervalMs`; a full rebuild waits `idleMs` and `minIntervalMs`
 * since the last run. Projects never opted in with `codegraph scip index` are
 * left alone — no surprise indexer runs.
 */

import { ScipHost } from './index';
import { incrementalPlan } from './produce';
import { reindexRound } from './round';
import { INDEXERS } from './indexers';
import { availableIndexes, patchDriftExceeded, tryReindexLock } from './store';

export interface ReindexOptions {
  /** quiet time before a full rebuild; also before a patch, unless `patchIdleMs` is given */
  idleMs?: number;
  patchIdleMs?: number;
  minIntervalMs?: number;
  incrementalIntervalMs?: number;
  log?: (msg: string) => void;
}

export const DEFAULT_IDLE_MS = 60_000;
export const DEFAULT_PATCH_IDLE_MS = 10_000;
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_INCREMENTAL_INTERVAL_MS = 10_000;

export class ScipReindexScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastRunAt = 0;
  private dirty = false;
  private abort = new AbortController();
  private readonly idleMs: number;
  private readonly patchIdleMs: number;
  private readonly minIntervalMs: number;
  private readonly incrementalIntervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly host: ScipHost, opts: ReindexOptions = {}) {
    // `CODEGRAPH_SCIP_REINDEX_IDLE_MS` sets both waits: the watcher builds its scheduler with no options (tests shorten them).
    const fixed = opts.idleMs ?? (Number(process.env.CODEGRAPH_SCIP_REINDEX_IDLE_MS) || undefined);
    this.idleMs = fixed ?? DEFAULT_IDLE_MS;
    this.patchIdleMs = opts.patchIdleMs ?? fixed ?? DEFAULT_PATCH_IDLE_MS;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.incrementalIntervalMs = opts.incrementalIntervalMs ?? DEFAULT_INCREMENTAL_INTERVAL_MS;
    this.log = opts.log ?? ((m) => process.stderr.write(`[CodeGraph SCIP] ${m}\n`));
  }

  /** A sync changed files. */
  notifyChange(): void {
    const installed = availableIndexes(this.host.getProjectRoot());
    if (installed.length === 0) return;
    this.dirty = true;
    this.arm(this.quiet(installed));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
  }

  /** Resolves when an in-flight run (if any) finishes. Test hook. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private arm(delayMs: number): void {
    if (this.abort.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fire(), delayMs);
    this.timer.unref();
  }

  private fire(): void {
    this.timer = null;
    if (this.running || !this.dirty) return;
    const wait = this.lastRunAt + (this.patchable() ? this.incrementalIntervalMs : this.minIntervalMs) - Date.now();
    if (wait > 0) {
      this.arm(wait);
      return;
    }
    this.dirty = false;
    this.lastRunAt = Date.now();
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.dirty) this.arm(this.quiet());
    });
  }

  /**
   * How long the project must be quiet: short when the next run is likely a patch.
   * Runs on every synced save, on the server's event loop, so it reads only the
   * installed metas — each index's tool can be patched and its drift allows one —
   * not the full plan (a scan of every file: ~40 ms on vscode). fire() decides.
   */
  private quiet(installed = availableIndexes(this.host.getProjectRoot())): number {
    const likelyPatch = installed.length > 0
      && installed.every(({ lang, meta }) => INDEXERS[lang].patch?.[meta.tool] !== undefined && !patchDriftExceeded(meta));
    return likelyPatch ? this.patchIdleMs : this.idleMs;
  }

  /** Every installed index can be patched rather than rebuilt. */
  private patchable(): boolean {
    const root = this.host.getProjectRoot();
    try {
      const installed = availableIndexes(root);
      return installed.length > 0 && installed.every(({ lang }) => incrementalPlan(this.host.scipReadDb(), root, lang) !== null);
    } catch {
      return false; // can't tell: take the full-run interval
    }
  }

  private async runOnce(): Promise<void> {
    const root = this.host.getProjectRoot();
    const lock = tryReindexLock(root);
    if (!lock) {
      this.log('reindex skipped: another process is re-indexing this project; retrying when idle');
      this.dirty = true;
      return;
    }
    try {
      await this.reindex(root);
    } catch (err) {
      // Nothing awaits this run (fire() only chains it): a throw here would be an
      // unhandled rejection in the MCP server. The index stays pending; the next round merges it.
      this.log(`reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      lock.release();
    }
  }

  private async reindex(root: string): Promise<void> {
    const langs = availableIndexes(root).map(i => i.lang);
    const { results, report } = await reindexRound(this.host, {
      langs,
      nice: true,
      incremental: true,
      signal: this.abort.signal,
      log: this.log,
    });
    for (const r of results) {
      if (r.status === 'installed') {
        if (r.incremental !== undefined) this.log(`${r.lang}: patched ${r.incremental} file(s) in ${r.durationMs}ms`);
        for (const w of r.warnings) this.log(`${r.lang} reindex: ${w}`);
      } else if (r.status !== 'current' && r.status !== 'skipped') {
        this.log(`${r.lang} reindex ${r.status}: ${r.reason}`);
      }
    }
    if (report) this.log(`merged ${report.freshDocuments}/${report.documents} documents (${report.judgedDocuments} re-judged) in ${report.durationMs}ms`);
  }
}
