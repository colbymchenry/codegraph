/**
 * `GET /api/events` — the viewer's live channel (server-sent events).
 *
 * Two questions the open browser cannot answer for itself, and one stream that
 * answers both:
 *
 * - **"has the file I'm looking at changed on disk?"** — the drift banner. The
 *   verdict itself comes from `/api/source` (it hashes the bytes); this stream
 *   only says *when to ask again*, so the banner appears about a third of a
 *   second after a save instead of on the next navigation.
 * - **"has the index moved?"** — the live refresh. Something else (an agent's
 *   MCP daemon, `codegraph sync`, a git hook) writes the graph; when it does,
 *   every screen the viewer is showing is one round-trip out of date.
 *
 * ## This server watches. It never syncs.
 *
 * `codegraph ui` is read-only in every sense — the banner it prints says so —
 * so the obvious implementation (run the engine's watcher, let it sync) is out.
 * What is left is *observation*, from two independent directions:
 *
 * - the project tree, through the engine's own {@link FileWatcher} with a
 *   notify-only `syncFn`. It never writes: the callback that would have run a
 *   sync fans the changed paths out to the browser instead. Everything else
 *   about it — the per-platform watch strategy, the indexer's ignore scope, the
 *   adaptive debounce, the degrade latch — is behaviour we would otherwise have
 *   had to write again, worse.
 * - the index itself, through one non-recursive `fs.watch` on the data
 *   directory. That is the only cross-process signal there is: the writer is a
 *   different process, and the thing it changes is a file. A settled write is
 *   followed by ONE cheap query (`getIndexRevision`), and only a revision that
 *   actually moved becomes an event.
 *
 * **Nothing polls.** Both watchers are edge-triggered, and both start on the
 * first subscriber and stop with the last one — a viewer nobody has open costs
 * no watch descriptors, which matters on Linux where the strategy is
 * per-directory.
 *
 * ## Boundary
 *
 * A long-lived response sits inside the loopback boundary exactly like every
 * other route: `Host`, `Origin` and the GET-only rule are already enforced by
 * `startUiServer` before this module is reached, and nothing here reads the
 * repository — the paths it names came from the watcher and the index, and the
 * viewer has to go back through `/api/source` (and therefore through
 * `resolveProjectFile`) to see a byte of any of them.
 */

import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import type { CodeGraph } from '../../index';
import { getCodeGraphDir } from '../../directory';
import { FileWatcher } from '../../sync/watcher';
import type { GraphSession } from './session';

/**
 * Paths carried in one event. `total` is always the real number — a burst of
 * two thousand files still says two thousand, it just does not list them.
 */
export const MAX_EVENT_FILES = 200;

/** Comment frame keeping the connection (and the client's idea of it) alive. */
export const HEARTBEAT_MS = 25_000;

/**
 * Quiet window before an index write is treated as finished.
 *
 * A sync writes the WAL continuously, so the *end* of the writing is the signal
 * — not its start. Long enough that a multi-second sync produces one event
 * rather than a dozen.
 */
const INDEX_SETTLE_MS = 400;

/**
 * Ceiling on that quiet window. A sync large enough that the WAL never goes
 * quiet for 400 ms would otherwise hold the first event until it finished; the
 * cap makes the viewer refresh mid-way instead, which is still true — the graph
 * really has moved — and costs one query.
 */
const INDEX_SETTLE_MAX_MS = 3_000;

/**
 * Debounce for source-file events. The watcher's own adaptive rule fires a lone
 * save after `min(300, this)` ms of quiet and keeps the full window for a
 * burst, so a single edit reaches the browser well inside the one-second bar
 * while an agent rewriting forty files still arrives as one event.
 */
const SOURCE_DEBOUNCE_MS = 500;

/* --------------------------------------------------------------- the wire -- */

export interface WireIndexRevision {
  lastIndexedAt: number | null;
  files: number;
}

/** Sent once, immediately, so a client knows what it is synchronised against. */
export interface WireEventHello {
  type: 'hello';
  index: WireIndexRevision | null;
  /** Which of the two observers actually came up. */
  watching: { source: boolean; index: boolean };
  /** Non-null when live watching has given up; the client must NOT start polling. */
  degraded: string | null;
  heartbeatMs: number;
  at: number;
}

/** Source files changed on disk. The index has NOT caught up yet. */
export interface WireEventChanged {
  type: 'changed';
  files: string[];
  total: number;
  truncated: boolean;
  /**
   * True when the change could not be described file by file (a directory
   * removal, or a burst past the watcher's scoped ceiling). Treat any open file
   * as possibly affected.
   */
  scan: boolean;
  at: number;
}

/** The index moved: some other process finished writing the graph. */
export interface WireEventIndex {
  type: 'index';
  index: WireIndexRevision;
  /** Files this sync re-indexed, newest first. Empty when it only deleted. */
  files: string[];
  total: number;
  truncated: boolean;
  at: number;
}

/** Live watching has stopped for good. Sent once; the stream stays open. */
export interface WireEventDegraded {
  type: 'degraded';
  reason: string;
  at: number;
}

export type WireEvent =
  | WireEventHello
  | WireEventChanged
  | WireEventIndex
  | WireEventDegraded;

/* ---------------------------------------------------------------- the hub -- */

interface Client {
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

/**
 * Fans filesystem and index changes out to every open viewer.
 *
 * One hub per server. It owns the watchers, and owns them lazily: they exist
 * only while somebody is listening.
 */
export class EventHub {
  private readonly projectRoot: string;
  private readonly session: GraphSession;
  private readonly clients = new Set<Client>();

  private sourceWatcher: FileWatcher | null = null;
  private indexWatcher: fs.FSWatcher | null = null;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current settle window started, for the {@link INDEX_SETTLE_MAX_MS} cap. */
  private indexPendingSince = 0;
  private revision: WireIndexRevision | null = null;
  private sourceUp = false;
  private indexUp = false;
  private degraded: string | null = null;
  private closed = false;

  constructor(projectRoot: string, session: GraphSession) {
    this.projectRoot = projectRoot;
    this.session = session;
  }

  /**
   * Attach one browser to the stream.
   *
   * Returns `true` in every case — the response is answered here, streaming or
   * not — so it slots into the API's `switch` like any other endpoint.
   */
  subscribe(req: IncomingMessage, res: ServerResponse, method: string): true {
    if (this.closed) {
      // The server is shutting down. Answer, do not attach: a client that got a
      // stream here would hold the socket open against `close()`.
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Shutting down.', code: 'internal' }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      // Node would otherwise chunk small writes; an event that sits in a buffer
      // is an event that did not happen.
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (method === 'HEAD') {
      res.end();
      return true;
    }

    // No keep-alive timeout on this socket: the server sets one globally so
    // Ctrl-C does not wait on browser connections, and it would close a healthy
    // stream between heartbeats.
    res.socket?.setTimeout(0);
    res.socket?.setNoDelay(true);

    this.ensureWatching();

    const client: Client = {
      res,
      heartbeat: setInterval(() => {
        // A comment frame. Not an event, so no client handler ever sees it —
        // it exists to notice a socket the other end has already dropped.
        if (!res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS),
    };
    // `unref` so a live stream never keeps the process alive on its own.
    client.heartbeat.unref?.();
    this.clients.add(client);

    const drop = (): void => this.drop(client);
    res.on('close', drop);
    res.on('error', drop);
    req.on('aborted', drop);

    this.send(client, {
      type: 'hello',
      index: this.revision,
      watching: { source: this.sourceUp, index: this.indexUp },
      degraded: this.degraded,
      heartbeatMs: HEARTBEAT_MS,
      at: Date.now(),
    });
    return true;
  }

  /** Number of attached clients — for tests and for the watchers' lifetime. */
  get size(): number {
    return this.clients.size;
  }

  /** Stop watching and end every open stream. Idempotent. */
  close(): void {
    this.closed = true;
    this.stopWatching();
    for (const client of [...this.clients]) {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
      try {
        client.res.end();
      } catch {
        /* the socket is already gone */
      }
    }
  }

  /* ------------------------------------------------------------ plumbing -- */

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    clearInterval(client.heartbeat);
    if (this.clients.size === 0) this.stopWatching();
  }

  private send(client: Client, event: WireEvent): void {
    if (client.res.writableEnded) return;
    try {
      // `retry` on every frame is cheap and means a client that reconnects with
      // the browser's own EventSource still backs off the way we asked.
      client.res.write(`retry: 3000\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.drop(client);
    }
  }

  private broadcast(event: WireEvent): void {
    for (const client of [...this.clients]) this.send(client, event);
  }

  /* ------------------------------------------------------------ watching -- */

  private ensureWatching(): void {
    if (this.closed) return;
    this.revision ??= this.probe();
    this.startSourceWatcher();
    this.startIndexWatcher();
  }

  private stopWatching(): void {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    this.indexPendingSince = 0;
    try {
      this.indexWatcher?.close();
    } catch {
      /* already closed */
    }
    this.indexWatcher = null;
    this.indexUp = false;
    this.sourceWatcher?.stop();
    this.sourceWatcher = null;
    this.sourceUp = false;
  }

  /**
   * The project tree, through the engine's watcher with the sync taken out.
   *
   * The `syncFn` is the whole trick: the watcher calls it with exactly the
   * paths it would have handed to a scoped sync (or `undefined` when the events
   * could not describe the change), we announce them and report zero files
   * changed. It succeeds every time, so the watcher's failure ladder — lock
   * retries, backoff, the degrade latch — is only ever reached by the watch
   * layer itself, which is precisely the part we do want.
   */
  private startSourceWatcher(): void {
    if (this.sourceWatcher) return;
    const watcher = new FileWatcher(
      this.projectRoot,
      async (paths?: string[]) => {
        this.announceChanged(paths);
        return { filesChanged: 0, durationMs: 0 };
      },
      {
        debounceMs: SOURCE_DEBOUNCE_MS,
        onDegraded: (reason) => {
          this.degraded = reason;
          this.sourceUp = false;
          this.broadcast({ type: 'degraded', reason, at: Date.now() });
        },
      }
    );
    this.sourceWatcher = watcher;
    this.sourceUp = watcher.start();
    if (!this.sourceUp) {
      // Watching is off by policy (CODEGRAPH_NO_WATCH, a WSL2 /mnt drive) or
      // the OS refused. The stream stays — the index watcher is independent —
      // and `hello` already told the client which half is live.
      this.sourceWatcher = null;
    }
  }

  private announceChanged(paths?: string[]): void {
    const all = paths ?? [];
    const files = all.slice(0, MAX_EVENT_FILES);
    this.broadcast({
      type: 'changed',
      files,
      total: all.length,
      truncated: files.length < all.length,
      scan: paths === undefined,
      at: Date.now(),
    });
  }

  /**
   * The index, through one watch on the data directory.
   *
   * Non-recursive and on the directory rather than the database file: SQLite
   * writes land in `codegraph.db-wal`, and a full re-index REPLACES
   * `codegraph.db` outright (a watch on the file itself would follow the
   * unlinked inode and never fire again).
   */
  private startIndexWatcher(): void {
    if (this.indexWatcher) return;
    const dir = getCodeGraphDir(this.projectRoot);
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => this.scheduleProbe());
      watcher.on('error', () => {
        // The data directory went away, or the OS dropped the watch. Nothing to
        // retry against — a client that reloads gets a fresh one.
        this.indexUp = false;
        this.indexWatcher = null;
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
      });
      this.indexWatcher = watcher;
      this.indexUp = true;
    } catch {
      this.indexUp = false;
    }
  }

  /**
   * Wait for the writing to stop, then look once.
   *
   * Re-armed by every write, so a sync that takes four seconds produces one
   * probe at its end — except that {@link INDEX_SETTLE_MAX_MS} caps how long
   * the first probe can be deferred, so a continuously-writing full index still
   * refreshes the viewer while it runs.
   */
  private scheduleProbe(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.indexPendingSince === 0) this.indexPendingSince = now;
    const remaining = Math.max(0, this.indexPendingSince + INDEX_SETTLE_MAX_MS - now);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    const timer = setTimeout(() => {
      this.indexTimer = null;
      this.indexPendingSince = 0;
      this.checkIndex();
    }, Math.min(INDEX_SETTLE_MS, remaining));
    timer.unref?.();
    this.indexTimer = timer;
  }

  /** One query. An unmoved revision is not an event. */
  private checkIndex(): void {
    if (this.closed || this.clients.size === 0) return;
    const next = this.probe();
    if (next === null) return;
    const previous = this.revision;
    this.revision = next;
    if (
      previous !== null &&
      previous.lastIndexedAt === next.lastIndexedAt &&
      previous.files === next.files
    ) {
      return;
    }

    // Everything re-indexed since the mark we were holding. A sync that only
    // removed files names nothing here — which is why the revision comparison
    // above, not this list, decides whether an event happens at all.
    let files: string[] = [];
    let total = 0;
    const since = previous?.lastIndexedAt ?? null;
    if (since !== null) {
      try {
        const changed = this.session.acquire().getFilesIndexedSince(since, MAX_EVENT_FILES);
        files = changed.paths;
        total = changed.total;
      } catch {
        /* the index went away between the probe and here — the event still stands */
      }
    }

    this.broadcast({
      type: 'index',
      index: next,
      files,
      total: Math.max(total, files.length),
      truncated: files.length < total,
      at: Date.now(),
    });
  }

  /**
   * The current revision, or null when there is no readable index.
   *
   * A missing index is not an error here: `codegraph ui` refuses to start
   * without one, but a user can delete `.codegraph/` with the viewer open, and
   * every endpoint already says so in its own words when asked.
   */
  private probe(): WireIndexRevision | null {
    try {
      const cg: CodeGraph = this.session.acquire();
      const revision = cg.getIndexRevision();
      return { lastIndexedAt: revision.lastIndexedAt, files: revision.fileCount };
    } catch {
      return null;
    }
  }
}
