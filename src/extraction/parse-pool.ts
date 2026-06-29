/**
 * Parse worker pool — runs tree-sitter parsing across N worker threads so a full
 * `codegraph index` uses every core instead of pinning one.
 *
 * Why this exists: `ExtractionOrchestrator.indexAll()` already reads files in
 * parallel, but it parsed them through a SINGLE worker thread, so on an
 * N-core machine indexing a large repo used one core and left the rest idle
 * (issue #1015, the parse-time half of #320). Spreading the parse calls across a
 * pool of workers — each its own tree-sitter WASM heap — restores multi-core
 * throughput. SQLite storage stays on the main thread (it isn't thread-safe), so
 * only the CPU-bound parse step is parallelised; results are stored as they
 * arrive, in whatever order they finish.
 *
 * Design mirrors {@link ../mcp/query-pool} (idle-list dispatch, lazy growth,
 * throttled cold-starts, crash recovery), with parse-specific behaviour:
 *   - per-worker recycle: WASM linear memory grows but never shrinks, so each
 *     worker is torn down and replaced after `recycleInterval` parses to reclaim
 *     its heap — the same reason the old single worker recycled.
 *   - reject, don't retry: a parse that crashes or times out its worker REJECTS
 *     (with a message the orchestrator's retry pass recognises) rather than being
 *     silently requeued — the orchestrator owns the smarter two-stage retry
 *     (fresh worker, then comment-stripped) on a clean WASM heap.
 *   - a size-1 pool reproduces the old single-worker path exactly, which is the
 *     conservative rollback: set `CODEGRAPH_PARSE_WORKERS=1`.
 *
 * Memory: peak scales with pool size (≈ size × a worker's pre-recycle heap), so
 * the default is capped and the env var lets constrained machines dial it down.
 */

import { Worker } from 'worker_threads';
import type { Language, ExtractionResult } from '../types';

/**
 * Minimal worker surface the pool drives — satisfied by a real `worker_threads`
 * Worker. Abstracted so tests can inject a fake worker and exercise the pool's
 * queue / growth / recycle / crash-recovery logic without spawning threads or a
 * built `dist/`.
 */
export interface ParsePoolWorker {
  postMessage(msg: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', cb: (m: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
}

/** A single file to parse. `language` is resolved on the main thread (it holds
 *  the project's codegraph.json extension overrides) and handed to the worker. */
export interface ParseTask {
  filePath: string;
  content: string;
  language: Language;
  frameworkNames?: string[];
}

/** Default upper bound on the pool size derived from the core count. */
const DEFAULT_PARSE_POOL_CAP = 8;
/** Hard ceiling on pool size regardless of an explicit env override. */
const MAX_PARSE_POOL_SIZE = 16;
/** Parses a worker performs before it's recycled to reclaim WASM heap. */
const DEFAULT_RECYCLE_INTERVAL = 250;
/** Base per-parse timeout; scaled up for large files by the caller's formula. */
const DEFAULT_PARSE_TIMEOUT_MS = 10_000;
/**
 * Max workers cold-starting at once. A worker's cold start is heavy (module load
 * + grammar WASM compile); starting the whole pool simultaneously thrashes CPU.
 * Warming a couple at a time keeps each start fast while the pool still reaches
 * full size within a few parses of a large run.
 */
const MAX_CONCURRENT_SPAWN = 2;
/**
 * Total worker deaths before the pool stops respawning and fails outstanding
 * work, so a systematically-broken worker platform degrades instead of
 * respawning forever. Set high: normal per-file WASM crashes are cleared by the
 * orchestrator's retry pass and shouldn't trip this on a merely-crashy repo.
 */
const CRASH_BUDGET = 100;

/**
 * Resolve the pool size from the `CODEGRAPH_PARSE_WORKERS` override and the
 * machine's core count.
 *   - explicit `0` or `1` → 1 worker (the old single-worker path; the rollback).
 *   - explicit `N` → N, clamped to [1, 16].
 *   - unset / blank / non-numeric → `clamp(cores - 1, 1, 8)` (leave a core for
 *     the main thread + UI; never zero — parsing always needs a worker).
 */
export function resolveParsePoolSize(envVal: string | undefined, cpuCount: number): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) {
      return Math.max(1, Math.min(Math.floor(n), MAX_PARSE_POOL_SIZE));
    }
    // non-numeric / negative → fall through to the default
  }
  return Math.max(1, Math.min(cpuCount - 1, DEFAULT_PARSE_POOL_CAP));
}

interface ParseJob {
  id: number;
  task: ParseTask;
  resolve: (r: ExtractionResult) => void;
  reject: (e: Error) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Shape of a message a worker posts back (grammar-load ack or a parse result). */
interface ParseWorkerMessage {
  type?: string;
  id?: number;
  result?: ExtractionResult;
}

export interface ParseWorkerPoolOptions {
  /** Languages to load grammars for in every worker at spawn. */
  languages: Language[];
  /** Number of worker threads (≥1). Clamp the resolved value before passing. */
  size: number;
  /** Compiled `parse-worker.js` path. Required unless `createWorker` is given. */
  workerScriptPath?: string;
  /** Parses per worker before recycle. Default 250. */
  recycleInterval?: number;
  /** Base per-parse timeout (ms); scaled by file size per parse. Default 10s. */
  parseTimeoutMs?: number;
  /** Worker factory (tests inject a fake). Defaults to a real `worker_threads` Worker. */
  createWorker?: () => ParsePoolWorker;
  /** Optional verbose logger (the orchestrator's `[worker] …` logger). */
  log?: (msg: string) => void;
}

export class ParseWorkerPool {
  private idle: ParsePoolWorker[] = [];
  private queue: ParseJob[] = [];
  private inflight = new Map<ParsePoolWorker, ParseJob>();
  private workers = new Set<ParsePoolWorker>();
  // Spawned but not yet 'grammars-loaded'. Growth counts these so a single first
  // parse doesn't spawn the whole pool before the eager worker reports ready.
  private pending = new Set<ParsePoolWorker>();
  private parseCounts = new Map<ParsePoolWorker, number>();
  private nextId = 1;
  private totalCrashes = 0;
  private destroyed = false;

  private readonly languages: Language[];
  private readonly maxSize: number;
  private readonly recycleInterval: number;
  private readonly parseTimeoutMs: number;
  private readonly createWorker: () => ParsePoolWorker;
  private readonly log: (msg: string) => void;

  constructor(opts: ParseWorkerPoolOptions) {
    this.languages = opts.languages;
    this.maxSize = Math.max(1, Math.min(opts.size, MAX_PARSE_POOL_SIZE));
    this.recycleInterval = opts.recycleInterval ?? DEFAULT_RECYCLE_INTERVAL;
    this.parseTimeoutMs = opts.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    if (opts.createWorker) {
      this.createWorker = opts.createWorker;
    } else if (opts.workerScriptPath) {
      const scriptPath = opts.workerScriptPath;
      this.createWorker = () => new Worker(scriptPath);
    } else {
      throw new Error('ParseWorkerPool requires workerScriptPath or createWorker');
    }
    this.spawnOne(); // one eager warm worker, ready for the first parse
  }

  /** Pool size cap (for logging). */
  get size(): number { return this.maxSize; }

  /** Live worker count (for tests). */
  get liveWorkers(): number { return this.workers.size; }

  /** False once the crash budget is exhausted (or after destroy). */
  get healthy(): boolean {
    return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
  }

  /**
   * Parse one file on the pool. Resolves with the extraction result, or REJECTS
   * if the parse times out or its worker crashes — the caller records the error
   * and (for worker-exit/OOM rejections) re-attempts in its retry pass.
   */
  requestParse(task: ParseTask): Promise<ExtractionResult> {
    if (this.destroyed) return Promise.reject(new Error('Parse pool destroyed'));
    return new Promise<ExtractionResult>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, task, resolve, reject, settled: false });
      this.drain();
    });
  }

  private spawnOne(): void {
    if (this.destroyed || this.workers.size >= this.maxSize || !this.healthy) return;
    let w: ParsePoolWorker;
    try {
      w = this.createWorker();
    } catch {
      this.totalCrashes++; // counts toward the circuit breaker
      return;
    }
    this.workers.add(w);
    this.pending.add(w);
    this.parseCounts.set(w, 0);
    w.on('message', (m) => this.onMessage(w, (m ?? {}) as ParseWorkerMessage));
    w.on('error', (e) => this.onWorkerGone(w, `Worker error: ${e?.message ?? 'unknown'}`));
    w.on('exit', (code) => { if (code !== 0) this.onWorkerGone(w, `Worker exited with code ${code}`); });
    // Load grammars; the worker replies 'grammars-loaded' and only then is idle.
    w.postMessage({ type: 'load-grammars', languages: this.languages });
  }

  private onMessage(w: ParsePoolWorker, m: ParseWorkerMessage): void {
    if (m.type === 'grammars-loaded') {
      if (!this.workers.has(w)) return; // recycled/destroyed before ready
      this.pending.delete(w);
      this.idle.push(w);
      this.drain();
      return;
    }
    if (m.type === 'parse-result') {
      const job = this.inflight.get(w);
      if (!job || (m.id !== undefined && m.id !== job.id)) return; // stale (post-recycle)
      this.inflight.delete(w);
      // Recycle the worker once it's done enough parses to have grown its WASM
      // heap; otherwise return it to the idle set for the next job.
      if ((this.parseCounts.get(w) ?? 0) >= this.recycleInterval) {
        this.recycle(w);
      } else {
        this.idle.push(w);
      }
      this.settle(job, m.result);
      this.drain();
    }
  }

  /** A worker died (crash hook / OOM exit / spawn error). Reject its in-flight
   *  parse so the caller's retry pass can re-attempt it, then respawn. */
  private onWorkerGone(w: ParsePoolWorker, message: string): void {
    if (!this.workers.has(w)) return; // already handled (error+exit both fire), or recycled
    this.removeWorker(w);
    this.totalCrashes++;
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    try { void w.terminate(); } catch { /* already gone */ }
    if (job) this.settle(job, undefined, new Error(message));
    if (this.healthy) this.spawnOne(); // keep capacity
    this.drain();
  }

  /** Tear down a worker that has hit its recycle threshold and replace it. Not a
   *  crash, so it doesn't count against the budget. */
  private recycle(w: ParsePoolWorker): void {
    this.log(`Recycling worker after ${this.parseCounts.get(w)} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
    this.removeWorker(w);
    // Fire-and-forget: worker.terminate() can hang if WASM is wedged.
    try { void w.terminate(); } catch { /* already gone */ }
    if (this.healthy && !this.destroyed) this.spawnOne();
  }

  private removeWorker(w: ParsePoolWorker): void {
    this.workers.delete(w);
    this.pending.delete(w);
    this.parseCounts.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
  }

  private dispatch(w: ParsePoolWorker, job: ParseJob): void {
    this.inflight.set(w, job);
    this.parseCounts.set(w, (this.parseCounts.get(w) ?? 0) + 1);
    // Scale the timeout for large files: base + 10s per 100KB (matches the
    // original single-worker formula so pathological-file behaviour is unchanged).
    const timeoutMs = this.parseTimeoutMs + Math.floor(job.task.content.length / 100_000) * 10_000;
    job.timer = setTimeout(() => this.onTimeout(w, job, timeoutMs), timeoutMs);
    job.timer.unref?.();
    w.postMessage({
      type: 'parse',
      id: job.id,
      filePath: job.task.filePath,
      content: job.task.content,
      frameworkNames: job.task.frameworkNames,
      language: job.task.language,
    });
  }

  private onTimeout(w: ParsePoolWorker, job: ParseJob, ms: number): void {
    if (job.settled || !this.workers.has(w)) return;
    this.log(`TIMEOUT: ${job.task.filePath} exceeded ${ms}ms — killing worker`);
    // Kill the (possibly WASM-wedged) worker and reject this parse. A timeout
    // isn't a crash — don't charge the budget — but the worker is gone, so spawn
    // a replacement to keep capacity.
    this.removeWorker(w);
    this.inflight.delete(w);
    try { void w.terminate(); } catch { /* already gone */ }
    this.settle(job, undefined, new Error(`Parse timed out after ${ms}ms`));
    if (this.healthy) this.spawnOne();
    this.drain();
  }

  private drain(): void {
    // Grow toward maxSize while queued work outstrips workers that are idle OR
    // already on their way up — throttled so we never cold-start the whole pool
    // at once.
    while (
      this.queue.length > this.idle.length + this.pending.size &&
      this.workers.size < this.maxSize &&
      this.pending.size < MAX_CONCURRENT_SPAWN &&
      !this.destroyed &&
      this.healthy
    ) {
      this.spawnOne();
    }
    // Dispatch queued jobs to idle workers.
    while (this.idle.length && this.queue.length) {
      let job: ParseJob | undefined;
      while (this.queue.length && (job = this.queue.shift()) && job.settled) job = undefined;
      if (!job || job.settled) break;
      const w = this.idle.pop()!;
      this.dispatch(w, job);
    }
    // Hang-prevention: if there's queued work but nothing can ever run it (no
    // idle workers, none spawning, none alive), fail it instead of hanging
    // forever. Reached only when the crash budget is exhausted or after destroy.
    if (this.queue.length && this.idle.length === 0 && this.pending.size === 0 && this.workers.size === 0) {
      const reason = this.destroyed ? 'parse pool destroyed' : 'parse pool exhausted its worker crash budget';
      for (const job of this.queue.splice(0)) this.settle(job, undefined, new Error(reason));
    }
  }

  private settle(job: ParseJob, result?: ExtractionResult, err?: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    if (err) job.reject(err);
    else job.resolve(result!);
  }

  /**
   * Recycle every idle worker now (fresh WASM heaps). The orchestrator calls
   * this before its retry pass so crash-on-memory files get the cleanest heap.
   */
  recycleAll(): void {
    for (const w of [...this.idle]) this.recycle(w);
  }

  /** Terminate all workers and reject any outstanding parses. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const ws = [...this.workers];
    this.workers.clear();
    this.pending.clear();
    this.parseCounts.clear();
    this.idle = [];
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, undefined, new Error('parse pool destroyed'));
    }
    this.inflight.clear();
    this.queue = [];
    await Promise.all(ws.map((w) => Promise.resolve(w.terminate()).catch(() => { /* already gone */ })));
  }
}
