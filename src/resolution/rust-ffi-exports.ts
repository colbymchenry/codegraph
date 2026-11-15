/**
 * Rust C-ABI exports as the source declares them: an `extern "C"` (or
 * `"C-unwind"`, or bare `extern`) function under `#[no_mangle]` or
 * `#[export_name = "…"]`, either possibly in `unsafe(…)` or in
 * `cfg_attr(condition, …)`. A symbol a macro or build script generates is not
 * seen. The walk is iterative, so no nesting depth can exhaust the stack.
 */
import type { Parser } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { mirrorTree, type SyntaxMirror as SyntaxNode } from './syntax-mirror';

export interface RustFfiExport {
  symbolName: string;
  /** `${filePath}:${startIndex}` of the exporting function. */
  functionId: string;
  filePath: string;
  /** The function's own name, line (1-based) and column, as the extractor records them. */
  name: string;
  line: number;
  column: number;
}

/** A Rust string literal's value, or undefined for one this decoder doesn't read. */
export function rustStringLiteral(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'raw_string_literal') return /^r(#+)?"([\s\S]*)"\1$/.exec(node.text)?.[2];
  if (node.type !== 'string_literal') return undefined;
  try { return JSON.parse(node.text) as string; } catch { return undefined; }
}

/** Whether `fn` has the C ABI: `extern "C"`, `extern "C-unwind"` or a bare `extern`. */
export function hasCAbi(fn: SyntaxNode): boolean {
  const modifiers = fn.namedChildren.find(n => n.type === 'function_modifiers');
  const abi = modifiers?.namedChildren.find(n => n.type === 'extern_modifier');
  if (!abi) return false;
  const name = abi.namedChildren.find(n => n.type === 'string_literal');
  return !name || ['C', 'C-unwind'].includes(rustStringLiteral(name) ?? '');
}

/** The outer attributes written before `node`, comments between them skipped. */
export function attributesBefore(node: SyntaxNode): string[] {
  const attributes: string[] = [];
  for (let previous = node.previousNamedSibling; previous && (previous.type === 'attribute_item' || previous.type.endsWith('comment'));
    previous = previous.previousNamedSibling) {
    if (previous.type === 'attribute_item') attributes.push(previous.text);
  }
  return attributes;
}

/**
 * The symbol an exported function links as: `#[export_name = "…"]`, else its
 * own name under `#[no_mangle]`; either may sit in `unsafe(…)` or in
 * `cfg_attr(condition, …)`, which applies it in the builds the condition selects.
 */
export function exportedSymbol(attributes: string[], name: string): string | undefined {
  const applied = attributes.map(attribute => {
    const inner = /^#\[\s*([\s\S]*?)\s*\]$/.exec(attribute)?.[1] ?? '';
    const conditional = /^cfg_attr\s*\([\s\S]*,\s*([\s\S]*?)\s*\)$/.exec(inner)?.[1] ?? inner;
    return /^unsafe\s*\(\s*([\s\S]*?)\s*\)$/.exec(conditional)?.[1] ?? conditional;
  });
  for (const attribute of applied) {
    const exported = /^export_name\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(attribute)?.[1];
    if (exported) { try { return JSON.parse(exported) as string; } catch { return undefined; } }
  }
  // A raw identifier links as its name without `r#`.
  return applied.includes('no_mangle') ? name.replace(/^r#/, '') : undefined;
}

/** The export `fn` declares, if it declares one. */
export function exportOf(fn: SyntaxNode, filePath: string): RustFfiExport | undefined {
  const name = fn.childForFieldName('name')?.text;
  if (!name || fn.hasError || !fn.childForFieldName('body') || !hasCAbi(fn)) return undefined;
  const symbolName = exportedSymbol(attributesBefore(fn), name);
  if (!symbolName) return undefined;
  const { row, column } = fn.startPosition;
  return { symbolName, functionId: `${filePath}:${fn.startIndex}`, filePath, name, line: row + 1, column };
}

/** Every export a file declares. A parse cut short by its budget is partial, and nothing is stored of it. */
export async function findRustExports(filePath: string, source: string): Promise<{ exports: RustFfiExport[]; partial?: true }> {
  await loadGrammarsForLanguages(['rust']);
  const parser: Parser | null = getParser('rust');
  const tree = parser ? parseWithinBudget(parser, source) : null;
  if (!tree) return { exports: [], partial: true };
  let root: SyntaxNode;
  try { root = mirrorTree(tree, source); } finally { tree.delete(); }
  const exports: RustFfiExport[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'function_item') {
      const exported = exportOf(node, filePath);
      if (exported) exports.push(exported);
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) pending.push(node.namedChildren[i]!);
  }
  return { exports };
}
