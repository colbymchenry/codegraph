/**
 * Opening a CodeGraph database failed in SQLite itself: report what SQLite
 * said, with the database's path and a short hint at the usual cause. Before,
 * every such failure came out as "CodeGraph requires node:sqlite (Node.js
 * 22.5+)", which sent users after their Node version when the file was locked,
 * unreadable, or on a network share. That hint is now only for a runtime that
 * cannot load `node:sqlite` at all (./node-sqlite.ts); an index Windows and WSL
 * share keeps its own guidance (./wsl-shared-index.ts).
 */

import { NodeSqliteUnavailableError } from './node-sqlite';
import { toWslSharedIndexError, WslSharedIndexError } from './wsl-shared-index';

/** SQLite's primary result codes, by number. node:sqlite reports the extended code; its low byte is the primary one. */
const SQLITE_CODE_NAMES: readonly string[] = [
  'SQLITE_OK', 'SQLITE_ERROR', 'SQLITE_INTERNAL', 'SQLITE_PERM', 'SQLITE_ABORT', 'SQLITE_BUSY',
  'SQLITE_LOCKED', 'SQLITE_NOMEM', 'SQLITE_READONLY', 'SQLITE_INTERRUPT', 'SQLITE_IOERR',
  'SQLITE_CORRUPT', 'SQLITE_NOTFOUND', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL',
  'SQLITE_EMPTY', 'SQLITE_SCHEMA', 'SQLITE_TOOBIG', 'SQLITE_CONSTRAINT', 'SQLITE_MISMATCH',
  'SQLITE_MISUSE', 'SQLITE_NOLFS', 'SQLITE_AUTH', 'SQLITE_FORMAT', 'SQLITE_RANGE', 'SQLITE_NOTADB',
];

/** What to check, for the failures an open meets in practice. */
const HINTS: Readonly<Record<string, string>> = {
  SQLITE_BUSY: 'Another process has the database locked; retry when it is done.',
  SQLITE_PERM: 'Check that you can read and write the file and its folder.',
  SQLITE_READONLY: 'The database or its folder is read-only, and CodeGraph has to write its index there.',
  SQLITE_IOERR:
    'SQLite could not read or write the file. On a network share, or another filesystem without ' +
    'reliable file locking, keep the project and its index on a local disk.',
  SQLITE_CORRUPT: 'The database is damaged; run "codegraph index" to rebuild it.',
  SQLITE_FULL: 'The disk is full.',
  SQLITE_CANTOPEN:
    'Check that the folder exists and that you can read and write it, and that no other program ' +
    '(a backup or antivirus scan, say) holds the file open.',
  SQLITE_NOTADB: 'The file is not a SQLite database; move it aside and run "codegraph init" to build a new index.',
};

/** A failure SQLite reported while opening the database at `dbPath`. */
export class DatabaseOpenError extends Error {
  /** node:sqlite's error code ("ERR_SQLITE_ERROR"), kept from the original. */
  readonly code: unknown;
  /** SQLite's extended result code, kept from the original. */
  readonly errcode: unknown;
  readonly errstr: unknown;
  /** SQLite's name for the primary result code, e.g. "SQLITE_CANTOPEN". */
  readonly sqliteCode: string;
  readonly dbPath: string;

  constructor(original: Error, dbPath: string) {
    const codes = original as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
    const primary = typeof codes.errcode === 'number' ? codes.errcode & 0xff : -1;
    const sqliteCode = SQLITE_CODE_NAMES[primary] ?? `SQLite error ${String(codes.errcode)}`;
    const hint = HINTS[sqliteCode];
    super(
      `Could not open the CodeGraph database at ${dbPath}: ${original.message} (${sqliteCode}).${hint ? ` ${hint}` : ''}`,
      { cause: original }
    );
    this.name = 'DatabaseOpenError';
    this.code = codes.code;
    this.errcode = codes.errcode;
    this.errstr = codes.errstr;
    this.sqliteCode = sqliteCode;
    this.dbPath = dbPath;
  }
}

/**
 * The error to throw for `err`, raised while opening the database at
 * `dbPath`: the Windows/WSL guidance for an index the two share, a
 * {@link DatabaseOpenError} for any other failure SQLite reported (it carries
 * a result code), and anything else unchanged, the missing-`node:sqlite`
 * explanation included.
 */
export function toDatabaseOpenError(err: unknown, dbPath: string): unknown {
  if (err instanceof DatabaseOpenError || err instanceof WslSharedIndexError || err instanceof NodeSqliteUnavailableError) {
    return err;
  }
  const shared = toWslSharedIndexError(err, dbPath);
  if (shared) return shared;
  if (err instanceof Error && typeof (err as { errcode?: unknown }).errcode === 'number') {
    return new DatabaseOpenError(err, dbPath);
  }
  return err;
}

/**
 * A project's index exists but could not be opened: what a caller reports as
 * that, not as "no index here". The Windows/WSL case has its own guidance.
 */
export function isDatabaseOpenFailure(err: unknown): err is DatabaseOpenError | NodeSqliteUnavailableError {
  return err instanceof DatabaseOpenError || err instanceof NodeSqliteUnavailableError;
}
