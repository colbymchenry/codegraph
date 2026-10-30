import { Node } from '../../../types';
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

/**
 * The classes a controller reference names, looked up by short name through
 * the name index — one query per reference, not a scan of every class. A
 * written FQCN names only the class in that namespace: another namespace's
 * class of the same short name is not it, so none is better than a wrong one.
 */
export function findControllerClasses(controller: string, context: ResolutionContext): Node[] {
  const fqcn = controller.replace(/^\\+/, '');
  const classes = context.getNodesByName(lastFqcnSegment(fqcn)).filter((n) => n.kind === 'class');
  if (!fqcn.includes('\\')) return classes;
  return classes.filter((n) => `\\${n.qualifiedName.replace(/::/g, '\\')}`.endsWith(`\\${fqcn}`));
}

export function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  for (const cls of findControllerClasses(controller, context)) {
    const named = context.getNodesInFileNamed?.(cls.filePath, method)
      ?? context.getNodesInFile(cls.filePath).filter((n) => n.name === method);
    const found = named.find(
      (n) => n.kind === 'method' && n.startLine >= cls.startLine && n.startLine <= cls.endLine
    );
    if (found) return found.id;
  }
  return null;
}
