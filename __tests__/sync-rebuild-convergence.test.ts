/**
 * Incremental sync must converge to a full rebuild (CG-33).
 *
 * A long-lived, auto-synced index silently diverged from a clean rebuild of the
 * identical tree: 4.3% of distinct edges wrong, in BOTH directions, on
 * codegraph's own repo. Two mechanisms, both exercised here:
 *
 * 1. Resolution binds a reference to one of the same-named definitions
 *    PROJECT-WIDE, so adding or removing a definition changes the answer for
 *    references in files the sync never touches. Those references resolved once
 *    and their rows were deleted, so nothing revisited them — the index kept an
 *    answer that was only correct against an older graph.
 * 2. When nothing disambiguated the candidates, the winner was whichever row
 *    the index scan reached first — i.e. the order files were WRITTEN. A full
 *    index writes in scan order; a sync appends each file as it changes, so the
 *    same tree resolved differently depending on how the index was built.
 *
 * The assertions here compare the whole edge SET, never counts: the divergence
 * is bidirectional and nets out of a total (raw rows differed by 0.7% while
 * 4.3% of edges were wrong), so a count check passes on a broken index.
 *
 * ---
 *
 * THIS SUITE MUST FAIL WITH `CODEGRAPH_NO_REBIND=1` (CG-35).
 *
 * That environment variable is the kill switch on the rebind half of the fix
 * (`src/index.ts`, guarding `resurrectStaleResolutionEdges`). The convergence
 * cases below are the only coverage that half has, so the check is the suite's
 * own regression test:
 *
 *     CODEGRAPH_NO_REBIND=1 npx vitest run __tests__/sync-rebuild-convergence.test.ts
 *
 * must report failures, and an unset run must be green. If you change a case
 * here, re-run both. A version of this suite passed under the kill switch
 * because `rebuildEdgeSet` was not rebuilding anything — see the note there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { createDatabase } from '../src/db/sqlite-adapter';

describe('Incremental sync converges to a full rebuild (CG-33)', () => {
  let testDir: string;
  let cg: CodeGraph;

  const write = (rel: string, content: string) => {
    const full = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  /**
   * Every edge as a `source|target|kind` triple, read from the database with a
   * second read-only connection. Node ids are `sha256(filePath:kind:name:line)`,
   * so for an identical tree they are identical across a sync and a rebuild —
   * which is what makes the two sets directly comparable.
   */
  const edgeSet = (): Set<string> => {
    const { db } = createDatabase(path.join(testDir, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT source, target, kind FROM edges').all() as Array<{
        source: string;
        target: string;
        kind: string;
      }>;
      return new Set(rows.map((r) => `${r.source}|${r.target}|${r.kind}`));
    } finally {
      db.close();
    }
  };

  /**
   * Run `fn` against a second, WRITABLE connection to the same database. Used
   * by the two rule tests below to plant edge shapes the extractor cannot
   * produce on demand — an edge from an engine older than the refName stamp,
   * and a synthesized dispatch edge.
   */
  const withDb = <T>(fn: (db: ReturnType<typeof createDatabase>['db']) => T): T => {
    const { db } = createDatabase(path.join(testDir, '.codegraph', 'codegraph.db'));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  /** Human-readable diff, so a failure names the edges instead of just a count. */
  const describeDiff = (synced: Set<string>, rebuilt: Set<string>): string => {
    const missing = [...rebuilt].filter((e) => !synced.has(e));
    const stale = [...synced].filter((e) => !rebuilt.has(e));
    return `missing from synced: ${missing.length}, stale in synced: ${stale.length}`;
  };

  /**
   * Rebuild the index from scratch over the CURRENT tree and return its edge
   * set — the ground truth a user gets from `codegraph index`.
   *
   * It must go through `CodeGraph.recreate`, which is what the CLI's `index`
   * command does: it DELETES the database file and builds an empty one. Calling
   * `indexAll` on the live handle instead is not a rebuild at all — every file
   * hashes identical, so the store writes nothing (`nodesCreated: 0`), no
   * reference is re-created, and every existing edge survives untouched. The
   * comparison then reads the synced index against ITSELF and can never fail,
   * which is exactly how this suite passed with `CODEGRAPH_NO_REBIND=1` (CG-35).
   */
  const rebuildEdgeSet = async (): Promise<Set<string>> => {
    // Close the live handle first: `recreate` unlinks the database file, and a
    // held handle makes that EBUSY on Windows.
    cg.destroy();
    cg = await CodeGraph.recreate(testDir);
    await cg.indexAll();
    return edgeSet();
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg33-'));
  });

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * The originating shape. `caller.ts` calls `pct` with no import, so it binds
   * by name; at index time `zeta.ts` is the only definition. A later sync adds
   * `alpha.ts`, which sorts FIRST and is therefore the rebuild's answer — but
   * `caller.ts` never changes, so nothing re-resolves it.
   */
  it('rebinds references in UNCHANGED files when a sync adds a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await cg.sync();
    expect(result.filesAdded).toBe(1);
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The mirror direction: removing a definition narrows the candidate set too,
   * so the delta must include names the sync DROPPED, not just names it added.
   *
   * This one already converged before the fix — a removal cascades the edge
   * away and the #1240 removal path resurrects it, so the reference gets
   * re-resolved for free. It is here as a standing guard on the invariant, and
   * because the removal half of the delta has no other coverage: an
   * implementation that only sampled post-sync names would still pass every
   * other test in this file.
   */
  it('rebinds references in UNCHANGED files when a sync removes a competing definition', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/alpha.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    fs.rmSync(path.join(testDir, 'src', 'alpha.ts'));
    const result = await cg.sync();
    expect(result.filesRemoved).toBe(1);

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The delta must be computed per FILE. Comparing one name set across the whole
   * changed batch cancels a name that is added in one changed file while another
   * changed file already defined it — which is precisely the shape a commit that
   * splits a module out has, and it was the largest residual class in the first
   * measurement of this fix.
   */
  it('flags a name added in one changed file even when another changed file already defines it', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\nexport function keep(): number {\n  return 0;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // One commit: a NEW file gains `pct`, and the file that already had `pct`
    // is edited too (so a batch-wide name set would see `pct` on both sides).
    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n + 1;\n}\nexport function keep(): number {\n  return 0;\n}\n`);
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('pct');

    const synced = edgeSet();
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The realistic case the issue was filed from: many edits driven through sync
   * one after another, the way a watcher or a `git pull` applies them. Drift
   * accumulated across syncs, so a single-edit test would not have caught it.
   */
  it('stays converged across a sequence of adds, edits, renames and deletes', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1) + fmt(2) + collect(3);\n}\n`);
    write('src/util/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    write('src/util/omega.ts', `export function fmt(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // 1. add a competing `pct` that sorts before the existing one
    write('src/util/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    await cg.sync();

    // 2. body-only edit — must produce NO definition delta, so the common sync
    //    pays nothing for this machinery
    write('src/util/alpha.ts', `export function pct(n: number): number {\n  return n * 3;\n}\n`);
    const bodyOnly = await cg.sync();
    expect(bodyOnly.filesModified).toBe(1);
    expect(bodyOnly.definitionDelta).toBeUndefined();

    // 3. a rename: `fmt` moves out of omega.ts into a file that sorts first
    write('src/util/omega.ts', `export function other(n: number): number {\n  return n;\n}\n`);
    write('src/util/beta.ts', `export function fmt(n: number): number {\n  return n;\n}\n`);
    await cg.sync();

    // 4. a symbol appears for a reference that never resolved at all
    write('src/util/gamma.ts', `export function collect(n: number): number {\n  return n;\n}\n`);
    await cg.sync();

    // 5. delete the current `pct` winner, so the reference must fall back...
    fs.rmSync(path.join(testDir, 'src', 'util', 'alpha.ts'));
    await cg.sync();

    // 6. ...and then a later sync introduces a new winner ahead of it again.
    //    Ending here rather than on the delete matters: after the delete the
    //    binding happens to land back where it started, which a broken index
    //    also reaches. The final state must be one only re-resolution reaches.
    write('src/util/aaa.ts', `export function pct(n: number): number {\n  return n * 5;\n}\n`);
    await cg.sync();

    const synced = edgeSet();
    expect(synced.size).toBeGreaterThan(0);
    const rebuilt = await rebuildEdgeSet();
    expect(describeDiff(synced, rebuilt)).toBe('missing from synced: 0, stale in synced: 0');
  });

  /**
   * The rebind pass DELETES an edge and re-inserts the reference behind it, so
   * it may only touch edges it can reconstruct. Two shapes it must leave alone,
   * both of which it would otherwise destroy permanently:
   *
   * - an edge with no `metadata.refName` — written by an engine older than the
   *   stamp. Rebuilding a reference from the target's plain name would strip the
   *   receiver context the original text carried (`h.greet` → `greet`);
   * - a synthesized dispatch edge (`provenance='heuristic'`), which is not
   *   resolution output at all: nothing would re-create it, and the synthesizer
   *   that wired it does not run again on this sync.
   *
   * Both are planted directly, since extraction cannot be asked to emit them.
   * The sync then changes the answer for `pct`, which is exactly the condition
   * that makes the pass want to re-open every edge targeting `pct`.
   */
  it('never deletes an edge it cannot reconstruct — no refName stamp, or synthesized', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/other.ts', `export function other(): number {\n  return 0;\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const planted = withDb((db) => {
      const pct = db.prepare("SELECT id FROM nodes WHERE name = 'pct'").get() as { id: string };
      const other = db.prepare("SELECT id FROM nodes WHERE name = 'other'").get() as { id: string };

      // 1. Strip the stamp off the real edge, leaving the rest of its metadata
      //    intact — the shape an index built before the stamp existed has.
      db.prepare(
        `UPDATE edges SET metadata = json_remove(metadata, '$.refName')
         WHERE target = ? AND kind = 'calls'`
      ).run(pct.id);

      // 2. A synthesized edge that DOES carry a stamp, so only the provenance
      //    rule can save it.
      db.prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         VALUES (?, ?, 'calls', ?, 1, 0, 'heuristic')`
      ).run(other.id, pct.id, JSON.stringify({ refName: 'pct', synthesizedBy: 'cg35-test' }));

      return {
        unstamped: `${(db.prepare("SELECT source FROM edges WHERE target = ? AND provenance IS NULL AND kind = 'calls'").get(pct.id) as { source: string }).source}|${pct.id}|calls`,
        synthesized: `${other.id}|${pct.id}|calls`,
      };
    });

    const before = edgeSet();
    expect(before.has(planted.unstamped)).toBe(true);
    expect(before.has(planted.synthesized)).toBe(true);

    write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('pct');

    // Both survive: the pass considered them (their target is `pct`) and
    // declined. Drift is the acceptable outcome here; an edge that no pass can
    // ever restore is not.
    const after = edgeSet();
    expect(after.has(planted.unstamped)).toBe(true);
    expect(after.has(planted.synthesized)).toBe(true);
  });

  /**
   * The per-name ceiling in `getResolutionEdgesByTargetName` (500 by default).
   * Above it a name is generic — `push`, `get`, `join` — one new definition
   * won't flip most of its references, and rebinding an arbitrary subset would
   * manufacture wrong edges while costing the most work. It must DECLINE the
   * name outright, and declining must be lossless.
   *
   * The rare name in the same sync is the control: it proves the pass ran and
   * that the ceiling is what spared the generic one, not a dead rebind pass.
   */
  it('declines a name over the per-name ceiling instead of rebinding an arbitrary subset', async () => {
    // Must exceed the 500 default in getResolutionEdgesByTargetName.
    const OVER_CEILING = 501;
    const callers = Array.from(
      { length: OVER_CEILING },
      (_, i) => `export function hot${i}(): number {\n  return push(${i});\n}\n`
    ).join('');
    write('src/hot.ts', callers);
    write('src/rare.ts', `export function rare(): number {\n  return tug(1);\n}\n`);
    write(
      'src/zzz_defs.ts',
      `export function push(n: number): number {\n  return n;\n}\nexport function tug(n: number): number {\n  return n;\n}\n`
    );
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const targetsOf = (name: string): string[] =>
      withDb((db) =>
        (
          db
            .prepare(
              `SELECT t.file_path AS file FROM edges e
               JOIN nodes t ON t.id = e.target
               JOIN nodes s ON s.id = e.source
               WHERE t.name = ? AND e.kind = 'calls'`
            )
            .all(name) as Array<{ file: string }>
        ).map((r) => r.file)
      );

    expect(targetsOf('push')).toHaveLength(OVER_CEILING);
    expect(new Set(targetsOf('push'))).toEqual(new Set(['src/zzz_defs.ts']));
    expect(targetsOf('tug')).toEqual(['src/zzz_defs.ts']);

    // One sync adds a competing definition of BOTH names, in a file that sorts
    // first and is therefore the rebuild's answer for each.
    write(
      'src/aaa.ts',
      `export function push(n: number): number {\n  return n * 2;\n}\nexport function tug(n: number): number {\n  return n * 2;\n}\n`
    );
    const result = await cg.sync();
    expect(result.definitionDelta).toContain('push');
    expect(result.definitionDelta).toContain('tug');

    // `push` is untouched — every edge still there, still on the old target.
    // This is knowingly divergent from a rebuild; see "Don't chase the
    // residual" in docs/benchmarks/index-drift-cg33.md.
    const pushTargets = targetsOf('push');
    expect(pushTargets).toHaveLength(OVER_CEILING);
    expect(new Set(pushTargets)).toEqual(new Set(['src/zzz_defs.ts']));

    // `tug` — the control — rebound.
    expect(targetsOf('tug')).toEqual(['src/aaa.ts']);
  });

  /**
   * Guards the escape hatch itself: with the rebind pass off, the same sequence
   * must still produce a structurally sound index (no lost or orphaned edges) —
   * just a drifted one. If this ever fails, the pass is doing something the
   * kill switch cannot undo.
   */
  it('CODEGRAPH_NO_REBIND=1 disables the pass without corrupting the index', async () => {
    write('src/caller.ts', `export function run(): number {\n  return pct(1);\n}\n`);
    write('src/zeta.ts', `export function pct(n: number): number {\n  return n;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    const before = edgeSet();

    process.env.CODEGRAPH_NO_REBIND = '1';
    try {
      write('src/alpha.ts', `export function pct(n: number): number {\n  return n * 2;\n}\n`);
      await cg.sync();
    } finally {
      delete process.env.CODEGRAPH_NO_REBIND;
    }

    const after = edgeSet();
    // Every edge that existed before is still there — the pass is the only
    // thing that would have re-opened them, and it did not run.
    for (const edge of before) expect(after.has(edge)).toBe(true);
  });
});

/**
 * Resolution's candidate order must be a property of the CODE, not of the order
 * rows were written. This is the half of CG-33 that a re-resolution pass alone
 * cannot fix: without it, re-resolving a reference against the very same graph
 * can still pick a different winner than a rebuild does.
 */
describe('Same-name candidate order is content-derived, not insertion-derived (CG-33)', () => {
  let testDir: string;
  let cg: CodeGraph;

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('getNodesByName orders by (file_path, start_line) even when rows were written in another order', async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg33-order-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'src', 'mid.ts'), `export function pad(): void {}\nexport function dup(): number {\n  return 2;\n}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'zeta.ts'), `export function dup(): number {\n  return 1;\n}\n`);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // A sync APPENDS this file's nodes, so `alpha.ts` gets the highest rowids
    // despite sorting first — exactly the divergence a full index never has,
    // and the reason candidate order cannot come from the physical row order.
    fs.writeFileSync(path.join(testDir, 'src', 'alpha.ts'), `export function dup(): number {\n  return 3;\n}\n`);
    await cg.sync();

    const keys = cg.getNodesByName('dup').map((n) => `${n.filePath}:${String(n.startLine).padStart(6, '0')}`);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toContain('src/alpha.ts');
  });
});
