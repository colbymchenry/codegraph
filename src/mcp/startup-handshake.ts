/**
 * Never-initialized backstop for `serve --mcp` (#1185).
 *
 * Every real MCP host sends `initialize` immediately after spawning a server.
 * A server that has received NO bytes at all for many minutes is not serving
 * anyone — it is the residue of an abandoned launch: the host killed the
 * launcher chain during startup (config probe, instant cancel, initialize
 * timeout) but kept our stdio pipe fds open, so stdin never EOFs. If the kill
 * landed before {@link ../mcp/early-ppid} could observe the real parent, the
 * PPID watchdog is blind too (baseline `1`), and — pre-#1185 — the orphan
 * lived until the HOST process exited, accumulating one ~30MB node process
 * per occurrence.
 *
 * This backstop closes that last hole: arm a one-shot timer at serve start
 * and disarm it on the first byte of client traffic. If the timer fires, the
 * caller shuts the server down. The default is deliberately generous (15
 * minutes) — hosts initialize within milliseconds, so the only processes this
 * ever reaps are ones nobody is talking to. It never affects a session that
 * spoke even once: after the first byte the timer is gone for good (a
 * quiet-but-live session is the PPID watchdog's / stdin teardown's job).
 *
 * IMPORTANT (callers): attaching a `'data'` listener switches the stream into
 * flowing mode. Arm this AFTER the real stdin consumer is attached, in the
 * same synchronous block, so no early bytes are emitted while only our
 * listener exists. The detached daemon must never arm this — its stdin is
 * `'ignore'` and its lifecycle is refcount/idle-based.
 *
 * Tune with `CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS`; `0` disables.
 */

/** Default wait for the first byte of MCP traffic before assuming orphaned. */
export const DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS = 900_000; // 15 min

export const STARTUP_HANDSHAKE_TIMEOUT_ENV = 'CODEGRAPH_STARTUP_HANDSHAKE_TIMEOUT_MS';

/**
 * Parse the timeout env override. Missing/invalid → default; `<= 0` → `0`
 * (disabled), the same disable convention as `CODEGRAPH_PPID_POLL_MS`.
 */
export function parseStartupHandshakeTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS;
  if (parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Arm the backstop. `onAbandoned` runs at most once, only if no `'data'` event
 * arrives on `stream` within the timeout. Returns a disarm function (idempotent;
 * also detaches the listener). `stream`/`timeoutMs` are injectable for tests.
 */
export function armStartupHandshakeTimeout(
  onAbandoned: () => void,
  stream: NodeJS.ReadableStream = process.stdin,
  timeoutMs: number = parseStartupHandshakeTimeoutMs(process.env[STARTUP_HANDSHAKE_TIMEOUT_ENV]),
): () => void {
  if (timeoutMs <= 0) return () => { /* disabled */ };
  const onFirstData = (): void => { clearTimeout(timer); };
  const timer = setTimeout(() => {
    stream.removeListener('data', onFirstData);
    onAbandoned();
  }, timeoutMs);
  // Never let the backstop itself keep an otherwise-finished process alive.
  timer.unref?.();
  stream.once('data', onFirstData);
  return (): void => {
    stream.removeListener('data', onFirstData);
    clearTimeout(timer);
  };
}
