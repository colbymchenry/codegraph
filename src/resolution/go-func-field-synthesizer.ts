/**
 * Go func-field dispatch synthesis.
 *
 * A Go struct can hold a function in a field and call it through the field:
 *
 *   type Discovery struct { refreshf func(ctx context.Context) ([]*Group, error) }
 *   func (d *Discovery) refresh(ctx context.Context) (…) { … d.refreshf(ctx) … }
 *
 * Static extraction sees a call to `d.refreshf`, which no method answers, so a
 * flow stops at the field. Prometheus' service discovery is the canonical
 * shape: `refresh.Discovery.refresh` calls `d.refreshf`, which `NewDiscovery`
 * copies from `Options.RefreshF`, which each provider fills with its own method
 * value (`refresh.Options{…, RefreshF: d.refresh}` in discovery/aws/ec2.go).
 *
 * This links the function making the call to each function or method value
 * the field is given, keyed by (struct, field):
 *   • a composite literal — keyed `S{F: v}` or positional `S{a, v}` — found
 *     through the literal's resolved `instantiates` edge, so the struct is the
 *     one the resolver chose, package and all;
 *   • an assignment `x.F = v`;
 *   • one level of field-to-field copy: `S{F: o.G}` / `x.F = o.G` gives S.F
 *     what T.G is given directly (`refreshf: opts.RefreshF`).
 * A value is what the resolver already linked it to — the function-value
 * `references` edge at that spot — else, for `x.m`, the method `m` of x's
 * type: an interface's method when x is an interface value (`r.refresh` with
 * `r refresher`), whose interface-impl edges reach the implementations. A
 * function literal has no node and links nothing; a conversion to a func type
 * (`HandlerFunc(h.serve)`) is the value it converts.
 *
 * A call or an assignment counts only where its receiver's type is known: the
 * receiver, parameter or local in scope there, as the resolver's Go scope
 * reader finds it, writes the type, or the local's value gives it — a
 * composite literal, `new(T)`, a type assertion or a resolved call's result.
 * One field hop is allowed (`s.opts.F(…)`), and the field is that struct's own
 * or one embedding promotes from a struct one level down. A generic field name
 * (`fn`, `handler`, `f`) shared by unrelated structs never crosses between them.
 * Generated files (`// Code generated … DO NOT EDIT.`, `*.pb.go`) are not read.
 *
 * Edges are `calls`, `provenance: 'heuristic'`, `synthesizedBy: 'go-func-field'`,
 * with `field` (`Discovery.refreshf`), `via` for a value copied from another
 * field (`Options.RefreshF`, or `rest.Config.WrapTransport` from another
 * package), and `registeredAt` = where the function was put
 * in a field (`discovery/aws/ec2.go:221`) — its production wiring before its
 * test wiring when it is put in at several. Each channel keeps at most the
 * caller's per-channel cap of values, in the same order, and a function one
 * package's test puts in a field links no call in another package's test:
 * each package's tests build a binary of their own.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { enclosingFn } from './synth-utils';
import { blankGoCode, goLocalDeclarationAt, GO_TYPE_KINDS } from './name-matcher';

/** One field of a Go struct, in declaration order. */
interface GoField {
  name: string;
  /** The type as written, comments and tag dropped: `func(ctx context.Context) error`, `*refresh.Discovery`. */
  type: string;
  /** An embedded field (`*refresh.Discovery`): named for its type, and its fields are promoted. */
  embedded: boolean;
}

/** A struct type, by package directory and name (build-tag twins share one). */
interface GoStructType {
  key: string;
  name: string;
  dir: string;
  /** Its package's name, as the `package` clause writes it. */
  pkg: string;
  /** The first declaration; its file qualifies the field types. */
  node: Node;
  fields: GoField[];
  funcFields: Set<string>;
}

/** A function put in a field, and where. */
interface FieldValue {
  target: Node;
  /** `file:line` of the wiring. */
  site: string;
  test: boolean;
  /** The field it was copied from, for a value that came through another field. */
  via?: string;
}

/** Source with comments and literal contents blanked, plus its line starts. */
interface MaskedFile {
  text: string;
  lineStarts: number[];
}

/** A type as written somewhere, with the file whose package and imports qualify it. */
interface TypeText {
  type: string;
  file: string;
}

/** What a type expression names: a project struct, a project interface, or nothing known. */
type ResolvedType = { kind: 'struct'; struct: GoStructType } | { kind: 'interface'; node: Node } | null;

/** What a value put in a field is. */
type ValueOutcome = { kind: 'fn'; target: Node } | { kind: 'copy'; holder: GoStructType; field: string } | null;

const IDENT = String.raw`[A-Za-z_]\w*`;
/** `x.F(` / `x.y.F(` — a call through a selector, its receiver at most two identifiers long. */
const SELECTOR_CALL_RE = new RegExp(String.raw`(?<![\w.])(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\.\s*(${IDENT})\s*\(`, 'g');
/** `x.F = v` / `x.y.F = v` — never `==`. */
const SELECTOR_ASSIGN_RE = new RegExp(String.raw`(?<![\w.])(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\.\s*(${IDENT})\s*=(?!=)`, 'g');
/** Cheap prefilter on the raw text: `.F(` or `.F =` for some name. */
const SELECTOR_USE_RE = /\.\s*([A-Za-z_]\w*)\s*(?:\(|=(?!=))/g;
/** A type written as a name: `T`, `*T`, `pkg.T`, `T[int]`. */
const NAMED_TYPE_RE = new RegExp(String.raw`^[*&\s]*(${IDENT})(?:\s*\.\s*(${IDENT}))?\s*(?:\[[\s\S]*\])?\s*$`);
/** A plain value: `h`, `d.refresh`, `pkg.Handle`. */
const PLAIN_VALUE_RE = new RegExp(String.raw`^${IDENT}(?:\s*\.\s*${IDENT})?$`);
/** The head of a `type` spec, from its name to its type: `HandlerFunc func(`, `Alias = pkg.T`. */
const TYPE_SPEC_RE = new RegExp(String.raw`^${IDENT}\s*(?:\[[^\]]*\])?\s*=?\s*([^\n;]+)`);
/** The names before the one a declaration is read at: `a, ` in `a, b := …`. */
const NAMES_BEFORE_RE = new RegExp(String.raw`(?:${IDENT}\s*,\s*)*$`);
/** A declaration's names from the one it is read at, to its `:=` or `=`: `b, c :=` in `a, b, c := …`. */
const NAMES_FROM_RE = new RegExp(String.raw`^${IDENT}((?:\s*,\s*${IDENT})*)\s*(?::=|=(?!=))`);
/** Words a result list's `x T` item can start with that are a type, not a name. */
const TYPE_KEYWORDS = new Set(['chan', 'func', 'map', 'struct', 'interface']);
/** Predeclared types: never a project type, never worth a lookup. */
const PREDECLARED_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
  'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of `offset`. */
function lineAt(file: MaskedFile, offset: number): number {
  let lo = 0;
  let hi = file.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (file.lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Offset of the bracket matching the one at `open`, in masked text; -1 when unbalanced. */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The top-level items between the bracket at `open` and its match at `close`,
 * in masked text, each with where it starts: `{a: x, b: y}` → `a: x`, `b: y`.
 */
function listItems(text: string, open: number, close: number): Array<{ text: string; start: number }> {
  const items: Array<{ text: string; start: number }> = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    const t = raw.trim();
    if (t) items.push({ text: t, start: start + raw.length - raw.trimStart().length });
  };
  for (let i = open + 1; i < close; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return items;
}

/** Where the statement from `from` ends: a line break or `;` outside brackets, or a bracket closing around it. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if ((c === '\n' || c === ';') && depth === 0) {
      return i;
    }
  }
  return text.length;
}

/**
 * Each item's type in a Go result list: `(int, error)` and `(n int, err error)`
 * give `int`, `error`; a grouped `(a, b int)` gives `int` twice. A list of bare
 * types (`(chan int, error)`) names nothing: a named list's last item always
 * has a type.
 */
function goListTypes(items: readonly string[]): string[] {
  const split = (it: string): RegExpExecArray | null => {
    const m = /^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/.exec(it.trim());
    return m && !TYPE_KEYWORDS.has(m[1]!) ? m : null;
  };
  if (items.length === 0 || !split(items[items.length - 1]!)) return items.map((it) => it.trim());
  const types: string[] = [];
  let type = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const m = split(items[i]!);
    if (m) type = m[2]!.trim();
    types.unshift(type);
  }
  return types;
}

/** The result types of a signature `(params) results` as extraction stores it; null for another shape. */
function goResultTypes(signature: string | undefined): string[] | null {
  const sig = signature ? blankGoCode(signature).trim() : '';
  if (!sig.startsWith('(')) return null;
  const close = matchingBracket(sig, 0);
  if (close < 0) return null;
  const rest = sig.slice(close + 1).trim();
  if (!rest.startsWith('(')) return rest ? [rest] : [];
  const end = matchingBracket(rest, 0);
  return end < 0 ? null : goListTypes(listItems(rest, 0, end).map((i) => i.text));
}

function pkgDir(filePath: string): string {
  const f = filePath.replace(/\\/g, '/');
  const slash = f.lastIndexOf('/');
  return slash < 0 ? '.' : f.slice(0, slash);
}

/**
 * Production wiring before test wiring, then by site: the order a capped
 * channel keeps its values in, and which site a value put in a field at
 * several cites.
 */
function wiringOrder(a: FieldValue, b: FieldValue): number {
  return Number(a.test) - Number(b.test) || a.site.localeCompare(b.site, 'en', { numeric: true }) || a.target.id.localeCompare(b.target.id);
}

/** Store `value` under `key` in a memo that drops its oldest entry past `max`, so a whole-repo walk stays bounded. */
function remember<K, V>(map: Map<K, V>, max: number, key: K, value: V): V {
  if (map.size >= max) map.delete(map.keys().next().value as K);
  map.set(key, value);
  return value;
}

/**
 * Edges from each Go function that calls through a func-typed struct field to
 * the functions the field is given. See the file comment.
 */
export async function goFuncFieldEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
  maxPerChannel: number,
): Promise<Edge[]> {
  // ---- Source -----------------------------------------------------------------
  const maskedMemo = new Map<string, MaskedFile | null>();
  const maskedFile = (file: string, raw?: string | null): MaskedFile | null => {
    const hit = maskedMemo.get(file);
    if (hit !== undefined) return hit;
    const content = raw === undefined ? ctx.readFile(file) : raw;
    let m: MaskedFile | null = null;
    if (content !== null) {
      const text = blankGoCode(content);
      m = { text, lineStarts: lineStartsOf(text) };
    }
    return remember(maskedMemo, 128, file, m);
  };
  const offsetOf = (f: MaskedFile, line: number, column: number): number =>
    (f.lineStarts[line - 1] ?? f.text.length) + column;

  // ---- Types, by package ------------------------------------------------------
  const byNameMemo = new Map<string, Node[]>();
  const nodesNamed = (name: string): Node[] =>
    byNameMemo.get(name) ?? remember(byNameMemo, 8192, name, ctx.getNodesByName(name).filter((n) => n.language === 'go'));
  const importDirMemo = new Map<string, string | null>();
  const importDir = (qualifier: string, file: string): string | null => {
    const key = `${file}\0${qualifier}`;
    const hit = importDirMemo.get(key);
    if (hit !== undefined) return hit;
    const imp = ctx.getImportMappings(file, 'go').find((i) => i.localName === qualifier);
    // Room for every qualifier the type scan below reads, so none is looked up twice.
    return remember(importDirMemo, 65536, key, imp ? ctx.getGoPackageDir?.(imp.source, file) ?? null : null);
  };
  const typeNodes = (name: string, dir: string): Node[] =>
    PREDECLARED_TYPES.has(name) ? [] : nodesNamed(name).filter((n) => GO_TYPE_KINDS.has(n.kind) && pkgDir(n.filePath) === dir);
  /** type_alias node id → the type it is declared as, as written after its name (filled by the type scan below). */
  const specs = new Map<string, string | null>();
  /** The declared type of a `type` spec node: `func(*Context)` for `type HandlerFunc func(*Context)`. */
  const specType = (n: Node): string | null => specs.get(n.id) ?? null;
  const funcTypeMemo = new Map<string, boolean>();
  /** Whether a `type` spec declares a function type: `type HandlerFunc func(*Context)`. */
  const isFuncTypeNode = (n: Node): boolean => {
    let yes = funcTypeMemo.get(n.id);
    if (yes === undefined) {
      yes = n.kind === 'type_alias' && /^func\s*\(/.test(specType(n) ?? '');
      funcTypeMemo.set(n.id, yes);
    }
    return yes;
  };
  /** The project types a name written in `file` can mean: `T` in its own package, `pkg.T` in the imported one. */
  const namedTypes = (text: string, file: string): { name: string; dir: string; nodes: Node[] } | null => {
    const m = NAMED_TYPE_RE.exec(text.trim());
    if (!m || (!m[2] && PREDECLARED_TYPES.has(m[1]!))) return null;
    const dir = m[2] ? importDir(m[1]!, file) : pkgDir(file);
    if (!dir) return null;
    const name = m[2] ?? m[1]!;
    return { name, dir, nodes: typeNodes(name, dir) };
  };
  /** Whether a field's declared type can be called: `func(…)…`, or a project func type (not a pointer to one). */
  const isFuncFieldType = (type: string, file: string): boolean => {
    if (/^func\s*\(/.test(type)) return true;
    if (type.startsWith('*')) return false;
    const named = namedTypes(type, file);
    return !!named && named.nodes.length > 0 && named.nodes.every(isFuncTypeNode);
  };

  /** A struct's fields, read from its declaration in `f`. */
  const readFields = (f: MaskedFile, n: Node): GoField[] | null => {
    const from = offsetOf(f, n.startLine, n.startColumn ?? 0);
    const to = f.lineStarts[n.endLine ?? n.startLine] ?? f.text.length;
    const kw = /\bstruct\s*\{/.exec(f.text.slice(from, to));
    if (!kw) return null;
    const open = from + kw.index + kw[0].length - 1;
    const close = matchingBracket(f.text, open);
    if (close < 0) return null;
    const fields: GoField[] = [];
    let depth = 0;
    let start = open + 1;
    const take = (end: number): void => {
      let decl = f.text.slice(start, end).trim();
      // A tag is a string literal, blanked down to its quotes.
      const quote = decl[decl.length - 1];
      if (quote === '`' || quote === '"') decl = decl.slice(0, Math.max(0, decl.lastIndexOf(quote, decl.length - 2))).trim();
      if (!decl) return;
      const embedded = NAMED_TYPE_RE.exec(decl);
      if (embedded) {
        fields.push({ name: embedded[2] ?? embedded[1]!, type: decl, embedded: true });
        return;
      }
      const named = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+(\S[\s\S]*)$/.exec(decl);
      if (!named) return;
      const type = named[2]!.replace(/\s+/g, ' ').trim();
      for (const name of named[1]!.split(',')) fields.push({ name: name.trim(), type, embedded: false });
    };
    for (let i = open + 1; i < close; i++) {
      const c = f.text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if ((c === '\n' || c === ';') && depth === 0) {
        take(i);
        start = i + 1;
      }
    }
    take(close);
    return fields;
  };

  // Generated code — protobuf messages, deep copies, clientsets, mocks (`// Code
  // generated … DO NOT EDIT.`) — is left out: it is no flow a reader follows.
  const goFiles = ctx.getAllFiles().filter((file) => file.endsWith('.go'));
  const isGenerated = queries.generatedPredicateFor(goFiles);

  // Each file declaring a struct or another type is read once: its structs'
  // fields, its specs' types, and the names it uses as `.F(` / `.F =`, so the
  // site scan below reads it again only when one of those is a func field's.
  const declsByFile = new Map<string, Node[]>();
  let scanned = 0;
  for (const kind of ['struct', 'type_alias'] as const) {
    for (const n of queries.iterateNodesByKindIn(kind, ['go'])) {
      if ((++scanned & 255) === 0) await onYield();
      if (isGenerated(n.filePath)) continue;
      const list = declsByFile.get(n.filePath);
      if (list) list.push(n);
      else declsByFile.set(n.filePath, [n]);
    }
  }
  const structs = new Map<string, GoStructType>(); // `${dir}\0${name}`
  const selectorNames = new Map<string, string>(); // file → ` F G … `, the names it uses as `.F(` / `.F =`
  let filesRead = 0;
  for (const [file, decls] of declsByFile) {
    if ((++filesRead & 31) === 0) await onYield();
    const f = maskedFile(file);
    if (!f) continue;
    const dir = pkgDir(file);
    const pkg = /^\s*package\s+([A-Za-z_]\w*)/m.exec(f.text)?.[1] ?? dir.slice(dir.lastIndexOf('/') + 1);
    // The packages the types written here come through, looked up while the
    // file's imports are at hand rather than after it has left every cache.
    const qualifiers = (type: string | null | undefined): void => {
      const q = type ? NAMED_TYPE_RE.exec(type) : null;
      if (q?.[2]) importDir(q[1]!, file);
    };
    for (const n of decls) {
      if (n.kind === 'type_alias') {
        const at = offsetOf(f, n.startLine, n.startColumn ?? 0);
        const spec = TYPE_SPEC_RE.exec(f.text.slice(at, at + 400))?.[1]?.trim() ?? null;
        specs.set(n.id, spec);
        qualifiers(spec);
        continue;
      }
      const key = `${dir}\0${n.name}`;
      if (structs.has(key)) continue; // a build-tag twin: the first declaration speaks for both
      const fields = readFields(f, n);
      if (!fields) continue;
      structs.set(key, { key, name: n.name, dir, pkg, node: n, fields, funcFields: new Set() });
      for (const fld of fields) qualifiers(fld.type);
    }
    const used = new Set<string>();
    SELECTOR_USE_RE.lastIndex = 0;
    for (let m = SELECTOR_USE_RE.exec(f.text); m; m = SELECTOR_USE_RE.exec(f.text)) used.add(m[1]!);
    // Joined into one new string, which keeps no slice of the file's text alive.
    selectorNames.set(file, ` ${[...used].join(' ')} `);
  }
  const funcFieldNames = new Set<string>();
  for (const s of structs.values()) {
    for (const fld of s.fields) {
      if (fld.embedded || !isFuncFieldType(fld.type, s.node.filePath)) continue;
      s.funcFields.add(fld.name);
      funcFieldNames.add(fld.name);
    }
  }
  if (funcFieldNames.size === 0) return [];

  const resolveMemo = new Map<string, ResolvedType>();
  /** What a type written in `file` names: a project struct or interface; a defined type or alias is followed. */
  const resolveType = (text: string, file: string, depth = 0): ResolvedType => {
    const key = `${file}\0${text}`;
    const hit = resolveMemo.get(key);
    if (hit !== undefined) return hit;
    let out: ResolvedType = null;
    const named = depth <= 3 ? namedTypes(text, file) : null;
    if (named) {
      const s = structs.get(`${named.dir}\0${named.name}`);
      const iface = named.nodes.find((t) => t.kind === 'interface');
      if (s) out = { kind: 'struct', struct: s };
      else if (iface) out = { kind: 'interface', node: iface };
      else if (named.nodes.length > 0) {
        // `type A = B` and `type A B` have B's fields.
        const under = specType(named.nodes[0]!);
        if (under) out = resolveType(under, named.nodes[0]!.filePath, depth + 1);
      }
    }
    return remember(resolveMemo, 8192, key, out);
  };

  /** Whether `s` declares a method named `name` (selector lookup takes it over a promoted field). */
  const hasMethod = (s: GoStructType, name: string): boolean =>
    nodesNamed(name).some((n) => n.kind === 'method' && n.qualifiedName === `${s.name}::${name}` && pkgDir(n.filePath) === s.dir);

  /** The struct whose func field `field` a value of `s` reaches: its own, or the one embedding promotes it from. */
  const fieldOwner = (s: GoStructType, field: string): GoStructType | null => {
    if (s.funcFields.has(field)) return s;
    if (s.fields.some((f) => f.name === field) || hasMethod(s, field)) return null;
    const holders: GoStructType[] = [];
    for (const emb of s.fields) {
      if (!emb.embedded) continue;
      const t = resolveType(emb.type, s.node.filePath);
      if (t?.kind === 'struct' && t.struct.fields.some((f) => f.name === field)) holders.push(t.struct);
    }
    // Two at one depth is ambiguous to Go; one must hold a func field there.
    return holders.length === 1 && holders[0]!.funcFields.has(field) ? holders[0]! : null;
  };

  // ---- Typing a name inside a function -------------------------------------
  const staticCallsMemo = new Map<string, Edge[]>();
  const staticCalls = (fn: Node): Edge[] =>
    staticCallsMemo.get(fn.id) ??
    remember(staticCallsMemo, 256, fn.id, queries.getOutgoingEdges(fn.id, ['calls']).filter((e) => e.provenance !== 'heuristic'));

  /**
   * What the right side of a declaration gives its `index`th name (of
   * `names`): a composite literal's type, `new(T)`, a type assertion, or a
   * resolved call's result. Undefined when it can't be told.
   */
  const rhsType = (f: MaskedFile, fn: Node, rhsStart: number, index: number, names: number): TypeText | undefined => {
    const rhs = f.text.slice(rhsStart, statementEnd(f.text, rhsStart));
    if (/^\s*range\b/.test(rhs)) return undefined;
    const lead = rhs.length - rhs.trimStart().length;
    const values = listItems(`(${rhs})`, 0, rhs.length + 1);
    let value: string;
    let result = index;
    if (names > 1 && values.length === names) {
      value = values[index]!.text;
      result = 0;
    } else if (values.length === 1) {
      value = values[0]!.text;
    } else {
      return undefined;
    }
    const typeAt = (re: string): TypeText | undefined => {
      const m = new RegExp(re).exec(value);
      return m && result === 0 ? { type: m[1]!, file: fn.filePath } : undefined;
    };
    const literal = typeAt(String.raw`^&?\s*(${IDENT}(?:\s*\.\s*${IDENT})?)\s*(?:\[[^\]]*\])?\s*\{`);
    if (literal) return literal;
    const created = typeAt(String.raw`^new\s*\(\s*(${IDENT}(?:\s*\.\s*${IDENT})?)\s*(?:\[[^\]]*\])?\s*\)$`);
    if (created) return created;
    const asserted = typeAt(String.raw`\.\s*\(\s*(?!type\s*\))(\*?\s*${IDENT}(?:\s*\.\s*${IDENT})?)\s*\)$`);
    if (asserted) return asserted;
    // `f(…)`, `pkg.F(…)`, `x.M(…)` — the whole value one call the resolver linked.
    const call = new RegExp(String.raw`^(${IDENT}(?:\s*\.\s*${IDENT})*)\s*\(`).exec(value);
    if (!call || matchingBracket(value, call[0].length - 1) !== value.length - 1) return undefined;
    const name = call[1]!.replace(/\s+/g, '');
    const line = lineAt(f, rhsStart + lead);
    const callees = [...new Set(staticCalls(fn).filter((e) => e.line === line && e.metadata?.refName === name).map((e) => e.target))];
    if (callees.length !== 1) return undefined;
    const callee = queries.getNodeById(callees[0]!);
    if (!callee || (callee.kind !== 'function' && callee.kind !== 'method')) return undefined;
    const type = goResultTypes(callee.signature)?.[result];
    return type ? { type, file: callee.filePath } : undefined;
  };

  /**
   * What `name` is where offset `at` uses it in `fn`: the receiver, parameter
   * or local the resolver's scope reader finds in scope there, with its type —
   * the type its declaration writes, else what its value gives it — or null
   * when that can't be told. Undefined when `fn` declares no such name: it is
   * package-level, or an import.
   */
  const lookupName = (fn: Node, f: MaskedFile, name: string, at: number): TypeText | null | undefined => {
    const line = lineAt(f, at);
    const decl = goLocalDeclarationAt(name, { filePath: fn.filePath, line, column: at - f.lineStarts[line - 1]! }, ctx);
    if (!decl) return undefined;
    if (decl.type !== undefined) return decl.type.startsWith('...') ? null : { type: decl.type, file: fn.filePath };
    // `r, err := newRefresher(…)`, `var x = f()`, `v, ok := y.(*T)`: the name's place in its declaration.
    const p = offsetOf(f, decl.line, decl.column);
    const from = NAMES_FROM_RE.exec(f.text.slice(p, p + 400));
    if (!from) return null;
    const before = NAMES_BEFORE_RE.exec(f.text.slice(f.lineStarts[decl.line - 1]!, p))![0];
    const index = before ? before.split(',').length - 1 : 0;
    const names = index + (from[1] ? from[1].split(',').length : 1);
    return rhsType(f, fn, p + from[0].length, index, names) ?? null;
  };
  /** The type of `name` where offset `at` uses it in `fn`; null when it can't be told. */
  const typeOfName = (fn: Node, f: MaskedFile, name: string, at: number): TypeText | null =>
    lookupName(fn, f, name, at) ?? null;

  /** The struct or interface `x` / `x.y` has where offset `at` uses it in `fn`. */
  const typeOfExpr = (fn: Node, f: MaskedFile, expr: string, at: number): ResolvedType => {
    const segs = expr.split('.');
    const base = typeOfName(fn, f, segs[0]!, at);
    let t = base ? resolveType(base.type, base.file) : null;
    for (const seg of segs.slice(1)) {
      if (t?.kind !== 'struct') return null;
      let holder: GoStructType = t.struct;
      let fld = holder.fields.find((x) => x.name === seg);
      if (!fld) {
        // Promoted from a struct embedded one level down.
        const owners = holder.fields
          .filter((x) => x.embedded)
          .map((x) => resolveType(x.type, holder.node.filePath))
          .filter((r): r is { kind: 'struct'; struct: GoStructType } => r?.kind === 'struct' && r.struct.fields.some((x) => x.name === seg));
        if (owners.length !== 1) return null;
        holder = owners[0]!.struct;
        fld = holder.fields.find((x) => x.name === seg);
      }
      t = fld ? resolveType(fld.type, holder.node.filePath) : null;
    }
    return t;
  };

  // ---- Values put in fields ----------------------------------------------------
  const fnRefsMemo = new Map<string, Edge[]>();
  const fnRefs = (owner: Node): Edge[] =>
    fnRefsMemo.get(owner.id) ??
    remember(fnRefsMemo, 256, owner.id, queries.getOutgoingEdges(owner.id, ['references']).filter((e) => e.metadata?.fnRef === true));
  /** The one method named `member` a type declares (an interface's, or a struct's own). */
  const methodOf = (typeNode: Node, member: string): Node | null => {
    const hits = queries.getOutgoingEdges(typeNode.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method' && n.name === member);
    return hits.length === 1 ? hits[0]! : null;
  };

  /** What a value put in a field is: a function or method, another func field's values, or nothing known. */
  const valueOf = (owner: Node, fn: Node | null, f: MaskedFile, value: string, at: number, line: number): ValueOutcome => {
    let v = value.trim();
    // A conversion to a func type is the value it converts: `HandlerFunc(h.serve)`.
    const conv = new RegExp(String.raw`^(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\(`).exec(v);
    if (conv && matchingBracket(v, conv[0].length - 1) === v.length - 1) {
      const named = namedTypes(conv[1]!, owner.filePath);
      if (!named || named.nodes.length === 0 || !named.nodes.every(isFuncTypeNode)) return null;
      v = v.slice(conv[0].length, -1).trim();
    }
    if (!PLAIN_VALUE_RE.test(v)) return null;
    const name = v.replace(/\s+/g, '');
    const dot = name.indexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    const member = dot < 0 ? '' : name.slice(dot + 1);
    // What `base` names in the enclosing function: a local, a parameter or the receiver — else something package-level.
    const local = fn ? lookupName(fn, f, base, at) : undefined;
    // The resolver's own reading of this function value.
    const refs = [...new Set(fnRefs(owner).filter((e) => e.line === line && e.metadata?.refName === name).map((e) => e.target))];
    const ref = refs.length === 1 ? queries.getNodeById(refs[0]!) : null;
    const refFn = ref && (ref.kind === 'function' || ref.kind === 'method') ? ref : null;
    if (dot < 0) {
      // A bare name is a package-level function: Go names no method bare, and a local holds some other function.
      if (local !== undefined) return null;
      if (refFn) return refFn.kind === 'function' ? { kind: 'fn', target: refFn } : null;
      if (refs.length > 0) return null;
      // Extraction keeps a bare function value only when its file declares or imports it.
      const fns = nodesNamed(name).filter((n) => n.kind === 'function' && pkgDir(n.filePath) === pkgDir(owner.filePath));
      return fns.length === 1 ? { kind: 'fn', target: fns[0]! } : null;
    }
    const t = local ? resolveType(local.type, local.file) : null;
    if (t?.kind === 'interface') {
      const m = methodOf(t.node, member);
      if (m) return { kind: 'fn', target: m };
    } else if (t?.kind === 'struct') {
      // `opts.RefreshF`: another func field, whose functions this one gets.
      const holder = fieldOwner(t.struct, member);
      if (holder) return { kind: 'copy', holder, field: member };
      const m = refFn ? null : methodOf(t.struct.node, member);
      if (m) return { kind: 'fn', target: m };
    }
    if (refFn) return { kind: 'fn', target: refFn };
    if (local !== undefined || refs.length > 0) return null;
    // `pkg.Func`.
    const dir = importDir(base, owner.filePath);
    if (!dir) return null;
    const fns = nodesNamed(member).filter((n) => n.kind === 'function' && pkgDir(n.filePath) === dir);
    return fns.length === 1 ? { kind: 'fn', target: fns[0]! } : null;
  };

  const direct = new Map<string, FieldValue[]>(); // channel → functions put in it
  const copies = new Map<string, Array<{ from: string; label: string }>>(); // channel → channels copied into it
  /** Note what a value put in `into`'s field `field` is. */
  const record = (into: GoStructType, field: string, outcome: ValueOutcome, file: string, line: number): void => {
    if (!outcome) return;
    const channel = `${into.key}\0${field}`;
    if (outcome.kind === 'copy') {
      const from = `${outcome.holder.key}\0${outcome.field}`;
      if (from === channel) return;
      // `refreshf: opts.RefreshF` reads `Options.RefreshF`; another package's is `rest.Config.WrapTransport`.
      const { holder } = outcome;
      const label = `${holder.dir === into.dir ? '' : `${holder.pkg}.`}${holder.name}.${outcome.field}`;
      const list = copies.get(channel) ?? [];
      if (!list.some((c) => c.from === from)) list.push({ from, label });
      copies.set(channel, list);
      return;
    }
    const list = direct.get(channel) ?? [];
    const value: FieldValue = { target: outcome.target, site: `${file}:${line}`, test: file.endsWith('_test.go') };
    const had = list.findIndex((v) => v.target.id === value.target.id);
    if (had < 0) list.push(value);
    else if (wiringOrder(value, list[had]!) < 0) list[had] = value;
    direct.set(channel, list);
  };

  // ---- Composite literals of the structs with func fields, by the file they're in ----
  const literalsByFile = new Map<string, Array<{ s: GoStructType; owner: Node; line: number; column: number }>>();
  for (const s of structs.values()) {
    if (s.funcFields.size === 0) continue;
    for (const decl of typeNodes(s.name, s.dir)) {
      if (decl.kind !== 'struct') continue;
      for (const e of queries.getIncomingEdges(decl.id, ['instantiates'])) {
        const owner = e.line ? queries.getNodeById(e.source) : null;
        if (!owner || owner.language !== 'go') continue;
        const list = literalsByFile.get(owner.filePath) ?? [];
        list.push({ s, owner, line: e.line!, column: e.column ?? 0 });
        literalsByFile.set(owner.filePath, list);
      }
    }
  }
  await onYield();

  /** The functions a struct literal puts in func fields: `S{F: v}`, or positional `S{a, v}`. */
  const readLiteral = (f: MaskedFile, lit: { s: GoStructType; owner: Node; line: number; column: number }): void => {
    const { s, owner } = lit;
    // The literal's `{` is on its type's line: Go puts no line break between them.
    const lineStart = f.lineStarts[lit.line - 1] ?? 0;
    const lineText = f.text.slice(lineStart, f.lineStarts[lit.line] ?? f.text.length);
    const typeRe = new RegExp(String.raw`(?<![\w.])(?:(${IDENT})\s*\.\s*)?${s.name}\s*(?:\[[^\]{}]*\])?\s*\{`, 'g');
    let open = -1;
    let nearest = Infinity;
    for (let m = typeRe.exec(lineText); m; m = typeRe.exec(lineText)) {
      // The type as written must name this struct's package: `refresh.Options` through its import, a bare name its own.
      if ((m[1] ? importDir(m[1], owner.filePath) : pkgDir(owner.filePath)) !== s.dir) continue;
      const distance = Math.abs(m.index - lit.column);
      if (distance < nearest) {
        nearest = distance;
        open = lineStart + m.index + m[0].length - 1;
      }
    }
    if (open < 0) return;
    const close = matchingBracket(f.text, open);
    if (close < 0) return;
    const fn = owner.kind === 'function' || owner.kind === 'method' ? owner : null;
    const items = listItems(f.text, open, close);
    const keys = items.map((it) => /^([A-Za-z_]\w*)\s*:(?!=)\s*/.exec(it.text));
    const fieldsAt: Array<{ field: string; value: string; at: number }> = [];
    if (keys.every((k) => k)) {
      items.forEach((it, i) => fieldsAt.push({ field: keys[i]![1]!, value: it.text.slice(keys[i]![0].length), at: it.start + keys[i]![0].length }));
    } else if (keys.every((k) => !k) && items.length === s.fields.length) {
      items.forEach((it, i) => fieldsAt.push({ field: s.fields[i]!.name, value: it.text, at: it.start }));
    }
    for (const { field, value, at } of fieldsAt) {
      if (!s.funcFields.has(field)) continue;
      const line = lineAt(f, at);
      record(s, field, valueOf(owner, fn, f, value, at, line), owner.filePath, line);
    }
  };

  // ---- Each Go file once: its literals, its calls through a field, its assignments to one ----
  interface Dispatch { fn: Node; line: number; channel: string; field: string }
  const dispatches: Dispatch[] = [];
  let filesScanned = 0;
  for (const file of goFiles) {
    if ((++filesScanned & 31) === 0) await onYield();
    if (isGenerated(file)) continue;
    const literals = literalsByFile.get(file);
    const used = selectorNames.get(file);
    let raw: string | null | undefined;
    let mentions = false;
    if (used !== undefined) {
      mentions = used.split(' ').some((name) => funcFieldNames.has(name));
    } else {
      raw = ctx.readFile(file);
      if (!raw) continue;
      SELECTOR_USE_RE.lastIndex = 0;
      for (let m = SELECTOR_USE_RE.exec(raw); m && !mentions; m = SELECTOR_USE_RE.exec(raw)) mentions = funcFieldNames.has(m[1]!);
    }
    if (!mentions && !literals) continue;
    const f = maskedFile(file, raw);
    if (!f) continue;
    for (const lit of literals ?? []) readLiteral(f, lit);
    if (!mentions) continue;
    const nodes = ctx.getNodesInFile(file);
    SELECTOR_CALL_RE.lastIndex = 0;
    for (let m = SELECTOR_CALL_RE.exec(f.text); m; m = SELECTOR_CALL_RE.exec(f.text)) {
      const field = m[2]!;
      if (!funcFieldNames.has(field)) continue;
      const line = lineAt(f, m.index);
      const fn = enclosingFn(nodes, line);
      if (!fn || fn.language !== 'go') continue;
      const t = typeOfExpr(fn, f, m[1]!.replace(/\s+/g, ''), m.index);
      const holder = t?.kind === 'struct' ? fieldOwner(t.struct, field) : null;
      if (holder) dispatches.push({ fn, line, channel: `${holder.key}\0${field}`, field: `${holder.name}.${field}` });
    }
    SELECTOR_ASSIGN_RE.lastIndex = 0;
    for (let m = SELECTOR_ASSIGN_RE.exec(f.text); m; m = SELECTOR_ASSIGN_RE.exec(f.text)) {
      const field = m[2]!;
      if (!funcFieldNames.has(field)) continue;
      const fn = enclosingFn(nodes, lineAt(f, m.index));
      if (!fn || fn.language !== 'go') continue;
      const t = typeOfExpr(fn, f, m[1]!.replace(/\s+/g, ''), m.index);
      const holder = t?.kind === 'struct' ? fieldOwner(t.struct, field) : null;
      if (!holder) continue;
      const valueStart = m.index + m[0].length;
      const value = f.text.slice(valueStart, statementEnd(f.text, valueStart));
      const at = valueStart + value.length - value.trimStart().length;
      const line = lineAt(f, at);
      record(holder, field, valueOf(fn, fn, f, value, at, line), file, line);
    }
  }

  // ---- Edges -------------------------------------------------------------------
  const valuesMemo = new Map<string, FieldValue[]>();
  const valuesOf = (channel: string): FieldValue[] => {
    let out = valuesMemo.get(channel);
    if (out) return out;
    const byTarget = new Map<string, FieldValue>();
    const add = (v: FieldValue): void => {
      const had = byTarget.get(v.target.id);
      if (!had || wiringOrder(v, had) < 0) byTarget.set(v.target.id, v);
    };
    for (const v of direct.get(channel) ?? []) add(v);
    for (const c of copies.get(channel) ?? []) for (const v of direct.get(c.from) ?? []) add({ ...v, via: c.label });
    out = [...byTarget.values()].sort(wiringOrder).slice(0, maxPerChannel);
    valuesMemo.set(channel, out);
    return out;
  };
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const d of dispatches) {
    const testCall = d.fn.filePath.endsWith('_test.go');
    for (const v of valuesOf(d.channel)) {
      if (v.target.id === d.fn.id) continue;
      // Each package's tests build a binary of their own: what one package's
      // test puts in a field, another package's test never calls.
      if (testCall && v.test && pkgDir(v.site.slice(0, v.site.lastIndexOf(':'))) !== pkgDir(d.fn.filePath)) continue;
      const key = `${d.fn.id}>${v.target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: d.fn.id,
        target: v.target.id,
        kind: 'calls',
        line: d.line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'go-func-field',
          field: d.field,
          ...(v.via ? { via: v.via } : {}),
          registeredAt: v.site,
        },
      });
    }
  }
  return edges;
}
