/**
 * F# scope: which declarations a name written in one file can mean.
 *
 * F# has no ambient project-wide namespace. What a name binds to depends on how
 * it is written:
 * - unqualified (`helper`): a scope enclosing the reference (in this file or another), the
 *   contents of a namespace or module the file `open`s (an `[<AutoOpen>]`
 *   module inside an opened one included), or `namespace global`. A module that
 *   merely sits inside an opened namespace is not opened, a type's members are
 *   never in scope bare, and neither is the case of a .NET-style `enum`;
 * - through a module or type (`Calc.helper`, `Other.Lib.Fn.helper`, a module
 *   alias): the container whose full path that is, taken as written, relative
 *   to an `open`, or relative to a scope enclosing the reference;
 * - through a value (`x.Add`), or a chain of properties (`Settings.Current.Save`):
 *   a member of the value's type, then of what that type inherits. The type is
 *   the one the value's binding states: a local's, as the extractor read it from
 *   the syntax tree (the reference's `receiver`), or a declaration's — a
 *   module's or a class's `let`, a function, a member — its `returnType`, read
 *   where that declaration is written. A member of a value the source does not
 *   type is never guessed.
 *
 * The extractor records each name as written (`Calc.helper`, `r.Save`, `_.Add`
 * for a member on an expression) at the name itself, so the resolver reads no
 * source text to find a qualifier.
 *
 * A same-named function in a namespace none of that reaches — `map`, `bind`,
 * `format` — is never what the name means.
 *
 * Another .NET language names an F# declaration as .NET sees it
 * (`fsharpDotnetDeclaration`): a module is a static class, a namespace a
 * namespace. Which declaration a C# or Razor name means is C#'s lookup to
 * decide (./dotnet-lookup), over C#'s declarations and these together; no
 * name of another language is matched to an F# declaration here.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { fsharpNames } from '../extraction/fsharp-lexer';
import { fsprojCompileItems } from './msbuild';
import {
  readFileFacts,
  siteKeyOf,
  type ArgumentType,
  type FsharpParameter,
  type FsharpPosition,
  type FsharpSite,
  type WrittenType,
} from '../extraction/languages/fsharp-store';

/** Reference kinds that name a declaration (an `open` names a namespace, which is not a symbol). */
const SYMBOL_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  'calls',
  'references',
  'extends',
  'implements',
  'instantiates',
  'type_of',
  'returns',
  'overrides',
  'decorates',
]);

/** Candidates that are bookkeeping rather than named symbols. */
const NON_SYMBOL_KINDS: ReadonlySet<string> = new Set(['file', 'namespace', 'import', 'export']);

/** What a type owns: reached through a value or a type name, never bare. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field']);

/** A type's member, not a class's `let` binding (which the extractor records as a method or field marked `let`). */
function isTypeMember(node: Node): boolean {
  return MEMBER_KINDS.has(node.kind) && node.decorators?.[0] !== 'let';
}

/** Languages an F# name can be written against: its own and the other .NET ones. */
const SCOPED_LANGUAGES: ReadonlySet<string> = new Set(['fsharp', 'csharp']);

/** The kinds that are types and modules: what holds other declarations. */
const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'union', 'enum', 'type_alias', 'module']);

/** Scopes whose own contents sit inside them: a reference written in one is relative to it. */
const OWN_SCOPE_KINDS: ReadonlySet<string> = new Set(['namespace', 'module', 'class', 'struct', 'interface', 'union', 'enum']);

/** Declarations directly in `namespace global` are visible from every file, and the namespace is always open. */
const GLOBAL_NAMESPACE = 'global';

/** Where a reference is written, and what its file brings into reach. */
export interface FsharpRefScope {
  /** The file the reference is written in. */
  filePath?: string;
  /** Dotted path of the scopes around the reference. */
  container: string;
  /** The namespace the reference's file declares it in. */
  namespace: string;
  /** Paths the file opens. */
  opens: readonly string[];
  /** Types the file opens with `open type`: their static members, nested types and union cases are in scope bare. */
  openTypes?: readonly string[];
  /** The full paths the opens name, read against what the project declares, with the line each is opened on. */
  openedPaths?: readonly { path: string; line: number }[];
  /** Qualifiers the name is written with, aliases expanded: `Calc` in `Calc.helper`, `x` in `x.Add`. */
  qualifiers: readonly string[];
  /** The name is written on a local value (`r.Save`, `(f x).Add`), not through a module or type. */
  onValue?: boolean;
  /** The name is written through a path whose head the project does not declare: `System.Threading.Tasks.Task.Run`. */
  externalQualifier: boolean;
  /**
   * When the name is a member written on a value (`r.Add`, `this.Step`,
   * `Settings.Current.Save`): the dotted paths of the value's type and of the
   * types it inherits or implements, as F# types it — a self identifier, a
   * parameter's annotation, a `let` or `use` bound to a constructor or
   * annotated. Null when that type is not known: then no member is meant.
   */
  receivers?: readonly string[] | null;
}

/** Where a candidate is declared. */
export interface FsharpCandidateScope {
  name: string;
  /** Dotted path of the scopes and types around it. */
  container: string;
  /** The namespace its file declares it in. */
  namespace: string;
  kind: string;
  /** Containers whose opening exposes it unqualified: its own, and what an `[<AutoOpen>]` chain adds. */
  holders: readonly string[];
  /** The `[<AutoOpen>]` modules among the scopes around it. */
  autoOpened: readonly string[];
  /** A class's `let` binding: in scope bare inside its type, where the type's members are not. */
  classLet?: boolean;
  /** A static member, which `open type` brings into scope bare. */
  isStatic?: boolean;
}

/**
 * The dotted path of the namespaces / modules / types around a node:
 * `Shop.Core::Calc::helper` → `Shop.Core.Calc`. Empty for a node declared at
 * the top of a script, outside any namespace or module.
 */
function fsharpContainerOf(qualifiedName: string): string {
  const segments = qualifiedName.split('::');
  return segments.slice(0, -1).join('.');
}

/** The module a file that declares no namespace or module puts its top level in, named after the file (`a.fsx` → `A`). */
function implicitModule(filePath: string): string {
  const stem = (filePath.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');
  return stem === '' ? '' : stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** The container of a node, the implicit module of its file when it has none. */
function containerOfNode(node: Node): string {
  return fsharpContainerOf(node.qualifiedName) || implicitModule(node.filePath);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/** `A.B.C` → ['', 'A', 'A.B', 'A.B.C']: the scopes a name written in `A.B.C` can be relative to. */
function scopePrefixes(container: string): string[] {
  const parts = container === '' ? [] : container.split('.');
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('.'))];
}

function parentPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(0, dot);
}

function joinPath(prefix: string, rest: string): string {
  return prefix === '' ? rest : `${prefix}.${rest}`;
}


/**
 * The full paths a file's `open`s, in order, can name: each read relative to the
 * scopes around the reference, and to what the `open`s before it opened —
 * `open Shop` then `open Core` opens the module `Shop.Core` (F# refuses that
 * for a namespace, FS0893, so code that compiles names a module there).
 */
function openedPaths(
  prefixes: readonly string[],
  opens: readonly { name: string; line: number }[],
  declared?: ReadonlySet<string>,
): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  // `namespace global` is around every file: `open Util` opens its module `Util`.
  const bases: string[] = [...prefixes, GLOBAL_NAMESPACE];
  for (const { name, line } of opens) {
    const reached = [...new Set(bases.map((base) => joinPath(base, name)))];
    // An `open` names one namespace or module: of the paths it could be, the ones the project
    // declares, else the path as written (a namespace outside the project, `open System.Text`).
    // Without the project's declarations at hand, every reading is kept, and none is built on.
    const opened = declared ? reached.filter((p) => declared.has(p)) : reached;
    for (const path of opened.length > 0 ? opened : [name]) out.push({ path, line });
    if (declared) for (const path of opened) if (!bases.includes(path)) bases.push(path);
  }
  return out;
}

const FSHARP_FILES = new WeakMap<ResolutionContext, string[]>();

/**
 * The project's indexed F# files — by the language each was indexed as, so a
 * `codegraph.json` extension mapping counts — listed once per context: a
 * project without any pays nothing for F#.
 */
function fsharpFiles(context: ResolutionContext): string[] {
  let files = FSHARP_FILES.get(context);
  if (!files) FSHARP_FILES.set(context, (files = indexedFsharpFiles(context)));
  return files;
}

function indexedFsharpFiles(context: ResolutionContext): string[] {
  return context.getFilePathsOfLanguage?.('fsharp') ?? context.getNodesByKind('file').filter((n) => n.language === 'fsharp').map((n) => n.filePath);
}

/** Whether the project has F# code at all. */
export function hasFsharpFiles(context: ResolutionContext): boolean {
  return fsharpFiles(context).length > 0;
}

/** The F# declarations of the given kinds, read from the F# files alone. */
function fsharpNodesOfKinds(kinds: ReadonlySet<string>, context: ResolutionContext): Node[] {
  return fsharpFiles(context).flatMap((f) => context.getNodesInFile(f).filter((n) => n.language === 'fsharp' && kinds.has(n.kind)));
}

const DECLARED_SCOPES = new WeakMap<ResolutionContext, Set<string>>();

/** The dotted paths of every namespace and module the project declares, and of the namespaces around them. */
function declaredScopes(context: ResolutionContext): Set<string> {
  let paths = DECLARED_SCOPES.get(context);
  if (paths) return paths;
  paths = new Set();
  for (const kind of ['namespace', 'module'] as const) {
    for (const n of context.getNodesByKind(kind)) {
      if (!SCOPED_LANGUAGES.has(n.language)) continue;
      const full = n.qualifiedName.split('::').join('.');
      for (const prefix of scopePrefixes(full)) if (prefix !== '') paths.add(prefix);
    }
  }
  DECLARED_SCOPES.set(context, paths);
  return paths;
}

const RESOLVED_SCOPES = new WeakMap<object, { prefixes: string[]; opens: Set<string>; openTypes: Set<string> }>();

/**
 * The scopes around a reference and its opens, the latter also read relative to
 * those scopes (`open Core` in `namespace Shop`). They depend on where the
 * reference is, not on what it is written through: the scopes derived from one
 * (`{ ...scope, qualifiers }`) share its `openedPaths`, and the reading with it.
 */
function resolvedScopes(ref: FsharpRefScope): { prefixes: string[]; opens: Set<string>; openTypes: Set<string> } {
  const key: object = ref.openedPaths ?? ref;
  const cached = RESOLVED_SCOPES.get(key);
  if (cached) return cached;
  const prefixes = scopePrefixes(ref.container);
  const opened = ref.openedPaths ?? openedPaths(prefixes, ref.opens.map((name) => ({ name, line: 0 })));
  const opens = new Set<string>(opened.map(({ path }) => path));
  // `open type T` names `T` as written, relative to the scopes around the reference and to what is opened.
  const openTypes = new Set<string>();
  for (const name of ref.openTypes ?? []) for (const base of [...prefixes, ...opens]) openTypes.add(joinPath(base, name));
  const resolved = { prefixes, opens, openTypes };
  RESOLVED_SCOPES.set(key, resolved);
  return resolved;
}

/**
 * Pure rule: can a name written as `ref` says mean a declaration placed as
 * `candidate` says? A type's own members are bare-visible inside it, in its file.
 */
export function isFsharpCandidateReachable(ref: FsharpRefScope, candidate: FsharpCandidateScope, sameFile = false): boolean {
  const c = candidate.container;
  if (c === '') return false;
  if (c === GLOBAL_NAMESPACE) return true;

  const { prefixes, opens, openTypes } = resolvedScopes(ref);
  const isMember = MEMBER_KINDS.has(candidate.kind);

  // What a qualifier can start from: the scopes around the reference, its opens, and
  // what an `[<AutoOpen>]` module opens in turn (`open Core` brings in `Core.Domain.AgentName`).
  const exposed = (path: string): boolean =>
    path === '' || path === GLOBAL_NAMESPACE || prefixes.includes(path) || opens.has(path) || (candidate.autoOpened.includes(path) && exposed(parentPath(path)));
  // A qualifier the tree shows to be a local value names no module or type.
  const viaContainer = ref.onValue ? [] : ref.qualifiers;
  if (viaContainer.length > 0) {
    const through = (path: string, q: string): boolean =>
      path === q || (path.endsWith(`.${q}`) && exposed(path.slice(0, path.length - q.length - 1)));
    // A union case is written through its type (`Shape.Circle`) or through the module or
    // namespace its type is declared in (`Box.Circle`): its holders.
    const paths = candidate.kind === 'enum_member' ? [c, ...candidate.holders] : [c];
    if (viaContainer.some((q) => paths.some((path) => through(path, q)))) return true;
  }
  if (ref.externalQualifier) return false;

  // A member on a value (`r.Add`, a module's `repo.Save`), or on a chain of properties from a name
  // (`Settings.Current.Save`), is a member of the value's type, as F# types the value: its type, or one that type inherits.
  if (ref.qualifiers.length > 0) return isMember && ref.receivers?.includes(c) === true;

  // Bare name: a member is never in scope — inside its own type too, where it is reached
  // through the self identifier (`this.M`) — but a class's `let` is, inside that type;
  // anything else only through an enclosing scope or an opened one.
  if (isMember) return (candidate.classLet === true && sameFile && isPathPrefix(c, ref.container)) || (candidate.isStatic === true && openTypes.has(c));
  return openTypes.has(c) || candidate.holders.some((h) => opens.has(h) || isPathPrefix(h, ref.container));
}

/**
 * An F# declaration as .NET sees it, which is what another .NET language
 * writes: the namespace it is in; the module or type that holds it, where an
 * F# module is a static class; its metadata name — `<M>Module` for a module
 * beside a type of its name or one carrying
 * `[<CompilationRepresentation(ModuleSuffix)>]`, a `[<CompiledName>]`,
 * `New<Case>` for a union case with fields — without the type-parameter count
 * a generic type's metadata name ends in (``Wrapped`1``); and whether it is
 * static, as a module and everything it holds are.
 */
export interface DotnetDeclaration {
  /** The namespace it is declared in, `''` for the global one. */
  namespace: string;
  /** The module or type that holds it; null for one declared directly in a namespace. A file stands for the module its top level compiles into. */
  owner: Node | null;
  name: string;
  /** A type or a module, rather than a member of one. */
  isType: boolean;
  /** The type parameters .NET gives a type — a unit of measure is none; null for a member, and where the index does not say. */
  typeParameters: number | null;
  isStatic: boolean;
}

interface FileScope {
  /** Paths the file opens: `open X`. */
  opens: { node: Node; owner?: Node }[];
  /** Types the file opens: `open type X`. */
  openTypes: { node: Node; owner?: Node }[];
  /** Module abbreviations, with the lexical scope that owns them. */
  aliases: { node: Node; owner?: Node }[];
  /** Namespaces, modules and enums of the file by their qualified name. */
  scopes: Map<string, Node>;
  /** The same by dotted path: a file-level `module A.B.C` is one segment of the qualified name. */
  byPath: Map<string, Node>;
  /**
   * Qualified names of the file's types whose cases are written through them:
   * .NET-style enums and unions marked `[<RequireQualifiedAccess>]`. A module
   * of the type's name shares its qualified name, and its attributes are its own.
   */
  requireQualified: Set<string>;
}

function containsPosition(node: Node, line: number, column: number): boolean {
  return (line > node.startLine || (line === node.startLine && column >= node.startColumn)) &&
    (line < node.endLine || (line === node.endLine && column <= node.endColumn));
}

/** An open or abbreviation applies only after its declaration, inside its owner. */
function importApplies(entry: { node: Node; owner?: Node }, ref: UnresolvedRef): boolean {
  return (ref.line > entry.node.endLine || (ref.line === entry.node.endLine && ref.column >= entry.node.endColumn)) &&
    (!entry.owner || containsPosition(entry.owner, ref.line, ref.column));
}

const FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, FileScope>>();

/** What a file says about names, read once per resolution context. */
function fileScopeOf(filePath: string, context: ResolutionContext): FileScope {
  let perFile = FILE_SCOPES.get(context);
  if (!perFile) FILE_SCOPES.set(context, (perFile = new Map()));
  const cached = perFile.get(filePath);
  if (cached) return cached;
  const scope: FileScope = { opens: [], openTypes: [], aliases: [], scopes: new Map(), byPath: new Map(), requireQualified: new Set() };
  const nodes = context.getNodesInFile(filePath);
  const containers = nodes.filter((n) => n.kind === 'module' || n.kind === 'namespace');
  for (const n of nodes) {
    const qualifiedCases = n.kind === 'enum' || (n.kind === 'union' && n.decorators?.some((d) => isAttribute(attributeOf(d).name, 'RequireQualifiedAccess')));
    if (qualifiedCases) scope.requireQualified.add(n.qualifiedName);
    if (n.kind === 'module' || n.kind === 'enum' || n.kind === 'namespace') {
      scope.scopes.set(n.qualifiedName, n);
      scope.byPath.set(n.qualifiedName.split('::').join('.'), n);
    }
    if (n.kind !== 'import') continue;
    // Import qualifiedName deliberately names its target, so recover the
    // lexical owner from source ranges rather than that qualifiedName.
    const owner = containers.filter((c) => containsPosition(c, n.startLine, n.startColumn))
      .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
    if (n.signature) scope.aliases.push({ node: n, owner });
    else if (n.decorators?.includes('type')) scope.openTypes.push({ node: n, owner });
    // `#load "a.fsx"` is an import node too, but names a file, not a scope.
    else if (!/[.]fsx?$/i.test(n.name)) scope.opens.push({ node: n, owner });
  }
  perFile.set(filePath, scope);
  return scope;
}

const isAutoOpen = (module: Node | undefined): boolean => module?.kind === 'module' && module.decorators?.some((d) => isAttribute(attributeOf(d).name, 'AutoOpen')) === true;

/**
 * The segments of a written name path: `Calc.helper` → ['Calc', 'helper']. A
 * dot inside ``a.b`` or an operator's parentheses (`(+.)`) belongs to the name.
 */
function pathSegments(written: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < written.length; i++) {
    if (written.startsWith('``', i)) {
      quoted = !quoted;
      i++;
    } else if (!quoted) {
      if (written[i] === '(') depth++;
      else if (written[i] === ')') depth--;
      else if (written[i] === '.' && depth === 0) {
        segments.push(written.slice(start, i));
        start = i + 1;
      }
    }
  }
  segments.push(written.slice(start));
  return segments;
}

/**
 * The qualifier a reference is written with — what its name, as the extractor
 * records it, carries before its last segment — its head a module alias
 * expanded to what it names (`module F = Other.Lib.Fn`): `Calc` of
 * `Calc.helper`, `r` of `r.Save`, `_` of a member on an expression (`_.Add`).
 * None for a bare name, an operator or a record expression.
 */
function writtenQualifiers(ref: UnresolvedRef, aliases: ReadonlyMap<string, string>, context: ResolutionContext): string[] {
  const written = writtenOf(ref, context);
  if (!written || written.position === 'record') return [];
  const segments = written.path;
  if (segments.length < 2) return [];
  const [head = '', ...rest] = segments.slice(0, -1);
  const target = aliases.get(head);
  return [target ? [target, ...rest].join('.') : [head, ...rest].join('.')];
}

const DECLARED_NAMESPACES = new WeakMap<ResolutionContext, Map<string, string>>();

/**
 * The namespace a node's file declares it in. `namespace A.B` is `A.B`; a
 * top-level `module A.B` sits in namespace `A`, and a bare `module M` in none.
 */
function declaredNamespace(node: Node, context: ResolutionContext): string {
  const head = node.qualifiedName.split('::')[0] ?? '';
  let perContext = DECLARED_NAMESPACES.get(context);
  if (!perContext) DECLARED_NAMESPACES.set(context, (perContext = new Map()));
  const key = `${node.filePath}|${head}`;
  const cached = perContext.get(key);
  if (cached !== undefined) return cached;
  const scope = fileScopeOf(node.filePath, context).scopes.get(head);
  const dot = scope ? scope.name.lastIndexOf('.') : -1;
  const namespace = !scope || scope.kind === 'enum' ? '' : scope.kind === 'namespace' ? scope.name : dot > 0 ? scope.name.slice(0, dot) : '';
  perContext.set(key, namespace);
  return namespace;
}

/** A dotted path written on no local value that no project declaration ends in: `System.Threading.Tasks.Task`, though `Settings.Current` may be. */
function isExternalPath(qualifier: string, onValue: boolean, context: ResolutionContext): boolean {
  if (!qualifier.includes('.') || onValue) return false;
  const last = qualifier.slice(qualifier.lastIndexOf('.') + 1);
  return !context.getNodesByName(last).some((n) => {
    const path = n.qualifiedName.split('::').join('.');
    return path === qualifier || path.endsWith(`.${qualifier}`);
  });
}

/** What a reference says about where it is written, read once for all of its candidates. */
const REF_SCOPES = new WeakMap<UnresolvedRef, FsharpRefScope>();

function scopeOfRef(ref: UnresolvedRef, context: ResolutionContext): FsharpRefScope {
  const cached = REF_SCOPES.get(ref);
  if (cached) return cached;
  const file = fileScopeOf(ref.filePath, context);
  const from = context.getNodeById?.(ref.fromNodeId) ?? context.getNodesInFile(ref.filePath).find((n) => n.id === ref.fromNodeId);
  // A scope is the one its own contents sit in; what is written at the top of a file sits in its implicit module.
  const container = !from || from.kind === 'file'
    ? implicitModule(ref.filePath)
    : OWN_SCOPE_KINDS.has(from.kind)
      ? from.qualifiedName.split('::').join('.')
      : containerOfNode(from);
  const opens = file.opens.filter((entry) => importApplies(entry, ref));
  const aliases = new Map(file.aliases.filter((entry) => importApplies(entry, ref)).map(({ node }) => [node.name, node.signature!]));
  const qualifiers = writtenQualifiers(ref, aliases, context);
  const written = writtenOf(ref, context);
  const onValue = written?.onValue === true;
  const scope: FsharpRefScope = {
    filePath: ref.filePath,
    container,
    namespace: from && from.kind !== 'file' ? declaredNamespace(from, context) : '',
    opens: opens.map(({ node }) => node.name),
    openTypes: file.openTypes.filter((entry) => importApplies(entry, ref)).map(({ node }) => node.name),
    openedPaths: openedPaths(scopePrefixes(container), opens.map(({ node }) => ({ name: node.name, line: node.endLine })), declaredScopes(context)),
    qualifiers,
    onValue,
    externalQualifier: qualifiers.length > 0 && qualifiers.every((q) => isExternalPath(q, onValue, context)),
  };
  REF_SCOPES.set(ref, scope);
  // What a member written on the qualifier belongs to is read only when a member is among the candidates.
  if (qualifiers.length > 0) {
    let receivers: string[] | null | undefined;
    Object.defineProperty(scope, 'receivers', {
      get: () => {
        // While it is being read, a copy of this scope reads none.
        if (receivers === undefined) {
          receivers = null;
          receivers = receiversOf(written, qualifiers[0]!, scope, context);
        }
        return receivers;
      },
      enumerable: true,
    });
  }
  return scope;
}

/** How far a value's type is followed through what other declarations return. */
const MAX_TYPE_DEPTH = 6;

/**
 * The types a member written on a value can belong to (`r.Save`, `this.Step`,
 * `Settings.Current.Save`), nearest first: the value's own type, then what it
 * inherits, then the type extensions in scope. The value's type is the one the
 * extractor read from its binding (the reference's `receiver`: `Repo` for
 * `r: Repo`), else, for a path to a module value, what that value's declaration
 * says it holds; a path that names a type is none. Null when F# would know it
 * and the source does not say.
 */
function receiversOf(written: FsharpSite | null, qualifier: string, scope: FsharpRefScope, context: ResolutionContext): string[] | null {
  // A local value's type is what its binding states; a path from a name is evaluated as F# would.
  // A path that names a type is no value: what is written through it is the type's static member.
  const onValue = written?.onValue === true;
  if (!onValue && reachableTypes(qualifier, scope, context).length > 0) return null;
  const owner = onValue ? written?.receiverType : qualifier;
  if (owner === undefined) return null;
  const owners = [owner];
  const paths: string[] = [];
  const add = (path: string): void => {
    if (!paths.includes(path)) paths.push(path);
  };
  const extended = new Set<string>();
  for (const owner of owners) {
    const types = typesOfPath(owner, scope, context, 0);
    for (const path of typeAndAncestors(types, context)) add(path);
    for (const type of types) extended.add(type.name);
    if (types.length === 0) extended.add(lastSegmentOf(owner));
  }
  // `type System.String with member s.Shout() = …` adds members to a type, a project's or not,
  // where the extension is in scope.
  for (const name of extended) for (const path of visibleExtensions(name, scope, context)) add(path);
  return paths.length > 0 ? paths : null;
}

/** The dotted paths of `types` and of what they inherit or implement, each type before its ancestors. */
function typeAndAncestors(types: readonly Node[], context: ResolutionContext): string[] {
  const paths: string[] = [];
  let level = [...types];
  for (let depth = 0; level.length > 0 && depth <= 8; depth++) {
    const next: Node[] = [];
    for (const type of level) {
      const path = type.qualifiedName.split('::').join('.');
      if (paths.includes(path)) continue;
      paths.push(path);
      next.push(...(context.getSupertypeNodes?.(type.id) ?? []));
    }
    level = next;
  }
  return paths;
}

/** Declarations a path can stand for as a value: what they hold, or what a call of them returns, is their `returnType`. */
const VALUE_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'property', 'field', 'variable', 'constant', 'enum_member']);

/**
 * The project types `path` evaluates to where `scope` is: the type it names,
 * else the result type of the value, function or member it names — a union
 * case's union — each read by F#'s scope rules where that declaration is
 * written. `Repo` → the type `Repo`; `Repo.Load` → what `Repo`'s `Load`
 * returns; `Settings.Current` → what the module value `Current` holds.
 */
function typesOfPath(path: string, scope: FsharpRefScope, context: ResolutionContext, depth: number): Node[] {
  if (depth > MAX_TYPE_DEPTH || path === '') return [];
  const asType = reachableTypes(path, scope, context);
  if (asType.length > 0) return asType;
  const segments = pathSegments(path);
  const last = segments.pop()!;
  return valuesAt(last, segments.join('.'), scope, context, depth).flatMap((value) => resultTypes(value, context, depth + 1));
}

/** The declarations named `name` that `prefix.name` (bare when `prefix` is empty) can mean as a value where `scope` is. */
function valuesAt(name: string, prefix: string, scope: FsharpRefScope, context: ResolutionContext, depth: number): Node[] {
  const named = context.getNodesByName(name).filter((n) => SCOPED_LANGUAGES.has(n.language) && VALUE_KINDS.has(n.kind));
  const at = (qualifiers: string[]): FsharpRefScope => ({ ...scope, qualifiers, receivers: null });
  const reach = (qualifiers: string[]) => (n: Node): boolean =>
    isFsharpCandidateReachable(at(qualifiers), scopeOfCandidate(n, context), n.filePath === scope.filePath);
  if (prefix === '') return named.filter((n) => n.language === 'fsharp' && reach([])(n));
  // Through a module or a type: `Settings.Current`, `Repo.Default`.
  const through = named.filter(reach([prefix]));
  if (through.length > 0) return through;
  // On a value: a member of what the prefix evaluates to, the nearest type's first.
  const owners = typeAndAncestors(typesOfPath(prefix, scope, context, depth + 1), context);
  const members = named.filter((n) => MEMBER_KINDS.has(n.kind) && owners.includes(containerOfNode(n)));
  const nearest = Math.min(...members.map((n) => owners.indexOf(containerOfNode(n))));
  return members.filter((n) => owners.indexOf(containerOfNode(n)) === nearest);
}

/** The project types a value, function or member yields, read where it is declared; a union case yields its union. */
function resultTypes(value: Node, context: ResolutionContext, depth: number): Node[] {
  if (value.kind === 'enum_member') {
    const owner = value.qualifiedName.slice(0, value.qualifiedName.lastIndexOf('::'));
    return context.getNodesByQualifiedName(owner).filter((n) => n.kind === 'union');
  }
  return value.returnType ? typesOfPath(value.returnType, scopeAtNode(value, context), context, depth) : [];
}

const NODE_SCOPES = new WeakMap<ResolutionContext, Map<string, FsharpRefScope>>();

/** The scope a declaration is written in, as for a name written at its own position: what its file opens there. */
function scopeAtNode(node: Node, context: ResolutionContext): FsharpRefScope {
  let perContext = NODE_SCOPES.get(context);
  if (!perContext) NODE_SCOPES.set(context, (perContext = new Map()));
  const cached = perContext.get(node.id);
  if (cached) return cached;
  const scope = scopeOfRef({
    fromNodeId: node.id,
    referenceName: '',
    referenceKind: 'references',
    line: node.startLine,
    column: node.startColumn,
    filePath: node.filePath,
    language: 'fsharp',
  }, context);
  perContext.set(node.id, scope);
  return scope;
}

/** F#'s names for .NET types: an annotation `(s: string)` is a `System.String`. */
const FSHARP_TYPE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  string: 'String', int: 'Int32', int32: 'Int32', int64: 'Int64', int16: 'Int16', uint32: 'UInt32', uint64: 'UInt64',
  float: 'Double', double: 'Double', float32: 'Single', single: 'Single', decimal: 'Decimal', bool: 'Boolean',
  char: 'Char', byte: 'Byte', sbyte: 'SByte', obj: 'Object', bigint: 'BigInteger', unit: 'Unit',
};

/** Whether a node is an F# type extension (`type T with …`), which declares no type of its own. */
function isTypeExtension(node: Node): boolean {
  return node.language === 'fsharp' && node.decorators?.includes('extension') === true;
}

/** The dotted paths of the type extensions of the type named `name` that a reference can see. */
function visibleExtensions(name: string, scope: FsharpRefScope, context: ResolutionContext): string[] {
  const simple = name.replace(/<.*$/, '');
  const extended = FSHARP_TYPE_ABBREVIATIONS[simple] ?? simple;
  const local = { ...scope, qualifiers: [], receivers: null };
  return (extensionsByName(context).get(extended) ?? [])
    .filter((n) => isFsharpCandidateReachable(local, { ...scopeOfCandidate(n, context), kind: 'module' }))
    .map((n) => n.qualifiedName.split('::').join('.'));
}

const EXTENSIONS = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/** The project's F# type extensions by the simple name of the type they extend, read once per context. */
function extensionsByName(context: ResolutionContext): Map<string, Node[]> {
  let byName = EXTENSIONS.get(context);
  if (byName) return byName;
  byName = new Map();
  for (const n of fsharpNodesOfKinds(new Set(['class']), context)) {
    if (!isTypeExtension(n)) continue;
    const extended = lastSegmentOf(n.name).replace(/<.*$/, '');
    byName.set(extended, [...(byName.get(extended) ?? []), n]);
  }
  EXTENSIONS.set(context, byName);
  return byName;
}

/** The project types a type name written at a reference can mean, by F#'s scope rules for that reference. */
function reachableTypes(written: string, scope: FsharpRefScope, context: ResolutionContext): Node[] {
  const name = lastSegmentOf(written);
  const qualifier = written.length > name.length ? written.slice(0, written.length - name.length - 1) : '';
  const local = { ...scope, qualifiers: qualifier === '' ? [] : [qualifier], receivers: null };
  return context.getNodesByName(name).filter((n) =>
    SCOPED_LANGUAGES.has(n.language) && TYPE_KINDS.has(n.kind) && n.kind !== 'module' && !isTypeExtension(n) &&
    (n.language !== 'fsharp' || isFsharpCandidateReachable(local, scopeOfCandidate(n, context))));
}

function lastSegmentOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

/**
 * The containers whose opening exposes an F# candidate unqualified: the one it
 * is declared in — for a union case, the one its type is declared in, and
 * none for a case of a .NET-style `enum` or of a union marked
 * `[<RequireQualifiedAccess>]`, which are always written through their type —
 * and, while that is an `[<AutoOpen>]` module, the one around it.
 */
function holdersOf(candidate: Node, file: FileScope): string[] {
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  if (candidate.kind === 'enum_member') {
    const owner = segments.join('::');
    if (file.requireQualified.has(owner)) return [];
    segments.pop();
  }
  if (segments.length === 0) return [containerOfNode(candidate)];
  // An AutoOpen module opens into the scope around it.
  let path = segments.join('.');
  const holders = [path];
  while (path !== '' && isAutoOpen(file.byPath.get(path))) {
    path = parentPath(path);
    if (path !== '') holders.push(path);
  }
  return holders;
}

/** The `[<AutoOpen>]` modules among the scopes an F# candidate is declared in. */
function autoOpenedAround(candidate: Node, scopes: ReadonlyMap<string, Node>): string[] {
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  const found: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    if (isAutoOpen(scopes.get(segments.slice(0, i).join('::')))) found.push(segments.slice(0, i).join('.'));
  }
  return found;
}

/** The kinds of an F# type definition. */
const TYPE_DEFINITION_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'union', 'enum', 'type_alias']);

/** An F# decorator as the extractor records an attribute: its name, and its arguments (`CompiledName(["Apply"])`). */
function attributeOf(decorator: string): { name: string; args: string[] } {
  const open = decorator.indexOf('(');
  return open < 0 ? { name: decorator, args: [] } : { name: decorator.slice(0, open), args: JSON.parse(decorator.slice(open + 1, -1)) as string[] };
}

/** Whether attribute `name` is `attribute`, written with or without its `Attribute` suffix. */
function isAttribute(name: string, attribute: string): boolean {
  const simple = lastSegmentOf(name);
  return simple === attribute || simple === `${attribute}Attribute`;
}

/** A metadata name without the type-parameter count a generic type's ends in: ``Wrapped`1`` is `Wrapped`. */
function withoutTypeParameterCount(metadataName: string): string {
  const tick = metadataName.lastIndexOf('`');
  if (tick <= 0 || tick === metadataName.length - 1) return metadataName;
  for (let i = tick + 1; i < metadataName.length; i++) {
    const c = metadataName.charCodeAt(i);
    if (c < 48 || c > 57) return metadataName;
  }
  return metadataName.slice(0, tick);
}

/** The name a `[<CompiledName>]` gives a declaration, as another language writes it. */
function compiledNameOf(node: Node): string | null {
  for (const d of node.decorators ?? []) {
    const { name, args } = attributeOf(d);
    if (isAttribute(name, 'CompiledName') && args.length > 0) return withoutTypeParameterCount(args[0]!);
  }
  return null;
}

/** The kinds of F# declaration an assembly can show another. */
const DOTNET_KINDS: ReadonlySet<string> = new Set([
  'module', 'class', 'struct', 'interface', 'union', 'enum',
  'function', 'method', 'property', 'field', 'variable', 'constant', 'enum_member',
]);

/** The name .NET gives an F# declaration (see `DotnetDeclaration`). */
function dotnetNameOf(node: Node, nodesInFile: readonly Node[]): string {
  const given = compiledNameOf(node) ?? unionCaseDotnetName(node, nodesInFile);
  if (given !== null) return given;
  if (node.kind !== 'module') return node.name;
  // `module A.B.C` at the top of a file is module `C` of namespace `A.B`.
  const own = node.qualifiedName.includes('::') ? node.name : lastSegmentOf(node.name);
  return hasModuleSuffix(node, nodesInFile) ? `${own}Module` : own;
}

/**
 * Whether an F# file compiles its top level into a module named after the
 * file: it declares something outside any namespace or module. A script is no
 * part of an assembly.
 */
function hasImplicitModule(filePath: string, nodesInFile: readonly Node[]): boolean {
  return !/\.fsx$/i.test(filePath) && nodesInFile.some((n) => DOTNET_KINDS.has(n.kind) && n.kind !== 'module' && !n.qualifiedName.includes('::'));
}

const DOTNET_DECLARATIONS = new WeakMap<ResolutionContext, Map<string, DotnetDeclaration | null>>();

/**
 * F# declaration `node` as .NET sees it (see `DotnetDeclaration`); null for
 * what no other assembly can name: what F# erases (a type abbreviation) or
 * compiles under another type (a type extension), what a signature file leaves
 * out, what is `private` or `internal`, and the top of a script.
 */
export function fsharpDotnetDeclaration(node: Node, context: ResolutionContext): DotnetDeclaration | null {
  let perContext = DOTNET_DECLARATIONS.get(context);
  if (!perContext) DOTNET_DECLARATIONS.set(context, (perContext = new Map()));
  const cached = perContext.get(node.id);
  if (cached !== undefined) return cached;
  const declaration = readDotnetDeclaration(node, context);
  perContext.set(node.id, declaration);
  return declaration;
}

function readDotnetDeclaration(node: Node, context: ResolutionContext): DotnetDeclaration | null {
  if (node.language !== 'fsharp') return null;
  const nodes = context.getNodesInFile(node.filePath);
  if (node.kind === 'file') {
    return hasImplicitModule(node.filePath, nodes)
      ? { namespace: '', owner: null, name: implicitModule(node.filePath), isType: true, typeParameters: 0, isStatic: true }
      : null;
  }
  if (!DOTNET_KINDS.has(node.kind) || isTypeExtension(node)) return null;
  if (isHiddenBySignature(node, context) || isAssemblyInternal(node, context)) return null;
  const segments = node.qualifiedName.split('::').slice(0, -1);
  const namespace: string[] = [];
  let owner: Node | null = null;
  if (segments.length === 0) {
    if (node.kind === 'module') namespace.push(...node.name.split('.').slice(0, -1));
    else {
      // Outside any namespace or module: in the module the file's top level compiles into.
      owner = hasImplicitModule(node.filePath, nodes) ? (nodes.find((n) => n.kind === 'file') ?? null) : null;
      if (!owner) return null;
    }
  }
  let qualified = '';
  for (const segment of segments) {
    qualified = qualified === '' ? segment : `${qualified}::${segment}`;
    // A type and a module of one name share a qualified name: the one around the declaration is meant.
    const around = nodes.filter((n) => n.qualifiedName === qualified && n.id !== node.id && containsLine(n, node.startLine));
    const scope = around.find((n) => n.kind === 'namespace' || n.kind === 'module') ?? around[0];
    if (!scope) return null;
    if (scope.kind === 'namespace') {
      if (segment !== GLOBAL_NAMESPACE) namespace.push(...segment.split('.'));
    } else if (scope.kind === 'module') {
      // `module A.B.C` at the top of a file is module `C` of namespace `A.B`.
      if (owner === null) namespace.push(...segment.split('.').slice(0, -1));
      owner = scope;
    } else if (isTypeExtension(scope)) {
      // What an extension in the type's own file adds is the type's; what one elsewhere adds, no other language can name.
      const extended = nodes.find((n) => n.qualifiedName === qualified && TYPE_DEFINITION_KINDS.has(n.kind) && !isTypeExtension(n));
      if (!extended) return null;
      owner = extended;
    } else {
      owner = scope;
    }
  }
  // What holds it must itself be nameable.
  if (owner && owner.kind !== 'file' && !fsharpDotnetDeclaration(owner, context)) return null;
  const isType = TYPE_KINDS.has(node.kind);
  return {
    namespace: namespace.join('.'),
    owner,
    name: dotnetNameOf(node, nodes),
    isType,
    typeParameters: !isType ? null : node.kind === 'module' ? 0 : (factsOf(node.filePath, context).typeParameters.get(node.id) ?? null),
    isStatic: node.kind === 'module' || (!isType && (!MEMBER_KINDS.has(node.kind) || node.isStatic === true)),
  };
}

interface DotnetNames {
  /** Every name .NET gives an F# declaration, and every part of an F# namespace's path. */
  names: Set<string>;
  /** The declarations .NET names otherwise than F# does, by that name. */
  renamed: Map<string, Node[]>;
  /** The namespaces F# declares and those around them, by dotted path. */
  namespaces: Set<string>;
  /** The `namespace` declarations of each path. */
  namespaceNodes: Map<string, Node[]>;
  /** The files that declare something in each namespace of `namespaces`, or in one inside it. */
  namespaceFiles: Map<string, Set<string>>;
}

const DOTNET_NAMES = new WeakMap<ResolutionContext, DotnetNames>();

function dotnetNames(context: ResolutionContext): DotnetNames {
  let index = DOTNET_NAMES.get(context);
  if (index) return index;
  index = { names: new Set(), renamed: new Map(), namespaces: new Set(), namespaceNodes: new Map(), namespaceFiles: new Map() };
  const addNamespace = (path: string, file: string): void => {
    for (const prefix of scopePrefixes(path)) {
      if (prefix === '') continue;
      index!.namespaces.add(prefix);
      let files = index!.namespaceFiles.get(prefix);
      if (!files) index!.namespaceFiles.set(prefix, (files = new Set()));
      files.add(file);
    }
    for (const part of path.split('.')) if (part !== '') index!.names.add(part);
  };
  for (const file of fsharpFiles(context)) {
    const nodes = context.getNodesInFile(file).filter((n) => n.language === 'fsharp');
    const implicit = hasImplicitModule(file, nodes);
    for (const n of nodes) {
      if (n.kind === 'namespace') {
        if (n.name === GLOBAL_NAMESPACE) continue;
        addNamespace(n.name, file);
        index.namespaceNodes.set(n.name, [...(index.namespaceNodes.get(n.name) ?? []), n]);
        continue;
      }
      if (n.kind === 'module' && !n.qualifiedName.includes('::')) addNamespace(parentPath(n.name), file);
      const name = n.kind === 'file' ? (implicit ? implicitModule(file) : null) : DOTNET_KINDS.has(n.kind) ? dotnetNameOf(n, nodes) : null;
      if (name === null) continue;
      index.names.add(name);
      if (name !== n.name) index.renamed.set(name, [...(index.renamed.get(name) ?? []), n]);
    }
  }
  DOTNET_NAMES.set(context, index);
  return index;
}

/** Whether `name` is one .NET gives some F# declaration, or a part of an F# namespace's path. */
export function isFsharpDotnetName(name: string, context: ResolutionContext): boolean {
  return dotnetNames(context).names.has(name);
}

/** The F# declarations another assembly names `name`. */
export function fsharpDeclarationsNamed(name: string, context: ResolutionContext): Node[] {
  const written = context.getNodesByName(name).filter((n) => n.language === 'fsharp');
  return [...written, ...(dotnetNames(context).renamed.get(name) ?? [])].filter((n) => fsharpDotnetDeclaration(n, context)?.name === name);
}

/** The namespaces F# declares and those around them, by dotted path. */
export function fsharpNamespaces(context: ResolutionContext): ReadonlySet<string> {
  return dotnetNames(context).namespaces;
}

/** The F# files that declare something in namespace `path` or in one inside it. */
export function fsharpNamespaceFiles(path: string, context: ResolutionContext): ReadonlySet<string> {
  return dotnetNames(context).namespaceFiles.get(path) ?? new Set();
}

/** The F# declarations of namespace `path`, in the order of their files. */
export function fsharpNamespaceNodes(path: string, context: ResolutionContext): Node[] {
  return [...(dotnetNames(context).namespaceNodes.get(path) ?? [])].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.startLine - b.startLine));
}

/** The project types a read or a call of F# declaration `value` gives, as F# reads its declared type where it is written. */
export function fsharpResultTypes(value: Node, context: ResolutionContext): Node[] {
  return resultTypes(value, context, 0);
}

/**
 * A union case as .NET sees it: a case with fields is built by the union type's
 * static method `New<Case>` (`Shape.NewCircle(r)`), a case without one is the
 * static property of its own name (`Shape.Empty`). Null for anything else.
 */
function unionCaseDotnetName(candidate: Node, nodesInFile: readonly Node[]): string | null {
  if (candidate.kind !== 'enum_member') return null;
  const owner = candidate.qualifiedName.slice(0, candidate.qualifiedName.lastIndexOf('::'));
  if (!nodesInFile.some((n) => n.qualifiedName === owner && n.kind === 'union')) return null;
  return candidate.signature ? `New${candidate.name}` : candidate.name;
}

/**
 * Whether .NET names F# module `module` `<M>Module`: it carries
 * `[<CompilationRepresentation(ModuleSuffix)>]`, or a type of the same name is
 * declared beside it, which since F# 4.1 adds the suffix on its own.
 */
function hasModuleSuffix(module: Node, nodesInFile: readonly Node[]): boolean {
  return module.decorators?.some((d) => {
    const { name, args } = attributeOf(d);
    return isAttribute(name, 'CompilationRepresentation') && args.some((a) => lastSegmentOf(a) === 'ModuleSuffix');
  }) === true ||
    nodesInFile.some((n) => n.qualifiedName === module.qualifiedName && TYPE_DEFINITION_KINDS.has(n.kind));
}

function containsLine(node: Node, line: number): boolean {
  return node.startLine <= line && (node.endLine ?? node.startLine) >= line;
}

const CANDIDATE_SCOPES = new WeakMap<ResolutionContext, Map<string, FsharpCandidateScope>>();

/** Forget what was read from files and candidates; called when the resolver drops its caches after a sync. */
export function clearFsharpScopeCaches(context: ResolutionContext): void {
  DOTNET_DECLARATIONS.delete(context);
  EXTENSIONS.delete(context);
  COMPILE_ORDERS.delete(context);
  SIGNATURES.delete(context);
  DECLARED_SCOPES.delete(context);
  DOTNET_NAMES.delete(context);
  ASSEMBLY_INTERNAL.delete(context);
  NODE_SCOPES.delete(context);
  PRIVATE_SCOPES.delete(context);
  FSHARP_FILES.delete(context);
  FILE_SCOPES.delete(context);
  DECLARED_NAMESPACES.delete(context);
  CANDIDATE_SCOPES.delete(context);
  FACTS.delete(context);
}

/** Where a candidate is declared, read once per candidate. */
function scopeOfCandidate(candidate: Node, context: ResolutionContext): FsharpCandidateScope {
  let perContext = CANDIDATE_SCOPES.get(context);
  if (!perContext) CANDIDATE_SCOPES.set(context, (perContext = new Map()));
  const cached = perContext.get(candidate.id);
  if (cached) return cached;
  // A C# declaration is reached through its namespace like an F# one.
  const foreign = candidate.language !== 'fsharp';
  const container = foreign ? fsharpContainerOf(candidate.qualifiedName) : containerOfNode(candidate);
  const file = fileScopeOf(candidate.filePath, context);
  const scope: FsharpCandidateScope = {
    name: candidate.name,
    container,
    namespace: declaredNamespace(candidate, context),
    kind: candidate.kind,
    holders: foreign ? [container] : holdersOf(candidate, file),
    autoOpened: foreign ? [] : autoOpenedAround(candidate, file.scopes),
    classLet: !foreign && candidate.decorators?.[0] === 'let',
    isStatic: candidate.isStatic === true,
  };
  perContext.set(candidate.id, scope);
  return scope;
}

/**
 * Whether F# compiles `candidate` so that no other assembly sees it: it, or a
 * module or type around it, is `private` or `internal` (F# emits `private` as
 * `internal`), or it is a class's `let`. A C# project is always
 * another assembly than the F# one.
 */
function isAssemblyInternal(candidate: Node, context: ResolutionContext): boolean {
  let perContext = ASSEMBLY_INTERNAL.get(context);
  if (!perContext) ASSEMBLY_INTERNAL.set(context, (perContext = new Map()));
  const cached = perContext.get(candidate.id);
  if (cached !== undefined) return cached;
  const closed = (n: Node): boolean => n.visibility === 'private' || n.visibility === 'internal';
  const internal = closed(candidate) || candidate.decorators?.[0] === 'let' ||
    context.getNodesInFile(candidate.filePath).some((n) =>
      n.id !== candidate.id && closed(n) && TYPE_KINDS.has(n.kind) && containsPosition(n, candidate.startLine, candidate.startColumn));
  perContext.set(candidate.id, internal);
  return internal;
}

const ASSEMBLY_INTERNAL = new WeakMap<ResolutionContext, Map<string, boolean>>();

/**
 * Of the declarations an F# name can mean, the ones F# takes: the name binds to
 * what became visible last before it. An `open` makes what it opens visible from
 * its line — so of two opened modules that both define `pick`, the one opened
 * later is meant — and a declaration of a scope around the reference from its
 * own line in that file, or from the top of any other file. Several equally late
 * stay: the caller does not guess between them.
 */
export function latestFsharpBindings(candidates: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (ref.language !== 'fsharp' || candidates.length < 2) return candidates;
  const scope = scopeOfRef(ref, context);
  // Where each path became visible through an `open` read relative to the scopes around the reference.
  const openedAt = new Map<string, number>();
  for (const { path, line } of scope.openedPaths ?? []) openedAt.set(path, Math.max(openedAt.get(path) ?? -1, line));
  const visibleFrom = (path: string, declaredAt: number, sameFile: boolean): number => {
    if (path === '' || path === GLOBAL_NAMESPACE) return 0;
    const opened = openedAt.get(path) ?? -1;
    const around = isPathPrefix(path, scope.container) ? (sameFile ? declaredAt : 0) : -1;
    return Math.max(opened, around);
  };
  const qualifier = scope.onValue ? undefined : scope.qualifiers[0];
  const lines = candidates.map((n) => {
    const target = scopeOfCandidate(n, context);
    const sameFile = n.filePath === ref.filePath;
    if (qualifier === undefined) return Math.max(...target.holders.map((h) => visibleFrom(h, n.startLine, sameFile)), -1);
    // `Calc.helper`: the module the qualifier starts at is what became visible.
    if (target.container === qualifier) return 0;
    const head = target.container.slice(0, target.container.length - qualifier.length - 1);
    return target.container.endsWith(`.${qualifier}`) ? visibleFrom(head, n.startLine, sameFile) : -1;
  });
  const latest = Math.max(...lines);
  const visible = candidates.filter((_, i) => lines[i] === latest);
  // Declared side by side, as one module or namespace's in one file: the later declaration shadows the
  // earlier. Not a type's members: two of one name are overloads, which the arguments choose between.
  const holder = (n: Node): string => `${n.filePath}|${scopeOfCandidate(n, context).holders[0] ?? ''}`;
  if (visible.length > 1 && !visible.some(isTypeMember) && visible.every((n) => holder(n) === holder(visible[0]!))) {
    const last = Math.max(...visible.map((n) => n.startLine));
    return visible.filter((n) => n.startLine === last);
  }
  return visible.length > 1 && visible.every((n) => isTypeMember(n) && n.qualifiedName === visible[0]!.qualifiedName)
    ? overloadsFitting(visible, ref, context)
    : visible;
}

/** What a type is, for matching an argument to a parameter: a .NET primitive by its name, the project's declarations, or nothing known. */
type ArgumentTypeShape = { dotnet: string } | { project: Node[] } | null;

/** A written type as overload matching compares it: `int` → Int32, `Repo` → the project's `Repo`, `'T` → anything. */
function shapeOfWritten(type: WrittenType, scope: FsharpRefScope, context: ResolutionContext): ArgumentTypeShape | 'any' {
  if (type.kind === 'variable') return 'any';
  if (type.kind === 'compound') return null;
  const dotnet = FSHARP_TYPE_ABBREVIATIONS[type.name] ?? (DOTNET_PRIMITIVES.has(lastSegmentOf(type.name)) ? lastSegmentOf(type.name) : null);
  if (dotnet) return { dotnet };
  const project = reachableTypes(type.name, scope, context);
  return project.length > 0 ? { project } : null;
}

/** The .NET primitive types an F# abbreviation names, by their own names. */
const DOTNET_PRIMITIVES: ReadonlySet<string> = new Set([
  'String', 'Char', 'Boolean', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64',
  'IntPtr', 'UIntPtr', 'Single', 'Double', 'Decimal', 'BigInteger', 'Object', 'Unit',
]);

/** What an argument's type is, as the extractor read it from the tree and the project's declarations state it. */
function shapeOfArgument(type: ArgumentType | undefined, scope: FsharpRefScope, context: ResolutionContext): ArgumentTypeShape | 'any' {
  if (!type) return null;
  switch (type.kind) {
    case 'written':
      return shapeOfWritten(type.type, scope, context);
    case 'of': {
      const dotnet = FSHARP_TYPE_ABBREVIATIONS[type.path];
      if (dotnet) return { dotnet };
      const project = typesOfPath(type.path, scope, context, 0);
      return project.length > 0 ? { project } : null;
    }
    case 'field': {
      // A name a union case's pattern binds holds that case's field.
      const dot = type.casePath.lastIndexOf('.');
      const qualifier = dot < 0 ? '' : type.casePath.slice(0, dot);
      const cases = context.getNodesByName(type.casePath.slice(dot + 1)).filter((n) => n.kind === 'enum_member' &&
        isFsharpCandidateReachable({ ...scope, qualifiers: qualifier === '' ? [] : [qualifier], receivers: null }, scopeOfCandidate(n, context)));
      const fields = cases.map((c) => parametersOf(c, context)?.[type.index]?.type);
      const field = fields[0];
      const sameType = (a: WrittenType | undefined): boolean =>
        a !== undefined && field !== undefined && a.kind === field.kind && (a.kind !== 'name' || field.kind !== 'name' || a.name === field.name);
      return field !== undefined && fields.every(sameType) ? shapeOfWritten(field, scope, context) : null;
    }
  }
}

/**
 * How a parameter of type `param` takes an argument of type `arg`, as F# picks
 * between a method's overloads: 2 exactly, 1 through a conversion F# applies
 * to a method argument (an `int` where an `int64`, a `float` or an `obj` is
 * taken; a type where one it inherits is), 0 when either is unknown, -1 never.
 */
function argumentFits(arg: ArgumentTypeShape | 'any', param: ArgumentTypeShape | 'any', context: ResolutionContext): number {
  if (arg === null || param === null || arg === 'any' || param === 'any') return 0;
  if ('dotnet' in param && param.dotnet === 'Object') return 1;
  if ('dotnet' in arg && 'dotnet' in param) {
    if (arg.dotnet === param.dotnet) return 2;
    return arg.dotnet === 'Int32' && (param.dotnet === 'Int64' || param.dotnet === 'Double' || param.dotnet === 'IntPtr') ? 1 : -1;
  }
  // A project type may convert from a primitive (`op_Implicit`); a primitive takes no project type.
  if ('dotnet' in arg) return 0;
  if ('dotnet' in param) return -1;
  const wanted = new Set(param.project.map((t) => t.id));
  if (arg.project.some((t) => wanted.has(t.id))) return 2;
  const inherited = new Set(typeAndAncestors(arg.project, context));
  return param.project.some((t) => inherited.has(t.qualifiedName.split('::').join('.'))) ? 1 : -1;
}

/**
 * Of a type's overloads of one method, the ones the call's arguments fit, as
 * F# picks between them: by how many arguments the call passes, by the names
 * it passes some by, then by the arguments' types. All of them when the call
 * says too little.
 */
function overloadsFitting(overloads: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const args = writtenOf(ref, context)?.args;
  if (!args) return overloads;
  const scope = scopeOfRef(ref, context);
  const argShapes = args.map((a) => shapeOfArgument(a.type, scope, context));
  const scored = overloads.map((n) => {
    const params = parametersOf(n, context);
    if (!params) return { n, score: 0 };
    const variadic = params.length > 0 && params[params.length - 1]!.paramArray === true;
    const required = params.filter((p, i) => !p.optional && !(variadic && i === params.length - 1)).length;
    if (args.length < required || (!variadic && args.length > params.length)) return { n, score: -1 };
    let score = 1;
    for (let i = 0; i < args.length; i++) {
      const named = args[i]!.named;
      // A named argument fills the parameter of its name, wherever it stands.
      const param = named !== undefined ? params.find((p) => p.name === named) : variadic && i >= params.length - 1 ? undefined : params[i];
      if (named !== undefined && param === undefined) return { n, score: -1 };
      if (!param) continue;
      const fit = argumentFits(argShapes[i]!, param.type ? shapeOfWritten(param.type, scope, context) : null, context);
      if (fit < 0) return { n, score: -1 };
      score += fit;
    }
    // Of overloads the call fits equally, F# prefers the one it fills without optional arguments left out.
    if (args.length < params.length) score -= 0.5;
    return { n, score };
  });
  const best = Math.max(...scored.map((s) => s.score));
  if (best < 0) return overloads;
  return scored.filter((s) => s.score === best).map((s) => s.n);
}

const FACTS = new WeakMap<ResolutionContext, Map<string, ReturnType<typeof readFileFacts>>>();

/** What the extractor kept in `fsharp.db` about `file`, read once per file. */
function factsOf(file: string, context: ResolutionContext): ReturnType<typeof readFileFacts> {
  let perContext = FACTS.get(context);
  if (!perContext) FACTS.set(context, (perContext = new Map()));
  let facts = perContext.get(file);
  if (!facts) perContext.set(file, (facts = readFileFacts(context.getProjectRoot(), file)));
  return facts;
}

/** What the extractor kept in `fsharp.db` about where the F# reference `ref` is written; null for one it kept nothing about. */
function writtenOf(ref: UnresolvedRef, context: ResolutionContext): FsharpSite | null {
  if (ref.language !== 'fsharp') return null;
  return factsOf(ref.filePath, context).sites.get(siteKeyOf(ref.line, ref.column, ref.referenceKind, ref.referenceName)) ?? null;
}

/** The parameters the F# declaration `node` has, as the extractor kept them; undefined for one it kept none for. */
function parametersOf(node: Node, context: ResolutionContext): FsharpParameter[] | undefined {
  if (node.language !== 'fsharp') return undefined;
  return factsOf(node.filePath, context).parameters.get(node.id);
}

/** Reference kinds that name a type: only a type can be what they mean. */
const TYPE_REFERENCE_KINDS: ReadonlySet<string> = new Set(['extends', 'implements', 'type_of', 'returns']);

/** Whether `ref` is an F# name of a declaration, which F#'s own lookup (`matchFsharpReference`) resolves, and nothing else. */
export function isFsharpSymbolReference(ref: UnresolvedRef): boolean {
  return ref.language === 'fsharp' && SYMBOL_REFERENCE_KINDS.has(ref.referenceKind);
}

/**
 * The declaration an F# name means, by F#'s lookup: the declarations of its
 * name that its scope can reach (`isFsharpCandidateInScope`), the one that
 * became visible last (`latestFsharpBindings`), and of a member written on a
 * value, the one of the value's own type before those of the types it
 * inherits. What it can be at all is where the tree places it: a type where a
 * type is written; a case or a literal in a pattern; elsewhere a value, which
 * no module or union type is. Null unless one declaration is meant: silent beats wrong.
 */
export function matchFsharpReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const written = writtenOf(ref, context);
  if (!written) return null;
  if (written.position === 'record') return matchFsharpRecordConstruction(ref, context);
  if (written.labelOf && labelsParameter(written.path[written.path.length - 1]!, written.labelOf, ref, context)) return null;
  const position: FsharpPosition = TYPE_REFERENCE_KINDS.has(ref.referenceKind) ? 'type' : written.position;
  const meant = (n: Node): boolean => {
    if (n.kind === 'module') return false;
    switch (position) {
      case 'type': return TYPE_KINDS.has(n.kind);
      case 'pattern': return n.kind === 'enum_member' || n.kind === 'constant';
      case 'call':
      case 'value': return n.kind !== 'union';
    }
  };
  const reached = context.getNodesByName(written.path[written.path.length - 1]!).filter((n) => meant(n) && isFsharpCandidateInScope(n, ref, context));
  let ranked = latestFsharpBindings(reached, ref, context);
  // A member on a value is looked up in the value's type, then in what that type inherits.
  const receivers = scopeOfRef(ref, context).receivers;
  if (receivers && ranked.length > 1) {
    const depth = (n: Node): number => (MEMBER_KINDS.has(n.kind) ? receivers.indexOf(containerOfNode(n)) : -1);
    const nearest = Math.min(...ranked.map(depth).filter((d) => d >= 0));
    if (Number.isFinite(nearest)) ranked = ranked.filter((n) => depth(n) === nearest);
  }
  if (ranked.length === 0 || ranked.some((n) => n.qualifiedName !== ranked[0]!.qualifiedName)) return null;
  return { original: ref, targetNodeId: ranked[0]!.id, confidence: 0.9, resolvedBy: 'exact-match' };
}

/**
 * Whether `name` in `M(name = value)` is the label of a named argument rather
 * than a value compared: as F# decides, when the call reaches a method or a
 * constructor with a parameter of that name, or builds a type with a member of
 * it to set. A function's arguments are never named. Also true when the call
 * reaches nothing the project declares: then what the name is cannot be told.
 */
function labelsParameter(name: string, call: { line: number; column: number; name: string }, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const callRef: UnresolvedRef = { ...ref, line: call.line, column: call.column, referenceKind: 'calls', referenceName: call.name };
  if (!writtenOf(callRef, context)) return true;
  const resolved = matchFsharpReference(callRef, context);
  const target = resolved ? (context.getNodeById?.(resolved.targetNodeId) ?? null) : null;
  if (!target) return true;
  if (target.kind === 'function') return false;
  if (parametersOf(target, context)?.some((p) => p.name === name)) return true;
  if (!TYPE_KINDS.has(target.kind)) return false;
  const members = context.getNodesByName(name).filter((n) => containerOfNode(n) === target.qualifiedName.split('::').join('.'));
  const constructors = context.getNodesByName('new').filter((n) => containerOfNode(n) === target.qualifiedName.split('::').join('.'));
  return members.length > 0 || constructors.some((c) => parametersOf(c, context)?.some((p) => p.name === name) === true);
}

/**
 * The record type an F# record expression builds, as F# infers it from the
 * labels: a record type in scope with those fields — the one that became
 * visible last when several have them — and for `{ Dom.Customer.Name = … }`
 * the type its first label is written through. `{ c with … }` copies `c`, so
 * it builds `c`'s type. Null unless exactly one type is meant.
 */
export function matchFsharpRecordConstruction(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const written = writtenOf(ref, context);
  if (ref.referenceKind !== 'instantiates' || written?.position !== 'record' || !written.labels) return null;
  const scope = scopeOfRef(ref, context);
  const first = written.labels[0]!;
  const labels = written.labels.map((l) => l[l.length - 1]!);
  let types: Node[];
  if (written.copy) {
    // What is copied has the type its binding states, or that a module value holds.
    if (written.copy.type === undefined) return null;
    types = typesOfPath(written.copy.type, scope, context, 0).filter((n) => TYPE_KINDS.has(n.kind) && n.kind !== 'module');
  } else if (first.length > 1) {
    types = reachableTypes(first.slice(0, -1).join('.'), scope, context);
  } else {
    // The types with a field of the first label, among those the reference can name.
    const owners = new Set(context.getNodesByName(labels[0]!)
      .filter((n) => n.language === 'fsharp' && n.kind === 'field')
      .map((n) => n.qualifiedName.slice(0, n.qualifiedName.lastIndexOf('::'))));
    types = [...owners].flatMap((qn) => context.getNodesByQualifiedName(qn))
      .filter((t) => t.language === 'fsharp' && TYPE_KINDS.has(t.kind) && t.kind !== 'module' &&
        isFsharpCandidateReachable({ ...scope, qualifiers: [], receivers: null }, scopeOfCandidate(t, context)));
  }
  const hasField = (type: Node, label: string): boolean =>
    context.getNodesByName(label).some((f) => f.kind === 'field' && f.qualifiedName === `${type.qualifiedName}::${label}`);
  const built = latestFsharpBindings(types.filter((t) => labels.every((label) => hasField(t, label))), ref, context);
  if (built.length === 0 || built.some((t) => t.qualifiedName !== built[0]!.qualifiedName)) return null;
  return { original: ref, targetNodeId: built[0]!.id, confidence: 0.9, resolvedBy: 'exact-match' };
}

const COMPILE_ORDERS = new WeakMap<ResolutionContext, Map<string, Map<string, number>[]>>();

/**
 * The compilation order of the F# project that compiles `file`: the nearest
 * folder at or above it holding `.fsproj` files, and of those the one whose
 * items list the file (`fsprojCompileItems`), by project-relative path. F#
 * sees in a file only what the files before it in that order declare. Null
 * when the nearest project files list it nowhere.
 */
function compileOrderOf(file: string, context: ResolutionContext): Map<string, number> | null {
  let byDir = COMPILE_ORDERS.get(context);
  if (!byDir) COMPILE_ORDERS.set(context, (byDir = new Map()));
  const root = context.getProjectRoot();
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    const key = dir === '.' ? '' : dir;
    let orders = byDir.get(key);
    if (orders === undefined) {
      orders = projectOrdersIn(root, key);
      byDir.set(key, orders);
    }
    if (orders.length > 0) return orders.find((order) => order.has(file)) ?? null;
    if (key === '') return null;
  }
}

/** The compile order of each `.fsproj` in folder `dir`, by project-relative path. */
function projectOrdersIn(root: string, dir: string): Map<string, number>[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(root, dir));
  } catch {
    entries = [];
  }
  return entries.filter((e) => /\.fsproj$/i.test(e)).sort().map((project) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, dir, project), 'utf8');
    } catch {
      text = '';
    }
    const order = new Map<string, number>();
    for (const item of fsprojCompileItems(text)) {
      const listed = path.posix.normalize(path.posix.join(dir, item));
      if (!order.has(listed)) order.set(listed, order.size);
    }
    return order;
  });
}

const PRIVATE_SCOPES = new WeakMap<ResolutionContext, Map<string, { path: string; namespace: boolean }[]>>();

/**
 * Whether F#'s `private` lets code in `refContainer` (a dotted path) reach
 * `candidate`. A `private` declaration is its enclosing scope's: code inside
 * that module or type (one file, as neither spans files) or that namespace (in
 * any file of it) sees it. The contents of a `private` module or type are
 * private to where it is, as F# combines their access with it.
 */
function isPrivateAccessible(candidate: Node, ref: UnresolvedRef, refContainer: string, context: ResolutionContext): boolean {
  let perContext = PRIVATE_SCOPES.get(context);
  if (!perContext) PRIVATE_SCOPES.set(context, (perContext = new Map()));
  let limits = perContext.get(candidate.id);
  if (!limits) {
    const nodes = context.getNodesInFile(candidate.filePath);
    const scopes = fileScopeOf(candidate.filePath, context);
    limits = [candidate, ...nodes.filter((n) => n.id !== candidate.id && TYPE_KINDS.has(n.kind) && containsPosition(n, candidate.startLine, candidate.startColumn))]
      // A class's `let` is the classLet rule's (isFsharpCandidateReachable).
      .filter((n) => n.visibility === 'private' && n.decorators?.[0] !== 'let')
      .map((n) => {
        const path = containerOfNode(n);
        return { path, namespace: scopes.byPath.get(path)?.kind === 'namespace' };
      });
    perContext.set(candidate.id, limits);
  }
  return limits.every(({ path, namespace }) => isPathPrefix(path, refContainer) && (namespace || candidate.filePath === ref.filePath));
}

/** Kinds a `let` binds: in its own body only when written `let rec`. */
const LET_BOUND_KINDS: ReadonlySet<string> = new Set(['function', 'variable', 'constant']);

/**
 * Whether `candidate`, declared in `ref`'s own file, is not in scope yet where
 * `ref` is written: a file is read top to bottom, so a name means what is
 * declared above it, and a `let` without `rec` does not see itself in its own
 * body (the name there is an earlier one). Except inside a `module rec` or
 * `namespace rec`, among the bindings of one `let rec … and …` or the types of
 * one `type … and …`, and among a type's members, which see each other
 * wherever they are written.
 */
function isNotYetInScope(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (isTypeMember(candidate)) return false;
  const below = candidate.startLine > ref.line || (candidate.startLine === ref.line && candidate.startColumn > ref.column);
  const letBound = LET_BOUND_KINDS.has(candidate.kind) || candidate.decorators?.[0] === 'let';
  const ownBody = !below && letBound && containsPosition(candidate, ref.line, ref.column);
  if (!below && !ownBody) return false;
  const nodes = context.getNodesInFile(candidate.filePath);
  const recursive = (n: Node): boolean => (n.kind === 'module' || n.kind === 'namespace') && n.decorators?.includes('rec') === true;
  if (nodes.some((n) => recursive(n) && containsPosition(n, candidate.startLine, candidate.startColumn) && containsPosition(n, ref.line, ref.column))) {
    return false;
  }
  if (ownBody && candidate.decorators?.includes('rec')) return false;
  const groupStart = recursiveGroupStart(candidate, context);
  return groupStart === null || ref.line < groupStart;
}

/**
 * The first line of the `let rec … and …` or `type … and …` group `candidate`
 * joins with `and`, or null when it joins none: its members are all in scope
 * from the group's first line. The group is the declarations of its scope the
 * extractor marked `and`, back to the one that opens it, and a `let` group is
 * recursive only when that one is written `let rec`.
 */
function recursiveGroupStart(candidate: Node, context: ResolutionContext): number | null {
  if (!candidate.decorators?.includes('and')) return null;
  const container = containerOfNode(candidate);
  const declaration = (n: Node): boolean =>
    LET_BOUND_KINDS.has(n.kind) || n.decorators?.[0] === 'let' || (TYPE_KINDS.has(n.kind) && n.kind !== 'module');
  const earlier = context.getNodesInFile(candidate.filePath)
    .filter((n) => declaration(n) && containerOfNode(n) === container &&
      (n.startLine < candidate.startLine || (n.startLine === candidate.startLine && n.startColumn < candidate.startColumn)))
    .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn);
  const head = earlier.find((n) => !n.decorators?.includes('and'));
  if (!head) return null;
  return TYPE_KINDS.has(head.kind) || head.decorators?.includes('rec') ? head.startLine : null;
}

/**
 * The names an F# signature file mentions, sorted, comments left out: what
 * decides which of its `.fs` file's declarations other files see
 * (`isHiddenBySignature`). A comment or a reordering changes none of them.
 */
export function signatureNames(text: string): string[] {
  return [...new Set(fsharpNames(text))].sort();
}

/**
 * The files outside the index that decide what F# names see, project-relative:
 * the `.fsproj` files in the folders around each F# file (the compile order),
 * and each `.fs` file's `.fsi` signature where there is one. A signature that
 * appears is listed from then on and one that goes stays in the snapshot it
 * was in, so both read as a change. A sync re-resolves F# — and the C# that
 * names it — when what one of them says changes.
 */
export function fsharpConfigFiles(context: ResolutionContext): string[] {
  const root = context.getProjectRoot();
  const out = new Set<string>();
  const seenDirs = new Set<string>();
  // Listed afresh, not from the memo: a sync asks after files came or went.
  for (const file of indexedFsharpFiles(context)) {
    if (/\.fs$/i.test(file) && fs.existsSync(path.join(root, `${file}i`))) out.add(`${file}i`);
    for (let dir = path.posix.dirname(file); !seenDirs.has(dir); dir = path.posix.dirname(dir)) {
      seenDirs.add(dir);
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(path.join(root, dir === '.' ? '' : dir));
      } catch {
        entries = [];
      }
      for (const e of entries) if (/\.fsproj$/i.test(e)) out.add(dir === '.' ? e : `${dir}/${e}`);
      if (dir === '.' || dir === '/' || dir === '') break;
    }
  }
  return [...out];
}

/** Whether `candidate`'s file comes after `ref`'s in the F# project that compiles both, so `ref` cannot see it. */
function isCompiledLater(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (candidate.filePath === ref.filePath) return false;
  const order = compileOrderOf(ref.filePath, context);
  const at = order?.get(ref.filePath);
  const candidateAt = order?.get(candidate.filePath);
  return at !== undefined && candidateAt !== undefined && candidateAt > at;
}

const SIGNATURES = new WeakMap<ResolutionContext, Map<string, Set<string> | null>>();

/**
 * Whether a signature file hides `candidate` from other files: beside `X.fs`,
 * an `X.fsi` declares what the file shows, and what it leaves out is private to
 * the file. The signature is read as text (the grammar cannot parse one), so a
 * name its code mentions anywhere counts as declared; one only in a comment does not.
 */
function isHiddenBySignature(candidate: Node, context: ResolutionContext): boolean {
  if (!/\.fs$/i.test(candidate.filePath)) return false;
  let byFile = SIGNATURES.get(context);
  if (!byFile) SIGNATURES.set(context, (byFile = new Map()));
  const signaturePath = `${candidate.filePath}i`;
  let names = byFile.get(signaturePath);
  if (names === undefined) {
    try {
      names = new Set(signatureNames(fs.readFileSync(path.join(context.getProjectRoot(), signaturePath), 'utf8')));
    } catch {
      names = null;
    }
    byFile.set(signaturePath, names);
  }
  // A declaration's name as the lexer spells it: ``a b`` without its backticks, `( +++ )` without spaces.
  return names !== null && !names.has(candidate.name.replace(/^``([\s\S]*)``$/, '$1').replace(/^\((.*)\)$/, (_, op: string) => `(${op.replace(/\s+/g, '')})`));
}

/**
 * Is `candidate` something `ref` can mean? For an F# name, by F#'s scope
 * rules. A name of another language never means an F# declaration by its name
 * alone — what a C# or Razor name means in F# is C#'s lookup to say
 * (./dotnet-lookup) — but a file is a file to any language.
 */
export function isFsharpCandidateInScope(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.language !== 'fsharp') return candidate.language !== 'fsharp' || candidate.kind === 'file';
  // A Razor component is not something F# names.
  if (candidate.language === 'razor') return false;
  if (!SCOPED_LANGUAGES.has(candidate.language)) return true;
  if (!SYMBOL_REFERENCE_KINDS.has(ref.referenceKind) || NON_SYMBOL_KINDS.has(candidate.kind)) return true;
  // A call invokes something; a module is a scope — in any file, so a `module Order` beside `type Order` is not its constructor.
  if (ref.referenceKind === 'calls' && candidate.kind === 'module') return false;
  // `type System.String with …` adds members; it declares no type a name could mean.
  if (isTypeExtension(candidate)) return false;
  // A file sees only what the files compiled before it declare, and of a file with a
  // signature, only what the signature declares.
  if (candidate.language === 'fsharp' && isCompiledLater(candidate, ref, context)) return false;
  if (candidate.language === 'fsharp' && candidate.filePath !== ref.filePath && isHiddenBySignature(candidate, context)) return false;

  const sameFile = candidate.filePath === ref.filePath;
  if (sameFile && candidate.language === 'fsharp' && isNotYetInScope(candidate, ref, context)) return false;
  const refScope = scopeOfRef(ref, context);
  if (candidate.language === 'fsharp' && !isPrivateAccessible(candidate, ref, refScope.container, context)) return false;

  const scope = scopeOfCandidate(candidate, context);
  // A C# declaration outside every namespace is global.
  if (candidate.language !== 'fsharp' && scope.container === '') return true;
  return isFsharpCandidateReachable(refScope, scope, sameFile);
}
