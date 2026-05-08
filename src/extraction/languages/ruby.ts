import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const rubyExtractor: LanguageExtractor = {
  functionTypes: ['method'],
  classTypes: ['class'],
  methodTypes: ['method', 'singleton_method'],
  interfaceTypes: [], // Ruby uses modules (handled via visitNode hook)
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['call'], // require/require_relative
  callTypes: ['call', 'method_call'],
  variableTypes: ['assignment'], // Ruby uses assignment like Python
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  visitNode: (node, ctx) => {
    if (node.type !== 'module') return false;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return false;
    const name = nameNode.text;

    const moduleNode = ctx.createNode('module', name, node);
    if (!moduleNode) return false;

    // Push module onto scope stack so children get proper qualified names
    ctx.pushScope(moduleNode.id);
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
    ctx.popScope();
    return true; // handled
  },
  extractBareCall: (node, _source) => {
    // Ruby bare method calls (no parens, no receiver) parse as plain identifiers.
    // e.g., `reset` in a method body is `identifier "reset"` not a `call` node.
    if (node.type !== 'identifier') return undefined;

    const parent = node.parent;
    if (!parent) return undefined;

    // Only statement-level identifiers — direct children of block/body nodes
    const BLOCK_PARENTS = new Set([
      'body_statement', 'then', 'else', 'do', 'begin',
      'rescue', 'ensure', 'when',
    ]);
    if (!BLOCK_PARENTS.has(parent.type)) return undefined;

    const name = node.text;

    // Skip Ruby keywords/literals
    const SKIP = new Set([
      'true', 'false', 'nil', 'self', 'super',
      '__FILE__', '__LINE__', '__dir__',
    ]);
    if (SKIP.has(name)) return undefined;

    // Skip constants (uppercase start) — these are class/module refs, not calls
    if (name.length > 0 && name.charCodeAt(0) >= 65 && name.charCodeAt(0) <= 90) return undefined;

    return name;
  },
  getVisibility: (node) => {
    // Ruby visibility is based on preceding visibility modifiers
    let sibling = node.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'call') {
        const methodName = getChildByField(sibling, 'method');
        if (methodName) {
          const text = methodName.text;
          if (text === 'private') return 'private';
          if (text === 'protected') return 'protected';
          if (text === 'public') return 'public';
        }
      }
      sibling = sibling.previousNamedSibling;
    }
    return 'public';
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // Check if this is a require/require_relative call
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (!identifier) return null;
    const methodName = getNodeText(identifier, source);
    if (methodName !== 'require' && methodName !== 'require_relative') {
      return null; // Not an import, skip
    }

    // Find the argument (string)
    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
    if (argList) {
      const stringNode = argList.namedChildren.find((c: SyntaxNode) => c.type === 'string');
      if (stringNode) {
        const stringContent = stringNode.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
        if (stringContent) {
          return { moduleName: getNodeText(stringContent, source), signature: importText };
        }
      }
    }
    return null;
  },
};
