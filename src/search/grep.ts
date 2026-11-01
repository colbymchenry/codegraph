/**
 * Search indexed files with ripgrep, attribute each hit to its innermost
 * enclosing symbol, and rank groups by incoming graph edges. Questionable
 * calls use the shared suspects classifier; strict searches exclude them.
 * Attribution performs one indexed lookup per retained hit and keeps at most
 * twice the hit cap in memory. File enumeration and containment checks still
 * grow with the number of indexed files under the selected prefix.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseConnection, getDatabasePath } from '../db';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { candidateEdgeSql } from '../graph/suspects';

/** Default retained-hit cap; excess matches are counted, not retained. */
export const DEFAULT_MAX_HITS = 300;
/** Hit text is cut to this many UTF-16 code units after trimming. */
const MAX_HIT_TEXT = 160;
/**
 * Conservative path budget leaves room for quoting, the pattern and flags
 * under Windows' command-line limit as well as POSIX argv limits.
 */
const MAX_ARGV_BYTES = 8 * 1024;
/** A single minified line must not grow the JSON parser without a bound. */
const MAX_JSON_LINE = 8 * 1024 * 1024;
/** Diagnostics are bounded independently of match output. */
const MAX_STDERR = 64 * 1024;

/**
 * Node kinds that never own a hit. `file` spans the whole file, and a hit
 * outside every real symbol is "module level"; import/export/parameter/
 * enum_member/route are sub-statement or synthetic nodes, not enclosing symbols.
 */
const NON_ENCLOSING_KINDS = ['file', 'import', 'export', 'parameter', 'enum_member', 'route'] as const;
/** Edge kinds that count toward a group's in-degree. */
const IN_DEGREE_EDGE_KINDS = ['calls', 'references', 'imports', 'implements', 'extends'] as const;

const sqlList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

/**
 * The innermost enclosing symbol of one line: the containing span with the
 * greatest start line; ties go to the tighter span (smaller end), then id so
 * the answer is deterministic. Served by idx_nodes_file_line (file_path,
 * start_line); the two trailing ORDER BY terms sort only the few rows that
 * contain the line.
 */
const ENCLOSING_SQL = `
  SELECT id, kind, qualified_name, file_path, start_line, end_line
  FROM nodes
  WHERE file_path = ? AND start_line <= ? AND end_line >= ?
    AND kind NOT IN (${sqlList(NON_ENCLOSING_KINDS)})
  ORDER BY start_line DESC, end_line ASC, id ASC
  LIMIT 1`;
/**
 * Served by idx_edges_target_kind (target, kind). `n` counts every in-degree
 * edge; `q` counts those that are questionable calls (candidateEdgeSql),
 * so one statement gives both the full and the strict count.
 */
const IN_DEGREE_SQL =
  `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN ${candidateEdgeSql('edges')} THEN 1 ELSE 0 END), 0) AS q ` +
  `FROM edges WHERE target = ? AND kind IN (${sqlList(IN_DEGREE_EDGE_KINDS)})`;
const FILE_SIZE_SQL = 'SELECT size FROM files WHERE path = ?';
const ALL_FILES_SQL = 'SELECT path FROM files';

export interface GrepOptions {
  /** Repo-relative path prefix, segment-aware (`src/a` does not reach `src/ab/`). */
  in?: string;
  /** Match the pattern literally. */
  fixed?: boolean;
  ignoreCase?: boolean;
  /**
   * Hits kept after sorting; the rest are counted in `truncated.hits`. Default
   * 300. Must be a non-negative integer (grepIndex throws a TypeError
   * otherwise); 0 keeps no hits and counts every hit as truncated.
   */
  maxHits?: number;
  /** ripgrep binary. Default: `$CODEGRAPH_RG`, else `rg` on PATH. */
  rgPath?: string;
  /**
   * The per-rg-process argv budget, in bytes of path arguments (each path's
   * UTF-8 length plus one). Paths are packed in order into batches, one rg
   * process per batch, and a batch stays within this budget unless it is a
   * single path longer than the budget, which forms a batch of its own and so
   * exceeds it (batchPaths). Default 8 KB.
   */
  batchBytes?: number;
  /**
   * Leave questionable incoming calls (bound by name only) out of each group's
   * inDegree, and so out of the ranking. Without it they are counted in
   * inDegree and also reported as questionableInDegree.
   */
  strict?: boolean;
}

export interface GrepSymbolRef {
  /** `<path>#<name>`, with `~2`, `~3`... on later groups that would repeat an id. */
  id: string;
  /** qualified_name with `::` written as `.`. */
  name: string;
  kind: string;
  path: string;
  /** `L<start>-L<end>`. */
  span: string;
}
export interface GrepHit { line: number; text: string }
export interface GrepGroup {
  symbol: GrepSymbolRef | null;
  path: string;
  /** In-degree edges into the symbol; under `strict`, without the questionable calls. */
  inDegree: number;
  hits: GrepHit[];
  /** How many of inDegree are questionable calls. Set only when > 0, and never under `strict`. */
  questionableInDegree?: number;
}
export interface GrepResult {
  pattern: string;
  filesSearched: number;
  totalHits: number;
  groups: GrepGroup[];
  /**
   * `files`: indexed paths under the prefix that were not searched, because
   * they are not in the canonical relative form the indexer writes, missing,
   * unreadable, not a regular file, or lead outside the project
   * (searchablePaths). `hits`: hits dropped by the `maxHits` cap.
   */
  truncated: { files: number; hits: number };
  /**
   * baselineBytes sums the `files.size` byte counts of the distinct files
   * the groups live in: what reading them whole would have cost. The key is
   * absent when no group path has a size.
   */
  saved?: { files: number; baselineBytes: number };
  /** Present (true) only when the search ran with `strict`. */
  strict?: true;
}

/** The pattern is not a valid regex (JS RegExp or ripgrep refused it). */
export class GrepPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrepPatternError';
  }
}
/** A non-empty `--in` prefix with no indexed file under it. */
export class GrepScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrepScopeError';
  }
}
/**
 * The search cannot run: `not-indexed` (no `.codegraph` database at the root,
 * a caller mistake) or `rg-missing` (the ripgrep binary could not be started,
 * a malfunction). The MCP surface answers the first with guidance and the
 * second with isError, so the reason is carried rather than inferred.
 */
export class GrepIndexError extends Error {
  readonly reason: 'not-indexed' | 'rg-missing';
  constructor(message: string, reason: 'not-indexed' | 'rg-missing') {
    super(message);
    this.name = 'GrepIndexError';
    this.reason = reason;
  }
}

/** Escape a literal pattern before JavaScript RegExp validation. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Posix separators, no leading `./` (repeated), no trailing `/`. */
export function normalizeGrepPrefix(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/\/+$/, '');
}

/** The empty prefix holds everything; other prefixes end at a path segment. */
function pathUnderPrefix(path: string, prefix: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Split paths into argv batches of at most `maxBytes` path bytes each (each
 * path costs its UTF-8 length plus one for the argv separator). A path larger
 * than the budget still gets a batch of its own, so no batch is ever empty.
 */
export function batchPaths(paths: string[], maxBytes: number = MAX_ARGV_BYTES): string[][] {
  const batches: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const n = Buffer.byteLength(p) + 1;
    if (cur.length > 0 && bytes + n > maxBytes) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += n;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** One match as rg reported it, before ranking. */
export interface RawHit { path: string; line: number; text: string }

/** rg's JSON carries a path or line as `{text}` or, when not valid UTF-8, `{bytes}` (base64). */
function rgData(d: { text?: string; bytes?: string } | undefined): string {
  if (!d) return '';
  if (typeof d.text === 'string') return d.text;
  return typeof d.bytes === 'string' ? Buffer.from(d.bytes, 'base64').toString('utf8') : '';
}

/** Drop the newline, trim whitespace and cap the displayed line. */
function hitText(raw: string): string {
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return line.trim().slice(0, MAX_HIT_TEXT);
}

/**
 * Run one rg process over one batch, handing each match to `onHit` as it
 * arrives. Resolves with how many of the batch's paths rg could not read.
 *
 * The batch holds only paths searchablePaths passed, but a path can change
 * between that check and rg opening it, so rg is still held to the paths it is
 * given: `--max-depth 0` stops it descending into a path that has just become
 * a directory, and any match whose path is not in the batch is dropped. rg
 * reports an unreadable or missing path on stderr and still exits 2 after
 * searching the rest; the JSON summary's `searches` counts only the files it
 * opened, so `paths - searches` is the unreadable count. Exit 2 with no
 * summary at all is a fatal refusal (a regex rg will not compile, or some
 * other startup error).
 *
 * Output that is not rg's JSON (a malformed line, or a failure inside
 * `onHit`) kills the child and rejects the batch. The promise settles once:
 * after a failure, further output and the child's exit are ignored.
 */
function runRgBatch(
  rg: string,
  cwd: string,
  args: string[],
  paths: string[],
  onHit: (hit: RawHit) => void,
): Promise<{ unreadable: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(rg, [...args, '--', ...paths], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const batch = new Set(paths);
    let settled = false;
    let searches: number | null = null;
    let pending = '';
    let stderr = '';
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onLine = (line: string): void => {
      if (line.length === 0) return;
      if (line.length > MAX_JSON_LINE) throw new Error('ripgrep JSON record exceeds the 8 MiB safety limit. Narrow the search.');
      let msg: { type?: unknown; data?: any };
      try {
        msg = JSON.parse(line) as { type?: unknown; data?: any };
      } catch {
        throw new Error(`ripgrep printed output that is not its JSON: ${JSON.stringify(line.slice(0, 80))}`);
      }
      if (msg === null || typeof msg !== 'object') {
        throw new Error(`ripgrep printed output that is not its JSON: ${JSON.stringify(line.slice(0, 80))}`);
      }
      if (msg.type === 'match') {
        const path = rgData(msg.data.path);
        if (!batch.has(path)) return;
        onHit({ path, line: msg.data.line_number as number, text: hitText(rgData(msg.data.lines)) });
      } else if (msg.type === 'summary') {
        searches = msg.data.stats.searches as number;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      pending += chunk;
      let nl: number;
      try {
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          onLine(line);
        }
        if (pending.length > MAX_JSON_LINE) throw new Error('ripgrep JSON record exceeds the 8 MiB safety limit. Narrow the search.');
      } catch (e) {
        fail(e);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (!settled) stderr = (stderr + chunk).slice(0, MAX_STDERR); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        fail(new GrepIndexError(`ripgrep not found ("${rg}") — install rg or set CODEGRAPH_RG to its path`, 'rg-missing'));
      } else {
        fail(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      try {
        onLine(pending);
      } catch (e) {
        fail(e);
        return;
      }
      if (code === 0 || code === 1 || (code === 2 && searches !== null)) {
        settled = true;
        resolve({ unreadable: Math.max(0, paths.length - (searches ?? paths.length)) });
        return;
      }
      const message = stderr.replace(/^rg: /, '').trim() || `rg exited with code ${String(code)}`;
      if (code === 2 && /regex|pattern/i.test(message)) fail(new GrepPatternError(message));
      else fail(new Error(`ripgrep failed: ${message}`));
    });
  });
}

/** Resolve the default executable without searching the indexed project's cwd. */
function defaultRipgrep(projectRoot: string): string {
  const realRoot = fs.realpathSync(projectRoot);
  const names = process.platform === 'win32' ? ['rg.exe', 'rg.com'] : ['rg'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    try {
      if (fs.realpathSync(dir) === realRoot) continue;
    } catch { continue; }
    for (const name of names) {
      const executable = path.join(dir, name);
      try {
        if (!fs.statSync(executable).isFile()) continue;
        fs.accessSync(executable, fs.constants.X_OK);
        return executable;
      } catch { /* A missing candidate does not exclude other executable suffixes. */ }
    }
  }
  throw new GrepIndexError('ripgrep not found — install rg or set CODEGRAPH_RG to its path', 'rg-missing');
}

/**
 * Search indexed files under `opts.in` for `pattern` and group the hits by
 * innermost enclosing symbol. The
 * database is opened read-only and closed on every path.
 */
export async function grepIndex(projectRoot: string, pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  const maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
  assertMaxHits(maxHits);
  const dbPath = getDatabasePath(projectRoot);
  if (!fs.existsSync(dbPath)) {
    throw new GrepIndexError(`no codegraph index at ${projectRoot} — run codegraph init there first`, 'not-indexed');
  }

  try {
    new RegExp(opts.fixed ? escapeRegExp(pattern) : pattern, opts.ignoreCase ? 'i' : '');
  } catch (e) {
    throw new GrepPatternError(`invalid pattern ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const conn = DatabaseConnection.open(dbPath, { readOnly: true });
  try {
    const db = conn.getDb();
    const prefix = opts.in ? normalizeGrepPrefix(opts.in) : '';
    const scoped: string[] = [];
    for (const row of db.prepare(ALL_FILES_SQL).iterate() as IterableIterator<{ path: string }>) {
      if (pathUnderPrefix(row.path, prefix)) scoped.push(row.path);
    }
    if (prefix !== '' && scoped.length === 0) {
      throw new GrepScopeError(`nothing indexed under "${prefix}/" (or any path prefix)`);
    }
    const files = scoped;

    const ranks = rankPaths(files);
    const capped = new CappedHits(ranks, maxHits);
    const rg = opts.rgPath ?? process.env.CODEGRAPH_RG ?? defaultRipgrep(projectRoot);
    const args = ['--json', '-a', '--no-config', '--max-depth', '0'];
    if (opts.ignoreCase) args.push('-i');
    if (opts.fixed) args.push('-F');
    args.push('-e', pattern);
    const searchable = searchablePaths(projectRoot, files);
    const batches = searchable.paths.length > 0 ? batchPaths(searchable.paths, opts.batchBytes) : [];
    // One active child bounds CPU/file descriptors and leaves none running
    // after a failed batch. Exact dropped-hit counts still require every batch.
    let unreadable = searchable.skipped;
    for (const batch of batches) {
      const result = await runRgBatch(rg, projectRoot, args, batch, (hit) => capped.add(hit));
      unreadable += result.unreadable;
    }

    const kept = capped.kept();
    const strict = opts.strict === true;
    const groups = groupHits(db, kept, strict);
    // Stable (under strict, inDegree is already the strict count): equal in-degree and equal path rank keep creation (sorted-hit) order.
    groups.sort((a, b) => b.inDegree - a.inDegree || (ranks.get(a.path) ?? 0) - (ranks.get(b.path) ?? 0));
    assignIds(groups);

    const result: GrepResult = {
      pattern,
      filesSearched: files.length,
      totalHits: kept.length,
      groups,
      truncated: { files: unreadable, hits: capped.total - kept.length },
    };
    const saved = savedFor(db, groups);
    if (saved) result.saved = saved;
    if (strict) result.strict = true;
    return result;
  } finally {
    conn.close();
  }
}

/** maxHits must be a non-negative integer: a fraction, NaN or a negative has no meaning as a hit count. */
function assertMaxHits(maxHits: number): void {
  if (!Number.isInteger(maxHits) || maxHits < 0) {
    throw new TypeError(`maxHits must be a non-negative integer, got ${String(maxHits)}`);
  }
}

/**
 * Whether an indexed path is in the form the indexer writes (relative,
 * `/`-separated, normalizePath): not empty, no NUL byte, not absolute in
 * posix or win32 form, and no segment that is empty, `.` or `..`. On win32 a
 * drive-relative `C:x` is refused too, and `\` separates segments as well.
 *
 * Why: searchablePaths checks `path.resolve(root, rel)`, which collapses `..`
 * lexically, but rg opens `rel` as given and the OS resolves it a segment at a
 * time. For `link/../secret.txt`, with `link` a symlink to a folder outside,
 * the check sees `<root>/secret.txt` while rg reads the `secret.txt` beside
 * the folder `link` points to. For a canonical path the check and the open
 * name the same file, and the indexer writes nothing else, so refusing every
 * other form loses no indexed file.
 */
export function isCanonicalIndexedPath(rel: string): boolean {
  if (rel === '' || rel.includes('\0')) return false;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  const win32 = process.platform === 'win32';
  if (win32 && path.win32.parse(rel).root !== '') return false;
  return rel.split(win32 ? /[\\/]/ : '/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * The indexed paths rg may open, and how many it may not. rg follows a path
 * argument that is a symlink wherever it points (`--max-depth 0` does not stop
 * that), and the index can hold a symlink, or a file under a symlinked folder,
 * that leads out of the project (the indexer follows them, #935). The hit text
 * grep returns is file content, so like the content-serving reads behind
 * validatePathWithinRoot (#527), a path is searched only if its real location
 * is inside realpath(projectRoot): equal to it or under it, segment-aware.
 *
 * - A path not in canonical form (isCanonicalIndexedPath) is refused before
 *   any filesystem call and counts as one unreadable file. The checks below
 *   run on `path.resolve(root, rel)` while rg opens `rel` itself, and only for
 *   a canonical `rel` are those the same file.
 * - A regular file costs one lstat, plus one realpath of its folder, cached per
 *   distinct folder (so a symlinked folder on the way is caught too); a file
 *   directly in the root needs no realpath.
 * - A symlink is realpathed itself and searched only if it ends at a regular
 *   file inside the project.
 * - Everything else is not handed to rg and counts as one unreadable file:
 *   a missing path, a dangling symlink, a symlink or symlinked folder leading
 *   out of the project, a directory, or a special file (a FIFO would block rg).
 *
 * The check runs before rg opens the file, so a path swapped for a symlink in
 * between is not caught; the index's own paths are what this guards.
 */
function searchablePaths(projectRoot: string, files: string[]): { paths: string[]; skipped: number } {
  const root = path.resolve(projectRoot);
  let rootReal: string | null | undefined;
  const realRoot = (): string | null => {
    if (rootReal === undefined) rootReal = realOrNull(root);
    return rootReal;
  };
  const inside = (real: string): boolean => {
    const r = realRoot();
    if (r === null) return false;
    const a = process.platform === 'win32' ? real.toLowerCase() : real;
    const b = process.platform === 'win32' ? r.toLowerCase() : r;
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  };
  const folderInside = new Map<string, boolean>();
  const paths: string[] = [];
  let skipped = 0;
  for (const rel of files) {
    if (!isCanonicalIndexedPath(rel)) {
      skipped++;
      continue;
    }
    const abs = path.resolve(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      skipped++;
      continue;
    }
    let ok = false;
    if (st.isFile()) {
      const dir = path.dirname(abs);
      if (dir === root) {
        ok = true;
      } else {
        let known = folderInside.get(dir);
        if (known === undefined) {
          const real = realOrNull(dir);
          known = real !== null && inside(real);
          folderInside.set(dir, known);
        }
        ok = known;
      }
    } else if (st.isSymbolicLink()) {
      const real = realOrNull(abs);
      ok = real !== null && inside(real) && isRegularFile(real);
    }
    if (ok) paths.push(rel);
    else skipped++;
  }
  return { paths, skipped };
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Rank searched paths in String.prototype.localeCompare order. Sort once
 * with a default-locale Intl.Collator (the comparison localeCompare performs
 * with no arguments, without re-resolving the locale per call). Paths the
 * collator calls equal (`ab.ts` and `a\u200Db.ts`, with a zero-width joiner)
 * SHARE a rank, so between them the line number decides, as a
 * localeCompare-then-line sort would. The rank is also the group order's path
 * tie-break.
 */
function rankPaths(paths: string[]): Map<string, number> {
  const collator = new Intl.Collator();
  const sorted = [...paths].sort(collator.compare);
  const ranks = new Map<string, number>();
  let rank = 0;
  sorted.forEach((p, i) => {
    if (i > 0 && collator.compare(sorted[i - 1] as string, p) !== 0) rank++;
    ranks.set(p, rank);
  });
  return ranks;
}

/** Code-unit order, the deterministic tie-break between paths that share a rank. */
const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The first `maxHits` hits by (path rank, line), then path code-unit order,
 * then arrival, kept in bounded memory. Every hit is counted in `total`; at
 * most 2 * maxHits are ever held (`peak` reports the most held at once): when
 * an add brings the buffer to 2 * maxHits, it is sorted and cut back to
 * maxHits, which cannot drop a hit that belongs in the final set. With
 * maxHits 0 nothing is held. Throws a TypeError unless maxHits is a
 * non-negative integer.
 */
export class CappedHits {
  total = 0;
  private buf: Array<RawHit & { seq: number }> = [];
  private peakSize = 0;

  constructor(private readonly ranks: Map<string, number>, private readonly maxHits: number) {
    assertMaxHits(maxHits);
  }

  add(hit: RawHit): void {
    const seq = this.total++;
    if (this.maxHits === 0) return;
    this.buf.push({ ...hit, seq });
    if (this.buf.length > this.peakSize) this.peakSize = this.buf.length;
    if (this.buf.length >= 2 * this.maxHits) this.trim();
  }

  /** The most hits the buffer has held at once. */
  get peak(): number {
    return this.peakSize;
  }

  /** The kept hits, in (path rank, line) order. */
  kept(): RawHit[] {
    this.trim();
    return this.buf.map(({ path, line, text }) => ({ path, line, text }));
  }

  private trim(): void {
    const rank = (p: string): number => this.ranks.get(p) ?? 0;
    this.buf.sort((a, b) => rank(a.path) - rank(b.path) || a.line - b.line || codeUnit(a.path, b.path) || a.seq - b.seq);
    if (this.buf.length > this.maxHits) this.buf.length = this.maxHits;
  }
}

interface NodeRow { id: string; kind: string; qualified_name: string; file_path: string; start_line: number; end_line: number }

/**
 * Group kept hits by enclosing node (or `file:<path>`), groups created in hit
 * order. Under `strict` a group's inDegree leaves out questionable calls;
 * otherwise it counts them and, when there are any, says how many in
 * questionableInDegree (set after `hits`, so the existing JSON key order holds).
 */
function groupHits(db: SqliteDatabase, kept: RawHit[], strict: boolean): GrepGroup[] {
  const enclosing = db.prepare(ENCLOSING_SQL);
  const inDegree = db.prepare(IN_DEGREE_SQL);
  const groups = new Map<string, GrepGroup>();
  for (const h of kept) {
    const node = enclosing.get(h.path, h.line, h.line) as NodeRow | undefined;
    const key = node ? node.id : `file:${h.path}`;
    let group = groups.get(key);
    if (!group) {
      const name = node ? node.qualified_name.split('::').join('.') : '';
      const counts = node ? (inDegree.get(node.id) as { n: number | bigint; q: number | bigint }) : undefined;
      const all = counts ? Number(counts.n) : 0;
      const questionable = counts ? Number(counts.q) : 0;
      group = {
        symbol: node
          ? { id: `${node.file_path}#${name}`, name, kind: node.kind, path: node.file_path, span: `L${node.start_line}-L${node.end_line}` }
          : null,
        path: h.path,
        inDegree: strict ? all - questionable : all,
        hits: [],
      };
      if (!strict && questionable > 0) group.questionableInDegree = questionable;
      groups.set(key, group);
    }
    group.hits.push({ line: h.line, text: h.text });
  }
  return [...groups.values()];
}

/**
 * Two distinct nodes can share `<path>#<name>` (overloads, a Swift extension
 * beside its type). Within one result, the second and later groups in output
 * order get `~2`, `~3`, ... The suffix depends on this result's groups, so it
 * is not a stable id across searches.
 */
function assignIds(groups: GrepGroup[]): void {
  const seen = new Map<string, number>();
  for (const g of groups) {
    if (!g.symbol) continue;
    const base = g.symbol.id;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) g.symbol.id = `${base}~${n}`;
  }
}

function savedFor(db: SqliteDatabase, groups: GrepGroup[]): GrepResult['saved'] | undefined {
  const size = db.prepare(FILE_SIZE_SQL);
  let files = 0;
  let baselineBytes = 0;
  for (const p of new Set(groups.map((g) => g.path))) {
    const row = size.get(p) as { size: number | bigint } | undefined;
    if (!row) continue;
    files++;
    baselineBytes += Number(row.size);
  }
  return files > 0 ? { files, baselineBytes } : undefined;
}
