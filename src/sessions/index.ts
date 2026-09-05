/**
 * Session index: full-text search over the agent-session transcripts that
 * belong to a project — "what did the last session decide about X" as one
 * query instead of a grep over hundreds of megabytes of JSONL.
 *
 * An FTS5 table (porter stemming, BM25 rank) over the prose of every
 * transcript, stored in its own file, `.codegraph/sessions.db`, beside the
 * graph. Its own file on purpose: the graph's schema, migrations and bulk-load
 * FTS rebuild stay untouched, and the two indexes have different lifetimes (a
 * transcript changes while the code does not). Refresh happens on query and
 * re-reads only files whose mtime or size moved, so a call after one live
 * session costs tens of milliseconds; the first index of a few hundred
 * transcripts takes about a second.
 *
 * Readers live beside this file, one per agent host (`claude-code.ts` today).
 */
import * as fs from 'fs';
import * as path from 'path';
import { createDatabase, type SqliteDatabase, type SqliteStatement } from '../db/sqlite-adapter';
import { getCodeGraphDir } from '../directory';
import { loadSessionsEnabled } from '../project-config';
import {
  claudeSessionsDir,
  parseEntries,
  sessionIdOf,
  transcriptDocs,
  transcriptTitle,
  walkJsonl,
} from './claude-code';

export const SESSIONS_DB_FILENAME = 'sessions.db';

/** How long a connection waits for another's write before giving up. */
export const BUSY_TIMEOUT_MS = 5000;

/** Bump when the readers' notion of prose changes, so existing indexes rebuild. */
const INDEX_VERSION = 2;

export interface SessionsIndexStats {
  /** Transcript files seen. */
  files: number;
  /** Files re-read because their mtime or size moved. */
  refreshed: number;
  /** Docs written for the refreshed files. */
  docs: number;
}

export interface SessionHit {
  session: string;
  title: string | null;
  role: string;
  ts: string;
  /** The matching passage with `[match]` marks, about 24 tokens wide. */
  snippet: string;
  /** BM25 rank; lower is better, relative within one query only. */
  score: number;
}

export interface SessionSearchOptions {
  /** Max hits (default 10). */
  limit?: number;
  /** `user`, `assistant` or `summary`. */
  role?: string;
  /** ISO timestamp; hits before it are dropped. */
  sinceIso?: string;
  /** Session id prefix. */
  session?: string;
  /** OR the words instead of ANDing them. */
  any?: boolean;
}

/**
 * Every word quoted, ANDed or ORed, so a flag, a path or punctuation in the
 * query can never break FTS5's MATCH syntax. Porter stemming happens inside
 * FTS5, so "merging" reaches "merged".
 */
export function ftsQuery(raw: string, any = false): string {
  return (raw.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => `"${w}"`).join(any ? ' OR ' : ' ');
}

interface FileRow {
  path: string;
  mtime: number;
  size: number;
}

export class SessionsIndex {
  private readonly fileRow: SqliteStatement;
  private readonly putFile: SqliteStatement;
  private readonly dropDocs: SqliteStatement;
  private readonly addDoc: SqliteStatement;

  private constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, session TEXT NOT NULL, title TEXT, mtime REAL NOT NULL, size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        text, file UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize = 'porter unicode61'
      );
    `);
    // A reader change (what counts as prose) only reaches transcripts that
    // change afterwards; bumping INDEX_VERSION re-reads every file once.
    if (db.pragma('user_version', { simple: true }) !== INDEX_VERSION) {
      db.exec(`DELETE FROM docs; DELETE FROM files; PRAGMA user_version = ${INDEX_VERSION}`);
    }
    this.fileRow = db.prepare('SELECT mtime, size FROM files WHERE path = ?');
    this.putFile = db.prepare(
      'INSERT OR REPLACE INTO files (path, session, title, mtime, size) VALUES (?, ?, ?, ?, ?)',
    );
    this.dropDocs = db.prepare('DELETE FROM docs WHERE file = ?');
    this.addDoc = db.prepare('INSERT INTO docs (text, file, role, ts) VALUES (?, ?, ?, ?)');
  }

  /** Open (creating if needed) the index at `dbPath`; `:memory:` for tests. */
  static open(dbPath: string): SessionsIndex {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { db } = createDatabase(dbPath);
    // Parallel tool calls run on worker threads, one connection each, and all
    // of them see the same changed transcript. node:sqlite's busy timeout is
    // zero, so without this the losers fail with "database is locked" instead
    // of waiting the few hundred milliseconds the winner's write takes. Set
    // before the constructor's schema and version writes, which race the same way.
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
    return new SessionsIndex(db);
  }

  /**
   * Bring the index up to date with the transcripts under `dir`. Each changed
   * file is one transaction, so a crash mid-refresh leaves every other file
   * whole. Files that vanished from disk are forgotten.
   */
  refresh(dir: string): SessionsIndexStats {
    const files = walkJsonl(dir);
    const known = new Map(
      (this.db.prepare('SELECT path, mtime, size FROM files').all() as FileRow[]).map((r) => [r.path, r]),
    );
    const stats: SessionsIndexStats = { files: files.length, refreshed: 0, docs: 0 };
    const present = new Set(files);
    const unchanged = (row: Omit<FileRow, 'path'> | undefined, st: fs.Stats): boolean =>
      row !== undefined && row.mtime === st.mtimeMs && row.size === st.size;
    for (const file of files) {
      const st = fs.statSync(file);
      if (unchanged(known.get(file), st)) continue;
      const docs = this.replaceFile(file, st, unchanged);
      if (docs === null) continue;
      stats.docs += docs;
      stats.refreshed += 1;
    }
    const forget = this.db.transaction((gone: string[]) => {
      const dropFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      for (const file of gone) {
        this.dropDocs.run(file);
        dropFile.run(file);
      }
    });
    const gone = [...known.keys()].filter((p) => !present.has(p));
    if (gone.length) forget(gone);
    return stats;
  }

  /**
   * Re-index one file, or return null when another connection already did.
   * `BEGIN IMMEDIATE` takes the write lock first (waiting out `busy_timeout`),
   * then the file row is read again under it: a deferred transaction that read
   * first and wrote second would fail with SQLITE_BUSY_SNAPSHOT the moment the
   * other connection committed, and the busy handler never retries that.
   */
  private replaceFile(
    file: string,
    st: fs.Stats,
    unchanged: (row: Omit<FileRow, 'path'> | undefined, st: fs.Stats) => boolean,
  ): number | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (unchanged(this.fileRow.get(file) as Omit<FileRow, 'path'> | undefined, st)) {
        this.db.exec('COMMIT');
        return null;
      }
      const entries = parseEntries(file);
      const docs = transcriptDocs(entries);
      this.dropDocs.run(file);
      for (const d of docs) this.addDoc.run(d.text, file, d.role, d.ts);
      this.putFile.run(file, sessionIdOf(file), transcriptTitle(entries), st.mtimeMs, st.size);
      this.db.exec('COMMIT');
      return docs.length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  search(raw: string, opts: SessionSearchOptions = {}): SessionHit[] {
    const q = ftsQuery(raw, opts.any);
    if (!q) return [];
    const where = ['docs MATCH ?'];
    const params: Array<string | number> = [q];
    const filters: Array<[string, string | undefined]> = [
      ['docs.role = ?', opts.role],
      ['docs.ts >= ?', opts.sinceIso],
      ['files.session GLOB ?', opts.session ? `${opts.session}*` : undefined],
    ];
    for (const [clause, value] of filters) {
      if (value) {
        where.push(clause);
        params.push(value);
      }
    }
    params.push(Math.max(1, Math.min(opts.limit ?? 10, 100)));
    return this.db
      .prepare(
        `SELECT files.session, files.title, docs.role, docs.ts,
                snippet(docs, 0, '[', ']', '…', 24) AS snippet, bm25(docs) AS score
         FROM docs JOIN files ON files.path = docs.file
         WHERE ${where.join(' AND ')}
         ORDER BY score LIMIT ?`,
      )
      .all(...params) as SessionHit[];
  }

  close(): void {
    this.db.close();
  }
}

/** Where a project's session index lives. */
export function sessionsDbPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), SESSIONS_DB_FILENAME);
}

/**
 * The transcript directory to index for a project: `CODEGRAPH_SESSIONS_DIR`
 * when set (tests, unusual layouts), else Claude Code's store for that
 * project. Null when there is nothing to index, or `codegraph.json` says
 * `"sessions": false`.
 */
export function sessionsSourceDir(projectRoot: string): string | null {
  if (!loadSessionsEnabled(projectRoot)) return null;
  const override = process.env.CODEGRAPH_SESSIONS_DIR;
  if (override) return fs.existsSync(override) ? override : null;
  return claudeSessionsDir(projectRoot);
}

export interface SessionsQueryResult {
  index: SessionsIndexStats;
  hits: SessionHit[];
}

/**
 * The one entry point the CLI and the MCP tool share: refresh, then search.
 * Throws when the project has no transcripts to index (or has opted out) —
 * the caller renders that as guidance, not a failure.
 */
export function querySessions(
  projectRoot: string,
  query: string,
  opts: SessionSearchOptions = {},
): SessionsQueryResult {
  const dir = sessionsSourceDir(projectRoot);
  if (!dir) throw new NoSessionsError(projectRoot);
  const index = SessionsIndex.open(sessionsDbPath(projectRoot));
  try {
    const stats = index.refresh(dir);
    return { index: stats, hits: index.search(query, opts) };
  } finally {
    index.close();
  }
}

export class NoSessionsError extends Error {
  constructor(projectRoot: string) {
    super(
      `No agent-session transcripts to index for ${projectRoot}: Claude Code has not run in this ` +
        'project (no ~/.claude/projects/<slug>/ directory), CODEGRAPH_SESSIONS_DIR points nowhere, ' +
        'or codegraph.json sets "sessions": false.',
    );
    this.name = 'NoSessionsError';
  }
}

/** The text both the CLI and the MCP tool print for a set of hits. */
export function formatSessionHits(query: string, result: SessionsQueryResult): string {
  const { hits, index } = result;
  const head = `Sessions matching "${query}" — ${hits.length} hit${hits.length === 1 ? '' : 's'} across ${index.files} transcript${index.files === 1 ? '' : 's'}`;
  if (hits.length === 0) {
    return `${head}.\nNo transcript prose matches every word. Fewer words, a stem ("merge" also finds "merged", "merging"), or any=true (OR the words) widen the search.`;
  }
  const lines = [head + ':', ''];
  for (const h of hits) {
    const title = h.title ? ` · ${h.title}` : '';
    lines.push(`## ${h.session}${title}`);
    lines.push(`${h.role} · ${h.ts}`);
    lines.push(h.snippet.replace(/\s+/g, ' ').trim());
    lines.push('');
  }
  lines.push('A hit names its session id; the transcript itself is the next step when the snippet is not enough.');
  return lines.join('\n');
}
