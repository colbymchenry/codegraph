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
  /**
   * What a change in here reaches: files OUTSIDE this module holding a direct,
   * confident reference into one of its files, and how many modules those
   * files span.
   *
   * DIRECT, deliberately. The transitive closure was measured first and it is
   * useless on a real repository: any dependency cycle — and a mobile app had
   * nine mutual pairs — saturates it, so every module comes out reaching
   * nearly every file (139–282 of 377, a flat 2× spread that says nothing but
   * "this repo has cycles"). The direct count on the same repository spreads
   * 0–127 and names the modules a reader would name by hand: the shared types
   * at the top, the CLI at zero.
   *
   * The counts are FILES, not symbols: a module is a set of files, and "94
   * files would have to be re-read if this changed" is a claim the index can
   * stand behind. It is a floor on blast radius, not the whole of it — a
   * symbol-level answer for one symbol is what the Symbol view is for.
   */
  dependents: { files: number; modules: number };
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

/**
 * A box holding more than this share of the mapped symbols IS the program, and
 * a map whose subject is one box has not said anything.
 */
const DOMINANT_SHARE = 0.4;

/**
 * …but only if there is something inside it. A dominant box of four files is a
 * small project honestly drawn; opening it just spreads four files over four
 * boxes. This is the line between "grouped too coarsely" and "actually small".
 */
const DOMINANT_MIN_FILES = 25;

/** Fewer boxes than this is a list, not a picture. */
const MIN_MODULES = 4;

/** More than this and a deeper grouping has traded one unreadable map for another. */
const MAX_MODULES = 60;

/** The non-test modules a given depth would draw, and how concentrated they are. */
function tallyModules(
  files: ReadonlyArray<{ path: string; symbols: number; test: boolean }>,
  root: string,
  depth: number
): { count: number; share: number; largestFiles: number } {
  const byModule = new Map<string, { symbols: number; files: number }>();
  let total = 0;
  for (const file of files) {
    if (file.test) continue;
    const assigned = moduleIdFor(file.path, root, depth);
    if (assigned === null) continue;
    let entry = byModule.get(assigned.id);
    if (!entry) byModule.set(assigned.id, (entry = { symbols: 0, files: 0 }));
    entry.symbols += file.symbols;
    entry.files += 1;
    total += file.symbols;
  }
  let largest = { symbols: 0, files: 0 };
  for (const entry of byModule.values()) {
    if (entry.symbols > largest.symbols) largest = entry;
  }
  return {
    count: byModule.size,
    share: total === 0 ? 0 : largest.symbols / total,
    largestFiles: largest.files,
  };
}

/**
 * How many segments name a module, when the reader has not said.
 *
 * Depth is not a property of the reader's taste, it is a property of the
 * repository: one level under the root is the right grouping for a project
 * whose directories ARE its modules, and the wrong one for the very common
 * shape where every line of the program lives under a single `src/`. Drawing
 * that project at depth 1 produces the map this rule exists to prevent — a box
 * labelled `src`, holding two thirds of the code, with nothing to say about it.
 *
 * So: take the shallowest depth that is neither dominated by one box worth
 * opening nor too small to be a picture; stop before a deeper one becomes a
 * crowd; and never go past the last level the directory tree actually has.
 *
 * The walk does NOT stop at the first depth that fails to add boxes. A repo
 * packaged as `frontend/src/...` plateaus at two boxes for two levels running
 * before the third splits it, and a rule that gave up on the plateau would
 * draw exactly the picture this function exists to avoid.
 */
export function pickDefaultDepth(
  files: ReadonlyArray<{ path: string; symbols: number; test: boolean }>,
  root: string
): number {
  // Past the deepest directory, a bigger number only renames boxes to
  // `src/a/(root files)`. There is nothing below the leaves.
  let deepest = DEFAULT_DEPTH;
  for (const file of files) {
    if (file.test) continue;
    const path = toPosixPath(file.path);
    if (root && !path.startsWith(`${root}/`)) continue;
    const rel = root ? path.slice(root.length + 1) : path;
    deepest = Math.max(deepest, rel.split('/').filter(Boolean).length - 1);
  }

  let fallback = DEFAULT_DEPTH;
  let fallbackCount = 0;
  for (let depth = DEFAULT_DEPTH; depth <= Math.min(MAX_DEPTH, deepest); depth += 1) {
    const tally = tallyModules(files, root, depth);
    if (tally.count === 0) break;
    // Deeper only gets more crowded from here.
    if (tally.count > MAX_MODULES) break;
    const dominated = tally.share > DOMINANT_SHARE && tally.largestFiles >= DOMINANT_MIN_FILES;
    if (tally.count >= MIN_MODULES && !dominated) return depth;
    // Not a picture yet. Worth keeping only if it drew more than the last one:
    // a deeper grouping that splits nothing is the same map with longer labels.
    if (tally.count > fallbackCount) {
      fallback = depth;
      fallbackCount = tally.count;
    }
  }
  return fallback;
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

/**
 * `null` for either field means "nobody said" — the answer picks. Absence has
 * to survive parsing: a depth defaulted to 1 here is indistinguishable from a
 * reader who asked for 1, and {@link pickDefaultDepth} would never run.
 */
export function parseMapQuery(query: URLSearchParams): {
  root: string | null;
  depth: number | null;
} {
  const rawDepth = query.get('depth');
  let depth: number | null = null;
  if (rawDepth !== null && rawDepth !== '') {
    depth = Number.parseInt(rawDepth, 10);
    if (!Number.isFinite(depth) || depth < 1 || depth > MAX_DEPTH) {
      throw badRequest(`depth must be a whole number from 1 to ${MAX_DEPTH}.`);
    }
  }
  const rawRoot = query.get('root');
  return { root: rawRoot === null ? null : normalizeRoot(rawRoot), depth };
}

/**
 * Rename `x/(root files)` to `x` wherever the bucket is all `x` has.
 *
 * The bucket earns its name only when it stands beside something: `src` holding
 * both `src/api` and three loose files needs a box for the loose ones, and that
 * box has to say it is not the whole of `src`. But a `backend/controllers` with
 * no subdirectories in it is not a directory with a bucket in it — it IS the
 * directory, and drawing it as `backend/controllers/(root files)` names a thing
 * the repository does not have. Deeper groupings hit this constantly (every
 * leaf directory becomes a bucket), which is what makes it worth a pass.
 *
 * Returns only the ids that move, so a caller can leave the rest alone.
 */
function collapseLoneRootFiles(ids: ReadonlySet<string>): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const id of ids) {
    const cut = id.lastIndexOf('/(root files)');
    // A bucket at the very top (`(root files)`) has no directory to become.
    if (cut <= 0 || cut + '/(root files)'.length !== id.length) continue;
    const dir = id.slice(0, cut);
    let alone = true;
    for (const other of ids) {
      // A façade counts: `src/utils` beside `src/utils/index.tsx` would read as
      // if the box contained the file drawn next to it.
      if (other !== id && other.startsWith(`${dir}/`)) {
        alone = false;
        break;
      }
    }
    // `dir` can only already be a module if something lives BELOW it, which is
    // exactly the case `alone` just ruled out — so this rename cannot collide.
    if (alone) renamed.set(id, dir);
  }
  return renamed;
}

export function buildMap(cg: CodeGraph, projectRoot: string, query: URLSearchParams): WireMapPayload {
  const started = Date.now();
  const { root: requestedRoot, depth: requestedDepth } = parseMapQuery(query);

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
  // Root first, then depth against THAT root: how finely to cut depends on
  // what is being cut. Choosing `src` and then asking for one level under it
  // is the same question as choosing the whole project and asking for two.
  const depth = requestedDepth ?? pickDefaultDepth(fileRecords, root);
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

  const assigned = new Map<string, { id: string; facade: boolean }>();
  for (const file of fileRecords) {
    const at = moduleIdFor(file.path, root, depth);
    if (at !== null) assigned.set(file.path, at);
  }
  const renamed = collapseLoneRootFiles(new Set([...assigned.values()].map((a) => a.id)));

  for (const file of fileRecords) {
    const at = assigned.get(file.path);
    if (at === undefined) continue;
    const id = renamed.get(at.id) ?? at.id;
    assignments.push({ filePath: file.path, module: id });
    moduleOfFile.set(file.path, id);
    let entry = modules.get(id);
    if (!entry) {
      entry = {
        id,
        facade: at.facade,
        files: 0,
        symbols: 0,
        testFiles: 0,
        generatedFiles: 0,
        generatedPaths: new Set(),
        languages: new Map(),
        paths: [],
      };
      modules.set(id, entry);
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

  // ONE fetch of the file edge list, read twice: the cycle finder and the
  // dependent counts are both questions about it, and it is the expensive query
  // on this screen.
  const filePairs = cg.getFileDependencyPairs(UNCERTAIN_BELOW);
  const dependents = countDependents(filePairs, moduleOfFile);

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
          dependents: dependents.get(entry.id) ?? { files: 0, modules: 0 },
        };
      })
      // Sorted so two runs over one index produce byte-identical payloads —
      // the layout is deterministic, and it cannot be if its input is not.
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: [...links.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    ),
    cycles: fileCycles(filePairs, moduleOfFile),
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
 * Per module: how many files outside it reference into it, and across how many
 * modules those files sit.
 *
 * One pass over the edge list. A pair whose two ends land in the same module is
 * internal cohesion, not blast radius, and is skipped; a pair touching a file
 * outside the chosen root has no module and is skipped too. The `Set` per
 * module is what makes the count DISTINCT FILES rather than distinct
 * references — twelve calls from one file are one file that has to be re-read.
 */
function countDependents(
  pairs: ReadonlyArray<{ source: string; target: string }>,
  moduleOfFile: Map<string, string>
): Map<string, { files: number; modules: number }> {
  const incoming = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const from = moduleOfFile.get(pair.source);
    const to = moduleOfFile.get(pair.target);
    if (from === undefined || to === undefined || from === to) continue;
    let seen = incoming.get(to);
    if (!seen) incoming.set(to, (seen = new Set()));
    seen.add(pair.source);
  }
  const out = new Map<string, { files: number; modules: number }>();
  for (const [module, files] of incoming) {
    const modules = new Set<string>();
    for (const file of files) modules.add(moduleOfFile.get(file)!);
    out.set(module, { files: files.size, modules: modules.size });
  }
  return out;
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
  pairs: ReadonlyArray<{ source: string; target: string }>,
  moduleOfFile: Map<string, string>
): WireMapPayload['cycles'] {
  const adjacency = new Map<string, string[]>();
  for (const pair of pairs) {
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
