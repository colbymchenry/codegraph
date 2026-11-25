/**
 * C++ methods a function-like macro defines, minted where the file invokes
 * the macro.
 *
 * protocolbuffers/protobuf defines most of its descriptor accessors this way.
 * `FieldDescriptor` declares `int number() const;`, and descriptor.h defines
 * it further down with `PROTOBUF_DEFINE_ACCESSOR(FieldDescriptor, number,
 * int)`, the macro being `inline TYPE CLASS::FIELD() const { return FIELD##_; }`.
 * The parser never sees that definition (the preParse blanks the invocation,
 * an unknown statement without a semicolon), and a declaration without a body
 * mints no node, so `FieldDescriptor::number` had no node at all and none of
 * its callers linked.
 *
 * This reads the file's own `#define`s whose body defines `Class::method(…) … {`
 * at its top level, expands each invocation at namespace scope (its
 * parameters, and `##` pasting), and mints a method node per definition, as the
 * walker mints an out-of-line definition: named and qualified like one (the
 * enclosing namespaces composed with the written receiver), and contained by
 * the file and by the same-file class of the receiver's name. The node spans
 * the invocation. Its signature is the expanded head (`inline const
 * FileDescriptor* Descriptor::file() const`), which the resolver reads where it
 * would read a definition's source: the return type a chained call goes on
 * through, and the parameters an overload is picked by. The expanded body is
 * not read, so the method has no calls of its own.
 *
 * It runs on the original source after either extractor (the kernel or the
 * wasm walker), so both mint the same nodes. Only macros the file defines
 * itself are expanded: an extraction sees one file. Constructors and
 * destructors are left out: constructor resolution reads a constructor's
 * parameter list as its signature, and a destructor is not called by name.
 */
import { Edge, ExtractionResult, Node } from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import { normalizeCppReturnType, stripCppTemplateArgs } from './c-cpp';
import { scanCppBraceScopes } from './cpp-brace-scopes';

/** A function-like macro a file defines (not a variadic one: none defines a method in practice). */
interface CppMacro {
  name: string;
  params: string[];
  /** Its replacement text: continuations spliced, comments blanked. */
  body: string;
  /** Where its `#` is. */
  at: number;
}

/** A method definition at the top level of a macro's expansion. */
interface CppDefinitionHead {
  /** The receiver as written, template arguments dropped (`Descriptor`, `internal::ExtensionSet`). */
  receiver: string;
  name: string;
  /** The text before the receiver: specifiers and the return type (`inline const FileDescriptor*`). */
  returnText: string;
  /** Everything up to the body's `{`, whitespace collapsed. */
  head: string;
}

const isWordStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
const isWordChar = (c: number): boolean => isWordStart(c) || (c >= 48 && c <= 57);

/** A function-like `#define` whose replacement, on any of its lines, writes `::` and a `{`. */
const METHOD_MACRO_CANDIDATE = /^[ \t]*#[ \t]*define[ \t]+[A-Za-z_]\w*\([^)\n]*\)((?:[^\n]*\\\r?\n)*[^\n]*)/gm;

/**
 * Whether the C++ `source` may define a method with a macro of its own: a
 * cheap test of the raw text, so the bulk-index fast path, which never sees
 * this pass, is left only for a file that can't have one.
 */
export function mayDefineCppMacroMethods(source: string): boolean {
  if (!source.includes('define')) return false;
  METHOD_MACRO_CANDIDATE.lastIndex = 0;
  for (let m = METHOD_MACRO_CANDIDATE.exec(source); m; m = METHOD_MACRO_CANDIDATE.exec(source)) {
    if (m[1]!.includes('::') && m[1]!.includes('{')) return true;
  }
  return false;
}

/** Add the methods the file's own macros define (see the module comment) to an extraction result. */
export function appendCppMacroMethods(result: ExtractionResult, filePath: string, source: string, preParse: (source: string) => string): void {
  if (!mayDefineCppMacroMethods(source)) return;
  const minted = cppMacroMethods(filePath, source, preParse, result.nodes);
  result.nodes.push(...minted.nodes);
  result.edges.push(...minted.edges);
}

/**
 * The method nodes, and their `contains` edges, for every definition the
 * file's own method-defining macros expand to where the file invokes them at
 * namespace scope. `nodes` are the file's extracted nodes: the class a
 * method's receiver names, and the ids already taken.
 */
function cppMacroMethods(
  filePath: string,
  source: string,
  preParse: (source: string) => string,
  nodes: readonly Node[],
): { nodes: Node[]; edges: Edge[] } {
  const out = { nodes: [] as Node[], edges: [] as Edge[] };
  const { macros, undefs } = cppMacroDirectives(source);
  const defining = macros.filter((m) => cppDefinitionHeads(m.body.replace(/\s*##\s*/g, '')).length > 0);
  if (defining.length === 0) return out;
  // Scopes as the parser saw them (after preParse, offsets unchanged), like the walker's.
  const scopes = scanCppBraceScopes(preParse(source));
  if (!scopes) return out;

  const names = new Set(defining.map((m) => m.name));
  const taken = new Set(nodes.map((n) => n.id));
  const fileId = `file:${filePath}`;
  for (const call of cppMacroInvocations(source, names)) {
    if (!scopes.atNamespaceScope(call.at)) continue;
    const macro = liveMacro(defining, undefs, call.name, call.at);
    const expansion = macro && expandCppMacro(macro, call.args);
    if (!expansion) continue;
    const start = scopes.positionOf(call.at);
    const end = scopes.positionOf(call.end);
    const prefix = scopes.namespacesAt(call.at);
    for (const def of cppDefinitionHeads(expansion)) {
      const receiverLast = def.receiver.split('::').pop()!;
      // A constructor's or destructor's.
      if (def.name === receiverLast || def.name.startsWith('~')) continue;
      let id = generateNodeId(filePath, 'method', def.name, start.line);
      if (taken.has(id)) id = `${id}:${start.column}`;
      for (let k = 1; taken.has(id); k++) id = `${generateNodeId(filePath, 'method', def.name, start.line)}:${start.column}:${k}`;
      taken.add(id);
      const returnType = normalizeCppReturnType(cppTypeText(def.returnText));
      out.nodes.push({
        id,
        kind: 'method',
        name: def.name,
        qualifiedName: composeQualifiedName(prefix, def.receiver, def.name),
        filePath,
        language: 'cpp',
        startLine: start.line,
        endLine: end.line,
        startColumn: start.column,
        endColumn: end.column,
        signature: def.head,
        ...(returnType ? { returnType } : {}),
        updatedAt: Date.now(),
      });
      out.edges.push({ source: fileId, target: id, kind: 'contains' });
      // As for an out-of-line definition, the class of its receiver's name in the same file holds it.
      const owner = nodes.find((n) => n.name === def.receiver && n.filePath === filePath &&
        (n.kind === 'struct' || n.kind === 'union' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait'));
      if (owner) out.edges.push({ source: owner.id, target: id, kind: 'contains' });
    }
  }
  return out;
}

/**
 * The qualified name of a method written `receiver::name` inside the
 * namespaces `prefix`, as the walker composes an out-of-line definition's
 * (TreeSitterExtractor.composeReceiverQualifiedName): the receiver is anchored
 * at the first namespace it re-spells.
 */
function composeQualifiedName(prefix: readonly string[], receiver: string, name: string): string {
  const base = `${receiver}::${name}`;
  if (prefix.length === 0) return base;
  const anchor = prefix.indexOf(receiver.split('::')[0]!);
  const kept = anchor === -1 ? prefix : prefix.slice(0, anchor);
  return kept.length > 0 ? `${kept.join('::')}::${base}` : base;
}

/** The type a definition's leading text writes, without its specifiers, template header and attributes. */
function cppTypeText(returnText: string): string {
  let text = returnText.trim();
  for (;;) {
    const before = text;
    if (text.startsWith('template')) {
      const open = text.indexOf('<');
      const close = open < 0 ? -1 : matching(text, open, '<', '>');
      if (close < 0) return '';
      text = text.slice(close + 1).trim();
    }
    text = text.replace(/^\[\[[^\]]*\]\]\s*/, '')
      .replace(/^(?:inline|static|virtual|constexpr|consteval|explicit|extern|friend|__forceinline)\b\s*/, '')
      // An attribute macro in front (`PROTOBUF_NOINLINE`, `ABSL_MUST_USE_RESULT`).
      .replace(/^[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\s*\([^()]*\))?\s+/, '');
    if (text === before) return text;
  }
}

/** Where the `close` matching the `open` at `text[from]` is, or -1. */
function matching(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") i = quotedEnd(text, i) - 1;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Past the string or character literal whose quote is at `i`. */
function quotedEnd(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  return Math.min(text.length, j + 1);
}

/** Past the blanks at `i`. */
function skipBlank(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/** The end of the identifier at `i`, or -1. */
function wordEnd(text: string, i: number): number {
  if (!isWordStart(text.charCodeAt(i))) return -1;
  let j = i + 1;
  while (j < text.length && isWordChar(text.charCodeAt(j))) j++;
  return j;
}

/**
 * The qualified name starting at `i` that an argument list follows
 * (`Descriptor::file(`, `internal::ExtensionSet::Has(`, `Box<T>::get(`,
 * `Matrix::operator()(`): its segments and the offset of the `(`. Null when no
 * such name starts there, or it has no `::`.
 */
function qualifiedCallableAt(text: string, i: number): { segments: string[]; open: number } | null {
  const segments: string[] = [];
  let j = i;
  if (text.startsWith('::', j)) j = skipBlank(text, j + 2);
  for (;;) {
    if (text.startsWith('operator', j) && !isWordChar(text.charCodeAt(j + 8))) {
      const op = /^operator\s*(\(\s*\)|\[\s*\]|[^\s\w(]+|\w+)\s*\(/.exec(text.slice(j));
      if (!op || segments.length === 0) return null;
      segments.push(`operator${op[1]!.replace(/\s+/g, '')}`);
      return { segments, open: j + op[0].length - 1 };
    }
    const tilde = text[j] === '~';
    const end = wordEnd(text, tilde ? skipBlank(text, j + 1) : j);
    if (end < 0) return null;
    const word = text.slice(tilde ? skipBlank(text, j + 1) : j, end);
    segments.push(tilde ? `~${word}` : word);
    let k = skipBlank(text, end);
    if (text[k] === '<' && !tilde) {
      const close = matching(text, k, '<', '>');
      if (close < 0) return null;
      segments[segments.length - 1] += text.slice(k, close + 1);
      k = skipBlank(text, close + 1);
    }
    if (text.startsWith('::', k)) {
      if (tilde) return null;
      j = skipBlank(text, k + 2);
      continue;
    }
    return text[k] === '(' && segments.length > 1 ? { segments, open: k } : null;
  }
}

/**
 * After a definition's parameter list (from `i`): the offset of its body's
 * `{`, past the qualifiers it may write (`const`, `noexcept(…)`, `override`,
 * `&&`, an attribute, an attribute macro, a trailing return type). -1 for
 * anything else: a declaration (`;`), `= default`, a constructor's
 * initializer list.
 */
function bodyOpenAfter(text: string, i: number): number {
  let j = skipBlank(text, i);
  for (;;) {
    const c = text[j];
    if (c === '{') return j;
    if (c === '&') {
      j = skipBlank(text, j + (text[j + 1] === '&' ? 2 : 1));
      continue;
    }
    if (text.startsWith('[[', j)) {
      const close = text.indexOf(']]', j + 2);
      if (close < 0) return -1;
      j = skipBlank(text, close + 2);
      continue;
    }
    if (text.startsWith('->', j)) {
      // A trailing return type runs to the body.
      let depth = 0;
      for (let k = j + 2; k < text.length; k++) {
        const d = text[k];
        if (d === '(' || d === '<' || d === '[') depth++;
        else if (d === ')' || d === '>' || d === ']') depth--;
        else if (d === '{' && depth <= 0) return k;
        else if (d === ';' && depth <= 0) return -1;
      }
      return -1;
    }
    const end = wordEnd(text, j);
    if (end < 0) return -1;
    const word = text.slice(j, end);
    if (!/^(?:const|volatile|override|final|noexcept|throw|[A-Z][A-Z0-9]*_[A-Z0-9_]*)$/.test(word)) return -1;
    j = skipBlank(text, end);
    if (text[j] === '(' && word !== 'const' && word !== 'volatile' && word !== 'override' && word !== 'final') {
      const close = matching(text, j, '(', ')');
      if (close < 0) return -1;
      j = skipBlank(text, close + 1);
    }
  }
}

/** The method definitions at the top level of a macro's expansion `text`, in order. */
function cppDefinitionHeads(text: string): CppDefinitionHead[] {
  const heads: CppDefinitionHead[] = [];
  let segment = 0; // where the current top-level declaration began
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = quotedEnd(text, i);
      continue;
    }
    if (c === ';' || c === '}') {
      segment = ++i;
      continue;
    }
    if (c === '{' || c === '(') {
      // A body or group that is no definition read here (a namespace, a class, a statement).
      const close = matching(text, i, c, c === '{' ? '}' : ')');
      if (close < 0) return heads;
      if (c === '{') segment = close + 1;
      i = close + 1;
      continue;
    }
    const callable = isWordStart(text.charCodeAt(i)) || (c === ':' && text[i + 1] === ':') ? qualifiedCallableAt(text, i) : null;
    if (!callable) {
      const end = wordEnd(text, i);
      i = end < 0 ? i + 1 : end;
      continue;
    }
    const close = matching(text, callable.open, '(', ')');
    if (close < 0) return heads;
    const open = bodyOpenAfter(text, close + 1);
    if (open < 0) {
      i = close + 1;
      continue;
    }
    // An explicit specialization's arguments (`Read<int32_t, TYPE_INT32>`) are no part of its name.
    const last = callable.segments[callable.segments.length - 1]!;
    const name = last.startsWith('operator') ? last : stripCppTemplateArgs(last);
    const receiver = stripCppTemplateArgs(callable.segments.slice(0, -1).join('::'));
    if (receiver) {
      heads.push({
        receiver,
        name,
        returnText: text.slice(segment, i).trim(),
        head: text.slice(segment, open).replace(/\s+/g, ' ').trim(),
      });
    }
    const bodyClose = matching(text, open, '{', '}');
    if (bodyClose < 0) return heads;
    segment = i = bodyClose + 1;
  }
  return heads;
}

/**
 * The macro of `name` in effect at `offset`: its last `#define` before it,
 * unless an `#undef` came between.
 */
function liveMacro(macros: readonly CppMacro[], undefs: ReadonlyArray<{ name: string; at: number }>, name: string, offset: number): CppMacro | null {
  let found: CppMacro | null = null;
  for (const m of macros) if (m.name === name && m.at < offset && (!found || m.at > found.at)) found = m;
  if (!found) return null;
  return undefs.some((u) => u.name === name && u.at > found!.at && u.at < offset) ? null : found;
}

/** A macro's expansion for the arguments `args` (as written), or null when they don't fit its parameters. */
function expandCppMacro(macro: CppMacro, args: string[]): string | null {
  const values = macro.params.length === 0 && args.length === 1 && args[0]!.trim() === '' ? [] : args.map((a) => a.trim());
  if (values.length !== macro.params.length) return null;
  const valueOf = new Map<string, string>(macro.params.map((p, k) => [p, values[k]!]));
  return macro.body
    .replace(/[A-Za-z_]\w*/g, (word) => valueOf.get(word) ?? word)
    // `a ## b`: one token.
    .replace(/\s*##\s*/g, '');
}

/**
 * The function-like `#define`s of a C++ source and its `#undef`s, in order,
 * read past comments and literals: a `#define` in a comment or a raw string
 * defines nothing.
 */
function cppMacroDirectives(source: string): { macros: CppMacro[]; undefs: Array<{ name: string; at: number }> } {
  const macros: CppMacro[] = [];
  const undefs: Array<{ name: string; at: number }> = [];
  for (const d of cppCodeScan(source, null).directives) {
    const text = withoutLineComment(d.text.replace(/\\\r?\n/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '));
    const define = /^#[ \t]*define[ \t]+([A-Za-z_]\w*)\(([^)]*)\)/.exec(text);
    if (define) {
      const params = define[2]!.split(',').map((p) => p.trim()).filter((p) => p !== '');
      if (!params.some((p) => p.endsWith('...'))) macros.push({ name: define[1]!, params, body: text.slice(define[0].length), at: d.at });
      continue;
    }
    const undef = /^#[ \t]*undef[ \t]+([A-Za-z_]\w*)/.exec(text);
    if (undef) undefs.push({ name: undef[1]!, at: d.at });
  }
  return { macros, undefs };
}

/** The invocations of the macros `names` in code (not in a directive, comment or literal), with their arguments. */
function cppMacroInvocations(source: string, names: ReadonlySet<string>): Array<{ name: string; at: number; end: number; args: string[] }> {
  const calls: Array<{ name: string; at: number; end: number; args: string[] }> = [];
  for (const word of cppCodeScan(source, names).words) {
    const open = skipBlankAndComments(source, word.end);
    if (source[open] !== '(') continue;
    const args: string[] = [];
    let depth = 0;
    let from = open + 1;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      const c = source[i]!;
      if (c === '"' || c === "'") i = quotedEnd(source, i) - 1;
      else if (c === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 1;
      } else if (c === '/' && source[i + 1] === '/') {
        const end = source.indexOf('\n', i);
        i = end < 0 ? source.length : end - 1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        close = i;
        break;
      } else if (c === ',' && depth === 1) {
        args.push(source.slice(from, i));
        from = i + 1;
      }
    }
    if (close < 0) continue;
    args.push(source.slice(from, close));
    calls.push({ name: word.name, at: word.at, end: close + 1, args: args.map(withoutComments) });
  }
  return calls;
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** A spliced directive without the `//` comment that ends it, one in a string literal aside. */
function withoutLineComment(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = quotedEnd(text, i) - 1;
    else if (c === '/' && text[i + 1] === '/') return text.slice(0, i);
  }
  return text;
}

/** Past blanks and comments from `i`. */
function skipBlankAndComments(source: string, i: number): number {
  for (;;) {
    i = skipBlank(source, i);
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
    } else {
      return i;
    }
  }
}

const RAW_STRING_PREFIX = /^(?:u8|[uUL])?R$/;

/**
 * One pass over C/C++ source, skipping comments and string, character and raw
 * string literals: the preprocessor directives (each with its `\`
 * continuations), and, when `names` is given, the code's identifiers among
 * them.
 */
function cppCodeScan(source: string, names: ReadonlySet<string> | null): {
  directives: Array<{ at: number; text: string }>;
  words: Array<{ name: string; at: number; end: number }>;
} {
  const directives: Array<{ at: number; text: string }> = [];
  const words: Array<{ name: string; at: number; end: number }> = [];
  const n = source.length;
  let lineStart = true;
  let lastWordStart = -1;
  let lastWordEnd = -1;
  for (let i = 0; i < n; ) {
    const c = source.charCodeAt(i);
    if (c === 10) {
      lineStart = true;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 11 || c === 12) {
      i++;
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 47) {
      // A `\` at the end continues a line comment.
      let end = i;
      for (;;) {
        end = source.indexOf('\n', end);
        if (end < 0) {
          end = n;
          break;
        }
        let k = end - 1;
        if (source.charCodeAt(k) === 13) k--;
        if (source.charCodeAt(k) !== 92) break;
        end++;
      }
      i = end;
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 42) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === 35 && lineStart) {
      let j = i + 1;
      for (; j < n; j++) {
        const d = source.charCodeAt(j);
        if (d === 47 && source.charCodeAt(j + 1) === 42) {
          const end = source.indexOf('*/', j + 2);
          j = end < 0 ? n - 1 : end + 1;
        } else if (d === 10) {
          let k = j - 1;
          if (source.charCodeAt(k) === 13) k--;
          if (source.charCodeAt(k) !== 92) break;
        }
      }
      directives.push({ at: i, text: source.slice(i, j) });
      i = j;
      continue;
    }
    lineStart = false;
    if (c === 34) {
      if (lastWordEnd === i && RAW_STRING_PREFIX.test(source.slice(lastWordStart, i))) {
        const paren = source.indexOf('(', i + 1);
        const delimiter = paren < 0 ? '' : source.slice(i + 1, paren);
        if (paren >= 0 && /^[^\s()\\"]{0,16}$/.test(delimiter)) {
          const end = source.indexOf(`)${delimiter}"`, paren + 1);
          i = end < 0 ? n : end + delimiter.length + 2;
          continue;
        }
      }
      i = quotedEnd(source, i);
      continue;
    }
    if (c === 39) {
      // A digit separator (`1'000`) is no character literal.
      if (i > 0 && isWordChar(source.charCodeAt(i - 1)) && lastWordEnd !== i) {
        i++;
        continue;
      }
      i = quotedEnd(source, i);
      continue;
    }
    if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(source.charCodeAt(j))) j++;
      if (isWordStart(c)) {
        lastWordStart = i;
        lastWordEnd = j;
        if (names?.has(source.slice(i, j))) words.push({ name: source.slice(i, j), at: i, end: j });
      }
      i = j;
      continue;
    }
    i++;
  }
  return { directives, words };
}
