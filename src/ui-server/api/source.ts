/**
 * `GET /api/source?file=&from=&to=` — verbatim source, or an honest refusal.
 *
 * This is the one endpoint that reads the user's repository, so two rules
 * govern it and neither is negotiable.
 *
 * **Every read goes through `resolveProjectFile`.** That is the chokepoint from
 * `security.ts` — traversal, in-tree symlinks pointing out of the root,
 * absolute paths, sensitive system directories. Without it,
 * `?file=../../.ssh/id_rsa` is a credential leak over a port the user opened to
 * read their own code.
 *
 * **A file that changed on disk since it was indexed is never sliced under the
 * index's numbering.** The viewer asks for line ranges the *index* recorded; if
 * the file moved on since, those ranges can point at a different symbol's body,
 * which would be served under the requested name and look perfectly plausible.
 * So the bytes are hashed and compared against `files.content_hash`, and on a
 * mismatch the slice is omitted with `drift: true` — the same call
 * `codegraph_node` makes when it says "changed on disk after the last index
 * sync".
 *
 * A caller that has ALREADY decided the index's numbering is off — a viewer
 * about to draw a drift banner — asks with `ondrift=current` and gets the
 * file's CURRENT lines instead of nothing. That is the other half of
 * `codegraph_node`'s behaviour (issue #1474): a drifted file is served whole
 * and current rather than omitted, because current bytes are correct by
 * construction. `showing` says which of the two came back, on every response,
 * so nothing has to infer it from the presence of `lines`.
 *
 * Only files that are IN the index are served. That is a tighter boundary than
 * the MCP tools take, and it costs the viewer nothing (it only ever renders
 * indexed symbols) while making the drift verdict meaningful for every answer:
 * there is always a hash to compare against.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { FileRecord } from '../../types';
import type { CodeGraph } from '../../index';
import { resolveProjectFile } from '../security';
import { highlightLines, type HighlightResult } from '../highlight';
import { ApiError, badRequest, intParam, notFound, textParam } from './respond';

/**
 * Largest file we will read to answer a source request.
 *
 * The whole file has to be read to hash it, so this bounds the work one request
 * can cause. Well above the 1 MB ceiling extraction itself applies, so anything
 * actually in the index is comfortably inside it.
 */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** Lines returned in one response. The Symbol view asks for windows, not files. */
export const MAX_SOURCE_LINES = 4000;

/**
 * Look up a file record by a viewer-supplied path, WITHOUT validating it.
 *
 * Indexed paths are normalized to forward slashes at extraction time, so that
 * is the form tried first; the platform-separator form is a fallback for an
 * index written before that normalization.
 *
 * Callers that go on to READ the file must use {@link resolveRequestedFile}
 * instead — it puts the path through the security chokepoint first. This one is
 * for endpoints that only need the record (a drift flag on a path the index
 * itself handed us).
 */
export function findIndexedFile(
  cg: CodeGraph,
  requested: string
): { record: FileRecord; storedPath: string } | null {
  const posix = toRequestPath(requested);
  const record = cg.getFile(posix);
  if (record) return { record, storedPath: posix };

  const native = posix.split('/').join(path.sep);
  if (native !== posix) {
    const legacy = cg.getFile(native);
    if (legacy) return { record: legacy, storedPath: native };
  }
  return null;
}

/**
 * Forward slashes and no leading `./` — the form indexed paths are stored in.
 *
 * A LEADING SLASH IS LEFT ALONE on purpose. Stripping it would quietly turn
 * `/etc/passwd` into the project-relative `etc/passwd` and answer "not in this
 * index" — reinterpreting the request instead of refusing it, and leaving the
 * chokepoint's absolute-path rule with nothing to catch.
 */
export function toRequestPath(requested: string): string {
  return requested.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Validate a viewer-supplied path, THEN look it up in the index.
 *
 * The order is the point. `resolveProjectFile` runs first, so a traversal, an
 * absolute path or a sensitive system directory is refused as what it is,
 * before the index is consulted — a 403 that says "outside the project", not a
 * 404 that says "not indexed" and quietly depends on the index lookup missing.
 * It also means the absolute path every reader uses has already been through
 * the chokepoint by construction, rather than by remembering to call it.
 *
 * @throws {PathRefusalError} the path is not one we would ever read.
 * @throws {ApiError} `not-found` when it is fine but not in the index.
 */
export function resolveRequestedFile(
  cg: CodeGraph,
  projectRoot: string,
  requested: string
): { record: FileRecord; storedPath: string; absolute: string } {
  const posix = toRequestPath(requested);
  // Refusals happen here, ahead of everything.
  const absolute = resolveProjectFile(projectRoot, posix);

  const found = findIndexedFile(cg, posix);
  if (!found) throw notIndexedError(posix);
  return { ...found, absolute };
}

export function notIndexedError(file: string): ApiError {
  return notFound(
    `${file} is not in this CodeGraph index.`,
    'The viewer only reads files the index knows about. If the file is new, ' +
      'it appears after the next sync; if it is excluded (gitignored, generated, ' +
      'or too large to parse), it will not appear at all.'
  );
}

/**
 * Split source the way the index counted it.
 *
 * Rows are `\n`-delimited — that is how tree-sitter numbers them — so a CRLF
 * file has the same line numbers here as in the graph. The trailing `\r` is
 * dropped per line so it does not render as a stray glyph.
 */
export function splitLines(content: string): string[] {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  // A file ending in a newline splits to a final empty string that is not a
  // line of source. Every other trailing empty line IS one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The whole text of an INDEXED file, or `null` for anything unreadable.
 *
 * The dead code report's corroboration pass needs to count an identifier in a
 * file's text, and this module is the only one in `api/` that opens a file — so
 * the reader it uses lives here, behind the same chokepoint. Three refusals,
 * all answering `null` rather than throwing, because the caller's rule is
 * already "cannot read it → do not make the claim":
 *
 * - not in the index (the viewer never reads a file the graph does not know);
 * - outside the project (`resolveProjectFile` throws; caught here);
 * - bigger than `maxBytes`.
 *
 * Drift is deliberately NOT checked. The question being asked is "does anything
 * in this file write this name", and the file's current bytes are the better
 * answer to it than the bytes we indexed.
 */
export function readIndexedFileText(
  cg: CodeGraph,
  projectRoot: string,
  requested: string,
  maxBytes: number
): string | null {
  try {
    const found = findIndexedFile(cg, requested);
    if (!found) return null;
    const absolute = resolveProjectFile(projectRoot, found.storedPath);
    const stats = fs.statSync(absolute);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether an indexed file has changed on disk since it was indexed — the same
 * verdict `/api/source` returns, for endpoints that must *flag* drift without
 * serving source (a symbol header, a file outline).
 *
 * Cheap first: size plus floored mtime is the identical freshness test the sync
 * fast path uses, so an untouched file costs one `stat`. Only a stat mismatch
 * pays for a hash, which is what keeps a `touch` or a checkout that rewrote
 * identical bytes from reading as drift.
 *
 * Any failure answers `false`. A wrong "stale" flag would put a warning banner
 * over correct source; the cases that would trip it (missing record, unreadable
 * file) have their own handling in the endpoints that actually read.
 */
export function hasDriftedOnDisk(
  projectRoot: string,
  storedPath: string,
  record: FileRecord
): boolean {
  try {
    const absolute = resolveProjectFile(projectRoot, storedPath);
    const stats = fs.statSync(absolute);
    if (stats.size === record.size && Math.floor(stats.mtimeMs) === Math.floor(record.modifiedAt)) {
      return false;
    }
    if (stats.size > MAX_SOURCE_BYTES) return true;
    const content = fs.readFileSync(absolute, 'utf-8');
    return createHash('sha256').update(content).digest('hex') !== record.contentHash;
  } catch {
    return false;
  }
}

/**
 * The drift verdict AND the file's length, from one read.
 *
 * The whole-file view needs both before it draws anything: the drift banner,
 * and the line count that fixes the height of the scrolling document (every
 * line is a fixed 20px, so the total IS the layout). Asking
 * {@link hasDriftedOnDisk} and then a source page would answer the first
 * question against one read of the file and the second against another, which
 * is exactly the window in which a file can change underneath the two.
 *
 * Unlike `hasDriftedOnDisk` there is no stat-only fast path: the bytes have to
 * be read to be counted. That is the cost of knowing the length, and it is
 * bounded by {@link MAX_SOURCE_BYTES} like every other read here.
 */
export function readFileShape(
  projectRoot: string,
  storedPath: string,
  record: FileRecord
): { drift: boolean; totalLines: number | null; reason?: string } {
  let absolute: string;
  try {
    absolute = resolveProjectFile(projectRoot, storedPath);
  } catch {
    // A refusal on a path the INDEX handed us is not a request to refuse — the
    // caller already passed the chokepoint. Treat it as unreadable.
    return { drift: false, totalLines: null };
  }
  try {
    const stats = fs.statSync(absolute);
    if (stats.size > MAX_SOURCE_BYTES) {
      return { drift: false, totalLines: null, reason: 'The file is too large to read here.' };
    }
    const content = fs.readFileSync(absolute, 'utf-8');
    const drift = createHash('sha256').update(content).digest('hex') !== record.contentHash;
    return {
      drift,
      totalLines: splitLines(content).length,
      ...(drift
        ? {
            reason:
              'This file changed on disk after the last index sync, so the line ' +
              'numbers the graph holds no longer match it.',
          }
        : {}),
    };
  } catch {
    return {
      drift: true,
      totalLines: null,
      reason: 'The file is in the index but could not be read from disk.',
    };
  }
}

export interface SourceResult {
  file: string;
  language: string;
  /** The file on disk differs from what was indexed. */
  drift: boolean;
  /**
   * Which numbering the returned lines belong to.
   *
   * `'indexed'` — the file matches the index, so the two are the same thing.
   * `'current'` — the file drifted and the caller asked for it anyway
   * (`ondrift=current`): these are the bytes on disk right now, and NOTHING the
   * graph holds about this file (symbol ranges, call-site lines, ports) lines
   * up with them.
   * `'none'` — the file drifted and no slice is served.
   */
  showing: 'indexed' | 'current' | 'none';
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  totalLines: number | null;
  from?: number;
  to?: number;
  lines?: string[];
  truncated?: boolean;
  reason?: string;
  /**
   * The same lines, classified for the code block — one entry per line, each a
   * list of `[classId, text]` pairs indexed into `highlight.classes`.
   *
   * It rides with the slice rather than living behind its own endpoint because
   * the two are only ever wanted together, and because a second round-trip
   * would let the viewer paint unhighlighted source and then reflow it. Absent
   * whenever `lines` is — a drifted file is not served at all.
   */
  highlight?: HighlightResult;
}

/**
 * What to do when the file on disk no longer matches the index.
 *
 * `omit` (the default) is the safe answer for a caller that has not decided
 * anything yet. `current` is for one that has: it is about to say, in the
 * pixels, that these are the file's CURRENT lines and that nothing the graph
 * holds about them applies.
 */
export type OnDrift = 'omit' | 'current';

/** Said once, so the two places that answer with current bytes cannot diverge. */
const DRIFT_CURRENT_REASON =
  'This file changed on disk after the last index sync. These are its current ' +
  'lines; the indexed line ranges — symbol bodies, call sites, ports — no longer ' +
  'match them. The next sync picks it up.';

export function parseOnDrift(query: URLSearchParams): OnDrift {
  const raw = query.get('ondrift');
  if (raw === null || raw === '' || raw === 'omit') return 'omit';
  if (raw === 'current') return 'current';
  throw badRequest(
    `Parameter "ondrift" must be "omit" or "current" (got "${raw}").`,
    'Omit it to leave a drifted file unsliced; "current" serves the bytes on disk instead.'
  );
}

export async function buildSource(
  cg: CodeGraph,
  projectRoot: string,
  query: URLSearchParams
): Promise<SourceResult> {
  const requested = textParam(query, 'file');
  // Refusal first, index lookup second — see `resolveRequestedFile`.
  const { record, storedPath, absolute } = resolveRequestedFile(cg, projectRoot, requested);

  const from = intParam(query, 'from', { min: 1, max: 5_000_000, default: 1 });
  const to = intParam(query, 'to', { min: 1, max: 5_000_000, default: 0 });
  if (to !== 0 && to < from) {
    throw badRequest(`Parameter "to" (${to}) must not be before "from" (${from}).`);
  }
  const onDrift = parseOnDrift(query);

  const base: SourceResult = {
    file: storedPath.replace(/\\/g, '/'),
    language: record.language,
    drift: false,
    showing: 'indexed',
    contentHash: record.contentHash,
    indexedAt: record.indexedAt,
    generated: record.generated === true,
    totalLines: null,
  };

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    // Indexed but gone. That IS drift, and the strongest kind: nothing on disk
    // corresponds to the ranges the graph holds — and `ondrift=current` has
    // nothing to fall back to either.
    return {
      ...base,
      drift: true,
      showing: 'none',
      reason: 'The file is in the index but no longer on disk.',
    };
  }
  if (stats.size > MAX_SOURCE_BYTES) {
    throw badRequest(
      `${base.file} is ${Math.round(stats.size / 1024 / 1024)} MB — too large to serve as source.`
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(absolute, 'utf-8');
  } catch (err) {
    throw new ApiError(
      'internal',
      `Could not read ${base.file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Byte-identical to extraction's `hashContent` (sha256 over the utf-8
  // string). A touch or a checkout that rewrote the same bytes must not count
  // as drift, which is exactly what hashing content rather than mtime buys.
  const hash = createHash('sha256').update(content).digest('hex');
  const drift = hash !== record.contentHash;
  if (drift && onDrift === 'omit') {
    return {
      ...base,
      drift: true,
      showing: 'none',
      reason:
        'This file changed on disk after the last index sync, so the indexed line ' +
        'ranges no longer reliably match. Source is omitted rather than risk showing ' +
        "a different symbol's code; it returns after the next sync.",
    };
  }

  const all = splitLines(content);
  // Past the end of the file `from` names nothing, which is a caller bug worth
  // surfacing rather than answering with the last line as if that were meant.
  // `to` past the end is different — "line 30 to the end, whatever that is" is
  // an ordinary way to ask, so it clamps.
  //
  // The exception is a drifted file the caller asked for anyway: it has already
  // been told the numbering does not hold, and a save that SHORTENED the file
  // between the length it was given and this read is an ordinary race, not a
  // bug. Those get an empty slice.
  if (from > all.length) {
    if (!drift) {
      throw badRequest(
        `Parameter "from" (${from}) is past the end of ${base.file}, which has ${all.length} lines.`
      );
    }
    return {
      ...base,
      drift: true,
      showing: 'current',
      totalLines: all.length,
      from,
      to: from - 1,
      lines: [],
      truncated: false,
      reason: DRIFT_CURRENT_REASON,
    };
  }
  const start = from;
  const requestedEnd = to === 0 ? all.length : Math.min(to, all.length);
  const end = Math.min(requestedEnd, start + MAX_SOURCE_LINES - 1);
  const slice = all.slice(start - 1, end);

  return {
    ...base,
    drift,
    // The bytes are always the ones on disk. What changes with drift is what
    // they can be *used* for: under `current` the caller must not map anything
    // the index holds onto these numbers.
    showing: drift ? 'current' : 'indexed',
    ...(drift ? { reason: DRIFT_CURRENT_REASON } : {}),
    totalLines: all.length,
    from: start,
    to: end,
    lines: slice,
    truncated: end < requestedEnd,
    // Keyed on the hash of the bytes ACTUALLY BEING SERVED, so the cache is
    // invalidated by the file changing rather than by a clock, and two viewers
    // looking at the same symbol share one tokenisation. It must be the disk
    // hash rather than the record's: on a drifted file those differ, and keying
    // current lines under the indexed hash would serve the previous edit's
    // colours over this one's text.
    highlight: await highlightLines(slice, {
      language: record.language,
      cacheKey: `${hash}:${start}:${end}`,
    }),
  };
}
