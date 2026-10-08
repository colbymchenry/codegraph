/**
 * VB.NET receivers, projects and receiver-less calls.
 *
 * The name matcher guesses a `receiver.Method()` call it cannot type by the
 * method's name alone (matchMethodCall's Strategy 3: a unique name, or the
 * receiver sharing words with the owner), and a receiver-less call by the
 * nearest same-named member. VB.NET brought none of the evidence C# does to
 * those guesses, so a call landed on whichever project method shared its
 * name: SCrawler's `ThumbnailFile.Delete(…)` on an external `SFile` went to a
 * nested `TempFileConversion.Delete`, staxrip's main app called its AutoCrop
 * tool's copy of `ColorHSL`. What this module reads, from the source:
 *
 * 1. A receiver's declared type — `Dim x As T`, `ByVal x As T`, `x As New T`,
 *    a type character (`Dim name$`), `Dim x = New T(…)`, a `For Each` over a
 *    typed collection, a field or property of the class, of one it inherits
 *    (with the type arguments the subclass gives) or of a `Module`, or what
 *    `Dim x = obj.GetString(…)` returns. A typed receiver's call is the
 *    type's own method or one it inherits, else an extension method declared
 *    for the type, else nothing of the project's: a type the project does
 *    not define (`SFile`, `String`, `List(Of T)`) has none of its methods. A
 *    member read through it (`x.Normal`, `Me._h.Title`, a `With` block's
 *    `.Value`) is the type's member in the same way, link by link.
 * 2. Which type a name means where it is written: the namespaces around it,
 *    outward, then its file's and project's `Imports` (aliases included),
 *    then the project a file belongs to — the `.vbproj` above it, whose
 *    `RootNamespace` its namespaces are inside. Between same-named types, and
 *    between guesses nothing else tells apart, the caller's own project's
 *    comes first; a written qualifier (`System.Drawing.Point`) must match.
 * 3. A receiver-less call (or one on `Me` / `MyClass` / `MyBase`, which the
 *    extractor drops) is a member of a type around it, of what those inherit,
 *    or of a `Module`; a type nested in a class is named bare only inside it.
 *
 * VB.NET's keywords and names are matched without regard to case. Nothing
 * here runs for another language.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** A VB.NET declared type: its simple name (no namespace, no type arguments) and whether it is an array. */
interface VbType {
  name: string;
  array: boolean;
  /** The namespaces or types written before the name (`API.Base` in `API.Base.UserDataBase`), lowercased. */
  qualifier?: string[];
  /** Where the name is written, which decides the namespaces it is looked up in. */
  file?: string;
  line?: number;
  /** A supertype named in an `Implements` statement: its members are not the type's own. */
  implemented?: boolean;
  /** The type arguments written with it: `SiteSettings` in `Checker(Of SiteSettings)`. */
  args?: VbType[];
}

/** What a statement says a local is: its type, the call whose result it holds, or a binding that names no type. */
type VbBinding =
  | { kind: 'type'; type: VbType }
  | { kind: 'call'; receiver: string | null; member: string }
  | { kind: 'each'; collection: string }
  | { kind: 'unknown' };

/** .NET's collections of one element type: `For Each x In list` over a `List(Of T)` binds a `T`. */
const VB_ELEMENT_COLLECTIONS = /^(?:List|IList|IEnumerable|ICollection|IReadOnlyList|IReadOnlyCollection|HashSet|SortedSet|Queue|Stack|LinkedList|ObservableCollection|Collection|ReadOnlyCollection|BindingList|ConcurrentBag|ConcurrentQueue|ConcurrentStack|BlockingCollection)$/i;

/** The type of what a `For Each` over a value of type `t` binds: an array's or a .NET collection's element type. */
function elementType(t: VbType): VbType | null {
  if (t.array) return { ...t, array: false };
  return t.args?.length === 1 && VB_ELEMENT_COLLECTIONS.test(t.name) && t.args[0]!.name !== '?' ? t.args[0]! : null;
}

/** VB.NET's built-in types, by keyword and by .NET name, keyed to the keyword. */
const VB_BUILTIN_TYPES: ReadonlyMap<string, string> = new Map([
  ...['boolean', 'byte', 'char', 'date', 'decimal', 'double', 'integer', 'long', 'object', 'sbyte', 'short', 'single',
    'string', 'uinteger', 'ulong', 'ushort'].map((k): [string, string] => [k, k]),
  ['int16', 'short'], ['int32', 'integer'], ['int64', 'long'], ['uint16', 'ushort'], ['uint32', 'uinteger'],
  ['uint64', 'ulong'], ['datetime', 'date'],
]);

/** The type a type character declares: `Dim aStr$`, `For i% = 0 …`. */
const VB_TYPE_CHARS: Readonly<Record<string, string>> = {
  $: 'String', '%': 'Integer', '&': 'Long', '!': 'Single', '#': 'Double', '@': 'Decimal',
};

/** VB.NET's conversion functions and the built-in type each returns. */
const VB_CONVERSIONS: Readonly<Record<string, string>> = {
  cbool: 'Boolean', cbyte: 'Byte', cchar: 'Char', cdate: 'Date', cdbl: 'Double', cdec: 'Decimal', cint: 'Integer',
  clng: 'Long', cobj: 'Object', csbyte: 'SByte', cshort: 'Short', csng: 'Single', cstr: 'String', cuint: 'UInteger',
  culng: 'ULong', cushort: 'UShort',
};

/** VB.NET type nodes a member can belong to (a `Module` is indexed as a class). */
const VB_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface']);
const VB_VALUE_KINDS: ReadonlySet<string> = new Set(['field', 'property', 'constant', 'variable']);
const VB_MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'field', 'enum_member', 'constant', 'variable']);

/** A declaration keyword right before a name: the name is a member being declared, not a variable. */
const VB_MEMBER_HEAD = /\b(?:Function|Sub|Property|Event|Operator|Declare|Delegate|Class|Structure|Module|Interface|Enum|Namespace)\s+$/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A type's key for comparing two of them: the built-in keyword or the lowercased name, `[]` for an array. */
function typeKey(t: VbType): string {
  const lower = t.name.toLowerCase();
  return `${VB_BUILTIN_TYPES.get(lower) ?? lower}${t.array ? '[]' : ''}`;
}

function isBuiltin(t: VbType): boolean {
  return !t.array && VB_BUILTIN_TYPES.has(t.name.toLowerCase());
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The top-level items of the parenthesized list opening at `open`, or null when it does not close. */
function splitArgs(text: string, open: number): string[] | null {
  const close = closeParen(text, open);
  if (close < 0) return null;
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text.slice(open + 1, close)) {
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else cur += ch;
  }
  args.push(cur);
  return args.map((a) => a.trim());
}

/**
 * The type written at `text[at]` — `List(Of Foo)`, `String()`, `Integer?`,
 * `Global.A.B` — by its last name; null when no type starts there.
 */
function readType(text: string, at: number): VbType | null {
  const head = /^\s*([A-Za-z_][\w.]*)/.exec(text.slice(at));
  if (!head) return null;
  let i = at + head[0].length;
  let args: VbType[] | undefined;
  if (/^\s*\(\s*Of\b/i.test(text.slice(i))) {
    const open = text.indexOf('(', i);
    const close = closeParen(text, open);
    if (close < 0) return null;
    args = (splitArgs(text, open) ?? []).map((a) => readType(a.replace(/^Of\s+/i, ''), 0) ?? { name: '?', array: false });
    i = close + 1;
  }
  const segments = head[1]!.split('.');
  const name = segments.pop()!;
  if (!/^[A-Za-z_]\w*$/.test(name) || /^(?:New|Of|As|In|Out|From|With)$/i.test(name)) return null;
  const qualifier = segments.map((s) => s.toLowerCase()).filter((s, i) => !(i === 0 && s === 'global'));
  return {
    name,
    array: /^\s*\??\s*\(\s*,*\s*\)/.test(text.slice(i)),
    ...(qualifier.length > 0 ? { qualifier } : {}),
    ...(args ? { args } : {}),
  };
}

/** `t` — and the type arguments written inside it — written at `file:line`. */
function sited(t: VbType | null, file: string, line: number): VbType | null {
  return t ? { ...t, file, line, ...(t.args ? { args: t.args.map((a) => sited(a, file, line)!) } : {}) } : null;
}

/** A VB.NET line's code: its comment dropped and every string literal emptied to `""`. */
function vbCode(line: string): string {
  // Most lines have neither: the line itself, without a copy.
  if (!/["'‘’\r]/.test(line)) return line;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] !== '"') continue;
        if (line[j + 1] === '"') j++;
        else break;
      }
      out += '""';
      i = j;
      continue;
    }
    if (ch === "'" || ch === '\u2018' || ch === '\u2019' || ch === '\r') break;
    out += ch;
  }
  return out;
}

const VB_CODE_LINES = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** A file's lines as code (see vbCode), read once per file. */
function codeLines(file: string, context: ResolutionContext): string[] {
  let memo = VB_CODE_LINES.get(context);
  if (!memo) VB_CODE_LINES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const lines = (context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? []).map(vbCode);
  if (memo.size >= 1024) memo.delete(memo.keys().next().value!);
  memo.set(file, lines);
  return lines;
}

interface VbPatterns {
  /** The name standing where a binding names it — not as `name.Member` nor `name(args)`, which only use it. */
  declared: RegExp;
  /** `name As T`, `name() As T`, `name As New T`: a variable, parameter, loop or catch variable. */
  asClause: RegExp;
  /** `Dim name, other As T`: a declarator sharing the next one's type. */
  listed: RegExp;
  /** `Dim name$`, `ByVal name%`, `For i% = …`. */
  typeChar: RegExp;
  /** `Dim name = …`: the value's type. */
  inferred: RegExp;
  /** `For Each name In …`: the collection's element type, when it says it. */
  forEach: RegExp;
  /** A binding that names no type: `For name = …`, `Function(name)`, `From name In`, `Catch name`. */
  loose: RegExp;
}

const VB_PATTERNS = new Map<string, VbPatterns>();

function patternsFor(name: string): VbPatterns {
  const key = name.toLowerCase();
  const hit = VB_PATTERNS.get(key);
  if (hit) return hit;
  const r = escapeRegex(key);
  const patterns: VbPatterns = {
    declared: new RegExp(`(?<![\\w.])${r}(?![\\w.]|\\s*\\.|\\s*\\((?![\\s\\d,]*\\)))`, 'i'),
    asClause: new RegExp(`(?<![\\w.])${r}(\\s*\\([\\s\\d,]*\\))?\\s*\\??\\s+As\\s+(New\\s+)?`, 'gi'),
    listed: new RegExp(`\\b(?:Dim|Static)\\s+(?:[A-Za-z_]\\w*\\s*,\\s*)*${r}\\s*,[\\w\\s,]*?\\bAs\\s+`, 'i'),
    typeChar: new RegExp(
      `(?:\\b(?:Dim|Static|Const|ByVal|ByRef|Optional|ParamArray|Each|For|Using|Private|Public|Friend|Protected|Shared|ReadOnly|WithEvents)\\s+|[,(]\\s*)` +
      `${r}([$%&!#@])(\\s*\\([\\s\\d,]*\\))?(?![\\w$%&!#@])`,
      'i',
    ),
    inferred: new RegExp(`\\b(?:Dim|Static|Const|Using)\\s+${r}\\s*=(?!=)`, 'i'),
    forEach: new RegExp(`\\bFor\\s+Each\\s+${r}\\s+In\\s+(.+)$`, 'i'),
    loose: new RegExp(
      `\\bFor\\s+(?:Each\\s+)?${r}\\b|\\b(?:From|Aggregate)\\s+${r}\\s+In\\b|\\bLet\\s+${r}\\s*=|\\bCatch\\s+${r}\\b|` +
      `\\b(?:Function|Sub)\\s*\\((?:[^()]*,)?\\s*(?:ByVal\\s+|ByRef\\s+)?${r}\\s*[,)]`,
      'i',
    ),
  };
  if (VB_PATTERNS.size >= 4096) VB_PATTERNS.delete(VB_PATTERNS.keys().next().value!);
  VB_PATTERNS.set(key, patterns);
  return patterns;
}

/**
 * What every binding of a name has on its line: a declaring keyword, or a
 * type character. Most lines naming a variable just use it (`sb.Append(…)`).
 */
const VB_MAY_BIND = /\b(?:As|Dim|Static|Const|For|Each|Function|Sub|Catch|Using|From|Let|Aggregate)\b|\w[$%&!#@]/i;

/** What one line of code says `name` is, or undefined when it doesn't bind the name. */
function bindingOn(code: string, name: string): VbBinding | undefined {
  if (!VB_MAY_BIND.test(code)) return undefined;
  const p = patternsFor(name);
  if (!p.declared.test(code)) return undefined;
  p.asClause.lastIndex = 0;
  for (let m = p.asClause.exec(code); m; m = p.asClause.exec(code)) {
    if (VB_MEMBER_HEAD.test(code.slice(0, m.index))) continue;
    const type = readType(code, m.index + m[0].length);
    if (!type) return { kind: 'unknown' };
    // `As New T(…)`: the parentheses are the constructor's.
    return { kind: 'type', type: m[2] ? { ...type, array: false } : { ...type, array: type.array || !!m[1] } };
  }
  const listed = p.listed.exec(code);
  if (listed) {
    const type = readType(code, listed.index + listed[0].length);
    return type ? { kind: 'type', type } : { kind: 'unknown' };
  }
  const typeChar = p.typeChar.exec(code);
  if (typeChar) return { kind: 'type', type: { name: VB_TYPE_CHARS[typeChar[1]!]!, array: !!typeChar[2] } };
  // An assignment (`x = New Channel`) says nothing: the declared type
  // (`Dim x As IYouTubeMediaContainer`) is what the call binds to.
  const inferred = p.inferred.exec(code);
  if (inferred) return valueBinding(code.slice(inferred.index + inferred[0].length));
  // `For Each c In controls.OfType(Of ButtonLabel)`: the loop's elements are
  // that type; `For Each user In users`: the elements of what `users` is.
  const loop = p.forEach.exec(code);
  if (loop) {
    const collection = loop[1]!.trim();
    const elements = /\.\s*(?:OfType|Cast)\s*\(\s*Of\s+/i.exec(collection);
    const type = elements && /^[^()]*\)\s*(?:\(\s*\))?\s*$/.test(collection.slice(elements.index + elements[0].length))
      ? readType(collection, elements.index + elements[0].length) : null;
    if (type) return { kind: 'type', type };
    return /^[A-Za-z_]\w*$/.test(collection) ? { kind: 'each', collection } : { kind: 'unknown' };
  }
  return p.loose.test(code) ? { kind: 'unknown' } : undefined;
}

/** What a local initialized with `expr` (`Dim x = expr`) is. */
function valueBinding(expr: string): VbBinding {
  const e = expr.split(/\s:(?!=)/)[0]!.trim();
  const unknown: VbBinding = { kind: 'unknown' };
  const created = /^New\s+/i.exec(e);
  if (created) {
    const type = readType(e, created[0].length);
    return type ? { kind: 'type', type: { ...type, array: false } } : unknown;
  }
  const cast = /^(?:DirectCast|TryCast|CType)\s*\(/i.exec(e);
  if (cast) {
    const args = splitArgs(e, cast[0].length - 1);
    const type = args?.length === 2 ? readType(args[1]!, 0) : null;
    return type ? { kind: 'type', type } : unknown;
  }
  if (/^\$?""/.test(e)) return { kind: 'type', type: { name: 'String', array: false } };
  const conversion = /^(C[A-Za-z]+)\s*\(/.exec(e);
  const converted = conversion ? VB_CONVERSIONS[conversion[1]!.toLowerCase()] : undefined;
  if (converted) return { kind: 'type', type: { name: converted, array: false } };
  // `obj.Member(…)`, `Member(…)`, `Me.Member`: a call or a read as the whole value.
  const call = /^(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*/.exec(e);
  if (call) {
    let rest = e.slice(call[0].length);
    if (rest.startsWith('(')) {
      const close = closeParen(rest, 0);
      rest = close < 0 ? 'unclosed' : rest.slice(close + 1).trim();
    }
    if (rest === '') return { kind: 'call', receiver: call[1] ?? null, member: call[2]! };
  }
  return unknown;
}

/** The 0-based line a call's own declarations start on: its member's first line, which holds a method's parameters. */
function scopeStartLine(ref: UnresolvedRef, context: ResolutionContext): number {
  const from = context.getNodeById?.(ref.fromNodeId);
  if (from && from.filePath === ref.filePath && from.startLine <= ref.line && from.endLine >= ref.line &&
      (from.kind === 'method' || from.kind === 'function' || from.kind === 'property' || from.kind === 'field')) {
    return from.startLine - 1;
  }
  let start = -1;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind !== 'method' && n.kind !== 'function' && n.kind !== 'property') continue;
    if (n.startLine <= ref.line && n.endLine >= ref.line && n.startLine - 1 > start) start = n.startLine - 1;
  }
  return start < 0 ? ref.line - 1 : start;
}

const VB_WORD_LINES = new WeakMap<ResolutionContext, Map<string, Map<string, number[]>>>();

/**
 * The 0-based lines of a file's code each lowercased word appears on, in
 * order: a call's receiver is looked for only on the lines that name it,
 * not on every line back to its method's start (a long method's calls each
 * rescanned it).
 */
function wordLines(file: string, context: ResolutionContext): Map<string, number[]> {
  let memo = VB_WORD_LINES.get(context);
  if (!memo) VB_WORD_LINES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const index = new Map<string, number[]>();
  const words = /[A-Za-z_]\w*/g;
  const lines = codeLines(file, context);
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i]!.toLowerCase();
    words.lastIndex = 0;
    for (let m = words.exec(code); m; m = words.exec(code)) {
      let at = index.get(m[0]);
      if (!at) index.set(m[0], (at = []));
      if (at[at.length - 1] !== i) at.push(i);
    }
  }
  if (memo.size >= 256) memo.delete(memo.keys().next().value!);
  memo.set(file, index);
  return index;
}

const VB_BINDINGS = new WeakMap<ResolutionContext, Map<string, Array<{ line: number; binding: VbBinding }>>>();

/**
 * Every statement of a file that binds `name`, by 0-based line — read once:
 * staxrip's `GetArgs` methods call `sb.Append(…)` on hundreds of lines, each
 * of which would otherwise walk back over all the others to the `Dim sb`.
 */
function bindingsOf(name: string, file: string, context: ResolutionContext): Array<{ line: number; binding: VbBinding }> {
  let memo = VB_BINDINGS.get(context);
  if (!memo) VB_BINDINGS.set(context, (memo = new Map()));
  const key = `${file}|${name.toLowerCase()}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const lines = codeLines(file, context);
  const found: Array<{ line: number; binding: VbBinding }> = [];
  for (const i of wordLines(file, context).get(name.toLowerCase()) ?? []) {
    const binding = bindingOn(lines[i]!, name);
    if (binding) found.push({ line: i, binding });
  }
  if (memo.size >= 65536) memo.delete(memo.keys().next().value!);
  memo.set(key, found);
  return found;
}

/** The nearest statement above a call (in its member) that binds `name`, and its 1-based line. */
function localBinding(name: string, ref: UnresolvedRef, context: ResolutionContext): { binding: VbBinding; line: number } | undefined {
  const found = bindingsOf(name, ref.filePath, context);
  // The last binding at or above the call's line.
  let lo = 0;
  let hi = found.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (found[mid]!.line <= ref.line - 1) lo = mid + 1;
    else hi = mid;
  }
  const nearest = found[lo - 1];
  return nearest && nearest.line >= scopeStartLine(ref, context) ? { binding: nearest.binding, line: nearest.line + 1 } : undefined;
}

const VB_FILE_TYPES = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/** The VB.NET types a line is written inside, innermost first. */
function typesAround(file: string, line: number, context: ResolutionContext): Node[] {
  let memo = VB_FILE_TYPES.get(context);
  if (!memo) VB_FILE_TYPES.set(context, (memo = new Map()));
  let types = memo.get(file);
  if (!types) {
    types = context.getNodesInFile(file)
      .filter((n) => n.language === 'vbnet' && VB_TYPE_KINDS.has(n.kind))
      .sort((a, b) => b.startLine - a.startLine);
    if (memo.size >= 1024) memo.delete(memo.keys().next().value!);
    memo.set(file, types);
  }
  return types.filter((n) => n.startLine <= line && n.endLine >= line);
}

/** The project's VB.NET types (classes, modules, structures, interfaces — or `kinds`) named `name`, case aside. */
function projectTypesNamed(name: string, context: ResolutionContext, kinds: ReadonlySet<string> = VB_TYPE_KINDS): Node[] {
  return context.getNodesByLowerName(name.toLowerCase()).filter((n) => n.language === 'vbnet' && kinds.has(n.kind));
}

const VB_FILE_QNS = new WeakMap<ResolutionContext, Map<string, Map<string, Node[]>>>();

/** A file's VB.NET nodes by lowercased qualified name, indexed once. */
function nodesByQualifiedName(file: string, context: ResolutionContext): Map<string, Node[]> {
  let memo = VB_FILE_QNS.get(context);
  if (!memo) VB_FILE_QNS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const index = new Map<string, Node[]>();
  for (const n of context.getNodesInFile(file)) {
    if (n.language !== 'vbnet') continue;
    const key = n.qualifiedName.toLowerCase();
    const list = index.get(key);
    if (list) list.push(n);
    else index.set(key, [n]);
  }
  if (memo.size >= 1024) memo.delete(memo.keys().next().value!);
  memo.set(file, index);
  return index;
}

const VB_MEMBERS = new WeakMap<ResolutionContext, Map<string, Node[]>>();

/**
 * Members named `name` declared directly in `type` (any partial part of it),
 * case aside. A member is declared inside a part of its type, so it is looked
 * up in those parts' files: one lookup per type name, not one per member name.
 */
function membersNamed(type: Node, name: string, context: ResolutionContext): Node[] {
  let memo = VB_MEMBERS.get(context);
  if (!memo) VB_MEMBERS.set(context, (memo = new Map()));
  const qn = `${type.qualifiedName}::${name}`.toLowerCase();
  const hit = memo.get(qn);
  if (hit) return hit;
  const own = type.qualifiedName.toLowerCase();
  const files = new Set([type.filePath]);
  for (const part of context.getNodesByLowerName(type.name.toLowerCase())) {
    if (part.language === 'vbnet' && part.qualifiedName.toLowerCase() === own) files.add(part.filePath);
  }
  const members = [...files].flatMap((file) => nodesByQualifiedName(file, context).get(qn) ?? []);
  if (memo.size >= 65536) memo.delete(memo.keys().next().value!);
  memo.set(qn, members);
  return members;
}

const VB_MODULES = new WeakMap<ResolutionContext, Map<string, boolean>>();

/** Whether a VB.NET owner (by qualified name) is a `Module`, whose members are reached without a qualifier. */
function isModule(ownerQn: string, context: ResolutionContext): boolean {
  let memo = VB_MODULES.get(context);
  if (!memo) VB_MODULES.set(context, (memo = new Map()));
  const hit = memo.get(ownerQn);
  if (hit !== undefined) return hit;
  // Its own head line or the two after it (attributes may come first); the raw
  // lines, as the whole file need not be read as code for this.
  const module = context.getNodesByQualifiedName(ownerQn).some((n) => n.language === 'vbnet' && n.kind === 'class' &&
    (context.getFileLines?.(n.filePath) ?? context.readFile(n.filePath)?.split(/\r?\n/) ?? []).slice(n.startLine - 1, n.startLine + 2)
      .some((l) => /^\s*(?:<[^>]*>\s*)*(?:(?:Public|Friend|Private|Partial)\s+)*Module\s/i.test(l)));
  memo.set(ownerQn, module);
  return module;
}

/** The members named `name` of the project's Modules, which code reaches without a qualifier — the caller's project's first. */
function moduleMembersNamed(name: string, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const members = context.getNodesByLowerName(name.toLowerCase()).filter((n) => {
    const cut = n.qualifiedName.lastIndexOf('::');
    return n.language === 'vbnet' && cut > 0 && isModule(n.qualifiedName.slice(0, cut), context);
  });
  return preferVbProject(members, ref, context);
}

const VB_SUPERS = new WeakMap<ResolutionContext, Map<string, VbType[]>>();

/**
 * The types a VB.NET type's declarations (every `Partial` part) inherit or
 * implement: the `Inherits` / `Implements` statements that open its body,
 * including the `Class X : Inherits Y` form.
 */
function supertypesOf(type: Node, context: ResolutionContext): VbType[] {
  let memo = VB_SUPERS.get(context);
  if (!memo) VB_SUPERS.set(context, (memo = new Map()));
  const key = type.qualifiedName.toLowerCase();
  const hit = memo.get(key);
  if (hit) return hit;
  const supers: VbType[] = [];
  const parts = context.getNodesByQualifiedName(type.qualifiedName).filter((n) => n.language === 'vbnet' && VB_TYPE_KINDS.has(n.kind));
  for (const part of parts.length > 0 ? parts : [type]) {
    const lines = codeLines(part.filePath, context);
    scan: for (let i = part.startLine - 1; i < Math.min(lines.length, part.startLine + 12, part.endLine); i++) {
      for (const statement of lines[i]!.split(/:(?!=)/)) {
        const s = statement.trim();
        // Blank, an attribute, a directive, or the declaration's own head.
        if (s === '' || /^<.*>$/.test(s) || s.startsWith('#') || /\b(?:Class|Structure|Interface|Module)\s+[A-Za-z_]/i.test(s) && !/^(?:Inherits|Implements)\b/i.test(s)) continue;
        const clause = /^(Inherits|Implements)\s+(.+)$/i.exec(s);
        if (!clause) break scan;
        for (const sup of splitArgs(`(${clause[2]})`, 0) ?? []) {
          const t = sited(readType(sup, 0), part.filePath, part.startLine);
          if (t) supers.push(/^Implements$/i.test(clause[1]!) ? { ...t, implemented: true } : t);
        }
      }
    }
  }
  memo.set(key, supers);
  return supers;
}

/** A type a VB.NET type inherits, with what its type parameters stand for there (`T` → `SiteSettings`). */
interface VbAncestor {
  node: Node;
  args: Map<string, VbType>;
}

const VB_ANCESTRIES = new WeakMap<ResolutionContext, Map<string, VbAncestor[]>>();

/** `t` with a type parameter replaced by what `args` says it stands for. */
function substitute(t: VbType, args: ReadonlyMap<string, VbType>): VbType {
  return (!t.qualifier && !t.array && args.get(t.name.toLowerCase())) || t;
}

/**
 * A VB.NET type and the project types it inherits, nearest first: a class's
 * base classes, an interface's base interfaces — whose members are the
 * type's own. Each carries the type arguments `Inherits Checker(Of
 * SiteSettings)` gives its parameters. An interface a class implements lends
 * it no members: they are reached through the class's own `… Implements
 * IFoo.Bar` ones.
 */
function ancestry(type: Node, context: ResolutionContext): VbAncestor[] {
  let memo = VB_ANCESTRIES.get(context);
  if (!memo) VB_ANCESTRIES.set(context, (memo = new Map()));
  const hit = memo.get(type.id);
  if (hit) return hit;
  const out: VbAncestor[] = [];
  const seen = new Set<string>();
  const queue: VbAncestor[] = [{ node: type, args: new Map() }];
  while (queue.length > 0 && out.length < 16) {
    const current = queue.shift()!;
    const key = current.node.qualifiedName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(current);
    for (const sup of supertypesOf(current.node, context)) {
      if (sup.implemented) continue;
      const found = typesNamedAt(sup, context);
      if (found.ambiguous) continue;
      const given = (sup.args ?? []).map((a) => substitute(a, current.args));
      for (const base of found.owners) {
        const params = [...typeParametersOf(base, context).keys()];
        queue.push({ node: base, args: new Map(params.flatMap((p, i): Array<[string, VbType]> => (given[i] ? [[p, given[i]!]] : []))) });
      }
    }
  }
  memo.set(type.id, out);
  return out;
}

/** A VB.NET type and the project types it inherits, nearest first (see ancestry). */
function hierarchy(type: Node, context: ResolutionContext): Node[] {
  return ancestry(type, context).map((a) => a.node);
}

const VB_PROJECTS = new WeakMap<ResolutionContext, Map<string, string | null>>();

/** The directory of the nearest `.vbproj` at or above `dir` (`''` for the root), or null outside any project. */
function projectOfDir(dir: string, context: ResolutionContext, memo: Map<string, string | null>): string | null {
  const hit = memo.get(dir);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  try {
    if (fs.readdirSync(path.join(context.getProjectRoot(), dir)).some((e) => /\.vbproj$/i.test(e))) found = dir;
  } catch {
    // Unreadable: no project file here.
  }
  if (found === null && dir !== '') {
    const cut = dir.lastIndexOf('/');
    found = projectOfDir(cut < 0 ? '' : dir.slice(0, cut), context, memo);
  }
  memo.set(dir, found);
  return found;
}

/** The project (the directory of the nearest `.vbproj` above it) a file belongs to, or null. */
function projectOf(file: string, context: ResolutionContext): string | null {
  let memo = VB_PROJECTS.get(context);
  if (!memo) VB_PROJECTS.set(context, (memo = new Map()));
  const cut = file.lastIndexOf('/');
  return projectOfDir(cut < 0 ? '' : file.slice(0, cut), context, memo);
}

/** Whether two files are in the same VB.NET project — false when either is in none. */
export function sameVbProject(a: string, b: string, context: ResolutionContext): boolean {
  const project = projectOf(a, context);
  return project !== null && project === projectOf(b, context);
}

interface VbProjectInfo {
  /** The root namespace every file of the project declares its namespaces inside, as segments. */
  root: string[];
  /** The namespaces the project imports into every file (`<Import Include="…" />`). */
  imports: string[];
}

const VB_PROJECT_INFO = new WeakMap<ResolutionContext, Map<string, VbProjectInfo>>();

/** A file's project's root namespace (`<RootNamespace>`, else the project's name) and project-wide imports, lowercased. */
function projectInfo(file: string, context: ResolutionContext): VbProjectInfo {
  const dir = projectOf(file, context);
  if (dir === null) return { root: [], imports: [] };
  let memo = VB_PROJECT_INFO.get(context);
  if (!memo) VB_PROJECT_INFO.set(context, (memo = new Map()));
  const hit = memo.get(dir);
  if (hit) return hit;
  const info: VbProjectInfo = { root: [], imports: [] };
  try {
    const abs = path.join(context.getProjectRoot(), dir);
    const project = fs.readdirSync(abs).find((e) => /\.vbproj$/i.test(e));
    if (project) {
      const text = fs.readFileSync(path.join(abs, project), 'utf8');
      const root = /<RootNamespace>\s*([\w.]*)\s*<\/RootNamespace>/i.exec(text)?.[1] ?? project.replace(/\.vbproj$/i, '');
      info.root = root.toLowerCase().split('.').filter((s) => s !== '');
      for (const m of text.matchAll(/<Import\s+Include\s*=\s*"([\w.]+)"/gi)) info.imports.push(m[1]!.toLowerCase());
    }
  } catch {
    // Unreadable project file: no root namespace, no project imports.
  }
  memo.set(dir, info);
  return info;
}

/** A node's full qualified name as segments: its project's root namespace, then its namespaces and types. */
function fullSegments(n: Node, context: ResolutionContext): string[] {
  return [...projectInfo(n.filePath, context).root, ...n.qualifiedName.toLowerCase().split('::').flatMap((s) => s.split('.'))];
}

/** A file's lines before its first declaration: where its `Option` and `Imports` statements are. */
function headerLines(file: string, context: ResolutionContext): string[] {
  const lines = codeLines(file, context);
  const end = lines.findIndex((l) =>
    /^\s*(?:Namespace|Module|Class|Structure|Interface|Enum|Delegate|Public|Friend|Private|Protected|Partial|NotInheritable|MustInherit)\b/i.test(l));
  return end < 0 ? lines : lines.slice(0, end);
}

const VB_FILE_IMPORTS = new WeakMap<ResolutionContext, Map<string, string[]>>();

/** The namespaces a file imports — its own `Imports` and its project's — lowercased. */
function importedNamespaces(file: string, context: ResolutionContext): string[] {
  let memo = VB_FILE_IMPORTS.get(context);
  if (!memo) VB_FILE_IMPORTS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const imports = [...projectInfo(file, context).imports];
  for (const line of headerLines(file, context)) {
    const m = /^\s*Imports\s+([\w.]+)\s*$/i.exec(line);
    if (m) imports.push(m[1]!.toLowerCase().replace(/^global\./, ''));
  }
  memo.set(file, imports);
  return imports;
}

const VB_ALIASES = new WeakMap<ResolutionContext, Map<string, Map<string, VbType>>>();

/** A file's import aliases: `Imports TDJob = SCrawler.DownloadObjects.TDownloader.Job`, by lowercased alias. */
function importAliases(file: string, context: ResolutionContext): Map<string, VbType> {
  let memo = VB_ALIASES.get(context);
  if (!memo) VB_ALIASES.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const aliases = new Map<string, VbType>();
  for (const line of headerLines(file, context)) {
    const m = /^\s*Imports\s+([A-Za-z_]\w*)\s*=\s*(.+)$/i.exec(line);
    const target = m ? readType(m[2]!, 0) : null;
    if (target) aliases.set(m![1]!.toLowerCase(), target);
  }
  memo.set(file, aliases);
  return aliases;
}

/** `t` with an import alias it is written with — as itself or as its first qualifier — spelled out. */
function unalias(t: VbType, file: string, context: ResolutionContext): VbType {
  const aliases = importAliases(file, context);
  if (aliases.size === 0) return t;
  if (!t.qualifier) {
    const target = aliases.get(t.name.toLowerCase());
    return target ? { ...t, name: target.name, ...(target.qualifier ? { qualifier: target.qualifier } : {}) } : t;
  }
  const target = aliases.get(t.qualifier[0]!);
  return target ? { ...t, qualifier: [...(target.qualifier ?? []), target.name.toLowerCase(), ...t.qualifier.slice(1)] } : t;
}

/** Whether `tail` is the end of `full`. */
function endsWith(full: string[], tail: string[]): boolean {
  return tail.length <= full.length && tail.every((s, i) => full[full.length - tail.length + i] === s);
}

const VB_TYPE_LIKE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'type_alias']);

/** The class, structure or interface (not a `Module`) a VB.NET type is nested in, or null. */
function enclosingType(n: Node, context: ResolutionContext): Node | null {
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return null;
  const parentQn = n.qualifiedName.slice(0, cut);
  const parent = context.getNodesByQualifiedName(parentQn).find((p) => p.language === 'vbnet' && VB_TYPE_KINDS.has(p.kind));
  return parent && !isModule(parentQn, context) ? parent : null;
}

function isNestedInType(n: Node, context: ResolutionContext): boolean {
  return enclosingType(n, context) !== null;
}

const VB_BASE_NAMES = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/**
 * The lowercased names of the types around a line and of the classes they
 * inherit, walked by name (a few levels): the types whose nested types code
 * there names bare — `Dim ret As New MenuList` in a `VideoEncoder` subclass.
 */
function baseTypeNamesAround(file: string, line: number, context: ResolutionContext): Set<string> {
  const around = typesAround(file, line, context);
  let memo = VB_BASE_NAMES.get(context);
  if (!memo) VB_BASE_NAMES.set(context, (memo = new Map()));
  const key = around.map((t) => t.id).join('|');
  const hit = memo.get(key);
  if (hit) return hit;
  const names = new Set<string>();
  let frontier = around;
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const t of frontier) {
      if (names.has(t.name.toLowerCase())) continue;
      names.add(t.name.toLowerCase());
      for (const sup of supertypesOf(t, context)) if (!sup.implemented) next.push(...projectTypesNamed(sup.name, context));
    }
    frontier = next;
  }
  memo.set(key, names);
  return names;
}

/**
 * Whether a type is one a name written with this qualifier can mean: its
 * namespaces and outer types end with what is written before the name.
 * Designer code's `New System.Drawing.Point(3, 3)` is not staxrip's nested
 * `ButtonEx.SymbolDrawer.Point`; `New API.Base.UserDataBase(…)` is that one.
 */
export function isVbTypeQualifiedBy(n: Node, qualifier: string, file: string, context: ResolutionContext): boolean {
  if (n.language !== 'vbnet' || !VB_TYPE_LIKE_KINDS.has(n.kind)) return true;
  const written = readType(`${qualifier}.${n.name}`, 0);
  if (!written?.qualifier) return true;
  const t = unalias(written, file, context);
  return !t.qualifier || endsWith(fullSegments(n, context).slice(0, -1), t.qualifier);
}

/**
 * The project types a type name written at a site means, as VB.NET looks it
 * up: one its written qualifier names, nested in or declared in the namespace
 * of a type around the site — the nearest first — else nested in a class
 * those inherit, else in a namespace the file or project imports, else in
 * the site's own project (a class's nested type only where it is in scope).
 * SCrawler declares
 * a `SiteSettings` in each site's namespace (`API.Pinterest`, `API.Bluesky`,
 * …); a member typed `SiteSettings` in `API.Pinterest.UserData` is
 * Pinterest's. `ambiguous` when what is left are different types. `kinds`
 * widens the types looked for (an `Enum` a value is read through).
 */
function typesNamedAt(
  written: VbType,
  context: ResolutionContext,
  kinds: ReadonlySet<string> = VB_TYPE_KINDS,
): { owners: Node[]; ambiguous: boolean } {
  const t = written.file ? unalias(written, written.file, context) : written;
  let candidates = projectTypesNamed(t.name, context, kinds);
  // `System.Drawing.Color` is not the project's `Color`; `API.Base.UserDataBase` is that one.
  if (t.qualifier) candidates = candidates.filter((c) => endsWith(fullSegments(c, context).slice(0, -1), t.qualifier!));
  if (candidates.length === 0 || !t.file) return { owners: candidates, ambiguous: false };
  const file = t.file;
  const site = typesAround(file, t.line ?? 0, context)[0];
  const sitePath = site ? fullSegments(site, context) : projectInfo(file, context).root;
  let tier: Node[] = [];
  let best = -1;
  for (const c of candidates) {
    const container = fullSegments(c, context).slice(0, -1);
    if (container.length > sitePath.length || container.some((s, i) => s !== sitePath[i])) continue;
    if (container.length > best) {
      best = container.length;
      tier = [c];
    } else if (container.length === best) tier.push(c);
  }
  // A type nested in a class the site's types inherit.
  if (tier.length === 0 && !t.qualifier) {
    const bases = baseTypeNamesAround(file, t.line ?? 0, context);
    tier = candidates.filter((c) => bases.has(enclosingType(c, context)?.name.toLowerCase() ?? ''));
  }
  if (tier.length === 0) {
    const imports = importedNamespaces(file, context);
    tier = candidates.filter((c) => imports.includes(fullSegments(c, context).slice(0, -1).join('.')));
  }
  // Else any the project declares in a namespace (the root namespaces and
  // project imports this cannot see) — but not a class's nested type, which
  // is named bare only inside it or a class deriving from it.
  if (tier.length === 0) tier = t.qualifier ? candidates : candidates.filter((c) => !isNestedInType(c, context));
  // A project's own declaration over another project's of the same name
  // (staxrip's main app and its AutoCrop tool each declare a `ColorHSL`).
  const own = tier.filter((c) => sameVbProject(c.filePath, file, context));
  if (own.length > 0) tier = own;
  // One type's partial parts are one type.
  const distinct = new Set(tier.map((c) => `${projectOf(c.filePath, context)}|${c.qualifiedName.toLowerCase()}`));
  return { owners: [...tier.filter((c) => c.filePath === file), ...tier.filter((c) => c.filePath !== file)], ambiguous: distinct.size > 1 };
}

/** The call site's own file first, then its project's, the rest after, each in its given order. */
export function preferVbProject(nodes: Node[], ref: UnresolvedRef, context: ResolutionContext): Node[] {
  if (nodes.length < 2) return nodes;
  const file: Node[] = [];
  const project: Node[] = [];
  const rest: Node[] = [];
  for (const n of nodes) {
    if (n.filePath === ref.filePath) file.push(n);
    else if (sameVbProject(n.filePath, ref.filePath, context)) project.push(n);
    else rest.push(n);
  }
  return [...file, ...project, ...rest];
}

/** How many leading directories two files share. */
function sharedDirs(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let i = 0;
  while (i < da.length && i < db.length && da[i] === db[i]) i++;
  return i;
}

/**
 * The one of several equally good guesses a call means: the one in its own
 * file, else in its own project, else in the nearest directory — or null
 * when none of these tells them apart.
 */
export function breakVbTie(tied: Node[], ref: UnresolvedRef, context: ResolutionContext): Node | null {
  // One type's overloads (and partial parts) are one guess, not a tie: the first stands for them.
  const seen = new Set<string>();
  const distinct = tied.filter((n) => {
    const key = `${projectOf(n.filePath, context)}|${n.qualifiedName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (distinct.length === 1) return distinct[0]!;
  let pool = distinct.filter((n) => n.filePath === ref.filePath);
  if (pool.length === 0) {
    const own = distinct.filter((n) => sameVbProject(n.filePath, ref.filePath, context));
    pool = own.length > 0 ? own : distinct;
  }
  if (pool.length === 1) return pool[0]!;
  let best = -1;
  let winners: Node[] = [];
  for (const n of pool) {
    const shared = sharedDirs(ref.filePath, n.filePath);
    if (shared > best) {
      best = shared;
      winners = [n];
    } else if (shared === best) winners.push(n);
  }
  return winners.length === 1 ? winners[0]! : null;
}

/** The type a field or property declares itself with, read from its declaration. */
function memberDeclaredType(member: Node, context: ResolutionContext): VbType | null {
  const code = codeLines(member.filePath, context).slice(member.startLine - 1, member.startLine + 2).join(' ');
  const r = escapeRegex(member.name);
  const property = new RegExp(`\\bProperty\\s+${r}\\b\\s*`, 'i').exec(code);
  if (property) {
    let at = property.index + property[0].length;
    if (code[at] === '(') {
      const close = closeParen(code, at);
      if (close < 0) return null;
      at = close + 1;
    }
    const as = /^\s*As\s+(New\s+)?/i.exec(code.slice(at));
    const type = as ? readType(code, at + as[0].length) : null;
    return type && as?.[1] ? { ...type, array: false } : type;
  }
  const binding = bindingOn(code, member.name);
  if (binding?.kind === 'type') return binding.type;
  // `Private x = New Foo()`: a field's initializer is what it holds.
  const init = new RegExp(`(?<![\\w.])${r}\\s*=(?!=)`, 'i').exec(code);
  const value = init ? valueBinding(code.slice(init.index + init[0].length)) : null;
  return value?.kind === 'type' ? value.type : null;
}

/**
 * The type a value member — a field, a property, or a function read without
 * parentheses — has, as written at it; a type parameter of its class is what
 * `args` gives it where it is reached from.
 */
function valueMemberType(member: Node, context: ResolutionContext, args: ReadonlyMap<string, VbType> = new Map()): VbType | null {
  const type = sited(member.kind === 'method' ? declaredReturnType(member, context) : memberDeclaredType(member, context),
    member.filePath, member.startLine);
  const given = type ? substitute(type, args) : null;
  return given !== type ? given : resolveTypeParameter(type, member, context);
}

/**
 * The type of what a receiver-less `name` reads where a call is: a member of
 * a class around the call or of one it inherits, else of a `Module`. Null when
 * it declares no type the source shows, undefined when nothing has the name.
 */
function memberType(name: string, ref: UnresolvedRef, context: ResolutionContext): VbType | null | undefined {
  const fits = (n: Node) => VB_VALUE_KINDS.has(n.kind) || n.kind === 'method';
  for (const around of typesAround(ref.filePath, ref.line, context)) {
    for (const { node, args } of ancestry(around, context)) {
      const member = membersNamed(node, name, context).find(fits);
      if (member) return valueMemberType(member, context, args);
    }
  }
  const global = moduleMembersNamed(name, ref, context).find(fits);
  return global ? valueMemberType(global, context) : undefined;
}

/** The type a method, function or property returns, read from its declaration; null for a `Sub` or none written. */
function declaredReturnType(n: Node, context: ResolutionContext): VbType | null {
  const code = codeLines(n.filePath, context).slice(n.startLine - 1, n.startLine + 6).join(' ');
  const head = new RegExp(`\\b(Function|Property|Sub)\\s+${escapeRegex(n.name)}\\b`, 'i').exec(code);
  if (!head || /^Sub$/i.test(head[1]!)) return null;
  let at = head.index + head[0].length;
  // `(Of T)`, then the parameter list.
  for (let group = 0; group < 2; group++) {
    const open = /^\s*\(/.exec(code.slice(at));
    if (!open) break;
    const close = closeParen(code, at + open[0].length - 1);
    if (close < 0) return null;
    at = close + 1;
  }
  const as = /^\s*As\s+/i.exec(code.slice(at));
  return as ? readType(code, at + as[0].length) : null;
}

const VB_TYPE_PARAMS = new WeakMap<ResolutionContext, Map<string, Map<string, VbType | null>>>();

/** The type parameters a declaration's head names (`Class Repo(Of T As Entity)`), each with its constraint or null. */
function typeParametersOf(n: Node, context: ResolutionContext): Map<string, VbType | null> {
  let memo = VB_TYPE_PARAMS.get(context);
  if (!memo) VB_TYPE_PARAMS.set(context, (memo = new Map()));
  const hit = memo.get(n.id);
  if (hit) return hit;
  const params = readTypeParameters(n, context);
  memo.set(n.id, params);
  return params;
}

function readTypeParameters(n: Node, context: ResolutionContext): Map<string, VbType | null> {
  const params = new Map<string, VbType | null>();
  const code = codeLines(n.filePath, context).slice(n.startLine - 1, n.startLine + 2).join(' ');
  const head = new RegExp(`\\b(?:Class|Structure|Interface|Module|Function|Sub)\\s+${escapeRegex(n.name)}\\s*(?=\\(\\s*Of\\b)`, 'i').exec(code);
  if (!head) return params;
  for (const p of splitArgs(code, head.index + head[0].length) ?? []) {
    const m = /^(?:Of\s+)?(?:In\s+|Out\s+)?([A-Za-z_]\w*)(?:\s+As\s+(.+))?$/i.exec(p);
    if (!m) continue;
    const constraints = (m[2] ?? '').replace(/^\{|\}$/g, '').split(',').map((c) => c.trim())
      .filter((c) => c !== '' && !/^(?:New|Class|Structure)$/i.test(c));
    params.set(m[1]!.toLowerCase(), constraints.length > 0 ? sited(readType(constraints[0]!, 0), n.filePath, n.startLine) : null);
  }
  return params;
}

/**
 * What a type means where it is written: a type parameter of the method
 * (`owner`) or of a type around it stands for its constraint — null when it
 * has none, as its value's type is then unknown — and any other name for itself.
 */
function resolveTypeParameter(t: VbType | null, owner: Node | null, context: ResolutionContext): VbType | null {
  if (!t || t.array || isBuiltin(t) || t.qualifier || !t.file) return t;
  const key = t.name.toLowerCase();
  for (const decl of [...(owner && owner.kind === 'method' ? [owner] : []), ...typesAround(t.file, t.line ?? 0, context)]) {
    const params = typeParametersOf(decl, context);
    if (params.has(key)) return params.get(key) ?? null;
  }
  return t;
}

/**
 * The project types `t` names where it is written, null when the name leaves
 * different types (a guess between them would be no better than none), or
 * none for an array or a built-in type.
 */
function ownersOf(t: VbType, context: ResolutionContext): Node[] | null {
  if (t.array || isBuiltin(t)) return [];
  const found = typesNamedAt(t, context);
  return found.ambiguous ? null : found.owners;
}

/**
 * A method — or, `withValues`, a field or property; or what `fits` — named
 * `name` on one of `owners` (the type `typed` names) or a project type they
 * inherit, with what the type parameters of the type declaring it stand for.
 */
function memberOn(
  owners: Node[],
  name: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  withValues: boolean,
  typed?: VbType,
  fits: (n: Node) => boolean = (n) => n.kind === 'method' || (withValues && VB_VALUE_KINDS.has(n.kind)),
): { node: Node; args: Map<string, VbType> } | null {
  for (const level of [0, 1]) {
    for (const owner of preferVbProject(owners, ref, context)) {
      // What the owner's own parameters are, as the receiver's type writes them (`Repo(Of Foo)`).
      const given = new Map([...typeParametersOf(owner, context).keys()].flatMap((p, i): Array<[string, VbType]> =>
        (typed?.args?.[i] ? [[p, typed.args[i]!]] : [])));
      const ancestors = ancestry(owner, context);
      for (const { node, args } of level === 0 ? ancestors.slice(0, 1) : ancestors.slice(1)) {
        const found = preferVbProject(membersNamed(node, name, context).filter(fits), ref, context)[0];
        if (found) return { node: found, args: level === 0 ? given : new Map([...args].map(([p, t]) => [p, substitute(t, given)])) };
      }
    }
  }
  return null;
}

/** The type of the value `Member(…)` / `obj.Member(…)` gives, from the member's declaration. */
function callResultType(
  call: { receiver: string | null; member: string },
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): VbType | null {
  let member: { node: Node; args: Map<string, VbType> } | null = null;
  if (call.receiver === null || /^(?:Me|MyClass|MyBase)$/i.test(call.receiver)) {
    const owners = typesAround(ref.filePath, ref.line, context).slice(0, 1);
    member = owners.length > 0 ? memberOn(owners, call.member, ref, context, true) : null;
    if (!member && call.receiver === null) {
      const global = moduleMembersNamed(call.member, ref, context).find((n) => n.kind === 'method' || VB_VALUE_KINDS.has(n.kind));
      member = global ? { node: global, args: new Map() } : null;
    }
  } else {
    const type = receiverType(call.receiver, ref, context, depth + 1);
    // Not a variable: a type or module named for a shared call (`ObjectStorage.Load()`).
    const owners = type === undefined ? ownersOf({ name: call.receiver, array: false, file: ref.filePath, line: ref.line }, context)
      : type ? ownersOf(type, context) : null;
    member = owners && owners.length > 0 ? memberOn(owners, call.member, ref, context, true, type ?? undefined) : null;
  }
  return member ? valueMemberType(member.node, context, member.args) : null;
}

/**
 * What a receiver named `name` is declared as where the call is: a local or
 * parameter of its member, else a field or property of its class, of one the
 * class inherits, or of a `Module`. Null when the receiver is bound but its
 * type isn't known; undefined when nothing binds the name (a type or module).
 */
function receiverType(name: string, ref: UnresolvedRef, context: ResolutionContext, depth: number): VbType | null | undefined {
  if (depth > 2) return null;
  const local = localBinding(name, ref, context);
  if (local) {
    const { binding, line } = local;
    const owner = context.getNodeById?.(ref.fromNodeId) ?? null;
    if (binding.kind === 'type') return resolveTypeParameter(sited(binding.type, ref.filePath, line), owner, context);
    if (binding.kind === 'call') return callResultType(binding, { ...ref, line }, context, depth);
    if (binding.kind === 'each') {
      const collection = receiverType(binding.collection, { ...ref, line }, context, depth + 1);
      return collection ? elementType(collection) : null;
    }
    return null;
  }
  return memberType(name, ref, context);
}

interface VbExtension {
  node: Node;
  /** The type it extends; null when that is one of its own type parameters (it extends anything). */
  param: VbType | null;
}

const VB_EXTENSIONS = new WeakMap<ResolutionContext, Map<string, VbExtension | null>>();

/** A method's extension-method declaration (`<Extension> Function F(s As String, …)`), or null when it isn't one. */
function extensionOf(n: Node, context: ResolutionContext): VbExtension | null {
  if (n.kind !== 'method' || n.language !== 'vbnet') return null;
  let memo = VB_EXTENSIONS.get(context);
  if (!memo) VB_EXTENSIONS.set(context, (memo = new Map()));
  const hit = memo.get(n.id);
  if (hit !== undefined) return hit;
  const extension = readExtension(n, context);
  memo.set(n.id, extension);
  return extension;
}

function readExtension(n: Node, context: ResolutionContext): VbExtension | null {
  const code = codeLines(n.filePath, context).slice(Math.max(0, n.startLine - 2), n.startLine + 6).join(' ');
  const decl = new RegExp(`\\b(?:Function|Sub)\\s+${escapeRegex(n.name)}\\b`, 'i').exec(code);
  if (!decl) return null;
  const attributes = /((?:<[^<>]*>\s*)+)(?:(?:Public|Friend|Private|Protected|Shared|Overloads|Async|Iterator)\s+)*$/i
    .exec(code.slice(0, decl.index))?.[1];
  if (!attributes || !/\bExtension(?:Attribute)?\b/i.test(attributes)) return null;
  let at = decl.index + decl[0].length;
  const typeParams = new Set<string>();
  if (/^\s*\(\s*Of\b/i.test(code.slice(at))) {
    const open = code.indexOf('(', at);
    for (const p of splitArgs(code, open) ?? []) {
      const tp = /^(?:Of\s+)?(?:In\s+|Out\s+)?([A-Za-z_]\w*)/i.exec(p);
      if (tp) typeParams.add(tp[1]!.toLowerCase());
    }
    const close = closeParen(code, open);
    if (close < 0) return null;
    at = close + 1;
  }
  const open = /^\s*\(/.exec(code.slice(at));
  const first = open ? splitArgs(code, at + open[0].length - 1)?.[0]?.replace(/<[^<>]*>/g, '') : undefined;
  const as = first ? /\bAs\s+/i.exec(first) : null;
  const type = as ? readType(first!, as.index + as[0].length) : null;
  if (!type) return null;
  return { node: n, param: typeParams.has(type.name.toLowerCase()) && !type.array ? null : type };
}

/** `Object`'s instance methods, which every type has. */
const OBJECT_METHODS = ['tostring', 'equals', 'gethashcode', 'gettype'];

/**
 * The instance methods of .NET's everyday types: a call one of them answers
 * is the type's own, whatever extension of that name the project declares
 * (`list.Sort()` on a `List(Of T)`), and a name one of them lacks is no
 * instance method there (`list.Join(", ")` is an extension's).
 */
const BCL_INSTANCE_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries({
  string: ['clone', 'compareto', 'contains', 'copyto', 'endswith', 'getenumerator', 'gettypecode', 'indexof', 'indexofany',
    'insert', 'isnormalized', 'lastindexof', 'lastindexofany', 'normalize', 'padleft', 'padright', 'remove', 'replace', 'split',
    'startswith', 'substring', 'tochararray', 'tolower', 'tolowerinvariant', 'toupper', 'toupperinvariant', 'trim', 'trimend',
    'trimstart'],
  stringbuilder: ['append', 'appendformat', 'appendjoin', 'appendline', 'clear', 'copyto', 'ensurecapacity', 'getchunks', 'insert',
    'remove', 'replace'],
  list: ['add', 'addrange', 'asreadonly', 'binarysearch', 'clear', 'contains', 'convertall', 'copyto', 'exists', 'find', 'findall',
    'findindex', 'findlast', 'findlastindex', 'foreach', 'getenumerator', 'getrange', 'indexof', 'insert', 'insertrange',
    'lastindexof', 'remove', 'removeall', 'removeat', 'removerange', 'reverse', 'sort', 'toarray', 'trimexcess', 'trueforall'],
  dictionary: ['add', 'clear', 'containskey', 'containsvalue', 'ensurecapacity', 'getenumerator', 'remove', 'trimexcess', 'tryadd',
    'trygetvalue'],
  hashset: ['add', 'clear', 'contains', 'copyto', 'exceptwith', 'getenumerator', 'intersectwith', 'ispropersubsetof',
    'ispropersupersetof', 'issubsetof', 'issupersetof', 'overlaps', 'remove', 'removewhere', 'setequals', 'symmetricexceptwith',
    'trimexcess', 'trygetvalue', 'unionwith'],
  '[]': ['clone', 'copyto', 'getenumerator', 'getlength', 'getlonglength', 'getlowerbound', 'getupperbound', 'getvalue',
    'initialize', 'setvalue'],
}).map(([type, methods]) => [type, new Set([...methods, ...OBJECT_METHODS])]));

/** The instance methods of a .NET type the table above knows; undefined for any other. */
function bclInstanceMethods(t: VbType): ReadonlySet<string> | undefined {
  return BCL_INSTANCE_METHODS.get(t.array ? '[]' : typeKey(t));
}

/**
 * Whether a value of type `t` might reach an extension declared for `param`
 * through a conversion nothing here can check: `Object`, an array's
 * collection interfaces, an interface a built-in type implements, or any
 * type an outside base type may lead to.
 */
function mayExtend(t: VbType, open: boolean, param: VbType): boolean {
  if (typeKey(param) === 'object') return true;
  if (param.array !== t.array) {
    return t.array && /^(?:IEnumerable|IList|ICollection|IReadOnlyList|IReadOnlyCollection|Array)$/i.test(param.name);
  }
  if (isBuiltin(param)) return false;
  if (isBuiltin(t)) return /^I[A-Z]/.test(param.name);
  return open;
}

/**
 * The extension method a call on a value of type `t` reaches: one declared
 * for `t` or for a type it inherits — else, when exactly one other extension
 * of that name could apply and the name is no instance method of `t`'s
 * (one of .NET's own names, for a type nothing here describes), that one.
 */
function extensionFor(
  t: VbType,
  owners: Node[],
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  isStdMethod: (name: string) => boolean,
): ResolvedRef | null {
  const instanceMethods = owners.length === 0 ? bclInstanceMethods(t) : undefined;
  if (instanceMethods?.has(method.toLowerCase())) return null;
  const extensions = context.getNodesByLowerName(method.toLowerCase())
    .map((n) => extensionOf(n, context))
    .filter((e): e is VbExtension => e !== null);
  if (extensions.length === 0) return null;
  // Every name the type goes by — its own, its base types', the interfaces
  // they implement — and whether one of them is an outside type, whose own
  // ancestry nothing here shows.
  const names = new Set<string>([typeKey({ name: t.name, array: false })]);
  let open = owners.length === 0 && !isBuiltin(t) && !t.array;
  for (const owner of owners) {
    for (const type of hierarchy(owner, context)) {
      names.add(type.name.toLowerCase());
      for (const sup of supertypesOf(type, context)) {
        names.add(typeKey(sup));
        const found = typesNamedAt(sup, context).owners;
        if (found.length === 0) open = true;
        else if (sup.implemented) for (const i of found) for (const h of hierarchy(i, context)) names.add(h.name.toLowerCase());
      }
    }
  }
  const exact = extensions.filter((e) => e.param !== null &&
    (typeKey(e.param) === typeKey(t) || (!t.array && !e.param.array && names.has(typeKey(e.param)))));
  if (exact.length > 0) {
    const target = preferVbProject(exact.map((e) => e.node), ref, context)[0]!;
    return { original: ref, targetNodeId: target.id, confidence: 0.85, resolvedBy: 'instance-method' };
  }
  const loose = extensions.filter((e) => e.param === null || mayExtend(t, open, e.param));
  if (loose.length === 1 && (instanceMethods !== undefined || !isStdMethod(method))) {
    return { original: ref, targetNodeId: loose[0]!.node.id, confidence: 0.7, resolvedBy: 'instance-method' };
  }
  return null;
}

/**
 * Resolve `receiver.method()` through the receiver's declared type: the
 * type's own method or one it inherits, else an extension method for it,
 * else null — a typed receiver is never a guess. A receiver naming one of the
 * project's types or modules is a shared call on it. Undefined when the type
 * isn't known, or is `Object` (a late-bound call), for the name strategies.
 */
export function matchVbTypedCall(
  receiver: string,
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  isStdMethod: (name: string) => boolean,
): ResolvedRef | null | undefined {
  if (!/^[A-Za-z_]\w*$/.test(receiver)) return undefined;
  const type = receiverType(receiver, ref, context, 0);
  if (type === undefined) {
    // A type or module named for a shared call — `M3U8.Download(…)` in SCrawler's
    // `API.Reddit.UserData` is `API.Reddit.M3U8`'s, not another site's: its own
    // member or one it inherits.
    const named = typesNamedAt({ name: receiver, array: false, file: ref.filePath, line: ref.line }, context);
    if (named.owners.length === 0) return undefined;
    if (named.ambiguous) return null;
    const shared = memberOn(named.owners, method, ref, context, false);
    if (shared) return { original: ref, targetNodeId: shared.node.id, confidence: 0.85, resolvedBy: 'qualified-name' };
    // `AppSession.Items(0)`: an index into a shared field or property, which
    // VB.NET writes as a call — a read of the member and of its type (#2305).
    const indexed = memberOn(named.owners, method, ref, context, true);
    return indexed ? readThrough(indexed.node, named.owners, ref, context, { edgeKind: 'references' }) : null;
  }
  if (!type || typeKey(type) === 'object') return undefined;
  const owners = ownersOf(type, context);
  // A type name that leaves two of the project's types: no guess between them.
  if (owners === null) return null;
  return callOnValue(type, owners, method, ref, context, isStdMethod);
}

/**
 * A call of `method` on a value of type `type` (`owners`, the project type
 * it names; none for an outside type): the type's own method or one it
 * inherits; an index into its field or property (`x.Items(0)`), which VB.NET
 * writes as a call, reads the member; else an extension method for the type.
 */
function callOnValue(
  type: VbType,
  owners: Node[],
  method: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  isStdMethod: (name: string) => boolean,
): ResolvedRef | null {
  if (owners.length > 0) {
    const own = memberOn(owners, method, ref, context, false, type);
    if (own) return { original: ref, targetNodeId: own.node.id, confidence: 0.9, resolvedBy: 'instance-method' };
    const indexed = memberOn(owners, method, ref, context, true, type);
    if (indexed) {
      return indexed.node.id === ref.fromNodeId ? null
        : { original: ref, targetNodeId: indexed.node.id, confidence: 0.9, resolvedBy: 'instance-method', edgeKind: 'references' };
    }
  }
  return extensionFor(type, owners, method, ref, context, isStdMethod);
}

/** The types a value is read through: those a shared call is made on, and an `Enum`. */
const VB_READ_TYPE_KINDS: ReadonlySet<string> = new Set([...VB_TYPE_KINDS, 'enum']);

/**
 * What a read through a type names: a value it holds or gives (a field, a
 * property, a constant, an `Enum` case, an event), a method — which VB.NET
 * runs when it is named without parentheses — or a type nested in it.
 */
const VB_READ_KINDS: ReadonlySet<string> = new Set([...VB_VALUE_KINDS, 'enum_member', 'method', ...VB_TYPE_LIKE_KINDS]);

/** What a read through a value names: a field, property, constant or event of its type, or a method it runs. */
const VB_INSTANCE_READ_KINDS: ReadonlySet<string> = new Set([...VB_VALUE_KINDS, 'method']);

/** Members that belong to a type, not an instance, besides those declared `Shared`: a constant, an `Enum` case, a nested type. */
const VB_SHARED_READ_KINDS: ReadonlySet<string> = new Set(['constant', 'enum_member', ...VB_TYPE_LIKE_KINDS]);

/**
 * Whether a member belongs to its type rather than to an instance: `Shared`,
 * an `Enum` case, a nested type, or a `Const` — Shared without saying so,
 * which a VB.NET field's node doesn't record, so its declaration is read.
 */
function isSharedMember(n: Node, context: ResolutionContext): boolean {
  if (n.isStatic || VB_SHARED_READ_KINDS.has(n.kind)) return true;
  if (n.kind !== 'field') return false;
  const code = codeLines(n.filePath, context).slice(n.startLine - 1, n.startLine + 2).join(' ');
  return new RegExp(`\\bConst\\s+(?:[^=]*,\\s*)?${escapeRegex(n.name)}(?![\\w$%&!#@])`, 'i').test(code);
}

/**
 * A member read (or a `With` block's call) as the extractor sends it
 * (extractVbMemberRead): the receiver — a name, `Me` / `MyClass` / `MyBase`,
 * or `{T}` for a value of a type the code writes — then each member read
 * through it, the last the one used: `AppSession.SessionId`, `x.Normal`,
 * `Me._h.Title`, `{BoolParam}.Switch`.
 */
const VB_MEMBER_PATH = /^(\{[^{}]+\}|\[?[A-Za-z_]\w*\]?)((?:\.\[?[A-Za-z_]\w*\]?)*)\.(\[?[A-Za-z_]\w*\]?)$/;

/** Whether a reference is a VB.NET member read through a receiver, which matchVbMemberRead alone resolves. */
export function isVbMemberRead(ref: UnresolvedRef): boolean {
  return ref.language === 'vbnet' && ref.referenceKind === 'references' && VB_MEMBER_PATH.test(ref.referenceName);
}

/**
 * Whether a reference is a VB.NET call through a receiver path, which only a
 * `With` block sends (`.Run()` in `With Me._h`, `With DirectCast(o, T)`) and
 * matchVbPathCall alone resolves. A call through a name (`x.Run`) is the
 * name matcher's, which types it with matchVbTypedCall.
 */
export function isVbPathCall(ref: UnresolvedRef): boolean {
  if (ref.language !== 'vbnet' || ref.referenceKind !== 'calls') return false;
  const m = VB_MEMBER_PATH.exec(ref.referenceName);
  return m !== null && (m[2] !== '' || m[1]!.startsWith('{') || /^(?:Me|MyClass|MyBase)$/i.test(m[1]!));
}

/** What a receiver path reaches: the project type whose members are read through it, and how. */
interface VbReceiver {
  /** The parts of the project type the receiver names or holds a value of; none for an outside type. */
  owners: Node[];
  /** The type a value is declared as, with the type arguments it gives; absent through a type's name. */
  typed?: VbType;
  /** The receiver names a type (`AppSession`, `Outer.Mode`), whose own members are read, not a value. */
  throughType: boolean;
  /** The name is a value whose type has the same name (`theme As Theme`): VB.NET's "Color Color" rule. */
  colorColor?: boolean;
}

/** `Name` for an escaped `[Name]`. */
function unescaped(name: string): string {
  return name.replace(/^\[(.*)\]$/, '$1');
}

/** A receiver holding a value of type `t`; null when that type isn't known, is `Object` (late-bound), or names two types. */
function valueReceiver(t: VbType | null | undefined, context: ResolutionContext): VbReceiver | null {
  if (!t || typeKey(t) === 'object') return null;
  const owners = ownersOf(t, context);
  return owners ? { owners, typed: t, throughType: false } : null;
}

/**
 * What a receiver path's first link is where a member is read through it:
 * `Me` / `MyClass` the type around the read, `MyBase` the class that type
 * inherits, `{T}` a value of `T`. A name holds a value of its declared type
 * when it is a local, a parameter, or a member of a type around the read or
 * of a Module; any other name means the class, module, structure, interface
 * or enum it names there. A value whose type has its name (`Public Property
 * Settings As Settings`, `theme As Theme`) may mean either, by VB.NET's
 * "Color Color" rule: the member read through it decides (matchVbMemberRead).
 */
function receiverAt(head: string, ref: UnresolvedRef, context: ResolutionContext): VbReceiver | null {
  if (head.startsWith('{')) {
    const owner = context.getNodeById?.(ref.fromNodeId) ?? null;
    return valueReceiver(resolveTypeParameter(sited(readType(head.slice(1, -1), 0), ref.filePath, ref.line), owner, context), context);
  }
  if (/^(?:Me|MyClass|MyBase)$/i.test(head)) {
    const own = typesAround(ref.filePath, ref.line, context)[0];
    if (!own) return null;
    if (/^MyBase$/i.test(head)) return valueReceiver(supertypesOf(own, context).find((s) => !s.implemented), context);
    return { owners: [own], typed: { name: own.name, array: false }, throughType: false };
  }
  const name = unescaped(head);
  const bound = receiverType(name, ref, context, 0);
  const written: VbType | null = bound === undefined ? { name, array: false, file: ref.filePath, line: ref.line }
    : bound && !bound.array && bound.name.toLowerCase() === name.toLowerCase() ? bound : null;
  if (!written) return valueReceiver(bound, context);
  const found = typesNamedAt(written, context, VB_READ_TYPE_KINDS);
  return found.ambiguous || found.owners.length === 0 ? null
    : { owners: found.owners, throughType: true, ...(bound ? { colorColor: true } : {}) };
}

/**
 * What `name`, read through `at`, is as a receiver in turn: a value of the
 * type a field, property or function declares, or a type nested in a type
 * named for it (`Outer.Mode`). Null where the member, or its type, is not
 * known here.
 */
function memberAt(at: VbReceiver, name: string, ref: UnresolvedRef, context: ResolutionContext): VbReceiver | null {
  if (at.owners.length === 0) return null;
  const fits = (n: Node) => VB_INSTANCE_READ_KINDS.has(n.kind) || (at.throughType && VB_READ_TYPE_KINDS.has(n.kind));
  const found = memberOn(at.owners, name, ref, context, true, at.typed, fits) ??
    memberOn(at.owners, `[${name}]`, ref, context, true, at.typed, fits);
  if (!found) return null;
  if (VB_READ_TYPE_KINDS.has(found.node.kind)) return { owners: [found.node], throughType: true };
  return valueReceiver(valueMemberType(found.node, context, found.args), context);
}

/** What the receiver path `head.links…` reaches (see receiverAt and memberAt), or null where a link has no type here. */
function pathReceiver(head: string, links: string[], ref: UnresolvedRef, context: ResolutionContext): VbReceiver | null {
  let at = receiverAt(head, ref, context);
  for (const link of links) {
    if (!at) return null;
    at = memberAt(at, unescaped(link), ref, context);
  }
  return at;
}

/**
 * A read of `member` through one of `owners` (the parts of the type its
 * receiver names): the member, and the type as a second target — unless the
 * read is written inside that type, which doesn't depend on itself.
 */
function readThrough(
  member: Node,
  owners: Node[],
  ref: UnresolvedRef,
  context: ResolutionContext,
  extra: Partial<ResolvedRef> = {},
): ResolvedRef | null {
  if (member.id === ref.fromNodeId) return null;
  const owner = owners.find((o) => o.filePath === member.filePath) ?? owners[0]!;
  const from = context.getNodeById?.(ref.fromNodeId)?.qualifiedName.toLowerCase();
  const own = owner.qualifiedName.toLowerCase();
  const inside = owner.id === ref.fromNodeId || (from !== undefined && (from === own || from.startsWith(`${own}::`)));
  return {
    original: ref,
    targetNodeId: member.id,
    confidence: 0.85,
    resolvedBy: 'qualified-name',
    ...extra,
    ...(inside ? {} : { alsoTargets: [{ targetNodeId: owner.id }] }),
  };
}

/** Whether a method is named at a reference without being run: `AddressOf Type.Method`, `NameOf(Type.Method)`. */
function namesWithoutRunning(ref: UnresolvedRef, context: ResolutionContext): boolean {
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1] ?? '';
  return /\b(?:AddressOf\s+|NameOf\s*\(\s*)$/i.test(line.slice(0, Math.max(0, ref.column)));
}

/**
 * Resolve a VB.NET member read or write to the member the receiver's type
 * declares or inherits. Through a type's name (#2305) — `AppSession.SessionId`,
 * `AppSession.CurrentUser = "demo"`, `Logger.Level`, `Mode.Fast` — the read
 * links the type as well, and a `Shared` member before a same-named instance
 * one. Through a value — `x.Normal = 3` on a parameter `x As Holder`,
 * `Me._h.Title`, a `With` block's `.Value`, an initializer's `.Switch` — it
 * links the member of the type the value is declared as, whatever that
 * type's name; never a member of the type the receiver's own name would
 * mean. A value named like its type (`theme As Theme`) reads an instance
 * member as a value does and a Shared one as the type does, by VB.NET's
 * "Color Color" rule. A method named either way is called, as without
 * parentheses VB.NET runs it, unless `AddressOf` or `NameOf` only names it.
 * Null when a link of the path is not typed here (an outside type:
 * `Color.Red`, `str.Length`), is late-bound (`Object`), or names two of the
 * project's types.
 */
export function matchVbMemberRead(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = VB_MEMBER_PATH.exec(ref.referenceName);
  if (!m) return null;
  const links = m[2] ? m[2].slice(1).split('.') : [];
  const at = pathReceiver(m[1]!, links, ref, context);
  if (!at || at.owners.length === 0) return null;
  // `MySettings.Default` reads the property declared `[Default]`, and back.
  const name = unescaped(m[3]!);
  const calls = (member: Node) => member.kind === 'method' && !namesWithoutRunning(ref, context);
  const throughValue = (member: Node): ResolvedRef => ({
    original: ref,
    targetNodeId: member.id,
    confidence: 0.9,
    resolvedBy: 'instance-method',
    ...(calls(member) ? { edgeKind: 'calls' as const } : {}),
  });
  if (!at.throughType) {
    // The member the name means: the nearest the type declares or inherits.
    // The read's own member (`Return Me.Count` in `Count`) runs itself.
    const fits = (n: Node) => VB_INSTANCE_READ_KINDS.has(n.kind);
    const member = (memberOn(at.owners, name, ref, context, true, at.typed, fits) ??
      memberOn(at.owners, `[${name}]`, ref, context, true, at.typed, fits))?.node;
    return member && member.id !== ref.fromNodeId ? throughValue(member) : null;
  }
  // Not the member the read is written in: staxrip's `Overrides ReadOnly
  // Property Package` returns the class's `Shared ReadOnly Property Package`.
  const fits = (n: Node) => VB_READ_KINDS.has(n.kind) && n.id !== ref.fromNodeId;
  let member = (memberOn(at.owners, name, ref, context, true, undefined, fits) ??
    memberOn(at.owners, `[${name}]`, ref, context, true, undefined, fits))?.node;
  if (!member) return null;
  // Of a `Shared` member and an instance one of the same name, a type's name reads the `Shared` one.
  if (!member.isStatic) {
    const found = member;
    member = context.getNodesByQualifiedName(found.qualifiedName).find((n) => n.isStatic && n.filePath === found.filePath && fits(n)) ?? found;
  }
  // "Color Color": a value named like its type (`theme As Theme`) reads an
  // instance member through itself, and only a Shared one through the type.
  if (at.colorColor && !isSharedMember(member, context)) return throughValue(member);
  if (member.kind === 'method') {
    return {
      original: ref,
      targetNodeId: member.id,
      confidence: 0.85,
      resolvedBy: 'qualified-name',
      ...(calls(member) ? { edgeKind: 'calls' as const } : {}),
    };
  }
  // A type named through another (`Outer.Mode.Fast`) is linked by the read
  // that names it (`Outer.Mode`), so only a type named itself is linked here.
  return links.length === 0 ? readThrough(member, at.owners, ref, context, { confidence: 0.9 })
    : { original: ref, targetNodeId: member.id, confidence: 0.9, resolvedBy: 'qualified-name' };
}

/**
 * Resolve a VB.NET call through a receiver path, which a `With` block sends
 * for its `.Run()` (`With Me._h`, `With user.Settings`, `With
 * DirectCast(o, T)`), as matchVbTypedCall resolves one through a typed name:
 * the method the path's type has or inherits, a read of a field or property
 * it indexes, or an extension method for the type. Null — never a guess by
 * the method's name — when a link of the path is not typed here.
 */
export function matchVbPathCall(
  ref: UnresolvedRef,
  context: ResolutionContext,
  isStdMethod: (name: string) => boolean,
): ResolvedRef | null {
  const m = VB_MEMBER_PATH.exec(ref.referenceName);
  if (!m) return null;
  const at = pathReceiver(m[1]!, m[2] ? m[2].slice(1).split('.') : [], ref, context);
  return at?.typed && !at.throughType ? callOnValue(at.typed, at.owners, unescaped(m[3]!), ref, context, isStdMethod) : null;
}

const VB_TYPE_IMPORTS = new WeakMap<ResolutionContext, Map<string, Set<string>>>();

/** The last names of a file's `Imports` (a type imported this way lends its shared members; an alias lends none). */
function importedNames(file: string, context: ResolutionContext): Set<string> {
  let memo = VB_TYPE_IMPORTS.get(context);
  if (!memo) VB_TYPE_IMPORTS.set(context, (memo = new Map()));
  const hit = memo.get(file);
  if (hit) return hit;
  const names = new Set<string>();
  for (const line of headerLines(file, context)) {
    const m = /^\s*Imports\s+([\w.]+)\s*$/i.exec(line);
    if (m) names.add(m[1]!.split('.').pop()!.toLowerCase());
  }
  memo.set(file, names);
  return names;
}

const VB_SCOPES = new WeakMap<ResolutionContext, WeakMap<UnresolvedRef, Set<string> | null>>();

/** The lowercased names of the types around a call and of the project types they inherit; null outside any type. */
function scopeOwners(ref: UnresolvedRef, context: ResolutionContext): Set<string> | null {
  let memo = VB_SCOPES.get(context);
  if (!memo) VB_SCOPES.set(context, (memo = new WeakMap()));
  const hit = memo.get(ref);
  if (hit !== undefined) return hit;
  const around = typesAround(ref.filePath, ref.line, context);
  const owners = around.length === 0 ? null
    : new Set(around.flatMap((t) => hierarchy(t, context)).map((t) => t.name.toLowerCase()));
  memo.set(ref, owners);
  return owners;
}

/**
 * Whether an unqualified VB.NET type name can mean `n`: a type nested in a
 * class, structure or interface is named bare only inside it or a type
 * deriving from it — designer code's `New Point(4, 285)` is not staxrip's
 * nested `ButtonEx.SymbolDrawer.Point`. A `Module`'s types belong to its
 * namespace; a file can import the outer type, or alias the nested one
 * (`Imports UserMediaD = SCrawler.DownloadObjects.TDownloader.UserMediaD`).
 * Not judged when no type is around the name.
 */
export function isVbNestedTypeInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.language !== 'vbnet' || !VB_TYPE_LIKE_KINDS.has(n.kind)) return true;
  const parent = enclosingType(n, context);
  if (!parent) return true;
  const owners = scopeOwners(ref, context);
  if (owners === null || owners.has(parent.name.toLowerCase())) return true;
  const alias = importAliases(ref.filePath, context).get(ref.referenceName.toLowerCase());
  if (alias && alias.name.toLowerCase() === n.name.toLowerCase() &&
      (!alias.qualifier || endsWith(fullSegments(n, context).slice(0, -1), alias.qualifier))) return true;
  return importedNames(ref.filePath, context).has(parent.name.toLowerCase());
}

/**
 * Whether a receiver-less VB.NET call (or one through `Me` / `MyClass` /
 * `MyBase`) can mean member `n`: one of a type around the call or of a type
 * those inherit, of a `Module`, or of a type the file imports. Not judged
 * when no type is around the call, or `n` is not a member of a type.
 */
export function isVbMemberInScope(n: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (n.language !== 'vbnet' || !VB_MEMBER_KINDS.has(n.kind)) return true;
  const cut = n.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const owners = scopeOwners(ref, context);
  if (owners === null) return true;
  const ownerQn = n.qualifiedName.slice(0, cut);
  const owner = ownerQn.split(/::|\./).pop()!.toLowerCase();
  return owners.has(owner) || isModule(ownerQn, context) || importedNames(ref.filePath, context).has(owner);
}

/**
 * Drop this module's per-context memos — file lines and what was read from
 * them — with the resolver's own caches (ReferenceResolver.clearCaches), so a
 * sync never reads a changed file's old declarations.
 */
export function clearVbnetReceiverMemos(context: ResolutionContext): void {
  for (const memo of [VB_CODE_LINES, VB_WORD_LINES, VB_BINDINGS, VB_FILE_TYPES, VB_FILE_QNS, VB_MEMBERS, VB_MODULES, VB_SUPERS, VB_ANCESTRIES,
    VB_PROJECTS, VB_PROJECT_INFO, VB_FILE_IMPORTS, VB_ALIASES, VB_BASE_NAMES, VB_TYPE_PARAMS, VB_EXTENSIONS, VB_TYPE_IMPORTS,
    VB_SCOPES] as Array<WeakMap<ResolutionContext, unknown>>) {
    memo.delete(context);
  }
}
