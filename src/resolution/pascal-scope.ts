/**
 * Pascal names written without parentheses (#2514): a parameterless routine
 * is called that way in Delphi — `Before;`, `Result := FProvider.Value + 1`,
 * `if Ready then` — and the same spelling reads a field, a property, a
 * variable or a constant. The extractor records such a name as a
 * `references` ref named `{mode}.Name` or `{mode}.Receiver.Name`:
 *
 * - `{call}` — a statement on its own, which only a routine can be;
 * - `{read}` — a name in an expression or an argument, where a function
 *   (or a constructor) is called for its value and a procedure, which has
 *   none, can only be a method pointer;
 * - `{ref}` — the value given to an event (`OnClick := Handler`), a method
 *   pointer;
 * - `{recv}` — a receiver (`GetList` in `GetList.Count`, `B` in `A.B.C`) or
 *   an indexed value, which only a function can be.
 *
 * Written without its arguments, a routine that needs some is a method
 * pointer too, in any of them.
 *
 * The routine's class follows an `@` (`{call@TConsumer}.Before`), because the
 * reference's own node is the file when an implementation matched no
 * declaration. A receiver the routine declares itself is written as its
 * declared type after a `:` (`{read}.:TProvider.Value`).
 *
 * This module links such a ref only to a method or function the name reaches
 * by Delphi's scope rules — the routine's class and its ancestors, then the
 * unit, then the units it uses, last first — or, through a receiver, a method
 * of the receiver's declared type. The first declaration of the name in that
 * order decides: when it is data (a field, property, variable, constant, enum
 * value or type), nothing is linked. A bare name the routine declares itself
 * never reaches here (the extractor skips it).
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { declaredSupertypes } from './name-matcher';

type Mode = 'call' | 'read' | 'ref' | 'recv';
interface Found {
  node: Node;
  resolvedBy: ResolvedRef['resolvedBy'];
  confidence: number;
}

const PARENLESS = /^\{(call|read|ref|recv)(?:@([^}]+))?\}\.(.+)$/;
const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface']);
/** What a unit declares by name at its top level. */
const UNIT_KINDS: ReadonlySet<string> = new Set([
  'function', 'variable', 'constant', 'class', 'struct', 'interface', 'enum', 'type_alias', 'enum_member',
]);
/** What a class declares as its members. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'field', 'property', 'constant', 'variable']);
const MAX_HIERARCHY_DEPTH = 8;

/** Whether `ref` is a paren-less Pascal name (see the file comment), which only this module resolves. */
export function isPascalParenlessRef(ref: UnresolvedRef): boolean {
  return ref.language === 'pascal' && ref.referenceKind === 'references' && PARENLESS.test(ref.referenceName);
}

/** The routine a paren-less Pascal name reaches in its scope, or null (see the file comment). */
export function matchPascalParenlessRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = PARENLESS.exec(ref.referenceName);
  if (!m) return null;
  const mode = m[1] as Mode;
  const path = m[3]!.split('.');
  // Most such names read data, often the framework's: a name no Pascal
  // routine has is settled here, before any lookup in scope.
  if (routineNames(context)?.has(path[path.length - 1]!.toLowerCase()) === false) return null;
  let cls: Node | null = null;
  if (m[2]) {
    cls = classByQualifiedName(m[2], ref.filePath!, context);
  } else {
    const routine = context.getNodeById?.(ref.fromNodeId);
    if (routine) cls = classOfRoutine(routine, context);
  }
  const found = path.length === 1 ? nameInScope(path[0]!, cls, ref, context) : memberThroughPath(path, cls, ref, context);
  if (!found) return null;
  // Written without arguments, a routine that needs some can only be a
  // method pointer — save a constructor, whose name then means an inherited
  // one outside the project (`TObject.Create`) — and so is a procedure read
  // for a value, and an event's method; any other runs.
  const needsArgs = needsArguments(found.node);
  if (needsArgs && routineKeyword(found.node, context) === 'constructor') return null;
  const pointer = mode === 'ref' || needsArgs || (mode !== 'call' && !yieldsValue(found.node, context));
  // A statement runs its routine, and a receiver is a routine's value.
  if (pointer && (mode === 'call' || mode === 'recv')) return null;
  const edgeKind = pointer ? 'references' : 'calls';
  context.rememberNode?.(found.node);
  return {
    original: ref,
    targetNodeId: found.node.id,
    confidence: found.confidence,
    resolvedBy: found.resolvedBy,
    edgeKind,
    // A method pointer is a function used as a value, as `@Handler` is (#756).
    ...(edgeKind === 'references' ? { metadata: { fnRef: true } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Scope lookup
// ---------------------------------------------------------------------------

function isRoutine(node: Node): boolean {
  return node.kind === 'method' || node.kind === 'function';
}

/** A bare name, looked up the way Delphi looks it up from a routine of class `cls` (null: a free routine). */
function nameInScope(name: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const lower = name.toLowerCase();
  const memo = memos(context).inScope;
  const key = `${cls?.id ?? ''}|${ref.filePath}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Found | null = null;
  const member = cls ? memberInHierarchy(cls, lower, context) : null;
  if (member) {
    if (isRoutine(member)) found = { node: member, resolvedBy: 'instance-method', confidence: 0.9 };
  } else {
    const own = unitDeclaration(ref.filePath!, lower, context);
    if (own) {
      if (isRoutine(own)) found = { node: own, resolvedBy: 'exact-match', confidence: 0.9 };
    } else {
      const used = usedUnitFiles(ref.filePath!, context);
      for (let i = used.length - 1; i >= 0; i--) {
        const decl = unitDeclaration(used[i]!, lower, context);
        if (!decl) continue;
        if (isRoutine(decl)) found = { node: decl, resolvedBy: 'import', confidence: 0.85 };
        break;
      }
    }
  }
  memo.set(key, found);
  return found;
}

/** A dotted name: the method its receiver's declared type has. */
function memberThroughPath(path: string[], cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const head = headOf(path[0]!, cls, ref, context);
  if (!head) return null;
  let type: Node | null;
  let rest = path.slice(1);
  if (head.unitFile) {
    // `UnitName.Routine`, `UnitName.GlobalVar.Method`.
    const decl = unitDeclaration(head.unitFile, rest[0]!.toLowerCase(), context);
    if (!decl) return null;
    if (rest.length === 1) return isRoutine(decl) ? { node: decl, resolvedBy: 'import', confidence: 0.9 } : null;
    type = typeOfMember(decl, context);
    rest = rest.slice(1);
  } else {
    type = head.type;
  }
  for (const link of rest.slice(0, -1)) {
    const member = type ? memberInHierarchy(type, link.toLowerCase(), context) : null;
    if (!member) return null;
    type = typeOfMember(member, context);
  }
  const member = type ? memberInHierarchy(type, rest[rest.length - 1]!.toLowerCase(), context) : null;
  return member && isRoutine(member) ? { node: member, resolvedBy: 'instance-method', confidence: 0.9 } : null;
}

/**
 * What a dotted name's first link is: a value of a known class (a local's
 * declared type, written `:TFoo`), a class itself, or a unit.
 */
function headOf(name: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): { type: Node | null; unitFile?: string } | null {
  if (name.startsWith(':')) return { type: classNamed(name.slice(1), ref.filePath!, context) };
  const lower = name.toLowerCase();
  if (lower === 'self') return cls ? { type: cls } : null;
  if (cls) {
    const member = memberInHierarchy(cls, lower, context);
    if (member) return { type: typeOfMember(member, context) };
  }
  const decl = unitDeclaration(ref.filePath!, lower, context) ??
    usedUnitFiles(ref.filePath!, context).reduceRight<Node | undefined>((hit, file) => hit ?? unitDeclaration(file, lower, context), undefined);
  if (decl) return { type: CLASS_KINDS.has(decl.kind) ? decl : typeOfMember(decl, context) };
  const unitFile = unitFileNamed(lower, ref.filePath!, context);
  return unitFile ? { type: null, unitFile } : null;
}

// ---------------------------------------------------------------------------
// Classes, units and declarations
// ---------------------------------------------------------------------------

interface Memos {
  routineNames?: Set<string> | null;
  named: Map<string, Node[]>;
  inScope: Map<string, Found | null>;
  classOfRoutine: Map<string, Node | null>;
  classByQn: Map<string, Node | null>;
  ancestors: Map<string, Node[]>;
  usedFiles: Map<string, string[]>;
  classByName: Map<string, Node | null>;
  unitsByName?: Map<string, string[]>;
  unitFiles: Map<string, string | null>;
  hierarchy: Map<string, Node | null>;
  memberTypes: Map<string, Node | null>;
  keywords: Map<string, string | null>;
}
const MEMOS = new WeakMap<ResolutionContext, Memos>();

function memos(context: ResolutionContext): Memos {
  let m = MEMOS.get(context);
  if (!m) {
    m = {
      named: new Map(), inScope: new Map(), classOfRoutine: new Map(), classByQn: new Map(),
      ancestors: new Map(), usedFiles: new Map(), classByName: new Map(), unitFiles: new Map(), hierarchy: new Map(),
      memberTypes: new Map(), keywords: new Map(),
    };
    MEMOS.set(context, m);
  }
  return m;
}

/** Every Pascal method's and function's name, lowercased, or null when the context can't list them. */
function routineNames(context: ResolutionContext): Set<string> | null {
  const memo = memos(context);
  if (memo.routineNames === undefined) {
    const names = context.getNodeNamesOfKinds?.('pascal', ['method', 'function']);
    memo.routineNames = names ? new Set(names.map((n) => n.toLowerCase())) : null;
  }
  return memo.routineNames;
}

/** The Pascal nodes a name names, whatever their case. */
function pascalNamed(lower: string, context: ResolutionContext): Node[] {
  const memo = memos(context).named;
  let nodes = memo.get(lower);
  if (!nodes) {
    nodes = context.getNodesByLowerName(lower).filter((n) => n.language === 'pascal');
    memo.set(lower, nodes);
  }
  return nodes;
}

/** Drops this module's per-context memos (the resolver clears them between runs). */
export function clearPascalScopeMemos(context: ResolutionContext): void {
  MEMOS.delete(context);
}

/**
 * The class (or record) an implementation header names (`TOuter::TInner`,
 * generic parameters dropped): the one `filePath` declares, whatever its case
 * or parameters, else one the file sees.
 */
function classByQualifiedName(qualifiedName: string, filePath: string, context: ResolutionContext): Node | null {
  const memo = memos(context).classByQn;
  const key = `${filePath}|${qualifiedName}`;
  if (memo.has(key)) return memo.get(key)!;
  const exact = context.getNodesByQualifiedName(qualifiedName).filter((n) => n.language === 'pascal' && CLASS_KINDS.has(n.kind));
  const lower = qualifiedName.toLowerCase();
  const cls = declarationOf(exact.filter((n) => n.filePath === filePath)) ??
    declarationOf(context.getNodesInFile(filePath).filter((n) =>
      CLASS_KINDS.has(n.kind) && n.qualifiedName.replace(/<[^>]*>/g, '').toLowerCase() === lower)) ??
    declarationOf(exact) ??
    classNamed(qualifiedName.split('::').pop()!, filePath, context);
  memo.set(key, cls);
  return cls;
}

/**
 * The class declaration among same-named nodes, not a forward declaration
 * (`TFoo = class;`, which names no members or ancestors): the longest one.
 */
function declarationOf(classes: Node[]): Node | null {
  let best: Node | null = null;
  for (const c of classes) if (!best || c.endLine - c.startLine > best.endLine - best.startLine) best = c;
  return best;
}

/** The class a method belongs to: its qualified name's owner, declared in the method's own file. */
function classOfRoutine(routine: Node, context: ResolutionContext): Node | null {
  if (routine.kind !== 'method') return null;
  const memo = memos(context).classOfRoutine;
  if (memo.has(routine.id)) return memo.get(routine.id)!;
  const owner = routine.qualifiedName.slice(0, Math.max(0, routine.qualifiedName.lastIndexOf('::')));
  const candidates = owner ? context.getNodesByQualifiedName(owner).filter((n) => n.language === 'pascal' && CLASS_KINDS.has(n.kind)) : [];
  const cls = declarationOf(candidates.filter((n) => n.filePath === routine.filePath)) ?? declarationOf(candidates);
  memo.set(routine.id, cls);
  return cls;
}

/** A class and its ancestors the project declares, nearest first. */
function ancestorsOf(cls: Node, context: ResolutionContext): Node[] {
  const memo = memos(context).ancestors;
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const order: Node[] = [];
  const seen = new Set<string>();
  let frontier = [cls];
  for (let depth = 0; depth < MAX_HIERARCHY_DEPTH && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const c of frontier) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      order.push(c);
      for (const name of declaredSupertypes(c, context)) {
        const sup = classNamed(name, c.filePath, context);
        if (sup) next.push(sup);
      }
    }
    frontier = next;
  }
  memo.set(cls.id, order);
  return order;
}

/** The qualified name of what declares a node (`TFoo::Bar` → `tfoo`), lowercased. */
function ownerOf(node: Node): string {
  return node.qualifiedName.slice(0, Math.max(0, node.qualifiedName.lastIndexOf('::'))).toLowerCase();
}

/**
 * The member a name reaches in a class or, failing that, in its ancestors,
 * nearest first; a parameterless overload before the others. Null when no
 * class of the hierarchy declares it.
 */
function memberInHierarchy(cls: Node, lower: string, context: ResolutionContext): Node | null {
  const memo = memos(context).hierarchy;
  const key = `${cls.id}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Node | null = null;
  const candidates = pascalNamed(lower, context).filter((n) => MEMBER_KINDS.has(n.kind));
  if (candidates.length > 0) {
    for (const c of ancestorsOf(cls, context)) {
      const owner = c.qualifiedName.toLowerCase();
      const members = candidates.filter((n) => n.filePath === c.filePath && ownerOf(n) === owner);
      if (members.length > 0) {
        found = members.find((n) => !needsArguments(n)) ?? members[0]!;
        break;
      }
    }
  }
  memo.set(key, found);
  return found;
}

/** A unit's top-level declaration of a name (its enum values included). */
function unitDeclaration(filePath: string, lower: string, context: ResolutionContext): Node | undefined {
  const decls = pascalNamed(lower, context).filter((n) =>
    n.filePath === filePath && UNIT_KINDS.has(n.kind) && (n.kind === 'enum_member' || !n.qualifiedName.includes('::')));
  // A routine declared in the interface and defined in the implementation is
  // one name; of overloads, one called without arguments first.
  return decls.find((n) => !isRoutine(n)) ?? decls.find((n) => !needsArguments(n)) ?? decls[0];
}

/** The files of the units a file uses, in the order its `uses` clauses name them. */
function usedUnitFiles(filePath: string, context: ResolutionContext): string[] {
  const memo = memos(context).usedFiles;
  const hit = memo.get(filePath);
  if (hit) return hit;
  const files: string[] = [];
  const imports = context.getNodesInFile(filePath)
    .filter((n) => n.kind === 'import' && n.language === 'pascal')
    .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  for (const imp of imports) {
    const file = unitFileNamed(imp.name.toLowerCase(), filePath, context);
    if (file && file !== filePath && !files.includes(file)) files.push(file);
  }
  memo.set(filePath, files);
  return files;
}

/** The file of the unit a name names, nearest to `fromFile` when several units share it. */
function unitFileNamed(lower: string, fromFile: string, context: ResolutionContext): string | null {
  const m = memos(context);
  const key = `${fromFile}|${lower}`;
  if (m.unitFiles.has(key)) return m.unitFiles.get(key)!;
  if (!m.unitsByName) {
    m.unitsByName = new Map();
    for (const n of context.getNodesByKind('module')) {
      if (n.language !== 'pascal') continue;
      const name = n.name.toLowerCase();
      const files = m.unitsByName.get(name);
      if (files) files.push(n.filePath);
      else m.unitsByName.set(name, [n.filePath]);
    }
  }
  const file = nearest(m.unitsByName.get(lower) ?? [], fromFile);
  m.unitFiles.set(key, file);
  return file;
}

/** A class (or record or interface) a type name names, seen from `fromFile`. */
function classNamed(typeName: string, fromFile: string, context: ResolutionContext): Node | null {
  const simple = typeName.split('.').pop()!.toLowerCase();
  const memo = memos(context).classByName;
  const key = `${fromFile}|${simple}`;
  if (memo.has(key)) return memo.get(key)!;
  const candidates = pascalNamed(simple, context).filter((n) => CLASS_KINDS.has(n.kind));
  let cls = declarationOf(candidates.filter((n) => n.filePath === fromFile));
  if (!cls && candidates.length > 0) {
    // The unit used last declares the name Delphi sees; else the one unit that does.
    const used = usedUnitFiles(fromFile, context);
    for (let i = used.length - 1; i >= 0 && !cls; i--) cls = declarationOf(candidates.filter((n) => n.filePath === used[i]));
    if (!cls && candidates.every((n) => n.filePath === candidates[0]!.filePath)) cls = declarationOf(candidates);
  }
  memo.set(key, cls);
  return cls;
}

/** The file whose path shares the longest directory prefix with `from`. */
function nearest(files: string[], from: string): string | null {
  if (files.length <= 1) return files[0] ?? null;
  const dirs = from.split('/');
  let best: string | null = null;
  let bestScore = -1;
  for (const f of files) {
    const parts = f.split('/');
    let score = 0;
    while (score < parts.length && score < dirs.length && parts[score] === dirs[score]) score++;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Declared types
// ---------------------------------------------------------------------------

function fileLines(filePath: string, context: ResolutionContext): string[] {
  return context.getFileLines?.(filePath) ?? context.readFile(filePath)?.split(/\r?\n/) ?? [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The class a member's value has: a field's or variable's declared type, a property's, a function's result. */
function typeOfMember(member: Node, context: ResolutionContext): Node | null {
  const memo = memos(context).memberTypes;
  if (memo.has(member.id)) return memo.get(member.id)!;
  let typeName: string | undefined;
  if (member.kind === 'method' || member.kind === 'function') {
    typeName = member.returnType ?? /:\s*([A-Za-z_][\w.]*)\s*;?\s*$/.exec(member.signature ?? '')?.[1];
  } else {
    const line = fileLines(member.filePath, context)[member.startLine - 1] ?? '';
    const name = escapeRegExp(member.name);
    const re = member.kind === 'property'
      ? new RegExp(`\\bproperty\\s+${name}\\s*(?:\\[[^\\]]*\\])?\\s*:\\s*([A-Za-z_][\\w.]*)`, 'i')
      : new RegExp(`\\b${name}\\b(?:\\s*,\\s*[A-Za-z_]\\w*)*\\s*:\\s*([A-Za-z_][\\w.]*)`, 'i');
    typeName = re.exec(line)?.[1];
  }
  const type = typeName ? classNamed(typeName, member.filePath, context) : null;
  memo.set(member.id, type);
  return type;
}

/** Whether a routine has a parameter without a default value, which a call must pass. */
function needsArguments(routine: Node): boolean {
  const signature = routine.signature?.trim();
  if (!signature?.startsWith('(')) return false;
  let depth = 0;
  let end = signature.length;
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    else if (signature[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  return signature.slice(1, end).split(';').some((param) => param.trim() !== '' && !param.includes('='));
}

/** Whether a routine gives a value — a function or a constructor — rather than a procedure. */
function yieldsValue(routine: Node, context: ResolutionContext): boolean {
  if (routine.returnType) return true;
  const keyword = routineKeyword(routine, context);
  return keyword === 'function' || keyword === 'constructor';
}

/** The keyword that declares a routine (`function`, `procedure`, `constructor`, …), lowercased, or null. */
function routineKeyword(routine: Node, context: ResolutionContext): string | null {
  const memo = memos(context).keywords;
  const hit = memo.get(routine.id);
  if (hit !== undefined) return hit;
  const line = fileLines(routine.filePath, context)[routine.startLine - 1] ?? '';
  const keyword = /\b(function|procedure|constructor|destructor|operator)\s/i.exec(line)?.[1]!.toLowerCase() ?? null;
  memo.set(routine.id, keyword);
  return keyword;
}
