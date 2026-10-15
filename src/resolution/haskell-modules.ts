/**
 * Haskell / DAML qualified references.
 *
 * Extraction writes a qualified reference in the resolver's `Module::name`
 * form with the import alias expanded (`M.fromList` under
 * `import Data.Map qualified as M` → `Data.Map::fromList`). An alias several
 * imports share (legal, and common in DAML) lists every module in
 * `candidates`. The exact qualified-name strategy covers a name declared in the
 * named module; this covers the rest:
 *
 * - a shared alias: the one candidate module that declares the name;
 * - a re-export (`module Splice.Utils (module Splice.Utils.Internal) where`):
 *   the named module is the project's but declares nothing by that name, so
 *   the name is accepted when exactly one declaration of a fitting kind has it.
 *
 * A module the project doesn't declare — the DAML standard library (`DA.Map`,
 * `DA.Date`) or an external package — stays unresolved: binding
 * `DA.Date::date` to a project's own `date` would be a wrong edge.
 *
 * DAML: a choice declares a record type of its own name (the choice argument),
 * so building that record (`let arg = Transfer with ...`, exercised later
 * through the variable) instantiates the choice, qualified or not.
 *
 * When a module exists in several copies (a vendored package, a generated docs
 * tree mirroring `src/`), the copy sharing the longest directory prefix with
 * the referencing file wins, as a module search path would pick it; a tie
 * stays unresolved.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const HASKELL_FAMILY = new Set(['haskell', 'daml']);

/** Kinds a reference of each kind may land on. */
const TARGET_KINDS: Record<string, ReadonlySet<string>> = {
  calls: new Set(['function', 'method']),
  instantiates: new Set(['struct', 'class', 'enum_member']),
  implements: new Set(['interface', 'trait', 'class', 'type_alias']),
  extends: new Set(['interface', 'trait', 'class', 'type_alias']),
};

function sharedDirDepth(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let i = 0;
  while (i < da.length && i < db.length && da[i] === db[i]) i++;
  return i;
}

/** The single candidate nearest the referencing file, or null on a tie. */
export function nearest(candidates: Node[], filePath: string | undefined): Node | null {
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0 || !filePath) return null;
  const scored = candidates.map((n) => ({ n, depth: sharedDirDepth(n.filePath, filePath) }))
    .sort((x, y) => y.depth - x.depth);
  return scored[0]!.depth > scored[1]!.depth ? scored[0]!.n : null;
}

function splitQualified(name: string): { module: string; member: string } | null {
  const sep = name.lastIndexOf('::');
  return sep > 0 ? { module: name.slice(0, sep), member: name.slice(sep + 2) } : null;
}

/**
 * Whatever strategy resolved a Haskell/DAML reference, prefer the copy of its
 * target nearest the referencing file when the same qualified name is declared
 * in several copies of a module (the generic strategies take the first one
 * indexed). Applies to `imports` too: a module imports its own copy's sibling.
 */
export function gateHaskellNearestCopy(
  result: ResolvedRef | null,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  if (!result || !ref.language || !HASKELL_FAMILY.has(ref.language)) return result;
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target || !HASKELL_FAMILY.has(target.language)) return result;
  const copies = context.getNodesByQualifiedName(target.qualifiedName)
    .filter((n) => n.kind === target.kind && n.language === target.language);
  if (copies.length < 2) return result;
  const best = nearest(copies, ref.filePath);
  return best && best.id !== target.id ? { ...result, targetNodeId: best.id } : result;
}

function isDamlChoice(n: Node): boolean {
  return n.language === 'daml' && n.kind === 'method' && !!n.decorators?.includes('choice');
}

export function resolveHaskellModuleRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!ref.language || !HASKELL_FAMILY.has(ref.language)) return null;
  const kinds = TARGET_KINDS[ref.referenceKind];
  if (!kinds) return null;
  const fits = (n: Node): boolean =>
    n.language === ref.language &&
    (kinds.has(n.kind) || (ref.referenceKind === 'instantiates' && isDamlChoice(n)));
  const names = (ref.candidates?.length ? ref.candidates : [ref.referenceName])
    .map(splitQualified)
    .filter((q): q is { module: string; member: string } => q !== null);
  if (names.length === 0) {
    // An unqualified choice-argument record the name matcher left alone.
    if (ref.referenceKind !== 'instantiates') return null;
    const target = nearest(context.getNodesByName(ref.referenceName).filter(isDamlChoice), ref.filePath);
    return target ? { original: ref, targetNodeId: target.id, confidence: 0.7, resolvedBy: 'qualified-name' } : null;
  }

  const exact = names.flatMap((q) => context.getNodesByQualifiedName(`${q.module}::${q.member}`).filter(fits));
  if (exact.length > 0) {
    const target = nearest(exact, ref.filePath);
    return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'qualified-name' } : null;
  }

  const isProjectModule = names.some((q) =>
    context.getNodesByQualifiedName(q.module).some((n) => n.kind === 'namespace' && n.language === ref.language),
  );
  if (!isProjectModule) return null;
  const target = nearest(context.getNodesByName(names[0]!.member).filter(fits), ref.filePath);
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.7, resolvedBy: 'qualified-name' } : null;
}

// --- Scope ------------------------------------------------------------------
//
// A bare Haskell/DAML name can only mean a declaration of the referencing
// module or of a module it imports unqualified (within that import's list, or
// outside its `hiding` list), or one such a module re-exports — with
// `module X`, or by naming it in its export list (one hop). The generic name strategies don't know this and bind standard
// library calls (`pure`, `show`, `time`) to whatever project declaration shares
// the name. Instance and `interface instance` implementations are never named
// directly: a call dispatches through the class or interface method.

interface ImportScope {
  module: string;
  /** null = every name; otherwise the names the import list brings in. */
  names: Set<string> | null;
  hiding: Set<string>;
}

interface FileScope {
  module: string | null;
  imports: ImportScope[];
  /** Modules re-exported by the header's `module X` entries. */
  reexports: Set<string>;
  /** Names the export list mentions; null without an export list. */
  exportNames: Set<string> | null;
  /** The export list exports some type's constructors/fields wholesale (`T(..)`). */
  exportsAllChildren: boolean;
  /** Every module imported, qualified or not. */
  importedModules: Set<string>;
}

const scopeCache = new WeakMap<ResolutionContext, Map<string, FileScope>>();

const HEADER_RE = /^module\s+([\w.']+)\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?\s*where\b/m;
const IMPORT_RE =
  /^import\s+(qualified\s+)?([\w.']+)(\s+qualified)?(?:\s+as\s+[\w.']+)?\s*(hiding\s*)?(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?/gm;

function stripHaskellComments(src: string): string {
  return src.replace(/\{-[\s\S]*?-\}/g, ' ').replace(/--.*$/gm, '');
}

/** Names an import list mentions; null when it brings in all of a type's members (`T(..)`). */
function listedNames(list: string): Set<string> | null {
  if (/\(\s*\.\.\s*\)/.test(list.slice(1, -1))) return null;
  return new Set(list.slice(1, -1).match(/[A-Za-z_][\w']*/g) ?? []);
}

function fileScope(filePath: string, context: ResolutionContext): FileScope {
  let cache = scopeCache.get(context);
  if (!cache) {
    cache = new Map();
    scopeCache.set(context, cache);
  }
  const hit = cache.get(filePath);
  if (hit) return hit;
  const src = stripHaskellComments(context.readFile(filePath) ?? '');
  const header = HEADER_RE.exec(src);
  const exportList = header?.[2] ?? null;
  const scope: FileScope = {
    module: header?.[1] ?? null,
    imports: [],
    reexports: new Set(exportList?.match(/\bmodule\s+([\w.']+)/g)?.map((m) => m.replace(/^module\s+/, '')) ?? []),
    exportNames: exportList ? new Set(exportList.match(/[A-Za-z_][\w']*/g) ?? []) : null,
    exportsAllChildren: !!exportList && /\(\s*\.\.\s*\)/.test(exportList),
    importedModules: new Set(),
  };
  for (const m of src.matchAll(IMPORT_RE)) {
    scope.importedModules.add(m[2]!);
    if (m[1] || m[3]) continue; // qualified-only: brings in no bare names
    const list = m[5];
    const names = list && !m[4] ? listedNames(list) : null;
    const hiding = list && m[4] ? new Set(list.slice(1, -1).match(/[A-Za-z_][\w']*/g) ?? []) : new Set<string>();
    scope.imports.push({ module: m[2]!, names, hiding });
  }
  cache.set(filePath, scope);
  return scope;
}

/** The file declaring `module`, nearest the referencing file. */
function moduleFile(module: string, fromFile: string, context: ResolutionContext): string | null {
  const decls = context.getNodesByQualifiedName(module).filter((n) => n.kind === 'namespace' && HASKELL_FAMILY.has(n.language));
  return nearest(decls, fromFile)?.filePath ?? null;
}

function isInstanceImplementation(n: Node): boolean {
  return n.kind === 'method' && !n.decorators?.includes('choice') && n.qualifiedName.split('::').length >= 3;
}

function isVisible(target: Node, name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (isInstanceImplementation(target)) return false;
  if (!ref.filePath || target.filePath === ref.filePath) return true;
  const targetModule = fileScope(target.filePath, context).module;
  if (!targetModule) return false;
  const scope = fileScope(ref.filePath, context);
  if (scope.module === targetModule) return true;
  return scope.imports.some((imp) => {
    if (imp.hiding.has(name) || (imp.names && !imp.names.has(name))) return false;
    if (imp.module === targetModule) return true;
    const file = moduleFile(imp.module, ref.filePath!, context);
    if (!file) return false;
    const reexporter = fileScope(file, context);
    if (reexporter.reexports.has(targetModule)) return true;
    // `module M (basicAccount, Inequality(..)) where import M.Internal ...`
    // `T(..)` / `C(..)` re-export constructors, fields and class methods.
    const named = reexporter.exportNames?.has(name) || reexporter.exportsAllChildren;
    return !!named && reexporter.importedModules.has(targetModule);
  });
}

/**
 * Keep a bare Haskell/DAML reference's target only when Haskell scoping can see
 * it; otherwise switch to the visible same-named declaration, or drop the edge.
 */
export function gateHaskellScope(
  result: ResolvedRef | null,
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  if (!result || !ref.language || !HASKELL_FAMILY.has(ref.language)) return result;
  if (ref.referenceName.includes('::') || !TARGET_KINDS[ref.referenceKind] || ref.referenceKind === 'implements' || ref.referenceKind === 'extends') {
    return result;
  }
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target || !HASKELL_FAMILY.has(target.language)) return result;
  if (isVisible(target, ref.referenceName, ref, context)) return result;
  const kinds = TARGET_KINDS[ref.referenceKind]!;
  const visible = context.getNodesByName(ref.referenceName).filter((n) =>
    n.language === target.language &&
    (kinds.has(n.kind) || n.kind === 'field' || (ref.referenceKind === 'instantiates' && isDamlChoice(n))) &&
    isVisible(n, ref.referenceName, ref, context));
  // A record type and its same-named constructor share a file: keep the kind
  // the strategy chose before widening.
  const alt = nearest(visible.filter((n) => n.kind === target.kind), ref.filePath) ?? nearest(visible, ref.filePath);
  return alt ? { ...result, targetNodeId: alt.id } : null;
}
