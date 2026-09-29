/**
 * Where a Swift reference to a type may land.
 *
 * Two shapes bound type references to the wrong node:
 *
 * 1. `extension View { … }` parses as a class_declaration, so the index holds a
 *    `class View` node for every file that extends SwiftUI's `View`, `Text`,
 *    `Color`, `String` or `URL`. With no declaration of the type in the
 *    project, every `struct X: View`, `Text("…")` and `Color.red` bound to
 *    whichever extension came first, and one private helper file became the
 *    most depended-on symbol in the app. An extension is not the type: a
 *    reference lands on the type's own declaration, or nowhere when the SDK
 *    declares it.
 *
 * 2. A nested type is named bare only inside its parent (or an extension or
 *    subclass of it). `@State` in a view is SwiftUI's property wrapper, never
 *    `AccountsListViewModel.State` from another file. The index keeps a type
 *    reference by its last segment, so a site's qualifier (`Build.Id` vs
 *    `Package.Id`) is read back from the source line.
 *
 * Applied to every strategy's result at resolveOne's seam, so the framework
 * resolvers' name patterns and the name matcher obey it alike. A conformance
 * to a type the project only extends now resolves to nothing, so the
 * supertype walk reads such conformances from the declaration itself
 * (`swiftExtendedConformances`) and the extensions' members still reach the
 * conformer. Resolution only: extraction, and the kernel's, are unchanged.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const TYPE_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['class', 'struct', 'enum', 'interface', 'protocol', 'type_alias']);

/** The first declaration keyword of a class_declaration, past its attributes and modifiers. */
const DECLARATION_KEYWORD = /\b(extension|class|struct|enum|actor|protocol)\b/;

interface Memo {
  extension: Map<string, boolean>;
  declaration: Map<string, Node | null>;
  conformances: Map<string, string[]>;
  clauses: Map<string, string[]>;
  inherited: Map<string, ReadonlySet<string>>;
}
const memos = new WeakMap<ResolutionContext, Memo>();

function memoFor(context: ResolutionContext): Memo {
  let memo = memos.get(context);
  if (!memo) {
    memo = { extension: new Map(), declaration: new Map(), conformances: new Map(), clauses: new Map(), inherited: new Map() };
    memos.set(context, memo);
  }
  return memo;
}

/** Drop the memos (see ReferenceResolver.clearCaches). */
export function clearSwiftTypeVisibility(context: ResolutionContext): void {
  memos.delete(context);
}

/** Is this Swift node an `extension` of a type rather than its declaration? */
export function isSwiftExtension(node: Node, context: ResolutionContext): boolean {
  // Extraction classifies an extension as a class (it is neither struct nor enum).
  if (node.language !== 'swift' || node.kind !== 'class') return false;
  const memo = memoFor(context).extension;
  const hit = memo.get(node.id);
  if (hit !== undefined) return hit;
  const lines = linesOf(node.filePath, context);
  let extension = false;
  if (lines) {
    const head = [
      (lines[node.startLine - 1] ?? '').slice(node.startColumn),
      ...lines.slice(node.startLine, Math.min(node.endLine, node.startLine + 4)),
    ]
      .join(' ')
      // An attribute's string argument (`message: "use class Foo"`) is not a keyword.
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    extension = DECLARATION_KEYWORD.exec(head)?.[1] === 'extension';
  }
  memo.set(node.id, extension);
  return extension;
}

/** A declaration's inheritance clause: `struct HomeView: View, Sendable {` → `View, Sendable`. */
const INHERITANCE_CLAUSE = /\b(?:class|struct|enum|actor|protocol|extension)\s+[A-Za-z_][\w.]*\s*(?:<[^{}]*?>)?\s*:\s*([^{]*?)\s*(?:\bwhere\b[^{]*)?\{/;

/** The supertypes a Swift type node's own declaration names: `View`, `Sendable` for `struct HomeView: View, Sendable {`. */
function declaredSupertypes(node: Node, context: ResolutionContext): string[] {
  const memo = memoFor(context).clauses;
  const hit = memo.get(node.id);
  if (hit) return hit;
  let names: string[] = [];
  const lines = linesOf(node.filePath, context);
  if (lines) {
    const head = [(lines[node.startLine - 1] ?? '').slice(node.startColumn), ...lines.slice(node.startLine, Math.min(node.endLine, node.startLine + 6))].join(' ');
    const clause = INHERITANCE_CLAUSE.exec(head.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'))?.[1];
    if (clause) {
      names = clause
        .split(',')
        .map((part) => part.replace(GENERIC_ARGS, '').trim().split('.').pop()!.trim())
        .filter((name) => /^[A-Za-z_]\w*$/.test(name));
    }
  }
  memo.set(node.id, names);
  return names;
}

/**
 * The types a Swift type node's own declaration conforms to that the project
 * only extends — `View` for `struct HomeView: View` when `extension View {}`
 * is all the index holds of it. Those conformances resolve to nothing (an
 * extension is not the type), yet the members the extensions add are the
 * conformer's: the supertype walk reads them from here. From the source, once
 * per node — the resolved edges it would otherwise come from do not exist.
 */
export function swiftExtendedConformances(node: Node, context: ResolutionContext): string[] {
  if (node.language !== 'swift') return [];
  const memo = memoFor(context).conformances;
  const hit = memo.get(node.id);
  if (hit) return hit;
  const names = declaredSupertypes(node, context).filter((name) => {
    const typed = context.getNodesByName(name).filter((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind));
    return typed.length > 0 && typed.every((n) => isSwiftExtension(n, context));
  });
  memo.set(node.id, names);
  return names;
}

/** Every type a Swift type inherits from or conforms to, as declared in the project — transitively, a few levels. */
function inheritedTypeNames(typeName: string, context: ResolutionContext): ReadonlySet<string> {
  const memo = memoFor(context).inherited;
  const hit = memo.get(typeName);
  if (hit) return hit;
  const found = new Set<string>();
  let frontier = [typeName];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const node of context.getNodesByName(name)) {
        if (node.language !== 'swift' || !TYPE_KINDS.has(node.kind)) continue;
        for (const sup of declaredSupertypes(node, context)) {
          if (sup === typeName || found.has(sup)) continue;
          found.add(sup);
          next.push(sup);
        }
      }
    }
    frontier = next;
  }
  memo.set(typeName, found);
  return found;
}

/** The type path a nested type is declared in (`AccountsListViewModel` for `AccountsListViewModel::State`), or null at the top level. */
function parentPath(node: Node): string | null {
  const sep = node.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null;
  const parent = node.qualifiedName.slice(0, sep);
  // A framework resolver's node is named after its file (`Sources/App/Home.swift::Home`), not a scope.
  if (parent.includes('/') || parent.endsWith('.swift')) return null;
  return parent;
}

/**
 * How deep the code at `from` sits in `target`'s scope, when it may name
 * `target` bare: 0 for a top-level type, the parent's segment count inside
 * the parent or a subtype of it, one more inside the type itself; null when
 * out of scope. An `extension API.PackageController` carries only its last
 * segment (`PackageController::get`), so a suffix of a path counts as inside
 * it too.
 */
function bareScopeDepth(target: Node, from: Node | null, context: ResolutionContext): number | null {
  const parent = parentPath(target);
  if (!parent) return 0;
  if (!from) return null;
  const scope = from.qualifiedName;
  const inside = (path: string): boolean => {
    const segs = path.split('::');
    for (let i = 0; i < segs.length; i++) {
      const suffix = segs.slice(i).join('::');
      if (scope === suffix || scope.startsWith(`${suffix}::`)) return true;
    }
    return false;
  };
  const depth = parent.split('::').length;
  // Inside the type itself — `extension NIOBSDSocket.Option { static let x: Option }` —
  // or inside its parent.
  if (inside(target.qualifiedName)) return depth + 1;
  if (inside(parent)) return depth;
  // A subclass (or conformer) names its supertype's nested types bare:
  // `ReadResult` in `BaseStreamSocketChannel: BaseSocketChannel`.
  const parentName = parent.split('::').pop()!;
  const scopeTypes = scope.split('::');
  for (const name of scopeTypes) {
    if (inheritedTypeNames(name, context).has(parentName)) return depth;
  }
  return null;
}

/** The source lines of a file, through the resolver's line cache when it has one. */
function linesOf(filePath: string, context: ResolutionContext): string[] | null {
  return context.getFileLines?.(filePath) ?? context.readFile(filePath)?.split(/\r?\n/) ?? null;
}

/** `<Success>` / `<Key, [Value]>` — one level of nesting is all a qualifier carries in practice. */
const GENERIC_ARGS = /<[^<>]*(?:<[^<>]*>[^<>]*)*>/g;
const QUALIFIER_SEGMENT = String.raw`[A-Za-z_]\w*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\.\s*`;
const QUALIFIER_BEFORE = new RegExp(String.raw`((?:${QUALIFIER_SEGMENT})+)$`);

/**
 * The reference as its site writes it. The index keeps a Swift type
 * reference by its last segment — `Build.Id` is a ref named `Id` — so whether
 * the name was qualified is read back from the line: a type annotation's
 * column is the name's (`Build.|Id`), a construction's is the chain's
 * (`|API.PackageController.GetRoute.Model(`).
 */
function writtenName(ref: UnresolvedRef, context: ResolutionContext): string {
  const name = ref.referenceName;
  if (name.includes('.')) return name;
  const text = linesOf(ref.filePath, context)?.[ref.line - 1];
  if (!text) return name;
  // `EventLoopFuture<Success>.Isolated`: the qualifier's generic arguments are not part of its path.
  const clean = (qualifier: string): string => `${qualifier.replace(GENERIC_ARGS, '').replace(/\s+/g, '')}${name}`;
  // A composition's `&` line is parsed one column left of the file, its `&`
  // moved onto the line before (joinSwiftCompositionContinuations).
  const column = !text.startsWith(name, ref.column) && /^[ \t]*&[ \t]/.test(text) && text.startsWith(name, ref.column + 1) ? ref.column + 1 : ref.column;
  if (text.startsWith(name, column)) {
    const before = QUALIFIER_BEFORE.exec(text.slice(Math.max(0, column - 240), column));
    return before ? clean(before[1]!) : name;
  }
  const chain = new RegExp(String.raw`^((?:${QUALIFIER_SEGMENT})+)${name.replace(/[$\\]/g, '\\$&')}\b`).exec(text.slice(ref.column, ref.column + 240));
  return chain ? clean(chain[1]!) : name;
}

/** `API.PackageController.Model` as `API::PackageController::Model`, up to `name`; null when `name` is not a segment. */
function writtenPath(written: string, name: string): string | null {
  const segs = written.split('.');
  const at = segs.lastIndexOf(name);
  return at < 0 ? null : segs.slice(0, at + 1).join('::');
}

/**
 * Does a type's qualified name fit the path a site wrote? A type declared in
 * `extension API.PackageController.GetRoute` is `GetRoute::Model`, so its
 * name may be a tail of the path; a module-qualified `Foundation.Date` names
 * a top-level type.
 */
function fitsPath(node: Node, path: string, context: ResolutionContext): boolean {
  const qn = node.qualifiedName;
  if (qn === path || qn.endsWith(`::${path}`)) return true;
  if (!path.endsWith(`::${qn}`)) return false;
  if (qn.includes('::')) return true;
  const head = path.slice(0, path.length - qn.length - 2);
  const parentName = head.split('::').pop()!;
  // A member declared under `#if` in a type's body can be indexed at the top
  // level — the grammar ends `enum NIOBSDSocket {` at an `#if` right inside
  // it, so `typealias Handle` loses its parent. It still shares a file with a
  // declaration or extension of the parent the site names.
  if (context.getNodesInFile(node.filePath).some((p) => p.name === parentName && TYPE_KINDS.has(p.kind) && p.id !== node.id)) return true;
  // `App.Build`: a top-level type under a qualifier that names no type — a module.
  return !head.includes('::') && !context.getNodesByName(head).some((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind));
}

/** Segments two paths' directories share. */
function sharedDirs(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let n = 0;
  while (n < da.length && n < db.length && da[n] === db[n]) n++;
  return n;
}

/** The project's own declaration of the type a site names, when exactly one fits. */
function declarationFor(name: string, written: string, ref: UnresolvedRef, from: Node | null, context: ResolutionContext): Node | null {
  const memo = memoFor(context).declaration;
  const key = `${ref.filePath}\0${from?.qualifiedName ?? ''}\0${written}\0${name}`;
  if (memo.has(key)) return memo.get(key)!;

  const bare = !written.includes('.');
  const path = bare ? null : writtenPath(written, name);
  const scored: Array<{ node: Node; depth: number }> = [];
  for (const node of context.getNodesByName(name)) {
    if (node.language !== 'swift' || !TYPE_KINDS.has(node.kind) || isSwiftExtension(node, context)) continue;
    if (path !== null) {
      if (fitsPath(node, path, context)) scored.push({ node, depth: 0 });
      continue;
    }
    const depth = bare ? bareScopeDepth(node, from, context) : 0;
    if (depth !== null) scored.push({ node, depth });
  }
  // Swift looks a bare name up innermost scope first.
  const deepest = Math.max(-1, ...scored.map((s) => s.depth));
  // One declaration per file: a framework resolver's one-line twin of a
  // declaration (`@main struct App`) is the same type.
  const byFile = new Map<string, Node>();
  for (const { node, depth } of scored) {
    if (depth !== deepest) continue;
    const had = byFile.get(node.filePath);
    if (!had || node.endLine - node.startLine > had.endLine - had.startLine) byFile.set(node.filePath, node);
  }
  const declarations = [...byFile.values()];
  let found: Node | null = null;
  if (declarations.length === 1) {
    found = declarations[0]!;
  } else if (declarations.length > 1) {
    // The same file's, else the nearest by directory — a package's own type
    // over another package's. A tie is left unresolved.
    found = declarations.find((n) => n.filePath === ref.filePath) ?? null;
    if (!found) {
      const near = Math.max(...declarations.map((n) => sharedDirs(n.filePath, ref.filePath)));
      const nearest = declarations.filter((n) => sharedDirs(n.filePath, ref.filePath) === near);
      found = nearest.length === 1 ? nearest[0]! : null;
    }
  }
  memo.set(key, found);
  return found;
}

/**
 * A Swift reference's resolved type target, checked against what the site
 * wrote: an extension moves to the declaration it extends, a qualified name
 * to the type on that path, and a bare name of a nested type out of its
 * scope to one in scope — or the reference is left unresolved.
 */
export function gateSwiftTypeTarget(result: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!result || ref.language !== 'swift' || ref.referenceKind === 'imports') return result;
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target || target.language !== 'swift' || !TYPE_KINDS.has(target.kind)) return result;
  const from = context.getNodeById?.(ref.fromNodeId) ?? null;
  const written = writtenName(ref, context);
  if (!isSwiftExtension(target, context)) {
    if (!written.includes('.')) {
      if (bareScopeDepth(target, from, context) !== null) return result;
    } else {
      const path = writtenPath(written, target.name);
      if (path === null || fitsPath(target, path, context)) return result;
    }
  }
  const declared = declarationFor(target.name, written, ref, from, context);
  if (!declared) return null;
  return declared.id === result.targetNodeId ? result : { ...result, targetNodeId: declared.id };
}
