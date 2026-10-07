/**
 * A C or C++ base class — `class DynamicMessage final : public Message` — is
 * the class C++ name lookup finds for it.
 *
 * The base used to be matched by its name alone, so one named like a class of
 * another namespace, or of another language, bound to whichever namesake
 * ranked first: protobuf's `google::protobuf::DynamicMessage` derived from
 * `json_internal::ResolverPool::Message`, and before #2397 from the PHP
 * extension's C struct `Message`; leveldb's iterators from
 * `SkipList::Iterator`. A wrong supertype reaches everything that walks the
 * hierarchy: the supertype walk that finds an inherited method, the
 * cpp-override edges, the type hierarchy `codegraph_explore` prints.
 *
 * The name is looked up as C++ looks it up:
 *  - from the scope the class is declared in (its own members are not in
 *    scope in its base clause), outwards to the global scope; a class scope
 *    includes its bases, a qualified name is resolved a segment at a time and
 *    an alias is followed to the class it names (cpp-type-aliases.ts);
 *    `::Base` is the global one;
 *  - then through what the file writes before the class: a namespace alias
 *    (`namespace _pbi = ::google::protobuf::internal;`), a using-declaration
 *    (`using leveldb::FilterPolicy;`), a using-directive (`using namespace
 *    ROCKSDB_NAMESPACE;`); and through a namespace a macro opens
 *    (`fmt::detail::buffer` under fmt's FMT_BEGIN_NAMESPACE);
 *  - a class a source file (`.cc`, `.cpp`, `.c`) defines belongs to that
 *    translation unit, so only that file sees it (leveldb's skiplist test
 *    declares its own `leveldb::Comparator`);
 *  - a template parameter (`template <class Base> class X : public Base`) or
 *    a member of one (`public T::Base`) is whatever a template argument makes
 *    it: no edge.
 * When none of that finds the class, a class of that name that is the only
 * one the file can see is taken: the index loses a class's namespace in a
 * few shapes (`class PROTOBUF_EXPORT FieldDescriptor`, the classes after a
 * partial specialization), and the lookup from the wrong scope finds nothing.
 * Several such classes would be a guess, so there is no edge.
 *
 * Only C and C++ declarations are candidates, and no other strategy (a
 * framework's, the import resolver, name matching) sees these references.
 *
 * The same lookup (cppClassWritten) finds the class a `std::unique_ptr`,
 * `std::shared_ptr` or `std::optional` holds, for a `->` call on it, looked
 * up from the calling function (name-matcher's matchCppHeldTypeCall).
 */
import type { Node } from '../types';
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';
import {
  cppClassNamed,
  cppParentScope,
  cppScopesWithin,
  cppTemplateParameters,
  cppTypeSegments,
  type CppNamedClass,
} from './cpp-type-aliases';
import { cppMacroNamespaceFrames, cppNamespaceAliases } from './cpp-namespaces';
import { stripCommentsForRegex } from './strip-comments';

const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'union']);

/** A C or C++ source file, whose definitions belong to its own translation unit. */
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|c\+\+|cu|metal)$/i;

/** Does `ref` name a C or C++ class's base? */
export function isCppSupertypeRef(ref: UnresolvedRef): boolean {
  return (ref.language === 'cpp' || ref.language === 'c') &&
    (ref.referenceKind === 'extends' || ref.referenceKind === 'implements');
}

function isCFamily(n: Node): boolean {
  return n.language === 'cpp' || n.language === 'c';
}

/** The declarations code in `file` can see: a header's, and the file's own. */
function visibleFrom(file: string): (n: Node) => boolean {
  return (n) => n.filePath === file || !SOURCE_FILE.test(n.filePath);
}

export function matchCppSupertype(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const derived = context.getNodeById?.(ref.fromNodeId);
  if (!derived || !isCFamily(derived) || !CLASS_KINDS.has(derived.kind)) return null;
  const found = cppClassWritten(writtenBase(ref, context), {
    scope: cppParentScope(derived.qualifiedName),
    file: derived.filePath,
    line: ref.line,
    parameters: cppTemplateParameters(derived, context),
    self: derived,
  }, ref, context);
  if (!found) return null;
  return found.exact
    ? { original: ref, targetNodeId: found.node.id, confidence: 0.9, resolvedBy: 'qualified-name' }
    : { original: ref, targetNodeId: found.node.id, confidence: 0.7, resolvedBy: 'exact-match' };
}

/** Where a C or C++ type name is written, which is where its lookup starts. */
export interface CppNameSite {
  /**
   * The scope it is looked up from: a class's enclosing scope for its base
   * clause, the class of a method for code in the method.
   */
  scope: string;
  /** The file that writes it: its translation unit decides which classes it sees, and its `using`s before `line` apply. */
  file: string;
  line: number;
  /** The template parameters in scope there; a name that starts with one names no particular class. */
  parameters: ReadonlySet<string>;
  /** A class the name cannot be: the deriving class, in its own base clause. */
  self?: Node;
}

/** The class a C or C++ type name names. */
export interface CppWrittenClass {
  /** The class, or an alias of a type that is none of the project's classes. */
  node: Node;
  /** Found by C++ name lookup, rather than as the only class of that name the file can see. */
  exact: boolean;
}

/**
 * The class a C or C++ type name written at `site` names, looked up as the
 * comment at the top of this file says. Null when the name names no
 * particular class (a template parameter, an enum, a member of a type outside
 * the project); undefined when nothing the file can see is named so, or
 * several classes could be.
 */
export function cppClassWritten(written: string, site: CppNameSite, ref: UnresolvedRef, context: ResolutionContext): CppWrittenClass | null | undefined {
  const segments = cppTypeSegments(written);
  if (!segments) return null;
  const global = written.startsWith('::');
  if (!global && site.parameters.has(segments[0]!)) return null;

  const visible = visibleFrom(site.file);
  const scopes = cppScopesWithin(site.scope);
  const resolved = (node: Node): CppWrittenClass => ({ node, exact: true });

  // The scopes around the name, or only the global one for `::Base`.
  const lexical = classNode(cppClassNamed(written, global ? [''] : scopes, ref, context, visible), site, context);
  if (lexical !== undefined) return lexical && resolved(lexical);

  // What the file writes before the name, the nearest first: each stands for
  // the name's first segment, and the rest stays as written.
  const path = segments.join('::');
  const first = /^\s*(?:::\s*)?[A-Za-z_]\w*/.exec(written)?.[0] ?? '';
  const after = written.slice(first.length);
  const usings = usingsIn(site.file, context).filter((u) => u.line < site.line).reverse();
  const lookUp = (spelled: string): Node | undefined => {
    const absolute = spelled.startsWith('::');
    return classNode(cppClassNamed(spelled, absolute ? [''] : scopes, ref, context, visible), site, context) ?? undefined;
  };
  // `::_pbi::MessageGlobalsBase` under `namespace _pbi = ::google::protobuf::internal;`.
  if (segments.length > 1) {
    const local = usings.find((u) => u.kind === 'alias' && u.name === segments[0]);
    const target = local?.path ?? cppNamespaceAliases(context).get(segments[0]!);
    const hit = target ? lookUp(target + after) : undefined;
    if (hit) return resolved(hit);
  }
  if (!global) {
    // `using leveldb::FilterPolicy;` … `public FilterPolicy`.
    for (const u of usings) {
      if (u.kind !== 'declaration' || u.name !== segments[0]) continue;
      const hit = lookUp(u.path + after);
      if (hit) return resolved(hit);
    }
    // `using namespace ROCKSDB_NAMESPACE;` … `public EventListener`.
    for (const u of usings) {
      if (u.kind !== 'directive') continue;
      const hit = lookUp(`${u.path}::${written}`);
      if (hit) return resolved(hit);
    }
  }
  // `fmt::detail::buffer`, where a macro opens `namespace fmt` around `detail::buffer`.
  if (segments.length > 1) {
    const hit = pick(namedClasses(segments, site, context, visible)
      .filter((n) => macroQualifiedName(n, context) === path), site.file);
    if (hit) return resolved(hit);
  }
  // The only class of that name the file can see, by its qualified tail.
  const tail = namedClasses(segments, site, context, visible)
    .filter((n) => n.qualifiedName === path || n.qualifiedName.endsWith(`::${path}`));
  const own = tail.filter((n) => n.filePath === site.file);
  const sole = own.length > 0 ? own : tail;
  return sole.length === 1 ? { node: sole[0]!, exact: false } : undefined;
}

/**
 * The base as the base clause writes it, template arguments included
 * (`bool_constant<is_utf8_enabled>`): the reference carries the name without
 * them, and an alias template is only ever named with them. The reference's
 * own name when the source there reads otherwise.
 */
function writtenBase(ref: UnresolvedRef, context: ResolutionContext): string {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  const text = lines?.slice(ref.line - 1, ref.line + 11).join('\n').slice(Math.max(0, ref.column)) ?? '';
  let depth = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    // A template's `<` follows its name; `sizeof(T) <= 8` and `1 << n` compare and shift.
    const opens = c === '(' || (c === '<' && /\w/.test(text[i - 1] ?? '') && text[i + 1] !== '=' && text[i + 1] !== '<');
    const closes = c === ')' || (c === '>' && text[i - 1] !== '-' && text[i + 1] !== '=');
    if (opens) depth++;
    else if (closes) {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
    } else if (depth === 0 && (c === ',' || c === '{' || c === ';')) {
      end = i;
      break;
    }
  }
  const written = text.slice(0, end).trim();
  const squash = (s: string): string => s.replace(/\s+/g, '');
  return squash(stripTemplateArguments(written)) === squash(ref.referenceName) ? written : ref.referenceName.trim();
}

/** `Base<T, Cmp<int>>::Inner` → `Base::Inner`. */
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

/**
 * The node of the class a lookup found, as the file that writes the name sees
 * it (null: the name names no particular class; undefined: keep looking).
 */
function classNode(named: CppNamedClass, site: CppNameSite, context: ResolutionContext): Node | null | undefined {
  if (named === null || named === undefined) return named;
  if ('alias' in named) return named.alias;
  const classes = context
    .getNodesByQualifiedName(named.cls)
    .filter((n) => isCFamily(n) && CLASS_KINDS.has(n.kind) && n.id !== site.self?.id);
  // A lookup that ended on the class itself (its namespace lost) found nothing.
  if (classes.length === 0) return undefined;
  const visible = classes.filter(visibleFrom(site.file));
  return pick(visible.length > 0 ? visible : classes, site.file);
}

/**
 * One of several declarations of a class (separate translation units,
 * vendored copies): the one in `file` itself, then in its header, then the
 * nearest by path.
 */
function pick(classes: Node[], file: string): Node | undefined {
  if (classes.length <= 1) return classes[0];
  const own = classes.find((n) => n.filePath === file);
  if (own) return own;
  const stem = (p: string): string => p.replace(/\.[^./\\]+$/, '');
  const header = classes.find((n) => stem(n.filePath) === stem(file));
  if (header) return header;
  const shared = (p: string): number => {
    const a = p.split('/');
    const b = file.split('/');
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    return i;
  };
  return classes.reduce((best, n) => (shared(n.filePath) > shared(best.filePath) ? n : best));
}

/** C and C++ classes named like the last segment of `segments` that the file at `site` can see. */
function namedClasses(segments: readonly string[], site: CppNameSite, context: ResolutionContext, visible: (n: Node) => boolean): Node[] {
  return context
    .getNodesByName(segments[segments.length - 1]!)
    .filter((n) => isCFamily(n) && CLASS_KINDS.has(n.kind) && n.id !== site.self?.id && visible(n));
}

/** A declaration's qualified name with the namespaces macros open around it: `fmt::detail::buffer` for `detail::buffer`. */
function macroQualifiedName(n: Node, context: ResolutionContext): string {
  const prefix = cppMacroNamespaceFrames(n.filePath, context)
    .filter((f) => f.start <= n.startLine && f.end >= n.startLine)
    .sort((a, b) => a.start - b.start)
    .flatMap((f) => f.path);
  return prefix.length > 0 ? `${prefix.join('::')}::${n.qualifiedName}` : n.qualifiedName;
}

/** A `using` declaration or directive, or a namespace alias, a C or C++ file writes. */
interface CppUsing {
  line: number;
  kind: 'declaration' | 'directive' | 'alias';
  /** The name it brings in: the declared name, or the alias. */
  name: string;
  /** What it names, as written: `leveldb::FilterPolicy`, `ROCKSDB_NAMESPACE`, `::google::protobuf::internal`. */
  path: string;
}

const USINGS = new WeakMap<ResolutionContext, Map<string, CppUsing[]>>();

/** Drop the per-file `using` memo (see ReferenceResolver.clearCaches). */
export function clearCppSupertypeMemos(context: ResolutionContext): void {
  USINGS.delete(context);
}

const PATH = String.raw`(?:::\s*)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*`;
const USING = new RegExp(
  String.raw`\busing\s+namespace\s+(${PATH})\s*;` +
  String.raw`|\busing\s+(${PATH}\s*::\s*[A-Za-z_]\w*)\s*;` +
  String.raw`|\bnamespace\s+([A-Za-z_]\w*)\s*=\s*(${PATH})\s*;`,
  'g',
);

/** The `using` declarations and directives and namespace aliases of a file, in order. */
function usingsIn(file: string, context: ResolutionContext): CppUsing[] {
  let memo = USINGS.get(context);
  if (!memo) USINGS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const found: CppUsing[] = [];
  const source = context.readFile(file);
  if (source && (source.includes('using') || source.includes('namespace'))) {
    const text = stripCommentsForRegex(source, 'cpp');
    let line = 1;
    let at = 0;
    for (const m of text.matchAll(USING)) {
      for (; at < m.index; at++) if (text.charCodeAt(at) === 10) line++;
      const squash = (s: string): string => s.replace(/\s+/g, '');
      if (m[1]) {
        found.push({ line, kind: 'directive', name: '', path: squash(m[1]) });
      } else if (m[2]) {
        const path = squash(m[2]);
        found.push({ line, kind: 'declaration', name: path.slice(path.lastIndexOf('::') + 2), path });
      } else if (m[3] && m[4]) {
        found.push({ line, kind: 'alias', name: m[3], path: squash(m[4]) });
      }
    }
  }
  memo.set(file, found);
  return found;
}
