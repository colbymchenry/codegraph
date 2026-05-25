import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * YAML extractor — surfaces top-level mapping keys as variable nodes.
 *
 * Hugo-relevant files this covers:
 *   - hugo.yaml / config/_default/*.yaml         (site config)
 *   - data/**\/*.yaml                            (.Site.Data)
 *   - i18n/*.yaml                                (translations)
 *   - .github/workflows/*.yml                    (CI)
 *
 * Only scalar values get surfaced as signatures. Nested maps and sequences
 * are still indexed as nodes (so they're searchable) but signatures are
 * omitted to avoid bloating the graph with serialised blobs.
 *
 * Spec: 03-YAML-JSON.md
 */
export const yamlExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: ['block_mapping_pair'],
  nameField: 'key',
  bodyField: 'value',
  paramsField: '',
  returnField: undefined,
  getSignature: (node, source) => {
    const val = node.childForFieldName('value');
    if (!val) return undefined;
    const text = getNodeText(val, source).trim();
    // Skip multi-line/nested values — they bloat the index without helping queries
    if (text.includes('\n')) return undefined;
    return text.substring(0, 120);
  },
  isAsync: () => false,
  isStatic: () => false,
  extractImport: () => null,
};
