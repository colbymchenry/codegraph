import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const glslExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'preproc_function_def'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['function_call'],
  variableTypes: ['declaration', 'local_declaration', 'parameter_declaration', 'field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: (node, source) => {
    if (node.type === 'function_definition' || node.type === 'preproc_function_def') {
      const declarator = node.namedChildren.find((c: SyntaxNode) => c.type === 'function_declarator');
      if (declarator) {
        const nameNode = getChildByField(declarator, 'name') || declarator.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        if (nameNode) return getNodeText(nameNode, source);
      }
    } else if (node.type === 'struct_specifier') {
      const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier');
      if (nameNode) return getNodeText(nameNode, source);
    } else if (node.type === 'declaration' || node.type === 'local_declaration' || node.type === 'parameter_declaration' || node.type === 'field_declaration') {
      const instanceName = getChildByField(node, 'instance_name');
      if (instanceName) return getNodeText(instanceName, source);
      
      const declaratorList = node.namedChildren.find((c: SyntaxNode) => c.type === 'declarator_list');
      if (declaratorList) {
        const declarator = declaratorList.namedChildren.find((c: SyntaxNode) => c.type === 'declarator');
        if (declarator) {
          const nameNode = getChildByField(declarator, 'name');
          if (nameNode) return getNodeText(nameNode, source);
        }
      }
      
      const initDeclarator = node.namedChildren.find((c: SyntaxNode) => c.type === 'init_declarator');
      if (initDeclarator) {
        const nameNode = getChildByField(initDeclarator, 'declarator') || initDeclarator.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        if (nameNode) return getNodeText(nameNode, source);
      }
      
      // Fallbacks
      const nameNode = getChildByField(node, 'name');
      if (nameNode) return getNodeText(nameNode, source);
      
      const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier' || c.type === 'field_identifier');
      if (identifier) return getNodeText(identifier, source);
    }
    return undefined;
  },
  // GLSL function_definition has no 'body' named field; the compound_statement
  // is a plain named child — find it so visitFunctionBody gets called.
  resolveBody: (node) => {
    return node.namedChildren.find((c: SyntaxNode) => c.type === 'compound_statement') ?? null;
  },

  // Struct declarations are nested inside `declaration` nodes:
  //   declaration → declarator_list → declarator → type → type_specifier → struct_specifier
  // The generic variable-extraction path sets skipChildren=true and never reaches
  // struct_specifier. Intercept declaration nodes that carry a struct and extract
  // the struct directly, then mark as handled so the variable path is skipped.
  visitNode: (node, ctx) => {
    if (node.type !== 'declaration') return false;
    const structNode = findNestedStructSpecifier(node);
    if (!structNode) return false;
    const nameNode =
      structNode.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier') ??
      structNode.childForFieldName('name');
    if (!nameNode) return false;
    const name = ctx.source.substring(nameNode.startIndex, nameNode.endIndex);
    if (!name) return false;
    ctx.createNode('struct', name, structNode, {});
    return true;
  },

  extractImport: () => null,
};

function findNestedStructSpecifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'struct_specifier') return node;
  for (const child of node.namedChildren) {
    const found = findNestedStructSpecifier(child);
    if (found) return found;
  }
  return null;
}
