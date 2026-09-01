/**
 * `GET /api/map` — the repository at module granularity.
 *
 * The Map answers "what is in here and how is it organised" without anybody
 * having drawn a diagram: modules are directories, the arrows between them are
 * the edges the index already holds, and the vertical order falls out of the
 * dependency direction (design spec §3.6). This module produces the *data*;
 * the layering, cycle-breaking and geometry are pure functions in the viewer
 * (`ui/src/lib/map-model.ts`), so toggling tests or selecting a module never
 * costs a round-trip.
 *
 * Three decisions shape the payload, and all three are about not lying:
 *
 * **A module is a directory, not a guess.** `moduleIdFor` maps each indexed
 * file to the first {@link MapQuery.depth} path segments under the chosen root.
 * A file sitting loose in the root gets folded into one `(root files)` box —
 * except a façade (`index.ts`, `lib.rs`, `__init__.py`), which is its own box
 * because it is the thing everything else imports. No clustering, no
 * heuristics about "what belongs together": if two files are in the same
 * directory the repository already said they belong together.
 *
 * **Weight counts edges; layering counts *declared* edges.** A link's `count`
 * is every confident cross-module edge behind it, which is what the reader
 * sees as thickness. Its `declared` count is the subset resolved through an
 * import, a qualified name, an inheritance clause or a typed receiver — and
 * that is what the layout layers on. The difference is not academic: on this
 * repository, bare name matching resolves calls to `run`, `push` and `finish`
 * across unrelated directories, and layering on raw counts puts the storage
 * layer directly under the CLI. Layering on declared edges reproduces the
 * pipeline the project's own docs describe.
 *
 * **Nothing is dropped silently.** Uncertain edges (confidence below
 * {@link UNCERTAIN_BELOW}) are excluded from every count, and how many were
 * excluded rides on the payload so the side panel can say so.
 */

import type { CodeGraph } from '../../index';
import type { EdgeKind, Language } from '../../types';
import { isTestFile } from '../../search/query-utils';
import { badRequest } from './respond';
import { UNCERTAIN_BELOW, toPosixPath, wireList, type WireList } from './wire';

/**
 * The edge kinds that count as "module A reaches into module B".
 *
 * `contains` is absent on purpose — a file containing its own symbols is not a
 * dependency, and including it would make every module depend on itself.
 */
export const MAP_EDGE_KINDS: readonly EdgeKind[] = [
  'calls',
  'imports',
  'references',
  'instantiates',
  'extends',
  'implements',
  'navigates',
];

/**
 * The kinds whose symbol pairs the tooltip names.
 *
 * A `references` edge to a type is real traffic but "Config → Config" is not
 * an interesting row; calls and imports are what a reader wants named.
 */
const PAIR_EDGE_KINDS: readonly EdgeKind[] = ['calls', 'imports', 'instantiates', 'navigates'];

/** Symbol pairs kept per link — the tooltip shows four (design spec §3.6). */
const TOP_PAIRS_PER_LINK = 4;

/**
 * File paths listed per module.
 *
 * The panel's file list is a drill-down, not a directory listing, and it rides
 * on this payload so that clicking a module and then one of its files costs no
 * round-trip at all. Capped because a module can hold hundreds of files and the
 * map is not where you read them; `total` stays the real number.
 */
const MAX_FILES_PER_MODULE = 40;

/** Longest cycle reported, and how many. Beyond this a cycle list stops being readable. */
const MAX_FILE_CYCLES = 40;
const MAX_CYCLE_LENGTH = 12;

/** Default segments below the root that name a module. */
const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 4;

/**
 * Basenames that stay their own box when they sit loose in a module root.
 *
 * These are façades — the file every other module imports the directory
 * *through*. Folding `src/index.ts` into a "(root files)" bucket with the type
 * declarations next to it hides the busiest node on the map.
 */
const FACADE_STEMS = new Set(['index', 'main', 'lib', 'mod', '__init__', 'init']);

/** Id of the bucket loose files fall into. Deliberately not a real directory name. */
export function rootFilesId(root: string): string {
  return root ? `${root}/(root files)` : '(root files)';
}

// =============================================================================
// Wire shapes
// =============================================================================

export interface WireMapModule {
  /** Directory path, or the `(root files)` bucket, or a façade file's own path. */
  id: string;
  /** Last path segment — what the node label shows when the id is long. */
  label: string;
  files: number;
  symbols: number;
  /** File count by language, most files first. */
  languages: Array<{ language: Language; files: number }>;
  /** More than half its files are tests — drawn dashed, hidden by default. */
  test: boolean;
  /**
   * How many of its files are tool-generated. A module whose files are ALL
   * generated is drawn in ink-4 (design spec §2.6): code nobody wrote by hand
   * and nobody deletes by hand.
   */
  generated: number;
  /** Which of {@link fileList}'s entries are generated, so a row can dim too. */
  generatedFiles: string[];
  /** True when this box is a single file kept out of the root bucket (a façade). */
  facade: boolean;
  /** Its files, capped — what the side panel lists when the module is selected. */
  fileList: WireList<string>;
}

export interface WireMapLink {
  source: string;
  target: string;
  /** Every confident cross-module edge behind this link. Drives thickness. */
  count: number;
  /**
   * The subset resolved through an import, a qualified name, an inheritance
   * clause or a typed receiver. Drives the layering — see the module header.
   */
  declared: number;
  /** `count` broken down by edge kind, biggest first. */
  byKind: Array<{ kind: EdgeKind; count: number }>;
  /**
   * The busiest symbol pairs behind the link, at most
   * {@link TOP_PAIRS_PER_LINK}, declared ones first.
   */
  topPairs: Array<{ from: string; to: string; count: number; declared: number }>;
}

export interface WireMapCycle {
  /** How many files are in the component. `files` may be shorter. */
  size: number;
  /** The files, capped — a 200-file knot is a fact, not a list anybody reads. */
  files: string[];
  /** The modules the cycle passes through, deduped in order. */
  modules: string[];
}

export interface WireMapPayload {
  root: string;
  depth: number;
  /** Every root the selector may offer, this index's own directories. */
  roots: Array<{ root: string; label: string; files: number }>;
  modules: WireMapModule[];
  links: WireMapLink[];
  /**
   * File-level circular dependencies — the strongly connected components of
   * the file graph, which is what `findCircularDependencies` reports, computed
   * from one query so it stays affordable on a large index.
   */
  cycles: { total: number; shown: number; truncated: boolean; items: WireMapCycle[] };
  excluded: {
    /** Cross-module edges left out for being name-only guesses. */
    uncertainEdges: number;
    /** The confidence floor applied. */
    confidenceBelow: number;
  };
  index: { lastIndexedAt: number | null; edges: number; files: number };
  /** How long the aggregation took, and whether this answer came from the cache. */
  timing: { elapsedMs: number; cached: boolean };
}

export interface MapQuery {
  root: string;
  depth: number;
}

// =============================================================================
// Module naming
// =============================================================================

/** Strip a trailing slash and any leading `./`, so `src/` and `src` are one root. */
export function normalizeRoot(raw: string | undefined): string {
  let root = (raw ?? '').trim().replace(/\\/g, '/');
  while (root.startsWith('./')) root = root.slice(2);
  while (root.endsWith('/')) root = root.slice(0, -1);
  if (root === '.' || root === '/') return '';
  return root;
}

function stemOf(basename: string): string {
  const dot = basename.indexOf('.');
  return dot <= 0 ? basename : basename.slice(0, dot);
}

/**
 * Which module a file belongs to, or `null` when it is outside the root.
 *
 * `depth` segments under the root name the module. A file with fewer segments
 * than that is loose in the root: a façade keeps its own box, everything else
 * joins the `(root files)` bucket.
 */
export function moduleIdFor(
  filePath: string,
  root: string,
  depth: number
): { id: string; facade: boolean } | null {
  const path = toPosixPath(filePath);
  let rel = path;
  if (root) {
    if (!path.startsWith(`${root}/`)) return null;
    rel = path.slice(root.length + 1);
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length <= depth) {
    // A loose file. The directories it DOES have still qualify it, so
    // `src/a/b.ts` at depth 2 lands in `src/a/(root files)`, not the top one.
    const dir = [root, ...parts.slice(0, -1)].filter(Boolean).join('/');
    if (FACADE_STEMS.has(stemOf(parts[parts.length - 1] ?? ''))) {
      return { id: [root, ...parts].filter(Boolean).join('/'), facade: true };
    }
    return { id: rootFilesId(dir), facade: false };
  }
  return { id: [root, ...parts.slice(0, depth)].filter(Boolean).join('/'), facade: false };
}

/**
 * The root the map opens on: the directory holding the most non-test symbols.
 *
 * A repository's source almost always lives under one directory (`src`, `lib`,
 * `pkg`, `app`), and opening there is what keeps the default map about the
 * program rather than about its tests, scripts and sibling packages. The
 * fallback is the repository root, which is correct for a flat project.
 *
 * A directory only wins if it holds a clear majority of the symbols — anything
 * less and the honest answer is "this repository has no single source root".
 */
export function pickDefaultRoot(
  files: ReadonlyArray<{ path: string; symbols: number; test: boolean }>
): string {
  const byDir = new Map<string, number>();
  let total = 0;
  for (const file of files) {
    if (file.test) continue;
    const slash = file.path.indexOf('/');
    if (slash <= 0) continue;
    const dir = file.path.slice(0, slash);
    byDir.set(dir, (byDir.get(dir) ?? 0) + file.symbols);
    total += file.symbols;
  }
  if (total === 0) return '';
  let best = '';
  let bestSymbols = 0;
  let second = 0;
  for (const [dir, symbols] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (symbols > bestSymbols) {
      second = bestSymbols;
      best = dir;
      bestSymbols = symbols;
    } else if (symbols > second) second = symbols;
  }
  // A second root holding a fifth of the code (a React Native app's `ios/`
  // beside its `src/`) belongs on the picture: map the whole project.
  if (second * 5 >= total) return '';
  return bestSymbols * 2 > total ? best : '';
}

// =============================================================================
// Cache
// =============================================================================

/**
 * One aggregation per (project, index build, root, depth).
 *
 * The map is the one screen whose cost is proportional to the whole edge
 * table, so it is also the one screen worth caching. Keyed on the index's
 * stamp AND its edge count, exactly as the blast scale is: a re-index or a
 * sync that only moved edges must invalidate it, or the map draws a shape the
 * code no longer has. A handful of entries, because the root selector is the
 * only thing that varies.
 */
const CACHE_LIMIT = 8;
const cache = new Map<string, WireMapPayload>();

export function resetMapCache(): void {
  cache.clear();
}

// =============================================================================
// Build
// =============================================================================

export function parseMapQuery(query: URLSearchParams): { root: string | null; depth: number } {
  const rawDepth = query.get('depth');
  let depth = DEFAULT_DEPTH;
  if (rawDepth !== null && rawDepth !== '') {
    depth = Number.parseInt(rawDepth, 10);
    if (!Number.isFinite(depth) || depth < 1 || depth > MAX_DEPTH) {
      throw badRequest(`depth must be a whole number from 1 to ${MAX_DEPTH}.`);
    }
  }
  const rawRoot = query.get('root');
  return { root: rawRoot === null ? null : normalizeRoot(rawRoot), depth };
}

export function buildMap(cg: CodeGraph, projectRoot: string, query: URLSearchParams): WireMapPayload {
  const started = Date.now();
  let { root: requestedRoot, depth } = parseMapQuery(query);

  const fileRecords = cg.getFiles().map((file) => {
    const path = toPosixPath(file.path);
    return {
      path,
      language: file.language,
      symbols: file.nodeCount ?? 0,
      test: isTestFile(path),
      generated: file.generated === true,
    };
  });

  const root = requestedRoot ?? pickDefaultRoot(fileRecords);
  // Left to choose, and choosing the whole project (two substantial roots):
  // one level deeper, so the boxes are `src/app` and `ios/CaptureView`, not
  // `src` and `ios`.
  if (requestedRoot === null && root === '' && !query.has('depth')) depth = 2;
  const stats = cg.getStats();
  const key = [
    projectRoot,
    cg.getLastIndexedAt() ?? 0,
    stats.edgeCount,
    stats.fileCount,
    root,
    depth,
  ].join('\u0000');
  const hit = cache.get(key);
  if (hit) {
    // Re-stamp rather than mutate: the cached body is shared, and a caller
    // must not see another request's elapsed time.
    return { ...hit, timing: { elapsedMs: Date.now() - started, cached: true } };
  }

  const assignments: Array<{ filePath: string; module: string }> = [];
  const modules = new Map<
    string,
    {
      id: string;
      facade: boolean;
      files: number;
      symbols: number;
      testFiles: number;
      generatedFiles: number;
      generatedPaths: Set<string>;
      languages: Map<Language, number>;
      paths: string[];
    }
  >();
  const moduleOfFile = new Map<string, string>();

  for (const file of fileRecords) {
    const assigned = moduleIdFor(file.path, root, depth);
    if (assigned === null) continue;
    assignments.push({ filePath: file.path, module: assigned.id });
    moduleOfFile.set(file.path, assigned.id);
    let entry = modules.get(assigned.id);
    if (!entry) {
      entry = {
        id: assigned.id,
        facade: assigned.facade,
        files: 0,
        symbols: 0,
        testFiles: 0,
        generatedFiles: 0,
        generatedPaths: new Set(),
        languages: new Map(),
        paths: [],
      };
      modules.set(assigned.id, entry);
    }
    entry.files += 1;
    entry.paths.push(file.path);
    entry.symbols += file.symbols;
    if (file.test) entry.testFiles += 1;
    if (file.generated) {
      entry.generatedFiles += 1;
      entry.generatedPaths.add(file.path);
    }
    entry.languages.set(file.language, (entry.languages.get(file.language) ?? 0) + 1);
  }

  const aggregation = cg.getModuleAggregation(assignments, {
    kinds: MAP_EDGE_KINDS,
    minConfidence: UNCERTAIN_BELOW,
    topPairsPerLink: TOP_PAIRS_PER_LINK,
    pairKinds: PAIR_EDGE_KINDS,
  });

  const links = new Map<string, WireMapLink>();
  let uncertainEdges = 0;
  for (const row of aggregation.links) {
    // The same pass counts what the confidence floor left out, so the "N
    // name-only matches excluded" note reports the number the map actually
    // applied rather than a second query's opinion of it.
    uncertainEdges += row.uncertain;
    if (row.count === 0) continue;
    const id = `${row.source}\u0000${row.target}`;
    let link = links.get(id);
    if (!link) {
      link = { source: row.source, target: row.target, count: 0, declared: 0, byKind: [], topPairs: [] };
      links.set(id, link);
    }
    link.count += row.count;
    link.declared += row.declared;
    link.byKind.push({ kind: row.kind, count: row.count });
  }
  for (const link of links.values()) {
    link.byKind.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }
  for (const pair of aggregation.pairs) {
    const link = links.get(`${pair.source}\u0000${pair.target}`);
    if (link && link.topPairs.length < TOP_PAIRS_PER_LINK) {
      link.topPairs.push({
        from: pair.from,
        to: pair.to,
        count: pair.count,
        declared: pair.declared,
      });
    }
  }

  const payload: WireMapPayload = {
    root,
    depth,
    roots: rootOptions(fileRecords),
    modules: [...modules.values()]
      .map((entry) => {
        const shown = entry.paths.slice().sort().slice(0, MAX_FILES_PER_MODULE);
        return {
          id: entry.id,
          label: entry.id.slice(entry.id.lastIndexOf('/') + 1) || entry.id,
          files: entry.files,
          symbols: entry.symbols,
          languages: [...entry.languages]
            .map(([language, files]) => ({ language, files }))
            .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
          test: entry.testFiles * 2 > entry.files,
          generated: entry.generatedFiles,
          facade: entry.facade,
          // Only the SHOWN paths, so the list the panel dims and the list it
          // draws are the same list — the count-equals-list rule.
          generatedFiles: shown.filter((path) => entry.generatedPaths.has(path)),
          fileList: wireList(shown, entry.files),
        };
      })
      // Sorted so two runs over one index produce byte-identical payloads —
      // the layout is deterministic, and it cannot be if its input is not.
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: [...links.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    ),
    cycles: fileCycles(cg, moduleOfFile),
    excluded: { uncertainEdges, confidenceBelow: UNCERTAIN_BELOW },
    index: {
      lastIndexedAt: cg.getLastIndexedAt(),
      edges: stats.edgeCount,
      files: stats.fileCount,
    },
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
 * File-level circular dependencies, as strongly connected components.
 *
 * Tarjan over the one-query file edge list. Components of size 1 are not
 * cycles (a file depending on itself is a same-file edge, already excluded),
 * and a component longer than {@link MAX_CYCLE_LENGTH} is reported truncated
 * rather than printed — a 200-file knot is a fact about the repository, not a
 * list anybody reads.
 */
function fileCycles(
  cg: CodeGraph,
  moduleOfFile: Map<string, string>
): WireMapPayload['cycles'] {
  const adjacency = new Map<string, string[]>();
  for (const pair of cg.getFileDependencyPairs(UNCERTAIN_BELOW)) {
    if (!moduleOfFile.has(pair.source) || !moduleOfFile.has(pair.target)) continue;
    let out = adjacency.get(pair.source);
    if (!out) adjacency.set(pair.source, (out = []));
    out.push(pair.target);
  }
  // Deterministic iteration: SQLite's DISTINCT ordering is not a contract.
  const nodes = [...new Set([...adjacency.keys(), ...[...adjacency.values()].flat()])].sort();
  for (const list of adjacency.values()) list.sort();

  const components = tarjan(nodes, (id) => adjacency.get(id) ?? []);
  const cycles = components
    .filter((component) => component.length > 1)
    .map((component) => component.slice().sort())
    .sort((a, b) => a.length - b.length || (a[0] ?? '').localeCompare(b[0] ?? ''));

  const items = cycles.slice(0, MAX_FILE_CYCLES).map((files) => ({
    size: files.length,
    files: files.slice(0, MAX_CYCLE_LENGTH),
    modules: [...new Set(files.map((file) => moduleOfFile.get(file) ?? file))].sort(),
  }));
  return {
    total: cycles.length,
    shown: items.length,
    truncated: cycles.length > items.length,
    items,
  };
}

/** Tarjan's strongly connected components, iterative so a deep graph cannot blow the stack. */
function tarjan(nodes: readonly string[], edgesOf: (id: string) => readonly string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ id: string; edges: readonly string[]; at: number }> = [
      { id: start, edges: edgesOf(start), at: 0 },
    ];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      if (frame.at < frame.edges.length) {
        const next = frame.edges[frame.at]!;
        frame.at += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, edges: edgesOf(next), at: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.id) break;
        }
        out.push(component);
      }
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
    }
  }
  return out;
}

/**
 * The roots the selector offers: the repository root plus every top-level
 * directory that holds indexed files, biggest first.
 *
 * A monorepo's answer to "which project am I looking at" — and on a single
 * project it is a one-line list nobody has to use.
 */
function rootOptions(
  files: ReadonlyArray<{ path: string; symbols: number }>
): WireMapPayload['roots'] {
  const byDir = new Map<string, number>();
  for (const file of files) {
    const slash = file.path.indexOf('/');
    if (slash <= 0) continue;
    const dir = file.path.slice(0, slash);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const dirs = [...byDir]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([root, count]) => ({ root, label: root, files: count }));
  return [{ root: '', label: 'whole repository', files: files.length }, ...dirs];
}
