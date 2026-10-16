/**
 * A long explore query runs FTS, the LIKE fallback and the fuzzy fallback once
 * per extracted term, so per-term cost multiplies by the query's vocabulary
 * (a pasted log or a skill body is a few hundred terms). These tests pin the
 * three per-term savings and that each keeps the answers it had:
 *  - the distinct-name list behind the fuzzy fallback is read once per
 *    database state, not once per term;
 *  - the fuzzy fallback scans only names whose length can be within maxDist,
 *    and ranks them exactly as a full scan does;
 *  - FTS joins nodes on rowid, which nodes_fts (external content) shares with
 *    nodes by construction — including after syncs rewrite rows.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { boundedEditDistance } from '../src/search/query-parser';
import { scorePathRelevance } from '../src/search/query-utils';

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}

function spyRead(cg: CodeGraph) {
  return vi.spyOn(queriesOf(cg) as unknown as { readAllNodeNames: () => string[] }, 'readAllNodeNames');
}

function fuzzy(q: QueryBuilder, text: string, limit = 50) {
  return (q as unknown as {
    searchNodesFuzzy: (t: string, o: { limit: number }) => Array<{ node: { name: string } }>;
  }).searchNodesFuzzy(text, { limit });
}

const FUNCS = [
  'getUser', 'getUsers', 'getUserName', 'setUser', 'getUsr', 'gotUser', 'getUserById',
  'process', 'prosody', 'proceed', 'procesz', 'progress', 'loadConfig', 'loadConfigs', 'saveConfig',
];

describe('explore per-term search cost', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(files: Record<string, string> = {
    'src/users.ts': FUNCS.map((f) => `export function ${f}(): void {}`).join('\n') + '\n',
  }): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-term-cost-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  describe('distinct-name list', () => {
    it('is read once across many fuzzy lookups while the database is unchanged', async () => {
      const cg = await setup();
      const read = spyRead(cg);
      for (const t of ['getUssr', 'procesq', 'loadConfgi', 'zzzzzz']) cg.searchNodes(t);
      expect(read).toHaveBeenCalledTimes(1);
      expect(queriesOf(cg).getAllNodeNames()).toContain('getUser');
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('hands out a copy, so a caller cannot edit the cached list', async () => {
      const cg = await setup();
      queriesOf(cg).getAllNodeNames().length = 0;
      expect(queriesOf(cg).getAllNodeNames()).toContain('getUser');
    });

    it('sees a name added by a sync', async () => {
      const cg = await setup();
      expect(queriesOf(cg).getAllNodeNames()).not.toContain('freshlyAdded');
      fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export function freshlyAdded(): void {}\n');
      await cg.sync();
      expect(queriesOf(cg).getAllNodeNames()).toContain('freshlyAdded');
      expect(fuzzy(queriesOf(cg), 'freshlyAdedd').map((r) => r.node.name)).toContain('freshlyAdded');
    });

    it('sees a sync made through another connection (another process)', async () => {
      const writer = await setup();
      const reader = await CodeGraph.open(dir);
      open.push(reader);
      expect(queriesOf(reader).getAllNodeNames()).not.toContain('freshlyAdded');
      fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export function freshlyAdded(): void {}\n');
      await writer.sync();
      expect(queriesOf(reader).getAllNodeNames()).toContain('freshlyAdded');
    });

    it('does not keep a list read inside a transaction that is rolled back', async () => {
      const cg = await setup();
      const q = queriesOf(cg);
      const db = (cg as any).db.getDb();
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM nodes');
        expect(q.getAllNodeNames()).toEqual([]);
      } finally {
        db.exec('ROLLBACK');
      }
      expect(q.getAllNodeNames()).toContain('getUser');
    });

    it('forgets the list when rebound to another connection', async () => {
      await setup();
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-term-cost-other-'));
      const conns: DatabaseConnection[] = [];
      try {
        fs.writeFileSync(path.join(other, 'only.ts'), 'export function onlyInOther(): void {}\n');
        (await CodeGraph.init(other, { index: true })).close();
        conns.push(DatabaseConnection.open(getDatabasePath(dir)), DatabaseConnection.open(getDatabasePath(other)));
        const q = new QueryBuilder(conns[0]!.getDb());
        expect(q.getAllNodeNames()).toContain('getUser');
        q.rebind(conns[1]!.getDb());
        expect(q.getAllNodeNames()).toContain('onlyInOther');
        expect(q.getAllNodeNames()).not.toContain('getUser');
      } finally {
        for (const c of conns) c.close();
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('fuzzy fallback length window', () => {
    it('ranks candidates exactly as a scan over every name does', async () => {
      const cg = await setup();
      const q = queriesOf(cg);
      const names = q.getAllNodeNames();
      for (const text of ['getUssr', 'procesq', 'prcess', 'loadConfgi', 'gtUser', 'getUserByIdd']) {
        const lowered = text.toLowerCase();
        const maxDist = lowered.length <= 4 ? 1 : 2;
        const expected = names
          .map((name) => ({ name, dist: boundedEditDistance(name.toLowerCase(), lowered, maxDist) }))
          .filter((c) => c.dist <= maxDist)
          .sort((a, b) => a.dist - b.dist)
          .map((c) => c.name);
        const got = [...new Set(fuzzy(q, text, 500).map((r) => r.node.name))];
        expect(expected.length).toBeGreaterThan(0);
        expect(got).toEqual(expected);
      }
    });

    it('still finds a typo and still refuses a far name', async () => {
      const cg = await setup();
      const hits = fuzzy(queriesOf(cg), 'getUssr').map((r) => r.node.name);
      expect(hits).toContain('getUser');
      expect(fuzzy(queriesOf(cg), 'process').map((r) => r.node.name)).not.toContain('prosody');
    });
  });

  describe('FTS rowid join', () => {
    it('finds renamed symbols and drops deleted ones after a sync rewrites rows', async () => {
      const cg = await setup({
        'src/a.ts': 'export function alphaHandler(): void {}\nexport function betaHandler(): void {}\n',
        'src/b.ts': 'export function gammaHandler(): void {}\n',
      });
      expect(cg.searchNodes('alphaHandler').map((r) => r.node.name)).toContain('alphaHandler');

      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alphaRenamed(): void {}\n');
      fs.rmSync(path.join(dir, 'src', 'b.ts'));
      await cg.sync();

      const names = (q: string) => cg.searchNodes(q).map((r) => `${r.node.name}@${r.node.filePath}`);
      expect(names('alphaRenamed')).toContain('alphaRenamed@src/a.ts');
      expect(names('betaHandler')).not.toContain('betaHandler@src/a.ts');
      expect(names('gammaHandler')).not.toContain('gammaHandler@src/b.ts');
      // Every FTS row resolves to the node it indexes.
      const db = (cg as any).db.getDb();
      const mismatched = db.prepare(
        'SELECT count(*) AS c FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE f.id <> n.id'
      ).get() as { c: number };
      expect(mismatched.c).toBe(0);
    });
  });

  describe('path relevance word split cache', () => {
    it('scores the same on repeated calls and with repeated words', () => {
      const p = 'src/services/user/UserService.ts';
      const q = 'UserService user service getUserName config';
      const first = scorePathRelevance(p, q);
      expect(scorePathRelevance(p, q)).toBe(first);
      expect(scorePathRelevance(p, `${q} ${q}`)).toBe(first * 2);
    });
  });
});
