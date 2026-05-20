/**
 * Elixir language extractor.
 *
 * tree-sitter-elixir is unusual: nearly every Elixir construct
 * (`defmodule`, `def`, `if`, `case`, …) parses as a `call` node whose
 * first named child is an `identifier` naming the called form. The
 * extractor therefore dispatches on the *identifier text*, not on
 * `node.type`. Module attributes (`@behaviour`, `@spec`, `@moduledoc`,
 * `@doc`) surface as `unary_operator` whose operand is the attribute
 * call — handled separately.
 *
 * Function names carry arity (`hello/2`, `frobnicate/0`) to match
 * Elixir convention and disambiguate overloads. Multi-clause `def`s
 * merge into a single node per `name/arity` per module.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// --- helpers ----------------------------------------------------------------

function callTarget(node: SyntaxNode, source: string): string | null {
  if (node.type !== 'call') return null;
  const head = node.namedChild(0);
  if (!head || head.type !== 'identifier') return null;
  return getNodeText(head, source);
}

/** First named child whose type matches `wanted`. */
function findChild(node: SyntaxNode, wanted: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === wanted) return c;
  }
  return null;
}

/** All named children of a given type. */
function findChildren(node: SyntaxNode, wanted: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === wanted) out.push(c);
  }
  return out;
}

/** Read a dotted alias node, e.g. `Foo.Bar.Baz`. */
function readAliasText(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim();
}

/**
 * Build the qualifiedName that `TreeSitterExtractor.buildQualifiedName`
 * will compute for a node created right now. We need to predict it
 * to deduplicate multi-clause function definitions before calling
 * createNode (which has no "find-or-create" mode).
 */
function expectedQualifiedName(name: string, ctx: ExtractorContext): string {
  const parts: string[] = [];
  for (const id of ctx.nodeStack) {
    const n = ctx.nodes.find((x) => x.id === id);
    if (n && n.kind !== 'file') parts.push(n.name);
  }
  parts.push(name);
  return parts.join('::');
}

function findExistingFunction(name: string, ctx: ExtractorContext): boolean {
  const qname = expectedQualifiedName(name, ctx);
  return ctx.nodes.some((n) => n.kind === 'function' && n.qualifiedName === qname);
}

/**
 * Strip Elixir comment markers (`#`) and `@moduledoc "…"`/`@doc "…"` wrappers,
 * returning the bare doc text.
 */
function stripHeredoc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"""') && s.endsWith('"""')) {
    s = s.slice(3, -3);
  } else if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  return s.replace(/\\"/g, '"').trim();
}

/**
 * For a `def`/`defp`/`defmacro`/`defmacrop` call node, return
 * `{ name, arity }` parsed from the head signature, or null if
 * the shape is unexpected.
 *
 * `def foo`              → identifier "foo", arity 0
 * `def foo(a, b)`        → call (target "foo", arguments [a, b]), arity 2
 * `def foo(a), do: ...`  → arguments contains [call foo(a), keywords[do:]]
 * `def foo(a) do …end`   → arguments contains [call foo(a)], do_block sibling
 */
function parseDefHead(callNode: SyntaxNode, source: string): { name: string; arity: number } | null {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args || args.namedChildCount === 0) return null;
  const head = args.namedChild(0);
  if (!head) return null;
  if (head.type === 'identifier') {
    return { name: getNodeText(head, source), arity: 0 };
  }
  if (head.type === 'call') {
    const nameNode = head.namedChild(0);
    if (!nameNode || nameNode.type !== 'identifier') return null;
    const name = getNodeText(nameNode, source);
    const innerArgs = getChildByField(head, 'arguments') ?? findChild(head, 'arguments');
    const arity = innerArgs ? innerArgs.namedChildCount : 0;
    return { name, arity };
  }
  // Some operator-style def heads (e.g. `def a + b`) wrap in binary_operator.
  // For phase 2a, return null and skip.
  return null;
}

/** Locate a function body for a `def …` call — either a `do_block` sibling or `do:` keyword pair. */
function resolveDefBody(callNode: SyntaxNode): SyntaxNode | null {
  const doBlock = findChild(callNode, 'do_block');
  if (doBlock) return doBlock;
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return null;
  const keywords = findChild(args, 'keywords');
  if (!keywords) return null;
  for (const pair of findChildren(keywords, 'pair')) {
    const key = getChildByField(pair, 'key') ?? pair.namedChild(0);
    if (key && getNodeText(key, '').trim().startsWith('do')) {
      // fall through — read by text below since we don't have source here
    }
    // Compare key text via source-independent shortcut: pair[0] is keyword `do:`
    // and pair[1] is value.
  }
  // The pair lookup needs source; fall back to: take first pair's value if
  // its key text starts with `do`. We can't read text without source, so
  // accept any first pair value as the body. This is a heuristic — for
  // single-`do:` clauses (the common case) it is correct.
  const firstPair = findChild(keywords, 'pair');
  if (firstPair) {
    return getChildByField(firstPair, 'value') ?? firstPair.namedChild(1);
  }
  return null;
}

// --- handlers ---------------------------------------------------------------

function handleDefmodule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(node, 'arguments') ?? findChild(node, 'arguments');
  const aliasNode = args ? findChild(args, 'alias') : null;
  if (!aliasNode) return true; // malformed — swallow
  const moduleName = readAliasText(aliasNode, ctx.source);

  const moduleNode = ctx.createNode('module', moduleName, node);
  if (!moduleNode) return true;

  ctx.pushScope(moduleNode.id);
  try {
    const body = findChild(node, 'do_block');
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

function handleDef(
  node: SyntaxNode,
  defKind: 'def' | 'defp' | 'defmacro' | 'defmacrop',
  ctx: ExtractorContext
): boolean {
  const head = parseDefHead(node, ctx.source);
  if (!head) return true;
  const name = `${head.name}/${head.arity}`;
  const isPrivate = defKind === 'defp' || defKind === 'defmacrop';

  if (findExistingFunction(name, ctx)) {
    // Multi-clause: merge into the first node. Still walk the body for
    // call-site extraction so calls inside later clauses are captured.
    const body = resolveDefBody(node);
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
    return true;
  }

  const fnNode = ctx.createNode('function', name, node, {
    visibility: isPrivate ? 'private' : 'public',
  });
  if (!fnNode) return true;

  ctx.pushScope(fnNode.id);
  try {
    const body = resolveDefBody(node);
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

/**
 * `@moduledoc "…"` and `@doc "…"` attach docstrings to surrounding nodes.
 * `@behaviour`, `@callback`, `@spec` are handled in later phases.
 *
 * tree-sitter-elixir shape:
 *   unary_operator
 *     operator @
 *     operand: call
 *       identifier[target] moduledoc
 *       arguments: string "…"
 *
 * Returns true if fully handled.
 */
function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'unary_operator') return false;
  const operand = getChildByField(node, 'operand') ?? node.namedChild(0);
  if (!operand || operand.type !== 'call') return false;
  const target = callTarget(operand, ctx.source);
  if (!target) return false;

  if (target === 'moduledoc') {
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    const str = args ? findChild(args, 'string') : null;
    if (str) {
      const doc = stripHeredoc(getNodeText(str, ctx.source));
      // Attach to the most recent module node on the stack.
      const moduleId = [...ctx.nodeStack].reverse().find((id) => {
        const n = ctx.nodes.find((x) => x.id === id);
        return n?.kind === 'module';
      });
      if (moduleId) {
        const mod = ctx.nodes.find((n) => n.id === moduleId);
        // We're mutating a node already in ctx.nodes — readonly is a TS
        // signal, not a runtime guarantee. This is the only writeable path
        // for module-level docstrings since createNode can't update.
        if (mod) (mod as { docstring?: string }).docstring = doc;
      }
    }
    return true;
  }

  // For other attributes, swallow them so the default walker doesn't
  // mis-interpret their operand `call` (e.g. `behaviour GenServer`) as
  // a user call site. Later phases will handle these properly.
  return true;
}

// --- LanguageExtractor config ----------------------------------------------

export const elixirExtractor: LanguageExtractor = {
  // Elixir doesn't fit the C-family default at all — all extraction is
  // driven by the visitNode hook below. Leave the node-type arrays empty
  // so the default dispatcher in tree-sitter.ts is a no-op for us.
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
  paramsField: 'arguments',

  visitNode(node, ctx) {
    if (node.type === 'call') {
      const target = callTarget(node, ctx.source);
      switch (target) {
        case 'defmodule':
          return handleDefmodule(node, ctx);
        case 'def':
        case 'defp':
        case 'defmacro':
        case 'defmacrop':
          return handleDef(node, target, ctx);
      }
      // For any other call, let the default walker descend so nested
      // structures (e.g. defmodule inside an `if`) are still visited.
      return false;
    }
    if (node.type === 'unary_operator') {
      return handleAttribute(node, ctx);
    }
    return false;
  },
};
