import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';

export function extractTwigReferences(content: string, filePath: string, _now: number): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const twigRegex = /\$this->render(?:View)?\s*\(\s*['"]([^'"]+\.twig)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = twigRegex.exec(content)) !== null) {
    const template = match[1]!;
    const line = content.slice(0, match.index).split('\n').length;
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: template,
      referenceKind: 'references',
      line,
      column: match[0].indexOf(template),
      filePath,
      language: 'php',
    });
  }
  return { nodes, references };
}
