/**
 * Dependency boundaries and module cycles, derived from the index — nothing here is persisted.
 *
 * Both answers come from the same material: file-level dependencies already resolved into the graph
 * (`calls`, `imports`, `references`, `instantiates`, `extends`, `implements`, `navigates`), rolled
 * up to modules with {@link moduleIdFor}. `contains` is absent because a file containing its own
 * symbols is not a dependency.
 *
 * The report is read-only on purpose. Writing violation edges into the graph would mean a new edge
 * kind, and `EDGE_KINDS` is the native kernel's wire contract (`src/types.ts`): appending to it
 * carries a schema/migration cost the report does not need, since the answer is cheap to recompute
 * and always reflects the current index.
 */
import type { EdgeKind } from '../types';
import { tarjan } from './scc';

/**
 * The edge kinds that count as "module A reaches into module B".
 *
 * Shared with the viewer's map: `MAP_EDGE_KINDS` re-exports this list, so the report and the map
 * cannot drift into counting different relationships.
 */
export const MODULE_DEPENDENCY_EDGE_KINDS: readonly EdgeKind[] = [
  'calls',
  'imports',
  'references',
  'instantiates',
  'extends',
  'implements',
  'navigates',
];

export interface ArchitectureBoundaryRule {
  /** Module id or directory prefix the dependency starts in. */
  from: string;
  /** Module id or directory prefix it must not reach. */
  to: string;
  reason?: string;
}

/** One (source module, target module) total, with the per-kind links folded together. */
export interface ModuleDependency {
  source: string;
  target: string;
  count: number;
  declared: number;
  uncertain: number;
}

/** A declared rule that an existing module dependency violates. */
export interface BoundaryViolation {
  rule: ArchitectureBoundaryRule;
  source: string;
  target: string;
  count: number;
  /** How many of `count` came from something the source writes down. */
  declared: number;
}

/** One module cycle: the modules in the component, and the files that link them. */
export interface ModuleCycle {
  size: number;
  modules: string[];
  /** Files behind the module edges inside this cycle, capped by `maxCycleLength`. */
  files: string[];
  filesTotal: number;
}

export interface ModuleCycleReport {
  total: number;
  shown: number;
  truncated: boolean;
  items: ModuleCycle[];
}

/** A module path and a rule path match when they are equal or the rule is an ancestor directory. */
function matchesModule(id: string, rulePath: string): boolean {
  return id === rulePath || id.startsWith(`${rulePath}/`);
}

/**
 * Fold the per-kind link totals into one entry per module pair.
 *
 * `aggregateModuleGraph` returns one row per (source, target, kind); a boundary is about the pair,
 * so `calls` and `imports` from `src/graph` to `src/bin` are one violation, not two.
 */
export function foldModuleDependencies(
  links: ReadonlyArray<{ source: string; target: string; count: number; declared: number; uncertain: number }>
): ModuleDependency[] {
  const SEP = '\u0000';
  const byPair = new Map<string, ModuleDependency>();
  for (const link of links) {
    const key = `${link.source}${SEP}${link.target}`;
    const entry = byPair.get(key);
    if (entry) {
      entry.count += link.count;
      entry.declared += link.declared;
      entry.uncertain += link.uncertain;
    } else {
      byPair.set(key, {
        source: link.source,
        target: link.target,
        count: link.count,
        declared: link.declared,
        uncertain: link.uncertain,
      });
    }
  }
  return [...byPair.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
  );
}

/**
 * Which rules the current dependencies violate.
 *
 * `requireDeclared` (the default) drops pairs whose edges are all bare name matches: `run`, `push`
 * and `finish` resolve across unrelated directories, and a boundary report that fires on those is
 * not a report anybody can act on. The dropped pairs stay visible in the caller's summary as
 * `uncertain`, so the exclusion is stated rather than silent.
 */
export function matchBoundaryRules(
  links: ReadonlyArray<{ source: string; target: string; count: number; declared: number; uncertain: number }>,
  rules: readonly ArchitectureBoundaryRule[],
  options: { requireDeclared?: boolean } = {}
): BoundaryViolation[] {
  if (rules.length === 0) return [];
  const requireDeclared = options.requireDeclared ?? true;
  const dependencies = foldModuleDependencies(links);
  const violations: BoundaryViolation[] = [];
  for (const rule of rules) {
    for (const dependency of dependencies) {
      if (!matchesModule(dependency.source, rule.from) || !matchesModule(dependency.target, rule.to)) continue;
      if (requireDeclared && dependency.declared === 0) continue;
      violations.push({
        rule,
        source: dependency.source,
        target: dependency.target,
        count: dependency.count,
        declared: dependency.declared,
      });
    }
  }
  return violations.sort(
    (a, b) =>
      a.rule.from.localeCompare(b.rule.from) ||
      a.rule.to.localeCompare(b.rule.to) ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target)
  );
}

/**
 * Module-level cycles as the strongly connected components of the module dependency graph.
 *
 * File pairs are rolled up first: a cycle between two modules is worth reporting, while the same
 * cycle spelled out across thirty files is not. Components of size 1 are not cycles, and the
 * reported `files` are the files behind the edges *inside* the component — evidence a reader can
 * open, not the whole module's file list.
 */
export function moduleCycles(
  pairs: ReadonlyArray<{ source: string; target: string }>,
  moduleOfFile: ReadonlyMap<string, string>,
  options: { maxCycles?: number; maxCycleLength?: number } = {}
): ModuleCycleReport {
  const maxCycles = options.maxCycles ?? 40;
  const maxCycleLength = options.maxCycleLength ?? 12;
  const SEP = '\u0000';

  const filesByModuleEdge = new Map<string, Set<string>>();
  const adjacency = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const from = moduleOfFile.get(pair.source);
    const to = moduleOfFile.get(pair.target);
    if (from === undefined || to === undefined || from === to) continue;
    let files = filesByModuleEdge.get(`${from}${SEP}${to}`);
    if (!files) filesByModuleEdge.set(`${from}${SEP}${to}`, (files = new Set()));
    files.add(pair.source);
    let targets = adjacency.get(from);
    if (!targets) adjacency.set(from, (targets = new Set()));
    targets.add(to);
  }

  // Deterministic iteration: the pair list order is not a contract.
  const nodes = [...adjacency.keys()].sort();
  const components = tarjan(nodes, (id) => [...(adjacency.get(id) ?? [])].sort());
  const cycles = components
    .filter((component) => component.length > 1)
    .map((component) => component.slice().sort())
    .sort((a, b) => a.length - b.length || (a[0] ?? '').localeCompare(b[0] ?? ''));

  const items = cycles.slice(0, maxCycles).map((modules) => {
    const inCycle = new Set(modules);
    const files = new Set<string>();
    for (const [key, edgeFiles] of filesByModuleEdge) {
      const [from, to] = key.split(SEP);
      if (from === undefined || to === undefined) continue;
      if (!inCycle.has(from) || !inCycle.has(to)) continue;
      for (const file of edgeFiles) files.add(file);
    }
    const sorted = [...files].sort();
    return {
      size: modules.length,
      modules,
      files: sorted.slice(0, maxCycleLength),
      filesTotal: sorted.length,
    };
  });

  return {
    total: cycles.length,
    shown: items.length,
    truncated: cycles.length > items.length,
    items,
  };
}
