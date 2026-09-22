'use strict';
// Internal opt-in experiment. Never imported by production. No callback skips.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { channel } = require('node:diagnostics_channel');
const { DatabaseSync } = require('node:sqlite');
const { currentPlugins } = require('../../../dist/plugins/registry');
const { getSynthPasses } = require('../../../dist/resolution/callback-synthesizer');
const { getCodeGraphDir } = require('../../../dist/directory');
const { evaluate } = require('./adapter.cjs');
const { hash } = require('../dependency-review/model.cjs');
const sessions = new Map(), events = channel('codegraph.semantic.update');
const copy = value => structuredClone(value);
const clock = () => performance.now();
const raw = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const byteHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const loadedCode = { adapter: byteHash(path.join(__dirname, 'adapter.cjs')), observer: byteHash(__filename),
  engineSource: byteHash(path.join(__dirname, '../../../dist/index.js')) };
const normalize = edges => edges.map(e => ({ source: e.source, target: e.target, kind: e.kind,
  line: e.line ?? null, metadata: e.metadata, provenance: e.provenance }));
const guardedOutput = edges => edges.map(e => ({ ...e, provenance: 'heuristic', metadata: { ...e.metadata, synthesizedBy: 'shadow-binding' } }));
const methods = new Set(['readFile', 'fileExists', 'getAllFiles', 'getNodesByName']);
function projected(value, method) {
  // New internal view explicitly excludes wall-clock updatedAt. Every other
  // observable Node field and query order is kept. No claim of transparent v1 capture.
  return method === 'getNodesByName' ? JSON.parse(JSON.stringify(value.map(({ updatedAt, ...node }) => node))) : value;
}
function view(ctx, observer) {
  return new Proxy({}, { get(_, method) {
    return (...args) => {
      // Unknown/caught operations taint before calling or throwing; authoritative
      // semantics are forwarded unchanged. A proxy is not an I/O sandbox.
      if (!methods.has(method)) observer?.taint('unsupported:' + String(method));
      const value = projected(ctx[method](...args), method);
      observer?.read(method, args, value);
      return copy(value);
    };
  } });
}
function dbState(root) {
  const file = path.join(getCodeGraphDir(root), 'codegraph.db');
  if (!fs.existsSync(file)) return { marker: null, edges: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const marker = db.prepare("SELECT value FROM project_metadata WHERE key='semantic_update'").get()?.value || null;
    const edges = db.prepare('SELECT source,target,kind,line,metadata,provenance FROM edges').all()
      .map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : undefined }));
    return { marker, edges };
  } finally { db.close(); }
}
function sourceIdentity(root, registry, options) {
  if (loadedCode.adapter !== byteHash(path.join(__dirname, 'adapter.cjs')) || loadedCode.observer !== byteHash(__filename) ||
      loadedCode.engineSource !== byteHash(path.join(__dirname, '../../../dist/index.js'))) throw Error('loaded host code changed; restart required');
  return { project: fs.realpathSync(root), ...loadedCode, engine: require('../../../package.json').version,
    queryContract: 'shadow-view-1-without-updatedAt',
    stage: 'independent-post-resolution', options: copy(options),
    config: raw(path.join(root, 'codegraph.json')), ignore: raw(path.join(root, '.gitignore')),
    // Whole codegraph config includes scan policy, replacements and enabled order.
    environment: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CODEGRAPH_')).sort()),
    registry: registry.resolved.map(p => [p.manifest.id, p.version, p.digest, p.options, p.replaces]),
    mergeOrder: getSynthPasses().map(p => p.name) };
}
function currentFileMatches(root, read) {
  if (read.method === 'readFile') return hash(raw(path.join(root, read.args[0]))) === read.hash;
  if (read.method === 'fileExists') return hash(fs.existsSync(path.join(root, read.args[0]))) === read.hash;
  return true;
}
class Session {
  constructor(root, options) {
    this.root = fs.realpathSync(root); this.options = options; this.committed = null; this.active = null;
    this.records = []; this.closed = false; this.disabled = false;
    this.listener = e => { if (e.projectRoot === this.root && this.active) {
      this.active.phases.push(e.phase); if (e.phase === 'committed') this.active.graphCommitted = true;
    } };
    events.subscribe(this.listener);
  }
  async operation(name, fn, { fault } = {}) {
    if (this.closed || this.active) throw Error('shadow session closed or operation active');
    const start = clock(); let previousMarker;
    try { previousMarker = dbState(this.root).marker; } catch { this.disabled = true; this.committed = null; }
    const op = this.active = { name, phases: [], pending: null, graphCommitted: false, fault, invocations: 0 };
    let error, result;
    try { result = await fn(); } catch (e) { error = e; }
    const finalizeStart = clock();
    // Never throw an observer failure into the successful engine operation.
    const record = { name, success: !error, certified: false, phases: op.phases, ...op.pending?.metrics,
      authoritativeInvocations: op.invocations, graphMarker: null, identity: op.pending?.identity || null, trace: op.pending?.trace || [],
      owned: op.pending?.owned || [], reason: error ? 'operation-failed' : op.reason || 'not-observed' };
    try {
      const state = dbState(this.root); record.graphMarker = state.marker;
      if (!error && op.pending && !this.disabled && !op.reason && op.graphCommitted && state.marker !== previousMarker) {
        const p = op.pending;
        if (raw(path.join(this.root, 'codegraph.json')) !== p.identity.config || raw(path.join(this.root, '.gitignore')) !== p.identity.ignore ||
            !p.trace.every(r => currentFileMatches(this.root, r))) throw Error('observed source/config changed before certification');
        // Owned premerge output can be shadowed by another earlier pass. Compare
        // the complete registered fixture-owner merge, never delete shadowed ownership.
        const expected = this.options.expectedMerge ? this.options.expectedMerge(p.owned) : guardedOutput(p.owned);
        const actual = state.edges.filter(e => this.options.owners.includes(e.metadata?.synthesizedBy));
        const sort = es => normalize(es).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (hash(sort(actual)) !== hash(sort(expected))) throw Error('committed SQLite/owned merge mismatch');
        this.committed = { identity: p.identity, trace: p.trace, owned: copy(p.owned), marker: state.marker, bytes: p.metrics.traceBytes };
        record.certified = true; record.reason = 'committed'; record.sqlite = sort(actual); record.sqliteHash = hash(record.sqlite);
      } else if (error || op.reason || !op.graphCommitted) this.committed = null;
    } catch (e) { record.reason = 'observer:' + e.message; this.committed = null; this.disabled = true; }
    record.finalizeMs = clock() - finalizeStart;
    record.observerMs = (record.identityMs || 0) + (record.replayMs || 0) + (record.shadowMs || 0) + (record.compareMs || 0) + record.finalizeMs;
    record.totalOperationMs = clock() - start;
    this.records.push(record); if (this.records.length > 256) this.records.shift();
    this.active = null;
    if (error) throw error;
    return result;
  }
  close() { this.committed = null; this.active = null; this.closed = true; sessions.delete(this.root); events.unsubscribe(this.listener); }
}
function enable(root, options) {
  const real = fs.realpathSync(root);
  if (sessions.has(real) || !options.expectedPackageDigest || !options.owners?.includes('shadow-binding')) throw Error('explicit unique project/package admission required');
  const session = new Session(real, { maxReads: 128, maxBytes: 65536, ...options }); sessions.set(real, session); return session;
}
function invoke(root, ctx, options) {
  // The full authoritative callback is unconditional. Observer code runs only
  // afterward and never changes this value, including mismatches/over-budget.
  const session = sessions.get(root), op = session?.active;
  if (op) op.invocations++;
  const authStart = clock(); const authoritative = evaluate(view(ctx), copy(options)); const authoritativeMs = clock() - authStart;
  if (!session || !op || session.disabled) return authoritative;
  try {
    const identityStart = clock(), registry = currentPlugins();
    const own = registry?.resolved.find(p => p.manifest.id === 'shadow-binding');
    if (!own || own.digest !== session.options.expectedPackageDigest) { op.reason = 'not-admitted-package'; return authoritative; }
    const identity = sourceIdentity(root, registry, options), identityMs = clock() - identityStart;
    const legacy = registry.resolved.some(p => !session.options.auditedUpstreamDigests?.includes(p.digest) && p !== own);
    let reason = legacy ? 'legacy-untracked-global-fallback' : null;
    const old = session.committed, replayStart = clock();
    let wouldReuse = !reason && !!old && old.marker === dbState(root).marker && hash(old.identity) === hash(identity);
    if (wouldReuse) for (const r of old.trace) {
      if (hash(projected(ctx[r.method](...r.args), r.method)) !== r.hash) { wouldReuse = false; break; }
    }
    const replayMs = clock() - replayStart;
    const trace = []; let traceBytes = 0, captureMs = 0;
    const observer = { taint: why => { reason ||= why; }, read(method, args, value) {
      const t = clock();
      if (op.fault === 'capture-error') throw Error('injected observer failure');
      if (methods.has(method) && !reason) {
        const entry = { method, args: copy(args), value: copy(value), hash: hash(value), valueBytes: Buffer.byteLength(JSON.stringify(value)),
          empty: value === null || value === false || (Array.isArray(value) && value.length === 0) };
        traceBytes += Buffer.byteLength(JSON.stringify(entry));
        if (trace.length >= session.options.maxReads || traceBytes > session.options.maxBytes) reason = 'observation-budget';
        else trace.push(entry);
      }
      captureMs += clock() - t;
    } };
    const shadowStart = clock(); const shadow = evaluate(view(ctx, observer), copy(options)); const shadowMs = clock() - shadowStart;
    const compareStart = clock();
    if (op.fault === 'mismatch') shadow.push({ source: 'invalid', target: 'invalid', kind: 'calls' });
    if (hash(shadow) !== hash(authoritative) || (wouldReuse && hash(old.owned) !== hash(authoritative))) {
      reason = 'prediction-or-shadow-mismatch'; session.disabled = true;
    }
    const compareMs = clock() - compareStart;
    if (reason) { op.reason = reason; session.committed = null; }
    op.pending = { identity, trace: reason ? [] : trace, owned: copy(authoritative), metrics: {
      wouldReuse: wouldReuse && !reason, predictedCallbackMsAvoided: wouldReuse && !reason ? authoritativeMs : 0,
      authoritativeMs, identityMs, captureMs, replayMs, compareMs, shadowMs,
      traceBytes: reason ? 0 : Buffer.byteLength(JSON.stringify({ identity, trace, owned: authoritative })),
      readCount: trace.length, negativeReads: trace.filter(r => r.empty).length,
      actualCallbacksSkipped: 0, shadowExecutions: 1 } };
    if (op.pending.metrics.traceBytes > session.options.maxBytes) { op.reason = 'total-observation-budget'; op.pending.trace = []; session.committed = null; }
  } catch (error) { session.committed = null; session.disabled = true; op.reason = 'observer:' + error.message; }
  return authoritative;
}
module.exports = { enable, invoke, dbState, normalize, guardedOutput, hash };
