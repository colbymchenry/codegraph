/**
 * Reopen a DB connection when its file is replaced under us (same path, new
 * inode). Regression for issue #925.
 *
 * Scenario: the project dir is removed and recreated at the same path (a
 * `git worktree remove` + `git worktree add`, or a fresh `codegraph init`).
 * A long-lived SQLite handle keeps reading the old, now-unlinked inode while
 * `init`/`sync` write to the new inode at the same path — so the MCP server
 * served a stale snapshot for the life of the daemon. Four layers are covered:
 *   1. `DatabaseConnection.isFileReplaced()` — the inode-identity primitive.
 *   2. `CodeGraph.isDbReplaced()` — a live instance reports its DB was swapped.
 *   3. `ToolHandler.liveCachedGraph()` — a cross-project (`projectPath`) cache
 *      hit on a replaced DB is evicted + closed, so the caller reopens against
 *      the new inode (the existing open path) instead of serving the stale one.
 *   4. `ToolHandler.getCodeGraph()` default path — a swapped default project is
 *      reopened via the engine reload hook (the steady-state tool-call path,
 *      which the cold init methods never re-enter — issue #925's headline case).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import { ToolHandler } from '../src/mcp/tools';

const rmDb = (dbPath: string) => {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
};

describe('DatabaseConnection.isFileReplaced (issue #925)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dbid-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('false while the same file; true after the file at the path is swapped; false while missing', () => {
    const dbPath = path.join(dir, 'graph.db');
    const conn = DatabaseConnection.initialize(dbPath); // records inode A
    expect(conn.isFileReplaced()).toBe(false);

    // Replace the file at the same path with a brand-new inode (the recreate).
    rmDb(dbPath);
    DatabaseConnection.initialize(dbPath).close(); // creates inode B at the same path
    expect(conn.isFileReplaced()).toBe(true);

    // Mid-recreate gap (file absent) must NOT count — don't churn on a transient.
    rmDb(dbPath);
    expect(conn.isFileReplaced()).toBe(false);

    conn.close();
  });
});

describe('Reopen on replaced project DB (issue #925)', () => {
  let dir: string;

  const buildProject = async (fnName: string) => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'probe.ts'), `export function ${fnName}() { return 1; }\n`);
    const cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
  };
  const replaceProjectDb = async (fnName: string) => {
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    await buildProject(fnName);
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-db-reopen-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('CodeGraph.isDbReplaced flips after the DB file is recreated at the same path', async () => {
    await buildProject('probeAlpha');
    const cg = CodeGraph.openSync(dir);
    try {
      expect(cg.isDbReplaced()).toBe(false);
      await replaceProjectDb('probeBeta'); // new .codegraph/codegraph.db = new inode
      expect(cg.isDbReplaced()).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('ToolHandler.liveCachedGraph evicts + closes a cached project whose DB file was replaced', async () => {
    await buildProject('probeAlpha');
    const cg = CodeGraph.openSync(dir);
    const closeSpy = vi.spyOn(cg, 'close');
    const handler = new ToolHandler(null);
    // Seed the cross-project cache the way getCodeGraph would (private field).
    (handler as unknown as { projectCache: Map<string, CodeGraph> }).projectCache.set(dir, cg);
    const live = (k: string) => (handler as unknown as { liveCachedGraph(k: string): CodeGraph | null }).liveCachedGraph(k);
    const cached = () => (handler as unknown as { projectCache: Map<string, CodeGraph> }).projectCache;

    // Fresh → returned as-is, not evicted/closed.
    expect(live(dir)).toBe(cg);
    expect(closeSpy).not.toHaveBeenCalled();

    // Replace the DB file at the same path → next lookup evicts + closes it,
    // returning null so the caller falls through to reopen against the new DB.
    await replaceProjectDb('probeBeta');
    expect(live(dir)).toBeNull();
    expect(cached().has(dir)).toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('getCodeGraph reopens the DEFAULT project via the reload hook when its DB file was replaced', async () => {
    await buildProject('probeAlpha');
    const stale = CodeGraph.openSync(dir);
    const handler = new ToolHandler(stale);
    // Mirror the engine's reload hook: open the fresh DB and install it as default.
    let hookCalls = 0;
    handler.setDefaultReloadHook(() => {
      hookCalls++;
      handler.setDefaultCodeGraph(CodeGraph.openSync(dir));
    });
    const getDefault = () =>
      (handler as unknown as { getCodeGraph(p?: string): CodeGraph }).getCodeGraph();

    // Fresh default → served as-is on the steady-state (no-projectPath) path; hook not fired.
    expect(getDefault()).toBe(stale);
    expect(hookCalls).toBe(0);

    // Replace the DB at the same path → the default-serving path detects it and
    // fires the hook, which installs a fresh default; the call returns the new one.
    await replaceProjectDb('probeBeta');
    const reopened = getDefault();
    expect(hookCalls).toBe(1);
    expect(reopened).not.toBe(stale);
    expect(reopened.isDbReplaced()).toBe(false); // fresh handle on the new inode

    stale.close();
    reopened.close();
  });
});
