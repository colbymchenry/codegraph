/**
 * `GET /api/entrypoints` — where to start reading a project you have never
 * opened, and where a flow starts.
 *
 * The empty state, the resting search palette and the entry-points panel all
 * have the same problem: a graph of thirteen thousand symbols and no obvious
 * door. Four answers, every one of them derived from the graph rather than
 * from a filename convention:
 *
 * - **Routes** — a request arriving from outside is the most literal entry a
 *   codebase has. Straight from the routing manifest (`/api/routes`), and
 *   absent for a project that is not a routed app. Carried with the file the
 *   URL is REGISTERED in as well as the one that serves it, because a router
 *   file is how a reader groups routes and the two are rarely the same file.
 * - **Files that run something** — the engine records a statement at the top
 *   level of a file as an edge out of the *file* node, so a CLI, a worker
 *   entry or a build script has `calls` where a library module has none. That
 *   is what makes `src/bin/codegraph.ts` the root of this repo's CLI flow.
 *   Ranked by calls x how many other files they reach, so the file that both
 *   runs and wires the project together outranks a registration table that
 *   makes a hundred module-level calls into itself.
 * - **Tests** — the other direction: not where the project starts, but what
 *   already exercises it. Ranked by how many other files a test reaches, so
 *   the suites that cross the most of the codebase come first.
 * - **Hubs** — the most depended-on symbols. Not an entry in the "runs first"
 *   sense; an entry in the sense that reading one tells you the most about
 *   what the project is made of, and a change to one radiates furthest.
 *
 * Tests and fixtures are excluded from the two *reading* lists — "where do I
 * start reading" never means a test — and the Tests list is built from the
 * narrow {@link isTestPath}, not from {@link isTestFile}: an example, a
 * benchmark or a fixture is not a test, and a heading that says "Tests" must
 * not be quietly counting them.
 */

import type { CodeGraph } from '../../index';
import type { Node, NodeKind } from '../../types';
import { intParam } from './respond';
import { buildRoutes, type WireRoute } from './routes';
import { isTestFile, isTestPath } from '../../search/query-utils';
import { toNodeRef, toPosixPath, wireList, type WireList, type WireNodeRef } from './wire';

/** Rows per derived list, and the default for `limit`. */
const DEFAULT_LIMIT = 12;

/**
 * Route rows, and the default for `routes`.
 *
 * Separate from `limit` because routes are the one list whose useful length is
 * set by the project rather than by the reader: a panel that groups 60 routes
 * under four router files is legible, while 60 rows of "most depended on" is
 * a wall. Both are honest — every list carries the real total.
 */
const DEFAULT_ROUTE_LIMIT = 60;
const MAX_ROUTE_LIMIT = 300;

/**
 * Ranked rows examined before the test filter and the per-directory cap run.
 *
 * Fixed rather than a multiple of `limit` so the same project answers with the
 * same rows whatever the caller asks for. It also means the `total` on the two
 * derived lists is a FLOOR — "at least this many" — because the tests it skips
 * are only recognisable in JavaScript (`isTestFile` reads directory shapes and
 * CamelCase suffixes that do not survive translation into SQL). That is the
 * honest reading, and the viewer prints the rows rather than the count.
 */
const SCAN_ROWS = 400;

/**
 * At most this many executable files from any one directory.
 *
 * Without it a repo with twenty one-off scripts in `scripts/` answers "where do
 * I start" with twenty scripts, and the CLI everybody actually wants falls off
 * the end. Two keeps a directory represented without letting it own the list.
 */
const MAX_FILES_PER_DIR = 2;

/**
 * Test files asked about per reach query.
 *
 * The reach query is driven from `nodes` by file path, so its cost is
 * proportional to the files in the chunk rather than to the edge table — but a
 * repo with ten thousand test files would still put ten thousand paths into
 * one `json_each`. Chunking keeps every statement bounded WITHOUT capping the
 * candidate list, which would silently drop test files from the ranking.
 */
const TEST_CHUNK = 500;

/** Kinds that are never a useful hub row: a mention, a container, or a name. */
const NON_HUB_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'file',
  'import',
  'export',
  'parameter',
]);

export interface WireEntryFile extends WireNodeRef {
  /** Calls and instantiations made at the top level of the file. */
  calls: number;
  /** Distinct other files this one's symbols reach. */
  reaches: number;
  /** Other files reaching into this one. Zero means nothing imports it. */
  dependents: number;
}

export interface WireEntryTest extends WireNodeRef {
  /** Distinct other files this test reaches — what it exercises. */
  reaches: number;
  /** References behind that reach. */
  refs: number;
}

export interface WireEntryHub extends WireNodeRef {
  /** Distinct symbols that depend on this one. */
  dependents: number;
}

export interface WireEntryPoints {
  /**
   * Frameworks the resolver detected, e.g. `["go"]`, `["express"]`.
   *
   * The Routes section's header names them: a route list is a claim about a
   * framework's conventions, and saying which one produced it is the
   * difference between a fact and an assertion.
   */
  frameworks: string[];
  routes: {
    routed: boolean;
    /** Every `route` node in the graph, resolved handler or not. */
    routeCount: number;
    items: WireList<WireRoute>;
  };
  /** `total` is a floor on these three — the server counts what its scan saw. */
  files: WireList<WireEntryFile>;
  tests: WireList<WireEntryTest>;
  hubs: WireList<WireEntryHub>;
  index: { lastIndexedAt: number | null; files: number };
  timing: { elapsedMs: number; cached: boolean };
}

// =============================================================================
// Cache
// =============================================================================

/**
 * One answer per (project, index build, limits).
 *
 * Unlike `/api/source` and everything downstream of it, nothing here is read
 * from disk: every field comes out of the index, so an answer is exactly as
 * fresh as the index build it was keyed on. The Tests list is the reason it is
 * worth caching at all — it asks a reach query per chunk of test files, and
 * every screen in the viewer refetches this payload when the index moves.
 */
const CACHE_LIMIT = 8;
const cache = new Map<string, WireEntryPoints>();

export function resetEntryPointsCache(): void {
  cache.clear();
}

// =============================================================================
// Build
// =============================================================================

export function buildEntryPoints(cg: CodeGraph, query: URLSearchParams): WireEntryPoints {
  const started = Date.now();
  const limit = intParam(query, 'limit', { min: 1, max: 50, default: DEFAULT_LIMIT });
  const routeLimit = intParam(query, 'routes', {
    min: 3,
    max: MAX_ROUTE_LIMIT,
    default: DEFAULT_ROUTE_LIMIT,
  });

  const stats = cg.getStats();
  // JSON rather than a joined string: a project root can contain any character
  // a separator might have picked, and this key is compared for equality only.
  const key = JSON.stringify([
    cg.getProjectRoot(),
    cg.getLastIndexedAt() ?? 0,
    stats.edgeCount,
    stats.fileCount,
    limit,
    routeLimit,
  ]);
  const hit = cache.get(key);
  if (hit) {
    // Re-stamp rather than mutate: the body is shared with the next caller.
    return { ...hit, timing: { elapsedMs: Date.now() - started, cached: true } };
  }

  const payload: WireEntryPoints = {
    frameworks: cg.getDetectedFrameworks(),
    routes: routeEntries(cg, routeLimit),
    files: executableFiles(cg, limit),
    tests: testFiles(cg, limit),
    hubs: hubs(cg, limit),
    index: { lastIndexedAt: cg.getLastIndexedAt() ?? null, files: stats.fileCount },
    timing: { elapsedMs: Date.now() - started, cached: false },
  };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, payload);
  return payload;
}

/**
 * The routing manifest, trimmed to a starting-points list.
 *
 * `buildRoutes` is reused rather than re-derived so a route row means exactly
 * the same thing here as on the routes endpoint — including its handler id and
 * its registration site, which are what make the row navigable and groupable.
 */
function routeEntries(cg: CodeGraph, limit: number): WireEntryPoints['routes'] {
  const manifest = buildRoutes(cg, new URLSearchParams([['limit', String(limit)]]));
  return {
    routed: manifest.routed,
    routeCount: manifest.routeCount,
    // `shown` counts the rows; `truncated` is the manifest's own verdict on
    // whether the window cut anything, and it is more trustworthy than
    // comparing against `routeCount` (which counts URLs whose handler never
    // resolved as well).
    items: {
      total: manifest.truncated ? Math.max(manifest.shown + 1, manifest.routeCount) : manifest.shown,
      shown: manifest.shown,
      truncated: manifest.truncated,
      items: manifest.entries,
    },
  };
}

/**
 * Files that do something on the way down, most first.
 *
 * Over-fetched before filtering, because the two things that shrink the list —
 * tests and the per-directory cap — are only knowable after the rows come back,
 * and a project whose noisiest module-level callers are all test files would
 * otherwise answer with an empty list.
 */
function executableFiles(cg: CodeGraph, limit: number): WireList<WireEntryFile> {
  const ranked = cg.getTopCallingFiles(SCAN_ROWS);

  const kept: Array<{ node: Node; calls: number; reaches: number }> = [];
  const perDir = new Map<string, number>();
  let eligible = 0;

  for (const row of ranked) {
    if (isTestFile(row.filePath)) continue;
    eligible += 1;
    if (kept.length >= limit) continue;
    const dir = directoryOf(row.filePath);
    const taken = perDir.get(dir) ?? 0;
    if (taken >= MAX_FILES_PER_DIR) continue;
    const node = cg.getNode(row.nodeId);
    if (!node) continue;
    perDir.set(dir, taken + 1);
    kept.push({ node, calls: row.calls, reaches: row.reaches });
  }

  const dependents = cg.getFileDependentCounts(kept.map((k) => k.node.filePath));
  const items: WireEntryFile[] = kept.map(({ node, calls, reaches }) => ({
    ...toNodeRef(node),
    calls,
    reaches,
    dependents: dependents.get(node.filePath) ?? 0,
  }));

  // `eligible` counts every non-test file the scan saw: a floor, never an
  // overstatement.
  return wireList(items, Math.max(eligible, items.length));
}

/**
 * The suites that exercise the most of the project, widest first.
 *
 * Ranked by reach rather than by size or by module-level calls: a test's
 * useful property is how much of the codebase runs when it does, and only Go,
 * Rust and Java put that work inside functions where a "runs something at
 * module level" ranking cannot see it at all.
 *
 * `total` is exact here — the candidate list is every test file in the index,
 * decided in JavaScript before any query runs — which is why it is the one
 * derived list whose count is not a floor. A test file that reaches nothing
 * outside itself is left out on purpose: it exercises nothing this graph can
 * name.
 */
function testFiles(cg: CodeGraph, limit: number): WireList<WireEntryTest> {
  const candidates = cg
    .getFiles()
    .map((file) => toPosixPath(file.path))
    .filter((path) => isTestPath(path));
  if (candidates.length === 0) return wireList([], 0);

  const reach = new Map<string, { reaches: number; refs: number }>();
  for (let i = 0; i < candidates.length; i += TEST_CHUNK) {
    for (const [path, counts] of cg.getFileReachCounts(candidates.slice(i, i + TEST_CHUNK))) {
      reach.set(toPosixPath(path), counts);
    }
  }

  const ranked = [...reach.entries()]
    .map(([path, counts]) => ({ path, ...counts }))
    .sort((a, b) => b.reaches - a.reaches || b.refs - a.refs || a.path.localeCompare(b.path));

  const top = ranked.slice(0, limit);
  const nodes = new Map(cg.getFileNodes(top.map((row) => row.path)).map((n) => [toPosixPath(n.filePath), n]));

  const items: WireEntryTest[] = [];
  for (const row of top) {
    const node = nodes.get(row.path);
    if (!node) continue;
    items.push({ ...toNodeRef(node), reaches: row.reaches, refs: row.refs });
  }

  return wireList(items, Math.max(ranked.length, items.length));
}

/** The most depended-on symbols, tests and non-navigable kinds removed. */
function hubs(cg: CodeGraph, limit: number): WireList<WireEntryHub> {
  const ranked = cg.getTopDependedOn(SCAN_ROWS);

  const items: WireEntryHub[] = [];
  let eligible = 0;
  for (const row of ranked) {
    const node = cg.getNode(row.nodeId);
    if (!node || NON_HUB_KINDS.has(node.kind) || isTestFile(node.filePath)) continue;
    eligible += 1;
    if (items.length >= limit) continue;
    items.push({ ...toNodeRef(node), dependents: row.dependents });
  }

  return wireList(items, Math.max(eligible, items.length));
}

/** `src/bin/codegraph.ts` -> `src/bin`; a root file -> `.`. */
function directoryOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut < 0 ? '.' : normalized.slice(0, cut);
}
