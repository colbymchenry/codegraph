#!/usr/bin/env node
// Disposable-corpus benchmark. Never point CORPUS_COPY at a working checkout.
// node haskell-corpus.cjs ENGINE_ROOT CORPUS_COPY OUTPUT_JSON OPTIONS_JSON
// Options: { queries: string[], editFile?: string, explicitExports?: boolean,
//   editReplacementFile?: string, skipSyncEdits?: boolean, config?: object,
//   integrityCheck?: 'quick_check' | 'integrity_check' }
// Optional HASKELL_PROFILE=1 measures canonical-origin exports without changing
// ResolutionContext identity or the engine's cache ownership.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const [engineArg, rootArg, outputArg, optionsArg] = process.argv.slice(2);
if (!engineArg || !rootArg || !outputArg || !optionsArg) {
  throw new Error('Usage: node haskell-corpus.cjs ENGINE_ROOT CORPUS_COPY OUTPUT_JSON OPTIONS_JSON');
}
const engine = path.resolve(engineArg), root = fs.realpathSync(rootArg);
const output = path.resolve(outputArg), options = JSON.parse(fs.readFileSync(optionsArg, 'utf8'));
if (fs.existsSync(path.join(root, '.codegraph'))) throw new Error('Refusing an existing corpus index; use a fresh disposable copy.');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing benchmark report.');
if (!Array.isArray(options.queries) || options.queries.some(q => typeof q !== 'string')) throw new Error('options.queries must be a string array.');
if (options.integrityCheck && !['quick_check', 'integrity_check'].includes(options.integrityCheck)) throw new Error('Unsupported integrity check.');
fs.mkdirSync(path.dirname(output), { recursive: true });
const progressPath = output.replace(/\.json$/, '') + '.progress.ndjson';
const progressFd = fs.openSync(progressPath, 'wx');
const started = performance.now();
const initialCpu = process.cpuUsage();
const report = {
  engine, root, node: process.version, startedAt: new Date().toISOString(),
  options, phase: 'opening', stages: [], syncs: [], edits: [], flows: [], warnings: [],
};
let graph, editPath, originalSource, originalConfig, configTouched = false;
let activePhase = 'opening';
const profile = new Map();

function progress(event, details = {}) {
  fs.writeSync(progressFd, JSON.stringify({ event, phase: activePhase, wallMs: performance.now() - started,
    epochMs: Date.now(), rss: process.memoryUsage().rss, ...details }) + '\n');
}
function checkpoint() {
  report.phase = activePhase;
  report.elapsedMs = performance.now() - started;
  report.cpu = process.cpuUsage(initialCpu);
  report.maxRSSKiB = process.resourceUsage().maxRSS;
  report.memory = process.memoryUsage();
  if (profile.size) report.canonicalOriginProfile = Object.fromEntries([...profile].map(([name, p]) => [name, {
    calls: p.calls, uniqueFileNames: p.keys.size, totalMs: p.totalMs, maxMs: p.maxMs,
  }]));
  const temp = output + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(report, null, 2));
  fs.renameSync(temp, output);
}
function restoreFiles() {
  if (editPath && originalSource !== undefined) fs.writeFileSync(editPath, originalSource);
  if (configTouched) {
    const configPath = path.join(root, 'codegraph.json');
    if (originalConfig === null) fs.unlinkSync(configPath);
    else fs.writeFileSync(configPath, originalConfig);
    configTouched = false;
  }
}
function wrapProof(module, name) {
  const original = module[name];
  if (typeof original !== 'function') return;
  const stats = { calls: 0, keys: new Set(), totalMs: 0, maxMs: 0 };
  profile.set(name, stats);
  module[name] = function (...args) {
    const start = performance.now();
    stats.calls++;
    stats.keys.add(`${args[0]}\0${args[1]}`);
    try { return original.apply(this, args); }
    finally { const ms = performance.now() - start; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms); }
  };
}
if (process.env.HASKELL_PROFILE === '1') {
  const combinatorsPath = path.join(engine, 'dist/resolution/haskell-combinators.js');
  if (fs.existsSync(combinatorsPath)) wrapProof(require(combinatorsPath), 'haskellCombinatorHasCanonicalOrigin');
  wrapProof(require(path.join(engine, 'dist/resolution/import-resolver.js')), 'haskellEffectHeadHasCanonicalOrigin');
}
const { CodeGraph } = require(path.join(engine, 'dist/index.js'));
const { ToolHandler } = require(path.join(engine, 'dist/mcp/tools.js'));
const { resolveNamedSymbolFlow } = require(path.join(engine, 'dist/graph/named-symbol-flow.js'));
const originalResolution = CodeGraph.prototype.resolveReferencesBatched;
CodeGraph.prototype.resolveReferencesBatched = async function (...args) {
  const start = performance.now(), cpu = process.cpuUsage();
  const stage = { name: 'resolution-and-synthesis', phase: activePhase, startedAt: new Date().toISOString() };
  progress('stage-start', stage);
  try {
    const result = await originalResolution.apply(this, args);
    stage.stats = result?.stats;
    return result;
  } finally {
    Object.assign(stage, { wallMs: performance.now() - start, cpu: process.cpuUsage(cpu) });
    report.stages.push(stage);
    progress('stage-complete', stage);
  }
};
const heartbeat = setInterval(() => progress('heartbeat'), 10000);
heartbeat.unref();
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    report.interrupted = signal;
    try { restoreFiles(); } catch (error) { report.restoreError = error.stack; }
    try { checkpoint(); progress('interrupted', { signal }); } finally { process.exit(code); }
  });
}

function rows(sql) { return graph.db.getDb().prepare(sql).all(); }
// Streaming the brackets and commas preserves the historical probe's exact
// sha256(JSON.stringify(rows)) result while avoiding materializing the graph.
function hashRows(sql) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  hash.update('[');
  for (const row of graph.db.getDb().prepare(sql).iterate()) {
    if (count++) hash.update(',');
    hash.update(JSON.stringify(row));
  }
  hash.update(']');
  return { count, hash: hash.digest('hex') };
}
function fingerprint() {
  const nodes = hashRows('SELECT id, kind, name, qualified_name, file_path, start_line, end_line FROM nodes ORDER BY id');
  // Retain the historical projection for comparisons with prior reports, and
  // also cover every semantic node column, including signatures and lexical
  // ranges. updated_at is deliberately excluded because indexing refreshes it.
  const nodeColumns = rows('PRAGMA table_info(nodes)')
    .map(column => column.name)
    .filter(name => name !== 'updated_at')
    .map(name => '"' + name.replaceAll('"', '""') + '"');
  const fullNodes = hashRows(`SELECT ${nodeColumns.join(', ')} FROM nodes ORDER BY id`);
  const edges = hashRows('SELECT source, target, kind, line, col, metadata, provenance FROM edges ORDER BY source, target, kind, line, col, metadata, provenance');
  return { nodes: nodes.count, edges: edges.count, nodesHash: nodes.hash,
    fullNodeHash: fullNodes.hash, edgesHash: edges.hash };

}
function sameFingerprint(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// Capture only the actual compact Flow list. The following dynamic-boundary
// and source sections can contain implementation snippets, so never include
// them. Guard annotations also quote conditions from the source; omit those.
function surfacedFlowFromExplore(text) {
  const heading = '**Flow (call path among the symbols you queried)**';
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return { present: false, text: '', steps: 0, truncated: false };
  const compact = [heading];
  let steps = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\d+\. .+ \(.+:\d+\)$/.test(line)) {
      compact.push(line);
      steps++;
    } else if (/^\s*↓ /.test(line)) {
      compact.push(line.replace(/ \(when .*/, ''));
    } else {
      break;
    }
  }
  const compactText = compact.join('\n');
  const limit = 6000;
  return { present: true, text: compactText.slice(0, limit), steps,
    truncated: compactText.length > limit };
}
async function recordFlows() {
  activePhase = 'flows';
  for (const query of options.queries) {
    const handler = new ToolHandler(graph);
    const start = performance.now();
    const response = await handler.execute('codegraph_explore', { query });
    const exploreMs = performance.now() - start;
    const text = response.content?.map(item => item.text ?? '').join('\n') ?? '';
    const flowStart = performance.now();
    const flow = resolveNamedSymbolFlow(graph, query);
    const namedFlowMs = performance.now() - flowStart;
    const chains = flow.chains.map(chain => chain.steps.map(step => ({ name: step.node.name, file: step.node.filePath })));
    report.flows.push({ query, exploreMs, chars: text.length,
      isError: response.isError ?? false,
      surfacedFlow: surfacedFlowFromExplore(text),
      namedFlow: { ms: namedFlowMs, chains, hasChain: chains.length > 0 },
      // Compatibility fields for existing report comparators. These chains
      // describe the separate graph query, not the returned explore text.
      namedFlowMs, chains, chainsSource: 'named-symbol-graph-query',
      // Empty/partial paths can be expected. Successful tool execution and
      // graph integrity do not establish complete retrieval coverage.
      coverage: 'not-assessed',
    });
    checkpoint();
  }
}
async function timedSync(label, syncOptions = {}) {
  activePhase = label;
  progress('sync-start');
  const start = performance.now(), cpu = process.cpuUsage();
  const result = await graph.sync(syncOptions);
  const measured = { label, ms: performance.now() - start, cpu: process.cpuUsage(cpu), result };
  progress('sync-complete', { label, ms: measured.ms });
  if (result.success === false || result.filesErrored > 0) throw new Error(`${label} did not finish cleanly`);
  return measured;
}

// Find a real module header and its balanced export parentheses. Comments are
// skipped without changing offsets. Refuse uncertain layouts instead of making
// an edit whose syntax changes could invalidate a performance comparison.
function topologySource(source) {
  const name = 'codegraphCorpusBenchmarkIdentity';
  if (source.includes(name)) throw new Error('Benchmark declaration already exists.');
  const module = /^module[ \t]+[A-Z][\w']*(?:\.[A-Z][\w']*)*[ \t\r\n]*/m.exec(source);
  if (!module) throw new Error('No supported module header; supply editReplacementFile.');
  let i = module.index + module[0].length;
  const explicit = source[i] === '(';
  if (options.explicitExports !== undefined && explicit !== options.explicitExports) throw new Error('Module export list does not match explicitExports.');
  if (explicit) {
    const open = i;
    let depth = 0, blockComment = 0, close = -1;
    for (; i < source.length; i++) {
      const pair = source.slice(i, i + 2);
      if (pair === '{-') { blockComment++; i++; continue; }
      if (blockComment && pair === '-}') { blockComment--; i++; continue; }
      if (blockComment) continue;
      if (pair === '--') { const newline = source.indexOf('\n', i); if (newline < 0) break; i = newline; continue; }
      if (source[i] === '(') depth++;
      if (source[i] === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0 || !/^\s*where\b/.test(source.slice(close + 1))) throw new Error('Uncertain module export header; supply editReplacementFile.');
    const exports = source.slice(open + 1, close);
    if (!exports.trim()) source = source.slice(0, open + 1) + name + source.slice(close);
    else source = source.slice(0, open + 1) + name + ', ' + source.slice(open + 1);
  } else if (!/^where\b/.test(source.slice(i))) {
    throw new Error('Uncertain implicit module header; supply editReplacementFile.');
  }
  return source + `\n\n${name} :: a -> a\n${name} value = value\n`;
}
async function editAndRestore(kind, changedSource) {
  const record = { kind, file: options.editFile };
  report.edits.push(record);
  try {
    fs.writeFileSync(editPath, changedSource);
    record.changed = await timedSync(`${kind}-edit`, { paths: [options.editFile] });
    record.changed.fingerprint = fingerprint();
    record.changed.sameAsInitial = sameFingerprint(report.before, record.changed.fingerprint);
    if (kind === 'topology') {
      record.benchmarkNodes = rows("SELECT count(*) AS n FROM nodes WHERE name = 'codegraphCorpusBenchmarkIdentity'")[0].n;
      if (!options.editReplacementFile && !record.benchmarkNodes) throw new Error('Topology edit did not introduce its benchmark declaration.');
    }
  } finally {
    fs.writeFileSync(editPath, originalSource);
    record.restored = await timedSync(`${kind}-restore`, { paths: [options.editFile] });
    record.restored.fingerprint = fingerprint();
    record.restored.stable = sameFingerprint(report.before, record.restored.fingerprint);
    if (!record.restored.stable) report.warnings.push(`${kind} restoration changed the graph fingerprint.`);
    checkpoint();
  }
}

(async () => {
  try {
    if (options.config !== undefined) {
      const configPath = path.join(root, 'codegraph.json');
      let existingConfig;
      try { existingConfig = fs.lstatSync(configPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existingConfig && !existingConfig.isFile()) {
        throw new Error('Refusing to replace a symlink or non-file corpus configuration.');
      }
      originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
      fs.writeFileSync(configPath, JSON.stringify(options.config, null, 2) + '\n');
      configTouched = true;
    }
    if (options.editFile && !options.skipSyncEdits) {
      editPath = fs.realpathSync(path.resolve(root, options.editFile));
      const relative = path.relative(root, editPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('editFile must resolve inside the disposable corpus.');
      originalSource = fs.readFileSync(editPath, 'utf8');
    }
    progress('start');
    const initStart = performance.now(), initCpu = process.cpuUsage();
    graph = CodeGraph.initSync(root);
    report.initMs = performance.now() - initStart;
    report.initCpu = process.cpuUsage(initCpu);
    activePhase = 'indexing';
    const indexStart = performance.now(), indexCpu = process.cpuUsage();
    let lastProgress = 0, lastPhase;
    report.indexed = await graph.indexAll({ onProgress: p => {
      const now = performance.now();
      if (p.phase !== lastPhase || now - lastProgress >= 1000 || p.current === p.total) {
        progress('index-progress', { progress: p }); lastProgress = now; lastPhase = p.phase;
      }
    } });
    report.indexMs = performance.now() - indexStart;
    report.indexCpu = process.cpuUsage(indexCpu);
    report.indexMaxRSSKiB = process.resourceUsage().maxRSS;
    activePhase = 'initial-index-complete';
    checkpoint(); // Keep completed index metrics even if later verification is interrupted.
    activePhase = 'verification';
    report.before = fingerprint();
    report.stats = graph.getStats();
    report.fileErrors = rows("SELECT path, errors FROM files WHERE errors IS NOT NULL AND errors <> '[]'");
    report.languages = rows('SELECT language, COUNT(*) AS files FROM files GROUP BY language');
    report.refs = rows('SELECT status, COUNT(*) AS count FROM unresolved_refs GROUP BY status');
    report.heuristic = rows("SELECT json_extract(metadata, '$.synthesizedBy') AS mechanism, COUNT(*) AS count FROM edges WHERE provenance = 'heuristic' GROUP BY mechanism");
    const check = options.integrityCheck || 'quick_check';
    report.integrity = rows(`PRAGMA ${check}`);
    report.foreignKeys = rows('PRAGMA foreign_key_check');
    report.orphans = rows('SELECT count(*) AS n FROM edges e LEFT JOIN nodes s ON s.id=e.source LEFT JOIN nodes t ON t.id=e.target WHERE s.id IS NULL OR t.id IS NULL')[0].n;
    if (report.integrity.length !== 1 || Object.values(report.integrity[0])[0] !== 'ok' || report.foreignKeys.length || report.orphans) throw new Error('Database integrity verification failed.');
    if (report.refs.some(r => r.status === 'pending' && r.count > 0)) report.warnings.push('Pending references remain after initial indexing.');
    checkpoint();
    if (!report.indexed.success || report.indexed.filesErrored) {
      await recordFlows();
      throw new Error('Initial index did not finish cleanly; partial graph diagnostics were retained.');
    }
    for (let run = 1; run <= 3; run++) {
      const synced = await timedSync(`no-change-${run}`);
      synced.fingerprint = fingerprint();
      synced.stable = sameFingerprint(report.before, synced.fingerprint);
      if (!synced.stable) report.warnings.push(`No-change sync ${run} changed the graph fingerprint.`);
      report.syncs.push(synced);
      checkpoint();
    }
    if (editPath) {
      await editAndRestore('comment', originalSource + '\n-- CodeGraph disposable corpus benchmark comment.\n');
      const replacement = options.editReplacementFile
        ? fs.readFileSync(options.editReplacementFile, 'utf8') : topologySource(originalSource);
      await editAndRestore('topology', replacement);
    }
    await recordFlows();
    report.after = fingerprint();
    report.stable = sameFingerprint(report.before, report.after);
    report.ok = report.stable && report.warnings.length === 0 && report.flows.every(flow => !flow.isError);
    if (!report.ok) process.exitCode = 1;
    activePhase = 'complete';
  } catch (error) {
    report.error = error.stack;
    report.ok = false;
    process.exitCode = 1;
  } finally {
    try { restoreFiles(); } catch (error) { report.restoreError = error.stack; process.exitCode = 1; }
    try { graph?.close(); } catch (error) { report.closeError = error.stack; process.exitCode = 1; }
    checkpoint();
    progress('finished', { ok: report.ok, error: report.error });
    clearInterval(heartbeat);
    fs.closeSync(progressFd);
    console.log(JSON.stringify({ output, indexMs: report.indexMs, maxRSSKiB: report.maxRSSKiB, ok: report.ok, error: report.error }));
  }
})();
