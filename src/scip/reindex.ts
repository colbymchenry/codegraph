/**
 * Background SCIP reindex for a watched project.
 *
 * Each synced edit restarts an idle timer; once the project has been quiet for
 * `idleMs` (and at least `minIntervalMs` has passed since the last run) every
 * language that ALREADY has an installed index is re-indexed, niced, one at a
 * time, then merged. Projects never opted in with `codegraph scip index` are
 * left alone — no surprise indexer runs.
 */

import { runScipPass, ScipHost } from './index';
import { produceIndex } from './produce';
import { availableIndexes } from './store';

export interface ReindexOptions {
  idleMs?: number;
  minIntervalMs?: number;
  log?: (msg: string) => void;
}

export const DEFAULT_IDLE_MS = 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;

export class ScipReindexScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastRunAt = 0;
  private dirty = false;
  private abort = new AbortController();
  private readonly idleMs: number;
  private readonly minIntervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly host: ScipHost, opts: ReindexOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.log = opts.log ?? ((m) => process.stderr.write(`[CodeGraph SCIP] ${m}\n`));
  }

  /** A sync changed files. */
  notifyChange(): void {
    if (availableIndexes(this.host.getProjectRoot()).length === 0) return;
    this.dirty = true;
    this.arm(this.idleMs);
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
    const wait = this.lastRunAt + this.minIntervalMs - Date.now();
    if (wait > 0) {
      this.arm(wait);
      return;
    }
    this.dirty = false;
    this.lastRunAt = Date.now();
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.dirty) this.arm(this.idleMs);
    });
  }

  private async runOnce(): Promise<void> {
    const root = this.host.getProjectRoot();
    let installed = 0;
    for (const lang of availableIndexes(root)) {
      if (this.abort.signal.aborted) return;
      try {
        const r = await produceIndex(this.host.scipReadDb(), root, lang, { nice: true, signal: this.abort.signal, log: this.log });
        if (r.status === 'installed') installed++;
        else this.log(`${lang} reindex ${r.status}: ${r.reason}`);
      } catch (err) {
        this.log(`${lang} reindex failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (installed === 0 || this.abort.signal.aborted) return;
    try {
      const report = await this.host.scipWrite((db) => runScipPass(db, root));
      if (report) this.log(`merged ${report.freshDocuments}/${report.documents} documents in ${report.durationMs}ms`);
    } catch (err) {
      this.log(`merge after reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
