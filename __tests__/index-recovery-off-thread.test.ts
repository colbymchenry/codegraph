/**
 * Recovery of an interrupted bulk load runs off the event loop (#1887).
 *
 * A run killed inside a bulk-load window (a crash, an OOM kill, the liveness
 * watchdog) leaves the window's secondary indexes dropped, and the next open
 * rebuilds them (#1556). Rebuilding one scans and sorts its whole table, so on
 * a large index the rebuild ran for minutes on the opener's main thread: an MCP
 * server's liveness watchdog killed it before the index committed, and every
 * restart was killed the same way. Opens on a watched event loop now leave the
 * rebuild to a worker thread with its own connection, and wait for it before
 * the project is served.
 *
 * The spies record the SQL every connection on THIS thread runs: a rebuild
 * here shows up as a CREATE INDEX. Everything runs against the built dist, as
 * the MCP engine tests do (the engine lazy-loads the CodeGraph chain).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIST = path.resolve(__dirname, '../dist');
const CodeGraph = (require(path.join(DIST, 'index.js')) as typeof import('../src/index')).default;
const { DatabaseConnection, getDatabasePath } = require(path.join(DIST, 'db', 'index.js')) as typeof import('../src/db');
const { createDatabase } = require(path.join(DIST, 'db', 'sqlite-adapter.js')) as typeof import('../src/db/sqlite-adapter');
const { MCPEngine } = require(path.join(DIST, 'mcp', 'engine.js')) as typeof import('../src/mcp/engine');

beforeAll(() => {
  if (!fs.existsSync(path.join(DIST, 'index.js'))) throw new Error('Build the project first (npm run build).');
});

/** The indexes the resolution phase's ref and edge windows drop. */
const WINDOW_INDEXES = [
  'idx_unresolved_from_node', 'idx_unresolved_name', 'idx_unresolved_file_path', 'idx_unresolved_from_name',
  'idx_unresolved_failed_tail', 'idx_edges_kind', 'idx_edges_source_kind', 'idx_edges_target_kind',
  'idx_edges_provenance', 'idx_edges_synthesis_site',
];

const dirs: string[] = [];
const engines: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of dirs.splice(0)) {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

/**
 * A project whose index a killed run left inside the resolution phase's bulk
 * window: rows in place, the window's ten indexes dropped. `failed` refs keep a
 * catch-up sync from resolving them again.
 */
function interruptedProject(rows: { nodes: number; refs: number; edges: number }): { root: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-recover-'));
  dirs.push(root);
  CodeGraph.initSync(root).close();
  const dbPath = getDatabasePath(root);
  const conn = DatabaseConnection.open(dbPath);
  const db = conn.getDb();
  conn.beginBulkNodeLoad();
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows.nodes - 1})
    INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
    SELECT 'n' || i, 'function', 'fn_' || (i * 7919 % ${rows.nodes}), 'mod.fn_' || i, 'src/f' || (i % 500) || '.ts', 'typescript', i, i + 3, 0, 1, 0 FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows.refs - 1})
    INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
    SELECT 'n' || (i % ${rows.nodes}), 'callee_' || (i * 104729 % 1000003), 'calls', i % 2000, i % 80,
      'src/f' || (i * 31 % 500) || '.ts', 'typescript', 'failed', 'tail_' || (i * 13 % 50021) FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows.edges - 1})
    INSERT OR IGNORE INTO edges (source, target, kind, line, col, provenance)
    SELECT 'n' || (i % ${rows.nodes}), 'n' || (i * 7907 % ${rows.nodes}), CASE i % 2 WHEN 0 THEN 'calls' ELSE 'references' END,
      i, 0, CASE WHEN i % 10 = 0 THEN 'heuristic' ELSE NULL END FROM n`);
  conn.endBulkNodeLoad();
  conn.beginBulkRefLoad();
  conn.beginBulkEdgeLoad();
  conn.close();
  return { root, dbPath };
}

/** Which of the window's indexes the database holds now. */
function presentWindowIndexes(dbPath: string): string[] {
  const { db } = createDatabase(dbPath, { readOnly: true });
  try {
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name));
    return WINDOW_INDEXES.filter((name) => names.has(name));
  } finally {
    db.close();
  }
}

/** Record the index DDL every connection on this thread runs from now on. */
function spyOnIndexDdl(): string[] {
  const { db: probe } = createDatabase(':memory:');
  const proto = Object.getPrototypeOf(probe) as { exec(sql: string): void; prepare(sql: string): unknown };
  probe.close();
  const seen: string[] = [];
  const record = (sql: string): void => { if (/^\s*CREATE\s+INDEX/i.test(sql)) seen.push(sql); };
  const exec = proto.exec;
  const prepare = proto.prepare;
  vi.spyOn(proto, 'exec').mockImplementation(function (this: unknown, sql: string) { record(sql); return exec.call(this, sql); });
  vi.spyOn(proto, 'prepare').mockImplementation(function (this: unknown, sql: string) { record(sql); return prepare.call(this, sql); });
  return seen;
}

const SMALL = { nodes: 2000, refs: 20000, edges: 5000 };

describe('recovering an interrupted bulk load off the event loop (#1887)', () => {
  it('leaves a deferred rebuild to a worker that restores every index', async () => {
    const { dbPath } = interruptedProject(SMALL);
    expect(presentWindowIndexes(dbPath)).toEqual([]);
    const seen = spyOnIndexDdl();
    const conn = DatabaseConnection.open(dbPath, { deferIndexRecovery: true });
    try {
      expect(conn.hasDeferredIndexRecovery()).toBe(true);
      expect(presentWindowIndexes(dbPath)).toEqual([]);
      const first = conn.recoverIndexesOffThread();
      expect(conn.recoverIndexesOffThread()).toBe(first); // one rebuild at a time
      await first;
      expect(conn.hasDeferredIndexRecovery()).toBe(false);
      expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
      await conn.recoverIndexesOffThread(); // nothing left: resolves at once
    } finally {
      conn.close();
    }
    expect(seen).toEqual([]);
  }, 30_000);

  it('defers nothing on a healthy index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-recover-'));
    dirs.push(root);
    CodeGraph.initSync(root).close();
    const conn = DatabaseConnection.open(getDatabasePath(root), { deferIndexRecovery: true });
    try {
      expect(conn.hasDeferredIndexRecovery()).toBe(false);
    } finally {
      conn.close();
    }
  });

  it('opens with CodeGraph.open() only once the indexes are back, rebuilt off this thread', async () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const seen = spyOnIndexDdl();
    const cg = await CodeGraph.open(root);
    try {
      expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
      expect(cg.hasPendingIndexRecovery()).toBe(false);
    } finally {
      cg.close();
    }
    expect(seen).toEqual([]);
  }, 30_000);

  it('still rebuilds in line for a synchronous open that asks for no deferral', () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const cg = CodeGraph.openSync(root);
    cg.close();
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
  }, 30_000);

  it('serves a projectPath call once the indexes are back, without rebuilding on the server thread', async () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    const seen = spyOnIndexDdl();
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'fn_1', projectPath: root });
    expect(result.isError).toBeFalsy();
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
    expect(seen).toEqual([]);
  }, 30_000);

  it('rebuilds before a watched projectPath project is caught up and served', async () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const engine = new MCPEngine({ watch: true });
    engines.push(engine);
    const seen = spyOnIndexDdl();
    // The catch-up sync writes through the main connection; started during the
    // rebuild it would wait out the rebuild's write lock with this thread blocked.
    const events: string[] = [];
    const recover = CodeGraph.prototype.recoverIndexes;
    vi.spyOn(CodeGraph.prototype, 'recoverIndexes').mockImplementation(function (this: InstanceType<typeof CodeGraph>) {
      const pending = this.hasPendingIndexRecovery();
      return recover.call(this).then(() => { if (pending) events.push('rebuilt'); });
    });
    const sync = CodeGraph.prototype.sync;
    vi.spyOn(CodeGraph.prototype, 'sync').mockImplementation(function (this: InstanceType<typeof CodeGraph>, ...args) {
      events.push('sync');
      return sync.apply(this, args);
    });
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'fn_1', projectPath: root });
    expect(result.isError).toBeFalsy();
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
    expect(seen).toEqual([]);
    expect(events[0]).toBe('rebuilt');
    expect(events).toContain('sync');
  }, 30_000);

  it('opens the default project at once on the retry path and serves it rebuilt', async () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    const seen = spyOnIndexDdl();
    engine.retryInitializeSync(root);
    expect(engine.hasDefaultCodeGraph()).toBe(true);
    const result = await engine.getToolHandler().execute('codegraph_search', { query: 'fn_1' });
    expect(result.isError).toBeFalsy();
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
    expect(seen).toEqual([]);
  }, 30_000);

  it('opens the default project with the indexes back on the startup path', async () => {
    const { root, dbPath } = interruptedProject(SMALL);
    const engine = new MCPEngine({ watch: false });
    engines.push(engine);
    const seen = spyOnIndexDdl();
    await engine.ensureInitialized(root);
    expect(engine.hasDefaultCodeGraph()).toBe(true);
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
    expect(seen).toEqual([]);
  }, 30_000);

  /**
   * End to end with the real liveness watchdog, armed for heartbeats only and
   * with a short timeout: a rebuild on the opener's thread is one silent block
   * of about a second on this index and gets the process killed; off the
   * thread, the heartbeat never stops.
   */
  it('keeps a watched process alive while CodeGraph.open() rebuilds a large index', async () => {
    const { root, dbPath } = interruptedProject({ nodes: 10000, refs: 300000, edges: 150000 });
    const watchdog = path.join(DIST, 'mcp', 'liveness-watchdog.js');
    const child = spawn(process.execPath, ['-e', `
      (async () => {
        const { default: CodeGraph, initGrammars } = require(${JSON.stringify(path.join(DIST, 'index.js'))});
        await initGrammars(); // grammar loading is not what this measures
        require(${JSON.stringify(watchdog)}).installMainThreadWatchdog();
        const cg = await CodeGraph.open(${JSON.stringify(root)});
        cg.close();
        process.exit(0);
      })().catch((err) => { console.error(err); process.exit(23); });
    `], {
      env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '0', CODEGRAPH_WATCHDOG_TIMEOUT_MS: '500' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    expect(stderr).not.toContain('Main thread unresponsive');
    expect(code, stderr).toBe(0);
    expect(presentWindowIndexes(dbPath)).toEqual(WINDOW_INDEXES);
  }, 60_000);
});
