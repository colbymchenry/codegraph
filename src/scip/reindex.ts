/**
 * Background SCIP reindex for a watched project.
 *
 * Each synced edit restarts an idle timer; once the project has been quiet for
 * `idleMs` every language that ALREADY has an installed index is re-indexed,
 * niced, one at a time, then merged. A tsgo index is patched — only the changed
 * files and their importers are re-indexed (produce.ts incrementalPlan) — and
 * may run every `incrementalIntervalMs`; a full rebuild waits `minIntervalMs`
 * since the last run. Projects never opted in with `codegraph scip index` are
 * left alone — no surprise indexer runs.
 */

import { MergeScope, joinScopes, runScipPass, ScipHost } from './index';
import { incrementalPlan, produceIndex } from './produce';
import { availableIndexes, tryReindexLock } from './store';

export interface ReindexOptions {
  idleMs?: number;
  minIntervalMs?: number;
  incrementalIntervalMs?: number;
  log?: (msg: string) => void;
}

export const DEFAULT_IDLE_MS = 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;
export const DEFAULT_INCREMENTAL_INTERVAL_MS = 60_000;

export class ScipReindexScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastRunAt = 0;
  private dirty = false;
  private abort = new AbortController();
  private readonly idleMs: number;
  private readonly minIntervalMs: number;
  private readonly incrementalIntervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly host: ScipHost, opts: ReindexOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.incrementalIntervalMs = opts.incrementalIntervalMs ?? DEFAULT_INCREMENTAL_INTERVAL_MS;
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
    const wait = this.lastRunAt + (this.patchable() ? this.incrementalIntervalMs : this.minIntervalMs) - Date.now();
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
    } finally {
      lock.release();
    }
  }

  private async reindex(root: string): Promise<void> {
    let installed = 0;
    /** what the patches changed; null once any index was rebuilt in full */
    let scopes: MergeScope[] | null = [];
    for (const { lang } of availableIndexes(root)) {
      if (this.abort.signal.aborted) return;
      try {
        const r = await produceIndex(this.host.scipReadDb(), root, lang, { nice: true, incremental: true, signal: this.abort.signal, log: this.log });
        if (r.status === 'installed') {
          installed++;
          scopes = r.scope && scopes ? [...scopes, r.scope] : null;
          if (r.incremental !== undefined) this.log(`${lang}: patched ${r.incremental} file(s) in ${r.durationMs}ms`);
          for (const w of r.warnings) this.log(`${lang} reindex: ${w}`);
        }
        else if (r.status !== 'current') this.log(`${lang} reindex ${r.status}: ${r.reason}`);
      } catch (err) {
        this.log(`${lang} reindex failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (installed === 0 || this.abort.signal.aborted) return;
    try {
      const report = await this.host.scipWrite((db) => runScipPass(db, root, scopes ? joinScopes(scopes) : undefined));
      if (report) this.log(`merged ${report.freshDocuments}/${report.documents} documents (${report.judgedDocuments} re-judged) in ${report.durationMs}ms`);
    } catch (err) {
      this.log(`merge after reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
