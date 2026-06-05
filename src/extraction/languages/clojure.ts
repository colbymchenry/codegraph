import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Clojure / ClojureScript extractor.
 *
 * The maintained grammar (sogaiu/tree-sitter-clojure) is deliberately
 * *lexical*: there are no function/class/import node types — `(defn foo [x]
 * ...)` is just a `list_lit` whose first `sym_lit` is `defn`. So unlike every
 * other extractor, all the declarative type arrays are empty and extraction
 * happens in the `visitNode` full-takeover hook (the Pascal precedent), which
 * interprets list heads: `ns`, `def`/`defn`/`defmacro`, `defprotocol`,
 * `defrecord`/`deftype`, `defmulti`/`defmethod`, and plain calls.
 *
 * Reference-name conventions (chosen so the existing resolver links them with
 * NO resolver changes):
 * - `(ns my.app.core ...)` creates a `module` node named `my.app.core` and
 *   scopes every top-level def under it, so defs get qualifiedName
 *   `my.app.core::process-user`.
 * - An aliased call `(str/upper-case x)` resolves the alias through the file's
 *   `:require` clause and emits referenceName `clojure.string::upper-case` —
 *   an exact `matchByQualifiedName` hit on the target's qualifiedName.
 * - `(:require [my.app.db ...])` emits an `imports` ref named `my.app.db`,
 *   which name-matches the target file's `module` node.
 */

/** Per-parse-tree namespace state (alias/refer tables from the `ns` form). */
interface NsState {
  /** The file's own namespace (from the `ns` form) — used to expand `::kwd`. */
  nsName?: string;
  /** :as alias → full namespace name */
  aliases: Map<string, string>;
  /** :refer'd symbol → full namespace name */
  refers: Map<string, string>;
  /**
   * Lazy index of same-file function/method names for HOF detection in
   * handleSymRef. Rebuilt only when ctx.nodes has grown — without it every
   * bare symbol pays a linear scan over all nodes extracted so far
   * (O(symbols × nodes) on god-files).
   */
  fnNames?: { len: number; names: Set<string> };
  /**
   * Stack of local-binding frames (let/loop/for vecs, fn/defn params, letfn
   * names, as->/catch bindings). A bare symbol matching ANY frame is a local
   * — shadowing a same-file fn name in a `let` is idiomatic Clojure, and
   * without this both the shadowed usages and shadowed head-position calls
   * would emit false `calls` edges to the fn.
   */
  locals: Set<string>[];
}

function isLocal(name: string, state: NsState): boolean {
  for (let i = state.locals.length - 1; i >= 0; i--) {
    if (state.locals[i]!.has(name)) return true;
  }
  return false;
}

/**
 * Collect the names a binding TARGET introduces: a plain symbol, or every
 * unqualified symbol inside a destructuring vec/map (`{:keys [a b] :as all}`).
 * Keyword markers (`:keys`, `:as`, `:or`, map keys) are skipped; `&` is not a
 * name. Over-collects symbols inside `:or` default expressions — conservative
 * in the right direction (suppresses references rather than fabricating them).
 */
function collectBindingNames(target: SyntaxNode, source: string, into: Set<string>): void {
  if (target.type === 'sym_lit') {
    const { ns, name } = symParts(target, source);
    if (!ns && name && name !== '&') into.add(name);
    return;
  }
  if (target.type === 'vec_lit' || target.type === 'map_lit' || target.type === 'ns_map_lit') {
    for (const child of valueChildren(target)) {
      if (child.type === 'kwd_lit') continue;
      collectBindingNames(child, source, into);
    }
  }
}

// Keyed weakly by the parse Tree object — one entry per in-flight file parse,
// reclaimed when the extractor deletes the tree.
const nsStateByTree = new WeakMap<object, NsState>();

function getNsState(node: SyntaxNode): NsState {
  let state = nsStateByTree.get(node.tree);
  if (!state) {
    state = { aliases: new Map(), refers: new Map(), locals: [] };
    nsStateByTree.set(node.tree, state);
  }
  return state;
}

/** Split a sym_lit into its optional namespace part and name part. */
function symParts(sym: SyntaxNode, source: string): { ns?: string; name: string } {
  const nsNode = getChildByField(sym, 'namespace');
  const nameNode = getChildByField(sym, 'name');
  return {
    ns: nsNode ? getNodeText(nsNode, source) : undefined,
    name: nameNode ? getNodeText(nameNode, source) : getNodeText(sym, source),
  };
}

/** Named children minus comments/discards — the actual value forms. */
function valueChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter(
    (c): c is SyntaxNode => !!c && c.type !== 'comment' && c.type !== 'dis_expr'
  );
}

/** Does a sym_lit carry `^:private` (or `{:private true}`) metadata? */
function hasPrivateMeta(sym: SyntaxNode, source: string): boolean {
  for (let i = 0; i < sym.namedChildCount; i++) {
    if (sym.fieldNameForNamedChild(i) !== 'meta') continue;
    const meta = sym.namedChild(i);
    if (meta && /:private\b/.test(getNodeText(meta, source))) return true;
  }
  return false;
}

/** Strip surrounding quotes from a str_lit's text. */
function stringContent(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).replace(/^"|"$/g, '');
}

const LITERAL_TYPES = new Set([
  'num_lit', 'str_lit', 'kwd_lit', 'bool_lit', 'nil_lit', 'char_lit', 'regex_lit',
]);

// Container forms whose children are evaluated — walk through them.
const WALK_THROUGH_TYPES = new Set([
  'vec_lit', 'map_lit', 'set_lit', 'ns_map_lit',
  'read_cond_lit', 'splicing_read_cond_lit', 'syn_quoting_lit',
  'unquoting_lit', 'unquote_splicing_lit', 'derefing_lit',
  'tagged_or_ctor_lit', 'var_quoting_lit', 'evaling_lit',
]);

// Special forms + ubiquitous clojure.core macros/functions. These never get a
// `calls` reference: the real target (clojure.core) is never in the project
// graph, so emitting them only risks false edges to same-named project
// symbols. Children are still walked, so calls *inside* them are captured.
const CORE_FORMS = new Set([
  // special forms / core macros
  'def', 'if', 'do', 'let', 'let*', 'quote', 'var', 'fn', 'fn*', 'loop', 'loop*',
  'recur', 'throw', 'try', 'catch', 'finally', 'set!', 'new', '.', '..',
  'monitor-enter', 'monitor-exit', 'in-ns', 'import', 'require', 'use', 'refer',
  'when', 'when-not', 'when-let', 'when-some', 'when-first', 'if-let', 'if-not',
  'if-some', 'cond', 'condp', 'case', 'and', 'or', 'not',
  '->', '->>', 'as->', 'some->', 'some->>', 'cond->', 'cond->>', 'doto',
  'doseq', 'dotimes', 'for', 'while', 'binding', 'with-open', 'with-redefs',
  'with-local-vars', 'with-bindings', 'with-out-str', 'with-in-str', 'with-meta',
  'delay', 'lazy-seq', 'lazy-cat', 'future', 'promise', 'locking', 'io!', 'sync',
  // NOTE: definline is deliberately NOT here — it defines a function, and the
  // def-macro heuristic in handleList turns it into a function node.
  'dosync', 'declare', 'assert', 'comment', 'gen-class', 'this-as',
  'goog-define', 'specify', 'specify!',
  // ubiquitous core functions
  'map', 'filter', 'remove', 'reduce', 'reduce-kv', 'apply', 'str', 'pr', 'prn',
  'println', 'print', 'printf', 'pr-str', 'prn-str', 'format', 'get', 'get-in',
  'assoc', 'assoc-in', 'update', 'update-in', 'dissoc', 'merge', 'merge-with',
  'conj', 'cons', 'concat', 'into', 'vec', 'vector', 'list', 'hash-map',
  'hash-set', 'set', 'sorted-map', 'sorted-set', 'array-map', 'first', 'second',
  'ffirst', 'rest', 'next', 'nnext', 'nth', 'last', 'butlast', 'take',
  'take-while', 'take-last', 'take-nth', 'drop', 'drop-while', 'drop-last',
  'count', 'empty', 'empty?', 'seq', 'not-empty', 'keys', 'vals', 'contains?',
  'some', 'every?', 'not-any?', 'not-every?', 'filterv', 'mapv', 'keep',
  'keep-indexed', 'map-indexed', 'mapcat', 'partition', 'partition-all',
  'partition-by', 'group-by', 'frequencies', 'sort', 'sort-by', 'reverse',
  'distinct', 'dedupe', 'interleave', 'interpose', 'flatten', 'zipmap', 'range',
  'repeat', 'repeatedly', 'iterate', 'cycle', 'identity', 'constantly', 'comp',
  'partial', 'juxt', 'complement', 'fnil', 'memoize', 'trampoline',
  '=', 'not=', '==', '<', '>', '<=', '>=', '+', '-', '*', '/', '+\'', '-\'', '*\'',
  'quot', 'rem', 'mod', 'inc', 'dec', 'inc\'', 'dec\'', 'max', 'min', 'abs',
  'zero?', 'pos?', 'neg?', 'even?', 'odd?', 'number?', 'string?', 'keyword?',
  'symbol?', 'map?', 'vector?', 'list?', 'set?', 'seq?', 'coll?', 'fn?', 'ifn?',
  'nil?', 'true?', 'false?', 'boolean', 'some?', 'any?', 'instance?',
  'satisfies?', 'isa?', 'type', 'class', 'name', 'namespace', 'keyword',
  'symbol', 'gensym', 'int', 'long', 'double', 'float', 'bigdec', 'bigint',
  'num', 'rand', 'rand-int', 'rand-nth', 'shuffle', 'atom', 'swap!',
  'swap-vals!', 'reset!', 'reset-vals!', 'compare-and-set!', 'add-watch',
  'remove-watch', 'agent', 'send', 'send-off', 'await', 'alter', 'alter-var-root',
  'commute', 'ref', 'ref-set', 'deref', 'intern', 'resolve', 'requiring-resolve',
  'find-var', 'meta', 'vary-meta', 'alter-meta!', 'reduced', 'realized?', 'force',
  'ex-info', 'ex-data', 'ex-message', 'ex-cause', 'slurp', 'spit', 'read-string',
  'get-method', 'methods', 'prefer-method', 'remove-method', 'derive', 'underive',
  'make-hierarchy', 'boolean?', 'char?', 'double?', 'float?', 'int?', 'integer?',
  'nat-int?', 'pos-int?', 'neg-int?', 'rational?', 'ratio?', 'decimal?', 'var?',
  'volatile!', 'vswap!', 'vreset!', 'tap>', 'add-tap', 'remove-tap', 'run!',
  'doall', 'dorun', 'nthnext', 'nthrest', 'split-at', 'split-with', 'subvec',
  'subs', 're-find', 're-matches', 're-seq', 're-pattern', 'peek', 'pop',
  'select-keys', 'update-keys', 'update-vals', 'min-key', 'max-key', 'key',
  'val', 'find', 'line-seq', 'file-seq', 'tree-seq', 'xml-seq', 'compare',
  'hash', 'identical?', 'time', 'identity', 'random-uuid', 'parse-long',
  'parse-double', 'parse-boolean', 'parse-uuid', 'char', 'int-array',
  'long-array', 'object-array', 'to-array', 'into-array', 'aget', 'aset',
  'alength', 'aclone', 'amap', 'areduce', 'make-array',
]);

/** Emit one unresolved reference from the current scope. */
function emitRef(
  ctx: ExtractorContext,
  node: SyntaxNode,
  referenceName: string,
  referenceKind: 'calls' | 'references' | 'instantiates' | 'implements' | 'imports'
): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId || !referenceName) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * Reference name for a namespaced symbol: resolve the alias through the
 * file's `:require` table to `full.ns::name` (exact qualifiedName match), or
 * fall back to interop/foreign-namespace forms.
 */
function qualifiedRefName(ns: string, name: string, state: NsState): string {
  const full = state.aliases.get(ns);
  if (full) return `${full}::${name}`;
  if (ns.includes('.')) return `${ns}::${name}`; // direct fully-qualified usage
  if (/^[A-Z]/.test(ns)) return `${ns}.${name}`; // Class/staticMethod interop
  return name; // unknown lowercase alias — fall back to bare name matching
}

/** Walk any evaluated (non-list) form for references; lists go to handleList. */
function walkForm(node: SyntaxNode, ctx: ExtractorContext): void {
  const t = node.type;
  if (t === 'list_lit') {
    handleList(node, ctx);
  } else if (t === 'anon_fn_lit') {
    // `#(f x)` IS the call form — the grammar puts head + args directly under
    // anon_fn_lit, no inner list_lit. Route through handleList so the call is
    // extracted (`%`/`%1` arg symbols are 1-char and skipped by handleSymRef).
    handleList(node, ctx);
  } else if (t === 'sym_lit') {
    handleSymRef(node, ctx);
  } else if (WALK_THROUGH_TYPES.has(t)) {
    for (const child of valueChildren(node)) walkForm(child, ctx);
  }
  // quoting_lit / dis_expr / literals: not evaluated as code — skip
}

/**
 * A symbol in non-head (argument) position. Emit a reference only in the
 * high-precision cases: a namespaced symbol (clearly a var usage), a
 * `:refer`'d symbol, or a symbol naming a function already defined in this
 * file (the common private-helper-passed-to-HOF case — Clojure is
 * define-before-use, so the node already exists). Bare locals never match.
 */
function handleSymRef(sym: SyntaxNode, ctx: ExtractorContext): void {
  const state = getNsState(sym);
  const { ns, name } = symParts(sym, ctx.source);
  if (!name || name.length <= 1) return;

  if (ns) {
    emitRef(ctx, sym, qualifiedRefName(ns, name, state), 'references');
    return;
  }
  if (CORE_FORMS.has(name)) return;
  if (isLocal(name, state)) return; // bound by an enclosing let/fn/loop — not a var usage
  const referNs = state.refers.get(name);
  if (referNs) {
    emitRef(ctx, sym, `${referNs}::${name}`, 'references');
    return;
  }
  // Same-file function passed as a value — a higher-order call.
  let cache = state.fnNames;
  if (!cache || cache.len !== ctx.nodes.length) {
    const names = new Set<string>();
    for (const n of ctx.nodes) {
      if (n.kind === 'function' || n.kind === 'method') names.add(n.name);
    }
    cache = { len: ctx.nodes.length, names };
    state.fnNames = cache;
  }
  if (cache.names.has(name)) emitRef(ctx, sym, name, 'calls');
}

/**
 * Core forms whose second element is a binding VECTOR: `[name expr name
 * expr ...]`. Binding names introduce locals — they are never usages, and
 * shadowing a same-file fn name in a `let` is idiomatic Clojure, so walking
 * them through handleSymRef would emit false `calls` edges.
 */
const BINDING_FORMS = new Set([
  'let', 'let*', 'loop', 'loop*', 'binding', 'for', 'doseq', 'dotimes',
  'when-let', 'if-let', 'when-some', 'if-some', 'when-first',
  'with-open', 'with-redefs', 'with-local-vars',
]);

/**
 * Process the pairs of a binding vector into `frame`: even positions are
 * binding targets (their names join the frame AFTER their init is walked —
 * `let` is sequential), odd positions are init expressions. `for`/`doseq`
 * modifiers keep the pairing: `:when expr` / `:while expr` walk the expr,
 * `:let [..]` recurses into the nested binding vector.
 */
function processBindingPairs(
  vec: SyntaxNode,
  ctx: ExtractorContext,
  frame: Set<string>
): void {
  const kids = valueChildren(vec);
  for (let i = 0; i + 1 < kids.length; i += 2) {
    const target = kids[i]!;
    const init = kids[i + 1]!;
    if (target.type === 'kwd_lit') {
      if (getNodeText(target, ctx.source) === ':let' && init.type === 'vec_lit') {
        processBindingPairs(init, ctx, frame);
      } else {
        walkForm(init, ctx); // :when / :while expressions
      }
      continue;
    }
    walkForm(init, ctx);
    collectBindingNames(target, ctx.source, frame);
  }
}

/**
 * `(let [name expr ...] body)` and friends — bind the vector's names for the
 * duration of the body so shadowed usages don't emit references.
 */
function handleBindingForm(kids: SyntaxNode[], ctx: ExtractorContext, state: NsState): void {
  const frame = new Set<string>();
  state.locals.push(frame);
  processBindingPairs(kids[1]!, ctx, frame);
  for (const kid of kids.slice(2)) walkForm(kid, ctx);
  state.locals.pop();
}

/**
 * `(fn name? [params] body)` / `(fn name? ([a] ...) ([a b] ...))` — the
 * optional self-name and the param vectors are bindings: they join a locals
 * frame around the bodies instead of being walked as usages.
 */
function walkFnForm(kids: SyntaxNode[], ctx: ExtractorContext, state: NsState): void {
  const frame = new Set<string>();
  state.locals.push(frame);
  let i = 1;
  if (kids[i]?.type === 'sym_lit') {
    collectBindingNames(kids[i]!, ctx.source, frame);
    i++;
  }
  if (kids[i]?.type === 'vec_lit') {
    collectBindingNames(kids[i]!, ctx.source, frame);
    for (const form of kids.slice(i + 1)) walkForm(form, ctx);
  } else {
    for (const arity of kids.slice(i)) {
      if (arity.type !== 'list_lit') {
        walkForm(arity, ctx);
        continue;
      }
      const aKids = valueChildren(arity);
      if (aKids[0]?.type === 'vec_lit') collectBindingNames(aKids[0]!, ctx.source, frame);
      for (const form of aKids.slice(aKids[0]?.type === 'vec_lit' ? 1 : 0)) {
        walkForm(form, ctx);
      }
    }
  }
  state.locals.pop();
}

/** Push a frame of param names around a body walk (defn arities, method impls). */
function walkBodyWithParams(
  params: SyntaxNode | undefined,
  body: SyntaxNode[],
  ctx: ExtractorContext,
  state: NsState
): void {
  const frame = new Set<string>();
  if (params) collectBindingNames(params, ctx.source, frame);
  state.locals.push(frame);
  for (const form of body) walkForm(form, ctx);
  state.locals.pop();
}

// ---------------------------------------------------------------------------
// re-frame keyword-keyed dispatch
// ---------------------------------------------------------------------------
//
// re-frame routes everything through keyword-keyed registries at runtime —
// `(reg-event-db :todo/add handler)` … `(dispatch [:todo/add x])` — so the
// flow has zero static edges. Keywords are globally unique strings, so the
// bridge is extraction-only: each registration becomes a function node NAMED
// by its (alias-expanded) keyword, each literal dispatch/subscribe site emits
// a `calls` reference with the same name, and the existing exact-name matcher
// links them.
//
// Detection is SHAPE-based, not require-gated: real apps wrap re-frame in a
// project facade (status-mobile's `utils.re-frame` fronts 512 files, with
// custom registrars like `reg-root-key-sub` and `sub` for subscribe), so
// gating on `re-frame.core` in the require table misses most call sites.
// The shape is distinctive — a `reg-*` head with a literal keyword first arg
// is re-frame-family vocabulary — and precision is enforced structurally: an
// edge only materializes when a registration node AND a dispatch ref carry
// the exact same keyword, so a stray shape-match in a non-re-frame app
// resolves to nothing and is dropped. (The node side of a stray match — a
// spurious function node named `:kwd` — is accepted: it is inert without a
// same-keyword dispatch site, and the registrar call itself still gets its
// ordinary call ref, so nothing is lost either way.)

const RE_FRAME_REG_SHAPE = /^reg-[a-z-]+$/;
const RE_FRAME_DISPATCH_FORMS = new Set(['dispatch', 'dispatch-sync', 'subscribe', 'sub']);

// ---------------------------------------------------------------------------
// UIx / helix (ClojureScript React wrappers)
// ---------------------------------------------------------------------------
//
// Components are defined with a def-macro (`defui` in UIx, `defnc` in helix)
// and composed with the `$` element macro: `($ ui/button {:on-click f} ...)`.
// `$` is the entire composition mechanism, so the component argument gets a
// real `calls` edge (a render IS a call — same reasoning as the React JSX
// child edges), not just an argument-position reference. Gated on `$`
// actually resolving to uix.core / helix.core in the file's require table —
// `$` is too short a name to shape-match.

const UIX_CORE_NAMESPACES = new Set(['uix.core', 'helix.core']);
const UIX_COMPONENT_MACROS = new Set(['defui', 'defnc']);

/** `($ ui/button {...} child)` — emit a calls ref to the component (sym args only; `:div`/`:<>` keywords are DOM tags). */
function emitUixElementRef(kids: SyntaxNode[], ctx: ExtractorContext, state: NsState): void {
  const comp = kids[1];
  if (!comp || comp.type !== 'sym_lit') return;
  const { ns, name } = symParts(comp, ctx.source);
  if (!name || isLocal(name, state)) return;
  if (ns) {
    emitRef(ctx, comp, qualifiedRefName(ns, name, state), 'calls');
    return;
  }
  const referNs = state.refers.get(name);
  emitRef(ctx, comp, referNs ? `${referNs}::${name}` : name, 'calls');
}

/**
 * Expand a keyword literal to its canonical `:full.ns/name` string:
 * `:todo/add` as written, `::add` → `:<current-ns>/add`, `::subs/items` →
 * `:<full-ns-of-alias>/items`. The `::` auto-resolve marker only exists in
 * the raw text — the grammar's ns/name fields don't carry it.
 */
function expandKeyword(kwd: SyntaxNode, ctx: ExtractorContext, state: NsState): string {
  const raw = getNodeText(kwd, ctx.source);
  const nsNode = getChildByField(kwd, 'namespace');
  const nameNode = getChildByField(kwd, 'name');
  const name = nameNode ? getNodeText(nameNode, ctx.source) : raw.replace(/^:+/, '');
  const ns = nsNode ? getNodeText(nsNode, ctx.source) : undefined;
  if (raw.startsWith('::')) {
    if (ns) return `:${state.aliases.get(ns) ?? ns}/${name}`;
    return state.nsName ? `:${state.nsName}/${name}` : `:${name}`;
  }
  return ns ? `:${ns}/${name}` : `:${name}`;
}

/**
 * `(reg-event-db :todo/add (fn [db v] ...))` — the registration becomes a
 * function node named by the keyword, and the handler body walks under it so
 * its calls attribute to the event, not the file.
 */
function handleReframeRegistration(
  list: SyntaxNode,
  kids: SyntaxNode[],
  ctx: ExtractorContext,
  state: NsState,
  regName: string
): void {
  const kwd = kids[1];
  if (!kwd || kwd.type !== 'kwd_lit') {
    // Dynamic registration key — nothing to name; walk for calls only.
    for (const kid of kids.slice(1)) walkForm(kid, ctx);
    return;
  }
  const keyword = expandKeyword(kwd, ctx, state);
  const regNode = ctx.createNode('function', keyword, list, {
    signature: `(${regName} ${getNodeText(kwd, ctx.source)})`,
    isExported: true,
  });
  if (regNode) {
    ctx.pushScope(regNode.id);
    for (const kid of kids.slice(2)) walkForm(kid, ctx);
    ctx.popScope();
  } else {
    for (const kid of kids.slice(2)) walkForm(kid, ctx);
  }
}

/**
 * `(dispatch [:todo/add x])` / `(subscribe [:todo/items])` — emit a `calls`
 * reference named by the literal event keyword so it links to the
 * registration node. Variable event vectors (`(dispatch evt)`) stay
 * unlinked — the anonymous frontier.
 */
function emitReframeDispatchRef(kids: SyntaxNode[], ctx: ExtractorContext, state: NsState): void {
  const vec = kids[1];
  if (!vec || vec.type !== 'vec_lit') return;
  const kwd = valueChildren(vec)[0];
  if (!kwd || kwd.type !== 'kwd_lit') return;
  emitRef(ctx, vec, expandKeyword(kwd, ctx, state), 'calls');
}

/** Dispatch a list form by its head symbol. */
function handleList(list: SyntaxNode, ctx: ExtractorContext): void {
  const kids = valueChildren(list);
  const head = kids[0];
  if (!head) return;

  // `((make-handler) req)` or `(:kwd m)` — no callable name; walk everything.
  if (head.type !== 'sym_lit') {
    for (const kid of kids) walkForm(kid, ctx);
    return;
  }

  const state = getNsState(list);
  const { ns, name } = symParts(head, ctx.source);

  if (!ns) {
    switch (name) {
      case 'ns':
        handleNs(list, kids, ctx, state);
        return;
      case 'comment': // rich-comment block — never code that runs
      case 'quote':
      case 'declare':
        return;
      case 'defn':
      case 'defn-':
      case 'defmacro':
        handleDefn(list, kids, ctx, name === 'defn-');
        return;
      case 'def':
      case 'defonce':
        handleDef(list, kids, ctx);
        return;
      case 'defprotocol':
        handleProtocol(list, kids, ctx, 'protocol');
        return;
      case 'definterface':
        handleProtocol(list, kids, ctx, 'interface');
        return;
      case 'defrecord':
      case 'deftype':
        handleRecord(list, kids, ctx, name === 'defrecord');
        return;
      case 'defmulti':
        handleDefmulti(list, kids, ctx);
        return;
      case 'defmethod':
        handleDefmethod(list, kids, ctx);
        return;
      case 'reify':
      case 'proxy':
      case 'extend-protocol':
      case 'extend-type':
      case 'extend':
      case 'specify':
      case 'specify!':
        handleInlineImpl(kids, ctx);
        return;
      case 'letfn':
        handleLetfn(kids, ctx, state);
        return;
      case 'new': {
        // (new Foo args)
        const cls = kids[1];
        if (cls?.type === 'sym_lit') {
          emitRef(ctx, list, symParts(cls, ctx.source).name, 'instantiates');
        }
        for (const kid of kids.slice(2)) walkForm(kid, ctx);
        return;
      }
    }

    // (.method obj args) — interop / protocol method call by bare name.
    // (.-property obj) is a ClojureScript property READ, not a call.
    if (name.startsWith('.') && name.length > 1 && name !== '..') {
      const isPropertyAccess = name.startsWith('.-');
      emitRef(ctx, list, name.replace(/^\.-?/, ''), isPropertyAccess ? 'references' : 'calls');
      for (const kid of kids.slice(1)) walkForm(kid, ctx);
      return;
    }
    // (Foo. args) — constructor call.
    if (name.endsWith('.') && name.length > 1) {
      emitRef(ctx, list, name.slice(0, -1), 'instantiates');
      for (const kid of kids.slice(1)) walkForm(kid, ctx);
      return;
    }
    if (CORE_FORMS.has(name)) {
      // Binding forms: names join a locals frame, init exprs + body walked.
      if (BINDING_FORMS.has(name) && kids[1]?.type === 'vec_lit') {
        handleBindingForm(kids, ctx, state);
        return;
      }
      // fn literals: self-name + param vectors are bindings, not usages.
      if (name === 'fn' || name === 'fn*') {
        walkFnForm(kids, ctx, state);
        return;
      }
      // (as-> expr name forms...) / (catch ExClass e body) — kids[2] is a
      // binding name scoped over the remaining forms.
      if (name === 'as->' || name === 'catch') {
        if (kids[1]) walkForm(kids[1]!, ctx);
        const frame = new Set<string>();
        if (kids[2]) collectBindingNames(kids[2]!, ctx.source, frame);
        state.locals.push(frame);
        for (const kid of kids.slice(3)) walkForm(kid, ctx);
        state.locals.pop();
        return;
      }
      for (const kid of kids.slice(1)) walkForm(kid, ctx);
      return;
    }

    // Library def-macros: `(defroutes app-routes ...)`, `(deftest x ...)`,
    // `(defstate db ...)` — anything def-shaped whose first arg is a symbol
    // defines that symbol. Without this, the var never becomes a node and
    // every call inside the body attributes to the file instead.
    // UIx `defui` / helix `defnc` define React components — kind 'component'
    // (same modeling as Svelte/Vue components).
    if (/^def[a-z-]*$/.test(name) && name !== 'default' && name !== 'defer') {
      const defSym = kids[1];
      if (defSym?.type === 'sym_lit') {
        const kind = UIX_COMPONENT_MACROS.has(name) ? 'component' : 'function';
        const defNode = ctx.createNode(kind, symParts(defSym, ctx.source).name, list, {
          signature: `(${name} ...)`,
          isExported: !hasPrivateMeta(defSym, ctx.source),
        });
        if (defNode) {
          ctx.pushScope(defNode.id);
          for (const kid of kids.slice(2)) walkForm(kid, ctx);
          ctx.popScope();
          return;
        }
      }
    }

    // A locally-bound head — `(let [helper (mk)] (helper 1))` — calls the
    // LOCAL, not the same-named var; the target is unknowable statically.
    if (isLocal(name, state)) {
      for (const kid of kids.slice(1)) walkForm(kid, ctx);
      return;
    }

    // re-frame shapes (see the block comment above RE_FRAME_REG_SHAPE).
    if (RE_FRAME_REG_SHAPE.test(name) && kids[1]?.type === 'kwd_lit' && kids.length >= 3) {
      // The registrar itself is still called — keep its ordinary call ref so
      // "who calls reg-sub" / impact on a project facade sees every
      // registration site.
      const regReferNs = state.refers.get(name);
      emitRef(ctx, list, regReferNs ? `${regReferNs}::${name}` : name, 'calls');
      handleReframeRegistration(list, kids, ctx, state, name);
      return;
    }
    if (RE_FRAME_DISPATCH_FORMS.has(name)) {
      emitReframeDispatchRef(kids, ctx, state);
      // fall through — the dispatch call itself is still a call
    }

    // UIx/helix element macro: `($ button {...})` with `$` :refer'd.
    if (name === '$' && UIX_CORE_NAMESPACES.has(state.refers.get('$') ?? '')) {
      emitUixElementRef(kids, ctx, state);
      for (const kid of kids.slice(kids[1]?.type === 'sym_lit' ? 2 : 1)) walkForm(kid, ctx);
      return;
    }

    // Plain call. Prefer the :refer'd qualified form when known.
    const referNs = state.refers.get(name);
    emitRef(ctx, list, referNs ? `${referNs}::${name}` : name, 'calls');
    for (const kid of kids.slice(1)) walkForm(kid, ctx);
    return;
  }

  // re-frame via an alias — `(rf/reg-event-db :k ...)`, `(rf/dispatch [:k x])`
  // — including project facades (`utils.re-frame`); see RE_FRAME_REG_SHAPE.
  if (RE_FRAME_REG_SHAPE.test(name) && kids[1]?.type === 'kwd_lit' && kids.length >= 3) {
    // Keep the ordinary registrar call ref (callers/impact on the facade).
    emitRef(ctx, list, qualifiedRefName(ns, name, state), 'calls');
    handleReframeRegistration(list, kids, ctx, state, name);
    return;
  }
  if (RE_FRAME_DISPATCH_FORMS.has(name)) {
    emitReframeDispatchRef(kids, ctx, state);
    // fall through — the dispatch call itself is still a call
  }

  // UIx/helix element macro via alias: `(uix/$ button {...})`.
  if (name === '$' && UIX_CORE_NAMESPACES.has(state.aliases.get(ns) ?? ns)) {
    emitUixElementRef(kids, ctx, state);
    for (const kid of kids.slice(kids[1]?.type === 'sym_lit' ? 2 : 1)) walkForm(kid, ctx);
    return;
  }

  // Qualified def-macros: `(rum/defc page [args] ...)`, `(m/defstate db ...)`
  // — same def-shape heuristic as the unqualified branch. Without this, every
  // rum/uix/fulcro component in a ClojureScript app is invisible.
  if (/^def[a-z-]*$/.test(name) && kids[1]?.type === 'sym_lit') {
    const kind = UIX_COMPONENT_MACROS.has(name) ? 'component' : 'function';
    const defNode = ctx.createNode(kind, symParts(kids[1]!, ctx.source).name, list, {
      signature: `(${ns}/${name} ...)`,
      isExported: !hasPrivateMeta(kids[1]!, ctx.source),
    });
    if (defNode) {
      ctx.pushScope(defNode.id);
      for (const kid of kids.slice(2)) walkForm(kid, ctx);
      ctx.popScope();
      return;
    }
  }

  // Namespaced head: aliased / fully-qualified / interop call.
  emitRef(ctx, list, qualifiedRefName(ns, name, state), 'calls');
  for (const kid of kids.slice(1)) walkForm(kid, ctx);
}

/**
 * `(ns my.app.core (:require ...) (:import ...))` — create the module node,
 * scope the rest of the file under it, record alias/refer tables, and create
 * import nodes + `imports` refs for required namespaces.
 */
function handleNs(
  list: SyntaxNode,
  kids: SyntaxNode[],
  ctx: ExtractorContext,
  state: NsState
): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  const nsName = symParts(nameSym, ctx.source).name;
  state.nsName = nsName;

  const docNode = kids[2]?.type === 'str_lit' ? kids[2] : undefined;
  const moduleNode = ctx.createNode('module', nsName, list, {
    signature: `(ns ${nsName})`,
    docstring: docNode ? stringContent(docNode, ctx.source) : undefined,
    endLine: list.endPosition.row + 1,
  });
  if (!moduleNode) return;
  // Deliberately never popped — the whole file's top-level defs live in this
  // namespace, giving them qualifiedName `my.app.core::sym` (same pattern as
  // the JVM package_header namespace wrapper). A (rare) second `ns` form in
  // the same file nests its module inside the first, so later defs carry both
  // namespaces in their qualifiedName — accepted: still searchable, and
  // multi-ns files are vanishingly rare outside generated code.
  ctx.pushScope(moduleNode.id);

  for (const clause of kids.slice(2)) {
    if (clause.type !== 'list_lit') continue;
    const clauseKids = valueChildren(clause);
    const kwd = clauseKids[0];
    if (!kwd || kwd.type !== 'kwd_lit') continue;
    const kwdName = getNodeText(kwd, ctx.source).replace(/^:+/, '');

    if (kwdName === 'require' || kwdName === 'use' || kwdName === 'require-macros') {
      for (const entry of clauseKids.slice(1)) parseRequireEntry(entry, '', ctx, state);
    } else if (kwdName === 'import') {
      for (const entry of clauseKids.slice(1)) parseImportEntry(entry, ctx);
    }
  }
}

/** One `:require` entry: `[my.app.db :as db :refer [save!]]`, a bare sym, a prefix list, or a reader conditional. */
function parseRequireEntry(
  entry: SyntaxNode,
  prefix: string,
  ctx: ExtractorContext,
  state: NsState
): void {
  if (entry.type === 'read_cond_lit' || entry.type === 'splicing_read_cond_lit') {
    for (const child of valueChildren(entry)) {
      if (child.type !== 'kwd_lit') parseRequireEntry(child, prefix, ctx, state);
    }
    return;
  }
  if (entry.type === 'sym_lit') {
    const base = symParts(entry, ctx.source).name;
    createRequire(prefix ? `${prefix}.${base}` : base, entry, ctx);
    return;
  }
  if (entry.type !== 'vec_lit' && entry.type !== 'list_lit') return;

  const kids = valueChildren(entry);
  const first = kids[0];
  if (!first) return;
  let base: string | null = null;
  if (first.type === 'sym_lit') base = symParts(first, ctx.source).name;
  else if (first.type === 'str_lit') base = stringContent(first, ctx.source); // shadow-cljs npm require
  if (!base) return;
  const full = prefix ? `${prefix}.${base}` : base;

  // Prefix form: `(my.app [db :as db] core)` — sub-entries are vecs/syms/lists.
  const subEntries = kids
    .slice(1)
    .filter((k) => k.type === 'vec_lit' || k.type === 'list_lit' || k.type === 'sym_lit');
  const hasOptions = kids.some((k) => k.type === 'kwd_lit');
  if (subEntries.length > 0 && !hasOptions) {
    for (const sub of subEntries) parseRequireEntry(sub, full, ctx, state);
    return;
  }

  createRequire(full, entry, ctx);

  for (let i = 1; i < kids.length - 1; i++) {
    const k = kids[i]!;
    if (k.type !== 'kwd_lit') continue;
    const opt = getNodeText(k, ctx.source).replace(/^:+/, '');
    const value = kids[i + 1];
    if (!value) continue;
    if ((opt === 'as' || opt === 'as-alias') && value.type === 'sym_lit') {
      state.aliases.set(symParts(value, ctx.source).name, full);
    } else if (opt === 'refer' && value.type === 'vec_lit') {
      for (const refSym of valueChildren(value)) {
        if (refSym.type === 'sym_lit') {
          state.refers.set(symParts(refSym, ctx.source).name, full);
        }
      }
    }
  }
}

function createRequire(nsName: string, node: SyntaxNode, ctx: ExtractorContext): void {
  ctx.createNode('import', nsName, node, {
    signature: getNodeText(node, ctx.source).trim(),
  });
  emitRef(ctx, node, nsName, 'imports');
}

/** One `:import` entry: `(java.time Instant Duration)` or `java.util.Date`. External — import nodes only, no refs. */
function parseImportEntry(entry: SyntaxNode, ctx: ExtractorContext): void {
  if (entry.type === 'sym_lit') {
    ctx.createNode('import', symParts(entry, ctx.source).name, entry, {
      signature: getNodeText(entry, ctx.source).trim(),
    });
    return;
  }
  if (entry.type !== 'list_lit' && entry.type !== 'vec_lit') return;
  const kids = valueChildren(entry);
  const pkg = kids[0];
  if (!pkg || pkg.type !== 'sym_lit') return;
  const pkgName = symParts(pkg, ctx.source).name;
  for (const cls of kids.slice(1)) {
    if (cls.type === 'sym_lit') {
      ctx.createNode('import', `${pkgName}.${symParts(cls, ctx.source).name}`, cls, {
        signature: getNodeText(entry, ctx.source).trim(),
      });
    }
  }
}

/** `(defn name docstring? attr-map? [params] body)` or multi-arity `(defn name ([a] ...) ([a b] ...))`. */
function handleDefn(
  list: SyntaxNode,
  kids: SyntaxNode[],
  ctx: ExtractorContext,
  privateForm: boolean
): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') {
    for (const kid of kids.slice(1)) walkForm(kid, ctx);
    return;
  }
  const name = symParts(nameSym, ctx.source).name;
  const isPrivate = privateForm || hasPrivateMeta(nameSym, ctx.source);

  let docstring: string | undefined;
  const arities: { params: SyntaxNode; body: SyntaxNode[] }[] = [];

  let i = 2;
  if (kids[i]?.type === 'str_lit') {
    docstring = stringContent(kids[i]!, ctx.source);
    i++;
  }
  if (kids[i]?.type === 'map_lit') i++; // attr-map

  if (kids[i]?.type === 'vec_lit') {
    arities.push({ params: kids[i]!, body: kids.slice(i + 1) });
  } else {
    // Multi-arity: each remaining list is ([params] body...)
    for (const arity of kids.slice(i)) {
      if (arity.type !== 'list_lit') continue;
      const arityKids = valueChildren(arity);
      if (arityKids[0]?.type === 'vec_lit') {
        arities.push({ params: arityKids[0]!, body: arityKids.slice(1) });
      }
    }
  }

  const fnNode = ctx.createNode('function', name, list, {
    signature: arities.map((a) => getNodeText(a.params, ctx.source)).join(' ') || undefined,
    docstring,
    visibility: isPrivate ? 'private' : 'public',
    isExported: !isPrivate,
  });
  if (!fnNode) return;
  const state = getNsState(list);
  ctx.pushScope(fnNode.id);
  for (const a of arities) walkBodyWithParams(a.params, a.body, ctx, state);
  ctx.popScope();
}

/** `(def name value)` / `(defonce name value)` — var, constant, or function-valued def. */
function handleDef(list: SyntaxNode, kids: SyntaxNode[], ctx: ExtractorContext): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  const name = symParts(nameSym, ctx.source).name;
  const isPrivate = hasPrivateMeta(nameSym, ctx.source);

  let docstring: string | undefined;
  let valueIdx = 2;
  if (kids.length > 3 && kids[2]?.type === 'str_lit') {
    docstring = stringContent(kids[2]!, ctx.source);
    valueIdx = 3;
  }
  const value = kids[valueIdx];

  // (def handler (fn [req] ...)) / (def handler #(...)) — a function in disguise.
  if (value) {
    const isFnList =
      value.type === 'list_lit' &&
      (() => {
        const h = valueChildren(value)[0];
        if (!h || h.type !== 'sym_lit') return false;
        const hn = symParts(h, ctx.source).name;
        return hn === 'fn' || hn === 'fn*';
      })();
    if (isFnList || value.type === 'anon_fn_lit') {
      const fnNode = ctx.createNode('function', name, list, {
        docstring,
        visibility: isPrivate ? 'private' : 'public',
        isExported: !isPrivate,
      });
      if (fnNode) {
        ctx.pushScope(fnNode.id);
        walkForm(value, ctx);
        ctx.popScope();
      }
      return;
    }
  }

  const kind = value && LITERAL_TYPES.has(value.type) ? 'constant' : 'variable';
  const defNode = ctx.createNode(kind, name, list, {
    docstring,
    visibility: isPrivate ? 'private' : 'public',
    isExported: !isPrivate,
  });
  if (defNode && value) {
    ctx.pushScope(defNode.id);
    walkForm(value, ctx);
    ctx.popScope();
  }
}

/** `(defprotocol Storage (put [this k v]) (fetch [this k]))` / `definterface`. */
function handleProtocol(
  list: SyntaxNode,
  kids: SyntaxNode[],
  ctx: ExtractorContext,
  kind: 'protocol' | 'interface'
): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  const name = symParts(nameSym, ctx.source).name;
  const docNode = kids[2]?.type === 'str_lit' ? kids[2] : undefined;

  const protoNode = ctx.createNode(kind, name, list, {
    docstring: docNode ? stringContent(docNode, ctx.source) : undefined,
    isExported: true,
  });
  if (!protoNode) return;
  ctx.pushScope(protoNode.id);
  for (const sig of kids.slice(2)) {
    if (sig.type !== 'list_lit') continue;
    const sigKids = valueChildren(sig);
    const mSym = sigKids[0];
    if (!mSym || mSym.type !== 'sym_lit') continue;
    const params = sigKids
      .filter((k) => k.type === 'vec_lit')
      .map((k) => getNodeText(k, ctx.source))
      .join(' ');
    const mDoc = sigKids.find((k) => k.type === 'str_lit');
    ctx.createNode('method', symParts(mSym, ctx.source).name, sig, {
      signature: params || undefined,
      docstring: mDoc ? stringContent(mDoc, ctx.source) : undefined,
    });
  }
  ctx.popScope();
}

/** `(defrecord MemStore [state] Storage (put [_ k v] ...))` / `deftype`. */
function handleRecord(
  list: SyntaxNode,
  kids: SyntaxNode[],
  ctx: ExtractorContext,
  isRecord: boolean
): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  const name = symParts(nameSym, ctx.source).name;
  const fieldsVec = kids[2]?.type === 'vec_lit' ? kids[2] : undefined;

  const classNode = ctx.createNode('class', name, list, {
    signature: fieldsVec ? getNodeText(fieldsVec, ctx.source) : undefined,
    isExported: true,
  });
  if (!classNode) return;

  // defrecord implicitly defines positional + map constructors; creating them
  // as function nodes lets `(->MemStore ...)` call sites resolve by name.
  if (isRecord) {
    ctx.createNode('function', `->${name}`, list, {
      signature: fieldsVec ? getNodeText(fieldsVec, ctx.source) : undefined,
      isExported: true,
    });
    ctx.createNode('function', `map->${name}`, list, { isExported: true });
  }

  ctx.pushScope(classNode.id);
  if (fieldsVec) {
    for (const f of valueChildren(fieldsVec)) {
      if (f.type === 'sym_lit') ctx.createNode('field', symParts(f, ctx.source).name, f);
    }
  }
  for (const member of kids.slice(fieldsVec ? 3 : 2)) {
    if (member.type === 'sym_lit') {
      // Protocol / interface being implemented
      emitRef(ctx, member, symParts(member, ctx.source).name, 'implements');
    } else if (member.type === 'list_lit') {
      handleMethodImpl(member, ctx);
    }
  }
  ctx.popScope();
}

/** `(put [_ k v] (swap! state assoc k v))` inside defrecord/deftype — a method node + body walk. */
function handleMethodImpl(impl: SyntaxNode, ctx: ExtractorContext): void {
  const kids = valueChildren(impl);
  const mSym = kids[0];
  if (!mSym || mSym.type !== 'sym_lit') return;
  const paramsVec = kids[1]?.type === 'vec_lit' ? kids[1] : undefined;
  const mNode = ctx.createNode('method', symParts(mSym, ctx.source).name, impl, {
    signature: paramsVec ? getNodeText(paramsVec, ctx.source) : undefined,
  });
  if (!mNode) return;
  ctx.pushScope(mNode.id);
  walkBodyWithParams(paramsVec, kids.slice(paramsVec ? 2 : 1), ctx, getNsState(impl));
  ctx.popScope();
}

/** `(defmulti render :type)` — the dispatch entry point. */
function handleDefmulti(list: SyntaxNode, kids: SyntaxNode[], ctx: ExtractorContext): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  let docstring: string | undefined;
  let dispatchIdx = 2;
  if (kids[2]?.type === 'str_lit') {
    docstring = stringContent(kids[2]!, ctx.source);
    dispatchIdx = 3;
  }
  const dispatch = kids[dispatchIdx];
  const fnNode = ctx.createNode('function', symParts(nameSym, ctx.source).name, list, {
    signature: dispatch ? getNodeText(dispatch, ctx.source) : undefined,
    docstring,
    isExported: true,
  });
  if (fnNode && dispatch) {
    ctx.pushScope(fnNode.id);
    walkForm(dispatch, ctx);
    ctx.popScope();
  }
}

/**
 * `(defmethod render :button [w] ...)` — an implementation of the multimethod
 * (same name → overload). For a foreign multimethod — `(defmethod ig/init-key
 * ::server ...)` — the node is named by the method name (`init-key`) with the
 * dispatch value in the signature: slightly mislabeled (the local file doesn't
 * own `init-key`), but deliberately kept — it's exactly what a search for the
 * integrant/multimethod key needs to find.
 */
function handleDefmethod(list: SyntaxNode, kids: SyntaxNode[], ctx: ExtractorContext): void {
  const nameSym = kids[1];
  if (!nameSym || nameSym.type !== 'sym_lit') return;
  const dispatchVal = kids[2];
  const paramsIdx = kids.findIndex((k, idx) => idx >= 3 && k.type === 'vec_lit');
  const params = paramsIdx >= 0 ? getNodeText(kids[paramsIdx]!, ctx.source) : '';
  const fnNode = ctx.createNode('function', symParts(nameSym, ctx.source).name, list, {
    signature: `${dispatchVal ? getNodeText(dispatchVal, ctx.source) : ''} ${params}`.trim() || undefined,
  });
  if (!fnNode) return;
  ctx.pushScope(fnNode.id);
  walkBodyWithParams(
    paramsIdx >= 0 ? kids[paramsIdx] : undefined,
    kids.slice(paramsIdx >= 0 ? paramsIdx + 1 : 3),
    ctx,
    getNsState(list)
  );
  ctx.popScope();
}

/**
 * `reify` / `proxy` / `extend-protocol` / `extend-type` bodies: inline method
 * impls `(method [args] body)` are anonymous — no nodes created, but their
 * bodies are walked so calls attribute to the enclosing function. Other
 * children walk normally.
 */
function handleInlineImpl(kids: SyntaxNode[], ctx: ExtractorContext): void {
  for (const kid of kids.slice(1)) {
    if (kid.type === 'list_lit') {
      const implKids = valueChildren(kid);
      if (implKids[0]?.type === 'sym_lit' && implKids[1]?.type === 'vec_lit') {
        walkBodyWithParams(implKids[1], implKids.slice(2), ctx, getNsState(kid));
        continue;
      }
    }
    walkForm(kid, ctx);
  }
}

// ---------------------------------------------------------------------------
// EDN data mode (.edn files: deps.edn, bb.edn, shadow-cljs.edn, system configs)
// ---------------------------------------------------------------------------

/**
 * Recursively collect qualified-symbol references (`app.core/init` in a
 * shadow-cljs `:main`, integrant component maps, …) from an EDN value.
 * Bare symbols are data, not code — only namespaced symbols are precise
 * enough to reference.
 */
function scanEdnValueForRefs(node: SyntaxNode, ctx: ExtractorContext): void {
  if (node.type === 'sym_lit') {
    const { ns, name } = symParts(node, ctx.source);
    if (ns) {
      // `app.core/init` → app.core::init; single-segment ns (rare in EDN) is
      // still emitted — there is no alias table in a data file to consult.
      emitRef(ctx, node, `${ns}::${name}`, 'references');
    }
    return;
  }
  for (const child of valueChildren(node)) scanEdnValueForRefs(child, ctx);
}

/**
 * EDN is data: never emit `calls`, never interpret list heads. Top-level map
 * keys become `property` nodes (one level only, so multi-megabyte fixture
 * files can't explode the graph), and every qualified symbol in their values
 * becomes a `references` edge to the code it names.
 */
function handleEdnTopLevel(node: SyntaxNode, ctx: ExtractorContext): void {
  if (node.type === 'map_lit' || node.type === 'ns_map_lit') {
    const kids = valueChildren(node);
    // A config map (deps.edn, shadow-cljs.edn, system.edn) has dozens of keys
    // at most. Thousands of keys means a dataset (translation dicts, icon
    // tables) — extracting those as property nodes explodes the graph with
    // pure data (measured: logseq's locale dicts alone added 40k nodes).
    // Skip the nodes entirely but still scan for code references.
    if (kids.length / 2 > 64) {
      scanEdnValueForRefs(node, ctx);
      return;
    }
    for (let i = 0; i + 1 < kids.length; i += 2) {
      const key = kids[i]!;
      const value = kids[i + 1]!;
      if (key.type !== 'kwd_lit') {
        scanEdnValueForRefs(key, ctx);
        scanEdnValueForRefs(value, ctx);
        continue;
      }
      const keyText = getNodeText(key, ctx.source);
      const valuePreview = getNodeText(value, ctx.source).replace(/\s+/g, ' ');
      const prop = ctx.createNode('property', keyText, key, {
        signature: valuePreview.length > 80 ? `${valuePreview.slice(0, 77)}...` : valuePreview,
      });
      if (prop) {
        ctx.pushScope(prop.id);
        scanEdnValueForRefs(value, ctx);
        ctx.popScope();
      } else {
        scanEdnValueForRefs(value, ctx);
      }
    }
    return;
  }
  // Top-level vector/list/etc. (fixture data) — refs only, no nodes.
  scanEdnValueForRefs(node, ctx);
}

/** `(letfn [(f [x] ...) (g [y] ...)] body)` — local fn bindings, then body. */
function handleLetfn(kids: SyntaxNode[], ctx: ExtractorContext, state: NsState): void {
  const frame = new Set<string>();
  state.locals.push(frame);
  const bindings = kids[1];
  if (bindings?.type === 'vec_lit') {
    // The local fn NAMES are in scope in every binding body and the letfn
    // body (mutual recursion), so collect them all before walking anything.
    for (const binding of valueChildren(bindings)) {
      if (binding.type !== 'list_lit') continue;
      const bSym = valueChildren(binding)[0];
      if (bSym?.type === 'sym_lit') collectBindingNames(bSym, ctx.source, frame);
    }
    for (const binding of valueChildren(bindings)) {
      if (binding.type !== 'list_lit') continue;
      const bKids = valueChildren(binding);
      const paramsVec = bKids[1]?.type === 'vec_lit' ? bKids[1] : undefined;
      walkBodyWithParams(paramsVec, bKids.slice(paramsVec ? 2 : 1), ctx, state);
    }
  }
  for (const form of kids.slice(2)) walkForm(form, ctx);
  state.locals.pop();
}

export const clojureExtractor: LanguageExtractor = {
  // The grammar has no semantic node types — everything routes through the
  // visitNode hook below; the core's declarative dispatch never fires.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'params',

  visitNode: (node, ctx) => {
    const t = node.type;

    // .edn files are pure data — property nodes + references, never calls.
    if (ctx.filePath.endsWith('.edn')) {
      if (t === 'source') return false; // walk top-level forms
      if (t === 'comment' || t === 'dis_expr') return true;
      handleEdnTopLevel(node, ctx);
      return true;
    }

    if (t === 'list_lit') {
      handleList(node, ctx);
      return true;
    }
    // Discarded (`#_form`) and quoted data are not code.
    if (t === 'dis_expr' || t === 'quoting_lit') return true;
    // Everything else (source root, top-level vecs/maps, reader conditionals)
    // returns false so the core walks children and this hook sees the lists.
    return false;
  },
};
