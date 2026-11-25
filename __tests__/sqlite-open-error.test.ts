/**
 * A database SQLite cannot open is reported as what went wrong, with the path
 * and a short hint, not as "CodeGraph requires node:sqlite (Node.js 22.5+)".
 *
 * Before, every failure inside the SQLite connection's constructor came out as
 * that Node-version hint, so a database another program held open, one in a
 * folder the user can't write, or one on a network share sent users after
 * their Node version. A failure in the connection's first statements (locked,
 * not a database, an I/O error) came out raw, with no path. The hint is now
 * for a runtime that cannot load node:sqlite at all; the Windows/WSL shared
 * index keeps its own guidance.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, DatabaseOpenError, NodeSqliteUnavailableError, getDatabasePath } from '../src/db';
import { toDatabaseOpenError } from '../src/db/open-error';
import { WslSharedIndexError } from '../src/db/wsl-shared-index';
import { __setWslWindowsDriveForTests } from '../src/sync/watch-policy';

// Through require: vite does not resolve the node:sqlite builtin.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };
const DIST = path.resolve(__dirname, '../dist');
const BIN = path.join(DIST, 'bin', 'codegraph.js');
const { MCPEngine } = require(path.join(DIST, 'mcp', 'engine.js')) as typeof import('../src/mcp/engine');

beforeAll(() => {
  if (!fs.existsSync(BIN)) throw new Error('Build the project first (npm run build).');
});

const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  __setWslWindowsDriveForTests(null);
  for (const dir of dirs.splice(0)) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-open-error-')));
  dirs.push(dir);
  return dir;
}

/** An indexed project, closed again. */
async function indexedProject(): Promise<{ root: string; dbPath: string }> {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha(): number { return 1; }\n');
  (await CodeGraph.init(root, { index: true })).close();
  return { root, dbPath: getDatabasePath(root) };
}

/** A node:sqlite error as SQLite reports it. */
function sqliteError(errcode: number, message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: message });
}

/**
 * Hold `file` open with no sharing, as a backup or antivirus scan can on
 * Windows (libuv's UV_FS_O_EXLOCK): SQLite then can't open it at all.
 */
function holdExclusively(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDWR | 0x10000000);
  cleanups.push(() => fs.closeSync(fd));
}

/**
 * Lock the database from another connection so that no other can read it:
 * exclusive locking mode, inside a write transaction.
 */
function lockDatabase(dbPath: string): void {
  const holder = new DatabaseSync(dbPath);
  holder.exec('PRAGMA locking_mode = EXCLUSIVE');
  holder.exec('BEGIN EXCLUSIVE');
  holder.exec('CREATE TABLE IF NOT EXISTS hold_2795 (x)');
  cleanups.push(() => { holder.exec('ROLLBACK'); holder.close(); });
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('naming a failed open', () => {
  const dbPath = path.join('/projects', 'app', '.codegraph', 'codegraph.db');

  it.each([
    [14, 'unable to open database file', 'SQLITE_CANTOPEN', 'Check that the folder exists'],
    [526, 'unable to open database file', 'SQLITE_CANTOPEN', 'holds the file open'],
    [10, 'disk I/O error', 'SQLITE_IOERR', 'network share'],
    [3850, 'disk I/O error', 'SQLITE_IOERR', 'local disk'],
    [5, 'database is locked', 'SQLITE_BUSY', 'locked'],
    [26, 'file is not a database', 'SQLITE_NOTADB', 'codegraph init'],
    [11, 'database disk image is malformed', 'SQLITE_CORRUPT', 'codegraph index'],
    [8, 'attempt to write a readonly database', 'SQLITE_READONLY', 'read-only'],
  ])('reports SQLite code %i as %s, with the path and a hint', (errcode, message, name, hint) => {
    const original = sqliteError(errcode, message);
    const err = toDatabaseOpenError(original, dbPath) as DatabaseOpenError;
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.message).toContain(dbPath);
    expect(err.message).toContain(`${message} (${name}).`);
    expect(err.message).toContain(hint);
    expect(err.message).not.toContain('node:sqlite');
    expect(err.sqliteCode).toBe(name);
    // Callers branching on SQLite's codes see what they saw before.
    expect(err.code).toBe('ERR_SQLITE_ERROR');
    expect(err.errcode).toBe(errcode);
    expect(err.cause).toBe(original);
  });

  it('names a code it has no hint for, without one', () => {
    const err = toDatabaseOpenError(sqliteError(1, 'no such table: nodes'), dbPath) as DatabaseOpenError;
    expect(err.message).toBe(`Could not open the CodeGraph database at ${dbPath}: no such table: nodes (SQLITE_ERROR).`);
  });

  it('leaves alone what SQLite did not report', () => {
    const plain = new TypeError('The "path" argument must be of type string');
    expect(toDatabaseOpenError(plain, dbPath)).toBe(plain);
    const missing = new NodeSqliteUnavailableError(new Error('No such built-in module: node:sqlite'));
    expect(toDatabaseOpenError(missing, dbPath)).toBe(missing);
  });

  it('keeps the Windows/WSL guidance for an index the two share', () => {
    __setWslWindowsDriveForTests(() => true);
    const err = toDatabaseOpenError(sqliteError(10, 'disk I/O error'), '/mnt/c/app/.codegraph/codegraph.db');
    expect(err).toBeInstanceOf(WslSharedIndexError);
    expect(toDatabaseOpenError(err, '/mnt/c/app/.codegraph/codegraph.db')).toBe(err);
  });

  it('keeps the node:sqlite explanation for a runtime that cannot load it', () => {
    const err = new NodeSqliteUnavailableError(new Error('No such built-in module: node:sqlite'));
    expect(err.message).toContain('CodeGraph requires node:sqlite (Node.js 22.5+)');
    expect(err.message).toContain('No such built-in module: node:sqlite');
  });
});

describe('a database SQLite cannot open', () => {
  it('reports a path SQLite cannot open as that, not as a Node version problem', () => {
    // A directory where the file should be: SQLITE_CANTOPEN in the open itself.
    const dbPath = path.join(tempDir(), 'codegraph.db');
    fs.mkdirSync(dbPath);
    const err = thrownBy(() => DatabaseConnection.open(dbPath)) as Error;
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.message).toContain(`Could not open the CodeGraph database at ${dbPath}: unable to open database file (SQLITE_CANTOPEN).`);
    expect(err.message).not.toContain('node:sqlite');
  });

  it('reports a file that is not a database, with its path', () => {
    const dbPath = path.join(tempDir(), 'codegraph.db');
    fs.writeFileSync(dbPath, 'not a database '.repeat(300));
    const err = thrownBy(() => DatabaseConnection.open(dbPath)) as DatabaseOpenError;
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.sqliteCode).toBe('SQLITE_NOTADB');
    expect(err.message).toContain(dbPath);
    expect(err.message).toContain('codegraph init');
  });

  it('reports a database another connection keeps locked, and opens it once released', async () => {
    const { dbPath } = await indexedProject();
    lockDatabase(dbPath);
    const err = thrownBy(() => DatabaseConnection.open(dbPath)) as DatabaseOpenError;
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.sqliteCode).toBe('SQLITE_BUSY');
    expect(err.message).toContain(dbPath);
    await cleanups.pop()!();
    DatabaseConnection.open(dbPath).close();
  }, 30_000);

  it.runIf(process.platform === 'win32')('reports a database another program holds open on Windows', async () => {
    const { root, dbPath } = await indexedProject();
    holdExclusively(dbPath);
    let err: unknown;
    try {
      (await CodeGraph.open(root)).close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect((err as Error).message).toContain(`Could not open the CodeGraph database at ${dbPath}: unable to open database file (SQLITE_CANTOPEN).`);
    expect((err as Error).message).toContain('holds the file open');
    expect((err as Error).message).not.toContain('node:sqlite');
  }, 30_000);
});

/** Run the built CLI; output with colour codes removed. */
function cli(args: string[], nodeFlags: string[] = []): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [...nodeFlags, '--liftoff-only', '--disable-warning=ExperimentalWarning', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

describe('the CLI', () => {
  it.runIf(process.platform === 'win32')('names the SQLite failure in status, sync and query', async () => {
    const { root, dbPath } = await indexedProject();
    holdExclusively(dbPath);
    for (const args of [['status', root], ['sync', root], ['query', 'alpha', '--path', root]]) {
      const { status, output } = cli(args);
      expect(status, output).not.toBe(0);
      expect(output).toContain(`Could not open the CodeGraph database at ${dbPath}`);
      expect(output).toContain('(SQLITE_CANTOPEN)');
      expect(output).not.toContain('requires node:sqlite');
    }
  }, 120_000);

  it('explains a runtime without node:sqlite, without an unhandled rejection', async () => {
    const { root } = await indexedProject();
    for (const args of [['status', root], ['sync', root]]) {
      const { status, output } = cli(args, ['--no-experimental-sqlite']);
      expect(status, output).not.toBe(0);
      expect(output).toContain('CodeGraph requires node:sqlite (Node.js 22.5+)');
      expect(output).not.toContain('Unhandled rejection');
    }
  }, 120_000);
});

describe('the MCP server', () => {
  const engines: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.stop();
  });

  const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join('\n');

  it('answers a call on the default project with why its index could not be opened', async () => {
    const { root, dbPath } = await indexedProject();
    lockDatabase(dbPath);
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    await engine.ensureInitialized(root);
    expect(engine.hasDefaultCodeGraph()).toBe(false);
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alpha' });
    // A malfunction: isError, with the retry-once note, saying what failed.
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Could not open the CodeGraph database at ${dbPath}`);
    expect(text(result)).toContain('(SQLITE_BUSY)');
    expect(text(result)).toContain('Retry the call once');
    expect(text(result)).not.toContain('No CodeGraph project is loaded');
    expect(text(result)).not.toContain('internal codegraph error');
  }, 60_000);

  it('answers a projectPath call with why that index could not be opened', async () => {
    const { root, dbPath } = await indexedProject();
    lockDatabase(dbPath);
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alpha', projectPath: root });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Could not open the CodeGraph database at ${dbPath}`);
    expect(text(result)).toContain('(SQLITE_BUSY)');
    expect(text(result)).toContain('Retry the call once');
    expect(text(result)).not.toContain('node:sqlite');
  }, 60_000);

  it('still answers an unindexed default project with the not-indexed guidance', async () => {
    const root = tempDir();
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    await engine.ensureInitialized(root);
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'alpha' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('No CodeGraph project is loaded');
  }, 30_000);
});
