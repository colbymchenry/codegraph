/**
 * Tree-sitter Shared Helpers
 *
 * Utility functions used by the core TreeSitterExtractor and per-language extractors.
 * Extracted to a leaf module to avoid circular imports between tree-sitter.ts and languages/.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import * as crypto from 'crypto';
import { NodeKind } from '../types';

/**
 * Generate a unique node ID
 *
 * Uses a 32-character (128-bit) hash to avoid collisions when indexing
 * large codebases with many files containing similar symbols.
 */
export function generateNodeId(
  filePath: string,
  kind: NodeKind,
  name: string,
  line: number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * Extract text from a syntax node
 */
export function getNodeText(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/**
 * Find a child node by field name
 */
export function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

// Syntax nodes that merely wrap a declaration (the emitted symbol is an inner
// child). A preceding comment is a sibling of the wrapper, not of the inner
// node, so when the inner node has no preceding comment we retry from the
// wrapper. Bounded to this whitelist so the walk can't reach the file root and
// mis-attribute an unrelated leading comment. See #780.
const DOCSTRING_WRAPPER_TYPES = new Set([
  'export_statement',      // TS/JS: `export function/class/default …`
  'decorated_definition',  // Python: `@decorator\ndef/class …`
  'lexical_declaration',   // TS/JS: `const x = () => …` (with or without export)
  'variable_declarator',   // inner hop: arrow fn → its declarator → lexical_declaration
]);

/** Collect adjacent comment nodes immediately preceding `node`. */
function collectPrecedingComments(node: SyntaxNode, source: string): string[] {
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  return comments;
}

/**
 * Get the docstring/comment preceding a node
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  let comments = collectPrecedingComments(node, source);

  // The emitted symbol may be wrapped (export_statement, decorated_definition,
  // lexical_declaration). The comment is a sibling of the wrapper one level up,
  // so retry from each wrapper ancestor until a comment is found. Only runs when
  // the node itself had no preceding comment, so unwrapped declarations (and
  // every existing test) keep their current behavior exactly. See #780.
  if (comments.length === 0) {
    let wrapper = node.parent;
    while (wrapper && DOCSTRING_WRAPPER_TYPES.has(wrapper.type)) {
      comments = collectPrecedingComments(wrapper, source);
      if (comments.length > 0) break;
      wrapper = wrapper.parent;
    }
  }

  if (comments.length === 0) return undefined;

  // Clean up comment markers
  return comments
    .map((c) =>
      c
        .replace(/^\/\*\*?|\*\/$/g, '')
        .replace(/^\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
    )
    .join('\n')
    .trim();
}
