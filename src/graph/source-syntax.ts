import type { Node as TreeNode } from 'web-tree-sitter';
import type { Language } from '../types';
import { getParser } from '../extraction/grammars';

export type SyntaxNode = TreeNode;

export function visitSyntax(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    visit(current);
    for (let i = current.namedChildCount - 1; i >= 0; i--) pending.push(current.namedChild(i)!);
  }
}

/** The callback cannot retain nodes after the tree is released. */
export function withSourceTree<T>(source: string, language: Language, read: (root: SyntaxNode) => T): T | null {
  const parser = getParser(language);
  if (!parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null;
  try { return read(tree.rootNode); }
  finally { tree.delete(); }
}

export function literalValue(node: SyntaxNode | null): string | null {
  if (!node || !['string', 'string_literal', 'interpreted_string_literal', 'raw_string_literal'].includes(node.type)) return null;
  const text = node.text;
  if (/^r#*"/.test(text)) return text.replace(/^r#*"/, '').replace(/"#*$/, '');
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  if (text.startsWith('"')) {
    try { return JSON.parse(text) as string; } catch { return null; }
  }
  if (text.startsWith("'") && text.endsWith("'") && !text.slice(1, -1).includes('\\')) return text.slice(1, -1);
  return null;
}

export function attributesBefore(node: SyntaxNode): string {
  const attributes: string[] = [];
  for (let previous = node.previousNamedSibling; previous; previous = previous.previousNamedSibling) {
    if (previous.type.includes('comment')) continue;
    if (previous.type !== 'attribute_item') break;
    attributes.unshift(previous.text);
  }
  return attributes.join('\n');
}
