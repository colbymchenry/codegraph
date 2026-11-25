/**
 * A stand-in for a project's daemon, for the prompt hook's tests (#3284): a
 * real socket server (a named pipe on Windows) on the path the hook looks for,
 * speaking the daemon's handshake. It says hello, reads the client-hello, and
 * answers a client-hello's challenge with a proof line the way `proof` says:
 *   - `valid`: this user's key, this path, as the real daemon answers;
 *   - `other-key`: another key, as a stand-in another user put there would;
 *   - `other-path`: this user's key for another path, a proof relayed from
 *     this user's daemon listening elsewhere;
 *   - `none`: no proof line, as a daemon from before the proof.
 * Then it answers each request with what `reply` returns (merged into the
 * JSON-RPC response), or stays silent when that is undefined.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { getDaemonSocketCandidates } from '../src/mcp/daemon-paths';
import { daemonKey, daemonProof } from '../src/mcp/daemon-proof';
import { CodeGraphPackageVersion } from '../src/mcp/version';

export type FakeProof = 'valid' | 'other-key' | 'other-path' | 'none';

export interface FakeRequest {
  id?: unknown;
  method: string;
  params?: { query?: string };
}

/** A request as recorded: what the client asked, without its id. */
export interface RecordedRequest {
  method: string;
  params?: { query?: string };
}

export interface FakeDaemonOptions {
  /** Listen here instead of on the project's own daemon path. */
  socketPath?: string;
  version?: string;
  proof?: FakeProof;
  /** `{ result }` or `{ error }` for a request, or undefined to send nothing. */
  reply: (request: FakeRequest) => unknown | undefined;
  /** Whole messages to send ahead of each response, like a notification. */
  before?: unknown[];
}

export interface FakeDaemon {
  socketPath: string;
  /** Every request the client sent after the handshake. */
  requests: RecordedRequest[];
  /** The challenges client-hellos carried. */
  challenges: string[];
  close(): Promise<void>;
}

export async function startFakeDaemon(root: string, opts: FakeDaemonOptions): Promise<FakeDaemon> {
  const socketPath = opts.socketPath ?? getDaemonSocketCandidates(root)[0]!;
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const requests: RecordedRequest[] = [];
  const challenges: string[] = [];
  const sockets = new Set<net.Socket>();
  const proofFor = (challenge: string): string | null => {
    const mode = opts.proof ?? 'valid';
    if (mode === 'none') return null;
    if (mode === 'other-key') return daemonProof(randomBytes(32), challenge, socketPath);
    // A key this process can't read (a test faking another uid) proves nothing, as in the daemon.
    const key = daemonKey();
    return key ? daemonProof(key, challenge, mode === 'other-path' ? `${socketPath}-elsewhere` : socketPath) : null;
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* a client that hung up */ });
    socket.write(JSON.stringify({ codegraph: opts.version ?? CodeGraphPackageVersion, pid: process.pid, socketPath, protocol: 1 }) + '\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.codegraph_client) {
          if (typeof message.challenge === 'string') {
            challenges.push(message.challenge);
            const proof = proofFor(message.challenge);
            if (proof !== null) socket.write(JSON.stringify({ codegraph_proof: proof }) + '\n');
          }
          continue;
        }
        requests.push({ method: message.method, params: message.params });
        for (const extra of opts.before ?? []) socket.write(JSON.stringify(extra) + '\n');
        const body = opts.reply(message);
        if (body !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(body as object) }) + '\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    challenges,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
      if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
    }),
  };
}
