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
 * **How.** The parent writes a heartbeat byte to the child's stdin every
 * `checkMs` from a timer — firing at all means the event loop is turning. The
 * child resets a kill-timer on each byte; if none arrives for `timeoutMs` it
 * `SIGKILL`s the parent so a fresh daemon starts on the next connection. When
 * the parent exits normally the pipe closes and the child exits too (no
 * orphan).
 *
 * **Won't fire on real work.** Heavy parsing runs in the parse worker
 * (off-thread) and the daemon's indexing shells out to a child process, so the
 * daemon's main thread mostly does fast, bounded work; the exception, a sync
 * storing into SQLite, is what the disk-progress deferral below is for. The
 * default timeout is ~300× the 5h #850 wedge shorter, yet far longer than any
 * legitimate main-thread block. Opt out with `CODEGRAPH_NO_WATCHDOG=1`; tune
 * with `CODEGRAPH_WATCHDOG_TIMEOUT_MS`.
 *
 * **Disk-progress deferral (`progressPaths`).** The CLI `index`/`init` path is
 * different: it runs the SQLite store on this thread, and one long synchronous
 * statement on severely degraded storage can block the loop past the timeout
 * with the process perfectly healthy (#1231: killed a valid index on a
 * 150-IOPS disk). Heartbeat silence alone cannot tell that apart from a wedge —
 * but the disk can: a wedged CPU loop makes no forward progress on the DB
 * files, while a slow store advances them. When the caller supplies
 * `progressPaths` (the SQLite DB + `-wal`), the child checks them at each
 * silent timeout: size/mtime advanced ⇒ defer the kill and keep watching;
 * unchanged ⇒ kill as before. Deferral is bounded by a hard cap
 * (`PROGRESS_CAP_MULTIPLIER` × timeout) of continuous silence, so a wedge
 * coinciding with unrelated file activity — or I/O hung beyond all reason —
 * still dies. A true wedge with no disk progress dies at the base timeout,
 * exactly as before.
 *
 * **Every index the process writes counts (#2404).** An MCP server syncs on
 * its main thread too, and not only the project it was armed for: the shared
 * daemon writes every project a session names by `projectPath`, and a proxy's
 * in-process fallback writes its own. {@link addWatchdogProgressPaths} adds a
 * project's index files the moment this process becomes its writer and drops
 * them when it lets go; each change re-arms the watchdog with a new child
 * whose argv carries the whole list. A new process gets its list the instant
 * it is spawned, whatever the parent does next: a message on the heartbeat
 * pipe could not promise that, since a pipe write queued behind one still in
 * flight waits for an event-loop turn, and a sync can block the loop right
 * after the project is added.
 */
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

/** Default: 60s — ~300× shorter than the 5h #850 wedge, far longer than any real main-thread block. */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 60_000;

/**
 * Hard cap on disk-progress deferral: after this many timeouts' worth of
 * CONTINUOUS heartbeat silence the process is killed even if the watched files
 * keep advancing (a wedge coinciding with unrelated file writes, or I/O hung
 * beyond any legitimate statement). 10× the 60s default ⇒ 10 minutes.
 */
export const PROGRESS_CAP_MULTIPLIER = 10;

/** `true` for `1/true/yes/on` (case-insensitive); `false` otherwise. */
function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The longest delay a Node timer holds: anything above 2^31-1 ms is run after
 * 1 ms instead (with a TimeoutOverflowWarning), so a huge value meant as
 * "effectively never" would fire at once (#1966).
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Parse the timeout env, falling back to the default for missing/invalid values
 * and capping at {@link MAX_TIMER_DELAY_MS}.
 */
export function parseWatchdogTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_WATCHDOG_TIMEOUT_MS
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMER_DELAY_MS) : fallback;
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
const capMs = Number(process.argv[3]);
const progressPaths = process.argv.slice(4);
const secs = Math.round(timeoutMs / 1000);
function kill(extra) {
  // Timestamped so daemon.log kills can be correlated with anything (#1431) —
  // computed here at kill time; this child process is never the wedged one.
  try { fs.writeSync(2, Buffer.from('[' + new Date().toISOString() + '] [CodeGraph] Main thread unresponsive for ~' + secs + 's' + (extra || '') + ' — killing the wedged process so a fresh one can start (#850). Disable with CODEGRAPH_NO_WATCHDOG=1.\\n')); } catch (e) {}
  try { process.kill(parentPid, 'SIGKILL'); } catch (e) {}
  process.exit(0);
}
// Fingerprint of the watched files (size + mtime). A change between checks is
// forward disk progress — a slow synchronous SQLite statement, not a wedge.
function snap() {
  let s = '';
  for (const p of progressPaths) {
    try { const st = fs.statSync(p); s += st.size + ':' + st.mtimeMs + ';'; } catch (e) { s += 'x;'; }
  }
  return s;
}
let lastSnap = progressPaths.length ? snap() : '';
let lastSnapAt = Date.now();
let silentSince = null; // start of the current continuous-silence episode
function onTimeout() {
  if (!progressPaths.length) return kill('');
  const now = Date.now();
  if (silentSince === null) silentSince = now - timeoutMs; // silence began ~one timeout ago
  const cur = snap();
  if (cur !== lastSnap && now - silentSince < capMs) {
    // The event loop is blocked but the DB files are advancing: a legitimate
    // long store on slow storage. Defer, re-baseline, keep watching.
    lastSnap = cur;
    timer = setTimeout(onTimeout, timeoutMs);
    return;
  }
  kill(cur !== lastSnap ? ' despite ongoing disk activity (hard cap ' + Math.round(capMs / 1000) + 's reached)' : '');
}
let timer = setTimeout(onTimeout, timeoutMs);
process.stdin.on('data', () => {
  silentSince = null;
  // Keep the baseline fresh while healthy (throttled — a stat per second).
  if (progressPaths.length) {
    const t = Date.now();
    if (t - lastSnapAt >= 1000) { lastSnap = snap(); lastSnapAt = t; }
  }
  clearTimeout(timer); timer = setTimeout(onTimeout, timeoutMs);
});
process.stdin.on('end', () => process.exit(0));   // parent closed the pipe (exited) -> no orphan
process.stdin.on('error', () => process.exit(0)); // pipe broke -> parent gone
process.stdin.resume();
`;

export interface WatchdogOptions {
  /**
   * Files whose size/mtime advancing counts as forward progress (the SQLite
   * DB + `-wal` for an in-process indexer). With paths supplied, a silent
   * timeout only kills when the files did NOT advance — see the header. The
   * files of other indexes the process comes to write join at runtime through
   * {@link addWatchdogProgressPaths}; with neither, a silent timeout kills.
   */
  progressPaths?: string[];
}

/**
 * Files added with {@link addWatchdogProgressPaths} and not yet dropped, with
 * how many registrations hold each.
 */
const addedProgressPaths = new Map<string, number>();

/**
 * Tells each armed watchdog the list of files changed: `added` when a file
 * joined it, false when files only left it.
 */
const armedWatchdogs = new Set<(added: boolean) => void>();

/**
 * Count `paths` advancing as forward progress for this process's liveness
 * watchdog, armed now or later, until the returned function is called
 * (#2404). For the index files of a project this process has just become the
 * writer of: its syncs store on the main thread, and without this a long one
 * reads as a wedge whenever the project is not the one the watchdog was armed
 * for. Registrations of one file nest, and the returned function is
 * idempotent.
 */
export function addWatchdogProgressPaths(paths: readonly string[]): () => void {
  let added = false;
  for (const file of paths) {
    const held = addedProgressPaths.get(file) ?? 0;
    addedProgressPaths.set(file, held + 1);
    if (held === 0) added = true;
  }
  if (added) for (const changed of armedWatchdogs) changed(true);
  let dropped = false;
  return () => {
    if (dropped) return;
    dropped = true;
    let removed = false;
    for (const file of paths) {
      const held = addedProgressPaths.get(file) ?? 0;
      if (held > 1) {
        addedProgressPaths.set(file, held - 1);
      } else if (held === 1) {
        addedProgressPaths.delete(file);
        removed = true;
      }
    }
    if (removed) for (const changed of armedWatchdogs) changed(false);
  };
}

/** One watchdog child process, watching a fixed list of files. */
interface WatchdogChild {
  paths: readonly string[];
  /** Write one heartbeat byte. */
  beat(): void;
  /** End the child: EOF, then a kill for good measure. */
  stop(): void;
}

/** Spawn a watchdog child for `paths`, or null when it can't be spawned. */
function spawnWatchdogChild(timeoutMs: number, checkMs: number, capMs: number, paths: readonly string[]): WatchdogChild | null {
  let child: ChildProcess;
  try {
    // No execArgv inheritance (unlike Worker), so the child carries none of our
    // V8 flags — it runs no WASM and needs none. stderr inherits the parent's
    // fd 2 so the kill notice lands wherever the parent logs (daemon.log).
    child = spawn(
      process.execPath,
      ['-e', CHILD_SOURCE, String(process.pid), String(timeoutMs), String(capMs), ...paths],
      {
        stdio: ['pipe', 'ignore', 'inherit'],
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

  const stdin = child.stdin;
  if (!stdin) {
    debug('child has no stdin pipe; not arming');
    try { child.kill(); } catch { /* ignore */ }
    return null;
  }
  // Writing after the child exits surfaces EPIPE on the stream — swallow it so
  // it can't escalate to the global handler (which now exits, #850).
  stdin.on('error', () => { /* child gone; heartbeat writes are best-effort */ });
  child.on('error', (err) => debug(`child error: ${err.message}`));

  // Neither the child nor its pipe should keep the parent alive past its work.
  child.unref();
  try { (stdin as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

  debug(`armed (child pid ${child.pid ?? '?'}): timeoutMs=${timeoutMs} checkMs=${checkMs} progressPaths=${paths.length}`);

  return {
    paths,
    beat(): void {
      try { stdin.write('\n'); } catch { /* child gone */ }
    },
    stop(): void {
      try { stdin.end(); } catch { /* ignore */ } // EOF -> child exits cleanly
      try { child.kill(); } catch { /* ignore */ } // belt-and-suspenders
    },
  };
}

/**
 * Install the main-thread liveness watchdog for a long-lived process. Returns a
 * handle to stop it, or `null` when disabled or when the child can't be spawned
 * (degraded, never throws — a missing watchdog must never keep a process from
 * starting).
 */
export function installMainThreadWatchdog(options: WatchdogOptions = {}): WatchdogHandle | null {
  if (isEnvTruthy(process.env.CODEGRAPH_NO_WATCHDOG)) return null;

  const timeoutMs = parseWatchdogTimeoutMs(process.env.CODEGRAPH_WATCHDOG_TIMEOUT_MS);
  const checkMs = deriveCheckIntervalMs(timeoutMs);
  const capMs = timeoutMs * PROGRESS_CAP_MULTIPLIER;
  const armedPaths = options.progressPaths ?? [];
  const watchedPaths = (): string[] => [...new Set([...armedPaths, ...addedProgressPaths.keys()])];

  let current = spawnWatchdogChild(timeoutMs, checkMs, capMs, watchedPaths());
  if (!current) return null;

  // Heartbeat: a byte per tick. When the main thread wedges, these stop and the
  // child's timeout fires. unref'd so it never keeps the process alive itself.
  const heartbeat = setInterval(() => current?.beat(), checkMs);
  heartbeat.unref();

  // The list of files changed (#2404): a child for the new list takes over,
  // then the old one goes. Always from a turning event loop, so the old child,
  // its last heartbeat recent, has no reason to kill meanwhile; a spawn that
  // fails leaves it watching the old list. An added file takes effect at once,
  // since a sync may block the loop right after. Dropped files wait for the
  // next turn, so a process letting go of several projects, as one does on its
  // way out, re-arms once or not at all.
  let pendingRearm: NodeJS.Timeout | null = null;
  const rearm = (): void => {
    if (pendingRearm) clearTimeout(pendingRearm);
    pendingRearm = null;
    if (!current) return;
    const paths = watchedPaths();
    if (paths.length === current.paths.length && paths.every((p) => current!.paths.includes(p))) return;
    const next = spawnWatchdogChild(timeoutMs, checkMs, capMs, paths);
    if (!next) return;
    const previous = current;
    current = next;
    previous.stop();
  };
  const changed = (added: boolean): void => {
    if (added) {
      rearm();
    } else if (!pendingRearm) {
      pendingRearm = setTimeout(rearm, 0);
      pendingRearm.unref();
    }
  };
  armedWatchdogs.add(changed);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      armedWatchdogs.delete(changed);
      if (pendingRearm) clearTimeout(pendingRearm);
      pendingRearm = null;
      clearInterval(heartbeat);
      current?.stop();
      current = null;
    },
  };
}
