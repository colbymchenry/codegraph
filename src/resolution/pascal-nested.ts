import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import {
  assignmentDestination, classMembers, declarationText, isProceduralType, methodOn, ownerOf, routineAt, sourceFacts, typeNamed,
  type Routine, type SourceFacts,
} from './pascal-references';

const NESTING = new WeakMap<SourceFacts, boolean>();

function hasNested(facts: SourceFacts): boolean {
  let nested = NESTING.get(facts);
  if (nested === undefined) {
    nested = [...facts.routines.values()].some(group => group.some(r => r.parent));
    NESTING.set(facts, nested);
  }
  return nested;
}

function lineOf(facts: SourceFacts, offset: number): number {
  let low = 0;
  let high = facts.lineOffsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (facts.lineOffsets[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function routineNode(routine: Routine, file: string, facts: SourceFacts, context: ResolutionContext): Node | null {
  if (routine.parent) {
    const parent = routineNode(routine.parent, file, facts, context);
    if (!parent) return null;
    const qualified = `${parent.qualifiedName}::${routine.name}`.toLowerCase();
    const found = context.getNodesInFile(file).filter(n => n.kind === 'function' && n.qualifiedName.toLowerCase() === qualified);
    const line = lineOf(facts, routine.start);
    return found.find(n => n.startLine === line) ?? (found.length === 1 ? found[0]! : null);
  }
  const parts = routine.name.split('.');
  const name = parts.pop()!;
  if (parts.length > 0) {
    const type = typeNamed(parts[parts.length - 1]!, file, context);
    return type ? classMembers(type, name, context).find(n => n.kind === 'method') ?? null : null;
  }
  return context.getNodesInFile(file).find(n => n.kind === 'function' && n.name.toLowerCase() === name &&
    !n.qualifiedName.includes('::')) ?? null;
}

interface Lookup {
  routine: Node | null | undefined;
  hidden: boolean;
}

function declaredBefore(facts: SourceFacts, scope: Routine, name: string, child: Routine, origin: Routine | null): boolean {
  if (!origin || child.start <= origin.start) return true;
  const forward = new RegExp(`\\b(?:procedure|function)\\s+${name}\\b[^;]*;\\s*forward\\s*;`, 'i');
  return forward.test(facts.text.slice(scope.start, origin.start));
}

/**
 * Nearest nested routine a bare name denotes at the reference, walking scopes
 * outward from the innermost routine. A sibling declared after the routine
 * that mentions it is not visible unless a `forward` declaration precedes it.
 * `routine` undefined: none visible. null: one is visible but a nearer local
 * declaration shadows it, or it has no indexed node. `hidden`: a routine of
 * that name exists in an enclosing scope but is declared too late to be seen.
 */
function lookup(name: string, ref: UnresolvedRef, context: ResolutionContext): Lookup {
  const facts = sourceFacts(ref.filePath, context);
  if (!hasNested(facts)) return { routine: undefined, hidden: false };
  const offset = (facts.lineOffsets[ref.line - 1] ?? 0) + ref.column;
  const key = name.toLowerCase();
  const candidates = facts.routines.get(key) ?? [];
  let shadowed = false;
  let hidden = false;
  let origin: Routine | null = null;
  for (let scope = routineAt(facts, offset); scope; origin = scope, scope = scope.parent) {
    const child = candidates.find(r => r.parent === scope);
    if (child) {
      if (declaredBefore(facts, scope, key, child, origin)) {
        return { routine: shadowed ? null : routineNode(child, ref.filePath, facts, context), hidden };
      }
      hidden = true;
    }
    if (scope.locals.get(key)?.some(b => b.start < offset && offset < b.end)) shadowed = true;
  }
  return { routine: undefined, hidden };
}

export function lexicalRoutine(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null | undefined {
  const found = lookup(name, ref, context);
  return found.routine === undefined && found.hidden ? null : found.routine;
}

export function matchNestedRoutine(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language !== 'pascal' || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'function_ref')) return undefined;
  let name = ref.referenceName.replace(/\(\)/g, '');
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    const parts = name.split('.');
    const head = parts[0]!;
    if (parts.length < 2 || !/^[A-Za-z_]\w*$/.test(head)) return undefined;
    const facts = sourceFacts(ref.filePath, context);
    const offset = (facts.lineOffsets[ref.line - 1] ?? 0) + ref.column;
    const synthetic = head.toLowerCase() === 'self' && parts.length === 2 && !/^self\s*\./i.test(facts.text.slice(offset, offset + 80));
    if (!synthetic) {
      const receiver = lexicalRoutine(head, ref, context);
      if (!receiver) return undefined;
      return receiver.returnType && typeNamed(receiver.returnType, receiver.filePath, context) ? undefined : null;
    }
    name = parts[1]!;
    if (!lexicalRoutine(name, ref, context)) return undefined;
  }
  const found = lookup(name, ref, context);
  const facts = sourceFacts(ref.filePath, context);
  const key = name.toLowerCase();
  let target = found.routine;
  if (target === undefined) {
    if (!found.hidden && !facts.routines.get(key)?.some(r => r.parent)) return undefined;
    const owner = ownerOf(ref, context);
    const plain = context.getNodesByLowerName(key).filter(n => n.language === 'pascal' && n.kind === 'function' &&
      !n.qualifiedName.includes('::'));
    const local = plain.filter(n => n.filePath === ref.filePath);
    target = (owner && methodOn(owner, name, context)) ?? local[0] ?? (plain.length === 1 ? plain[0]! : null);
  }
  if (target === null) return null;
  const offset = (facts.lineOffsets[ref.line - 1] ?? 0) + ref.column;
  const assignment = facts.assignments.get(offset);
  const declaration = declarationText(target, context).trim();
  const procedure = /^(?:class\s+)?procedure\b/i.test(declaration);
  const returned = target.returnType ?? /^(?:class\s+)?function\s+[\w.]+\s*(?:\([^)]*\))?\s*:\s*([A-Za-z_][\w.]*)/i.exec(declaration)?.[1] ?? null;
  const destination = assignment ? assignmentDestination(offset, ref, context) : null;
  const returnsCallback = isProceduralType(returned, target.filePath, context) ||
    (!!destination && returned?.toLowerCase() === destination.toLowerCase());
  const pointer = ref.referenceKind === 'function_ref' || (!!assignment && assignment.rhs === key &&
    (assignment.addressOf || procedure || (!returnsCallback && isProceduralType(destination, ref.filePath, context))));
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.95,
    resolvedBy: pointer ? 'function-ref' : 'exact-match',
    ...(pointer ? { edgeKind: 'references' as const, metadata: { fnRef: true } } : {}),
  };
}
