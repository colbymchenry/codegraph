/**
 * Where a Swift reference to a type may land: on the type's own declaration,
 * never an extension (1); a nested type only where it can be named bare (2);
 * and a static call on the type's own member, or a `references` edge to the
 * type when the member is external (3).
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
 *    `Package.Id`) is read back from the source line. An inheritance entry
 *    is the exception: its ref carries the dotted path the parse tree gives
 *    it (`class QC: Kit.Runner` is a ref named `Kit.Runner`), used as is.
 *
 * 1 and 2 apply to every strategy's result at resolveOne's seam, so the
 * framework resolvers' name patterns and the name matcher obey them alike. A
 * conformance to a type the project only extends resolves to nothing, yet the
 * extensions' members still reach the conformer: the static-call walk
 * (swiftSupertypeChain) maps the failed conformance's name to the project's
 * extensions of it, and getSupertypes' conformance pass reads it from the
 * declaration (`swiftExtendedConformances`). The walk reads the inheritance
 * refs both extractors write.
 *
 * 3. A static call on a project type resolves on that type or not at all:
 *    `API.PackageController.GetRoute.query(on:)` through
 *    `resolveSwiftTypePathCall`, the single-segment `TestHelpers.make()`
 *    through `resolveSwiftTypeCall`, both dispatched from the name matcher.
 *    The single-segment call sees a declaration only in a SwiftPM module its
 *    file can see (swiftStaticCallVisible: its own module, one an `import`
 *    node of the file names, or one a seen module re-exports with
 *    `@_exported import`; a declaration in no derivable module is always
 *    seen), so `SHA256.hash(data:)` in a file importing CryptoKit and not the
 *    project module that declares a `SHA256` gets no edge.
 *    `MyTool.main()` on an ArgumentParser `ParsableCommand`, or
 *    `Todo.query(on:)` on a Fluent `Model`, calls a member the library
 *    supplies, so the call cannot resolve — yet the caller depends on the
 *    project type it names. `swiftUnresolvedTypeMemberEdges` gives such a
 *    final failure a `references` edge to that type, under the same module
 *    rule; the `calls` row itself stays parked as failed. It runs where final failures are parked
 *    (ReferenceResolver's persist paths in index.ts), not at resolveOne's seam.
 */
import type { Edge, Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { isInheritanceRef } from './types';
import { escapeRegExp } from '../utils';
import { swiftModule, swiftModuleIdentity } from './swift-module';

const TYPE_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['class', 'struct', 'enum', 'interface', 'protocol', 'type_alias']);

/**
 * Swift's raw-value types by their stdlib names: String, Character, Bool, and
 * the integer and floating-point families. Each is a stdlib struct, and an
 * enum inherits from no class and nothing conforms to a struct, so an entry
 * of an enum's inheritance clause naming one of them is the enum's raw type
 * (`enum K: String`), never a supertype. That holds wherever the entry sits
 * in the clause, so no position data is needed to tell it apart. The static-call
 * supertype walk (swiftSupertypeChain) does not follow them from an enum.
 */
const SWIFT_RAW_VALUE_TYPES: ReadonlySet<string> = new Set([
  'String', 'Character', 'Bool',
  'Int', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Double', 'Float', 'Float16', 'Float80',
]);

/** The first declaration keyword of a class_declaration, past its attributes and modifiers. */
const DECLARATION_KEYWORD = /\b(extension|class|struct|enum|actor|protocol)\b/;

interface Memo {
  extension: Map<string, boolean>;
  declaration: Map<string, Node | null>;
  conformances: Map<string, string[]>;
  clauses: Map<string, string[]>;
  inherited: Map<string, ReadonlySet<string>>;
  owners: Map<string, string | null>;
  typeOwners: Map<string, string | null>;
  imports: Map<string, ReadonlySet<string>>;
  /** Per caller file: the module names it sees through imports and `@_exported` re-exports (seenModules). */
  seen: Map<string, ReadonlySet<string>>;
  /** The project's `@_exported import`s, read once (swiftReExports). */
  reExports: SwiftReExports | null;
}
const memos = new WeakMap<ResolutionContext, Memo>();

function memoFor(context: ResolutionContext): Memo {
  let memo = memos.get(context);
  if (!memo) {
    memo = { extension: new Map(), declaration: new Map(), conformances: new Map(), clauses: new Map(), inherited: new Map(), owners: new Map(), typeOwners: new Map(), imports: new Map(), seen: new Map(), reExports: null };
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
  const extension = !!lines && declaresExtension(lines, node);
  memo.set(node.id, extension);
  return extension;
}

/** Does the class_declaration at `node`'s position open with `extension`? From the file's lines. */
export function declaresExtension(lines: readonly string[], node: Pick<Node, 'startLine' | 'startColumn' | 'endLine'>): boolean {
  const head = [
    (lines[node.startLine - 1] ?? '').slice(node.startColumn),
    ...lines.slice(node.startLine, Math.min(node.endLine, node.startLine + 4)),
  ]
    .join(' ')
    // An attribute's string argument (`message: "use class Foo"`) is not a keyword.
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return DECLARATION_KEYWORD.exec(head)?.[1] === 'extension';
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
 * annotation or construction by its last segment — `Build.Id` is a ref named
 * `Id` — so whether the name was qualified is read back from the line: a type
 * annotation's column is the name's (`Build.|Id`), a construction's is the
 * chain's (`|API.PackageController.GetRoute.Model(`). Never called for an
 * inheritance entry, whose ref already carries its dotted path
 * (gateSwiftTypeTarget).
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
  const chain = new RegExp(String.raw`^((?:${QUALIFIER_SEGMENT})+)${escapeRegExp(name)}\b`).exec(text.slice(ref.column, ref.column + 240));
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

/**
 * The project's own declaration of the type a site names, when exactly one fits.
 *
 * `visible`, when given, keeps only the declarations the caller can see
 * (swiftStaticCallVisible) before the innermost-scope and tie rules run; the
 * static-call consumers pass it, gateSwiftTypeTarget does not. Dropping a
 * copy the caller cannot see never hands the call to a copy in no derivable
 * module that would not have won without the filter: such a winner must be
 * the unfiltered winner too, else nothing is found (a module-less copy is
 * kept only because its module is unknown, which is no evidence the caller
 * sees it over the dropped one).
 */
function declarationFor(
  name: string,
  written: string,
  ref: UnresolvedRef,
  from: Node | null,
  context: ResolutionContext,
  visible?: (decl: Node) => boolean,
): Node | null {
  const memo = memoFor(context).declaration;
  const key = `${ref.filePath}\0${from?.qualifiedName ?? ''}\0${written}\0${name}\0${visible ? 'visible' : ''}`;
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
  let found: Node | null;
  if (!visible) {
    found = pickDeclaration(scored, ref);
  } else {
    const seen = scored.filter((s) => visible(s.node));
    found = pickDeclaration(seen, ref);
    if (found && seen.length < scored.length && swiftModuleIdentity(found.filePath) === null) {
      if (pickDeclaration(scored, ref)?.id !== found.id) found = null;
    }
  }
  memo.set(key, found);
  return found;
}

/** Of scored declarations, the one a site means: innermost scope, then same file, then nearest directory; a tie is none. */
function pickDeclaration(scored: ReadonlyArray<{ node: Node; depth: number }>, ref: UnresolvedRef): Node | null {
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
  if (declarations.length === 0) return null;
  if (declarations.length === 1) return declarations[0]!;
  // The same file's, else the nearest by directory — a package's own type
  // over another package's. A tie is left unresolved.
  const same = declarations.find((n) => n.filePath === ref.filePath);
  if (same) return same;
  const near = Math.max(...declarations.map((n) => sharedDirs(n.filePath, ref.filePath)));
  const nearest = declarations.filter((n) => sharedDirs(n.filePath, ref.filePath) === near);
  return nearest.length === 1 ? nearest[0]! : null;
}

/**
 * Can code in `callerFile` name the type `decl` declares, by Swift's module
 * rule? Yes when `decl`'s SwiftPM module is not derivable (not gated), when
 * the caller is in that module (swiftModuleIdentity, the path up to the
 * module directory), or when the module's c99name is one the caller's file
 * sees (seenModules): one an `import` node of the file names, by the import's
 * name before its first '.' (`import Kit`, `@testable import Kit`,
 * `import struct Kit.Cache`), or one a seen module re-exports with
 * `@_exported import`, its own module included. A caller in no derivable
 * module and importing nothing sees no module's types.
 * Index facts only: the import nodes' names and signatures, never file text.
 */
function swiftStaticCallVisible(decl: Node, callerFile: string, context: ResolutionContext): boolean {
  const target = swiftModuleIdentity(decl.filePath);
  if (target === null) return true;
  if (swiftModuleIdentity(callerFile) === target) return true;
  const name = swiftModule(decl.filePath)!.name;
  return seenModules(callerFile, context).has(name);
}

/**
 * The project's `@_exported import`s, by the module that declares them:
 * `byIdentity` maps a module's swiftModuleIdentity to the module names its
 * files re-export, and `byName` a module's c99name to the identities of the
 * modules of that name that re-export anything (two packages may each have a
 * `Core` target, so a name can map to several).
 */
interface SwiftReExports {
  byIdentity: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
}

/**
 * Is this Swift import node an `@_exported import`? Its signature is the
 * whole import statement as extraction stored it (attributes included), so
 * the attribute is a whitespace-separated token before the `import` keyword.
 */
function isSwiftExportedImport(node: Node): boolean {
  const tokens = (node.signature ?? '').split(/\s+/);
  const at = tokens.indexOf('import');
  return at > 0 && tokens.slice(0, at).includes('@_exported');
}

/**
 * Read once per context, and dropped with the other memos: every Swift import
 * node, kept only where it is `@_exported` and its file is in a derivable
 * SwiftPM module (a re-export from a file in no module re-exports into no
 * module another file can import; that file's own imports already count
 * for it). Swift's `@_exported` is module-wide: one file's re-export is seen
 * by every importer of the module, and by every file of the module itself.
 */
function swiftReExports(context: ResolutionContext): SwiftReExports {
  const memo = memoFor(context);
  if (memo.reExports) return memo.reExports;
  const found: SwiftReExports = { byIdentity: new Map(), byName: new Map() };
  const imports = context.iterateNodesByKind?.('import') ?? context.getNodesByKind('import');
  for (const node of imports) {
    if (node.language !== 'swift' || !isSwiftExportedImport(node)) continue;
    const identity = swiftModuleIdentity(node.filePath);
    if (identity === null) continue;
    let names = found.byIdentity.get(identity);
    if (!names) {
      names = new Set();
      found.byIdentity.set(identity, names);
      const own = swiftModule(node.filePath)!.name;
      let ids = found.byName.get(own);
      if (!ids) found.byName.set(own, (ids = new Set()));
      ids.add(identity);
    }
    names.add(node.name.split('.')[0]!);
  }
  memo.reExports = found;
  return found;
}

/**
 * The module names code in `filePath` sees: those its own `import` nodes
 * name, and, closed transitively, those any seen module re-exports
 * (swiftReExports), starting from the file's own module's re-exports. A name
 * is matched to every module of that name that re-exports, as an `import`
 * is matched by name alone.
 */
function seenModules(filePath: string, context: ResolutionContext): ReadonlySet<string> {
  const memo = memoFor(context).seen;
  const hit = memo.get(filePath);
  if (hit) return hit;
  const reExports = swiftReExports(context);
  const seen = new Set(importedModules(filePath, context));
  // Every name in `pending` is in `seen` and is walked once: a cycle of
  // re-exports (A re-exports B, B re-exports A) ends.
  const pending = [...seen];
  const add = (identity: string): void => {
    for (const name of reExports.byIdentity.get(identity) ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      pending.push(name);
    }
  };
  const own = swiftModuleIdentity(filePath);
  if (own !== null) add(own);
  while (pending.length > 0) {
    for (const identity of reExports.byName.get(pending.pop()!) ?? []) add(identity);
  }
  memo.set(filePath, seen);
  return seen;
}

/** The module names a file's `import` nodes name: each import's name before its first '.'. */
function importedModules(filePath: string, context: ResolutionContext): ReadonlySet<string> {
  const memo = memoFor(context).imports;
  let names = memo.get(filePath);
  if (!names) {
    names = new Set(context.getNodesInFile(filePath).filter((n) => n.kind === 'import').map((n) => n.name.split('.')[0]!));
    memo.set(filePath, names);
  }
  return names;
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
  // An inheritance entry's ref is its dotted path from the parse tree
  // (`Kit.Runner`), so its qualifier is taken as is, not read back from the
  // source line.
  const written = isInheritanceRef(ref) ? ref.referenceName : writtenName(ref, context);
  // A supertype written with a qualifier none of whose segments names a
  // project type (`struct Y: Swift.Error`, `class Z: Foundation.Operation`)
  // names an external module's type: Swift never lets a project type be named
  // through another module's qualifier. The extraction cannot tell a module
  // from a type, and fitsPath reads such a qualifier as a module that fits a
  // top-level project type of the same last segment, so the entry gets no
  // target rather than a wrong one. Supertype refs only: a type annotation or
  // a call keeps fitsPath's reading.
  if ((ref.referenceKind === 'extends' || ref.referenceKind === 'implements') && written.includes('.')) {
    const qualifier = written.split('.').slice(0, -1);
    if (!qualifier.some((seg) => context.getNodesByName(seg).some((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind)))) return null;
  }
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

/**
 * A call through a type path, `API.PackageController.GetRoute.query` — at
 * least two capitalized segments before the member (the extractor keeps the
 * path only for those; see SWIFT_TYPE_PATH_RECEIVER in tree-sitter.ts).
 */
export const SWIFT_TYPE_PATH_CALL = /^(?!Self\.)[A-Z]\w*(?:\.[A-Z]\w*)+\.[A-Za-z_]\w*$/;

/** What a type-path call can name: a method, or a case with associated values (`Gitlab.Error.requestFailed(status:)`). */
const PATH_MEMBER_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['method', 'function', 'enum_member']);

/**
 * `API.PackageController.GetRoute.query(on:)` lands on the `query` of the
 * type the path names, and `API.PackageController.Model(name:)` on that
 * nested type — never on the member's name alone: in a Vapor app every
 * route's type has a `query`. A path the call's own namespace lets it
 * shorten (`PackageController.GetRoute` inside `extension API`) or a module
 * qualifier (`Vapor.HTTPStatus`) still fits. No type on the path, or two,
 * leaves the call unresolved.
 */
export function resolveSwiftTypePathCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  const dot = name.lastIndexOf('.');
  const member = name.slice(dot + 1);
  const path = name.slice(0, dot).split('.').join('::');
  const onPath = (kinds: ReadonlySet<Node['kind']>): Node[] => {
    const exact: Node[] = [];
    const shortened: Node[] = [];
    for (const n of context.getNodesByName(member)) {
      if (n.language !== 'swift' || !kinds.has(n.kind)) continue;
      if (TYPE_KINDS.has(n.kind) && isSwiftExtension(n, context)) continue;
      const owner = ownerPath(n, context);
      if (owner === null) continue;
      if (owner === path) exact.push(n);
      else if (owner.endsWith(`::${path}`) || moduleQualified(owner, path, context)) shortened.push(n);
    }
    return exact.length > 0 ? exact : shortened;
  };
  // `API.PackageController.Model(name:)` constructs a nested type.
  let fit = /^[A-Z]/.test(member) ? onPath(TYPE_KINDS) : [];
  if (fit.length === 0) fit = onPath(PATH_MEMBER_KINDS);
  // The Composable Architecture's `@Reducer enum Path { case detail(Detail) }`
  // generates `Path.State` and `Path.Action` with the same cases, so
  // `Path.State.detail(…)` constructs the case written in `Path`.
  if (fit.length === 0) {
    const reducer = /^(.+)::(?:State|Action)$/.exec(path)?.[1];
    if (reducer) {
      fit = context.getNodesByName(member).filter((n) => {
        if (n.language !== 'swift' || n.kind !== 'enum_member') return false;
        const owner = ownerPath(n, context);
        return owner !== null && (owner === reducer || owner.endsWith(`::${reducer}`)) && isReducerEnum(n, context);
      });
    }
  }
  if (fit.length === 0 || new Set(fit.map((n) => ownerPath(n, context))).size > 1) return null;
  // Of one type's overloads, the first declared.
  const target = fit.reduce((a, b) => (a.filePath < b.filePath || (a.filePath === b.filePath && a.startLine <= b.startLine) ? a : b));
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'qualified-name' };
}

/**
 * A qualified Swift inheritance entry, `class QC: Kit.Runner`, whose ref is
 * the dotted path the parse tree gives (`Kit.Runner`): the project's own
 * declaration of the type on that path (declarationFor, by the last segment),
 * or null. ResolveOne's gates still run on the result: gateSwiftTypeTarget
 * drops it when no qualifier segment names a project type. (createEdges later
 * writes an `extends` onto a protocol as `implements` when the source is not
 * itself an interface or protocol.)
 */
export function resolveSwiftQualifiedSupertype(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  const from = context.getNodeById?.(ref.fromNodeId) ?? null;
  const decl = declarationFor(name.slice(name.lastIndexOf('.') + 1), name, ref, from, context);
  return decl ? { original: ref, targetNodeId: decl.id, confidence: 0.9, resolvedBy: 'qualified-name' } : null;
}

/** Is this case declared in a `@Reducer enum`? */
function isReducerEnum(member: Node, context: ResolutionContext): boolean {
  const owner = context
    .getNodesInFile(member.filePath)
    .filter((t) => t.kind === 'enum' && t.startLine <= member.startLine && t.endLine >= member.endLine)
    .reduce<Node | null>((inner, t) => (!inner || t.startLine >= inner.startLine ? t : inner), null);
  if (!owner) return false;
  const lines = linesOf(owner.filePath, context) ?? [];
  // The node starts at its attributes; `@Reducer` may also sit on the line above.
  return /@Reducer\b/.test(lines.slice(Math.max(0, owner.startLine - 2), owner.startLine + 1).join(' '));
}

/** `Vapor::HTTPStatus` for a type `HTTPStatus`: a qualifier that names no project type is a module. */
function moduleQualified(owner: string, path: string, context: ResolutionContext): boolean {
  if (!path.endsWith(`::${owner}`)) return false;
  const head = path.slice(0, path.length - owner.length - 2);
  return !head.includes('::') && !context.getNodesByName(head).some((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind));
}

/**
 * The full path of the type a member is declared on. Its qualified name
 * starts at the outermost declaration in its file, and an extension is named
 * by its last segment — the members of `extension API.PackageController {
 * enum GetRoute { … } }` are `PackageController::GetRoute::…` — so the
 * outermost extension's written path is read back from its line. Null for a
 * top-level function.
 */
function ownerPath(member: Node, context: ResolutionContext): string | null {
  const memo = memoFor(context).owners;
  const hit = memo.get(member.id);
  if (hit !== undefined) return hit;
  const cut = member.qualifiedName.lastIndexOf('::');
  const path = cut < 0 ? null : writtenOwnerPath(member.qualifiedName.slice(0, cut), member, context);
  memo.set(member.id, path);
  return path;
}

/**
 * `path`, a prefix of `member`'s qualified name, with its outermost segment
 * read back as written when that segment is an `extension` of a nested type
 * enclosing `member` (`PackageController::GetRoute` → `API::PackageController::GetRoute`).
 */
function writtenOwnerPath(path: string, member: Node, context: ResolutionContext): string {
  const first = path.split('::')[0]!;
  const outer = context
    .getNodesInFile(member.filePath)
    .filter((t) => t.name === first && TYPE_KINDS.has(t.kind) && t.startLine <= member.startLine && t.endLine >= member.endLine)
    .reduce<Node | null>((out, t) => (!out || t.startLine < out.startLine ? t : out), null);
  const extended = outer ? extendedPath(outer, context) : null;
  return extended ? extended + path.slice(first.length) : path;
}

/** `extension API.PackageController {` → `API::PackageController`; null for anything but an extension of a nested type. */
function extendedPath(node: Node, context: ResolutionContext): string | null {
  if (!isSwiftExtension(node, context)) return null;
  const lines = linesOf(node.filePath, context);
  if (!lines) return null;
  const head = [(lines[node.startLine - 1] ?? '').slice(node.startColumn), ...lines.slice(node.startLine, node.startLine + 3)]
    .join(' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const written = /\bextension\s+((?:[A-Za-z_]\w*\s*\.\s*)+[A-Za-z_]\w*)/.exec(head)?.[1];
  return written ? written.replace(/\s+/g, '').split('.').join('::') : null;
}


/**
 * A static call on a type, `MyTool.main` or `API.Tool.main`: one or more
 * capitalized receiver segments, then the member. It covers both the
 * single-segment calls resolveSwiftTypeCall resolves (SWIFT_TYPE_CALL) and
 * the paths resolveSwiftTypePathCall does (SWIFT_TYPE_PATH_CALL), and also
 * a capitalized member after one segment (`Tool.Nested`), which neither claims.
 * `Self.x` names no type of its own.
 */
const SWIFT_TYPE_MEMBER_CALL = /^(?!Self\.)[A-Z]\w*(?:\.[A-Z]\w*)*\.[A-Za-z_]\w*$/;

/**
 * Anything a `Type.member` call can name when the project declares it: a
 * method, a case, a stored or static property (it may hold a closure), or a
 * nested type being constructed.
 */
const DECLARED_MEMBER_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>([
  'method', 'function', 'enum_member', 'property', 'field', 'variable', 'constant', ...TYPE_KINDS,
]);

/** A type's path as ownerPath writes a member's owner: `API::PackageController::GetRoute`. */
function typePath(type: Node, context: ResolutionContext): string {
  const owner = ownerPath(type, context);
  return owner === null ? type.name : `${owner}::${type.name}`;
}

/** Does a member's owner path name the type at `path` — as written, or module-qualified (`extension Kit.Tool`)? */
function isPath(owner: string, path: string, context: ResolutionContext): boolean {
  return owner === path || moduleQualified(path, owner, context);
}

/**
 * The path of the type a member is declared on. Its owner path, less the
 * methods the grammar can nest it under: an `if try await f(a,⏎ b) {` ends a
 * method late, so a member declared after it is indexed as
 * `Receiver::restore::receivedFacts`. A segment is dropped only where the
 * member's own file indexes a method or function of exactly that qualified
 * name around it, so the type left is the one that encloses the member. Null
 * when no type does (a top-level function). A method's real local function
 * (`func literal` inside `render`) is read the same way, as the type's: the
 * index does not tell the two apart, so resolveSwiftTypeCall declines both.
 */
function memberTypePath(member: Node, context: ResolutionContext): string | null {
  const memo = memoFor(context).typeOwners;
  const hit = memo.get(member.id);
  if (hit !== undefined) return hit;
  let path: string | null = null;
  const cut = member.qualifiedName.lastIndexOf('::');
  if (cut >= 0) {
    let prefix: string | null = member.qualifiedName.slice(0, cut);
    const inFile = context.getNodesInFile(member.filePath);
    const encloses = (qualifiedName: string): boolean =>
      inFile.some((n) => (n.kind === 'method' || n.kind === 'function') && n.qualifiedName === qualifiedName &&
        n.startLine <= member.startLine && n.endLine >= member.endLine);
    while (prefix !== null && encloses(prefix)) {
      const up = prefix.lastIndexOf('::');
      prefix = up < 0 ? null : prefix.slice(0, up);
    }
    path = prefix === null ? null : writtenOwnerPath(prefix, member, context);
  }
  memo.set(member.id, path);
  return path;
}

/**
 * The Swift node kinds a type inherits from or conforms to: a class, or a
 * protocol (a protocol_declaration is indexed as an `interface`). A struct or
 * enum is no supertype, so an `extends` edge onto one is not followed: a bare
 * entry naming an external type whose name a project struct or enum in
 * another target shares (`struct Y: Error` meaning Swift's, with a project
 * `enum Error`) holds an edge to that project type, which Swift could never
 * inherit from. (A qualified entry naming an external module's type gets no
 * edge at all: gateSwiftTypeTarget.) Onto a class it is the same edge, so
 * swiftSupertypeChain also asks who holds it.
 */
const SUPERTYPE_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['class', 'interface', 'protocol']);

/** The nodes of the type `decl` declares at `path`: `decl` and every `extension` of it, in any file. */
function typeNodesAt(decl: Node, path: string, context: ResolutionContext): Node[] {
  const nodes = [decl];
  for (const n of context.getNodesByName(decl.name)) {
    if (n.id === decl.id || n.language !== 'swift' || !isSwiftExtension(n, context)) continue;
    if (isPath(extendedPath(n, context) ?? n.qualifiedName, path, context)) nodes.push(n);
  }
  return nodes;
}

/**
 * The project's extensions of a type it does not declare, by the path each
 * extends: `extension View2 {}` under `View2` when the index holds no
 * declaration of `View2`. Empty when any project node of the name is a
 * declaration: a conformance to it resolves to that declaration instead.
 */
function extensionsOnly(name: string, context: ResolutionContext): Map<string, Node[]> {
  const byPath = new Map<string, Node[]>();
  const typed = context.getNodesByName(name).filter((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind));
  if (typed.length === 0 || !typed.every((n) => isSwiftExtension(n, context))) return byPath;
  for (const n of typed) {
    const path = extendedPath(n, context) ?? n.qualifiedName;
    const at = byPath.get(path);
    if (at) at.push(n);
    else byPath.set(path, [n]);
  }
  return byPath;
}

/**
 * Every name extensionsOnly maps to something: a name the project's Swift
 * nodes only extend. Each such name has an `extension` node, and an extension
 * is indexed as a `class`, so the Swift class nodes are all that is read.
 * ReferenceResolver's getUnresolvedSupertypeNames reads the unresolved
 * conformances to these names in one query: a conformance to any other name
 * gives swiftSupertypeChain nothing.
 */
export function swiftExtensionOnlyNames(context: ResolutionContext): string[] {
  const names: string[] = [];
  const asked = new Set<string>();
  for (const n of context.getNodesByKind('class')) {
    if (n.language !== 'swift' || asked.has(n.name) || !isSwiftExtension(n, context)) continue;
    asked.add(n.name);
    if (extensionsOnly(n.name, context).size > 0) names.push(n.name);
  }
  return names;
}

/**
 * The project supertypes and protocols of the type at `path` whose nodes
 * (its declaration and its extensions) are `roots`, transitively, nearest
 * first: each by its path, with its own declaration and extensions. Read from
 * the parse tree's inheritance clauses, never from the source text: each
 * node's own `extends`/`implements` references, so a nested type's clause
 * (`enum CodingKeys: String` inside `struct User`) is the nested type's, and a
 * conformance an extension declares (`extension Tool: Runner {}`) counts.
 *
 * - A reference that resolved: its target, when a class or a protocol
 *   (SUPERTYPE_KINDS), with that type's extensions. The edges exist by the
 *   time a call resolves: `extends`/`implements` references resolve first.
 *   A class target is followed only from a class declaration: a struct, an
 *   enum or an extension inherits from no class, so such an edge is a bare
 *   entry naming an external type landing on a project class of the same
 *   name (`struct Y: Error` with a project `class Error`); a protocol's
 *   class constraint (`protocol P: Kit`) is not walked either, as it cannot
 *   be told from that.
 * - A reference that resolved to nothing (getUnresolvedSupertypeNames, which
 *   reads only names swiftExtensionOnlyNames lists): the
 *   project's extensions of that name when it declares no such type
 *   (`struct HV: View` with only `extension View {}`), so the members they
 *   add still reach the conformer. From an enum declaration, a name in
 *   SWIFT_RAW_VALUE_TYPES is skipped: it is the enum's raw type
 *   (`enum K: String` with `extension String {}` does not give K String's
 *   members). A raw type outside that list (a project type expressible by a
 *   literal) the project only extends is still walked as a supertype.
 *
 * Every supertype is visited once, so an inheritance cycle ends the walk.
 */
function swiftSupertypeChain(roots: readonly Node[], path: string, context: ResolutionContext): Map<string, Node[]> {
  const chain = new Map<string, Node[]>();
  const seen = new Set<string>([path]);
  let frontier: readonly Node[] = roots;
  while (frontier.length > 0) {
    const next: Node[] = [];
    const visit = (supPath: string, nodes: () => Node[]): void => {
      if (seen.has(supPath)) return;
      seen.add(supPath);
      const at = nodes();
      chain.set(supPath, at);
      next.push(...at);
    };
    for (const n of frontier) {
      // Only a class declaration has a superclass; an extension is indexed as a class too.
      const inheritsClass = n.kind === 'class' && !isSwiftExtension(n, context);
      for (const sup of context.getSupertypeNodes?.(n.id) ?? []) {
        if (sup.language !== 'swift' || !SUPERTYPE_KINDS.has(sup.kind) || isSwiftExtension(sup, context)) continue;
        if (sup.kind === 'class' && !inheritsClass) continue;
        const supPath = typePath(sup, context);
        visit(supPath, () => typeNodesAt(sup, supPath, context));
      }
      for (const name of context.getUnresolvedSupertypeNames?.(n.id) ?? []) {
        // An enum's entry naming a stdlib raw-value type is its raw type, not
        // a supertype (SWIFT_RAW_VALUE_TYPES says why). An enum's extension is
        // indexed as a class, and an extension declares no raw type.
        if (n.kind === 'enum' && SWIFT_RAW_VALUE_TYPES.has(name)) continue;
        for (const [supPath, nodes] of extensionsOnly(name, context)) visit(supPath, () => nodes);
      }
    }
    frontier = next;
  }
  return chain;
}

/** The supertype in `chain` a member's owner path names, or undefined when it names none. */
function chainKey(owner: string, chain: ReadonlyMap<string, Node[]>, context: ResolutionContext): string | undefined {
  for (const supPath of chain.keys()) if (isPath(owner, supPath, context)) return supPath;
  return undefined;
}

/**
 * Does the project declare `member` on the type `decl` declares at `path`
 * (or an extension of it), or on one of its project supertypes and protocols
 * (or an extension of one)? A member of a type nested in it is not its
 * member: `Tool.Inner.main` is no `Tool.main`. A case whose name is a keyword
 * is indexed with its backticks (`` case `in`(…) `` is `` `in` ``) while the
 * call names it bare (`StoragePredicate.in(…)`), so both spellings are asked.
 */
function declaresMember(decl: Node, path: string, member: string, context: ResolutionContext): boolean {
  let chain: Map<string, Node[]> | null = null;
  return [member, `\`${member}\``].some((name) => context.getNodesByName(name).some((n) => {
    if (n.language !== 'swift' || !DECLARED_MEMBER_KINDS.has(n.kind)) return false;
    const owner = memberTypePath(n, context);
    if (owner === null) return false;
    if (isPath(owner, path, context)) return true;
    chain ??= swiftSupertypeChain(typeNodesAt(decl, path, context), path, context);
    return chainKey(owner, chain, context) !== undefined;
  }));
}

/**
 * A static call on one type, `TestHelpers.make()`: a capitalized receiver
 * segment, then a lowercase member. `Self.x` names no type of its own;
 * two or more receiver segments are SWIFT_TYPE_PATH_CALL's.
 */
export const SWIFT_TYPE_CALL = /^(?!Self\.)[A-Z]\w*\.[a-z_]\w*$/;

/**
 * What a single-segment `Type.member(…)` call lands on: a method or a free
 * function the grammar indexes under the type. A case or a static closure
 * property the type declares is not a target here (the call gets no edge).
 */
const TYPE_CALL_MEMBER_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>(['method', 'function']);

/**
 * `TestHelpers.make()` lands on the `make` the type `TestHelpers` declares:
 * its own, one an `extension TestHelpers` adds in any file, or one a project
 * supertype or a conformed protocol's extension supplies, as
 * swiftSupertypeChain walks them (never through a class reached from a
 * non-class). The receiver is
 * the project's declaration of that name (declarationFor): only one in a
 * module the caller's file can see (swiftStaticCallVisible: the caller's own
 * SwiftPM module, one its file imports, one a seen module re-exports with
 * `@_exported import`, or a declaration in no derivable module), a bare nested type only inside its scope, and of several such
 * copies the caller's own file's, else its nearest directory's. A copy in no
 * derivable module wins only where it would have won had the copies the
 * caller cannot see been kept (declarationFor).
 *
 * Matching by the member's name alone would bind a call on a namespace `enum`
 * to whichever type declares a member of that name, and an ArgumentParser
 * `MyTool.main()` to the project's only other `main` (`Other.main`). So once
 * the receiver is a project type, the call resolves on it or not at all:
 *
 * - the type declares no such method or function → null; when it declares
 *   no member of the name at all, the parked failure then gets
 *   swiftUnresolvedTypeMemberEdges' `references` edge to the type;
 * - the type does not declare it and two supertypes supply it, neither
 *   overriding the other (two protocols' extensions) → null; of an override
 *   chain (`Leaf: Middle: Base`, each class declaring it but `Leaf`), the
 *   nearest override, `Middle`'s, is the target (nearestOverrides);
 * - the only types of the name are nested types outside the caller's scope
 *   → null (Swift cannot name them bare there);
 * - every declaration of the type is in a module the caller's file neither
 *   belongs to, imports, nor sees re-exported → null, never a by-name match (the receiver is
 *   another module's type, or the SDK's: `SHA256` with `import CryptoKit`);
 * - several declarations of the type, none in the caller's file and none
 *   nearer it by directory → null.
 *
 * A candidate the index holds under a method or function of the type
 * (`Pred::render::literal`) is never a target. A local function of that
 * method is no member of the type, and the index cannot tell it from a later
 * member the grammar nested under an earlier method (tree-sitter-swift
 * 0.7.3: `Receiver::restore::receivedFacts`), which memberTypePath
 * reads as the type's. Such a member gets no `calls` edge until extraction
 * indexes it on its type.
 *
 * `undefined` leaves the call to the name matcher: no project type of the
 * name (`JSONDecoder.make()`, a capitalized variable), an alias whose
 * aliased type the index does not hold, or a `private` type of another file
 * (Swift cannot see it there, so the receiver is something else).
 *
 * Of the type's own overloads, those of `decl`'s copy (ofDeclaration): its
 * body's, and its extensions' in any file, but none in the body of another
 * module's copy of the type or nearer that copy by directory than `decl`.
 * Of several overloads left, those whose parameter lists the call's argument
 * labels fit (`fitsLabels`, the name matcher's label reading); when it finds
 * none, all of them. Then `decl`'s body's before its extensions', and the
 * earliest by file path and line.
 */
export function resolveSwiftTypeCall(
  ref: UnresolvedRef,
  context: ResolutionContext,
  fitsLabels: (member: Node) => boolean | null,
): ResolvedRef | null | undefined {
  const name = ref.referenceName;
  const dot = name.indexOf('.');
  const typeName = name.slice(0, dot);
  const member = name.slice(dot + 1);
  const projectTypes = context.getNodesByName(typeName)
    .filter((n) => n.language === 'swift' && TYPE_KINDS.has(n.kind) && !isSwiftExtension(n, context));
  if (projectTypes.length === 0) return undefined;
  const from = context.getNodeById?.(ref.fromNodeId) ?? null;
  // Only a declaration in a module the caller's file can see is a receiver;
  // with none left the type is another module's (or the SDK's): no edge.
  const decl = declarationFor(typeName, typeName, ref, from, context, (d) => swiftStaticCallVisible(d, ref.filePath, context));
  if (!decl) return null;
  if (decl.kind === 'type_alias') return undefined;
  if (decl.visibility === 'private' && decl.filePath !== ref.filePath) return undefined;

  const path = typePath(decl, context);
  const own: Node[] = [];
  const inherited: Node[] = [];
  let chain: Map<string, Node[]> | null = null;
  // A member named by a keyword is indexed with its backticks
  // (`` func `default`() ``) while the call names it bare, so both spellings are asked.
  for (const n of [...context.getNodesByName(member), ...context.getNodesByName(`\`${member}\``)]) {
    if (n.language !== 'swift' || !TYPE_CALL_MEMBER_KINDS.has(n.kind)) continue;
    const owner = memberTypePath(n, context);
    if (owner === null) continue;
    // memberTypePath read past an enclosing method or function: a local
    // function, or a member the grammar misnested (see above). Declined.
    if (owner !== ownerPath(n, context)) continue;
    if (isPath(owner, path, context)) {
      own.push(n);
      continue;
    }
    chain ??= swiftSupertypeChain(typeNodesAt(decl, path, context), path, context);
    if (chainKey(owner, chain, context) !== undefined) inherited.push(n);
  }
  let fit: Node[];
  if (own.length > 0) {
    // Every owner here is the type's path, as written or module-qualified
    // (`extension Kit.Cache`), so the owners are not compared.
    fit = ofDeclaration(own, decl, projectTypes, path, context);
  } else {
    // A member of the type itself shadows one it inherits, and so does an
    // override down the chain: of `Base.make` and `Middle.make` for
    // `Leaf: Middle: Base`, an owner another candidate's owner inherits from
    // (Base, under Middle) drops out. Owners left that are not related this
    // way (two protocols' extensions) cannot be told apart: no edge.
    fit = chain ? nearestOverrides(inherited, chain, context) : [];
    if (new Set(fit.map((n) => memberTypePath(n, context))).size > 1) return null;
    // A supertype several modules declare: its members nearest `decl` by directory.
    const near = Math.max(...fit.map((n) => sharedDirs(n.filePath, decl.filePath)));
    fit = fit.filter((n) => sharedDirs(n.filePath, decl.filePath) === near);
  }
  if (fit.length === 0) return null;
  if (fit.length > 1) {
    const labelled = fit.filter((n) => fitsLabels(n) === true);
    if (labelled.length > 0) fit = labelled;
    const inBody = fit.filter((n) => declaredIn(n, decl));
    if (inBody.length > 0) fit = inBody;
  }
  const target = fit.reduce((a, b) => (a.filePath < b.filePath || (a.filePath === b.filePath && a.startLine <= b.startLine) ? a : b));
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'qualified-name' };
}

/** Whether `member` lies in the body of the type declaration `type`. */
function declaredIn(member: Node, type: Node): boolean {
  return member.filePath === type.filePath && member.startLine >= type.startLine && member.endLine <= type.endLine;
}

/**
 * The members of the type at `path` (`members`: its body's and its
 * extensions') that belong to `decl`'s copy of it. The other copies are the
 * project's other declarations of the name (`types`, extensions excluded) in
 * other files at that same path; an alias is not one. With none, all the
 * members, in any file. Else those in `decl`'s body, and of the rest (an
 * extension's) those outside every other copy's body and no nearer another
 * copy by directory than `decl`.
 */
function ofDeclaration(members: Node[], decl: Node, types: readonly Node[], path: string, context: ResolutionContext): Node[] {
  const copies = types.filter((t) => t.filePath !== decl.filePath && t.kind !== 'type_alias' && typePath(t, context) === path);
  if (copies.length === 0) return members;
  return members.filter((n) => {
    if (declaredIn(n, decl)) return true;
    if (copies.some((c) => declaredIn(n, c))) return false;
    const mine = sharedDirs(n.filePath, decl.filePath);
    return copies.every((c) => sharedDirs(n.filePath, c.filePath) <= mine);
  });
}

/**
 * The inherited candidates no other candidate overrides: a member whose
 * owner is a supertype of another candidate's owner drops out, so
 * `Middle.make` stays and `Base.make` goes for `Leaf: Middle: Base`. Each
 * owner is a supertype in `chain` (the receiver's swiftSupertypeChain), and
 * what it inherits is the same walk from that supertype's own nodes, never
 * every type that shares its name. Owners neither of which inherits from the
 * other both stay.
 */
function nearestOverrides(inherited: Node[], chain: ReadonlyMap<string, Node[]>, context: ResolutionContext): Node[] {
  const ownerKey = (n: Node): string | undefined => chainKey(memberTypePath(n, context)!, chain, context);
  const owners = new Set(inherited.map(ownerKey));
  if (owners.size < 2) return inherited;
  const ancestors = new Map<string | undefined, ReadonlySet<string>>();
  for (const o of owners) ancestors.set(o, o === undefined ? new Set() : new Set(swiftSupertypeChain(chain.get(o)!, o, context).keys()));
  const overridden = new Set([...owners].filter((o) => o !== undefined && [...owners].some((other) => other !== o && ancestors.get(other)!.has(o))));
  return inherited.filter((n) => !overridden.has(ownerKey(n)));
}

/**
 * `references` edges for Swift static calls whose member is external:
 * `MyTool.main()` with `struct MyTool: ParsableCommand`, `Todo.query(on:)`
 * with `final class Todo: Model`. The member is the library's, so the call
 * fails to resolve, but the receiver is a project type the caller depends on.
 *
 * `refs` are final failures (not deferred attempts). A ref gets an edge to
 * its receiver's declaration when:
 *
 * - exactly one project declaration fits the receiver as written (an
 *   `extension X {}` is never it; a nested type named bare only in scope;
 *   only a declaration in a module the caller's file can see, by
 *   swiftStaticCallVisible — see declarationFor);
 * - the caller can see it: a `private` or `fileprivate` type is visible in
 *   its own file only, so a local `var W = [Float]()` in another file is not
 *   the type;
 * - it is not a `typealias`: the index does not hold what an alias names, so
 *   whether that type declares the member cannot be told;
 * - and the project does not declare the member on the type, its extensions,
 *   or its project supertypes and protocols and their extensions
 *   (declaresMember).
 *
 * Every rule here can only suppress an edge; none aims one anywhere but the
 * receiver's own declaration.
 *
 * Known limits (pinned in swift-external-member-ref.test.ts):
 * - an alias receiver gets no edge at all (the `typealias` rule above);
 * - a local or parameter that shadows a project type's name cannot be told
 *   from the type: Swift locals/params are not indexed, so it gets the edge;
 * - when a later sync makes the call resolve (a new extension declares the
 *   member), the retry resolves the call but nothing takes back the parked
 *   `references` edge;
 * - a member the extraction does not index (for one, a member of an
 *   extension the parse ends early) reads as external, so the receiver gets
 *   the edge;
 * - a supertype written with the project's own module name (`MyModule.Base`,
 *   where no qualifier segment names a project type) gets no edge:
 *   gateSwiftTypeTarget cannot tell that module from an external one, so it
 *   gives every such entry no target (`Swift.Error` and
 *   `Foundation.Operation` with a project `Error` / `Operation` are pinned to
 *   no edge in swift-qualified-inheritance.test.ts, tests g and h);
 * - a module-qualified conformance to a type the project only extends
 *   (`struct HV: SwiftUI.View2` with a project `extension View2`) is
 *   recorded as `SwiftUI.View2`, and the extension-only walk
 *   (swiftSupertypeChain) matches supertype names exactly, so the extension's
 *   members do not reach HV (swift-static-calls.test.ts, `it.fails`);
 * - the module rule reads the index's `import` nodes (the caller file's, and
 *   every `@_exported import` of a module it sees) and the SwiftPM directory
 *   layout, never Package.swift, so a SwiftPM target whose Package.swift
 *   `path:` gives it a module name different from its directory is matched
 *   by its directory's name: an import of its real name does not see it, so
 *   a genuine edge is dropped (silent beats wrong). Not pinned.
 *
 * The edge carries no `refName`: an edge with one is turned back into a
 * pending ref when its target is deleted (resurrect-ref.ts), which would
 * duplicate the failed `calls` row that is still parked for the same site.
 */
export function swiftUnresolvedTypeMemberEdges(refs: readonly UnresolvedRef[], context: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.language !== 'swift' || ref.referenceKind !== 'calls') continue;
    const name = ref.referenceName;
    if (!SWIFT_TYPE_MEMBER_CALL.test(name)) continue;
    const dot = name.lastIndexOf('.');
    const receiver = name.slice(0, dot);
    const member = name.slice(dot + 1);
    const typeName = receiver.slice(receiver.lastIndexOf('.') + 1);
    const from = context.getNodeById?.(ref.fromNodeId) ?? null;
    const decl = declarationFor(typeName, receiver, ref, from, context, (d) => swiftStaticCallVisible(d, ref.filePath, context));
    if (!decl || decl.kind === 'type_alias') continue;
    if (decl.visibility === 'private' && decl.filePath !== ref.filePath) continue;
    if (declaresMember(decl, typePath(decl, context), member, context)) continue;
    const key = `${ref.fromNodeId}\0${decl.id}\0${ref.line}\0${ref.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: ref.fromNodeId,
      target: decl.id,
      kind: 'references',
      line: ref.line,
      column: ref.column,
      provenance: 'heuristic',
      // 0.8, below the 0.9 of a Swift qualified-name resolution: the edge names the type, not the member called.
      metadata: { resolvedBy: 'swift-external-member', confidence: 0.8 },
    });
  }
  return edges;
}
