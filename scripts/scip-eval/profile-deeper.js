#!/usr/bin/env node
/**
 * Deeper SCIP/explore bottleneck probe (beyond the four static findings).
 * Usage: node scripts/scip-eval/profile-deeper.js <projectRoot>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

function med(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
function bench(fn, { warmup = 1, iters = 3 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  let last;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    last = fn();
    samples.push(performance.now() - t0);
  }
  return { ms: { median: med(samples), min: Math.min(...samples), max: Math.max(...samples), samples }, result: last };
}

function main() {
  const root = process.argv[2];
  if (!root) throw new Error('usage: profile-deeper.js <projectRoot>');
  const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'));
  const out = { root, at: new Date().toISOString(), scale: {}, indexes: [], probes: {} };

  out.scale = {
    files: db.prepare('SELECT COUNT(*) n FROM files').get().n,
    nodes: db.prepare('SELECT COUNT(*) n FROM nodes').get().n,
    edges: db.prepare('SELECT COUNT(*) n FROM edges').get().n,
    callEdges: db.prepare(`SELECT COUNT(*) n FROM edges WHERE kind='calls'`).get().n,
    scipCalls: db.prepare(`SELECT COUNT(*) n FROM edges WHERE kind='calls' AND provenance='scip'`).get().n,
    unresolved: db.prepare('SELECT COUNT(*) n FROM unresolved_refs').get().n,
    unresolvedFailedCalls: db
      .prepare(`SELECT COUNT(*) n FROM unresolved_refs WHERE status='failed' AND reference_kind='calls'`)
      .get().n,
  };

  out.indexes = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND (tbl_name IN ('unresolved_refs','edges','nodes','files','scip_documents')
         OR name LIKE '%unresolved%' OR name LIKE '%scip%')
       ORDER BY tbl_name, type, name`,
    )
    .all()
    .map((r) => ({ type: r.type, name: r.name, tbl: r.tbl_name, sql: (r.sql || '').replace(/\s+/g, ' ').slice(0, 220) }));

  const hot = db
    .prepare(
      `SELECT t.id, t.name, t.qualified_name, t.file_path, COUNT(*) AS n
       FROM edges e JOIN nodes t ON t.id = e.target
       WHERE e.kind='calls' AND e.provenance='scip' AND t.kind IN ('function','method')
       GROUP BY t.id ORDER BY n DESC LIMIT 3`,
    )
    .all();
  out.scale.hot = hot;

  // --- SQL plans ---
  const t0 = hot[0];
  out.probes.explainUnresolved = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM unresolved_refs u
       WHERE u.status='failed' AND u.name_tail=? AND u.reference_kind='calls' AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN nodes s ON s.id = e.source
         WHERE e.target=? AND e.kind='calls' AND e.line=u.line AND s.file_path=u.file_path)`,
    )
    .all(t0.name, t0.id);

  out.probes.explainSitesOf = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT s.file_path AS file, e.line, s.qualified_name AS caller, e.provenance, e.metadata
       FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'calls' AND e.line IS NOT NULL
       ORDER BY s.file_path, e.line`,
    )
    .all(t0.id);

  out.probes.explainReferenceSites = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT s.file_path AS file, e.line, t.name FROM edges e
       JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'references' AND e.line IS NOT NULL`,
    )
    .all();

  // --- Cheaper unresolved alternatives ---
  const failedName = db
    .prepare(`SELECT COUNT(*) n FROM unresolved_refs WHERE status='failed' AND name_tail=? AND reference_kind='calls'`)
    .get(t0.name).n;

  out.probes.unresolvedAlts = {
    target: t0.qualified_name,
    failedName,
    countFailedNameOnly: bench(
      () => db.prepare(`SELECT COUNT(*) n FROM unresolved_refs WHERE status='failed' AND name_tail=? AND reference_kind='calls'`).get(t0.name).n,
      { iters: 5 },
    ),
    // Approximate: failed name refs minus those already on a call-site line for THIS target (via temp set)
    withTempSiteLines: bench(() => {
      db.exec('BEGIN');
      try {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS _sites(file TEXT, line INT)');
        db.exec('DELETE FROM _sites');
        db.prepare(
          `INSERT INTO _sites(file, line)
           SELECT s.file_path, e.line FROM edges e JOIN nodes s ON s.id=e.source
           WHERE e.target=? AND e.kind='calls' AND e.line IS NOT NULL`,
        ).run(t0.id);
        db.exec('CREATE INDEX IF NOT EXISTS _sites_fl ON _sites(file, line)');
        const n = db
          .prepare(
            `SELECT COUNT(*) n FROM unresolved_refs u
             WHERE u.status='failed' AND u.name_tail=? AND u.reference_kind='calls'
               AND NOT EXISTS (SELECT 1 FROM _sites s WHERE s.file=u.file_path AND s.line=u.line)`,
          )
          .get(t0.name).n;
        return n;
      } finally {
        db.exec('ROLLBACK');
      }
    }, { warmup: 0, iters: 2 }),
    // Skip exclusion entirely (upper bound footnote)
    countFailedNameSkipExclude: null, // same as countFailedNameOnly
  };
  out.probes.unresolvedAlts.countFailedNameSkipExclude = out.probes.unresolvedAlts.countFailedNameOnly;

  // --- sitesOf / call list query ---
  out.probes.sitesOf = {};
  for (const t of hot) {
    out.probes.sitesOf[t.qualified_name] = bench(() => {
      const rows = db
        .prepare(
          `SELECT s.file_path AS file, e.line, s.qualified_name AS caller, e.provenance, e.metadata
           FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'calls' AND e.line IS NOT NULL
           ORDER BY s.file_path, e.line`,
        )
        .all(t.id);
      return { rows: rows.length };
    }, { iters: 3 });
  }

  // --- referenceSites full ---
  out.probes.referenceSitesFull = bench(() => {
    const rows = db
      .prepare(
        `SELECT s.file_path AS file, e.line, t.name FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND e.line IS NOT NULL`,
      )
      .all();
    return { rows: rows.length };
  }, { iters: 2 });

  // --- decode SCIP index ---
  const scipTs = path.join(root, '.codegraph', 'scip', 'typescript.scip');
  if (fs.existsSync(scipTs)) {
    const { loadScipIndex } = require('../../dist/scip/reader.js');
    out.probes.decodeScip = bench(() => {
      const ix = loadScipIndex(scipTs);
      return { docs: ix.documents.length, bytes: fs.statSync(scipTs).size };
    }, { warmup: 0, iters: 2 });
  }

  // --- end-to-end callSitesSection on a mid-cost target (avoid 100s unresolved names) ---
  try {
    const { callSitesSection } = require('../../dist/scip/callsites.js');
    const mid = hot.find((h) => h.name === 'localize') || hot[Math.min(1, hot.length - 1)];
    out.probes.callSitesSectionFull = {
      target: mid.qualified_name,
      ...bench(() => {
        const s = callSitesSection(db, root, mid.name, [mid.id]);
        return { chars: s.length };
      }, { warmup: 0, iters: 1 }),
    };
  } catch (e) {
    out.probes.callSitesSectionFull = { error: String(e && e.message) };
  }

  // --- name_tail cardinality (pain amplifier) ---
  out.probes.worstNameTails = db
    .prepare(
      `SELECT name_tail, COUNT(*) n FROM unresolved_refs
       WHERE status='failed' AND reference_kind='calls'
       GROUP BY name_tail ORDER BY n DESC LIMIT 15`,
    )
    .all();

  // --- heuristicSites-style per-file cost on a 1000-file chunk ---
  const sampleFiles = db.prepare(`SELECT path FROM files ORDER BY path LIMIT 1000`).all().map((r) => r.path);
  const heurStmt = db.prepare(`
    SELECT e.id, e.source, e.line, e.kind, t.name, e.target
    FROM nodes s JOIN edges e ON e.source = s.id JOIN nodes t ON t.id = e.target
    WHERE s.file_path = ? AND e.kind IN ('calls','instantiates','implements','extends','references')
      AND e.line IS NOT NULL AND (provenance IS NULL OR provenance = 'tree-sitter')`);
  out.probes.heuristicSites1000 = bench(() => {
    let rows = 0;
    for (const f of sampleFiles) rows += heurStmt.all(f).length;
    return { files: sampleFiles.length, rows };
  }, { warmup: 0, iters: 1 });

  // --- bySource N queries on 1000 files (merge pattern) ---
  out.probes.bySourceSilent1000 = bench(() => {
    const stmt = db.prepare(
      `SELECT e.id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.metadata LIKE '%scipSilent%' AND s.file_path = ?`,
    );
    let n = 0;
    for (const f of sampleFiles) n += stmt.all(f).length;
    return { files: sampleFiles.length, rows: n };
  }, { warmup: 0, iters: 1 });

  console.log(JSON.stringify(out, null, 2));
  db.close();
}

main();
