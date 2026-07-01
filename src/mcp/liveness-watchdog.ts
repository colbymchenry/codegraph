/**
 * Main-thread liveness watchdog — belt-and-suspenders for #850.
 *
 * The #850 fix removes the one *known* trigger (the uncaught-exception handler
 * no longer formats a raw Error's `.stack`). But ANY synchronous, non-yielding
 * loop on the main thread — a future V8 stack-format pathology, a runaway
 * regex, an accidental `while (true)` — wedges the event loop, and from JS you
 * cannot interrupt it: timers, signal handlers, and the PPID watchdog all run
 * *on* that blocked loop, so the process pins a core forever with no
 * self-recovery (the exact unrecoverable state #850 reported).
 *
 * **Why a separate PROCESS, not a worker thread.** A worker thread was the
 * obvious first choice and it works in a toy process — but it was validated to
 * FAIL in the real daemon (#850 live test). V8 isolates in one process
 * coordinate on global safepoints, so when one thread requests a GC every other
 * thread must reach a safepoint before it can proceed. A main thread wedged in
 * a tight, non-allocating loop never reaches one, which strands the watchdog
 * worker on its very next allocation/safepoint check — and the #850 hot loop
 * (`SourcePositionTableIterator::Advance`, a non-allocating C++ table walk) is
 * exactly that shape. A child process shares no isolate and no heap with the
 * parent, so the wedge cannot touch it; it kills via the kernel, which honours
 * SIGKILL regardless of what the parent's threads are doing.
 *
 * **How.** The parent sends a heartbeat over a dedicated IPC channel every
 * `checkMs` from a timer — firing at all means the event loop is turning. The
 * child resets a kill-timer on each heartbeat; if none arrives for `timeoutMs` it
 * `SIGKILL`s the parent so a fresh daemon starts on the next connection. When
 * the parent exits normally the IPC channel closes and the child exits too (no
 * orphan).
 *
 * **Won't fire on real work.** Heavy parsing runs in the parse worker
 * (off-thread) and indexing shells out to a child process, so the daemon's main
 * thread only ever does fast, bounded work. The default timeout is ~300× the
 * 5h #850 wedge shorter, yet far longer than any legitimate main-thread block.
 * Opt out with `CODEGRAPH_NO_WATCHDOG=1`; tune with `CODEGRAPH_WATCHDOG_TIMEOUT_MS`.
 */
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

/** Default: 60s — ~300× shorter than the 5h #850 wedge, far longer than any real main-thread block. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 60_000;

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

/** Derive a heartbeat cadence that emits several beats inside the timeout window. */
export function deriveCheckIntervalMs(timeoutMs: number): number {
  return Math.min(2000, Math.max(50, Math.round(timeoutMs / 5)));
}

/** Arming/teardown diagnostics, gated on the existing MCP debug switch. */
function debug(msg: string): void {
  if (process.env.CODEGRAPH_MCP_DEBUG) {
    try { fs.writeSync(2, `[CodeGraph watchdog] ${msg}\n`); } catch { /* ignore */ }
  }
}

export interface WatchdogHandle {
  /** Emit one heartbeat immediately. Safe to call from long synchronous loops. */
  beat(): void;

  /** Stop heartbeating and shut the watchdog child down. Idempotent. */
  stop(): void;
}

/**
 * The watchdog child body, run via `node -e`. Inlined as a string (not a
 * shipped `.js`) so there is no dist-vs-src path to resolve — it runs
 * identically under `tsx` in tests and under the bundle in production. Reads its
 * target pid + timeout from argv; an MSG built once at startup (the child is
 * never wedged, so allocation here is fine).
 */
const CHILD_SOURCE = `
const fs = require('fs');
const parentPid = Number(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const secs = Math.round(timeoutMs / 1000);
const MSG = Buffer.from('[CodeGraph] Main thread unresponsive for ~' + secs + 's — killing the wedged process so a fresh one can start (#850). Disable with CODEGRAPH_NO_WATCHDOG=1.\\n');
function kill() {
  try { fs.writeSync(2, MSG); } catch (e) {}
  try { process.kill(parentPid, 'SIGKILL'); } catch (e) {}
  process.exit(0);
}
let timer = setTimeout(kill, timeoutMs);
process.on('message', () => { clearTimeout(timer); timer = setTimeout(kill, timeoutMs); });
process.on('disconnect', () => process.exit(0)); // parent closed the IPC channel (exited) -> no orphan
`;

/**
 * Install the main-thread liveness watchdog for a long-lived process. Returns a
 * handle to stop it, or `null` when disabled or when the child can't be spawned
 * (degraded, never throws — a missing watchdog must never keep a process from
 * starting).
 */
export function installMainThreadWatchdog(): WatchdogHandle | null {
  if (isEnvTruthy(process.env.CODEGRAPH_NO_WATCHDOG)) return null;

  const timeoutMs = parseWatchdogTimeoutMs(process.env.CODEGRAPH_WATCHDOG_TIMEOUT_MS);
  const checkMs = deriveCheckIntervalMs(timeoutMs);

  let child: ChildProcess;
  try {
    // No execArgv inheritance (unlike Worker), so the child carries none of our
    // V8 flags — it runs no WASM and needs none. stderr inherits the parent's
    // fd 2 so the kill notice lands wherever the parent logs (daemon.log).
    child = spawn(
      process.execPath,
      ['-e', CHILD_SOURCE, String(process.pid), String(timeoutMs)],
      {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        windowsHide: true,
        // The watchdog touches no files; keep its cwd off the project/temp dir
        // so it can't hold one open (Windows EPERM-on-cleanup, mirrors the
        // parse-worker quirk).
        cwd: os.tmpdir(),
      }
    );
  } catch (err) {
    debug(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (!child.send) {
    debug('child has no IPC channel; not arming');
    try { child.kill(); } catch { /* ignore */ }
    return null;
  }
  child.on('error', (err) => debug(`child error: ${err.message}`));

  const beat = (): void => {
    try { child.send?.('beat'); } catch { /* child gone */ }
  };

  // Heartbeat: one IPC message per tick. When the main thread wedges, these stop and the
  // child's timeout fires. unref'd so it never keeps the process alive itself.
  const heartbeat = setInterval(beat, checkMs);
  heartbeat.unref();

  // Neither the child nor its IPC channel should keep the parent alive past its work.
  child.unref();
  try { child.channel?.unref?.(); } catch { /* ignore */ }

  debug(`armed (child pid ${child.pid ?? '?'}): timeoutMs=${timeoutMs} checkMs=${checkMs}`);

  let stopped = false;
  return {
    beat,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      try { child.disconnect(); } catch { /* ignore */ } // IPC close -> child exits cleanly
      try { child.kill(); } catch { /* ignore */ } // belt-and-suspenders
    },
  };
}
