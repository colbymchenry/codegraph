/**
 * Which files include a C or C++ file: the files whose `#include` names it,
 * then the files that include those, out to the translation units.
 *
 * Read from the `import` node extraction mints for every `#include`, each
 * resolved by the coordinator's import lookup as the graph's include edge is
 * (by the end of its path when nothing else places it, and never to a project
 * file for a standard header like `<math.h>`), so "includes" here is the
 * include edge a reader sees. The name matcher asks it
 * whether a C or C++ file named like a test is part of a reference's
 * translation unit: protobuf's conformance framework lives in
 * `conformance/conformance_test.h` and `test_runner.h`, which the suites and
 * runners that use it include.
 *
 * The walk starts from the included file, not from the reference's: a handful
 * of such files are asked about, by references from many files, and a file
 * nothing includes — a project's own tests, mostly — costs one map lookup.
 */
import type { Language, Node } from '../types';
import type { ResolutionContext } from './types';

/** One `#include` directive, as its import node records it. */
interface Include {
  id: string;
  /** The path as written: `conformance/conformance_test.h`. */
  spec: string;
  file: string;
  language: Language;
  line: number;
  column: number;
}

interface Memo {
  /** Every C / C++ `#include`, by the file name it spells (`a/b.h` → `b.h`). */
  byName: Map<string, Include[]> | null;
  /** The same, by the stem of that name (`a/b.h` → `b`). */
  byStem: Map<string, Include[]> | null;
  /** Import node id → the indexed file its `#include` names (null: none). */
  targets: Map<string, string | null>;
  /** File → the files that include it, directly or through other includes. */
  includers: Map<string, ReadonlySet<string>>;
}

const MEMO = new WeakMap<ResolutionContext, Memo>();

export function clearCppIncluderMemos(context: ResolutionContext): void {
  MEMO.delete(context);
}

function memoFor(context: ResolutionContext): Memo {
  let memo = MEMO.get(context);
  if (!memo) MEMO.set(context, (memo = { byName: null, byStem: null, targets: new Map(), includers: new Map() }));
  return memo;
}

const isCFamily = (language: string): boolean => language === 'c' || language === 'cpp';
const fileName = (filePath: string): string => filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};
const dirOf = (filePath: string): string => filePath.slice(0, filePath.lastIndexOf('/') + 1);

const toInclude = (n: Pick<Node, 'id' | 'name' | 'filePath' | 'language' | 'startLine' | 'startColumn'>): Include =>
  ({ id: n.id, spec: n.name, file: n.filePath, language: n.language, line: n.startLine, column: n.startColumn });

/** The indexed file an `#include` names, the way its include edge resolves it. */
function includedFile(include: Include, context: ResolutionContext, memo: Memo): string | null {
  const hit = memo.targets.get(include.id);
  if (hit !== undefined) return hit;
  const resolved = context.resolveImport?.({
    fromNodeId: include.id,
    referenceName: include.spec,
    referenceKind: 'imports',
    line: include.line,
    column: include.column,
    filePath: include.file,
    language: include.language,
  });
  const target = resolved ? context.getNodeById?.(resolved.targetNodeId) : null;
  const file = target?.kind === 'file' ? target.filePath : null;
  memo.targets.set(include.id, file);
  return file;
}

function includesByName(context: ResolutionContext, memo: Memo): Map<string, Include[]> {
  if (memo.byName) return memo.byName;
  const byName = new Map<string, Include[]>();
  const nodes = context.getCppIncludeNodes?.() ?? context.iterateNodesByKind?.('import') ?? context.getNodesByKind('import');
  for (const n of nodes) {
    if (!isCFamily(n.language)) continue;
    const name = fileName(n.name);
    const list = byName.get(name);
    if (list) list.push(toInclude(n));
    else byName.set(name, [toInclude(n)]);
  }
  memo.byName = byName;
  return byName;
}

function includesByStem(context: ResolutionContext, memo: Memo): Map<string, Include[]> {
  if (memo.byStem) return memo.byStem;
  const byStem = new Map<string, Include[]>();
  for (const [name, includes] of includesByName(context, memo)) {
    const stem = stemOf(name);
    const list = byStem.get(stem);
    if (list) list.push(...includes);
    else byStem.set(stem, [...includes]);
  }
  memo.byStem = byStem;
  return byStem;
}

/**
 * The headers in `filePath`'s folder named like it (`field_def.c` →
 * `field_def.h`) that it includes, directly or through other headers. upb's
 * reflection/field_def.c includes only reflection/internal/field_def.h, which
 * reaches the reflection/field_def.h it implements through def.h.
 */
export function cppIncludedHeadersBeside(filePath: string, context: ResolutionContext): string[] {
  const memo = memoFor(context);
  const dir = dirOf(filePath);
  const found: string[] = [];
  for (const include of includesByStem(context, memo).get(stemOf(fileName(filePath))) ?? []) {
    const target = includedFile(include, context, memo);
    if (!target || target === filePath || found.includes(target) || dirOf(target) !== dir) continue;
    if (cppIncluders(target, context).has(filePath)) found.push(target);
  }
  return found;
}

/** The indexed file the `#include` an import node records names, or null. */
export function cppIncludedFile(include: Node, context: ResolutionContext): string | null {
  return include.kind === 'import' && isCFamily(include.language) ? includedFile(toInclude(include), context, memoFor(context)) : null;
}

/**
 * Every file that includes `filePath`, directly or through the files that
 * include it: the translation units (and headers) it is part of.
 */
export function cppIncluders(filePath: string, context: ResolutionContext): ReadonlySet<string> {
  const memo = memoFor(context);
  const hit = memo.includers.get(filePath);
  if (hit) return hit;
  const byName = includesByName(context, memo);
  const found = new Set<string>();
  const queue = [filePath];
  for (let i = 0; i < queue.length; i++) {
    const target = queue[i]!;
    const name = fileName(target);
    const dot = name.lastIndexOf('.');
    // `#include "foo"` can name `foo.h`: the include resolver tries extensions.
    for (const spelled of dot > 0 ? [name, name.slice(0, dot)] : [name]) {
      for (const include of byName.get(spelled) ?? []) {
        if (include.file === filePath || found.has(include.file)) continue;
        if (includedFile(include, context, memo) !== target) continue;
        found.add(include.file);
        queue.push(include.file);
      }
    }
  }
  memo.includers.set(filePath, found);
  return found;
}
