import { ResolutionContext } from '../../types';

export function lastFqcnSegment(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '').trim();
  const parts = clean.split('\\');
  return parts[parts.length - 1] ?? clean;
}

export function parseControllerServiceRef(expr: string): { class: string; method: string } | null {
  const clean = expr.trim().replace(/^['"]|['"]$/g, '');
  const match = clean.match(/^([A-Za-z_\\][\w\\]*):{1,2}(\w+)$/);
  if (match) {
    return { class: match[1]!, method: match[2]! };
  }
  // Bare FQCN — single-action controller (__invoke)
  if (clean.includes('\\') && /[A-Z]/.test(clean)) {
    return { class: clean, method: '__invoke' };
  }
  return null;
}

export function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  const shortName = lastFqcnSegment(controller);

  const allClasses = context.getNodesByKind('class');
  for (const cls of allClasses) {
    if (cls.name === shortName) {
      const nodesInFile = context.getNodesInFile(cls.filePath);
      const methodNode = nodesInFile.find(n => n.kind === 'method' && n.name === method);
      if (methodNode) return methodNode.id;
    }
  }

  return null;
}
