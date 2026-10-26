/**
 * Local C++ object construction → the constructor it runs (#1839).
 *
 * `T obj;` / `T obj(args);` / `T obj{args};` carry no call node, so
 * extraction records a dedicated `calls` ref shaped `ns::T::T/<arity>`
 * (tree-sitter.ts cppStackConstructions). This module resolves it:
 *  - the type is looked up in the LEXICAL namespaces of the call site — for
 *    `second::use()` writing `Widget w;`, `second::Widget` before a global
 *    `Widget`; a `::T` spelling is global only;
 *  - a type named through a `typedef` / `using` alias is the type the alias
 *    names, looked up from the alias's own scope (cpp-type-aliases.ts);
 *  - among that type's constructors, the single overload whose parameter
 *    count admits the argument count wins (defaults and `...` widen a range);
 *    two admitting overloads (`T(int)` / `T(double)` for `T w(x)`) resolve to
 *    nothing rather than a guess;
 *  - a type with no indexed constructor (an aggregate) yields no edge — a
 *    type declaration is not a callee.
 * These refs never fall through to the generic name strategies.
 */
import type { Node } from '../types';
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';
import { resolveCppAliasedType } from './cpp-type-aliases';

const CONSTRUCTOR_REF = /^(.*)::([^:]+)\/(\d+)$/;

export function isCppConstructorRef(ref: UnresolvedRef): boolean {
  return ref.language === 'cpp' && ref.referenceKind === 'calls' && /::[^:]+\/\d+$/.test(ref.referenceName);
}

/** Admissible argument counts of a `(params)` signature; null when it can't be read. */
function constructorShape(signature: string | undefined): { min: number; max: number; key: string } | null {
  signature = signature?.replace(/;$/, '');
  if (!signature?.startsWith('(') || !signature.endsWith(')')) return null;
  const text = signature.slice(1, -1).trim();
  if (!text || text === 'void') return { min: 0, max: 0, key: '' };
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
  const types = parts.map((p) => {
    let type = p.split('=')[0]!.trim();
    // Strip an optional parameter name, retaining unnamed built-in types
    // (`unsigned int`, `long long`) and qualifiers. Complex declarators stay
    // distinct unless their spelling matches; uncertainty must not merge overloads.
    type = type.replace(/(.*[\s*&>])([A-Za-z_]\w*)$/, (whole, prefix: string, name: string) =>
      /^(?:void|bool|char|short|int|long|float|double|signed|unsigned|const|volatile)$/.test(name)
        || /^(?:const|volatile|struct|class|enum)\s*$/.test(prefix) ? whole : prefix);
    return type.replace(/\s+/g, '');
  });
  return {
    key: types.join(','),
    min: parts.filter((p) => !p.includes('=') && !p.includes('...')).length,
    max: variadic ? Infinity : parts.length,
  };
}

export function matchCppConstructor(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const match = ref.referenceName.match(CONSTRUCTOR_REF);
  if (!match) return null;
  const [, rawType, ctorName, count] = match;
  let type = rawType!.replace(/^::/, '');
  if (type.split('::').pop() !== ctorName) return null;
  const argc = Number(count);

  // Innermost lexical namespace first, then outward, then global.
  const caller = context.getNodeById?.(ref.fromNodeId);
  let scopes = rawType!.startsWith('::') ? [] : (caller?.qualifiedName.split('::') ?? []);
  // A type named through an alias (`Table::Iterator iter(&table_);` under
  // `typedef SkipList<…> Table;`) constructs the type the alias names, looked
  // up from where the alias wrote it — never an outer class the alias hides.
  if (!rawType!.startsWith('::')) {
    const aliased = resolveCppAliasedType(type, ref, context);
    if (aliased === null) return null;
    if (aliased) {
      type = [...aliased.target, ...aliased.rest].join('::');
      scopes = aliased.scope ? aliased.scope.split('::') : [];
    }
  }
  const name = type.split('::').pop()!;
  const candidates: string[] = [];
  for (let i = scopes.length; i > 0; i--) candidates.push(`${scopes.slice(0, i).join('::')}::${type}`);
  candidates.push(type);

  for (const qualified of candidates) {
    const owners = context
      .getNodesByQualifiedName(qualified)
      .filter((n) => n.language === 'cpp' && (n.kind === 'class' || n.kind === 'struct' || n.kind === 'union'));
    if (owners.length === 0) continue;
    const constructors = context
      .getNodesByName(name)
      .filter((n) => n.language === 'cpp' && n.kind === 'method' && n.qualifiedName === `${qualified}::${name}`);
    // Brace-init prefers an initializer_list overload over arity — that
    // choice needs the argument types, so decline.
    if (constructors.some((n) => /\binitializer_list\b/.test(n.signature ?? ''))) return null;
    // A prototype and its out-of-line definition describe one overload.
    // Merge their admissible ranges, then prefer the executable definition.
    const overloads = new Map<string, { nodes: Node[]; min: number; max: number }>();
    for (const node of constructors) {
      const shape = constructorShape(node.signature);
      if (!shape) return null;
      const prior = overloads.get(shape.key);
      if (prior) {
        prior.nodes.push(node);
        prior.min = Math.min(prior.min, shape.min);
      } else overloads.set(shape.key, { nodes: [node], min: shape.min, max: shape.max });
    }
    const admitting = [...overloads.values()].filter((o) => o.min <= argc && argc <= o.max);
    if (admitting.length !== 1) return null;
    const definitions = admitting[0]!.nodes.filter((n) => !n.signature?.endsWith(';'));
    const targets = definitions.length > 0 ? definitions : admitting[0]!.nodes;
    if (targets.length !== 1) return null;
    return { original: ref, targetNodeId: targets[0]!.id, confidence: 0.9, resolvedBy: 'qualified-name' };
  }
  return null;
}
