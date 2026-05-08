import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const javascriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_definition', 'field_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = throttle((e) => { ... })
    //   field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        if (child.type === 'call_expression') {
          const args = getChildByField(child, 'arguments');
          if (args) {
            for (let j = 0; j < args.namedChildCount; j++) {
              const arg = args.namedChild(j);
              if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
                return getChildByField(arg, bodyField);
              }
            }
          }
        }
      }
    }
    return null;
  },
  paramsField: 'parameters',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },
  isExported: (node, _source) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isConst: (node) => {
    if (node.type === 'lexical_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },
};
