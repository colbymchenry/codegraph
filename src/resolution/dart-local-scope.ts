/**
 * A name a Dart function, closure or block around a call declares — a
 * parameter, a local variable, a loop or `catch` variable, a pattern
 * variable — is what a bare call of that name means there.
 *
 * riverpod's `overrideWith(CreatedT Function(Ref ref, ArgT arg) create)` calls
 * its parameter, `create(ref, arg)`, and so do its tests' provider factories
 * (`(create, {name, dependencies}) => …`). The index holds no node for any of
 * those, so the name matcher handed 48 such calls to the one top-level
 * `create` it knew: a docs example's `final create = Mutation<…>()` that none
 * of the callers import. A parameter hides a member as well: a bloc event
 * handler's `emit(…)` calls its `Emitter` parameter, never `Bloc.emit`. The
 * same holds for a function passed by name. Read from the source of the
 * call's file:
 *
 * - a parameter list that a body follows (`{ … }` or `=> …`), the body being
 *   its scope: a function's, a method's, a closure's, a `catch` clause's, a
 *   constructor's (its initializer list too);
 * - the variables a `for` head declares, for the loop;
 * - a local a block declares (`final x = …`, `Foo? x;`, `var (a, b) = …`, a
 *   pattern's `final x`), from there to the block's end.
 *
 * Fields and top-level variables are not locals. The nearest binding around
 * the call decides: a local function declared there is a node, and the call
 * keeps the one it resolved to.
 */
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** Where a name is bound: offsets into the file's source, inclusive. */
interface Scope {
  start: number;
  end: number;
  /** A local function's name, which a call can reach. */
  fn?: boolean;
}

interface DartFileScopes {
  lineStarts: number[];
  /** Name → the scopes it is bound in. */
  names: Map<string, Scope[]>;
}

const memos = new WeakMap<ResolutionContext, Map<string, DartFileScopes | null>>();

/** Drop the memos (see ReferenceResolver.clearCaches). */
export function clearDartLocalScopeMemos(context: ResolutionContext): void {
  memos.delete(context);
}

/**
 * The resolved reference, or null when it is a receiver-less Dart call (or a
 * function passed by name) whose name a parameter or local around it binds.
 */
export function gateDartLocal(resolved: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!resolved || ref.language !== 'dart') return resolved;
  if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'function_ref') return resolved;
  const name = ref.referenceName;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return resolved;
  const file = fileScopes(ref.filePath, context);
  const bound = file?.names.get(name);
  if (!file || !bound) return resolved;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n');
  const line = lines?.[ref.line - 1];
  if (line === undefined) return resolved;
  const column = nameColumn(line, name, ref.column);
  // `this.create()`, `x.create()`, `..create()` — the dot maybe ending the
  // line before: a member, whatever the locals are.
  const before = line.slice(0, column);
  if (column < 0 || /\.\s*$/.test(before) ||
      (before.trim() === '' && /\.\s*$/.test((lines![ref.line - 2] ?? '').replace(/\/\/.*$/, '')))) return resolved;
  const at = (file.lineStarts[ref.line - 1] ?? 0) + column;
  // Scopes nest, so the binding that starts last is the nearest one.
  let nearest: Scope | null = null;
  for (const scope of bound) {
    if (at >= scope.start && at <= scope.end && (!nearest || scope.start > nearest.start)) nearest = scope;
  }
  return !nearest || nearest.fn ? resolved : null;
}

/**
 * Whether a parameter, local or local function `name` is bound at offset `at`
 * of the file's source — where it hides a library name, an import prefix
 * among them: `http.get(…)` with a parameter `http` calls the parameter's.
 */
export function isDartLocallyBound(filePath: string, name: string, at: number, context: ResolutionContext): boolean {
  const bound = fileScopes(filePath, context)?.names.get(name);
  return bound !== undefined && bound.some((scope) => at >= scope.start && at <= scope.end);
}

/**
 * Where on its line a reference's name starts. A Dart ref's column sits just
 * past the name (a function value's at it); a column counted in bytes misses
 * on a line with non-ASCII text before it, so the nearest whole-word
 * occurrence is taken then.
 */
function nameColumn(line: string, name: string, column: number): number {
  const isWord = (at: number): boolean =>
    line.startsWith(name, at) && !/[\w$]/.test(line[at - 1] ?? '') && !/[\w$]/.test(line[at + name.length] ?? '');
  if (column >= 0 && isWord(column)) return column;
  if (column >= name.length && isWord(column - name.length)) return column - name.length;
  let best = -1;
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    if (isWord(at) && (best < 0 || Math.abs(at - column) < Math.abs(best - column))) best = at;
  }
  return best;
}

function fileScopes(filePath: string, context: ResolutionContext): DartFileScopes | null {
  let memo = memos.get(context);
  if (!memo) {
    memo = new Map();
    memos.set(context, memo);
  }
  const hit = memo.get(filePath);
  if (hit !== undefined) return hit;
  const source = context.readFile(filePath);
  const scopes = source === null ? null : readScopes(source);
  memo.set(filePath, scopes);
  return scopes;
}

/** Every parameter, loop variable and local a Dart file binds, with its scope. */
function readScopes(source: string): DartFileScopes {
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const code = blankTypeArguments(blankDartLiterals(source));
  const brackets = matchBrackets(code);
  const names = new Map<string, Scope[]>();
  const bind = (name: string, start: number, end: number, fn = false): void => {
    if (name === '_' || DART_RESERVED.has(name)) return;
    const scope: Scope = fn ? { start, end, fn } : { start, end };
    const list = names.get(name);
    if (list) list.push(scope);
    else names.set(name, [scope]);
  };
  const parameterLists = bindParameters(code, brackets, bind);
  bindLocals(code, brackets, parameterLists, bind);
  return { lineStarts, names };
}

type Bind = (name: string, start: number, end: number, fn?: boolean) => void;

/**
 * Each parameter list a body follows, the body being where its names are
 * bound — and a `for` head's variables, for the loop. A group a control-flow
 * keyword heads (`if (create) {`) holds an expression, and a call's arguments
 * (`: super(x) {`, `: _f = make(x) {` in an initializer list) bind nothing.
 * A function declared in a block binds its own name there, to the block's end.
 * Returns the offsets of the groups read as parameter lists.
 */
function bindParameters(code: string, b: Brackets, bind: Bind): Set<number> {
  const lists = new Set<number>();
  for (let k = 0; k < b.at.length; k++) {
    const open = b.partner[k]!;
    if (code[b.at[k]!] !== ')' || open < 0) continue;
    const from = b.at[open]!;
    const head = tokenBefore(code, from);
    let i = skipSpace(code, b.at[k]! + 1);
    const modifier = /^(?:async\s*\*?|sync\s*\*)/.exec(code.slice(i, i + 8));
    if (modifier) i = skipSpace(code, i + modifier[0].length);
    const list = code.slice(from + 1, b.at[k]!);
    const block = code[i] === '{' && b.at[k + 1] === i && b.partner[k + 1]! >= 0 ? b.at[b.partner[k + 1]!]! : -1;
    if (head.word === 'for') {
      const end = block >= 0 ? block : endOfStatement(code, b, i, false);
      for (const name of forHeadNames(list)) bind(name, from, end);
      lists.add(from);
      continue;
    }
    if (head.word !== null && CONTROL_HEADS.has(head.word)) continue;
    let scope: Scope | null = null;
    if (block >= 0) scope = { start: i, end: block };
    else if (code.startsWith('=>', i)) scope = { start: i, end: endOfStatement(code, b, i + 2, true) };
    else if (code[i] === ':' && isConstructorHead(code, head)) scope = { start: i, end: endOfConstructor(code, b, i + 1) };
    if (!scope || isCallArguments(code, head)) continue;
    lists.add(from);
    for (const name of parameterNames(list)) bind(name, scope.start, scope.end);
    // `int make() => 2;` in a block: a local function, a node of its own.
    const around = head.word !== null && !DART_KEYWORDS.has(head.word) ? enclosingBlock(code, b, head.at) : -1;
    if (around >= 0) bind(head.word!, head.at, blockEnd(code, b, around), true);
  }
  return lists;
}

/**
 * Whether a group is a call's arguments rather than a declaration's
 * parameters: a call in a constructor's initializer list (`: _value =
 * compute(x) {`, `: super.named(x) {`, `: assert(x) {`).
 */
function isCallArguments(code: string, head: { word: string | null; at: number }): boolean {
  if (head.word === null) return false;
  if (head.word === 'super' || head.word === 'this' || head.word === 'assert') return true;
  const before = tokenBefore(code, head.at);
  if (before.word === null && /^[=:,]$/.test(code[before.at] ?? '')) return true;
  // `super.named(x)` / `this.named(x)`, never a named constructor `Foo.named(x)`.
  if (before.word === null && code[before.at] === '.') {
    const owner = tokenBefore(code, before.at);
    return owner.word === 'super' || owner.word === 'this';
  }
  return false;
}

/**
 * Whether a group followed by `:` is a constructor's parameter list —
 * `Foo(this.x) :`, `const Foo.named(int x) :` at the start of a member — and
 * not a call in a conditional (`c ? f(x) : y`) or a `case Foo(x):`.
 */
function isConstructorHead(code: string, head: { word: string | null; at: number }): boolean {
  if (head.word === null || DART_KEYWORDS.has(head.word)) return false;
  let type = head.word;
  let before = tokenBefore(code, head.at);
  if (before.word === null && code[before.at] === '.') {
    const owner = tokenBefore(code, before.at);
    if (owner.word === null) return false;
    type = owner.word;
    before = tokenBefore(code, owner.at);
  }
  if (!/^_*[A-Z$]/.test(type)) return false;
  if (before.word !== null) return before.word === 'const' || before.word === 'external';
  return before.at < 0 || /^[;{}]$/.test(code[before.at] ?? '');
}

/**
 * The end of a constructor's initializer list and body, from just past its
 * `:` — the body being the first `{` that does not start a value (`: _m = {}`).
 */
function endOfConstructor(code: string, b: Brackets, from: number): number {
  let k = firstBracketFrom(b, from);
  let pos = from;
  for (;;) {
    const next = k < b.at.length ? b.at[k]! : code.length;
    const semicolon = code.indexOf(';', pos);
    if (semicolon >= 0 && semicolon < next) return semicolon;
    if (k >= b.at.length) return code.length;
    const ch = code[next];
    if (ch === ')' || ch === ']' || ch === '}') return next;
    const close = b.partner[k]!;
    if (close < 0) return code.length;
    if (ch === '{') {
      const prior = tokenBefore(code, next);
      if (prior.word !== null || /[)\]'"]/.test(code[prior.at] ?? '')) return b.at[close]!;
    }
    pos = b.at[close]! + 1;
    k = close + 1;
  }
}

/**
 * The names a parameter list declares: `(Ref ref, {required this.create,
 * int count = 0})`, `([String? label])`, old-style `void cb(int x)` (`cb`),
 * untyped closure parameters `(create, {name})`, and a switch arm's pattern
 * `Foo(:final value) =>`.
 */
function parameterNames(list: string): string[] {
  const names: string[] = [];
  for (const raw of splitParameters(list)) {
    let item = raw.replace(/@[\w$.]+(?:\s*\([^()]*\))?/g, ' ');
    const eq = item.indexOf('=');
    if (eq >= 0) item = item.slice(0, eq);
    item = item.trimEnd();
    // `void cb(int x)`: the name is before its own parameter list.
    if (item.endsWith(')')) {
      let depth = 0;
      let at = item.length - 1;
      for (; at >= 0; at--) {
        if (item[at] === ')') depth++;
        else if (item[at] === '(' && --depth === 0) break;
      }
      item = item.slice(0, Math.max(0, at)).trimEnd();
    }
    const name = /([A-Za-z_$][\w$]*)$/.exec(item)?.[1];
    if (name) names.push(name);
  }
  return names;
}

/** A parameter list's items, the optional group's (`{…}` / `[…]`, always last) included. */
function splitParameters(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let item = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (depth === 0 && (ch === '{' || ch === '[') && item.trim() === '') {
      const close = list.lastIndexOf(ch === '{' ? '}' : ']');
      items.push(...splitParameters(list.slice(i + 1, close > i ? close : list.length)));
      return items;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      if (item.trim() !== '') items.push(item);
      item = '';
    } else {
      item += ch;
    }
  }
  if (item.trim() !== '') items.push(item);
  return items;
}

/** The variables a `for` head declares: `final x in xs`, `var (a, b) in pairs`, `var i = 0, j = n; …`. */
function forHeadNames(head: string): string[] {
  const loop = /^([^;]*?)\bin\b/.exec(head);
  if (loop) {
    const decl = loop[1]!.trim();
    const pattern = /^(?:final|var)\s*(?:[\w$.]+\s*)?([([{][\s\S]*)$/.exec(decl);
    if (pattern) return patternBinders(pattern[1]!);
    const declared = /^(?:(?:final|var|const)\s+(?:[\w$.]+\s*\??\s+)?|[\w$.]+\s*\??\s+)([A-Za-z_$][\w$]*)$/.exec(decl);
    return declared ? [declared[1]!] : [];
  }
  const init = head.split(';')[0] ?? '';
  if (!/^\s*(?:(?:final|var|const|late)\b|[\w$.]+\s*\??\s+[A-Za-z_$][\w$]*\s*=)/.test(init)) return [];
  return [...init.matchAll(/(?:^|,|\s)([A-Za-z_$][\w$]*)\s*=(?![=>])/g)].map((m) => m[1]!);
}

/** The names a destructuring pattern binds: `(a, b)`, `[x, ...rest]`, `Point(:x, y: final py)`, `{'k': v}`. */
function patternBinders(pattern: string): string[] {
  const names: string[] = [];
  for (const m of pattern.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*[:(])(?!\s+[A-Za-z_$(])/g)) {
    if (m[1] !== '_' && !DART_RESERVED.has(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/**
 * The locals a block declares, each bound from its declaration to the
 * block's end: `final x = …`, `var x;`, `Foo<T>? x = …`, `void Function() x
 * = …`, `final (a, b) = …`, and a pattern's `final x` / `var x` (`case
 * Foo(:final x)`, `if (v case final x?)`). A declaration directly in a class
 * body is a field, and one at the top of the file a library variable.
 */
function bindLocals(code: string, b: Brackets, parameterLists: Set<number>, bind: Bind): void {
  // `direct`: a statement's own declaration, whose block is the bracket right
  // around it; a pattern's variable is in the block around its `case` or `if`.
  const bindInBlock = (name: string, at: number, direct: boolean): void => {
    let k = innermostBracket(code, b, at);
    while (!direct && k >= 0 && code[b.at[k]!] !== '{') {
      // A parameter list's `final x` is the parameter, bound where the list is read.
      if (parameterLists.has(b.at[k]!)) return;
      k = b.parent[k]!;
    }
    if (k >= 0 && code[b.at[k]!] === '{' && !isTypeBody(code, b.at[k]!)) bind(name, at, blockEnd(code, b, k));
  };
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?=\s*(?:=(?![=>])|;))/g)) {
    if (isDeclarationType(code, b, tokenBefore(code, m.index))) bindInBlock(m[1]!, m.index, true);
  }
  // A pattern variable: `case Foo(:final value)`, `if (x case final y?)` —
  // not the type of `final Foo? x = …`.
  for (const m of code.matchAll(/(?<![\w$.])(?:final|var)\s+(?:[\w$.]+\s*\??\s+)?([A-Za-z_$][\w$]*)(?=\s*(?:[)\]},:]|\?(?!\s*[\w$])|=>|\bwhen\b|&&|\|\|))/g)) {
    bindInBlock(m[1]!, m.index, false);
  }
  // A destructuring declaration: `final (a, b) = …`, `var Point(:x, :y) = …`.
  for (const m of code.matchAll(/(?<![\w$.])(?:final|var)\s*(?:[A-Z][\w$]*\s*)?([([{])/g)) {
    const open = m.index + m[0].length - 1;
    const k = bracketIndexAt(b, open);
    if (k < 0 || b.partner[k]! < 0) continue;
    const close = b.at[b.partner[k]!]!;
    if (!/^\s*=(?![=>])/.test(code.slice(close + 1, close + 4))) continue;
    for (const name of patternBinders(code.slice(open + 1, close))) bindInBlock(name, m.index, true);
  }
}

/**
 * Whether the token before a name followed by `=` / `;` makes it a
 * declaration: `final` / `var` / `const`, a type (`Foo`, `Foo?`, `List<int>`
 * — type arguments are blanked — or a function type ending `Function(…)`).
 */
function isDeclarationType(code: string, b: Brackets, before: { word: string | null; at: number }): boolean {
  if (before.word !== null) return DECLARATION_KEYWORDS.has(before.word) || !DART_KEYWORDS.has(before.word);
  const ch = code[before.at];
  if (ch === '?') return /[\w$)]/.test(code[before.at - 1] ?? '');
  if (ch === ')') {
    const k = bracketIndexAt(b, before.at);
    const open = k >= 0 ? b.partner[k]! : -1;
    return open >= 0 && tokenBefore(code, b.at[open]!).word === 'Function';
  }
  return false;
}

/** Whether the `{` at `brace` opens a class, mixin, enum or extension body. */
function isTypeBody(code: string, brace: number): boolean {
  const from = Math.max(code.lastIndexOf(';', brace - 1), code.lastIndexOf('{', brace - 1), code.lastIndexOf('}', brace - 1));
  return TYPE_BODY_HEAD.test(code.slice(from + 1, brace));
}

const TYPE_BODY_HEAD = /^\s*(?:@[\w$.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)*(?:(?:abstract|base|final|sealed|interface|mixin|augment)\s+)*(?:class|mixin|enum|extension)\b/;

/** The index of the `{` right around offset `at` when it holds statements (no class or extension body), or -1. */
function enclosingBlock(code: string, b: Brackets, at: number): number {
  const k = innermostBracket(code, b, at);
  return k >= 0 && code[b.at[k]!] === '{' && !isTypeBody(code, b.at[k]!) ? k : -1;
}

/** Where the bracket at index `k` closes: the end of the file when it never does. */
function blockEnd(code: string, b: Brackets, k: number): number {
  return b.partner[k]! >= 0 ? b.at[b.partner[k]!]! : code.length;
}

/**
 * Where the expression or statement starting at `from` ends: the first `;`
 * (and, for an expression, `,`) outside the brackets it opens, or the close
 * of the bracket around it — the end of a `=> …` body in an argument list,
 * a switch arm or a declaration.
 */
function endOfStatement(code: string, b: Brackets, from: number, expression: boolean): number {
  let k = firstBracketFrom(b, from);
  let pos = from;
  for (;;) {
    const next = k < b.at.length ? b.at[k]! : code.length;
    for (let i = pos; i < next; i++) {
      if (code[i] === ';' || (expression && code[i] === ',')) return i;
    }
    if (k >= b.at.length) return code.length;
    const ch = code[next];
    if (ch === ')' || ch === ']' || ch === '}') return next;
    const close = b.partner[k]!;
    if (close < 0) return code.length;
    pos = b.at[close]! + 1;
    k = close + 1;
  }
}

/** The word right before offset `at` (skipping blanks), or else the offset of the character there (-1 at the start). */
function tokenBefore(code: string, at: number): { word: string | null; at: number } {
  let i = at - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  let start = i;
  while (start >= 0 && /[\w$]/.test(code[start]!)) start--;
  if (start === i) return { word: null, at: i };
  return { word: code.slice(start + 1, i + 1), at: start + 1 };
}

function skipSpace(code: string, at: number): number {
  while (at < code.length && /\s/.test(code[at]!)) at++;
  return at;
}

/** Keywords that head a parenthesised expression, not a parameter list. */
const CONTROL_HEADS: ReadonlySet<string> = new Set(['if', 'while', 'switch']);

/** Keywords a declaration's name can follow. */
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(['final', 'var', 'const']);

/** Dart's reserved words: never a name a declaration binds. */
const DART_RESERVED: ReadonlySet<string> = new Set([
  'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends',
  'false', 'final', 'finally', 'for', 'if', 'in', 'is', 'new', 'null', 'rethrow', 'return', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with',
]);

/**
 * The reserved words and the built-in and contextual ones that never name a
 * declaration's type or a function there. Several are fine parameter names —
 * json_generator's `R Function(DartType item) set` — so only DART_RESERVED
 * keeps a name from binding.
 */
const DART_KEYWORDS: ReadonlySet<string> = new Set([
  ...DART_RESERVED,
  'abstract', 'as', 'async', 'await', 'base', 'covariant', 'deferred', 'export', 'extension', 'external', 'factory',
  'get', 'hide', 'implements', 'import', 'interface', 'late', 'library', 'mixin', 'of', 'on', 'operator', 'part',
  'required', 'sealed', 'set', 'show', 'static', 'sync', 'typedef', 'when', 'yield',
]);

// ---------------------------------------------------------------- brackets

interface Brackets {
  /** The offset of every bracket character, in order. */
  at: number[];
  /** For each bracket, the index of its partner, or -1. */
  partner: number[];
  /** For each bracket, the index of the open bracket around it, or -1. */
  parent: number[];
}

/** Pairs `()`, `[]` and `{}`; a stray close is left unpaired, and so are the opens a close skips past. */
function matchBrackets(code: string): Brackets {
  const at: number[] = [];
  const partner: number[] = [];
  const parent: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      at.push(i);
      partner.push(-1);
      parent.push(stack.length > 0 ? stack[stack.length - 1]! : -1);
      stack.push(at.length - 1);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const want = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      let s = stack.length - 1;
      while (s >= 0 && code[at[stack[s]!]!] !== want) s--;
      at.push(i);
      partner.push(-1);
      if (s < 0) {
        parent.push(stack.length > 0 ? stack[stack.length - 1]! : -1);
        continue;
      }
      const open = stack[s]!;
      stack.length = s;
      partner[open] = at.length - 1;
      partner[at.length - 1] = open;
      parent.push(parent[open]!);
    }
  }
  return { at, partner, parent };
}

/** The index of the first bracket at or after offset `from`. */
function firstBracketFrom(b: Brackets, from: number): number {
  let lo = 0;
  let hi = b.at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b.at[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The index of the bracket at offset `at`, or -1. */
function bracketIndexAt(b: Brackets, at: number): number {
  const k = firstBracketFrom(b, at);
  return b.at[k] === at ? k : -1;
}

/** The index of the innermost open bracket around offset `at`, or -1. */
function innermostBracket(code: string, b: Brackets, at: number): number {
  const k = firstBracketFrom(b, at) - 1;
  if (k < 0) return -1;
  const ch = code[b.at[k]!];
  return ch === '(' || ch === '[' || ch === '{' ? k : b.parent[k]!;
}

// ---------------------------------------------------------------- lexing

/**
 * The source with comments and the text of string literals blanked to
 * spaces (offsets and newlines kept). Code inside a `${…}` interpolation
 * stays, minus the braces that delimit it; block comments nest, and raw
 * strings (`r'…'`) have no escapes or interpolation.
 */
function blankDartLiterals(source: string): string {
  const out = source.split('');
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (source[k] !== '\n' && source[k] !== '\r') out[k] = ' ';
  };
  // The strings an interpolation was opened from, innermost last, with the brace depth inside it.
  const suspended: Array<{ quote: string; braces: number }> = [];
  let quote: string | null = null;
  let raw = false;
  let i = 0;
  while (i < n) {
    if (quote !== null) {
      if (source.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
        continue;
      }
      const ch = source[i]!;
      if (!raw && ch === '\\') {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (!raw && ch === '$' && source[i + 1] === '{') {
        blank(i, i + 2);
        suspended.push({ quote, braces: 0 });
        quote = null;
        i += 2;
        continue;
      }
      // A single-quoted string ends at the line's end however it was left.
      if (quote.length === 1 && ch === '\n') {
        quote = null;
        i++;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (source[j] === '*' && source[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (suspended.length > 0 && (ch === '{' || ch === '}')) {
      const top = suspended[suspended.length - 1]!;
      if (ch === '{') top.braces++;
      else if (top.braces > 0) top.braces--;
      else {
        blank(i, i + 1);
        suspended.pop();
        quote = top.quote;
        raw = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      raw = source[i - 1] === 'r' && !/[\w$]/.test(source[i - 2] ?? '');
      quote = source[i + 1] === ch && source[i + 2] === ch ? ch.repeat(3) : ch;
      i += quote.length;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * The code with type-argument lists blanked — `Map<String, int>`, `<T>(x) =>`,
 * `<int>[]` — so their commas never end an argument and their angle brackets
 * never read as comparisons. A `<` opens one when it follows a name with no
 * space (`List<int>`), or when what it closes is followed by `(`, `[`, `{` or
 * `.` (a generic function or a typed literal), and everything inside is type
 * syntax.
 */
function blankTypeArguments(code: string): string {
  if (!code.includes('<')) return code;
  const out = code.split('');
  let i = code.indexOf('<');
  while (i >= 0) {
    const end = typeArgumentsEnd(code, i);
    if (end > i) {
      const glued = /[\w$]/.test(code[i - 1] ?? '');
      const next = code[skipSpace(code, end + 1)] ?? '';
      if (glued || next === '(' || next === '[' || next === '{' || next === '.') {
        for (let k = i; k <= end; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
        i = code.indexOf('<', end + 1);
        continue;
      }
    }
    i = code.indexOf('<', i + 1);
  }
  return out.join('');
}

/** The offset of the `>` closing a type-argument list opened at `open`, or -1 if what follows is not one. */
function typeArgumentsEnd(code: string, open: number): number {
  let angles = 0;
  let parens = 0;
  for (let i = open; i < code.length && i < open + 400; i++) {
    const ch = code[i]!;
    if (ch === '<') angles++;
    else if (ch === '>') {
      if (code[i - 1] === '=') return -1;
      if (--angles === 0) return parens === 0 ? i : -1;
    } else if (ch === '(' || ch === '{') parens++;
    else if (ch === ')' || ch === '}') {
      if (--parens < 0) return -1;
    } else if (!/[\w$\s.,?]/.test(ch)) return -1;
  }
  return -1;
}
