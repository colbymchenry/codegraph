/**
 * Main-thread liveness watchdog — belt-and-suspenders for #850.
 *
 * The #850 fix removes the one *known* trigger (the uncaught-exception handler
 * no longer formats a raw Error's `.stack` — the step that could enter a
 * non-terminating V8 source-position loop). But ANY synchronous, non-yielding
 * loop on the main thread — a future V8 stack-format pathology, a runaway
 * regex, an accidental `while (true)` — wedges the event loop, and from JS you
 * cannot interrupt it: timers, signal handlers, and the PPID watchdog all run
 * *on* that blocked loop, so the process pins a core forever with no
 * self-recovery (the exact unrecoverable state #850 reported).
 *
 * The only observer still running when the main thread is wedged is another
 * THREAD. This installs a tiny worker thread that watches a heartbeat the main
 * thread bumps through shared memory. If the heartbeat stops advancing across
 * enough consecutive checks (~`timeoutMs` of real time), the worker concludes
 * the main thread is wedged and SIGKILLs the process — the one signal a wedged
 * event loop can't swallow — so a fresh daemon starts on the next connection
 * instead of a zombie pinning a core.
 *
 * **Why count checks, not elapsed wall-clock.** A laptop that sleeps freezes
 * both threads; on wake `Date.now()` has jumped hours but the heartbeat sat
 * still — a wall-clock delta would false-positive and kill a perfectly healthy
 * daemon. Counting *consecutive worker iterations* with no progress is immune:
 * a healthy main thread resumes and bumps the heartbeat within one interval of
 * waking, resetting the count; only a thread that never resumes keeps it
 * climbing. {@link stepHeartbeat} is the pure reducer behind both the worker
 * and the unit tests.
 *
 * **Why it won't fire on real work.** Heavy parsing runs in the parse worker
 * (off this thread) and indexing shells out to a child process, so the daemon's
 * main thread only ever does fast, bounded work (socket handling + sub-second
 * SQLite reads). The default timeout is therefore vastly larger than any
 * legitimate main-thread block yet vastly smaller than "forever". Opt out with
 * `CODEGRAPH_NO_WATCHDOG=1`; tune with `CODEGRAPH_WATCHDOG_TIMEOUT_MS`.
 */
import { Worker } from 'worker_threads';

/** Default: 60s — ~300× shorter than the 5h #850 wedge, far longer than any real main-thread block. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 60_000;

export interface HeartbeatState {
  /** Last heartbeat counter the worker observed. */
  lastCounter: number;
  /** Consecutive checks the counter has NOT advanced. */
  staleChecks: number;
}

/**
 * Pure reducer for one worker check. `maxStaleChecks` consecutive no-progress
 * checks → wedged. Counting iterations (not wall-clock) is what makes this
 * robust to clock jumps / system sleep.
 */
export function stepHeartbeat(
  state: HeartbeatState,
  counter: number,
  maxStaleChecks: number
): { next: HeartbeatState; wedged: boolean } {
  if (counter !== state.lastCounter) {
    return { next: { lastCounter: counter, staleChecks: 0 }, wedged: false };
  }
  const staleChecks = state.staleChecks + 1;
  return {
    next: { lastCounter: counter, staleChecks },
    wedged: staleChecks >= maxStaleChecks,
  };
}

/** `true` for `1/true/yes/on` (case-insensitive); `false` otherwise. */
function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Parse the timeout env, falling back to the default for missing/invalid values. */
export function parseWatchdogTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_WATCHDOG_TIMEOUT_MS
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Derive a heartbeat/check cadence that fires several times inside the timeout window. */
export function deriveCheckIntervalMs(timeoutMs: number): number {
  return Math.min(2000, Math.max(50, Math.round(timeoutMs / 5)));
}

export interface WatchdogHandle {
  /** Stop heartbeating and terminate the worker. Idempotent. */
  stop(): void;
}

/**
 * The worker body, run via `new Worker(src, { eval: true })`. Inlined as a
 * string (not a shipped `.js`) so there is no dist-vs-src path to resolve — it
 * runs identically under `tsx` in tests and under the bundle in production.
 * Mirrors {@link stepHeartbeat}; keep the two in sync (the unit test pins the
 * algorithm, the integration test pins this exact body end-to-end).
 */
const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const beat = new Int32Array(workerData.sab);
const { checkMs, maxStaleChecks } = workerData;
let lastCounter = Atomics.load(beat, 0);
let staleChecks = 0;
const timer = setInterval(() => {
  const counter = Atomics.load(beat, 0);
  if (counter !== lastCounter) { lastCounter = counter; staleChecks = 0; return; }
  if (++staleChecks < maxStaleChecks) return;
  clearInterval(timer);
  const secs = Math.round((staleChecks * checkMs) / 1000);
  try {
    fs.writeSync(2, '[CodeGraph] Main thread unresponsive for ~' + secs + 's — killing the wedged process so a fresh one can start (#850). Disable with CODEGRAPH_NO_WATCHDOG=1.\\n');
  } catch (e) { /* stderr gone */ }
  try { process.kill(process.pid, 'SIGKILL'); } catch (e) { /* nothing left to try */ }
}, checkMs);
`;

/**
 * Install the main-thread liveness watchdog for a long-lived process. Returns a
 * handle to stop it, or `null` when disabled or when the worker can't be
 * spawned (degraded, never throws — a missing watchdog must never keep a
 * process from starting).
 */
export function installMainThreadWatchdog(): WatchdogHandle | null {
  if (isEnvTruthy(process.env.CODEGRAPH_NO_WATCHDOG)) return null;

  const timeoutMs = parseWatchdogTimeoutMs(process.env.CODEGRAPH_WATCHDOG_TIMEOUT_MS);
  const checkMs = deriveCheckIntervalMs(timeoutMs);
  const maxStaleChecks = Math.max(1, Math.ceil(timeoutMs / checkMs));

  // Single Int32 counter in shared memory. The main thread bumps it each tick;
  // the worker reads it. Atomics make the write visible across threads.
  const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const beat = new Int32Array(sab);

  // The heartbeat: firing at all means the event loop is turning. unref'd so it
  // never keeps the process alive on its own (the server's socket does that).
  const heartbeat = setInterval(() => {
    Atomics.add(beat, 0, 1);
  }, checkMs);
  heartbeat.unref();

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab, checkMs, maxStaleChecks },
    });
  } catch {
    // Worker threads unavailable — fall back to no watchdog rather than refuse
    // to start. Degraded (a future wedge wouldn't self-kill) but not broken.
    clearInterval(heartbeat);
    return null;
  }

  // A watchdog-worker error must never escalate to the global handler (which now
  // exits, #850): swallow it and run degraded.
  worker.on('error', () => { /* watchdog gone; nothing safe to do here */ });
  // Don't let the watchdog keep the process alive past its real work.
  worker.unref();

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      void worker.terminate();
    },
  };
}
