/**
 * The Claude Code prompt hook's line to the project's running daemon (#3284).
 *
 * The hook is a new process on every prompt, so an explore it runs itself
 * starts cold: it reads the name lists, the name index and the dominant file
 * again each time, seconds on a large index. The daemon an MCP session keeps
 * running for the project already holds all of that, and answers the same
 * explore several times sooner. This asks it, and says so when it can't.
 *
 * It only ever uses a daemon that is already up. Starting one takes the
 * project's writer lock and a file watcher, which no prompt should cost.
 *
 * And only one that proves it runs as this user (`./daemon-proof`), since the
 * prompt goes to whoever listens and their answer into the agent's context.
 * The connection is made here rather than through `./proxy`, which would load
 * the MCP server's tool layer on every prompt the daemon answers.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { daemonOptOutSet, getDaemonSocketCandidates } from './daemon-paths';
import { daemonProofMatches, newDaemonChallenge, readDaemonKey } from './daemon-proof';
import { PROMPT_EXPLORE_METHOD } from './prompt-explore';
import { CodeGraphPackageVersion } from './version';

/**
 * - `answered`: the daemon's explore, ready to inject.
 * - `unavailable`: nothing asked the daemon to explore, or it could not: no
 *   daemon, another version, one that predates the request, an error, or one
 *   that said it could not start the explore at once (busy catching up,
 *   serving other calls, or on its way out). The caller's own explore is as
 *   good as it ever was.
 * - `timed-out`: the daemon is exploring and has not answered by the deadline.
 *   A second explore in the caller would only add load to a machine already
 *   too slow to answer in time.
 */
export type DaemonExplore =
  | { status: 'answered'; text: string }
  | { status: 'unavailable' }
  | { status: 'timed-out' };

/** How long the hook waits for the daemon before it injects nothing. */
const DEFAULT_PROMPT_HOOK_DAEMON_TIMEOUT_MS = 15_000;

/** The wait, from `CODEGRAPH_PROMPT_HOOK_DAEMON_TIMEOUT_MS` when that is a positive number. */
export function promptHookDaemonTimeoutMs(): number {
  const n = Number(process.env.CODEGRAPH_PROMPT_HOOK_DAEMON_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROMPT_HOOK_DAEMON_TIMEOUT_MS;
}

const UNAVAILABLE: DaemonExplore = { status: 'unavailable' };

/**
 * Whether the socket at `socketPath` is one this user's daemon bound. The
 * prompt goes to whoever listens there and their answer goes into the agent's
 * context, and one candidate is in the system temp directory, which every user
 * of the machine can write to on Linux. `lstat`, so a link left at the path is
 * refused however it resolves. A Windows named pipe has no owner to read here.
 *
 * The folder is checked too, because the socket is checked before it is
 * connected to: where others can write and no sticky bit keeps a file for its
 * owner to remove, they could put their own socket in its place in between.
 * The folder's owner can remove any file in it, so that is this user or root.
 */
function boundByThisUser(socketPath: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    const uid = process.getuid?.();
    const socket = fs.lstatSync(socketPath);
    const folder = fs.statSync(path.dirname(socketPath));
    const othersCanReplace = (folder.mode & 0o022) !== 0 && (folder.mode & 0o1000) === 0;
    return socket.isSocket() && socket.uid === uid && (folder.uid === uid || folder.uid === 0) && !othersCanReplace;
  } catch {
    return false;
  }
}

/**
 * How long the daemon gets for its hello and its proof together. A healthy
 * one sends both the moment it can; one that can't within a second is too
 * busy to beat the hook's own explore, so the hook runs that instead.
 */
const HANDSHAKE_TIMEOUT_MS = 1_000;

/** Longest hello or proof line; both are a few dozen bytes. */
const MAX_HANDSHAKE_CHARS = 4096;

/** Most the hook reads from the daemon for one answer, so a broken peer can't fill its memory. */
const MAX_ANSWER_CHARS = 8 * 1024 * 1024;

const REQUEST_ID = 1;

async function connectToDaemon(projectRoot: string): Promise<net.Socket | null> {
  for (const socketPath of getDaemonSocketCandidates(projectRoot)) {
    if (!boundByThisUser(socketPath)) continue;
    const socket = await connectProven(socketPath, HANDSHAKE_TIMEOUT_MS);
    if (socket) return socket;
  }
  return null;
}

/**
 * Connect to `socketPath` and keep the socket only when the daemon there runs
 * this version and proves it runs as this user: read its hello, send a
 * client-hello carrying a fresh challenge, and check the proof it answers
 * with (see `./daemon-proof`). Null otherwise, and then nothing but the
 * challenge was sent. On Windows, where a pipe's owner can't be read, this is
 * the whole check; on macOS and Linux it follows {@link boundByThisUser}.
 */
function connectProven(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    let socket: net.Socket;
    try {
      socket = net.createConnection(socketPath);
    } catch {
      resolve(null);
      return;
    }
    let buffer = '';
    let challenge: string | null = null;
    let settled = false;
    const finish = (proven: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (proven) {
        resolve(socket);
      } else {
        socket.destroy();
        resolve(null);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onData = (chunk: string | Buffer): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (buffer.length > MAX_HANDSHAKE_CHARS) return finish(false);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown> | null;
        try {
          message = JSON.parse(line);
        } catch {
          return finish(false);
        }
        if (!message || typeof message !== 'object') return finish(false);
        if (challenge === null) {
          // The daemon's hello. Another version gets no prompt: the hook explores itself.
          if (message.protocol !== 1 || message.codegraph !== CodeGraphPackageVersion) return finish(false);
          challenge = newDaemonChallenge();
          socket.write(JSON.stringify({ codegraph_client: 1, pid: process.pid, hostPid: null, challenge }) + '\n');
        } else {
          // Read after the proof arrives: a daemon answering the first challenge makes the key.
          const key = readDaemonKey();
          return finish(key !== null && daemonProofMatches(key, challenge, socketPath, message.codegraph_proof));
        }
      }
    };
    socket.setEncoding('utf8');
    // For the socket's whole life: an 'error' with no listener would throw.
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('data', onData);
  });
}

/**
 * Send the one request and read the line that answers it. Lines that answer
 * anything else are skipped. A daemon that could not start the explore at
 * once answers `{ busy: true }`, and that is `unavailable`: the hook explores
 * itself rather than wait, or inject a busy notice.
 */
function ask(socket: net.Socket, query: string): Promise<DaemonExplore> {
  return new Promise((resolve) => {
    let buffer = '';
    // For the socket's whole life: an 'error' with no listener would throw.
    socket.on('error', () => resolve(UNAVAILABLE));
    socket.on('close', () => resolve(UNAVAILABLE));
    socket.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (buffer.length > MAX_ANSWER_CHARS) return resolve(UNAVAILABLE);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: { id?: unknown; result?: { busy?: unknown; isError?: boolean; content?: Array<{ text?: unknown }> } };
        try {
          reply = JSON.parse(line);
        } catch {
          return resolve(UNAVAILABLE);
        }
        if (reply?.id !== REQUEST_ID) continue;
        const result = reply.result;
        if (!result || result.busy === true || result.isError) return resolve(UNAVAILABLE);
        const text = result.content?.[0]?.text;
        return resolve(typeof text === 'string' && text.trim() ? { status: 'answered', text } : UNAVAILABLE);
      }
    });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, method: PROMPT_EXPLORE_METHOD, params: { query } }) + '\n');
  });
}

/**
 * Ask the daemon running for `projectRoot` to explore `query`, waiting at most
 * `deadlineMs` for the connection and the answer together. Never throws.
 */
export async function exploreViaDaemon(projectRoot: string, query: string, deadlineMs: number): Promise<DaemonExplore> {
  if (daemonOptOutSet()) return UNAVAILABLE;
  let socket: net.Socket | null = null;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const asked = (async (): Promise<DaemonExplore> => {
    socket = await connectToDaemon(projectRoot);
    if (!socket) return UNAVAILABLE;
    // The deadline passed while this was still connecting.
    if (settled) { socket.destroy(); return UNAVAILABLE; }
    return ask(socket, query);
  })().catch(() => UNAVAILABLE);
  const deadline = new Promise<DaemonExplore>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), deadlineMs);
  });
  try {
    return await Promise.race([asked, deadline]);
  } finally {
    settled = true;
    clearTimeout(timer);
    (socket as net.Socket | null)?.destroy();
  }
}
