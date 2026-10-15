/**
 * A full index leaves the planner exact statistics (#2571).
 *
 * The maintenance after a bulk write ran `PRAGMA optimize` under
 * `analysis_limit=1000`: statistics from the first rows of each index. On a
 * repository with one generated file of thousands of symbols (an Android
 * `R.java`, a bundled `.d.ts`) that sample misses the big file, the planner
 * takes every file for a few symbols, and the dominant-file query behind
 * every `codegraph_explore` is planned as a scan of each file's symbols per
 * symbol — ~100 s per explore on a 280k-node index, 1.5 s with exact
 * statistics. A full index now ends with a full `ANALYZE`; a sync keeps the
 * incremental `optimize`, which re-analyzes only a table that grew by a lot.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';

describe('#2571 — a full index leaves the planner exact statistics', () => {
  it('runMaintenance after a full index analyzes every row, not a sample', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-analyze-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
    try {
      const raw = db.getDb();
      const insert = raw.prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
         VALUES (?, 'constant', ?, ?, ?, 'java', 1, 1, 0, 0, 0)`,
      );
      // One generated file of 3,000 symbols beside 3,000 files of one: two symbols per file on average.
      // The big file sorts after the small ones, where a sample of the index never reaches it.
      raw.exec('BEGIN');
      for (let i = 0; i < 3000; i++) {
        insert.run(`big-${i}`, `R${i}`, `R.R${i}`, 'zz/R.java');
        insert.run(`one-${i}`, `f${i}`, `f${i}`, `src/${String(i).padStart(4, '0')}.java`);
      }
      raw.exec('COMMIT');
      const stat = (): string | undefined =>
        (raw.prepare(`SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_nodes_file_path'`).get() as { stat: string } | undefined)?.stat;

      // The statistics a sync's maintenance leaves: a sample of the first rows, which misses the big file.
      await db.runMaintenance();
      expect(stat()).toBe('6000 1');

      await db.runMaintenance({ fullAnalyze: true });
      expect(stat()).toBe('6000 2');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
