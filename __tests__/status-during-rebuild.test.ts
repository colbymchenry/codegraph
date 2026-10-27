/**
 * `codegraph status` while another process rebuilds the index (#2913).
 *
 * Status opened the database read-write, and the open ran the writer's
 * repairs: during a rebuild's bulk load it recreated the secondary edge
 * indexes the indexer had dropped, so the indexer's next edge write failed
 * with SQLITE_BUSY_SNAPSHOT ("database is locked"). Status now opens read-only
 * and leaves the dropped indexes alone, and it says that a rebuild is running.
 *
 * The CLI runs against the built binary, as the issue's reproduction did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runStatus(cwd: string, json: boolean): string {
  return execFileSync(process.execPath, [BIN, 'status', ...(json ? ['--json'] : [])], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function statusJson(cwd: string): Record<string, unknown> {
  const line = runStatus(cwd, true).trim().split('\n').filter(Boolean).pop()!;
  return JSON.parse(line);
}

/** The secondary indexes on `edges`, the ones a bulk edge load drops. */
function edgeIndexes(conn: DatabaseConnection): string[] {
  return (conn.getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'edges' AND sql IS NOT NULL"
  ).all() as Array<{ name: string }>).map((r) => r.name).sort();
}

describe('codegraph status during an index rebuild (#2913)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-rebuild-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
    dbPath = path.join(dir, '.codegraph', 'codegraph.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Both locks name this process, as `codegraph index` writes them. */
  function holdRebuildLocks(pid: number): void {
    const lock = JSON.stringify({ pid, mode: 'rebuild', startedAt: Date.now(), ready: false });
    fs.writeFileSync(path.join(dir, '.codegraph', 'rebuild.pid'), lock);
    fs.writeFileSync(path.join(dir, '.codegraph', 'writer.pid'), lock);
  }

  it('leaves the indexes a bulk load dropped alone, so the writer goes on writing', async () => {
    const writer = DatabaseConnection.open(dbPath);
    try {
      const complete = edgeIndexes(writer);
      writer.beginBulkEdgeLoad();
      const dropped = edgeIndexes(writer);
      expect(dropped.length).toBeLessThan(complete.length);
      holdRebuildLocks(process.pid);

      const status = statusJson(dir);
      expect(status.initialized).toBe(true);
      expect(status.nodeCount).toBeGreaterThan(0);
      expect(status.rebuildInProgress).toBe(true);
      // Status repaired nothing: the bulk load's indexes are still down.
      expect(edgeIndexes(writer)).toEqual(dropped);

      // The indexer's next edge write, as it happens after status returned.
      const ids = (writer.getDb().prepare('SELECT id FROM nodes WHERE kind = ? ORDER BY start_line').all('function') as Array<{ id: string }>).map((r) => r.id);
      expect(ids.length).toBe(2);
      const queries = new QueryBuilder(writer.getDb());
      expect(() => queries.insertEdges([{ source: ids[0]!, target: ids[1]!, kind: 'references' }])).not.toThrow();
      await writer.endBulkEdgeLoad();
      expect(edgeIndexes(writer)).toEqual(complete);
    } finally {
      writer.close();
    }
  });

  it('a read-write open still recreates them: the repair stays with the writer', () => {
    const writer = DatabaseConnection.open(dbPath);
    try {
      const complete = edgeIndexes(writer);
      writer.beginBulkEdgeLoad();
      expect(edgeIndexes(writer).length).toBeLessThan(complete.length);
      const other = DatabaseConnection.open(dbPath);
      other.close();
      expect(edgeIndexes(writer)).toEqual(complete);
    } finally {
      writer.close();
    }
  });

  it('says a rebuild is running, and not when its lock belongs to a dead process', () => {
    holdRebuildLocks(process.pid);
    expect(runStatus(dir, false)).toContain('An index rebuild ("codegraph index") is running in another process');

    // A pid no process has: the lock is stale, not a rebuild.
    holdRebuildLocks(2_147_483_000);
    expect(statusJson(dir).rebuildInProgress).toBe(false);
    expect(runStatus(dir, false)).not.toContain('is running in another process');
  });

  it('reports a project with no rebuild as before', () => {
    const status = statusJson(dir);
    expect(status.rebuildInProgress).toBe(false);
    expect(status.nodeCount).toBeGreaterThan(0);
    expect(runStatus(dir, false)).toContain('Index Statistics');
  });
});
