/**
 * Python's `typing.overload` (#2963). A name declared with overloads is a run
 * of `def`s of one name in one scope: `@overload` stubs, whose bodies are
 * `...` and never run, and below them the `def` without the decorator, which
 * every call runs. Each `def` is its own node, so a reference resolved by name
 * landed on the first stub: click's `command` has four stubs above it, and its
 * callers all stopped there, while the implementation, whose body holds the
 * real callees, looked unreferenced.
 *
 * A resolved reference whose target is a stub moves to the implementation
 * below it, at the one place every strategy's answer passes through, so a
 * call, an import and a function handed on as a value agree. A stub with no
 * implementation below it (a `Protocol`, a `.pyi` stub file) stays the target.
 *
 * Python nodes keep no decorators, so they are read from the lines above each
 * `def`. Only typing's `overload` declares stubs: plum's or multipledispatch's
 * overloads are real implementations, which the decorator dispatches between.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef } from './types';

/** Per context: a def's id → the id of the def a call to it runs, or null when that is the def itself. */
const RUNS_INSTEAD = new WeakMap<ResolutionContext, Map<string, string | null>>();

export function clearPythonOverloadMemos(context: ResolutionContext): void {
  RUNS_INSTEAD.delete(context);
}

/** The modules whose `overload` marks a stub. */
const TYPING = new Set(['typing', 'typing_extensions']);

/** How many lines above a `def` its decorators may reach (a decorator's arguments can span lines). */
const DECORATOR_REACH = 24;

/**
 * `resolved`, moved to the implementation when its target is a Python
 * `@overload` stub that has one below it in its scope.
 */
export function preferPythonImplementation(
  resolved: ResolvedRef | null,
  ref: { language: string },
  context: ResolutionContext,
): ResolvedRef | null {
  if (!resolved || ref.language !== 'python') return resolved;
  let memo = RUNS_INSTEAD.get(context);
  if (!memo) RUNS_INSTEAD.set(context, (memo = new Map()));
  let runs = memo.get(resolved.targetNodeId);
  if (runs === undefined) {
    const target = context.getNodeById?.(resolved.targetNodeId) ?? null;
    runs = target ? implementationOf(target, context) : null;
    memo.set(resolved.targetNodeId, runs);
  }
  return runs === null ? resolved : { ...resolved, targetNodeId: runs };
}

/** The implementation a stub stands for: the first `def` of its scope and name below it that is no stub. */
function implementationOf(def: Node, context: ResolutionContext): string | null {
  if (def.language !== 'python' || (def.kind !== 'function' && def.kind !== 'method')) return null;
  const named = context.getNodesInFileNamed?.(def.filePath, def.name) ??
    context.getNodesInFile(def.filePath).filter((n) => n.name === def.name);
  const scope = named.filter((n) => n.kind === def.kind && n.qualifiedName === def.qualifiedName);
  // The one def of its name in its scope: the common case, decided without reading the file.
  if (scope.length < 2) return null;
  const overload = overloadSpellings(def.filePath, context);
  const lines = context.getFileLines?.(def.filePath) ?? context.readFile(def.filePath)?.split(/\r?\n/) ?? [];
  if (!isOverloadStub(def, lines, overload)) return null;
  const below = scope.filter((n) => n.startLine > def.startLine).sort((a, b) => a.startLine - b.startLine);
  return below.find((n) => !isOverloadStub(n, lines, overload))?.id ?? null;
}

/**
 * How a file can write typing's `overload` as a decorator: bare names (`overload`,
 * or the alias of `from typing import overload as ov`) and the names a typing
 * module goes by (`typing`, or `t` after `import typing as t`). A bare
 * `overload` the file imports from another module is that module's.
 */
function overloadSpellings(filePath: string, context: ResolutionContext): { bare: Set<string>; modules: Set<string> } {
  const imports = context.getImportMappings(filePath, 'python');
  const bare = new Set<string>();
  const modules = new Set(TYPING);
  for (const m of imports) {
    if (m.isNamespace && TYPING.has(m.source)) modules.add(m.localName);
    else if (!m.isNamespace && m.exportedName === 'overload' && TYPING.has(m.source)) bare.add(m.localName);
  }
  // Not imported by name at all (`from typing import *`): the bare name is typing's.
  if (!imports.some((m) => m.localName === 'overload')) bare.add('overload');
  return { bare, modules };
}

/** Whether the decorators above a `def` hold typing's `overload`. */
function isOverloadStub(def: Node, lines: string[], overload: { bare: Set<string>; modules: Set<string> }): boolean {
  // Upward from the line above the `def`: decorators, and inside a decorator's
  // parentheses the lines of its arguments. A `)` read going up opens such a
  // span, which its `(` closes.
  let open = 0;
  for (let i = def.startLine - 2; i >= 0 && i >= def.startLine - 1 - DECORATOR_REACH; i--) {
    const text = (lines[i] ?? '').trim();
    open += (text.match(/\)/g)?.length ?? 0) - (text.match(/\(/g)?.length ?? 0);
    if (open > 0) continue;
    open = 0;
    if (text === '' || text.startsWith('#')) continue;
    if (!text.startsWith('@')) return false;
    const m = /^@\s*((?:\w+\s*\.\s*)*)(\w+)/.exec(text);
    if (!m) continue;
    const via = m[1]!.replace(/\s/g, '').replace(/\.$/, '');
    if (via ? m[2] === 'overload' && overload.modules.has(via) : overload.bare.has(m[2]!)) return true;
  }
  return false;
}
