/**
 * Why are call edges still unverified? Breaks down a merged graph's heuristic
 * call/instantiation edges (provenance NULL) by what SCIP had at the call site.
 *
 *   npx tsx scripts/scip-eval/unverified.ts <repo> [--json] [--examples 3]
 *
 * Reads <repo>/.codegraph/codegraph.db and every installed index, and replays
 * the merge's own site extraction (scipSites) to see what it made of each call.
 * Causes, in the order they are tested:
 *   no document          the caller's file is not in any index (no project owns it, other language)
 *   stale document       its document fails the hash gate (edited since, or over the size limit)
 *   target outside graph SCIP resolved the call to a project definition in a file codegraph has no
 *                        nodes for (over its size limit, or excluded)
 *   target without node  …to a definition in an indexed file that maps to no node of the right kind
 *   later line           SCIP has the reference a few lines further down: a call in a multi-line
 *                        chain, keyed by codegraph at the chain's first line
 *   no reference         SCIP has no reference by that name nearby: untyped receiver,
 *                        unresolved import, dynamic code
 *   not a call to SCIP   SCIP has one, but not one the merge judges as this call: another kind of
 *                        symbol (a Rust enum variant, a property), or not call-shaped
 */

import { createDatabase } from '../../src/db/sqlite-adapter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../../src/file-limits';
import { ROLE_DEFINITION, ScipDocument, loadScipIndex, parseSymbol } from '../../src/scip/reader';
import { siteKey, siteKindOfEdge } from '../../src/scip/site';
import { scipDefinitions, scipSites } from '../../src/scip/sites';
import { ScipLanguage, availableIndexes, indexPath, readHashed } from '../../src/scip/store';

const repo = path.resolve(process.argv[2] ?? '.');
const json = process.argv.includes('--json');
const exAt = process.argv.indexOf('--examples');
const examplesPer = exAt >= 0 ? Number(process.argv[exAt + 1]) : 3;

const db = createDatabase(path.join(repo, '.codegraph', 'codegraph.db'), { readOnly: true }).db;
const installed = availableIndexes(repo);
if (installed.length === 0) throw new Error(`${repo} has no installed SCIP index`);

const docs = new Map<string, { doc: ScipDocument; hash: string | undefined }>();
const definedIn = new Map<string, string>(); // symbol → file of its first definition
const indexes: Array<{ lang: ScipLanguage; docs: ScipDocument[] }> = [];
for (const { lang, meta } of installed) {
  const all = loadScipIndex(indexPath(repo, lang)).documents;
  indexes.push({ lang, docs: all });
  for (const doc of all) {
    docs.set(doc.relativePath, { doc, hash: meta.hashes[doc.relativePath] });
    for (const o of doc.occurrences) if (o.roles & ROLE_DEFINITION && !definedIn.has(o.symbol)) definedIn.set(o.symbol, doc.relativePath);
  }
}
const indexedHash = new Map((db.prepare('SELECT path, content_hash FROM files').all() as { path: string; content_hash: string }[])
  .map(r => [r.path, r.content_hash]));

/** Per file: is its document usable (the merge's hash gate), cached. */
const gate = new Map<string, boolean>();
const fresh = (file: string) => {
  let ok = gate.get(file);
  if (ok === undefined) {
    const d = docs.get(file);
    const disk = d && d.hash === indexedHash.get(file) ? readHashed(repo, file) : null;
    gate.set(file, (ok = !!disk && disk.hash === d!.hash && disk.text !== null));
  }
  return ok;
};
/** Per file: references by 1-based line → names (last descriptor) and symbols, cached. */
const refsByLine = new Map<string, Map<number, { name: string; symbol: string }[]>>();
const refsAt = (file: string, line: number) => {
  let m = refsByLine.get(file);
  if (!m) {
    refsByLine.set(file, (m = new Map()));
    for (const o of docs.get(file)!.doc.occurrences) {
      if (o.roles & ROLE_DEFINITION) continue;
      const p = parseSymbol(o.symbol);
      if (!p) continue;
      const l = o.range.startLine + 1;
      let list = m.get(l);
      if (!list) m.set(l, (list = []));
      list.push({ name: p.last.name, symbol: o.symbol });
    }
  }
  return m.get(line) ?? [];
};
const CONSTRUCTORS = new Set(['<constructor>', 'constructor', '__init__', 'new']);

// The merge's view: fresh documents' lines, then its sites.
const lines = new Map<string, string[]>();
for (const file of docs.keys()) if (fresh(file)) lines.set(file, fs.readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/));
const scip = scipSites(scipDefinitions(db, indexes, new Set(lines.keys())), indexes, lines, new Map()); // calls only
/** The symbol SCIP has on `line` by `name`: what an unknown site resolved to. */
const symbolAt = (file: string, line: number, name: string, kind: string) =>
  refsAt(file, line).find(r => r.name === name || (kind === 'instantiates' && CONSTRUCTORS.has(r.name)))?.symbol;

const edges = db.prepare(`SELECT e.kind, e.line, e.source, s.file_path AS src, s.qualified_name AS caller, t.name AS name, t.file_path AS tgt
  FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
  WHERE e.kind IN ('calls', 'instantiates') AND e.provenance IS NULL AND e.line IS NOT NULL`).iterate() as Iterable<{
    kind: string; line: number; source: string; src: string; caller: string; name: string; tgt: string;
  }>;

const counts = new Map<string, number>();
/** cause → where: the target's definition file (target causes), or the caller's folder (no document) → edges */
const targetFiles = new Map<string, Map<string, number>>();
const examples = new Map<string, string[]>();
let total = 0;
for (const e of edges) {
  total++;
  let cause: string;
  if (!docs.has(e.src)) {
    cause = 'no document';
    const dir = `${e.src.split('/').slice(0, 2).join('/')} (${path.extname(e.src)})`;
    const byDir = targetFiles.get(cause) ?? new Map<string, number>();
    targetFiles.set(cause, byDir);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  else if (!fresh(e.src)) cause = 'stale document';
  else {
    const key = siteKey(e.source, e.line, e.name, siteKindOfEdge(e.kind));
    if (scip.sites.has(key)) cause = 'judged (?)'; // the merge would have verified or removed it
    else if (scip.unknown.has(key)) {
      const symbol = symbolAt(e.src, e.line, e.name, e.kind);
      const at = symbol && definedIn.get(symbol);
      const size = (() => { try { return at ? fs.statSync(path.join(repo, at)).size : -1; } catch { return -1; } })();
      cause = at && (!indexedHash.has(at) || size > MAX_SOURCE_FILE_SIZE_BYTES) ? 'target outside graph' : 'target without node';
      const byFile = targetFiles.get(cause) ?? new Map<string, number>();
      targetFiles.set(cause, byFile);
      const where = at ? `${at} (${symbol!.slice(symbol!.lastIndexOf('/') + 1)})` : '?';
      byFile.set(where, (byFile.get(where) ?? 0) + 1);
    } else if (symbolAt(e.src, e.line, e.name, e.kind)) cause = 'not a call to SCIP';
    else cause = [1, 2, 3, 4, 5].some(d => symbolAt(e.src, e.line + d, e.name, e.kind)) ? 'later line' : 'no reference';
  }
  counts.set(cause, (counts.get(cause) ?? 0) + 1);
  const ex = examples.get(cause) ?? [];
  if (ex.length < examplesPer) examples.set(cause, [...ex, `${e.src}:${e.line} ${e.caller} → ${e.name} (${e.tgt})`]);
}

const verified = (db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind IN ('calls', 'instantiates') AND provenance = 'scip'`).get() as { n: number }).n;
const rows = [...counts].sort((a, b) => b[1] - a[1]);
if (json) {
  const top = Object.fromEntries([...targetFiles].map(([c, m]) => [c, Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 8))]));
  console.log(JSON.stringify({ repo, verified, unverified: total, causes: Object.fromEntries(rows), targets: top, examples: Object.fromEntries(examples) }, null, 2));
} else {
  console.log(`${repo}: ${verified} verified, ${total} unverified call edges (${(100 * total / (total + verified)).toFixed(1)}%)`);
  for (const [cause, n] of rows) {
    console.log(`  ${cause.padEnd(22)} ${String(n).padStart(8)}  ${(100 * n / total).toFixed(1)}%`);
    for (const x of examples.get(cause) ?? []) console.log(`      ${x}`);
  }
}
