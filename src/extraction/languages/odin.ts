import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor } from '../tree-sitter-types';

export const odinExtractor: LanguageExtractor = {
  functionTypes: ['procedure_declaration', 'overloaded_procedure_declaration'],
  classTypes: [], // Odin has no classes
  methodTypes: [], // Procedures are not attached to classes/objects
  interfaceTypes: [], // Odin has no interfaces/traits
  structTypes: ['struct_declaration', 'union_declaration', 'bit_field_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['identifier'], // Enum values are identifiers
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression', 'selector_call_expression'],
  variableTypes: ['variable_declaration', 'var_declaration', 'const_declaration', 'const_type_declaration'],
  fieldTypes: ['field'], // Struct fields

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  resolveName: (node: SyntaxNode, source: string) => {
    // In Odin, declarations are structured as: name :: definition or name : type := definition
    // The LHS name (an identifier or expression) is the first named child.
    const first = node.firstNamedChild;
    if (first) {
      return source.substring(first.startIndex, first.endIndex).trim();
    }
    return undefined;
  },

  resolveBody: (node: SyntaxNode, _bodyField: string) => {
    if (node.type === 'procedure_declaration') {
      const procNode = node.namedChildren.find(c => c.type === 'procedure');
      if (procNode) {
        const block = procNode.namedChildren.find(c => c.type === 'block');
        if (block) return block;
      }
    } else if (
      node.type === 'struct_declaration' ||
      node.type === 'union_declaration' ||
      node.type === 'bit_field_declaration' ||
      node.type === 'enum_declaration'
    ) {
      // The struct/enum fields are direct children of the declaration node.
      // Returning the node itself allows the core extractor to visit its children.
      return node;
    }
    return null;
  },

  getSignature: (node: SyntaxNode, source: string) => {
    const procNode = node.namedChildren.find(c => c.type === 'procedure' || c.type === 'overloaded_procedure');
    if (procNode) {
      return source.substring(procNode.startIndex, procNode.endIndex).trim();
    }
    return undefined;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) return null;

    let modulePath = source.substring(pathNode.startIndex, pathNode.endIndex).trim();
    // Strip string quotes
    if ((modulePath.startsWith('"') && modulePath.endsWith('"')) ||
        (modulePath.startsWith('`') && modulePath.endsWith('`'))) {
      modulePath = modulePath.slice(1, -1);
    }

    const signature = source.substring(node.startIndex, node.endIndex).trim();
    return {
      moduleName: modulePath,
      signature: signature,
    };
  },
};
