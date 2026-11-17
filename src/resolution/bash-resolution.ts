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
 * - A script reached through PATH is linked only where the project says PATH
 *   holds it: a script that puts its own directory first on PATH
 *   (`PATH="$SELF_DIR:$PATH"`) lets the scripts in that directory run one
 *   another by bare name, and `"$VAR/x"` reaches `x` in the directory a
 *   script exports as `VAR`. `exec X` and `command X` look on PATH only.
 *   A builtin (`set`, `test`) is never a script.
 * - A path built from `$0` (`$(dirname "$0")/lib.sh`, kept as `$0/lib.sh`)
 *   is relative to the script the shell was started with. In a file nothing
 *   sources, that is the file itself; in a sourced file it is the script at the
 *   top of the sourcing chain, so the path links only when every such script
 *   places it at the same file. Under Bats, `$0` is Bats' own runner, so a
 *   path a test file reaches through `$0` stays unresolved.
 *
 * Not followed (missing edges, never wrong ones): a library function calling a
 * sibling library that only its entry script sources; files sourced through a
 * variable the extractor can't read; a `source` inside a function or an `if`
 * counts as if it always ran.
 */
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { resolveImportPath } from './import-resolver';
import { ON_PATH_DECORATOR, PATH_PROGRAM_PREFIX, SCRIPT_DIR_DECORATOR, SCRIPT_ZERO_PREFIX } from '../extraction/languages/bash';

/**
 * Bash builtins and keywords: the shell runs these itself, whatever PATH holds,
 * so a script that shares the name (dokku's `set` subcommand) is never it.
 */
const SHELL_BUILTINS = new Set([
  '.', ':', '[', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen', 'complete',
  'compopt', 'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export',
  'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout',
  'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'set', 'shift',
  'shopt', 'source', 'suspend', 'test', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask',
  'unalias', 'unset', 'wait',
]);

/** A call edge to a script that is run, or null. */
function runResult(ref: UnresolvedRef, file: string | null, context: ResolutionContext): ResolvedRef | null {
  const node = file ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
  return node ? { original: ref, targetNodeId: node.id, confidence: 0.85, resolvedBy: 'import' } : null;
}

/**
 * The script a bare command runs from PATH, or null. Only a directory some
 * script in it puts first on PATH (`PATH="$SELF_DIR:$PATH"`, bats-core's
 * libexec) is known to be there, and only for the scripts in that directory,
 * which the PATH-setting script starts. Never a builtin, never the caller.
 */
function onPathScript(name: string, fromFile: string, memo: BashMemo, context: ResolutionContext): string | null {
  if (SHELL_BUILTINS.has(name) || !/^[\w.+][\w.+-]*$/.test(name)) return null;
  const dir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  if (!pathDirsOf(memo, context).has(dir)) return null;
  const target = dir === '.' ? name : `${dir}/${name}`;
  return target !== fromFile && isBashFile(target, context) ? target : null;
}

/**
 * `"$VAR/x"` where a script exports `VAR` as its own directory: that
 * directory's `x`, when every such script agrees on the directory.
 */
function exportedDirectoryScript(variable: string, rest: string, fromFile: string, memo: BashMemo, context: ResolutionContext): string | null {
  const dirs = scriptDirsOf(memo, context).get(variable);
  if (!dirs || dirs.size !== 1) return null;
  const target = path.posix.normalize(path.posix.join([...dirs][0]!, rest));
  if (target === '..' || target.startsWith('../') || target === fromFile) return null;
  return isBashFile(target, context) ? target : null;
}

function isBashFile(file: string, context: ResolutionContext): boolean {
  return context.fileExists(file) && context.getNodesInFile(file).some((n) => n.kind === 'file' && n.language === 'bash');
}

/** Directories a script puts first on PATH (from `PATH` variable nodes the extractor marked). */
function pathDirsOf(memo: BashMemo, context: ResolutionContext): Set<string> {
  if (memo.pathDirs) return memo.pathDirs;
  const dirs = new Set<string>();
  for (const kind of ['variable', 'constant'] as const) {
    for (const v of context.getNodesByKind(kind)) {
      if (v.language !== 'bash' || v.name !== 'PATH') continue;
      for (const d of v.decorators ?? []) if (d.startsWith(ON_PATH_DECORATOR)) dirs.add(d.slice(ON_PATH_DECORATOR.length));
    }
  }
  memo.pathDirs = dirs;
  return dirs;
}

/** Each exported variable to the script directories it is assigned. */
function scriptDirsOf(memo: BashMemo, context: ResolutionContext): Map<string, Set<string>> {
  if (memo.scriptDirs) return memo.scriptDirs;
  const map = new Map<string, Set<string>>();
  for (const kind of ['variable', 'constant'] as const) {
    for (const v of context.getNodesByKind(kind)) {
      if (v.language !== 'bash') continue;
      for (const d of v.decorators ?? []) {
        if (!d.startsWith(SCRIPT_DIR_DECORATOR)) continue;
        let set = map.get(v.name);
        if (!set) map.set(v.name, (set = new Set()));
        set.add(d.slice(SCRIPT_DIR_DECORATOR.length));
      }
    }
  }
  memo.scriptDirs = map;
  return map;
}

/** Whether `ref` is a Bash reference this module answers (calls and file imports). */
export function isBashRef(ref: UnresolvedRef): boolean {
  return ref.language === 'bash' && (ref.referenceKind === 'calls' || ref.referenceKind === 'imports');
}

/** The resolution of a Bash call or import; null leaves it unresolved (no other strategy runs). */
export function resolveBashRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const memo = memoFor(context);
  if (ref.referenceKind === 'imports') {
    const file = importTarget(ref.referenceName, ref.filePath, memo, context);
    const node = file ? context.getNodesInFile(file).find((n) => n.kind === 'file') : undefined;
    return node ? { original: ref, targetNodeId: node.id, confidence: 0.95, resolvedBy: 'import' } : null;
  }
  const name = ref.referenceName;
  if (name.startsWith(PATH_PROGRAM_PREFIX)) return runResult(ref, onPathScript(name.slice(PATH_PROGRAM_PREFIX.length), ref.filePath, memo, context), context);
  const viaVariable = /^\$([A-Za-z_]\w*)\/(.+)$/.exec(name);
  if (viaVariable) return runResult(ref, exportedDirectoryScript(viaVariable[1]!, viaVariable[2]!, ref.filePath, memo, context), context);
  const fn = resolveFunctionCall(ref, memo, context);
  if (fn) return fn;
  // No function answers: a script of that name in a directory on PATH may.
  return runResult(ref, onPathScript(name, ref.filePath, memo, context), context);
}

/** A call to the function the shell would run, or null. */
function resolveFunctionCall(ref: UnresolvedRef, memo: BashMemo, context: ResolutionContext): ResolvedRef | null {
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
  /** Each file to the files that source it; built once per pass. */
  sourcedBy: Map<string, Set<string>> | null;
  /** Each file to the scripts `$0` can name while it runs; empty when unknown. */
  starters: Map<string, Set<string>>;
  pathDirs: Set<string> | null;
  scriptDirs: Map<string, Set<string>> | null;
}

const memos = new WeakMap<ResolutionContext, BashMemo>();

function memoFor(context: ResolutionContext): BashMemo {
  let memo = memos.get(context);
  if (!memo) {
    memo = { names: null, sources: new Map(), defs: new Map(), ends: new Map(), reading: new Set(), sourcedBy: null, starters: new Map(), pathDirs: null, scriptDirs: null };
    memos.set(context, memo);
  }
  return memo;
}

/** The file a Bash path names, or null: the exact file, never a name match. */
function importTarget(spec: string, fromFile: string, memo: BashMemo, context: ResolutionContext): string | null {
  if (!spec.startsWith(SCRIPT_ZERO_PREFIX)) return resolveImportPath(spec, fromFile, 'bash', context);
  const relative = spec.slice(SCRIPT_ZERO_PREFIX.length);
  const starters = startersOf(fromFile, memo, context);
  let found: string | null = null;
  for (const starter of starters) {
    // Under Bats, `$0` is Bats' runner, which is not in the project.
    if (/\.bats$/i.test(starter)) return null;
    const target = placeFrom(starter, relative, context);
    if (!target || (found !== null && target !== found)) return null;
    found = target;
  }
  return found;
}

/** `relative` joined to `starter`'s directory, when that file is in the project. */
function placeFrom(starter: string, relative: string, context: ResolutionContext): string | null {
  const target = path.posix.join(path.posix.dirname(starter.replace(/\\/g, '/')), relative);
  if (target === '..' || target.startsWith('../')) return null;
  return context.fileExists(target) ? target : null;
}

/**
 * The scripts `$0` can name while `file` runs: the file itself when nothing
 * sources it, else the scripts at the top of each chain that sources it. Empty
 * when every chain loops back on itself.
 */
function startersOf(file: string, memo: BashMemo, context: ResolutionContext, seen = new Set<string>()): Set<string> {
  const cached = memo.starters.get(file);
  if (cached) return cached;
  const sourcers = sourcedByOf(memo, context).get(file);
  if (!sourcers || sourcers.size === 0) {
    const own = new Set([file]);
    memo.starters.set(file, own);
    return own;
  }
  if (seen.has(file)) return new Set();
  seen.add(file);
  const out = new Set<string>();
  for (const sourcer of sourcers) for (const starter of startersOf(sourcer, memo, context, seen)) out.add(starter);
  seen.delete(file);
  // A result reached through a loop depends on where the walk began: kept only at its start.
  if (seen.size === 0) memo.starters.set(file, out);
  return out;
}

/**
 * Which files source which. A path built from `$0` is placed here only in a
 * file nothing else sources (where `$0` is that file), so that knowing who
 * sources a file never depends on itself; deeper `$0` paths are placed later,
 * through `startersOf`, once this map is known.
 */
function sourcedByOf(memo: BashMemo, context: ResolutionContext): Map<string, Set<string>> {
  if (memo.sourcedBy) return memo.sourcedBy;
  const map = new Map<string, Set<string>>();
  const add = (target: string | null, from: string): void => {
    if (!target || target === from) return;
    let set = map.get(target);
    if (!set) map.set(target, (set = new Set()));
    set.add(from);
  };
  const viaZero: Node[] = [];
  for (const imp of context.getNodesByKind('import')) {
    if (imp.language !== 'bash') continue;
    const spec = imp.qualifiedName || imp.name;
    if (spec.startsWith(SCRIPT_ZERO_PREFIX)) viaZero.push(imp);
    else add(resolveImportPath(spec, imp.filePath, 'bash', context), imp.filePath);
  }
  for (const imp of viaZero) {
    if (map.has(imp.filePath)) continue;
    add(placeFrom(imp.filePath, (imp.qualifiedName || imp.name).slice(SCRIPT_ZERO_PREFIX.length), context), imp.filePath);
  }
  memo.sourcedBy = map;
  return map;
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
    const target = importTarget(imp.qualifiedName || imp.name, file, memo, context);
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
