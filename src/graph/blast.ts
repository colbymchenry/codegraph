/**
 * Blast radius of a diff: what else in the project depends on the lines a
 * change touched.
 *
 * Seeding: a changed line seeds the innermost symbol whose span contains it;
 * the file node is the walk seed only when no symbol matched (an added file
 * with no symbols, a rename with no content change, an edit outside every
 * symbol). Seeding the file alongside symbols would pull in every importer of
 * the file for a one-line edit to one function. `import`, `export`,
 * `parameter` and `route` nodes are never seeds (`NON_SEED_KINDS` in
 * `./blast-store`).
 *
 * Walk: from each changed file's seeds, up incoming dependency edges
 * (`BLAST_WALK_KINDS`) to a depth, one batched query per level. Seeds come in
 * position order and the edges within a level in (target, kind, source) order,
 * so the relation recorded for a node reached by two edges is deterministic.
 *
 * Certainty: a dependent that no walk reaches within the depth without
 * crossing a questionable call edge (a call the resolver bound by name only,
 * `candidateEdgeSql` in `./suspects`; a same-file exact-match call is certain)
 * is marked `questionable`, and `strict` leaves such dependents out.
 *
 * Grouping: dependents are grouped by directory into modules, test-only
 * modules are split out, the changed files are folded into at most
 * `MAX_AREAS` directory areas, and each area gets a test signal (whether a test
 * file reaches its changed symbols, and whether the diff touched that test).
 * A module or area is labelled by its most-depended-on symbol (`hubLabel`).
 */
import { isTestPath } from '../search/query-utils';
import type { ChangedFile } from './git-diff';
import type { BlastStore, IncomingEdge } from './blast-store';

/**
 * Incoming edge kinds the walk follows: the dependent breaks when the target
 * changes. Not followed: `contains` and `exports` (a file contains or exports
 * everything in it, so walking either reports the whole file), and `type_of`,
 * `returns`, `overrides` and `navigates`, which would widen the reach to code
 * that names a type rather than depends on its behaviour.
 */
export const BLAST_WALK_KINDS: readonly string[] = [
  'calls', 'references', 'imports', 'implements', 'extends', 'instantiates', 'decorates',
];

export interface BlastNode {
  id: string;
  name: string;
  kind: string;
  path: string;
  /** `L<start>-L<end>`. */
  span: string;
}

export interface Seed extends BlastNode {
  /** True when the whole file is the unit of change (no symbol matched). */
  wholeFile: boolean;
}

export interface Impacted extends BlastNode {
  /** The kind of the edge the walk arrived by. */
  relation: string;
  /** Hops from the nearest seed, 1-based. */
  depth: number;
  /**
   * Set (always to true) when the walk reaches this dependent within the depth
   * only through at least one questionable call edge, from every changed file
   * that reaches it. Absent otherwise, and always absent under `strict`.
   */
  questionable?: true;
}

export interface Module {
  label: string;
  /** Where the label came from: always the module's hub symbol. */
  labelSource: 'symbol';
  key: string;
  files: string[];
  symbols: Impacted[];
  /** Changed files whose walk reached a symbol of this module. */
  from: string[];
}

export interface Area {
  label: string;
  /** Where the label came from: always the area's hub symbol. */
  labelSource: 'symbol';
  key: string;
  files: string[];
  seeds: number;
  tests: 'changed' | 'stale' | 'none' | 'na';
  testFiles: string[];
  changedTestFiles: string[];
  reached: number;
  behavioural: number;
  unreached: string[];
  seedNames: string[];
}

export interface BlastReport {
  basis: string;
  /** `Infinity` for depth "all"; JSON.stringify prints it as null. */
  depth: number;
  changed: ChangedFile[];
  unindexed: string[];
  deleted: string[];
  seeds: Seed[];
  impacted: Impacted[];
  modules: Module[];
  testModules: Module[];
  areas: Area[];
  /** Set (to true) only when the report was computed with `strict`. */
  strict?: true;
}

export interface BlastOptions {
  /** Walk only certain edges: dependents reached only through questionable call edges drop out. */
  strict?: boolean;
}

const SPAN_RE = /^L(\d+)-L(\d+)$/;

function spanBounds(span: string): { start: number; end: number } | null {
  const m = SPAN_RE.exec(span);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * The innermost symbols whose spans overlap any changed range in `path`.
 *
 * A changed line inside `Cache.get` overlaps both the class and the method;
 * seeding the class would report everyone who touches any part of `Cache`. For
 * each range, a symbol that contains another overlapping symbol is dropped.
 *
 * The containment test is non-strict, so two overlapping symbols with
 * identical spans drop each other. When that leaves the file with no symbol
 * seed from any range, the file fallback seeds the walk.
 */
function seedsForFile(store: BlastStore, path: string, ranges: ChangedFile['ranges']): BlastNode[] {
  const hit = new Map<string, BlastNode>();
  for (const r of ranges) {
    const overlapping: { node: BlastNode; start: number; end: number }[] = [];
    for (const node of store.symbolsOverlapping(path, r.start, r.end)) {
      const b = spanBounds(node.span);
      if (b) overlapping.push({ node, ...b });
    }
    for (const s of overlapping) {
      const containsAnother = overlapping.some((o) => o !== s && o.start >= s.start && o.end <= s.end);
      if (!containsAnother) hit.set(s.node.id, s.node);
    }
  }
  return [...hit.values()];
}

interface Hit {
  node: BlastNode | null;
  id: string;
  relation: string;
  depth: number;
}

/**
 * Breadth-first walk up incoming edges from `seeds`, frontier-batched: one
 * `incomingEdges` query per depth level and one `nodesByIds` for the ids that
 * level discovered.
 *
 * Runs one walk per entry of `skipQuestionable` from the same seeds, in
 * lockstep: each level's query covers the union of the walks' frontiers, so a
 * certain walk run alongside the normal one costs no extra query. A walk with
 * `skipQuestionable` true does not follow questionable call edges. The result
 * has one hit list per walk, in the same order.
 *
 * Seeds are pre-visited, so a seed is never its own hit and an edge between two
 * seeds is never reported. Each node is reported once per walk, at the depth it
 * was first reached. The visited set is also what ends a `depth = Infinity`
 * walk: the frontier empties once no unvisited node points into it.
 */
function impactOfMany(
  store: BlastStore,
  seeds: readonly BlastNode[],
  maxDepth: number,
  skipQuestionable: readonly boolean[],
): Hit[][] {
  const walks = skipQuestionable.map((skip) => ({
    skip,
    visited: new Set(seeds.map((s) => s.id)),
    hits: [] as Hit[],
    frontier: seeds.map((s) => s.id),
  }));
  for (let depth = 1; depth <= maxDepth && walks.some((w) => w.frontier.length > 0); depth++) {
    const targets = [...new Set(walks.flatMap((w) => w.frontier))];
    const byTarget = new Map<string, IncomingEdge[]>();
    for (const e of store.incomingEdges(targets, BLAST_WALK_KINDS)) {
      const at = byTarget.get(e.target);
      if (at) at.push(e);
      else byTarget.set(e.target, [e]);
    }
    const levels: Hit[][] = [];
    const discovered = new Set<string>();
    for (const w of walks) {
      const level: Hit[] = [];
      const next: string[] = [];
      for (const current of w.frontier) {
        for (const { source, kind, questionable } of byTarget.get(current) ?? []) {
          if (w.skip && questionable) continue;
          if (w.visited.has(source)) continue;
          w.visited.add(source);
          level.push({ node: null, id: source, relation: kind, depth });
          next.push(source);
          discovered.add(source);
        }
      }
      levels.push(level);
      w.frontier = next;
    }
    if (discovered.size > 0) {
      const nodes = new Map(store.nodesByIds([...discovered]).map((n) => [n.id, n]));
      for (const level of levels) for (const h of level) h.node = nodes.get(h.id) ?? null;
    }
    walks.forEach((w, i) => w.hits.push(...(levels[i] ?? [])));
  }
  return walks.map((w) => w.hits);
}

/**
 * Compute the blast radius of `changed` against the index behind `store`.
 *
 * Without `strict`, each changed file's walk runs twice in lockstep: the normal
 * walk, which follows every `BLAST_WALK_KINDS` edge, and a certain walk, which
 * skips questionable call edges. A dependent the normal walk reaches but no
 * file's certain walk reaches within the depth is marked `questionable`. With
 * `strict`, only the certain walk runs, so those dependents are left out and
 * every relation and depth comes from it.
 */
export function blastRadius(
  store: BlastStore,
  changed: ChangedFile[],
  basis: string,
  depth: number,
  opts: BlastOptions = {},
): BlastReport {
  const strict = opts.strict === true;
  const seeds: Seed[] = [];
  const unindexed: string[] = [];
  const deleted: string[] = [];
  /** Walk seeds per changed file, kept for the area grouping and the test signal. */
  const seedNodes = new Map<string, BlastNode[]>();
  /** Merged dependents at the shallowest depth any file reached them, plus which files reached them. */
  const merged = new Map<string, { hit: Impacted; from: Set<string> }>();
  /** Dependents some file's certain walk reached (non-strict only): these carry no mark. */
  const certain = new Set<string>();

  for (const file of changed) {
    if (file.status === 'deleted') {
      deleted.push(file.path);
      continue;
    }
    const fileNode = store.fileNode(file.path);
    if (!fileNode) {
      unindexed.push(file.path);
      continue;
    }
    // No hunk ranges (a rename with no content change, a mode change): the unit of change is the file.
    const symbolSeeds = file.ranges.length > 0 ? seedsForFile(store, file.path, file.ranges) : [];
    for (const node of symbolSeeds) seeds.push({ ...node, wholeFile: false });
    if (symbolSeeds.length === 0) seeds.push({ ...fileNode, wholeFile: true });

    // One walk PER CHANGED FILE, so a module's `from` names the changed files
    // that actually reach it rather than every file in the diff.
    const walkSeeds = symbolSeeds.length > 0 ? symbolSeeds : [fileNode];
    seedNodes.set(file.path, walkSeeds);
    const [reached = [], certainHits = []] = impactOfMany(store, walkSeeds, depth, strict ? [true] : [false, true]);
    for (const h of certainHits) certain.add(h.id);
    for (const h of reached) {
      // A dangling endpoint has no location to group or open.
      if (h.node === null) continue;
      const hit: Impacted = { ...h.node, relation: h.relation, depth: h.depth };
      const prev = merged.get(hit.id);
      if (!prev) merged.set(hit.id, { hit, from: new Set([file.path]) });
      else {
        prev.from.add(file.path);
        // Two hops from one changed file and one hop from another is one hop from this diff.
        if (hit.depth < prev.hit.depth) prev.hit = hit;
      }
    }
  }

  const impacted = [...merged.values()].map((m) => m.hit);
  // Marked after the merge, so a certain reach from any changed file clears the mark.
  if (!strict) for (const hit of impacted) if (!certain.has(hit.id)) hit.questionable = true;
  const origins = new Map([...merged].map(([id, m]) => [id, m.from]));
  const grouped = groupByModule(impacted, changed, origins);
  const report: BlastReport = {
    basis,
    depth,
    changed,
    unindexed,
    deleted,
    seeds,
    impacted,
    modules: grouped.modules,
    testModules: grouped.testModules,
    areas: changedAreas(store, changed, seedNodes, grouped.modules),
  };
  if (strict) report.strict = true;
  return report;
}

/**
 * Group the changed files into directory areas and work out whether each one's
 * tests moved: `changed` when a test file reaching it is in the diff, `stale`
 * when one reaches it but is not, `none` when none does, `na` when the area
 * changed no function, method or class.
 *
 * The in-degree and the test-file sources are two batched store queries over
 * the seed ids only, and do not go through `incomingEdges`: they count every
 * edge kind. Neither is filtered by `strict`: they are side counts about the
 * seeds (hub ranking and the test signal), not the walk, so a questionable call
 * edge still counts there.
 */
function changedAreas(
  store: BlastStore,
  changed: ChangedFile[],
  seedNodes: Map<string, BlastNode[]>,
  modules: Module[],
): Area[] {
  const changedTests = new Set(changed.filter((c) => isTestPath(c.path)).map((c) => c.path));

  const groups = new Map<string, string[]>();
  for (const path of seedNodes.keys()) {
    // A changed test file is the signal, not a source of blast radius.
    if (isTestPath(path)) continue;
    const dir = dirLabel(path);
    groups.set(dir, [...(groups.get(dir) ?? []), path]);
  }
  coarsen(groups, MAX_AREAS);

  const seedIds = [...new Set([...groups.values()].flat().flatMap((p) => (seedNodes.get(p) ?? []).map((n) => n.id)))];
  const inDegree = store.inDegree(seedIds);
  const incoming = new Map<string, Set<string>>();
  for (const [target, paths] of store.incomingSourcePaths(seedIds)) {
    const tests = new Set([...paths].filter((p) => isTestPath(p)));
    if (tests.size > 0) incoming.set(target, tests);
  }

  const byKey = new Map<string, Area>();
  /** Hub candidates per area, ranked once every seed has been seen. */
  const candidates = new Map<Area, { name: string; behavioural: boolean; degree: number }[]>();
  for (const [dir, paths] of groups) {
    const area: Area = {
      label: dir, labelSource: 'symbol', key: dir,
      files: [], seeds: 0, tests: 'none', testFiles: [], changedTestFiles: [],
      reached: 0, behavioural: 0, unreached: [], seedNames: [],
    };
    byKey.set(dir, area);
    for (const path of paths) {
      const nodes = seedNodes.get(path) ?? [];
      area.files.push(path);
      area.seeds += nodes.length;
      for (const node of nodes) {
        // Reach is measured over behaviour only: nothing calls a type, so counting
        // interfaces would report a fully tested area as partly unreached.
        const behavioural = node.kind === 'function' || node.kind === 'method' || node.kind === 'class';
        const from = incoming.get(node.id) ?? new Set<string>();
        for (const t of from) {
          if (!area.testFiles.includes(t)) area.testFiles.push(t);
          if (changedTests.has(t) && !area.changedTestFiles.includes(t)) area.changedTestFiles.push(t);
        }
        candidates.set(area, [
          ...(candidates.get(area) ?? []),
          { name: node.name, behavioural, degree: inDegree.get(node.id) ?? 0 },
        ]);
        if (!behavioural) continue;
        area.behavioural++;
        if (from.size > 0) area.reached++;
        else area.unreached.push(node.name);
      }
    }
  }

  for (const area of byKey.values()) {
    // The hub is the most-depended-on symbol in the area; behaviour outranks types.
    area.seedNames = (candidates.get(area) ?? [])
      .sort((a, b) => Number(b.behavioural) - Number(a.behavioural) || b.degree - a.degree || a.name.localeCompare(b.name))
      .map((c) => c.name);
    area.label = hubLabel(area.seedNames, area.key);
    area.files.sort();
    area.testFiles.sort();
    area.changedTestFiles.sort();
    area.tests =
      area.behavioural === 0 ? 'na'
        : area.changedTestFiles.length > 0 ? 'changed'
          : area.testFiles.length > 0 ? 'stale'
            : 'none';
  }

  // Ordered by how many affected modules each area reaches, then size, then label.
  const reach = (a: Area): number => modules.filter((m) => m.from.some((f) => a.files.includes(f))).length;
  return [...byKey.values()].sort(
    (a, b) => reach(b) - reach(a) || b.files.length - a.files.length || a.label.localeCompare(b.label),
  );
}

/**
 * Group dependents into directory modules. `origins` carries, per dependent, the
 * changed files whose walk reached it, so a module's `from` is the real arrow set.
 */
function groupByModule(
  impacted: Impacted[],
  changed: ChangedFile[],
  origins: Map<string, Set<string>>,
): { modules: Module[]; testModules: Module[] } {
  const changedPaths = new Set(changed.map((c) => c.path));
  const byKey = new Map<string, Module>();
  for (const hit of impacted) {
    // A dependent inside a file the diff already changes is the diff, not reach.
    // It stays in `impacted`; it is only kept out of the modules.
    if (changedPaths.has(hit.path)) continue;
    const key = dirLabel(hit.path);
    let mod = byKey.get(key);
    if (!mod) {
      mod = { label: key, labelSource: 'symbol', key, files: [], symbols: [], from: [] };
      byKey.set(key, mod);
    }
    mod.symbols.push(hit);
    if (!mod.files.includes(hit.path)) mod.files.push(hit.path);
  }
  for (const mod of byKey.values()) {
    const from = new Set<string>();
    for (const s of mod.symbols) for (const p of origins.get(s.id) ?? []) from.add(p);
    mod.from = [...from].sort();
    mod.files.sort();
    mod.symbols.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    // Shallowest symbol first after that sort, so it names the module.
    mod.label = hubLabel(mod.symbols.map((s) => s.name), mod.key);
  }
  // Test-only modules are split out, not sorted last: on a project with a test
  // per module they are most of the dependents and would crowd out the rest.
  const bySize = (a: Module, b: Module): number => b.symbols.length - a.symbols.length || a.label.localeCompare(b.label);
  const all = [...byKey.values()];
  return {
    modules: all.filter((m) => !isTestOnly(m)).sort(bySize),
    testModules: all.filter(isTestOnly).sort(bySize),
  };
}

/** Directory groups the diff is folded to: roughly what a reviewer holds in their head. */
const MAX_AREAS = 5;

/**
 * Fold directory groups into their parents until there are at most `max`.
 *
 * The deepest group goes first, into a parent that already exists when one
 * does; otherwise a parent is created, but never at the top level, since a
 * single `(root)` area is no grouping at all.
 */
function coarsen(groups: Map<string, string[]>, max: number): void {
  const depthOf = (dir: string): number => dir.split('/').length;
  while (groups.size > max) {
    const keys = [...groups.keys()].sort(
      (a, b) => depthOf(b) - depthOf(a) || groups.get(a)!.length - groups.get(b)!.length,
    );
    const pick =
      keys.find((k) => groups.has(parentDir(k)) && parentDir(k) !== '') ??
      keys.find((k) => parentDir(k) !== '');
    if (!pick) return;
    const parent = parentDir(pick);
    groups.set(parent, [...(groups.get(parent) ?? []), ...groups.get(pick)!]);
    groups.delete(pick);
  }
}

/** True when every file in the module is a test file. */
function isTestOnly(mod: Module): boolean {
  return mod.files.length > 0 && mod.files.every((f) => isTestPath(f));
}

/** Longest label before shortLabel cuts it. */
const MAX_LABEL = 30;

/** Clause breaks a long name can be cut at without an ellipsis. */
const CLAUSE_BREAK = /\s(?:\(|—|-\s)|:\s|\s(?:via|and|for|with|using|in|across|over|from|of|by|to)\s/i;

/** A name trimmed to fit a table cell: cut at a clause break, else at a word boundary with an ellipsis. */
export function shortLabel(label: string): string {
  const bare = label.trim();
  if (bare.length <= MAX_LABEL) return bare;
  const at = CLAUSE_BREAK.exec(bare);
  // A break before character 8 would leave a stub, past MAX_LABEL would not fit.
  if (at && at.index >= 8 && at.index <= MAX_LABEL) return bare.slice(0, at.index).trimEnd();
  const cut = bare.lastIndexOf(' ', MAX_LABEL);
  return `${bare.slice(0, cut > MAX_LABEL / 2 ? cut : MAX_LABEL).trimEnd()}…`;
}

/** The parent directory of a directory label, or "" at the top level. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/\/$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? '' : `${trimmed.slice(0, cut)}/`;
}

/** The file's directory with a trailing "/", or `(root)` for a top-level file. */
export function dirLabel(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '(root)' : path.slice(0, cut) + '/';
}

/** The first non-empty name, shortened; the fallback key when there is none. */
export function hubLabel(names: readonly string[], fallback: string): string {
  const [head] = names.filter(Boolean);
  return head ? shortLabel(head) : fallback;
}
