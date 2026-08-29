import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// Node names follow tree-sitter-elixir (ABI 14, the tree-sitter-wasms build).
//
// Elixir is HOMOICONIC: there are no declaration node types at all. Every
// construct — `defmodule`, `def`, `alias`, `import`, an Ecto `schema`, a
// Phoenix route — parses as the SAME `call` node, distinguished only by the
// text of its `target` identifier:
//
//   defmodule MyApp.Repo do … end
//     → call(target: identifier "defmodule", arguments(alias "MyApp.Repo"), do_block)
//   def create(attrs \\ %{}) when is_map(attrs), do: …
//     → call(target: identifier "def",
//            arguments(binary_operator(left: call(target: identifier "create", …),
//                                      right: <guard>),
//                      keywords(pair(key: keyword "do:", …))))
//
// So the generic node-type ladder in tree-sitter.ts has nothing to match, and
// EVERYTHING is dispatched through the visitNode hook below. The hook also
// owns call extraction (rather than an `elixir` branch in the core
// extractCall) because it must run inside function bodies too — and
// visitFunctionBody does NOT invoke this hook. The hook therefore descends
// with ctx.visitNode(), which re-enters it for every child, so a `call`
// nested anywhere still gets Elixir semantics.
//
// Naming / resolution model, mirroring Erlang's `mod::fn` (#1610) minus arity:
//   - a `defmodule` becomes a `module` node whose name AND qualifiedName are
//     the full dotted name (`MyApp.Accounts`); a nested defmodule concatenates
//     (`MyApp.Accounts.Inner`), which is exactly the module Elixir defines;
//   - every `def` inside it gets qualifiedName `MyApp.Accounts::list_users`;
//   - a remote call `Repo.all(User)` is emitted with its receiver ALIAS
//     EXPANDED (`alias MyApp.Repo` → ref `MyApp.Repo::all`), so it resolves by
//     exact qualified-name match. An unaliased short receiver still lands via
//     matchByQualifiedName's partial `endsWith` fallback.
// Arity is deliberately NOT part of the qualified name (unlike Erlang):
// Elixir's default arguments (`def f(a, b \\ 0)`) make ONE definition answer
// to several arities, so an arity-pinned ref would miss the real target.

const DEF_KINDS = new Set([
  'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp',
]);

/** `defp`/`defmacrop`/`defguardp` — the private half of each pair. */
const PRIVATE_DEFS = new Set(['defp', 'defmacrop', 'defguardp']);

/** Lexical directives; all four make the named module a dependency. */
const DIRECTIVES = new Set(['alias', 'import', 'require', 'use']);

/**
 * Module attributes with compiler meaning — never module-level constants.
 * Everything else (`@default_role :member`) IS a constant and is extracted as
 * one. `@spec`/`@type`/`@callback` bodies are TYPE expressions that parse as
 * `call` nodes, so their subtrees must be consumed, not descended into, or
 * every `String.t()` in a typespec would mint a bogus call ref.
 */
const RESERVED_ATTRS = new Set([
  'moduledoc', 'doc', 'typedoc', 'shortdoc', 'spec', 'callback', 'macrocallback',
  'impl', 'behaviour', 'behavior', 'derive', 'enforce_keys', 'deprecated',
  'optional_callbacks', 'before_compile', 'after_compile', 'on_definition',
  'on_load', 'external_resource', 'compile', 'dialyzer', 'file', 'fallback_to_any',
]);

/** `@type` / `@typep` / `@opaque` — named type declarations. */
const TYPE_ATTRS = new Set(['type', 'typep', 'opaque']);

/**
 * Ecto schema field macros. A `schema "users" do … end` block declares the
 * struct's shape through these, and nothing else in the graph would record it
 * — so a schema module would otherwise index as a module with zero members and
 * an agent asking "what columns does User have" has to Read the file. The
 * association macros additionally name the related schema MODULE, which is a
 * real cross-file dependency.
 */
const SCHEMA_FIELDS = new Set([
  'field', 'belongs_to', 'has_many', 'has_one', 'many_to_many',
  'embeds_one', 'embeds_many',
]);

/**
 * `Kernel.SpecialForms` plus the Kernel macros that ARE language syntax. These
 * parse as ordinary `call` nodes — `case x do … end` is
 * `call(target: identifier "case", …)` — so without this list every `if`,
 * `case` and `quote` in the codebase mints a `calls` ref. On plug that was
 * ~1,900 refs (a third of the file's total) that can never resolve to
 * anything, and worse: a project that legitimately defines `def send(…)` or
 * `def raise(…)` would collect hundreds of wrong caller edges. The subtree is
 * still walked, so real calls nested inside a `case` are unaffected.
 * Closed list — it is fixed by the language, not by any library.
 */
const SPECIAL_FORMS = new Set([
  '__CALLER__', '__DIR__', '__ENV__', '__MODULE__', '__STACKTRACE__',
  '__aliases__', '__block__',
  'case', 'cond', 'fn', 'for', 'if', 'unless', 'quote', 'receive', 'super',
  'try', 'unquote', 'unquote_splicing', 'with',
  'and', 'or', 'not', 'in',
  'raise', 'reraise', 'throw', 'send', 'self', 'exit', 'binding', 'var!',
]);

/**
 * Phoenix router verbs → the HTTP method a `route` node is named for. Written
 * as `get "/users", UserController, :index` inside a `scope`, which is the
 * ONLY place the URL↔controller binding exists — there is no static call from
 * the router to the action, so without this a request flow dead-ends at the
 * router and the agent has to read it. (`forward` and `live` are handled
 * alongside; `resources` expands to the REST seven.)
 */
const ROUTE_VERBS = new Map<string, string>([
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'],
  ['delete', 'DELETE'], ['options', 'OPTIONS'], ['head', 'HEAD'],
]);

/** The actions `resources "/posts", PostController` generates. */
const RESOURCE_ACTIONS = ['index', 'edit', 'new', 'show', 'create', 'update', 'delete'];

/** Association macros whose second argument is the related schema module. */
const SCHEMA_ASSOCS = new Set([
  'belongs_to', 'has_many', 'has_one', 'many_to_many', 'embeds_one', 'embeds_many',
]);

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `:member` → `member`; `"name"` stays as-is for non-atoms. */
function atomName(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/^:/, '').replace(/^"([\s\S]*)"$/, '$1');
}

/**
 * `for: ` → `for`. A `keyword` node spans its trailing colon AND the
 * whitespace after it, so both must come off before comparing.
 */
function keywordName(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/:$/, '');
}

/**
 * The operator of a `binary_operator`, read from the gap between its `left`
 * and `right` fields — the grammar exposes no `operator` field. Distinguishes
 * a guard (`def f(x) when is_x(x)`) from an operator DEFINITION
 * (`def a ++ b`) and from a default argument (`b \\ 0`), all of which are the
 * same node type in a def head.
 */
function operatorText(node: SyntaxNode, source: string): string {
  const left = getChildByField(node, 'left');
  const right = getChildByField(node, 'right');
  if (!left || !right) return '';
  return source.substring(left.endIndex, right.startIndex).trim();
}

function namedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * A call's argument list. `arguments` is a plain named CHILD of the `call`
 * node, not a field (only `target` is), so childForFieldName never finds it.
 */
function argsOf(node: SyntaxNode): SyntaxNode | null {
  return namedChildOfType(node, 'arguments');
}

// --- Per-file state. Extraction is file-sequential within a worker, so
// single-entry memos keyed by filePath are safe (and reset naturally). ---

/**
 * `alias`-established short names → the full dotted module they stand for
 * (`alias MyApp.Accounts.User` ⇒ `User` → `MyApp.Accounts.User`). Populated in
 * source order as the walk meets each directive, which matches Elixir's own
 * rule that an alias must precede its uses. File-wide rather than
 * module-scoped: an alias re-bound to a different module in a second module of
 * the SAME file is vanishingly rare, and the approximation costs nothing.
 */
let aliasFile = '';
let aliasMap = new Map<string, string>();

/** Full dotted names of the `defmodule`s currently open (innermost last). */
let moduleStack: string[] = [];

/**
 * Enclosing Phoenix `scope "/api", MyAppWeb do` frames (innermost last). A
 * route's real path and its controller's real module name are both assembled
 * from these — `get "/users", UserController` inside that scope means
 * `GET /api/users` → `MyAppWeb.UserController`.
 */
let routeScopes: { path: string; alias: string }[] = [];

/**
 * Clause-merge state. Elixir spells multi-clause functions as repeated `def`s
 * of the same name and arity (`def handle_call({:get, k}, _from, s)` ×N — the
 * whole GenServer idiom), so without merging, a 6-clause handler indexes as 6
 * identical nodes and every caller edge lands on an arbitrary one. Consecutive
 * same-(module, name, arity) defs extend the FIRST node instead. Adjacency is
 * a safe key: Elixir warns ("clauses with the same name and arity should be
 * grouped") on any non-adjacent redefinition. A same-name DIFFERENT-arity def
 * is a separate function and gets its own node.
 */
let lastDefFile = '';
let lastDefModule = '';
let lastDefName = '';
let lastDefArity = -1;
let lastDefId = '';

/**
 * Clear the per-file memos. Called unconditionally on the `source` root — a
 * guaranteed once-per-extract event — because keying on filePath alone leaks
 * state when the SAME file is extracted twice in a row (an incremental sync
 * re-parse): `lastDefId` would still name a node from the previous run, which
 * no longer exists in this run's node list, and merging onto it would push a
 * dangling scope id and emit edges to a nonexistent node.
 */
function resetFileState(filePath: string, force = false): void {
  if (!force && filePath === aliasFile) return;
  aliasFile = filePath;
  aliasMap = new Map();
  moduleStack = [];
  routeScopes = [];
  lastDefFile = '';
  lastDefModule = '';
  lastDefName = '';
  lastDefArity = -1;
  lastDefId = '';
}

function currentModule(): string {
  return moduleStack.length > 0 ? moduleStack[moduleStack.length - 1]! : '';
}

/**
 * Expand a written module reference to its full dotted name: an alias short
 * name to what it aliases, `__MODULE__` to the enclosing module, anything else
 * unchanged. A DOTTED reference expands on its first segment
 * (`alias MyApp.Accounts` then `Accounts.User` → `MyApp.Accounts.User`).
 */
function expandAlias(written: string): string {
  if (!written) return written;
  if (written === '__MODULE__') return currentModule();
  const direct = aliasMap.get(written);
  if (direct) return direct;
  const dot = written.indexOf('.');
  if (dot > 0) {
    const head = written.slice(0, dot);
    if (head === '__MODULE__') {
      const mod = currentModule();
      return mod ? mod + written.slice(dot) : written;
    }
    const mapped = aliasMap.get(head);
    if (mapped) return mapped + written.slice(dot);
  }
  return written;
}

/** Qualified name for a member of the module currently being walked. */
function qualify(name: string): string {
  const mod = currentModule();
  return mod ? `${mod}::${name}` : name;
}

/**
 * The `@doc "…"` / `@moduledoc "…"` heredoc text of an attribute node, or
 * undefined when the attribute holds something else (`@doc false`).
 */
function attrString(attrCall: SyntaxNode, source: string): string | undefined {
  const args = argsOf(attrCall);
  const str = args ? namedChildOfType(args, 'string') : null;
  if (!str) return undefined;
  const content = namedChildOfType(str, 'quoted_content');
  const text = content ? getNodeText(content, source) : '';
  return text.trim() || undefined;
}

/** The `call` under an `@name …` attribute (`unary_operator` with operand). */
function attrCallOf(node: SyntaxNode): SyntaxNode | null {
  const operand = getChildByField(node, 'operand');
  return operand && operand.type === 'call' ? operand : null;
}

/** The attribute's name, for both `@name value` and a bare `@name` read. */
function attrNameOf(node: SyntaxNode, source: string): string | null {
  const operand = getChildByField(node, 'operand');
  if (!operand) return null;
  if (operand.type === 'identifier') return getNodeText(operand, source);
  if (operand.type === 'call') {
    const target = getChildByField(operand, 'target');
    if (target?.type === 'identifier') return getNodeText(target, source);
  }
  return null;
}

/** True for a `unary_operator` whose operator is the given single character. */
function unaryOpIs(node: SyntaxNode, source: string, op: string): boolean {
  return source[node.startIndex] === op;
}

/**
 * Walk back over the attribute/comment preamble of a definition and return the
 * `@doc` prose plus the `@spec` text. Both sit as preceding siblings, so the
 * generic comment-based getPrecedingDocstring never sees them — yet `@doc` is
 * where essentially all Elixir documentation lives, and the `@spec` is the
 * only place a function's types are written.
 */
function defPreamble(
  node: SyntaxNode,
  source: string
): { doc?: string; spec?: string } {
  let doc: string | undefined;
  let spec: string | undefined;
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      sibling = sibling.previousNamedSibling;
      continue;
    }
    if (sibling.type !== 'unary_operator' || !unaryOpIs(sibling, source, '@')) break;
    const attrCall = attrCallOf(sibling);
    const target = attrCall ? getChildByField(attrCall, 'target') : null;
    const name = target ? getNodeText(target, source) : '';
    if (name === 'doc') doc ??= attrString(attrCall!, source);
    else if (name === 'spec') spec ??= collapseWs(getNodeText(sibling, source)).slice(0, 300);
    else if (name !== 'impl' && name !== 'deprecated' && name !== 'since') break;
    sibling = sibling.previousNamedSibling;
  }
  return { doc, spec };
}

/** The `@moduledoc` prose of a module's `do_block`, if it opens with one. */
function moduleDoc(doBlock: SyntaxNode, source: string): string | undefined {
  for (const child of doBlock.namedChildren) {
    if (child.type !== 'unary_operator' || !unaryOpIs(child, source, '@')) continue;
    const attrCall = attrCallOf(child);
    const target = attrCall ? getChildByField(attrCall, 'target') : null;
    if (target && getNodeText(target, source) === 'moduledoc') {
      return attrString(attrCall!, source);
    }
  }
  return undefined;
}

/**
 * The body of a definition: either the `do_block` sibling of the `arguments`
 * (`def f do … end`) or the trailing `keywords` inside them
 * (`def f, do: …` — the `do:`/`rescue:`/`after:` keyword list).
 */
function defBody(node: SyntaxNode): SyntaxNode | null {
  const doBlock = namedChildOfType(node, 'do_block');
  if (doBlock) return doBlock;
  const args = argsOf(node);
  return args ? namedChildOfType(args, 'keywords') : null;
}

interface DefHead {
  name: string;
  arity: number;
  /** The `when …` guard expression, which holds real calls. */
  guard: SyntaxNode | null;
  /** The parameter list, whose default values (`\\ %{}`) hold real calls. */
  params: SyntaxNode | null;
}

/**
 * Parse the head of a `def`. The three shapes the grammar produces:
 *   `def f do`             → identifier
 *   `def f(a, b \\ 0) do`  → call(target: identifier, arguments)
 *   `def f(a) when g do`   → binary_operator(op `when`)
 *   `def a ++ b do`        → binary_operator(op `++`) — an operator definition
 * Returns null for a head with no static name (`def unquote(name)(x)`), whose
 * subtree is then consumed rather than mined for a bogus call.
 */
function parseDefHead(head: SyntaxNode, source: string): DefHead | null {
  if (head.type === 'identifier') {
    return { name: getNodeText(head, source), arity: 0, guard: null, params: null };
  }
  if (head.type === 'call') {
    const target = getChildByField(head, 'target');
    if (target?.type !== 'identifier') return null; // `def unquote(name)(…)`
    const params = argsOf(head);
    return {
      name: getNodeText(target, source),
      arity: params ? params.namedChildCount : 0,
      guard: null,
      params,
    };
  }
  if (head.type === 'binary_operator') {
    const op = operatorText(head, source);
    if (op === 'when') {
      const left = getChildByField(head, 'left');
      const inner = left ? parseDefHead(left, source) : null;
      return inner ? { ...inner, guard: getChildByField(head, 'right') } : null;
    }
    // Operator definition — `def a ++ b`, `def left <> right`. The operator IS
    // the function's name (that is how call sites and `&(++)/2` spell it).
    if (op && !/[\w\s]/.test(op)) {
      return { name: op, arity: 2, guard: null, params: null };
    }
  }
  return null;
}

/** Push a scope, walk the given subtrees through the hook, pop. */
function walkUnder(scopeId: string, ctx: ExtractorContext, subtrees: (SyntaxNode | null)[]): void {
  ctx.pushScope(scopeId);
  for (const subtree of subtrees) {
    if (!subtree) continue;
    for (const child of subtree.namedChildren) ctx.visitNode(child);
  }
  ctx.popScope();
}

function addRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  referenceName: string,
  referenceKind: 'calls' | 'references' | 'imports' | 'implements' | 'instantiates',
  at: SyntaxNode
): void {
  if (!referenceName) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

function scopeHead(ctx: ExtractorContext): string | undefined {
  return ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
}

// --- Definition handlers -----------------------------------------------------

function handleDefmodule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const aliasNode = args ? namedChildOfType(args, 'alias') : null;
  const doBlock = namedChildOfType(node, 'do_block');
  if (!aliasNode) return true; // `defmodule unquote(name) do` — no static name

  const written = getNodeText(aliasNode, ctx.source);
  const outer = currentModule();
  // A nested defmodule defines `Outer.Inner`, which is the module name every
  // call site and `alias` in the project spells.
  const fullName = outer ? `${outer}.${written}` : written;

  const mod = ctx.createNode('module', fullName, node, {
    docstring: doBlock ? moduleDoc(doBlock, ctx.source) : getPrecedingDocstring(node, ctx.source),
    signature: `defmodule ${fullName}`,
  });
  if (!mod) return true;
  mod.qualifiedName = fullName;

  // Elixir auto-aliases a NESTED module's last segment inside its parent, so
  // `defmodule Outer do defmodule Inner do` makes bare `Inner.f()` mean
  // `Outer.Inner.f()`. A top-level defmodule establishes no such binding —
  // registering one would silently rewrite an unrelated same-suffix receiver.
  if (outer) aliasMap.set(written.split('.').pop()!, fullName);

  moduleStack.push(fullName);
  const savedDefName = lastDefName;
  lastDefName = ''; // a new module never continues the previous module's clause
  walkUnder(mod.id, ctx, [doBlock]);
  lastDefName = savedDefName;
  moduleStack.pop();
  return true;
}

/** `defprotocol Sizeable do def size(data) end` — a behaviour contract. */
function handleDefprotocol(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const aliasNode = args ? namedChildOfType(args, 'alias') : null;
  const doBlock = namedChildOfType(node, 'do_block');
  if (!aliasNode) return true;
  const fullName = expandAlias(getNodeText(aliasNode, ctx.source));

  const proto = ctx.createNode('interface', fullName, node, {
    docstring: doBlock ? moduleDoc(doBlock, ctx.source) : undefined,
    signature: `defprotocol ${fullName}`,
  });
  if (!proto) return true;
  proto.qualifiedName = fullName;

  moduleStack.push(fullName);
  const savedDefName = lastDefName;
  lastDefName = ''; // as in handleDefmodule — a new scope starts a new clause run
  walkUnder(proto.id, ctx, [doBlock]);
  lastDefName = savedDefName;
  moduleStack.pop();
  return true;
}

/**
 * `defimpl Sizeable, for: List do … end` — Elixir compiles this to the module
 * `Sizeable.List`. Named that way so the dispatch target is findable, with an
 * `implements` edge to the protocol so "who implements this" answers.
 */
function handleDefimpl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const aliasNode = args ? namedChildOfType(args, 'alias') : null;
  const doBlock = namedChildOfType(node, 'do_block');
  if (!aliasNode) return true;
  const protocol = expandAlias(getNodeText(aliasNode, ctx.source));

  let forType = '';
  const keywords = args ? namedChildOfType(args, 'keywords') : null;
  if (keywords) {
    for (const pair of keywords.namedChildren) {
      const key = getChildByField(pair, 'key');
      const value = getChildByField(pair, 'value');
      if (key && value && keywordName(key, ctx.source) === 'for') {
        forType = expandAlias(getNodeText(value, ctx.source));
        break;
      }
    }
  }
  // A bare `defimpl P do` inside `defmodule T` implements P for T.
  if (!forType) forType = currentModule();
  const fullName = forType ? `${protocol}.${forType}` : protocol;

  const impl = ctx.createNode('module', fullName, node, {
    signature: collapseWs(
      ctx.source.substring(node.startIndex, doBlock ? doBlock.startIndex : node.endIndex)
    ).slice(0, 200),
  });
  if (!impl) return true;
  impl.qualifiedName = fullName;
  addRef(ctx, impl.id, protocol, 'implements', node);

  moduleStack.push(fullName);
  const savedDefName = lastDefName;
  lastDefName = '';
  walkUnder(impl.id, ctx, [doBlock]);
  lastDefName = savedDefName;
  moduleStack.pop();
  return true;
}

function handleDef(node: SyntaxNode, defKind: string, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const head = args ? args.namedChild(0) : null;
  const parsed = head ? parseDefHead(head, ctx.source) : null;
  // Consume either way: descending into an unparseable head would emit a call
  // ref to the function's OWN name (the head is literally `f(a, b)`).
  if (!parsed) return true;

  const body = defBody(node);
  const isPrivate = PRIVATE_DEFS.has(defKind);
  const mod = currentModule();

  // Continuation clause of the same function — extend the first node's span
  // and attribute this clause's calls to it.
  if (
    ctx.filePath === lastDefFile &&
    mod === lastDefModule &&
    parsed.name === lastDefName &&
    parsed.arity === lastDefArity &&
    lastDefId
  ) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastDefId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    walkUnder(lastDefId, ctx, [parsed.params, parsed.guard, body]);
    return true;
  }

  const { doc, spec } = defPreamble(node, ctx.source);
  // Everything up to the body — `def create(attrs \\ %{}) when is_map(attrs)`.
  // A bodiless head (a protocol's `def size(data)`, a `defguard`) has no body
  // to stop at, so the whole node IS the header.
  const header = collapseWs(
    ctx.source.substring(node.startIndex, body ? body.startIndex : node.endIndex)
  ).replace(/,$/, '');
  const fn = ctx.createNode('function', parsed.name, node, {
    docstring: doc ?? getPrecedingDocstring(node, ctx.source),
    // The @spec is the only place a function's types are written, so lead with
    // it when present — that is what makes the signature useful to an agent.
    signature: spec ? `${spec} ${header}` : header,
    visibility: isPrivate ? 'private' : 'public',
    isExported: !isPrivate,
    decorators: defKind.startsWith('defmacro')
      ? ['macro']
      : defKind.startsWith('defguard')
        ? ['guard']
        : undefined,
  });
  if (!fn) return true;
  fn.qualifiedName = qualify(parsed.name);

  // The parameter list and guard hold real calls (default values, `is_map(x)`),
  // but the head's own name must never become a call ref — hence walking
  // `params`/`guard` rather than the whole head.
  walkUnder(fn.id, ctx, [parsed.params, parsed.guard, body]);

  lastDefFile = ctx.filePath;
  lastDefModule = mod;
  lastDefName = parsed.name;
  lastDefArity = parsed.arity;
  lastDefId = fn.id;
  return true;
}

/**
 * `defdelegate encode(data), to: Jason, as: :dump` — a real function whose
 * whole body is a call to another module. Without the synthesized call edge
 * the delegation chain simply stops here.
 */
function handleDefdelegate(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const head = args ? args.namedChild(0) : null;
  const parsed = head ? parseDefHead(head, ctx.source) : null;
  if (!parsed) return true;

  let to = '';
  let as = parsed.name;
  const keywords = args ? namedChildOfType(args, 'keywords') : null;
  if (keywords) {
    for (const pair of keywords.namedChildren) {
      const key = getChildByField(pair, 'key');
      const value = getChildByField(pair, 'value');
      if (!key || !value) continue;
      const k = keywordName(key, ctx.source);
      if (k === 'to') to = expandAlias(getNodeText(value, ctx.source));
      else if (k === 'as') as = atomName(value, ctx.source);
    }
  }

  const { doc } = defPreamble(node, ctx.source);
  const fn = ctx.createNode('function', parsed.name, node, {
    docstring: doc,
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
    isExported: true,
    visibility: 'public',
  });
  if (!fn) return true;
  fn.qualifiedName = qualify(parsed.name);
  if (to) addRef(ctx, fn.id, `${to}::${as}`, 'calls', node);
  return true;
}

/**
 * `defstruct [:id, :name]` / `defstruct name: nil, age: 0` — the struct's
 * fields, emitted under the enclosing module (which IS the struct in Elixir,
 * so no separate struct node is minted).
 */
function handleDefstruct(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  if (!args) return true;
  for (const arg of args.namedChildren) {
    if (arg.type === 'list' || arg.type === 'keywords') {
      for (const item of arg.namedChildren) {
        if (item.type === 'atom') {
          ctx.createNode('field', atomName(item, ctx.source), item);
        } else if (item.type === 'pair') {
          const key = getChildByField(item, 'key');
          if (key) ctx.createNode('field', keywordName(key, ctx.source), item);
        }
      }
    } else if (arg.type === 'atom') {
      ctx.createNode('field', atomName(arg, ctx.source), arg);
    }
  }
  return true;
}

/**
 * Ecto `schema "users" do field :name, :string; has_many :posts, MyApp.Post end`
 * — the schema block's macros are the module's data shape and its associations
 * to other schemas. Consumed rather than descended into so the macro names
 * (`field`, `has_many`) don't become call refs.
 */
function handleSchema(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const doBlock = namedChildOfType(node, 'do_block');
  if (!doBlock) return false; // not the schema-block form — treat as a plain call
  const ownerId = scopeHead(ctx);

  for (const stmt of doBlock.namedChildren) {
    if (stmt.type !== 'call') continue;
    const target = getChildByField(stmt, 'target');
    if (target?.type !== 'identifier') continue;
    const macro = getNodeText(target, ctx.source);
    if (!SCHEMA_FIELDS.has(macro)) continue;
    const stmtArgs = argsOf(stmt);
    const nameArg = stmtArgs ? stmtArgs.namedChild(0) : null;
    if (!nameArg || nameArg.type !== 'atom') continue;

    const field = ctx.createNode('field', atomName(nameArg, ctx.source), stmt, {
      signature: collapseWs(getNodeText(stmt, ctx.source)).slice(0, 200),
    });
    // `has_many :posts, MyApp.Post` — the related schema is a genuine
    // cross-module dependency, and the only place the association is written.
    if (SCHEMA_ASSOCS.has(macro)) {
      const related = stmtArgs ? stmtArgs.namedChild(1) : null;
      if (related?.type === 'alias') {
        const from = field?.id ?? ownerId;
        if (from) addRef(ctx, from, expandAlias(getNodeText(related, ctx.source)), 'references', related);
      }
    }
  }
  return true;
}

/** `alias` / `import` / `require` / `use` — module dependencies. */
function handleDirective(node: SyntaxNode, directive: string, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  if (!args) return true;
  const parentId = scopeHead(ctx);
  const first = args.namedChild(0);
  if (!first) return true;

  const signature = collapseWs(getNodeText(node, ctx.source)).slice(0, 200);
  const register = (full: string, at: SyntaxNode, short?: string): void => {
    if (!full) return;
    if (directive === 'alias') aliasMap.set(short ?? full.split('.').pop()!, full);
    const imported = ctx.createNode('import', full, at, { signature });
    // Anchor to the enclosing module only. The generic `::`-joined name would
    // repeat the whole nodeStack (`Outer::Outer.Inner::Plug.Builder`).
    if (imported) imported.qualifiedName = qualify(full);
    if (parentId) addRef(ctx, parentId, full, 'imports', at);
  };

  // `alias MyApp.Accounts.{User, Credential}` — one dot node, many aliases.
  if (first.type === 'dot') {
    const left = getChildByField(first, 'left');
    const right = getChildByField(first, 'right');
    if (left && right?.type === 'tuple') {
      const base = expandAlias(getNodeText(left, ctx.source));
      for (const member of right.namedChildren) {
        if (member.type !== 'alias') continue;
        const written = getNodeText(member, ctx.source);
        register(`${base}.${written}`, member, written.split('.').pop()!);
      }
      return true;
    }
  }

  if (first.type !== 'alias') return true; // `alias __MODULE__.Sub`, dynamic forms
  const full = expandAlias(getNodeText(first, ctx.source));

  // `alias MyApp.Repo, as: R` renames the binding.
  let short: string | undefined;
  const keywords = namedChildOfType(args, 'keywords');
  if (keywords) {
    for (const pair of keywords.namedChildren) {
      const key = getChildByField(pair, 'key');
      const value = getChildByField(pair, 'value');
      if (key && value && keywordName(key, ctx.source) === 'as') {
        short = getNodeText(value, ctx.source).split('.').pop();
      }
    }
  }
  register(full, first, short);
  return true;
}

/**
 * `@name …`. Four distinct things wear this syntax: documentation, typespecs,
 * behaviour declarations, and plain module constants — plus a bare `@name`
 * READ inside a function body.
 */
function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = attrNameOf(node, ctx.source);
  if (!name) return false;
  const attrCall = attrCallOf(node);

  // Bare read (`@timeout` in an expression) → a reference to the constant.
  if (!attrCall) {
    const parentId = scopeHead(ctx);
    if (parentId) addRef(ctx, parentId, name, 'references', node);
    return true;
  }

  if (TYPE_ATTRS.has(name)) {
    // `@type t :: %__MODULE__{}` — the declared name is the left of the `::`.
    const args = argsOf(attrCall);
    const decl = args ? args.namedChild(0) : null;
    let nameNode: SyntaxNode | null = null;
    if (decl?.type === 'binary_operator') nameNode = getChildByField(decl, 'left');
    else if (decl) nameNode = decl;
    if (nameNode?.type === 'call') nameNode = getChildByField(nameNode, 'target');
    if (nameNode?.type === 'identifier') {
      const alias = ctx.createNode('type_alias', getNodeText(nameNode, ctx.source), node, {
        signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
      });
      if (alias) alias.qualifiedName = qualify(alias.name);
    }
    return true; // type position — never descend (every `String.t()` is a `call`)
  }

  if (name === 'behaviour' || name === 'behavior') {
    const args = argsOf(attrCall);
    const target = args ? namedChildOfType(args, 'alias') : null;
    const parentId = scopeHead(ctx);
    if (target && parentId) {
      addRef(ctx, parentId, expandAlias(getNodeText(target, ctx.source)), 'implements', node);
    }
    return true;
  }

  // Documentation, typespecs, and compiler directives carry no symbol; their
  // bodies are type expressions or literals, so consume the subtree.
  if (RESERVED_ATTRS.has(name)) return true;

  // Everything else is a module-level constant: `@default_role :member`.
  const constant = ctx.createNode('constant', name, node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
  });
  if (constant) {
    constant.qualifiedName = qualify(name);
    // The value can hold real calls (`@config Application.compile_env(:app, :k)`).
    walkUnder(constant.id, ctx, [argsOf(attrCall)]);
  }
  return true;
}

// --- Reference handlers ------------------------------------------------------

/**
 * A call site. `Repo.all(User)` is `call(target: dot(left, right), arguments)`;
 * `list_users()` is `call(target: identifier, arguments)`. Remote receivers are
 * alias-expanded so the emitted `MyApp.Repo::all` matches the callee's
 * qualifiedName exactly; local calls stay bare and resolve by name with the
 * call site's own file preferred (an Elixir local call targets its own module).
 */
function handleCallSite(node: SyntaxNode, ctx: ExtractorContext): void {
  const callerId = scopeHead(ctx);
  if (!callerId) return;
  const target = getChildByField(node, 'target');
  if (!target) return;

  if (target.type === 'identifier') {
    const name = getNodeText(target, ctx.source);
    // `case`/`if`/`quote`/… are syntax, not callees (see SPECIAL_FORMS).
    if (!SPECIAL_FORMS.has(name)) addRef(ctx, callerId, name, 'calls', node);
    return;
  }
  if (target.type !== 'dot') return; // `fun.()`, `apply/3` — no static callee

  const left = getChildByField(target, 'left');
  const right = getChildByField(target, 'right');
  if (!left || !right) return;
  // A non-alias receiver (`conn.assigns`, `socket.foo()`) is a runtime value,
  // not a module: emitting a bare `::`-qualified ref there would resolve
  // against an unrelated same-named function.
  if (left.type !== 'alias') return;
  const receiver = expandAlias(getNodeText(left, ctx.source));
  const fn = getNodeText(right, ctx.source);
  if (!receiver || !fn) return;
  addRef(ctx, callerId, `${receiver}::${fn}`, 'calls', node);
}

/**
 * `&double/1` and `&String.upcase/1` — Elixir's function-capture syntax, and
 * the whole of how callbacks are registered (`Enum.map(list, &process/1)`,
 * `Task.async(&worker/0)`). The captured function has no call site of its own,
 * so without this it shows zero callers and the flow breaks exactly where an
 * agent has to start reading. Parses as `unary_operator(&)` over
 * `binary_operator(/)` — the arity literal is dropped, matching the
 * arity-free naming model above.
 */
function handleCapture(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const callerId = scopeHead(ctx);
  const operand = getChildByField(node, 'operand');
  if (!callerId || operand?.type !== 'binary_operator') return false;
  if (operatorText(operand, ctx.source) !== '/') return false;
  let left = getChildByField(operand, 'left');
  if (!left) return false;
  // A qualified capture's name half parses as an ARGUMENT-LESS call
  // (`&String.upcase/1` ⇒ binary_operator(left: call(target: dot(String,
  // upcase)))), so unwrap to the target. Without this the descent below sees
  // that inner node and records an invocation that never happens.
  if (left.type === 'call' && !argsOf(left)) {
    const inner = getChildByField(left, 'target');
    if (!inner) return false;
    left = inner;
  }

  if (left.type === 'identifier') {
    addRef(ctx, callerId, getNodeText(left, ctx.source), 'references', node);
    return true;
  }
  if (left.type === 'dot') {
    const mod = getChildByField(left, 'left');
    const fn = getChildByField(left, 'right');
    if (mod?.type === 'alias' && fn) {
      const receiver = expandAlias(getNodeText(mod, ctx.source));
      addRef(ctx, callerId, `${receiver}::${getNodeText(fn, ctx.source)}`, 'references', node);
      return true;
    }
  }
  return false;
}

/** The text of a `string` literal argument, or null for a non-literal. */
function stringArg(node: SyntaxNode | null, source: string): string | null {
  if (node?.type !== 'string') return null;
  const content = namedChildOfType(node, 'quoted_content');
  return content ? getNodeText(content, source) : '';
}

/** Join a scope prefix and a route path into one clean URL path. */
function joinPath(prefix: string, segment: string): string {
  const joined = `${prefix}/${segment}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}

/**
 * `scope "/api", MyAppWeb do … end` — a router path + controller-alias frame.
 * Returns false when the call isn't the scope-block form, so it falls through
 * to ordinary call handling.
 */
function handleRouteScope(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const doBlock = namedChildOfType(node, 'do_block');
  const args = argsOf(node);
  if (!doBlock || !args) return false;
  const path = stringArg(args.namedChild(0), ctx.source);
  if (path === null) return false; // `scope path: "/x", alias: Y do` — keyword form

  const aliasArg = args.namedChild(1);
  const prefix = routeScopes.length > 0 ? routeScopes[routeScopes.length - 1]! : { path: '', alias: '' };
  const scopeAlias =
    aliasArg?.type === 'alias' ? expandAlias(getNodeText(aliasArg, ctx.source)) : '';

  routeScopes.push({
    path: joinPath(prefix.path, path),
    // A nested scope's alias extends the outer one (`scope "/admin", Admin`
    // inside `scope "/", MyAppWeb` ⇒ `MyAppWeb.Admin`), matching Phoenix.
    alias: scopeAlias
      ? prefix.alias && !scopeAlias.startsWith(prefix.alias)
        ? `${prefix.alias}.${scopeAlias}`
        : scopeAlias
      : prefix.alias,
  });
  const ownerId = scopeHead(ctx);
  if (ownerId) walkUnder(ownerId, ctx, [doBlock]);
  routeScopes.pop();
  return true;
}

/**
 * A Phoenix route macro. Emits a `route` node named `GET /api/users` and a
 * `references` edge to the controller action it dispatches to — the hop that
 * otherwise does not exist anywhere in the graph, because Phoenix builds the
 * dispatch at compile time from these macro arguments.
 */
function handleRouteMacro(node: SyntaxNode, verb: string, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  if (!args) return false;
  const path = stringArg(args.namedChild(0), ctx.source);
  const controllerArg = args.namedChild(1);
  // Every form starts `verb "<path>", <Module>`; anything else is a same-named
  // ordinary function (`Map.get` is qualified, but a bare `get(x)` exists).
  if (path === null || controllerArg?.type !== 'alias') return false;

  const scope = routeScopes.length > 0 ? routeScopes[routeScopes.length - 1]! : { path: '', alias: '' };
  const written = expandAlias(getNodeText(controllerArg, ctx.source));
  const controller = scope.alias && !written.startsWith(scope.alias)
    ? `${scope.alias}.${written}`
    : written;
  const fullPath = joinPath(scope.path, path);

  const actionArg = args.namedChild(2);
  let actions: string[];
  let method: string;
  if (verb === 'resources') {
    actions = RESOURCE_ACTIONS;
    method = 'RESOURCES';
  } else if (verb === 'forward') {
    // `forward "/admin", MyPlug` dispatches into a Plug's `call/2`.
    actions = ['call'];
    method = 'FORWARD';
  } else if (verb === 'live') {
    // `live "/dash", DashLive, :index` — the third argument is a `live_action`
    // assign, NOT a function on the module, so the module itself is the target.
    actions = [];
    method = 'LIVE';
  } else {
    actions = actionArg?.type === 'atom' ? [atomName(actionArg, ctx.source)] : [];
    method = ROUTE_VERBS.get(verb) ?? verb.toUpperCase();
  }

  const route = ctx.createNode('route', `${method} ${fullPath}`, node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
  });
  const from = route?.id ?? scopeHead(ctx);
  if (!from) return true;
  if (route) route.qualifiedName = `${method} ${fullPath}`;
  for (const action of actions) {
    addRef(ctx, from, `${controller}::${action}`, 'references', node);
  }
  // A LiveView route names a module, not an action — link the module itself.
  if (actions.length === 0) addRef(ctx, from, controller, 'references', node);
  return true;
}

/**
 * `plug :authenticate` / `plug MyApp.Auth` inside a `Plug.Builder` or Phoenix
 * `pipeline` — the request pipeline. An ATOM names a function in the SAME
 * module (`defp authenticate(conn, _opts)`), and a MODULE names a plug whose
 * `call/2` runs. Neither is a static call, so a request flow otherwise stops
 * dead at the pipeline declaration.
 */
function handlePlugMacro(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const first = args ? args.namedChild(0) : null;
  const ownerId = scopeHead(ctx);
  if (!first || !ownerId) return false;
  if (first.type === 'atom') {
    addRef(ctx, ownerId, atomName(first, ctx.source), 'calls', node);
    return true;
  }
  if (first.type === 'alias') {
    addRef(ctx, ownerId, `${expandAlias(getNodeText(first, ctx.source))}::call`, 'calls', node);
    return true;
  }
  return false;
}

/**
 * `%User{name: "x"}` / `%__MODULE__{}` — struct construction, parsed as
 * `map(struct(alias), map_content)`. A plain map (`%{a: 1}`) has no `struct`
 * child and is skipped.
 */
function handleStructLiteral(node: SyntaxNode, ctx: ExtractorContext): void {
  const callerId = scopeHead(ctx);
  const structNode = namedChildOfType(node, 'struct');
  if (!callerId || !structNode) return;
  const aliasNode = namedChildOfType(structNode, 'alias');
  if (!aliasNode) return; // `%module{}` — a runtime struct name
  addRef(ctx, callerId, expandAlias(getNodeText(aliasNode, ctx.source)), 'instantiates', node);
}

export const elixirExtractor: LanguageExtractor = {
  // Every mapping is empty on purpose: the grammar has no declaration node
  // types (see the header note) and the visitNode hook owns all dispatch,
  // including calls — the generic ladder has nothing correct to do here.
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
  nameField: 'target',
  bodyField: 'do_block',
  paramsField: 'arguments',

  visitNode: (node, ctx) => {
    resetFileState(ctx.filePath, node.type === 'source');

    if (node.type === 'unary_operator') {
      if (unaryOpIs(node, ctx.source, '@')) return handleAttribute(node, ctx);
      if (unaryOpIs(node, ctx.source, '&')) return handleCapture(node, ctx);
      return false;
    }

    if (node.type === 'map') {
      handleStructLiteral(node, ctx);
      return false; // children still walked — `%User{id: get_id()}` holds calls
    }

    if (node.type !== 'call') return false;

    const target = getChildByField(node, 'target');
    const form = target?.type === 'identifier' ? getNodeText(target, ctx.source) : '';

    if (form === 'defmodule') return handleDefmodule(node, ctx);
    if (form === 'defprotocol') return handleDefprotocol(node, ctx);
    if (form === 'defimpl') return handleDefimpl(node, ctx);
    if (DEF_KINDS.has(form)) return handleDef(node, form, ctx);
    if (form === 'defdelegate') return handleDefdelegate(node, ctx);
    if (form === 'defstruct' || form === 'defexception') return handleDefstruct(node, ctx);
    if (DIRECTIVES.has(form)) return handleDirective(node, form, ctx);
    if (form === 'schema' || form === 'embedded_schema') {
      if (handleSchema(node, ctx)) return true;
    }
    // `defoverridable [foo: 1]` / `quote`d fragments name no new symbol.
    if (form === 'defoverridable') return true;

    // Macro-driven dispatch (Phoenix router, Plug pipelines). Each handler
    // returns false when the call doesn't actually match the framework shape,
    // so a same-named ordinary function still falls through to a plain call.
    if (form === 'scope' && handleRouteScope(node, ctx)) return true;
    if ((ROUTE_VERBS.has(form) || form === 'resources' || form === 'forward' || form === 'live') &&
        handleRouteMacro(node, form, ctx)) {
      return true;
    }
    if (form === 'plug' && handlePlugMacro(node, ctx)) return true;

    // An ordinary call. Emit its edge, then descend so nested calls in the
    // arguments and any `do_block` (a DSL block such as a Phoenix `scope`)
    // still attribute to the enclosing scope.
    handleCallSite(node, ctx);
    for (const child of node.namedChildren) {
      if (child.type === 'identifier' && child.id === target?.id) continue;
      ctx.visitNode(child);
    }
    return true;
  },
};
