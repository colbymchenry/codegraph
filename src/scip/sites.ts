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
import {
  POSITION_ENCODING_UTF8, ROLE_DEFINITION, ScipDocument, ScipOccurrence,
  parseSymbol, spanContains, spanSize,
} from './reader';

export type SiteKind = 'calls' | 'instantiates';
export const SITE_KINDS: readonly SiteKind[] = ['calls', 'instantiates'];

/** A call SCIP resolved to something outside the project (stdlib, dependency). */
export const EXTERNAL = '<external>';

const CALLABLE_KINDS = ['function', 'method'] as const;
const TYPE_KINDS = ['class', 'struct'] as const;

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

interface NodeRow { id: string; kind: string; name: string; start_line: number; end_line: number }

/** Resolves a SCIP definition to the codegraph node it names: same file, same name, line inside the node. */
class NodeMap {
  private byFile = new Map<string, NodeRow[]>();

  constructor(db: SqliteDatabase, files: Iterable<string>) {
    const kinds = [...CALLABLE_KINDS, ...TYPE_KINDS];
    const stmt = db.prepare(
      `SELECT id, kind, name, start_line, end_line FROM nodes WHERE file_path = ? AND kind IN (${kinds.map(() => '?').join(',')})`
    );
    for (const f of files) this.byFile.set(f, stmt.all(f, ...kinds) as NodeRow[]);
  }

  lookup(file: string, line0: number, name: string, kinds: readonly string[]): NodeRow | null {
    const line = line0 + 1;
    let best: NodeRow | null = null;
    for (const n of this.byFile.get(file) ?? []) {
      if (n.name !== name || !kinds.includes(n.kind) || n.start_line > line || n.end_line < line) continue;
      if (!best || n.end_line - n.start_line < best.end_line - best.start_line) best = n;
    }
    return best;
  }
}

/**
 * Non-callable nodes codegraph uses as the caller of code that runs outside any
 * function — class bodies, initializers, top-level statements. These are the
 * non-callable source kinds its own call edges carry; with none enclosing a
 * call, the file node is the caller.
 */
const CONTAINER_KINDS = ['class', 'struct', 'constant', 'variable', 'component', 'field', 'property'] as const;

interface SpanRow { id: string; kind: string; start_line: number; end_line: number; start_column: number; end_column: number }

/**
 * Who calls from a given position — decided from codegraph's OWN node spans,
 * not SCIP's ranges, so both sides key a call site by the same caller. (SCIP's
 * definition range includes decorators; codegraph's function node starts at
 * `def`, so a decorator call belongs to the enclosing class or file. And a
 * callback codegraph extracted as a function has no SCIP definition at all.)
 * Precedence: narrowest function/method — unless a container nested inside it
 * (a class defined in a method) is narrower — else narrowest container, else file.
 */
class Callers {
  private byFile = new Map<string, { callables: SpanRow[]; containers: SpanRow[]; file: string | null }>();

  constructor(db: SqliteDatabase, files: Iterable<string>) {
    const kinds = [...CALLABLE_KINDS, ...CONTAINER_KINDS, 'file'];
    const stmt = db.prepare(
      `SELECT id, kind, start_line, end_line, start_column, end_column FROM nodes
       WHERE file_path = ? AND kind IN (${kinds.map(() => '?').join(',')})`
    );
    for (const f of files) {
      const rows = stmt.all(f, ...kinds) as SpanRow[];
      this.byFile.set(f, {
        callables: rows.filter(r => (CALLABLE_KINDS as readonly string[]).includes(r.kind)),
        containers: rows.filter(r => (CONTAINER_KINDS as readonly string[]).includes(r.kind)),
        file: rows.find(r => r.kind === 'file')?.id ?? null,
      });
    }
  }

  /** Caller at 0-based `line0`/`col`, or null when the file has no nodes at all. */
  at(file: string, line0: number, col: number): { id: string; inFunction: boolean } | null {
    const entry = this.byFile.get(file);
    if (!entry) return null;
    const narrowest = (rows: SpanRow[]) => {
      let best: SpanRow | null = null;
      let bestSize = Infinity;
      for (const n of rows) {
        const span = { startLine: n.start_line - 1, startCol: n.start_column, endLine: n.end_line - 1, endCol: n.end_column };
        if (!spanContains(span, line0, col)) continue;
        const size = spanSize(span);
        if (size < bestSize) [best, bestSize] = [n, size];
      }
      return best;
    };
    const fn = narrowest(entry.callables);
    const holder = narrowest(entry.containers);
    // A container nested INSIDE the function (a class defined in a method) is the caller of its own body.
    if (fn && !(holder && holder.start_line >= fn.start_line && holder.end_line <= fn.end_line)) return { id: fn.id, inFunction: true };
    const id = holder?.id ?? entry.file;
    return id ? { id, inFunction: false } : null;
  }
}

/** Text after the callee name opens an argument list: `(`, `?.(`, or TS type arguments `<…>(`. */
export function looksLikeCall(tail: string): boolean {
  let t = tail.trimStart();
  if (t.startsWith('?.')) t = t.slice(2).trimStart();
  return skipGroup(t, '<', '>')?.startsWith('(') ?? false;
}

/** Strips one balanced `open…close` group (type arguments) from the start of `t`; null when it never closes. */
function skipGroup(t: string, open: string, close: string): string | null {
  if (!t.startsWith(open)) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close && --depth === 0) return t.slice(i + 1).trimStart();
  }
  return null;
}

/**
 * Languages that construct values with `Type{…}` literals rather than a call.
 * Each takes the text after and before a type reference and says whether the
 * brace that follows builds that type. The false friends are braces that
 * open a block right after a type: a return type before a function body, an
 * element type of a slice/map literal, an `impl` header.
 */
const LITERAL_SHAPES: Record<string, (tail: string, head: string) => boolean> = {
  go: (tail, head) => {
    const t = skipGroup(tail.trimStart(), '[', ']'); // generic instantiation: Box[int]{…}
    if (!t?.startsWith('{')) return false;
    // `[]T{`, `map[K]T{`, `[]*T{` build the container; `) T {` / `) *T {` is a return type before a body.
    return !/[\])]\s*\**$/.test(head.trimEnd());
  },
  rust: (tail, head) => {
    let t: string | null = tail.trimStart();
    if (t.startsWith('::')) t = t.slice(2).trimStart(); // turbofish: Foo::<T> { … }
    t = skipGroup(t, '<', '>');
    if (!t?.startsWith('{')) return false;
    // A type before a block: `-> Foo {`, `impl Foo {`, `impl T for Foo {`, `where T: Foo {`.
    if (/(->|\bimpl\b[^{};]*|\bwhere\b[^{};]*)\s*[&'\w\s]*$/.test(head)) return false;
    // A pattern, not a construction: `let Foo { a } = x`, `Foo { .. } =>`, `Foo { a }: Foo`.
    if (/\blet\s+(mut\s+)?$/.test(head)) return false;
    const after = skipGroup(t, '{', '}');
    return after === null || !/^(=>|=(?!=)|:(?!:)|\|)/.test(after);
  },
};

/** Language of a SCIP document, from its path — indexers don't reliably fill `Document.language`. */
function literalShapeFor(relativePath: string): ((tail: string, head: string) => boolean) | undefined {
  const ext = relativePath.slice(relativePath.lastIndexOf('.') + 1);
  return LITERAL_SHAPES[{ go: 'go', rs: 'rust' }[ext] ?? ''];
}

/** Maps a SCIP column to a JS string offset in `line`. */
function toStringOffset(line: string, col: number, encoding: number): number {
  if (encoding !== POSITION_ENCODING_UTF8 || /^[\x00-\x7f]*$/.test(line)) return col;
  return Buffer.from(line, 'utf8').subarray(0, col).toString('utf8').length;
}

interface DocSource {
  doc: ScipDocument;
  lines: string[];
}

/**
 * Every call/instantiation SCIP resolved inside a mapped callable of a fresh document.
 *
 * `fresh` holds the paths whose SCIP document matches codegraph's view of the
 * file (hash gate) with their source lines; documents outside it still
 * contribute to `projectSymbols` so a call INTO a stale file reads as unknown,
 * never as external.
 */
export function scipSites(db: SqliteDatabase, docs: ScipDocument[], fresh: Map<string, string[]>): ScipSites {
  const stats: Record<string, number> = {};
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const nodes = new NodeMap(db, fresh.keys());
  const symToNode = new Map<string, NodeRow>();
  const projectSymbols = new Set<string>();
  const sources: DocSource[] = [];

  // Pass 1: definitions → nodes, across all docs so cross-file targets resolve.
  for (const doc of docs) {
    const lines = fresh.get(doc.relativePath);
    for (const o of doc.occurrences) {
      if (!(o.roles & ROLE_DEFINITION)) continue;
      const parsed = parseSymbol(o.symbol);
      if (!parsed) continue;
      projectSymbols.add(o.symbol);
      if (!lines) continue;
      const { name: rawName, kind } = parsed.last;
      const callable = kind === 'method' || kind === 'term';
      if (!callable && kind !== 'type') continue;
      const name = CONSTRUCTOR_NAMES[rawName] ?? rawName;
      const node = nodes.lookup(doc.relativePath, o.range.startLine, name, callable ? CALLABLE_KINDS : TYPE_KINDS);
      if (!node) {
        if (kind !== 'term') bump('def_unmapped');
        continue;
      }
      symToNode.set(o.symbol, node);
      bump('def_mapped');
    }
    if (lines) sources.push({ doc, lines });
  }

  const sites = new Map<string, Map<string, SiteTarget>>();
  const unknown = new Set<string>();

  // Pass 2: references that are calls, attributed to the caller codegraph would name (see Callers).
  const callers = new Callers(db, fresh.keys());
  for (const { doc, lines } of sources) {
    for (const o of doc.occurrences) {
      if (o.roles & ROLE_DEFINITION) continue;
      const call = classify(o, doc, lines, symToNode);
      if (!call) continue;
      const { startLine, startCol } = o.range;
      const caller = callers.at(doc.relativePath, startLine, startCol);
      if (!caller) continue;
      if (!caller.inFunction) bump('call_outside_functions');
      const key = siteKey(caller.id, startLine + 1, call.name, call.kind);
      if (call.target === null) {
        if (projectSymbols.has(call.symbol)) {
          unknown.add(key);
          bump('call_unknown');
          continue;
        }
        addTarget(sites, key, EXTERNAL, startCol);
        bump('call_external');
        continue;
      }
      addTarget(sites, key, call.target, startCol);
      bump(`${call.kind}_resolved`);
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

/**
 * How the source text around an occurrence reads: `'call'` when an argument
 * list follows it, `'new'` when only a `new` keyword precedes it (`new Foo`),
 * `'literal'` for a Go/Rust `Type{…}` value, null otherwise (a callback passed
 * by name, a type annotation, …).
 */
export function callShape(
  o: ScipOccurrence, doc: Pick<ScipDocument, 'relativePath' | 'positionEncoding'>, lines: string[]
): 'call' | 'new' | 'literal' | null {
  const encoding = doc.positionEncoding;
  const { startLine, startCol, endLine, endCol } = o.range;
  const endText = lines[endLine];
  if (endText === undefined) return null;
  const tail = endText.slice(toStringOffset(endText, endCol, encoding));
  if (looksLikeCall(tail)) return 'call';
  const startText = lines[startLine] ?? '';
  const head = startText.slice(0, toStringOffset(startText, startCol, encoding));
  if (/\bnew\s+$/.test(head)) return 'new';
  return literalShapeFor(doc.relativePath)?.(tail, head) ? 'literal' : null;
}

function classify(
  o: ScipOccurrence, doc: ScipDocument, lines: string[], symToNode: Map<string, NodeRow>
): Call | null {
  const parsed = parseSymbol(o.symbol);
  if (!parsed) return null;
  const shape = callShape(o, doc, lines);
  const isCall = shape === 'call';
  const { name, kind } = parsed.last;

  if (kind === 'method' && name === '<constructor>') {
    if (!isCall) return null;
    const cls = symToNode.get(parsed.owner);
    const owner = parseSymbol(parsed.owner);
    return { kind: 'instantiates', name: cls?.name ?? owner?.last.name ?? name, target: cls?.id ?? null, symbol: parsed.owner };
  }
  if (kind === 'type') {
    if (!shape) return null;
    const node = symToNode.get(o.symbol);
    return { kind: 'instantiates', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  }
  if (!isCall) return null;
  const node = symToNode.get(o.symbol);
  if (kind === 'method') {
    return { kind: 'calls', name: node?.name ?? name, target: node?.id ?? null, symbol: o.symbol };
  }
  // A called `term` is a function-valued binding (`const f = () => …`) — a call only when it maps to a callable node.
  if (kind === 'term' && node && (CALLABLE_KINDS as readonly string[]).includes(node.kind)) {
    return { kind: 'calls', name: node.name, target: node.id, symbol: o.symbol };
  }
  return null;
}

/**
 * codegraph's own (tree-sitter-resolved) edges at the same kind of site, for
 * callers in `files`. Synthesized dynamic-dispatch edges (`provenance='heuristic'`)
 * are bridges SCIP can't see, so they are never candidates for replacement.
 */
export function heuristicSites(db: SqliteDatabase, files: Iterable<string>): Map<string, Set<string>> {
  const stmt = db.prepare(`
    SELECT e.source, e.line, e.kind, t.name, e.target
    FROM nodes s
    JOIN edges e ON e.source = s.id
    JOIN nodes t ON t.id = e.target
    WHERE s.file_path = ? AND e.kind IN ('calls', 'instantiates') AND e.line IS NOT NULL
      AND (e.provenance IS NULL OR e.provenance = 'tree-sitter')`);
  const out = new Map<string, Set<string>>();
  for (const f of files) {
    for (const r of stmt.all(f) as { source: string; line: number; kind: SiteKind; name: string; target: string }[]) {
      const key = siteKey(r.source, r.line, r.name, r.kind);
      let s = out.get(key);
      if (!s) out.set(key, (s = new Set()));
      s.add(r.target);
    }
  }
  return out;
}
