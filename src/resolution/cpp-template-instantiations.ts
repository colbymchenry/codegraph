/**
 * A C++ template parameter reaches the classes the template is instantiated
 * with.
 *
 * `Txn::PutEntity(…)` in rocksdb's `template <typename Txn> class
 * SecondaryIndexMixin` is a member of whatever class the template is given, so
 * no lookup at the call can answer it. A guess by name is no answer: the rule
 * that took `WriteCommittedTxn::PutEntity` because the class's name ends in
 * `Txn` sent other calls to the wrong class, and every such call now fails
 * (gateTypeParameter). What decides the target is written elsewhere, in
 * `new SecondaryIndexMixin<WriteCommittedTxn>(…)`, and with several
 * instantiations there is no one target: each really runs its own. So this is
 * a whole-graph pass over the references that failed, not a resolver: one
 * reference gets one edge per class the project writes as the argument.
 *
 * What it reads, from each failed reference that goes through a parameter:
 *  - The template that declares the parameter, and which parameter it is: the
 *    function's own head, the class templates around it, or, defined outside
 *    its class, the head that matches `C<T>::` (cppTemplateHeads). A gtest
 *    `TYPED_TEST(Fixture, Name)` body's `TypeParam` is the fixture's first.
 *  - An alias of a member of a parameter counts as that member:
 *    `using KeyGen = typename TypeParam::KeyGen;`.
 *  - A variable declared with such a type counts too: `shard.Clear()` on a
 *    `CacheShard& shard`.
 *  - A class template's instantiations are wherever `Name<…>` is written and
 *    `Name` is that class by C++ lookup: a base clause, a variable, member or
 *    `new`, an alias, `template class Name<Foo>;`, gtest's `::testing::Types`
 *    through `TYPED_TEST_SUITE`. A function template's are the calls the graph
 *    already holds, read for the `f<Foo>(…)` they write, or for the type of
 *    the argument that decides what `f(x)` deduces.
 *  - An argument that is itself a parameter of a template around the site is
 *    followed to that template's instantiations, a few hops at most.
 *  - An argument is a project class by the lookup a declared type gets
 *    (cppClassWritten), a class local to the function that writes it first,
 *    in a file that sees it. Anything else (`std::string`, `int`, a pointer)
 *    gives no edge, and takes nothing from the other instantiations.
 *  - The member must be that class's own or inherited (cppMethodOf); a
 *    constructor is chosen as a declared object's is (matchCppConstructor).
 *  - An instantiation a specialization takes runs the specialization's
 *    members, not the members of the template it specializes.
 *
 * The argument's site is the edge's `registeredAt`: a file holding only an
 * instantiation is what the edge depends on, so a sync that touches it runs
 * this pass again. Nothing here looks at an edge a resolver made, and a
 * reference with no answer stays failed.
 */
import type { Edge, EdgeKind, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext, UnresolvedRef } from './types';
import { matchCppConstructor } from './cpp-constructor';
import { cppIncluders } from './cpp-includers';
import { cppMacroNamespaceFrames } from './cpp-namespaces';
import { cppLiteralsBlanked, cppNonCodeLines } from './cpp-raw-strings';
import { cppClassWritten, type CppNameSite } from './cpp-supertypes';
import {
  cppAliasWrittenAt,
  cppAliasedClass,
  cppClassNamed,
  cppDeclaresLocalAlias,
  cppParentScope,
  cppTemplateHeads,
  cppTemplateParametersIn,
  cppTypeNamed,
  cppTypeNamesDeclared,
  cppTypeSegments,
  isCppPointerType,
  resolveCppAliasedType,
  stripCppTemplateArguments,
  type CppTemplateParameter,
} from './cpp-type-aliases';
import {
  cppArgumentType,
  cppCallArguments,
  cppCallTemplateArguments,
  cppCallersMember,
  cppMethodOf,
  cppOverloadParameters,
  isCppLocalName,
  splitCppTopLevel,
} from './name-matcher';
import { LRUCache } from './lru-cache';
import { stripCommentsForRegex } from './strip-comments';
import { makeLineAt } from './synth-utils';

/**
 * How many classes one parameter may reach before it reaches none. A template
 * written with more than this is a container or a test helper, whose every
 * instantiation is no hop a flow takes (see AGENTS.md on a god-function's
 * fan-out). A template over the cap gets no edges, not some.
 */
export const CPP_TEMPLATE_ARGUMENT_CAP = 40;

/** How many templates an argument is followed through, from a parameter to the parameter it is written as. */
const MAX_TEMPLATE_HOPS = 4;
/** How far an argument list may run: a gtest list of types takes a line per type. */
const MAX_ARGUMENT_LIST = 64 * 1024;
/** How much text before a `Name<` tells what is written there: a template head, at most. */
const HEAD_WINDOW = 400;
/** How many files' text and declarations are kept: every file of most projects, and a bound on the rest. */
const MAX_FILES_HELD = 4096;
/** How many templates' instantiations are kept. */
const MAX_TEMPLATES_HELD = 1024;

const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'union']);
const FUNCTION_KINDS: ReadonlySet<string> = new Set(['function', 'method']);
/** What a template argument is written in, and so what a site can sit in. */
const DECLARATION_KINDS: ReadonlySet<string> = new Set([...CLASS_KINDS, ...FUNCTION_KINDS, 'type_alias', 'variable', 'constant']);

const CPP_FILE = /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx|cppm|ipp|inl|tcc)$/i;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** A call on a variable, as a reference spells it: `shard.Clear`, for `shard->Clear()` too. */
const VALUE_CALL = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
/** What a declaration may write around its type and between it and the name. */
const CV_QUALIFIER = /\b(?:const|volatile|typename|mutable|static)\b/g;
/** A declaration of a value: the type's first name, then the variable's: `Shard& shard`, `Shard::Part* part`, `T* NONNULL p`. */
const DECLARED_VALUE = /\b([A-Za-z_]\w*)(?:\s*::\s*[A-Za-z_]\w*)*(?:\s*<[^<>;{}()]*>)?[\s*&]+(?:[A-Z][A-Z0-9_]*\s+)*(?=([A-Za-z_]\w*)\b)/g;

/** gtest's macros that give a typed fixture its list of types, with the fixture. */
const TYPED_SUITE = /\b(?:TYPED_TEST_(?:SUITE|CASE)\s*\(|INSTANTIATE_TYPED_TEST_(?:SUITE|CASE)_P\s*\(\s*[A-Za-z_]\w*\s*,)\s*((?:::\s*)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*,/g;
/** How the index names a class it reads no name for, such as a specialization. */
const ANONYMOUS = '<anonymous>';
/** A class declaration that writes template arguments after its name, up to the `<`. */
const SPECIALIZATION_HEAD = /^(?:class|struct|union)\s+(?:[A-Z][A-Z0-9_]*(?:\([^()]*\))?\s+)*((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*</;
/** A class head right before a name (macros and qualifiers between): `struct EXPORT ns::`. */
const CLASS_HEAD = /\b(?:class|struct|union)\s+(?:[A-Z][A-Z0-9_]*(?:\([^()]*\))?\s+)*(?:[\w:]+::\s*)?$/;
/** Something only the arguments decide, which no comparison of what is written can: `std::enable_if_t<…>`. */
const CONDITION = /\b(?:enable_if|void_t|disjunction|conjunction|negation|conditional|requires)\w*|\bis_\w+/;

/** A template's head, as the declaration it belongs to writes it. */
interface Template {
  /** One per template, whichever declaration of it a reference is in. */
  key: string;
  kind: 'class' | 'alias' | 'function';
  name: string;
  /** The declaration of a class or alias template; the very function for a function template. */
  node: Node;
  parameters: readonly CppTemplateParameter[];
  /** What a specialization writes after the name (`T*`, `int`); null for the template itself. */
  pattern: readonly string[] | null;
}

/** A parameter of a template. */
interface Slot {
  template: Template;
  index: number;
}

/** A reference that goes through a parameter. */
interface Through {
  slot: Slot;
  /** The parameter as the code around the reference names it. */
  parameter: string;
  /** Member types between the parameter and what is named: `Key` of `T::Key::Make`, or of an alias of `T::Key`. */
  types: readonly string[];
  /** The member called: `Make`; null for the type itself. */
  member: string | null;
  /** The argument count of a constructor call: `T x(a, b);`. */
  arity: number | null;
}

/** Where a type name is written: what it is looked up from. */
interface Place {
  file: string;
  line: number;
  scope: string;
  /** The declaration around it. */
  around: Node | null;
  /** The templates around it, innermost first. */
  templates: readonly Template[];
  /** The names that are parameters there, those of a head no node holds as well. */
  parameters: ReadonlySet<string>;
  ref: UnresolvedRef;
}

/** A template argument as written. */
interface Argument {
  text: string;
  place: Place;
}

/** A written `Name<…>` that names a template. */
interface Instantiation {
  args: readonly Argument[];
}

/** A call of a function template. */
interface Call {
  ref: UnresolvedRef;
  place: Place;
  /** The template arguments it writes; null for none, leaving them to be deduced. */
  args: readonly Argument[] | null;
}

/** One argument a specialization writes: `T`, `T*`, `int`, or a condition on `T`. */
interface PatternItem {
  text: string;
  /** The parameter it is, whole. */
  parameter?: string;
  pack?: boolean;
  /** What only the arguments decide. */
  condition?: boolean;
  /** How it reads a parameter out of an argument, with the parameters it does. */
  shape?: RegExp;
  words: readonly string[];
}

/** A specialization of a class template: `template <class T> class Name<T*>`. */
interface Specialization {
  pattern: readonly PatternItem[];
  /** The arguments as they compare, to find a declaration's own. */
  written: string;
}

/** What a class template's name is written as across the project. */
interface WrittenTemplate {
  instantiations: Instantiation[];
  specializations: Specialization[];
}

/** A file's text with comments and strings blanked, offsets kept. */
interface Source {
  text: string;
  lineAt: (offset: number) => number;
}

/** The arguments between the `<` at `open` and the `>` at `close`, split at the top level, each with where it starts. */
function argumentsBetween(text: string, open: number, close: number): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let parens = 0;
  let start = open + 1;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, offset: start + raw.indexOf(trimmed) });
  };
  for (let i = open + 1; i < close; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[') parens++;
    else if (c === ')' || c === ']') parens--;
    else if (parens > 0) continue;
    else if (c === '<') depth++;
    else if (c === '>' && text[i - 1] !== '-') depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close);
  return out;
}

/** The `>` closing the argument list opened at `open`, or -1 when `<` opens none there. */
function closingAngle(text: string, open: number): number {
  let depth = 0;
  let parens = 0;
  const end = Math.min(text.length, open + MAX_ARGUMENT_LIST);
  for (let i = open; i < end; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[') parens++;
    else if (c === ')' || c === ']') {
      if (--parens < 0) return -1;
    } else if (parens > 0) continue;
    else if (c === '<') depth++;
    else if (c === '>') {
      if (text[i - 1] === '-') continue;
      if (--depth === 0) return i;
    } else if (c === ';' || c === '{' || c === '}') return -1;
  }
  return -1;
}

const isWord = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

/** A copy of a name read from a file's text. V8 keeps a whole string alive for a long enough part of it. */
const detached = (name: string): string => `_${name}`.slice(1);

/** Add the names `text` writes right before a `<`. */
function addNamesBeforeAngle(text: string, names: Set<string>): void {
  for (let open = text.indexOf('<'); open >= 0; open = text.indexOf('<', open + 1)) {
    let end = open;
    while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
    let start = end;
    while (start > 0 && isWord(text.charCodeAt(start - 1))) start--;
    if (start < end) names.add(text.slice(start, end));
  }
}

/** The qualifiers `A<T>::B::` written right before `end`, outermost first, each with the arguments it writes. */
function qualifiersBefore(text: string, end: number): Array<{ name: string; args: string[] | null }> {
  const out: Array<{ name: string; args: string[] | null }> = [];
  let at = end;
  for (;;) {
    while (at > 0 && isSpace(text.charCodeAt(at - 1))) at--;
    if (text.slice(at - 2, at) !== '::') return out;
    at -= 2;
    while (at > 0 && isSpace(text.charCodeAt(at - 1))) at--;
    let args: string[] | null = null;
    if (text[at - 1] === '>') {
      let depth = 0;
      let i = at - 1;
      for (; i >= 0; i--) {
        if (text[i] === '>') depth++;
        else if (text[i] === '<' && --depth === 0) break;
      }
      if (i < 0) return out;
      args = argumentsBetween(text, i, at - 1).map((a) => a.text);
      at = i;
      while (at > 0 && isSpace(text.charCodeAt(at - 1))) at--;
    }
    let start = at;
    while (start > 0 && isWord(text.charCodeAt(start - 1))) start--;
    if (start === at) return out;
    out.unshift({ name: text.slice(start, at), args });
    at = start;
  }
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A written template argument as it compares: spaced only between words. */
function argumentKey(arg: string): string {
  return arg.replace(/\s*([^\w\s])\s*/g, '$1').replace(/\s+/g, ' ');
}

const slotKey = (slot: Slot): string => `${slot.template.key}#${slot.index}#${slot.template.pattern?.join() ?? ''}`;

/** Do the arguments a declaration writes for its template repeat its head: `C<T, U>` under `template <class T, class U>`? */
function isOwnHead(args: readonly string[], head: readonly CppTemplateParameter[]): boolean {
  return args.length === head.length && args.every((a, k) => a.replace(/\s*\.\.\.$/, '') === head[k]!.name);
}

/** A specialization, from the arguments it writes (as they compare) and its head. */
function specializationOf(args: readonly string[], parameters: readonly CppTemplateParameter[]): Specialization {
  const names = new Set(parameters.flatMap((p) => (p.name ? [p.name] : [])));
  const pattern = args.map((text): PatternItem => {
    const bare = text.replace(/\.\.\.$/, '');
    if (names.has(bare)) return { text, parameter: bare, pack: bare !== text, words: [] };
    const words = (text.match(/[A-Za-z_]\w*/g) ?? []).filter((w) => names.has(w));
    if (words.length === 0) return { text, words };
    if (CONDITION.test(text)) return { text, condition: true, words };
    return { text, words, shape: new RegExp(`^${text.split(/([A-Za-z_]\w*)/).map((part) => (names.has(part) ? '(.+)' : escapeRegExp(part))).join('')}$`) };
  });
  return { pattern, written: args.join() };
}

/** The `namespace a { … }` blocks of a blanked file, by offset, outermost first. */
function namespaceBlocks(text: string): Array<{ start: number; end: number; path: readonly string[] }> {
  const blocks: Array<{ start: number; end: number; path: readonly string[] }> = [];
  const open: Array<{ start: number; end: number; path: readonly string[] } | null> = [];
  let path: readonly string[] = [];
  for (const m of text.matchAll(/\bnamespace\b(?:\s+([A-Za-z_][\w:\s]*?))?\s*\{|[{}]/g)) {
    if (m[0] === '{') open.push(null);
    else if (m[0] === '}') {
      const block = open.pop();
      if (block) {
        block.end = m.index!;
        path = open.reduce<readonly string[]>((p, b) => b?.path ?? p, []);
      }
    } else {
      const names = m[1]?.replace(/\s+/g, '') ?? '';
      const block = { start: m.index!, end: text.length, path: names ? [...path, ...names.split('::')] : path };
      blocks.push(block);
      open.push(block);
      path = block.path;
    }
  }
  return blocks;
}

class TemplateInstantiations {
  private readonly sources = new LRUCache<string, Source | null>(MAX_FILES_HELD);
  private readonly declarations = new LRUCache<string, Node[]>(MAX_FILES_HELD);
  private readonly namespaces = new LRUCache<string, ReturnType<typeof namespaceBlocks>>(MAX_FILES_HELD);
  private readonly templates = new Map<string, readonly Template[]>();
  private readonly written = new LRUCache<string, WrittenTemplate>(MAX_TEMPLATES_HELD);
  private readonly calls = new Map<string, readonly Call[]>();
  private readonly seen = new Map<string, boolean>();
  private readonly values = new Map<string, ReadonlySet<string>>();
  /** The C and C++ files, each with the names it writes before a `<`, read once. */
  private readonly filesNaming = new Map<string, string[]>();
  /** The files that use gtest's typed tests. */
  private readonly typedFiles: string[] = [];
  private suites: Map<string, Array<{ file: string; offset: number; fixture: string }>> | null = null;
  private scanned = 0;

  constructor(
    private readonly queries: QueryBuilder,
    private readonly ctx: ResolutionContext,
    private readonly onYield: MaybeYield,
  ) {}

  /**
   * Read every C and C++ file once, for the names each writes before a `<`,
   * and return the names each that uses templates declares as a parameter or
   * an alias.
   */
  async read(): Promise<Map<string, ReadonlySet<string>>> {
    const declared = new Map<string, ReadonlySet<string>>();
    for (const file of [...this.ctx.getAllFiles()].sort()) {
      if (!CPP_FILE.test(file)) continue;
      if ((++this.scanned & 63) === 0) await this.onYield();
      const text = this.ctx.scanFile?.(file) ?? this.ctx.readFile(file);
      if (!text) continue;
      const names = new Set<string>();
      addNamesBeforeAngle(text, names);
      for (const name of names) {
        const list = this.filesNaming.get(name);
        if (list) list.push(file);
        else this.filesNaming.set(detached(name), [file]);
      }
      const typed = text.includes('TYPED_TEST');
      if (typed) this.typedFiles.push(file);
      if (!typed && !text.includes('template')) continue;
      const types = new Set([...cppTypeNamesDeclared(text)].map(detached));
      if (typed) types.add('TypeParam');
      declared.set(file, types);
    }
    return declared;
  }

  private lines(file: string): readonly string[] {
    return this.ctx.getFileLines?.(file) ?? this.ctx.readFile(file)?.split(/\r?\n/) ?? [];
  }

  /** The classes of a qualified name, in file and line order: the walks above take the first that fits. */
  private classesNamed(qualified: string): Node[] {
    return this.ctx.getNodesByQualifiedName(qualified).filter((n) => CLASS_KINDS.has(n.kind))
      .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) || a.startLine - b.startLine);
  }

  /** The declaration of a class or function around `node`, whose lines hold it, in the scope its qualified name gives. */
  private declarationAround(node: Node): Node | null {
    for (let scope = cppParentScope(node.qualifiedName); scope; scope = cppParentScope(scope)) {
      const around = this.ctx.getNodesByQualifiedName(scope).find((n) =>
        n.id !== node.id && (CLASS_KINDS.has(n.kind) || FUNCTION_KINDS.has(n.kind)) && n.filePath === node.filePath &&
        n.startLine <= node.startLine && (n.endLine ?? n.startLine) >= (node.endLine ?? node.startLine));
      if (around) return around;
    }
    return null;
  }

  /**
   * The class template a class declaration's head belongs to. A specialization
   * has no name of its own in the index (`<anonymous>`), and a nested class
   * defined outside its template names another class, so that is read from
   * what the declaration writes, `struct Traits<T*, int>`, and found as any
   * name is. Null when no class of that name is found.
   */
  private templateOfClass(decl: Node, head: readonly CppTemplateParameter[]): Template | null {
    const text = this.lines(decl.filePath).slice(decl.startLine - 1, decl.startLine + 7).join('\n').slice(decl.startColumn);
    const written = SPECIALIZATION_HEAD.exec(text);
    const close = written ? closingAngle(text, written[0].length - 1) : -1;
    const args = close < 0 ? null : argumentsBetween(text, written![0].length - 1, close).map((a) => a.text);
    const pattern = args && !isOwnHead(args, head) ? args : null;
    // `template <class T> struct List<T>::Node {`: its head is `List`'s.
    const nested = close >= 0 && /^\s*::/.test(text.slice(close + 1));
    if (decl.name !== ANONYMOUS && !nested) return this.classTemplate(decl, head, pattern);
    if (!args) return null;
    const place = this.placeIn(decl, decl.startLine);
    const found = cppClassWritten(written![1]!.replace(/\s+/g, ''), { ...this.site(place), scope: cppParentScope(decl.qualifiedName) }, place.ref, this.ctx);
    return found?.exact && CLASS_KINDS.has(found.node.kind) ? this.classTemplate(found.node, head, pattern) : null;
  }

  private classTemplate(decl: Node, parameters: readonly CppTemplateParameter[], pattern: readonly string[] | null): Template {
    return { key: `class:${decl.qualifiedName}@${decl.filePath}`, kind: 'class', name: decl.name, node: decl, parameters, pattern };
  }

  private functionTemplate(node: Node, parameters: readonly CppTemplateParameter[]): Template {
    return { key: `function:${node.id}`, kind: 'function', name: node.name, node, parameters, pattern: null };
  }

  /**
   * The class templates a definition outside its class writes in its
   * declarator (`template <class T> void C<T>::f()`), innermost first, after
   * a member template's own head.
   */
  private outOfLineTemplates(node: Node, heads: ReadonlyArray<readonly CppTemplateParameter[]>): Template[] {
    const text = this.lines(node.filePath).slice(node.startLine - 1, node.startLine + 11).join('\n').slice(node.startColumn);
    const name = new RegExp(String.raw`::\s*(?:template\s+)?~?${escapeRegExp(node.name)}\s*[(<]`).exec(text);
    const written = name ? qualifiersBefore(text, name.index + 2).filter((q) => q.args) : [];
    const out: Template[] = [];
    if (heads.length !== written.length && heads.length !== written.length + 1) return out;
    if (heads.length === written.length + 1) out.push(this.functionTemplate(node, heads[heads.length - 1]!));
    const segments = node.qualifiedName.split('::');
    for (let i = written.length - 1; i >= 0; i--) {
      const q = written[i]!;
      const head = heads[i]!;
      const at = segments.lastIndexOf(q.name, segments.length - 2);
      const decls = at < 0 ? [] : this.classesNamed(segments.slice(0, at + 1).join('::'));
      const decl = decls.find((n) => n.filePath === node.filePath) ?? decls.find((n) => this.sees(node.filePath, n));
      if (!decl || head.length === 0) continue;
      out.push(this.classTemplate(decl, head, isOwnHead(q.args!, head) ? null : q.args));
    }
    return out;
  }

  /** The typed fixture a gtest `TYPED_TEST` body is a member of, with `TypeParam` as its first parameter. */
  private typedTestTemplate(caller: Node): Template | null {
    if (caller.kind !== 'function' || !/^TYPED_TEST(?:_P)?$/.test(caller.name)) return null;
    const head = this.lines(caller.filePath).slice(caller.startLine - 1, caller.startLine + 1).join(' ');
    const fixture = /\bTYPED_TEST(?:_P)?\s*\(\s*((?:::\s*)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)\s*,/.exec(head)?.[1];
    if (!fixture) return null;
    const place = this.placeIn(caller, caller.startLine);
    const found = cppClassWritten(fixture.replace(/\s+/g, ''), this.site(place), place.ref, this.ctx);
    if (!found?.exact || !CLASS_KINDS.has(found.node.kind)) return null;
    return this.classTemplate(found.node, [{ name: 'TypeParam', pack: false, fallback: null }], null);
  }

  /** The templates around a declaration, innermost first, each with the parameters its body sees. */
  templatesAround(node: Node): readonly Template[] {
    const hit = this.templates.get(node.id);
    if (hit) return hit;
    const out: Template[] = [];
    this.templates.set(node.id, out);
    const heads = cppTemplateHeads(node, this.ctx);
    const around = this.declarationAround(node);
    if (heads.length > 0) {
      const own = heads[heads.length - 1]!;
      if (CLASS_KINDS.has(node.kind)) {
        const template = this.templateOfClass(node, own);
        if (template) out.push(template);
      } else if (node.kind === 'type_alias') {
        out.push({ key: `alias:${node.qualifiedName}`, kind: 'alias', name: node.name, node, parameters: own, pattern: null });
      } else if (FUNCTION_KINDS.has(node.kind)) {
        if (around || !cppParentScope(node.qualifiedName)) out.push(this.functionTemplate(node, own));
        else out.push(...this.outOfLineTemplates(node, heads));
      }
    }
    const typed = this.typedTestTemplate(node);
    if (typed) out.push(typed);
    if (around) out.push(...this.templatesAround(around));
    return out;
  }

  private slotNamed(name: string, templates: readonly Template[]): Slot | null {
    for (const template of templates) {
      const index = template.parameters.findIndex((p) => p.name === name);
      if (index >= 0) return { template, index };
    }
    return null;
  }

  /**
   * The parameter a type written as `segments` starts with where `ref` is
   * made, with the member types after it: itself, or through an alias
   * (`using KeyGen = typename TypeParam::KeyGen;`).
   */
  private parameterOf(segments: readonly string[], ref: UnresolvedRef, caller: Node): { slot: Slot; parameter: string; types: string[] } | null {
    const head = segments[0]!;
    const direct = this.slotNamed(head, this.templatesAround(caller));
    if (direct) return { slot: direct, parameter: head, types: segments.slice(1) };
    const alias = cppAliasWrittenAt(head, ref, this.ctx);
    const written = alias && cppTypeSegments(alias.text);
    if (!written) return null;
    const slot = this.slotNamed(written[0]!, this.templatesAround(alias.alias ?? caller));
    return slot ? { slot, parameter: written[0]!, types: [...written.slice(1), ...segments.slice(1)] } : null;
  }

  /**
   * The names a function's lines declare with a type that starts with a name
   * of `types`, a parameter or an alias: all a call on a variable of the
   * function's own can go through. Typing every variable a template calls
   * something on would be most of what this pass costs.
   */
  private localValues(caller: Node, types: ReadonlySet<string>): ReadonlySet<string> {
    const hit = this.values.get(caller.id);
    if (hit) return hit;
    const values = new Set<string>();
    const text = this.lines(caller.filePath).slice(caller.startLine - 1, caller.endLine ?? caller.startLine).join('\n').replace(CV_QUALIFIER, ' ');
    for (const m of text.matchAll(DECLARED_VALUE)) if (types.has(m[1]!)) values.add(m[2]!);
    this.values.set(caller.id, values);
    return values;
  }

  /** A call on a variable whose declared type is a parameter: `shard.Clear()` on a `CacheShard& shard`, `p->Clear()` on a `T* p`. */
  private throughValue(ref: UnresolvedRef, caller: Node, receiver: string, member: string, types: ReadonlySet<string>): Through | null {
    if (this.templatesAround(caller).length === 0) return null;
    let text: string | undefined;
    if (this.localValues(caller, types).has(receiver)) {
      const declared = cppArgumentType(receiver, ref, this.ctx);
      text = declared?.kind === 'type' ? declared.text : undefined;
    } else {
      // (Typing an argument leaves out a member of a template parameter's type.)
      const field = cppCallersMember(receiver, caller, ref, this.ctx)?.text;
      const head = field ? cppTypeSegments(field)?.[0] : undefined;
      if (head && types.has(head) && !isCppLocalName(receiver, caller, ref, this.ctx)) text = field;
    }
    const written = text ? cppTypeSegments(text) : null;
    const type = written && this.parameterOf(written, ref, caller);
    if (!type) return null;
    // A `->` on a value of the parameter's type is the argument's own `operator->`.
    const line = this.lines(ref.filePath)[ref.line - 1] ?? '';
    const arrow = new RegExp(String.raw`\b${receiver}\s*->\s*(?:template\s+)?${member}\b`).test(line);
    return arrow !== isCppPointerType(text!) ? null : { ...type, member, arity: null };
  }

  /** How a reference goes through a parameter, or null when it doesn't. */
  through(ref: UnresolvedRef, caller: Node, types: ReadonlySet<string>): Through | null {
    const value = VALUE_CALL.exec(ref.referenceName);
    if (value) return this.throughValue(ref, caller, value[1]!, value[2]!, types);
    const constructor = /^(.*)::([^:]+)\/(\d+)$/.exec(ref.referenceName);
    const segments = (constructor ? constructor[1]! : ref.referenceName).replace(/::\s*template\s+/g, '::').split('::');
    if (!segments.every((s) => IDENTIFIER.test(s))) return null;
    const type = this.parameterOf(segments, ref, caller);
    if (!type) return null;
    if (constructor) return { ...type, member: null, arity: Number(constructor[3]) };
    if (ref.referenceKind === 'instantiates') return { ...type, member: null, arity: null };
    return { ...type, types: type.types.slice(0, -1), member: type.types[type.types.length - 1]!, arity: null };
  }

  private source(file: string): Source | null {
    let source = this.sources.get(file);
    if (source === undefined) {
      const raw = this.ctx.readFile(file);
      const text = raw === null ? null : stripCommentsForRegex(raw, 'cpp');
      source = text === null ? null : { text, lineAt: makeLineAt(text, 1) };
      this.sources.set(file, source);
    }
    return source;
  }

  private declarationsIn(file: string): Node[] {
    let decls = this.declarations.get(file);
    if (!decls) {
      decls = this.ctx.getNodesInFile(file).filter((n) => DECLARATION_KINDS.has(n.kind) && (n.language === 'cpp' || n.language === 'c'));
      this.declarations.set(file, decls);
    }
    return decls;
  }

  /** The tightest declaration whose lines hold `line`. */
  private declarationAt(file: string, line: number): Node | null {
    let best: Node | null = null;
    for (const n of this.declarationsIn(file)) {
      if (n.startLine > line || (n.endLine ?? n.startLine) < line) continue;
      if (!best || n.startLine > best.startLine || (n.startLine === best.startLine && (n.endLine ?? n.startLine) < (best.endLine ?? best.startLine))) best = n;
    }
    return best;
  }

  /** The namespace at `offset`, outside every declaration: the index holds no node for one. */
  private namespaceAt(file: string, offset: number, line: number): string {
    const source = this.source(file);
    if (!source) return '';
    let blocks = this.namespaces.get(file);
    if (!blocks) this.namespaces.set(file, (blocks = namespaceBlocks(source.text)));
    let path: readonly string[] = [];
    for (const block of blocks) if (block.start <= offset && offset < block.end) path = block.path;
    const macros = cppMacroNamespaceFrames(file, this.ctx).filter((f) => f.start <= line && f.end >= line).flatMap((f) => f.path);
    return [...macros, ...path].join('::');
  }

  private placeIn(around: Node, line: number): Place {
    const file = around.filePath;
    const scope = CLASS_KINDS.has(around.kind) ? around.qualifiedName : cppParentScope(around.qualifiedName);
    const ref: UnresolvedRef = { fromNodeId: around.id, referenceName: '', referenceKind: 'references', line, column: 0, filePath: file, language: 'cpp' };
    return { file, line, scope, around, templates: [], parameters: new Set(), ref };
  }

  private parametersOf(templates: readonly Template[]): Set<string> {
    const parameters = new Set<string>();
    for (const t of templates) for (const p of t.parameters) if (p.name) parameters.add(p.name);
    return parameters;
  }

  /** Where a caller's call, or the body of a template, writes a name. */
  private placeOfCaller(caller: Node, line: number): Place {
    const templates = this.templatesAround(caller);
    return { ...this.placeIn(caller, line), templates, parameters: this.parametersOf(templates) };
  }

  /** Where the text at `offset` of `file` is written. */
  private placeAt(file: string, offset: number): Place {
    const source = this.source(file)!;
    const line = source.lineAt(offset);
    const around = this.declarationAt(file, line);
    const place: Place = around ? this.placeOfCaller(around, line) : {
      file, line, around: null, templates: [], parameters: new Set<string>(),
      scope: this.namespaceAt(file, offset, line),
      ref: { fromNodeId: '', referenceName: '', referenceKind: 'references', line, column: 0, filePath: file, language: 'cpp' },
    };
    // A head no node holds: a prototype's, or a default's in a head.
    const start = Math.max(source.text.lastIndexOf(';', offset), source.text.lastIndexOf('{', offset), source.text.lastIndexOf('}', offset)) + 1;
    const statement = source.text.slice(start, offset);
    if (statement.includes('template')) {
      const parameters = new Set(place.parameters);
      for (const name of cppTypeNamesDeclared(`${statement}>`)) parameters.add(name);
      place.parameters = parameters;
    }
    return place;
  }

  private site(place: Place): CppNameSite {
    return { scope: place.scope, file: place.file, line: place.line, parameters: place.parameters, sees: (n) => this.sees(place.file, n) };
  }

  /**
   * Can code in `file` see `decl`: its own, what it includes, or a header
   * beside it in one translation unit? A project's vendored copy of itself
   * declares the same names, and nothing it declares is any other file's.
   */
  private sees(file: string, decl: Node): boolean {
    if (decl.filePath === file) return true;
    const key = `${file}\0${decl.filePath}`;
    let seen = this.seen.get(key);
    if (seen === undefined) {
      const includers = cppIncluders(decl.filePath, this.ctx);
      seen = includers.has(file) || cppIncluders(file, this.ctx).has(decl.filePath);
      if (!seen) for (const unit of cppIncluders(file, this.ctx)) if (includers.has(unit)) { seen = true; break; }
      this.seen.set(key, seen);
    }
    return seen;
  }

  /** Is the line a preprocessor directive, or a continuation of one? */
  private isDirective(file: string, line: number): boolean {
    const lines = this.lines(file);
    let at = line - 1;
    while (at > 0 && /\\\s*$/.test(lines[at - 1] ?? '')) at--;
    return /^\s*#/.test(lines[at] ?? '');
  }

  /** Is what the line holds at the column code, not a string or a comment? */
  private isCode(file: string, line: number, column: number, name: string): boolean {
    return cppLiteralsBlanked(this.lines(file)[line - 1] ?? '', line, cppNonCodeLines(file, this.ctx)).startsWith(name, column);
  }

  /**
   * Is the declaration a lookup found in `file` `template`? Two headers can
   * declare one name for separate translation units, and so can two source
   * files: abseil's map and set tests each have a `ConstructorTest`.
   */
  private isTemplate(found: Node, template: Template, file: string): boolean {
    return found.qualifiedName === template.node.qualifiedName && this.sees(file, template.node);
  }

  /** Every `name<…>` a class or alias template is written as, and its specializations, in file and offset order. */
  private async writtenAs(template: Template): Promise<WrittenTemplate> {
    const hit = this.written.get(template.key);
    if (hit) return hit;
    const out: WrittenTemplate = { instantiations: [], specializations: [] };
    this.written.set(template.key, out);
    const { name } = template;
    for (const file of this.filesNaming.get(name) ?? []) {
      if ((++this.scanned & 15) === 0) await this.onYield();
      const source = this.source(file);
      if (!source) continue;
      const { text } = source;
      for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
        if (at > 0 && isWord(text.charCodeAt(at - 1))) continue;
        let open = at + name.length;
        while (open < text.length && isSpace(text.charCodeAt(open))) open++;
        if (text[open] !== '<') continue;
        const close = closingAngle(text, open);
        if (close < 0) continue;
        const before = text.slice(Math.max(0, at - HEAD_WINDOW), at);
        // (`x.get<Foo>()` and `p->get<Foo>()` call a member template.)
        if (/(?:\.|->)\s*(?:template\s+)?$/.test(before) || /\bfriend\s+(?:class|struct)\s+[\w:\s]*$/.test(before)) continue;
        const line = source.lineAt(at);
        if (this.isDirective(file, line) || !this.isCode(file, line, at - text.lastIndexOf('\n', at) - 1, name)) continue;
        const place = this.placeAt(file, at);
        const written = [...qualifiersBefore(text, at).map((q) => q.name), name].join('::');
        const site = template.kind === 'alias' ? { ...this.site(place), declared: true } : this.site(place);
        const found = cppClassWritten(written, site, place.ref, this.ctx);
        if (!found?.exact || !this.isTemplate(found.node, template, file)) continue;
        const args = argumentsBetween(text, open, close).map((a) => ({ text: a.text, place: { ...place, line: source.lineAt(a.offset) } }));
        const after = text.slice(close + 1, close + 8);
        // `template class Name<Foo>;` instantiates; `template <…> class Name<T*> {` specializes.
        const keyword = CLASS_HEAD.exec(before);
        const head = keyword && /^\s*(?:[{;]|:(?!:)|final\b)/.test(after) ? /\btemplate\s*<([^;{}]*)>\s*$/.exec(before.slice(0, keyword.index)) : null;
        if (head) {
          out.specializations.push(specializationOf(args.map((a) => argumentKey(a.text)), cppTemplateParametersIn(head[1]!)));
          continue;
        }
        out.instantiations.push({ args });
      }
    }
    if (template.kind === 'class') for (const list of this.typedLists(template)) out.instantiations.push(list);
    return out;
  }

  /** gtest's typed fixtures, by their last name, with where each is given its list of types. */
  private typedSuites(): Map<string, Array<{ file: string; offset: number; fixture: string }>> {
    if (this.suites) return this.suites;
    const suites = new Map<string, Array<{ file: string; offset: number; fixture: string }>>();
    for (const file of this.typedFiles) {
      const source = this.source(file);
      if (!source) continue;
      for (const m of source.text.matchAll(TYPED_SUITE)) {
        if (this.isDirective(file, source.lineAt(m.index!))) continue;
        const fixture = m[1]!.replace(/\s+/g, '');
        const last = fixture.slice(fixture.lastIndexOf(':') + 1);
        const list = suites.get(last);
        const suite = { file, offset: m.index! + m[0].length, fixture };
        if (list) list.push(suite);
        else suites.set(last, [suite]);
      }
    }
    this.suites = suites;
    return suites;
  }

  /** The instantiations `TYPED_TEST_SUITE(Fixture, Types)` writes for a fixture: one per listed type. */
  private typedLists(template: Template): Instantiation[] {
    const out: Instantiation[] = [];
    for (const suite of this.typedSuites().get(template.name) ?? []) {
      const place = this.placeAt(suite.file, suite.offset);
      const found = cppClassWritten(suite.fixture, this.site(place), place.ref, this.ctx);
      if (!found?.exact || !this.isTemplate(found.node, template, suite.file)) continue;
      for (const arg of this.typeList(suite.file, suite.offset, 0)) out.push({ args: [arg] });
    }
    return out;
  }

  /** The types a `::testing::Types<…>` written at `offset` of `file` lists, directly or through an alias of it. */
  private typeList(file: string, offset: number, hops: number): Argument[] {
    const source = this.source(file);
    if (!source || hops > 3) return [];
    const { text } = source;
    const from = text.slice(offset, offset + HEAD_WINDOW);
    const list = /\bTypes\s*</.exec(from);
    const end = /[,;)]/.exec(from)?.index ?? 0;
    if (list && list.index < Math.max(end, 1)) {
      const open = offset + list.index + list[0].length - 1;
      const close = closingAngle(text, open);
      if (close < 0) return [];
      const place = this.placeAt(file, open);
      return argumentsBetween(text, open, close).map((a) => ({ text: a.text, place: { ...place, line: source.lineAt(a.offset) } }));
    }
    const name = from.slice(0, end).replace(/\s+/g, '');
    if (!cppTypeSegments(name)) return [];
    const place = this.placeAt(file, offset);
    const found = cppClassWritten(name, { ...this.site(place), declared: true }, place.ref, this.ctx);
    if (!found || found.node.kind !== 'type_alias') return [];
    const alias = found.node;
    const aliased = this.source(alias.filePath);
    if (!aliased) return [];
    let start = 0;
    for (let i = 1; i < alias.startLine; i++) start = aliased.text.indexOf('\n', start) + 1;
    return this.typeList(alias.filePath, start + alias.startColumn, hops + 1);
  }

  /** A function template's calls, in file and line order, with the arguments each writes. */
  private callsOf(template: Template): readonly Call[] {
    const hit = this.calls.get(template.key);
    if (hit) return hit;
    const out: Call[] = [];
    for (const edge of this.queries.getIncomingEdges(template.node.id, ['calls', 'references'])) {
      const caller = this.ctx.getNodeById?.(edge.source);
      if (!caller || edge.line === undefined || edge.line === null || !this.sees(caller.filePath, template.node)) continue;
      const ref: UnresolvedRef = {
        fromNodeId: caller.id, referenceName: template.name, referenceKind: 'calls',
        line: edge.line, column: edge.column ?? 0, filePath: caller.filePath, language: 'cpp',
      };
      const place = this.placeOfCaller(caller, edge.line);
      const args = cppCallTemplateArguments(ref, this.ctx)?.map((text) => ({ text, place })) ?? null;
      out.push({ ref, place, args });
    }
    out.sort((a, b) => (a.ref.filePath < b.ref.filePath ? -1 : a.ref.filePath > b.ref.filePath ? 1 : 0) || a.ref.line - b.ref.line || a.ref.column - b.ref.column);
    this.calls.set(template.key, out);
    return out;
  }

  /**
   * The argument a call deduces for a parameter a function's own parameter
   * has as its whole type (`T`, `const T&`, `T&&`, `T*`), when the call's
   * argument there has a written type: the deduction has nothing else to go
   * on, and what it deduces is exact.
   */
  private deduced(template: Template, index: number, call: Call): Argument | null {
    const name = template.parameters[index]!.name;
    if (!name) return null;
    const list = cppOverloadParameters(template.node, template.name, this.ctx);
    if (list === null) return null;
    const type = new RegExp(String.raw`^(?:const\s+)?${escapeRegExp(name)}\s*(?:const\s*)?(\*|&&?)?\s*(?:const\s+)?(?:[A-Za-z_]\w*)?\s*(?:=.*)?$`, 's');
    const parameters = splitCppTopLevel(list);
    const position = parameters.findIndex((p) => type.test(p.trim()));
    if (position < 0) return null;
    const given = cppCallArguments(call.ref, template.name, this.ctx)?.[position];
    const argument = given === undefined ? null : cppArgumentType(given, call.ref, this.ctx);
    if (argument?.kind !== 'type') return null;
    const value = argument.text.replace(/&+\s*$/, '').trim();
    if (type.exec(parameters[position]!.trim())?.[1] !== '*') return { text: value, place: call.place };
    return /\*\s*(?:const\s*)?$/.test(value) ? { text: value.replace(/\*\s*(?:const\s*)?$/, '').trim(), place: call.place } : null;
  }

  /** The arguments a site gives a parameter of the template itself; its default stands in for one it doesn't write. */
  private argumentsFor(slot: Slot, args: readonly Argument[]): readonly Argument[] {
    const parameter = slot.template.parameters[slot.index]!;
    if (parameter.pack) return args.slice(slot.index);
    const given = args[slot.index];
    if (given) return [given];
    if (parameter.fallback === null || slot.template.kind === 'function') return [];
    const decl = slot.template.node;
    return [{ text: parameter.fallback, place: this.placeOfCaller(decl, decl.startLine) }];
  }

  /**
   * What the specialization binds its parameters to, when `args` can be taken
   * by it: `Foo` for `T` of `Name<T*>` given `Name<Foo*>`. Null when what each
   * side writes tells it isn't taken. A condition (`enable_if_t<…>`) can't be
   * told from what is written, and counts as taken.
   */
  private bindings(spec: Specialization, primary: readonly CppTemplateParameter[], args: readonly string[]): Map<string, string[]> | null {
    const bound = new Map<string, string[]>();
    for (let i = 0; i < spec.pattern.length; i++) {
      const item = spec.pattern[i]!;
      if (item.parameter) {
        const given = item.pack ? args.slice(i) : args[i] !== undefined ? [args[i]!] : [];
        bound.set(item.parameter, [...(bound.get(item.parameter) ?? []), ...given]);
        continue;
      }
      if (item.condition) continue;
      const given = args[i] ?? (primary[i]?.fallback ? argumentKey(primary[i]!.fallback!) : null);
      if (given === null) return null;
      if (!item.shape) {
        if (given !== item.text && !given.endsWith(`::${item.text}`) && !item.text.endsWith(`::${given}`)) return null;
        continue;
      }
      const m = item.shape.exec(given);
      if (!m) return null;
      item.words.forEach((w, k) => bound.set(w, [m[k + 1]!]));
    }
    return bound;
  }

  /** The arguments each instantiation gives a parameter, once specializations have taken theirs. */
  private async argumentsOf(slot: Slot): Promise<Argument[]> {
    const { template, index } = slot;
    if (template.kind === 'function') {
      return this.callsOf(template).flatMap((call) => {
        const written = this.argumentsFor(slot, call.args ?? []);
        const deduced = written.length === 0 ? this.deduced(template, index, call) : null;
        return deduced ? [deduced] : written;
      });
    }
    const { instantiations, specializations } = await this.writtenAs(template);
    const primary = specializations.length === 0 ? template.parameters : this.primaryParameters(template);
    const own = template.pattern?.map(argumentKey).join() ?? null;
    const out: Argument[] = [];
    for (const site of instantiations) {
      const given = specializations.length > 0 ? site.args.map((a) => argumentKey(a.text)) : [];
      const taken = specializations.flatMap((spec) => {
        const bound = this.bindings(spec, primary, given);
        return bound ? [{ spec, bound }] : [];
      });
      if (own === null) {
        if (taken.length === 0) out.push(...this.argumentsFor(slot, site.args));
        continue;
      }
      // A specialization's own members, from the instantiations only it takes.
      if (taken.length !== 1 || taken[0]!.spec.written !== own) continue;
      const name = template.parameters[index]?.name;
      const place = site.args[0]?.place;
      if (name && place) for (const text of taken[0]!.bound.get(name) ?? []) out.push({ text, place });
    }
    return out;
  }

  /** The head of the template itself, whichever declaration a reference is in. */
  private primaryParameters(template: Template): readonly CppTemplateParameter[] {
    if (!template.pattern) return template.parameters;
    for (const decl of this.classesNamed(template.node.qualifiedName)) {
      const heads = cppTemplateHeads(decl, this.ctx);
      const head = heads[heads.length - 1];
      if (head && !this.templateOfClass(decl, head)?.pattern) return head;
    }
    return [];
  }

  /**
   * The classes a parameter reaches, each once, with the argument that writes
   * it: those its own instantiations write, then those of each template whose
   * parameter they pass on, a hop at a time and each parameter once, so a
   * cycle ends. It stops past the cap: all that is known then is the cap.
   */
  async classesOf(start: Slot): Promise<Map<string, { node: Node; at: Argument }>> {
    const classes = new Map<string, { node: Node; at: Argument }>();
    const seen = new Set([slotKey(start)]);
    let frontier = [start];
    for (let hop = 0; hop <= MAX_TEMPLATE_HOPS && frontier.length > 0; hop++) {
      const next: Slot[] = [];
      for (const slot of frontier) {
        for (const arg of await this.argumentsOf(slot)) {
          const text = arg.text.replace(/\s*\.\.\.$/, '').trim();
          const name = text.replace(/\b(?:const|volatile|typename)\b/g, ' ').trim();
          const outer = IDENTIFIER.test(name) ? this.slotNamed(name, arg.place.templates) : null;
          if (outer) {
            if (!seen.has(slotKey(outer))) next.push(outer);
            seen.add(slotKey(outer));
            continue;
          }
          const node = this.classWritten(text, arg.place);
          if (node && !classes.has(node.id)) classes.set(node.id, { node, at: arg });
          if (classes.size > CPP_TEMPLATE_ARGUMENT_CAP) return classes;
        }
      }
      frontier = next;
    }
    return classes;
  }

  /** The project class an argument names, or null. */
  private classWritten(text: string, place: Place): Node | null {
    const plain = stripCppTemplateArguments(text);
    if (/[&*()[\]]/.test(plain) || isCppPointerType(text) || /\bdecltype\b/.test(plain)) return null;
    const segments = cppTypeSegments(text);
    if (!segments) return null;
    if (place.around && FUNCTION_KINDS.has(place.around.kind)) {
      const fn = place.around;
      if (segments.length === 1) {
        // A class local to the function that writes it, which the index names after the function alone.
        const local = this.declarationsIn(place.file).filter((n) => CLASS_KINDS.has(n.kind) && n.name === segments[0] &&
          n.startLine >= fn.startLine && (n.endLine ?? n.startLine) <= (fn.endLine ?? fn.startLine) && n.startLine <= place.line);
        if (local.length > 0) return local[local.length - 1]!;
      }
      if (cppDeclaresLocalAlias(text, place.ref, this.ctx)) {
        const aliased = resolveCppAliasedType(text, place.ref, this.ctx);
        const named = aliased && !aliased.pointer ? cppAliasedClass(aliased, this.ctx, place.ref) : undefined;
        return named ? this.classesNamed(named).find((n) => this.sees(place.file, n)) ?? null : null;
      }
    }
    const found = cppClassWritten(text, this.site(place), place.ref, this.ctx);
    // (A lookup falls back on what it can't see when that is all a name has: a copy
    // of the project declares it plainly where the project's own macro hides it.)
    return found?.exact && CLASS_KINDS.has(found.node.kind) && this.sees(place.file, found.node) ? found.node : null;
  }

  /** What a reference through a parameter names in the class its argument is, or null. */
  target(cls: Node, through: Through, ref: UnresolvedRef): Node | null {
    const { types, member, arity } = through;
    const spelled = types.join('::');
    const visible = (n: Node): boolean => this.sees(cls.filePath, n);
    if (member === null && arity === null) {
      if (types.length === 0) return cls;
      const named = cppTypeNamed(spelled, [cls.qualifiedName], ref, this.ctx, visible);
      if (!named) return null;
      if ('alias' in named) return named.alias;
      if ('enums' in named) return named.enums[0] ?? null;
      return this.classNode(named.cls, cls);
    }
    let owner: Node | null = cls;
    if (types.length > 0) {
      const named = cppClassNamed(spelled, [cls.qualifiedName], ref, this.ctx, visible);
      owner = named && 'cls' in named ? this.classNode(named.cls, cls) : null;
    }
    if (!owner) return null;
    if (arity !== null) {
      const made = matchCppConstructor({ ...ref, referenceName: `::${owner.qualifiedName}::${owner.name}/${arity}` }, this.ctx);
      return made ? this.ctx.getNodeById?.(made.targetNodeId) ?? null : null;
    }
    return cppMethodOf(owner, member!, ref, this.ctx);
  }

  private classNode(qualified: string, near: Node): Node | null {
    const classes = this.classesNamed(qualified);
    return classes.find((n) => n.filePath === near.filePath) ?? classes.find((n) => this.sees(near.filePath, n)) ?? null;
  }
}

const position = (a: UnresolvedRef, b: UnresolvedRef): number =>
  (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) || a.line - b.line || a.column - b.column ||
  (a.referenceName < b.referenceName ? -1 : a.referenceName > b.referenceName ? 1 : 0) ||
  (a.referenceKind < b.referenceKind ? -1 : a.referenceKind > b.referenceKind ? 1 : 0);

const EDGE_KIND: Readonly<Record<string, EdgeKind>> = { calls: 'calls', instantiates: 'instantiates', function_ref: 'references' };

/**
 * One edge per class a failed reference through a template parameter reaches
 * (see the top of this file). Reads the graph and source only.
 */
export async function cppTemplateArgumentEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const reader = new TemplateInstantiations(queries, ctx, onYield);
  // A name in a template's head or an alias, by file: most references go no further.
  const declared = await reader.read();
  if (declared.size === 0) return [];
  const refs: UnresolvedRef[] = [];
  for (const ref of queries.iterateFailedCppTypeReferences()) {
    const names = declared.get(ref.filePath as string);
    const head = /^[A-Za-z_]\w*/.exec(ref.referenceName)?.[0];
    if (names && head && (names.has(head) || ref.referenceName.includes('.'))) refs.push(ref as UnresolvedRef);
  }
  refs.sort(position);
  const groups = new Map<string, { slot: Slot; refs: Array<{ ref: UnresolvedRef; through: Through }> }>();
  let scanned = 0;
  for (const ref of refs) {
    if ((++scanned & 255) === 0) await onYield();
    const caller = ctx.getNodeById?.(ref.fromNodeId);
    if (!caller) continue;
    const through = reader.through(ref, caller, declared.get(ref.filePath)!);
    if (!through) continue;
    const key = slotKey(through.slot);
    const group = groups.get(key);
    if (group) group.refs.push({ ref, through });
    else groups.set(key, { slot: through.slot, refs: [{ ref, through }] });
  }
  const edges: Edge[] = [];
  for (const group of groups.values()) {
    await onYield();
    const classes = await reader.classesOf(group.slot);
    if (classes.size > CPP_TEMPLATE_ARGUMENT_CAP) continue;
    for (const { ref, through } of group.refs) {
      for (const { node, at } of classes.values()) {
        const target = reader.target(node, through, ref);
        if (!target || target.id === ref.fromNodeId) continue;
        edges.push({
          source: ref.fromNodeId,
          target: target.id,
          kind: EDGE_KIND[ref.referenceKind]!,
          line: ref.line,
          column: ref.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'cpp-template-argument',
            via: through.parameter,
            argument: node.name,
            registeredAt: `${at.place.file}:${at.place.line}`,
            ...(ref.referenceKind === 'function_ref' ? { fnRef: true } : {}),
          },
        });
      }
    }
  }
  return edges;
}
