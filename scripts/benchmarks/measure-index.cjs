// Standalone benchmark harness; see docs/benchmarks/regression-audit-2026-09.md.
// Arguments: built engine directory, fixture root, existing output directory, native|wasm.
const fs = require('node:fs');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const [engine, root, out, backend] = process.argv.slice(2);
if (!engine || !root || !out || !['native', 'wasm'].includes(backend)) {
  throw new Error('Usage: node measure-index.cjs BUILT_ENGINE FRESH_FIXTURE EXISTING_OUTPUT native|wasm');
}
if (fs.existsSync(path.join(root, '.codegraph'))) {
  throw new Error('Refusing an existing fixture index; preserve it and use a fresh fixture.');
}
const begin = performance.now();
const tracePath = path.join(out, 'progress.ndjson');
// Exclusive creation prevents accidental reuse of a previous run's evidence.
const traceFd = fs.openSync(tracePath, 'wx');
let phase = 'opening';
function progress(event, details = {}) {
  fs.writeSync(traceFd, JSON.stringify({ event, phase, epochMs: Date.now(),
    wallMs: performance.now() - begin, cpu: process.cpuUsage(), rss: process.memoryUsage().rss,
    ...details }) + '\n');
}
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let previousLoop = performance.eventLoopUtilization();
const heartbeat = setInterval(() => {
  const current = performance.eventLoopUtilization();
  progress('heartbeat', { eventLoop: performance.eventLoopUtilization(current, previousLoop),
    delayMaxMs: loopDelay.max / 1e6 });
  previousLoop = current;
  loopDelay.reset();
}, 5000);
heartbeat.unref();
progress('start');
const { CodeGraph } = require(path.join(engine, 'dist/index.js'));
const { DatabaseConnection } = require(path.join(engine, 'dist/db/index.js'));
const loader = require(path.join(engine, 'dist/extraction/kernel/loader.js'));
const result = { engine, root, backend, node: process.version, stages: [] };
let cg;
const orig = CodeGraph.prototype.resolveReferencesBatched;
CodeGraph.prototype.resolveReferencesBatched = async function (...args) {
  const stage = { name: 'resolution-and-synthesis', startEpochMs: Date.now(), memoryBefore: process.memoryUsage(), refsBefore: this.db.getDb().prepare('SELECT count(*) AS n FROM unresolved_refs').get().n };
  const start = performance.now(), cpu = process.cpuUsage();
  progress('stage-start', { name: stage.name });
  try { const value = await orig.apply(this, args); stage.stats = value.stats; return value; }
  finally {
    Object.assign(stage, { endEpochMs: Date.now(), wallMs: performance.now() - start, cpu: process.cpuUsage(cpu), memoryAfter: process.memoryUsage() });
    result.stages.push(stage);
    progress('stage-complete', { stage });
    phase = 'finalizing';
  }
};
const origMaintenance = DatabaseConnection.prototype.runMaintenance;
DatabaseConnection.prototype.runMaintenance = async function (...args) {
  phase = 'maintenance';
  const start = performance.now(), cpu = process.cpuUsage();
  progress('stage-start', { name: 'database-maintenance' });
  try { return await origMaintenance.apply(this, args); }
  finally {
    const stage = { name: 'database-maintenance', wallMs: performance.now() - start,
      cpu: process.cpuUsage(cpu) };
    result.stages.push(stage);
    progress('stage-complete', { stage });
    phase = 'finalizing';
  }
};
(async () => {
  try {
    // getKernel() deliberately ignores CODEGRAPH_KERNEL=0; kernelSupports()
    // is the actual per-call routing predicate used by extraction.
    result.nativeLoaded = loader.kernelSupports('typescript');
    if (result.nativeLoaded !== (backend === 'native')) throw new Error('Wrong extraction backend');
    cg = CodeGraph.initSync(root);
    result.openMs = performance.now() - begin;
    const start = performance.now(), cpu = process.cpuUsage();
    result.indexStartEpochMs = Date.now();
    let lastProgress = 0;
    phase = 'indexing';
    progress('index-start');
    result.index = await cg.indexAll({ onProgress: p => {
      const now = performance.now();
      // Preserve every resolution/synthesis batch, but avoid one disk write per
      // scanned/parsed file. Heartbeats continue while asynchronous work waits.
      if (phase !== p.phase || p.phase === 'resolving' || p.phase === 'linking' ||
          now - lastProgress >= 1000 || (p.total > 0 && p.current === p.total)) {
        phase = p.phase;
        progress('progress', { progress: p });
        lastProgress = now;
      }
    } });
    result.indexEndEpochMs = Date.now();
    result.indexMs = performance.now() - start;
    result.indexCpu = process.cpuUsage(cpu);
    progress('index-complete', { indexMs: result.indexMs, indexCpu: result.indexCpu, index: result.index });
    // Save the completed index measurement BEFORE potentially expensive full DB
    // checks. A stopped validation must not look like an indexing timeout.
    fs.writeFileSync(path.join(out, 'index-result.json'), JSON.stringify(result, null, 2));
    phase = 'verification';
    progress('verification-start');
    if (!result.index.success || result.index.filesErrored) throw new Error('Index did not finish cleanly');
    const db = new DatabaseSync(path.join(root, '.codegraph/codegraph.db'), { readOnly: true });
    result.counts = Object.fromEntries(['files','nodes','edges','unresolved_refs'].map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    result.languages = db.prepare('SELECT language,count(*) AS n FROM files GROUP BY language').all();
    result.integrity = db.prepare('PRAGMA integrity_check').all();
    result.foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    result.orphans = db.prepare('SELECT count(*) AS n FROM edges e LEFT JOIN nodes s ON s.id=e.source LEFT JOIN nodes t ON t.id=e.target WHERE s.id IS NULL OR t.id IS NULL').get().n;
    db.close();
    if (result.integrity.length !== 1 || result.integrity[0].integrity_check !== 'ok' ||
        result.foreignKeys.length || result.orphans) throw new Error('Database verification failed');
    progress('verification-complete');
  } catch (e) { result.error = e.stack; process.exitCode = 1; }
  finally {
    phase = 'closing';
    progress('closing');
    try { cg?.close(); }
    catch (e) { result.closeError = e.stack; process.exitCode = 1; }
    result.totalInsideProcessMs = performance.now() - begin;
    result.maxRSSKiB = process.resourceUsage().maxRSS;
    result.finalMemory = process.memoryUsage();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    progress('complete', { error: result.error, closeError: result.closeError });
    clearInterval(heartbeat);
    loopDelay.disable();
    fs.closeSync(traceFd);
    console.log(JSON.stringify({ indexMs: result.indexMs, stages: result.stages.map(x => ({ wallMs: x.wallMs, stats: x.stats })), error: result.error }));
  }
})();
