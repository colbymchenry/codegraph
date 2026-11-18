/**
 * The daemon proves it runs as this user before the prompt hook sends it a
 * prompt (#3284).
 *
 * The hook sends the user's prompt to whoever listens where the project's
 * daemon does, and injects the answer into the agent's context. On Windows the
 * daemon's named pipe lives in a namespace every user can create in, and on
 * macOS and Linux one socket candidate sits in the shared temp folder; Node can
 * read neither a pipe's owner nor a socket peer's user. So the hook sends a
 * fresh challenge in its client-hello, and only a daemon holding this user's
 * key, which only this user can read, answers it with the right HMAC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import CodeGraph from '../src/index';
import { Daemon, parseClientHelloLine } from '../src/mcp/daemon';
import {
  daemonKey,
  daemonKeyPath,
  daemonProof,
  daemonProofMatches,
  newDaemonChallenge,
  readDaemonKey,
} from '../src/mcp/daemon-proof';
import { PROMPT_EXPLORE_METHOD } from '../src/mcp/prompt-explore';
import { exploreViaDaemon } from '../src/mcp/hook-client';
import { startFakeDaemon, type FakeProof } from './fake-daemon';

const posix = process.platform !== 'win32';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('the daemon key (#3284)', () => {
  it('lives in this user\'s ~/.codegraph', () => {
    expect(daemonKeyPath()).toBe(path.join(os.homedir(), '.codegraph', 'daemon.key'));
  });

  it('is made on first use, private, and the same key every time after', () => {
    const file = path.join(tempDir('cg-key-'), 'nested', 'daemon.key');
    expect(readDaemonKey(file)).toBeNull();

    const key = daemonKey(file);
    expect(key).not.toBeNull();
    expect(key!.length).toBeGreaterThanOrEqual(32);
    expect(daemonKey(file)!.equals(key!)).toBe(true);
    expect(readDaemonKey(file)!.equals(key!)).toBe(true);
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Nothing of the making is left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['daemon.key']);
  });

  it.runIf(posix)('is not used while others can read it, and the daemon replaces it with a private one', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    const leaked = daemonKey(file)!;
    fs.chmodSync(file, 0o644);

    expect(readDaemonKey(file)).toBeNull();
    const fresh = daemonKey(file)!;
    expect(fresh.equals(leaked)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDaemonKey(file)!.equals(fresh)).toBe(true);
  });

  it.runIf(posix)('is refused, and left alone, when another user owns it', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    const theirs = daemonKey(file)!;
    const mine = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(mine + 1);

    expect(readDaemonKey(file)).toBeNull();
    expect(daemonKey(file)).toBeNull();
    vi.restoreAllMocks();
    expect(readDaemonKey(file)!.equals(theirs)).toBe(true);
  });

  it.runIf(posix)('is never read through a link', () => {
    const dir = tempDir('cg-key-');
    const real = path.join(dir, 'real.key');
    daemonKey(real);
    const link = path.join(dir, 'daemon.key');
    fs.symlinkSync(real, link);

    expect(readDaemonKey(link)).toBeNull();
    expect(daemonKey(link)).toBeNull();
  });

  it('is replaced when the file is too short to be a key', () => {
    const file = path.join(tempDir('cg-key-'), 'daemon.key');
    fs.writeFileSync(file, 'short', { mode: 0o600 });

    expect(readDaemonKey(file)).toBeNull();
    const key = daemonKey(file)!;
    expect(key.length).toBeGreaterThanOrEqual(32);
  });
});

describe('a daemon proof (#3284)', () => {
  const key = randomBytes(32);
  const challenge = newDaemonChallenge();
  const where = '/project/.codegraph/daemon.sock';

  it('matches only its own key, challenge and path', () => {
    const proof = daemonProof(key, challenge, where);
    expect(daemonProofMatches(key, challenge, where, proof)).toBe(true);
    expect(daemonProofMatches(randomBytes(32), challenge, where, proof)).toBe(false);
    expect(daemonProofMatches(key, newDaemonChallenge(), where, proof)).toBe(false);
    expect(daemonProofMatches(key, challenge, '/tmp/codegraph-x.sock', proof)).toBe(false);
  });

  it('rejects anything that is not a proof', () => {
    for (const bad of [undefined, null, 42, '', 'zz', 'a'.repeat(64), daemonProof(key, challenge, where).toUpperCase(), daemonProof(key, challenge, where) + '0']) {
      expect(daemonProofMatches(key, challenge, where, bad)).toBe(false);
    }
  });

  it('gives a fresh challenge each time', () => {
    expect(newDaemonChallenge()).not.toBe(newDaemonChallenge());
  });

  it('rides the client-hello the daemon parses, which still parses without one', () => {
    const c = newDaemonChallenge();
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 7, hostPid: null, challenge: c })))
      .toEqual({ pid: 7, hostPid: null, challenge: c });
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":7,"hostPid":null}')).toEqual({ pid: 7, hostPid: null });
    // An oversized or non-string challenge is no challenge.
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 7, challenge: 'x'.repeat(300) }))).toEqual({ pid: 7, hostPid: null });
    expect(parseClientHelloLine(JSON.stringify({ codegraph_client: 1, pid: 7, challenge: 5 }))).toEqual({ pid: 7, hostPid: null });
  });
});

/** A socket or named-pipe path no other test uses. */
function uniqueSocketPath(): string {
  const id = randomBytes(6).toString('hex');
  return posix ? path.join(tempDir('cg-proofsock-'), `d-${id}.sock`) : `\\\\.\\pipe\\codegraph-prooftest-${id}`;
}

/** Read lines off `socket` as they come. */
function lineReader(socket: net.Socket): () => Promise<string> {
  let buffer = '';
  const waiting: Array<(line: string) => void> = [];
  const lines: string[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const next = waiting.shift();
      if (next) next(line); else lines.push(line);
    }
  });
  return () => new Promise((resolve, reject) => {
    const line = lines.shift();
    if (line !== undefined) return resolve(line);
    const timer = setTimeout(() => reject(new Error('no line within 5s')), 5_000);
    waiting.push((l) => { clearTimeout(timer); resolve(l); });
  });
}

describe('the daemon answers a challenge in its handshake (#3284)', () => {
  /** A real Daemon's connection handling, on a socket of its own. Opens no index. */
  async function daemonOn(socketPath: string): Promise<void> {
    const daemon = new Daemon(tempDir('cg-proofroot-'), { idleTimeoutMs: 0 }) as unknown as {
      socketPath: string;
      handleConnection(socket: net.Socket): void;
    };
    daemon.socketPath = socketPath;
    const accepted = new Set<net.Socket>();
    const server = net.createServer((socket) => { accepted.add(socket); daemon.handleConnection(socket); });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => {
      for (const socket of accepted) socket.destroy();
      server.close(() => resolve());
    }));
  }

  async function connect(socketPath: string): Promise<{ socket: net.Socket; next: () => Promise<string> }> {
    const socket = net.createConnection(socketPath);
    socket.on('error', () => { /* torn down at the end */ });
    cleanups.push(() => { socket.destroy(); });
    const next = lineReader(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    return { socket, next };
  }

  it('proves it holds this user\'s key, for the path it listens on, before the session starts', async () => {
    const socketPath = uniqueSocketPath();
    await daemonOn(socketPath);
    const { socket, next } = await connect(socketPath);

    const hello = JSON.parse(await next());
    expect(hello.protocol).toBe(1);
    const challenge = newDaemonChallenge();
    socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null, challenge }) + '\n');
    const { codegraph_proof: proof } = JSON.parse(await next());

    expect(daemonProofMatches(readDaemonKey()!, challenge, socketPath, proof)).toBe(true);
    // The session follows, as on any connection.
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) + '\n');
    expect(JSON.parse(await next())).toMatchObject({ id: 5, result: {} });
  });

  // The proxy's client-hello carries no challenge: its connection is as before.
  it('sends no proof line to a client-hello without a challenge', async () => {
    const socketPath = uniqueSocketPath();
    await daemonOn(socketPath);
    const { socket, next } = await connect(socketPath);

    await next(); // hello
    socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null }) + '\n');
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }) + '\n');

    expect(JSON.parse(await next())).toMatchObject({ id: 6, result: {} });
  });
});

/** An indexed project for the client to find a daemon for. */
async function indexedProject(): Promise<string> {
  const root = tempDir('cg-proofhook-');
  fs.writeFileSync(path.join(root, 'orders.ts'), 'export function placeOrder() { return 1; }\n');
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();
  return root;
}

describe('the hook sends a prompt only to a daemon that proves it runs as this user (#3284)', () => {
  const answer = () => ({ result: { content: [{ type: 'text', text: 'FROM THE DAEMON' }] } });

  async function daemonProving(proof: FakeProof) {
    const root = await indexedProject();
    const daemon = await startFakeDaemon(root, { proof, reply: answer });
    cleanups.push(() => daemon.close());
    return { root, daemon };
  }

  it('asks a daemon that proves it, with the prompt as the query', async () => {
    const { root, daemon } = await daemonProving('valid');

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'answered', text: 'FROM THE DAEMON' });
    expect(daemon.challenges).toHaveLength(1);
    expect(daemon.requests).toEqual([{ method: PROMPT_EXPLORE_METHOD, params: { query: 'how does placeOrder work' } }]);
  });

  it.each([
    ['answers under another key, as a stand-in another user put there would', 'other-key'],
    ['answers with this user\'s proof for another path, relayed from elsewhere', 'other-path'],
  ] as const)('sends no prompt to a daemon that %s', async (_why, proof) => {
    const { root, daemon } = await daemonProving(proof);

    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(daemon.challenges).toHaveLength(1);
    expect(daemon.requests).toEqual([]);
  });

  it('sends no prompt to a daemon that answers no challenge, and gives up on it within the handshake time', async () => {
    const { root, daemon } = await daemonProving('none');

    const started = Date.now();
    await expect(exploreViaDaemon(root, 'how does placeOrder work', 5_000)).resolves.toEqual({ status: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(daemon.requests).toEqual([]);
  });
});
