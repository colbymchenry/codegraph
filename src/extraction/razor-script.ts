/**
 * The JavaScript in a Razor view's `<script>` block, with the Razor taken out.
 *
 * A view's script is a template: the server runs what follows an `@` and the
 * browser gets the result. A JavaScript grammar reads `var id = @Model.Id;` as
 * an error, and `@Html.Raw(Json.Serialize(Model))` as calls to `Html.Raw` and
 * `Json.Serialize` that no script makes. So everything Razor is blanked before
 * the block is parsed, offset for offset, and lines keep their numbers:
 *
 *  - an expression (`@Model.Id`, `@T("x")`, `@(a + b)`, `@await F()`) becomes `0`,
 *    a value wherever an expression was, harmless inside a string;
 *  - a comment (`@* … *@`) and a code block (`@{ … }`) become blanks;
 *  - a control statement (`@if (…) { … } else { … }`, `@foreach (…) { … }`) loses
 *    its C#, and keeps the JavaScript it emits: what a `<text>` holds and an
 *    `@:` line.
 */

/** Razor's statement keywords: a block follows, not a value. */
const CONTROL = new Set(['if', 'for', 'foreach', 'while', 'switch', 'lock', 'using', 'try', 'do']);
/** What can carry a control statement on after its block. */
const CONTINUATION = /^\s*(?:else\s+if\b|else\b|catch\b|finally\b)/;

const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Past a C# string or char literal at `at`. */
function skipString(s: string, at: number): number {
  const quote = s[at];
  const verbatim = at > 0 && s[at - 1] === '@';
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i];
    if (!verbatim && c === '\\') i++;
    else if (c === quote) {
      if (verbatim && s[i + 1] === quote) i++;
      else return i + 1;
    } else if (c === '\n' && !verbatim) return i;
  }
  return s.length;
}

/** Index just past the bracket closing the one at `open`, or -1. Strings and comments hold no brackets. */
function pastBracket(s: string, open: number): number {
  const stack = [CLOSER[s[open]!]!];
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      i = skipString(s, i) - 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (CLOSER[c]) {
      stack.push(CLOSER[c]!);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function blank(out: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
}

/** Past an implicit expression starting at `at` (after the `@`): names, members, calls and indexers. */
function pastExpression(s: string, at: number): number {
  let i = at;
  const awaited = /^await\s+/.exec(s.slice(i, i + 16));
  if (awaited) i += awaited[0].length;
  const name = /^[A-Za-z_]\w*/.exec(s.slice(i, i + 128));
  if (!name) return at;
  i += name[0].length;
  for (;;) {
    const c = s[i];
    if (c === '(' || c === '[') {
      const end = pastBracket(s, i);
      if (end < 0) return i;
      i = end;
    } else if (c === '<' && /^<[A-Z][\w.,\s<>?]*>\(/.test(s.slice(i, i + 80))) {
      // A generic call: `@Html.Partial<Foo>(…)`.
      i = s.indexOf('(', i);
    } else if ((c === '.' || (c === '?' && s[i + 1] === '.')) && /[A-Za-z_]/.test(s[i + (c === '.' ? 1 : 2)] ?? '')) {
      i += c === '.' ? 1 : 2;
      const member = /^\w+/.exec(s.slice(i, i + 128));
      i += member?.[0].length ?? 0;
    } else {
      return i;
    }
  }
}

/** Where the `</text>` closing the `<text>` at `open` starts, nested ones counted; -1 if none before `to`. */
function closingText(s: string, open: number, to: number): number {
  let depth = 0;
  const tag = /<(\/?)text>/g;
  tag.lastIndex = open;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(s)) !== null && m.index < to) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return -1;
}

/** Keep what a statement block emits as JavaScript, and blank the C# around it. */
function keepEmittedScript(s: string, out: string[], from: number, to: number): void {
  let i = from;
  while (i < to) {
    const textTag = s.indexOf('<text>', i);
    const lineTag = s.indexOf('@:', i);
    const next = [textTag, lineTag].filter((at) => at >= 0 && at < to).sort((a, b) => a - b)[0];
    if (next === undefined) {
      blank(out, i, to);
      return;
    }
    blank(out, i, next);
    if (next === lineTag) {
      const end = s.indexOf('\n', next);
      const stop = end < 0 || end > to ? to : end;
      blank(out, next, next + 2);
      blankRazor(s, out, next + 2, stop);
      i = stop;
    } else {
      const close = closingText(s, next, to);
      if (close < 0) {
        blank(out, next, to);
        return;
      }
      blank(out, next, next + '<text>'.length);
      blankRazor(s, out, next + '<text>'.length, close);
      blank(out, close, close + '</text>'.length);
      i = close + '</text>'.length;
    }
  }
}

/** Blank a control statement whose keyword starts at `at`; returns where it ends. */
function blankControl(s: string, out: string[], at: number, limit: number): number {
  let i = at;
  for (;;) {
    // The header: everything up to the block's `{`, brackets balanced.
    while (i < limit && s[i] !== '{') {
      if (s[i] === '(') {
        const end = pastBracket(s, i);
        if (end < 0) {
          i = limit;
          break;
        }
        i = end;
      } else i++;
    }
    if (i >= limit) {
      blank(out, at, limit);
      return limit;
    }
    const end = pastBracket(s, i);
    if (end < 0 || end > limit) {
      blank(out, at, limit);
      return limit;
    }
    blank(out, at, i + 1);
    keepEmittedScript(s, out, i + 1, end - 1);
    blank(out, end - 1, end);
    const rest = CONTINUATION.exec(s.slice(end, end + 32));
    if (!rest) return end;
    at = end;
    i = end;
  }
}

function blankRazor(s: string, out: string[], from: number, to: number): void {
  let i = from;
  while (i < to) {
    const at = s.indexOf('@', i);
    if (at < 0 || at >= to) return;
    // `name@host` is text to Razor, as it is here.
    if (at > 0 && /\w/.test(s[at - 1]!)) {
      i = at + 1;
      continue;
    }
    const next = s[at + 1];
    if (next === '@') {
      blank(out, at, at + 1);
      i = at + 2;
    } else if (next === '*') {
      const end = s.indexOf('*@', at + 2);
      const stop = end < 0 || end + 2 > to ? to : end + 2;
      blank(out, at, stop);
      i = stop;
    } else if (next === '{' || next === '(') {
      const end = pastBracket(s, at + 1);
      if (end < 0 || end > to) return;
      blank(out, at, end);
      if (next === '(') out[at] = '0';
      i = end;
    } else if (next === ':') {
      blank(out, at, at + 2);
      i = at + 2;
    } else {
      const word = /^[A-Za-z_]\w*/.exec(s.slice(at + 1, at + 33))?.[0];
      if (!word) {
        i = at + 1;
      } else if (CONTROL.has(word)) {
        i = blankControl(s, out, at, to);
      } else {
        const end = Math.min(pastExpression(s, at + 1), to);
        blank(out, at, end);
        out[at] = '0';
        i = Math.max(end, at + 1);
      }
    }
  }
}

/** `source` with its Razor blanked; every offset and line stays where it was. */
export function blankRazorInScript(source: string): string {
  if (!source.includes('@')) return source;
  const out = source.split('');
  blankRazor(source, out, 0, source.length);
  return out.join('');
}

/** `source` with its `@* … *@` comments blanked, so a commented-out `<script>` is not a script. */
export function blankRazorComments(source: string): string {
  if (!source.includes('@*')) return source;
  const out = source.split('');
  for (let at = source.indexOf('@*'); at >= 0; at = source.indexOf('@*', at + 2)) {
    const end = source.indexOf('*@', at + 2);
    if (end < 0) break;
    blank(out, at, end + 2);
    at = end;
  }
  return out.join('');
}

/** Whether a `<script>` element's attributes leave it JavaScript: no `type`, or a JavaScript one. */
export function isJavaScriptBlock(attrs: string): boolean {
  const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.trim().toLowerCase();
  if (type === undefined || type === '') return true;
  return /^(?:module|(?:text|application)\/(?:javascript|ecmascript|typescript|babel|jsx)|text\/(?:x-)?(?:babel|jsx))$/.test(type);
}
