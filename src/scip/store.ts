/**
 * Where SCIP state lives and how freshness is decided.
 *
 * On disk, per indexer language, under `.codegraph/scip/`:
 *   <lang>.scip       the index
 *   <lang>.meta.json  tool info + the content hash of every file as it was when
 *                     the indexer STARTED (the "snapshot")
 *   reindex.lock      pid of the process re-indexing (indexers + merge) right now
 *
 * A SCIP document is trusted only when its snapshot hash, the hash codegraph
 * stored for the file (`files.content_hash`) and the file on disk all agree —
 * both indexes saw the bytes the merge reads call text from. Anything else is
 * stale and its call sites are left alone. The gate itself runs in the pass
 * (index.ts); this module owns the hashes it compares.
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
import { FileLock } from '../utils';
import type { SqliteDatabase } from '../db/sqlite-adapter';

export const SCIP_LANGUAGES = ['typescript', 'python', 'go', 'rust'] as const;
export type ScipLanguage = (typeof SCIP_LANGUAGES)[number];

export interface ScipMeta {
  tool: string;
  toolVersion: string;
  /** epoch ms when the snapshot was taken (indexer start, or import time for `scip import`) */
  producedAt: number;
  /** repo-relative path → content hash, as codegraph computes it */
  hashes: Record<string, string>;
  /** the regression guard's baseline — see produce.ts */
  resolvedCalls?: number;
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

export interface InstalledIndex {
  lang: ScipLanguage;
  meta: ScipMeta;
}

/** Languages that have both an index and a readable snapshot on disk — with the snapshot, read once. */
export function availableIndexes(projectRoot: string): InstalledIndex[] {
  const out: InstalledIndex[] = [];
  for (const lang of SCIP_LANGUAGES) {
    if (!fs.existsSync(indexPath(projectRoot, lang))) continue;
    const meta = readMeta(projectRoot, lang);
    if (meta) out.push({ lang, meta });
  }
  return out;
}

export function readMeta(projectRoot: string, lang: ScipLanguage): ScipMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(projectRoot, lang), 'utf8')) as ScipMeta;
    return m && typeof m.hashes === 'object' && m.hashes !== null ? m : null;
  } catch {
    return null;
  }
}

/**
 * Installs an index (`write` produces it at a temp path) and then the snapshot
 * that vouches for it — in that order: a crash between the two leaves a new
 * index under an old snapshot, which only makes more documents read as stale,
 * never a wrong edge.
 */
export function installIndex(projectRoot: string, lang: ScipLanguage, write: (file: string) => void, meta: ScipMeta): void {
  const final = indexPath(projectRoot, lang);
  const tmp = `${final}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(final), { recursive: true });
  try {
    write(tmp);
    fs.renameSync(tmp, final);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  writeFileAtomic(metaPath(projectRoot, lang), JSON.stringify(meta));
}

/**
 * One re-index (indexer runs + merge) per repo at a time, across processes: the
 * watcher's background reindex and a CLI `scip index` would otherwise each start
 * a full indexer (~8 GB for vscode). Null when another live process holds it;
 * a dead holder's lock is taken over.
 */
export function tryReindexLock(projectRoot: string): FileLock | null {
  fs.mkdirSync(scipDir(projectRoot), { recursive: true });
  const lock = new FileLock(path.join(scipDir(projectRoot), 'reindex.lock'));
  try {
    lock.acquire();
    return lock;
  } catch (err) {
    if (err instanceof Error && err.message.includes('locked by another')) return null;
    throw err;
  }
}

/** Atomic write: a concurrent reader sees the old file or the new one, never half of either. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * A file's content hash the way the extractor computes it, plus its text —
 * null text for a file over codegraph's size limit (hashed by size, never read).
 * Null when it can't be read: an unreadable file can't be vouched for.
 */
export function readHashed(projectRoot: string, relPath: string): { hash: string; text: string | null } | null {
  try {
    const abs = path.join(projectRoot, relPath);
    let text: string | null = null;
    const hash = hashContent(indexedHashInput(fs.statSync(abs).size, () => (text = fs.readFileSync(abs, 'utf8'))));
    return { hash, text };
  } catch {
    return null;
  }
}

/** Snapshot the current content hash of every tracked file in the given codegraph languages. */
export function snapshotHashes(db: SqliteDatabase, projectRoot: string, languages: readonly string[]): Record<string, string> {
  const rows = db
    .prepare(`SELECT path FROM files WHERE language IN (${languages.map(() => '?').join(',')})`)
    .all(...languages) as { path: string }[];
  const out: Record<string, string> = {};
  for (const { path: p } of rows) {
    const h = readHashed(projectRoot, p)?.hash;
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

/** Read-only: never creates the table (callers may not hold the write lock). */
export function mergedDocumentCounts(db: SqliteDatabase): Map<string, number> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scip_documents'").get();
  if (!exists) return new Map();
  const rows = db.prepare('SELECT language, COUNT(*) AS n FROM scip_documents GROUP BY language').all() as
    { language: string; n: number }[];
  return new Map(rows.map(r => [r.language, r.n]));
}
