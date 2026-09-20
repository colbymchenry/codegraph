import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const pythonExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'], // Methods are functions inside classes
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'], // Python uses assignment for variable declarations
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  /**
   * Python states intent in a docstring — a bare string literal as the first
   * statement of the body — not in a preceding comment, so the comment-sibling
   * walk never reached it and the prose never entered the index (#1905).
   *
   * Reads `string_content` rather than slicing quotes off the raw text: the
   * grammar already separates delimiters from body, which keeps `r`/`u`/`b`
   * prefixes and both `"""` and `'''` forms working without a regex per case.
   * f-strings are skipped — an interpolated string is code, not prose.
   */
  getBodyDocstring: (node, source) => {
    const body = getChildByField(node, 'body');
    if (!body) return undefined;
    const first = body.namedChild(0);
    if (!first || first.type !== 'expression_statement') return undefined;
    const literal = first.namedChild(0);
    if (!literal || literal.type !== 'string') return undefined;
    // `f"..."` opens with an `f`-prefixed start token; interpolation makes it
    // an expression whose text is not what the author wrote as prose.
    const start = literal.namedChild(0)?.type === 'string_start' ? literal.namedChild(0) : null;
    if (start && /f/i.test(getNodeText(start, source).replace(/['"]/g, ''))) return undefined;
    const content = literal.namedChildren.find((c) => c.type === 'string_content');
    const raw = content ? getNodeText(content, source) : undefined;
    return raw ? dedentDocstring(raw) : undefined;
  },
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    const prev = node.previousSibling;
    return prev?.type === 'async';
  },
  isStatic: (node) => {
    // Check for @staticmethod decorator
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        return { moduleName: source.substring(moduleNode.startIndex, moduleNode.endIndex), signature: importText };
      }
    }
    // import_statement creates multiple imports - return null for core fallback
    return null;
  },
};

/**
 * A docstring is indented to its definition, so every line after the first
 * carries that indentation. Strip the common prefix (PEP 257's rule: the first
 * line is exempt because it starts right after the opening quotes) and drop
 * blank edges, so the stored prose reads the same as a comment-derived one.
 */
function dedentDocstring(raw: string): string {
  const lines = raw.split('\n');
  const rest = lines.slice(1).filter((l) => l.trim().length > 0);
  const indent = rest.length === 0
    ? 0
    : Math.min(...rest.map((l) => l.length - l.trimStart().length));
  const out = [
    lines[0]?.trim() ?? '',
    ...lines.slice(1).map((l) => l.slice(indent).trimEnd()),
  ];
  while (out.length > 0 && out[0]!.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  return out.join('\n');
}
