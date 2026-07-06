import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * HEEx extractor — Phoenix HTML-aware EEx template language.
 *
 * HEEx is a template language used by Phoenix LiveView. The grammar produces
 * an HTML-like AST with:
 * - `tag` / `start_tag` / `end_tag` — HTML elements
 * - `component` / `start_component` / `end_component` — component tags
 *   (<.modal>, <MyComponent>, <.form>, etc.)
 * - `component_name` with `function` child for <.name> style
 *   or `module` child for <PascalCase> style
 * - `expression` / `expression_value` — {expr} Elixir expression embeds
 * - `directive` — <%= expr %> Elixir directive tags
 *
 * This extractor extracts component usages (for cross-file resolution) and
 * reference calls from template expressions so the graph connects component
 * references and callee edges.
 */

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Find first named child with a given type.
 */
function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/**
 * Find first named child by type and return its text.
 */
function extractNodeTextFromChild(
  node: SyntaxNode,
  childType: string,
  source: string
): string | null {
  const child = findChildByType(node, childType);
  if (!child) return null;
  return getNodeText(child, source);
}

/**
 * Extract callee function names from an Elixir expression value string.
 * Matches simple function call patterns: `name(...)` or `Module.name(...)`.
 */
function extractCallsFromExpression(
  expr: string
): string[] {
  const calls: string[] = [];
  // Match identifier or dotted-name followed by (
  const callRegex = /\b([a-zA-Z_][\w$.!?]*)\s*\(/g;
  let match;
  while ((match = callRegex.exec(expr)) !== null) {
    const name = match[1]!;
    // Skip Elixir keywords/captures
    if (
      name === 'if' || name === 'unless' || name === 'case' ||
      name === 'cond' || name === 'with' || name === 'try' ||
      name === 'receive' || name === 'fn' || name === 'for' ||
      name === 'raise' || name === 'throw'
    ) continue;
    calls.push(name);
  }
  return calls;
}

// ===========================================================================
// Extractor
// ===========================================================================

export const heexExtractor: LanguageExtractor = {
  // HEEx is a template language — no function/class/struct definitions
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
    // --- component: <.modal> or <MyComponent> ---
    if (node.type === 'component') {
      // component_name lives inside start_component child
      const startComp = findChildByType(node, 'start_component');
      if (!startComp) return false;
      const nameNode = findChildByType(startComp, 'component_name');
      if (!nameNode) return false;

      // component_name has either:
      // - `function` child for <.modal> style (text: "modal")
      // - `module` child for <MyComponent> style (text: "MyComponent")
      const compName =
        extractNodeTextFromChild(nameNode, 'function', ctx.source) ||
        extractNodeTextFromChild(nameNode, 'module', ctx.source);
      if (!compName) return false;

      // Create component node — this is a reference to another component
      ctx.createNode('component', compName, node);

      // Emit unresolved reference so the resolver can link
      // to the component's definition file
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (parentId) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: compName,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }

      // Continue visiting children (nested tags/components/expressions)
      return false;
    }

    // --- expression: {expr} — extract function calls ---
    if (node.type === 'expression') {
      const exprValue = findChildByType(node, 'expression_value');
      if (exprValue) {
        const exprText = getNodeText(exprValue, ctx.source);
        const callees = extractCallsFromExpression(exprText);
        for (const callee of callees) {
          ctx.addUnresolvedReference({
            fromNodeId: ctx.nodeStack[ctx.nodeStack.length - 1] || '',
            referenceName: callee,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      // Let walker visit children (text nodes, etc.)
      return false;
    }

    // --- directive: <%= expr %> — extract function calls ---
    if (node.type === 'directive') {
      // Directives contain expression_value directly as child
      const exprValue = findChildByType(node, 'expression_value');
      if (exprValue) {
        const exprText = getNodeText(exprValue, ctx.source);
        const callees = extractCallsFromExpression(exprText);
        for (const callee of callees) {
          ctx.addUnresolvedReference({
            fromNodeId: ctx.nodeStack[ctx.nodeStack.length - 1] || '',
            referenceName: callee,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return false;
    }

    return false;
  },
};
