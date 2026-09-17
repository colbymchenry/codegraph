import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';

export function extractEventSubscribers(content: string, filePath: string, now: number): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const subPattern = /(?:class\s+(\w+)\s+implements\s+(?:.*,\s*)?EventSubscriberInterface)/g;
  let match: RegExpExecArray | null;
  while ((match = subPattern.exec(content)) !== null) {
    const className = match[1]!;
    const line = content.slice(0, match.index).split('\n').length;
    nodes.push({
      id: `event_subscriber:${filePath}:${line}:${className}`,
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
