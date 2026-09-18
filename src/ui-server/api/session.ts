/**
 * The one open handle on the project's index.
 *
 * `CodeGraph.openSync` costs tens of milliseconds and runs pending migrations,
 * so it happens once for the life of the server rather than once per request.
 * That leaves two things this module has to get right:
 *
 * - **A missing index is guidance, not a stack trace.** `codegraph ui` refuses
 *   to start without one, but a user can delete `.codegraph/` while the viewer
 *   is open, so every endpoint has to be able to say so in the same words the
 *   CLI does.
 * - **A re-index must not be served from a phantom database.** `codegraph init`
 *   on an already-indexed project *replaces the database file* (see
 *   `CodeGraph.recreate`). On POSIX our handle would keep reading the unlinked
 *   inode and happily serve a graph that no longer exists on disk. So the file
 *   identity is re-checked on acquisition — one `stat` — and a swapped file
 *   reopens the connection.
 * - **A sync by ANOTHER process must not be served from memory.** The same
 *   `stat` also notices the database growing, and when it has, the read caches
 *   go (`dropReadCaches`). The query layer holds an LRU of nodes by id which
 *   only a write through *this* instance invalidates, so without it
 *   `/api/node/<id>` keeps answering with a symbol an agent's sync deleted
 *   while `/api/search` — which never caches — correctly says it is gone. That
 *   is not a stale screen, it is two screens contradicting each other; and
 *   because a node's id contains its start line, ANY edit above a symbol
 *   renames it, so this is the common case rather than the corner one.
 */

import * as fs from 'fs';
import { CodeGraph } from '../../index';
import { getDatabasePath } from '../../db';
import { isInitialized } from '../../directory';
import { ApiError } from './respond';

/**
 * Identity of the database file, so a swap underneath us is detectable — plus
 * the marks that say it was WRITTEN to without being replaced.
 *
 * The WAL is measured as well as the database: in WAL mode a commit lands in
 * `codegraph.db-wal` and may not touch `codegraph.db` until a checkpoint, so a
 * whole sync can go by with the main file's size and mtime unchanged.
 */
interface FileIdentity {
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

function identify(dbPath: string): FileIdentity | null {
  try {
    const st = fs.statSync(dbPath);
    let walSize = 0;
    let walMtimeMs = 0;
    try {
      const wal = fs.statSync(`${dbPath}-wal`);
      walSize = wal.size;
      walMtimeMs = wal.mtimeMs;
    } catch {
      // No WAL sidecar: either not in WAL mode, or fully checkpointed. Both are
      // "nothing pending", which is what zeroes mean here.
    }
    return {
      ino: st.ino,
      birthtimeMs: st.birthtimeMs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      walSize,
      walMtimeMs,
    };
  } catch {
    return null;
  }
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return false;
  // `ino` is 0 on a few Windows filesystems; birthtime alone still catches a
  // recreate there, and a false "changed" only costs one reopen.
  return a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

/** Same file, but written to since we last looked. */
function sameContent(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.walSize === b.walSize &&
    a.walMtimeMs === b.walMtimeMs
  );
}

/**
 * Guidance shown when there is no index to read. Deliberately the same three
 * facts the CLI prints: the viewer never creates an index, `codegraph init`
 * does, and you can point the viewer somewhere already indexed.
 */
function noIndexError(projectRoot: string): ApiError {
  return new ApiError(
    'no-index',
    `No CodeGraph index found for ${projectRoot}.`,
    'The viewer reads an index that already exists — it never creates one. ' +
      'Run "codegraph init" in that project, or start the viewer against a project ' +
      'that has one: codegraph ui /path/to/indexed/project'
  );
}

/**
 * Holds the project's `CodeGraph` open for the life of the server.
 *
 * Not thread-safe and does not need to be: `node:http` dispatches on one
 * thread, and every read below is synchronous.
 */
export class GraphSession {
  readonly projectRoot: string;
  private readonly dbPath: string;
  private cg: CodeGraph | null = null;
  private identity: FileIdentity | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.dbPath = getDatabasePath(projectRoot);
  }

  /**
   * The open graph, opening (or reopening) it if needed.
   *
   * @throws {ApiError} `no-index` when the project has no index,
   *   `index-unusable` when it has one that will not open.
   */
  acquire(): CodeGraph {
    const current = identify(this.dbPath);

    if (this.cg !== null) {
      if (sameFile(this.identity, current)) {
        // Same file, but somebody wrote to it. SQLite itself is fine — a WAL
        // reader sees the new commits — but our in-memory node cache is not,
        // so it goes. One `stat` already paid for; clearing a bounded Map is
        // the whole cost.
        if (!sameContent(this.identity, current)) {
          this.identity = current;
          this.cg.dropReadCaches();
        }
        return this.cg;
      }
      // The database was replaced (a re-index) or removed. Drop the stale
      // handle; falling through re-opens against whatever is there now.
      this.closeQuietly();
    }

    if (!isInitialized(this.projectRoot)) throw noIndexError(this.projectRoot);

    try {
      this.cg = CodeGraph.openSync(this.projectRoot);
    } catch (err) {
      this.cg = null;
      this.identity = null;
      throw new ApiError(
        'index-unusable',
        `The CodeGraph index for ${this.projectRoot} could not be opened: ` +
          (err instanceof Error ? err.message : String(err)),
        'If another CodeGraph process is rebuilding it, wait for that to finish. ' +
          'If the index is damaged, rebuild it with "codegraph init".'
      );
    }
    this.identity = current ?? identify(this.dbPath);
    return this.cg;
  }

  /** Release the handle. Idempotent — the CLI calls it on Ctrl-C. */
  close(): void {
    this.closeQuietly();
  }

  private closeQuietly(): void {
    const cg = this.cg;
    this.cg = null;
    this.identity = null;
    if (!cg) return;
    try {
      cg.close();
    } catch {
      // A close that fails has nothing left to release — the process is either
      // exiting or the file is already gone. Never let it fail a request.
    }
  }
}
