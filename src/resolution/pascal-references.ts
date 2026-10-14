import type { Node } from '../types';
import { lexicalRoutine } from './pascal-nested';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

interface Assignment {
  lhs: string;
  rhs: string;
  addressOf: boolean;
  rooted: boolean;
  target: string[] | null;
}

interface LocalBinding {
  type: string;
  start: number;
  end: number;
}

export interface Routine {
  name: string;
  start: number;
  end: number;
  body: boolean;
  parent?: Routine;
  blocks: Array<{ kind: string; start: number; end: number }>;
  openBlocks: Array<{ kind: string; start: number; end: number }>;
  locals: Map<string, LocalBinding[]>;
}

export interface SourceFacts {
  text: string;
  lineOffsets: number[];
  assignments: Map<number, Assignment>;
  routines: Map<string, Routine[]>;
}

const SOURCES = new WeakMap<ResolutionContext, Map<string, SourceFacts>>();
const MEMBERS = new WeakMap<ResolutionContext, Map<string, string | null>>();
const DECLARATIONS = new WeakMap<ResolutionContext, Map<string, string>>();
const CLASS_MEMBERS = new WeakMap<ResolutionContext, Map<string, Node[]>>();
const GENERICS = new WeakMap<ResolutionContext, Map<string, Node[]>>();

export function clearPascalReferenceMemos(context: ResolutionContext): void {
  SOURCES.delete(context);
  MEMBERS.delete(context);
  DECLARATIONS.delete(context);
  CLASS_MEMBERS.delete(context);
  GENERICS.delete(context);
}

const ROUTINE_NAME_KEYWORDS = /^(?:begin|of|var|const|type|label)$/i;
const BODYLESS_DIRECTIVES = new Set(['overload', 'inline', 'stdcall', 'cdecl', 'pascal', 'register', 'safecall',
  'varargs', 'assembler', 'platform', 'deprecated', 'experimental', 'local', 'export', 'far', 'near', 'dynamic',
  'virtual', 'override', 'reintroduce', 'abstract', 'final', 'static', 'message', 'unsafe', 'delayed']);

function hasNoBody(text: string, from: number): boolean {
  let depth = 0;
  let at = from;
  for (; at < text.length; at++) {
    const c = text[at];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth <= 0) break;
  }
  if (at >= text.length) return false;
  const directive = /\s*([A-Za-z]+)[^;]*;/y;
  directive.lastIndex = at + 1;
  for (let m = directive.exec(text); m; m = directive.exec(text)) {
    const word = m[1]!.toLowerCase();
    if (word === 'forward' || word === 'external') return true;
    if (!BODYLESS_DIRECTIVES.has(word)) return false;
  }
  return false;
}

function typeBodyEnd(text: string, from: number): number {
  const scan = /=\s*(?:packed\s+)?(?:class|object|interface)\b(?!\s*(?:of\b|(?:\([^)]*\))?\s*;))|\brecord\b|\bend\b/gi;
  scan.lastIndex = from;
  let depth = 1;
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    if (m[0].toLowerCase() === 'end') {
      if (--depth === 0) return scan.lastIndex;
    } else depth++;
  }
  return text.length;
}

function indexRoutines(text: string): Map<string, Routine[]> {
  const routines: Routine[] = [];
  let current: Routine | undefined;
  const implementation = /\bimplementation\b/i.exec(text)?.index ?? 0;
  const tokens = /\b(?:procedure|function|constructor|destructor)\s+([\w.]+)|\b(begin|end|case|try|record|asm)\b|=\s*(?:packed\s+)?(?:class|object|interface)\b/gi;
  const forwardType = /\s*(?:of\b|(?:\([^)]*\))?\s*;)/iy;
  tokens.lastIndex = implementation;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text))) {
    if (token[0].startsWith('=')) {
      forwardType.lastIndex = tokens.lastIndex;
      if (forwardType.test(text)) continue;
      const end = typeBodyEnd(text, tokens.lastIndex);
      current?.blocks.push({ kind: 'record', start: token.index, end });
      tokens.lastIndex = end;
    } else if (token[1]) {
      if (ROUTINE_NAME_KEYWORDS.test(token[1])) {
        tokens.lastIndex -= token[1].length;
        continue;
      }
      if (hasNoBody(text, tokens.lastIndex)) continue;
      current = {
        name: token[1].toLowerCase(), start: token.index, end: text.length, body: false,
        parent: current, blocks: [], openBlocks: [], locals: new Map(),
      };
      routines.push(current);
    } else if (token[2]!.toLowerCase() === 'record') {
      const end = typeBodyEnd(text, tokens.lastIndex);
      current?.blocks.push({ kind: 'record', start: token.index, end });
      tokens.lastIndex = end;
    } else if (current) {
      const kind = token[2]!.toLowerCase();
      if (kind === 'end') {
        const block = current.openBlocks.pop();
        if (block) block.end = tokens.lastIndex;
        if (current.body && current.openBlocks.length === 0) {
          current.end = tokens.lastIndex;
          current = current.parent;
        }
      } else if (!(kind === 'case' && current.openBlocks.some(b => b.kind === 'record'))) {
        if ((kind === 'begin' || kind === 'asm') && current.openBlocks.length === 0) current.body = true;
        const block = { kind, start: token.index, end: text.length };
        current.blocks.push(block);
        current.openBlocks.push(block);
      }
    }
  }
  const declarations = /\b([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*((?:array(?:\s*\[[^\]]*\])?\s+of\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/gi;
  let routineIndex = 0;
  for (const declaration of text.matchAll(declarations)) {
    const offset = declaration.index!;
    while (routineIndex + 1 < routines.length && routines[routineIndex + 1]!.start <= offset) routineIndex++;
    let routine = routines[routineIndex];
    while (routine && (routine.start > offset || routine.end <= offset)) routine = routine.parent;
    if (!routine) continue;
    const block = routine.blocks.find(b => (b.kind === 'record') && b.start < offset && offset < b.end);
    if (block) continue;
    const scope = routine.blocks.filter(b => b.kind === 'begin' && b.start < offset && offset < b.end).pop();
    for (const name of declaration[1]!.split(',')) {
      const key = name.trim().toLowerCase();
      let bindings = routine.locals.get(key);
      if (!bindings) routine.locals.set(key, bindings = []);
      bindings.push({ type: declaration[2]!, start: offset, end: scope?.end ?? routine.end });
    }
  }
  const byName = new Map<string, Routine[]>();
  for (const routine of routines) {
    let named = byName.get(routine.name);
    if (!named) byName.set(routine.name, named = []);
    named.push(routine);
  }
  return byName;
}

function openingBracket(text: string, close: number): number {
  const opener = text[close] === ']' ? '[' : '(';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = text[i];
    if (ch === text[close]) depth++;
    else if (ch === opener && --depth === 0) return i;
  }
  return -1;
}

function receiverBefore(text: string, end: number): string[] | null {
  const segments: string[] = [];
  let i = end;
  const skip = (): void => { while (i > 0 && /\s/.test(text[i - 1]!)) i--; };
  for (;;) {
    skip();
    if (text[i - 1] !== '.' || text[i - 2] === '.') return null;
    i--;
    skip();
    let suffix = '';
    if (text[i - 1] === ']') {
      i = openingBracket(text, i - 1);
      if (i < 0 || text[i - 1] === ']') return null;
      suffix = '[]';
    } else if (text[i - 1] === ')') {
      const open = openingBracket(text, i - 1);
      if (open < 0) return null;
      const inner = text.slice(open + 1, i - 1);
      i = open;
      if (/\w/.test(text[i - 1] ?? '')) suffix = '()';
      else {
        const type = /\bas\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/i.exec(inner)?.[1];
        skip();
        if (!type || /[.\])^]/.test(text[i - 1] ?? '')) return null;
        segments.push(type.replace(/\s/g, ''));
        return segments.reverse();
      }
    }
    let start = i;
    while (start > 0 && /\w/.test(text[start - 1]!)) start--;
    const name = text.slice(start, i);
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    segments.push(name + suffix);
    i = start;
    skip();
    if (text[i - 1] !== '.') return /[\])]/.test(text[i - 1] ?? '') ? null : segments.reverse();
  }
}

export function sourceFacts(file: string, context: ResolutionContext): SourceFacts {
  let files = SOURCES.get(context);
  if (!files) SOURCES.set(context, files = new Map());
  const cached = files.get(file);
  if (cached) return cached;
  const text = (context.readFile(file) ?? '').replace(/'(?:''|[^'])*'|\{[^}]*\}|\(\*[\s\S]*?\*\)|\/\/[^\r\n]*/g,
    value => value.replace(/[^\r\n]/g, ' '));
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineOffsets.push(i + 1);
  const assignments = new Map<number, Assignment>();
  const pattern = /\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*:=\s*(@\s*)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*(?=;|\b(?:else|end|until)\b)/gi;
  for (const match of text.matchAll(pattern)) {
    const rhs = match.index! + match[0].indexOf(':=') + 2;
    const value = rhs + (match[0].slice(match[0].indexOf(':=') + 2).match(/^\s*@?\s*/)?.[0].length ?? 0);
    const lhs = match[1]!.replace(/\s/g, '');
    const rooted = /[.\])]\s*$/.test(text.slice(Math.max(0, match.index! - 40), match.index));
    const target = rooted ? receiverBefore(text, match.index!)?.concat(lhs.split('.')) ?? null : lhs.split('.');
    assignments.set(value, { lhs, rhs: match[3]!.replace(/\s/g, '').toLowerCase(), addressOf: !!match[2], rooted, target });
  }
  const facts = { text, lineOffsets, assignments, routines: indexRoutines(text) };
  files.set(file, facts);
  return facts;
}

export function declarationText(node: Node, context: ResolutionContext): string {
  let declarations = DECLARATIONS.get(context);
  if (!declarations) DECLARATIONS.set(context, declarations = new Map());
  const cached = declarations.get(node.id);
  if (cached !== undefined) return cached;
  const facts = sourceFacts(node.filePath, context);
  const text = facts.text.slice((facts.lineOffsets[node.startLine - 1] ?? 0) + node.startColumn,
    (facts.lineOffsets[node.endLine - 1] ?? 0) + node.endColumn);
  declarations.set(node.id, text);
  return text;
}

function genericTypes(context: ResolutionContext): Map<string, Node[]> {
  let memo = GENERICS.get(context);
  if (memo) return memo;
  GENERICS.set(context, memo = new Map());
  for (const kind of ['class', 'interface'] as const) {
    const nodes = context.iterateNodesByKind ? context.iterateNodesByKind(kind) : context.getNodesByKind(kind);
    for (const node of nodes) {
      const base = node.language === 'pascal' ? /^([A-Za-z_]\w*)\s*</.exec(node.name)?.[1]?.toLowerCase() : undefined;
      if (!base) continue;
      let named = memo.get(base);
      if (!named) memo.set(base, named = []);
      named.push(node);
    }
  }
  return memo;
}

export function typeNamed(name: string, file: string, context: ResolutionContext, skip?: Set<string>): Node | null {
  const simple = name.split('.').pop()!.toLowerCase();
  const types = [...context.getNodesByLowerName(simple), ...(genericTypes(context).get(simple) ?? [])].filter(n => n.language === 'pascal' &&
    (n.kind === 'class' || n.kind === 'interface' || n.kind === 'type_alias') && !skip?.has(n.id));
  const local = types.filter(n => n.filePath === file);
  const pool = local.length ? local : types;
  const defined = pool.filter(n => (n.kind === 'class' || n.kind === 'interface') && /\bend\b/i.test(declarationText(n, context)));
  const candidates = defined.length ? defined : pool;
  const found = candidates.length === 1 ? candidates[0]! : null;
  if (found?.kind !== 'type_alias') return found;
  const rhs = /=\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*;/.exec(declarationText(found, context))?.[1]?.replace(/\s/g, '');
  if (!rhs || rhs.split('.').pop()!.toLowerCase() !== simple) return found;
  return typeNamed(rhs, found.filePath, context, new Set([...(skip ?? []), found.id])) ?? found;
}

function ownerName(caller: Node | null | undefined, context: ResolutionContext): string | undefined {
  if (!caller) return undefined;
  const parts = caller.qualifiedName.split('::');
  if (caller.kind !== 'function' || parts.length < 2) return parts.slice(-2, -1)[0];
  const root = context.getNodesByQualifiedName(`${parts[0]}::${parts[1]}`)
    .find(n => n.kind === 'method' && n.filePath === caller.filePath);
  return root ? parts[0] : undefined;
}

export function ownerOf(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const owner = ownerName(context.getNodeById?.(ref.fromNodeId), context);
  return owner ? typeNamed(owner, ref.filePath, context) : null;
}

export function routineAt(facts: SourceFacts, offset: number): Routine | undefined {
  let innermost: Routine | undefined;
  for (const group of facts.routines.values()) {
    for (const r of group) {
      if (r.start <= offset && offset < r.end && (!innermost || r.start > innermost.start)) innermost = r;
    }
  }
  return innermost;
}

export function declaredType(text: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}(?:\\s*,\\s*[A-Za-z_]\\w*)*\\s*:\\s*((?:array(?:\\s*\\[[^\\]]*\\])?\\s+of\\s+)?[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)`, 'i');
  return pattern.exec(text)?.[1] ?? null;
}

export function classMembers(type: Node, name: string, context: ResolutionContext): Node[] {
  let memo = CLASS_MEMBERS.get(context);
  if (!memo) CLASS_MEMBERS.set(context, memo = new Map());
  const key = `${type.id}|${name.toLowerCase()}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const qualified = `${type.qualifiedName}::${name}`.toLowerCase();
  const members = context.getNodesByLowerName(name.toLowerCase()).filter(n => n.language === 'pascal' &&
    n.filePath === type.filePath && n.qualifiedName.toLowerCase() === qualified);
  memo.set(key, members);
  return members;
}

function memberType(type: Node, name: string, context: ResolutionContext, seen = new Set<string>()): string | null {
  if (seen.has(type.id)) return null;
  seen.add(type.id);
  let memo = MEMBERS.get(context);
  if (!memo) MEMBERS.set(context, memo = new Map());
  const key = `${type.id}|${name.toLowerCase()}`;
  if (memo.has(key)) return memo.get(key)!;
  const text = declarationText(type, context);
  const members = classMembers(type, name, context);
  const value = members.find(n => n.kind === 'field' || n.kind === 'property');
  let found = value ? declaredType(declarationText(value, context), name) : members.find(n => n.kind === 'method')?.returnType ?? null;
  if (!found) {
    const parents = /\b(?:class|interface)\s*\(([^)]*)\)/i.exec(text)?.[1];
    for (const parent of parents?.split(',') ?? []) {
      const node = typeNamed(parent.trim(), type.filePath, context);
      if (node) found = memberType(node, name, context, seen);
      if (found) break;
    }
  }
  memo.set(key, found);
  return found;
}

export function localType(name: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const facts = sourceFacts(ref.filePath, context);
  const offset = (facts.lineOffsets[ref.line - 1] ?? 0) + ref.column;
  const caller = context.getNodeById?.(ref.fromNodeId);
  if (caller?.kind !== 'method' && caller?.kind !== 'function') return null;
  for (let routine = routineAt(facts, offset); routine; routine = routine.parent) {
    const bindings = routine.locals.get(name.toLowerCase());
    if (!bindings) continue;
    for (let i = bindings.length - 1; i >= 0; i--) {
      const binding = bindings[i]!;
      if (binding.start < offset && offset < binding.end) return binding.type;
    }
  }
  return null;
}

function rootDeclaration(name: string, ref: UnresolvedRef, context: ResolutionContext): { type: string; file: string } | null {
  const local = localType(name, ref, context);
  if (local) return { type: local, file: ref.filePath };
  const owner = ownerOf(ref, context);
  const field = owner && memberType(owner, name, context);
  if (field) return { type: field, file: owner!.filePath };
  const variables = context.getNodesByLowerName(name.toLowerCase()).filter(n => n.language === 'pascal' &&
    n.kind === 'variable' && !n.qualifiedName.includes('::'));
  const localGlobals = variables.filter(n => n.filePath === ref.filePath);
  const imports = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'import').map(n => n.name.toLowerCase());
  const candidates = localGlobals.length ? localGlobals : variables.filter(n =>
    context.getNodesInFile(n.filePath).some(m => m.kind === 'module' && imports.includes(m.name.toLowerCase())));
  if (candidates.length !== 1) return null;
  const variable = candidates[0]!;
  const type = declaredType(declarationText(variable, context), name);
  return type ? { type, file: variable.filePath } : null;
}

export function rootType(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const owner = ownerOf(ref, context);
  if (name.toLowerCase() === 'self') return owner;
  const nested = lexicalRoutine(name, ref, context);
  if (nested) return nested.returnType ? typeNamed(nested.returnType, nested.filePath, context) : null;
  const indexed = name.endsWith('[]');
  const declared = rootDeclaration(indexed ? name.slice(0, -2) : name, ref, context);
  const declaredName = indexed ? declared?.type.replace(/^array(?:\s*\[[^\]]*\])?\s+of\s+/i, '') : declared?.type;
  return declaredName ? typeNamed(declaredName, declared!.file, context) : typeNamed(name, ref.filePath, context);
}

export function methodOn(type: Node, name: string, context: ResolutionContext, seen = new Set<string>()): Node | null {
  if (seen.has(type.id)) return null;
  seen.add(type.id);
  const members = classMembers(type, name, context);
  if (members.some(n => n.kind === 'field' || n.kind === 'property')) return null;
  const matches = members.filter(n => n.kind === 'method');
  if (matches.length > 0) return matches[0]!;
  const parents = /\b(?:class|interface)\s*\(([^)]*)\)/i.exec(declarationText(type, context))?.[1];
  for (const parent of parents?.split(',') ?? []) {
    const node = typeNamed(parent.trim(), type.filePath, context);
    const found = node && methodOn(node, name, context, seen);
    if (found) return found;
  }
  return null;
}

export function pathType(path: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const parts = path.split('.');
  const first = parts.shift()!;
  if (!parts.length) {
    const owner = ownerOf(ref, context);
    return localType(first, ref, context) ?? (owner && memberType(owner, first, context));
  }
  let type = rootType(first, ref, context);
  for (let i = 0; type && i < parts.length; i++) {
    const name = parts[i]!;
    const next = memberType(type, name, context) ?? methodOn(type, name, context)?.returnType ?? null;
    if (i === parts.length - 1) return next;
    type = next ? typeNamed(next, type.filePath, context) : null;
  }
  return null;
}

export type ProceduralKind = 'function' | 'procedure';

export function proceduralKind(name: string | null, file: string, context: ResolutionContext, seen = new Set<string>()): ProceduralKind | null {
  if (!name) return null;
  if (/^(?:function|procedure)$/i.test(name)) return name.toLowerCase() as ProceduralKind;
  const node = typeNamed(name, file, context);
  if (!node || node.kind !== 'type_alias' || seen.has(node.id)) return null;
  seen.add(node.id);
  const rhs = /=\s*([\s\S]*?);/.exec(declarationText(node, context))?.[1]?.trim();
  if (!rhs) return null;
  const kind = /^(?:reference\s+to\s+)?(function|procedure)\b/i.exec(rhs)?.[1];
  if (kind) return kind.toLowerCase() as ProceduralKind;
  return /^[\w.]+$/.test(rhs) ? proceduralKind(rhs, node.filePath, context, seen) : null;
}

export function isProceduralType(name: string | null, file: string, context: ResolutionContext): boolean {
  return proceduralKind(name, file, context) !== null;
}

export function isUnitQualifier(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!context.getNodesByLowerName(name.toLowerCase()).some(n => n.language === 'pascal' && n.kind === 'module')) return false;
  if (localType(name, ref, context)) return false;
  const owner = ownerOf(ref, context);
  return !(owner && memberDecl(owner, name, context));
}

export function matchPascalReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language !== 'pascal' || (ref.referenceKind !== 'calls' && ref.referenceKind !== 'function_ref')) return undefined;
  const parts = ref.referenceName.replace(/\(\)/g, '').split('.');
  if (parts.length < 2) return callsEventMember(ref, context) ? null : undefined;
  let root = parts.shift()!;
  if (isUnitQualifier(root, ref, context)) {
    root = parts.shift()!;
    if (!root || !parts.length) return null;
  }
  const facts = sourceFacts(ref.filePath, context);
  const offset = (facts.lineOffsets[ref.line - 1] ?? 0) + ref.column;
  if (root.toLowerCase() === 'self' && !/^self\s*\./i.test(facts.text.slice(offset, offset + 80)) &&
      localType(parts[0]!, ref, context)) return null;
  let type = root.endsWith('[]') ? indexedRootType(root.slice(0, -2), ref, context) : rootType(root, ref, context);
  if (!type) return root.toLowerCase() === 'self' || parts.length > 1 ? null : undefined;
  let method: Node | null = null;
  while (type && parts.length) {
    const part = parts.shift()!;
    const indexed = part.endsWith('[]');
    const name = indexed ? part.slice(0, -2) : part;
    method = methodOn(type, name, context);
    if (!parts.length) break;
    if (indexed) {
      const decl = memberDecl(type, name, context);
      const element = decl && (decl.decl.kind === 'field' || decl.decl.kind === 'property')
        ? memberElement(decl.decl, context)
        : method?.returnType ? arrayElement(method.returnType, method.filePath, context) : null;
      type = element ? typeNamed(element.type, element.file, context) : null;
      method = null;
      continue;
    }
    const constructor = method
      ? /\bconstructor\b/i.test(declarationText(method, context))
      : name.toLowerCase() === 'create';
    const next: string | null = constructor ? type.name : method?.returnType ?? memberType(type, name, context);
    type = next ? typeNamed(next, type.filePath, context) : null;
  }
  if (!type || !method) return null;
  const assignment = facts.assignments.get(offset);
  const destination = assignment && (assignment.rooted ? rootedDestination(assignment, ref, context) : pathType(assignment.lhs, ref, context));
  const returnsCallback = isProceduralType(method.returnType ?? null, method.filePath, context) ||
    (!!destination && method.returnType?.toLowerCase() === destination.toLowerCase());
  const procedure = /^(?:class\s+)?procedure\b/i.test(declarationText(method, context).trim());
  const pointer = assignment && assignment.rhs === ref.referenceName.toLowerCase() &&
    (assignment.addressOf || procedure || (!returnsCallback && isProceduralType(destination ?? null, ref.filePath, context)));
  return {
    original: ref,
    targetNodeId: method.id,
    confidence: 0.9,
    resolvedBy: pointer || ref.referenceKind === 'function_ref' ? 'function-ref' : 'instance-method',
    ...(pointer ? { edgeKind: 'references' as const, metadata: { fnRef: true } } : {}),
  };
}

function parentsOf(type: Node, context: ResolutionContext): string[] {
  const parents = /\b(?:class|interface)\s*\(([^)]*)\)/i.exec(declarationText(type, context))?.[1];
  return parents?.split(',').map(p => p.trim()).filter(Boolean) ?? [];
}

export interface MemberDeclaration {
  decl: Node;
  type: Node;
}

export function memberDecl(type: Node, name: string, context: ResolutionContext, seen = new Set<string>()): MemberDeclaration | null {
  if (seen.has(type.id)) return null;
  seen.add(type.id);
  const members = classMembers(type, name, context);
  const own = members.find(n => n.kind === 'field' ||
      (n.kind === 'property' && (declaredType(declarationText(n, context), n.name) !== null ||
        indexedPropertyType(n, context) !== null))) ??
    members.find(n => n.kind === 'method');
  if (own) return { decl: own, type };
  for (const parent of parentsOf(type, context)) {
    const node = typeNamed(parent, type.filePath, context);
    const found = node && memberDecl(node, name, context, seen);
    if (found) return found;
  }
  return null;
}

export interface EventChannel {
  key: string;
  decl: Node;
  typeName: string;
  kind: ProceduralKind;
}

export function eventMemberKind(decl: Node, context: ResolutionContext): { typeName: string; kind: ProceduralKind } | null {
  if (decl.kind !== 'field' && decl.kind !== 'property') return null;
  const typeName = declaredType(declarationText(decl, context), decl.name);
  if (!typeName) return null;
  const inline = /^(?:function|procedure)$/i.test(typeName) ? typeName.toLowerCase() as ProceduralKind : null;
  const kind = inline ?? proceduralKind(typeName, decl.filePath, context);
  return kind ? { typeName, kind } : null;
}

function propertySpecifiers(decl: Node, context: ResolutionContext): string {
  const facts = sourceFacts(decl.filePath, context);
  const start = (facts.lineOffsets[decl.startLine - 1] ?? 0) + decl.startColumn;
  const end = facts.text.indexOf(';', start);
  return facts.text.slice(start, end < 0 ? undefined : end);
}

export function channelOf(decl: Node, owner: Node, context: ResolutionContext): EventChannel | null {
  const member = eventMemberKind(decl, context);
  if (!member) return null;
  if (decl.kind === 'property') {
    const text = propertySpecifiers(decl, context);
    for (const accessor of [/\bread\s+([A-Za-z_]\w*)/i, /\bwrite\s+([A-Za-z_]\w*)/i]) {
      const name = accessor.exec(text)?.[1];
      const backing = name && memberDecl(owner, name, context);
      if (backing && backing.decl.kind === 'field') return channelOf(backing.decl, backing.type, context);
    }
  }
  return { key: decl.id, decl, ...member };
}

export interface ChainResult {
  type: Node | null;
  hit?: { channel: EventChannel; index: number };
}

const ARRAY_OF = /^array(?:\s*\[[^\]]*\])?\s+of\s+/i;

interface ChainStep {
  name: string;
  indexed: boolean;
  call: boolean;
}

function chainStep(segment: string): ChainStep {
  const call = segment.endsWith('()');
  const base = call ? segment.slice(0, -2) : segment;
  const indexed = base.endsWith('[]');
  return { name: indexed ? base.slice(0, -2) : base, indexed, call };
}

function indexedPropertyType(decl: Node, context: ResolutionContext): string | null {
  const escaped = decl.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\s*\\[[^\\]]*\\]\\s*:\\s*([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)`, 'i');
  return pattern.exec(declarationText(decl, context))?.[1] ?? null;
}

function defaultElement(type: Node, context: ResolutionContext, seen = new Set<string>()): { type: string; file: string } | null {
  if (seen.has(type.id)) return null;
  seen.add(type.id);
  const pattern = /\bproperty\s+[A-Za-z_]\w*\s*\[[^\]]*\]\s*:\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[^;]*;\s*default\s*;/i;
  const parameters = (type.name.match(/<(.*)>/)?.[1] ?? '').split(',').map(p => p.trim().toLowerCase());
  const found = pattern.exec(declarationText(type, context))?.[1];
  if (found) return parameters.includes(found.toLowerCase()) ? null : { type: found, file: type.filePath };
  for (const parent of parentsOf(type, context)) {
    const node = typeNamed(parent, type.filePath, context);
    const inherited = node && defaultElement(node, context, seen);
    if (inherited) return inherited;
  }
  return null;
}

function arrayElement(declared: string, file: string, context: ResolutionContext): { type: string; file: string } | null {
  const direct = declared.replace(ARRAY_OF, '');
  if (direct !== declared) return { type: direct, file };
  const named = typeNamed(declared, file, context);
  if (!named) return null;
  if (named.kind !== 'type_alias') return defaultElement(named, context);
  const rhs = /=\s*([\s\S]*?);/.exec(declarationText(named, context))?.[1]?.trim();
  const element = rhs && /^array(?:\s*\[[^\]]*\])?\s+of\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/i.exec(rhs)?.[1];
  return element ? { type: element, file: named.filePath } : null;
}

function memberElement(decl: Node, context: ResolutionContext): { type: string; file: string } | null {
  const indexed = decl.kind === 'property' ? indexedPropertyType(decl, context) : null;
  if (indexed) return { type: indexed, file: decl.filePath };
  const declared = declaredType(declarationText(decl, context), decl.name);
  return declared ? arrayElement(declared, decl.filePath, context) : null;
}

function indexedRootType(name: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const declared = rootDeclaration(name, ref, context);
  const element = declared && arrayElement(declared.type, declared.file, context);
  return element ? typeNamed(element.type, element.file, context) : null;
}

export function resolveChain(segments: string[], ref: UnresolvedRef, context: ResolutionContext): ChainResult {
  const steps = segments.map(chainStep);
  const owner = ownerOf(ref, context);
  const head = steps[0]!;
  const qualified = steps.length > 1 && !head.indexed && !head.call && isUnitQualifier(head.name, ref, context);
  const base = qualified ? 1 : 0;
  const first = steps[base]!;
  let type: Node | null;
  let index: number;
  if (first.name.toLowerCase() === 'self' && !first.indexed) {
    type = owner;
    index = base + 1;
  } else if (!localType(first.name, ref, context) && !lexicalRoutine(first.name, ref, context) && owner && memberDecl(owner, first.name, context)) {
    type = owner;
    index = base;
  } else {
    type = first.indexed ? indexedRootType(first.name, ref, context) : rootType(first.name, ref, context);
    index = base + 1;
  }
  for (; type && index < steps.length; index++) {
    const step = steps[index]!;
    const found = memberDecl(type, step.name, context);
    if (!found) return { type: null };
    const { decl } = found;
    if (decl.kind === 'field' || decl.kind === 'property') {
      if (step.call) return { type: null };
      if (step.indexed) {
        const element = memberElement(decl, context);
        type = element ? typeNamed(element.type, element.file, context) : null;
        continue;
      }
      const channel = channelOf(decl, found.type, context);
      if (channel) return { type: null, hit: { channel, index } };
      const declared = declaredType(declarationText(decl, context), decl.name);
      type = declared ? typeNamed(declared, decl.filePath, context) : null;
    } else if (step.indexed) {
      return { type: null };
    } else if (/\bconstructor\b/i.test(declarationText(decl, context))) {
      type = found.type;
    } else {
      type = decl.returnType ? typeNamed(decl.returnType, decl.filePath, context) : null;
    }
  }
  return { type };
}

function rootedDestination(assignment: Assignment, ref: UnresolvedRef, context: ResolutionContext): string | null {
  if (!assignment.target) return null;
  const hit = resolveChain(assignment.target, ref, context).hit;
  return hit && hit.index === assignment.target.length - 1 ? hit.channel.typeName : null;
}

export function assignmentDestination(offset: number, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const assignment = sourceFacts(ref.filePath, context).assignments.get(offset);
  if (!assignment) return null;
  return assignment.rooted ? rootedDestination(assignment, ref, context) : pathType(assignment.lhs, ref, context);
}

function callsEventMember(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  const name = ref.referenceName.replace(/\(\)/g, '');
  if (!/^[A-Za-z_]\w*$/.test(name) || localType(name, ref, context)) return false;
  const owner = ownerOf(ref, context);
  const found = owner && memberDecl(owner, name, context);
  return !!found && channelOf(found.decl, found.type, context) !== null;
}
