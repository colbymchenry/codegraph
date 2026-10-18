import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection, getDatabasePath } from '../src/db';

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

/** `n` exported functions in one file — enough nodes for the name list to be non-trivial. */
function funcs(prefix: string, n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(`export function ${prefix}${i}(): number { return ${i}; }`);
  return lines.join('\n') + '\n';
}

describe('whole-table read memos — one computation per database state', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-readmemo-'));
    fs.mkdirSync(path.join(dir, 'core'));
    fs.writeFileSync(path.join(dir, 'core', 'engine.ts'), funcs('engineStep', 5));
    fs.writeFileSync(path.join(dir, 'core', 'util.py'), 'def helper():\n    return 1\n');
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('returns the same array until something is written', async () => {
    const q = queriesOf(await setup());
    const first = q.getAllFilePaths();
    expect(first).toContain('core/engine.ts');
    expect(q.getAllFilePaths()).toBe(first);
  });

  it('hands out values that cannot be mutated by a caller', async () => {
    const q = queriesOf(await setup());
    const files = q.getAllFilePaths();
    expect(Object.isFrozen(files)).toBe(true);
    expect(() => (files as string[]).push('bogus.ts')).toThrow();
  });

  it('sees files added by a sync through this connection', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    expect(q.getAllFilePaths()).not.toContain('core/extra.ts');

    fs.writeFileSync(path.join(dir, 'core', 'extra.ts'), funcs('extraStep', 3));
    await cg.sync();

    expect(q.getAllFilePaths()).toContain('core/extra.ts');
    expect(q.getDistinctFileLanguages()).toContain('typescript');
  });

  it('sees a swap that keeps the file count unchanged', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const before = q.getAllFilePaths();
    expect(before).toContain('core/util.py');

    // Same number of files, different names — a length-based key would call
    // this a cache hit and hand the resolver a stale file list.
    fs.rmSync(path.join(dir, 'core', 'util.py'));
    fs.writeFileSync(path.join(dir, 'core', 'added.ts'), funcs('addedStep', 2));
    await cg.sync();

    const after = q.getAllFilePaths();
    expect(after).not.toBe(before);
    expect(after).not.toContain('core/util.py');
    expect(after).toContain('core/added.ts');
    expect(q.getDistinctFileLanguages()).not.toContain('python');
  });

  it('sees a sync made through another connection (another process)', async () => {
    const writer = await setup();
    const reader = await CodeGraph.open(dir);
    open.push(reader);
    expect(queriesOf(reader).getAllFilePaths()).not.toContain('core/other.ts');

    fs.writeFileSync(path.join(dir, 'core', 'other.ts'), funcs('otherStep', 2));
    await writer.sync();

    expect(queriesOf(reader).getAllFilePaths()).toContain('core/other.ts');
  });

  it('does not keep a value read inside a transaction that is rolled back', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const before = q.getAllFilePaths();
    const db = (cg as unknown as { db: DatabaseConnection }).db.getDb();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM files');
      db.exec('DELETE FROM nodes');
      // Inside the transaction the read must reflect the statement, not a memo.
      expect(q.getAllFilePaths()).toEqual([]);
    } finally {
      db.exec('ROLLBACK');
    }
    expect(q.getAllFilePaths()).toEqual(before);
  });

  it('forgets the values when rebound to another connection', async () => {
    await setup();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-readmemo-other-'));
    const conns: DatabaseConnection[] = [];
    try {
      fs.writeFileSync(path.join(other, 'solo.ts'), funcs('soloStep', 2));
      (await CodeGraph.init(other, { index: true })).close();
      conns.push(DatabaseConnection.open(getDatabasePath(dir)), DatabaseConnection.open(getDatabasePath(other)));
      const q = new QueryBuilder(conns[0]!.getDb());
      expect(q.getAllFilePaths()).toContain('core/engine.ts');
      q.rebind(conns[1]!.getDb());
      expect(q.getAllFilePaths()).toEqual(['solo.ts']);
      expect(q.getDistinctFileLanguages()).toEqual(new Set(['typescript']));
    } finally {
      for (const c of conns) c.close();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
