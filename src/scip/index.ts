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
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { Compactor } from './compact';
import { languageOfTool } from './indexers';
import { MergeOutcome, markStaleForFiles, merge } from './merge';
import { loadScipIndex, scanIndex } from './reader';
import { heuristicSites, scipSites } from './sites';
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

export interface ScipPassReport {
  documents: number;
  freshDocuments: number;
  staleDocuments: string[];
  /** diagnostic counters from call-site extraction (see sites.ts) */
  stats: Record<string, number>;
  outcome: MergeOutcome;
  durationMs: number;
  /** wall time per phase, ms: decode, hashGate, scipSites, heuristicSites, merge */
  phases: Record<string, number>;
}

/**
 * Merge all installed indexes. Returns null when the project has none.
 * Must run with the write lock held (the index hooks already hold it).
 */
export function runScipPass(db: SqliteDatabase, projectRoot: string): ScipPassReport | null {
  const installed = availableIndexes(projectRoot);
  if (installed.length === 0) return null;
  // A big pass reads and rewrites hundreds of thousands of rows across a
  // multi-GB table: give this connection a larger page cache for the pass.
  const cacheSize = db.pragma('cache_size', { simple: true }) as number;
  db.pragma('cache_size = -524288'); // 512 MB
  try {
    return pass(db, projectRoot, installed);
  } finally {
    db.pragma(`cache_size = ${cacheSize}`);
  }
}

function pass(db: SqliteDatabase, projectRoot: string, installed: ReturnType<typeof availableIndexes>): ScipPassReport {
  const started = Date.now();
  const phases: Record<string, number> = {};
  let mark = started;
  const lap = (name: string) => { const now = Date.now(); phases[name] = now - mark; mark = now; };
  const indexes = installed.map(({ lang, meta }) => ({ lang, meta, docs: loadScipIndex(indexPath(projectRoot, lang)).documents }));
  lap('decode');

  // Hash gate: snapshot (what the indexer saw) == files.content_hash (what
  // codegraph extracted) == disk (what we read the call text from).
  const indexed = indexedHashes(db, indexes.flatMap(i => i.docs.map(d => d.relativePath)));
  const fresh = new Map<string, string[]>();
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
      fresh.set(d.relativePath, disk.text.split(/\r?\n/));
      list.push({ path: d.relativePath, language: lang, contentHash: cg });
    }
    merged.set(lang, list);
  }
  lap('hashGate');

  const scip = scipSites(db, indexes, fresh);
  lap('scipSites');
  const heuristic = heuristicSites(db, fresh.keys());
  lap('heuristicSites');
  const outcome = db.transaction(() => {
    const o = merge(db, scip, heuristic, new Set(fresh.keys()));
    for (const { lang, meta } of indexes) recordMergedDocuments(db, lang, meta, merged.get(lang) ?? []);
    return o;
  })();
  lap('merge');
  return {
    documents: indexes.reduce((n, i) => n + i.docs.length, 0),
    freshDocuments: fresh.size,
    staleDocuments,
    stats: scip.stats,
    outcome,
    durationMs: Date.now() - started,
    phases,
  };
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
  projectRoot: string, file: string, lang?: ScipLanguage
): { lang: ScipLanguage; documents: number; newerThanIndex: string[] } {
  const builtAt = fs.statSync(file).mtimeMs;
  const bytes = fs.readFileSync(file);
  const { toolName } = scanIndex(bytes);
  const resolved = lang ?? languageOfTool(toolName);
  if (!resolved) {
    throw new Error(`can't tell which language ${file} covers (tool "${toolName}") — pass --lang (${SCIP_LANGUAGES.join('|')})`);
  }
  const compact = new Compactor(projectRoot, resolved);
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
