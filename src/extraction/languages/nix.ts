import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor, ImportInfo } from '../tree-sitter-types';

export const nixExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['apply_expression'],
  callTypes: [],
  variableTypes: ['binding'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'arguments',

  visitNode: (node: SyntaxNode, ctx) => {
    if (node.type !== 'binding') return false;

    const attrpath = getChildByField(node, 'attrpath');
    const name = attrpath ? getNodeText(attrpath, ctx.source) : getNodeText(node, ctx.source);
    const valueNode = getChildByField(node, 'expression');
    const signature = valueNode ? getNodeText(valueNode, ctx.source) : undefined;

    ctx.createNode('variable', name, node, { signature });

    if (valueNode) {
      ctx.visitNode(valueNode);
    }

    return true;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    if (node.type !== 'apply_expression') return null;
    const functionNode = getChildByField(node, 'function');
    if (!functionNode || getNodeText(functionNode, source) !== 'import') return null;

    const argument = getChildByField(node, 'argument');
    if (!argument) return null;

    const moduleName = getNodeText(argument, source).replace(/^['"]|['"]$/g, '');
    return {
      moduleName,
      signature: getNodeText(node, source).trim(),
    } as ImportInfo;
  },
};
