import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

/**
 * Clojure extraction.
 *
 * Clojure is homoiconic: there are NO definition node types. `(defn f [x] ...)`,
 * `(if a b)` and `(foo 1)` are all the same `list_lit` node, and what a form
 * *means* is decided by its head symbol. So every declarative node-type list
 * below is empty and the whole extraction runs through `visitNode`, dispatching
 * on the head symbol — the hook the core documents for "languages with
 * fundamentally different AST structures".
 *
 * Grammar: vendored sogaiu/tree-sitter-clojure (ABI 14). Shape:
 *   list_lit  → value: sym_lit (head), value: sym_lit (name), value: …
 *   sym_lit   → namespace: sym_ns (optional), name: sym_name
 *   var_quoting_lit → `#'ns/sym` (test suites reference private vars this way)
 */

/**
 * Head symbol → the kind of definition the form introduces.
 *
 * A `Map`, deliberately, NOT an object literal: head symbols come from source
 * text, and `Long/valueOf` (Java interop) reduces to the bare name `valueOf`,
 * which on an object literal resolves up the prototype chain to
 * `Object.prototype.valueOf` — a *function* — and would then be used as a node
 * kind. That produced a non-cloneable node and killed the whole parse worker
 * ("function valueOf() { [native code] } could not be cloned") on real files.
 */
const DEF_KINDS = new Map<string, NodeKind>([
  ['defn', 'function'],
  ['defn-', 'function'],
  ['defmacro', 'function'],
  ['definline', 'function'],
  ['defmulti', 'function'],
  ['deftest', 'function'],
  ['deftest-', 'function'],
  ['defmethod', 'method'],
  ['defprotocol', 'interface'],
  ['definterface', 'interface'],
  ['defrecord', 'class'],
  ['deftype', 'class'],
  ['def', 'constant'],
  ['defonce', 'constant'],
  // mount/integrant-style stateful components, common in service code.
  ['defstate', 'constant'],
]);

/**
 * Clojure convention: a capitalised symbol namespace is a Java class, so
 * `Long/valueOf` / `Date/valueOf` are host-interop statics, not vars in another
 * Clojure namespace. Lower-case namespaces (`shared/…`, `str/…`) are require
 * aliases and DO resolve to project code.
 */
function isHostInterop(namespace: string): boolean {
  return /^[A-Z]/.test(namespace);
}

/**
 * Head symbols that are special forms, binding forms or macros — never a call
 * to a user-defined var, so emitting a `calls` edge for them is pure noise.
 * (The def-macros are excluded separately, via DEF_KINDS.)
 */
const NON_CALL_HEADS = new Set([
  'ns', 'in-ns', 'require', 'import', 'use', 'refer', 'refer-clojure', 'load',
  'let', 'letfn', 'if', 'if-let', 'if-some', 'if-not', 'when', 'when-let',
  'when-some', 'when-not', 'when-first', 'cond', 'condp', 'case', 'do', 'fn',
  'loop', 'recur', 'try', 'catch', 'finally', 'throw', 'quote', 'var', 'set!',
  'new', 'monitor-enter', 'monitor-exit', 'binding', 'with-open',
  'with-redefs', 'with-local-vars', 'with-bindings', 'for', 'doseq', 'dotimes',
  'while', 'and', 'or', 'not', 'comment', 'declare', 'gen-class',
  'proxy', 'reify', 'extend-type', 'extend-protocol', 'this-as',
  '.', '..', '->', '->>', 'some->', 'some->>', 'as->', 'cond->', 'cond->>',
  'doto', 'let*', 'fn*', 'do*',
]);

/** The `value:` children of a list, in source order. */
function values(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

/** Bare name of a `sym_lit` (`str/trim` → `trim`), or null. */
function symName(node: SyntaxNode | null, source: string): string | null {
  if (!node || node.type !== 'sym_lit') return null;
  const name = getChildByField(node, 'name');
  if (!name) return null;
  const text = getNodeText(name, source).trim();
  return text || null;
}

/** Namespace/alias of a `sym_lit` (`str/trim` → `str`), or null when bare. */
function symNamespace(node: SyntaxNode, source: string): string | null {
  const ns = getChildByField(node, 'namespace');
  if (!ns) return null;
  const text = getNodeText(ns, source).trim();
  return text || null;
}

/** Innermost enclosing symbol id, or null at file scope. */
function currentScope(ctx: ExtractorContext): string | null {
  return ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] ?? null : null;
}

function addRef(
  ctx: ExtractorContext,
  name: string,
  kind: 'calls' | 'references' | 'imports',
  node: SyntaxNode,
): void {
  const from = currentScope(ctx);
  if (!from) return;
  ctx.addUnresolvedReference({
    fromNodeId: from,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * `(ns my.app.core (:require [a.b :as b] [c.d :refer [x]]) (:import [java.time Instant]))`
 * — emit the namespace as a module and every required/imported namespace as an
 * import. The first symbol of each `:require` vector is the required namespace;
 * a bare symbol form (`(:require a.b)`) is also legal.
 */
function extractNs(node: SyntaxNode, ctx: ExtractorContext): void {
  const source = ctx.source;
  const vals = values(node);
  const nsName = symName(vals[1] ?? null, source);
  if (!nsName) return;

  ctx.createNode('module', nsName, node, {
    signature: `(ns ${nsName})`,
  });

  for (const clause of vals.slice(2)) {
    if (clause.type !== 'list_lit') continue;
    const head = values(clause)[0];
    if (!head || head.type !== 'kwd_lit') continue;
    const kwdName = getChildByField(head, 'name');
    const directive = kwdName ? getNodeText(kwdName, source).trim() : '';
    if (directive !== 'require' && directive !== 'import' && directive !== 'use') continue;

    for (const spec of values(clause).slice(1)) {
      // `[a.b :as b]` / `[java.time Instant]` → first symbol; `a.b` → itself.
      const target = spec.type === 'vec_lit' ? values(spec)[0] ?? null : spec;
      const modName = symName(target, source);
      if (!modName) continue;
      ctx.createNode('import', modName, spec, {
        signature: getNodeText(spec, source).trim().slice(0, 100),
      });
      addRef(ctx, modName, 'imports', spec);
    }
  }
}

/** Recurse into a slice of children, letting the core dispatch each one. */
function visitAll(children: SyntaxNode[], ctx: ExtractorContext): void {
  for (const child of children) ctx.visitNode(child);
}

export const clojureExtractor: LanguageExtractor = {
  // Every list is `list_lit`; meaning comes from the head symbol, so none of
  // the type-driven machinery applies. All extraction happens in visitNode.
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
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    const source = ctx.source;

    // `#'some.ns/private-var` — how test suites reach private vars. A plain
    // symbol sweep misses these entirely, so capture them as references.
    if (node.type === 'var_quoting_lit') {
      const sym = values(node).find((c) => c.type === 'sym_lit');
      const name = symName(sym ?? null, source);
      if (name) addRef(ctx, name, 'references', node);
      return true;
    }

    // A namespace-qualified symbol in value position (`str/trim` passed as a
    // value, not called) is an unambiguous cross-namespace reference. Bare
    // symbols are NOT captured: most are locals/params, and the noise would
    // swamp the real edges.
    if (node.type === 'sym_lit') {
      const ns = symNamespace(node, source);
      if (ns && !isHostInterop(ns)) {
        const name = symName(node, source);
        if (name) addRef(ctx, name, 'references', node);
      }
      return true;
    }

    if (node.type !== 'list_lit') return false;

    const vals = values(node);
    const head = vals[0];

    // `((constantly 1) x)` and friends — no symbol in head position.
    if (!head || head.type !== 'sym_lit') {
      visitAll(vals, ctx);
      return true;
    }

    const headName = symName(head, source);
    if (!headName) {
      visitAll(vals, ctx);
      return true;
    }

    if (headName === 'ns') {
      extractNs(node, ctx);
      return true;
    }

    const kind = DEF_KINDS.get(headName);
    if (kind) {
      // `(defmethod render :html [x] …)` — the defined name is the second
      // symbol; the dispatch value that follows is not part of the name.
      const nameNode = vals.slice(1).find((c) => c.type === 'sym_lit') ?? null;
      const name = symName(nameNode, source);
      if (name) {
        const params = vals.find((c) => c.type === 'vec_lit');
        const created = ctx.createNode(kind, name, node, {
          signature: params ? getNodeText(params, source).slice(0, 200) : undefined,
          // `defn-` and `^:private` are Clojure's only privacy markers.
          visibility:
            headName.endsWith('-') || /\^:private|\^\{:private true\}/.test(getNodeText(head.parent ?? node, source).slice(0, 120))
              ? 'private'
              : 'public',
        });
        if (created) {
          ctx.pushScope(created.id);
          // Skip the head and the name symbol — the body is everything else.
          visitAll(vals.filter((c) => c !== head && c !== nameNode), ctx);
          ctx.popScope();
          return true;
        }
      }
      visitAll(vals.slice(1), ctx);
      return true;
    }

    // Anything else in head position is a call to a var — qualified
    // (`shared/aggregate-select-exprs`) or bare (`helper`). Special forms and
    // binding macros are excluded so they don't manufacture dead edges.
    const headNs = symNamespace(head, source);
    if (!NON_CALL_HEADS.has(headName) && !(headNs && isHostInterop(headNs))) {
      addRef(ctx, headName, 'calls', head);
    }

    // Descend into the arguments; skip the head, which was just handled (and
    // would otherwise be re-counted by the qualified-symbol branch above).
    visitAll(vals.slice(1), ctx);
    return true;
  },
};
