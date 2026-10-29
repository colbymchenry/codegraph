/**
 * The dominant-file aggregation must stay one pass over the edges whatever the
 * planner's statistics say (#2571). `runMaintenance` samples them
 * (`analysis_limit=1000` + `PRAGMA optimize`), and a sample can under-count
 * nodes per file — `idx_nodes_file_path` at 6 where a full ANALYZE says 26.
 * The plain join then started from nodes and, per node, walked every node in
 * its file and probed edges by (source, target): quadratic in nodes per file,
 * ~100 s on a repo with a generated R.java. The statistics below are the
 * sampled ones from a real index; the test plants them and reads the plan.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DOMINANT_FILE_SQL } from '../src/db/queries';

/** sqlite_stat1 after a sampled ANALYZE of this repo's own index. */
const SAMPLED_STATS: Array<[string, string, string]> = [
  ['edges', 'idx_edges_identity', '103526 9 2 2 1 1'],
  ['edges', 'idx_edges_kind', '103526 12941'],
  ['edges', 'idx_edges_provenance', '103526 51763'],
  ['edges', 'idx_edges_source_kind', '103526 9 6'],
  ['edges', 'idx_edges_target_kind', '103526 4 3'],
  ['nodes', 'idx_nodes_file_line', '30684 26 1'],
  ['nodes', 'idx_nodes_file_path', '30684 6'],
  ['nodes', 'idx_nodes_kind', '30684 1535 6 1 1'],
  ['nodes', 'idx_nodes_language', '30684 1395'],
  ['nodes', 'idx_nodes_lower_name', '30684 3'],
  ['nodes', 'idx_nodes_name', '30684 2'],
  ['nodes', 'idx_nodes_qualified_name', '30684 2'],
  ['nodes', 'sqlite_autoindex_nodes_1', '30684 1'],
];

let root: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('dominant file query plan (#2571)', () => {
  it('scans the edges first even when sampled statistics under-count nodes per file', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2571-'));
    const body = Array.from({ length: 25 }, (_, i) => `export function f${i}() { return f${i + 1}(); }`).join('\n');
    fs.writeFileSync(path.join(root, 'core.ts'), `${body}\nexport function f25() { return 0; }\n`);
    cg = await CodeGraph.init(root, { index: true });

    const db = (cg as any).db.db;
    db.exec('ANALYZE');
    db.exec("DELETE FROM sqlite_stat1 WHERE tbl IN ('nodes', 'edges')");
    const insert = db.prepare('INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES (?, ?, ?)');
    for (const row of SAMPLED_STATS) insert.run(...row);
    db.exec('ANALYZE sqlite_schema'); // reload the planted statistics

    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail);

    // The statement getDominantFile prepares is the exported one.
    const queries = (cg as any).queries;
    queries.stmts.getDominantFile = undefined;
    const prepare = queries.db.prepare.bind(queries.db);
    const prepared: string[] = [];
    queries.db.prepare = (text: string) => {
      prepared.push(text);
      return prepare(text);
    };
    let dominant;
    try {
      dominant = queries.getDominantFile();
    } finally {
      queries.db.prepare = prepare;
    }
    expect(dominant?.filePath).toBe('core.ts');
    expect(prepared).toContain(DOMINANT_FILE_SQL);

    const fixed = plan(DOMINANT_FILE_SQL);
    expect(fixed[0]).toMatch(/^SCAN e\b/);
    expect(fixed.join(' | ')).not.toMatch(/SEARCH m USING INDEX idx_nodes_file_path/);

    // Control: on SQLite 3.51 a plain join takes the quadratic plan under these
    // statistics, which is what makes the assertions above discriminate. A
    // planner that costs it differently is no failure of this query.
    const plain = plan(DOMINANT_FILE_SQL.replace(/CROSS JOIN/g, 'JOIN')).join(' | ');
    if (!/SEARCH m USING INDEX idx_nodes_file_path/.test(plain)) {
      console.warn(`dominant-file-plan: plain JOIN no longer takes the quadratic plan here (${plain})`);
    }
  });

  // The plan no longer decides between files with the same count: the old
  // plan happened to emit them by path, the edges-first one does not, and a
  // tie at the edge of the 20-row window can decide the dominant file.
  it('breaks a tie in edge count by path, whatever the plan', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2571-'));
    const chain = (prefix: string) =>
      Array.from({ length: 25 }, (_, i) => `export function ${prefix}${i}() { return ${prefix}${i + 1}(); }`).join('\n') +
      `\nexport function ${prefix}25() { return 0; }\n`;
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/zeta.ts'), chain('z'));
    fs.writeFileSync(path.join(root, 'src/alpha.ts'), chain('a'));
    cg = await CodeGraph.init(root, { index: true });
    (cg as any).db.db.exec('ANALYZE');

    const dominant = (cg as any).queries.getDominantFile();
    expect(dominant?.edgeCount).toBe(dominant?.nextEdgeCount);
    expect(dominant?.filePath).toBe('src/alpha.ts');
  });
});
