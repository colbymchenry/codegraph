import type { Edge, Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import type { MaybeYield } from './cooperative-yield';
import {
  clearPascalReferenceMemos, eventMemberKind, isProceduralType, isUnitQualifier, localType, methodOn, ownerOf,
  pathType, proceduralKind, resolveChain, routineAt, sourceFacts,
  type EventChannel, type SourceFacts,
} from './pascal-references';
import { lexicalRoutine, routineNode } from './pascal-nested';

const PASCAL_SOURCE = /\.(?:pas|dpr|lpr|pp)$/i;
const PATH = /(?<![\w.@&$])(@\s*)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)/g;
const STATEMENT_START = /(?:;|\b(?:begin|then|else|do|try|finally|except))\s*$/i;
const STATEMENT_END = /\s*(?:;|\b(?:end|else|until)\b)/iy;
const EXPRESSION_START = /(?::=|[-+*\/=<>]|\b(?:if|while|until|and|or|xor|not|div|mod|shl|shr|in)\b)\s*$/i;
const NIL_AFTER = /\s*(?:=|<>)\s*nil\b/iy;
const NIL_BEFORE = /\bnil\s*(?:=|<>)\s*$/i;
const ASSIGNMENT_TARGET = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*:=\s*$/;

interface Registration {
  handler: Node;
  registeredAt: string;
}

interface Channels {
  channel: EventChannel;
  registrations: Registration[];
}

function refAt(file: string, offset: number, fromNodeId: string, facts: SourceFacts): UnresolvedRef {
  let low = 0;
  let high = facts.lineOffsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (facts.lineOffsets[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return {
    fromNodeId, referenceName: '', referenceKind: 'calls', line: low + 1,
    column: offset - facts.lineOffsets[low]!, filePath: file, language: 'pascal',
  };
}

function moduleName(file: string, context: ResolutionContext): string | null {
  return context.getNodesInFile(file).find(n => n.kind === 'module')?.name.toLowerCase() ?? null;
}

function standaloneFunction(name: string, unit: string | null, file: string, context: ResolutionContext): Node | null {
  const functions = context.getNodesByLowerName(name).filter(n => n.language === 'pascal' && n.kind === 'function' &&
    !n.qualifiedName.includes('::'));
  const pick = (pool: Node[]): Node | null => pool.sort((a, b) => a.startLine - b.startLine)[0] ?? null;
  if (unit) return pick(functions.filter(n => moduleName(n.filePath, context) === unit));
  const local = functions.filter(n => n.filePath === file);
  if (local.length > 0) return pick(local);
  const imports = new Set(context.getNodesInFile(file).filter(n => n.kind === 'import').map(n => n.name.toLowerCase()));
  const visible = functions.filter(n => imports.has(moduleName(n.filePath, context) ?? ''));
  return visible.length === 1 ? visible[0]! : null;
}

function resolveHandler(rhs: string, ref: UnresolvedRef, channel: EventChannel, context: ResolutionContext): Node | null {
  const segments = rhs.split('.');
  const name = segments.pop()!;
  let handler: Node | null = null;
  if (segments.length === 0) {
    if (localType(name, ref, context)) return null;
    const nested = lexicalRoutine(name, ref, context);
    if (nested !== undefined) handler = nested;
    else {
      const owner = ownerOf(ref, context);
      handler = (owner && methodOn(owner, name, context)) ?? standaloneFunction(name, null, ref.filePath, context);
    }
  } else if (segments.length === 1 && isUnitQualifier(segments[0]!, ref, context)) {
    handler = standaloneFunction(name, segments[0]!, ref.filePath, context);
  } else {
    const chain = resolveChain(segments, ref, context);
    handler = chain.type && methodOn(chain.type, name, context);
  }
  if (!handler || (handler.kind !== 'method' && handler.kind !== 'function')) return null;
  const returnType = handler.returnType?.toLowerCase();
  if (returnType && (returnType === channel.typeName.toLowerCase() || proceduralKind(handler.returnType!, handler.filePath, context))) return null;
  return handler;
}

function isInvocation(
  channel: EventChannel, facts: SourceFacts, start: number, end: number, ref: UnresolvedRef,
  routine: Node, context: ResolutionContext
): boolean {
  const text = facts.text;
  if (/^\s*\(/.test(text.slice(end, end + 8))) return true;
  if (/^\s*:=/.test(text.slice(end, end + 8))) return false;
  const before = text.slice(Math.max(0, start - 120), start);
  STATEMENT_END.lastIndex = end;
  if (STATEMENT_START.test(before) && (STATEMENT_END.test(text) || end >= text.length)) return true;
  if (channel.kind === 'procedure' || !EXPRESSION_START.test(before) || NIL_BEFORE.test(before)) return false;
  NIL_AFTER.lastIndex = end;
  if (NIL_AFTER.test(text)) return false;
  const target = ASSIGNMENT_TARGET.exec(before)?.[1]?.replace(/\s/g, '');
  if (!target) return true;
  const destination = target.toLowerCase() === 'result' ? routine.returnType ?? null : pathType(target, ref, context);
  return !isProceduralType(destination, ref.filePath, context);
}

function eventNames(context: ResolutionContext): Set<string> {
  const names = new Set<string>();
  for (const kind of ['field', 'property'] as const) {
    const nodes = context.iterateNodesByKind ? context.iterateNodesByKind(kind) : context.getNodesByKind(kind);
    for (const node of nodes) {
      if (node.language === 'pascal' && eventMemberKind(node, context)) names.add(node.name.toLowerCase());
    }
  }
  return names;
}

export async function pascalEventEdges(context: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  try {
    const files = context.getAllFiles().filter(f => PASCAL_SOURCE.test(f));
    if (files.length === 0) return [];
    const names = eventNames(context);
    if (names.size === 0) return [];

    const registered = new Map<string, Channels>();
    let scanned = 0;
    for (const file of files) {
      if ((++scanned & 31) === 0) await onYield();
      const facts = sourceFacts(file, context);
      const fileNode = context.getNodesInFile(file).find(n => n.kind === 'file');
      for (const [offset, assignment] of facts.assignments) {
        const target = assignment.target;
        if (!target) continue;
        if (!names.has(target[target.length - 1]!.toLowerCase())) continue;
        const routine = routineAt(facts, offset);
        const from = (routine && routineNode(routine, file, facts, context)) ?? fileNode;
        if (!from) continue;
        const ref = refAt(file, offset, from.id, facts);
        const hit = resolveChain(target, ref, context).hit;
        if (!hit || hit.index !== target.length - 1) continue;
        const handler = resolveHandler(assignment.rhs, ref, hit.channel, context);
        if (!handler) continue;
        let entry = registered.get(hit.channel.key);
        if (!entry) registered.set(hit.channel.key, entry = { channel: hit.channel, registrations: [] });
        entry.registrations.push({ handler, registeredAt: `${file}:${ref.line}` });
      }
    }
    if (registered.size === 0) return [];

    const edges: Edge[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      if ((++scanned & 31) === 0) await onYield();
      const facts = sourceFacts(file, context);
      const routines = [...facts.routines.values()].flat().filter(r => r.body).sort((a, b) => a.start - b.start);
      for (const routine of routines) {
        const begin = routine.blocks.find(b => b.kind === 'begin');
        const dispatcher = begin && routineNode(routine, file, facts, context);
        if (!begin || !dispatcher) continue;
        PATH.lastIndex = begin.start;
        for (let match = PATH.exec(facts.text); match && match.index < routine.end; match = PATH.exec(facts.text)) {
          if (match[1]) continue;
          const segments = match[2]!.replace(/\s/g, '').split('.');
          if (!segments.some(s => names.has(s.toLowerCase()))) continue;
          const start = match.index;
          const ref = refAt(file, start, dispatcher.id, facts);
          const end = start + match[0].length;
          const hit = resolveChain(segments, ref, context).hit;
          const entry = hit && registered.get(hit.channel.key);
          if (!hit || !entry) continue;
          const implicit = hit.index < segments.length - 1 && hit.channel.kind === 'function';
          if (!implicit && !(hit.index === segments.length - 1 &&
              isInvocation(hit.channel, facts, start, end, ref, dispatcher, context))) continue;
          for (const { handler, registeredAt } of entry.registrations) {
            const key = `${dispatcher.id}>${handler.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              source: dispatcher.id, target: handler.id, kind: 'calls', line: ref.line,
              provenance: 'heuristic',
              metadata: {
                synthesizedBy: 'pascal-event',
                via: hit.channel.decl.qualifiedName.replace(/::/g, '.'),
                registeredAt,
              },
            });
          }
        }
      }
    }
    return edges;
  } finally {
    clearPascalReferenceMemos(context);
  }
}
