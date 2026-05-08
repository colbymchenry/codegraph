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
 * Get the docstring/comment preceding a node
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
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
