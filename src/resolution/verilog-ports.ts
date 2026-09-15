import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const PREFIX = 'hdl:port:';
const POSITION_PREFIX = 'hdl:port-position:';

export function isVerilogPortRef(ref: UnresolvedRef): boolean {
  return ref.language === 'verilog' && ref.referenceKind === 'references' && (ref.referenceName.startsWith(PREFIX) || ref.referenceName.startsWith(POSITION_PREFIX));
}

/** Bind a named source connection to the selected module's own declared port.
 * Reuse the instantiation matcher so simulation-file selection cannot diverge.
 * This is source correspondence, not an elaborated net or drive-direction edge.
 */
export function matchVerilogPort(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolveModule: (ref: UnresolvedRef, context: ResolutionContext) => ResolvedRef | null,
): ResolvedRef | null {
  const positional = ref.referenceName.startsWith(POSITION_PREFIX);
  let parts: unknown;
  try { parts = JSON.parse(ref.referenceName.slice(positional ? POSITION_PREFIX.length : PREFIX.length)); } catch { return null; }
  if (!Array.isArray(parts)) return null;
  let moduleName: string, instanceId: string, portName: string;
  let position = -1, count = -1;
  if (positional) {
    if (parts.length !== 4 || typeof parts[0] !== 'string' || !parts[0] || typeof parts[3] !== 'string' || !parts[3]
      || !Number.isSafeInteger(parts[1]) || !Number.isSafeInteger(parts[2]) || parts[1] < 0 || parts[2] <= parts[1]) return null;
    [moduleName, position, count, instanceId] = parts as [string, number, number, string];
    portName = '';
  } else {
    if (parts.length !== 3 || !parts.every(p => typeof p === 'string' && p.length > 0)) return null;
    [moduleName, portName, instanceId] = parts as [string, string, string];
  }
  const selected = selectVerilogModule(ref, context, resolveModule, moduleName, instanceId);
  if (!selected) return null;
  const module = selected.module;
  if (positional) {
    const tag = module.decorators?.find(d => d.startsWith('hdl:port-order:'));
    let order: unknown;
    try { order = tag && JSON.parse(tag.slice('hdl:port-order:'.length)); } catch { return null; }
    if (!Array.isArray(order) || !order.every(n => typeof n === 'string') || count > order.length
      || new Set(order.map(n => n.replace(/^\\/, ''))).size !== order.length) return null;
    portName = order[position]!;
  }
  const canonicalPort = portName.replace(/^\\/, '');
  const names = [canonicalPort, `\\${canonicalPort}`];
  const ports = names.flatMap(name => context.getNodesByQualifiedName(`${module.qualifiedName}::${name}`))
    .filter(n => n.language === 'verilog' && n.filePath === module.filePath && n.kind === 'field'
      && n.decorators?.includes('hdl:port') && n.startLine >= module.startLine && n.endLine <= module.endLine);
  if (ports.length !== 1) return null;
  return { original: ref, targetNodeId: ports[0]!.id, confidence: selected!.confidence,
    resolvedBy: 'qualified-name', ...(positional ? { alsoTargets: [{ targetNodeId: module.id, metadata: { binding: 'hdl-positional-dependency', endpoint: 'module' } }] } : {}),
    metadata: { binding: positional ? 'hdl-positional-port' : 'hdl-named-port', moduleId: module.id, instanceId, ...(positional ? { position, moduleName } : {}) } };
}

/** Shared selection for named, positional and wildcard source bindings. */
export function selectVerilogModule(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolveModule: (ref: UnresolvedRef, context: ResolutionContext) => ResolvedRef | null,
  moduleName: string,
  instanceId: string,
): { module: Node; confidence: number } | null {
  const instance = context.getNodeById?.(instanceId);
  if (!instance || instance.language !== 'verilog' || instance.kind !== 'variable' || instance.filePath !== ref.filePath) return null;
  const selected = resolveModule({ ...ref, fromNodeId: instance.id, referenceName: moduleName,
    referenceKind: 'instantiates', line: instance.startLine, column: instance.startColumn }, context);
  const module = selected && context.getNodeById?.(selected.targetNodeId);
  if (!module || module.name !== moduleName || module.language !== 'verilog'
    || !['class', 'interface'].includes(module.kind)) return null;
  let candidates = context.getNodesByName(moduleName)
    .filter(n => n.language === 'verilog' && ['class', 'interface'].includes(n.kind));
  const simulation = (file: string) => /(^|\/)(sim|tb|tests?|testbench|dv)\//i.test(file)
    || /_(stub|tb|sim)\.s?vh?$/i.test(file);
  if (!simulation(ref.filePath)) {
    const synthesis = candidates.filter(n => !simulation(n.filePath));
    if (synthesis.length) candidates = synthesis;
  }
  // The module matcher may choose the first equal candidate. Port correspondence
  // is stricter: a tie in source-file/directory proximity stays unresolved.
  const dirs = ref.filePath.split('/').slice(0, -1);
  const score = (file: string): number => {
    const other = file.split('/').slice(0, -1);
    let shared = 0;
    while (shared < Math.min(dirs.length, other.length) && dirs[shared] === other[shared]) shared++;
    return (file === ref.filePath ? 100 : 0) + Math.min(shared * 15, 80);
  };
  if (candidates.some(n => n.id !== module.id && score(n.filePath) >= score(module.filePath))) return null;
  if (context.getNodesByQualifiedName(module.qualifiedName).filter(n => n.filePath === module.filePath
    && n.language === 'verilog' && ['class', 'interface'].includes(n.kind)).length !== 1) return null;
  return { module, confidence: selected!.confidence };
}
