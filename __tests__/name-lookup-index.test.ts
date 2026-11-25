/**
 * Exact-name lookups must seek `idx_nodes_lower_name`
 *
 * `nodes` carries two name indexes and neither one can serve
 * `WHERE name = ? COLLATE NOCASE`:
 *
 *   - `idx_nodes_name` is BINARY-collated, so NOCASE equality can't use it;
 *   - `idx_nodes_lower_name` is an expression index on `lower(name)`, and the
 *     planner only matches it against the same expression.
 *
 * So every exact-name lookup written that way degrades to a full table scan.
 * The `LIMIT`s on those queries do not save them: SQLite can only stop early
 * once it has produced `LIMIT` rows, and the common cases — a query term that
 * is not a symbol at all, or a name with only a handful of definitions — never
 * reach it and scan the whole table.
 *
 * These tests read the planner's own verdict rather than a wall-clock number,
 * so they are deterministic and fail loudly if a lookup regresses to a scan.
 * `lower(name) = lower(?)` (not a JS-side `.toLowerCase()`) is the required
 * form — see the folding-parity test at the bottom for why.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { SqliteDatabase } from '../src/db/sqlite-adapter';
import { Node } from '../src/types';

function makeNode(id: string, name: string, filePath = 'src/a.ts'): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

/** Wraps a db so every `prepare()` is recorded, then delegates unchanged. */
function recordingDb(raw: SqliteDatabase): { db: SqliteDatabase; sqls: string[] } {
  const sqls: string[] = [];
  const db: SqliteDatabase = {
    prepare(sql: string) {
      sqls.push(sql);
      return raw.prepare(sql);
    },
    exec: (sql: string) => raw.exec(sql),
    pragma: (str: string, options?: { simple?: boolean }) => raw.pragma(str, options),
    transaction: <T>(fn: (...args: any[]) => T) => raw.transaction(fn),
    close: () => raw.close(),
    get open() {
      return raw.open;
    },
  };
  return { db, sqls };
}

/** SQL that filters `nodes` on whole-name equality, in either spelling. */
function exactNameLookups(sqls: string[]): string[] {
  return sqls.filter(
    (s) =>
      /\bFROM\s+nodes\b/i.test(s) &&
      (/\bname\s*(COLLATE\s+NOCASE\s*)?=\s*\?(\s*COLLATE\s+NOCASE)?/i.test(s) ||
        /\blower\(name\)\s*=/i.test(s))
  );
}

/** The planner's access path for the `nodes` table in a statement. */
function nodesAccessPath(raw: SqliteDatabase, sql: string): string {
  const args = new Array((sql.match(/\?/g) ?? []).length).fill('x');
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
  const detail = rows.map((r) => r.detail).find((d) => /\bnodes\b/.test(d));
  return detail ?? rows.map((r) => r.detail).join(' | ');
}

describe('exact-name lookups seek idx_nodes_lower_name', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let raw: SqliteDatabase;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-lookup-index-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    raw = conn.getDb();
    const seed = new QueryBuilder(raw);

    // A corpus wide enough that a scan and a seek can't accidentally agree on
    // ordering, with `handleRequest` deliberately rare (2 nodes) — the shape
    // the LIMITs never short-circuit on.
    const nodes: Node[] = [];
    for (let i = 0; i < 300; i++) {
      nodes.push(makeNode(`filler-${i}`, `filler${i}Symbol`, `src/pkg${i % 7}/f${i}.ts`));
    }
    nodes.push(makeNode('hr-1', 'handleRequest', 'src/server/router.ts'));
    nodes.push(makeNode('hr-2', 'HandleRequest', 'src/server/legacy.ts'));
    for (const n of nodes) seed.insertNode(n);
  });

  afterAll(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('searchNodes issues its exact-name supplement as an index seek', () => {
    const { db, sqls } = recordingDb(raw);
    const q = new QueryBuilder(db);

    const results = q.searchNodes('handleRequest');
    expect(results.length).toBeGreaterThan(0);

    const lookups = exactNameLookups(sqls);
    // Guard against a vacuous pass: the supplement must actually have run.
    expect(lookups.length).toBeGreaterThan(0);

    for (const sql of lookups) {
      expect(nodesAccessPath(raw, sql)).toMatch(/SEARCH nodes USING .*idx_nodes_lower_name/);
    }
  });

  it('findNodesByExactName issues both of its passes as index seeks', () => {
    const { db, sqls } = recordingDb(raw);
    const q = new QueryBuilder(db);

    const results = q.findNodesByExactName(['handleRequest']);
    expect(results.length).toBeGreaterThan(0);

    const lookups = exactNameLookups(sqls);
    // Two passes: the file_path probe and the row fetch.
    expect(lookups.length).toBeGreaterThanOrEqual(2);

    for (const sql of lookups) {
      expect(nodesAccessPath(raw, sql)).toMatch(/SEARCH nodes USING .*idx_nodes_lower_name/);
    }
  });

  it('getNodesByLowerName seeks the index and does not depend on the caller lowering', () => {
    const { db, sqls } = recordingDb(raw);
    const q = new QueryBuilder(db);

    // Previously this took an already-lowered string on trust: anything with an
    // uppercase letter in it silently returned nothing.
    expect(q.getNodesByLowerName('handlerequest').map((n) => n.id).sort()).toEqual([
      'hr-1',
      'hr-2',
    ]);
    expect(q.getNodesByLowerName('HandleRequest').map((n) => n.id).sort()).toEqual([
      'hr-1',
      'hr-2',
    ]);
    expect(q.getNodesByLowerName('HANDLEREQUEST').map((n) => n.id).sort()).toEqual([
      'hr-1',
      'hr-2',
    ]);

    const lookups = exactNameLookups(sqls);
    expect(lookups.length).toBeGreaterThan(0);
    for (const sql of lookups) {
      expect(nodesAccessPath(raw, sql)).toMatch(/SEARCH nodes USING .*idx_nodes_lower_name/);
    }
  });

  it('still matches case-insensitively across both call sites', () => {
    const q = new QueryBuilder(raw);

    const exact = q.findNodesByExactName(['HANDLEREQUEST']);
    expect(exact.map((r) => r.node.id).sort()).toEqual(['hr-1', 'hr-2']);

    const searched = q.searchNodes('HandleRequest');
    const ids = new Set(searched.map((r) => r.node.id));
    expect(ids.has('hr-1')).toBe(true);
    expect(ids.has('hr-2')).toBe(true);
  });

  it('folds exactly what COLLATE NOCASE folded — ASCII only', () => {
    // SQLite's NOCASE and its `lower()` are both ASCII-only. JavaScript's
    // `.toLowerCase()` is not, so lowering the parameter in JS and comparing
    // against `lower(name)` would silently stop matching non-ASCII names that
    // NOCASE used to match. `lower(?)` keeps both sides on SQLite's rules.
    const probe = new QueryBuilder(raw);
    probe.insertNode(makeNode('uni-1', 'Ünïcode', 'src/i18n/a.ts'));

    const found = probe.findNodesByExactName(['Ünïcode']);
    expect(found.map((r) => r.node.id)).toContain('uni-1');

    // The mixed-ASCII half still folds, as NOCASE did.
    probe.insertNode(makeNode('uni-2', 'Ünïcodeloader', 'src/i18n/b.ts'));
    const folded = probe.findNodesByExactName(['ÜnïcodeLOADER']);
    expect(folded.map((r) => r.node.id)).toContain('uni-2');

    // Same rule for the fuzzy-match lookup. Note what this does NOT claim: a
    // caller that lowers in JavaScript first still hands over `ünïcode`, which
    // is not what SQLite's `lower()` makes of `Ünïcode`, so the gap stays open
    // on that side.
    expect(probe.getNodesByLowerName('Ünïcode').map((n) => n.id)).toContain('uni-1');
    expect(probe.getNodesByLowerName('ÜnïcodeLOADER').map((n) => n.id)).toContain('uni-2');
  });
});
