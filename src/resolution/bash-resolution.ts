/**
 * Bash references resolve by what the shell itself would run, never by a
 * project-wide name match.
 *
 * - A call is a function only. A command word is a program on PATH as often
 *   as a function, so a name no sourced file defines stays unresolved: `set`,
 *   `test` or `run` never lands on a script that shares the name, and
 *   `command` never lands on a variable called `command`.
 * - Only `source`, `.` and Bats `load` bring definitions in: the extractor
 *   makes an `import` node for those alone. Running a script (`./x`,
 *   `bash x`, `exec x`) starts another process, so nothing it defines is
 *   visible to the caller (its file edge comes from the reference alone).
 * - Which definition runs follows the order the shell reads statements in. A
 *   file's definitions and the files it sources are taken in source order,
 *   each sourced file contributing what it defines by its end, so the last
 *   definition read wins. Top-level code sees what was read before it; a call
 *   in a function body runs later, so it sees the whole file.
 * - A sourced path is the exact file the extractor named, or nothing: a
 *   `./lib.sh` that `resolveShellPath` can't place never falls back to some
 *   other `lib.sh` by name.
 *
 * Not followed (missing edges, never wrong ones): a library function calling a
 * sibling library that only its entry script sources; files sourced through a
 * variable the extractor can't read; a `source` inside a function or an `if`
 * counts as if it always ran.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { resolveImportPath } from './import-resolver';

/** Whether `ref` is a Bash reference this module answers (calls and file imports). */
export function isBashRef(ref: UnresolvedRef): boolean {
  return ref.language === 'bash' && (ref.referenceKind === 'calls' || ref.referenceKind === 'imports');
}

/** The resolution of a Bash call or import; null leaves it unresolved (no other strategy runs). */
export function resolveBashRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind === 'imports') {
    const file = resolveImportPath(ref.referenceName, ref.filePath, 'bash', context);
    const node = file ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
    return node ? { original: ref, targetNodeId: node.id, confidence: 0.95, resolvedBy: 'import' } : null;
  }
  const memo = memoFor(context);
  if (!isBashFunctionName(ref.referenceName, memo, context)) return null; // `echo`, `grep`, …: no lookup needed
  const pos: Pos = [ref.line ?? Number.MAX_SAFE_INTEGER, ref.column ?? 0];
  // Inside any function body, a Bats test included: it runs after the whole
  // file is read. Compared by line and column, so `f() { :; }; g` is top level.
  const inFunction = context.getNodesInFile(ref.filePath).some((fn) =>
    fn.kind === 'function' && fn.language === 'bash' &&
    before([fn.startLine, fn.startColumn], pos) && before(pos, [fn.endLine ?? fn.startLine, fn.endColumn ?? Number.MAX_SAFE_INTEGER]));
  const target = inFunction
    ? endState(ref.filePath, memo, context).get(ref.referenceName)
    : lastBefore(ref.filePath, ref.referenceName, pos, memo, context);
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' } : null;
}

/**
 * The definition of `name` read last before `pos` in `file`: walking its
 * definitions and sources backwards from `pos`, the first that has it.
 */
function lastBefore(file: string, name: string, pos: Pos, memo: BashMemo, context: ResolutionContext): Node | undefined {
  const defs = defsOf(file, memo, context);
  const sources = sourcesOf(file, memo, context);
  let d = defs.length - 1;
  let s = sources.length - 1;
  while (d >= 0 && !before([defs[d]!.startLine, defs[d]!.startColumn], pos)) d--;
  while (s >= 0 && !before(sources[s]!.pos, pos)) s--;
  while (d >= 0 || s >= 0) {
    const def = d >= 0 ? defs[d] : undefined;
    const src = s >= 0 ? sources[s] : undefined;
    if (def && (!src || before(src.pos, [def.startLine, def.startColumn]))) {
      if (def.name === name) return def;
      d--;
    } else {
      const found = endState(src!.target, memo, context).get(name);
      if (found) return found;
      s--;
    }
  }
  return undefined;
}

type Pos = [line: number, column: number];

const before = (a: Pos, b: Pos): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

interface BashMemo {
  names: Set<string> | null;
  sources: Map<string, Array<{ pos: Pos; target: string }>>;
  defs: Map<string, Node[]>;
  ends: Map<string, Map<string, Node>>;
  reading: Set<string>;
}

const memos = new WeakMap<ResolutionContext, BashMemo>();

function memoFor(context: ResolutionContext): BashMemo {
  let memo = memos.get(context);
  if (!memo) memos.set(context, (memo = { names: null, sources: new Map(), defs: new Map(), ends: new Map(), reading: new Set() }));
  return memo;
}

/** Drop the per-context Bash memos (with the resolver's other caches, on every sync). */
export function clearBashResolutionMemos(context: ResolutionContext): void {
  memos.delete(context);
}

function isBashFunctionName(name: string, memo: BashMemo, context: ResolutionContext): boolean {
  if (!memo.names) {
    memo.names = new Set();
    for (const fn of context.getNodesByKind('function')) if (fn.language === 'bash' && !fn.decorators?.includes('@test')) memo.names.add(fn.name);
  }
  return memo.names.has(name);
}

function sourcesOf(file: string, memo: BashMemo, context: ResolutionContext): Array<{ pos: Pos; target: string }> {
  let out = memo.sources.get(file);
  if (out) return out;
  out = [];
  for (const imp of context.getNodesInFile(file)) {
    if (imp.kind !== 'import' || imp.language !== 'bash') continue;
    const target = resolveImportPath(imp.qualifiedName || imp.name, file, 'bash', context);
    if (target && target !== file) out.push({ pos: [imp.startLine, imp.startColumn], target });
  }
  out.sort((a, b) => (before(a.pos, b.pos) ? -1 : before(b.pos, a.pos) ? 1 : 0));
  memo.sources.set(file, out);
  return out;
}

function defsOf(file: string, memo: BashMemo, context: ResolutionContext): Node[] {
  let out = memo.defs.get(file);
  if (out) return out;
  out = context.getNodesInFile(file)
    .filter((n) => n.kind === 'function' && n.language === 'bash')
    .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  // A Bats test (marked `@test`) is a body to run, not a function to call.
  out = out.filter((n) => !n.decorators?.includes('@test'));
  memo.defs.set(file, out);
  return out;
}

/**
 * The functions visible once the shell has read `file` up to `pos`: its
 * definitions and the files it sources, in source order, each sourced file
 * adding what it defines by its end.
 */
function stateBefore(file: string, pos: Pos, memo: BashMemo, context: ResolutionContext): Map<string, Node> {
  const state = new Map<string, Node>();
  const defs = defsOf(file, memo, context);
  const sources = sourcesOf(file, memo, context);
  let d = 0;
  let s = 0;
  while (true) {
    const def = defs[d] && before([defs[d]!.startLine, defs[d]!.startColumn], pos) ? defs[d] : undefined;
    const src = sources[s] && before(sources[s]!.pos, pos) ? sources[s] : undefined;
    if (!def && !src) break;
    if (def && (!src || before([def.startLine, def.startColumn], src.pos))) {
      state.set(def.name, def);
      d++;
    } else {
      for (const [name, node] of endState(src!.target, memo, context)) state.set(name, node);
      s++;
    }
  }
  return state;
}

/**
 * What `file` defines by its end, memoized per pass. A file already being read
 * further up contributes only its own functions where it recurs, which keeps
 * the walk linear and the answer independent of where the walk began.
 */
function endState(file: string, memo: BashMemo, context: ResolutionContext): Map<string, Node> {
  const cached = memo.ends.get(file);
  if (cached) return cached;
  // Met again inside a cycle (sourcing usually behind an include guard): only
  // its own functions, the same whichever file the walk began from.
  if (memo.reading.has(file)) return new Map(defsOf(file, memo, context).map((fn) => [fn.name, fn]));
  memo.reading.add(file);
  try {
    const state = stateBefore(file, [Number.MAX_SAFE_INTEGER, 0], memo, context);
    memo.ends.set(file, state);
    return state;
  } finally {
    memo.reading.delete(file);
  }
}
