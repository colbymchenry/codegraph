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

export { SqliteDatabase, SqliteBackend, WASM_FALLBACK_FIX_RECIPE } from './sqlite-adapter';

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

    // Enable foreign keys and WAL mode for better performance
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    // Wait up to 2 minutes if database is locked by another process
    // (indexing operations can hold locks for extended periods)
    db.pragma('busy_timeout = 120000');
    // Performance tuning
    db.pragma('synchronous = NORMAL');     // Safe with WAL mode
    db.pragma('cache_size = -64000');      // 64 MB page cache
    db.pragma('temp_store = MEMORY');      // Temp tables in memory
    db.pragma('mmap_size = 268435456');    // 256 MB memory-mapped I/O

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

    // Enable foreign keys and WAL mode
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    // Wait up to 2 minutes if database is locked by another process
    // (indexing operations can hold locks for extended periods)
    db.pragma('busy_timeout = 120000');
    // Performance tuning
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');

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
 * Get the default database path for a project
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', DATABASE_FILENAME);
}
