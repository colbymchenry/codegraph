import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * JSON extractor — surfaces top-level object keys as variable nodes.
 *
 * Hugo-relevant files this covers:
 *   - hugo.json / config/_default/*.json
 *   - data/**\/*.json                          (.Site.Data)
 *   - i18n/*.json                              (translations)
 *   - theme.json                               (Hugo theme metadata)
 *
 * Note on package-lock.json and similar generated files: these can produce
 * a lot of nodes. Recommend excluding them via .codegraph/config.json:
 *
 *   { "exclude": ["**\/package-lock.json", "**\/*.lock.json"] }
 *
 * Spec: 03-YAML-JSON.md
 */
export const jsonExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: ['pair'],
  nameField: 'key',
  bodyField: 'value',
  paramsField: '',
  returnField: undefined,
  getSignature: (node, source) => {
    const val = node.childForFieldName('value');
    if (!val) return undefined;
    const text = getNodeText(val, source).trim();
    // Skip nested objects/arrays — too verbose for signatures
    if (text.startsWith('{') || text.startsWith('[')) return undefined;
    return text.substring(0, 120);
  },
  isAsync: () => false,
  isStatic: () => false,
  extractImport: () => null,
};
