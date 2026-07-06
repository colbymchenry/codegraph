import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Elixir extractor — call-dominant grammar (everything is a `call` node).
 *
 * The Elixir grammar has NO distinct node types for definitions. Every
 * keyword construct (def, defp, defmodule, alias, import, if, case, ...) is a
 * generic `call` node whose `target` identifier text distinguishes them.
 *
 * This extractor uses `visitNode` to disambiguate definition calls from
 * regular function calls by checking the target text, then lets the generic
 * walker handle children for non-definition calls.
 */

// --- Keyword sets ---

/** Definition keywords that produce function nodes. */
const DEF_CALLS = new Set([
  'def', 'defp',
  'defguard', 'defguardp',
  'defdelegate',
  'defmacro', 'defmacrop',
]);

/** Module definition keywords. */
const MODULE_CALLS = new Set(['defmodule']);

/** Protocol/implementation keywords (interface-like). */
const PROTOCOL_CALLS = new Set(['defprotocol', 'defimpl']);

/** Import-like keywords. */
const IMPORT_CALLS = new Set(['alias', 'import', 'require', 'use']);

/** Keywords that should be consumed without producing nodes or call edges. */
const SKIP_CALLS = new Set([
  'defstruct', 'defexception', 'defoverridable',
  'if', 'unless', 'case', 'cond', 'with', 'try', 'receive', 'for',
  'raise', 'throw', 'exit', 'reraise',
  'send', 'spawn', 'spawn_link', 'spawn_monitor',
  'put_elem', 'elem', 'tuple_size',
  'is_atom', 'is_binary', 'is_boolean', 'is_float',
  'is_function', 'is_integer', 'is_list', 'is_map', 'is_number',
  'is_pid', 'is_port', 'is_reference', 'is_tuple',
  'abs', 'round', 'div', 'rem', 'trunc', 'hd', 'tl', 'length', 'in',
  'map_size', 'byte_size', 'bit_size', 'self',
]);

// --- Clause-merge state for multi-clause functions ---
// Elixir emits separate `call` nodes for each clause of a multi-clause def
// (`def foo(:a), do: ... ; def foo(:b), do: ...`). We merge them by name.
let lastFnFile = '';
let lastFnName = '';
let lastFnId = '';

// ===========================================================================
// Helpers
// ===========================================================================

/** Get the target text of a `call` node, or null if it can't be determined. */
function getTargetText(node: SyntaxNode, source: string): string | null {
  const target = getChildByField(node, 'target') || node.namedChild(0);
  if (!target || target.type !== 'identifier') return null;
  return getNodeText(target, source);
}

/** Find the `do_block` child of a call node, or null. */
function findDoBlock(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'do_block') return child;
  }
  return null;
}

/**
 * Find a named child of a specific type (for children that aren't
 * field-named — the Elixir grammar's `call` node has `arguments` and
 * `do_block` as type-identified named children, not fields).
 */
function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/**
 * Check if a binary_operator or unary_operator node has a given operator text
 * as an anonymous child (used for `|>` pipe and `@` attribute detection).
 */
function hasOperatorText(node: SyntaxNode, source: string, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && getNodeText(child, source) === text) return true;
  }
  return false;
}

/**
 * Extract function name and params from a def/defp/defguard/etc. call node.
 *
 * Structure:
 *   `def foo(x)` → call(target:"def") → arguments[0] = call(target:"foo") with its own arguments
 *   `def foo(x) when is_integer(x)` → arguments[0] = binary_operator(when)
 */
interface FunctionInfo {
  name: string;
  signature?: string;
}
function extractFunctionInfo(node: SyntaxNode, source: string): FunctionInfo | null {
  // Elixir grammar: `arguments` is a named child, NOT a field on `call` nodes
  const args = findChildByType(node, 'arguments');
  if (!args) return null;

  const firstArg = args.namedChild(0);
  if (!firstArg) return null;

  // Guarded def: `def foo(x) when cond` → firstArg is binary_operator (when)
  if (firstArg.type === 'binary_operator' && hasOperatorText(firstArg, source, 'when')) {
    const left = getChildByField(firstArg, 'left') || firstArg.namedChild(0);
    if (left && left.type === 'call') {
      const innerTarget = getChildByField(left, 'target') || left.namedChild(0);
      if (innerTarget && innerTarget.type === 'identifier') {
        const name = getNodeText(innerTarget, source);
        // Inner call: `arguments` is also a named child, not a field
        const paramsNode = findChildByType(left, 'arguments');
        const sig = paramsNode ? getNodeText(paramsNode, source).slice(0, 200) : undefined;
        return name ? { name, signature: sig } : null;
      }
    }
    return null;
  }

  // No-parens: `def foo do ... end` → firstArg is an identifier (no params)
  if (firstArg.type === 'identifier') {
    const name = getNodeText(firstArg, source);
    return name ? { name } : null;
  }

  // Simple: `def foo(x)` → firstArg is a call with target "foo"
  if (firstArg.type === 'call') {
    const innerTarget = getChildByField(firstArg, 'target') || firstArg.namedChild(0);
    if (!innerTarget || innerTarget.type !== 'identifier') return null;
    const name = getNodeText(innerTarget, source);
    // Inner call: `arguments` is also a named child, not a field
    const paramsNode = findChildByType(firstArg, 'arguments');
    const sig = paramsNode ? getNodeText(paramsNode, source).slice(0, 200) : undefined;
    return name ? { name, signature: sig } : null;
  }

  // `defdelegate foo(args), to: Mod` → firstArg is a call with target "foo"
  if (firstArg.type === 'call') {
    const innerTarget = getChildByField(firstArg, 'target') || firstArg.namedChild(0);
    if (innerTarget && innerTarget.type === 'identifier') {
      const name = getNodeText(innerTarget, source);
      return name ? { name } : null;
    }
  }

  return null;
}

// ===========================================================================
// Handlers
// ===========================================================================

function handleDefinition(node: SyntaxNode, targetText: string, ctx: ExtractorContext): boolean {
  // --- defmodule ---
  if (targetText === 'defmodule') {
    // Elixir grammar: `arguments` is a named child, NOT a field on `call`
    const args = findChildByType(node, 'arguments');
    const moduleNameNode = args ? args.namedChild(0) : null;
    if (!moduleNameNode) return true;
    const moduleName = getNodeText(moduleNameNode, ctx.source);
    if (!moduleName) return true;

    const mod = ctx.createNode('module', moduleName, node, {
      docstring: getPrecedingDocstring(node, ctx.source),
    });
    if (!mod) return true;

    ctx.pushScope(mod.id);
    const doBlock = findDoBlock(node);
    if (doBlock) {
      for (let i = 0; i < doBlock.namedChildCount; i++) {
        const child = doBlock.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
    ctx.popScope();
    return true;
  }

  // --- function definitions (def, defp, defguard, etc.) ---
  const info = extractFunctionInfo(node, ctx.source);
  if (!info || !info.name) return true;

  const isPrivate = targetText === 'defp' || targetText === 'defguardp' || targetText === 'defmacrop';

  // Multi-clause merge: if same name as previous def in same file, extend it
  if (ctx.filePath === lastFnFile && info.name === lastFnName && lastFnId) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    ctx.pushScope(lastFnId);
    const doBlock = findDoBlock(node);
    if (doBlock) ctx.visitFunctionBody(doBlock, lastFnId);
    ctx.popScope();
    return true;
  }

  const fn = ctx.createNode('function', info.name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: info.signature,
    visibility: isPrivate ? 'private' : 'public',
  });
  if (!fn) return true;

  ctx.pushScope(fn.id);
  const doBlock = findDoBlock(node);
  if (doBlock) ctx.visitFunctionBody(doBlock, fn.id);
  ctx.popScope();

  lastFnFile = ctx.filePath;
  lastFnName = info.name;
  lastFnId = fn.id;

  return true;
}

function handleImport(node: SyntaxNode, _targetText: string, ctx: ExtractorContext): boolean {
  // Elixir grammar: `arguments` is a named child, NOT a field on `call`
  const args = findChildByType(node, 'arguments');
  if (!args) return true;

  const moduleNameNode = args.namedChild(0);
  if (!moduleNameNode) return true;

  const moduleName = getNodeText(moduleNameNode, ctx.source);
  if (!moduleName) return true;

  const imp = ctx.createNode('import', moduleName, node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 200),
  });
  if (imp && ctx.nodeStack.length > 0) {
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }
  return true;
}

function emitCallRef(ctx: ExtractorContext, node: SyntaxNode, calleeName: string): void {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return;
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: calleeName,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

// ===========================================================================
// Extractor
// ===========================================================================

export const elixirExtractor: LanguageExtractor = {
  // All patterns are detected via visitNode since the grammar uses `call` for everything
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
  interfaceKind: 'trait',

  /** Extract call edges inside function bodies (walked by visitFunctionBody). */
  extractBareCall: (node, source) => {
    if (node.type !== 'call') return undefined;
    const targetText = getTargetText(node, source);
    if (!targetText) return undefined;
    // Skip definition/import/keyword calls (handled by visitNode at module level)
    if (DEF_CALLS.has(targetText)) return undefined;
    if (MODULE_CALLS.has(targetText)) return undefined;
    if (PROTOCOL_CALLS.has(targetText)) return undefined;
    if (IMPORT_CALLS.has(targetText)) return undefined;
    if (SKIP_CALLS.has(targetText)) return undefined;
    // Qualified call (Enum.map)
    const target = getChildByField(node, 'target') || node.namedChild(0);
    if (target && target.type === 'dot') {
      const left = getChildByField(target, 'left') || target.namedChild(0);
      const right = getChildByField(target, 'right') || target.namedChild(1);
      if (left && right) return `${getNodeText(left, source)}.${getNodeText(right, source)}`;
    }
    // Bare function call
    return targetText;
  },

  visitNode: (node, ctx) => {
    // --- `call` — the universal node type in Elixir ---
    if (node.type === 'call') {
      const targetText = getTargetText(node, ctx.source);
      if (!targetText) return false;

      // Definition calls (def, defp, defmodule, etc.)
      if (DEF_CALLS.has(targetText)) {
        return handleDefinition(node, targetText, ctx);
      }

      if (MODULE_CALLS.has(targetText)) {
        return handleDefinition(node, targetText, ctx);
      }

      // Protocol/impl — treat as function-like definitions for now
      if (PROTOCOL_CALLS.has(targetText)) {
        return handleDefinition(node, targetText, ctx);
      }

      // Import-like calls (alias, import, require, use)
      if (IMPORT_CALLS.has(targetText)) {
        return handleImport(node, targetText, ctx);
      }

      // Skip language keyword constructs (if, case, with, etc.)
      if (SKIP_CALLS.has(targetText)) {
        return true;
      }

      // Regular function call — emit call edge
      const target = getChildByField(node, 'target') || node.namedChild(0);
      if (target && target.type === 'dot') {
        // Module.function() qualified call
        const left = getChildByField(target, 'left') || target.namedChild(0);
        const right = getChildByField(target, 'right') || target.namedChild(1);
        if (left && right) {
          emitCallRef(ctx, node, `${getNodeText(left, ctx.source)}.${getNodeText(right, ctx.source)}`);
        }
      } else if (target && target.type === 'identifier') {
        // Bare function call
        emitCallRef(ctx, node, targetText);
      }

      // Return false so the generic walker visits children (nested calls)
      return false;
    }

    // --- binary_operator — skip pipe |> (data flow, not a call) ---
    if (node.type === 'binary_operator') {
      if (hasOperatorText(node, ctx.source, '|>')) {
        return true;
      }
      return false; // other binary ops (when, +, etc.) — let generic handle
    }

    // --- unary_operator — skip @ attribute access ---
    if (node.type === 'unary_operator') {
      if (hasOperatorText(node, ctx.source, '@')) {
        return true;
      }
      return false;
    }

    return false;
  },
};
