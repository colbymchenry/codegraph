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
 *   a member of some type. Its type is whatever inference says, so it is
 *   reached by name within the neighbourhood the file can see.
 *
 * The extractor keeps only the last segment of a qualified callee, so the
 * qualifier is read back from the source, at the reference's own position.
 *
 * A same-named function in a namespace none of that reaches — `map`, `bind`,
 * `format` — is never what the name means.
 */

import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';

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

/**
 * Members every .NET object has. A project's override of one is not what
 * `x.ToString()` means on a value whose type is not known: the call stays unresolved.
 */
const UNIVERSAL_MEMBERS: ReadonlySet<string> = new Set([
  'ToString',
  'Equals',
  'GetHashCode',
  'GetType',
  'CompareTo',
  'Dispose',
  'Finalize',
  'MemberwiseClone',
]);

/** Languages an F# name can be written against: its own and the other .NET ones. */
const SCOPED_LANGUAGES: ReadonlySet<string> = new Set(['fsharp', 'csharp', 'vbnet']);

/** The .NET languages that share a family with F# and whose references must not land on F# declarations. */
const DOTNET_REFERRERS: ReadonlySet<string> = new Set(['csharp', 'vbnet', 'razor']);

/** Scopes whose own contents sit inside them: a reference written in one is relative to it. */
const OWN_SCOPE_KINDS: ReadonlySet<string> = new Set(['namespace', 'module', 'class', 'struct', 'interface', 'union', 'enum']);

/** Declarations directly in `namespace global` are visible from every file, and the namespace is always open. */
const GLOBAL_NAMESPACE = 'global';

/** Where a reference is written, and what its file brings into reach. */
export interface FsharpRefScope {
  /** Dotted path of the scopes around the reference. */
  container: string;
  /** The namespace the reference's file declares it in. */
  namespace: string;
  /** Paths the file opens. */
  opens: readonly string[];
  /** Qualifiers the name is written with, aliases expanded: `Calc` in `Calc.helper`, `x` in `x.Add`. */
  qualifiers: readonly string[];
  /** The name is written through a capitalised path whose head the project does not declare: `System.Threading.Tasks.Task.Run`. */
  externalQualifier: boolean;
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

/** Does `opened` reach `path`, with at most one more segment? (A type or module directly under it.) */
function openReaches(path: string, opened: string): boolean {
  const at = `.${path}.`.indexOf(`.${opened}.`);
  if (at < 0) return false;
  const rest = `.${path}.`.slice(at + opened.length + 2);
  return rest.split('.').filter((seg) => seg !== '').length <= 1;
}

/** A qualifier names a module or type when it starts with a capital or a backtick; a lowercase one is a value. */
function namesContainer(qualifier: string): boolean {
  return /^(?:``|\p{Lu})/u.test(qualifier);
}

const RESOLVED_SCOPES = new WeakMap<FsharpRefScope, { prefixes: string[]; opens: Set<string> }>();

/** The scopes around a reference and its opens, the latter also read relative to those scopes (`open Core` in `namespace Shop`). */
function resolvedScopes(ref: FsharpRefScope): { prefixes: string[]; opens: Set<string> } {
  const cached = RESOLVED_SCOPES.get(ref);
  if (cached) return cached;
  const prefixes = scopePrefixes(ref.container);
  const opens = new Set<string>();
  for (const o of ref.opens) for (const p of prefixes) opens.add(joinPath(p, o));
  const resolved = { prefixes, opens };
  RESOLVED_SCOPES.set(ref, resolved);
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

  const { prefixes, opens } = resolvedScopes(ref);
  const isMember = MEMBER_KINDS.has(candidate.kind);

  // What a qualifier can start from: the scopes around the reference, its opens, and
  // what an `[<AutoOpen>]` module opens in turn (`open Core` brings in `Core.Domain.AgentName`).
  const exposed = (path: string): boolean =>
    path === '' || path === GLOBAL_NAMESPACE || prefixes.includes(path) || opens.has(path) || (candidate.autoOpened.includes(path) && exposed(parentPath(path)));
  const viaContainer = ref.qualifiers.filter(namesContainer);
  if (viaContainer.length > 0) {
    const through = (q: string): boolean =>
      c === q || (c.endsWith(`.${q}`) && exposed(c.slice(0, c.length - q.length - 1)));
    if (viaContainer.some(through)) return true;
  }
  if (ref.externalQualifier) return false;

  // A value, or a chain of properties from a name (`Settings.Current.Save`), has some type's member:
  // reached by name, near what the file can see.
  const viaValue = ref.qualifiers.some((q) => !namesContainer(q) || q.includes('.'));
  if (viaValue && isMember) {
    if (UNIVERSAL_MEMBERS.has(candidate.name)) return false;
    if (ref.namespace !== '' && ref.namespace === candidate.namespace) return true;
    if (ref.container !== '' && (isPathPrefix(c, ref.container) || isPathPrefix(ref.container, c))) return true;
    return [...opens].some((o) => openReaches(c, o));
  }

  if (ref.qualifiers.length > 0) return false;

  // Bare name: a member is never in scope; anything else only through an
  // enclosing scope or an opened one.
  if (isMember) return sameFile && isPathPrefix(c, ref.container);
  return candidate.holders.some((h) => opens.has(h) || isPathPrefix(h, ref.container));
}

interface FileScope {
  /** Paths the file opens: `open X`. */
  opens: string[];
  /** `module F = Other.Lib.Fn` aliases, alias → target. */
  aliases: Map<string, string>;
  /** Namespaces, modules and enums of the file by their qualified name. */
  scopes: Map<string, Node>;
  /** The same by dotted path: a file-level `module A.B.C` is one segment of the qualified name. */
  byPath: Map<string, Node>;
}

const FILE_SCOPES = new WeakMap<ResolutionContext, Map<string, FileScope>>();

/** What a file says about names, read once per resolution context. */
function fileScopeOf(filePath: string, context: ResolutionContext): FileScope {
  let perFile = FILE_SCOPES.get(context);
  if (!perFile) FILE_SCOPES.set(context, (perFile = new Map()));
  const cached = perFile.get(filePath);
  if (cached) return cached;
  const scope: FileScope = { opens: [], aliases: new Map(), scopes: new Map(), byPath: new Map() };
  for (const n of context.getNodesInFile(filePath)) {
    if (n.kind === 'module' || n.kind === 'enum' || n.kind === 'namespace') {
      scope.scopes.set(n.qualifiedName, n);
      scope.byPath.set(n.qualifiedName.split('::').join('.'), n);
    }
    if (n.kind !== 'import') continue;
    if (n.signature) scope.aliases.set(n.name, n.signature);
    // `#load "a.fsx"` is an import node too, but names a file, not a scope.
    else if (!/[.]fsx?$/i.test(n.name)) scope.opens.push(n.name);
  }
  perFile.set(filePath, scope);
  return scope;
}

const isAutoOpen = (module: Node | undefined): boolean => module?.kind === 'module' && module.decorators?.some((d) => d.startsWith('AutoOpen')) === true;

/** Is the character part of a name? */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_']/u.test(ch);
}

/** Index of the first mention of `name` as a whole word in `line` at or after `from`, or -1. */
function indexOfWord(line: string, name: string, from: number): number {
  for (let at = line.indexOf(name, from); at >= 0; at = line.indexOf(name, at + 1)) {
    if (!isNameChar(line[at - 1]) && !isNameChar(line[at + name.length])) return at;
  }
  return -1;
}

/** How far below the reference's own line its name may be written: a pipeline continues on the next lines. */
const QUALIFIER_WINDOW = 8;

/** The longest qualifier read back; anything longer is not a name. */
const MAX_QUALIFIER = 240;

/**
 * Read the qualifier written just before `line[at]`: `Utils` in `Utils.helper`,
 * `Other.Lib.Fn` in `Other.Lib.Fn.helper`. Empty when the name is bare, `_` when
 * what precedes the dot is not a name (`(f x).Add`, `xs.[0].Add`). Reads backwards
 * from the name, so a long line costs only the qualifier.
 */
function qualifierBefore(line: string, at: number): string | null {
  let i = at - 1;
  while (i >= 0 && line[i] === ' ') i--;
  if (line[i] !== '.') return null;
  const segments: string[] = [];
  const stop = Math.max(-1, i - MAX_QUALIFIER);
  while (line[i] === '.' && i > stop) {
    i--;
    while (i >= 0 && line[i] === ' ') i--;
    let start: number;
    if (line[i] === '`' && line[i - 1] === '`') {
      start = line.lastIndexOf('``', i - 2);
      if (start < 0 || start <= stop) return '_';
    } else {
      start = i;
      while (start >= 0 && start > stop && isNameChar(line[start])) start--;
      start++;
      if (start > i) return '_';
    }
    segments.unshift(line.slice(start, i + 1));
    i = start - 1;
    while (i >= 0 && line[i] === ' ') i--;
  }
  return segments.join('.');
}

/**
 * The qualifier a reference's name is written with, aliases expanded: a module
 * alias (`module F = Other.Lib.Fn`) is replaced by what it names. The reference
 * points at the start of its expression, so the name is looked for from there on
 * its line and on the few lines below it, and the first mention is the one.
 */
function writtenQualifiers(ref: UnresolvedRef, aliases: ReadonlyMap<string, string>, context: ResolutionContext): string[] {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/) ?? [];
  for (let i = 0; i < QUALIFIER_WINDOW; i++) {
    const line = lines[ref.line - 1 + i];
    if (line === undefined) break;
    let at = indexOfWord(line, ref.referenceName, i === 0 ? Math.min(ref.column, line.length) : 0);
    if (at < 0 && i === 0) at = indexOfWord(line, ref.referenceName, 0);
    if (at < 0) continue;
    const written = qualifierBefore(line, at);
    if (written === null || written === '') return [];
    if (written === '_') return ['_'];
    const [head = '', ...rest] = written.split('.');
    const target = aliases.get(head);
    return [target ? [target, ...rest].join('.') : written];
  }
  return [];
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

/** A capitalised dotted path that no project declaration ends in: `System.Threading.Tasks.Task`, though `Settings.Current` may be. */
function isExternalPath(qualifier: string, context: ResolutionContext): boolean {
  if (!qualifier.includes('.') || !qualifier.split('.').every(namesContainer)) return false;
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
  const qualifiers = writtenQualifiers(ref, file.aliases, context);
  const scope: FsharpRefScope = {
    container,
    namespace: from && from.kind !== 'file' ? declaredNamespace(from, context) : '',
    opens: file.opens,
    qualifiers,
    externalQualifier: qualifiers.length > 0 && qualifiers.every((q) => isExternalPath(q, context)),
  };
  REF_SCOPES.set(ref, scope);
  return scope;
}

/**
 * The containers whose opening exposes an F# candidate unqualified: the one it
 * is declared in — for a union case, the one its type is declared in, and
 * none for a case of a .NET-style `enum`, which is always written through its
 * type — and, while that is an `[<AutoOpen>]` module, the one around it.
 */
function holdersOf(candidate: Node, file: FileScope): string[] {
  const segments = candidate.qualifiedName.split('::').slice(0, -1);
  if (candidate.kind === 'enum_member') {
    if (file.scopes.get(segments.join('::'))?.kind === 'enum') return [];
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

const CANDIDATE_SCOPES = new WeakMap<ResolutionContext, Map<string, FsharpCandidateScope>>();

/** Forget what was read from files and candidates; called when the resolver drops its caches after a sync. */
export function clearFsharpScopeCaches(context: ResolutionContext): void {
  FILE_SCOPES.delete(context);
  DECLARED_NAMESPACES.delete(context);
  CANDIDATE_SCOPES.delete(context);
}

/** Where a candidate is declared, read once per candidate. */
function scopeOfCandidate(candidate: Node, context: ResolutionContext): FsharpCandidateScope {
  let perContext = CANDIDATE_SCOPES.get(context);
  if (!perContext) CANDIDATE_SCOPES.set(context, (perContext = new Map()));
  const cached = perContext.get(candidate.id);
  if (cached) return cached;
  // A C# or VB.NET declaration is reached through its namespace like an F# one.
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
  };
  perContext.set(candidate.id, scope);
  return scope;
}

/** Is `candidate` something `ref` can mean? Always true for refs and candidates F# has nothing to say about. */
export function isFsharpCandidateInScope(candidate: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  // C#, VB.NET and Razor reach F# declarations through their own `using` rules, which nothing models: silent beats wrong.
  if (ref.language !== 'fsharp') return candidate.language !== 'fsharp' || !DOTNET_REFERRERS.has(ref.language);
  // A Razor component is not something F# names.
  if (candidate.language === 'razor') return false;
  if (!SCOPED_LANGUAGES.has(candidate.language)) return true;
  if (!SYMBOL_REFERENCE_KINDS.has(ref.referenceKind) || NON_SYMBOL_KINDS.has(candidate.kind)) return true;
  // A call invokes something; a module is a scope — in any file, so a `module Order` beside `type Order` is not its constructor.
  if (ref.referenceKind === 'calls' && candidate.kind === 'module') return false;

  const sameFile = candidate.filePath === ref.filePath;
  const refScope = scopeOfRef(ref, context);
  // Through a value, a member of this very file is not scoped by anything but its type.
  if (sameFile && refScope.qualifiers.length > 0 && !refScope.qualifiers.some(namesContainer)) return true;

  const scope = scopeOfCandidate(candidate, context);
  // A C# or VB.NET declaration outside every namespace is global.
  if (candidate.language !== 'fsharp' && scope.container === '') return true;
  return isFsharpCandidateReachable(refScope, scope, sameFile);
}
