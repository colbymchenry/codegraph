/**
 * Calls written in a Vue single-file component's `<template>` (#2340).
 *
 * A template runs code as surely as the `<script>` does: `{{ formatDate(at) }}`,
 * `:to="localePath(link)"`, `v-if="canEdit(user)"` and `@click="save(item)"`
 * call a function every time the component renders or the event fires. The
 * Vue extractor hands only `<script>` blocks to the TypeScript extractor, so
 * none of these were calls: `callers` on a Nuxt composable used in markup
 * came back empty.
 *
 * This finds them without a template compiler. A tag scanner reads the root
 * `<template>` (quote-aware, so a `>` inside an attribute value never ends a
 * tag) and collects the expressions Vue compiles: `{{ }}` interpolations in
 * text, and the values of directives (`:x` / `v-bind`, `@x` / `v-on`, `v-if`,
 * `v-show`, `v-model`, `v-for`'s source, custom `v-*`). A small JS lexer then
 * names each call's callee the way a script-side call is named (`useBar`,
 * `store.fetchUsers`), skipping strings and comments and reading into
 * template-literal substitutions.
 *
 * What is never a call to project code is dropped: names the template binds
 * itself (`v-for` aliases and slot props for their element's subtree, arrow
 * and function parameters for the rest of their expression), `$`-prefixed
 * instance helpers (`$t`, `$emit`, `$router.push`), the globals Vue lets a
 * template reach (`Math`, `JSON`, `Date`...), keywords, `new X()`, and an
 * object literal's method shorthand. A `v-pre` subtree is not compiled by Vue
 * and is skipped, as is a template in another language (`lang="pug"`).
 * Approach after the template-binding scan in #2073 by @L0garithmic.
 */

export interface VueTemplateCall {
  /** The callee as a script-side call names it: `useBar`, `store.fetchUsers`. */
  name: string;
  /** Offset of the callee's first character in the SFC source. */
  offset: number;
}

/** Elements that never have children: no closing tag, no scope of their own. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * The globals a Vue template can reach — Vue's own allow-list
 * (`isGloballyAllowed` in @vue/shared). Every other name in a template is the
 * component's: a script binding, a prop, an auto-import.
 */
const TEMPLATE_GLOBALS = new Set([
  'Infinity', 'undefined', 'NaN', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'Math',
  'Number', 'Date', 'Array', 'Object', 'Boolean', 'String', 'RegExp', 'Map', 'Set',
  'JSON', 'Intl', 'BigInt', 'console', 'Error', 'Symbol',
]);

/** Words that can stand before `(` without being a call. */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'throw', 'try', 'catch', 'finally', 'function', 'class',
  'new', 'delete', 'typeof', 'void', 'instanceof', 'in', 'of', 'var', 'let',
  'const', 'this', 'super', 'import', 'export', 'await', 'async', 'yield', 'with',
  'debugger', 'true', 'false', 'null', 'undefined',
]);

/** Keywords that end an operand, as an identifier does (`this`, `true`). */
const VALUE_KEYWORDS = new Set(['this', 'super', 'true', 'false', 'null', 'undefined']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[\w$]/;
const IDENTIFIERS = /[A-Za-z_$][\w$]*/g;
const WS = /\s/;

/** Vue's own `v-for` split: aliases, then `in` / `of`, then the source expression. */
const FOR_ALIAS = /([\s\S]*?)\s+(?:in|of)\s+(\S[\s\S]*)/;

/** Every call written in the root `<template>` of a Vue SFC, in source order. */
export function vueTemplateCalls(source: string): VueTemplateCall[] {
  // Blank <script>/<style> blocks and HTML comments, keeping every offset.
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const masked = source
    .replace(/<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  const root = rootTemplate(masked);
  if (!root) return [];
  const calls: VueTemplateCall[] = [];
  scanMarkup(masked, root.start, root.end, calls);
  return calls.sort((a, b) => a.offset - b.offset);
}

/** The content range of the SFC's root `<template>`; null for none or a non-HTML one. */
function rootTemplate(s: string): { start: number; end: number } | null {
  const tagRe = /<(\/?)template(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  let start = -1;
  let depth = 0;
  while ((m = tagRe.exec(s)) !== null) {
    const closing = m[1] === '/';
    const attrs = m[2] ?? '';
    if (start === -1) {
      if (closing || attrs.trimEnd().endsWith('/')) continue;
      const lang = /\blang\s*=\s*["']?([\w-]+)/.exec(attrs)?.[1];
      if (lang && lang.toLowerCase() !== 'html') return null;
      start = m.index + m[0].length;
      depth = 1;
    } else if (closing) {
      if (--depth === 0) return { start, end: m.index };
    } else if (!attrs.trimEnd().endsWith('/')) {
      depth++;
    }
  }
  return start === -1 ? null : { start, end: s.length };
}

interface Attr {
  name: string;
  value: string | null;
  /** Offset of the value's first character (inside any quotes). */
  valueStart: number;
}

interface Frame {
  tag: string;
  locals: Set<string> | null;
  pre: boolean;
}

/** The markup of `s[start, end)`: element nesting, directive values, interpolations. */
function scanMarkup(s: string, start: number, end: number, out: VueTemplateCall[]): void {
  const stack: Frame[] = [];
  const inScope = (name: string, own?: Set<string>) =>
    own?.has(name) === true || stack.some((f) => f.locals?.has(name) === true);
  const inPre = () => stack.some((f) => f.pre);
  const closeTag = /<\/([A-Za-z][^\s/>]*)\s*>/y;

  // The next `{{` at or after `i`, searched for again only once `i` passes it
  // (a fresh search per tag would rescan the rest of a mustache-free template).
  let nextMustache = -1;
  let i = start;
  while (i < end) {
    if (nextMustache < i) {
      const mu = s.indexOf('{{', i);
      nextMustache = mu === -1 || mu >= end ? end : mu;
    }
    const lt = s.indexOf('<', i);
    const nextTag = lt === -1 || lt >= end ? end : lt;
    if (nextMustache < nextTag) {
      // A `{{ }}` interpolation runs to the first `}}`, as Vue's parser reads it.
      const close = s.indexOf('}}', nextMustache + 2);
      const exprEnd = close === -1 || close > end ? end : close;
      if (!inPre()) scanExpression(s, nextMustache + 2, exprEnd, (n) => inScope(n), out);
      i = exprEnd + 2;
      continue;
    }
    if (nextTag >= end) break;

    closeTag.lastIndex = nextTag;
    const cm = closeTag.exec(s);
    if (cm) {
      const name = cm[1]!;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.tag === name || stack[k]!.tag.toLowerCase() === name.toLowerCase()) {
          stack.length = k;
          break;
        }
      }
      i = nextTag + cm[0].length;
      continue;
    }
    if (!/[A-Za-z]/.test(s[nextTag + 1] ?? '')) {
      i = nextTag + 1; // a `<` in text, not a tag
      continue;
    }

    const tag = parseOpenTag(s, nextTag, end);
    i = tag.close;
    // Names this element binds for itself and its subtree: `v-for` aliases,
    // slot props (`#item="{ item }"`, `v-slot="props"`, Vue 2 `slot-scope`).
    let own: Set<string> | null = null;
    let pre = false;
    let forSource: { start: number; end: number } | null = null;
    for (const a of tag.attrs) {
      if (a.name === 'v-pre') pre = true;
      if (a.value === null) continue;
      const kind = directiveKind(a.name);
      if (kind === 'for') {
        const fm = FOR_ALIAS.exec(a.value);
        if (fm) {
          own ??= new Set();
          for (const id of fm[1]!.match(IDENTIFIERS) ?? []) own.add(id);
          forSource = { start: a.valueStart + a.value.length - fm[2]!.length, end: a.valueStart + a.value.length };
        }
      } else if (kind === 'slot') {
        own ??= new Set();
        for (const id of a.value.match(IDENTIFIERS) ?? []) own.add(id);
      }
    }
    if (!pre && !inPre()) {
      const ownLocals = own ?? undefined;
      const local = (n: string) => inScope(n, ownLocals);
      for (const a of tag.attrs) {
        if (a.value === null) continue;
        const kind = directiveKind(a.name);
        if (kind === 'expr' || kind === 'on') {
          scanExpression(s, a.valueStart, a.valueStart + a.value.length, local, out);
        } else if (kind === 'for' && forSource) {
          scanExpression(s, forSource.start, forSource.end, local, out);
        }
      }
    }
    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name.toLowerCase())) {
      stack.push({ tag: tag.name, locals: own, pre });
    }
  }
}

/** What an attribute is to Vue: a `v-for`, a slot-props pattern, a handler, an expression, or plain HTML. */
function directiveKind(name: string): 'for' | 'slot' | 'on' | 'expr' | null {
  if (name === 'v-for') return 'for';
  if (name.startsWith('#') || name === 'v-slot' || name.startsWith('v-slot:') || name === 'slot-scope' || name === 'scope') {
    return 'slot';
  }
  if (name.startsWith('@') || name === 'v-on' || name.startsWith('v-on:')) return 'on';
  // `:x` / `.x` (v-bind and its `.prop` shorthand), `v-bind`, `v-if`, `v-model`, custom `v-*`.
  if (name.startsWith(':') || name.startsWith('.') || name.startsWith('v-')) return 'expr';
  return null;
}

/** An opening tag at `at`: its name, its attributes, where it ends. Quote-aware. */
function parseOpenTag(
  s: string,
  at: number,
  end: number
): { name: string; attrs: Attr[]; close: number; selfClosing: boolean } {
  let p = at + 1;
  const nameStart = p;
  while (p < end && !/[\s/>]/.test(s[p]!)) p++;
  const name = s.slice(nameStart, p);
  const attrs: Attr[] = [];
  while (p < end) {
    while (p < end && WS.test(s[p]!)) p++;
    if (p >= end) break;
    const c = s[p]!;
    if (c === '>') return { name, attrs, close: p + 1, selfClosing: false };
    if (c === '/' && s[p + 1] === '>') return { name, attrs, close: p + 2, selfClosing: true };
    const attrStart = p;
    while (p < end && !/[\s"'>/=]/.test(s[p]!)) p++;
    if (p === attrStart) {
      p++; // a stray `/`, quote or `=`
      continue;
    }
    const attrName = s.slice(attrStart, p);
    let q = p;
    while (q < end && WS.test(s[q]!)) q++;
    if (s[q] !== '=') {
      attrs.push({ name: attrName, value: null, valueStart: -1 });
      continue;
    }
    q++;
    while (q < end && WS.test(s[q]!)) q++;
    const quote = s[q];
    if (quote === '"' || quote === "'") {
      const closeQuote = s.indexOf(quote, q + 1);
      const valueEnd = closeQuote === -1 || closeQuote > end ? end : closeQuote;
      attrs.push({ name: attrName, value: s.slice(q + 1, valueEnd), valueStart: q + 1 });
      p = valueEnd + 1;
    } else {
      const valueStart = q;
      while (q < end && !/[\s>]/.test(s[q]!)) q++;
      attrs.push({ name: attrName, value: s.slice(valueStart, q), valueStart });
      p = q;
    }
  }
  return { name, attrs, close: end, selfClosing: false };
}

/** Prior token class, as the lexer needs it: what may follow, and what a `/` means. */
type Prev = 'start' | 'operand' | 'dot' | 'new' | 'decl';

interface Paren {
  open: number;
  /** Index in `found` of the call this paren opens, or -1. */
  call: number;
  /** The parameter list of a `function`. */
  params: boolean;
}

/**
 * The calls in one template expression `s[start, end)`. `outerLocal` is the
 * template scope (aliases and slot props in force); arrow and function
 * parameters bound inside the expression join it as they are met.
 */
function scanExpression(
  s: string,
  start: number,
  end: number,
  outerLocal: (name: string) => boolean,
  out: VueTemplateCall[]
): void {
  const params = new Set<string>();
  const isLocal = (name: string) => params.has(name) || outerLocal(name);
  const found: Array<VueTemplateCall & { dropped?: boolean }> = [];
  const parens: Paren[] = [];
  let lastGroup: { open: number; close: number } | null = null;
  let lastIdent = '';
  let functionPending = false;
  let prev: Prev = 'start';

  const skipWs = (k: number) => {
    while (k < end && WS.test(s[k]!)) k++;
    return k;
  };
  const wordEnd = (k: number) => {
    while (k < end && IDENT_CHAR.test(s[k]!)) k++;
    return k;
  };
  const addParams = (from: number, to: number) => {
    for (const id of s.slice(from, to).match(IDENTIFIERS) ?? []) params.add(id);
  };

  let i = start;
  while (i < end) {
    const c = s[i]!;
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i, end);
      prev = 'operand';
      continue;
    }
    if (c === '`') {
      i = skipTemplateLiteral(s, i, end, (a, b) => scanExpression(s, a, b, isLocal, out));
      prev = 'operand';
      continue;
    }
    if (c === '/') {
      if (s[i + 1] === '/') {
        const nl = s.indexOf('\n', i);
        i = nl === -1 || nl > end ? end : nl;
        continue;
      }
      if (s[i + 1] === '*') {
        const close = s.indexOf('*/', i + 2);
        i = close === -1 || close > end ? end : close + 2;
        continue;
      }
      if (prev !== 'operand') {
        i = skipRegex(s, i, end);
        prev = 'operand';
        continue;
      }
      i++;
      prev = 'start';
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      i++;
      while (i < end && /[\w.]/.test(s[i]!)) i++;
      prev = 'operand';
      continue;
    }
    if (IDENT_START.test(c)) {
      const wEnd = wordEnd(i);
      const word = s.slice(i, wEnd);
      if (prev === 'dot') {
        // A member tail of something that is not a plain path: `a().b`, `x[0].y`.
        i = wEnd;
        prev = 'operand';
        lastIdent = '';
        continue;
      }
      if (KEYWORDS.has(word)) {
        i = wEnd;
        lastIdent = '';
        if (word === 'new') prev = 'new';
        else if (word === 'function' || word === 'class') {
          prev = 'decl';
          if (word === 'function') functionPending = true;
        } else prev = VALUE_KEYWORDS.has(word) ? 'operand' : 'start';
        continue;
      }
      if (prev === 'decl') {
        // A function or class name, not a call.
        i = wEnd;
        prev = 'operand';
        continue;
      }
      // The member path rooted here: `a`, `a.b.c`, `a?.b`, TS `a!.b`.
      const segments = [word];
      let p = wEnd;
      for (;;) {
        let q = skipWs(p);
        if (s[q] === '!' && s[q + 1] === '.') q++;
        let r: number;
        if (s[q] === '.' && s[q + 1] !== '.') r = skipWs(q + 1);
        else if (s[q] === '?' && s[q + 1] === '.' && !/[0-9]/.test(s[q + 2] ?? '')) r = skipWs(q + 2);
        else break;
        if (!IDENT_START.test(s[r] ?? '')) break;
        const segEnd = wordEnd(r);
        segments.push(s.slice(r, segEnd));
        p = segEnd;
      }
      // Called? `path(`, or optionally `path?.(`.
      let q = skipWs(p);
      if (s[q] === '?' && s[q + 1] === '.' && s[skipWs(q + 2)] === '(') q = skipWs(q + 2);
      const root = segments[0]!;
      if (s[q] === '(') {
        let call = -1;
        if (prev !== 'new' && !root.startsWith('$') && !TEMPLATE_GLOBALS.has(root) && !isLocal(root)) {
          found.push({ name: segments.join('.'), offset: i });
          call = found.length - 1;
        }
        parens.push({ open: q, call, params: false });
        i = q + 1;
        prev = 'start';
        lastIdent = '';
        continue;
      }
      i = p;
      prev = 'operand';
      lastIdent = segments.length === 1 ? word : '';
      continue;
    }
    // Punctuation.
    if (c === '(') {
      parens.push({ open: i, call: -1, params: functionPending });
      functionPending = false;
      i++;
      prev = 'start';
      continue;
    }
    if (c === ')') {
      const paren = parens.pop();
      if (paren) {
        lastGroup = { open: paren.open, close: i };
        if (paren.params) addParams(paren.open + 1, i);
        // `{ fmt(v) { … } }` — an object literal's method, not a call.
        if (paren.call >= 0 && s[skipWs(i + 1)] === '{') found[paren.call]!.dropped = true;
      }
      i++;
      prev = 'operand';
      lastIdent = '';
      continue;
    }
    if (c === '=' && s[i + 1] === '>') {
      // Arrow parameters: `(a, { b }) =>` or `a =>`.
      if (lastIdent) params.add(lastIdent);
      else if (lastGroup && lastGroup.close === previousNonWs(s, i, start)) addParams(lastGroup.open + 1, lastGroup.close);
      i += 2;
      prev = 'start';
      lastIdent = '';
      continue;
    }
    if (c === '.') {
      if (s[i + 1] === '.' && s[i + 2] === '.') {
        i += 3;
        prev = 'start';
      } else {
        i++;
        prev = 'dot';
      }
      lastIdent = '';
      continue;
    }
    if (c === '?' && s[i + 1] === '.' && !/[0-9]/.test(s[i + 2] ?? '')) {
      i += 2;
      prev = 'dot';
      lastIdent = '';
      continue;
    }
    i++;
    prev = c === ']' || c === '}' ? 'operand' : 'start';
    lastIdent = '';
  }

  for (const f of found) if (!f.dropped) out.push({ name: f.name, offset: f.offset });
}

/** Index of the last non-whitespace character before `i` (not before `floor`). */
function previousNonWs(s: string, i: number, floor: number): number {
  let k = i - 1;
  while (k >= floor && WS.test(s[k]!)) k--;
  return k;
}

/** Past a `'…'` / `"…"` string starting at `i`. */
function skipString(s: string, i: number, end: number): number {
  const quote = s[i];
  let k = i + 1;
  while (k < end) {
    const c = s[k]!;
    if (c === '\\') k += 2;
    else if (c === quote) return k + 1;
    else k++;
  }
  return end;
}

/** Past a template literal starting at `i`, reporting each `${…}` substitution's range. */
function skipTemplateLiteral(
  s: string,
  i: number,
  end: number,
  onSubstitution?: (start: number, end: number) => void
): number {
  let k = i + 1;
  while (k < end) {
    const c = s[k]!;
    if (c === '\\') k += 2;
    else if (c === '`') return k + 1;
    else if (c === '$' && s[k + 1] === '{') {
      const close = matchingBrace(s, k + 2, end);
      onSubstitution?.(k + 2, close);
      k = close + 1;
    } else k++;
  }
  return end;
}

/** The `}` closing a brace opened just before `i` (strings and template literals skipped). */
function matchingBrace(s: string, i: number, end: number): number {
  let depth = 0;
  let k = i;
  while (k < end) {
    const c = s[k]!;
    if (c === '"' || c === "'") k = skipString(s, k, end);
    else if (c === '`') k = skipTemplateLiteral(s, k, end);
    else if (c === '{') {
      depth++;
      k++;
    } else if (c === '}') {
      if (depth === 0) return k;
      depth--;
      k++;
    } else k++;
  }
  return end;
}

/** Past a regex literal starting at `i` (a `/` where an operand is expected). */
function skipRegex(s: string, i: number, end: number): number {
  let k = i + 1;
  let inClass = false;
  while (k < end) {
    const c = s[k]!;
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === '\n') return i + 1; // not a regex after all
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      k++;
      while (k < end && /[a-z]/i.test(s[k]!)) k++;
      return k;
    }
    k++;
  }
  return i + 1;
}
