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
 * Node types that *wrap* a declaration so a leading comment is a sibling of the
 * wrapper, not of the emitted (inner) declaration node. CodeGraph emits the
 * inner node, so before looking for its preceding comment we climb out through
 * these. Examples: `export class X {}` (export_statement), `@dec\ndef f()`
 * (decorated_definition), `const f = () => {}` (lexical_declaration →
 * variable_declarator). Each wraps exactly one declaration, so climbing can't
 * mis-attribute a comment to a sibling. (#780)
 */
const DOCSTRING_WRAPPER_TYPES = new Set([
  'export_statement', // JS/TS: export class/function/const ...
  'decorated_definition', // Python: @decorator over def/class
  'lexical_declaration', // JS/TS: const/let x = () => {}
  'variable_declaration', // JS/TS: var x = ...
  'variable_declarator', // JS/TS: the `x = () => {}` inside the declaration
  'ambient_declaration', // TS: declare ...
]);

/**
 * Strip comment-syntax markers from a raw comment so the stored docstring is
 * just the prose. Covers the marker styles across every supported language:
 * C-family line and block comments and their doc variants, Rust/Swift/Kotlin
 * triple-slash and bang doc lines, hash lines (Python/Ruby/shell), Lua/Luau
 * line and long-bracket comments, and Pascal brace and paren-star comments.
 * (#780)
 *
 * Paired block delimiters are stripped only when the comment OPENS with one,
 * so a line comment that merely happens to END with a closing delimiter is
 * never truncated. The per-line markers are anchored at line start, so
 * they're safe to apply to any comment.
 */
function cleanCommentMarkers(comment: string): string {
  let c = comment.trim();
  if (c.startsWith('/*')) c = c.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '');
  else if (c.startsWith('--[')) c = c.replace(/^--\[=*\[/, '').replace(/\]=*\]$/, '');
  else if (c.startsWith('(*')) c = c.replace(/^\(\*/, '').replace(/\*\)$/, '');
  else if (c.startsWith('{')) c = c.replace(/^\{/, '').replace(/\}$/, '');
  return c
    .replace(/^\/\/[/!]?\s?/gm, '') // // , and Rust/Swift doc lines /// //!
    .replace(/^--\s?/gm, '') //        Lua/Luau line comments
    .replace(/^#\s?/gm, '') //         Python/Ruby/shell line comments
    .replace(/^\s*\*\s?/gm, '') //     block-comment continuation (* foo)
    .trim();
}

/**
 * Get the docstring/comment preceding a node
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  // Climb out of any wrapper(s) so a comment preceding the WHOLE construct
  // (export-, decorator-, or const-arrow-wrapped) is reachable as a sibling.
  // The emitted node's own `previousNamedSibling` is empty (export/const) or a
  // decorator (Python) in those cases, so without this the docstring was
  // dropped. (#780)
  let anchor = node;
  while (anchor.parent && DOCSTRING_WRAPPER_TYPES.has(anchor.parent.type)) {
    anchor = anchor.parent;
  }

  let sibling = anchor.previousNamedSibling;
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

  // Strip each comment's syntax markers (language-aware), then join.
  return comments.map(cleanCommentMarkers).join('\n').trim();
}
