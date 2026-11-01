/**
 * Both extractors record `super().run()`, with or without arguments, as the name
 * `super().run`, which no other strategy reads. A call through `super()` runs
 * the first class after the caller's in its method resolution order that defines
 * the name, so that's the answer: read from the class's own bases, and never by
 * name, because a base from outside the project has no node and a project method
 * of that name is not what runs. `class Site(models.Model)`'s `super().save()`
 * stays unlinked, and is no call to whichever `save` the project has.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const SUPER_CALL = /^super\(\)\.([A-Za-z_]\w*)$/;
/** The class named by the two-argument form, `super(Child, self).run()`. */
const NAMED_CLASS = /\bsuper\s*\(\s*(?:[\w]+\.)*(\w+)\s*,/;

export function isPythonSuperCall(ref: UnresolvedRef): boolean {
  return ref.language === 'python' && ref.referenceKind === 'calls' && SUPER_CALL.test(ref.referenceName);
}

/** A class's project bases, in the order its header lists them. Stored edges carry no order. */
function basesOf(cls: Node, context: ResolutionContext): Node[] {
  const bases = (context.getSupertypeNodes?.(cls.id) ?? []).filter((n) => n.kind === 'class');
  if (bases.length < 2) return bases;
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const end = lines.slice(cls.startLine - 1, cls.endLine).findIndex((line) => /:\s*(?:#.*)?$/.test(line));
  const header = lines.slice(cls.startLine - 1, cls.startLine + Math.max(end, 0)).join(' ');
  const at = (base: Node): number => {
    const i = header.search(new RegExp(`\\b${base.name}\\b`));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...bases].sort((a, b) => at(a) - at(b));
}

/** C3, Python's linearization. Null for a hierarchy Python would refuse, or one that loops. */
function linearization(cls: Node, context: ResolutionContext, active: Set<string>): Node[] | null {
  if (active.has(cls.id)) return null;
  active.add(cls.id);
  const bases = basesOf(cls, context);
  const parents = bases.map((base) => linearization(base, context, active));
  active.delete(cls.id);
  if (parents.some((p) => p === null)) return null;

  const order = [cls];
  const pending = [...(parents as Node[][]).map((p) => [...p]), [...bases]].filter((p) => p.length > 0);
  while (pending.length > 0) {
    const next = pending.map((p) => p[0]!).find((head) => !pending.some((p) => p.slice(1).some((n) => n.id === head.id)));
    if (!next) return null;
    order.push(next);
    for (const p of pending) if (p[0]!.id === next.id) p.shift();
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.length === 0) pending.splice(i, 1);
  }
  return order;
}

/** The innermost class around a line of a file. */
function classAround(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  let found: Node | null = null;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind === 'class' && n.startLine <= ref.line && n.endLine >= ref.line && (!found || n.startLine > found.startLine)) found = n;
  }
  return found;
}

export function matchPythonSuperCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = SUPER_CALL.exec(ref.referenceName)?.[1];
  const cls = name ? classAround(ref, context) : null;
  if (!name || !cls) return null;
  // `super(Other, self)` starts somewhere else in the order, past a class that isn't the caller's.
  const line = (context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1] ?? '';
  const named = NAMED_CLASS.exec(line)?.[1];
  if (named !== undefined && named !== cls.name) return null;

  for (const base of (linearization(cls, context, new Set()) ?? []).slice(1)) {
    // The last `def` of a name in a class body is the one the name holds, below any `@overload` stubs.
    const defined = context.getNodesInFile(base.filePath)
      .filter((n) => n.kind === 'method' && n.name === name && n.qualifiedName === `${base.qualifiedName}::${name}`)
      .sort((a, b) => b.startLine - a.startLine)[0];
    if (defined) return { original: ref, targetNodeId: defined.id, confidence: 0.95, resolvedBy: 'instance-method' };
  }
  return null;
}
