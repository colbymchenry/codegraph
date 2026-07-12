import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// Node names follow the elixir-lang/tree-sitter-elixir grammar (ABI 14, the
// grammar shipped in tree-sitter-wasms). Elixir has no keywords — `defmodule`,
// `def`, `defp`, `use`, `import`, `@spec`, … are all MACROS, so every one of
// them parses as a `call` node (or a `@`-`unary_operator` for module
// attributes). Nothing fits the generic functionTypes/classTypes dispatch, so
// the whole language is driven from the visitNode hook below, keyed off the
// target identifier of each `call`.
//
// Verified empirically with scripts/add-lang/dump-ast.mjs (2026-07-11):
//   - `defmodule Foo.Bar do … end`  →  call(target=identifier "defmodule",
//        arguments→alias "Foo.Bar", do_block CHILD of the call)
//   - `def name(args) do … end`     →  call(target=identifier "def",
//        arguments→call(head: target=name, arguments=params), do_block child)
//   - guard clause `def f(x) when g` →  arguments→binary_operator("when")
//        {left: head call, right: guard}
//   - one-liner `def f(x), do: e`   →  no do_block; body is arguments→keywords
//        →pair(key keyword "do:")
//   - `@spec`/`@doc`/`@moduledoc`/`@behaviour` → unary_operator("@")
//        {operand: call(target=identifier "spec"/"doc"/… )}
//   - remote call `Mod.Sub.fun(x)`  →  call(target=dot{left: alias "Mod.Sub",
//        right: identifier "fun"})
//
// Remote calls are emitted (in the elixir branch of extractCall) as
// `Full.Module::fun`, byte-identical to the qualifiedName a module's functions
// carry, so cross-module resolution rides the standard qualified-name matcher —
// the same design the erlang extractor uses.

const PUBLIC_DEFS = new Set(['def', 'defmacro', 'defguard', 'defdelegate']);
const PRIVATE_DEFS = new Set(['defp', 'defmacrop', 'defguardp']);

/**
 * Reserved/built-in module attributes whose VALUES are type positions, docs, or
 * compiler metadata — NOT runtime code. Their subtree is consumed (not walked)
 * because a type expression like `String.t()` in `@spec` parses as a `call` and
 * would otherwise mint a bogus `calls` edge (D3). List sourced from the official
 * Module docs (https://hexdocs.pm/elixir/Module.html, verified 2026-07-12) plus
 * the American spelling `behavior` and the Mix `@shortdoc` convention.
 * Every attribute OUTSIDE this set is a custom attribute: its value is real
 * compile-time code, so we descend into it to emit normal `calls` edges.
 */
const META_ATTRIBUTES = new Set([
  'spec',
  'doc',
  'moduledoc',
  'typedoc',
  'shortdoc',
  'behaviour',
  'behavior',
  'type',
  'typep',
  'opaque',
  'callback',
  'macrocallback',
  'optional_callbacks',
  'impl',
  'derive',
  'enforce_keys',
  'deprecated',
  'dialyzer',
  'external_resource',
  'compile',
  'before_compile',
  'after_compile',
  'after_verify',
  'on_definition',
  'on_load',
  'nifs',
  'vsn',
  'file',
]);
/** Every macro that introduces a named function. */
const DEF_MACROS = new Set([...PUBLIC_DEFS, ...PRIVATE_DEFS]);

/**
 * Per-file clause-merge state. Elixir emits one `def` call PER CLAUSE (pattern
 * matching / default args / guards), so consecutive same-name definitions in
 * the same module are merged into a single function node — the endLine is
 * extended and the extra clause's body attributed to the existing node. Keyed
 * by (file, module node id, name): a same-named function in a different module
 * must NOT merge. Extraction is file-sequential, so a single-entry memo is safe.
 */
let lastFnFile = '';
let lastFnModuleId = '';
let lastFnName = '';
let lastFnId = '';

/** Nesting stack of enclosing module full dotted names (for nested defmodule). */
let moduleNameStack: string[] = [];
let moduleStackFile = '';

function resetModuleStack(filePath: string): void {
  if (moduleStackFile !== filePath) {
    moduleStackFile = filePath;
    moduleNameStack = [];
  }
}

function currentModulePrefix(): string {
  return moduleNameStack.length ? moduleNameStack[moduleNameStack.length - 1]! : '';
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Text of a `keyword` key with surrounding space and trailing colon stripped
 * (`do:` → `do`). The grammar can include trailing whitespace on the token. */
function keywordKey(node: SyntaxNode, source: string): string {
  return getNodeText(node, source).trim().replace(/:$/, '');
}

/**
 * The `arguments` node of a call. In tree-sitter-elixir `arguments` is a child
 * NODE TYPE, not a field, so it must be located by type (not childForFieldName).
 */
function argsOf(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === 'arguments') return child;
  }
  return null;
}

/** First `alias` under a node's direct named children. */
function firstAlias(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  for (const child of node.namedChildren) {
    if (child.type === 'alias') return child;
  }
  return null;
}

/** Look up a keyword value (`for:` → its value node) inside an arguments node. */
function keywordValue(argsNode: SyntaxNode | null, key: string, source: string): SyntaxNode | null {
  if (!argsNode) return null;
  for (const child of argsNode.namedChildren) {
    if (child.type !== 'keywords') continue;
    for (const pair of child.namedChildren) {
      if (pair.type !== 'pair') continue;
      const k = getChildByField(pair, 'key');
      if (k && keywordKey(k, source) === key) return getChildByField(pair, 'value');
    }
  }
  return null;
}

/** The `do_block` child of a def/defmodule call, if the block form is used. */
function doBlockOf(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === 'do_block') return child;
  }
  return null;
}

/**
 * Unwrap the head `call` of a `def`: arguments[0] is either the head call
 * directly, or a `binary_operator` ("when") whose `left` is the head call.
 * Returns the head call (target=identifier function name, arguments=params).
 */
function defHead(node: SyntaxNode): SyntaxNode | null {
  const args = argsOf(node);
  const first = args?.namedChildren[0] ?? null;
  if (!first) return null;
  if (first.type === 'binary_operator') {
    const left = getChildByField(first, 'left');
    return left && left.type === 'call' ? left : null;
  }
  if (first.type === 'call') return first;
  // A zero-arg macro def head can be a bare identifier (`def hello, do: …`).
  return null;
}

/** Function name + head node for a def call (handles the bare-identifier head). */
function defName(node: SyntaxNode, source: string): { name: string; head: SyntaxNode | null } | null {
  const head = defHead(node);
  if (head) {
    const target = getChildByField(head, 'target');
    if (target?.type === 'identifier') return { name: getNodeText(target, source), head };
    return null;
  }
  // Bare head: `def hello do … end` / `def hello, do: …` — arguments[0] is an
  // identifier (the name), or when there is a `when` guard on a zero-arg def.
  const args = argsOf(node);
  const first = args?.namedChildren[0] ?? null;
  if (first?.type === 'identifier') return { name: getNodeText(first, source), head: null };
  if (first?.type === 'binary_operator') {
    const left = getChildByField(first, 'left');
    if (left?.type === 'identifier') return { name: getNodeText(left, source), head: null };
  }
  return null;
}

/**
 * Collect the `@spec` (signature) and `@doc` (docstring) directly preceding a
 * def, skipping comments and other clauses. Mirrors erlang's precedingSpec.
 */
function precedingAttrs(
  node: SyntaxNode,
  source: string
): { signature?: string; docstring?: string } {
  const out: { signature?: string; docstring?: string } = {};
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'comment') {
      prev = prev.previousNamedSibling;
      continue;
    }
    if (prev.type === 'unary_operator') {
      const attr = attributeCall(prev);
      if (attr) {
        const attrName = attributeName(attr, source);
        if (attrName === 'spec' && out.signature === undefined) {
          out.signature = collapseWs(getNodeText(prev, source)).slice(0, 300);
          prev = prev.previousNamedSibling;
          continue;
        }
        if (attrName === 'doc' && out.docstring === undefined) {
          out.docstring = docContent(attr, source);
          prev = prev.previousNamedSibling;
          continue;
        }
      }
    }
    break;
  }
  return out;
}

/** For a `@`-unary_operator, the inner `call` (`@spec name(...) :: ...`). */
function attributeCall(unary: SyntaxNode): SyntaxNode | null {
  const operand = getChildByField(unary, 'operand');
  return operand?.type === 'call' ? operand : null;
}

/** The attribute name of an inner attribute call (`spec`/`doc`/`behaviour`). */
function attributeName(call: SyntaxNode, source: string): string {
  const target = getChildByField(call, 'target');
  return target?.type === 'identifier' ? getNodeText(target, source) : '';
}

/** The string literal content of a `@doc "..."` / `@moduledoc "..."`. */
function docContent(call: SyntaxNode, source: string): string | undefined {
  const args = argsOf(call);
  const strNode = args?.namedChildren.find((c) => c.type === 'string');
  if (!strNode) return undefined;
  const content = strNode.namedChildren.find((c) => c.type === 'quoted_content');
  const text = content ? getNodeText(content, source) : getNodeText(strNode, source);
  return collapseWs(text) || undefined;
}

/** `@moduledoc` docstring inside a module's do_block, if present. */
function moduledocOf(doBlock: SyntaxNode | null, source: string): string | undefined {
  if (!doBlock) return undefined;
  for (const child of doBlock.namedChildren) {
    if (child.type !== 'unary_operator') continue;
    const call = attributeCall(child);
    if (call && attributeName(call, source) === 'moduledoc') return docContent(call, source);
  }
  return undefined;
}

function handleModule(node: SyntaxNode, ctx: ExtractorContext, localName: string): boolean {
  const prefix = currentModulePrefix();
  const fullName = prefix ? `${prefix}.${localName}` : localName;
  const doBlock = doBlockOf(node);
  const ns = ctx.createNode('namespace', fullName, node, {
    qualifiedName: fullName,
    docstring: moduledocOf(doBlock, ctx.source),
  });
  if (!ns) return true;
  ctx.pushScope(ns.id);
  moduleNameStack.push(fullName);
  if (doBlock) {
    for (const child of doBlock.namedChildren) ctx.visitNode(child);
  }
  moduleNameStack.pop();
  ctx.popScope();
  return true;
}

function handleDefImpl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = argsOf(node);
  const protoAlias = firstAlias(args);
  const forValue = keywordValue(args, 'for', ctx.source);
  const proto = protoAlias ? getNodeText(protoAlias, ctx.source) : '';
  const forType =
    forValue?.type === 'alias'
      ? getNodeText(forValue, ctx.source)
      : forValue
        ? collapseWs(getNodeText(forValue, ctx.source))
        : '';
  const localName = forType ? `${proto}.${forType}` : proto;
  // `defimpl Proto, for: Type` implements Proto's contract — emit the
  // implements ref, then treat the block like a normal module named Proto.Type.
  const prefix = currentModulePrefix();
  const fullName = prefix ? `${prefix}.${localName}` : localName;
  const doBlock = doBlockOf(node);
  const ns = ctx.createNode('namespace', fullName, node, { qualifiedName: fullName });
  if (!ns) return true;
  if (proto) {
    ctx.addUnresolvedReference({
      fromNodeId: ns.id,
      referenceName: proto,
      referenceKind: 'implements',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
  ctx.pushScope(ns.id);
  moduleNameStack.push(fullName);
  if (doBlock) {
    for (const child of doBlock.namedChildren) ctx.visitNode(child);
  }
  moduleNameStack.pop();
  ctx.popScope();
  return true;
}

function handleDef(node: SyntaxNode, ctx: ExtractorContext, macro: string): boolean {
  const named = defName(node, ctx.source);
  if (!named) return true;
  const { name, head } = named;
  const moduleId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const fullMod = currentModulePrefix();

  // Continuation clause of the same function in the same module — merge.
  if (
    ctx.filePath === lastFnFile &&
    moduleId === lastFnModuleId &&
    name === lastFnName &&
    lastFnId
  ) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    ctx.pushScope(lastFnId);
    visitDefBodies(node, head, lastFnId, ctx);
    ctx.popScope();
    return true;
  }

  const attrs = precedingAttrs(node, ctx.source);
  const signature =
    attrs.signature ?? (head ? collapseWs(getNodeText(head, ctx.source)).slice(0, 300) : name);
  const fn = ctx.createNode('function', name, node, {
    qualifiedName: fullMod ? `${fullMod}::${name}` : name,
    signature,
    docstring: attrs.docstring,
    isExported: PUBLIC_DEFS.has(macro),
    visibility: PRIVATE_DEFS.has(macro) ? 'private' : 'public',
  });
  if (!fn) return true;
  ctx.pushScope(fn.id);
  visitDefBodies(node, head, fn.id, ctx);
  ctx.popScope();
  lastFnFile = ctx.filePath;
  lastFnModuleId = moduleId;
  lastFnName = name;
  lastFnId = fn.id;
  return true;
}

/**
 * Walk a def's body/bodies for calls WITHOUT walking the head (which would emit
 * a spurious self-call to the function's own name): the do_block child and, for
 * the one-liner form, the `do:` keyword value.
 */
function visitDefBodies(
  node: SyntaxNode,
  _head: SyntaxNode | null,
  fnId: string,
  ctx: ExtractorContext
): void {
  const doBlock = doBlockOf(node);
  if (doBlock) ctx.visitFunctionBody(doBlock, fnId);
  const doValue = keywordValue(argsOf(node), 'do', ctx.source);
  if (doValue) ctx.visitFunctionBody(doValue, fnId);
}

function handleDefstruct(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // Fields belong to the enclosing module (the struct IS the module). Two
  // shapes: keyword form `defstruct name: nil, count: 0` and atom-list form
  // `defstruct [:name, :count]`.
  const args = argsOf(node);
  if (!args) return true;
  const addField = (fieldName: string, pos: SyntaxNode): void => {
    if (!fieldName) return;
    const fullMod = currentModulePrefix();
    ctx.createNode('field', fieldName, pos, {
      qualifiedName: fullMod ? `${fullMod}::${fieldName}` : fieldName,
    });
  };
  for (const child of args.namedChildren) {
    if (child.type === 'keywords') {
      for (const pair of child.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = getChildByField(pair, 'key');
        if (key) addField(keywordKey(key, ctx.source), pair);
      }
    } else if (child.type === 'list') {
      for (const item of child.namedChildren) {
        if (item.type === 'atom') {
          addField(getNodeText(item, ctx.source).replace(/^:/, ''), item);
        } else if (item.type === 'keywords') {
          for (const pair of item.namedChildren) {
            if (pair.type !== 'pair') continue;
            const key = getChildByField(pair, 'key');
            if (key) addField(keywordKey(key, ctx.source), pair);
          }
        }
      }
    }
  }
  return true;
}

/** `use`/`import`/`require`/`alias` — structural edges (D7). */
function handleModuleDirective(node: SyntaxNode, ctx: ExtractorContext, macro: string): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return true;
  const args = argsOf(node);
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column;

  // `use Mod` injects a contract — model as `implements` (closest existing
  // semantics; resolves to the module namespace via the module-only rule).
  if (macro === 'use') {
    const aliasNode = firstAlias(args);
    if (aliasNode) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: getNodeText(aliasNode, ctx.source),
        referenceKind: 'implements',
        line,
        column,
      });
    }
    return true;
  }

  // import / require / alias → file-level import edge to the module. Handles
  // grouped `alias Foo.{Alpha, Beta}` (dot{left: alias prefix, right: tuple}).
  const emit = (moduleName: string): void => {
    if (!moduleName) return;
    ctx.addUnresolvedReference({
      fromNodeId: parentId,
      referenceName: moduleName,
      referenceKind: 'imports',
      line,
      column,
    });
  };
  if (args) {
    for (const child of args.namedChildren) {
      if (child.type === 'alias') {
        emit(getNodeText(child, ctx.source));
      } else if (child.type === 'dot') {
        // grouped alias: Foo.{Alpha, Beta}
        const left = getChildByField(child, 'left');
        const right = getChildByField(child, 'right');
        const prefix = left?.type === 'alias' ? getNodeText(left, ctx.source) : '';
        if (right?.type === 'tuple' && prefix) {
          for (const member of right.namedChildren) {
            if (member.type === 'alias') emit(`${prefix}.${getNodeText(member, ctx.source)}`);
          }
        }
      }
    }
  }
  return true;
}

/**
 * `@behaviour Mod` → implements ref; other META attributes (@spec/@doc/…) are
 * consumed silently; CUSTOM attributes have their VALUE walked so a compile-time
 * call in the value (`@id Product.get_product_name(:x)`) emits a normal `calls`
 * edge attributed to the enclosing module (the current scope).
 */
function handleAttribute(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const call = attributeCall(node);
  if (!call) return true; // no inner call (e.g. bare `@x`) — nothing to walk
  const name = attributeName(call, ctx.source);
  if (name === 'behaviour' || name === 'behavior') {
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    const aliasNode = firstAlias(argsOf(call));
    if (parentId && aliasNode) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: getNodeText(aliasNode, ctx.source),
        referenceKind: 'implements',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return true;
  }
  if (META_ATTRIBUTES.has(name)) {
    // @doc/@spec are consumed here (picked up by precedingAttrs on the next def);
    // @moduledoc by moduledocOf. Consuming prevents type-position exprs in @spec
    // (`String.t()` parses as a call) from minting bogus call refs (D3).
    return true;
  }
  // Custom attribute: its value is real compile-time code. Walk the value
  // subtree (the inner call's arguments) — NOT the inner call's target, which is
  // just the attribute NAME (`x` in `@x value`) and must never become a `calls`
  // edge. Descending lets `Mod.fun(...)` in the value resolve normally; the
  // enclosing module namespace is the current scope, so the edge originates
  // there (attributes live at module level, not inside any function).
  const args = argsOf(call);
  if (args) {
    for (const child of args.namedChildren) ctx.visitNode(child);
  }
  return true;
}

export const elixirExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  // Real call sites (remote/local calls, `&` captures, `%Struct{}` literals)
  // are dispatched to the elixir branch of extractCall; declaration macros are
  // intercepted by visitNode below (returning true) before they reach it.
  callTypes: ['call', 'unary_operator', 'map'],
  variableTypes: [],
  nameField: 'target',
  bodyField: 'do_block',
  paramsField: 'arguments',

  visitNode: (node, ctx) => {
    resetModuleStack(ctx.filePath);

    if (node.type === 'unary_operator') {
      // `@attr …` module attribute (operator text starts with '@').
      if (getNodeText(node, ctx.source).startsWith('@')) {
        return handleAttribute(node, ctx);
      }
      return false; // `&capture/1`, negation, etc. → extractCall / generic walk
    }

    if (node.type !== 'call') return false;
    const target = getChildByField(node, 'target');
    if (target?.type !== 'identifier') return false; // remote call (dot) → extractCall

    const macro = getNodeText(target, ctx.source);
    if (macro === 'defmodule' || macro === 'defprotocol') {
      const aliasNode = firstAlias(argsOf(node));
      if (!aliasNode) return true;
      return handleModule(node, ctx, getNodeText(aliasNode, ctx.source));
    }
    if (macro === 'defimpl') return handleDefImpl(node, ctx);
    if (DEF_MACROS.has(macro)) return handleDef(node, ctx, macro);
    if (macro === 'defstruct' || macro === 'defexception') return handleDefstruct(node, ctx);
    if (macro === 'use' || macro === 'import' || macro === 'require' || macro === 'alias') {
      return handleModuleDirective(node, ctx, macro);
    }
    return false; // ordinary local call → extractCall
  },
};
