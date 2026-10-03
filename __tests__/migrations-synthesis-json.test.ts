import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { SynthesisStage } from '../src/db/synthesis-stage';

describe('synthesis metadata JSON boundaries and migration', () => {
  let dir: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synthesis-json-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes(['a', 'b'].map(id => ({
      id, name: id, qualifiedName: id, kind: 'function', language: 'typescript',
      filePath: `${id}.ts`, startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
      updatedAt: 0,
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const insertRaw = (metadata: string | null, line = 1) => connection.getDb().prepare(
    "INSERT INTO edges(source, target, kind, metadata, line) VALUES ('a', 'b', 'calls', ?, ?)"
  ).run(metadata, line);

  it.each([null, 'broken json {{{', 'null', '[]', '{}', '{"registeredAt":"wiring.ts:1"}'])
  ('treats unowned metadata %s as an ordinary edge', metadata => {
    insertRaw(metadata);
    expect(queries.getOutgoingEdges('a')).toHaveLength(1);
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(false);
    expect(queries.hasSynthesizedEdgesTouchingFile('b.ts')).toBe(false);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(false);
  });

  it('keeps the third-file range lookup indexed while tolerating malformed neighbors', () => {
    insertRaw('broken json {{{');
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'event-emitter', registeredAt: 'wiring.ts:12' } });
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(true);
    expect(queries.hasSynthesizedEdgesTouchingFile('b.ts')).toBe(true);
    const prepare = vi.spyOn(connection.getDb(), 'prepare');
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(true);
    const sql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.includes('FROM edges e WHERE'))!;
    expect(sql).toBeDefined();
    prepare.mockRestore();
    const plan = connection.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all('wiring.ts:', 'wiring.ts;');
    expect(plan.map(row => row.detail).join('\n'))
      .toMatch(/SEARCH e USING INDEX idx_edges_synthesis_site/);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.tsx')).toBe(false);
  });

  it('preserves malformed base edges while staging and publishing owned replacements', async () => {
    insertRaw('broken json {{{');
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'old-pass', registeredAt: 'old.ts:1' } });
    const stage = new SynthesisStage(connection.getPath());
    try {
      expect(stage.queries.getOutgoingEdges('a').map(edge => edge.line)).toEqual([1]);
      // The overlay must not shadow an existing base edge, even if its JSON is bad.
      stage.queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 1,
        metadata: { synthesizedBy: 'new-pass' } });
      stage.queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 3,
        metadata: { synthesizedBy: 'new-pass', registeredAt: 'new.ts:1' } });
      await stage.publish();
    } finally { stage.close(); }
    expect(connection.getDb().prepare('SELECT line, metadata FROM edges ORDER BY line').all()).toEqual([
      { line: 1, metadata: 'broken json {{{' },
      { line: 3, metadata: JSON.stringify({ synthesizedBy: 'new-pass', registeredAt: 'new.ts:1' }) },
    ]);
  });

  it('preserves resolver-owned Haskell calls when refreshing callback synthesis', async () => {
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 1,
      metadata: { synthesizedBy: 'haskell-combinator', haskellImportDependent: true, registeredAt: 'a.hs:1' } });
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'event-emitter', registeredAt: 'a.ts:2' } });
    const before = queries.getOutgoingEdges('a').filter(edge => edge.line === 1);
    const stage = new SynthesisStage(connection.getPath());
    try {
      expect(stage.queries.getOutgoingEdges('a')).toEqual(before);
      await stage.publish();
    } finally { stage.close(); }
    expect(queries.getOutgoingEdges('a')).toEqual(before);
  });

  it('upgrades pre-v10 malformed metadata, including legacy Go containment', () => {
    const raw = connection.getDb();
    raw.exec(`DROP INDEX idx_edges_synthesis_site;
      DROP TABLE synthesis_inputs;
      DELETE FROM schema_versions WHERE version >= 10;
      UPDATE nodes SET language = 'go', kind = CASE id WHEN 'a' THEN 'struct' ELSE 'method' END;`);
    insertRaw('broken json {{{');
    raw.prepare("INSERT INTO edges(source, target, kind, metadata) VALUES ('a', 'b', 'contains', ?)")
      .run('broken containment {{{');
    runMigrations(raw, 9);
    expect(getCurrentVersion(raw)).toBe(CURRENT_SCHEMA_VERSION);
    expect(queries.getOutgoingEdges('a', ['calls'])[0].metadata).toBeUndefined();
    expect(queries.getOutgoingEdges('a', ['contains'])[0].metadata?.synthesizedBy).toBe('go-method-contains');
    expect(queries.hasSynthesizedEdgesTouchingFile('a.ts')).toBe(true);
    insertRaw('still malformed', 2);
  });

  it.each([10, 11])('adds Haskell fingerprints to an upstream v%s index without losing rows', version => {
    const raw = connection.getDb();
    raw.exec(`ALTER TABLE files DROP COLUMN haskell_topology_hash;
      DELETE FROM schema_versions WHERE version >= 10;`);
    raw.prepare('INSERT INTO schema_versions(version, applied_at, description) VALUES (?, 0, ?)')
      .run(version, 'upstream fixture');
    insertRaw('broken json {{{');
    connection.close();

    connection = DatabaseConnection.open(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(connection.getDb().prepare('PRAGMA table_info(files)').all()
      .some(column => column.name === 'haskell_topology_hash')).toBe(true);
    expect(queries.getOutgoingEdges('a')).toHaveLength(1);
    expect(connection.getDb().prepare('SELECT COUNT(*) AS count FROM synthesis_inputs').get())
      .toEqual({ count: 0 });
  });

  it('upgrades the Haskell v10 layout with upstream synthesis and preserves fingerprints', () => {
    const raw = connection.getDb();
    raw.exec(`DROP INDEX idx_edges_synthesis_site;
      DROP TABLE synthesis_inputs;
      DROP INDEX idx_nodes_kind;
      CREATE INDEX idx_nodes_kind ON nodes(kind);
      DELETE FROM schema_versions WHERE version >= 10;
      INSERT INTO schema_versions(version, applied_at, description) VALUES (10, 0, 'Haskell topology fixture');
      INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, haskell_topology_hash)
        VALUES ('Main.hs', 'content', 'haskell', 1, 0, 0, 'preserved-topology');
      UPDATE nodes SET language = 'go', kind = CASE id WHEN 'a' THEN 'struct' ELSE 'method' END;`);
    raw.prepare("INSERT INTO edges(source, target, kind, metadata) VALUES ('a', 'b', 'contains', ?)")
      .run('broken containment {{{');
    connection.close();

    connection = DatabaseConnection.open(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(connection.getDb().prepare('SELECT haskell_topology_hash FROM files WHERE path = ?').get('Main.hs'))
      .toEqual({ haskell_topology_hash: 'preserved-topology' });
    expect(queries.getOutgoingEdges('a', ['contains'])[0].metadata?.synthesizedBy).toBe('go-method-contains');
    expect(connection.getDb().prepare("PRAGMA index_info('idx_nodes_kind')").all().map(column => column.name))
      .toEqual(['kind', 'file_path', 'start_line', 'id']);
    expect(connection.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get())
      .toEqual({ value: '1' });
    expect(connection.getDb().prepare('SELECT COUNT(*) AS count FROM synthesis_inputs').get())
      .toEqual({ count: 0 });
    const before = connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all();
    runMigrations(connection.getDb(), getCurrentVersion(connection.getDb()));
    expect(connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(before);
  });

  it('replaces the v10 index on open and safely replays the replacement', () => {
    const raw = connection.getDb();
    raw.exec(`DROP INDEX idx_edges_synthesis_site;
      CREATE INDEX idx_edges_synthesis_site ON edges(json_extract(metadata, '$.registeredAt'))
        WHERE json_extract(metadata, '$.synthesizedBy') IS NOT NULL;
      DELETE FROM schema_versions WHERE version >= 11;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (10, 0, 'legacy fixture');`);
    queries.insertEdge({ source: 'a', target: 'b', kind: 'calls', line: 2,
      metadata: { synthesizedBy: 'event-emitter', registeredAt: 'wiring.ts:12' } });
    connection.close();
    connection = DatabaseConnection.open(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    insertRaw('broken json {{{');
    const before = connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all();
    // Replay the DDL over its own output with bad JSON already present.
    connection.getDb().exec('DELETE FROM schema_versions WHERE version >= 11');
    runMigrations(connection.getDb(), 10);
    runMigrations(connection.getDb(), getCurrentVersion(connection.getDb()));
    expect(connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(before);
    expect(queries.hasSynthesizedEdgesTouchingFile('wiring.ts')).toBe(true);
  });
});
