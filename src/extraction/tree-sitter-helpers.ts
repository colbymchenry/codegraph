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
 * Strip generic/template type arguments from a type reference name.
 *
 * A supertype written as `Base<T>` (or nested `Base<Map<K, V>>`) is captured by
 * tree-sitter as a `generic_type`/`template_type` node whose text includes the
 * angle-bracket suffix. Class nodes are indexed under their argument-free name
 * (`Base`), so without stripping, an `extends Base<T>` reference resolves to
 * nothing and the inheritance edge is silently dropped.
 *
 * Only the first `<` matters: no Java/C#/Kotlin/Scala/C++ type identifier
 * contains `<` except as the generic-argument delimiter, so slicing there is
 * safe even for nested generics. Qualified prefixes (`com.foo.Base`, `ns::Base`)
 * are intentionally preserved — resolution uses them to disambiguate same-named
 * types across packages/namespaces. The `> 0` guard leaves synthetic names that
 * legitimately start with `<` (e.g. anonymous-class markers) untouched.
 */
export function stripTypeArguments(name: string): string {
  const lt = name.indexOf('<');
  return (lt > 0 ? name.slice(0, lt) : name).trim();
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
