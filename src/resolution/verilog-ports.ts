import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const PREFIX = 'hdl:port:';

export function isVerilogPortRef(ref: UnresolvedRef): boolean {
  return ref.language === 'verilog' && ref.referenceKind === 'references' && ref.referenceName.startsWith(PREFIX);
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
  let parts: unknown;
  try { parts = JSON.parse(ref.referenceName.slice(PREFIX.length)); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(p => typeof p === 'string' && p.length > 0)) return null;
  const [moduleName, portName, instanceId] = parts as [string, string, string];
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
  const ports = context.getNodesByQualifiedName(`${module.qualifiedName}::${portName}`)
    .filter(n => n.language === 'verilog' && n.filePath === module.filePath && n.kind === 'field'
      && n.decorators?.includes('hdl:port') && n.startLine >= module.startLine && n.endLine <= module.endLine);
  if (ports.length !== 1) return null;
  return { original: ref, targetNodeId: ports[0]!.id, confidence: selected!.confidence,
    resolvedBy: 'qualified-name', metadata: { binding: 'hdl-named-port', moduleId: module.id, instanceId } };
}
