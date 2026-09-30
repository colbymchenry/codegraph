/**
 * Where SCIP state lives and how freshness is decided.
 *
 * On disk, per indexer language, under `.codegraph/scip/`:
 *   <lang>.scip       the index
 *   <lang>.meta.json  tool info + the content hash of every file as it was when
 *                     the indexer STARTED (the "snapshot")
 *
 * A SCIP document is trusted only when its snapshot hash equals the hash
 * codegraph stored for the file (`files.content_hash`) — i.e. both indexes saw
 * the same bytes. Anything else is stale and its call sites are left alone.
 *
 * `scip_documents` records which documents are currently merged into the graph.
 * It is created lazily and sits outside the upstream migration chain, so an
 * upstream rebase never collides with it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { hashContent } from '../extraction';
import { indexedHashInput } from '../file-limits';
import type { SqliteDatabase } from '../db/sqlite-adapter';

export const SCIP_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type ScipLanguage = (typeof SCIP_LANGUAGES)[number];

/** codegraph `files.language` values each SCIP indexer covers. */
export const CODEGRAPH_LANGUAGES: Record<ScipLanguage, readonly string[]> = {
  typescript: ['typescript', 'javascript', 'tsx', 'jsx'],
  python: ['python'],
  go: ['go'],
  rust: ['rust'],
};

export interface ScipMeta {
  tool: string;
  toolVersion: string;
  /** epoch ms when the snapshot was taken (indexer start, or import time for `scip import`) */
  producedAt: number;
  /** repo-relative path → content hash, as codegraph computes it */
  hashes: Record<string, string>;
  /** the regression guard's baseline — see produce.ts */
  resolvedRefs?: number;
}

export function scipDir(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), 'scip');
}

export function indexPath(projectRoot: string, lang: ScipLanguage): string {
  return path.join(scipDir(projectRoot), `${lang}.scip`);
}

export function metaPath(projectRoot: string, lang: ScipLanguage): string {
  return path.join(scipDir(projectRoot), `${lang}.meta.json`);
}

/** Languages that have both an index and a readable snapshot on disk. */
export function availableIndexes(projectRoot: string): ScipLanguage[] {
  return SCIP_LANGUAGES.filter(l => fs.existsSync(indexPath(projectRoot, l)) && readMeta(projectRoot, l) !== null);
}

export function readMeta(projectRoot: string, lang: ScipLanguage): ScipMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(projectRoot, lang), 'utf8')) as ScipMeta;
    return m && typeof m.hashes === 'object' && m.hashes !== null ? m : null;
  } catch {
    return null;
  }
}

/** Atomic write: a concurrent reader sees the old file or the new one, never half of either. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Hash one file the way the extractor does, or null when it can't be read. */
export function hashFile(projectRoot: string, relPath: string): string | null {
  try {
    const abs = path.join(projectRoot, relPath);
    const size = fs.statSync(abs).size;
    return hashContent(indexedHashInput(size, () => fs.readFileSync(abs, 'utf8')));
  } catch {
    return null;
  }
}

/** Snapshot the current content hash of every tracked file of this language. */
export function snapshotHashes(db: SqliteDatabase, projectRoot: string, lang: ScipLanguage): Record<string, string> {
  const langs = CODEGRAPH_LANGUAGES[lang];
  const rows = db
    .prepare(`SELECT path FROM files WHERE language IN (${langs.map(() => '?').join(',')})`)
    .all(...langs) as { path: string }[];
  const out: Record<string, string> = {};
  for (const { path: p } of rows) {
    const h = hashFile(projectRoot, p);
    if (h) out[p] = h;
  }
  return out;
}

/** path → content hash codegraph indexed, for the given paths. */
export function indexedHashes(db: SqliteDatabase, paths: Iterable<string>): Map<string, string> {
  const stmt = db.prepare('SELECT content_hash FROM files WHERE path = ?');
  const out = new Map<string, string>();
  for (const p of paths) {
    const row = stmt.get(p) as { content_hash: string } | undefined;
    if (row) out.set(p, row.content_hash);
  }
  return out;
}

export function ensureDocumentsTable(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scip_documents (
    path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    tool TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  )`);
}

export interface MergedDocument {
  path: string;
  language: ScipLanguage;
  contentHash: string;
}

/** Replace one language's merged-document rows. */
export function recordMergedDocuments(
  db: SqliteDatabase, lang: ScipLanguage, meta: ScipMeta, docs: MergedDocument[]
): void {
  ensureDocumentsTable(db);
  db.prepare('DELETE FROM scip_documents WHERE language = ?').run(lang);
  const ins = db.prepare(
    'INSERT OR REPLACE INTO scip_documents(path, language, content_hash, tool, tool_version, imported_at) VALUES (?,?,?,?,?,?)'
  );
  const now = Date.now();
  for (const d of docs) ins.run(d.path, lang, d.contentHash, meta.tool, meta.toolVersion, now);
}

export function mergedDocumentCounts(db: SqliteDatabase): Map<string, number> {
  ensureDocumentsTable(db);
  const rows = db.prepare('SELECT language, COUNT(*) AS n FROM scip_documents GROUP BY language').all() as
    { language: string; n: number }[];
  return new Map(rows.map(r => [r.language, r.n]));
}
