/**
 * Where saved trails live on disk — the only thing `codegraph ui` ever writes.
 *
 * Every other module under `api/` is a reader. This one holds the single write
 * path in the whole viewer, and it is scoped as narrowly as a write can be: one
 * directory, `<CODEGRAPH_DIR>/ui/trails/`, inside the project the server was
 * started on, one JSON file per trail. It never touches source, never touches
 * the index, and never writes anywhere a `codegraph init` would not already
 * have created. `.codegraph/.gitignore` ignores everything but itself, so a
 * saved trail is local by default; exporting one to commit is a copy the reader
 * makes deliberately.
 *
 * Two rules hold it inside the boundary described in `../security.ts`:
 *
 * - **The directory is resolved through `resolveProjectFile`**, exactly like a
 *   source read, so a trail id that tried to be a path is refused by the same
 *   chokepoint that refuses `?file=../../.ssh/id_rsa`. It is belt and braces on
 *   top of {@link isTrailId}, which already refuses anything but a slug.
 * - **A write is atomic.** Temp file in the same directory, then rename. A
 *   half-written trail read back by the list would look like a corrupt one, and
 *   the list would then have to decide whether to hide it — which is a decision
 *   nobody should have to make about a file they saved a second ago.
 *
 * The format is deliberately plain: a reader can open one in an editor, and a
 * hop is described by what it IS (a qualified name in a file) rather than by the
 * node id it happened to have. Node ids contain a start line, so any edit above
 * a symbol renames it — a trail keyed on ids would not survive its own project.
 */

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { CODEGRAPH_DIR } from '../../directory';
import { resolveProjectFile } from '../security';
import { ApiError, badRequest } from './respond';

/** Where trails live, relative to the project root. Forward slashes always. */
export const TRAILS_RELATIVE_DIR = `${CODEGRAPH_DIR}/ui/trails`;

/** The only `version` this build writes, and the only one it reads. */
export const TRAIL_FORMAT_VERSION = 1;

/** Trail files read from the directory before the list stops looking. */
export const MAX_TRAILS = 200;

/** Hops one trail may carry. Past this it is a history, not a tour. */
export const MAX_TRAIL_HOPS = 64;

/** Characters in a trail's name. */
export const MAX_TRAIL_NAME = 120;

/** Characters in a trail's note. */
export const MAX_TRAIL_NOTE = 600;

/** Bytes a single trail file may be before it is skipped as not-ours. */
export const MAX_TRAIL_FILE_BYTES = 64 * 1024;

/** Characters in a generated slug, before any de-duplicating suffix. */
const MAX_SLUG = 60;

/** How a reader got from the previous hop to this one. Mirrors the viewer's `HopDirection`. */
export type StoredHopDirection = 'start' | 'down' | 'up';

/**
 * One hop, described by what it is rather than by the id it had.
 *
 * `id` is kept as a HINT — when the file has not changed it resolves in one
 * lookup — but `qualifiedName` + `kind` + `file` is what the trail is actually
 * keyed on, and what lets it survive a re-index.
 */
export interface StoredHop {
  dir: StoredHopDirection;
  name: string;
  qualifiedName: string;
  kind: string;
  /** Project-relative, forward slashes. */
  file: string;
  line: number;
  /** The node id at save time. A fast path, never the identity. */
  id: string;
}

export interface StoredTrail {
  version: number;
  /** Slug, and the file's basename. */
  id: string;
  name: string;
  note: string;
  /** Whoever saved it — git's `user.name`, or the OS user. */
  author: string;
  createdAt: string;
  updatedAt: string;
  hops: StoredHop[];
}

/* ------------------------------------------------------------------ paths -- */

/**
 * Whether a string is a trail id we would have written.
 *
 * Lowercase slug characters only: no dot, no separator, no leading dash. This
 * is what makes `<id>.json` a filename rather than a path expression, and it
 * runs before the id is ever joined to anything.
 */
export function isTrailId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

/**
 * `Read a file with these lines` -> `read-a-file-with-these-lines`.
 *
 * Names that carry no ASCII letters or digits at all (a trail named entirely in
 * Chinese, or in emoji) slug to nothing; they get `trail`, and the collision
 * handling in {@link saveTrail} keeps them distinct from each other.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug === '' ? 'trail' : slug;
}

/** The absolute trails directory, having been through the read chokepoint. */
export function trailsDirectory(projectRoot: string): string {
  return resolveProjectFile(projectRoot, TRAILS_RELATIVE_DIR);
}

/**
 * The absolute path of one trail file.
 *
 * @throws {ApiError} `bad-request` when the id is not a slug we would have
 *   written — checked before the join, so nothing path-shaped is ever built.
 */
export function trailPath(projectRoot: string, id: string): string {
  if (!isTrailId(id)) {
    throw badRequest(
      `"${id}" is not a saved trail id.`,
      'Trail ids are the lowercase slug in the file name, e.g. "how-a-request-is-served".'
    );
  }
  return resolveProjectFile(projectRoot, `${TRAILS_RELATIVE_DIR}/${id}.json`);
}

/* ------------------------------------------------------------------- read -- */

/**
 * Parse a file into a trail, or `null` if it is not one.
 *
 * Everything is re-validated rather than trusted: the directory is a place a
 * user may hand-edit a file, or drop one somebody else exported, and a trail
 * that half-parsed would draw a row with holes in it. A file that fails is
 * skipped and counted, never repaired in place.
 */
export function parseTrail(id: string, text: string): StoredTrail | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  // Unversioned hand-written trails predate the stored format marker and are
  // treated as v1. A declared future/unknown version must not be guessed at.
  if (value.version !== undefined && value.version !== TRAIL_FORMAT_VERSION) return null;
  if (typeof value.name !== 'string' || value.name.trim() === '') return null;
  if (!Array.isArray(value.hops) || value.hops.length === 0) return null;

  const hops: StoredHop[] = [];
  for (const entry of value.hops.slice(0, MAX_TRAIL_HOPS)) {
    if (typeof entry !== 'object' || entry === null) return null;
    const hop = entry as Record<string, unknown>;
    const qualifiedName = typeof hop.qualifiedName === 'string' ? hop.qualifiedName : '';
    const name = typeof hop.name === 'string' ? hop.name : '';
    if (qualifiedName === '' && name === '') return null;
    hops.push({
      dir: hop.dir === 'up' || hop.dir === 'down' ? hop.dir : 'start',
      name: name || qualifiedName,
      qualifiedName: qualifiedName || name,
      kind: typeof hop.kind === 'string' ? hop.kind : '',
      file: typeof hop.file === 'string' ? hop.file : '',
      line: typeof hop.line === 'number' && hop.line > 0 ? Math.floor(hop.line) : 0,
      id: typeof hop.id === 'string' ? hop.id : '',
    });
  }

  const created = typeof value.createdAt === 'string' ? value.createdAt : '';
  return {
    version: typeof value.version === 'number' ? value.version : TRAIL_FORMAT_VERSION,
    // The FILE's name wins over any `id` inside it: the basename is what the
    // delete route addresses, so a hand-copied file is addressable under the
    // name it actually has rather than the one it remembers having.
    id,
    name: value.name.slice(0, MAX_TRAIL_NAME),
    note: typeof value.note === 'string' ? value.note.slice(0, MAX_TRAIL_NOTE) : '',
    author: typeof value.author === 'string' ? value.author.slice(0, 120) : '',
    createdAt: created,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : created,
    hops,
  };
}

export interface StoredTrailList {
  trails: StoredTrail[];
  /** Files in the directory that were not readable trails. */
  skipped: number;
}

/**
 * Every trail in the project, newest save first.
 *
 * A missing directory is the ordinary state of a project nobody has saved a
 * trail in — an empty list, never an error.
 */
export function listStoredTrails(projectRoot: string): StoredTrailList {
  const dir = trailsDirectory(projectRoot);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { trails: [], skipped: 0 };
  }

  const trails: StoredTrail[] = [];
  let skipped = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    if (trails.length >= MAX_TRAILS) break;
    const id = name.slice(0, -'.json'.length);
    if (!isTrailId(id)) {
      skipped += 1;
      continue;
    }
    let trail: StoredTrail | null = null;
    try {
      // Use the same per-file chokepoint as direct reads. Checking only the
      // directory lets `trails/x.json -> /outside/secret.json` escape it.
      trail = readStoredTrail(projectRoot, id);
    } catch {
      // A linked or otherwise refused entry is an unreadable trail, not a reason
      // to hide every valid trail beside it.
    }
    if (trail) trails.push(trail);
    else skipped += 1;
  }

  // Newest save first: a tour written a minute ago is the one being iterated on.
  trails.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name.localeCompare(b.name)));
  return { trails, skipped };
}

function readTrailFile(absolute: string, id: string): StoredTrail | null {
  let fd: number | null = null;
  try {
    // O_NOFOLLOW closes the race between path validation and the actual open:
    // replacing a checked file with a symlink must fail rather than follow it.
    // O_NONBLOCK keeps a FIFO with no writer from parking the whole server on
    // this open; a regular file ignores it, and `isFile()` below rejects the rest.
    fd = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
    const stat = fs.fstatSync(fd);
    // A file too big to be a trail is skipped rather than read: this directory
    // is inside the project, and something else may one day put a log in it.
    if (!stat.isFile() || stat.size > MAX_TRAIL_FILE_BYTES) return null;
    return parseTrail(id, fs.readFileSync(fd, 'utf-8'));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** One trail by id, or `null` when there is no such file. */
export function readStoredTrail(projectRoot: string, id: string): StoredTrail | null {
  return readTrailFile(trailPath(projectRoot, id), id);
}

/* ------------------------------------------------------------------ write -- */

/**
 * Write a trail, atomically.
 *
 * Temp file beside the target then `rename`, so a reader either sees the
 * previous trail or the new one and never a partial file. A random suffix plus
 * exclusive creation means neither another viewer nor a pre-planted symlink can
 * capture the temporary write.
 */
export function writeStoredTrail(projectRoot: string, trail: StoredTrail): void {
  const dir = trailsDirectory(projectRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw writeFailure(err);
  }
  // The directory did not necessarily exist during the first check. Resolve it
  // again now that mkdir completed, so an existing parent symlink cannot turn a
  // not-yet-existing trail directory into an out-of-project write.
  trailsDirectory(projectRoot);
  const target = trailPath(projectRoot, trail.id);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(trail, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temp, target);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Nothing to clean up, or nothing we can do about it. The write already
      // failed; the caller is about to be told so.
    }
    throw writeFailure(err);
  }
}

/** Remove a trail. Returns false when there was nothing there. */
export function deleteStoredTrail(projectRoot: string, id: string): boolean {
  try {
    fs.unlinkSync(trailPath(projectRoot, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw writeFailure(err);
  }
}

/**
 * An id nothing in `taken` is using, preferring the plain slug.
 *
 * A save under a name that is already there REPLACES it — that is what a reader
 * pressing Save with the same name means — so the caller passes the ids of
 * trails carrying a *different* name, and this only steps aside for those.
 */
export function uniqueTrailId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 999 trails sharing one slug is not a state worth a clever answer.
  throw new ApiError('bad-request', `Too many saved trails are already named like "${base}".`);
}

function writeFailure(err: unknown): ApiError {
  const code = (err as NodeJS.ErrnoException).code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new ApiError(
      'refused',
      `Saved trails could not be written: ${detail}`,
      `The viewer writes only to ${TRAILS_RELATIVE_DIR} inside this project. Check that it is writable.`
    );
  }
  return new ApiError('internal', `Saved trails could not be written: ${detail}`);
}
