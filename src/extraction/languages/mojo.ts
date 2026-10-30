import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Mojo (Modular) extraction.
 *
 * Mojo's grammar (`tree-sitter-mojo`) is derived from `tree-sitter-python`, so a
 * definition carries the same fields the core extractor reads — `name`, `body`,
 * `parameters`, `return_type` — and the same import shape. The differences this
 * config accounts for:
 *
 * - Mojo declares types with `struct` and `trait`, not `class`. `struct_definition`
 *   is both the "class" and the "struct" of this language; `trait_definition` is
 *   the interface.
 * - A function may be introduced by `def` or `fn`; the grammar folds both into
 *   `function_definition`.
 * - Compile-time parameters are a separate field, `meta_parameters`, written in
 *   square brackets: `def f[T: AnyType](x: T) -> T`. They belong in the
 *   signature or the indexed signature is missing the parameterization.
 * - `comptime` and `alias` declarations are Mojo-specific and are not modelled
 *   as callable definitions here.
 */
export const mojoExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['struct_definition'],
  methodTypes: ['function_definition'], // Methods are functions inside a struct
  interfaceTypes: ['trait_definition'],
  structTypes: ['struct_definition'],
  enumTypes: [],
  typeAliasTypes: ['type_alias_statement'],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    // Mojo's compile-time parameter list precedes the runtime one and is part of
    // how a caller must spell the call, so it is kept in the signature.
    const meta = getChildByField(node, 'meta_parameters');
    let sig = (meta ? getNodeText(meta, source) : '') + getNodeText(params, source);
    const returnType = getChildByField(node, 'return_type');
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        return {
          moduleName: source.substring(moduleNode.startIndex, moduleNode.endIndex),
          signature: importText,
        };
      }
    }
    // `import a.b` can name several modules on one line; return null so the core
    // extractor's own fallback walks them.
    return null;
  },
};
