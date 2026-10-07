import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolHandler } from '../../src/mcp/tools';
import { countUnresolvedOtherCalls } from '../../src/scip/callsites';
import { FixtureProject, importFixtureIndex, indexedFixture, merge, nodeId } from './helpers';

/** codegraph_explore's "Call sites of" section (src/scip/callsites.ts), on the TypeScript fixture. */
describe('explore: compiler-verified call sites', () => {
  let p: FixtureProject;
  const explore = async (query: string) =>
    ((await new ToolHandler(p.cg).execute('codegraph_explore', { query })).content[0] as { text: string }).text;
  const addCall = (source: string, target: string, line: number) => p.cg.scipReadDb()
    .prepare(`INSERT INTO edges (source, target, kind, line, col, provenance) VALUES (?, ?, 'calls', ?, 2, 'scip')`).run(source, target, line);

  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('explore lists every compiler-verified call site of the symbol a query names', async () => {
    expect(await explore('Invoice totalPrice callers')).not.toContain('**Call sites of'); // no compiler data yet: unchanged
    importFixtureIndex(p.dir, 'scip-ts');
    await merge(p);
    const text = await explore('Invoice totalPrice callers');
    expect(text).toMatch(/\*\*Call sites of `Invoice::totalPrice` \(src\/models\.ts:\d+\) — \d+: \d+ compiler-verified\*\*/);
    expect(text).toContain('`src/main.ts`\n- 6 — `return invoices.reduce((acc, inv) => acc + inv.totalPrice(), 0) + helper(2);` (in `sum`)');
    expect(text).toMatch(/\n- \d+ — `return new Invoice\(4\)` \(in `chained`\)/); // a chain: keyed where its expression starts
    // what a grep for the name would add, accounted for: `o.totalPrice()` on an Order
    expect(text).toMatch(/Other calls named `totalPrice`, which neither the compiler nor codegraph resolved to this one: \d+ to `Order::totalPrice` \(src\/models\.ts, compiler-verified\)/);
  });

  it('a symbol called hundreds of times is listed compactly, every line kept, so explore\'s source still fits', async () => {
    importFixtureIndex(p.dir, 'scip-ts');
    await merge(p);
    const db = p.cg.scipReadDb();
    for (let line = 1000; line < 1500; line++) addCall(nodeId(db, 'make'), nodeId(db, 'Invoice::totalPrice'), line);
    const text = await explore('Invoice totalPrice callers');
    const section = text.slice(text.indexOf('**Call sites of `Invoice::totalPrice`'), text.indexOf('Other calls named `totalPrice`'));
    expect(section).toContain('Lines per file');
    expect(section).toMatch(/- `src\/main\.ts`: [\d, ]*1000, 1001, [\d, ]*1499/);
    expect(section.length).toBeLessThan(5000);
  });

  it('a file the query names picks between same-named methods (bench T2: the client one was listed, the asked-for one not)', async () => {
    importFixtureIndex(p.dir, 'scip-ts');
    await merge(p);
    // A second, compiler-verified `Invoice::totalPrice` in another file (as Playwright has a client and a server `JSHandle`).
    const db = p.cg.scipReadDb();
    db.prepare(`INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at)
      VALUES ('other-total', 'method', 'totalPrice', 'Invoice::totalPrice', 'src/client/models.ts', 'typescript', 1, 3, 0, 1, 0)`).run();
    addCall(nodeId(db, 'make'), 'other-total', 12);
    const listed = async (query: string) =>
      [...(await explore(query)).matchAll(/\*\*Call sites of `Invoice::totalPrice` \(([^:]+):/g)].map(m => m[1]).sort();
    expect(await listed('Invoice.totalPrice callers')).toEqual(['src/client/models.ts', 'src/models.ts']);
    expect(await listed('Invoice.totalPrice in src/models.ts callers, not Order.totalPrice')).toEqual(['src/models.ts']);
    expect(await listed('callers of `Invoice.totalPrice()` (client/models.ts)')).toEqual(['src/client/models.ts']);
  });

  it('a stale scip edge (provenance still scip) is marked unverified, same as scipVerdict', async () => {
    importFixtureIndex(p.dir, 'scip-ts');
    await merge(p);
    const db = p.cg.scipReadDb();
    const target = nodeId(db, 'Invoice::totalPrice');
    // Keep provenance='scip' but flag scipStale — the old bug counted these as compiler-verified.
    db.prepare(`UPDATE edges SET metadata = json_set(COALESCE(metadata, '{}'), '$.scipStale', json('true'))
      WHERE target = ? AND kind = 'calls' AND provenance = 'scip' AND line = 6`).run(target);
    const text = await explore('Invoice totalPrice callers');
    expect(text).toMatch(/Call sites of `Invoice::totalPrice`[^]*\d+: \d+ compiler-verified, \d+ not \(marked\)/);
    expect(text).toMatch(/\n- 6 \[unverified\] —/);
  });
});

describe('countUnresolvedOtherCalls', () => {
  let p: FixtureProject;
  beforeEach(async () => { p = await indexedFixture('scip-ts'); });
  afterEach(() => p.close());

  it('matches the old correlated NOT EXISTS count (same exclusion semantics)', async () => {
    importFixtureIndex(p.dir, 'scip-ts');
    await merge(p);
    const db = p.cg.scipReadDb();
    const t = db.prepare(
      `SELECT id, name FROM nodes WHERE qualified_name = 'Invoice::totalPrice' AND kind = 'method' LIMIT 1`,
    ).get() as { id: string; name: string };
    const sites = db.prepare(`SELECT s.file_path AS file, e.line FROM edges e JOIN nodes s ON s.id = e.source
      WHERE e.target = ? AND e.kind = 'calls' AND e.line IS NOT NULL`).all(t.id) as { file: string; line: number }[];
    const fast = countUnresolvedOtherCalls(db, t.name, sites);
    const slow = (db.prepare(`SELECT COUNT(*) AS n FROM unresolved_refs u
      WHERE u.status = 'failed' AND u.name_tail = ? AND u.reference_kind = 'calls' AND NOT EXISTS (
        SELECT 1 FROM edges e JOIN nodes s ON s.id = e.source
        WHERE e.target = ? AND e.kind = 'calls' AND e.line = u.line AND s.file_path = u.file_path)`
    ).get(t.name, t.id) as { n: number }).n;
    expect(fast).toBe(slow);
  });
});
