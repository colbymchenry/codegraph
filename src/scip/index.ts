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
import { hashContent } from '../extraction';
import { indexedHashInput } from '../file-limits';
import { TOOL_LANGUAGES } from './indexers';
import { MergeOutcome, markStaleForFiles, merge } from './merge';
import { resolvedRefCount } from './produce';
import { ScipDocument, loadScipIndex } from './reader';
import { heuristicSites, scipSites } from './sites';
import {
  MergedDocument, ScipLanguage, ScipMeta, SCIP_LANGUAGES, availableIndexes, hashFile, indexPath,
  indexedHashes, mergedDocumentCounts, metaPath, readMeta, recordMergedDocuments, writeFileAtomic,
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
  languages: ScipLanguage[];
  documents: number;
  freshDocuments: number;
  staleDocuments: string[];
  stats: Record<string, number>;
  sites: { heuristic: number; scip: number; unknown: number };
  outcome: MergeOutcome;
  durationMs: number;
}

/**
 * Merge all installed indexes. Returns null when the project has none.
 * Must run with the write lock held (the index hooks already hold it).
 */
export function runScipPass(db: SqliteDatabase, projectRoot: string): ScipPassReport | null {
  const languages = availableIndexes(projectRoot);
  if (languages.length === 0) return null;
  const started = Date.now();

  const docs: ScipDocument[] = [];
  const perLang: Array<{ lang: ScipLanguage; meta: ScipMeta; docs: ScipDocument[] }> = [];
  for (const lang of languages) {
    const ix = loadScipIndex(indexPath(projectRoot, lang));
    perLang.push({ lang, meta: readMeta(projectRoot, lang)!, docs: ix.documents });
    docs.push(...ix.documents);
  }

  // Hash gate: snapshot (what the indexer saw) == files.content_hash (what
  // codegraph extracted) == disk (what we read the call text from).
  const indexed = indexedHashes(db, docs.map(d => d.relativePath));
  const fresh = new Map<string, string[]>();
  const merged = new Map<ScipLanguage, MergedDocument[]>();
  const staleDocuments: string[] = [];
  for (const { lang, meta, docs: langDocs } of perLang) {
    const list: MergedDocument[] = [];
    for (const d of langDocs) {
      const snap = meta.hashes[d.relativePath];
      const cg = indexed.get(d.relativePath);
      if (!cg) continue; // not a file codegraph indexes (excluded, generated, …)
      const text = snap === cg ? readIfHash(projectRoot, d.relativePath, cg) : null;
      if (text === null) {
        staleDocuments.push(d.relativePath);
        continue;
      }
      fresh.set(d.relativePath, text.split(/\r?\n/));
      list.push({ path: d.relativePath, language: lang, contentHash: cg });
    }
    merged.set(lang, list);
  }

  const scip = scipSites(db, docs, fresh);
  const heuristic = heuristicSites(db, fresh.keys());
  const outcome = db.transaction(() => {
    const o = merge(db, scip, heuristic, new Set(fresh.keys()));
    for (const { lang, meta } of perLang) recordMergedDocuments(db, lang, meta, merged.get(lang) ?? []);
    return o;
  })();
  return {
    languages,
    documents: docs.length,
    freshDocuments: fresh.size,
    staleDocuments,
    stats: scip.stats,
    sites: { heuristic: heuristic.size, scip: scip.sites.size, unknown: scip.unknown.size },
    outcome,
    durationMs: Date.now() - started,
  };
}

function readIfHash(projectRoot: string, rel: string, expected: string): string | null {
  try {
    const abs = path.join(projectRoot, rel);
    const size = fs.statSync(abs).size;
    const text = fs.readFileSync(abs, 'utf8');
    return hashContent(indexedHashInput(size, () => text)) === expected ? text : null;
  } catch {
    return null;
  }
}

/**
 * After a sync (write lock held). Cheap unless a changed file now matches the
 * installed index again — e.g. the background reindex ran before this sync
 * caught up with the edit — in which case the full pass re-verifies it.
 */
export function onSynced(db: SqliteDatabase, projectRoot: string, changedFiles: readonly string[]): ScipPassReport | null {
  const languages = availableIndexes(projectRoot);
  if (languages.length === 0 || changedFiles.length === 0) return null;
  markStaleForFiles(db, changedFiles);
  const indexed = indexedHashes(db, changedFiles);
  const metas = languages.map(l => readMeta(projectRoot, l)!);
  const nowFresh = changedFiles.some(f => metas.some(m => m.hashes[f] !== undefined && m.hashes[f] === indexed.get(f)));
  return nowFresh ? runScipPass(db, projectRoot) : null;
}

/**
 * Install an index produced outside codegraph. Its snapshot is the current
 * disk content — the caller vouches that the index was built from it.
 */
export function importScipFile(projectRoot: string, file: string, lang?: ScipLanguage): { lang: ScipLanguage; documents: number } {
  const ix = loadScipIndex(file);
  const resolved = lang ?? TOOL_LANGUAGES[ix.toolName];
  if (!resolved) {
    throw new Error(`can't tell which language ${file} covers (tool "${ix.toolName}") — pass --lang (${SCIP_LANGUAGES.join('|')})`);
  }
  const hashes: Record<string, string> = {};
  for (const d of ix.documents) {
    const h = hashFile(projectRoot, d.relativePath);
    if (h) hashes[d.relativePath] = h;
  }
  writeFileAtomic(indexPath(projectRoot, resolved), fs.readFileSync(file));
  const meta: ScipMeta = {
    tool: ix.toolName, toolVersion: ix.toolVersion, producedAt: Date.now(), hashes, resolvedRefs: resolvedRefCount(ix),
  };
  writeFileAtomic(metaPath(projectRoot, resolved), JSON.stringify(meta));
  return { lang: resolved, documents: ix.documents.length };
}

export interface ScipStatus {
  indexes: Array<{ lang: ScipLanguage; tool: string; toolVersion: string; producedAt: number; files: number; mergedDocuments: number }>;
  edges: { scip: number; stale: number; silent: number };
}

export function scipStatus(db: SqliteDatabase, projectRoot: string): ScipStatus {
  const counts = mergedDocumentCounts(db);
  const indexes = availableIndexes(projectRoot).map(lang => {
    const m = readMeta(projectRoot, lang)!;
    return {
      lang, tool: m.tool, toolVersion: m.toolVersion, producedAt: m.producedAt,
      files: Object.keys(m.hashes).length, mergedDocuments: counts.get(lang) ?? 0,
    };
  });
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
