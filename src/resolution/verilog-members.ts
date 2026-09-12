import type { Node } from '../types';
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';

export function isVerilogMemberRef(ref: UnresolvedRef): boolean {
  return ref.language === 'verilog' && (ref.referenceKind === 'calls' || ref.referenceKind === 'type_of' ||
    (ref.referenceKind === 'references' && (ref.referenceName.includes('::') || ref.referenceName.startsWith('hdl:signal:'))));
}

/** Resolve only explicit HDL identity or visible lexical/import scope, never a trailing-name guess. */
export function matchVerilogMember(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const exact = (name: string, kinds: Node['kind'][]) => context.getNodesByQualifiedName(name)
    .filter(n => n.language === 'verilog' && kinds.includes(n.kind));
  const result = (nodes: Node[]): ResolvedRef | null => {
    const unique = [...new Map(nodes.map(n => [n.id, n])).values()];
    return unique.length === 1 ? { original: ref, targetNodeId: unique[0]!.id,
      confidence: 0.95, resolvedBy: 'qualified-name' } : null;
  };
  if (ref.referenceKind === 'references' && ref.referenceName.startsWith('hdl:signal:')) {
    const name = ref.referenceName.slice('hdl:signal:'.length);
    const caller = context.getNodeById?.(ref.fromNodeId);
    const scopes = caller?.qualifiedName.split('::') ?? [];
    for (let i = scopes.length; i > 0; i--) {
      const matches = exact(`${scopes.slice(0, i).join('::')}::${name}`, ['field', 'variable', 'constant'])
        .filter(n => n.filePath === ref.filePath);
      if (matches.length) return result(matches);
    }
    return null;
  }
  if (ref.referenceKind === 'references') return result(exact(ref.referenceName, ['field', 'variable', 'constant'])
    .filter(n => n.filePath === ref.filePath));
  if (ref.referenceKind === 'type_of') return result(exact(ref.referenceName.replace(/\./g, '::'), ['interface', 'class', 'type_alias']));
  if (ref.referenceName.includes('::')) return result(exact(ref.referenceName, ['function', 'method']));
  // Hierarchical instance calls require elaborated receiver identity, which this pass does not infer.
  if (ref.referenceName.includes('.')) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const scopes = caller?.qualifiedName.split('::') ?? [];
  for (let i = scopes.length; i > 0; i--) {
    const matches = exact(`${scopes.slice(0, i).join('::')}::${ref.referenceName}`, ['function', 'method'])
      .filter(n => n.filePath === ref.filePath);
    if (matches.length) return result(matches);
  }
  const imported: Node[] = [];
  for (const item of context.getNodesInFile(ref.filePath)) {
    if (item.kind !== 'import' || item.startLine > ref.line) continue;
    const prefix = item.qualifiedName.split('::').slice(0, -1).join('::');
    if (prefix && !caller?.qualifiedName.startsWith(`${prefix}::`)) continue;
    const match = item.signature?.trim().match(/^([\w$]+)::([\w$]+|\*)$/);
    if (match && (match[2] === '*' || match[2] === ref.referenceName)) {
      imported.push(...exact(`${match[1]}::${ref.referenceName}`, ['function', 'method']));
    }
  }
  if (imported.length) return result(imported);
  return result(exact(ref.referenceName, ['function', 'method']).filter(n => n.filePath === ref.filePath));
}
