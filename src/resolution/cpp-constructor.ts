import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';

/** The constructor-only reference emitted for a local C++ object declaration. */
export function isCppConstructorRef(ref: UnresolvedRef): boolean {
  return ref.language === 'cpp' && ref.referenceKind === 'calls' && /::[^:]+\/\d+$/.test(ref.referenceName);
}

/** Count top-level parameters; nested template/function/default commas are not separators. */
function arity(signature: string | undefined): { min: number; max: number } | null {
  if (!signature?.startsWith('(') || !signature.endsWith(')')) return null;
  const text = signature.slice(1, -1).trim();
  if (!text || text === 'void') return { min: 0, max: 0 };
  const parts: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('(<[{'.includes(c)) depth++;
    if (')>]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0 || quote) return null;
  parts.push(text.slice(start));
  // Complex declarator/default expressions need a compiler; don't infer their arity.
  if (parts.some(p => /[<>]=|==|!=/.test(p))) return null;
  const variadic = parts.some(p => p.includes('...'));
  return { min: parts.filter(p => !p.includes('=') && !p.includes('...')).length,
    max: variadic ? Infinity : parts.length };
}

/** Lexical type identity first, then a unique arity-compatible constructor. */
export function matchCppConstructor(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const match = ref.referenceName.match(/^(.*)::([^:]+)\/(\d+)$/);
  if (!match) return null;
  const [, rawType, name, count] = match;
  const type = rawType!.replace(/^::/, '');
  if (type.split('::').pop() !== name) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const scopes = rawType!.startsWith('::') ? [] : (caller?.qualifiedName.split('::') ?? []);
  const typeNames: string[] = [];
  for (let i = scopes.length; i > 0; i--) typeNames.push(`${scopes.slice(0, i).join('::')}::${type}`);
  typeNames.push(type);
  for (const qualified of typeNames) {
    const owners = context.getNodesByQualifiedName(qualified).filter(n =>
      n.language === 'cpp' && (n.kind === 'class' || n.kind === 'struct'));
    if (!owners.length) continue;
    const methods = context.getNodesByName(name!).filter(n => n.language === 'cpp' &&
      n.kind === 'method' && n.qualifiedName === `${qualified}::${name}`);
    // Braced initialization prioritizes initializer_list overloads; arity alone
    // cannot safely choose among them and ordinary constructors.
    if (methods.some(n => /\binitializer_list\b/.test(n.signature ?? ''))) return null;
    const matches = methods.filter(n => { const a = arity(n.signature); return a && a.min <= Number(count) && Number(count) <= a.max; });
    if (matches.length !== 1) return null;
    return { original: ref, targetNodeId: matches[0]!.id, confidence: 0.9, resolvedBy: 'qualified-name' };
  }
  return null;
}
