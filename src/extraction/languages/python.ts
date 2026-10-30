import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { preParseCython, CYTHON_FILE } from './cython-preparse';

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
  // Cython (.pyx/.pxd/.pxi) is a Python superset carried by this language
  // (the way .metal/.cu ride 'cpp'): the preParse rewrites its Cython-only
  // constructs into the Python shapes the grammar reads (#1819). Plain .py
  // sources pass through untouched — the transform is gated on the file
  // extension and its own cheap keyword gate.
  preParse: (source, filePath) => (filePath && CYTHON_FILE.test(filePath) ? preParseCython(source) : source),
  // A Cython `ctypedef`/`cdef` declaration the preParse deliberately leaves
  // for the grammar's error recovery, whose shape this hook reads (see
  // cythonDeclarationNode below).
  visitNode: cythonDeclarationNode,
  /**
   * Python states intent in a docstring — a bare string literal as the first
   * statement of the body — not in a preceding comment, so the comment-sibling
   * walk never reached it and the prose never entered the index (#1905).
   *
   * Reads `string_content` rather than slicing quotes off the raw text: the
   * grammar already separates delimiters from body, which keeps `r`/`u`
   * prefixes and both `"""` and `'''` forms working without a regex per case.
   * Bytes and f-strings are not Python docstrings.
   */
  getBodyDocstring: (node, source) => {
    const body = node.type === 'module' ? node : getChildByField(node, 'body');
    if (!body) return undefined;
    const first = body.namedChildren.find((c) => c.type !== 'comment');
    if (!first || first.type !== 'expression_statement') return undefined;
    if (first.namedChildCount !== 1 || first.children.some((c) => c.type === ',')) return undefined;
    let literal = first.namedChild(0);
    while (literal?.type === 'parenthesized_expression') {
      literal = literal.namedChildren.find((c) => c.type !== 'comment') ?? null;
    }
    if (!literal) return undefined;
    const strings = literal.type === 'concatenated_string'
      ? literal.namedChildren.filter((c) => c.type !== 'comment') : [literal];
    let raw = '';
    for (const string of strings) {
      if (string.type !== 'string') return undefined;
      const start = string.namedChildren.find((c) => c.type === 'string_start');
      if (!start || /[bf]/i.test(getNodeText(start, source))) return undefined;
      if (!string.namedChildren.some((c) => c.type === 'string_end')) return undefined;
      const content = string.namedChildren.find((c) => c.type === 'string_content');
      if (content) raw += getNodeText(content, source);
    }
    return dedentDocstring(raw) || undefined;
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
 * Cython declarations the preParse leaves to the grammar's error recovery
 * (#1819), whose shapes this hook reads — the gate is a C `cdef`/`ctypedef`
 * keyword, and only in a Cython file (type-checked first: the hook runs for
 * every node of every Python file):
 *
 * - A C aggregate — `cdef struct Point:` / `ctypedef enum Color:` (its body
 *   blanked by the preParse) — recovers as an ERROR over the keywords with
 *   the declared name escaping beside it (an assignment `Point:` when the
 *   colon ended the line, a bare identifier in the colon-less old style). The
 *   shape is read into the `struct`/`union`/`enum` node the declaration means;
 *   the assignment's own variable node is suppressed.
 * - A plain alias — `ctypedef unsigned long long u64` — recovers as an ERROR
 *   with the alias name as a following bare-name expression: a `type_alias`.
 * - An initialized declaration — `cdef int x = f(3)` — recovers as an
 *   assignment whose LEFT side is the keyword itself (`cdef`, `int x` an
 *   ERROR inside). That would mint a bogus `variable cdef`, so the statement
 *   is dropped whole (a `.pyx` cannot spell a variable named `cdef`).
 */
function cythonDeclarationNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type !== 'ERROR' && node.type !== 'expression_statement') return false;
  if (!CYTHON_FILE.test(ctx.filePath)) return false;
  if (node.type === 'ERROR') {
    const head = node.text.trimStart();
    if (!/^(?:ctypedef|cdef)\b/.test(head)) return false;
    const kind = /\bstruct\b/.test(head) ? 'struct' : /\bunion\b/.test(head) ? 'union' : /\benum\b/.test(head) ? 'enum' : null;
    if (!kind && !head.startsWith('ctypedef')) return false;
    const next = node.nextNamedSibling;
    if (!next || next.type !== 'expression_statement' || next.namedChildCount !== 1) return false;
    const value = next.namedChild(0)!;
    if (value.type === 'identifier') {
      ctx.createNode(kind ?? 'type_alias', value.text, next, { signature: head });
      return false;
    }
    if (value.type === 'assignment') {
      const nameNode = value.childForFieldName('left');
      if (nameNode?.type === 'identifier' && kind) {
        ctx.createNode(kind, nameNode.text, next, { signature: head });
      }
      return false;
    }
    return false;
  }
  if (node.type === 'expression_statement' && node.namedChildCount === 1 && node.namedChild(0)?.type === 'assignment') {
    const left = node.namedChild(0)!.childForFieldName('left');
    if (left?.type === 'identifier' && (left.text === 'cdef' || left.text === 'cpdef')) return true;
    for (let prev = node.previousNamedSibling; prev; prev = prev.previousNamedSibling) {
      if (prev.type === 'comment') continue;
      // The assignment a C-aggregate ERROR minted above: no variable of its own.
      if (prev.type === 'ERROR') {
        const head = prev.text.trimStart();
        if (/^(?:ctypedef|cdef)\b/.test(head) && /\b(?:struct|union|enum)\b/.test(head)) return true;
      }
      break;
    }
  }
  return false;
}

/**
 * A docstring is indented to its definition, so every line after the first
 * carries that indentation. Strip the common prefix (PEP 257's rule: the first
 * line is exempt because it starts right after the opening quotes) and drop
 * blank edges, so the stored prose reads the same as a comment-derived one.
 */
function dedentDocstring(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    let column = 0;
    return Array.from(line, (char) => {
      const width = char === '\t' ? 8 - column % 8 : 1;
      column += width;
      return char === '\t' ? ' '.repeat(width) : char;
    }).join('');
  });
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
