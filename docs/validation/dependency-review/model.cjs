'use strict';
// Validation-only read-set model. Not imported by the application or SDK.
const { createHash } = require('node:crypto');
const clone = value => structuredClone(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical); // order is observable
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
class UntrackedRead extends Error {}

function answer(snapshot, method, args) {
  const [arg, language] = args;
  switch (method) {
    case 'readFile': return snapshot.files[arg] ?? null;
    case 'fileExists': return Object.hasOwn(snapshot.files, arg);
    case 'getFileLines': return snapshot.files[arg]?.split(/\r?\n/) ?? null;
    case 'getAllFiles': return snapshot.indexedFiles;
    case 'listDirectories': return snapshot.directories[arg] ?? [];
    case 'getNodesInFile': return snapshot.nodes.filter(n => n.filePath === arg);
    case 'getNodesByName': return snapshot.nodes.filter(n => n.name === arg);
    case 'getNodesByQualifiedName': return snapshot.nodes.filter(n => n.qualifiedName === arg);
    case 'getNodesByLowerName': return snapshot.nodes.filter(n => n.name.toLowerCase() === arg);
    case 'getNodesByKind': return snapshot.nodes.filter(n => n.kind === arg);
    case 'getNodeById': return snapshot.nodes.find(n => n.id === arg) ?? null;
    case 'getSupertypes': {
      const ids = new Set(snapshot.nodes.filter(n => n.name === arg && n.language === language).map(n => n.id));
      return [...new Set(snapshot.edges.filter(e => ids.has(e.source) && ['extends', 'implements'].includes(e.kind))
        .map(e => snapshot.nodes.find(n => n.id === e.target)?.name).filter(Boolean))];
    }
    default: throw new UntrackedRead(method);
  }
}
function context(snapshot, reads, legacy = {}, taint = () => {}) {
  return new Proxy({}, { get(_object, method) {
    return (...args) => {
      let value;
      try { value = answer(snapshot, method, args); }
      catch (error) {
        if (!(error instanceof UntrackedRead)) throw error;
        taint(error);
        if (!legacy[method]) throw error;
        return legacy[method](...args);
      }
      reads?.push({ method, args: clone(args), value: clone(value) });
      return clone(value);
    };
  } });
}
// Matches the existing independent-synthesis pair winner, not a proposed new key.
function merge(outputs) {
  const seen = new Set();
  return outputs.flat().filter(edge => {
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
async function full(snapshot, units) {
  const outputs = [];
  for (const unit of units) outputs.push(await unit.run(context(snapshot, null, unit.legacyContext), clone(snapshot.options)));
  return { output: merge(outputs), owned: outputs };
}
class ReadSetModel {
  constructor({ positiveOnly = false } = {}) {
    this.positiveOnly = positiveOnly; this.entries = new Map(); this.output = []; this.last = null;
  }
  async update(snapshot, units, beforeCommit = () => {}) {
    if (new Set(units.map(u => u.id)).size !== units.length) throw new Error('duplicate unit identity');
    const generation = hash(snapshot), next = new Map(), outputs = [], stats = { ran: [], reused: [], reads: {}, fallback: null };
    // Certification here is test-supplied metadata, NOT enforced isolation.
    const identity = hash({ environment: snapshot.identity, options: snapshot.options,
      schedule: units.map(u => [u.id, u.digest, u.mode]) });
    if (units.some(u => u.mode !== 'captured')) stats.fallback = 'legacy/untracked unit: whole schedule';
    try {
      for (const unit of units) {
        const old = this.entries.get(unit.id);
        if (!stats.fallback && old?.identity === identity && old.reads.every(r => hash(answer(snapshot, r.method, r.args)) === hash(r.value))) {
          next.set(unit.id, old); outputs.push(clone(old.output)); stats.reused.push(unit.id); continue;
        }
        const reads = [];
        let unsupported;
        const output = await unit.run(context(snapshot, reads, stats.fallback ? unit.legacyContext : {}, error => unsupported = error), clone(snapshot.options));
        if (unsupported && !stats.fallback) throw unsupported; // sticky even if extension caught it
        stats.ran.push(unit.id); stats.reads[unit.id] = clone(reads);
        // Deliberately broken comparison arm: omits empty results and tracks
        // only members returned last time, not membership of their predicate.
        let retained = reads;
        if (this.positiveOnly) retained = reads.flatMap(r => {
          if (r.value == null || r.value === false || (Array.isArray(r.value) && !r.value.length)) return [];
          if (r.method.startsWith('getNodes')) return r.value.map(n => ({ method: 'getNodeById', args: [n.id], value: n }));
          if (r.method === 'getAllFiles') return []; // filenames previously read are all it remembers
          return [r];
        });
        if (!stats.fallback) next.set(unit.id, { identity, reads: retained, output: clone(output) });
        outputs.push(output);
      }
    } catch (error) {
      if (!(error instanceof UntrackedRead)) throw error;
      // Discard every tentative reused/derived result before conservative retry.
      const result = await full(snapshot, units);
      outputs.splice(0, outputs.length, ...result.owned); next.clear();
      stats.fallback = `unsupported context operation: ${error.message}`;
      stats.ran = units.map(u => u.id); stats.reused = [];
    }
    beforeCommit();
    if (hash(snapshot) !== generation) throw new Error('snapshot changed before model commit');
    this.entries = next; this.output = merge(outputs); this.last = stats;
    return { output: clone(this.output), ...stats };
  }
}
module.exports = { ReadSetModel, context, full, hash, merge };
