import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';

export function extractConsoleCommands(content: string, filePath: string, now: number): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const cmdPattern = /#\[\s*AsCommand\s*\([^)]*\)\s*\](?:\s*\n\s*)*\b(?:final\s+)?(?:class\s+(\w+)\s+extends\s+(?:Command|AbstractCommand|ContainerAwareCommand))/g;
  let match: RegExpExecArray | null;
  while ((match = cmdPattern.exec(content)) !== null) {
    const className = match[1]!;
    const line = content.slice(0, match.index).split('\n').length;
    nodes.push({
      id: `console_command:${filePath}:${line}:${className}`,
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
