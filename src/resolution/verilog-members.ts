import type { Node } from '../types';
import { resolveVerilogCallArgumentAccess } from './verilog-call-access';
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
    if (unique.length !== 1) return null;
    let metadata: Record<string, unknown> | undefined;
    if (ref.referenceKind === 'references' && ref.referenceName.startsWith('hdl:signal:')) {
      const access = [...new Set((ref.candidates ?? []).filter(c => c.startsWith('hdl:access:'))
        .map(c => c.slice('hdl:access:'.length)).filter(c => ['read', 'write', 'readwrite', 'control', 'event'].includes(c)))];
      const argument = access.length ? undefined : resolveVerilogCallArgumentAccess(ref, context, matchVerilogMember);
      if (argument) access.push(argument.access);
      const events = [...new Set((ref.candidates ?? []).filter(c => c.startsWith('hdl:event:'))
        .map(c => c.slice('hdl:event:'.length)).filter(c => ['posedge', 'negedge'].includes(c)))];
      if (access.length) metadata = { hdlAccess: access, ...(events.length ? { hdlEvent: events } : {}),
        ...(argument ? { hdlCallTargetId: argument.callableId, hdlFormalId: argument.formalId } : {}) };
    }
    return { original: ref, targetNodeId: unique[0]!.id, confidence: 0.95,
      resolvedBy: 'qualified-name', ...(metadata ? { metadata } : {}) };
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
  const hint = ref.candidates?.find(c => c.startsWith('hdl:scope:'))?.slice('hdl:scope:'.length);
  const lexical = hint && caller && context.getNodesByQualifiedName(hint).some(n =>
    n.language === 'verilog' && n.filePath === ref.filePath && n.kind === 'namespace'
    && n.qualifiedName.startsWith(`${caller.qualifiedName}::`) && n.startLine <= ref.line && n.endLine >= ref.line)
    ? hint : caller?.qualifiedName;
  const scopes = lexical?.split('::') ?? [];
  const imports = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'import' && n.startLine <= ref.line);
  // Resolve one lexical level at a time: an inner package import can shadow
  // an outer module function, just like a nearer declaration can.
  for (let i = scopes.length; i >= 0; i--) {
    const scope = scopes.slice(0, i).join('::');
    const matches = exact(scope ? `${scope}::${ref.referenceName}` : ref.referenceName, ['function', 'method'])
      .filter(n => n.filePath === ref.filePath);
    if (matches.length) return result(matches);
    const imported: Node[] = [];
    for (const item of imports) {
      if (item.qualifiedName.split('::').slice(0, -1).join('::') !== scope) continue;
      const match = item.signature?.trim().match(/^([\w$]+)::([\w$]+|\*)$/);
      if (match && (match[2] === '*' || match[2] === ref.referenceName)) {
        imported.push(...exact(`${match[1]}::${ref.referenceName}`, ['function', 'method']));
      }
    }
    if (imported.length) return result(imported);
  }
  return null;
}
