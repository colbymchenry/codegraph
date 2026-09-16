/**
 * Local C++ object construction → the constructor it runs (#1839).
 *
 * `T obj;` / `T obj(args);` / `T obj{args};` carry no call node, so
 * extraction records a dedicated `calls` ref shaped `ns::T::T/<arity>`
 * (tree-sitter.ts cppStackConstructions). This module resolves it:
 *  - the type is looked up in the LEXICAL namespaces of the call site — for
 *    `second::use()` writing `Widget w;`, `second::Widget` before a global
 *    `Widget`; a `::T` spelling is global only;
 *  - among that type's constructors, the single overload whose parameter
 *    count admits the argument count wins (defaults and `...` widen a range);
 *    two admitting overloads (`T(int)` / `T(double)` for `T w(x)`) resolve to
 *    nothing rather than a guess;
 *  - a type with no indexed constructor (an aggregate) yields no edge — a
 *    type declaration is not a callee.
 * These refs never fall through to the generic name strategies.
 */
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';

const CONSTRUCTOR_REF = /^(.*)::([^:]+)\/(\d+)$/;

export function isCppConstructorRef(ref: UnresolvedRef): boolean {
  return ref.language === 'cpp' && ref.referenceKind === 'calls' && /::[^:]+\/\d+$/.test(ref.referenceName);
}

/** Admissible argument counts of a `(params)` signature; null when it can't be read. */
function arityRange(signature: string | undefined): { min: number; max: number } | null {
  if (!signature?.startsWith('(') || !signature.endsWith(')')) return null;
  const text = signature.slice(1, -1).trim();
  if (!text || text === 'void') return { min: 0, max: 0 };
  // Split on top-level commas only: `std::map<K, V>`, `int (*cb)(int, int)`
  // and `T x = f(a, b)` all nest their commas.
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if ('(<[{'.includes(c)) depth++;
    if (')>]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote) return null;
  parts.push(text.slice(start));
  // A comparison in a default argument would be mistaken for a `=` default
  // or a template bracket — leave those to a compiler.
  if (parts.some((p) => /[<>]=|==|!=/.test(p))) return null;
  const variadic = parts.some((p) => p.includes('...'));
  return {
    min: parts.filter((p) => !p.includes('=') && !p.includes('...')).length,
    max: variadic ? Infinity : parts.length,
  };
}

export function matchCppConstructor(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const match = ref.referenceName.match(CONSTRUCTOR_REF);
  if (!match) return null;
  const [, rawType, name, count] = match;
  const type = rawType!.replace(/^::/, '');
  if (type.split('::').pop() !== name) return null;
  const argc = Number(count);

  // Innermost lexical namespace first, then outward, then global.
  const caller = context.getNodeById?.(ref.fromNodeId);
  const scopes = rawType!.startsWith('::') ? [] : (caller?.qualifiedName.split('::') ?? []);
  const candidates: string[] = [];
  for (let i = scopes.length; i > 0; i--) candidates.push(`${scopes.slice(0, i).join('::')}::${type}`);
  candidates.push(type);

  for (const qualified of candidates) {
    const owners = context
      .getNodesByQualifiedName(qualified)
      .filter((n) => n.language === 'cpp' && (n.kind === 'class' || n.kind === 'struct'));
    if (owners.length === 0) continue;
    const constructors = context
      .getNodesByName(name!)
      .filter((n) => n.language === 'cpp' && n.kind === 'method' && n.qualifiedName === `${qualified}::${name}`);
    // Brace-init prefers an initializer_list overload over arity — that
    // choice needs the argument types, so decline.
    if (constructors.some((n) => /\binitializer_list\b/.test(n.signature ?? ''))) return null;
    const admitting = constructors.filter((n) => {
      const range = arityRange(n.signature);
      return range !== null && range.min <= argc && argc <= range.max;
    });
    if (admitting.length !== 1) return null;
    return { original: ref, targetNodeId: admitting[0]!.id, confidence: 0.9, resolvedBy: 'qualified-name' };
  }
  return null;
}
