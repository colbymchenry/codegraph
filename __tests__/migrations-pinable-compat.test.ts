import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter';
import {
  CURRENT_SCHEMA_VERSION, getCurrentVersion, getMigrationHistory,
  getPendingMigrations, runMigrations,
} from '../src/db/migrations';

const cursorIndexes = {
  idx_edges_source_id: ['source', 'id'],
  idx_edges_target_id: ['target', 'id'],
  idx_nodes_file_id: ['file_path', 'id'],
};
type Legacy = 'v9' | 'pinable-v10' | 'upstream-v10' | 'upstream-v11';

describe('Pinable/upstream schema-version collision (#2060)', () => {
  let dir: string | undefined;
  let connection: DatabaseConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fixture(origin: Legacy): { dbPath: string; version: number; ordinaryMetadata: string } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pinable-migration-'));
    const dbPath = path.join(dir, 'index.db');
    const raw = createDatabase(dbPath).db;
    const version = origin === 'v9' ? 9 : origin === 'upstream-v11' ? 11 : 10;
    const legacySynthesis = origin === 'v9' || origin === 'pinable-v10';
    const ordinaryMetadata = origin === 'upstream-v10' ? '{"keep":true}' : 'malformed ordinary metadata';
    try {
      // Keep the full real SQLite schema, then remove only the features that
      // these historical versions did not contain. No database mocking.
      raw.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
      raw.exec('DELETE FROM schema_versions');
      raw.prepare('INSERT INTO schema_versions VALUES (?, 0, ?)').run(version, origin);
      if (origin !== 'pinable-v10') {
        for (const index of Object.keys(cursorIndexes)) raw.exec(`DROP INDEX ${index}`);
      }
      if (legacySynthesis) {
        raw.exec(`DROP TABLE synthesis_inputs;
          DROP INDEX idx_edges_synthesis_site;
          DROP INDEX idx_nodes_kind;
          CREATE INDEX idx_nodes_kind ON nodes(kind);`);
      } else {
        raw.prepare('INSERT INTO project_metadata VALUES (?, ?, ?)').run('synthesis_pending', '0', 7);
        if (origin === 'upstream-v10') {
          raw.exec(`DROP INDEX idx_edges_synthesis_site;
            CREATE INDEX idx_edges_synthesis_site ON edges(json_extract(metadata, '$.registeredAt'))
              WHERE json_extract(metadata, '$.synthesizedBy') IS NOT NULL;`);
        }
      }
      raw.prepare('INSERT INTO project_metadata VALUES (?, ?, ?)').run('user_marker', 'unchanged', 7);
      for (const [id, kind, file] of [['owner', 'struct', 'types.go'], ['method', 'method', 'methods.go']]) {
        raw.prepare(`INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at)
          VALUES (?, 'hash', 'go', 100, 0, 0)`).run(file);
        raw.prepare(`INSERT INTO nodes(id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column, updated_at)
          VALUES (?, ?, ?, ?, ?, 'go', 1, 2, 0, 1, 0)`).run(id, kind, id, id, file);
      }
      const containment = legacySynthesis ? { keep: true } : { keep: true, synthesizedBy: 'go-method-contains' };
      raw.prepare("INSERT INTO edges(source, target, kind, metadata) VALUES ('owner', 'method', 'contains', ?)")
        .run(JSON.stringify(containment));
      raw.prepare("INSERT INTO edges(source, target, kind, metadata) VALUES ('owner', 'method', 'calls', ?)")
        .run(ordinaryMetadata);
    } finally { raw.close(); }
    return { dbPath, version, ordinaryMetadata };
  }

  function assertSchema(db: SqliteDatabase): void {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(15);
    expect(getPendingMigrations(db)).toEqual([]);
    expect(() => db.prepare('SELECT file_path FROM synthesis_inputs').all()).not.toThrow();
    for (const [index, columns] of Object.entries({
      ...cursorIndexes, idx_nodes_kind: ['kind', 'file_path', 'start_line', 'id'],
    })) {
      expect(db.prepare(`PRAGMA index_info(${index})`).all().map(row => row.name)).toEqual(columns);
    }
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_edges_synthesis_site'").get().sql;
    expect(sql).toContain('json_valid(metadata)');
  }

  it.each<Legacy>(['v9', 'pinable-v10', 'upstream-v10', 'upstream-v11'])
  ('opens %s without losing graph data, synthesis state or pagination indexes', origin => {
    const { dbPath, version, ordinaryMetadata } = fixture(origin);
    connection = DatabaseConnection.open(dbPath);
    const db = connection.getDb();
    assertSchema(db);
    expect(db.prepare('SELECT id FROM nodes ORDER BY id').all()).toEqual([{ id: 'method' }, { id: 'owner' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM edges').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get().n).toBe(2);
    expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'user_marker'").get().value).toBe('unchanged');
    expect(db.prepare("SELECT metadata FROM edges WHERE kind = 'calls'").get().metadata).toBe(ordinaryMetadata);
    expect(JSON.parse(db.prepare("SELECT metadata FROM edges WHERE kind = 'contains'").get().metadata))
      .toEqual({ keep: true, synthesizedBy: 'go-method-contains' });
    expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get().value)
      .toBe(origin === 'v9' || origin === 'pinable-v10' ? '1' : '0');
    expect(db.prepare('SELECT description FROM schema_versions WHERE version = ?').get(version).description).toBe(origin);

    // After synthesis completes, a no-op reopen and a replay of the new
    // additive migration must not dirty the graph or request synthesis again.
    db.exec("UPDATE project_metadata SET value = '0' WHERE key = 'synthesis_pending'");
    const rows = db.prepare('SELECT * FROM edges ORDER BY id').all();
    const history = getMigrationHistory(db);
    runMigrations(db, getCurrentVersion(db));
    expect(getMigrationHistory(db)).toEqual(history);
    connection.close();
    connection = DatabaseConnection.open(dbPath);
    expect(getMigrationHistory(connection.getDb())).toEqual(history);
    connection.getDb().exec('DELETE FROM schema_versions WHERE version >= 12');
    runMigrations(connection.getDb(), 11);
    assertSchema(connection.getDb());
    expect(connection.getDb().prepare('SELECT * FROM edges ORDER BY id').all()).toEqual(rows);
    expect(connection.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get().value).toBe('0');
  });

  it('gives a fresh database the same synthesis and cursor schema', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pinable-fresh-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'index.db'));
    assertSchema(connection.getDb());
  });
});
