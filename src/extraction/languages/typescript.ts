import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const typescriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration', 'abstract_class_declaration'],
  methodTypes: ['method_definition', 'public_field_definition'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // public_field_definition (arrow function class fields) nest the body inside
    // an arrow_function or function_expression child:
    //   public_field_definition → arrow_function → body (statement_block)
    // Also handles wrapper patterns like: field = withBatchedUpdates((e) => { ... })
    //   public_field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'public_field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        // Check inside call_expression arguments (HOF wrappers like throttle, debounce)
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
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
    }
    return sig;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return undefined;
  },
  isExported: (node, _source) => {
    // Walk the parent chain to find an export_statement ancestor.
    // This correctly handles deeply nested nodes like arrow functions
    // inside variable declarations: `export const X = () => { ... }`
    // where the arrow_function is 3 levels deep under export_statement.
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
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static') return true;
    }
    return false;
  },
  isConst: (node) => {
    // For lexical_declaration, check if it's 'const' or 'let'
    // For variable_declaration, it's always 'var'
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
