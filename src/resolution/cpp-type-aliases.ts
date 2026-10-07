/**
 * C++ type aliases in a declared type: `typedef X Y;` and `using Y = X;`.
 *
 * Both extractors index an alias as a `type_alias` node and record nothing
 * about the type it names, so a receiver declared through one used to be
 * looked up by the alias's own name. google/leveldb's `MemTable::Add` calls
 * `table_.Insert(buf)` on a member `Table table_;`, with
 * `typedef SkipList<const char*, KeyComparator> Table;` declared beside it in
 * the class. No class `Table` has an `Insert` (the one class `Table` is the
 * unrelated `leveldb::Table`), so the call fell through to a guess by the
 * receiver's name and reached `HandleTable::Insert`.
 *
 * A name is looked up the way C++ looks it up: from the innermost scope of
 * the code that uses it outwards. That is an alias declared earlier in the
 * calling function, then the caller's class and that class's bases, then the
 * classes and namespaces around it, and the global scope. The first scope
 * that declares the name decides; a class there is the type itself. An alias
 * there is read from its own declaration and followed from the alias's own
 * scope, for a few hops at most. A qualified name is resolved a segment at a
 * time, so `Table::Iterator` is `SkipList::Iterator` and `MemTable::Table`
 * is `SkipList`. Template arguments are dropped. An alias of what only a
 * template argument decides (`using Type = GenericType;` in the template
 * that declares `GenericType`, `typename Traits::Field`) or of a
 * `decltype(…)` names no particular class, and is reported as such.
 */
import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';

/** Kinds that declare a type name in a scope, besides an alias. */
const DECLARING_KINDS: ReadonlySet<string> = new Set([
  'class', 'struct', 'union', 'enum', 'interface', 'namespace', 'module',
]);
const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'union']);

/** How many aliases one name is followed through (`A` → `B` → `C`). */
const MAX_HOPS = 4;
/** How many base classes deep a member is looked for. */
const MAX_BASE_DEPTH = 4;
/** How far past a class's first line its base clause may run. */
const HEAD_LINES = 12;

/**
 * What a type named through an alias resolved to: the aliased type as written
 * in `scope` (`['SkipList']`), then the rest of the name that followed the
 * alias (`['Iterator']` for `Table::Iterator`).
 */
export interface CppAliasedType {
  target: string[];
  rest: string[];
  /** The qualified scope `target` is written in (`''` for the global scope). */
  scope: string;
  /** An alias on the way named a pointer (`using Field = const FieldDescriptor*;`). */
  pointer: boolean;
  /**
   * The type is a class template of the project (or a class nested in one),
   * whose specializations can declare members the primary template doesn't.
   */
  classTemplate: boolean;
}

/** A written type's `::` segments, each with whether template arguments followed it. */
interface TypeName {
  names: string[];
  templated: boolean[];
}

/** `SkipList<const char*, Cmp<int>>::Iterator` → `SkipList::Iterator`. */
function stripTemplateArguments(text: string): string {
  let out = '';
  let depth = 0;
  for (const c of text) {
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** The `::` segments of a written type, or null when it is not a plain (possibly qualified) type name. */
function cppTypeName(raw: string): TypeName | null {
  const parts: string[] = [];
  const templated: boolean[] = [];
  let depth = 0;
  let part = '';
  let args = false;
  const text = raw.replace(/\b(?:const|volatile|mutable|typename|template|class|struct|union|enum)\b/g, ' ').replace(/[&*]+/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '<') {
      depth++;
      args = true;
    } else if (c === '>') depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (c === ':' && text[i + 1] === ':') {
      parts.push(part.trim());
      templated.push(args);
      part = '';
      args = false;
      i++;
    } else part += c;
  }
  parts.push(part.trim());
  templated.push(args);
  if (parts[0] === '') {
    // A leading `::` names the global scope.
    parts.shift();
    templated.shift();
  }
  if (parts.length === 0 || !parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) return null;
  return { names: parts, templated };
}

/** Is a written type a pointer (`Table*`, `const Foo* const`), not counting its template arguments? */
export function isCppPointerType(raw: string): boolean {
  return stripTemplateArguments(raw).includes('*');
}

/**
 * The `::` segments of a written type: `const ns::Foo<T>&` → `['ns', 'Foo']`.
 * Null when what is written is not a plain (possibly qualified) type name —
 * `unsigned int`, `decltype(…)`, a function type.
 */
export function cppTypeSegments(raw: string): string[] | null {
  return cppTypeName(raw)?.names ?? null;
}

/**
 * The top-level arguments of the first template argument list in a written
 * type: `['Iterator']` for `const std::unique_ptr<Iterator>&`, `['Foo',
 * 'Deleter<Foo>']` for `std::unique_ptr<Foo, Deleter<Foo>>`. Null when it has
 * none, or the list is not closed.
 */
export function cppTemplateArguments(raw: string): string[] | null {
  const open = raw.indexOf('<');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === '<') depth++;
    else if (raw[i] === '>' && --depth === 0) return splitTopLevel(raw.slice(open + 1, i)).map((a) => a.trim());
  }
  return null;
}

/** C and C++ declare the names a C++ file can see (a header may be either). */
function isCFamily(n: Node): boolean {
  return n.language === 'cpp' || n.language === 'c';
}

/** Scopes visible from inside the scope `qualified`, innermost first, ending with the global scope. */
function scopesWithin(qualified: string): string[] {
  const parts = qualified ? qualified.split('::') : [];
  const scopes: string[] = [];
  for (let i = parts.length; i >= 0; i--) scopes.push(parts.slice(0, i).join('::'));
  return scopes;
}

/** The scope a declaration sits in: `leveldb::MemTable` for `leveldb::MemTable::Table`. */
function parentScope(qualified: string): string {
  const cut = qualified.lastIndexOf('::');
  return cut < 0 ? '' : qualified.slice(0, cut);
}

/** The scope the code that makes `ref` is written in: its class for a method, itself for a class. */
function callerScope(caller: Node | null | undefined): string {
  if (!caller || caller.kind === 'file') return '';
  return DECLARING_KINDS.has(caller.kind) ? caller.qualifiedName : parentScope(caller.qualifiedName);
}

function linesOf(filePath: string, context: ResolutionContext): string[] | null {
  return context.getFileLines?.(filePath) ?? context.readFile(filePath)?.split(/\r?\n/) ?? null;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text of `node`'s declaration, cut to its columns when they fit the lines. */
function declarationText(node: Node, context: ResolutionContext): string | null {
  const lines = linesOf(node.filePath, context);
  if (!lines) return null;
  const span = lines.slice(node.startLine - 1, node.endLine ?? node.startLine);
  if (span.length === 0) return null;
  const whole = span.join('\n');
  if (span.length === 1) {
    span[0] = span[0]!.slice(node.startColumn, node.endColumn);
  } else {
    span[0] = span[0]!.slice(node.startColumn);
    span[span.length - 1] = span[span.length - 1]!.slice(0, node.endColumn);
  }
  const cut = span.join('\n');
  return /\b(?:typedef|using)\b/.test(cut) ? cut : whole;
}

/** Split `text` on commas outside `<>`, `()`, `[]` and `{}`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * What an alias of `name` declares in `text`, as written: `SkipList<const
 * char*, KeyComparator>` for `typedef SkipList<const char*, KeyComparator>
 * Table;` and for `using Table = SkipList<const char*, KeyComparator>;`.
 * Null when `text` declares no alias of that name.
 */
function aliasedTypeIn(text: string, name: string): string | null {
  const escaped = escapeRegExp(name);
  const using = new RegExp(String.raw`\busing\s+${escaped}\s*(?:\[\[[^\]]*\]\]\s*)?=\s*([^;]+)`).exec(text);
  if (using) return using[1]!.trim();
  const typedef = /\btypedef\b([^;]+)/.exec(text);
  if (!typedef) return null;
  // `typedef Foo* FooPtr, FooObj;` indexes its first declarator; the type is
  // what precedes that declarator's name.
  const declared = new RegExp(String.raw`^([\s\S]*?)\b${escaped}\s*$`).exec(splitTopLevel(typedef[1]!)[0]!);
  return declared?.[1]?.trim() || null;
}

/** Is `alias` an alias template (`template <typename T> using Vec = std::vector<T>;`)? */
function isAliasTemplate(alias: Node, context: ResolutionContext): boolean {
  const lines = linesOf(alias.filePath, context);
  if (!lines) return false;
  const before = [
    ...lines.slice(Math.max(0, alias.startLine - 4), alias.startLine - 1),
    (lines[alias.startLine - 1] ?? '').slice(0, alias.startColumn),
  ].join(' ');
  return /\btemplate\s*<[^;{}]*>\s*$/.test(before);
}

const LOCAL_ALIAS_LINES = new WeakMap<ResolutionContext, Map<string, number[]>>();

/** The lines of a function's body that declare an alias (`typedef …;`, `using X = …;`), last first. */
function localAliasLines(caller: Node, lines: readonly string[], context: ResolutionContext): number[] {
  let memo = LOCAL_ALIAS_LINES.get(context);
  if (!memo) LOCAL_ALIAS_LINES.set(context, (memo = new Map()));
  let found = memo.get(caller.id);
  if (!found) {
    found = [];
    const last = Math.min(caller.endLine ?? caller.startLine, lines.length);
    for (let i = last - 1; i >= caller.startLine - 1 && i >= 0; i--) {
      if (/\b(?:typedef\b|using\s+\w+\s*=)/.test(lines[i]!)) found.push(i);
    }
    memo.set(caller.id, found);
  }
  return found;
}

/**
 * The type an alias declared earlier in the calling function names, as
 * written. Those aliases are not indexed, so the function's own lines are
 * read, from the call back to the function's first line.
 */
function localAliasedType(name: string, caller: Node | null | undefined, ref: UnresolvedRef, context: ResolutionContext): string | null | undefined {
  if (!caller || (caller.kind !== 'function' && caller.kind !== 'method') || caller.filePath !== ref.filePath) return undefined;
  const lines = linesOf(ref.filePath, context);
  if (!lines) return undefined;
  const declares = new RegExp(String.raw`\b(?:using\s+${escapeRegExp(name)}\s*=|typedef\b[^;]*\b${escapeRegExp(name)}\s*[;,])`);
  for (const i of localAliasLines(caller, lines, context)) {
    if (i > ref.line - 1) continue;
    const line = lines[i]!;
    if (line.includes(name) && declares.test(line)) return aliasedTypeIn(line, name);
  }
  return undefined;
}

/** What a scope declares under a name. */
type Declared =
  | { alias: Node }
  /** A class, struct or union, by its qualified name. */
  | { cls: string }
  /** An enum, namespace or other non-class type. */
  | 'other'
  /**
   * Aliases naming different types, none of them the calling file's: rocksdb's
   * `using DBWithTTLImplBase = …;` in each arm of an `#if USE_COROUTINES`.
   */
  | { ambiguous: Node[] }
  | undefined;

/** Which declarations a lookup can see; every one of them unless a caller narrows it. */
type Visible = (n: Node) => boolean;

/** C and C++ declarations named `name` that can stand for a type or scope. */
function typeDeclarations(name: string, context: ResolutionContext, visible?: Visible): Node[] {
  return context.getNodesByName(name).filter((n) =>
    isCFamily(n) && (n.kind === 'type_alias' || DECLARING_KINDS.has(n.kind)) && (!visible || visible(n)));
}

function declaredIn(
  scope: string,
  name: string,
  named: readonly Node[],
  templated: boolean,
  ref: UnresolvedRef,
  context: ResolutionContext,
): Declared {
  const qualified = scope ? `${scope}::${name}` : name;
  let here = named.filter((n) => n.qualifiedName === qualified);
  // An alias template is only ever named with template arguments.
  if (!templated) here = here.filter((n) => n.kind !== 'type_alias' || !isAliasTemplate(n, context));
  if (here.length === 0) return undefined;
  // `typedef struct Node Node;` declares the struct as well.
  if (here.some((n) => CLASS_KINDS.has(n.kind))) return { cls: qualified };
  if (here.some((n) => n.kind !== 'type_alias')) return 'other';
  const alias = pickAlias(here, ref, context);
  return alias ? { alias } : { ambiguous: here };
}

/**
 * One of several aliases a scope declares under one name (a translation unit
 * sees one of them): the one in the calling file, then in its header, then
 * any of them when they all name the same type.
 */
function pickAlias(aliases: Node[], ref: UnresolvedRef, context: ResolutionContext): Node | null {
  if (aliases.length === 1) return aliases[0]!;
  const sameFile = aliases.filter((a) => a.filePath === ref.filePath);
  if (sameFile.length === 1) return sameFile[0]!;
  const stem = (p: string): string => p.replace(/\.[^./\\]+$/, '');
  const header = aliases.filter((a) => stem(a.filePath) === stem(ref.filePath));
  if (header.length === 1) return header[0]!;
  const named = new Set(aliases.map((a) => {
    const text = declarationText(a, context);
    const type = text ? aliasedTypeIn(text, a.name) : null;
    return type ? (cppTypeSegments(type)?.join('::') ?? type) : null;
  }));
  return named.size === 1 && !named.has(null) ? aliases[0]! : null;
}

const BASES = new WeakMap<ResolutionContext, Map<string, string[]>>();
const TEMPLATE_PARAMETERS = new WeakMap<ResolutionContext, Map<string, ReadonlySet<string>>>();

/** Drop the memos of class bases, template parameters and local aliases (see ReferenceResolver.clearCaches). */
export function clearCppTypeAliasMemos(context: ResolutionContext): void {
  BASES.delete(context);
  TEMPLATE_PARAMETERS.delete(context);
  LOCAL_ALIAS_LINES.delete(context);
}

/** Add the parameter names of the `template <…>` header that ends right where a declaration starts. */
function collectTemplateHeader(lines: readonly string[], startLine: number, startColumn: number, names: Set<string>): void {
  const before = [...lines.slice(Math.max(0, startLine - 4), startLine - 1), (lines[startLine - 1] ?? '').slice(0, startColumn)].join('\n');
  const at = before.lastIndexOf('template');
  const header = at < 0 ? null : /^template\s*<([\s\S]*)>\s*$/.exec(before.slice(at));
  if (!header) return;
  for (const item of splitTopLevel(header[1]!)) {
    // `typename T = int`, `template <typename> class Policy`, `typename... Ts`, `int N`.
    const declared = stripTemplateArguments(item).split('=')[0]!;
    const name = /([A-Za-z_]\w*)\s*$/.exec(declared)?.[1];
    if (name && name !== 'typename' && name !== 'class') names.add(name);
  }
}

/**
 * The template parameters in scope where `node` is declared: its own
 * `template <…>` header and those of the class templates around it.
 */
function templateParametersAround(node: Node, context: ResolutionContext): ReadonlySet<string> {
  let memo = TEMPLATE_PARAMETERS.get(context);
  if (!memo) TEMPLATE_PARAMETERS.set(context, (memo = new Map()));
  const hit = memo.get(node.id);
  if (hit) return hit;
  const names = new Set<string>();
  const lines = linesOf(node.filePath, context);
  if (lines) {
    collectTemplateHeader(lines, node.startLine, node.startColumn, names);
    for (let scope = parentScope(node.qualifiedName); scope; scope = parentScope(scope)) {
      for (const cls of context.getNodesByQualifiedName(scope)) {
        if (!isCFamily(cls) || !CLASS_KINDS.has(cls.kind) || cls.filePath !== node.filePath) continue;
        if (node.startLine < cls.startLine || node.startLine > (cls.endLine ?? cls.startLine)) continue;
        collectTemplateHeader(lines, cls.startLine, cls.startColumn, names);
      }
    }
  }
  memo.set(node.id, names);
  return names;
}

/**
 * The qualified names of the classes `cls` derives from, read from the base
 * clause of its own declaration (`struct ParseProto2Descriptor :
 * Proto2Descriptor {`) and looked up from the scope the class is declared in.
 */
function baseClassesOf(cls: string, context: ResolutionContext): string[] {
  let memo = BASES.get(context);
  if (!memo) BASES.set(context, (memo = new Map()));
  const hit = memo.get(cls);
  if (hit) return hit;
  memo.set(cls, []);
  const bases: string[] = [];
  for (const decl of context.getNodesByQualifiedName(cls)) {
    if (!isCFamily(decl) || !CLASS_KINDS.has(decl.kind)) continue;
    const lines = linesOf(decl.filePath, context);
    if (!lines) continue;
    const head = lines.slice(decl.startLine - 1, decl.startLine - 1 + HEAD_LINES);
    if (head.length === 0) continue;
    head[0] = head[0]!.slice(decl.startColumn);
    const text = head.join('\n');
    const brace = text.indexOf('{');
    // A forward declaration (`class Foo;`) has no base clause of its own.
    if (brace < 0 || text.slice(0, brace).includes(';')) continue;
    const colon = text.slice(0, brace).search(/(?<!:):(?!:)/);
    if (colon < 0) continue;
    for (const part of splitTopLevel(text.slice(colon + 1, brace))) {
      const name = cppTypeName(part.replace(/\b(?:public|protected|private|virtual)\b/g, ' '));
      if (!name) continue;
      const base = classNamed(name.names, scopesWithin(parentScope(cls)), context);
      if (base && base !== cls && !bases.includes(base)) bases.push(base);
    }
  }
  memo.set(cls, bases);
  return bases;
}

/** The qualified name of the class `names` spells, looked up from `scopes`. */
function classNamed(names: readonly string[], scopes: readonly string[], context: ResolutionContext): string | undefined {
  const spelled = names.join('::');
  for (const scope of scopes) {
    const qualified = scope ? `${scope}::${spelled}` : spelled;
    if (context.getNodesByQualifiedName(qualified).some((n) => isCFamily(n) && CLASS_KINDS.has(n.kind))) return qualified;
  }
  return undefined;
}

/** `name` declared in class `cls` or one of its bases. */
function memberOf(
  cls: string,
  name: string,
  named: readonly Node[],
  templated: boolean,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
  seen: Set<string> = new Set(),
): Declared {
  const own = declaredIn(cls, name, named, templated, ref, context);
  if (own !== undefined || depth >= MAX_BASE_DEPTH) return own;
  seen.add(cls);
  for (const base of baseClassesOf(cls, context)) {
    if (seen.has(base)) continue;
    const inherited = memberOf(base, name, named, templated, ref, context, depth + 1, seen);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

/** `name` looked up unqualified from `scopes`, innermost first; a class scope includes its bases. */
function lookupUnqualified(
  name: string,
  templated: boolean,
  scopes: readonly string[],
  ref: UnresolvedRef,
  context: ResolutionContext,
  visible?: Visible,
): Declared {
  const named = typeDeclarations(name, context, visible);
  if (named.length === 0) return undefined;
  for (const scope of scopes) {
    const found = scope ? memberOf(scope, name, named, templated, ref, context) : declaredIn('', name, named, templated, ref, context);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The type a C++ declared type names once the aliases in it are followed,
 * looked up from the code that makes `ref`.
 *  - `undefined`: the type is not an alias; the caller keeps its own reading.
 *  - `null`: an alias that names no particular class: a template
 *    parameter's type (`using Type = GenericType;`, `typename
 *    Traits::Field`), a `decltype(…)` or a function type, or a chain of
 *    aliases too long to follow.
 */
export function resolveCppAliasedType(rawType: string, ref: UnresolvedRef, context: ResolutionContext): CppAliasedType | null | undefined {
  const name = cppTypeName(rawType);
  if (!name) return undefined;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const scope = callerScope(caller);
  const local = localAliasedType(name.names[0]!, caller, ref, context);
  const resolved = local !== undefined
    ? expand(local, name.names.slice(1), name.templated.slice(1), scope, ref, context, 1,
      caller ? templateParametersAround(caller, context) : undefined)
    : follow(name, scope, ref, context, 0);
  // `Table* table` is a pointer whatever `Table` names.
  return resolved && isCppPointerType(rawType) ? { ...resolved, pointer: true } : resolved;
}

/**
 * The name receiver inference gives a type resolved through aliases: the
 * aliased type's last segment (`SkipList`), as for any declared type, with
 * the nested part of a name reached through the alias kept on it
 * (`SkipList::Iterator`), since that owner is what names the nested type.
 */
export function cppAliasedTypeName(resolved: CppAliasedType): string {
  return [resolved.target[resolved.target.length - 1]!, ...resolved.rest].join('::');
}

/** What a C++ type name names when it is looked up for a class (see cppClassNamed). */
export type CppNamedClass =
  /** A class, by its qualified name. */
  | { cls: string }
  /**
   * An alias that leads to none of the project's classes: one of a type
   * outside the project (`template <bool B> using bool_constant =
   * std::integral_constant<bool, B>;`), of what a template argument decides,
   * or one each `#if` arm declares differently (the first declaration).
   */
  | { alias: Node }
  /** No particular class: an enum, a member of a type outside the project. */
  | null
  /** Nothing in the scopes looked in declares it. */
  | undefined;

/**
 * The class a C++ type written as `written` names, looked up from `scopes`
 * (innermost first) as a declared type is — a class scope with its bases, a
 * qualified name a segment at a time — and followed through an alias it
 * reaches: rocksdb's `InternalIterator` under `using InternalIterator =
 * InternalIteratorBase<Slice>;` names `InternalIteratorBase`. `visible`
 * narrows the declarations the lookup can see.
 */
export function cppClassNamed(
  written: string,
  scopes: readonly string[],
  ref: UnresolvedRef,
  context: ResolutionContext,
  visible?: Visible,
): CppNamedClass {
  const name = cppTypeName(written);
  if (!name) return null;
  const { found, next } = lookupSegments(name, scopes, ref, context, visible);
  if (found === undefined) return undefined;
  if (typeof found !== 'object') return null;
  if ('cls' in found) return found;
  if ('ambiguous' in found) {
    // An alias each `#if` arm declares differently: the first declaration.
    const [first] = [...found.ambiguous].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
    return next === name.names.length ? { alias: first! } : null;
  }
  const alias = found.alias;
  const text = declarationText(alias, context);
  // The aliased type is written in the alias's own scope.
  const aliased = expand(text ? aliasedTypeIn(text, alias.name) : null, name.names.slice(next), name.templated.slice(next),
    parentScope(alias.qualifiedName), ref, context, 1, templateParametersAround(alias, context));
  const cls = aliased && !aliased.pointer && classNamed([...aliased.target, ...aliased.rest], scopesWithin(aliased.scope), context);
  if (cls) return { cls };
  // A member of a type outside the project (`Alias::Inner`) is not the alias.
  return next === name.names.length ? { alias } : null;
}

/** The scopes visible from inside the scope `qualified`, innermost first, ending with the global scope. */
export function cppScopesWithin(qualified: string): string[] {
  return scopesWithin(qualified);
}

/** The scope a C++ declaration is declared in: `leveldb::MemTable` for `leveldb::MemTable::Table`. */
export function cppParentScope(qualified: string): string {
  return parentScope(qualified);
}

/** The template parameters in scope where `node` is declared: its own `template <…>` header and its class templates'. */
export function cppTemplateParameters(node: Node, context: ResolutionContext): ReadonlySet<string> {
  return templateParametersAround(node, context);
}

/**
 * What a written name declares, looked up from `scopes` (innermost first), and
 * how many of its segments that took: a class's member is looked up in the
 * class, and an alias ends the walk (`next` is where the rest of the name
 * starts).
 */
function lookupSegments(
  name: TypeName,
  scopes: readonly string[],
  ref: UnresolvedRef,
  context: ResolutionContext,
  visible?: Visible,
): { found: Declared; next: number } {
  let found = lookupUnqualified(name.names[0]!, name.templated[0]!, scopes, ref, context, visible);
  let next = 1;
  if (found === undefined && name.names.length > 1) {
    // Namespaces are not indexed: `detail::buffer_t` from inside `fmt` is
    // found by its spelling in an enclosing scope, longest prefix first.
    for (let i = name.names.length; i >= 2 && found === undefined; i--) {
      const spelled = name.names.slice(0, i);
      const named = typeDeclarations(spelled[spelled.length - 1]!, context, visible);
      for (const s of scopes) {
        found = declaredIn(s ? `${s}::${spelled.slice(0, -1).join('::')}` : spelled.slice(0, -1).join('::'),
          spelled[spelled.length - 1]!, named, name.templated[i - 1]!, ref, context);
        if (found !== undefined) break;
      }
      next = i;
    }
  }
  // `MemTable::Table`, `Table::Iterator`: one segment at a time.
  while (found && typeof found === 'object' && 'cls' in found && next < name.names.length) {
    found = memberOf(found.cls, name.names[next]!, typeDeclarations(name.names[next]!, context, visible), name.templated[next]!, ref, context);
    next++;
  }
  return { found, next };
}

function follow(
  name: TypeName,
  scope: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  hops: number,
): CppAliasedType | null | undefined {
  const { found, next } = lookupSegments(name, scopesWithin(scope), ref, context);
  if (!found || typeof found !== 'object' || !('alias' in found)) return undefined;
  const alias = found.alias;
  if (hops >= MAX_HOPS) return null;
  const text = declarationText(alias, context);
  // The aliased type is written in the alias's own scope.
  return expand(text ? aliasedTypeIn(text, alias.name) : null, name.names.slice(next), name.templated.slice(next),
    parentScope(alias.qualifiedName), ref, context, hops + 1, templateParametersAround(alias, context));
}

/**
 * Continue from the type an alias names, as written (`rest` followed the
 * alias in the name; `parameters` are the template parameters where it is
 * written).
 */
function expand(
  written: string | null,
  rest: readonly string[],
  restTemplated: readonly boolean[],
  scope: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  hops: number,
  parameters?: ReadonlySet<string>,
): CppAliasedType | null {
  // `typename Traits::Field`, `PolicyTemplate<const T>` inside the template
  // that declares `PolicyTemplate`: whatever a template argument makes it.
  if (!written || /\btypename\b/.test(written)) return null;
  const target = cppTypeName(written);
  if (!target || parameters?.has(target.names[0]!)) return null;
  const pointer = isCppPointerType(written);
  const names = [...target.names, ...rest];
  const further = follow({ names, templated: [...target.templated, ...restTemplated] }, scope, ref, context, hops);
  if (further === null) return null;
  if (further) return { ...further, pointer: further.pointer || pointer };
  const cls = classNamed(names, scopesWithin(scope), context);
  const classTemplate = !!cls && context.getNodesByQualifiedName(cls)
    .some((n) => isCFamily(n) && CLASS_KINDS.has(n.kind) && templateParametersAround(n, context).size > 0);
  return { target: target.names, rest: [...rest], scope, pointer, classTemplate };
}
