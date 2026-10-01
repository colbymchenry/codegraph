/**
 * SCIP (compiler-grade) edges for codegraph — fork-only.
 *
 * Entry points:
 * - {@link runScipPass}: merge every installed index into the graph (after a
 *   full index, after `scip index` / `scip import`, after a background reindex)
 * - {@link onSynced}: after a sync — demote SCIP edges touching rewritten files,
 *   and re-merge when a rewritten file now matches the index again
 * - {@link importScipFile}: install an index produced elsewhere
 * - {@link scipStatus}
 */

import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { Compactor } from './compact';
import { languageOfTool } from './indexers';
import { MergeOutcome, addOutcome, emptyOutcome, markStaleForFiles, merge } from './merge';
import { ROLE_DEFINITION, ScipDocument, loadScipIndex, scanIndex } from './reader';
import { heuristicSites, referenceSites, scipDefinitions, scipSites } from './sites';
import {
  MergedDocument, ScipLanguage, SCIP_LANGUAGES, availableIndexes, indexPath,
  indexedHashes, installIndex, mergedDocumentCounts, readHashed, recordMergedDocuments,
} from './store';

export { ScipLanguage, SCIP_LANGUAGES } from './store';

/** What the SCIP layer needs from a CodeGraph instance. */
export interface ScipHost {
  getProjectRoot(): string;
  /** raw connection for reads */
  scipReadDb(): SqliteDatabase;
  /** runs `fn` holding the index mutex + cross-process write lock */
  scipWrite<T>(fn: (db: SqliteDatabase) => T): Promise<T>;
}

/**
 * What a patch changed (produce.ts patchIndex): the merge then re-judges only
 * the sites that can depend on it, and leaves every other edge as the last
 * pass judged it.
 */
export interface MergeScope {
  /** files whose documents were replaced or removed */
  files: string[];
  /** symbols those documents defined, before and after */
  symbols: string[];
}

export function joinScopes(scopes: MergeScope[]): MergeScope {
  return { files: [...new Set(scopes.flatMap(s => s.files))], symbols: [...new Set(scopes.flatMap(s => s.symbols))] };
}

export interface ScipPassReport {
  documents: number;
  freshDocuments: number;
  staleDocuments: string[];
  /** documents whose sites were re-judged: all fresh ones, or a scope's (see MergeScope) */
  judgedDocuments: number;
  /** diagnostic counters from call-site extraction (see sites.ts) */
  stats: Record<string, number>;
  outcome: MergeOutcome;
  durationMs: number;
  /** wall time per phase, ms: decode, hashGate, scipSites, heuristicSites, merge */
  phases: Record<string, number>;
}

/**
 * Merge all installed indexes — after a patch, just what `scope` can affect.
 * Returns null when the project has none. Must run with the write lock held
 * (the index hooks already hold it).
 */
export function runScipPass(db: SqliteDatabase, projectRoot: string, scope?: MergeScope): ScipPassReport | null {
  const installed = availableIndexes(projectRoot);
  if (installed.length === 0) return null;
  // A big pass reads and rewrites hundreds of thousands of rows across a
  // multi-GB table: give this connection a larger page cache for the pass.
  const cacheSize = db.pragma('cache_size', { simple: true }) as number;
  db.pragma('cache_size = -524288'); // 512 MB
  try {
    return pass(db, projectRoot, installed, scope);
  } finally {
    db.pragma(`cache_size = ${cacheSize}`);
  }
}

/**
 * Files per merge chunk: bounds the sites, texts and heuristic edges held at once
 * (vscode: ~14k documents). `CODEGRAPH_SCIP_MERGE_CHUNK` overrides it (tests use 1).
 */
const MERGE_CHUNK_FILES = 1000;

let gcFn: (() => void) | null | undefined;
/**
 * A full collection between chunks. Left to itself V8 lets each chunk's garbage
 * pile up towards its heap limit (vscode merge: 3.6 GB peak RSS instead of 2.3),
 * which is the memory the chunks exist to bound. `gc` is exposed at run time
 * (no `--expose-gc` needed); where that fails, chunks still bound what is live.
 */
function collectGarbage(): void {
  if (gcFn === undefined) {
    try {
      v8.setFlagsFromString('--expose-gc');
      gcFn = vm.runInNewContext('gc') as () => void;
    } catch {
      gcFn = null;
    }
  }
  gcFn?.();
}

function pass(db: SqliteDatabase, projectRoot: string, installed: ReturnType<typeof availableIndexes>, scope?: MergeScope): ScipPassReport {
  const started = Date.now();
  const phases: Record<string, number> = {};
  let mark = started;
  const lap = (name: string) => { const now = Date.now(); phases[name] = (phases[name] ?? 0) + now - mark; mark = now; };
  const indexes = installed.map(({ lang, meta }) => ({ lang, meta, docs: loadScipIndex(indexPath(projectRoot, lang)).documents }));
  lap('decode');

  // Hash gate: snapshot (what the indexer saw) == files.content_hash (what
  // codegraph extracted) == disk (what we read the call text from).
  const indexed = indexedHashes(db, indexes.flatMap(i => i.docs.map(d => d.relativePath)));
  const fresh = new Map<string, string>(); // path → text, split into lines per chunk
  const merged = new Map<ScipLanguage, MergedDocument[]>();
  const staleDocuments: string[] = [];
  for (const { lang, meta, docs } of indexes) {
    const list: MergedDocument[] = [];
    for (const d of docs) {
      const cg = indexed.get(d.relativePath);
      if (!cg) continue; // not a file codegraph indexes (excluded, generated, …)
      const disk = meta.hashes[d.relativePath] === cg ? readHashed(projectRoot, d.relativePath) : null;
      if (disk?.hash === cg && disk.text === null) continue; // over the size limit: codegraph extracted nothing from it
      if (disk?.hash !== cg || disk.text === null) {
        staleDocuments.push(d.relativePath);
        continue;
      }
      fresh.set(d.relativePath, disk.text);
      list.push({ path: d.relativePath, language: lang, contentHash: cg });
    }
    merged.set(lang, list);
  }
  lap('hashGate');

  // Definitions, implementations and the hash gate stay whole-index: they are what a
  // site's verdict reads. Only which sites get (re-)judged narrows.
  const judged = scope ? affectedFiles(db, indexes, scope, staleDocuments) : null;
  const freshFiles = new Set(fresh.keys());
  const defs = scipDefinitions(db, indexes, freshFiles);
  lap('scipSites');

  // Sites and their verdicts a chunk of files at a time (one transaction for all):
  // a large repo's sites, file texts and heuristic edges never sit in memory at once.
  // The chunks cover every file codegraph has — or the patch's — not just the fresh
  // ones: the merge also flags and re-judges edges out of files SCIP can't vouch for.
  const universe = judged ? [...judged].sort() : (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map(r => r.path);
  const chunkFiles = Number(process.env.CODEGRAPH_SCIP_MERGE_CHUNK) || MERGE_CHUNK_FILES;
  const stats: Record<string, number> = { ...defs.stats };
  let judgedDocuments = 0;
  const outcome = db.transaction(() => {
    const total = emptyOutcome();
    for (let i = 0; i < universe.length; i += chunkFiles) {
      const chunk = new Set(universe.slice(i, i + chunkFiles));
      const lines = new Map<string, string[]>();
      for (const f of chunk) { const text = fresh.get(f); if (text !== undefined) lines.set(f, text.split(/\r?\n/)); }
      judgedDocuments += lines.size;
      const scip = scipSites(db, indexes, lines, chunk, referenceSites(db, lines.keys()), defs);
      for (const [k, v] of Object.entries(scip.stats)) stats[k] = (stats[k] ?? 0) + v;
      lap('scipSites');
      const heuristic = heuristicSites(db, lines.keys());
      lap('heuristicSites');
      addOutcome(total, merge(db, scip, heuristic, freshFiles, chunk));
      lap('merge');
      collectGarbage();
      lap('gc');
    }
    for (const { lang, meta } of indexes) recordMergedDocuments(db, lang, meta, merged.get(lang) ?? []);
    return total;
  })();
  lap('merge');
  return {
    documents: indexes.reduce((n, i) => n + i.docs.length, 0),
    freshDocuments: fresh.size,
    staleDocuments,
    judgedDocuments,
    stats,
    outcome,
    durationMs: Date.now() - started,
    phases,
  };
}

/**
 * The files a patch can change verdicts in: its own, the stale ones, and every
 * file calling into it — by its documents' references to what the patched
 * documents defined (before or after: a renamed or removed target counts), or
 * by an edge into it (sync re-attaches those onto the patched files' new nodes).
 */
function affectedFiles(
  db: SqliteDatabase, indexes: Array<{ docs: ScipDocument[] }>, scope: MergeScope, stale: string[]
): Set<string> {
  const files = new Set([...scope.files, ...stale]);
  const symbols = new Set(scope.symbols);
  for (const { docs } of indexes) {
    for (const d of docs) {
      if (files.has(d.relativePath)) continue;
      if (d.occurrences.some(o => !(o.roles & ROLE_DEFINITION) && symbols.has(o.symbol)) ||
          d.implementations?.some(i => symbols.has(i.target))) files.add(d.relativePath);
    }
  }
  const callers = db.prepare(`SELECT DISTINCT s.file_path AS f FROM nodes t JOIN edges e ON e.target = t.id JOIN nodes s ON s.id = e.source
    WHERE t.file_path = ? AND e.kind IN ('calls', 'instantiates', 'implements', 'extends')`);
  for (const f of scope.files) for (const { f: caller } of callers.all(f) as { f: string }[]) files.add(caller);
  return files;
}

/**
 * After a sync (write lock held). Cheap unless a changed file now matches the
 * installed index again — e.g. the background reindex ran before this sync
 * caught up with the edit — in which case the full pass re-verifies it.
 */
export function onSynced(db: SqliteDatabase, projectRoot: string, changedFiles: readonly string[]): ScipPassReport | null {
  const installed = availableIndexes(projectRoot);
  if (installed.length === 0 || changedFiles.length === 0) return null;
  markStaleForFiles(db, changedFiles);
  const indexed = indexedHashes(db, changedFiles);
  const nowFresh = changedFiles.some(f => installed.some(({ meta }) => meta.hashes[f] !== undefined && meta.hashes[f] === indexed.get(f)));
  return nowFresh ? runScipPass(db, projectRoot) : null;
}

/**
 * Install an index produced outside codegraph.
 *
 * There is no indexer-start snapshot to trust, so the index file's own mtime
 * stands in for "when it was built": a source file modified after that is left
 * out of the snapshot, and its document stays stale until a reindex. A file
 * edited and reverted before the import still counts — its bytes match.
 */
export function importScipFile(
  projectRoot: string, file: string, lang?: ScipLanguage, refs?: Set<string>
): { lang: ScipLanguage; documents: number; newerThanIndex: string[] } {
  const builtAt = fs.statSync(file).mtimeMs;
  const bytes = fs.readFileSync(file);
  const { toolName } = scanIndex(bytes);
  const resolved = lang ?? languageOfTool(toolName);
  if (!resolved) {
    throw new Error(`can't tell which language ${file} covers (tool "${toolName}") — pass --lang (${SCIP_LANGUAGES.join('|')})`);
  }
  const compact = new Compactor(projectRoot, resolved, refs);
  compact.add(bytes);
  if (compact.paths.length === 0) throw new Error(`${file} has no documents — the indexer failed or this is not a SCIP index`);
  const hashes: Record<string, string> = {};
  const newerThanIndex: string[] = [];
  for (const p of compact.paths) {
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(projectRoot, p)).mtimeMs;
    } catch {
      continue; // gone from disk — nothing to vouch for
    }
    if (mtime > builtAt) {
      newerThanIndex.push(p);
      continue;
    }
    const h = readHashed(projectRoot, p)?.hash;
    if (h) hashes[p] = h;
  }
  installIndex(projectRoot, resolved, f => compact.write(f), {
    tool: compact.meta!.toolName, toolVersion: compact.meta!.toolVersion, producedAt: builtAt, hashes,
    resolvedCalls: compact.resolvedCalls(),
  });
  return { lang: resolved, documents: compact.paths.length, newerThanIndex };
}

export interface ScipStatus {
  indexes: Array<{ lang: ScipLanguage; tool: string; toolVersion: string; producedAt: number; files: number; mergedDocuments: number }>;
  edges: { scip: number; stale: number; silent: number };
}

export function scipStatus(db: SqliteDatabase, projectRoot: string): ScipStatus {
  const counts = mergedDocumentCounts(db);
  const indexes = availableIndexes(projectRoot).map(({ lang, meta: m }) => ({
    lang, tool: m.tool, toolVersion: m.toolVersion, producedAt: m.producedAt,
    files: Object.keys(m.hashes).length, mergedDocuments: counts.get(lang) ?? 0,
  }));
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    indexes,
    edges: {
      scip: one(`SELECT COUNT(*) AS n FROM edges WHERE provenance = 'scip'`),
      stale: one(`SELECT COUNT(*) AS n FROM edges WHERE provenance = 'scip' AND metadata LIKE '%"scipStale":true%'`),
      silent: one(`SELECT COUNT(*) AS n FROM edges WHERE metadata LIKE '%"scipSilent":true%'`),
    },
  };
}
