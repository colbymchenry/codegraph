/**
 * Folds SCIP call sites into codegraph's edges.
 *
 * | case                                   | action                                          |
 * |----------------------------------------|-------------------------------------------------|
 * | agree                                  | flip the edge to `provenance='scip'`            |
 * | conflict (incl. SCIP → external)       | compiler wins: heuristic targets SCIP didn't    |
 * |                                        | confirm are deleted, SCIP's are inserted        |
 * | SCIP-only                              | insert `provenance='scip'` (nothing if external)|
 * | heuristic-only, caller file fresh      | keep, `metadata.scipSilent = true`              |
 * | compiler target has no node, heuristic | verify, `metadata.scipDispatch = true` — the    |
 * |   target implements it                 | call reaches it through an interface            |
 * | earlier SCIP edge SCIP no longer makes | delete (both ends fresh) or `scipStale = true`  |
 *
 * The flags are how answers tell a compiler-verified edge from an unverified one.
 *
 * Decisions are made in memory, then written in batches by edge id: a large
 * repo changes around a million edges, and one statement per edge was most of
 * the merge's time.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';
import { EXTERNAL, HeuristicSites, ScipSites, parseSiteKey, siteKey, siteKindOfEdge } from './sites';

export interface MergeOutcome {
  agree: number;
  conflict: number;
  scipOnly: number;
  /** heuristic edges to an implementation of an interface method that has no node, verified through it */
  dispatchVerified: number;
  scipOnlyExternal: number;
  alreadyVerified: number;
  silent: number;
  edgesUpdated: number;
  edgesDeleted: number;
  edgesInserted: number;
  scipEdgesKept: number;
  scipEdgesDropped: number;
  scipEdgesStale: number;
}

const SET_FLAG = (flag: string) => `metadata = json_set(COALESCE(metadata, '{}'), '$.${flag}', json('true'))`;
const CLEAR_FLAG = (flag: string) => `metadata = json_remove(metadata, '$.${flag}')`;
const BATCH = 500;

const edgeKey = (source: string, target: string, kind: string, line: number) => `${source}\0${target}\0${kind}\0${line}`;

/**
 * Runs `<sqlPrefix> (?,?,…)` over `ids` in batches; returns rows changed.
 * Ids go in rowid order so consecutive batches touch neighbouring pages —
 * random order on a multi-GB table is a page-cache miss per row.
 */
function byIds(db: SqliteDatabase, sqlPrefix: string, ids: number[]): number {
  ids.sort((a, b) => a - b);
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    changed += db.prepare(`${sqlPrefix} (${chunk.map(() => '?').join(',')})`).run(...chunk).changes;
  }
  return changed;
}

/**
 * Rows of `sql` (which joins the edge's source as `s` and ends in a WHERE clause),
 * for sources in `files` — one indexed query per file — or for every edge.
 */
function bySource<T>(db: SqliteDatabase, sql: string, files?: Set<string>): T[] {
  if (!files) return db.prepare(sql).all() as T[];
  const stmt = db.prepare(`${sql} AND s.file_path = ?`);
  return [...files].flatMap(f => stmt.all(f) as T[]);
}

/** `judged`: only sites whose caller is in these files are re-judged (a patch's scope); edges elsewhere stay as they are. */
export function merge(
  db: SqliteDatabase, scip: ScipSites, heuristic: HeuristicSites, freshFiles: Set<string>, judged?: Set<string>
): MergeOutcome {
  const c: MergeOutcome = {
    agree: 0, conflict: 0, scipOnly: 0, dispatchVerified: 0, scipOnlyExternal: 0, alreadyVerified: 0, silent: 0,
    edgesUpdated: 0, edgesDeleted: 0, edgesInserted: 0,
    scipEdgesKept: 0, scipEdgesDropped: 0, scipEdgesStale: 0,
  };
  if (!judged) db.exec(`UPDATE edges SET ${CLEAR_FLAG('scipSilent')} WHERE metadata LIKE '%scipSilent%'`);
  else {
    const flagged = bySource<{ id: number }>(db, `SELECT e.id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.metadata LIKE '%scipSilent%'`, judged);
    byIds(db, `UPDATE edges SET ${CLEAR_FLAG('scipSilent')} WHERE id IN`, flagged.map(r => r.id));
  }
  // Column is not part of a site's identity (see sites.ts), so "already there"
  // is judged without it — an earlier import's edge, or a synthesized one at
  // the same site, keeps its own column and is not duplicated.
  const existing = reconcileScipEdges(db, scip, freshFiles, c, judged);
  const synthesized = bySource<{ source: string; target: string; kind: string; line: number }>(db, `SELECT e.source, e.target, e.kind, e.line
    FROM edges e JOIN nodes s ON s.id = e.source
    WHERE e.provenance = 'heuristic' AND e.kind IN ('calls', 'instantiates', 'implements', 'extends') AND e.line IS NOT NULL`, judged);
  for (const e of synthesized) existing.add(edgeKey(e.source, e.target, e.kind, e.line));

  const verify: number[] = [];
  const verifyDispatch: number[] = [];
  const remove: number[] = [];
  const silent: number[] = [];
  const insert: Array<[string, string, string, number, number]> = [];

  for (const key of new Set([...heuristic.keys(), ...scip.sites.keys()])) {
    const hs = heuristic.get(key);
    const resolved = scip.sites.get(key);
    const dispatch = scip.dispatch.get(key);
    const viaInterface = (target: string, ids: number[]) => {
      if (!dispatch?.has(target)) return false;
      verifyDispatch.push(...ids);
      c.dispatchVerified += ids.length;
      return true;
    };
    if (!resolved) {
      for (const [target, ids] of hs ?? []) if (!viaInterface(target, ids)) silent.push(...ids);
      continue;
    }
    const { source, line, kind } = parseSiteKey(key);
    let added = 0;
    for (const { target, col, edgeKind = kind } of resolved.values()) {
      if (target === EXTERNAL || hs?.has(target)) continue;
      const k = edgeKey(source, target, edgeKind, line);
      if (existing.has(k)) continue;
      existing.add(k);
      insert.push([source, target, edgeKind, line, col]);
      added++;
    }
    if (!hs) {
      // No heuristic edge left here: new, or verified by an earlier import.
      if ([...resolved.keys()].every(t => t === EXTERNAL)) c.scipOnlyExternal++;
      else if (added > 0) c.scipOnly++;
      else c.alreadyVerified++;
      continue;
    }
    let confirmed = 0;
    for (const [target, ids] of hs) {
      if (resolved.has(target)) {
        verify.push(...ids);
        confirmed++;
      } else if (viaInterface(target, ids)) {
        confirmed++;
      } else {
        remove.push(...ids); // the compiler resolved this call elsewhere
      }
    }
    if (confirmed === hs.size && confirmed === resolved.size) c.agree++;
    else c.conflict++;
  }

  c.edgesUpdated += byIds(db, `UPDATE edges SET provenance = 'scip', ${CLEAR_FLAG('scipDispatch')} WHERE id IN`, verify);
  c.edgesUpdated += byIds(db, `UPDATE edges SET provenance = 'scip', ${SET_FLAG('scipDispatch')} WHERE id IN`, verifyDispatch);
  c.edgesDeleted += byIds(db, 'DELETE FROM edges WHERE id IN', remove);
  c.silent += byIds(db, `UPDATE edges SET ${SET_FLAG('scipSilent')} WHERE id IN`, silent);
  insert.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // by source: the identity index's leading column
  for (let i = 0; i < insert.length; i += BATCH) {
    const chunk = insert.slice(i, i + BATCH);
    c.edgesInserted += db.prepare(
      `INSERT OR IGNORE INTO edges (source, target, kind, line, col, provenance) VALUES ${chunk.map(() => "(?,?,?,?,?,'scip')").join(',')}`
    ).run(...chunk.flat()).changes;
  }
  return c;
}

/**
 * Edges an earlier import wrote. Where both ends' files are fresh, SCIP has the
 * full picture: keep what it still produces, drop the rest. Where either end is
 * stale (edited since the index was built, or re-attached by sync onto a
 * rewritten node), the edge can't be re-judged yet — flag it until the next
 * reindex. Returns the keys of the SCIP edges that remain.
 */
function reconcileScipEdges(db: SqliteDatabase, scip: ScipSites, freshFiles: Set<string>, c: MergeOutcome, judged?: Set<string>): Set<string> {
  const rows = bySource<{
    id: number; source: string; target: string; kind: string; line: number | null;
    name: string; src_file: string; tgt_file: string;
  }>(db, `
    SELECT e.id, e.source, e.target, e.kind, e.line, t.name AS name, s.file_path AS src_file, t.file_path AS tgt_file
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.provenance = 'scip'`, judged);
  const kept = new Set<string>();
  const keep: number[] = [];
  const drop: number[] = [];
  const stale: number[] = [];
  for (const r of rows) {
    const key = r.line === null ? null : siteKey(r.source, r.line, r.name, siteKindOfEdge(r.kind));
    if (key && (scip.sites.get(key)?.has(r.target) || scip.dispatch.get(key)?.has(r.target))) {
      keep.push(r.id);
      kept.add(edgeKey(r.source, r.target, r.kind, r.line!));
    } else if (freshFiles.has(r.src_file) && freshFiles.has(r.tgt_file) && !(key && scip.unknown.has(key))) {
      drop.push(r.id);
    } else {
      stale.push(r.id);
      if (r.line !== null) kept.add(edgeKey(r.source, r.target, r.kind, r.line));
    }
  }
  byIds(db, `UPDATE edges SET ${CLEAR_FLAG('scipStale')} WHERE metadata LIKE '%scipStale%' AND id IN`, keep);
  byIds(db, 'DELETE FROM edges WHERE id IN', drop);
  byIds(db, `UPDATE edges SET ${SET_FLAG('scipStale')} WHERE id IN`, stale);
  c.scipEdgesKept += keep.length;
  c.scipEdgesDropped += drop.length;
  c.scipEdgesStale += stale.length;
  return kept;
}

/**
 * After a sync rewrote `changedFiles`: SCIP edges touching them can no longer be
 * vouched for (sync re-attaches incoming edges onto the new nodes by name).
 */
export function markStaleForFiles(db: SqliteDatabase, changedFiles: readonly string[]): number {
  if (changedFiles.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE edges SET ${SET_FLAG('scipStale')}
    WHERE provenance = 'scip' AND (
      source IN (SELECT id FROM nodes WHERE file_path = ?1) OR
      target IN (SELECT id FROM nodes WHERE file_path = ?1))`);
  let n = 0;
  for (const f of changedFiles) n += stmt.run(f).changes;
  return n;
}
