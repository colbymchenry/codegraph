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
 *   an indexed value, which only a function can be;
 * - `{args}` — the last link of a chain called with its arguments written
 *   (`FPanel.Series().Clear(1)`, `TLog.Create.Write('x')`), which runs it (#2550).
 *
 * Written without its arguments, a routine that needs some is a method
 * pointer too, in any of them. A chain of more than one link (`{call}.A.B.C`)
 * is the outer method of a call through members and functions, typed by what
 * each link is declared to be, never a namesake by its name alone (#2550).
 *
 * A value assigned to a target carries the target after an `=`
 * (`{read=Callback}.FProvider.Value`, `{ref=FOnGet}`, a local's declared type
 * as `{read=:TGet}`): a target whose declared type is a routine type is given
 * a method pointer, whatever it is called, and one of any other type a value;
 * the mode, from the target's name (`OnClick`, `FOnGet`), decides only where
 * its declaration doesn't say (#2550).
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
import { PASCAL_SYSTEM_NAMES } from '../extraction/languages/pascal-system';

type Mode = 'call' | 'read' | 'ref' | 'recv' | 'args';
interface Found {
  node: Node;
  resolvedBy: ResolvedRef['resolvedBy'];
  confidence: number;
}

const PARENLESS = /^\{(call|read|ref|recv|args)(?:=([^@}]+))?(?:@([^}]+))?\}\.(.+)$/;
const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface']);
/** What a unit declares by name at its top level. */
const UNIT_KINDS: ReadonlySet<string> = new Set([
  'function', 'variable', 'constant', 'class', 'struct', 'interface', 'enum', 'type_alias', 'enum_member',
]);
/** What a class declares as its members. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'field', 'property', 'constant', 'variable']);
/** Declarations that hold a value rather than run code. */
const DATA_KINDS: ReadonlySet<string> = new Set(['field', 'property', 'variable', 'constant', 'enum_member']);
/**
 * The RTL's routine types whose names don't say so (`TProc`, `TFunc<T>`),
 * lowercased; the project's own are read from their declarations.
 */
const RTL_PROCEDURAL_TYPES: ReadonlySet<string> = new Set([
  'tproc', 'tfunc', 'tpredicate', 'tcomparison', 'tthreadprocedure', 'tlistsortcompare', 'tstringlistsortcompare',
]);
const MAX_HIERARCHY_DEPTH = 8;

/** Whether `ref` is a paren-less Pascal name (see the file comment), which only this module resolves. */
export function isPascalParenlessRef(ref: UnresolvedRef): boolean {
  return ref.language === 'pascal' && ref.referenceKind === 'references' && PARENLESS.test(ref.referenceName);
}

/** The routine a paren-less Pascal name reaches in its scope, or null (see the file comment). */
export function matchPascalParenlessRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = PARENLESS.exec(ref.referenceName);
  if (!m) return null;
  let mode = m[1] as Mode;
  const target = m[2];
  const path = m[4]!.split('.');
  // Most such names read data, often the framework's: a name no Pascal
  // routine has is settled here, before any lookup in scope. Called with its
  // arguments, a chain may end at data that holds a routine.
  if (mode !== 'args' && routineNames(context)?.has(path[path.length - 1]!.toLowerCase()) === false) return null;
  let cls: Node | null = null;
  if (m[3]) {
    cls = classByQualifiedName(m[3], ref.filePath!, context);
  } else {
    const routine = context.getNodeById?.(ref.fromNodeId);
    if (routine) cls = classOfRoutine(routine, context);
  }
  const found = path.length === 1
    ? nameInScope(path[0]!, cls, ref, context)
    : memberThroughPath(path, cls, ref, context, mode === 'args');
  if (!found) return null;
  let edgeKind: 'calls' | 'references' = 'calls';
  // Written with its arguments, the routine runs, or the routine the data holds.
  if (mode !== 'args') {
    if (target !== undefined) {
      // Given to a target, a method is a method pointer when the target's
      // declared type is a routine type, and a value otherwise. A function
      // whose result is a routine type is called for it.
      const routineTyped = assignedRoutineType(target, cls, ref, context);
      if (routineTyped !== undefined) mode = routineTyped ? 'ref' : 'read';
      if (mode === 'ref' && returnsRoutineType(found.node, context)) mode = 'read';
    }
    // Written without arguments, a routine that needs some can only be a
    // method pointer — save a constructor, whose name then means an inherited
    // one outside the project (`TObject.Create`) — and so is a procedure read
    // for a value, and an event's method; any other runs.
    const needsArgs = needsArguments(found.node);
    if (needsArgs && routineKeyword(found.node, context) === 'constructor') return null;
    const pointer = mode === 'ref' || needsArgs || (mode !== 'call' && !yieldsValue(found.node, context));
    // A statement runs its routine, and a receiver is a routine's value.
    if (pointer && (mode === 'call' || mode === 'recv')) return null;
    edgeKind = pointer ? 'references' : 'calls';
  }
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

/** Whether `ref` is a bare Pascal call to one of the System unit's names (see PASCAL_SYSTEM_NAMES). */
export function isPascalSystemCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  return ref.language === 'pascal' && ref.referenceKind === 'calls' && PASCAL_SYSTEM_NAMES.has(ref.referenceName.toLowerCase()) &&
    isBareCall(ref, context);
}

/**
 * Whether a Pascal call named by a bare name is written bare: its expression
 * starts with the name (`Reset(F)`). The last call of a chain is named bare
 * too (`Reset` in `GetKey(P).Reset`), and its scope is its receiver's type.
 */
function isBareCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^[A-Za-z_]\w*$/.test(ref.referenceName)) return false;
  const line = fileLines(ref.filePath!, context)[ref.line - 1] ?? '';
  return /^[A-Za-z_]\w*/.exec(line.slice(ref.column ?? 0))?.[0].toLowerCase() === ref.referenceName.toLowerCase();
}

/**
 * A call to one of the System unit's names is the System unit's, which the
 * project doesn't hold, unless a declaration in the call's scope shadows it:
 * a member of the class (`Delete(I)` in a list class), a routine of the unit
 * or the units it uses. A project type of that name is a typecast. Data of
 * that name runs only when it holds a routine (see isProceduralData). A unit
 * that declares one under a condition stands in for compilers without it
 * (`{$IFNDEF UNICODE} UnicodeString = WideString; {$ENDIF}`): the code is
 * most likely built with one that has it.
 */
export function matchPascalSystemCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const decl = declarationInScope(ref.referenceName.toLowerCase(), classOfCall(ref, context), ref, context);
  if (!decl) return null;
  if (DATA_KINDS.has(decl.node.kind) && !isProceduralData(decl.node, context)) return null;
  if (!decl.node.qualifiedName.includes('::') && declaredUnderCondition(decl.node, context)) return null;
  context.rememberNode?.(decl.node);
  return { original: ref, targetNodeId: decl.node.id, confidence: decl.confidence, resolvedBy: decl.resolvedBy };
}

/**
 * What a Pascal call another strategy resolved stands for, when it landed on
 * data or on a routine nested in another (see gatePascalNestedTarget).
 *
 * A call resolved to data — a field, a property, a variable, a constant —
 * runs what the data holds, so it stands only for data
 * whose declared type is a routine's. A bare name is what its scope declares
 * (`FOnChange(Self)` in the class that declares its own `FOnChange`): the
 * routine or the routine-holding data there, whichever namesake the strategy
 * chose. Any other is a namesake: `length(S)` was a record's `length` field,
 * `Pointer(P)` a property named `Pointer`. A name the calling routine
 * declares itself, as a parameter, a local or a nested routine, is that
 * declaration, which the graph doesn't hold. A name its scope doesn't
 * declare at all is a `with` object's member (`with OCI do HandleAlloc(...)`)
 * or a declaration the parse put in the wrong place: it stands for the one
 * routine-holding field or variable the project declares by that name.
 */
export function gatePascalCall(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target) return result;
  if (DATA_KINDS.has(target.kind)) return gatePascalDataCall(target, result, ref, context);
  if (isNestedRoutine(target, context)) return gatePascalNestedTarget(result, ref, context);
  return result;
}

/** See gatePascalCall: a call resolved to data. */
function gatePascalDataCall(target: Node, result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isBareCall(ref, context)) return target.language === 'pascal' && isProceduralData(target, context) ? result : null;
  const lower = ref.referenceName.toLowerCase();
  if (declaredInRoutine(lower, ref, context)) return null;
  const decl = declarationInScope(lower, classOfCall(ref, context), ref, context);
  if (!decl) {
    const only = target.language === 'pascal' && pascalNamed(lower, context).every((n) => n.id === target.id || n.kind === 'import');
    return only && isProceduralData(target, context) ? result : null;
  }
  if (!isRoutine(decl.node) && !(DATA_KINDS.has(decl.node.kind) && isProceduralData(decl.node, context))) return null;
  if (decl.node.id === target.id) return result;
  context.rememberNode?.(decl.node);
  return { ...result, targetNodeId: decl.node.id, confidence: decl.confidence, resolvedBy: decl.resolvedBy };
}

/**
 * Whether the routine making a call declares the called name itself, as a
 * parameter, a local or a nested routine (`function Hash(Item: Pointer;
 * Hasher: THasher)` calling `Hasher(0, Item, 4)`): from the routine's header
 * down to the call.
 */
function declaredInRoutine(lower: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const lines = fileLines(ref.filePath!, context);
  // The header in the text: a method's node may start at its declaration in
  // the class, above the fields and the unit's variables.
  const from = routineHeaderAt(ref.filePath!, ref.line, context);
  const name = escapeRegExp(lower);
  const mentions = new RegExp(`\\b${name}\\b`, 'i');
  const declares = new RegExp(`\\b(?:procedure|function)\\s+${name}\\b|\\b${name}\\s*(?:,\\s*[A-Za-z_]\\w*\\s*)*:(?!=)`, 'i');
  for (let i = Math.max(1, from); i <= ref.line && i <= lines.length; i++) {
    const text = lines[i - 1]!;
    if (mentions.test(text) && declares.test(text.replace(/\/\/.*$|\{[^}]*\}|'[^']*'/g, ' '))) return true;
  }
  return false;
}

/** The line of the nearest routine header at column 0 at or above a line, else the line itself. */
function routineHeaderAt(filePath: string, line: number, context: ResolutionContext): number {
  headerClassAt(filePath, line, context);
  const headers = memos(context).headerClasses.get(filePath) ?? [];
  let found = line;
  for (const h of headers) {
    if (h.line > line) break;
    if (h.routine) found = h.line;
  }
  return found;
}

/**
 * Whether a declaration is inside an `{$IFDEF}`, `{$IFNDEF}`, `{$IF}` or
 * `{$IFOPT}` block, or its `{$ELSE}`.
 */
function declaredUnderCondition(node: Node, context: ResolutionContext): boolean {
  const memo = memos(context).conditionDepths;
  let depths = memo.get(node.filePath);
  const lines = fileLines(node.filePath, context);
  if (!depths) {
    depths = [];
    let depth = 0;
    for (const text of lines) {
      depths.push(depth);
      if (text.includes('{$')) depth = conditionDepthAfter(text, depth);
    }
    memo.set(node.filePath, depths);
  }
  const line = lines[node.startLine - 1] ?? '';
  return conditionDepthAfter(line.slice(0, node.startColumn), depths[node.startLine - 1] ?? 0) > 0;
}

/** The depth of conditional blocks after a line's directives (`{$IFDEF X}` opens one, `{$ENDIF}` closes it). */
function conditionDepthAfter(text: string, depth: number): number {
  for (const m of text.matchAll(/\{\$(ifdef|ifndef|ifopt|ifend|endif|if)\b/gi)) {
    const directive = m[1]!.toLowerCase();
    depth = directive === 'endif' || directive === 'ifend' ? Math.max(0, depth - 1) : depth + 1;
  }
  return depth;
}

/**
 * The class whose method makes a call: the one the nearest method header
 * above the call names in the source text (`procedure TFoo.Bar;`), which holds
 * where the tree had errors and gave the code to the file, or to a routine
 * that swallowed the ones after it; else the reference's method's class.
 */
function classOfCall(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const qn = headerClassAt(ref.filePath!, ref.line, context);
  const cls = qn ? classByQualifiedName(qn, ref.filePath!, context) : null;
  if (cls) return cls;
  const routine = context.getNodeById?.(ref.fromNodeId);
  return routine?.kind === 'method' ? classOfRoutine(routine, context) : null;
}

/**
 * The class the nearest routine header at or above a line names
 * (`procedure TFoo.Bar;` → `TFoo`), or null when it is a free routine's, or
 * the unit's code resumes there: after an `end;` that starts its line, or at
 * `initialization`.
 */
function headerClassAt(filePath: string, line: number, context: ResolutionContext): string | null {
  const memo = memos(context).headerClasses;
  let headers = memo.get(filePath);
  if (!headers) {
    headers = [];
    const lines = fileLines(filePath, context);
    const header = /^(?:class\s+)?(?:procedure|function|constructor|destructor|operator)\s+([A-Za-z_][\w.<>, ]*?)\s*[(:;]/i;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      // Each starts its line with one of c, d, e, f, i, o, p (either case).
      const first = text.charCodeAt(0) | 0x20;
      if (first !== 0x63 && first !== 0x64 && first !== 0x65 && first !== 0x66 && first !== 0x69 && first !== 0x6f && first !== 0x70) continue;
      if (/^(?:end;|(?:initialization|finalization)\b)/i.test(text)) {
        headers.push({ line: i + 1, classQn: null, routine: false });
        continue;
      }
      const m = header.exec(text);
      if (!m) continue;
      const parts = m[1]!.replace(/<[^>]*>/g, '').replace(/\s+/g, '').split('.');
      headers.push({ line: i + 1, classQn: parts.length > 1 ? parts.slice(0, -1).join('::') : null, routine: true });
    }
    memo.set(filePath, headers);
  }
  let lo = 0;
  let hi = headers.length - 1;
  let hit: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headers[mid]!.line <= line) {
      hit = headers[mid]!.classQn;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Scope lookup
// ---------------------------------------------------------------------------

function isRoutine(node: Node): boolean {
  return node.kind === 'method' || node.kind === 'function';
}

/** A bare name, looked up the way Delphi looks it up from a routine of class `cls` (null: a free routine): a routine, or null. */
function nameInScope(name: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const decl = declarationInScope(name.toLowerCase(), cls, ref, context);
  return decl && isRoutine(decl.node) ? decl : null;
}

/**
 * The routine nested in the calling routine, or in one around it, that a
 * bare name there names (`procedure Inner;` between `procedure TFoo.Bar;`
 * and its `begin`, `TFoo::Bar::Inner`): the innermost one declared above the
 * call, the calling routine itself among them, or declared `forward` above
 * it (see declaredForward). It comes before anything of the class or the
 * unit. Null when none is.
 */
function nestedRoutineInScope(lower: string, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  // Most names no nested routine has: settled before any other lookup.
  const named = pascalNamed(lower, context);
  if (!named.some((n) => n.kind === 'function' && n.qualifiedName.includes('::'))) return null;
  const memo = memos(context).nestedInScope;
  const key = `${ref.fromNodeId}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Found | null = null;
  const caller = routineNode(ref.fromNodeId, context);
  if (caller && caller.language === 'pascal') {
    const chain = caller.qualifiedName.toLowerCase();
    let best: Node | null = null;
    let depth = -1;
    for (const n of named) {
      if (n.filePath !== caller.filePath || !isNestedRoutine(n, context)) continue;
      if (n.startLine > ref.line && !declaredForward(n, ref.line, context)) continue;
      const outer = ownerOf(n);
      // Nested in the caller, or in a routine the caller is nested in.
      if (chain !== outer && !chain.startsWith(`${outer}::`)) continue;
      if (outer.length > depth || (outer.length === depth && n.startLine < best!.startLine)) {
        best = n;
        depth = outer.length;
      }
    }
    if (best) found = { node: best, resolvedBy: 'exact-match', confidence: 0.95 };
  }
  memo.set(key, found);
  return found;
}

/**
 * Whether a routine nested in another is declared `forward` above a line
 * (`procedure Late; forward;`), which puts it in scope there ahead of its
 * body (#2550): a header of its name, as indented as its own, that ends in
 * `forward;`, between the line and the header indented less above it, the
 * routine both are nested in.
 */
function declaredForward(routine: Node, line: number, context: ResolutionContext): boolean {
  const lines = fileLines(routine.filePath, context);
  const name = routine.name.toLowerCase();
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^(\s*)(?:class\s+)?(?:procedure|function|constructor|destructor)\s+([A-Za-z_]\w*)/i.exec(lines[i]!);
    if (!m) continue;
    if (m[1]!.length < routine.startColumn) return false;
    if (m[1]!.length !== routine.startColumn || m[2]!.toLowerCase() !== name) continue;
    // Its parameters may go on over a few lines.
    let text = lines[i]!.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)/g, ' ');
    for (let j = i + 1; j < lines.length && j <= i + 4 && (text.split('(').length > text.split(')').length); j++) {
      text += ' ' + lines[j]!.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)/g, ' ');
    }
    if (/\bforward\s*;/i.test(text)) return true;
  }
  return false;
}

/**
 * Whether a node is a routine nested in another (see nestedRoutineInScope):
 * a Pascal function qualified under a routine, which no code outside the one
 * it is nested in can call.
 */
function isNestedRoutine(node: Node, context: ResolutionContext): boolean {
  if (node.kind !== 'function' || node.language !== 'pascal') return false;
  const cut = node.qualifiedName.lastIndexOf('::');
  if (cut < 0) return false;
  const outer = node.qualifiedName.slice(0, cut);
  const memo = memos(context).routineQns;
  let routine = memo.get(outer);
  if (routine === undefined) {
    routine = context.getNodesByQualifiedName(outer).some((n) => n.language === 'pascal' && isRoutine(n));
    memo.set(outer, routine);
  }
  return routine;
}

/** The routine a reference comes from, or null when it comes from a file or anything else. */
function routineNode(id: string, context: ResolutionContext): Node | null {
  const memo = memos(context).routineNodes;
  if (memo.has(id)) return memo.get(id)!;
  const node = context.getNodeById?.(id) ?? null;
  const routine = node && isRoutine(node) ? node : null;
  memo.set(id, routine);
  return routine;
}

/**
 * A bare Pascal call (`Inner(1)`) to a routine nested where the call is (see
 * nestedRoutineInScope). Made inside a nested routine, it reaches the rest of
 * that routine's scope the same way: the class of the method it is nested in
 * (`GetNext(Run)` in a tree method's nested routine is the tree's), its unit,
 * the units it uses. Undefined when that scope holds no routine of the name,
 * for the other strategies to resolve.
 */
export function matchPascalNestedCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | undefined {
  if (ref.language !== 'pascal' || ref.referenceKind !== 'calls' || !isBareCall(ref, context)) return undefined;
  const lower = ref.referenceName.toLowerCase();
  let found = nestedRoutineInScope(lower, ref, context);
  if (!found) {
    const caller = routineNode(ref.fromNodeId, context);
    if (!caller || !isNestedRoutine(caller, context)) return undefined;
    const decl = declarationInScope(lower, classOfCall(ref, context), ref, context);
    if (!decl || !(isRoutine(decl.node) || (DATA_KINDS.has(decl.node.kind) && isProceduralData(decl.node, context)))) return undefined;
    found = decl;
  }
  context.rememberNode?.(found.node);
  return { original: ref, targetNodeId: found.node.id, confidence: found.confidence, resolvedBy: found.resolvedBy };
}

/**
 * A Pascal call another strategy resolved to a routine nested in some other
 * routine, which nothing outside that routine can call: a bare name is then
 * what the call's scope declares, a routine or data holding one (mORMot's
 * `StrLen` variable), and any other call links nothing.
 */
function gatePascalNestedTarget(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isBareCall(ref, context)) return null;
  const lower = ref.referenceName.toLowerCase();
  const decl = declarationInScope(lower, classOfCall(ref, context), ref, context);
  if (!decl || (!isRoutine(decl.node) && !(DATA_KINDS.has(decl.node.kind) && isProceduralData(decl.node, context)))) return null;
  if (decl.node.id === result.targetNodeId) return result;
  context.rememberNode?.(decl.node);
  return { ...result, targetNodeId: decl.node.id, confidence: decl.confidence, resolvedBy: decl.resolvedBy };
}

/**
 * The first declaration a bare name reaches from a routine of class `cls`
 * (null: a free routine), whatever it declares: a routine nested in the
 * calling routine or one around it, a member of the class or its ancestors,
 * then a declaration of the unit, then of the units it uses, last first.
 * Null when the project declares none of them, as for the System unit's
 * names.
 */
function declarationInScope(lower: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  const nested = nestedRoutineInScope(lower, ref, context);
  if (nested) return nested;
  const memo = memos(context).inScope;
  const key = `${cls?.id ?? ''}|${ref.filePath}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Found | null = null;
  const member = cls ? memberInHierarchy(cls, lower, context) : null;
  if (member) {
    found = { node: member, resolvedBy: 'instance-method', confidence: 0.9 };
  } else {
    const own = ownUnitDeclaration(ref.filePath!, lower, context);
    if (own) {
      found = { node: own, resolvedBy: 'exact-match', confidence: 0.9 };
    } else {
      const used = usedUnitFiles(ref.filePath!, context);
      for (let i = used.length - 1; i >= 0 && !found; i--) {
        const decl = unitDeclaration(used[i]!, lower, context, ref.filePath!);
        if (decl) found = { node: decl, resolvedBy: 'import', confidence: 0.85 };
      }
    }
  }
  memo.set(key, found);
  return found;
}

/**
 * A dotted name: the method its receiver's declared type has; with
 * `holdsRoutine`, data that holds a routine too (a chain called with its
 * arguments, `Owner.Events.FOnChange(Self)`, see isProceduralData).
 */
function memberThroughPath(path: string[], cls: Node | null, ref: UnresolvedRef, context: ResolutionContext, holdsRoutine = false): Found | null {
  const last = memberAtPath(path, cls, ref, context);
  if (!last) return null;
  if (!isRoutine(last.node) && !(holdsRoutine && DATA_KINDS.has(last.node.kind) && isProceduralData(last.node, context))) return null;
  return { node: last.node, resolvedBy: last.unit ? 'import' : 'instance-method', confidence: 0.9 };
}

/**
 * What a dotted name's last link is declared as: a member of what the links
 * before it are declared to be — a field's or a property's type, a
 * function's result — from its head (see headOf), or, with `unit`, the
 * routine or variable a unit's name qualifies (`Utils.Helper`). A constructor
 * called on a class gives an instance of it: one the class declares, or
 * `Create`, which the project's classes inherit from outside it
 * (`TLog.Create.Write('x')`, `Logs.TLog.Create().Write('x')`).
 */
function memberAtPath(path: string[], cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): { node: Node; unit: boolean } | null {
  let head = headOf(path[0]!, cls, ref, context);
  let rest = path.slice(1);
  // A dotted unit name, the longest the links make (`mormot.core.os.GetTickCount64`).
  for (let k = path.length - 1; !head && k >= 2; k--) {
    const unitFile = unitFileNamed(path.slice(0, k).join('.').toLowerCase(), ref.filePath!, context);
    if (unitFile) {
      head = { type: null, unitFile };
      rest = path.slice(k);
    }
  }
  if (!head) return null;
  let type = head.type;
  let classRef = head.classRef === true;
  if (head.unitFile) {
    // `UnitName.Routine`, `UnitName.GlobalVar.Method`, `UnitName.TFoo.Create.Method`.
    const decl = unitDeclaration(head.unitFile, rest[0]!.toLowerCase(), context, ref.filePath!);
    if (!decl) return null;
    if (rest.length === 1) return { node: decl, unit: true };
    classRef = CLASS_KINDS.has(decl.kind);
    type = classRef ? decl : typeOfMember(decl, context);
    rest = rest.slice(1);
  }
  for (let i = 0; i < rest.length && type; i++) {
    const lower = rest[i]!.toLowerCase();
    const member = memberInHierarchy(type, lower, context);
    if (i === rest.length - 1) return member ? { node: member, unit: false } : null;
    if (classRef && (member ? routineKeyword(member, context) === 'constructor' : lower === 'create')) {
      classRef = false;
      continue;
    }
    if (!member) return null;
    type = typeOfMember(member, context);
    classRef = false;
  }
  return null;
}

/**
 * What a dotted name's first link is: a value of a known class (a local's
 * declared type, written `:TFoo`), a class itself (`classRef`), or a unit.
 */
function headOf(name: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): { type: Node | null; classRef?: boolean; unitFile?: string } | null {
  if (name.startsWith(':')) return { type: classNamed(name.slice(1), ref.filePath!, context) };
  const lower = name.toLowerCase();
  if (lower === 'self') return cls ? { type: cls } : null;
  if (cls) {
    const member = memberInHierarchy(cls, lower, context);
    if (member) return { type: typeOfMember(member, context) };
  }
  const decl = ownUnitDeclaration(ref.filePath!, lower, context) ??
    usedUnitFiles(ref.filePath!, context).reduceRight<Node | undefined>(
      (hit, file) => hit ?? unitDeclaration(file, lower, context, ref.filePath!), undefined);
  if (decl) return CLASS_KINDS.has(decl.kind) ? { type: decl, classRef: true } : { type: typeOfMember(decl, context) };
  const unitFile = unitFileNamed(lower, ref.filePath!, context);
  return unitFile ? { type: null, unitFile } : null;
}

/**
 * Whether the target a value is assigned to is declared with a routine type
 * (see the file comment): the field, property or variable a name reaches in
 * scope, or through a receiver (`FEvents.OnGet`, `Self.Callback`), or the
 * declared type of a local (`:TGet`, `:procedure` for one written out).
 * Undefined when the declaration, or what its type is, can't be read.
 */
function assignedRoutineType(target: string, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): boolean | undefined {
  const links = target.split('.');
  if (links.length === 1 && links[0]!.startsWith(':')) return routineTypeVerdict(links[0]!.slice(1), context, 0);
  const node = links.length === 1
    ? declarationInScope(links[0]!.toLowerCase(), cls, ref, context)?.node
    : memberAtPath(links, cls, ref, context)?.node;
  if (!node || !DATA_KINDS.has(node.kind) || node.kind === 'enum_member') return undefined;
  const text = declaredTypeText(node, context);
  return text ? routineTypeVerdict(text, context, 0) : undefined;
}

/** Whether a function's result is of a routine type (`function MakeHandler: TNotifyEvent`). */
function returnsRoutineType(routine: Node, context: ResolutionContext): boolean {
  if (!isRoutine(routine)) return false;
  const typeName = routine.returnType ?? /:\s*([A-Za-z_][\w.]*)\s*;?\s*$/.exec(routine.signature ?? '')?.[1];
  return !!typeName && routineTypeVerdict(typeName, context, 0) === true;
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
  genericTypes?: Map<string, Node[]>;
  projectFiles?: { byName: Map<string, string[]>; pascal: string[] };
  includes: Map<string, string[]>;
  includers: Map<string, string | null>;
  ownFiles: Map<string, string[]>;
  unitFileSets: Map<string, string[]>;
  unitFiles: Map<string, string | null>;
  hierarchy: Map<string, Node | null>;
  memberTypes: Map<string, Node | null>;
  keywords: Map<string, string | null>;
  procedural: Map<string, boolean>;
  headerClasses: Map<string, Array<{ line: number; classQn: string | null; routine: boolean }>>;
  outlines: Map<string, { classes: Node[]; imports: Node[]; routineColumn: number }>;
  conditionDepths: Map<string, number[]>;
  nestedInScope: Map<string, Found | null>;
  routineNodes: Map<string, Node | null>;
  routineQns: Map<string, boolean>;
}
const MEMOS = new WeakMap<ResolutionContext, Memos>();

function memos(context: ResolutionContext): Memos {
  let m = MEMOS.get(context);
  if (!m) {
    m = {
      named: new Map(), inScope: new Map(), classOfRoutine: new Map(), classByQn: new Map(),
      ancestors: new Map(), usedFiles: new Map(), classByName: new Map(), unitFiles: new Map(), hierarchy: new Map(),
      memberTypes: new Map(), keywords: new Map(), procedural: new Map(), headerClasses: new Map(), outlines: new Map(),
      conditionDepths: new Map(), unitFileSets: new Map(), includes: new Map(), includers: new Map(), ownFiles: new Map(),
      nestedInScope: new Map(), routineNodes: new Map(), routineQns: new Map(),
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
  let cls: Node | null = null;
  for (const file of ownUnitFiles(filePath, context)) {
    cls = declarationOf(exact.filter((n) => n.filePath === file)) ??
      declarationOf(outlineOf(file, context).classes.filter((n) => n.qualifiedName.replace(/<[^>]*>/g, '').toLowerCase() === lower));
    if (cls) break;
  }
  cls ??= declarationOf(exact) ?? classNamed(qualifiedName.split('::').pop()!, filePath, context);
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

/**
 * A unit's top-level declaration of a name (its enum values included), as
 * code in `fromFile` sees it: another unit's member that its parse lost (see
 * unitRoutineColumn) is not one, while in its own unit it is most likely the
 * member the code calls.
 */
function unitDeclaration(filePath: string, lower: string, context: ResolutionContext, fromFile = filePath): Node | undefined {
  const decls = pascalNamed(lower, context).filter((n) =>
    n.filePath === filePath && UNIT_KINDS.has(n.kind) && (n.kind === 'enum_member' || !n.qualifiedName.includes('::')) &&
    !(fromFile !== filePath && n.kind === 'function' && n.startColumn > unitRoutineColumn(filePath, context)));
  // A routine declared in the interface and defined in the implementation is
  // one name; of overloads, one called without arguments first.
  return decls.find((n) => !isRoutine(n)) ?? decls.find((n) => !needsArguments(n)) ?? decls[0];
}

/**
 * How far a unit's own routines are indented at most. In a unit whose
 * `unit` header the parser lost, the members of a class it couldn't read
 * come out as routines of the unit, indented deeper than the unit's own
 * (`function Http: IHttpClient;` in a class body); elsewhere, any.
 */
function unitRoutineColumn(filePath: string, context: ResolutionContext): number {
  return outlineOf(filePath, context).routineColumn;
}

/** What scope lookups need of a file's nodes, read once: its classes, its `uses` in order, unitRoutineColumn. */
function outlineOf(filePath: string, context: ResolutionContext): { classes: Node[]; imports: Node[]; routineColumn: number } {
  const memo = memos(context).outlines;
  let outline = memo.get(filePath);
  if (!outline) {
    const nodes = context.getNodesInFile(filePath);
    let routineColumn = Infinity;
    if (!nodes.some((n) => n.kind === 'module')) {
      for (const n of nodes) {
        if (n.kind === 'function' && !n.qualifiedName.includes('::')) routineColumn = Math.min(routineColumn, n.startColumn);
      }
    }
    outline = {
      classes: nodes.filter((n) => CLASS_KINDS.has(n.kind)),
      imports: nodes.filter((n) => n.kind === 'import' && n.language === 'pascal')
        .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn),
      routineColumn,
    };
    memo.set(filePath, outline);
  }
  return outline;
}

/** The files of the units a file uses, in the order its `uses` clauses name them. */
function usedUnitFiles(fromFile: string, context: ResolutionContext): string[] {
  const memo = memos(context).usedFiles;
  const hit = memo.get(fromFile);
  if (hit) return hit;
  // The unit's `uses` clauses, then those of the files it includes: mORMot's
  // `.inc` files open the unit's implementation with one.
  const unit = unitFilesOf(fromFile, context);
  const files: string[] = [];
  for (const own of unit) {
    for (const imp of outlineOf(own, context).imports) {
      const file = unitFileNamed(imp.name.toLowerCase(), own, context);
      if (file && !unit.includes(file) && !files.includes(file)) files.push(file);
    }
  }
  memo.set(fromFile, files);
  return files;
}

/** The unit's own declaration of a name, seen from one of its files (see ownUnitFiles). */
function ownUnitDeclaration(fromFile: string, lower: string, context: ResolutionContext): Node | undefined {
  for (const file of ownUnitFiles(fromFile, context)) {
    const decl = unitDeclaration(file, lower, context);
    if (decl) return decl;
  }
  return undefined;
}

/**
 * The files whose declarations are a file's unit's own, the file first: the
 * unit is its own file and the include files it pulls in, so code in
 * `mormot.core.os.pas` sees a variable `mormot.core.os.posix.inc` declares,
 * and that file's code sees the unit's (see unitFilesOf).
 */
function ownUnitFiles(filePath: string, context: ResolutionContext): string[] {
  const memo = memos(context).ownFiles;
  let own = memo.get(filePath);
  if (!own) {
    const unit = unitFilesOf(filePath, context);
    own = unit[0] === filePath ? unit : [filePath, ...unit.filter((f) => f !== filePath)];
    memo.set(filePath, own);
  }
  return own;
}

/**
 * The files one unit is made of: its own file, then the include files it
 * pulls in (`{$I name.inc}`, `{$INCLUDE name}`), nested ones too. For an
 * include file, the unit that includes it, nearest it when several do.
 */
function unitFilesOf(filePath: string, context: ResolutionContext): string[] {
  const m = memos(context);
  const hit = m.unitFileSets.get(filePath);
  if (hit) return hit;
  let root = filePath;
  for (let i = 0; i < 3 && /\.inc$/i.test(root); i++) {
    const up = includerOf(root, context);
    if (!up || up === filePath) break;
    root = up;
  }
  const files = [root];
  for (let i = 0; i < files.length && files.length < 32; i++) {
    for (const inc of includesOf(files[i]!, context)) if (!files.includes(inc)) files.push(inc);
  }
  if (!files.includes(filePath)) files.push(filePath);
  m.unitFileSets.set(filePath, files);
  return files;
}

/** The include files a Pascal file pulls in (`{$I name.inc}`, `{$INCLUDE name}`), each the one of that name nearest it. */
function includesOf(filePath: string, context: ResolutionContext): string[] {
  const m = memos(context);
  let includes = m.includes.get(filePath);
  if (includes) return includes;
  includes = [];
  if (PASCAL_SOURCE.test(filePath)) {
    for (const text of fileLines(filePath, context)) {
      if (!text.includes('{$') || !/\{\$i(?:nclude)?\s/i.test(text)) continue;
      for (const match of text.matchAll(/\{\$(?:I|INCLUDE)\s+['"]?([^'"}\s*]+)/gi)) {
        let name = match[1]!.replace(/\\/g, '/');
        name = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
        if (!name.includes('.')) name += '.inc';
        const inc = nearest(projectFiles(context).byName.get(name) ?? [], filePath);
        if (inc && inc !== filePath && !includes.includes(inc)) includes.push(inc);
      }
    }
  }
  m.includes.set(filePath, includes);
  return includes;
}

/** The Pascal file that includes an include file: of the forty nearest it, the nearest whose text does. */
function includerOf(incFile: string, context: ResolutionContext): string | null {
  const m = memos(context);
  if (m.includers.has(incFile)) return m.includers.get(incFile)!;
  // The files of its directory first, those named most like it first of
  // them (`mormot.core.os.pas` for `mormot.core.os.posix.inc`): how many
  // characters of its path a file shares, the directory counting first.
  const shared = (f: string): number => {
    let n = 0;
    while (n < f.length && n < incFile.length && f.charCodeAt(n) === incFile.charCodeAt(n)) n++;
    return f.lastIndexOf('/', n - 1) * 1000 + n;
  };
  const candidates = projectFiles(context).pascal.filter((f) => f !== incFile)
    .map((f) => ({ f, n: shared(f) })).sort((a, b) => b.n - a.n).slice(0, 40);
  const includer = candidates.find(({ f }) => includesOf(f, context).includes(incFile))?.f ?? null;
  m.includers.set(incFile, includer);
  return includer;
}

const PASCAL_SOURCE = /\.(?:pas|dpr|dpk|lpr|inc)$/i;

/** The project's files by lowercased name, and its Pascal sources. */
function projectFiles(context: ResolutionContext): { byName: Map<string, string[]>; pascal: string[] } {
  const m = memos(context);
  if (!m.projectFiles) {
    const byName = new Map<string, string[]>();
    const pascal: string[] = [];
    for (const file of context.getAllFiles()) {
      const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
      const same = byName.get(base);
      if (same) same.push(file);
      else byName.set(base, [file]);
      if (PASCAL_SOURCE.test(file)) pascal.push(file);
    }
    m.projectFiles = { byName, pascal };
  }
  return m.projectFiles;
}

/** The file of the unit a name names, nearest to `fromFile` when several units share it. */
function unitFileNamed(lower: string, fromFile: string, context: ResolutionContext): string | null {
  const m = memos(context);
  const key = `${fromFile}|${lower}`;
  if (m.unitFiles.has(key)) return m.unitFiles.get(key)!;
  if (!m.unitsByName) {
    const units = new Map<string, string[]>();
    const add = (name: string, file: string): void => {
      const files = units.get(name);
      if (files) files.push(file);
      else units.set(name, [file]);
    };
    const headed = new Set<string>();
    for (const n of context.getNodesByKind('module')) {
      if (n.language !== 'pascal') continue;
      add(n.name.toLowerCase(), n.filePath);
      headed.add(n.filePath);
    }
    // A unit's file is named after it, which Delphi enforces: one whose
    // `unit` header the parser lost to an error is the unit its file names.
    for (const file of context.getAllFiles()) {
      if (headed.has(file) || !/\.pas$/i.test(file)) continue;
      add(file.slice(file.lastIndexOf('/') + 1, -'.pas'.length).toLowerCase(), file);
    }
    m.unitsByName = units;
  }
  const file = nearest(m.unitsByName.get(lower) ?? [], fromFile);
  m.unitFiles.set(key, file);
  return file;
}

/** A class (or record or interface) a type name names, seen from `fromFile`. */
function classNamed(typeName: string, fromFile: string, context: ResolutionContext, depth = 0): Node | null {
  const simple = typeName.split('.').pop()!.toLowerCase();
  const memo = memos(context).classByName;
  const key = `${fromFile}|${simple}`;
  if (memo.has(key)) return memo.get(key)!;
  const named = pascalNamed(simple, context);
  const visible = (kinds: ReadonlySet<string>): Node[] => {
    // In the unit's own files, then in the unit used last, which declares the
    // name Delphi sees; else in the one unit that does.
    const candidates = named.filter((n) => kinds.has(n.kind));
    for (const file of ownUnitFiles(fromFile, context)) {
      const own = candidates.filter((n) => n.filePath === file);
      if (own.length > 0) return own;
    }
    const used = usedUnitFiles(fromFile, context);
    for (let i = used.length - 1; i >= 0; i--) {
      const there = candidates.filter((n) => n.filePath === used[i]);
      if (there.length > 0) return there;
    }
    return candidates.length > 0 && candidates.every((n) => n.filePath === candidates[0]!.filePath) ? candidates : [];
  };
  let cls = declarationOf(visible(CLASS_KINDS));
  if (!cls && depth < 4) {
    // A type alias names the class it stands for: `TVTAncestor = TVTAncestorVcl;`,
    // and so do a pointer type and a class reference type, whose values reach
    // its members (`PVirtualNode = ^TVirtualNode;`, `TSynLogClass = class of
    // TSynLog;`, #2550).
    for (const alias of visible(ALIAS_KINDS)) {
      const line = (fileLines(alias.filePath, context)[alias.startLine - 1] ?? '').replace(/\/\/.*$|\{[^}]*\}/g, '');
      const target = /=\s*(?:\^|class\s+of\b)?\s*([A-Za-z_][\w.]*)\s*;/i.exec(line)?.[1];
      if (target && (cls = classNamed(target, alias.filePath, context, depth + 1))) break;
    }
  }
  memo.set(key, cls);
  return cls;
}

const ALIAS_KINDS: ReadonlySet<string> = new Set(['type_alias']);

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
    typeName = /^([A-Za-z_][\w.]*)/.exec(declaredTypeText(member, context))?.[1];
  }
  const type = typeName ? classNamed(typeName, member.filePath, context) : null;
  memo.set(member.id, type);
  return type;
}

/**
 * The text of the type a field, variable, constant or property declares,
 * from its declaration on: `TFoo; // the foo` for `FFoo: TFoo; // the foo`.
 * A name in a comma list (`FOnLoad,` above `FOnSave: TSaveEvent;`) takes the
 * type the list ends with, a few lines down. Empty when none is written, as
 * for a published `property OnClick;`.
 */
function declaredTypeText(node: Node, context: ResolutionContext): string {
  const lines = fileLines(node.filePath, context);
  const name = escapeRegExp(node.name);
  const re = node.kind === 'property'
    ? new RegExp(`\\bproperty\\s+${name}\\s*(?:\\[[^\\]]*\\])?\\s*:\\s*(.*)$`, 'i')
    : new RegExp(`\\b${name}\\b(?:\\s*,\\s*[A-Za-z_]\\w*)*\\s*,?\\s*:(?!=)\\s*(.*)$`, 'i');
  let text = '';
  for (let i = node.startLine - 1; i < node.startLine + 5 && i < lines.length; i++) {
    text += ' ' + lines[i]!.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)/g, ' ');
    const m = re.exec(text);
    if (m) return m[1]!.trim();
    // A list goes on only after a comma.
    if (node.kind === 'property' || !/,\s*$/.test(text)) break;
  }
  return '';
}

/**
 * Whether data holds a routine, by its declared type: one written in place
 * (`FProc: procedure of object`, `F: reference to function: Integer`), a
 * project type declared as one (`TOnLog = procedure(...) of object;`), or a
 * type the project doesn't declare that the RTL's names say is one
 * (`TNotifyEvent`, `TWndMethod`, `TProc<T>`).
 */
function isProceduralData(node: Node, context: ResolutionContext): boolean {
  const memo = memos(context).procedural;
  const hit = memo.get(node.id);
  if (hit !== undefined) return hit;
  const procedural = isProceduralTypeText(declaredTypeText(node, context), context, 0);
  memo.set(node.id, procedural);
  return procedural;
}

/**
 * Whether a written type is a routine's: written out
 * (`reference to function: Integer`), or named, with the name's declaration
 * saying so, through an alias to another such name
 * (`TFormatter = TFunc<Exception, string>;`). A name the project doesn't
 * declare is a routine type when the RTL's names say so: `TProc`, `TFunc<T>`,
 * and the names Delphi gives them (`TNotifyEvent`, `TWndMethod`).
 */
function isProceduralTypeText(text: string, context: ResolutionContext, depth: number): boolean {
  return routineTypeVerdict(text, context, depth) === true;
}

/**
 * Whether a written type is a routine's (see isProceduralTypeText): false
 * for one of the System unit's value types, and undefined when nothing says,
 * for a name neither the project declares nor the RTL's names say is a
 * routine type (`TStringList`) or text that names no type (`array of TFoo`).
 */
function routineTypeVerdict(text: string, context: ResolutionContext, depth: number): boolean | undefined {
  if (PROCEDURAL_TYPE.test(text)) return true;
  const typeName = /^(?:type\s+)?([A-Za-z_][\w.]*)/i.exec(text)?.[1]?.split('.').pop()?.toLowerCase();
  if (!typeName || depth > 3) return undefined;
  const types = typesNamed(typeName, context);
  if (types.length === 0) {
    if (RTL_PROCEDURAL_TYPES.has(typeName) || /^t\w*(?:event|proc|method|callback)$/.test(typeName)) return true;
    return SYSTEM_VALUE_TYPES.has(typeName) ? false : undefined;
  }
  return types.some((t) => t.kind === 'type_alias' && isProceduralTypeText(aliasedTypeText(t, context), context, depth + 1));
}

/** The System unit's value types, lowercased, which hold no routine. */
const SYSTEM_VALUE_TYPES: ReadonlySet<string> = new Set([
  'boolean', 'bytebool', 'wordbool', 'longbool', 'integer', 'cardinal', 'shortint', 'smallint', 'longint', 'longword',
  'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'byte', 'word', 'dword', 'nativeint',
  'nativeuint', 'single', 'double', 'extended', 'real', 'currency', 'comp', 'char', 'ansichar', 'widechar', 'string',
  'ansistring', 'widestring', 'unicodestring', 'shortstring', 'rawbytestring', 'utf8string', 'pchar', 'pansichar',
  'pwidechar', 'pointer', 'variant', 'olevariant', 'tdatetime', 'tdate', 'ttime',
]);

/**
 * The project's Pascal types a name names, generic ones by the name before
 * their parameters: `TSetParams<T: class>` for `TSetParams`.
 */
function typesNamed(lower: string, context: ResolutionContext): Node[] {
  const m = memos(context);
  if (!m.genericTypes) {
    const generic = new Map<string, Node[]>();
    const add = (n: Node): void => {
      const open = n.name.indexOf('<');
      if (n.language !== 'pascal' || open <= 0 || !(n.kind === 'type_alias' || CLASS_KINDS.has(n.kind))) return;
      const base = n.name.slice(0, open).trim().toLowerCase();
      const list = generic.get(base);
      if (list) list.push(n);
      else generic.set(base, [n]);
    };
    const kinds = ['type_alias', 'class', 'struct', 'interface'] as const;
    // The names alone first, where the index can tell them, to fetch only
    // the generic types.
    const names = context.getNodeNamesOfKinds?.('pascal', kinds);
    if (names) {
      for (const name of new Set(names)) if (name.includes('<')) context.getNodesByName(name).forEach(add);
    } else {
      for (const kind of kinds) for (const n of context.iterateNodesByKind?.(kind) ?? context.getNodesByKind(kind)) add(n);
    }
    m.genericTypes = generic;
  }
  return pascalNamed(lower, context).filter((t) => t.kind === 'type_alias' || CLASS_KINDS.has(t.kind))
    .concat(m.genericTypes.get(lower) ?? []);
}

/**
 * What a type declaration says after its `=`, which may start on the next
 * line: `procedure(...) of object` for `TOnHelper =` above it.
 */
function aliasedTypeText(alias: Node, context: ResolutionContext): string {
  const lines = fileLines(alias.filePath, context);
  let text = '';
  for (let i = alias.startLine - 1; i < alias.startLine + 2 && i < lines.length; i++) {
    text += ' ' + lines[i]!.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)/g, ' ');
    const eq = text.indexOf('=');
    if (eq >= 0 && text.slice(eq + 1).trim()) return text.slice(eq + 1).trim();
  }
  return '';
}

/** A routine type written out: `procedure(...) of object`, `function: T`, `reference to procedure`. */
const PROCEDURAL_TYPE = /^(?:reference\s+to\s+)?(?:procedure|function)\b/i;

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
