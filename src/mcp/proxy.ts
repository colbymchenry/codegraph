/**
 * MCP proxy mode — issue #411.
 *
 * The proxy is a near-transparent stdio↔socket pipe. Once it has verified
 * the daemon's hello line (same major.minor.patch as ours), it does no
 * protocol parsing of its own: every byte the MCP host writes to the proxy's
 * stdin goes straight to the daemon socket, and every byte the daemon emits
 * goes straight to the host's stdout. Server-initiated JSON-RPC requests
 * (e.g. `roots/list`) flow through the same pipe transparently.
 *
 * Lifecycle expectations:
 *   - The proxy exits when *either* stream closes (host stdin closed →
 *     daemon socket end, or daemon-side socket close → host stdout end).
 *   - Closing the socket on the proxy side is what tells the daemon to
 *     decrement its connected-clients refcount.
 *   - On a parent-process death we can't detect via stdin close (e.g. SIGKILL
 *     of the MCP host), the proxy's PPID watchdog catches it — same logic
 *     the direct-mode server uses; see issue #277.
 */

import * as fs from 'fs';
import * as net from 'net';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';
import { DaemonClientHello, DaemonHello, MAX_HELLO_LINE_BYTES } from './daemon';
import { supervisionLostReason } from './ppid-watchdog';
import { CodeGraphPackageVersion } from './version';
import { SERVER_INFO, PROTOCOL_VERSION } from './session';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { getStaticTools } from './tools';
import type { MCPEngine } from './engine';

/** Default poll cadence for the PPID watchdog (same as the direct server). */
const DEFAULT_PPID_POLL_MS = 5000;

export interface ProxyResult {
  /**
   * `proxied` — successfully attached to a same-version daemon and piped
   * stdio. The proxy stays alive until either end closes.
   * `fallback-needed` — the daemon rejected us (version mismatch / unreachable
   * socket) and the caller should run the server in direct mode.
   */
  outcome: 'proxied' | 'fallback-needed';
  reason?: string;
}

/**
 * Attempt to connect to the daemon at `socketPath` and pipe stdio through it.
 *
 * Returns a promise that resolves when either:
 *   - the connection succeeded and one of stdin/socket has now closed
 *     (after which the process should exit), or
 *   - the connection failed early enough that the caller can still fall
 *     back to direct mode.
 *
 * The `expectedVersion` param defaults to the package's own version — daemon
 * and proxy MUST match exactly. Mismatch resolves with
 * `outcome: 'fallback-needed'` so the caller can transparently start its own
 * server. (We accept the cost of two concurrent servers in this case as the
 * price of never silently running a stale daemon against newer client code.)
 */
export async function runProxy(
  socketPath: string,
  expectedVersion: string = CodeGraphPackageVersion,
): Promise<ProxyResult> {
  // POSIX: refuse to connect to a stale socket file that points at no
  // listening process. `fs.existsSync` is a cheap pre-check; a real
  // ECONNREFUSED below catches the rare "exists but unbound" race.
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
    return { outcome: 'fallback-needed', reason: 'socket file missing' };
  }

  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');

  const hello = await readHelloLine(socket).catch((err) => {
    socket.destroy();
    return new Error(String(err));
  });
  if (hello instanceof Error) {
    return { outcome: 'fallback-needed', reason: hello.message };
  }

  if (hello.codegraph !== expectedVersion) {
    process.stderr.write(
      `[CodeGraph MCP] Found a daemon on ${socketPath} but version (${hello.codegraph}) ` +
      `differs from ours (${expectedVersion}); falling back to direct mode.\n`
    );
    socket.destroy();
    return { outcome: 'fallback-needed', reason: 'version mismatch' };
  }

  process.stderr.write(
    `[CodeGraph MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.codegraph}).\n`
  );

  sendClientHello(socket);
  startPpidWatchdog(socket);
  await pipeUntilClose(socket);
  // Host disconnected (or the daemon went away). The proxy's only job is the
  // pipe; exit now so we don't linger — process.stdin's 'data' listener would
  // otherwise keep the event loop alive and leave a zombie launcher behind.
  process.exit(0);
}

/**
 * Connect to a daemon at `socketPath` and verify its hello (exact version match).
 * Returns the live socket (hello already consumed) or null if unreachable / stale
 * / version-mismatched. Unlike {@link runProxy} it does NOT pipe — the caller
 * owns the socket. Used by the local-handshake proxy's background connect.
 */
export async function connectWithHello(
  socketPath: string,
  expectedVersion: string = CodeGraphPackageVersion,
): Promise<net.Socket | 'version-mismatch' | null> {
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return null;
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  const hello = await readHelloLine(socket).catch(() => null);
  if (!hello) {
    socket.destroy();
    return null; // no daemon yet — caller should keep polling
  }
  if (hello.codegraph !== expectedVersion) {
    // A daemon IS up but it's the wrong version — definitive, not a "not yet".
    // Don't poll; the caller serves in-process so we never run stale-vs-new.
    process.stderr.write(
      `[CodeGraph MCP] Found a daemon on ${socketPath} but version (${hello.codegraph}) ` +
      `differs from ours (${expectedVersion}); serving this session in-process.\n`
    );
    socket.destroy();
    return 'version-mismatch';
  }
  process.stderr.write(
    `[CodeGraph MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.codegraph}).\n`
  );
  sendClientHello(socket);
  return socket;
}

/**
 * Tell the daemon our pids right after we verify its hello, so its liveness
 * sweep can reap this client if our process dies without the socket ever
 * signalling close (the Windows named-pipe hazard behind #692). Best-effort:
 * sent before any piped bytes so it's always the daemon's first line from us,
 * and a write failure here is harmless (the daemon just falls back to the
 * socket-close lifecycle). `hostPid` mirrors the PPID watchdog: the threaded
 * host pid if set, else our own parent (the host, on a no-relaunch bundle).
 */
function sendClientHello(socket: net.Socket): void {
  const clientHello: DaemonClientHello = {
    codegraph_client: 1,
    pid: process.pid,
    hostPid: parseHostPpid(process.env[HOST_PPID_ENV]) ?? process.ppid,
  };
  try { socket.write(JSON.stringify(clientHello) + '\n'); } catch { /* best-effort */ }
}

type JsonRpc = Record<string, unknown>;

/** Dependencies the local-handshake proxy needs, injected by MCPServer (which
 *  owns the daemon-spawn machinery and the engine factory). */
export interface LocalHandshakeDeps {
  /** Probe → spawn → retry → hello-verify; resolves a connected daemon socket,
   *  or null when the daemon path is genuinely unavailable (→ in-process fallback). */
  getDaemonSocket(): Promise<net.Socket | null>;
  /** Lazily create an in-process engine — used ONLY if the daemon never comes up,
   *  preserving the "a broken daemon never wedges a session" guarantee. */
  makeEngine(): MCPEngine;
  /** Project root for the fallback engine's lazy init. */
  root: string;
}

/**
 * Local-handshake proxy (the cold-start fix).
 *
 * Answers `initialize` + `tools/list` from STATIC constants the instant the
 * client asks — tools register in ~process-startup time instead of waiting
 * ~600ms for the daemon to spawn+bind, which is what produced the "No such tool
 * available" race that made headless agents flail into grep/Read. Tool CALLS are
 * forwarded to the shared daemon (connected in the background); the daemon's
 * response to the forwarded `initialize` is suppressed (the client already got
 * the local one). If the daemon never comes up (version mismatch / spawn fail),
 * a lazily-created in-process engine serves the calls — so the handshake speedup
 * never costs the old fall-back-to-direct robustness.
 */
export async function runLocalHandshakeProxy(deps: LocalHandshakeDeps): Promise<void> {
  let daemonStatus: 'connecting' | 'ready' | 'failed' = 'connecting';
  let daemonSocket: net.Socket | null = null;
  let clientInitId: unknown = undefined;   // suppress the daemon's reply to the forwarded initialize
  const pending: string[] = [];            // client lines buffered until the daemon resolves
  let engine: MCPEngine | null = null;
  let engineReady: Promise<void> | null = null;
  let shuttingDown = false;

  const writeClient = (obj: JsonRpc | string): void => {
    try { process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); } catch { /* host gone */ }
  };
  const shutdown = (): void => {
    if (shuttingDown) return; shuttingDown = true;
    try { daemonSocket?.destroy(); } catch { /* ignore */ }
    try { engine?.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  const ensureEngine = (): Promise<void> => {
    if (!engine) engine = deps.makeEngine();
    if (!engineReady) engineReady = engine.ensureInitialized(deps.root).catch(() => { /* degraded */ });
    return engineReady;
  };
  // Daemon-unavailable fallback: serve a client message in-process.
  const handleLocally = async (line: string): Promise<void> => {
    let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { return; }
    const id = msg.id;
    if (msg.method === 'tools/call' && id !== undefined) {
      try {
        await ensureEngine();
        const params = (msg.params || {}) as { name: string; arguments?: Record<string, unknown> };
        const result = await engine!.getToolHandler().execute(params.name, params.arguments || {});
        writeClient({ jsonrpc: '2.0', id, result });
      } catch (err) {
        writeClient({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    } else if (msg.method === 'ping' && id !== undefined) {
      writeClient({ jsonrpc: '2.0', id, result: {} });
    }
    // initialize already answered locally; notifications (initialized) need no reply.
  };
  const routeToDaemon = (line: string): void => {
    if (daemonStatus === 'ready' && daemonSocket) {
      try { daemonSocket.write(line.endsWith('\n') ? line : line + '\n'); } catch { /* close path */ }
    } else if (daemonStatus === 'failed') {
      void handleLocally(line);
    } else {
      pending.push(line);
    }
  };

  // ---- client (stdin) ----
  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { routeToDaemon(line); continue; }
      if (msg.method === 'initialize') {
        clientInitId = msg.id;
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS } });
        routeToDaemon(line); // prime the daemon so it resolves the project (its reply is suppressed below)
      } else if (msg.method === 'tools/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { tools: getStaticTools() } });
      } else if (msg.method === 'resources/list') {
        // No resources exposed — answer the probe locally so it never reaches
        // the daemon as an unhandled method and logs `-32601`. (#621)
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } });
      } else if (msg.method === 'resources/templates/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [] } });
      } else if (msg.method === 'prompts/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
      } else {
        routeToDaemon(line);
      }
    }
  });
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  startPpidWatchdogNoSocket(shutdown);

  // ---- daemon connection (background) ----
  let socket: net.Socket | null = null;
  try { socket = await deps.getDaemonSocket(); } catch { socket = null; }

  if (socket && !shuttingDown) {
    daemonSocket = socket;
    daemonStatus = 'ready';
    let sockBuf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      sockBuf += chunk;
      let idx: number;
      while ((idx = sockBuf.indexOf('\n')) !== -1) {
        const line = sockBuf.slice(0, idx);
        sockBuf = sockBuf.slice(idx + 1);
        if (!line.trim()) continue;
        if (clientInitId !== undefined) {
          try { const m = JSON.parse(line) as JsonRpc; if (m.id === clientInitId && ('result' in m || 'error' in m)) continue; } catch { /* relay */ }
        }
        writeClient(line);
      }
    });
    socket.on('close', shutdown);
    socket.on('error', shutdown);
    for (const line of pending) { try { socket.write(line + '\n'); } catch { /* ignore */ } }
    pending.length = 0;
  } else if (!shuttingDown) {
    daemonStatus = 'failed';
    process.stderr.write('[CodeGraph MCP] Shared daemon unavailable; serving this session in-process (degraded).\n');
    const buffered = pending.splice(0);
    for (const line of buffered) await handleLocally(line);
  }

  await new Promise<void>(() => { /* stdin keeps the loop alive; exit via shutdown() */ });
}

/** PPID watchdog for the local-handshake proxy — same #277 logic as
 *  {@link startPpidWatchdog} but with no socket to close (the caller's shutdown
 *  handles teardown). */
function startPpidWatchdogNoSocket(onDeath: () => void): void {
  const pollMs = parsePollMs(process.env.CODEGRAPH_PPID_POLL_MS);
  if (pollMs <= 0) return;
  const originalPpid = process.ppid;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const timer = setInterval(() => {
    const reason = supervisionLostReason({
      originalPpid,
      currentPpid: process.ppid,
      hostPpid,
      isAlive: isProcessAliveLocal,
    });
    if (reason) {
      process.stderr.write(`[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`);
      onDeath();
    }
  }, pollMs);
  timer.unref?.();
}

/**
 * Read one CRLF/LF-terminated JSON line from the socket, parse it as the
 * daemon hello, and return it. Bounded to {@link MAX_HELLO_LINE_BYTES} so a
 * malicious or broken peer can't OOM us. Times out at 3s — a healthy daemon
 * sends hello immediately on accept.
 */
function readHelloLine(socket: net.Socket): Promise<DaemonHello> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
    };
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) {
        if (buffer.length > MAX_HELLO_LINE_BYTES) {
          cleanup();
          reject(new Error('daemon hello line exceeded size limit'));
        }
        return;
      }
      const line = buffer.slice(0, idx);
      // Re-emit anything past the newline so the pipe-stage sees it.
      const tail = buffer.slice(idx + 1);
      cleanup();
      if (tail.length > 0) {
        // Push back via unshift — Node's net.Socket supports it on readable streams.
        socket.unshift(tail);
      }
      try {
        const parsed = JSON.parse(line) as DaemonHello;
        if (typeof parsed.codegraph !== 'string' || typeof parsed.pid !== 'number') {
          reject(new Error('daemon hello missing required fields'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`daemon hello not JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('daemon closed connection before hello')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for daemon hello'));
    }, 3000);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Pipe stdin → socket and socket → stdout. Resolves once either end closes
 * so the process can exit. Note: we deliberately do NOT use
 * `process.stdin.pipe(socket)` because pipe propagates 'end' onto the
 * downstream, which would close the socket prematurely if stdin happens to
 * end early — the MCP spec allows it to stay open across reconnects.
 */
function pipeUntilClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    process.stdin.on('data', (chunk) => {
      try { socket.write(chunk); } catch { /* socket may have errored — close path catches it */ }
    });
    process.stdin.on('end', () => {
      try { socket.end(); } catch { /* ignore */ }
      done();
    });
    process.stdin.on('close', () => {
      try { socket.destroy(); } catch { /* ignore */ }
      done();
    });

    socket.on('data', (chunk) => {
      try { process.stdout.write(chunk); } catch { /* ignore */ }
    });
    socket.on('end', () => done());
    socket.on('close', () => done());
    socket.on('error', (err) => {
      process.stderr.write(`[CodeGraph MCP] daemon socket error: ${err.message}\n`);
      done();
    });
  });
}

/**
 * PPID watchdog mirroring the one in `MCPServer.start` — kills the proxy if
 * the MCP host (or its proxy of a host, see HOST_PPID_ENV) goes away without
 * closing stdin. Issue #277 documents why we can't rely on stdin EOF on
 * Linux: the parent may be SIGKILL'd and reparenting doesn't close pipes.
 *
 * The proxy's "kill" is just a socket close + process.exit — no SQLite or
 * watchers to clean up, so this is cheap.
 */
function startPpidWatchdog(socket: net.Socket): void {
  const pollMs = parsePollMs(process.env.CODEGRAPH_PPID_POLL_MS);
  if (pollMs <= 0) return;
  const originalPpid = process.ppid;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const timer = setInterval(() => {
    const reason = supervisionLostReason({
      originalPpid,
      currentPpid: process.ppid,
      hostPpid,
      isAlive: isProcessAliveLocal,
    });
    if (reason) {
      process.stderr.write(`[CodeGraph MCP] Parent process exited (${reason}); shutting down.\n`);
      try { socket.destroy(); } catch { /* ignore */ }
      process.exit(0);
    }
  }, pollMs);
  timer.unref?.();
}

function parsePollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PPID_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PPID_POLL_MS;
  if (parsed < 0) return DEFAULT_PPID_POLL_MS;
  return Math.floor(parsed);
}

function parseHostPpid(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  return parsed;
}

function isProcessAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}
