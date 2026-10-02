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
 * `scip_documents` records which documents are currently merged into the graph,
 * and `scip_merges` which installed index (by `producedAt`) they came from —
 * written in the merge's own transaction, so the stamp can't disagree with the
 * edges. Both are created lazily and sits outside the upstream migration chain, so an
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
  /** how long the last full run took (indexer runs + compaction), ms: what a patch's estimate is weighed against */
  fullRunMs?: number;
  /** when the last full run (or import) was taken; a patch carries it over (produce.ts incrementalPlan bounds the drift) */
  fullAt?: number;
  /** patches installed since then */
  patches?: number;
  /** measured ÷ declared time of this tool's patches, averaged: scales the adapter's `seconds` (produce.ts) */
  patchRatio?: number;
  /** every call the index counts carries ROLE_COUNTED_CALL (compact.ts): a patch can keep its other documents as they are */
  callMarks?: boolean;
}

/** Patches follow importers one level; force a full run after this many, or this long since `fullAt`. */
export const MAX_PATCHES = 20;
export const MAX_PATCH_AGE_MS = 12 * 60 * 60_000;

const PATCH_RATIO_MIN = 0.1;
const PATCH_RATIO_MAX = 2;

/** The ratio a patch that took `measuredMs` leaves: averaged with the previous one, bounded. */
export function nextPatchRatio(previous: number | undefined, declaredMs: number, measuredMs: number): number | undefined {
  if (declaredMs <= 0) return previous;
  const r = measuredMs / declaredMs;
  return Math.min(PATCH_RATIO_MAX, Math.max(PATCH_RATIO_MIN, previous === undefined ? r : (previous + r) / 2));
}

/** True when patch count or age says only a full run will do. */
export function patchDriftExceeded(meta: ScipMeta, now = Date.now()): boolean {
  return (meta.patches ?? 0) >= MAX_PATCHES
    || (meta.fullAt !== undefined && now - meta.fullAt > MAX_PATCH_AGE_MS);
}

/** Meta after a full indexer run. */
export function metaAfterFull(
  previous: ScipMeta | null,
  fields: {
    tool: string; toolVersion: string; producedAt: number; hashes: Record<string, string>;
    resolvedCalls: number; fullRunMs: number;
  },
): ScipMeta {
  return {
    ...fields,
    fullAt: fields.producedAt,
    patchRatio: previous?.tool === fields.tool ? previous.patchRatio : undefined,
    callMarks: true,
  };
}

/** Meta after a patch: keeps full-run baselines, bumps `patches`, optionally recalibrates `patchRatio`. */
export function metaAfterPatch(
  previous: ScipMeta,
  fields: {
    tool: string; toolVersion: string; producedAt: number; hashes: Record<string, string>;
    resolvedCalls: number; durationMs: number; declaredMs: number; unitsMatchPlan: boolean;
  },
): ScipMeta {
  return {
    tool: fields.tool,
    toolVersion: fields.toolVersion,
    producedAt: fields.producedAt,
    hashes: fields.hashes,
    resolvedCalls: fields.resolvedCalls,
    fullRunMs: previous.fullRunMs,
    fullAt: previous.fullAt,
    patches: (previous.patches ?? 0) + 1,
    patchRatio: fields.unitsMatchPlan
      ? nextPatchRatio(previous.patchRatio, fields.declaredMs, fields.durationMs)
      : previous.patchRatio,
    callMarks: true, // kept documents had marks, or were compacted again here (produce.ts patchIndex)
  };
}

/**
 * Meta after `scip import`. Same-tool planner fields (`fullRunMs`, `patchRatio`,
 * `patches`) carry over so an import cannot silently disable the half-full-run gate.
 */
export function metaAfterImport(
  previous: ScipMeta | null,
  fields: {
    tool: string; toolVersion: string; producedAt: number; hashes: Record<string, string>;
    resolvedCalls: number; fullAt: number;
  },
): ScipMeta {
  const same = previous?.tool === fields.tool;
  return {
    ...fields,
    fullRunMs: same ? previous!.fullRunMs : undefined,
    patchRatio: same ? previous!.patchRatio : undefined,
    patches: same ? previous!.patches : undefined,
    callMarks: true,
  };
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
  // A new install has a new producedAt, so it reads as unmerged (isMerged) until a merge records it.
  writeFileAtomic(metaPath(projectRoot, lang), JSON.stringify(meta));
}

/** Read-only: false when the fork's tables don't exist yet (callers may not hold the write lock). */
function hasTable(db: SqliteDatabase, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * This exact install (by `producedAt`) has been merged into the graph. False after
 * an install the round threw or crashed before merging, and after {@link forgetMerges}.
 */
export function isMerged(db: SqliteDatabase, lang: ScipLanguage, meta: ScipMeta): boolean {
  if (!hasTable(db, 'scip_merges')) return false;
  const row = db.prepare('SELECT produced_at FROM scip_merges WHERE language = ?').get(lang) as { produced_at: number } | undefined;
  return row?.produced_at === meta.producedAt;
}

/** True when any installed index is not the one last merged (or was never merged). */
export function needsMerge(db: SqliteDatabase, projectRoot: string): boolean {
  return availableIndexes(projectRoot).some(({ lang, meta }) => !isMerged(db, lang, meta));
}

/** The graph was rebuilt (every SCIP edge gone): no installed index is merged any more. */
export function forgetMerges(db: SqliteDatabase): void {
  if (hasTable(db, 'scip_merges')) db.exec('DELETE FROM scip_merges');
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
function writeFileAtomic(file: string, data: string | Buffer): void {
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

/**
 * An edge carrying merge.ts's `flag` (json_set writes it without spaces). COALESCE so
 * `NOT (…)` stays true when metadata is NULL — SQLite's `NOT (NULL LIKE …)` is unknown
 * and would drop verified scip edges from status counts (playwright: ~24k null-meta edges).
 * `column`: an aliased column (`e.metadata`) where the query joins.
 */
export function edgeFlag(flag: 'scipSilent' | 'scipStale', column = 'metadata'): string {
  return `COALESCE(${column},'') LIKE '%"${flag}":true%'`;
}

/** A heuristic edge the compiler could not confirm. The partial index scip_silent_edges is defined by this exact text. */
export const SILENT_EDGE = edgeFlag('scipSilent');

/** A SCIP edge whose ends changed since it was verified. */
export const STALE_EDGE = edgeFlag('scipStale');

/**
 * Compiler-verified — the SQL form of notes.ts `scipVerdict(...) === 'verified'`:
 * a SCIP edge neither silent nor stale. `alias`: the edges table's alias where the query joins.
 */
export function verifiedEdge(alias?: string): string {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  return `${col('provenance')} = 'scip' AND NOT (${edgeFlag('scipSilent', col('metadata'))}) AND NOT (${edgeFlag('scipStale', col('metadata'))})`;
}

/**
 * The fork's own tables and indexes, outside upstream's migrations. The partial
 * index keeps counting unverified edges off a full scan of `edges` (Django: 511 → 2 ms).
 */
function ensureScipSchema(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scip_documents (
    path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    tool TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    imported_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS scip_merges (
    language TEXT PRIMARY KEY,
    produced_at INTEGER NOT NULL
  )`);
  // Recreate if an older install still has the pre-COALESCE predicate (partial-index
  // WHERE must match the query expression for SQLite to use it).
  const idx = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND name='scip_silent_edges'`,
  ).get() as { sql: string } | undefined;
  if (idx && !idx.sql.includes('COALESCE(metadata')) {
    db.exec(`DROP INDEX IF EXISTS scip_silent_edges`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS scip_silent_edges ON edges(source) WHERE ${SILENT_EDGE}`);
}

export interface MergedDocument {
  path: string;
  language: ScipLanguage;
  contentHash: string;
}

/** Replace one language's merged-document rows, and stamp `meta`'s install as merged (call inside the merge's transaction). */
export function recordMergedDocuments(
  db: SqliteDatabase, lang: ScipLanguage, meta: ScipMeta, docs: MergedDocument[]
): void {
  ensureScipSchema(db);
  db.prepare('DELETE FROM scip_documents WHERE language = ?').run(lang);
  const ins = db.prepare(
    'INSERT OR REPLACE INTO scip_documents(path, language, content_hash, tool, tool_version, imported_at) VALUES (?,?,?,?,?,?)'
  );
  const now = Date.now();
  for (const d of docs) ins.run(d.path, lang, d.contentHash, meta.tool, meta.toolVersion, now);
  db.prepare('INSERT OR REPLACE INTO scip_merges(language, produced_at) VALUES (?, ?)').run(lang, meta.producedAt);
}

/** Read-only: never creates the table (callers may not hold the write lock). */
export function mergedDocumentCounts(db: SqliteDatabase): Map<string, number> {
  if (!hasTable(db, 'scip_documents')) return new Map();
  const rows = db.prepare('SELECT language, COUNT(*) AS n FROM scip_documents GROUP BY language').all() as
    { language: string; n: number }[];
  return new Map(rows.map(r => [r.language, r.n]));
}
