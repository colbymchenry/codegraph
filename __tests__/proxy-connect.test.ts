/**
 * Proxy connect resilience — issue #974.
 *
 * `connectWithHello` returns a live socket to the caller, which then attaches
 * its own onDaemonLost handler. Before #974, `readHelloLine` attached an
 * 'error' listener and REMOVED it on success, leaving a window where the socket
 * had no 'error' listener — and a socket 'error' with no listener is re-thrown
 * by Node as an uncaughtException, which the global fatal handler turns into
 * process.exit(1). To an MCP client that is a bare "Transport closed". The fix
 * keeps a guard 'error' listener attached for the socket's whole life.
 *
 * AF_UNIX over WSL2/DrvFs makes that window common; here we just prove the
 * invariant on a normal socket: the returned socket always has an 'error'
 * listener, and emitting an error on it never throws.
 *
 * The connect also has the daemon prove it runs as this user before any byte
 * of the session (#3284's proof, now the proxy's too): a stand-in another user
 * put where the daemon listens, which is a pipe name anyone can take first on
 * Windows, is `unproven` and gets nothing. See daemon-proof.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { connectWithHello } from '../src/mcp/proxy';
import { CodeGraphPackageVersion } from '../src/mcp/version';
import { startFakeDaemon, type FakeProof } from './fake-daemon';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

/** A socket path (a named pipe on Windows) no other test uses. */
function uniqueSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proxy-'));
  cleanups.push(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}-d` : path.join(dir, 'd.sock');
}

/** Stand up a fake daemon on its own path: a valid hello as `version`, and the proof `proof` says. */
async function fakeDaemon(version: string, proof: FakeProof = 'valid') {
  const daemon = await startFakeDaemon('', {
    socketPath: uniqueSocketPath(),
    version,
    proof,
    // Answers each request with its method, so a test can tell the session reached it.
    reply: (request) => ({ result: { echoed: request.method } }),
  });
  cleanups.push(() => daemon.close());
  return daemon;
}

describe('connectWithHello — socket is never left without an error listener (#974)', () => {
  it('returns a socket that has an error listener and never throws on error', async () => {
    const { socketPath } = await fakeDaemon(CodeGraphPackageVersion);
    const result = await connectWithHello(socketPath);
    expect(result).not.toBeNull();
    expect(typeof result).not.toBe('string');
    const socket = result as net.Socket;
    cleanups.push(() => { socket.destroy(); });
    // The invariant: a guard 'error' listener is attached for the socket's whole
    // life, so a stray socket error can't escalate to an uncaughtException.
    expect(socket.listenerCount('error')).toBeGreaterThanOrEqual(1);
    // Emitting an error must NOT throw. Without the guard this is exactly the
    // path that crashed the proxy with "Transport closed".
    expect(() => socket.emit('error', new Error('simulated ECONNRESET'))).not.toThrow();
  });

  it('still reports version-mismatch (and that path does not throw)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { socketPath, challenges } = await fakeDaemon('0.0.0-not-our-version');
    const result = await connectWithHello(socketPath);
    expect(result).toBe('version-mismatch');
    // Another version is told apart by its hello; it is never asked for a proof.
    expect(challenges).toEqual([]);
  });

  it('returns null when no daemon is listening', async () => {
    const result = await connectWithHello(uniqueSocketPath());
    expect(result).toBeNull();
  });
});

describe('connectWithHello — the daemon proves it runs as this user (#3284)', () => {
  it('hands over the session stream intact once the proof matches', async () => {
    const daemon = await fakeDaemon(CodeGraphPackageVersion);
    const socket = await connectWithHello(daemon.socketPath) as net.Socket;
    cleanups.push(() => { socket.destroy(); });
    expect(daemon.challenges).toHaveLength(1);

    // The proof line was read off the stream: the first line the session sees answers its request.
    const line = new Promise<string>((resolve) => {
      let buffer = '';
      socket.on('data', (chunk: string | Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline !== -1) resolve(buffer.slice(0, newline));
      });
    });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
    expect(JSON.parse(await line)).toEqual({ jsonrpc: '2.0', id: 7, result: { echoed: 'ping' } });
  });

  it.each([
    ['answers under another key, as a stand-in another user put there would', 'other-key'],
    ['answers with this user\'s proof for another path, relayed from elsewhere', 'other-path'],
    ['answers no challenge', 'none'],
  ] as const)('is unproven, and gets no session, when the daemon %s', async (_why, proof) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const daemon = await fakeDaemon(CodeGraphPackageVersion, proof);

    const result = await connectWithHello(daemon.socketPath, CodeGraphPackageVersion, 500);

    expect(result).toBe('unproven');
    expect(daemon.challenges).toHaveLength(1);
    expect(daemon.requests).toEqual([]);
    expect(stderr.mock.calls.some(([line]) => String(line).includes('could not prove it runs as this user'))).toBe(true);
  });
});
