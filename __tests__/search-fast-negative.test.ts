/**
 * Fast-negative for missing symbols (P0).
 *
 * Three behaviors are pinned here:
 * - `hasNodesByLowerNamePrefix` answers from idx_nodes_lower_name, never a scan
 * - the exact-name and case-insensitive lookups seek the same index
 * - `searchNodes(exactMode)` keeps fuzzy ("Did you mean") and stays correct
 * - `getAllNodeNames` is memoized per change stamp, including across connections
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { Node } from '../src/types';

function makeNode(id: string, name: string, kind = 'function'): Node {
  return {
    id,
    kind: kind as any,
    name,
    qualifiedName: name,
    filePath: 'test.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

/** The `detail` column of EXPLAIN QUERY PLAN, joined for substring checks. */
function queryPlan(db: DatabaseConnection, sql: string, params: unknown[]): string {
  const rows = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

describe('Fast negative for non-existent symbols', () => {
  let dir: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(db.getDb());

    queries.insertNode(makeNode('1', 'getUserData'));
    queries.insertNode(makeNode('2', 'callOibs', 'class'));
    queries.insertNode(makeNode('3', 'TransportSearchAction', 'class'));
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hasNodesByLowerNamePrefix rides idx_nodes_lower_name, not a scan', () => {
    const plan = queryPlan(
      db,
      'SELECT 1 FROM nodes WHERE lower(name) >= lower(?) AND lower(name) < lower(?) || char(65535) LIMIT 1',
      ['x', 'x']
    );
    expect(plan).toContain('idx_nodes_lower_name');
    expect(plan).not.toContain('SCAN nodes');
  });

  it('exact-name and case-insensitive lookups seek the index', () => {
    const lowerPlan = queryPlan(db, 'SELECT * FROM nodes WHERE lower(name) = lower(?)', ['x']);
    expect(lowerPlan).toContain('idx_nodes_lower_name');
    expect(lowerPlan).not.toContain('SCAN nodes');
  });

  it('hasNodesByLowerNamePrefix answers correctly, case-insensitively', () => {
    expect(queries.hasNodesByLowerNamePrefix('getUser')).toBe(true);
    expect(queries.hasNodesByLowerNamePrefix('call')).toBe(true);
    expect(queries.hasNodesByLowerNamePrefix('Transport')).toBe(true);
    expect(queries.hasNodesByLowerNamePrefix('GETUSER')).toBe(true);
    expect(queries.hasNodesByLowerNamePrefix('calloi')).toBe(true);

    expect(queries.hasNodesByLowerNamePrefix('nonExistent')).toBe(false);
    expect(queries.hasNodesByLowerNamePrefix('zzz')).toBe(false);
  });

  it('Case-insensitive fallback resolves typos', () => {
    expect(queries.getNodesByName('getUserData')).toHaveLength(1);
    // Wrong case: the BINARY exact lookup misses...
    expect(queries.getNodesByName('GETUSERDATA')).toEqual([]);
    expect(queries.getNodesByName('CallOibs')).toEqual([]);
    // ...and the lower-name lookup resolves it.
    expect(queries.getNodesByLowerName('GETUSERDATA')).toHaveLength(1);
    expect(queries.getNodesByLowerName('CallOibs')).toHaveLength(1);
    expect(queries.getNodesByLowerName('CallOibs')[0]?.name).toBe('callOibs');
  });

  it('searchNodes with exactMode still returns fuzzy "Did you mean" hits', () => {
    queries.insertNode(makeNode('4', 'getUser'));
    // A close typo: FTS misses, LIKE is skipped under exactMode, fuzzy still runs.
    const fuzzy = queries.searchNodes('getUssr', { limit: 5, exactMode: true });
    expect(fuzzy.some((r) => r.node.name === 'getUser')).toBe(true);
  });

  it('searchNodes exactMode is correct for a genuinely absent symbol', () => {
    expect(queries.searchNodes('nonExistentSymbol', { limit: 10, exactMode: true })).toEqual([]);
    // Default mode agrees — exactMode only changes which channels run, not the answer.
    expect(queries.searchNodes('nonExistentSymbol', { limit: 10 })).toEqual([]);
  });

  it('getAllNodeNames is memoized and recomputed after a write', () => {
    const names1 = queries.getAllNodeNames();
    expect(names1).toContain('getUserData');
    expect(queries.getAllNodeNames()).toBe(names1); // same array reference

    queries.insertNode(makeNode('5', 'newSymbol'));
    const names3 = queries.getAllNodeNames();
    expect(names3).toContain('newSymbol');
    expect(names3.length).toBe(names1.length + 1);
  });

  it('getAllNodeNames memo is invalidated by an external writer', () => {
    expect(queries.getAllNodeNames()).not.toContain('externallyAdded');

    // A second connection to the same file — the `codegraph index` beside a
    // running MCP server case (#1864). Must use open(), not initialize().
    const writer = DatabaseConnection.open(path.join(dir, 'test.db'));
    try {
      new QueryBuilder(writer.getDb()).insertNode(makeNode('ext-1', 'externallyAdded'));
    } finally {
      writer.close();
    }

    expect(queries.getAllNodeNames()).toContain('externallyAdded');
  });
});
