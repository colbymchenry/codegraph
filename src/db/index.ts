/**
 * Database Layer
 *
 * Handles SQLite database initialization and connection management.
 */

import { SqliteDatabase, SqliteBackend, createDatabase } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';
import { getCodeGraphDir } from '../directory';

export { SqliteDatabase, SqliteBackend } from './sqlite-adapter';

/**
 * Apply connection-level PRAGMAs. Shared by `initialize` and `open` so the two
 * paths can't drift.
 *
 * `busy_timeout` is set FIRST, before any pragma that might touch the database
 * file (notably `journal_mode`). If another process holds a write lock at open
 * time, the later pragmas — and the connection's first query — then wait out
 * the lock instead of throwing "database is locked" immediately. See issue #238.
 *
 * The 5s window (was 120s) rides out a normal incremental sync; the old
 * 2-minute wait presented as a frozen, hung agent. With WAL, reads never block
 * on a writer, so this timeout only governs cross-process write contention
 * (e.g. the git-hook `codegraph sync` running while the MCP server writes).
 */
function configureConnection(db: SqliteDatabase): void {
  db.pragma('busy_timeout = 5000');      // MUST be first — see above
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');       // node:sqlite supports WAL on every platform
  db.pragma('synchronous = NORMAL');     // safe with WAL mode
  db.pragma('cache_size = -64000');      // 64 MB page cache
  db.pragma('temp_store = MEMORY');      // temp tables in memory
  db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O
}

/**
 * Database connection wrapper with lifecycle management
 */
export class DatabaseConnection {
  private db: SqliteDatabase;
  private dbPath: string;
  private backend: SqliteBackend;
  /**
   * `dev:ino` of the DB file at the moment we opened it (or null when the
   * platform/filesystem reports no usable inode). Lets us notice when the file
   * we hold open has been unlinked and REPLACED by a new file at the same path
   * — a git worktree removed and re-added, or `.codegraph/` deleted and
   * re-`init`ed under a long-lived server — at which point our fd reads a now
   * dead inode forever (#925). See `isReplacedOnDisk`.
   */
  private openedInode: string | null;

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
    this.openedInode = statInode(dbPath);
  }

  /**
   * Initialize a new database at the given path
   */
  static initialize(dbPath: string): DatabaseConnection {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create and configure database
    const { db, backend } = createDatabase(dbPath);

    configureConnection(db);

    // Run schema initialization
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    // Record current schema version so migrations aren't re-applied on open
    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(CURRENT_SCHEMA_VERSION, Date.now(), 'Initial schema includes all migrations');
    }

    return new DatabaseConnection(db, dbPath, backend);
  }

  /**
   * Open an existing database
   */
  static open(dbPath: string): DatabaseConnection {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }

    const { db, backend } = createDatabase(dbPath);

    configureConnection(db);

    // Check and run migrations if needed
    const conn = new DatabaseConnection(db, dbPath, backend);
    const currentVersion = getCurrentVersion(db);

    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      runMigrations(db, currentVersion);
    }

    // Self-heal a bulk-load window that never closed (crash between
    // beginBulkNodeLoad and endBulkNodeLoad): the FTS triggers are missing and
    // nodes_fts is stale. Rebuild + recreate so search stays in sync.
    conn.healBulkNodeLoad();

    return conn;
  }

  /**
   * FTS maintenance triggers dropped/recreated around a bulk load.
   * Names must match schema.sql.
   */
  private static readonly FTS_TRIGGER_NAMES = ['nodes_ai', 'nodes_ad', 'nodes_au'] as const;

  /**
   * Enter bulk-load mode: drop the per-row FTS sync triggers so mass node
   * inserts skip per-row tokenization. MUST be paired with endBulkNodeLoad()
   * (use try/finally); a crash inside the window is healed on the next open().
   * The window is DB-wide (triggers are schema objects), which is safe because
   * endBulkNodeLoad() rebuilds nodes_fts from the nodes table wholesale — any
   * row written by anyone during the window is captured by the rebuild.
   */
  beginBulkNodeLoad(): void {
    for (const t of DatabaseConnection.FTS_TRIGGER_NAMES) {
      this.db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    }
  }

  /**
   * Leave bulk-load mode: rebuild the whole FTS index from the nodes table in
   * one pass (far cheaper than per-row trigger firings), then recreate the
   * triggers by re-running schema.sql (idempotent — everything in it is
   * IF NOT EXISTS).
   */
  endBulkNodeLoad(): void {
    this.db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
    this.recreateFtsTriggers();
  }

  /**
   * Names of the NON-UNIQUE edge indexes dropped for a bulk edge load.
   * idx_edges_identity deliberately stays: INSERT OR IGNORE's dedup conflicts
   * on it (#1034), and its leftmost column is `source`, so the source-keyed
   * reads resolution makes mid-window (supertype walks over
   * `implements`/`extends`) keep an index via its prefix — verified with
   * EXPLAIN QUERY PLAN. Target-keyed and kind-keyed reads (traversal,
   * synthesis) happen only after endBulkEdgeLoad().
   */
  private static readonly BULK_EDGE_INDEX_NAMES = [
    'idx_edges_kind',
    'idx_edges_source_kind',
    'idx_edges_target_kind',
    'idx_edges_provenance',
  ] as const;

  /**
   * Enter bulk-edge-load mode: drop the non-unique edge indexes so the mass
   * INSERT OR IGNORE stream pays one B-tree (the identity index) instead of
   * five — measured 2.8s → 1.1s inserting a 224k-edge resolution set, with
   * recreation costing ~0.3s. MUST be paired with endBulkEdgeLoad(); a crash
   * inside the window is healed on the next DatabaseConnection open (schema.sql
   * re-applies CREATE INDEX IF NOT EXISTS).
   */
  beginBulkEdgeLoad(): void {
    for (const idx of DatabaseConnection.BULK_EDGE_INDEX_NAMES) {
      this.db.exec(`DROP INDEX IF EXISTS ${idx}`);
    }
  }

  /**
   * Leave bulk-edge-load mode: recreate the dropped indexes in one pass each
   * over the (now fully loaded) edges table — far cheaper than maintaining
   * them per-insert. DDL is extracted from schema.sql so it cannot drift.
   *
   * Async with a yield BETWEEN the four CREATE INDEX statements: each build is
   * a synchronous scan of the whole edges table (~20s apiece at Linux-kernel
   * scale, 79s total measured), and running them back-to-back is a single
   * event-loop stall longer than the #850 liveness watchdog's 60s window — a
   * daemon-triggered re-index would be SIGKILLed right after doing the work.
   * One yield per statement keeps every stall to a single index build, which
   * stays inside the window.
   */
  async endBulkEdgeLoad(): Promise<void> {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    for (const idx of DatabaseConnection.BULK_EDGE_INDEX_NAMES) {
      const m = schema.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}\\b[^;]*;`));
      if (!m) throw new Error(`schema.sql: edge index ${idx} not found for bulk-load recreation`);
      this.db.exec(m[0]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Recreate the FTS triggers + rebuild if a bulk-load window never closed. */
  private healBulkNodeLoad(): void {
    const row = this.db
      .prepare(
        `SELECT count(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name IN ('nodes_ai','nodes_ad','nodes_au')`
      )
      .get() as { c: number } | undefined;
    if ((row?.c ?? 0) >= DatabaseConnection.FTS_TRIGGER_NAMES.length) return;
    this.endBulkNodeLoad();
  }

  /**
   * Recreate the FTS sync triggers from schema.sql — extracted from the file
   * rather than duplicated here so the DDL cannot drift from the schema.
   * (Re-execing the whole schema is not an option: it contains data INSERTs
   * that are not idempotent, e.g. schema_versions.)
   */
  private recreateFtsTriggers(): void {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    const triggerDdls = schema.match(
      /CREATE TRIGGER IF NOT EXISTS nodes_a[idu]\b[\s\S]*?END;/g
    );
    if (!triggerDdls || triggerDdls.length !== DatabaseConnection.FTS_TRIGGER_NAMES.length) {
      throw new Error(
        `schema.sql: expected ${DatabaseConnection.FTS_TRIGGER_NAMES.length} nodes FTS triggers, found ${triggerDdls?.length ?? 0}`
      );
    }
    for (const ddl of triggerDdls) {
      this.db.exec(ddl);
    }
  }

  /**
   * Get the underlying database instance
   */
  getDb(): SqliteDatabase {
    return this.db;
  }

  /**
   * Get the SQLite backend serving this connection. Per-instance so
   * MCP cross-project queries report the right backend even when
   * multiple project DBs are open in the same process.
   */
  getBackend(): SqliteBackend {
    return this.backend;
  }

  /**
   * Get database file path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * The journal mode actually in effect (e.g. 'wal', 'delete').
   *
   * SQLite silently keeps the prior mode if WAL can't be enabled — e.g. on
   * filesystems without shared-memory support (some network/virtualized mounts,
   * WSL2 /mnt). So the effective mode can differ
   * from what `configureConnection` requested. Surfaced in `codegraph status` so
   * a "database is locked" report is triageable: 'wal' ⇒ readers never block on a
   * writer; anything else ⇒ they can. See issue #238.
   */
  getJournalMode(): string {
    const raw = this.db.pragma('journal_mode');
    const row = Array.isArray(raw) ? raw[0] : raw;
    const mode = row && typeof row === 'object'
      ? (row as Record<string, unknown>).journal_mode
      : row;
    return String(mode ?? '').toLowerCase();
  }

  /**
   * Get current schema version
   */
  getSchemaVersion(): SchemaVersion | null {
    const row = this.db
      .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number; description: string | null } | undefined;

    if (!row) return null;

    return {
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description ?? undefined,
    };
  }

  /**
   * Execute a function within a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Get database file size in bytes
   */
  getSize(): number {
    const stats = fs.statSync(this.dbPath);
    return stats.size;
  }

  /**
   * Size of the `-wal` sidecar file in bytes. 0 when it doesn't exist (non-WAL
   * journal mode, in-memory DB, or no write since the last checkpoint+reset).
   */
  getWalSizeBytes(): number {
    if (!this.dbPath || this.dbPath === ':memory:') return 0;
    try {
      return fs.statSync(`${this.dbPath}-wal`).size;
    } catch {
      return 0;
    }
  }

  /** Size of the main DB file in bytes (0 for in-memory/unknown) — the WAL
   * valve scales its fold caps with it (resolveWalValveMb). */
  getDbFileSizeBytes(): number {
    if (!this.dbPath || this.dbPath === ':memory:') return 0;
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  /** Current `wal_autocheckpoint` interval in pages (0 = disabled). */
  getWalAutocheckpoint(): number {
    const v = this.db.pragma('wal_autocheckpoint', { simple: true });
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Set the connection's `wal_autocheckpoint` interval (pages; 0 disables).
   * Bulk indexing defers checkpoints entirely (#1231): the default 1000-page
   * auto-checkpoint re-writes hot B-tree/FTS pages into the main DB file over
   * and over — measured at ~95% of ALL disk I/O during a bulk index, and the
   * difference between 45s and 19+ minutes on HDD-class storage. During
   * deferral a {@link WalCheckpointValve} bounds WAL growth off-thread.
   */
  setWalAutocheckpoint(pages: number): void {
    this.db.pragma(`wal_autocheckpoint = ${Math.max(0, Math.floor(pages))}`);
  }

  /**
   * `PRAGMA wal_checkpoint(PASSIVE)` on a worker thread with its own
   * connection. PASSIVE never blocks the writer, and running it off-thread
   * means the main thread — and the #850 watchdog heartbeat — keep turning
   * even when the backfill is minutes of I/O on slow storage (a synchronous
   * checkpoint that exceeds the watchdog's 60s window gets a healthy index
   * SIGKILLed — observed in the #1231 repro).
   *
   * Returns SQLite's checkpoint result row — `log === checkpointed` with
   * `busy === 0` means the ENTIRE WAL was backfilled, so the writer's next
   * commit restarts the WAL from the top and the file stops growing. The
   * WAL valve needs that signal because a WAL file's SIZE never shrinks:
   * after the first wrap, raw file size says nothing about the un-backfilled
   * backlog. Best-effort: returns null on any failure (including worker
   * threads being unavailable — a potentially minutes-long checkpoint must
   * never run inline on the main thread).
   */
  async checkpointWalPassive(): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    return this.checkpointWal('PASSIVE');
  }

  /**
   * `PRAGMA wal_checkpoint(TRUNCATE)` — same off-thread pattern as PASSIVE,
   * but on success the WAL FILE is chopped to zero. A completed passive
   * backfill bounds the un-checkpointed backlog, yet the FILE only stops
   * growing when a commit finds ZERO readers holding WAL marks — rare while
   * pool workers cycle, so at kernel scale a fully-backfilled WAL still
   * accreted the phase's whole write volume on disk (§7a.1: 22GB). The valve
   * calls this exactly at a parked barrier (writer parked, pool drained,
   * backfill complete) where the no-reader condition is guaranteed rather
   * than lucky. The worker sets a short busy_timeout so a racing reader
   * degrades this to a no-op (busy=1) instead of a stall.
   */
  async checkpointWalTruncate(): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    return this.checkpointWal('TRUNCATE');
  }

  private async checkpointWal(mode: 'PASSIVE' | 'TRUNCATE'): Promise<{ busy: number; log: number; checkpointed: number } | null> {
    if (!this.dbPath || this.dbPath === ':memory:') {
      try {
        const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as Record<string, number> | undefined;
        return row ? { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) } : null;
      } catch {
        return null;
      }
    }
    try {
      const { Worker } = await import('node:worker_threads');
      const workerSource = `
        const { workerData, parentPort } = require('node:worker_threads');
        let row = null;
        let err = null;
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(workerData.dbPath);
          const mode = workerData.mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE';
          try {
            if (mode === 'TRUNCATE') db.exec('PRAGMA busy_timeout = 2000');
            row = db.prepare('PRAGMA wal_checkpoint(' + mode + ')').get();
          } catch (e) { err = String(e && e.message || e); }
          try { db.close(); } catch {}
        } catch (e) { err = err || String(e && e.message || e); }
        parentPort.postMessage({ row, err });
      `;
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (row?: Record<string, number> | null): void => {
          if (settled) return;
          settled = true;
          resolve(row ? { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) } : null);
        };
        try {
          const worker = new Worker(workerSource, { eval: true, workerData: { dbPath: this.dbPath, mode } });
          worker.once('message', (m: { row?: Record<string, number> | null; err?: string | null }) => {
            if (m?.err && process.env.CODEGRAPH_WAL_VALVE_DEBUG) {
              console.error(`[wal-valve] checkpoint worker (${mode}): ${m.err}`);
            }
            void worker.terminate();
            finish(m?.row ?? null);
          });
          worker.once('error', () => { void worker.terminate(); finish(null); });
          worker.once('exit', () => finish(null));
        } catch {
          finish(null);
        }
      });
    } catch {
      return null;
    }
  }

  /**
   * Optimize database (vacuum and analyze)
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * Lightweight maintenance to run after bulk writes (indexAll, sync).
   * Two operations:
   *
   *   - `PRAGMA optimize` — incremental ANALYZE; SQLite only re-analyzes
   *     tables whose row counts changed materially since the last
   *     ANALYZE. Without it, the query planner has no statistics on the
   *     freshly-bulk-loaded tables and can pick suboptimal indexes.
   *
   *   - `PRAGMA wal_checkpoint(PASSIVE)` — fold pending WAL pages back
   *     into the main database file so the WAL file doesn't grow
   *     unboundedly between automatic checkpoints (auto-fires at 1000
   *     pages by default; large indexAll runs blow past that).
   *
   * Runs on a WORKER THREAD with its own connection: on a multi-GB index
   * these pragmas are minutes of synchronous IO (a 95k-file kernel index
   * left a 593MB WAL whose checkpoint alone blew the #850 watchdog's 60s
   * window and got a COMPLETED index SIGKILLed at the finish line). WAL
   * checkpointing from a second connection is standard SQLite; `PRAGMA
   * optimize` persists its statistics in sqlite_stat tables, so the main
   * connection benefits the same. The main thread just awaits a message,
   * so the event loop — and the watchdog heartbeat — keep turning.
   *
   * Everything is silently swallowed on failure — best-effort
   * optimization, never load-bearing for correctness. If worker threads
   * are unavailable, falls back to a bounded in-line `PRAGMA optimize`
   * and SKIPS the checkpoint (the final close() checkpoints after the
   * CLI has already disarmed its watchdog).
   */
  async runMaintenance(): Promise<void> {
    // In-memory / test databases: nothing worth a worker round-trip.
    if (!this.dbPath || this.dbPath === ':memory:') {
      try { this.db.exec('PRAGMA optimize'); } catch { /* ignore */ }
      try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
      return;
    }
    await this.runPragmasOffThread(
      ['PRAGMA analysis_limit=1000', 'PRAGMA optimize', 'PRAGMA wal_checkpoint(PASSIVE)'],
      // Worker threads unavailable — bounded in-line fallback, no checkpoint.
      ['PRAGMA analysis_limit=1000', 'PRAGMA optimize']
    );
  }

  /**
   * Run pragmas on a worker thread against its own connection to this DB
   * (shared machinery for {@link runMaintenance} and
   * {@link checkpointWalPassive}). Each pragma is individually best-effort;
   * the whole call is best-effort. `inlineFallback` (if any) runs on THIS
   * connection only when worker threads are unavailable — keep it to pragmas
   * that are safe to run synchronously on the main thread.
   */
  private async runPragmasOffThread(pragmas: string[], inlineFallback: string[] = []): Promise<void> {
    try {
      const { Worker } = await import('node:worker_threads');
      const workerSource = `
        const { workerData, parentPort } = require('node:worker_threads');
        try {
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(workerData.dbPath);
          for (const p of workerData.pragmas) { try { db.exec(p); } catch {} }
          try { db.close(); } catch {}
        } catch {}
        parentPort.postMessage('done');
      `;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (!settled) { settled = true; resolve(); }
        };
        try {
          const worker = new Worker(workerSource, { eval: true, workerData: { dbPath: this.dbPath, pragmas } });
          worker.once('message', () => { void worker.terminate(); finish(); });
          worker.once('error', () => { void worker.terminate(); finish(); });
          worker.once('exit', finish);
        } catch {
          finish();
        }
      });
    } catch {
      for (const p of inlineFallback) {
        try { this.db.exec(p); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Check if the database connection is open
   */
  isOpen(): boolean {
    return this.db.open;
  }

  /**
   * True when the DB file at our path has been REPLACED on disk since we opened
   * it — a different inode now lives at the same path, so the fd we still hold
   * points at a now-unlinked inode that can never receive new writes (#925).
   * The trigger is removing and recreating `.codegraph/` at the same path under
   * a long-lived process (`git worktree remove` + re-add, or `rm -rf
   * .codegraph` + `codegraph init`). Returns false when the inode is unchanged,
   * when the file is momentarily absent (mid-recreate — nothing to reopen onto
   * yet), or when the platform doesn't report a usable inode (Windows can't
   * unlink an open file and its st_ino is unreliable, so this never fires there).
   */
  isReplacedOnDisk(): boolean {
    if (this.openedInode === null) return false;
    const current = statInode(this.dbPath);
    return current !== null && current !== this.openedInode;
  }
}

/**
 * `dev:ino` for a path, or null if it can't be stat'd or the platform doesn't
 * report a usable inode. Windows st_ino is unreliable across handle reopens, so
 * we deliberately return null there — the deleted-but-open-inode hazard this
 * guards (#925) is a POSIX file-semantics issue that doesn't arise on Windows
 * (an open file can't be unlinked).
 */
function statInode(p: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    const s = fs.statSync(p);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/**
 * Default database filename
 */
export const DATABASE_FILENAME = 'codegraph.db';

/**
 * SQLite's sidecar files in WAL mode — the write-ahead log and its shared-memory
 * index. They sit beside the main DB file and are removed alongside it when the
 * database is discarded (see `removeDatabaseFiles`).
 */
const WAL_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), DATABASE_FILENAME);
}

/**
 * Delete a database file and its WAL sidecars (`-wal`/`-shm`).
 *
 * This is how a FULL re-index discards an existing database — rather than
 * opening the old graph and DELETE-ing every row. On a large or pre-fix
 * poisoned index (e.g. an old graph that scanned an ignored gitlink corpus into
 * ~1.6M nodes with a multi-GB WAL, #1065) the per-row `nodes_fts` delete-trigger
 * churn blocks the main thread long enough to trip the #850 liveness watchdog
 * before indexing even starts, so the rebuild could never recover the bad state
 * (#1067). Unlinking is O(1) regardless of DB size and also reclaims the disk
 * the bloated WAL would otherwise keep.
 *
 * POSIX removes the directory entry even while another process (a daemon/MCP
 * server) still holds the file open; that holder heals via `reopenIfReplaced`
 * (#925). On Windows a live holder can make the unlink fail with EBUSY/EPERM —
 * that is thrown for the caller to surface ("stop the other process and retry").
 * The `-wal`/`-shm` sidecars are best-effort: SQLite recreates them on the next
 * open, so a leftover sidecar is harmless.
 */
export function removeDatabaseFiles(dbPath: string): void {
  // The main DB file first — its removal is the operation that must succeed (or
  // report why it couldn't). force:true treats an already-missing file as done.
  fs.rmSync(dbPath, { force: true });
  for (const suffix of WAL_SIDECAR_SUFFIXES) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      // A sidecar still held/locked is harmless — SQLite rebuilds it on open.
    }
  }
}
