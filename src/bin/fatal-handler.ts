/**
 * Last-resort handlers for uncaught exceptions and unhandled rejections.
 *
 * Reaching one of these means a fault escaped every boundary (per-request
 * try/catch in the MCP transport, the file watcher's own `'error'` handlers,
 * telemetry's fail-silent contract) — i.e. the process is in an undefined
 * state. Node's default in that case is to print and exit non-zero. The CLI
 * previously OVERRODE that to "log the error and keep running", which is the
 * bug behind two production incidents:
 *
 *   - #799 — a stdin socket `'error'` escalated here; the server logged it and
 *     kept running, orphaning the detached MCP daemon and (on Linux) spinning a
 *     POLLHUP fd at 100% CPU. Fixed for that one trigger by treating stdin
 *     failure as shutdown (`src/mcp/stdin-teardown.ts`).
 *   - #850 — a *different* uncaught exception hit the same handler. Logging it
 *     forced V8 to lazily format the Error's `.stack`, which entered a
 *     non-terminating source-position walk and pinned a core. Because the
 *     handler kept the process alive, the detached daemon was left wedged: its
 *     PPID watchdog and idle-timer (both `setInterval`s) could no longer fire,
 *     and nothing respawned it — unrecoverable without a manual `kill`.
 *
 * The fix restores the safe default: log a BOUNDED, hang-proof line, then exit
 * non-zero so a fresh daemon starts on the next connection.
 *
 * Two properties are load-bearing and covered by tests:
 *   1. {@link describeFatal} never reads `error.stack` and never hands the raw
 *      Error to `console.*`. The lazy stack getter is exactly the step that can
 *      wedge (#850); since it would run *inside* this handler, touching it could
 *      block the very `exit()` below. Name + message are plain string
 *      properties and are always safe.
 *   2. We write synchronously to fd 2 and then exit, so the message is flushed
 *      even though `process.exit()` doesn't drain async streams.
 */
import * as fs from 'fs';

/**
 * Render an uncaught value for the last-resort log WITHOUT triggering stack
 * formatting. Pure and total — never throws, never touches `.stack`.
 */
export function describeFatal(value: unknown): string {
  if (value instanceof Error) {
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error';
    // `message` is a plain own/proto string property — reading it does NOT
    // format the stack (which is what can loop forever, #850).
    const message = typeof value.message === 'string' ? value.message : '';
    return message ? `${name}: ${message}` : name;
  }
  try {
    return String(value);
  } catch {
    // e.g. an object with a throwing `toString` / `Symbol.toPrimitive`.
    return '<unstringifiable value>';
  }
}

/** Best-effort synchronous stderr write that can never keep a doomed process alive. */
function writeStderr(line: string): void {
  try {
    fs.writeSync(2, line);
  } catch {
    /* stderr closed/gone — nothing more we can safely do */
  }
}

/** Injectable seams so the wiring is testable without registering real handlers. */
export interface FatalHandlerDeps {
  /** Event target to attach to. Defaults to `process`. */
  target?: NodeJS.EventEmitter;
  /** How to terminate. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** How to emit the bounded line. Defaults to a synchronous fd-2 write. */
  write?: (line: string) => void;
}

/**
 * Install the uncaught-exception / unhandled-rejection handlers. Both log a
 * bounded line and then exit non-zero (Node's default fatal semantics).
 */
export function installFatalHandlers(deps: FatalHandlerDeps = {}): void {
  const target = deps.target ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const write = deps.write ?? writeStderr;

  target.on('uncaughtException', (error: unknown) => {
    write(`[CodeGraph] Uncaught exception: ${describeFatal(error)}\n`);
    exit(1);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    write(`[CodeGraph] Unhandled rejection: ${describeFatal(reason)}\n`);
    exit(1);
  });
}
