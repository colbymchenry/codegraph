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

/**
 * Comment node utilities
 */
function isCommentNode(node: SyntaxNode): boolean {
  return (
    node.type === 'comment' ||
    node.type === 'line_comment' ||
    node.type === 'block_comment' ||
    node.type === 'documentation_comment'
  );
}

const DOCSTRING_WRAPPER_TYPES = new Set<string>([
  // TS/JS
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'variable_declarator',
  // Python decorators
  'decorated_definition',
]);


/**
 * Collect the contiguous run of comment siblings immediately preceding `node`
 */
function collectPrecedingComments(node: SyntaxNode, source: string): string[] | null {
  let sibling = node.previousNamedSibling;
  const comments: string[] = [];

  while (sibling && isCommentNode(sibling)) {
    comments.unshift(getNodeText(sibling, source));
    sibling = sibling.previousNamedSibling;
  }

  return comments.length > 0 ? comments : null;
}

/**
 * Climb from `node` toward the root through transparent wrapper/decorator parents, returning the outermost wrapper whose preceding comment should be  attributed to `node`.
 */
function climbToWrapperWithComment(node: SyntaxNode): SyntaxNode | null {
  let current = node;

  while (current.parent && DOCSTRING_WRAPPER_TYPES.has(current.parent.type)) {
    const parent = current.parent;

    let leading = true;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (child.id === current.id) break;
      if (
        isCommentNode(child) ||
        child.type === 'decorator' ||
        child.type === 'identifier' ||
        child.type === 'property_identifier' ||
        child.type === 'type_annotation' ||
        child.type === 'type_identifier'
      ) {
        continue;
      }
      leading = false;
      break;
    }
    if (!leading) break;

    // If the wrapper itself has a preceding comment sibling, the climb has reached the node that owns the comment.
    const prev = parent.previousNamedSibling;
    if (prev && isCommentNode(prev)) {
      return parent;
    }

    current = parent;
  }

  // No climbed wrapper had a preceding comment.
  return null;
}



/**
 * Get the docstring/comment preceding a node
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  let comments = collectPrecedingComments(node, source);

  if (comments === null) {
    // No direct preceding comment — climb through wrapper/decorator parents.
    const wrapper = climbToWrapperWithComment(node);
    if (wrapper) {
      comments = collectPrecedingComments(wrapper, source);
    }
  }

  if (comments === null || comments.length === 0) return undefined;

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
