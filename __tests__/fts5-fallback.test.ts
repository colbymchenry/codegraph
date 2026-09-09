import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { Node } from '../src/types';

// Use real SQLite for every operation except the unsupported-module error.
// This must exercise fallback even when the test runner's Node has FTS5.
const { DatabaseSync } = require('node:sqlite');

function simulateMissingFts5(): () => number {
  const exec = DatabaseSync.prototype.exec;
  let attempts = 0;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: unknown, sql: string) {
    if (/CREATE VIRTUAL TABLE\b[^;]*\bUSING fts5\s*\(/i.test(sql)) {
      attempts++;
      throw new Error('no such module: fts5');
    }
    return exec.call(this, sql);
  });
  return () => attempts;
}

function makeNode(name: string, docstring?: string): Node {
  return {
    id: name,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'src/users.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    docstring,
    updatedAt: Date.now(),
  };
}

describe('FTS5 fallback (#1532)', () => {
  let dir: string;
  let connections: DatabaseConnection[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fts5-fallback-'));
    connections = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const connection of connections) connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function initialize(filename = 'test.db'): DatabaseConnection {
    const connection = DatabaseConnection.initialize(path.join(dir, filename));
    connections.push(connection);
    return connection;
  }

  function reopen(connection: DatabaseConnection): DatabaseConnection {
    connection.close();
    const reopened = DatabaseConnection.open(path.join(dir, 'test.db'));
    connections.push(reopened);
    return reopened;
  }

  it.each(['initialization', 'reopening'])('uses LIKE and fuzzy search after %s without FTS5', (state) => {
    const attempts = simulateMissingFts5();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let connection = initialize();

    expect(attempts()).toBe(1);
    expect(connection.fts5Available).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no such module: fts5'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LIKE + fuzzy matching'));

    if (state === 'reopening') connection = reopen(connection);
    expect(connection.fts5Available).toBe(false);

    const db = connection.getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes_fts' OR name IN ('nodes_ai', 'nodes_ad', 'nodes_au')").all()).toEqual([]);
    const exec = vi.spyOn(db, 'exec');
    connection.beginBulkNodeLoad();
    connection.endBulkNodeLoad();
    expect(exec).not.toHaveBeenCalled();

    const queries = new QueryBuilder(db);
    queries.insertNodes([makeNode('getUser'), makeNode('getUserProfile')]);
    const prepare = vi.spyOn(db, 'prepare');

    expect(queries.searchNodes('User').map(result => result.node.name)).toEqual(expect.arrayContaining(['getUser', 'getUserProfile']));
    expect(queries.searchNodes('getUssr').map(result => result.node.name)).toEqual(['getUser']);
    // A failed MATCH query is already caught by searchNodesFTS; pin that the
    // unavailable path skips the FTS query entirely, rather than retrying it.
    expect(prepare.mock.calls.some(([sql]) => /\bnodes_fts\b/.test(sql))).toBe(false);

    queries.setMetadata('project_name', 'fts5-fallback');
    expect(queries.getMetadata('project_name')).toBe('fts5-fallback');
  });

  it('keeps every non-FTS table and index when FTS5 creation fails', () => {
    const control = initialize('control.db');
    const nonFtsSchema = (connection: DatabaseConnection) => connection.getDb().prepare(`
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'nodes_fts%'
        AND name NOT IN ('nodes_ai', 'nodes_ad', 'nodes_au')
      ORDER BY type, name
    `).all();
    const expected = nonFtsSchema(control);

    simulateMissingFts5();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = initialize();

    expect(fallback.fts5Available).toBe(false);
    expect(nonFtsSchema(fallback)).toEqual(expected);
  });

  it.each(['initialization', 'reopening'])('uses real FTS5 after %s', (state) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let connection = initialize();
    expect(connection.fts5Available).toBe(true);
    new QueryBuilder(connection.getDb()).insertNode(makeNode('loadRecord', 'quasar nebula'));

    if (state === 'reopening') connection = reopen(connection);
    expect(connection.fts5Available).toBe(true);
    const queries = new QueryBuilder(connection.getDb());
    // Only the docstring contains this token: LIKE/fuzzy name search cannot
    // make this assertion pass if the FTS path is accidentally disabled.
    expect(queries.searchNodes('nebula').map(result => result.node.name)).toEqual(['loadRecord']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rebuilds real FTS5 after a bulk node load', () => {
    const connection = initialize();
    const queries = new QueryBuilder(connection.getDb());

    connection.beginBulkNodeLoad();
    queries.insertNode(makeNode('loadRecord', 'quasar nebula'));
    expect(queries.searchNodes('nebula')).toEqual([]);
    connection.endBulkNodeLoad();

    expect(queries.searchNodes('nebula').map(result => result.node.name)).toEqual(['loadRecord']);
    queries.insertNode(makeNode('saveRecord', 'pulsar supernova'));
    expect(queries.searchNodes('supernova').map(result => result.node.name)).toEqual(['saveRecord']);
  });

  it('repairs an interrupted real FTS5 bulk load on open', () => {
    let connection = initialize();
    connection.beginBulkNodeLoad();
    new QueryBuilder(connection.getDb()).insertNode(makeNode('loadRecord', 'quasar nebula'));

    connection = reopen(connection);

    expect(connection.fts5Available).toBe(true);
    const queries = new QueryBuilder(connection.getDb());
    expect(queries.searchNodes('nebula').map(result => result.node.name)).toEqual(['loadRecord']);
    queries.insertNode(makeNode('saveRecord', 'pulsar supernova'));
    expect(queries.searchNodes('supernova').map(result => result.node.name)).toEqual(['saveRecord']);
  });
});
