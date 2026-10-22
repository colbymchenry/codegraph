import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Interv Language Extractor.
 *
 * Interv v2 is a small functional language: `name :: fn (binders) { body }`
 * declares a function, `data Name { Ctor(fields…) ; … }` declares an algebraic
 * data type, `import path/to/module` imports a module, and application is
 * paren-call `f(a, b)`. There are no classes with dispatch in the core language
 * (the `class`/`instance` declarations add trait-style methods), so functions
 * and data constructors are the symbol backbone.
 *
 * Node shapes (from the vendored tree-sitter-interv grammar):
 *   - function_definition  name [":" type] "::" "fn" parameters body
 *   - const_definition     name [":" type] "::" value
 *   - data_declaration     "data" name "{" constructor (";" constructor)* "}"
 *   - constructor          upper_identifier ["(" field_list ")"]
 *   - import_statement     "import" path
 *   - call_expression      function arguments
 *   - class_declaration/instance_declaration with method_definition children
 */
export const intervExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration', 'instance_declaration'],
  methodTypes: ['method_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['data_declaration'],
  enumMemberTypes: ['constructor'],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: [], // consts/bindings are not symbol-bearing for indexing purposes
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  // Top-level definitions are the module's public surface; a nested `fn` value
  // is not. The member/hook bodies aren't walked for this because a nested
  // function (lambda) has no name field and is captured by its own callable —
  // only declarations whose parent is the file scope are exported.
  isExported: (node) => node.parent?.type === 'source_file',

  extractImport: (node, source) => {
    const path = getChildByField(node, 'path');
    if (!path) return null;
    const moduleName = getNodeText(path, source).trim();
    if (!moduleName) return null;
    return {
      moduleName,
      signature: source.substring(node.startIndex, node.endIndex).trim().slice(0, 120),
    };
  },

  // `data Name { … }` is an algebraic data type. The enum extraction walks the
  // constructor_body's direct children; a `constructor` node's `name` field is
  // the (namespaced-in-AST, bare-in-source) constructor name, so enum members
  // are minted per constructor.
  getReceiverType: () => undefined,
};
