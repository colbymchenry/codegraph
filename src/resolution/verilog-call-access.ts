import { VERILOG_CALL_ARGUMENT_PREFIX, type VerilogCallArgument } from '../extraction/languages/verilog-call-access';
import type { UnresolvedRef, ResolutionContext, ResolvedRef } from './types';

export interface VerilogCallAccess {
  access: 'read' | 'write' | 'readwrite';
  callableId: string;
  formalId: string;
}

/** Classify a call actual only after a precise callable and complete formal list are known. */
export function resolveVerilogCallArgumentAccess(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolveCallable: (ref: UnresolvedRef, context: ResolutionContext) => ResolvedRef | null,
): VerilogCallAccess | undefined {
  const token = ref.candidates?.find(c => c.startsWith(VERILOG_CALL_ARGUMENT_PREFIX));
  if (!token) return undefined;
  let info: VerilogCallArgument;
  try { info = JSON.parse(token.slice(VERILOG_CALL_ARGUMENT_PREFIX.length)); } catch { return undefined; }
  if (!info || typeof info.callee !== 'string' || typeof info.scope !== 'string' || typeof info.callableId !== 'string'
    || !Array.isArray(info.slots) || !['value', 'index'].includes(info.role) || typeof info.writeTarget !== 'boolean'
    || typeof info.referenceTarget !== 'boolean') return undefined;
  const caller = context.getNodeById?.(info.callableId);
  if (!caller || caller.filePath !== ref.filePath || caller.language !== 'verilog') return undefined;
  const target = resolveCallable({ ...ref, fromNodeId: caller.id, referenceName: info.callee,
    referenceKind: 'calls', candidates: [`hdl:scope:${info.scope}`] }, context);
  const callable = target && context.getNodeById?.(target.targetNodeId);
  if (!callable || callable.language !== 'verilog' || !['function', 'method'].includes(callable.kind)) return undefined;
  const formals = context.getNodesInFile(callable.filePath).filter(n => n.decorators?.includes('hdl:formal')
    && n.qualifiedName === `${callable.qualifiedName}::${n.name}` && n.startLine >= callable.startLine && n.endLine <= callable.endLine);
  const indexed = formals.map(node => ({node, index: Number(node.decorators?.find(d => d.startsWith('hdl:formal-index:'))?.slice('hdl:formal-index:'.length))})).sort((a,b) => a.index-b.index);
  if (!indexed.length || indexed.some((f,i) => f.index !== i)) return undefined;
  const canonical = (name: string) => name.replace(/^\\/, '');
  if (new Set(indexed.map(f => canonical(f.node.name))).size !== indexed.length) return undefined;
  const assigned = new Set<number>();
  let selected: typeof indexed[number] | undefined;
  for (const slot of info.slots) {
    if (!slot || typeof slot.omitted !== 'boolean') return undefined;
    const formal = typeof slot.key === 'number' && Number.isSafeInteger(slot.key) ? indexed[slot.key]
      : typeof slot.key === 'string' ? indexed.find(f => canonical(f.node.name) === canonical(slot.key as string)) : undefined;
    if (!formal || assigned.has(formal.index)) return undefined;
    assigned.add(formal.index);
    if (slot.omitted && !formal.node.decorators?.includes('hdl:default')) return undefined;
    if (slot.key === info.argument && !slot.omitted) selected = formal;
  }
  if (!selected || indexed.some(f => !assigned.has(f.index) && !f.node.decorators?.includes('hdl:default'))) return undefined;
  const direction = selected.node.decorators?.find(d => d.startsWith('hdl:direction:'))?.slice('hdl:direction:'.length);
  let access: VerilogCallAccess['access'];
  if (info.role === 'index' || direction === 'input' || direction === 'const-ref') access = 'read';
  else if (!info.writeTarget) return undefined;
  else if (direction === 'output') access = 'write';
  else if (direction === 'inout' || (direction === 'ref' && info.referenceTarget)) access = 'readwrite';
  else return undefined;
  return {access, callableId: callable.id, formalId: selected.node.id};
}
