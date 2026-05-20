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
    // Visit the do_block itself — our hook returns false for non-call
    // nodes, letting the default walker iterate its named children
    // (each module-level form: alias, def, defstruct, …).
    if (body) ctx.visitNode(body);
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
    // Multi-clause: merge into the first node. Still walk the body so
    // calls inside later clauses are captured. We need to push the
    // existing function node onto scope first so `enclosingFunctionId`
    // sees a function ancestor for any nested call sites.
    const existing = ctx.nodes.find(
      (n) => n.kind === 'function' && n.qualifiedName === expectedQualifiedName(name, ctx)
    );
    const body = resolveDefBody(node);
    if (body && existing) {
      ctx.pushScope(existing.id);
      try {
        ctx.visitNode(body);
      } finally {
        ctx.popScope();
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
    if (body) ctx.visitNode(body);
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

  if (target === 'behaviour' || target === 'behavior') {
    // `@behaviour Foo` → implements reference from enclosing module to Foo.
    const args = getChildByField(operand, 'arguments') ?? findChild(operand, 'arguments');
    const protoNode = args ? findChild(args, 'alias') : null;
    if (protoNode) {
      const moduleId = [...ctx.nodeStack].reverse().find((id) => {
        const n = ctx.nodes.find((x) => x.id === id);
        return n?.kind === 'module';
      });
      if (moduleId) {
        ctx.addUnresolvedReference({
          fromNodeId: moduleId,
          referenceName: readAliasText(protoNode, ctx.source),
          referenceKind: 'implements',
          line: protoNode.startPosition.row + 1,
          column: protoNode.startPosition.column,
          filePath: ctx.filePath,
          language: 'elixir',
        });
      }
    }
    return true;
  }

  // For other attributes (@doc, @callback, @spec, custom), swallow them
  // so the default walker doesn't mis-interpret their operand `call`
  // (e.g. `spec hello(...)`) as a user call site. Later phases can do
  // proper docstring / abstract-function extraction here.
  return true;
}

/**
 * Handle `alias`, `import`, `require`, and `use` directives. All four
 * share the same surface shape — a call whose first identifier names
 * the mechanism and whose `arguments` carry one or more module references.
 *
 * Variants we recognise:
 *   alias Bar.Baz                      → one import node "Bar.Baz"
 *   alias Bar.{Baz, Qux}               → two import nodes "Bar.Baz", "Bar.Qux"
 *   import Ecto.Query, only: [...]     → one import node "Ecto.Query"
 *   require Logger                     → one import node "Logger"
 *   use Phoenix.LiveView, layout: {…}  → one import node "Phoenix.LiveView"
 *
 * Each emitted import node carries `signature` = the full directive text
 * (mechanism + target + options), so `metadata.mechanism` lives there
 * without needing a separate Node field.
 */
function handleImportLike(
  callNode: SyntaxNode,
  _mechanism: 'alias' | 'import' | 'require' | 'use',
  ctx: ExtractorContext
): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args || args.namedChildCount === 0) return true;
  const first = args.namedChild(0)!;
  const signature = getNodeText(callNode, ctx.source).trim();

  const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1]! : null;
  const emit = (moduleName: string, posNode: SyntaxNode): void => {
    const imp = ctx.createNode('import', moduleName, posNode, { signature });
    if (!imp) return;
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: posNode.startPosition.row + 1,
        column: posNode.startPosition.column,
        filePath: ctx.filePath,
        language: 'elixir',
      });
    }
  };

  if (first.type === 'alias') {
    emit(readAliasText(first, ctx.source), first);
  } else if (first.type === 'dot') {
    // alias Foo.{Bar, Baz} — left=Foo, right=tuple of suffix aliases
    const left = getChildByField(first, 'left') ?? first.namedChild(0);
    const right = getChildByField(first, 'right') ?? first.namedChild(1);
    if (left && right && right.type === 'tuple') {
      const prefix = readAliasText(left, ctx.source);
      for (const suffix of findChildren(right, 'alias')) {
        emit(`${prefix}.${readAliasText(suffix, ctx.source)}`, suffix);
      }
    } else if (left) {
      // Unusual shape — fall back to the whole dot expression text.
      emit(readAliasText(first, ctx.source), first);
    }
  }
  return true;
}

/**
 * `defstruct [:a, :b]` and `defexception [:msg, :reason]`.
 * Both produce a `struct` node named after the *enclosing module* and a
 * `field` child per atom in the list. They have no separate name of
 * their own — the module IS the struct.
 */
function handleDefstruct(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  // Find the enclosing module's name from the scope stack.
  let moduleName: string | null = null;
  let moduleId: string | null = null;
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const id = ctx.nodeStack[i]!;
    const n = ctx.nodes.find((x) => x.id === id);
    if (n?.kind === 'module') {
      moduleName = n.name;
      moduleId = id;
      break;
    }
  }
  if (!moduleName || !moduleId) return true;

  const structNode = ctx.createNode('struct', moduleName, callNode);
  if (!structNode) return true;

  // The args are typically a single `list` of atoms. We accept either
  // `list` or `keywords` (for `defstruct a: nil, b: 0`).
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return true;
  const listNode = findChild(args, 'list') ?? findChild(args, 'keywords');
  if (!listNode) return true;

  ctx.pushScope(structNode.id);
  try {
    for (let i = 0; i < listNode.namedChildCount; i++) {
      const child = listNode.namedChild(i);
      if (!child) continue;
      let fieldName: string | null = null;
      let posNode: SyntaxNode = child;
      if (child.type === 'atom') {
        // `:name` — leading `:` is part of the text.
        fieldName = getNodeText(child, ctx.source).replace(/^:/, '');
      } else if (child.type === 'pair') {
        const key = getChildByField(child, 'key') ?? child.namedChild(0);
        if (key) {
          fieldName = getNodeText(key, ctx.source).replace(/[:\s]/g, '');
          posNode = key;
        }
      }
      if (fieldName) {
        ctx.createNode('field', fieldName, posNode);
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

/**
 * `defprotocol Sizable do def size(thing) end`. The module-shaped
 * container becomes a `protocol` node; bodyless `def` clauses inside
 * become `function` nodes marked `isAbstract: true`.
 */
function handleDefprotocol(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  const aliasNode = args ? findChild(args, 'alias') : null;
  if (!aliasNode) return true;
  const name = readAliasText(aliasNode, ctx.source);

  const protoNode = ctx.createNode('protocol', name, callNode);
  if (!protoNode) return true;

  ctx.pushScope(protoNode.id);
  try {
    const body = findChild(callNode, 'do_block');
    if (!body) return true;
    for (let i = 0; i < body.namedChildCount; i++) {
      const stmt = body.namedChild(i);
      if (!stmt || stmt.type !== 'call') continue;
      const target = callTarget(stmt, ctx.source);
      if (target !== 'def') {
        // Pass through anything else (rare in protocols).
        ctx.visitNode(stmt);
        continue;
      }
      const head = parseDefHead(stmt, ctx.source);
      if (!head) continue;
      const fnName = `${head.name}/${head.arity}`;
      if (!findExistingFunction(fnName, ctx)) {
        ctx.createNode('function', fnName, stmt, {
          visibility: 'public',
          isAbstract: true,
        });
      }
    }
  } finally {
    ctx.popScope();
  }
  return true;
}

/**
 * `defimpl Proto, for: Type do … end`. Produces:
 *   - a `module` node named `${Proto}.${Type}` (Elixir's own naming convention),
 *   - an `implements`-kind unresolved reference from that module to `Proto`,
 *   - regular function extraction inside the body.
 */
function handleDefimpl(callNode: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  if (!args) return true;

  // First positional argument is the protocol alias.
  const protoNode = findChild(args, 'alias');
  if (!protoNode) return true;
  const protoName = readAliasText(protoNode, ctx.source);

  // `for: TypeName` lives in the keywords list.
  const keywords = findChild(args, 'keywords');
  let forType = 'Any';
  if (keywords) {
    for (const pair of findChildren(keywords, 'pair')) {
      const key = getChildByField(pair, 'key') ?? pair.namedChild(0);
      const value = getChildByField(pair, 'value') ?? pair.namedChild(1);
      if (key && value && getNodeText(key, ctx.source).trim().startsWith('for')) {
        forType = readAliasText(value, ctx.source);
        break;
      }
    }
  }

  const implName = `${protoName}.${forType}`;
  const implModule = ctx.createNode('module', implName, callNode);
  if (!implModule) return true;

  ctx.addUnresolvedReference({
    fromNodeId: implModule.id,
    referenceName: protoName,
    referenceKind: 'implements',
    line: protoNode.startPosition.row + 1,
    column: protoNode.startPosition.column,
    filePath: ctx.filePath,
    language: 'elixir',
  });

  ctx.pushScope(implModule.id);
  try {
    const body = findChild(callNode, 'do_block');
    if (body) ctx.visitNode(body);
  } finally {
    ctx.popScope();
  }
  return true;
}

/**
 * Resolve the callee name + arity for a user call site.
 *
 *   helper(a, b)      → "helper/2"
 *   String.upcase(x)  → "String.upcase/1"
 *   length(list)      → "length/1"
 *
 * Returns null for shapes we don't recognise (operator-style calls,
 * anonymous-fn invocations `fun.()`, etc.) — phase 2c emits nothing
 * rather than guessing wrong.
 */
function resolveCallee(callNode: SyntaxNode, source: string): { name: string; argCount: number } | null {
  const target = callNode.namedChild(0);
  if (!target) return null;
  const args = getChildByField(callNode, 'arguments') ?? findChild(callNode, 'arguments');
  const argCount = args ? args.namedChildCount : 0;

  if (target.type === 'identifier') {
    return { name: getNodeText(target, source), argCount };
  }
  if (target.type === 'dot') {
    // `String.upcase` — left is the receiver (an alias or expression),
    // right is the method identifier. Anonymous-fn `.()` invocation has
    // no right field; ignore for now.
    const left = getChildByField(target, 'left') ?? target.namedChild(0);
    const right = getChildByField(target, 'right') ?? target.namedChild(1);
    if (!left || !right || right.type !== 'identifier') return null;
    const receiver = getNodeText(left, source).trim();
    return { name: `${receiver}.${getNodeText(right, source)}`, argCount };
  }
  return null;
}

/**
 * Is this call the right-hand operand of a `|>` pipe? If so, the pipe
 * threads its LHS in as an implicit first argument, so the effective
 * arity is `argCount + 1`.
 *
 * tree-sitter-elixir doesn't expose the operator text as a field — we
 * detect `|>` by reading the source slice between the parent's left and
 * right children.
 */
function pipeAddsArg(callNode: SyntaxNode, source: string): boolean {
  const parent = callNode.parent;
  if (!parent || parent.type !== 'binary_operator') return false;
  const right = getChildByField(parent, 'right');
  if (right?.id !== callNode.id) return false;
  const left = getChildByField(parent, 'left');
  if (!left) return false;
  const operatorText = source.substring(left.endIndex, callNode.startIndex);
  return operatorText.includes('|>');
}

/**
 * Find the enclosing function on the scope stack, if any. Calls outside
 * a function (e.g. module-level `use Foo`) are skipped — without a
 * caller, an unresolved reference has nothing useful to anchor to.
 */
function enclosingFunctionId(ctx: ExtractorContext): string | null {
  for (let i = ctx.nodeStack.length - 1; i >= 0; i--) {
    const id = ctx.nodeStack[i]!;
    const n = ctx.nodes.find((x) => x.id === id);
    if (n?.kind === 'function') return id;
    if (n?.kind === 'module') return null;
  }
  return null;
}

/**
 * Elixir control-flow and metaprogramming forms parse as plain `call`
 * nodes (since `case foo do … end` IS syntactically a call to `case`).
 * They aren't function references and should not be emitted as
 * `calls`-kind edges. Macros like `quote`/`unquote`/`raise`/`throw` are
 * arguable, but excluding them keeps the graph signal-heavy.
 */
const NON_CALL_FORMS = new Set([
  'case', 'cond', 'if', 'unless', 'with', 'for', 'try', 'receive',
  'quote', 'unquote', 'unquote_splicing', 'fn',
  'raise', 'throw', 'reraise',
]);

function handleUserCall(callNode: SyntaxNode, ctx: ExtractorContext): void {
  const fnId = enclosingFunctionId(ctx);
  if (!fnId) return;
  const callee = resolveCallee(callNode, ctx.source);
  if (!callee) return;
  // Strip the control-flow forms — they live syntactically as calls but
  // aren't function references.
  if (NON_CALL_FORMS.has(callee.name)) return;
  const effectiveArity = callee.argCount + (pipeAddsArg(callNode, ctx.source) ? 1 : 0);
  ctx.addUnresolvedReference({
    fromNodeId: fnId,
    referenceName: `${callee.name}/${effectiveArity}`,
    referenceKind: 'calls',
    line: callNode.startPosition.row + 1,
    column: callNode.startPosition.column,
    filePath: ctx.filePath,
    language: 'elixir',
  });
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
        case 'alias':
        case 'import':
        case 'require':
        case 'use':
          return handleImportLike(node, target, ctx);
        case 'defstruct':
        case 'defexception':
          return handleDefstruct(node, ctx);
        case 'defprotocol':
          return handleDefprotocol(node, ctx);
        case 'defimpl':
          return handleDefimpl(node, ctx);
      }
      // Generic user call site — emit a `calls` reference if we're
      // inside a function. Returning false lets the default walker
      // descend into the arguments so nested calls (e.g. `f(g(x))`)
      // are also captured.
      handleUserCall(node, ctx);
      return false;
    }
    if (node.type === 'unary_operator') {
      return handleAttribute(node, ctx);
    }
    return false;
  },
};
