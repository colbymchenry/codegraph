/**
 * Database Layer
 *
 * Handles database initialization and connection management.
 * Supports SQLite (default) and NeuG (optional graph database) backends.
 */

import { SqliteDatabase, SqliteBackend, createDatabase } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';

export { SqliteDatabase, SqliteBackend } from './sqlite-adapter';

/**
 * Storage backend type: SQLite (default) or NeuG (graph DB).
 */
export type StorageBackendType = 'sqlite' | 'neug';

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

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
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
}

/**
 * Default database filename
 */
export const DATABASE_FILENAME = 'codegraph.db';

/**
 * Default NeuG database directory name
 */
export const NEUG_DB_DIR = 'codegraph.neug';

/**
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', DATABASE_FILENAME);
}

/**
 * Get the NeuG database directory path for a project
 */
export function getNeuGDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', NEUG_DB_DIR);
}

/**
 * NeuG database connection wrapper with lifecycle management.
 *
 * Mirrors DatabaseConnection's public surface so CodeGraph can use either
 * via duck typing. Methods that are SQLite-specific (journal mode, pragmas)
 * return sensible defaults.
 */
export class NeuGDatabaseConnection {
  private db: any; // neug.Database
  private conn: any; // neug.Connection
  private dbPath: string;

  private constructor(db: any, conn: any, dbPath: string) {
    this.db = db;
    this.conn = conn;
    this.dbPath = dbPath;
  }

  private static async loadNeuG(): Promise<any> {
    try {
      // @ts-expect-error no type declarations shipped yet
      return await import('@graphscope-neug/neug');
    } catch {
      throw new Error(
        'The "@graphscope-neug/neug" package is not installed. Install it to use the NeuG backend:\n' +
        '  npm install @graphscope-neug/neug\n' +
        'Note: the neug npm package requires a platform-specific native binary.'
      );
    }
  }

  /**
   * Initialize a new NeuG database at the given path.
   * Dynamically imports the `neug` package.
   */
  static async initialize(dbPath: string): Promise<NeuGDatabaseConnection> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const neug = await NeuGDatabaseConnection.loadNeuG();
    const db = new neug.Database({ databasePath: dbPath, mode: 'w' });
    const conn = db.connect();
    return new NeuGDatabaseConnection(db, conn, dbPath);
  }

  /**
   * Open an existing NeuG database.
   */
  static async open(dbPath: string): Promise<NeuGDatabaseConnection> {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`NeuG database not found: ${dbPath}`);
    }

    const neug = await NeuGDatabaseConnection.loadNeuG();
    const db = new neug.Database({ databasePath: dbPath, mode: 'rw' });
    const conn = db.connect();
    return new NeuGDatabaseConnection(db, conn, dbPath);
  }

  /**
   * Get wrapped NeuG connection (used by NeuGQueryBuilder).
   * Wraps the raw connection to adapt QueryResult to the expected interface.
   */
  getConnection(): any {
    const { NeuGConnectionWrapper } = require('./neug-backend');
    return new NeuGConnectionWrapper(this.conn);
  }

  getBackend(): 'neug' {
    return 'neug';
  }

  getPath(): string {
    return this.dbPath;
  }

  getJournalMode(): string {
    return 'n/a';
  }

  getSchemaVersion(): SchemaVersion | null {
    try {
      const result = this.conn.execute(
        `MATCH (v:SchemaVersion) RETURN v.version, v.applied_at, v.description ORDER BY v.version DESC LIMIT 1`,
        { accessMode: 'read' }
      );
      if (result.length === 0) return null;
      const row = result.toArray()[0];
      return {
        version: Number(row[0]),
        appliedAt: Number(row[1]),
        description: row[2] ?? undefined,
      };
    } catch {
      return null;
    }
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  getSize(): number {
    try {
      const stats = fs.statSync(this.dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  optimize(): void {
    // NeuG has no equivalent of VACUUM/ANALYZE
  }

  runMaintenance(): void {
    // No-op for NeuG
  }

  close(): void {
    this.conn.close();
    this.db.close();
  }

  isOpen(): boolean {
    return true;
  }
}
