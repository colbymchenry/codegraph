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

    return conn;
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
   * WSL2 /mnt), and always on the wasm backend. So the effective mode can differ
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
   * Optimize database (vacuum and analyze)
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * Lightweight, non-blocking maintenance to run after bulk writes
   * (indexAll, sync). Two operations:
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
   * Both operations are silently swallowed on failure — they're a
   * best-effort optimization, never load-bearing for correctness.
   */
  runMaintenance(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // ignore
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // ignore (e.g., not in WAL mode)
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
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), DATABASE_FILENAME);
}
