/**
 * SQLite Adapter
 *
 * Thin wrapper around `bun:sqlite` exposing a better-sqlite3-style
 * interface so the rest of CodeGraph can stay backend-agnostic. The
 * adapter translates @named SQL params to positional `?` so callers
 * can keep passing plain `{ name: value }` objects without prefixing.
 *
 * Requires the Bun runtime — `bun:sqlite` is a built-in module and is
 * not available under Node.js.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SqlitePragmaOptions {
  /** Return a single scalar value (the first column of the first row). */
  simple?: boolean;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: SqlitePragmaOptions): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * Translate @named parameters (better-sqlite3 style) to positional ?
 * params. bun:sqlite supports SQLite-native `$name` / `:name` / `@name`
 * binding, but the rest of CodeGraph was written against better-sqlite3
 * and passes plain `{ name: value }` objects (no prefix). Rewriting the
 * SQL lets us keep every call site untouched.
 *
 * Returns the rewritten SQL and an ordered list of parameter names.
 * Returns null for paramOrder when no named params were found.
 */
function translateNamedParams(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  const rewritten = sql.replace(/@(\w+)/g, (_match, name: string) => {
    paramOrder.push(name);
    return '?';
  });
  if (paramOrder.length === 0) {
    return { sql, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

/**
 * Map better-sqlite3-style call args to a positional varargs array.
 *
 * - Named object: run({ id: '1', name: 'a' }) → values ordered by paramOrder
 * - Positional varargs: run('a', 'b') → ['a', 'b']
 * - No args: run() → []
 */
function resolveParams(params: any[], paramOrder: string[] | null): any[] {
  if (params.length === 0) return [];

  if (
    paramOrder &&
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Uint8Array)
  ) {
    const obj = params[0];
    return paramOrder.map((name) => obj[name]);
  }

  return params;
}

/**
 * Wraps `bun:sqlite`'s `Database` so it matches the better-sqlite3
 * interface the rest of the codebase was written against.
 *
 * Key differences handled:
 * - bun:sqlite has no `pragma()` method — emulated via `exec` / `query`.
 * - bun:sqlite has no `.open` property — tracked locally so callers can
 *   still ask the question.
 * - bun:sqlite's `Statement.run` already returns `{ changes,
 *   lastInsertRowid }`; we just normalize null/undefined.
 */
class BunSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _open = true;

  constructor(dbPath: string) {
    // Lazy require so this file is importable under non-Bun runtimes
    // for type-checking. The module only resolves at runtime in Bun.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite');
    this._db = new Database(dbPath, { create: true });
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    const { sql: rewrittenSql, paramOrder } = translateNamedParams(sql);
    const stmt = this._db.prepare(rewrittenSql);
    return {
      run(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        const result = stmt.run(...resolved);
        return {
          changes: result?.changes ?? 0,
          lastInsertRowid: result?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        return stmt.get(...resolved);
      },
      all(...params: any[]) {
        const resolved = resolveParams(params, paramOrder);
        return stmt.all(...resolved);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: SqlitePragmaOptions): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      // Write pragma — `PRAGMA key = value`.
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // Read pragma — better-sqlite3 returns an array of row objects by
    // default; with `{ simple: true }` it returns the first column of
    // the first row (a scalar). Replicate both shapes.
    const rows = this._db.prepare(`PRAGMA ${trimmed}`).all();
    if (options?.simple) {
      if (!rows || rows.length === 0) return undefined;
      const first = rows[0];
      const keys = Object.keys(first);
      return keys.length > 0 ? first[keys[0]!] : undefined;
    }
    return rows;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this._db.transaction(fn) as (...args: any[]) => T;
  }

  close(): void {
    this._db.close();
    this._open = false;
  }
}

/**
 * Create a database connection backed by `bun:sqlite`.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase } {
  return { db: new BunSqliteAdapter(dbPath) };
}
