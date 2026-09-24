/**
 * `GET/POST/DELETE /api/trails` — saved trails, the reader's own tours through
 * the graph (design spec §3.12).
 *
 * A trail is the path of symbols someone walked to explain something: "how a
 * request is served", "everything the token expiry touches". The viewer already
 * carries one in the URL; this is the same walk given a name and kept, so the
 * next person — or the same person next week — starts at the explanation rather
 * than at the search box.
 *
 * ## The one thing this feature has to get right
 *
 * **A trail must survive a re-index.** A node's id contains its start line, so
 * inserting an import at the top of a file renames every symbol below it. A
 * trail keyed on ids would break the first time anybody edited the code it
 * describes — which is exactly when it matters. So a hop is stored as what it
 * *is* — qualified name, kind, file — with the id kept only as a fast path, and
 * every hop is re-resolved against the current index on the way out:
 *
 * - the recorded id still names the same symbol → `ok`
 * - the qualified name resolves somewhere else → `moved`, and the row says
 *   where from
 * - the name is now carried by several symbols and none is in the recorded
 *   file → `ambiguous`, best guess offered and labelled as one
 * - nothing answers to it → `missing`, and the row says "moved or renamed"
 *
 * Nothing is silently dropped and nothing is silently guessed: a trail that has
 * decayed says so on its own row, which is the point at which its author can
 * fix it.
 *
 * ## What it opens
 *
 * A trail with a hole in it cannot be handed to the viewer whole — the `t`
 * param is a PATH, and stitching hop 2 to hop 4 would draw an adjacency that
 * does not exist. So the payload carries the longest run of consecutive
 * resolved hops, and the row says when that is less than the whole trail.
 *
 * Storage — the only write `codegraph ui` makes — is `./trail-store.ts`.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodeGraph } from '../../index';
import type { Node } from '../../types';
import { ApiError, badRequest, notFound } from './respond';
import {
  MAX_TRAIL_HOPS,
  MAX_TRAIL_NAME,
  MAX_TRAIL_NOTE,
  MAX_TRAILS,
  TRAILS_RELATIVE_DIR,
  TRAIL_FORMAT_VERSION,
  deleteStoredTrail,
  listStoredTrails,
  slugify,
  uniqueTrailId,
  writeStoredTrail,
  type StoredHop,
  type StoredHopDirection,
  type StoredTrail,
} from './trail-store';
import { toNodeRef } from './wire';

/* ------------------------------------------------------------------ wire -- */

/** How a saved hop fared against the current index. */
export type WireTrailHopStatus = 'ok' | 'moved' | 'ambiguous' | 'missing';

export interface WireTrailHop {
  dir: StoredHopDirection;
  /** The name as it was when the trail was saved. */
  name: string;
  qualifiedName: string;
  kind: string;
  /** Where the symbol was when the trail was saved. */
  savedFile: string;
  savedLine: number;
  status: WireTrailHopStatus;
  /** The symbol's id NOW. Null when nothing answers to it any more. */
  id: string | null;
  file: string | null;
  line: number | null;
  /** Finished screen wording for a status that is not `ok`; null when it is. */
  note: string | null;
}

export interface WireTrail {
  id: string;
  name: string;
  note: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  hops: WireTrailHop[];
  /** Hops that still resolve to a symbol in this index. */
  resolved: number;
  /** Every hop resolved, and none of them moved. */
  intact: boolean;
  /**
   * The longest run of CONSECUTIVE resolved hops, encoded as the `t` param.
   * Null when nothing in the trail resolves. Never stitched across a hole: the
   * trail is a path, and a fabricated adjacency is worse than a short one.
   */
  encoded: string | null;
  /** 1-based index of the first hop `encoded` carries. */
  openFrom: number;
  /** How many hops `encoded` carries. */
  openCount: number;
  /** The symbol the trail opens at — the last hop of that run. */
  openId: string | null;
}

export interface WireTrails {
  trails: WireTrail[];
  /** Writes are off. The viewer hides Save and Delete, and says why. */
  readOnly: boolean;
  readOnlyReason: string | null;
  /** Project-relative directory the files live in. The screen names it. */
  directory: string;
  /** Files in that directory that were not readable trails. */
  skipped: number;
  /** The list stopped at {@link MAX_TRAILS}. */
  bounded: boolean;
  /** The id just written, on the answer to a POST. */
  saved?: string;
  /** That POST replaced a trail of the same name. */
  replaced?: boolean;
  /** The id just removed, on the answer to a DELETE. */
  deleted?: string;
}

/* -------------------------------------------------------------- resolution -- */

/**
 * Re-resolve one saved hop against the index as it is now.
 *
 * Order matters: the recorded id first, because in the common case (nothing
 * above the symbol changed) it is one lookup and exactly right. It is still
 * verified against the qualified name — an id is a hash of position as well as
 * identity, and a recycled one pointing at a different symbol would put a
 * stranger in the middle of somebody's explanation.
 */
export function resolveHop(cg: CodeGraph, hop: StoredHop): WireTrailHop {
  const base = {
    dir: hop.dir,
    name: hop.name,
    qualifiedName: hop.qualifiedName,
    kind: hop.kind,
    savedFile: hop.file,
    savedLine: hop.line,
  };

  const byId = hop.id ? cg.getNode(hop.id) : null;
  if (byId && matches(byId, hop)) {
    return { ...base, status: 'ok', id: byId.id, file: byId.filePath, line: byId.startLine, note: null };
  }

  const candidates = cg
    .getNodesByQualifiedName(hop.qualifiedName)
    .filter((node) => hop.kind === '' || node.kind === hop.kind);

  if (candidates.length === 0) {
    return {
      ...base,
      status: 'missing',
      id: null,
      file: null,
      line: null,
      note: `no longer in the index — moved or renamed since this trail was saved`,
    };
  }

  const sameFile = candidates.filter((node) => node.filePath === hop.file);
  if (sameFile.length === 1) {
    const node = sameFile[0] as Node;
    return { ...base, status: 'ok', id: node.id, file: node.filePath, line: node.startLine, note: null };
  }

  if (candidates.length === 1) {
    const node = candidates[0] as Node;
    return {
      ...base,
      status: 'moved',
      id: node.id,
      file: node.filePath,
      line: node.startLine,
      note: `moved from ${hop.file || 'an unrecorded file'} to ${node.filePath}`,
    };
  }

  // Several symbols carry this name and none of them is where it used to be.
  // The best guess is offered — a row nobody can open is not more honest, it
  // is just less useful — but it is labelled as a guess.
  const pick = (sameFile[0] ?? candidates[0]) as Node;
  return {
    ...base,
    status: 'ambiguous',
    id: pick.id,
    file: pick.filePath,
    line: pick.startLine,
    note: `${candidates.length} symbols now carry this name — showing the one in ${pick.filePath}`,
  };
}

function matches(node: Node, hop: StoredHop): boolean {
  if (hop.kind !== '' && node.kind !== hop.kind) return false;
  return node.qualifiedName === hop.qualifiedName || node.name === hop.name;
}

/** The `t` param's own encoding — kept identical to `ui/src/lib/trail-codec.ts`. */
const DIR_CHAR: Record<StoredHopDirection, string> = { start: 's', down: 'd', up: 'u' };

/**
 * Turn resolved hops into something the viewer can open.
 *
 * The longest CONSECUTIVE run, not every resolved hop: skipping a missing hop
 * would encode a step from A to C that no edge supports, and the Flow strip
 * reads a trail as exactly that sequence of edges. The first hop of the run is
 * always written as `start`, because a run beginning mid-trail arrived from
 * nothing the viewer can draw.
 */
export function encodeResolvedRun(hops: readonly WireTrailHop[]): {
  encoded: string | null;
  openFrom: number;
  openCount: number;
  openId: string | null;
} {
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let i = 0; i <= hops.length; i += 1) {
    const resolved = i < hops.length && (hops[i] as WireTrailHop).id !== null;
    if (resolved) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start > bestLength) {
      bestStart = start;
      bestLength = i - start;
    }
    start = -1;
  }
  if (bestLength === 0) return { encoded: null, openFrom: 0, openCount: 0, openId: null };

  const run = hops.slice(bestStart, bestStart + bestLength);
  const encoded = run
    .map((hop, index) => `${index === 0 ? 's' : DIR_CHAR[hop.dir]}${encodeURIComponent(hop.id as string)}`)
    .join(',');
  return {
    encoded,
    openFrom: bestStart + 1,
    openCount: bestLength,
    openId: (run[run.length - 1] as WireTrailHop).id,
  };
}

export function resolveTrail(cg: CodeGraph, stored: StoredTrail): WireTrail {
  const hops = stored.hops.map((hop) => resolveHop(cg, hop));
  const run = encodeResolvedRun(hops);
  return {
    id: stored.id,
    name: stored.name,
    note: stored.note,
    author: stored.author,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    hops,
    resolved: hops.filter((hop) => hop.id !== null).length,
    intact: hops.every((hop) => hop.status === 'ok'),
    ...run,
  };
}

/* ------------------------------------------------------------------ read -- */

export interface TrailsOptions {
  /** Writes refused, and the sentence saying why. */
  readOnly: boolean;
  readOnlyReason: string | null;
}

export function buildTrails(
  cg: CodeGraph,
  projectRoot: string,
  options: TrailsOptions
): WireTrails {
  const { trails, skipped } = listStoredTrails(projectRoot);
  return {
    trails: trails.map((stored) => resolveTrail(cg, stored)),
    readOnly: options.readOnly,
    readOnlyReason: options.readOnlyReason,
    directory: TRAILS_RELATIVE_DIR,
    skipped,
    bounded: trails.length >= MAX_TRAILS,
  };
}

/* ----------------------------------------------------------------- write -- */

/** What a POST body has to be. Everything else about a hop comes from the graph. */
export interface SaveTrailRequest {
  name: string;
  note?: string;
  hops: Array<{ dir?: string; id: string }>;
}

/**
 * Save a trail.
 *
 * The client sends ids and directions and nothing else: the name, kind, file
 * and line of every hop are read out of the index here. A client that supplied
 * its own metadata could save a trail describing symbols that are not in the
 * graph, and the whole value of the feature is that a trail is a claim the
 * index can re-check.
 *
 * A save under a name that already exists REPLACES that trail, keeping its
 * `createdAt`. That is what pressing Save with the same name means, and the
 * answer says `replaced` so the screen can too.
 */
export function saveTrail(
  cg: CodeGraph,
  projectRoot: string,
  body: unknown,
  options: TrailsOptions
): WireTrails {
  if (options.readOnly) throw readOnlyRefusal(options.readOnlyReason);
  const request = parseSaveRequest(body);

  const hops: StoredHop[] = [];
  request.hops.forEach((hop, index) => {
    const node = cg.getNode(hop.id);
    if (!node) {
      throw badRequest(
        `Hop ${index + 1} is not in the index: ${hop.id}`,
        'Trails are saved from symbols the index holds. Reload the page and walk the trail again.'
      );
    }
    const ref = toNodeRef(node);
    hops.push({
      dir: hop.dir === 'up' || hop.dir === 'down' ? hop.dir : 'start',
      name: ref.name,
      qualifiedName: ref.qualifiedName,
      kind: ref.kind,
      file: ref.file,
      line: ref.line,
      id: ref.id,
    });
  });
  // The first hop is where the walk began, whatever the client called it.
  if (hops[0]) hops[0].dir = 'start';

  const existing = listStoredTrails(projectRoot).trails;
  const sameName = existing.find((trail) => trail.name === request.name);
  const takenByOthers = new Set(
    existing.filter((trail) => trail.name !== request.name).map((trail) => trail.id)
  );
  const id = sameName ? sameName.id : uniqueTrailId(slugify(request.name), takenByOthers);
  const now = new Date().toISOString();

  writeStoredTrail(projectRoot, {
    version: TRAIL_FORMAT_VERSION,
    id,
    name: request.name,
    note: request.note,
    author: trailAuthor(projectRoot),
    createdAt: sameName?.createdAt || now,
    updatedAt: now,
    hops,
  });

  return { ...buildTrails(cg, projectRoot, options), saved: id, replaced: sameName !== undefined };
}

export function removeTrail(
  cg: CodeGraph,
  projectRoot: string,
  id: string,
  options: TrailsOptions
): WireTrails {
  if (options.readOnly) throw readOnlyRefusal(options.readOnlyReason);
  if (!deleteStoredTrail(projectRoot, id)) {
    throw notFound(`There is no saved trail called "${id}".`);
  }
  return { ...buildTrails(cg, projectRoot, options), deleted: id };
}

function readOnlyRefusal(reason: string | null): ApiError {
  return new ApiError(
    'refused',
    reason ?? 'This viewer is running read-only, so trails cannot be saved.',
    `Restart without --read-only to let the viewer write trails into ${TRAILS_RELATIVE_DIR}.`
  );
}

function parseSaveRequest(body: unknown): { name: string; note: string; hops: SaveTrailRequest['hops'] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('A trail is saved from a JSON object: { name, hops }.');
  }
  const value = body as Record<string, unknown>;

  const name = typeof value.name === 'string' ? value.name.trim().replace(/\s+/g, ' ') : '';
  if (name === '') throw badRequest('A saved trail needs a name.');
  if (name.length > MAX_TRAIL_NAME) {
    throw badRequest(`That name is too long (max ${MAX_TRAIL_NAME} characters).`);
  }

  const note = typeof value.note === 'string' ? value.note.trim() : '';
  if (note.length > MAX_TRAIL_NOTE) {
    throw badRequest(`That note is too long (max ${MAX_TRAIL_NOTE} characters).`);
  }

  if (!Array.isArray(value.hops) || value.hops.length === 0) {
    throw badRequest('A saved trail needs at least one hop.');
  }
  if (value.hops.length > MAX_TRAIL_HOPS) {
    throw badRequest(`A saved trail can hold at most ${MAX_TRAIL_HOPS} hops.`);
  }

  const hops: SaveTrailRequest['hops'] = [];
  for (const entry of value.hops) {
    if (typeof entry !== 'object' || entry === null) throw badRequest('Each hop is { dir, id }.');
    const hop = entry as Record<string, unknown>;
    if (typeof hop.id !== 'string' || hop.id === '') throw badRequest('Each hop needs an id.');
    hops.push({ id: hop.id, ...(typeof hop.dir === 'string' ? { dir: hop.dir } : {}) });
  }

  return { name, note, hops };
}

/* ---------------------------------------------------------------- author -- */

/**
 * Who to record as the author.
 *
 * Git's `user.name` first, because a trail is a thing one person wrote for
 * others to read and that is the name they already sign work with in this
 * project; the OS user is the fallback. Read once per PROJECT — `git config` is
 * a subprocess, and a save should not pay for it twice — and never sent
 * anywhere: it goes into a file inside the user's own `.codegraph/`.
 */
const cachedAuthors = new Map<string, string>();

export function trailAuthor(projectRoot: string): string {
  const key = authorCacheKey(projectRoot);
  const cached = cachedAuthors.get(key);
  if (cached !== undefined) return cached;
  const author = gitUserName(projectRoot) ?? osUserName() ?? '';
  cachedAuthors.set(key, author);
  return author;
}

/** Test seam: forget the cached author. */
export function resetTrailAuthor(): void {
  cachedAuthors.clear();
}

function authorCacheKey(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

function gitUserName(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const name = out.trim();
    return name === '' ? null : name.slice(0, 120);
  } catch {
    // No git, no config, not a repository — all ordinary. Fall through.
    return null;
  }
}

function osUserName(): string | null {
  try {
    const name = os.userInfo().username.trim();
    return name === '' ? null : name.slice(0, 120);
  } catch {
    return null;
  }
}
