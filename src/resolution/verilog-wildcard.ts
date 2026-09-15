import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { selectVerilogModule } from './verilog-ports';

const PREFIX = 'hdl:wildcard:';
export function isVerilogWildcardRef(ref: UnresolvedRef): boolean {
  return ref.language === 'verilog' && ref.referenceKind === 'references' && ref.referenceName.startsWith(PREFIX);
}

/** One source .* clause, with paired endpoints for only unambiguous source names.
 * This records source correspondence, not elaborated nets or signal direction. */
export function matchVerilogWildcard(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolveModule: (ref: UnresolvedRef, context: ResolutionContext) => ResolvedRef | null,
): ResolvedRef | null {
  let parts: unknown;
  try { parts = JSON.parse(ref.referenceName.slice(PREFIX.length)); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== 'string' || !parts[0]
    || typeof parts[1] !== 'string' || !parts[1] || !Array.isArray(parts[2]) || !parts[2].every(n => typeof n === 'string')) return null;
  const [moduleName, instanceId, exclusions] = parts as [string, string, string[]];
  const selected = selectVerilogModule(ref, context, resolveModule, moduleName, instanceId);
  const instance = context.getNodeById?.(instanceId);
  if (!selected || !instance) return null;
  const module = selected.module;
  const canonical = (name: string) => name.replace(/^\\/, '');
  const excluded = new Set(exclusions.map(canonical));
  const tag = module.decorators?.find(d => d.startsWith('hdl:port-order:'));
  let order: unknown;
  try { order = tag && JSON.parse(tag.slice('hdl:port-order:'.length)); } catch { order = null; }
  // Non-ANSI alias/concatenation headers and unknown macro headers do not prove
  // that an internal input declaration is an externally named formal port.
  const names: string[] = Array.isArray(order) && order.every(n => typeof n === 'string' && canonical(n))
    && new Set(order.map(canonical)).size === order.length ? order.map(canonical) : [];
  const declared = context.getNodesInFile(module.filePath).filter(n => n.language === 'verilog'
    && n.kind === 'field' && n.decorators?.includes('hdl:port')
    && n.qualifiedName === `${module.qualifiedName}::${n.name}`
    && n.startLine >= module.startLine && n.endLine <= module.endLine);
  const formals = names.flatMap(name => {
    const matches = declared.filter(n => canonical(n.name) === name);
    return matches.length === 1 ? matches : [];
  });
  const scopes = instance.qualifiedName.split('::').slice(0, -1);
  const localSignal = (name: string): Node | null => {
    for (let i = scopes.length; i > 0; i--) {
      const matches = [name, `\\${name}`].flatMap(n => context.getNodesByQualifiedName(`${scopes.slice(0, i).join('::')}::${n}`))
        .filter(n => n.language === 'verilog' && n.filePath === ref.filePath);
      if (!matches.length) continue;
      // Any nearer declaration shadows the outer scope; unsupported declarations
      // and duplicates must not silently become the outer signal.
      return matches.length === 1 && matches[0]!.kind === 'field'
        && matches[0]!.decorators?.some(d => d === 'hdl:port' || d === 'hdl:signal') ? matches[0]! : null;
    }
    return null;
  };
  const targets: { targetNodeId: string; metadata: Record<string, unknown> }[] = [];
  for (const formal of formals) {
    const name = canonical(formal.name);
    if (excluded.has(name) || formals.filter(n => canonical(n.name) === name).length !== 1) continue;
    const local = localSignal(name);
    if (!local) continue;
    const metadata = { binding: 'hdl-wildcard-port', moduleId: module.id, instanceId,
      formalNodeId: formal.id, portName: formal.name };
    targets.push({ targetNodeId: formal.id, metadata: { ...metadata, endpoint: 'formal' } },
      { targetNodeId: local.id, metadata: { ...metadata, endpoint: 'actual' } });
  }
  return { original: ref, targetNodeId: module.id, confidence: selected.confidence,
    resolvedBy: 'qualified-name', metadata: { binding: 'hdl-wildcard-dependency', endpoint: 'module', moduleId: module.id, instanceId },
    alsoTargets: targets };
}
