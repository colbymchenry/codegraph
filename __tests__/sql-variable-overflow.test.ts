/**
 * Regression: bulk reads/deletes must never bind one SQL variable per row.
 *
 * SQLite caps bound parameters per statement at SQLITE_MAX_VARIABLE_NUMBER
 * (32766 on the node:sqlite build CodeGraph ships). A statement built as
 * `... IN (?,?,…)` with one placeholder per id/path overflows that cap once a
 * project is large enough, and `codegraph sync` aborts with "too many SQL
 * variables" in the resolution write phase — right after "Parsing code 100%".
 *
 * Every project-size-scaling lookup/delete now binds its list as ONE JSON
 * parameter expanded server-side via `json_each(?)`, so the bound-variable
 * count is fixed at 1 regardless of project size. These tests drive each of
 * those statements with > 32766 rows; they throw on the pre-fix code and pass
 * on the json_each fix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

// Comfortably past SQLITE_MAX_VARIABLE_NUMBER (32766) so a placeholder-per-row
// statement is guaranteed to overflow.
const N = 40000;

describe('SQL variable overflow — bulk paths stay O(1) in bound params', () => {
  let dir: string;
  let conn: DatabaseConnection;
  let db: ReturnType<DatabaseConnection['getDb']>;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-overflow-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
    db = conn.getDb();
    queries = new QueryBuilder(db);

    // Seed N nodes and N unresolved refs (one per node) directly, fast, in a
    // single transaction — we only need the rows to exist, not real extraction.
    const insertNode = db.prepare(
      `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column, updated_at)
       VALUES (?, 'function', ?, ?, ?, 'javascript', 1, 1, 0, 0, 0)`
    );
    const insertRef = db.prepare(
      `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
       VALUES (?, 'target', 'calls', 1, 0, ?, 'javascript')`
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const id = `node_${i}`;
        const file = `src/file_${i}.js`;
        insertNode.run(id, `fn_${i}`, `fn_${i}`, file);
        insertRef.run(id, file);
      }
    })();
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(`getNodesByIds resolves ${N} ids without "too many SQL variables"`, () => {
    const ids = Array.from({ length: N }, (_, i) => `node_${i}`);
    const fresh = new QueryBuilder(db); // empty LRU → every id is a DB miss
    const nodes = fresh.getNodesByIds(ids);
    expect(nodes.size).toBe(N);
  });

  it(`getUnresolvedReferencesByFiles scans ${N} file paths without overflow`, () => {
    const files = Array.from({ length: N }, (_, i) => `src/file_${i}.js`);
    const refs = queries.getUnresolvedReferencesByFiles(files);
    expect(refs.length).toBe(N);
  });

  it(`deleteResolvedReferences deletes ${N} from-node ids without overflow`, () => {
    const ids = Array.from({ length: N }, (_, i) => `node_${i}`);
    queries.deleteResolvedReferences(ids);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });
});
