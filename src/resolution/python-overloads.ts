/**
 * A Python name declared with `typing.overload` runs one function: the `def`
 * below its stubs, the one without the decorator. Every `def` is its own node,
 * so a call by name landed on the first stub, whose body is `...`: click's
 * `command` has four stubs, and its 300-odd callers all stopped at the first.
 * The implementation looked unreferenced, and a call path broke at the stub.
 *
 * A stub is resolved on to the implementation that follows it in the same scope.
 * With none below it, as in a `Protocol` or a `.pyi`, the stub is all there is
 * and stays the target. Asked at the one seam every strategy passes through, so
 * a call, an import and a name handed on as a value all agree.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef } from './types';

/** How far above a `def` its decorators are looked for; a decorator's arguments may span lines. */
const DECORATOR_LOOKBACK = 16;

/** Per context: a stub's node id → the implementation it stands for (null: it stands for none). */
const IMPLEMENTATIONS = new WeakMap<ResolutionContext, Map<string, string | null>>();

export function clearPythonOverloadMemos(context: ResolutionContext): void {
  IMPLEMENTATIONS.delete(context);
}

/**
 * Whether the decorators above a `def` hold `overload`, spelled bare or through
 * a module (`typing.overload`, `t.overload`). Decorators are not kept on Python
 * nodes, so they're read from the source, upward from the `def`.
 */
function isOverloadStub(n: Node, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
  let open = 0;
  for (let i = n.startLine - 2; i >= 0 && i >= n.startLine - 1 - DECORATOR_LOOKBACK; i--) {
    const text = lines[i]?.trim() ?? '';
    if (text.startsWith('#')) continue;
    // Each `)` opens a span upward that ends at its `(`: inside it, a decorator's arguments.
    open += (text.match(/\)/g)?.length ?? 0) - (text.match(/\(/g)?.length ?? 0);
    if (open > 0) continue;
    if (!text.startsWith('@')) return false;
    if (/^@(?:\w+\.)*overload\b/.test(text)) return true;
  }
  return false;
}

/** The `def` a stub stands for: the first below it of that scope's name that isn't a stub too. */
function implementationOf(stub: Node, context: ResolutionContext): string | null {
  const sameScope = (context.getNodesInFileNamed?.(stub.filePath, stub.name) ?? context.getNodesInFile(stub.filePath))
    .filter((n) => n.name === stub.name && n.kind === stub.kind && n.qualifiedName === stub.qualifiedName);
  // Nothing else of the name in that scope: the common case, and no source to read.
  if (sameScope.length < 2 || !isOverloadStub(stub, context)) return null;
  const below = sameScope.filter((n) => n.startLine > stub.startLine).sort((a, b) => a.startLine - b.startLine);
  return below.find((n) => !isOverloadStub(n, context))?.id ?? null;
}

/** `resolved` moved to the implementation when its `target` is an overload stub of one. */
export function preferPythonImplementation(resolved: ResolvedRef, target: Node | null | undefined, context: ResolutionContext): ResolvedRef {
  if (!target || target.language !== 'python' || (target.kind !== 'function' && target.kind !== 'method')) return resolved;
  let memo = IMPLEMENTATIONS.get(context);
  if (!memo) IMPLEMENTATIONS.set(context, (memo = new Map()));
  let implementation = memo.get(target.id);
  if (implementation === undefined) {
    implementation = implementationOf(target, context);
    memo.set(target.id, implementation);
  }
  return implementation === null ? resolved : { ...resolved, targetNodeId: implementation };
}
