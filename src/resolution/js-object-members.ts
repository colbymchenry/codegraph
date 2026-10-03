import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef, ResolvedRef } from './types';
import { resolveObjectLiteralMember, resolveObjectLiteralBinding } from './name-matcher';

export const JS_OBJECT_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro']);

function contains(scope: [number, number, number, number], ref: UnresolvedRef): boolean {
  const [sl, sc, el, ec] = scope;
  return (ref.line > sl || (ref.line === sl && ref.column >= sc)) &&
    (ref.line < el || (ref.line === el && ref.column < ec));
}

/**
 * Resolve only AST-derived qualified candidates; an owned missing member closes fallback.
 * `resolveBare` resolves a bare member name the ordinary way (the `window` escape below).
 */
export function resolveJsObjectCall(
  ref: UnresolvedRef,
  context: ResolutionContext,
  resolveBare?: (name: string) => ResolvedRef | null,
): ResolvedRef | null | undefined {
  if (!JS_OBJECT_LANGUAGES.has(ref.language) || ref.referenceKind !== 'calls' || ref.candidates === undefined) return undefined;
  const dot = ref.referenceName.lastIndexOf('.');
  if (dot < 0) {
    if (ref.candidates.length === 0) return null; // an AST-proven parameter is an opaque callable value.
    // A named function expression keeps its lexical self-name even when the property is renamed.
    const self = ref.candidates.flatMap(candidate => context.getNodesByQualifiedName(candidate)).filter(node =>
      context.getJsObjectInfo?.(node.id)?.ownerId && node.filePath === ref.filePath &&
      (ref.line > node.startLine || (ref.line === node.startLine && ref.column >= node.startColumn)) &&
      (ref.line < node.endLine || (ref.line === node.endLine && ref.column < node.endColumn)));
    return self.length === 1 ? { original: ref, targetNodeId: self[0]!.id, confidence: 0.95, resolvedBy: 'qualified-name' } : undefined;
  }
  if (ref.candidates.length === 0) return undefined;
  const receiver = ref.referenceName.slice(0, dot);
  const member = ref.referenceName.slice(dot + 1);
  const holders: Array<{ node: Node; scope: [number, number, number, number] }> = [];
  for (const candidate of ref.candidates) {
    if (!candidate.endsWith(`::${member}`)) continue;
    const name = candidate.slice(0, -member.length - 2);
    for (const node of context.getNodesByQualifiedName(name)) {
      const info = context.getJsObjectInfo?.(node.id);
      if (!info || info.ownerId || info.path !== receiver) continue;
      if (!info.binding.startsWith('global:') && (node.filePath !== ref.filePath || !contains(info.scope, ref))) continue;
      holders.push({ node, scope: info.scope });
    }
  }
  if (!holders.length) {
    // A proven host-global path names only its own namespace, never a class/free leaf decoy.
    if (/^(?:window|globalThis|self)\./.test(receiver) && ref.candidates.includes(`${receiver}::${member}`)) {
      const root = receiver.split('.')[0]!;
      const lexicalRoot = context.getNodesByQualifiedName(root).some(node => {
        const info = context.getJsObjectInfo?.(node.id);
        return node.filePath === ref.filePath && info?.path === root && !info.binding.startsWith('global:') && contains(info.scope, ref);
      });
      if (!lexicalRoot) {
        // No `window.X = {…}` is indexed. `window` stays the project-global
        // escape (#1707): a UMD or `root.X = api` namespace still reaches its
        // free function by name, never a class method that shares it.
        if (!receiver.startsWith('window.') || !resolveBare) return null;
        const bare = resolveBare(member);
        return bare && context.getNodeById?.(bare.targetNodeId)?.kind === 'function' ? { ...bare, original: ref } : null;
      }
    }
    return undefined; // typed/imported receivers keep their own resolution strategies.
  }
  // Nested lexical scopes win before asking whether the selected value has this member.
  const lexical = holders.filter(entry => !context.getJsObjectInfo?.(entry.node.id)?.binding.startsWith('global:'));
  if (lexical.length === 0 && holders.length !== 1) return null;
  const pool = lexical.length ? lexical : holders;
  pool.sort((a, b) => b.scope[0] - a.scope[0] || b.scope[1] - a.scope[1] || a.scope[2] - b.scope[2] || a.scope[3] - b.scope[3]);
  const selected = pool[0]!;
  const nearest = pool.filter(entry => entry.scope.every((value, i) => value === selected.scope[i]));
  if (nearest.length !== 1) return null; // competing assignments do not prove which runtime object won.
  return resolveObjectLiteralMember(selected.node, member, ref, context, 0.95, 'instance-method') ??
    resolveObjectLiteralBinding(selected.node, member, ref, context);
}
