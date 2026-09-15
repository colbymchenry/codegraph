/**
 * Symbol Lookup — the single "what did the user mean by this name?" path.
 *
 * Every verb that takes a symbol NAME from a human (or an agent) has to turn
 * that string into node(s). `codegraph_node` and `codegraph_explore` went
 * through the matcher below; the `callers` / `callees` / `impact` CLI verbs
 * carried their own ad-hoc filter instead:
 *
 *     node.name === symbol || node.name.endsWith('.' + symbol)
 *
 * which compares the query against the BARE name only. That produced two
 * opposite failures in the same repository:
 *
 *   - a bare name over-reported: `callers group` silently merged the callers of
 *     every distinct symbol named `group` — in any language — into one list
 *     headed "Callers of group", with nothing saying they were different
 *     symbols;
 *   - a qualified name under-reported: `Foo.Bar.baz` can never equal a bare
 *     `baz`, so every candidate failed the filter and the code fell through to
 *     an arbitrary top-of-FTS hit — or reported "not found" for a symbol that
 *     plainly exists.
 *
 * Both are fixed by routing all of them through one resolver, which this module
 * owns so the CLI and the MCP tools cannot drift apart again.
 */

import type { Node } from '../types';

const HASKELL_FLOW_ID_CONTINUE_SOURCE = String.raw`[\p{L}\p{Mn}\p{N}_']`;
// Flow tokenization is shared by every language. `$` is not a Haskell id
// character, but it is a legal leading/continuing character in JavaScript-like
// identifiers and was supported here before the Haskell Unicode expansion.
// Keep the broader spelling out of CONID/module parsing while preserving that
// cross-language contract.
const FLOW_IDENTIFIER_CONTINUE_SOURCE = String.raw`[\p{L}\p{M}\p{N}_'$]`;
export const HASKELL_FLOW_IDENTIFIER_SOURCE = String.raw`[\p{Ll}\p{Lo}\p{Lu}\p{Lt}_$]${FLOW_IDENTIFIER_CONTINUE_SOURCE}*#*`;
const HASKELL_FLOW_CONID_SOURCE = String.raw`(?:[\p{Lu}\p{Lt}]${HASKELL_FLOW_ID_CONTINUE_SOURCE}*)`;
export const HASKELL_FLOW_MODULE_SOURCE = String.raw`${HASKELL_FLOW_CONID_SOURCE}(?:\.${HASKELL_FLOW_CONID_SOURCE})*`;
export const QUALIFIED_OPERATOR_CONTAINER_SOURCE = String.raw`${HASKELL_FLOW_CONID_SOURCE}(?:(?:\.|::)${HASKELL_FLOW_CONID_SOURCE})*`;
const HASKELL_ASCII_OPERATOR_BODY = /^[-!#$%&*+.\/<=>?@\\^|~:]+$/;
const HASKELL_UNICODE_SYMBOL_OR_PUNCTUATION = /^[\p{S}\p{P}]$/u;
const HASKELL_OPERATOR_FORBIDDEN = new Set(['(', ')', '[', ']', '{', '}', ',', ';', '`', '_', '"', "'"]);

export function isHaskellOperatorBody(value: string): boolean {
  if (!value) return false;
  if (HASKELL_ASCII_OPERATOR_BODY.test(value)) return true;
  return [...value].every((char) =>
    !HASKELL_OPERATOR_FORBIDDEN.has(char)
    && (HASKELL_ASCII_OPERATOR_BODY.test(char)
      || HASKELL_UNICODE_SYMBOL_OR_PUNCTUATION.test(char))
  );
}

interface QualifiedHaskellOperator {
  moduleName: string;
  operatorBody: string;
  nodeName: string;
  canonical: string;
}

/** Parse `M.<+>`, `(M.<+>)`, `M::<+>`, or canonical `M::(<+>)`. */
export function qualifiedHaskellOperator(symbol: string): QualifiedHaskellOperator | null {
  let value = symbol.trim();
  if (value.startsWith('(') && value.endsWith(')')) value = value.slice(1, -1).trim();
  const canonical = value.match(new RegExp(
    `^(${QUALIFIED_OPERATOR_CONTAINER_SOURCE})::\\(([^()\\s]+)\\)$`,
    'u',
  ));
  const colonRaw = canonical ? null : value.match(new RegExp(
    `^(${QUALIFIED_OPERATOR_CONTAINER_SOURCE})::([^()\\s]+)$`,
    'u',
  ));
  const dotted = canonical || colonRaw ? null : value.match(new RegExp(
    `^(${HASKELL_FLOW_MODULE_SOURCE})\\.([^()\\s]+)$`,
    'u',
  ));
  const match = canonical ?? colonRaw ?? dotted;
  if (!match || !isHaskellOperatorBody(match[2]!)) return null;
  const moduleName = match[1]!;
  const operatorBody = match[2]!;
  const nodeName = `(${operatorBody})`;
  return { moduleName, operatorBody, nodeName, canonical: `${moduleName}::${nodeName}` };
}

export function qualifiedHaskellOperatorMatches(node: Node, parsed: QualifiedHaskellOperator): boolean {
  if (node.language === 'haskell') {
    if (node.name !== parsed.nodeName) return false;
    // Without graph context only a module-scope declaration is provable. A
    // nested local/instance implementation is not addressable as `Module.<+>`.
    return node.qualifiedName === parsed.canonical;
  }
  // `Module.<+>` is also valid in languages such as Scala. The tokenizer uses
  // the parenthesized Haskell canonical form because it has no project/language
  // context, so recover the pre-existing non-Haskell lookup explicitly and
  // exactly instead of dropping those symbols or falling back to fuzzy FTS.
  if (node.name !== parsed.operatorBody) return false;
  const containers = new Set([
    parsed.moduleName,
    parsed.moduleName.replace(/\./g, '::'),
  ]);
  return [...containers].some((container) => {
    const suffix = `${container}::${parsed.operatorBody}`;
    return node.qualifiedName === suffix || node.qualifiedName.endsWith(`::${suffix}`);
  });
}

/** Rust path prefixes that name no directory (`crate::x`, `super::y`). */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/** Does this query carry any scope qualifier at all? */
export function isQualifiedSymbol(symbol: string): boolean {
  return /[.\/]|::/.test(symbol);
}

/** The bare identifier at the end of a qualified query (arity spelling stripped). */
export function lastQualifierPart(symbol: string): string {
  const haskellOperator = qualifiedHaskellOperator(symbol);
  if (haskellOperator) return haskellOperator.nodeName;
  const bareOperator = /^\(([^()\s]+)\)$/.exec(symbol)?.[1];
  if (bareOperator && isHaskellOperatorBody(bareOperator)) return symbol;
  const noArity = symbol.replace(/\/\d{1,3}$/, '') || symbol;
  const parts = noArity.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Rewrite every scope separator to `.` so a query and a stored qualifiedName
 * written in different conventions can be compared directly. The extractors
 * join hierarchy with `::` while users type the language's own spelling
 * (`Session.request`, `stage_apply::run`, `pkg/mod.Fn`).
 */
function canonicalScope(text: string): string {
  return text.replace(/::/g, '.').replace(/\//g, '.');
}

/**
 * Does `node` satisfy the user's symbol query?
 *
 * Bare queries match the name. Qualified queries are checked against the
 * qualifiedName under both separator conventions, then — for languages whose
 * hierarchy lives in the file path rather than the name (Rust modules, Python
 * packages) — against the path.
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  const haskellOperator = qualifiedHaskellOperator(symbol);
  if (haskellOperator) return qualifiedHaskellOperatorMatches(node, haskellOperator);
  // Erlang arity spelling (`fn/3`, `mod:fn/3`): when the node's qualifiedName
  // carries an arity (#1610) the written arity must match exactly, and the rest
  // of the comparison runs on the arity-less spelling. A node with no arity
  // keeps the original symbol (a `/` there means a path-ish name instead).
  const aritySpelling = /^(.+)\/(\d{1,3})$/.exec(symbol);
  if (aritySpelling) {
    const nodeArity = /\/(\d{1,3})$/.exec(node.qualifiedName ?? '')?.[1];
    if (nodeArity !== undefined) {
      if (nodeArity !== aritySpelling[2]) return false;
      symbol = aritySpelling[1]!;
    }
  }

  if (node.name === symbol) return true;
  // File basename match ("product-card" matches "product-card.liquid").
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  if (!isQualifiedSymbol(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Stage 1: qualified-name containment under the extractor's `::` convention.
  if (node.qualifiedName.includes(parts.join('::'))) return true;

  // Stage 1b: boundary-aligned suffix under a canonical separator.
  //
  // Splitting on EVERY separator assumes no scope component contains one —
  // false for any language whose module names are themselves dotted (Elixir
  // `AppWeb.Format`, a Java/C# package, a Python dotted module). There the
  // stored qualifiedName is `AppWeb.Format::group`, so the stage-1 spelling
  // `AppWeb::Format::group` cannot match and a perfectly precise query
  // resolved to nothing. Canonicalising both sides and requiring the match to
  // land on a separator boundary handles both conventions with one rule, and
  // is strictly tighter than the `includes` above.
  const canonicalQuery = canonicalScope(symbol);
  const canonicalNode = canonicalScope(node.qualifiedName);
  if (canonicalNode === canonicalQuery || canonicalNode.endsWith(`.${canonicalQuery}`)) {
    return true;
  }

  // Stage 2: file-path containment. Rust modules and Python packages are not in
  // qualifiedName — they are encoded in the path — so `stage_apply::run`
  // matches a `run` in any file with a `stage_apply` path segment.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;
  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

/** The slice of CodeGraph a symbol lookup needs — keeps this module testable. */
export interface SymbolLookupHost {
  getNodesByName(name: string): Node[];
  searchNodes(query: string, options?: { limit?: number }): Array<{ node: Node }>;
  generatedFilePredicate(paths: string[]): (path: string) => boolean;
}

export interface SymbolLookupResult {
  /** Every definition the query names, keepers before generated stubs. */
  nodes: Node[];
  /**
   * The query named more than one distinct definition. Callers that aggregate
   * across all of them MUST surface this — an aggregate presented as one
   * symbol's answer is the over-reporting failure described at the top.
   */
  ambiguous: boolean;
}

/**
 * One group per (filePath, qualifiedName): same-file overloads stay together,
 * while unrelated definitions keep their own edges. Shared by CLI and MCP.
 * A non-matching file hint keeps all definitions and must be disclosed.
 */
export function groupDefinitions(
  nodes: Node[],
  fileFilter?: string
): { groups: Node[][]; filteredOut: boolean } {
  let pool = nodes;
  let filteredOut = false;
  if (fileFilter) {
    const wanted = fileFilter.replace(/^\.\//, '');
    const narrowed = pool.filter(
      (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
    );
    if (narrowed.length > 0) pool = narrowed;
    else filteredOut = true;
  }
  const byDef = new Map<string, Node[]>();
  for (const n of pool) {
    const key = `${n.filePath}|${n.qualifiedName}`;
    const group = byDef.get(key);
    if (group) group.push(n);
    else byDef.set(key, [n]);
  }
  return { groups: [...byDef.values()], filteredOut };
}

/**
 * Resolve a user-supplied symbol name to the definitions it names.
 *
 * The exact-name index is consulted FIRST and is authoritative: it is complete
 * and uncapped, whereas FTS ranks and truncates, and tokenises away `::` — so
 * a qualified query could miss a symbol that exists, or land on whatever
 * happened to rank first. FTS candidates still have to satisfy the matcher;
 * partial or mistyped names must never select the top fuzzy hit (#1473).
 */
export function lookupSymbolNodes(cg: SymbolLookupHost, symbol: string): SymbolLookupResult {
  const qualified = isQualifiedSymbol(symbol);

  // Exact-name index, then filter by the qualifier the user actually wrote.
  const tail = qualified ? lastQualifierPart(symbol) : symbol;
  let nodes = tail ? cg.getNodesByName(tail) : [];
  if (qualified) nodes = nodes.filter((n) => matchesSymbol(n, symbol));

  if (nodes.length === 0) {
    const hits = cg.searchNodes(symbol, { limit: 50 }).map((h) => h.node);
    const exact = hits.filter((n) => matchesSymbol(n, symbol));
    if (exact.length > 0) {
      nodes = exact;
    }
    // Any query with no exact match resolves to NOTHING rather than a
    // misleading fuzzy hit (#1473; qualified lookups already did this in #173).
  }

  if (nodes.length === 0) return { nodes: [], ambiguous: false };

  // Keepers before generated stubs (.pb.go and friends), stable otherwise.
  const isGenerated = cg.generatedFilePredicate(nodes.map((n) => n.filePath));
  const ranked = [...nodes].sort(
    (a, b) => (isGenerated(a.filePath) ? 1 : 0) - (isGenerated(b.filePath) ? 1 : 0)
  );
  return { nodes: ranked, ambiguous: groupDefinitions(ranked).groups.length > 1 };
}

/** One-line "kind at path:line" label used when disclosing an ambiguous query. */
export function describeSymbolNode(node: Node): string {
  return `${node.kind} ${node.qualifiedName || node.name} (${node.language}) — ${node.filePath}:${node.startLine}`;
}
