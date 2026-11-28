/**
 * A file's imports, looked up by the name each binds or by the module each is
 * from.
 *
 * Resolving a reference asks which of its file's imports its name reads, and
 * asks more than once on the way. Each ask went through all of the file's
 * imports, so a generated file of some thousand imports — an icon set's
 * index, a package's re-exports — went through all of them for every
 * reference it holds: forty seconds for 1.2 MB of Python imports, a quarter
 * of that in TypeScript or Java.
 *
 * Here the imports are indexed once for the array the context hands out, and
 * dropped with it. A file of a few imports is still read through: it is as
 * quick, and builds nothing. Every lookup answers in the imports' own order,
 * as a pass over them does.
 */

import type { ImportMapping } from './types';

/** Below this many imports a pass over them is as quick as a lookup. */
const FEW_IMPORTS = 16;

type Placed = { at: number; imp: ImportMapping };

/** By a file's imports, as the context hands them out: those of each local name, with their place among them. */
const IMPORTS_BY_LOCAL_NAME = new WeakMap<ImportMapping[], Map<string, Placed[]>>();
/** By a file's imports, as the context hands them out: those from each source, with their place among them. */
const IMPORTS_BY_SOURCE = new WeakMap<ImportMapping[], Map<string, Placed[]>>();

function indexed(memo: WeakMap<ImportMapping[], Map<string, Placed[]>>, imports: ImportMapping[], key: (imp: ImportMapping) => string): Map<string, Placed[]> {
  let index = memo.get(imports);
  if (!index) {
    index = new Map();
    for (let at = 0; at < imports.length; at++) {
      const imp = imports[at]!;
      const same = index.get(key(imp));
      if (same) same.push({ at, imp });
      else index.set(key(imp), [{ at, imp }]);
    }
    memo.set(imports, index);
  }
  return index;
}

const byLocalName = (imports: ImportMapping[]): Map<string, Placed[]> => indexed(IMPORTS_BY_LOCAL_NAME, imports, (imp) => imp.localName);
const bySource = (imports: ImportMapping[]): Map<string, Placed[]> => indexed(IMPORTS_BY_SOURCE, imports, (imp) => imp.source);

/** The imports of `imports` bound to `name`, in their order. */
export function importsBoundTo(imports: ImportMapping[], name: string): ImportMapping[] {
  if (imports.length < FEW_IMPORTS) return imports.filter((imp) => imp.localName === name);
  return byLocalName(imports).get(name)?.map((found) => found.imp) ?? [];
}

/** The imports of `imports` from `source`, in their order. */
export function importsFrom(imports: ImportMapping[], source: string): ImportMapping[] {
  if (imports.length < FEW_IMPORTS) return imports.filter((imp) => imp.source === source);
  return bySource(imports).get(source)?.map((found) => found.imp) ?? [];
}

/**
 * The imports a reference named `name` reads, in their order: the one bound
 * to the name itself, and those bound to what stands before one of its dots
 * (`a.b.c` reads `a` and `a.b`). What going through `imports` for
 * `imp.localName === name || name.startsWith(imp.localName + '.')` gives.
 */
export function importsReadBy(imports: ImportMapping[], name: string): ImportMapping[] {
  if (imports.length < FEW_IMPORTS) return imports.filter((imp) => imp.localName === name || name.startsWith(imp.localName + '.'));
  const index = byLocalName(imports);
  let found = index.get(name)?.slice() ?? [];
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    const before = index.get(name.slice(0, dot));
    if (before) found = found.concat(before);
  }
  return found.length <= 1 ? found.map((f) => f.imp) : found.sort((a, b) => a.at - b.at).map((f) => f.imp);
}

/**
 * The imports a Python member reference can read, in their order: those bound
 * to its receiver, and those whose module its name spells out (`pkg.mod` for
 * `pkg.mod.func`). The others resolvePythonModuleMember passes over.
 */
export function pythonMemberImports(imports: ImportMapping[], receiver: string, name: string): ImportMapping[] {
  if (imports.length < FEW_IMPORTS) return imports;
  const found = new Map<number, ImportMapping>();
  for (const bound of byLocalName(imports).get(receiver) ?? []) found.set(bound.at, bound.imp);
  for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
    for (const spelled of bySource(imports).get(name.slice(0, dot)) ?? []) found.set(spelled.at, spelled.imp);
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([, imp]) => imp);
}
