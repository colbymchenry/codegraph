import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';

export function extractDoctrineEntities(content: string, filePath: string, now: number): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const entityAttr = /#\[\s*(?:ORM\\)?Entity\s*(?:\([^)]*\))?\s*\](?:\s*\n\s*)*\b(?:final\s+)?(?:readonly\s+)?(?:class\s+(\w+))/g;
  let match: RegExpExecArray | null;
  while ((match = entityAttr.exec(content)) !== null) {
    const className = match[1]!;
    const line = content.slice(0, match.index).split('\n').length;
    nodes.push({
      id: `entity:${filePath}:${line}:${className}`,
      kind: 'class',
      name: className,
      qualifiedName: `${filePath}::${className}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      language: 'php',
      updatedAt: now,
    });
  }
  return { nodes, references };
}

export function extractDoctrineRepositories(content: string, filePath: string, now: number): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const repoPattern = /(?:class\s+(\w+)\s+extends\s+(?:ServiceEntityRepository|EntityRepository))/g;
  let match: RegExpExecArray | null;
  while ((match = repoPattern.exec(content)) !== null) {
    const className = match[1]!;
    const line = content.slice(0, match.index).split('\n').length;
    nodes.push({
      id: `repository:${filePath}:${line}:${className}`,
      kind: 'class',
      name: className,
      qualifiedName: `${filePath}::${className}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      language: 'php',
      updatedAt: now,
    });
  }
  return { nodes, references };
}
