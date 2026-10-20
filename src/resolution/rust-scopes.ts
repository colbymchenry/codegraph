/**
 * A Rust file's local bindings, read from its text, for typing the receiver
 * of a method call (matchRustTypedReceiverCall in name-matcher.ts): every
 * parameter of a function or a closure, `let`, `if let` / `while let`,
 * `let … else`, `for` and match-arm binding, where it is visible, and what
 * the source writes of its type there.
 *
 * A reader, not a parser. Comments and the contents of strings and
 * characters are blanked first (offsets and newlines kept), brackets are
 * paired, and each form is read from its keyword. A name a pattern may bind
 * is bound, typed or not, so that it hides the declarations around it rather
 * than taking their type: `fn f(srv: Server) { if let Some(srv) = spare() {
 * srv.run() } }` calls `run` on what `spare()` holds, not on a `Server`.
 */

/** Where a name sits in a tuple-struct, variant or struct pattern: `Commands::Build(opts)`, `Point { x, .. }`. */
export interface RustPatternSite {
  /** The pattern's path as written: `Commands::Build`, `Self::Text`, `Some`; '' for a tuple's own `(a, b)`. */
  path: string;
  /** The name's position among a tuple pattern's fields. */
  index?: number;
  /** The field a struct pattern binds the name from. */
  field?: string;
}

export interface RustBinding {
  /** Offset of the bound name. */
  at: number;
  kind: 'param' | 'closure' | 'let' | 'cond' | 'for' | 'arm';
  /** Where the name is visible: from `from` up to, not including, `to`. */
  from: number;
  to: number;
  /** The type written for it — a parameter's or a `let`'s — when its pattern is the name alone. */
  type?: string;
  /** A `let`'s value, when its pattern is the name alone and it writes no type. */
  init?: string;
  /** The pattern around the name, when it is bound inside a tuple-struct, variant or struct pattern. */
  site?: RustPatternSite;
  /** What an `if let`, `while let`, `let … else` or `match` pattern is matched against, or what a `for` iterates. */
  scrutinee?: string;
}

/** A function with a body: its generic parameters and `where` clause, and the span its parameters are bound in. */
export interface RustFn {
  /** Offset of the `fn` keyword. */
  at: number;
  /** The text between its generic parameters' brackets ('' for none). */
  generics: string;
  /** Its `where` clause's text after `where` ('' for none). */
  where: string;
  /** From its parameter list's `(` to its body's `}`. */
  from: number;
  to: number;
  /** Its parameter list's `)`, and its body's `{`. */
  paramsEnd: number;
  body: number;
}

/** An `impl` or `trait` block: its generic parameters and `where` clause, and its body. */
export interface RustImplBlock {
  /** Offset of the keyword. */
  at: number;
  kind: 'impl' | 'trait';
  generics: string;
  where: string;
  /** Its body, from `{` to `}`. */
  from: number;
  to: number;
}

export interface RustScopes {
  /** The source with its comments and the contents of its strings and characters blanked. */
  code: string;
  lineStarts: number[];
  fns: RustFn[];
  impls: RustImplBlock[];
  /** Each `(`, `[` and `{` → the bracket closing it. */
  close: Map<number, number>;
  /** Offsets of every `{` and `}`, with the innermost block open after each (rustInnerBlockAt). */
  events: number[];
  openAfter: number[];
  /** The names bound in the file, read on the first lookup (rustBindingAt). */
  bindings: Map<string, RustBinding[]> | null;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && (IDENT_CHAR.test(c) || c.charCodeAt(0) > 127);
}

/**
 * Rust source with its comments, and the contents of its strings, raw
 * strings and character literals, blanked: offsets and newlines stay, so an
 * offset still maps to its line and column. A lifetime (`'a`) is no
 * character literal.
 */
export function blankRustCode(src: string): string {
  const n = src.length;
  const parts: string[] = [];
  let last = 0;
  // `src[from, to)` as spaces, its newlines kept; the text before it as it is.
  const blank = (from: number, to: number): void => {
    if (to <= from) return;
    parts.push(src.slice(last, from));
    const chunk = src.slice(from, to);
    parts.push(chunk.includes('\n') ? chunk.replace(/[^\n]/g, ' ') : ' '.repeat(to - from));
    last = to;
  };
  const special = /[/"']/g;
  for (let m = special.exec(src); m; m = special.exec(src)) {
    const i = m.index;
    const c = src[i];
    const d = src[i + 1];
    if (c === '/') {
      if (d === '/') {
        const end = src.indexOf('\n', i);
        const to = end < 0 ? n : end;
        blank(i, to);
        special.lastIndex = to;
      } else if (d === '*') {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
          else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
          else j++;
        }
        blank(i, j);
        special.lastIndex = j;
      }
      continue;
    }
    if (c === '"') {
      // A raw string: `r"…"`, `r#"…"#`, also after a `b` or `c` prefix —
      // the `r` no end of a longer name.
      let k = i - 1;
      while (k >= 0 && src[k] === '#') k--;
      let p = k - 1;
      if (src[p] === 'b' || src[p] === 'c') p--;
      if (src[k] === 'r' && (p < 0 || !isIdentChar(src[p]))) {
        const close = `"${'#'.repeat(i - 1 - k)}`;
        const end = src.indexOf(close, i + 1);
        const to = end < 0 ? n : end;
        blank(i + 1, to);
        special.lastIndex = Math.min(n, to + close.length);
        continue;
      }
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      special.lastIndex = Math.min(n, j + 1);
      continue;
    }
    // `'\n'`, `'\u{1F600}'`; `'x'`; a character outside the BMP; else a lifetime or a label.
    if (d === '\\') {
      const end = src.indexOf('\'', i + 3);
      if (end > 0 && end - i <= 12) {
        blank(i + 1, end);
        special.lastIndex = end + 1;
      }
    } else if (src[i + 2] === '\'' && d !== undefined && d !== '\n') {
      blank(i + 1, i + 2);
      special.lastIndex = i + 3;
    } else if (d !== undefined && /[\uD800-\uDBFF]/.test(d) && src[i + 3] === '\'') {
      blank(i + 1, i + 3);
      special.lastIndex = i + 4;
    }
  }
  parts.push(src.slice(last));
  return parts.join('');
}

/** Each `(`, `[` and `{` → the offset of the bracket closing it. */
function pairBrackets(code: string): Map<number, number> {
  const close = new Map<number, number>();
  const stack: number[] = [];
  const brackets = /[()[\]{}]/g;
  for (let m = brackets.exec(code); m; m = brackets.exec(code)) {
    const i = m.index;
    const c = code[i]!;
    if (c === '(' || c === '[' || c === '{') {
      stack.push(i);
      continue;
    }
    const want = c === ')' ? '(' : c === ']' ? '[' : '{';
    // A stray closer (a macro's unbalanced tokens) closes nothing.
    if (stack.length > 0 && code[stack[stack.length - 1]!] === want) close.set(stack.pop()!, i);
  }
  return close;
}

function skipSpace(code: string, at: number): number {
  for (let c = code.charCodeAt(at); c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 11; c = code.charCodeAt(++at));
  return at;
}

/** The identifier starting at `at`, if one does. */
const IDENT_AT = /[A-Za-z_]\w*/y;
function identAt(code: string, at: number): string | null {
  IDENT_AT.lastIndex = at;
  return IDENT_AT.exec(code)?.[0] ?? null;
}

/** The offset of the `>` closing the `<` at `at`, or -1. `->` and `=>` close nothing. */
function angleClose(code: string, at: number, limit = code.length): number {
  let depth = 0;
  for (let i = at; i < limit; i++) {
    const c = code[i];
    if (c === '<') depth++;
    else if (c === '>' && code[i - 1] !== '-' && code[i - 1] !== '=') {
      if (--depth === 0) return i;
    } else if (c === ';' || c === '{' || c === '}') return -1;
  }
  return -1;
}

/**
 * Walk `code` from `from` to `to` over what lies outside brackets: `stop`
 * sees each such offset — a bracket opening a group too — and a true return
 * ends the walk there; past it, a `(`, `[` or `{` group is jumped over
 * whole, and with `angles` so is a `<…>` one. Returns that offset, or `to`.
 */
function walkTop(code: string, from: number, to: number, close: Map<number, number>, angles: boolean, stop: (i: number) => boolean): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = code[i]!;
    if (depth === 0 && stop(i)) return i;
    if (c === '(' || c === '[' || c === '{') {
      const end = close.get(i);
      if (end === undefined || end >= to) return to;
      i = end;
      continue;
    }
    if (angles && c === '<') depth++;
    else if (angles && c === '>' && code[i - 1] !== '-' && code[i - 1] !== '=' && depth > 0) depth--;
  }
  return to;
}

/** The spans of `code` between `from` and `to` that top-level commas part. */
function splitTop(code: string, from: number, to: number, close: Map<number, number>, angles: boolean): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let start = from;
  for (;;) {
    const comma = walkTop(code, start, to, close, angles, (i) => code[i] === ',');
    if (comma >= to) break;
    parts.push([start, comma]);
    start = comma + 1;
  }
  if (code.slice(start, to).trim() !== '') parts.push([start, to]);
  return parts;
}

/** A top-level `:` that is no part of a `::`, between `from` and `to`; -1 for none. */
function topColon(code: string, from: number, to: number, close: Map<number, number>): number {
  const at = walkTop(code, from, to, close, true, (i) => code[i] === ':' && code[i + 1] !== ':' && code[i - 1] !== ':');
  return at < to ? at : -1;
}

/** Whether the keyword `word` starts at `i`, a whole word. */
function wordAt(code: string, i: number, word: string): boolean {
  return code.startsWith(word, i) && !isIdentChar(code[i - 1]) && !isIdentChar(code[i + word.length]);
}

/** Words a pattern writes that bind nothing. */
const PATTERN_WORDS: ReadonlySet<string> = new Set(['ref', 'mut', 'box', 'true', 'false', 'self', 'Self', 'crate', 'super', '_']);

function isBindingName(id: string): boolean {
  return /^[a-z_][A-Za-z0-9_]*$/.test(id) && !PATTERN_WORDS.has(id);
}

/** A path at `at` — `Commands::Build`, `Self::A` — as its segments and the offset after it. */
function readPath(code: string, at: number): { segments: string[]; end: number } {
  const segments: string[] = [];
  let p = at;
  for (;;) {
    const id = identAt(code, p);
    if (!id) break;
    segments.push(id);
    p += id.length;
    let q = skipSpace(code, p);
    if (!code.startsWith('::', q)) break;
    q = skipSpace(code, q + 2);
    // A turbofish: `Foo::<T>::Bar`, `Vec::<u8>`.
    if (code[q] === '<') {
      const end = angleClose(code, q);
      if (end < 0) break;
      p = end + 1;
      q = skipSpace(code, p);
      if (!code.startsWith('::', q)) break;
      q = skipSpace(code, q + 2);
    }
    p = q;
  }
  return { segments, end: p };
}

type Emit = (name: string, at: number, site: RustPatternSite | undefined) => void;

/**
 * The names a pattern between `from` and `to` binds, each with the
 * tuple-struct, variant or struct pattern it sits in, innermost first.
 */
function walkPattern(code: string, from: number, to: number, close: Map<number, number>, site: RustPatternSite | undefined, emit: Emit): void {
  let p = from;
  while (p < to) {
    const c = code[p]!;
    if (c === '(' || c === '[') {
      // A tuple or a slice: its fields' types are not read here.
      const end = Math.min(close.get(p) ?? to, to);
      for (const [a, b] of splitTop(code, p + 1, end, close, false)) walkPattern(code, a, b, close, undefined, emit);
      p = end + 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(c) || isIdentChar(code[p - 1])) {
      p++;
      continue;
    }
    const path = readPath(code, p);
    if (path.segments.length === 0) {
      p++;
      continue;
    }
    const after = skipSpace(code, path.end);
    const written = path.segments.join('::');
    if (code[after] === '(') {
      const end = Math.min(close.get(after) ?? to, to);
      let index = 0;
      for (const [a, b] of splitTop(code, after + 1, end, close, false)) {
        walkPattern(code, a, b, close, { path: written, index }, emit);
        index++;
      }
      p = end + 1;
      continue;
    }
    if (code[after] === '{') {
      const end = Math.min(close.get(after) ?? to, to);
      for (const [a, b] of splitTop(code, after + 1, end, close, false)) {
        const colon = topColon(code, a, b, close);
        if (colon >= 0) {
          const field = code.slice(a, colon).trim();
          if (/^\w+$/.test(field)) walkPattern(code, colon + 1, b, close, { path: written, field }, emit);
          continue;
        }
        // `name`, `ref name`, `mut name`, `ref mut name` bind the field of that name.
        const text = code.slice(a, b);
        const short = /^\s*(?:ref\s+)?(?:mut\s+)?([A-Za-z_]\w*)\s*$/.exec(text);
        if (short && isBindingName(short[1]!)) emit(short[1]!, a + text.lastIndexOf(short[1]!), { path: written, field: short[1]! });
      }
      p = end + 1;
      continue;
    }
    if (path.segments.length === 1 && isBindingName(path.segments[0]!)) emit(path.segments[0]!, p, site);
    // `name @ pattern`: the subpattern binds in its own right.
    p = code[after] === '@' ? after + 1 : path.end;
  }
}

/** The innermost `{…}` holding an offset, as [open, close]; null outside every block. */
function blockAt(events: number[], open: number[], close: Map<number, number>, codeLength: number, offset: number): [number, number] | null {
  let lo = 0;
  let hi = events.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]! < offset) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const o = at < 0 ? -1 : open[at]!;
  return o < 0 ? null : [o, close.get(o) ?? codeLength];
}

/**
 * Whether a `|` at `i` opens a closure's parameter list: it stands where an
 * expression starts — after `(`, `[`, `{`, `,`, `=`, `;`, `:`, `=>`, or
 * `move` / `return` / `async` — never after an operand, where it is an `|`
 * of bits or a pattern's alternative.
 */
function opensClosure(code: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k--;
  if (k < 0) return true;
  const c = code[k]!;
  if (c === ':') return code[k - 1] !== ':';
  if ('([{,=;'.includes(c)) return true;
  if (c === '>') return code[k - 1] === '=';
  const word = /([A-Za-z_]\w*)$/.exec(code.slice(Math.max(0, k - 8), k + 1))?.[1];
  return word === 'move' || word === 'return' || word === 'async' || word === 'static';
}

/** Where an expression starting at `from` ends: its first top-level `,` or `;`, or the bracket closing around it. */
function expressionEnd(code: string, from: number, close: Map<number, number>): number {
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if (c === '(' || c === '[' || c === '{') {
      const end = close.get(i);
      if (end === undefined) return code.length;
      i = end;
      continue;
    }
    if (c === ',' || c === ';' || c === ')' || c === ']' || c === '}') return i;
  }
  return code.length;
}

/**
 * A Rust file read for its bindings: its blanked text, its functions with
 * bodies, its `impl` and `trait` blocks. The bindings themselves are read on
 * the first lookup — most files read here are only looked into.
 */
export function readRustScopes(source: string): RustScopes {
  const code = blankRustCode(source);
  const n = code.length;
  const lineStarts = [0];
  for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const close = pairBrackets(code);

  const fns: RustFn[] = [];
  for (const m of code.matchAll(/\bfn\b/g)) {
    let p = skipSpace(code, m.index! + 2);
    const name = identAt(code, p);
    if (!name) continue;
    p = skipSpace(code, p + name.length);
    let generics = '';
    if (code[p] === '<') {
      const end = angleClose(code, p);
      if (end < 0) continue;
      generics = code.slice(p + 1, end);
      p = skipSpace(code, end + 1);
    }
    if (code[p] !== '(') continue;
    const paramsEnd = close.get(p);
    if (paramsEnd === undefined) continue;
    // The body: the first `{` past the return type and `where` clause; a `;`
    // first is a declaration, which binds nothing.
    let body = -1;
    let where = -1;
    for (let q = paramsEnd + 1; q < n; q++) {
      const c = code[q]!;
      if (c === '{') { body = q; break; }
      if (c === ';' || c === '}') break;
      if (c === '(' || c === '[') { q = close.get(q) ?? n; continue; }
      if (where < 0 && c === 'w' && wordAt(code, q, 'where')) where = q + 5;
    }
    if (body < 0) continue;
    fns.push({ at: m.index!, generics, where: where < 0 ? '' : code.slice(where, body), from: p, to: close.get(body) ?? n, paramsEnd, body });
  }

  // `impl<T: Bound> … {` and `trait Name<T>: Super where … {` — an item, not
  // the `impl Trait` of a type, which follows a `:`, `(`, `,`, `<`, `&` or `->`.
  const impls: RustImplBlock[] = [];
  for (const m of code.matchAll(/\b(impl|trait)\b/g)) {
    const kind = m[1] as 'impl' | 'trait';
    if (kind === 'impl') {
      let k = m.index! - 1;
      while (k >= 0 && /\s/.test(code[k]!)) k--;
      if (k >= 0 && !'{};]'.includes(code[k]!) && !/\b(?:unsafe|default)$/.test(code.slice(Math.max(0, k - 7), k + 1))) continue;
    }
    let p = skipSpace(code, m.index! + kind.length);
    if (kind === 'trait') {
      const name = identAt(code, p);
      if (!name) continue;
      p = skipSpace(code, p + name.length);
    }
    let generics = '';
    if (code[p] === '<') {
      const end = angleClose(code, p);
      if (end < 0) continue;
      generics = code.slice(p + 1, end);
      p = end + 1;
    }
    let where = -1;
    let open = -1;
    for (let q = p; q < n; q++) {
      const c = code[q]!;
      if (c === '{') { open = q; break; }
      if (c === ';' || c === '}') break;
      if (c === '(' || c === '[') { q = close.get(q) ?? n; continue; }
      if (where < 0 && c === 'w' && wordAt(code, q, 'where')) where = q + 5;
    }
    if (open < 0) continue;
    impls.push({ at: m.index!, kind, generics, where: where < 0 ? '' : code.slice(where, open), from: open, to: close.get(open) ?? n });
  }

  // `{` / `}` offsets, and the innermost block open after each.
  const events: number[] = [];
  const openAfter: number[] = [];
  const stack: number[] = [];
  const braces = /[{}]/g;
  for (let m = braces.exec(code); m; m = braces.exec(code)) {
    if (code.charCodeAt(m.index) === 123) stack.push(m.index);
    else stack.pop();
    events.push(m.index);
    openAfter.push(stack.length > 0 ? stack[stack.length - 1]! : -1);
  }

  return { code, lineStarts, fns, impls, close, events, openAfter, bindings: null };
}

/** The innermost `{…}` of a file read by readRustScopes holding `offset`, as [open, close]; null outside every block. */
export function rustInnerBlockAt(scopes: RustScopes, offset: number): [number, number] | null {
  return blockAt(scopes.events, scopes.openAfter, scopes.close, scopes.code.length, offset);
}

/** The names a Rust file binds (RustBinding), read from what readRustScopes kept of it. */
function readRustBindings(scopes: RustScopes): Map<string, RustBinding[]> {
  const { code, close, events, openAfter } = scopes;
  const n = code.length;
  const bindings = new Map<string, RustBinding[]>();
  const add = (name: string, binding: RustBinding): void => {
    const list = bindings.get(name);
    if (list) list.push(binding);
    else bindings.set(name, [binding]);
  };
  const bindPattern = (from: number, to: number, kind: RustBinding['kind'], scopeFrom: number, scopeTo: number, scrutinee?: string): void => {
    const emit: Emit = (name, at, site) => add(name, { at, kind, from: scopeFrom, to: scopeTo, site, scrutinee });
    // A tuple pattern, `(k, v)` or `(i, mut x)`: a name alone at its top is
    // the tuple's field at its place (a site with no path).
    const open = skipSpace(code, from);
    const end = code[open] === '(' ? close.get(open) : undefined;
    if (end !== undefined && end < to && skipSpace(code, end + 1) >= to) {
      let index = 0;
      for (const [a, b] of splitTop(code, open + 1, end, close, false)) {
        const text = code.slice(a, b);
        const simple = /^\s*(?:ref\s+)?(?:mut\s+)?([A-Za-z_]\w*)\s*$/.exec(text);
        if (simple && isBindingName(simple[1]!)) emit(simple[1]!, a + text.lastIndexOf(simple[1]!), { path: '', index });
        else walkPattern(code, a, b, close, undefined, emit);
        index++;
      }
      return;
    }
    walkPattern(code, from, to, close, undefined, emit);
  };
  // A parameter `pattern: Type`, or a closure's `pattern`.
  const param = (from: number, to: number, kind: 'param' | 'closure', scopeFrom: number, scopeTo: number): void => {
    const colon = topColon(code, from, to, close);
    const pattern = code.slice(from, colon < 0 ? to : colon);
    const simple = /^\s*(?:mut\s+)?([A-Za-z_]\w*)\s*$/.exec(pattern);
    if (simple) {
      if (isBindingName(simple[1]!)) {
        add(simple[1]!, {
          at: from + pattern.lastIndexOf(simple[1]!), kind, from: scopeFrom, to: scopeTo,
          type: colon < 0 ? undefined : code.slice(colon + 1, to).trim(),
        });
      }
      return;
    }
    bindPattern(from, colon < 0 ? to : colon, kind, scopeFrom, scopeTo);
  };

  for (const f of scopes.fns) {
    for (const [a, b] of splitTop(code, f.from + 1, f.paramsEnd, close, true)) param(a, b, 'param', f.body, f.to);
  }

  for (let i = code.indexOf('|'); i >= 0; i = code.indexOf('|', i + 1)) {
    // `||` — no parameters, or an `or` — and `|=`.
    if (code[i + 1] === '|') { i++; continue; }
    if (code[i + 1] === '=' || !opensClosure(code, i)) continue;
    let end = -1;
    let depth = 0;
    for (let j = i + 1; j < n && j < i + 2000; j++) {
      const c = code[j]!;
      if (c === '(' || c === '[' || c === '{') {
        const e = close.get(j);
        if (e === undefined) break;
        j = e;
        continue;
      }
      if (c === '<') depth++;
      else if (c === '>' && code[j - 1] !== '-' && code[j - 1] !== '=') depth--;
      else if (c === '|' && depth <= 0) { end = j; break; }
      else if (c === ';' || c === ')' || c === ']' || c === '}') break;
    }
    if (end < 0) continue;
    const b = skipSpace(code, end + 1);
    let bodyEnd: number;
    if (code.startsWith('->', b)) {
      const brace = code.indexOf('{', b);
      bodyEnd = brace < 0 ? n : close.get(brace) ?? n;
    } else if (code[b] === '{') {
      bodyEnd = close.get(b) ?? n;
    } else {
      bodyEnd = expressionEnd(code, b, close);
    }
    for (const [s, e] of splitTop(code, i + 1, end, close, true)) param(s, e, 'closure', end + 1, bodyEnd);
    // The body is read on: closures nest.
    i = end;
  }

  for (const m of code.matchAll(/\blet\b/g)) {
    const at = m.index!;
    const cond = /(?:\bif|\bwhile|&&)\s*$/.test(code.slice(Math.max(0, at - 16), at));
    // The pattern: up to a top-level `=` (no `==` or `=>`), a `:` (no `::`), or a `;`.
    const patFrom = at + 3;
    const patEnd = walkTop(code, patFrom, n, close, false, (i) => {
      const c = code[i];
      if (c === ';' || c === '}') return true;
      if (c === ':') return code[i + 1] !== ':' && code[i - 1] !== ':';
      return c === '=' && code[i + 1] !== '=' && code[i + 1] !== '>' && !'=!<>'.includes(code[i - 1]!);
    });
    if (patEnd >= n) continue;
    let type: string | undefined;
    let eq = code[patEnd] === '=' ? patEnd : -1;
    if (code[patEnd] === ':') {
      const typeEnd = walkTop(code, patEnd + 1, n, close, true, (i) => code[i] === ';' || code[i] === '}' ||
        (code[i] === '=' && code[i + 1] !== '=' && code[i + 1] !== '>' && !'=!<>'.includes(code[i - 1]!)));
      if (typeEnd >= n) continue;
      type = code.slice(patEnd + 1, typeEnd).trim();
      if (code[typeEnd] === '=') eq = typeEnd;
    }
    const simple = /^\s*(?:ref\s+)?(?:mut\s+)?([A-Za-z_]\w*)\s*$/.exec(code.slice(patFrom, patEnd));
    if (cond) {
      if (eq < 0) continue;
      // The value is matched up to the body's `{` or the next condition of a
      // chain, which (with the body) sees what the pattern binds; the value
      // itself sees the names around it.
      const valueEnd = walkTop(code, eq + 1, n, close, false, (i) => code[i] === '{' || code[i] === ';' || (code[i] === '&' && code[i + 1] === '&'));
      const scrutinee = code.slice(eq + 1, valueEnd).trim();
      const open = code[valueEnd] === '{' ? valueEnd : walkTop(code, valueEnd, n, close, false, (i) => code[i] === '{' || code[i] === ';');
      if (code[open] !== '{') continue;
      bindPattern(patFrom, patEnd, 'cond', valueEnd, close.get(open) ?? n, scrutinee);
      continue;
    }
    // A statement: up to its `;`, past a `let … else { … }`'s block.
    let initEnd = n;
    let stmtEnd = n;
    if (eq >= 0) {
      const stop = walkTop(code, eq + 1, n, close, false, (i) => code[i] === ';' || code[i] === '}' ||
        (code[i] === 'e' && wordAt(code, i, 'else') && !/\}\s*$/.test(code.slice(Math.max(0, i - 64), i))));
      initEnd = stop;
      if (code[stop] === 'e') {
        const open = skipSpace(code, stop + 4);
        const elseEnd = code[open] === '{' ? close.get(open) ?? n : n;
        const semi = skipSpace(code, elseEnd + 1);
        stmtEnd = code[semi] === ';' ? semi : elseEnd;
      } else {
        stmtEnd = stop;
      }
    } else {
      stmtEnd = walkTop(code, patEnd, n, close, false, (i) => code[i] === ';' || code[i] === '}');
    }
    const block = blockAt(events, openAfter, close, n, at);
    if (!block) continue;
    const scopeFrom = stmtEnd + 1;
    const scopeTo = block[1];
    const init = eq >= 0 ? code.slice(eq + 1, initEnd).trim() : undefined;
    if (simple) {
      if (isBindingName(simple[1]!)) {
        add(simple[1]!, {
          at: patFrom + code.slice(patFrom, patEnd).lastIndexOf(simple[1]!), kind: 'let', from: scopeFrom, to: scopeTo,
          type, init: type === undefined ? init : undefined,
        });
      }
      continue;
    }
    bindPattern(patFrom, patEnd, 'let', scopeFrom, scopeTo, init);
  }

  for (const m of code.matchAll(/\bfor\b/g)) {
    const p = skipSpace(code, m.index! + 3);
    // `for<'a>` binds lifetimes; `impl Trait for Type {` no names.
    if (code[p] === '<') continue;
    const inAt = walkTop(code, p, n, close, false, (i) => code[i] === '{' || code[i] === ';' || code[i] === '=' ||
      (code[i] === 'i' && wordAt(code, i, 'in')));
    if (code[inAt] !== 'i') continue;
    const open = walkTop(code, inAt + 2, n, close, false, (i) => code[i] === '{' || code[i] === ';');
    if (code[open] !== '{') continue;
    // What the loop iterates is its bindings' scrutinee.
    bindPattern(p, inAt, 'for', open, close.get(open) ?? n, code.slice(inAt + 2, open).trim());
  }

  for (const m of code.matchAll(/\bmatch\b/g)) {
    const from = m.index! + 5;
    const open = walkTop(code, from, n, close, false, (i) => code[i] === '{' || code[i] === ';' || code[i] === '}');
    if (code[open] !== '{') continue;
    const scrutinee = code.slice(from, open).trim();
    if (scrutinee === '') continue;
    const end = close.get(open) ?? n;
    let armStart = open + 1;
    for (let p = open + 1; p < end; p++) {
      const c = code[p]!;
      if (c === '(' || c === '[' || c === '{') {
        p = close.get(p) ?? end;
        continue;
      }
      if (c !== '=' || code[p + 1] !== '>') continue;
      // The pattern, without its guard; the guard sees what it binds.
      const guard = walkTop(code, armStart, p, close, false, (i) => code[i] === 'i' && wordAt(code, i, 'if'));
      let q = skipSpace(code, p + 2);
      let armEnd: number;
      if (code[q] === '{') {
        armEnd = close.get(q) ?? end;
        q = skipSpace(code, armEnd + 1);
        if (code[q] === ',') q++;
        else q = armEnd + 1;
      } else {
        armEnd = walkTop(code, q, end, close, false, (i) => code[i] === ',');
        q = armEnd + 1;
      }
      bindPattern(armStart, guard, 'arm', guard, armEnd, scrutinee);
      armStart = q;
      p = q - 1;
    }
  }

  return bindings;
}

/** The innermost `impl` or `trait` body around `offset`, if any. */
export function rustImplAt(scopes: RustScopes, offset: number): RustImplBlock | undefined {
  let best: RustImplBlock | undefined;
  for (const b of scopes.impls) {
    if (offset > b.from && offset < b.to && (!best || b.from > best.from)) best = b;
  }
  return best;
}

/** `text` parted at its top-level `sep`s, outside `()`, `[]`, `{}` and `<>` (`->` closes nothing). */
export function splitRustTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[i - 1] !== '-' && text[i - 1] !== '=')) depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * The bounds a generic parameter `name` is declared with, read from the
 * generics lists (`T: Read + Send, U`) and `where` clauses (`T: Into<U>`) of
 * the items around it — a function's and its `impl`'s: each bound's text,
 * `?Sized` and lifetimes left out. Undefined when no list declares `name`.
 */
export function rustBoundsOf(name: string, items: ReadonlyArray<{ generics: string; where: string }>): string[] | undefined {
  let declared = false;
  const bounds: string[] = [];
  const take = (text: string): void => {
    for (const b of splitRustTopLevel(text, '+')) {
      const bound = b.replace(/^for\s*<[^>]*>\s*/, '').trim();
      if (bound === '' || bound.startsWith('?') || bound.startsWith('\'')) continue;
      bounds.push(bound);
    }
  };
  for (const item of items) {
    for (const part of splitRustTopLevel(item.generics, ',')) {
      const m = /^([A-Za-z_]\w*)\s*(?::([\s\S]*?))?(?:=[\s\S]*)?$/.exec(part);
      if (!m || m[1] !== name) continue;
      declared = true;
      if (m[2]) take(m[2]);
    }
  }
  if (!declared) return undefined;
  for (const item of items) {
    for (const part of splitRustTopLevel(item.where, ',')) {
      const m = /^([A-Za-z_]\w*)\s*:([\s\S]*)$/.exec(part);
      if (m && m[1] === name) take(m[2]!);
    }
  }
  return bounds;
}

/**
 * The binding of `name` in scope at `offset`: the innermost, latest one. A
 * name an alternative pattern binds more than once there (`A(x) | B(x)`)
 * comes back as `ambiguous`.
 */
export function rustBindingAt(scopes: RustScopes, name: string, offset: number): { binding: RustBinding; ambiguous: boolean } | undefined {
  const list = (scopes.bindings ??= readRustBindings(scopes)).get(name);
  if (!list) return undefined;
  let best: RustBinding | undefined;
  for (const b of list) {
    if (offset >= b.from && offset < b.to && (!best || b.at > best.at)) best = b;
  }
  if (!best) return undefined;
  const ambiguous = list.some((b) => b !== best && b.from === best!.from && b.to === best!.to && b.kind === best!.kind &&
    (b.kind === 'arm' || b.kind === 'cond' || b.kind === 'let'));
  return { binding: best, ambiguous };
}

/** The innermost function with a body around `offset`, if any. */
export function rustFnAt(scopes: RustScopes, offset: number): RustFn | undefined {
  let best: RustFn | undefined;
  for (const f of scopes.fns) {
    if (offset >= f.from && offset <= f.to && (!best || f.from > best.from)) best = f;
  }
  return best;
}
