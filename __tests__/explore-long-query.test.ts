/**
 * Long `codegraph_explore` queries on a large index (#2620).
 *
 * The prompt hook hands explore the whole prompt, so a pasted log, document
 * or source file reaches it as a query of hundreds of words, and every word
 * cost several reads that each scanned the index: on a 560k-node index such
 * a query took one to four minutes and the hook gave up. These tests pin the
 * two halves of the fix:
 *
 * - the per-word reads give exactly the rows they gave before, now from
 *   memory (the name-substring lookups, the fuzzy fallback's name list, the
 *   LIKE fallback's "nothing to find" check), read once per database state;
 * - a query searches at most MAX_QUERY_SYMBOLS names and MAX_QUERY_TERMS
 *   terms, code-shaped words first, so its cost no longer grows with its
 *   length.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { QueryBuilder } from '../src/db/queries';
import { MAX_QUERY_SYMBOLS, MAX_QUERY_TERMS } from '../src/context';
import { scorePathRelevance, extractSearchTerms, normalizeNameToken, isTestFile } from '../src/search/query-utils';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

function queriesOf(cg: CodeGraph): QueryBuilder {
  return (cg as unknown as { queries: QueryBuilder }).queries;
}
function rawDb(cg: CodeGraph): SqliteDatabase {
  return (cg as unknown as { db: { getDb(): SqliteDatabase } }).db.getDb();
}

/** Count the statements run whose SQL matches `pattern`, through the adapter. */
function countStatements(db: SqliteDatabase, pattern: RegExp): { count: number } {
  const counter = { count: 0 };
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    if (!pattern.test(sql)) return stmt;
    const wrap = <T extends (...a: any[]) => any>(fn: T): T => ((...args: any[]) => { counter.count++; return fn(...args); }) as T;
    return { ...stmt, all: wrap(stmt.all.bind(stmt)), get: wrap(stmt.get.bind(stmt)), iterate: wrap(stmt.iterate.bind(stmt)), run: stmt.run.bind(stmt) };
  });
  return counter;
}

const DEF = ['class', 'interface', 'struct', 'union', 'trait', 'protocol', 'enum', 'type_alias'];
const CALL = ['function', 'method', 'component'];
const SEED = ['function', 'method', 'component', 'variable', 'constant'];

/** The lookup as it was before the index: a LIKE scan, ties left to the plan. */
function likeScan(db: SqliteDatabase, substring: string, kinds: string[], excludePrefix: boolean, limit: number): string[] {
  let sql = 'SELECT nodes.*, 1.0 as score FROM nodes WHERE name LIKE ?';
  const params: (string | number)[] = [`%${substring}%`];
  if (excludePrefix) { sql += ' AND name NOT LIKE ?'; params.push(`${substring}%`); }
  sql += ` AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY length(name) ASC LIMIT ?`;
  return (db.prepare(sql).all(...params, ...kinds, limit) as Array<{ id: string }>).map((row) => row.id);
}

/** Many names of equal length across kinds and files, so ties decide the order. */
function writeTieProject(dir: string): void {
  const files: Record<string, string> = {};
  for (let f = 0; f < 6; f++) {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      const n = (f * 7 + i * 5) % 12;
      lines.push(`export function load${n}Item${f}(): void {}`);
      lines.push(`export class Item${n}Loader${f} { loadItem${n}(): void {} }`);
      lines.push(`export interface Item${n}Shape${f} { loadItem${n}Shape(): void; }`);
      lines.push(`export const ITEM_${n}_LOADER_${f} = ${i};`);
    }
    lines.push('export function load_item_snake(): void {}');
    lines.push('export function loadXitemXsnake(): void {}');
    lines.push('export class LOADITEMLOUD {}');
    lines.push('export function größeLaden(): void {}');
    lines.push('export function GrößeLaden(): void {}');
    lines.push('export function ÉtatLoader(): void {}');
    lines.push('export function étatLoader(): void {}');
    lines.push('export function 𝑥ItemLoader(): void {}');
    files[`src/part${(f * 5) % 6}/items${f}.ts`] = lines.join('\n') + '\n';
  }
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

const PATTERNS = [
  'Item', 'item', 'ITEM', 'Loader', 'Load', 'load', 'Item1', 'Item1loader', 'Loaditem', 'Shape', 'Oader', 'O',
  'Load_item', 'Item_', '_', 'I_em', 'Load_i', 'Item_1', 'Größe', 'größe', 'GRÖSSE', 'État', 'état', 'Etat',
  '𝑥', '𝑥item', 'Xitem', 'Loud', 'Missingword', 'Item.', 'Item(',
];

describe('name-substring lookups give the rows a LIKE scan gives (#2620)', () => {
  let dir: string;
  const open: CodeGraph[] = [];
  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-substr-'));
    writeTieProject(dir);
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  function expectSameRows(cg: CodeGraph, plan: 'rowid' | 'index'): void {
    const q = queriesOf(cg);
    const db = rawDb(cg);
    let compared = 0;
    for (const substring of PATTERNS) {
      for (const kinds of [DEF, CALL, SEED, ['method'], ['constant', 'function']]) {
        for (const excludePrefix of [false, true]) {
          for (const limit of [200, 7, 1]) {
            const expected = likeScan(db, substring, kinds, excludePrefix, limit);
            const actual = q.findNodesByNameSubstring(substring, { kinds: kinds as never, excludePrefix, limit }).map((r) => r.node.id);
            expect(actual, `${substring} ${kinds.join(',')} excludePrefix=${excludePrefix} limit=${limit}`).toEqual(expected);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(900);
    // The answers came from the index, under the plan SQLite chose.
    const memo = (q as unknown as { readMemos: Map<string, { value: { plans: Map<string, string | null> } | null }> })
      .readMemos.get('nameSubstringIndex');
    expect(memo?.value).toBeTruthy();
    const plans = [...memo!.value!.plans.values()];
    expect(plans).toContain(plan);
    expect(plans).not.toContain(null);
  }

  it('matches when SQLite scans the table (a small index)', async () => {
    const cg = await setup();
    const plan = rawDb(cg).prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name LIKE '%x%' AND kind IN (${DEF.map(() => '?').join(',')}) ORDER BY length(name) LIMIT 200`,
    ).all(...DEF) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail)).toContain('SCAN nodes');
    expectSameRows(cg, 'rowid');
  });

  it('matches when SQLite reads through the kind index (a large index)', async () => {
    const cg = await setup();
    const db = rawDb(cg);
    // The statistics of a large index (vscode's), so the planner reads by kind.
    db.exec('ANALYZE');
    db.exec("UPDATE sqlite_stat1 SET stat = '562636' || substr(stat, instr(stat, ' ')) WHERE tbl = 'nodes' AND instr(stat, ' ') > 0");
    db.exec("UPDATE sqlite_stat1 SET stat = '562636 1001 3 1 1' WHERE idx = 'idx_nodes_kind'");
    db.exec('ANALYZE sqlite_schema');
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE name LIKE '%x%' AND kind IN (${DEF.map(() => '?').join(',')}) ORDER BY length(name) LIMIT 200`,
    ).all(...DEF) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).some((d) => d.startsWith('SEARCH nodes USING INDEX idx_nodes_kind'))).toBe(true);
    expectSameRows(cg, 'index');
  });

  it('asks SQLite inside a transaction, and for a lookup without a kind filter', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const db = rawDb(cg);
    const scans = countStatements(db, /^\s*SELECT nodes\.\*, 1\.0 as score\s+FROM nodes\s+WHERE name LIKE \?/);
    db.exec('BEGIN');
    try {
      expect(q.findNodesByNameSubstring('Item', { kinds: DEF as never, limit: 50 }).map((r) => r.node.id))
        .toEqual(likeScan(db, 'Item', DEF, false, 50));
    } finally {
      db.exec('ROLLBACK');
    }
    expect(scans.count).toBe(2); // the lookup itself, and the comparison
    q.findNodesByNameSubstring('Item', { limit: 50 });
    expect(scans.count).toBe(3);
    q.findNodesByNameSubstring('Item', { kinds: DEF as never, limit: 50 });
    expect(scans.count).toBe(3);
  });
});

describe('per-word reads happen once per database state (#2620)', () => {
  let dir: string;
  const open: CodeGraph[] = [];
  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perword-'));
    fs.mkdirSync(path.join(dir, 'src', 'zorbtown'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'zorbtown', 'orders.ts'), [
      'export class OrderStateMachine {',
      '  submitOrder(): boolean { return this.transition("submitted"); }',
      '  transition(state: string): boolean { return state.length > 0; }',
      '}',
      'export function linkSessions(ids: string[]): string[] { return ids; }',
    ].join('\n') + '\n');
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  it('reads the name list once for every word the fuzzy fallback tries', async () => {
    const cg = await setup();
    const reads = vi.spyOn(queriesOf(cg), 'getAllNodeNames');
    for (const word of ['submitordr', 'transitoin', 'linksesions', 'qwertyuiop', 'zxcvbnmasd']) cg.searchNodes(word);
    expect(reads).toHaveBeenCalledTimes(1);
    // A typo still finds its symbol.
    expect(cg.searchNodes('transitoin').map((r) => r.node.name)).toContain('transition');
  });

  it('reads the names again after a sync or another connection\'s write', async () => {
    const cg = await setup();
    expect(cg.searchNodes('ordermachne').map((r) => r.node.name)).not.toContain('OrderMachine');
    fs.writeFileSync(path.join(dir, 'src', 'zorbtown', 'more.ts'), 'export class OrderMachine {}\n');
    await cg.sync();
    expect(cg.searchNodes('ordermachne').map((r) => r.node.name)).toContain('OrderMachine');

    const reader = await CodeGraph.open(dir);
    open.push(reader);
    expect(reader.searchNodes('invoicemachne').map((r) => r.node.name)).not.toContain('InvoiceMachine');
    fs.writeFileSync(path.join(dir, 'src', 'zorbtown', 'invoice.ts'), 'export class InvoiceMachine {}\n');
    await cg.sync();
    expect(reader.searchNodes('invoicemachne').map((r) => r.node.name)).toContain('InvoiceMachine');
  });

  it('reads the names fresh inside a transaction, and does not keep them', async () => {
    const cg = await setup();
    const db = rawDb(cg);
    expect(cg.searchNodes('linksesions').map((r) => r.node.name)).toContain('linkSessions');
    db.exec('BEGIN');
    try {
      db.exec("DELETE FROM nodes WHERE name = 'linkSessions'");
      expect(cg.searchNodes('linksesions').map((r) => r.node.name)).not.toContain('linkSessions');
    } finally {
      db.exec('ROLLBACK');
    }
    expect(cg.searchNodes('linksesions').map((r) => r.node.name)).toContain('linkSessions');
  });

  it('skips the LIKE scan for a word no name or qualified name holds, and still finds one inside a qualified name', async () => {
    const cg = await setup();
    const scans = countStatements(rawDb(cg), /qualified_name LIKE \?/);
    // No token starts with these, so FTS misses and the LIKE fallback runs.
    expect(cg.searchNodes('qwzxv')).toEqual([]);
    expect(cg.searchNodes('plmokn')).toEqual([]);
    expect(scans.count).toBe(0);
    // "rbtow" is inside the folder name in a file's qualified name (its path),
    // and inside no symbol name.
    const inPath = cg.searchNodes('rbtow');
    expect(inPath.map((r) => r.node.filePath)).toContain('src/zorbtown/orders.ts');
    // "tateMach" is inside a name.
    expect(cg.searchNodes('tatemach').map((r) => r.node.name)).toContain('OrderStateMachine');
    expect(scans.count).toBe(2);
  });
});

describe('a long query searches a bounded number of words (#2620)', () => {
  let dir: string;
  const open: CodeGraph[] = [];
  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-longquery-'));
    fs.writeFileSync(path.join(dir, 'orders.ts'), [
      'export class OrderStateMachine {',
      '  submitOrder(): boolean { return this.transition("submitted"); }',
      '  transition(state: string): boolean { return state.length > 0; }',
      '}',
      'export function reconcileLedger(): void {}',
      'export function zebrafinchquota(): void {}',
    ].join('\n') + '\n');
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    return cg;
  }

  /** Distinct lowercase filler words that name nothing in the project. */
  function filler(n: number): string {
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(`word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}x`);
    return words.join(' ');
  }

  it('runs a bounded number of searches however long the query is', async () => {
    const cg = await setup();
    const q = queriesOf(cg);
    const search = vi.spyOn(q, 'searchNodes');
    const substring = vi.spyOn(q, 'findNodesByNameSubstring');
    await cg.findRelevantContext(`how does submitOrder work? ${filler(400)}`);
    // A name is searched as a definition prefix (with its stems) and by four
    // substring lookups; a term once.
    expect(search.mock.calls.length).toBeLessThanOrEqual(MAX_QUERY_SYMBOLS * 4 + MAX_QUERY_TERMS);
    expect(substring.mock.calls.length).toBeLessThanOrEqual(MAX_QUERY_SYMBOLS * 4);
  });

  it('searches a bag of symbol names whole', async () => {
    const cg = await setup();
    const search = vi.spyOn(queriesOf(cg), 'searchNodes');
    const bag = 'AuthService AuthController TokenStore SessionManager UserRepository PasswordHasher JwtStrategy '
      + 'RefreshTokenService LoginHandler LogoutHandler AuthGuard RolesGuard PermissionService AuditLogger '
      + 'RateLimiter CsrfMiddleware reconcileLedger';
    expect(extractSearchTerms(bag).length).toBeGreaterThan(64);
    expect(extractSearchTerms(bag).length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
    await cg.findRelevantContext(bag);
    const searched = new Set(search.mock.calls.map((c) => String(c[0]).toLowerCase()));
    for (const term of extractSearchTerms(bag)) expect(searched).toContain(term);
  });

  it('still searches every word of a query within the bound', async () => {
    const cg = await setup();
    const search = vi.spyOn(queriesOf(cg), 'searchNodes');
    await cg.findRelevantContext(`${filler(20)} zebrafinchquota`);
    const searched = new Set(search.mock.calls.map((c) => String(c[0]).toLowerCase()));
    expect(searched).toContain('zebrafinchquota');
    expect(searched).toContain('wordaax');
  });

  it('keeps the identifiers of a long paste, wherever they are in it', async () => {
    const cg = await setup();
    const result = await cg.findRelevantContext(`${filler(300)} where does reconcileLedger run?`);
    expect([...result.nodes.values()].map((n) => n.name)).toContain('reconcileLedger');
  });

  it('drops the plain words past the bound', async () => {
    const cg = await setup();
    const search = vi.spyOn(queriesOf(cg), 'searchNodes');
    await cg.findRelevantContext(`${filler(300)} zebrafinchquota`);
    const searched = new Set(search.mock.calls.map((c) => String(c[0]).toLowerCase()));
    expect(searched).not.toContain('zebrafinchquota');
  });
});

describe('path relevance scores are unchanged by the per-query cache (#2620)', () => {
  /** scorePathRelevance as it was, re-splitting the query for every path. */
  function reference(filePath: string, query: string, projectNameTokens?: Set<string>, isDeprioritized?: boolean): number {
    const pathLower = filePath.toLowerCase();
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();
    let score = 0;
    const allWords = query.split(/\s+/).filter((w) => w.length > 0);
    if (allWords.length === 0) return 0;
    const words = projectNameTokens && projectNameTokens.size > 0
      ? allWords.filter((w) => !projectNameTokens.has(normalizeNameToken(w)))
      : allWords;
    const scored = words.length > 0 ? words : allWords;
    for (const word of scored) {
      const subtokens = extractSearchTerms(word, { stems: false });
      if (subtokens.length === 0) continue;
      if (subtokens.some((t) => fileName.includes(t))) score += 10;
      if (subtokens.some((t) => dirName.includes(t))) score += 5;
      else if (subtokens.some((t) => pathLower.includes(t))) score += 3;
    }
    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
    if ((!isTestQuery && isTestFile(filePath)) || isDeprioritized === true) score -= 15;
    return score;
  }

  it('scores every path as before, repeated words and project names included', () => {
    const queries = [
      'how does the order service submit an order',
      'OrderService.submit order ORDER order_service submitOrder',
      'SuperBizAgent agent routes for the agent',
      'test the order service', '   ', '', 'spec', 'the of and',
      Array.from({ length: 200 }, (_, i) => ['order', 'service', 'ledger', 'Submit', 'superbizagent'][i % 5]).join(' '),
    ];
    const paths = [
      'src/orders/order-service.ts', 'src/orders/__tests__/order-service.test.ts', 'SuperBizAgent/agent/routes.ts',
      'lib/ledger.rb', 'packages/submit/index.js', 'examples/order/main.go', 'README.md', 'a',
    ];
    const tokens = [undefined, new Set<string>(), new Set(['superbizagent'])];
    for (const query of queries) {
      for (const filePath of paths) {
        for (const projectNameTokens of tokens) {
          for (const dep of [undefined, true, false]) {
            expect(scorePathRelevance(filePath, query, projectNameTokens, dep), `${query} | ${filePath}`)
              .toBe(reference(filePath, query, projectNameTokens, dep));
          }
        }
      }
    }
  });
});
