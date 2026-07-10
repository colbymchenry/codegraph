import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Elixir extraction.
 *
 * tree-sitter-elixir is metaprogramming-first: there are almost no dedicated
 * declaration node types. `defmodule`, `def`, `defp`, `alias`, `import`, `if`,
 * `case` … all parse as the SAME shape — a `call` node:
 *
 *   (call target: (identifier "<macro>") (arguments …) (do_block …)?)
 *
 * So the whole language is handled through the `visitNode` hook, which inspects
 * each `call`'s target identifier and dispatches on the macro name. Real
 * function calls (target not a known macro) become `calls` edges; control-flow
 * special forms (`if`/`case`/…) are descended into but not recorded as calls.
 */

/** Macros that introduce a callable definition. */
const DEF_MACROS = new Set([
  'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate',
]);
/** The subset of DEF_MACROS that are private. */
const PRIVATE_DEFS = new Set(['defp', 'defmacrop', 'defguardp']);
/** Dependency macros — each records an `import` node (module dependency). */
const DEP_MACROS = new Set(['alias', 'import', 'require', 'use']);
/** Macros that define the enclosing module's data shape. */
const STRUCT_MACROS = new Set(['defstruct', 'defexception']);
/**
 * Kernel special forms / control-flow macros. They parse as `call`s but are not
 * meaningful call edges; we still descend into their bodies for nested calls.
 */
const SKIP_CALL = new Set([
  'if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive',
  'quote', 'unquote', 'unquote_splicing', 'fn', 'super',
]);

/** The `target` of a call: the macro/function identifier (or a `dot` for `Mod.fun`). */
function callTarget(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('target') ?? node.namedChild(0);
}

/** The `arguments` node of a call, if any. */
function callArgs(node: SyntaxNode): SyntaxNode | null {
  return (
    node.childForFieldName('arguments') ??
    node.namedChildren.find((c) => c.type === 'arguments') ??
    null
  );
}

/** The trailing `do … end` block of a call, if present. */
function doBlock(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c) => c.type === 'do_block') ?? null;
}

/**
 * The `as:` value of `alias X, as: Y` — the arguments node holds
 * `(alias "X") (keywords (pair key: (keyword "as:") value: (alias "Y")))`.
 * Returns null when there is no `as:` keyword (the common case, where the
 * local binding is X's own last segment).
 */
function elixirAsAlias(args: SyntaxNode | null, source: string): string | null {
  const kw = args?.namedChildren.find((c) => c.type === 'keywords');
  if (!kw) return null;
  for (let i = 0; i < kw.namedChildCount; i++) {
    const pair = kw.namedChild(i);
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key') ?? pair.namedChild(0);
    const keyText = key ? getNodeText(key, source).trim().replace(/:$/, '') : '';
    if (keyText === 'as') {
      const value = pair.childForFieldName('value') ?? pair.namedChild(1);
      return value ? getNodeText(value, source) : null;
    }
  }
  return null;
}

/**
 * Extract a definition's simple name from a def-macro's arguments. Handles:
 *   def foo(a)                  → call(target: foo)
 *   def foo(a) when guard       → binary_operator(when){ left: call(target: foo) }
 *   def foo                     → identifier(foo)            (zero-arg, no parens)
 */
function defName(args: SyntaxNode | null): string | null {
  if (!args) return null;
  let head = args.namedChild(0);
  if (!head) return null;
  // `when` guard wraps the head: take its left operand.
  if (head.type === 'binary_operator') {
    head = head.childForFieldName('left') ?? head;
  }
  if (head.type === 'call') {
    const t = callTarget(head);
    // A simple identifier target — its own text is the name.
    return t && t.type === 'identifier' ? t.text : (t ? t.text : null);
  }
  if (head.type === 'identifier') {
    return head.text;
  }
  return null;
}

/**
 * Predict the qualifiedName the core will assign (scope node names joined by
 * `::`). Used to fold a multi-clause function — Elixir lists each clause as its
 * own `def`, but they are one symbol; a second node with the same qualifiedName
 * only creates resolver ambiguity.
 */
function qualifiedNameFor(ctx: ExtractorContext, name: string): string {
  const parts: string[] = [];
  for (const id of ctx.nodeStack) {
    const n = ctx.nodes.find((x) => x.id === id);
    if (n && n.kind !== 'file') parts.push(n.name);
  }
  parts.push(name);
  return parts.join('::');
}

/** Visit every body a def can carry — a `do … end` block and/or a `do:` keyword. */
function visitDefBody(node: SyntaxNode, ctx: ExtractorContext): void {
  const block = doBlock(node);
  if (block) {
    for (let i = 0; i < block.namedChildCount; i++) {
      const child = block.namedChild(i);
      if (child) ctx.visitNode(child);
    }
  }
  const args = callArgs(node);
  const kw = args?.namedChildren.find((c) => c.type === 'keywords');
  if (kw) {
    for (let i = 0; i < kw.namedChildCount; i++) {
      const pair = kw.namedChild(i);
      if (pair?.type === 'pair') {
        const val = pair.childForFieldName('value') ?? pair.namedChild(1);
        if (val) ctx.visitNode(val);
      }
    }
  }
}

export const elixirExtractor: LanguageExtractor = {
  // Elixir has no dedicated declaration node types — everything is dispatched
  // through visitNode below. `callTypes` is empty because the hook records
  // calls itself (the core's extractCall keys off a `function` field Elixir
  // lacks).
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
    // Module attributes: `@doc …`, `@spec …`, `@moduledoc …`, `@my_attr …`
    // parse as `unary_operator` over a call. Not symbols in v1 — consume so the
    // inner call isn't mis-recorded as a call to "doc"/"spec".
    if (node.type === 'unary_operator') {
      const txt = getNodeText(node, ctx.source);
      if (txt.trimStart().startsWith('@')) return true;
      return false; // -x / !flag / ^pin — let the core descend for nested calls
    }

    if (node.type !== 'call') return false;

    const target = callTarget(node);
    if (!target) return false;
    // A qualified target (`Mod.fun`) is always a real call, never a macro.
    const macro = target.type === 'identifier' ? target.text : null;
    const args = callArgs(node);

    // --- defmodule / defprotocol ---
    if (macro === 'defmodule' || macro === 'defprotocol') {
      const alias = args?.namedChildren.find((c) => c.type === 'alias');
      const name = alias ? getNodeText(alias, ctx.source) : '<anonymous>';
      const kind = macro === 'defprotocol' ? 'interface' : 'module';
      const created = ctx.createNode(kind, name, node);
      const block = doBlock(node);
      if (created && block) {
        ctx.pushScope(created.id);
        for (let i = 0; i < block.namedChildCount; i++) {
          const child = block.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    // --- defimpl Protocol, for: Type ---
    if (macro === 'defimpl') {
      const aliases = args?.namedChildren.filter((c) => c.type === 'alias') ?? [];
      const protocol = aliases[0] ? getNodeText(aliases[0], ctx.source) : '<protocol>';
      // `for:` target type, if present
      const kw = args?.namedChildren.find((c) => c.type === 'keywords');
      const forPair = kw?.namedChildren.find(
        (p) => p.type === 'pair' && (p.childForFieldName('key')?.text ?? '').trim().replace(/:$/, '') === 'for'
      );
      const forVal = forPair?.childForFieldName('value');
      const forType = forVal ? getNodeText(forVal, ctx.source) : 'Any';
      const created = ctx.createNode('module', `${protocol}.${forType}`, node);
      if (created) {
        ctx.addUnresolvedReference({
          fromNodeId: created.id,
          referenceName: protocol,
          referenceKind: 'implements',
          filePath: ctx.filePath,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
        const block = doBlock(node);
        if (block) {
          ctx.pushScope(created.id);
          for (let i = 0; i < block.namedChildCount; i++) {
            const child = block.namedChild(i);
            if (child) ctx.visitNode(child);
          }
          ctx.popScope();
        }
      }
      return true;
    }

    // --- def / defp / defmacro / defguard / defdelegate ---
    if (macro && DEF_MACROS.has(macro)) {
      const name = defName(args);
      if (name) {
        // Fold additional clauses of the same function into the first node, but
        // still walk each clause body so all its calls are recorded.
        const qn = qualifiedNameFor(ctx, name);
        const existing = ctx.nodes.find((n) => n.kind === 'function' && n.qualifiedName === qn);
        const fnNode = existing ?? ctx.createNode('function', name, node, {
          visibility: PRIVATE_DEFS.has(macro) ? 'private' : 'public',
          signature: (getNodeText(node, ctx.source).split('\n')[0] ?? '').trim(),
        });
        if (fnNode) {
          ctx.pushScope(fnNode.id);
          visitDefBody(node, ctx);
          ctx.popScope();
        }
      }
      return true;
    }

    // --- defstruct / defexception ---
    if (macro && STRUCT_MACROS.has(macro)) {
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const parent = parentId ? ctx.nodes.find((n) => n.id === parentId) : undefined;
      ctx.createNode('struct', parent?.name ?? macro, node);
      return true;
    }

    // --- alias / import / require / use ---
    if (macro && DEP_MACROS.has(macro)) {
      const signature = (getNodeText(node, ctx.source).split('\n')[0] ?? '').trim();
      const first = args?.namedChild(0);
      if (first?.type === 'alias') {
        const canonical = getNodeText(first, ctx.source);
        // `alias X, as: Y` — the `as:` keyword renames the local binding: later
        // code refers to X only as Y (e.g. `Y.some_function()`). Elixir's own
        // default-alias rule (`alias Foo.Bar` binds the LAST segment, `Bar`,
        // with no `as:` needed) means an explicit `as:` is the only case where
        // the local name actually diverges from the canonical module path,
        // so record the import under the alias name and keep the canonical
        // path in `signature` for the resolver to recover (import-resolver.ts
        // resolveElixirAlias reads it back out).
        const asAlias = elixirAsAlias(args, ctx.source);
        ctx.createNode('import', asAlias ?? canonical, node, { signature });
      } else if (first?.type === 'dot') {
        // Multi-alias: `alias A.B.{X, Y}` → dot(left: alias "A.B", right: tuple)
        const base = getNodeText(first.childForFieldName('left') ?? first, ctx.source);
        const tuple = first.childForFieldName('right') ?? first.namedChildren.find((c) => c.type === 'tuple');
        if (tuple) {
          for (let i = 0; i < tuple.namedChildCount; i++) {
            const member = tuple.namedChild(i);
            if (member?.type === 'alias') {
              ctx.createNode('import', `${base}.${getNodeText(member, ctx.source)}`, node, { signature });
            }
          }
        }
      }
      return true;
    }

    // --- real function call ---
    let callee: string;
    if (target.type === 'identifier') callee = target.text;
    else callee = getNodeText(target, ctx.source); // dot → "Mod.fun"

    const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (callerId && !SKIP_CALL.has(callee)) {
      ctx.addUnresolvedReference({
        fromNodeId: callerId,
        referenceName: callee,
        referenceKind: 'calls',
        filePath: ctx.filePath,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    // Descend into every child except the target so nested calls in arguments,
    // do-blocks (control-flow macros), and keyword bodies are still recorded.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child !== target) ctx.visitNode(child);
    }
    return true;
  },
};
