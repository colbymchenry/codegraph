import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the vendored ABI-15 grammar (@tree-sitter-grammars/
// tree-sitter-lua), NOT the older tree-sitter-wasms build — see grammars.ts.

/** First descendant of a given type (breadth-first), or null. */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === type) return n;
    queue.push(...n.namedChildren);
  }
  return null;
}

/**
 * If `callNode` is a `require(...)` call, return the module name; otherwise null.
 * Lua/Luau have no import statement — modules are loaded by calling the global
 * `require`. Handles both:
 *   - string requires:  `require("net.http")` / `require "net.http"`  → "net.http"
 *   - Roblox/Luau path requires: `require(script.Parent.Signal)`      → "Signal"
 *     (the dominant idiom in Roblox code, where the argument is an instance path
 *     rather than a string — use the trailing field as the module name).
 */
function requireModule(callNode: SyntaxNode, source: string): string | null {
  // function_call > name: <callee>, arguments: arguments
  const name = getChildByField(callNode, 'name');
  // A dotted/colon callee (e.g. `socket.connect`) is dot/method_index_expression,
  // never a bare `require`.
  if (!name || name.type !== 'identifier') return null;
  if (getNodeText(name, source) !== 'require') return null;

  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;

  // String require — `string > content: string_content` gives the bare name.
  const content = findDescendant(args, 'string_content');
  if (content) return getNodeText(content, source).trim() || null;
  const str = findDescendant(args, 'string');
  if (str) {
    const mod = getNodeText(str, source)
      .trim()
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, '');
    if (mod) return mod;
  }

  // Roblox/Luau instance-path require: `require(script.Parent.Signal)` → "Signal".
  const idx = findDescendant(args, 'dot_index_expression') ?? findDescendant(args, 'method_index_expression');
  if (idx) {
    const field = getChildByField(idx, 'field') ?? getChildByField(idx, 'method');
    if (field) return getNodeText(field, source).trim() || null;
  }
  return null;
}

export const luaExtractor: LanguageExtractor = {
  // function_declaration covers global (`function f`), table (`function t.f`),
  // method (`function t:m`), and local (`local function f`) forms — the form is
  // distinguished by the `name:` child (identifier / dot_index_expression /
  // method_index_expression) and a `local` token, not by separate node types.
  // Anonymous `function() ... end` (function_definition) has no name and is
  // captured via its enclosing variable instead.
  functionTypes: ['function_declaration'],
  classTypes: [], // Lua has no classes/structs/interfaces/enums — tables are used for everything
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // `require` is a function_call — handled in visitNode below
  callTypes: ['function_call'],
  variableTypes: ['variable_declaration'], // see the `lua` branch in extractVariable
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  // `function t.f()` / `function t:m()` are methods on table `t`: return the
  // table as the receiver so they extract as methods with a `t::f` qualified
  // name. Plain `function f()` / `local function f()` have no receiver and stay
  // functions. (For `a.b.c`, the receiver is the nested `a.b`.)
  getReceiverType: (node, source) => {
    const name = getChildByField(node, 'name');
    if (name && (name.type === 'dot_index_expression' || name.type === 'method_index_expression')) {
      const table = getChildByField(name, 'table');
      if (table) return getNodeText(table, source);
    }
    return undefined;
  },

  // Emit import nodes for `require(...)`. The local-declaration form is handled
  // explicitly because the variable branch skips the initializer subtree; bare
  // and global `require` calls are caught when the walker reaches the
  // function_call node.
  visitNode: (node, ctx) => {
    const source = ctx.source;

    const emit = (callNode: SyntaxNode): void => {
      const mod = requireModule(callNode, source);
      if (!mod) return;
      const imp = ctx.createNode('import', mod, callNode, {
        signature: getNodeText(callNode, source).trim().slice(0, 100),
      });
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: mod,
            referenceKind: 'imports',
            line: callNode.startPosition.row + 1,
            column: callNode.startPosition.column,
          });
        }
      }
    };

    // Bare / global `require("x")` — claim it so it isn't double-counted as a call.
    if (node.type === 'function_call') {
      if (requireModule(node, source)) {
        emit(node);
        return true;
      }
      return false;
    }

    // `local x = require("x")` — variable_declaration wraps an assignment_statement
    // whose initializer subtree the variable branch will skip, so dig it out here.
    if (node.type === 'variable_declaration') {
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement');
      const exprList = assign?.namedChildren.find((c) => c.type === 'expression_list');
      if (exprList) {
        for (const val of exprList.namedChildren) {
          if (val.type === 'function_call') emit(val);
        }
      }
      return false;
    }

    return false;
  },
};
