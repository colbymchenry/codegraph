/**
 * Call sites as SCIP resolves them, keyed so they line up with codegraph's own
 * edges: (caller node, 1-based line, callee name, edge kind).
 *
 * codegraph's edge `col` is where the call EXPRESSION starts (`this.step()` →
 * the `this`), SCIP's range is the callee NAME, so the column can't be part of
 * the key — two same-named calls on one line collapse into one site, which the
 * merge treats identically anyway.
 */

import type { SqliteDatabase } from '../db/sqlite-adapter';
import { INDEXERS } from './indexers';
import { ParsedSymbol, ROLE_DEFINITION, ScipDocument, ScipOccurrence, parseSymbol } from './reader';
import type { ScipLanguage } from './store';
import { LiteralShape, callShape } from './syntax';

export type SiteKind = 'calls' | 'instantiates';

/** A call SCIP resolved to something outside the project (stdlib, dependency). */
export const EXTERNAL = '<external>';

/**
 * Edges the merge may verify, replace or flag: codegraph's tree-sitter-resolved
 * ones. Synthesized dynamic-dispatch edges (`provenance='heuristic'`) are
 * bridges SCIP can't see, so they are never candidates.
 */
export const HEURISTIC_PROVENANCE = "(provenance IS NULL OR provenance = 'tree-sitter')";

const CALLABLE_KINDS: readonly string[] = ['function', 'method'];
const TYPE_KINDS: readonly string[] = ['class', 'struct'];
/**
 * What a called `term` (a value) may be: a function-valued binding codegraph
 * extracted as a function, or one it keeps as a constant/variable — `export
 * const expect: Expect` — which its own edges already use as a call target.
 */
const CALLED_VALUE_KINDS: readonly string[] = [...CALLABLE_KINDS, 'constant', 'variable'];
/**
 * Non-callable nodes codegraph uses as the caller of code that runs outside any
 * function — class bodies, initializers, top-level statements (the non-callable
 * source kinds its own call edges carry). With none enclosing a call, the file is the caller.
 */
const CONTAINER_KINDS: readonly string[] = ['class', 'struct', 'constant', 'variable', 'component', 'field', 'property'];

/** SCIP spells constructors differently from the node codegraph extracts for them. */
const CONSTRUCTOR_NAMES: Record<string, string> = { '<constructor>': 'constructor' };

export function siteKey(source: string, line: number, name: string, kind: SiteKind): string {
  return `${source}\0${line}\0${name}\0${kind}`;
}

export function parseSiteKey(key: string): { source: string; line: number; name: string; kind: SiteKind } {
  const [source, line, name, kind] = key.split('\0');
  return { source: source!, line: Number(line), name: name!, kind: kind as SiteKind };
}

export interface SiteTarget {
  /** node id, or EXTERNAL */
  target: string;
  /** 0-based column of the callee name, for inserted edges */
  col: number;
}

export interface ScipSites {
  /** site key → resolved targets */
  sites: Map<string, Map<string, SiteTarget>>;
  /** sites SCIP saw but couldn't judge (target defined in the project, yet unmapped or stale) */
  unknown: Set<string>;
  stats: Record<string, number>;
}

interface NodeRow {
  id: string; kind: string; name: string; qualified_name: string;
  start_line: number; end_line: number; start_column: number; end_column: number;
}

/** (1-based line, 0-based column) — codegraph's node coordinates. */
type Pos = [number, number];
const startOf = (n: NodeRow): Pos => [n.start_line, n.start_column];
const endOf = (n: NodeRow): Pos => [n.end_line, n.end_column];
const before = (a: Pos, b: Pos) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
const size = (n: NodeRow) => (n.end_line - n.start_line) * 1_000_000 + (n.end_column - n.start_column);

interface FileIndex {
  byName: Map<string, NodeRow[]>;
  /** callables + containers covering each 1-based line, built on first use */
  byLine?: NodeRow[][];
  rows: NodeRow[];
  file: string | null;
}

/**
 * The nodes of each fresh file, loaded in one query, answering both questions
 * the merge asks of them. Lookups go through per-file indexes (by name, by
 * line) — a large repo has hundreds of thousands of call sites, and scanning a
 * file's every node per site was most of the merge.
 */
class FileNodes {
  private byFile = new Map<string, FileIndex>();

  constructor(db: SqliteDatabase, files: Set<string>) {
    const kinds = [...new Set([...CALLABLE_KINDS, ...TYPE_KINDS, ...CONTAINER_KINDS, 'file'])];
    const rows = db.prepare(
      `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, start_column, end_column FROM nodes
       WHERE kind IN (${kinds.map(() => '?').join(',')})`
    ).all(...kinds) as Array<NodeRow & { file_path: string }>;
    for (const r of rows) {
      if (!files.has(r.file_path)) continue;
      let f = this.byFile.get(r.file_path);
      if (!f) this.byFile.set(r.file_path, (f = { byName: new Map(), rows: [], file: null }));
      if (r.kind === 'file') {
        f.file = r.id;
        continue;
      }
      f.rows.push(r);
      const named = f.byName.get(r.name);
      if (named) named.push(r);
      else f.byName.set(r.name, [r]);
    }
  }

  /** The node a SCIP definition names: same file, same name, its (0-based) line inside the node. */
  definition(file: string, line0: number, name: string, kinds: readonly string[]): NodeRow | null {
    const line = line0 + 1;
    let best: NodeRow | null = null;
    for (const n of this.byFile.get(file)?.byName.get(name) ?? []) {
      if (!kinds.includes(n.kind) || n.start_line > line || n.end_line < line) continue;
      if (!best || size(n) < size(best)) best = n;
    }
    return best;
  }

  private lines(f: FileIndex): NodeRow[][] {
    if (f.byLine) return f.byLine;
    const byLine: NodeRow[][] = [];
    for (const n of f.rows) {
      if (!CALLABLE_KINDS.includes(n.kind) && !CONTAINER_KINDS.includes(n.kind)) continue;
      for (let l = n.start_line; l <= n.end_line; l++) (byLine[l] ??= []).push(n);
    }
    return (f.byLine = byLine);
  }

  /**
   * Who calls from a position — from codegraph's OWN spans, not SCIP's ranges,
   * so both sides key a call site by the same caller. (SCIP's definition range
   * includes decorators, while codegraph's function node starts at `def`; and a
   * callback codegraph extracted as a function has no SCIP definition at all.)
   * Narrowest function/method — unless a container nested inside it (a class
   * defined in a method) is narrower — else narrowest container, else the file.
   */
  callerAt(file: string, line0: number, col: number): { id: string; inFunction: boolean } | null {
    const f = this.byFile.get(file);
    if (!f) return null;
    const at: Pos = [line0 + 1, col];
    let fn: NodeRow | null = null;
    let holder: NodeRow | null = null;
    for (const n of this.lines(f)[line0 + 1] ?? []) {
      if (before(at, startOf(n)) || !before(at, endOf(n))) continue; // [start, end) — end column is exclusive
      if (CALLABLE_KINDS.includes(n.kind) && (!fn || size(n) < size(fn))) fn = n;
      if (CONTAINER_KINDS.includes(n.kind) && (!holder || size(n) < size(holder))) holder = n;
    }
    const nested = fn && holder && !before(startOf(holder), startOf(fn)) && !before(endOf(fn), endOf(holder));
    if (fn && !nested) return { id: fn.id, inFunction: true };
    const id = holder?.id ?? f.file;
    return id ? { id, inFunction: false } : null;
  }
}

/**
 * Every call/instantiation SCIP resolved in a fresh document.
 *
 * `fresh` holds the paths whose SCIP document matches codegraph's view of the
 * file (hash gate) with their source lines; documents outside it still
 * contribute to `projectSymbols` so a call INTO a stale file reads as unknown,
 * never as external.
 */
export function scipSites(
  db: SqliteDatabase, indexes: Array<{ lang: ScipLanguage; docs: ScipDocument[] }>, fresh: Map<string, string[]>
): ScipSites {
  const stats: Record<string, number> = {};
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const nodes = new FileNodes(db, new Set(fresh.keys()));
  const symToNode = new Map<string, NodeRow>();
  const projectSymbols = new Set<string>();
  const ambiguous = new Set<string>();
  // Symbols repeat at every occurrence; parse each once.
  const parsedCache = new Map<string, ParsedSymbol | null>();
  const parse = (symbol: string) => {
    let p = parsedCache.get(symbol);
    if (p === undefined) parsedCache.set(symbol, (p = parseSymbol(symbol)));
    return p;
  };

  // Pass 1: definitions → nodes, across all docs so cross-file targets resolve.
  for (const { docs } of indexes) {
    for (const doc of docs) {
      const known = fresh.has(doc.relativePath);
      for (const o of doc.occurrences) {
        if (!(o.roles & ROLE_DEFINITION)) continue;
        const parsed = parse(o.symbol);
        if (!parsed) continue;
        projectSymbols.add(o.symbol);
        const { name, kind } = parsed.last;
        if (!known || (kind !== 'method' && kind !== 'term' && kind !== 'type')) continue;
        const node = nodes.definition(doc.relativePath, o.range.startLine, CONSTRUCTOR_NAMES[name] ?? name,
          kind === 'type' ? TYPE_KINDS : kind === 'term' ? CALLED_VALUE_KINDS : CALLABLE_KINDS);
        const first = symToNode.get(o.symbol);
        if (node && first) {
          // One symbol defined more than once. An overload — a node per signature,
          // all one qualified name — maps to the first, like the heuristic. Distinct
          // functions sharing a symbol (rust-analyzer names every nested `fn imp` in
          // a module alike) can't be told apart: the symbol stays unjudged.
          if (node.qualified_name !== first.qualified_name) ambiguous.add(o.symbol);
        } else if (node) {
          symToNode.set(o.symbol, node);
          bump('def_mapped');
        } else if (kind !== 'term') {
          bump('def_unmapped'); // an unmapped `term` is a value codegraph has no node for (a parameter, a field, …)
        }
      }
    }
  }

  for (const s of ambiguous) symToNode.delete(s); // still a project symbol: its calls read as unknown
  stats.def_ambiguous = ambiguous.size;

  // Pass 2: references that are calls, keyed by the caller codegraph would name.
  const sites = new Map<string, Map<string, SiteTarget>>();
  const unknown = new Set<string>();
  for (const { lang, docs } of indexes) {
    const literal = INDEXERS[lang].literalShape;
    for (const doc of docs) {
      const lines = fresh.get(doc.relativePath);
      if (!lines) continue;
      for (const o of doc.occurrences) {
        if (o.roles & ROLE_DEFINITION) continue;
        const call = classify(o, doc.positionEncoding, lines, literal, symToNode, parse);
        if (!call) continue;
        const { startLine, startCol } = o.range;
        const caller = nodes.callerAt(doc.relativePath, startLine, startCol);
        if (!caller) continue;
        if (!caller.inFunction) bump('call_outside_functions');
        const key = siteKey(caller.id, startLine + 1, call.name, call.kind);
        if (call.target !== null) {
          addTarget(sites, key, call.target, startCol);
          bump(`${call.kind}_resolved`);
        } else if (projectSymbols.has(call.symbol)) {
          unknown.add(key);
          bump('call_unknown');
        } else {
          addTarget(sites, key, EXTERNAL, startCol);
          bump('call_external');
        }
      }
    }
  }
  // A site SCIP resolved at all is judged; "unknown" only matters where it resolved nothing.
  for (const k of sites.keys()) unknown.delete(k);
  return { sites, unknown, stats };
}

function addTarget(sites: Map<string, Map<string, SiteTarget>>, key: string, target: string, col: number): void {
  let m = sites.get(key);
  if (!m) sites.set(key, (m = new Map()));
  if (!m.has(target)) m.set(target, { target, col });
}

interface Call {
  kind: SiteKind;
  /** callee name as codegraph's edge target would carry it */
  name: string;
  /** node id, or null when the symbol has no node */
  target: string | null;
  /** the symbol the target was looked up by */
  symbol: string;
}

function classify(
  o: ScipOccurrence, encoding: number, lines: string[], literal: LiteralShape | undefined,
  symToNode: Map<string, NodeRow>, parse: (symbol: string) => ParsedSymbol | null
): Call | null {
  const parsed = parse(o.symbol);
  if (!parsed) return null;
  const { name, kind } = parsed.last;
  if (kind !== 'type' && kind !== 'method' && kind !== 'term') return null; // before the (costlier) text check
  const shape = callShape(o, encoding, lines, literal);

  if (kind === 'type') {
    if (!shape) return null; // Foo(…), new Foo, Foo{…}
    const node = symToNode.get(o.symbol);
    return { kind: 'instantiates', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  }
  if (shape !== 'call') return null;
  if (kind === 'method' && name === '<constructor>') {
    const cls = symToNode.get(parsed.owner);
    return { kind: 'instantiates', name: cls?.name ?? parse(parsed.owner)?.last.name ?? name, target: cls?.id ?? null, symbol: parsed.owner };
  }
  const node = symToNode.get(o.symbol);
  if (kind === 'method') return { kind: 'calls', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  // A called `term` is a function-valued binding (`const f = () => …`, `const expect: Expect`, a Go interface method) — judged only when it maps to a node.
  if (kind === 'term' && node) return { kind: 'calls', name: node.name, target: node.id, symbol: o.symbol };
  return null;
}

/** codegraph's own edges at the same kind of site, for callers in `files`. */
/** site key → target node id → ids of the heuristic edges joining them (several when only `col` differs) */
export type HeuristicSites = Map<string, Map<string, number[]>>;

/**
 * codegraph's own edges at the same kind of site, for callers in `files`.
 * Per file on purpose: through the file_path and source indexes this reads only
 * the fresh files' edges (measured faster than one scan joining every edge).
 */
export function heuristicSites(db: SqliteDatabase, files: Iterable<string>): HeuristicSites {
  const stmt = db.prepare(`
    SELECT e.id, e.source, e.line, e.kind, t.name, e.target
    FROM nodes s
    JOIN edges e ON e.source = s.id
    JOIN nodes t ON t.id = e.target
    WHERE s.file_path = ? AND e.kind IN ('calls', 'instantiates') AND e.line IS NOT NULL
      AND ${HEURISTIC_PROVENANCE} -- unambiguous: only edges have a provenance column
  `);
  const out: HeuristicSites = new Map();
  for (const f of files) {
    for (const r of stmt.all(f) as { id: number; source: string; line: number; kind: SiteKind; name: string; target: string }[]) {
      const key = siteKey(r.source, r.line, r.name, r.kind);
      let targets = out.get(key);
      if (!targets) out.set(key, (targets = new Map()));
      const ids = targets.get(r.target);
      if (ids) ids.push(r.id);
      else targets.set(r.target, [r.id]);
    }
  }
  return out;
}
