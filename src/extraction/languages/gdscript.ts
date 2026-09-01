import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow PrestonKnopp/tree-sitter-gdscript (ABI-15).
// GDScript is Python-like: indentation-based, dynamically typed, with
// Godot-specific constructs (class_name, extends, preload, signals, @export).

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

/** Extract string content from a string literal node, stripping quotes. */
function extractString(node: SyntaxNode, source: string): string | null {
  const content = findDescendant(node, 'string_content');
  if (content) return getNodeText(content, source).trim() || null;
  const text = getNodeText(node, source).trim();
  return text.replace(/^["']|["']$/g, '') || null;
}

/**
 * If `callNode` is `preload("res://...")` or `load("res://...")`,
 * return the path string; otherwise null.
 */
function preloadOrLoad(callNode: SyntaxNode, source: string): string | null {
  const name = getChildByField(callNode, 'name');
  if (!name || name.type !== 'identifier') return null;
  const callee = getNodeText(name, source);
  if (callee !== 'preload' && callee !== 'load') return null;

  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;
  const str = findDescendant(args, 'string');
  return str ? extractString(str, source) : null;
}

/**
 * Extract the base name from an extends_statement.
 * Returns null if no extends clause found.
 */
function extractExtends(node: SyntaxNode, source: string): string | null {
  // Look for extends_statement child (used by class_name_statement)
  const extendsStmt = node.namedChildren.find((c) => c.type === 'extends_statement');
  if (!extendsStmt) return null;

  // extends_statement > type > identifier or string
  const typeNode = getChildByField(extendsStmt, 'type');
  if (!typeNode) return null;

  const ident = typeNode.namedChildren.find((c) => c.type === 'identifier');
  if (ident) return getNodeText(ident, source);

  const str = typeNode.namedChildren.find((c) => c.type === 'string');
  if (str) return extractString(str, source);
  return null;
}

export const gdscriptExtractor: LanguageExtractor = {
  // GDScript functions: `func name(...)` — top-level or inside class.
  // class_name_statement creates global classes (no class keyword needed).
  functionTypes: ['function_definition'],
  classTypes: ['class_name_statement'],
  methodTypes: [], // methods are function_definition inside class context
  interfaceTypes: [],
  structTypes: [],
  // enum blocks: `enum { A, B }` or `enum Name { A, B }`
  enumTypes: ['enum_definition'],
  typeAliasTypes: [],
  importTypes: [], // preload/load are function calls — handled in visitNode
  callTypes: ['call'],
  variableTypes: [], // GDScript vars are not first-class symbols in most cases
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  // For function_definition inside a class, the class name is the receiver.
  // This is handled by the extraction framework via nodeStack context.
  getReceiverType: () => undefined,

  // Handle preload/load calls and extends clauses.
  visitNode: (node: SyntaxNode, ctx) => {
    const source = ctx.source;

    // Handle preload/load as import edges.
    if (node.type === 'call') {
      const path = preloadOrLoad(node, source);
      if (path) {
        const imp = ctx.createNode('import', path, node, {
          signature: getNodeText(node, source).trim().slice(0, 100),
        });
        if (imp && ctx.nodeStack.length > 0) {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          if (parentId) {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: path,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return true; // claimed as import, not a generic call
      }
      return false;
    }

    // Handle extends clauses on class_name_statement.
    if (node.type === 'class_name_statement') {
      const base = extractExtends(node, source);
      if (base && ctx.nodeStack.length > 0) {
        const classId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (classId) {
          ctx.addUnresolvedReference({
            fromNodeId: classId,
            referenceName: base,
            referenceKind: 'extends',
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