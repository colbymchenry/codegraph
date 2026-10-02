#!/usr/bin/env node
/**
 * Profile the four SCIP static-perf hotspots with A/B timings + counters.
 *
 * Usage:
 *   node scripts/scip-eval/profile-hotspots.js [projectRoot]
 *   node scripts/scip-eval/profile-hotspots.js --hash-tree <dir> <globExt...>
 *
 * Writes JSON to stdout. Does not modify the project.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const BATCH = 500;
const MAX_SITES = 1000;
const MAX_DETAILED_CHARS = 8000;
const WARMUP = 1;
const ITERS = 5;

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function bench(label, fn, { warmup = WARMUP, iters = ITERS } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  let last;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    last = fn();
    samples.push(performance.now() - t0);
  }
  return {
    label,
    ms: { min: Math.min(...samples), median: median(samples), max: Math.max(...samples), samples },
    result: last,
  };
}

function walkFiles(root, exts) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.codegraph', 'dist', 'target', 'vendor', '__pycache__']);
  const want = new Set(exts.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (want.has(path.extname(e.name))) out.push(p);
    }
  }
  walk(root);
  return out;
}

/** Mimic store.readHashed / hashContent cheaply for I/O timing (sha256 of content). */
function hashFile(abs) {
  const { createHash } = require('crypto');
  const st = fs.statSync(abs);
  if (st.size > 1024 * 1024) return `oversize:${st.size}`;
  const text = fs.readFileSync(abs);
  return createHash('sha256').update(text).digest('hex');
}

function profileHashTree(dir, exts) {
  const files = walkFiles(dir, exts);
  const disk = bench('snapshot_disk_hash', () => {
    let n = 0;
    let bytes = 0;
    for (const f of files) {
      try {
        const st = fs.statSync(f);
        bytes += st.size > 1024 * 1024 ? 0 : st.size;
        hashFile(f);
        n++;
      } catch {
        /* skip */
      }
    }
    return { n, bytes };
  });
  const noopMeta = bench('snapshot_path_list_only', () => ({ n: files.length }));
  return {
    kind: 'hash-tree',
    dir,
    exts,
    fileCount: files.length,
    disk,
    pathListOnly: noopMeta,
    estimatedSaveMs: disk.ms.median - noopMeta.ms.median,
  };
}

function openDb(projectRoot) {
  const dbPath = path.join(projectRoot, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no db at ${dbPath}`);
  // Copy to temp if WAL needs write — prefer opening normally for accurate timings.
  return new DatabaseSync(dbPath);
}

function profileProject(projectRoot) {
  const db = openDb(projectRoot);
  const report = {
    kind: 'project',
    projectRoot,
    at: new Date().toISOString(),
    scale: {},
    findings: {},
  };

  report.scale.files = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  report.scale.byLang = db
    .prepare('SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC')
    .all();
  report.scale.scipCallEdges = db
    .prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind='calls' AND provenance='scip'`)
    .get().n;

  // Languages the installed SCIP indexes cover (fallback: top language in files).
  const LANG_GROUPS = {
    typescript: ['typescript', 'javascript', 'tsx', 'jsx'],
    python: ['python'],
    go: ['go'],
    rust: ['rust'],
  };
  const scipDir = path.join(projectRoot, '.codegraph', 'scip');
  const installedLangs = [];
  let docPaths = [];
  if (fs.existsSync(scipDir)) {
    for (const lang of Object.keys(LANG_GROUPS)) {
      const metaFile = path.join(scipDir, `${lang}.meta.json`);
      if (!fs.existsSync(metaFile)) continue;
      installedLangs.push(lang);
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        docPaths.push(...Object.keys(meta.hashes || {}));
      } catch {
        /* keep */
      }
    }
  }
  docPaths = [...new Set(docPaths)];
  const snapLangs = installedLangs.length
    ? [...new Set(installedLangs.flatMap((l) => LANG_GROUPS[l] || []))]
    : [report.scale.byLang[0]?.language].filter(Boolean);
  const snapPaths = snapLangs.length
    ? db
        .prepare(`SELECT path, content_hash FROM files WHERE language IN (${snapLangs.map(() => '?').join(',')})`)
        .all(...snapLangs)
    : [];
  if (docPaths.length === 0) docPaths = snapPaths.map((r) => r.path);
  report.scale.snapshotLanguages = snapLangs;
  report.scale.snapshotFiles = snapPaths.length;
  report.scale.installedScipLangs = installedLangs;
  report.scale.hashGatePaths = docPaths.length;

  // --- Finding 1: snapshotHashes disk vs DB ---
  const counters = { reads: 0, readBytes: 0, stats: 0 };
  const diskSnap = bench('snapshotHashes_disk', () => {
    counters.reads = 0;
    counters.readBytes = 0;
    counters.stats = 0;
    const out = {};
    for (const { path: rel } of snapPaths) {
      const abs = path.join(projectRoot, rel);
      try {
        counters.stats++;
        const st = fs.statSync(abs);
        if (st.size > 1024 * 1024) {
          out[rel] = `oversize:${st.size}`;
          continue;
        }
        counters.reads++;
        const buf = fs.readFileSync(abs);
        counters.readBytes += buf.length;
        out[rel] = require('crypto').createHash('sha256').update(buf).digest('hex');
      } catch {
        /* skip */
      }
    }
    return { count: Object.keys(out).length, reads: counters.reads, readBytes: counters.readBytes, stats: counters.stats };
  });

  const dbSnap = bench('snapshotHashes_db', () => {
    const out = {};
    for (const { path: rel, content_hash } of snapPaths) out[rel] = content_hash;
    return { count: Object.keys(out).length };
  });

  report.findings.snapshotHashes = {
    disk: diskSnap,
    db: dbSnap,
    saveMs: diskSnap.ms.median - dbSnap.ms.median,
    savePctOfDisk: diskSnap.ms.median ? (1 - dbSnap.ms.median / diskSnap.ms.median) * 100 : null,
    io: diskSnap.result,
  };

  const point = bench('indexedHashes_point', () => {
    const stmt = db.prepare('SELECT content_hash FROM files WHERE path = ?');
    const out = new Map();
    let hits = 0;
    for (const p of docPaths) {
      const row = stmt.get(p);
      if (row) {
        out.set(p, row.content_hash);
        hits++;
      }
    }
    return { hits, size: out.size };
  });

  const batched = bench('indexedHashes_batched', () => {
    const out = new Map();
    let hits = 0;
    for (let i = 0; i < docPaths.length; i += BATCH) {
      const chunk = docPaths.slice(i, i + BATCH);
      const stmt = db.prepare(
        `SELECT path, content_hash FROM files WHERE path IN (${chunk.map(() => '?').join(',')})`,
      );
      for (const row of stmt.all(...chunk)) {
        out.set(row.path, row.content_hash);
        hits++;
      }
    }
    return { hits, size: out.size, batches: Math.ceil(docPaths.length / BATCH) };
  });

  const allFiles = bench('indexedHashes_full_scan', () => {
    const out = new Map();
    for (const row of db.prepare('SELECT path, content_hash FROM files').all()) out.set(row.path, row.content_hash);
    let hits = 0;
    for (const p of docPaths) if (out.has(p)) hits++;
    return { hits, mapSize: out.size };
  });

  report.findings.indexedHashes = {
    point,
    batched,
    fullScan: allFiles,
    saveMsPointToBatch: point.ms.median - batched.ms.median,
    saveMsPointToFull: point.ms.median - allFiles.ms.median,
  };

  // --- Findings 2+4: callSitesSection breakdown ---
  const hot = db
    .prepare(
      `SELECT t.id, t.name, t.qualified_name, t.file_path, t.start_line, t.language, COUNT(*) AS n
       FROM edges e JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'calls' AND e.line IS NOT NULL AND t.kind IN ('function', 'method')
         AND e.provenance = 'scip'
       GROUP BY t.id ORDER BY n DESC LIMIT 8`,
    )
    .all();
  // Always include notorious high-fan-in names when present (Playwright evaluate, etc.).
  for (const name of ['evaluate', 'start', 'get', 'run']) {
    if (hot.some((h) => h.name === name)) continue;
    const extra = db
      .prepare(
        `SELECT t.id, t.name, t.qualified_name, t.file_path, t.start_line, t.language, COUNT(*) AS n
         FROM edges e JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND e.line IS NOT NULL AND t.kind IN ('function', 'method')
           AND e.provenance = 'scip' AND t.name = ?
         GROUP BY t.id ORDER BY n DESC LIMIT 1`,
      )
      .get(name);
    if (extra) hot.push(extra);
  }
  hot.sort((a, b) => b.n - a.n);
  report.scale.hottestScipTargets = hot;

  const sitesOf = db.prepare(`SELECT s.file_path AS file, e.line, s.qualified_name AS caller, e.provenance, e.metadata
    FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'calls' AND e.line IS NOT NULL
    ORDER BY s.file_path, e.line`);

  function profileCallSites(target) {
    const sites = sitesOf.all(target.id);
    const shown = sites.slice(0, MAX_SITES);

    // Current path: always build detailed with line text, then maybe discard.
    const detailedCurrent = bench(`callSites_detailed_current_${target.name}`, () => {
      const texts = new Map();
      let reads = 0;
      let readBytes = 0;
      let jsonParses = 0;
      const lineText = (file, line) => {
        if (!texts.has(file)) {
          try {
            const abs = path.join(projectRoot, file);
            const buf = fs.readFileSync(abs);
            reads++;
            readBytes += buf.length;
            texts.set(file, buf.toString('utf8').split(/\r?\n/));
          } catch {
            texts.set(file, null);
          }
        }
        return (texts.get(file)?.[line - 1] ?? '').trim().slice(0, 140);
      };
      const ok = sites.map((s) => {
        if (!s.metadata) return s.provenance === 'scip';
        jsonParses++;
        try {
          const meta = JSON.parse(s.metadata);
          return !(meta && (meta.scipSilent || meta.scipStale));
        } catch {
          return s.provenance === 'scip';
        }
      });
      const verified = ok.filter(Boolean).length;
      const detailed = [];
      let file = '';
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i];
        if (s.file !== file) detailed.push(`\`${(file = s.file)}\``);
        detailed.push(`- ${s.line}${ok[i] ? '' : ' [unverified]'} — \`${lineText(s.file, s.line)}\` (in \`${s.caller}\`)`);
      }
      const text = detailed.join('\n');
      const usedDetailed = text.length <= MAX_DETAILED_CHARS;
      return {
        sites: sites.length,
        shown: shown.length,
        verified,
        uniqueFiles: texts.size,
        reads,
        readBytes,
        jsonParses,
        detailedChars: text.length,
        discardedDetailed: !usedDetailed,
      };
    });

    // Fixed path: if over budget, skip file reads and emit compact listing.
    const compactFirst = bench(`callSites_compact_first_${target.name}`, () => {
      let jsonParses = 0;
      const ok = sites.map((s) => {
        if (!s.metadata) return s.provenance === 'scip';
        jsonParses++;
        try {
          const meta = JSON.parse(s.metadata);
          return !(meta && (meta.scipSilent || meta.scipStale));
        } catch {
          return s.provenance === 'scip';
        }
      });
      // Cheap size estimate: ~80 chars/site average for detailed lines.
      const estimate = shown.length * 80;
      if (estimate > MAX_DETAILED_CHARS || shown.length > 80) {
        const byFile = new Map();
        for (let i = 0; i < shown.length; i++) {
          const s = shown[i];
          byFile.set(s.file, [...(byFile.get(s.file) ?? []), `${s.line}${ok[i] ? '' : '?'}`]);
        }
        return {
          mode: 'compact',
          sites: sites.length,
          shown: shown.length,
          uniqueFiles: byFile.size,
          reads: 0,
          readBytes: 0,
          jsonParses,
        };
      }
      // Small: still do detailed (same as current for small fan-in).
      const texts = new Map();
      let reads = 0;
      let readBytes = 0;
      for (const s of shown) {
        if (texts.has(s.file)) continue;
        try {
          const buf = fs.readFileSync(path.join(projectRoot, s.file));
          reads++;
          readBytes += buf.length;
          texts.set(s.file, true);
        } catch {
          texts.set(s.file, false);
        }
      }
      return { mode: 'detailed', sites: sites.length, shown: shown.length, uniqueFiles: texts.size, reads, readBytes, jsonParses };
    });

    // otherCalls current vs SQL aggregate
    const otherCurrent = bench(`otherCalls_js_${target.name}`, () => {
      const rows = db
        .prepare(
          `SELECT n.qualified_name AS qn, n.file_path AS file, e.provenance, e.metadata
           FROM edges e JOIN nodes n ON n.id = e.target
           WHERE n.name = ? AND NOT (n.qualified_name = ? AND n.file_path = ?) AND e.kind = 'calls'`,
        )
        .all(target.name, target.qualified_name, target.file_path);
      let jsonParses = 0;
      const elsewhere = new Map();
      for (const r of rows) {
        const key = `${r.qn}\0${r.file}`;
        const o = elsewhere.get(key) ?? { qn: r.qn, file: r.file, verified: 0, n: 0 };
        o.n++;
        if (r.metadata) {
          jsonParses++;
          try {
            JSON.parse(r.metadata);
          } catch {
            /* */
          }
        }
        if (r.provenance === 'scip') o.verified++;
        elsewhere.set(key, o);
      }
      const ordered = [...elsewhere.values()].sort((a, b) => b.n - a.n).slice(0, 5);
      return { rows: rows.length, groups: elsewhere.size, top: ordered.length, jsonParses };
    });

    const otherSql = bench(`otherCalls_sql_${target.name}`, () => {
      const rows = db
        .prepare(
          `SELECT n.qualified_name AS qn, n.file_path AS file, COUNT(*) AS n,
                  SUM(CASE WHEN e.provenance = 'scip' THEN 1 ELSE 0 END) AS verified
           FROM edges e JOIN nodes n ON n.id = e.target
           WHERE n.name = ? AND NOT (n.qualified_name = ? AND n.file_path = ?) AND e.kind = 'calls'
           GROUP BY n.qualified_name, n.file_path
           ORDER BY n DESC LIMIT 5`,
        )
        .all(target.name, target.qualified_name, target.file_path);
      return { top: rows.length, rows: rows.length };
    });

    return {
      target: {
        id: target.id,
        name: target.name,
        qualified_name: target.qualified_name,
        file_path: target.file_path,
        n: target.n,
      },
      detailedCurrent,
      compactFirst,
      saveMsCallSites: detailedCurrent.ms.median - compactFirst.ms.median,
      otherCurrent,
      otherSql,
      saveMsOther: otherCurrent.ms.median - otherSql.ms.median,
    };
  }

  // Profile top-3 by sites plus any evaluate target (large-repo stress).
  const toProfile = [];
  for (const t of hot) {
    if (toProfile.length >= 3 && t.name !== 'evaluate') continue;
    if (toProfile.some((x) => x.id === t.id)) continue;
    toProfile.push(t);
    if (toProfile.length >= 4) break;
  }
  report.findings.callSites = toProfile.map(profileCallSites);

  // Full-scan referenceSites cost (context for produce)
  const refSites = bench('referenceSites_full', () => {
    const rows = db
      .prepare(
        `SELECT s.file_path AS file, e.line, t.name FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND e.line IS NOT NULL`,
      )
      .all();
    return { rows: rows.length };
  });
  report.findings.referenceSitesFull = refSites;

  db.close();
  return report;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--hash-tree') {
    const dir = args[1];
    const exts = args.slice(2);
    if (!dir || exts.length === 0) {
      console.error('usage: --hash-tree <dir> <ext...>');
      process.exit(1);
    }
    console.log(JSON.stringify(profileHashTree(dir, exts), null, 2));
    return;
  }
  const root = args[0] || process.cwd();
  console.log(JSON.stringify(profileProject(root), null, 2));
}

main();
