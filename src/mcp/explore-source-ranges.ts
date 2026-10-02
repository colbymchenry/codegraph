import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Language, Node } from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { seedLiteralsInQuery } from '../extraction/literal-capture';
import { extractSearchTerms, isTestPath } from '../search/query-utils';

export interface RequestedSourceRange {
  start: number;
  end: number;
  name: string;
  score: number;
  nodeId?: string;
}

/** Source evidence inside an already selected file; never adds graph nodes or edges. */
export async function requestedSourceRanges(
  filePath: string, source: string, language: Language, query: string, nodes: readonly Node[] = [],
): Promise<RequestedSourceRange[]> {
  const test = isTestPath(filePath) && ['javascript', 'typescript', 'jsx', 'tsx'].includes(language);
  const vue = language === 'vue';

  // A component's name identifies its file, not every line containing "table"
  // or "board". Match the remaining question against its template and styles.
  const basename = filePath.split('/').pop()!.replace(/\.[^.]+$/, '');
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const question = query.replace(new RegExp(`\\b${escapedBasename}\\b`, 'gi'), '');
  const terms = extractSearchTerms(question);
  const literals = seedLiteralsInQuery(question);
  const identifiers = [...new Set((question.match(/[A-Za-z_$][\w$]*/g) ?? [])
    .filter(word => /[a-z][A-Z]|_/.test(word)).map(word => word.toLowerCase()))];
  if (terms.length === 0 && literals.length === 0) return [];
  const scoreCeiling = terms.length + (identifiers.length + literals.length) * (terms.length + 1) + 1;
  const score = (text: string): number => {
    const words = new Set(extractSearchTerms(text, { stems: false }));
    return terms.filter(t => words.has(t)).length
      + identifiers.filter(t => words.has(t)).length * (terms.length + 1)
      + literals.filter(l => text.includes(l)).length * (terms.length + 1);
  };
  const ranges: RequestedSourceRange[] = [];
  const declarations: RequestedSourceRange[] = [];
  const sourceLines = source.split('\n');
  if (!test) {
    for (const node of nodes) {
      if (!['function', 'method', 'constant', 'variable', 'property'].includes(node.kind)
          || node.startLine < 1 || node.endLine < node.startLine
          || node.endLine - node.startLine + 1 > sourceLines.length / 2) continue;
      const hit = score(sourceLines.slice(node.startLine - 1, node.endLine).join('\n'));
      if (hit > 0) declarations.push({
        start: node.startLine, end: node.endLine, name: node.name, score: hit, nodeId: node.id,
      });
    }
  }
  if (vue) {
    // Script definitions already have indexed ranges. Only supplement the
    // unmodelled template/style text, with bounded windows around actual hits.
    let inScript = false;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/<script(?:\s|>)/i.test(line)) inScript = true;
      if (!inScript) {
        const hit = score(line);
        if (hit > 0) ranges.push({
          start: Math.max(1, i - 3), end: Math.min(lines.length, i + 5), name: 'query match', score: hit,
        });
      }
      if (/<\/script\s*>/i.test(line)) inScript = false;
    }
    // Small style blocks are a useful unit: the selector alone does not show
    // its widths. Large blocks still use the matching-line windows above.
    for (const match of source.matchAll(/<style(?:\s[^>]*)?>[\s\S]*?<\/style\s*>/gi)) {
      const start = source.slice(0, match.index).split('\n').length;
      const end = start + match[0].split('\n').length - 1;
      const hit = score(match[0]);
      if (hit > 0 && end - start < 200) ranges.push({ start, end, name: 'style', score: hit });
    }
  } else if (test) {
    await loadGrammarsForLanguages([language]);
    const tree = getParser(language)?.parse(source);
    if (!tree) return [];
    try {
      const visit = (node: SyntaxNode): void => {
        if (node.type === 'call_expression') {
          const callee = node.childForFieldName('function')?.text ?? '';
          const args = node.childForFieldName('arguments')?.namedChildren ?? [];
          if (/^(?:it|test)(?:\.(?:only|skip|concurrent|serial|failing))*$/.test(callee)
              && args.some(a => ['arrow_function', 'function_expression'].includes(a.type))) {
            const hit = score(node.text) + score(args[0]?.text ?? '');
            if (hit > 0) {
              ranges.push({
                start: node.startPosition.row + 1, end: node.endPosition.row + 1, name: 'test', score: hit + 1,
              });
              // A long test may not fit whole. Its matching setup/assertion
              // statements remain complete units, including multiline arrays.
              const statements = (child: SyntaxNode): void => {
                if (['expression_statement', 'lexical_declaration', 'variable_declaration'].includes(child.type)) {
                  const match = score(child.text);
                  if (match > 0) ranges.push({
                    start: child.startPosition.row + 1, end: child.endPosition.row + 1,
                    name: 'test statement', score: hit + match / scoreCeiling,
                  });
                  return;
                }
                for (const nested of child.namedChildren) statements(nested);
              };
              for (const arg of args) {
                if (['arrow_function', 'function_expression'].includes(arg.type)) statements(arg);
              }
            }
            return;
          }
        }
        for (const child of node.namedChildren) visit(child);
      };
      visit(tree.rootNode);
    } finally {
      tree.delete();
    }
  }
  // Adjacent template hits describe one region; they must not consume every
  // candidate slot and exclude a later cell or style block for the same query.
  if (vue) {
    // An exact identifier/literal on a template line must not lose to a
    // larger declaration accumulating incidental prose matches across its body.
    const declarationScore = Math.max(0, ...declarations.map(r => r.score));
    for (const r of ranges) if (r.score > terms.length) r.score += declarationScore;
    const merged: RequestedSourceRange[] = [];
    for (const r of ranges.sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) {
        last.end = Math.max(last.end, r.end);
        last.score = Math.max(last.score, r.score);
      } else merged.push({ ...r });
    }
    return [...declarations, ...merged].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 12);
  }
  return [...declarations, ...ranges].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 12);
}
