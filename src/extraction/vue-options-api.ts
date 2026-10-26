/**
 * The members of a Vue Options API component — `export default { methods:
 * { login() {…} }, computed: {…}, watch: {…}, mounted() {…} }`.
 *
 * A `<script>` block goes through the TypeScript/JavaScript extractor, which
 * extracts no symbol for a method written in an object literal. Every Vue 2
 * app, and every Vue 3 app not on `<script setup>`, keeps its code there:
 * vue-element-admin's login screen had no `handleLogin`, so its calls, its
 * `this.$router.push`, and the `@click="handleLogin"` that runs it all
 * belonged to the file.
 *
 * This reads the options object the default export is — directly, or through
 * `defineComponent({…})` / `Vue.extend({…})` / `Vue.component('x', {…})` —
 * and names each function in it: `methods`, `computed` and `watch` entries,
 * and the component's own functions (`data`, `setup`, the lifecycle hooks,
 * Nuxt 2's `asyncData` / `fetch`, `render`).
 */

/** One function-valued member of the options object, as offsets into the script. */
export interface OptionsMember {
  name: string;
  /** Where the member's key starts. */
  start: number;
  /** One past where its value ends. */
  end: number;
}

/** The options a component declares as functions of its own. */
const COMPONENT_FUNCTIONS = new Set([
  'data', 'setup', 'render',
  'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
  'activated', 'deactivated', 'beforeDestroy', 'destroyed', 'beforeUnmount', 'unmounted',
  'errorCaptured', 'renderTracked', 'renderTriggered', 'serverPrefetch',
  // Nuxt 2
  'asyncData', 'fetch', 'head', 'validate', 'middleware',
]);

/** The groups whose every entry is a function (or, for computed/watch, an object of them). */
const MEMBER_GROUPS = new Set(['methods', 'computed', 'watch']);

/** The index after a string, template or regex-free literal starting at `at`; -1 if unterminated. */
function skipQuoted(s: string, at: number): number {
  const quote = s[at]!;
  for (let i = at + 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '`' && ch === '$' && s[i + 1] === '{') {
      const close = matchClose(s, i + 1);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return -1;
}

/** The index of the bracket closing the one at `open`; -1 if unbalanced. */
function matchClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipQuoted(s, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface RawMember {
  name: string;
  start: number;
  /** Where the value starts (after `:`), or the `(` of a method shorthand. */
  valueAt: number;
  end: number;
  shorthand: boolean;
}

/** The members of the object literal whose `{` is at `open`. */
function objectMembers(s: string, open: number): RawMember[] {
  const close = matchClose(s, open);
  if (close < 0) return [];
  const out: RawMember[] = [];
  let i = open + 1;
  while (i < close) {
    // Skip separators, whitespace and comments between members.
    const ws = /^(?:\s|,|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/.exec(s.slice(i, close));
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const start = i;
    // `async name(…)`, `*name(…)`, `get name()`, `'quoted-key'`, `name`, `...spread`
    const head = /^(?:(?:async|get|set)\s+(?=[\w$'"[]))?\*?\s*(?:([A-Za-z_$][\w$]*)|(['"])((?:(?!\2).)*)\2|(\[)|(\.\.\.))/.exec(s.slice(i, close));
    if (!head) {
      i++;
      continue;
    }
    const name = head[1] ?? head[3] ?? null;
    let j = i + head[0].length;
    if (head[5] !== undefined) {
      // A computed key — `[KEY]() {}` — has no static name; step over it.
      const keyClose = matchClose(s, j - 1);
      if (keyClose < 0) return out;
      j = keyClose + 1;
    }
    // Where this member ends: the next depth-0 comma, or the object's end.
    let k = j;
    while (k < close) {
      const ch = s[k]!;
      if (ch === '"' || ch === "'" || ch === '`') {
        const end = skipQuoted(s, k);
        if (end < 0) return out;
        k = end;
        continue;
      }
      if (ch === '/' && (s[k + 1] === '/' || s[k + 1] === '*')) {
        const end = s[k + 1] === '/' ? s.indexOf('\n', k) : s.indexOf('*/', k + 2) + 1;
        k = end <= 0 ? close : end + 1;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') {
        const end = matchClose(s, k);
        if (end < 0) return out;
        k = end + 1;
        continue;
      }
      if (ch === ',') break;
      k++;
    }
    const rest = s.slice(j, k);
    const colon = /^\s*:/.exec(rest);
    if (name !== null && head[6] === undefined) {
      out.push({
        name,
        start,
        valueAt: colon ? j + colon[0].length : j,
        end: k,
        shorthand: !colon && /^\s*\(/.test(rest),
      });
    }
    i = k + 1;
  }
  return out;
}

/** Whether a member's value is a function: a shorthand method, `function (…) {…}`, or an arrow. */
function isFunctionValue(s: string, m: RawMember): boolean {
  if (m.shorthand) return true;
  const value = s.slice(m.valueAt, m.end).trimStart();
  return /^(?:async\s+)?function\b/.test(value) || /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(value);
}

/** The `{` of the options object the default export is, or -1. */
function optionsObjectStart(script: string): number {
  const m = /\bexport\s+default\s+(?:(?:defineComponent|defineNuxtComponent|Vue\s*\.\s*extend)\s*\(\s*|Vue\s*\.\s*component\s*\(\s*(['"])[^'"]*\1\s*,\s*)?\{/.exec(script);
  return m ? m.index + m[0].length - 1 : -1;
}

/** Every function a Vue Options API component declares, in source order. */
export function vueOptionsMembers(script: string): OptionsMember[] {
  const open = optionsObjectStart(script);
  if (open < 0) return [];
  const out: OptionsMember[] = [];
  for (const member of objectMembers(script, open)) {
    if (COMPONENT_FUNCTIONS.has(member.name) && isFunctionValue(script, member)) {
      out.push({ name: member.name, start: member.start, end: member.end });
      continue;
    }
    if (!MEMBER_GROUPS.has(member.name) || member.shorthand) continue;
    const valueOpen = script.indexOf('{', member.valueAt);
    if (valueOpen < 0 || valueOpen >= member.end || script.slice(member.valueAt, valueOpen).trim() !== '') continue;
    for (const entry of objectMembers(script, valueOpen)) {
      // `computed: { x: { get() {}, set() {} } }` and `watch: { y: { handler() {} } }`
      // are functions too; a watcher written as a method NAME (`z: 'onZ'`) is not.
      const value = script.slice(entry.valueAt, entry.end).trimStart();
      if (isFunctionValue(script, entry) || (member.name !== 'methods' && value.startsWith('{'))) {
        out.push({ name: entry.name, start: entry.start, end: entry.end });
      }
    }
  }
  return out;
}
