/**
 * Call sites as SCIP resolves them, and codegraph's own edges at the same sites,
 * keyed alike (site.ts).
 */

import type { SqliteDatabase, SqliteStatement } from '../db/sqlite-adapter';
import { INDEXERS } from './indexers';
import { ParsedSymbol, ROLE_DEFINITION, ScipDocument, ScipOccurrence, parseSymbol } from './reader';
import type { ScipLanguage } from './store';
import { callSiteKey, edgeSiteKey, referenceKey, siteKey } from './site';
import { CallShape, ImplHeader, LiteralShape, SiteKind, callShape, implTypes, isCallTarget, siteKind } from './syntax';

/** A call SCIP resolved to something outside the project (stdlib, dependency). */
export const EXTERNAL = '<external>';

/**
 * Edges the merge may verify, replace or flag: codegraph's tree-sitter-resolved
 * ones. Synthesized dynamic-dispatch edges (`provenance='heuristic'`) are
 * bridges SCIP can't see, so they are never candidates.
 */
const HEURISTIC_PROVENANCE = "(provenance IS NULL OR provenance = 'tree-sitter')";

const CALLABLE_KINDS: readonly string[] = ['function', 'method'];
const TYPE_KINDS: readonly string[] = ['class', 'struct', 'interface', 'trait'];
/** A type nested in a type: also an enum variant (rust-analyzer names `Result::Ok` `Result#Ok#`). */
const NESTED_TYPE_KINDS: readonly string[] = [...TYPE_KINDS, 'enum_member'];
const INTERFACE_KINDS: readonly string[] = ['interface', 'trait'];
/** What a `references` edge may point at, by SCIP descriptor: a type (also an alias or enum), a member, a value. */
const REFERENCED_TYPE_KINDS: readonly string[] = [...TYPE_KINDS, 'type_alias', 'enum', 'union'];

/** codegraph's label for a type → base edge: a class/struct implements an interface/trait, anything else extends. */
function inheritanceKind(sourceKind: string, targetKind: string): 'implements' | 'extends' {
  return INTERFACE_KINDS.includes(targetKind) && !INTERFACE_KINDS.includes(sourceKind) ? 'implements' : 'extends';
}

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
const CONSTRUCTOR_NAMES = new Map([['<constructor>', 'constructor']]); // a Map: a plain object would answer `toString` too
const REFERENCED_METHOD_KINDS: readonly string[] = [...CALLABLE_KINDS, 'property'];
const REFERENCED_VALUE_KINDS: readonly string[] = [...CALLED_VALUE_KINDS, 'property', 'field', 'enum_member'];

/** codegraph's `references` sites: file → 1-based line → the names referenced there. */
export type ReferenceSites = Map<string, Map<number, Set<string>>>;

function toReferenceSites(rows: unknown[]): ReferenceSites {
  const out: ReferenceSites = new Map();
  for (const { file, line, name } of rows as { file: string; line: number; name: string }[]) {
    let lines = out.get(file);
    if (!lines) out.set(file, (lines = new Map()));
    let names = lines.get(line);
    if (!names) lines.set(line, (names = new Set()));
    names.add(name);
  }
  return out;
}

/**
 * The sites of codegraph's `references` edges (any provenance) in `files`, or
 * everywhere: what compaction keeps references for, what tsgo-index resolves
 * (`--refs`), and what the merge judges.
 */
export function referenceSites(db: SqliteDatabase, files?: Iterable<string>): ReferenceSites {
  const sql = `SELECT s.file_path AS file, e.line, t.name FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'references' AND e.line IS NOT NULL`;
  return toReferenceSites(files ? bySource(db, sql, files) : db.prepare(sql).all());
}

/**
 * The sites of the `references` codegraph has extracted but not resolved yet:
 * during a first index, before resolution turns them into edges (a superset of
 * those edges' lines — see produce.ts startIndex).
 */
export function pendingReferenceSites(db: SqliteDatabase): ReferenceSites {
  // A function passed by name is extracted as `function_ref` and stored as a `references` edge (resolution/index.ts).
  return toReferenceSites(db.prepare(`SELECT file_path AS file, line, reference_name AS name FROM unresolved_refs
    WHERE reference_kind IN ('references', 'function_ref')`).all());
}

/**
 * Rows of `sql` (which joins the edge's source as `s` and ends in a WHERE clause),
 * for sources in `files` — one indexed query per file.
 */
export function bySource<T>(db: SqliteDatabase, sql: string, files: Iterable<string>): T[] {
  const stmt = db.prepare(`${sql} AND s.file_path = ?`);
  return [...files].flatMap(f => stmt.all(f) as T[]);
}

interface SiteTarget {
  /** node id, or EXTERNAL */
  target: string;
  /** 0-based column of the callee name, for inserted edges */
  col: number;
  /** edge kind to insert when it differs from the site kind (`inherits` → implements/extends) */
  edgeKind?: string;
}

export interface ScipSites {
  /** site key → resolved targets */
  sites: Map<string, Map<string, SiteTarget>>;
  /** sites SCIP saw but couldn't judge (target defined in the project, yet unmapped or stale) */
  unknown: Set<string>;
  /**
   * Call sites whose compiler target has no node (unknown or external) → the
   * nodes that implement that target: a heuristic edge to one of them is the
   * call reaching its implementation through the interface, so it is verified.
   */
  dispatch: Map<string, Set<string>>;
  stats: Record<string, number>;
}

interface NodeRow {
  id: string; kind: string; name: string; qualified_name: string; file_path: string;
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

const NODE_KINDS = [...new Set([...CALLABLE_KINDS, ...NESTED_TYPE_KINDS, ...REFERENCED_TYPE_KINDS, ...REFERENCED_VALUE_KINDS, ...CONTAINER_KINDS, 'file'])];

/**
 * The nodes of a fresh file, answering both questions the merge asks of them.
 * Loaded per file on first use (one indexed query) and released when its
 * document is done, so a large repo's nodes are never all in memory at once.
 * Lookups go through per-file indexes (by name, by line) — a large repo has
 * hundreds of thousands of call sites, and scanning a file's every node per
 * site was most of the merge.
 */
class FileNodes {
  private byFile = new Map<string, FileIndex | null>();
  private readonly stmt: SqliteStatement;

  constructor(db: SqliteDatabase, private readonly files: ReadonlySet<string>) {
    this.stmt = db.prepare(`SELECT id, kind, name, qualified_name, file_path, start_line, end_line, start_column, end_column FROM nodes
      WHERE file_path = ? AND kind IN (${NODE_KINDS.map(() => '?').join(',')})`);
  }

  private load(file: string): FileIndex | null {
    let f = this.byFile.get(file);
    if (f !== undefined) return f;
    f = null;
    if (this.files.has(file)) {
      f = { byName: new Map(), rows: [], file: null };
      for (const r of this.stmt.all(file, ...NODE_KINDS) as NodeRow[]) {
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
    this.byFile.set(file, f);
    return f;
  }

  /** Done with `file` for now: a later use loads it again. */
  release(file: string): void {
    this.byFile.delete(file);
  }

  /**
   * The node a SCIP definition names: same file, same name, its (0-based) line
   * inside the node. Failing that, the file's only node of that name and kind
   * starting below it: an overloaded function is defined at its first signature,
   * while codegraph's node is the implementation that follows the signatures.
   */
  definition(file: string, line0: number, name: string, kinds: readonly string[]): NodeRow | null {
    const line = line0 + 1;
    let best: NodeRow | null = null;
    const below: NodeRow[] = [];
    for (const n of this.load(file)?.byName.get(name) ?? []) {
      if (!kinds.includes(n.kind)) continue;
      below.push(n);
      if (n.start_line > line || n.end_line < line) continue;
      if (!best || size(n) < size(best)) best = n;
    }
    return best ?? (below.length === 1 && below[0]!.start_line > line ? below[0]! : null);
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
    const f = this.load(file);
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
 * What every chunk of a merge reads, read once over all documents: each
 * definition's node (pass 1), which symbols the index defines at all, and which
 * nodes implement an interface method. `fresh`: the documents that pass the hash
 * gate — only their definitions map to nodes; the others still make their
 * symbols project symbols, so a call INTO a stale file reads as unknown, never
 * as external.
 */
export interface ScipDefinitions {
  nodes: FileNodes;
  symToNode: Map<string, NodeRow>;
  /** symbol → the node a reference to it points at: like symToNode, over the kinds a `references` edge (or an `impl` header) names */
  refToNode: Map<string, NodeRow>;
  projectSymbols: Set<string>;
  /** interface method symbol → the nodes implementing it, transitively */
  implementers: Map<string, Set<string>>;
  parse(symbol: string): ParsedSymbol | null;
  /** a reference's symbol, read as its defined twin when only that is defined (see below) */
  defined(symbol: string): string;
  stats: Record<string, number>;
}

export function scipDefinitions(
  db: SqliteDatabase, indexes: Array<{ lang: ScipLanguage; docs: ScipDocument[] }>, fresh: ReadonlySet<string>
): ScipDefinitions {
  const stats: Record<string, number> = {};
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const nodes = new FileNodes(db, fresh);
  const symToNode = new Map<string, NodeRow>();
  const refToNode = new Map<string, NodeRow>();
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
        if (!known || !isCallTarget(kind)) continue;
        const nested = kind === 'type' && parse(parsed.owner)?.last.kind === 'type';
        if (!refToNode.has(o.symbol)) {
          const kinds = kind === 'type' ? (nested ? [...REFERENCED_TYPE_KINDS, 'enum_member'] : REFERENCED_TYPE_KINDS)
            : kind === 'method' ? REFERENCED_METHOD_KINDS : REFERENCED_VALUE_KINDS;
          const target = nodes.definition(doc.relativePath, o.range.startLine, name, kinds);
          if (target) refToNode.set(o.symbol, target);
        }
        const node = nodes.definition(doc.relativePath, o.range.startLine, CONSTRUCTOR_NAMES.get(name) ?? name,
          nested ? NESTED_TYPE_KINDS : kind === 'type' ? TYPE_KINDS : kind === 'term' ? CALLED_VALUE_KINDS : CALLABLE_KINDS);
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
      nodes.release(doc.relativePath);
    }
  }

  for (const s of ambiguous) symToNode.delete(s); // still a project symbol: its calls read as unknown

  /**
   * A reference to a symbol no document defines, read as its defined method/term
   * twin (`X#m().` ↔ `X#m.`): scip-go names an interface method `Handle#URI.` where
   * its package is indexed and `Handle#URI().` from a run that only imports it (a
   * patch of one package, another module's run). Undefined both ways, it stays.
   */
  const defined = (symbol: string): string => {
    if (projectSymbols.has(symbol)) return symbol;
    const twin = symbol.endsWith('().') ? `${symbol.slice(0, -3)}.` : symbol.endsWith('.') ? `${symbol.slice(0, -1)}().` : null;
    return twin && projectSymbols.has(twin) ? twin : symbol;
  };
  stats.def_ambiguous = ambiguous.size;

  // method → method: which nodes a call through an interface method reaches, transitively.
  const implemented = new Map<string, string[]>();
  for (const { docs } of indexes) {
    for (const doc of docs) {
      if (!fresh.has(doc.relativePath)) continue; // those are the symbols with nodes
      for (const { symbol, target } of doc.implementations ?? []) {
        const list = implemented.get(symbol);
        if (list) list.push(target);
        else implemented.set(symbol, [target]);
      }
    }
  }
  const implementers = new Map<string, Set<string>>();
  for (const [symbol, node] of symToNode) {
    if (!implemented.has(symbol) || parse(symbol)?.last.kind === 'type') continue;
    const seen = new Set<string>();
    for (let todo = [...implemented.get(symbol)!]; todo.length;) {
      const t = todo.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      let set = implementers.get(t);
      if (!set) implementers.set(t, (set = new Set()));
      set.add(node.id);
      todo.push(...(implemented.get(t) ?? []));
    }
  }
  return { nodes, symToNode, refToNode, projectSymbols, implementers, parse, defined, stats };
}

/**
 * The sites SCIP resolved in the documents `fresh` holds (those that pass the
 * hash gate, with their source lines — all of them, or a merge chunk's): every
 * call and instantiation, each type's bases, and what it resolved at codegraph's
 * `references` sites (`refs`, referenceSites) — read against the whole index's
 * definitions (`defs`, scipDefinitions).
 */
export function scipSites(
  defs: ScipDefinitions, indexes: Array<{ lang: ScipLanguage; docs: ScipDocument[] }>, fresh: Map<string, string[]>,
  refs: ReferenceSites
): ScipSites {
  const { nodes, symToNode, refToNode, projectSymbols, implementers, parse, defined } = defs;
  const stats: Record<string, number> = {};
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const sites = new Map<string, Map<string, SiteTarget>>();
  const unknown = new Set<string>();
  /** A site resolved to `node`; with none, unknown for a symbol the project defines, else external. */
  const judge = (key: string, symbol: string, node: NodeRow | undefined, col: number, edgeKind?: string) => {
    if (node) addTarget(sites, key, node.id, col, edgeKind);
    else if (projectSymbols.has(symbol)) unknown.add(key);
    else addTarget(sites, key, EXTERNAL, col);
  };

  // type → base: the type's `implements`/`extends` edges, keyed like a call site at
  // the type's own line (where codegraph puts them).
  for (const { docs } of indexes) {
    for (const doc of docs) {
      if (!fresh.has(doc.relativePath)) continue;
      for (const { symbol, target } of doc.implementations ?? []) {
        if (parse(symbol)?.last.kind !== 'type' || parse(target)?.last.kind !== 'type') continue;
        const src = symToNode.get(symbol);
        if (!src) continue;
        const base = symToNode.get(target);
        const key = siteKey(src.id, src.start_line, base?.name ?? parse(target)!.last.name, 'inherits');
        judge(key, target, base, src.start_column, base && inheritanceKind(src.kind, base.kind));
        bump(base ? 'inherits_resolved' : 'inherits_unresolved');
      }
    }
  }
  const dispatch = new Map<string, Set<string>>();
  const via = (key: string, symbol: string) => {
    const impls = implementers.get(symbol);
    if (!impls) return;
    let set = dispatch.get(key);
    if (!set) dispatch.set(key, (set = new Set()));
    for (const id of impls) set.add(id);
  };

  // Pass 2: references that are calls, keyed by the caller codegraph would name.
  for (const { lang, docs } of indexes) {
    const { literalShape: literal, variantCalls = false, implHeader } = INDEXERS[lang];
    for (const doc of docs) {
      const lines = fresh.get(doc.relativePath);
      if (!lines) continue;
      const fileRefs = refs.get(doc.relativePath);
      // `impl Trait for Type`: the type's `implements` edge, keyed like codegraph's — from the
      // type to the trait at the header's line, and only for a type declared in this file (the
      // only one codegraph links). A generic `impl<T> Trait for T` names no type node.
      for (const { line, trait, self } of implHeader ? implHeaders(implHeader, doc, lines, parse) : []) {
        const src = refToNode.get(self.symbol);
        if (!src || src.file_path !== doc.relativePath) continue;
        const base = refToNode.get(trait.symbol);
        const key = siteKey(src.id, line + 1, base?.name ?? parse(trait.symbol)!.last.name, 'inherits');
        judge(key, trait.symbol, base, trait.range.startCol, base && inheritanceKind(src.kind, base.kind));
        bump(base ? 'impl_resolved' : 'impl_unresolved');
      }
      for (const occurrence of doc.occurrences) {
        if (occurrence.roles & ROLE_DEFINITION) continue;
        const symbol = defined(occurrence.symbol);
        const o = symbol === occurrence.symbol ? occurrence : { ...occurrence, symbol };
        // One of codegraph's references, judged by the symbol here — wherever it is called or not.
        const names = fileRefs?.get(o.range.startLine + 1);
        const ref = names && parse(symbol);
        if (ref && names.has(ref.last.name)) {
          const refKey = referenceKey(doc.relativePath, o.range.startLine + 1, ref.last.name);
          const node = refToNode.get(symbol);
          judge(refKey, symbol, node, o.range.startCol);
          bump(node ? 'references_resolved' : 'references_unresolved');
        }
        const call = classify(o, doc.positionEncoding, lines, literal, symToNode, parse, variantCalls);
        if (!call) continue;
        const { startLine, startCol } = o.range;
        const caller = nodes.callerAt(doc.relativePath, startLine, startCol);
        if (!caller) continue;
        if (!caller.inFunction) bump('call_outside_functions');
        const key = callSiteKey(caller.id, lines, startLine, startCol, call.name, call.kind);
        if (call.target !== null) {
          addTarget(sites, key, call.target, startCol);
          bump(`${call.kind}_resolved`);
        } else if (projectSymbols.has(call.symbol)) {
          unknown.add(key);
          via(key, call.symbol);
          bump('call_unknown');
        } else {
          addTarget(sites, key, EXTERNAL, startCol);
          via(key, call.symbol);
          bump('call_external');
        }
      }
      nodes.release(doc.relativePath);
    }
  }
  // A site SCIP resolved at all is judged; "unknown" only matters where it resolved nothing.
  for (const k of sites.keys()) unknown.delete(k);
  return { sites, unknown, dispatch, stats };
}

/**
 * The trait implementation headers in `doc` (IndexerSpec.implHeader), for an indexer
 * that emits no implementation relationships (rust-analyzer): per line, the trait's
 * and the implementing type's references (syntax.ts implTypes).
 */
function implHeaders(
  header: ImplHeader, doc: ScipDocument, lines: string[], parse: (symbol: string) => ParsedSymbol | null
): Array<{ line: number; trait: ScipOccurrence; self: ScipOccurrence }> {
  const byLine = new Map<number, ScipOccurrence[]>();
  for (const o of doc.occurrences) {
    if (o.roles & ROLE_DEFINITION || parse(o.symbol)?.last.kind !== 'type') continue;
    const list = byLine.get(o.range.startLine);
    if (list) list.push(o);
    else byLine.set(o.range.startLine, [o]);
  }
  const out: Array<{ line: number; trait: ScipOccurrence; self: ScipOccurrence }> = [];
  for (const [line, types] of byLine) {
    const pair = implTypes(header, lines[line] ?? '', doc.positionEncoding, types);
    if (pair) out.push({ line, ...pair });
  }
  return out;
}

function addTarget(sites: Map<string, Map<string, SiteTarget>>, key: string, target: string, col: number, edgeKind?: string): void {
  let m = sites.get(key);
  if (!m) sites.set(key, (m = new Map()));
  if (!m.has(target)) m.set(target, { target, col, edgeKind });
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
  symToNode: Map<string, NodeRow>, parse: (symbol: string) => ParsedSymbol | null, variantCalls: boolean
): Call | null {
  const parsed = parse(o.symbol);
  if (!parsed) return null;
  const { name, kind } = parsed.last;
  let shape: CallShape | null | undefined;
  const shapeOf = () => (shape === undefined ? (shape = callShape(o, encoding, lines, literal)) : shape);
  const site = siteKind(kind, shapeOf);
  if (!site) return null;
  if (site === 'instantiates') { // Foo(…), new Foo, Foo{…}
    const node = symToNode.get(o.symbol);
    const variant = variantCalls && shapeOf() === 'call' && parse(parsed.owner)?.last.kind === 'type'; // `Some(x)`
    return { kind: variant ? 'calls' : 'instantiates', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  }
  if (kind === 'method' && name === '<constructor>') {
    const cls = symToNode.get(parsed.owner);
    return { kind: 'instantiates', name: cls?.name ?? parse(parsed.owner)?.last.name ?? name, target: cls?.id ?? null, symbol: parsed.owner };
  }
  const node = symToNode.get(o.symbol);
  if (kind === 'method') return { kind: 'calls', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  // A called `term` is a function-valued binding (`const f = () => …`, `const expect: Expect`, a Go interface method) — judged only when it maps to a node.
  return node ? { kind: 'calls', name: node.name, target: node.id, symbol: o.symbol } : null;
}

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
    WHERE s.file_path = ? AND e.kind IN ('calls', 'instantiates', 'implements', 'extends', 'references') AND e.line IS NOT NULL
      AND ${HEURISTIC_PROVENANCE} -- unambiguous: only edges have a provenance column
  `);
  const out: HeuristicSites = new Map();
  for (const f of files) {
    for (const r of stmt.all(f) as { id: number; source: string; line: number; kind: string; name: string; target: string }[]) {
      const key = edgeSiteKey(r.source, f, r.line, r.name, r.kind);
      let targets = out.get(key);
      if (!targets) out.set(key, (targets = new Map()));
      const ids = targets.get(r.target);
      if (ids) ids.push(r.id);
      else targets.set(r.target, [r.id]);
    }
  }
  return out;
}
