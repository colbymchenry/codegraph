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
 */

import * as fs from 'fs';
import type * as net from 'net';
import { daemonOptOutSet, getDaemonSocketCandidates } from './daemon-paths';
import { connectWithHello } from './proxy';
import { PROMPT_EXPLORE_METHOD } from './session';

/**
 * - `answered`: the daemon's explore, ready to inject.
 * - `unavailable`: nothing asked the daemon to explore, or it could not: no
 *   daemon, another version, one that predates the request, an error. The
 *   caller's own explore is as good as it ever was.
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
 */
function boundByThisUser(socketPath: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    const stat = fs.lstatSync(socketPath);
    return stat.isSocket() && stat.uid === process.getuid?.();
  } catch {
    return false;
  }
}

async function connectToDaemon(projectRoot: string): Promise<net.Socket | null> {
  for (const socketPath of getDaemonSocketCandidates(projectRoot)) {
    if (!boundByThisUser(socketPath)) continue;
    const socket = await connectWithHello(socketPath);
    if (socket && typeof socket !== 'string') return socket;
  }
  return null;
}

/** Send the one request and read the one line that answers it. */
function ask(socket: net.Socket, query: string): Promise<DaemonExplore> {
  return new Promise((resolve) => {
    let buffer = '';
    socket.on('close', () => resolve(UNAVAILABLE));
    socket.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as {
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        const text = reply.result?.content?.[0]?.text ?? '';
        resolve(reply.result && !reply.result.isError && text.trim() ? { status: 'answered', text } : UNAVAILABLE);
      } catch {
        resolve(UNAVAILABLE);
      }
    });
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: PROMPT_EXPLORE_METHOD, params: { query } }) + '\n');
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
