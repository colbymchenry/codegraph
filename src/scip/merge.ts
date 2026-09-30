/**
 * Folds SCIP call sites into codegraph's edges.
 *
 * | case                                   | action                                          |
 * |----------------------------------------|-------------------------------------------------|
 * | agree                                  | flip the edge to `provenance='scip'`            |
 * | conflict (incl. SCIP → external)       | `decide()` — compiler wins                      |
 * | SCIP-only                              | insert `provenance='scip'` (nothing if external)|
 * | heuristic-only, caller file fresh      | keep, `metadata.scipSilent = true`              |
 * | earlier SCIP edge SCIP no longer makes | delete (both ends fresh) or `scipStale = true`  |
 *
 * The flags are how answers tell a compiler-verified edge from an unverified one.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';
import { EXTERNAL, HEURISTIC_PROVENANCE, ScipSites, SiteKind, parseSiteKey, siteKey } from './sites';

export interface MergeOutcome {
  agree: number;
  conflict: number;
  scipOnly: number;
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

/**
 * Merge policy for one call site where both sides resolved something.
 * Returns [heuristic targets to delete, SCIP targets to insert]. The compiler wins:
 * a heuristic target SCIP didn't confirm is a wrong guess.
 */
export function decide(heuristic: Set<string>, scip: Set<string>): [Set<string>, Set<string>] {
  return [
    new Set([...heuristic].filter(t => !scip.has(t))),
    new Set([...scip].filter(t => !heuristic.has(t))),
  ];
}

export function merge(
  db: SqliteDatabase,
  scip: ScipSites,
  heuristic: Map<string, Set<string>>,
  freshFiles: Set<string>
): MergeOutcome {
  const c: MergeOutcome = {
    agree: 0, conflict: 0, scipOnly: 0, scipOnlyExternal: 0, alreadyVerified: 0, silent: 0,
    edgesUpdated: 0, edgesDeleted: 0, edgesInserted: 0,
    scipEdgesKept: 0, scipEdgesDropped: 0, scipEdgesStale: 0,
  };
  const upd = db.prepare(
    `UPDATE edges SET provenance = 'scip'
     WHERE source = ? AND target = ? AND kind = ? AND line = ? AND ${HEURISTIC_PROVENANCE}`);
  const del = db.prepare(`DELETE FROM edges WHERE source = ? AND target = ? AND kind = ? AND line = ? AND ${HEURISTIC_PROVENANCE}`);
  // Column is not part of a site's identity (see sites.ts), so "already there"
  // is judged without it — an earlier import's edge keeps codegraph's column.
  const ins = db.prepare(
    `INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
     SELECT ?1, ?2, ?3, '{"resolvedBy":"scip"}', ?4, ?5, 'scip'
     WHERE NOT EXISTS (SELECT 1 FROM edges WHERE source = ?1 AND target = ?2 AND kind = ?3 AND line = ?4)`);
  const silent = db.prepare(`UPDATE edges SET ${SET_FLAG('scipSilent')} WHERE source = ? AND target = ? AND kind = ? AND line = ? AND ${HEURISTIC_PROVENANCE}`);

  db.exec(`UPDATE edges SET ${CLEAR_FLAG('scipSilent')} WHERE metadata LIKE '%scipSilent%'`);
  reconcileScipEdges(db, scip, freshFiles, c);

  for (const key of new Set([...heuristic.keys(), ...scip.sites.keys()])) {
    const { source, line, kind } = parseSiteKey(key);
    const hs = heuristic.get(key) ?? new Set<string>();
    const resolved = scip.sites.get(key);
    const ss = new Set(resolved?.keys() ?? []);
    const colOf = (t: string) => resolved?.get(t)?.col ?? null;

    if (ss.size === 0) {
      for (const t of hs) c.silent += silent.run(source, t, kind, line).changes;
      continue;
    }
    const insert = (targets: Set<string>) => {
      let n = 0;
      for (const t of targets) if (t !== EXTERNAL) n += ins.run(source, t, kind, line, colOf(t)).changes;
      c.edgesInserted += n;
      return n;
    };
    if (hs.size === 0) {
      // No heuristic edge left here: new, or verified by an earlier import.
      const added = insert(ss);
      if ([...ss].every(t => t === EXTERNAL)) c.scipOnlyExternal++;
      else if (added > 0) c.scipOnly++;
      else c.alreadyVerified++;
      continue;
    }
    for (const t of hs) if (ss.has(t)) c.edgesUpdated += upd.run(source, t, kind, line).changes;
    if (hs.size === ss.size && [...hs].every(t => ss.has(t))) {
      c.agree++;
      continue;
    }
    c.conflict++;
    const [drop, add] = decide(hs, ss);
    for (const t of drop) c.edgesDeleted += del.run(source, t, kind, line).changes;
    insert(add);
  }
  return c;
}

/**
 * Edges an earlier import wrote. Where both ends' files are fresh, SCIP has the
 * full picture: keep what it still produces, drop the rest. Where either end is
 * stale (edited since the index was built, or re-attached by sync onto a
 * rewritten node), the edge can't be re-judged yet — flag it until the next
 * reindex.
 */
function reconcileScipEdges(db: SqliteDatabase, scip: ScipSites, freshFiles: Set<string>, c: MergeOutcome): void {
  const rows = db.prepare(`
    SELECT e.id, e.source, e.target, e.kind, e.line, t.name AS name, s.file_path AS src_file, t.file_path AS tgt_file
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.provenance = 'scip'`).all() as Array<{
      id: number; source: string; target: string; kind: SiteKind; line: number | null;
      name: string; src_file: string; tgt_file: string;
    }>;
  const setStale = db.prepare(`UPDATE edges SET ${SET_FLAG('scipStale')} WHERE id = ?`);
  const clearStale = db.prepare(`UPDATE edges SET ${CLEAR_FLAG('scipStale')} WHERE id = ? AND metadata LIKE '%scipStale%'`);
  const drop = db.prepare('DELETE FROM edges WHERE id = ?');
  for (const r of rows) {
    const key = r.line === null ? null : siteKey(r.source, r.line, r.name, r.kind);
    if (key && scip.sites.get(key)?.has(r.target)) {
      clearStale.run(r.id);
      c.scipEdgesKept++;
    } else if (freshFiles.has(r.src_file) && freshFiles.has(r.tgt_file) && !(key && scip.unknown.has(key))) {
      drop.run(r.id);
      c.scipEdgesDropped++;
    } else {
      setStale.run(r.id);
      c.scipEdgesStale++;
    }
  }
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
