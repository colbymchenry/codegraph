/** Shared synchronization ownership for projects accessed by MCP engines (#1835). */
import { realpathSync } from 'fs';
import * as path from 'path';
import type { Socket } from 'net';
import type CodeGraph from '../index';
import { canonicalProjectRoot, getCodeGraphDir, isInitialized } from '../directory';
import { LockUnavailableError } from '../errors';
import { watchDisabledReason } from '../sync/watch-policy';
import { getDaemonSocketCandidates } from './daemon-paths';
import { addWatchdogProgressPaths } from './liveness-watchdog';
import { connectWithHello } from './proxy';
import { markWriterReady, readWriterLock, releaseWriterLock, tryAcquireWriterLock } from './writer-lock';

/**
 * How long a catch-up the WAL valve stopped waits before it starts again, and
 * the most it waits; the wait doubles after each stop in a row (#3273).
 */
export const VALVE_RETRY_BASE_MS = 5_000;
export const VALVE_RETRY_MAX_MS = 5 * 60_000;

/**
 * The WAL valve stopped the sync: a reader, typically a tool call served
 * from the query pool, kept every checkpoint from catching up (#1539). The
 * code is the valve's own (`WalValveAbortError`), read without importing it.
 */
function isWalValveAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'WAL_VALVE_ABORT';
}

interface Project {
  /** Identity key: one entry however the root is spelled (#2278). */
  key: string;
  cg: CodeGraph;
  refs: number;
  owner: boolean;
  caughtUp: boolean;
  retirement: Promise<void> | null;
  gate: Promise<void> | null;
  socket: Socket | null;
  timer: NodeJS.Timeout;
  options: Parameters<CodeGraph['watch']>[0];
  /** Drops the index files from the liveness watchdog's progress; set while this process writes them (#2404). */
  dropProgress: (() => void) | null;
  /** No catch-up starts before this time: the WAL valve stopped the last one (#3273). */
  retryAt: number;
  /** The wait {@link retryAt} was set with; 0 when the last catch-up wasn't stopped. */
  retryDelayMs: number;
}

export interface ProjectLease {
  cg: CodeGraph;
  ready(): Promise<void>;
  release(): Promise<void>;
}

const projects = new Map<string, Project>();

/** Engines in one process share a graph; other processes share the writer slot. */
export function acquireProject(
  root: string,
  open: () => CodeGraph,
  options: Parameters<CodeGraph['watch']>[0],
): ProjectLease {
  root = realpathSync(root);
  const key = canonicalProjectRoot(root);
  let project = projects.get(key);
  if (!project) {
    const cg = open();
    project = { key, cg, refs: 0, owner: false, caughtUp: false, retirement: null, gate: null, socket: null, options,
      dropProgress: null, retryAt: 0, retryDelayMs: 0, timer: setInterval(() => { void ready(root, project!); }, 1000) };
    project.timer.unref();
    projects.set(key, project);
  }
  const entry = project;
  entry.refs++;
  let released = false;
  return {
    cg: entry.cg,
    ready: () => ready(root, entry),
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      if (--entry.refs === 0) return retire(root, entry);
      return Promise.resolve();
    },
  };
}

function retire(root: string, project: Project): Promise<void> {
  if (project.retirement) return project.retirement;
  let resolve!: () => void;
  const retirement = new Promise<void>((done) => { resolve = done; });
  project.retirement = retirement;
  clearInterval(project.timer);
  project.socket?.destroy();
  project.socket = null;
  // A timed-out gate or an already-running watcher sync still owns this DB.
  // Leave the entry discoverable so a new lease can reuse it while it drains.
  const finish = (): void => {
    if (project.refs > 0) {
      project.retirement = null;
      project.timer = setInterval(() => { void ready(root, project); }, 1000);
      project.timer.unref();
      resolve();
      return;
    }
    if (project.gate || project.cg.isIndexing()) {
      setTimeout(finish, 25);
      return;
    }
    projects.delete(project.key);
    project.cg.close();
    if (project.owner) releaseWriterLock(root);
    // After the close, which may still checkpoint the WAL on this thread.
    project.dropProgress?.();
    project.dropProgress = null;
    resolve();
  };
  finish();
  return retirement;
}

function ready(root: string, project: Project): Promise<void> {
  if (project.gate) return project.gate;
  if (project.refs === 0 || (project.owner && project.caughtUp) || (project.socket && !project.socket.destroyed)) {
    return Promise.resolve();
  }
  // The WAL valve stopped the last catch-up. Every access and the timer below
  // would start it again at once, so a session's tool calls kept the readers
  // that stopped it coming while each retry scanned the project again and
  // grew the WAL a little more (#3273). Wait it out; calls meanwhile are
  // served without waiting for a catch-up, as after the gate's timeout.
  if (Date.now() < project.retryAt) return Promise.resolve();
  const gate = activate(root, project).then(() => {
    project.retryAt = 0;
    project.retryDelayMs = 0;
  }, (err) => {
    // A CLI/indexer can hold codegraph.lock even while we own writer.pid.
    // Leave caughtUp false so the next access or timer retries quietly (#1361).
    if (err instanceof LockUnavailableError) return;
    const message = err instanceof Error ? err.message : String(err);
    if (isWalValveAbort(err)) {
      project.retryDelayMs = Math.min(project.retryDelayMs > 0 ? project.retryDelayMs * 2 : VALVE_RETRY_BASE_MS, VALVE_RETRY_MAX_MS);
      project.retryAt = Date.now() + project.retryDelayMs;
      process.stderr.write(`[CodeGraph MCP] Catch-up sync failed for ${root}: ${message} Trying again in ${Math.round(project.retryDelayMs / 1000)}s.\n`);
      return;
    }
    process.stderr.write(`[CodeGraph MCP] Catch-up sync failed for ${root}: ${message}\n`);
  }).finally(() => {
    if (project.gate === gate) project.gate = null;
  });
  project.gate = gate;
  return gate;
}

async function activate(root: string, project: Project): Promise<void> {
  if (!isInitialized(root)) return;
  // Rebuild what an interrupted bulk load dropped (off this thread, #1887)
  // before writing: a sync's writes would wait out the rebuild's write lock
  // with this thread blocked.
  if (project.cg.hasPendingIndexRecovery?.()) await project.cg.recoverIndexes();
  const writer = tryAcquireWriterLock(root, 'fallback');
  if (writer.kind === 'taken') {
    // Keep a real daemon session, so its idle timeout cannot strand this reader.
    // Direct writers have no socket; the periodic retry takes over on their exit.
    if (writer.existing?.mode === 'daemon') {
      for (const candidate of getDaemonSocketCandidates(root)) {
        const socket = await connectWithHello(candidate);
        // A daemon of another version, older or not, is left to the project's own launchers.
        if (!socket || typeof socket === 'string') continue;
        if (project.refs === 0) { socket.destroy(); return; }
        project.socket = socket;
        socket.once('close', () => {
          if (project.socket === socket) project.socket = null;
        });
        await daemonCatchUp(socket);
        return;
      }
    }
    // A direct owner cannot accept RPC, but advertises completion in writer.pid.
    // Wait for its startup reconcile too; legacy writers have no readiness flag.
    const deadline = Date.now() + 30_000;
    while (project.refs > 0 && writer.existing?.ready === false && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const current = readWriterLock(root);
      if (!current || current.pid !== writer.existing.pid) return activate(root, project);
      if (current.ready !== false) break;
      try { process.kill(current.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return activate(root, project);
      }
    }
    return;
  }
  project.owner = true;
  // This process writes the index from here on, in long synchronous stretches
  // on the main thread: the catch-up below and every watcher sync. The
  // liveness watchdog must count its files advancing as progress, as it does
  // for the project it was armed with; otherwise a long sync of any other
  // project reads as a wedge and the server is killed mid-sync (#2404).
  if (!project.dropProgress) {
    const db = path.join(getCodeGraphDir(root), 'codegraph.db');
    project.dropProgress = addWatchdogProgressPaths([db, `${db}-wal`]);
  }
  const disabled = watchDisabledReason(root);
  if (disabled) {
    process.stderr.write(`[CodeGraph MCP] File watcher disabled for ${root} — ${disabled}.\n`);
  } else {
    if (project.cg.watch(project.options)) {
      process.stderr.write(`[CodeGraph MCP] File watcher active for ${root} — graph will auto-sync on changes\n`);
    }
  }
  await project.cg.sync();
  project.caughtUp = true;
  markWriterReady(root);
}

/** A tool request passes through the daemon's own first-query catch-up gate. */
function daemonCatchUp(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    const finish = (): void => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', finish);
      resolve();
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 'project-catchup') finish();
        } catch { /* ignore non-response lines */ }
      }
    };
    const timer = setTimeout(() => { socket.destroy(); finish(); }, 30_000);
    timer.unref();
    socket.on('data', onData);
    socket.once('close', finish);
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 'project-catchup', method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} } }) + '\n');
  });
}
