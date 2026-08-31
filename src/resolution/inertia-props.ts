/**
 * Inertia prop-boundary name math.
 *
 * Inertia (Laravel, Rails, Phoenix) has no REST schema and no GraphQL document:
 * the contract IS the prop map, and it is written twice — once as a server-side
 * map, once as a client-side destructure or type. When the server is configured
 * to camelize, the two halves do not even share a spelling, so a grep for
 * either name finds exactly one side. That is what makes this a resolver
 * problem rather than something a user can solve with search.
 *
 * Everything here is pure name math, kept separate from the resolver so the
 * transform can be pinned by tests against the real generator's behaviour.
 */

/**
 * `Phoenix.Naming.camelize(key, :lower)` — the exact transform the Phoenix
 * Inertia adapter applies when `camelize_props: true`.
 *
 * It is NOT a naive `snake_case` → `camelCase`, and the divergences are the
 * whole reason this is a function rather than a regex. Each produces a
 * plausible-LOOKING client name, so a mismatch reads as "this field is never
 * drawn" rather than "the transform is wrong" — the failure is silent in the
 * direction that matters:
 *
 *   _internal      → internal      leading underscores are stripped
 *   a__b           → aB            repeated underscores collapse
 *   foo_           → foo           a trailing underscore is dropped
 *   HTTP_status      → hTTPStatus      ONLY the first character is lowercased
 *   a_B            → a_B           an underscore before an UPPERCASE letter stays literal
 *   item_90x        → item90x        an underscore before a DIGIT is dropped
 *
 * The `a_B` and `HTTP_status` cases are the ones that bite, and the digit case is
 * the one that is easy to get backwards from reading the guards alone.
 */
export function phoenixCamelizeLower(key: string): string {
  let i = 0;
  while (i < key.length && key[i] === '_') i++; // leading underscores stripped
  if (i >= key.length) return '';
  return key[i]!.toLowerCase() + camelizeRest(key.slice(i + 1));
}

/** `Phoenix.Naming.camelize/1` — as above but with an upper-cased first letter. */
export function phoenixCamelizeUpper(key: string): string {
  let i = 0;
  while (i < key.length && key[i] === '_') i++;
  if (i >= key.length) return '';
  return key[i]!.toUpperCase() + camelizeRest(key.slice(i + 1));
}

function camelizeRest(rest: string): string {
  let out = '';
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch !== '_') {
      // `/` becomes `.` and restarts the upper-case form — a module-path
      // spelling that never appears in a prop key, kept for fidelity.
      if (ch === '/') return `${out}.${phoenixCamelizeUpper(rest.slice(i + 1))}`;
      out += ch;
      i++;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined) return out; // trailing `_` dropped
    if (next === '_') { i++; continue; } // repeated `_` collapse
    if (next >= 'a' && next <= 'z') { out += next.toUpperCase(); i += 2; continue; }
    if (next >= '0' && next <= '9') { out += next; i += 2; continue; }
    // Anything else (an uppercase letter): the underscore stays literal.
    out += ch;
    i++;
  }
  return out;
}

/** How a server adapter spells prop keys on the wire. */
export type PropTransform = 'camelize' | 'preserve';

/** Apply the configured transform to one server-side prop key. */
export function clientPropName(key: string, transform: PropTransform): string {
  return transform === 'camelize' ? phoenixCamelizeLower(key) : key;
}

/**
 * Server prop keys that must NOT be transformed.
 *
 * The Phoenix adapter exposes `preserve_case(:key)`, whose value is emitted
 * verbatim. It is a single clause and currently rare in the wild, but a
 * resolver that ignores it mis-links that field and nothing goes red — the same
 * invisible-failure class as the transform divergences above.
 */
export function stripPreserveCase(raw: string): { key: string; preserved: boolean } {
  const m = /^preserve_case\(\s*:?["']?([\w]+)["']?\s*\)$/.exec(raw.trim());
  return m ? { key: m[1]!, preserved: true } : { key: raw.trim(), preserved: false };
}

/**
 * Node kinds that COUNT as consuming a symbol.
 *
 * This is the real definition of "used", and it has to be per-SYMBOL rather
 * than per-file. A shared client types module routinely exports both the
 * `type`/`interface` declarations for a payload AND runtime helpers over it, and
 * it is imported as a value namespace by live code. Excluding the file loses
 * every genuine consumer of those helpers; including it makes each correctly
 * typed field "used" by its own declaration, so nothing is ever reported
 * orphaned — which is the failure that hides the finding entirely.
 *
 * A declaration is not a consumer of the field it declares. A function or value
 * that reads it is.
 */
const CONSUMER_KINDS = new Set([
  'function', 'method', 'variable', 'constant', 'component', 'property', 'field',
]);

/** Kinds that merely NAME a symbol — a type-level declaration, not a use. */
const DECLARATION_KINDS = new Set(['interface', 'type_alias', 'trait', 'protocol']);

/**
 * Does a reference from this symbol count as the prop being consumed?
 *
 * Deliberately NOT path-based. There is no reliable `.d.ts` convention to lean
 * on (in a typical app every `*.d.ts` lives in `node_modules`), and test files
 * must not be excluded wholesale either: a rendered-page test is sometimes the
 * only thing asserting a field's wording, because content behind a portal never
 * reaches a server-rendered string and the test has to call the composer
 * directly. Excluding those would make a genuinely consumed export look dead.
 */
export function isPropConsumer(kind: string): boolean {
  if (DECLARATION_KINDS.has(kind)) return false;
  return CONSUMER_KINDS.has(kind);
}
