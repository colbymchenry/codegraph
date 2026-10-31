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

  it('runs inside the writer\'s edge transaction without failing its insert', () => {
    // The issue's interleaving: the writer reads its endpoints inside the
    // transaction, status runs in another process, then the writer inserts.
    // Read-write, status recreated the dropped indexes in between and the
    // insert failed with SQLITE_BUSY_SNAPSHOT (517), "database is locked".
    const writer = DatabaseConnection.open(dbPath);
    try {
      writer.beginBulkEdgeLoad();
      holdRebuildLocks(process.pid);
      const db = writer.getDb();
      const ids = (db.prepare('SELECT id FROM nodes WHERE kind = ? ORDER BY start_line').all('function') as Array<{ id: string }>).map((r) => r.id);
      const edgeCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
      const before = edgeCount();
      const queries = new QueryBuilder(db);
      // The endpoint read is private; hook it as the issue's reproduction did.
      const hooked = queries as unknown as { getExistingNodeIds: (ids: readonly string[]) => Set<string> };
      const readEndpoints = hooked.getExistingNodeIds.bind(queries);
      let status: Record<string, unknown> | undefined;
      hooked.getExistingNodeIds = (endpointIds) => {
        const existing = readEndpoints(endpointIds);
        status = statusJson(dir);
        return existing;
      };
      expect(() => queries.insertEdges([{ source: ids[0]!, target: ids[1]!, kind: 'references' }])).not.toThrow();
      expect(status?.rebuildInProgress).toBe(true);
      expect(edgeCount()).toBe(before + 1);
    } finally {
      writer.close();
    }
  });

  it('gives no advice meant for an index at rest while a rebuild runs', () => {
    // Mid-rebuild, pending references are the run's own work and the version
    // stamps are not written yet: "run sync" or "re-index" would be advice
    // against the rebuild itself.
    const conn = DatabaseConnection.open(dbPath);
    try {
      const db = conn.getDb();
      const from = (db.prepare("SELECT id FROM nodes WHERE kind = 'function' LIMIT 1").get() as { id: string }).id;
      db.prepare(
        "INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?, 'later', 'calls', 1, 0, 'a.ts', 'typescript')"
      ).run(from);
      db.exec("DELETE FROM project_metadata WHERE key IN ('indexed_with_version', 'indexed_with_extraction_version')");
    } finally {
      conn.close();
    }

    holdRebuildLocks(process.pid);
    const during = runStatus(dir, false);
    expect(during).toContain('is running in another process');
    expect(during).toContain('Index Statistics');
    expect(during).not.toContain('from an interrupted run');
    expect(during).not.toContain('Run "codegraph');

    // The same index at rest, its rebuild lock left by a dead process.
    holdRebuildLocks(2_147_483_000);
    const atRest = runStatus(dir, false);
    expect(atRest).toContain('1 references from an interrupted run are awaiting resolution');
    expect(atRest).toContain('re-index to pick up');
  });
});

describe('codegraph status on an index an older release built (#2913)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-status-legacy-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function a() { return b(); }\nexport function b() { return 1; }\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close();
    dbPath = path.join(dir, '.codegraph', 'codegraph.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads one from before schema v8 as it is, without upgrading it', () => {
    // Up to 1.4.0 a reference carried no status: the v8 migration marks every
    // row pending. Status opens read-only, so it reads the index unmigrated.
    const conn = DatabaseConnection.open(dbPath);
    try {
      const db = conn.getDb();
      const from = (db.prepare("SELECT id FROM nodes WHERE kind = 'function' LIMIT 1").get() as { id: string }).id;
      const onStatus = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'unresolved_refs' AND (sql LIKE '%status%' OR sql LIKE '%name_tail%')"
      ).all() as Array<{ name: string }>;
      for (const { name } of onStatus) db.exec(`DROP INDEX ${name}`);
      db.exec('ALTER TABLE unresolved_refs DROP COLUMN status');
      db.exec('ALTER TABLE unresolved_refs DROP COLUMN name_tail');
      // A reference an interrupted run left behind.
      db.prepare(
        "INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language) VALUES (?, 'missing', 'calls', 1, 0, 'a.ts', 'typescript')"
      ).run(from);
      db.exec("DELETE FROM schema_versions; INSERT INTO schema_versions (version, applied_at, description) VALUES (7, 0, 'legacy')");
    } finally {
      conn.close();
    }

    const status = statusJson(dir);
    expect(status.nodeCount).toBeGreaterThan(0);
    expect((status.index as { pendingRefs: number }).pendingRefs).toBe(1);
    expect(runStatus(dir, false)).toContain('1 references from an interrupted run are awaiting resolution');

    const after = DatabaseConnection.open(dbPath, { readOnly: true });
    try {
      expect(after.getSchemaVersion()?.version).toBe(7);
    } finally {
      after.close();
    }
  });

  it('names only the full rebuild when an older engine built it', () => {
    const conn = DatabaseConnection.open(dbPath);
    try {
      conn.getDb().exec("UPDATE project_metadata SET value = '1' WHERE key = 'indexed_with_extraction_version'");
    } finally {
      conn.close();
    }

    // sync leaves unchanged files as the older engine read them.
    const out = runStatus(dir, false);
    expect(out).toContain('re-index to pick up');
    expect(out).toContain('Run "codegraph index" for a full rebuild');
    expect(out).not.toContain('codegraph sync');
  });
});
