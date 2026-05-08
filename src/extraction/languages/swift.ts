import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const swiftExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  getSignature: (node, source) => {
    // Swift function signature: func name(params) -> ReturnType
    const params = getChildByField(node, 'parameter');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Swift
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('internal')) return 'internal';
        if (text.includes('fileprivate')) return 'private';
      }
    }
    return 'internal'; // Swift defaults to internal
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true;
        }
      }
    }
    return false;
  },
  classifyClassNode: (node) => {
    // Swift uses class_declaration for classes, structs, and enums
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'struct') return 'struct';
      if (child?.type === 'enum') return 'enum';
    }
    return 'class';
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
