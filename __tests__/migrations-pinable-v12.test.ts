import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, getMigrationHistory, runMigrations } from '../src/db/migrations';

const cursors = ['idx_edges_source_id', 'idx_edges_target_id', 'idx_nodes_file_id'];
const retryIndexes = ['idx_unresolved_failed_import_tail', 'idx_unresolved_failed_import_name'];

describe('Pinable v12 adoption of upstream v12-v15 without another version collision', () => {
  let dir: string | undefined;
  let connection: DatabaseConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function fixture(version = 12, legacyImports = true): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pinable-v12-'));
    const dbPath = path.join(dir, 'index.db');
    connection = DatabaseConnection.initialize(dbPath);
    const db = connection.getDb();
    db.exec('DELETE FROM schema_versions');
    db.prepare('INSERT INTO schema_versions VALUES (?, 123, ?)').run(version, 'original history, do not replace');
    for (const name of cursors) db.exec(`DROP INDEX ${name}`);
    if (legacyImports) for (const name of retryIndexes) db.exec(`DROP INDEX ${name}`);
    if (version < 15) db.exec('DROP INDEX idx_unresolved_failed_module_name');
    db.prepare('INSERT INTO project_metadata VALUES (?, ?, ?)').run('synthesis_pending', '0', 7);
    db.prepare("INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at) VALUES ('a.dart', 'hash', 'dart', 10, 0, 0)").run();
    db.prepare(`INSERT INTO nodes(id, kind, name, qualified_name, file_path, language,
      start_line, end_line, start_column, end_column, updated_at)
      VALUES ('a', 'file', 'a.dart', 'a.dart', 'a.dart', 'dart', 1, 2, 0, 1, 0)`).run();
    for (const [name, kind, status, tail] of [
      ['package:app/b.dart', 'imports', 'failed', legacyImports ? 'dart' : 'b'],
      ['c.h', 'imports', 'failed', 'h'],
      ['pending/path.dart', 'imports', 'pending', 'dart'],
      ['snippets/price.liquid', 'references', 'failed', version < 13 ? 'liquid' : 'price.liquid'],
      ['lazy-import:./pages/Team', 'references', 'failed', version < 14 ? '/pages/Team' : 'module:Team'],
      ['lists::map/2', 'calls', 'failed', 'map'],
    ]) {
      db.prepare(`INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col, file_path, language, status, name_tail)
        VALUES ('a', ?, ?, 1, 0, 'a.dart', 'dart', ?, ?)`).run(name, kind, status, tail);
    }
    return dbPath;
  }

  const tails = () => connection!.getDb().prepare('SELECT reference_name, status, name_tail FROM unresolved_refs ORDER BY id').all();
  const hasIndex = (name: string) => !!connection!.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

  it('repairs legacy v12 imports, applies v13-v15, and preserves the occupied v12 history', () => {
    const dbPath = fixture();
    connection!.close();
    connection = DatabaseConnection.open(dbPath);
    expect(getCurrentVersion(connection.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    expect(getMigrationHistory(connection.getDb()).map(row => row.version)).toEqual([12, 13, 14, 15]);
    expect(getMigrationHistory(connection.getDb())[0]).toEqual({version: 12, appliedAt: 123, description: 'original history, do not replace'});
    for (const name of [...cursors, ...retryIndexes, 'idx_unresolved_failed_module_name']) expect(hasIndex(name)).toBe(true);
    expect(tails().map(row => row.name_tail)).toEqual(['b', 'h', 'dart', 'price.liquid', 'module:Team', 'map']);
    expect(connection.getDb().prepare('SELECT COUNT(*) AS n FROM nodes').get().n).toBe(1);
    expect(connection.getDb().prepare('SELECT COUNT(*) AS n FROM unresolved_refs').get().n).toBe(6);
    expect(connection.getDb().prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get().value).toBe('0');
  });

  it('adopts an upstream v12 database without replaying its correct import rewrite', () => {
    const dbPath = fixture(12, false);
    const before = tails().slice(0, 3);
    connection!.close();
    connection = DatabaseConnection.open(dbPath);
    expect(tails().slice(0, 3)).toEqual(before);
    expect(tails().map(row => row.name_tail)).toEqual(['b', 'h', 'dart', 'price.liquid', 'module:Team', 'map']);
    for (const name of cursors) expect(hasIndex(name)).toBe(true);
  });

  it('adds cursor indexes even when the upstream version is already current', () => {
    const dbPath = fixture(15, false);
    const history = getMigrationHistory(connection!.getDb());
    const rows = tails();
    connection!.close();
    connection = DatabaseConnection.open(dbPath);
    for (const name of cursors) expect(hasIndex(name)).toBe(true);
    expect(getMigrationHistory(connection.getDb())).toEqual(history);
    expect(tails()).toEqual(rows);
  });

  it.each(retryIndexes)('repairs when just %s is missing', missing => {
    fixture(15, false);
    connection!.getDb().exec(`DROP INDEX ${missing}`);
    connection!.getDb().prepare('UPDATE unresolved_refs SET name_tail = ? WHERE reference_name = ?').run('dart', 'package:app/b.dart');
    runMigrations(connection!.getDb(), 15);
    for (const name of retryIndexes) expect(hasIndex(name)).toBe(true);
    expect(tails()[0].name_tail).toBe('b');
    expect(getMigrationHistory(connection!.getDb())).toHaveLength(1);
  });

  it.each([12, 15])('does not repair or change history through a read-only v%s connection', version => {
    const dbPath = fixture(version, version === 12);
    const before = tails();
    const history = getMigrationHistory(connection!.getDb());
    connection!.close();
    connection = DatabaseConnection.open(dbPath, {readOnly: true});
    for (const name of cursors) expect(hasIndex(name)).toBe(false);
    expect(tails()).toEqual(before);
    expect(getMigrationHistory(connection.getDb())).toEqual(history);
    connection.close();
    connection = DatabaseConnection.open(dbPath);
    for (const name of cursors) expect(hasIndex(name)).toBe(true);
  });

  it('rolls back feature repairs together when the legacy import rewrite fails', () => {
    fixture();
    const db = connection!.getDb();
    db.exec(`DROP TABLE synthesis_inputs;
      CREATE TRIGGER reject_import_rewrite BEFORE UPDATE ON unresolved_refs
      WHEN OLD.reference_kind = 'imports' BEGIN SELECT RAISE(ABORT, 'repair blocked'); END;`);
    const before = tails();
    const history = getMigrationHistory(db);
    expect(() => runMigrations(db, 12)).toThrow(/repair blocked/);
    expect(tails()).toEqual(before);
    expect(getMigrationHistory(db)).toEqual(history);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'synthesis_inputs'").get()).toBeUndefined();
    expect(db.prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get().value).toBe('0');
    for (const name of [...cursors, ...retryIndexes]) expect(hasIndex(name)).toBe(false);
    db.exec('DROP TRIGGER reject_import_rewrite');
    runMigrations(db, 12);
    expect(getCurrentVersion(db)).toBe(15);
    expect(tails()[0].name_tail).toBe('b');
  });

  it('does no DDL or row writes on a healthy repeated migration and preserves reopen state', () => {
    const dbPath = fixture();
    const db = connection!.getDb();
    runMigrations(db, 12);
    const before = tails();
    const history = getMigrationHistory(db);
    const schemaVersion = db.pragma('schema_version', {simple: true});
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    runMigrations(db, getCurrentVersion(db));
    expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(changes);
    expect(db.pragma('schema_version', {simple: true})).toBe(schemaVersion);
    connection!.close();
    connection = DatabaseConnection.open(dbPath);
    expect(tails()).toEqual(before);
    expect(getMigrationHistory(connection.getDb())).toEqual(history);
    expect(connection.getDb().pragma('schema_version', {simple: true})).toBe(schemaVersion);
  });

  it('leaves an unknown newer schema to the application version that owns it', () => {
    const dbPath = fixture(CURRENT_SCHEMA_VERSION + 1, false);
    const history = getMigrationHistory(connection!.getDb());
    connection!.close();
    connection = DatabaseConnection.open(dbPath);
    for (const name of cursors) expect(hasIndex(name)).toBe(false);
    expect(getMigrationHistory(connection.getDb())).toEqual(history);
  });
});
