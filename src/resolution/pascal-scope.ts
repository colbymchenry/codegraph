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
 * A Pascal `inherited` call as the extractor records it: `{inherited@TChild}.Run`
 * for `inherited Run(N)`, and `{inherited/1@TChild}.Run` for a bare
 * `inherited;` in a method of one parameter, which passes its own.
 */
const INHERITED = /^\{inherited(?:\/(\d+))?@([^}]+)\}\.([A-Za-z_]\w*)$/;

/** Whether `ref` is a Pascal `inherited` call (see INHERITED), which only this module resolves. */
export function isPascalInheritedCall(ref: UnresolvedRef): boolean {
  return ref.language === 'pascal' && ref.referenceKind === 'calls' && INHERITED.test(ref.referenceName);
}

/**
 * The method a Pascal `inherited` call runs: of the name it is written with,
 * or a bare `inherited`'s own routine's, the one the nearest ancestor of the
 * calling method's class declares (see inheritedAncestry), never the class's
 * own. Of that ancestor's overloads, one the call's arguments fit — a bare
 * call passes its routine's parameters, so one of the same types first —
 * and when none does, one an ancestor further up declares, as an `overload`
 * set reaches them. Null when the nearest declaration of the name is data (a
 * property, a field), when none of the project's ancestors declares it (the
 * RTL's `TComponent.Create`), or when no overload takes the arguments.
 */
export function matchPascalInheritedCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = INHERITED.exec(ref.referenceName);
  if (!m) return null;
  const cls = classByQualifiedName(m[2]!, ref.filePath!, context);
  if (!cls) return null;
  const lower = m[3]!.toLowerCase();
  const bare = m[1] !== undefined;
  const count = bare ? Number(m[1]) : pascalCallArgumentCount(ref, context);
  const caller = routineNode(ref.fromNodeId, context);
  if (caller && classInitializer(caller, context)) return null;
  // A bare call passes the routine's own parameters: an override's match the
  // method it overrides, types and all.
  const own = bare && caller && caller.name.toLowerCase() === lower ? pascalParameterTypes(caller.signature) : null;
  for (const c of inheritedAncestry(cls, context)) {
    const owner = c.qualifiedName.toLowerCase();
    const members = pascalNamed(lower, context).filter((n) => MEMBER_KINDS.has(n.kind) && n.filePath === c.filePath && ownerOf(n) === owner);
    if (members.length === 0) continue;
    if (!members.some(isRoutine)) return null;
    const routines = members.filter((n) => isRoutine(n) && !classInitializer(n, context));
    const fitting = count === null ? routines : routines.filter((n) => {
      const range = pascalParameterRange(n.signature);
      return range === null || (count >= range[0] && count <= range[1]);
    });
    if (fitting.length === 0) continue;
    const exact = (n: Node): boolean => pascalParameterRange(n.signature)?.[1] === count;
    const sameTypes = (n: Node): boolean => own !== null && String(pascalParameterTypes(n.signature)) === String(own);
    const chosen = fitting.find(sameTypes) ?? (count === null ? fitting.find((n) => !needsArguments(n)) : fitting.find(exact)) ?? fitting[0]!;
    context.rememberNode?.(chosen);
    return { original: ref, targetNodeId: chosen.id, confidence: 0.9, resolvedBy: 'instance-method' };
  }
  return null;
}

/**
 * Whether a routine is a class constructor or destructor (`class constructor
 * Create;`), which only the runtime runs: no `inherited Create` reaches one,
 * and an `inherited` written in one links nothing.
 */
function classInitializer(routine: Node, context: ResolutionContext): boolean {
  if (routine.isStatic !== true) return false;
  const keyword = routineKeyword(routine, context);
  return keyword === 'constructor' || keyword === 'destructor';
}

/**
 * The classes an `inherited` call made in a method of `cls` looks in, nearest
 * first: the class it descends from, then that one's, as far as the project
 * declares them where each class can see them — never an interface it
 * implements, whose methods have no body. A helper's method looks in the
 * helpers it descends from, then in the type it helps, then in that type's
 * ancestors.
 */
function inheritedAncestry(cls: Node, context: ResolutionContext): Node[] {
  const memo = memos(context).inheritedChains;
  const hit = memo.get(cls.id);
  if (hit) return hit;
  const order: Node[] = [];
  const seen = new Set<string>([cls.id]);
  const add = (next: Node | null): Node | null => {
    if (!next || next.kind !== 'class' || seen.has(next.id) || order.length >= MAX_HIERARCHY_DEPTH) return null;
    seen.add(next.id);
    order.push(next);
    return next;
  };
  let c: Node | null = cls;
  const helper = helperHead(cls);
  if (helper) {
    for (let h: Node | null = cls; h;) {
      const parent: string | null | undefined = helperHead(h)?.parent;
      h = add(parent ? visibleClassNamed(parent, h.filePath, context) : null);
    }
    c = add(visibleClassNamed(helper.helped, cls.filePath, context));
  }
  while (c) {
    // A class's first supertype is the class it descends from; the others are interfaces.
    const base: string | undefined = declaredSupertypes(c, context)[0];
    c = add(base ? visibleClassNamed(base, c.filePath, context) : null);
  }
  memo.set(cls.id, order);
  return order;
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
 *
 * A bare call in a `with` body is first a member of the `with` statement's
 * subject (see withSubjectMember), whatever the strategy chose: in
 * `with TJsonWriter.CreateOwnedStream(tmp) do … SetText(result)`, the
 * writer's `SetText`, not a list class's. A bare call that reached a routine
 * no scope of the call declares — no `with` subject, the calling routine,
 * its class, its unit, the units it uses — links nothing: the name is the
 * RTL's or another library's, which the project doesn't hold (HeidiSQL's
 * `Max(a, b)` from `System.Math` reached `SynEditMiscProcs.Max`, a unit it
 * doesn't use; DUnit's `Check(…)` a test script's `TBase.Check`). One its
 * scope declares is what the scope declares first, whatever namesake the
 * strategy chose: the routine, or the data holding one; nothing when that is
 * a type (a typecast), other data, or a parameter or local of the caller.
 *
 * A call that landed on a routine reaches the overload its arguments fit
 * (pascalOverloadFor).
 */
export function gatePascalCall(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // An `inherited` call is settled where it is matched, overload included.
  if (isPascalInheritedCall(ref)) return result;
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target) return result;
  const bare = isBareCall(ref, context);
  if (bare) {
    const member = withSubjectMember(ref.referenceName.toLowerCase(), ref, context);
    if (member) {
      // A subject's data runs only when it holds a routine.
      if (!isRoutine(member) && !(DATA_KINDS.has(member.kind) && isProceduralData(member, context))) return null;
      // An overload of it the strategy chose stands: the arguments' count decides between them, not the order they are declared in.
      if (member.id === target.id || (member.qualifiedName === target.qualifiedName && member.kind === target.kind &&
          member.filePath === target.filePath)) return pascalOverloadFor(result, ref, context);
      context.rememberNode?.(member);
      return pascalOverloadFor({ ...result, targetNodeId: member.id, confidence: 0.9, resolvedBy: 'instance-method' }, ref, context);
    }
  }
  if (DATA_KINDS.has(target.kind)) return gatePascalDataCall(target, result, ref, context);
  if (isNestedRoutine(target, context)) {
    const nested = gatePascalNestedTarget(result, ref, context);
    return nested && pascalOverloadFor(nested, ref, context);
  }
  // A helper's method is callable only where the helper is in scope: never
  // from a unit that neither declares nor uses it (SynEdit's VCL
  // `Canvas.FillRect(R)` is no FireMonkey canvas helper's).
  if (isRoutine(target) && helperOwned(target, context) && !helperVisible(classOfRoutine(target, context)!, ref.filePath!, context)) return null;
  if (bare && isRoutine(target)) {
    const decl = declarationInScope(ref.referenceName.toLowerCase(), classOfCall(ref, context), ref, context);
    if (!decl) return scopeKnown(ref.filePath!, context) ? null : pascalOverloadFor(result, ref, context);
    // What the scope declares first is what the name means, whatever
    // namesake the strategy chose: a routine; data that runs the routine it
    // holds; never a type (`TFoo(X)` is a typecast) nor other data; and a
    // parameter or local of the calling routine before any of them
    // (DelphiMVCFramework's `Log('…')` on a `Log: TProc<string>`).
    const declared = isRoutine(decl.node) ? decl.node : routineAlternative(decl.node, context) ?? decl.node;
    if (sameRoutine(declared, target, context)) return pascalOverloadFor(result, ref, context);
    if (!isNestedRoutine(declared, context) && declaredAsLocal(ref.referenceName.toLowerCase(), ref, context)) return null;
    if (!isRoutine(declared) && !(DATA_KINDS.has(declared.kind) && isProceduralData(declared, context))) return null;
    // Routines of one name in several units the code sees are one set of
    // overloads (mORMot's `ConsoleWrite(Text, Color)` in mormot.core.os and
    // `ConsoleWrite(Fmt, Args)` in mormot.core.text): the strategy's choice
    // among them stands while the call's arguments fit it, else the one
    // taking them exactly, else one they fit.
    let chosen = declared;
    if (isRoutine(declared) && !declared.qualifiedName.includes('::')) {
      const overloads = pascalNamed(ref.referenceName.toLowerCase(), context).filter((n) =>
        n.kind === 'function' && !n.qualifiedName.includes('::') && unitRoutineInScope(n, ref.filePath!, context));
      if (overloads.some((n) => n.id === target.id) && fitsArguments(target, ref, context)) return pascalOverloadFor(result, ref, context);
      const fitting = overloads.filter((n) => fitsArguments(n, ref, context));
      chosen = fitting.find((n) => takesExactly(n, ref, context)) ?? fitting.find((n) => n.id === declared.id) ?? fitting[0] ?? declared;
      if (sameRoutine(chosen, target, context)) return pascalOverloadFor(result, ref, context);
    }
    context.rememberNode?.(chosen);
    return pascalOverloadFor({ ...result, targetNodeId: chosen.id, confidence: decl.confidence, resolvedBy: decl.resolvedBy }, ref, context);
  }
  return pascalOverloadFor(result, ref, context);
}

/**
 * Whether the routine making a call declares the called name as a parameter
 * or a local of its own, or one of the routines it is nested in does, above
 * the call (`procedure Show(Log: TProc<string>)`): not a routine's header
 * (`function Max: Integer`), nor what a routine nested beside it declares.
 */
function declaredAsLocal(lower: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const lines = fileLines(ref.filePath!, context);
  const from = routineHeaderAt(ref.filePath!, ref.line, context);
  const name = escapeRegExp(lower);
  const mentions = new RegExp(`\\b${name}\\b`, 'i');
  const declares = new RegExp(
    `(?<![.\\w])(?<!\\b(?:procedure|function|constructor|destructor|operator)\\s+(?:[\\w<>]+\\s*\\.\\s*)*)${name}(?:\\s*,\\s*&?[A-Za-z_]\\w*)*\\s*:(?!=)`, 'i');
  const elsewhere = nestedRoutineSpans(ref.filePath!, context).filter(([start, end]) => ref.line < start || ref.line > end);
  for (let i = Math.max(1, from); i <= ref.line && i <= lines.length; i++) {
    const raw = lines[i - 1]!;
    if (!mentions.test(raw) || elsewhere.some(([start, end]) => i >= start && i <= end)) continue;
    if (declares.test(raw.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)|'(?:[^']|'')*'/g, ' '))) return true;
  }
  return false;
}

/** Whether a unit's routine is one a file sees: its own unit's, or one a unit it uses declares in its interface. */
function unitRoutineInScope(routine: Node, fromFile: string, context: ResolutionContext): boolean {
  const unit = unitFilesOf(routine.filePath, context)[0]!;
  if (ownUnitFiles(fromFile, context).includes(unit) || ownUnitFiles(fromFile, context).includes(routine.filePath)) return true;
  return usedUnitFiles(fromFile, context).includes(unit) && exportedRoutine(routine, context);
}

/** Whether a call's argument count fits a routine's parameters; true when either can't be read. */
function fitsArguments(routine: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const count = pascalCallArgumentCount(ref, context);
  const range = pascalParameterRange(routine.signature);
  return count === null || range === null || (count >= range[0] && count <= range[1]);
}

/** Whether a routine takes exactly a call's argument count, none of them left to a default. */
function takesExactly(routine: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const count = pascalCallArgumentCount(ref, context);
  const range = pascalParameterRange(routine.signature);
  return count !== null && range !== null && range[0] === count && range[1] === count;
}

/**
 * Whether two routine nodes are the same routine, or overloads of it: the
 * same node, or of one qualified name (whatever its case) in one unit — a
 * routine declared in a unit's file and implemented in one of its include
 * files is two nodes (mORMot's `mormot.core.base.pas` and
 * `mormot.core.base.asmx64.inc`).
 */
function sameRoutine(a: Node, b: Node, context: ResolutionContext): boolean {
  if (a.id === b.id) return true;
  if (!isRoutine(a) || !isRoutine(b) || a.qualifiedName.toLowerCase() !== b.qualifiedName.toLowerCase()) return false;
  return a.filePath === b.filePath || unitFilesOf(a.filePath, context)[0] === unitFilesOf(b.filePath, context)[0];
}

/**
 * A routine of a unit's declaration's name that its unit declares too: two
 * declarations of one name in one unit are `{$ifdef}` alternatives, and the
 * routine is the one with a body to read — mORMot's `MoveFast`, a variable
 * holding `Move` or the asm procedure `mormot.core.base.asmx64.inc`
 * implements, and `ToByte`, a type or an inline function.
 */
function routineAlternative(decl: Node, context: ResolutionContext): Node | null {
  if (decl.qualifiedName.includes('::')) return null;
  const unit = unitFilesOf(decl.filePath, context)[0];
  return pascalNamed(decl.name.toLowerCase(), context).find((n) => n.kind === 'function' &&
    n.qualifiedName.toLowerCase() === decl.qualifiedName.toLowerCase() && unitFilesOf(n.filePath, context)[0] === unit) ?? null;
}

/** Whether a member is a helper's (`TFooHelper = class helper for TFoo`). */
function helperOwned(member: Node, context: ResolutionContext): boolean {
  const owner = classOfRoutine(member, context);
  return !!owner && helperHead(owner) !== null;
}

/**
 * Whether a helper is in scope in a file: its unit is the file's or one it
 * uses, or a helper in scope there descends from it.
 */
function helperVisible(helper: Node, fromFile: string, context: ResolutionContext): boolean {
  const own = ownUnitFiles(fromFile, context);
  const used = usedUnitFiles(fromFile, context);
  const sees = (file: string): boolean => own.includes(file) || used.includes(file);
  if (sees(helper.filePath)) return true;
  for (const list of helpersByType(context).values()) {
    for (const h of list) {
      if (!sees(h.filePath)) continue;
      for (let p: Node | null = h, depth = 0; p && depth < MAX_HIERARCHY_DEPTH; depth++) {
        if (p.id === helper.id) return true;
        const parent: string | null | undefined = helperHead(p)?.parent;
        p = parent ? visibleClassNamed(parent, p.filePath, context) : null;
      }
    }
  }
  return false;
}

/**
 * Of the overloads of a routine a call reached through its receiver's type
 * (see matchPascalHelperCall), one taking exactly the call's argument count,
 * none of them left to a default, before the one reached: memberOfValue
 * takes an overload callable without arguments first, which suits a
 * paren-less name. HeidiSQL's `Result.Add(Node)` is `Add(Value: TXmlNode)`,
 * not `Add(NodeType: TXmlNodeType = ntElement)`.
 */
function overloadByArity(member: Node, ref: UnresolvedRef, context: ResolutionContext): Node {
  const count = pascalCallArgumentCount(ref, context);
  if (count === null) return member;
  const exact = context.getNodesByQualifiedName(member.qualifiedName).find((n) => {
    if (n.kind !== member.kind || n.language !== 'pascal' || n.filePath !== member.filePath) return false;
    const range = pascalParameterRange(n.signature);
    return range !== null && range[0] === count && range[1] === count;
  });
  return exact ?? member;
}

/**
 * Of the overloads of the routine a call reached — the routines of its
 * qualified name and kind in its file — one the call's argument count fits,
 * when the reached one does not fit it (#3453). The name strategies choose
 * among overloads by where they are, and a routine is where its body is:
 * HeidiSQL's `SetRedraw(False)` reached the two-parameter
 * `SetRedraw(AHandle: HWND; const Value: Boolean)` implemented nearer the
 * call than `SetRedraw(const Value: Boolean)`. Of several that fit, one
 * taking exactly that many, else the first.
 */
function pascalOverloadFor(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef {
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target || target.language !== 'pascal' || (target.kind !== 'method' && target.kind !== 'function')) return result;
  const overloads = context.getNodesByQualifiedName(target.qualifiedName).filter((n) =>
    n.id !== target.id && n.kind === target.kind && n.language === 'pascal' && n.filePath === target.filePath);
  if (overloads.length === 0) return result;
  const count = pascalCallArgumentCount(ref, context);
  if (count === null) return result;
  const range = (n: Node): [number, number] | null => pascalParameterRange(n.signature);
  const fits = (n: Node): boolean => {
    const r = range(n);
    return r !== null && count >= r[0] && count <= r[1];
  };
  if (fits(target)) return result;
  const fitting = overloads.filter(fits);
  if (fitting.length === 0) return result;
  const choice = fitting.find((n) => range(n)![1] === count) ?? fitting[0]!;
  context.rememberNode?.(choice);
  return { ...result, targetNodeId: choice.id };
}

/**
 * How many arguments a Pascal call passes: the list in parentheses after the
 * called name, from the reference's column on and across lines; 0 for a call
 * written without one. Null when the name is not there, or is indexed.
 */
function pascalCallArgumentCount(ref: UnresolvedRef, context: ResolutionContext): number | null {
  const lines = fileLines(ref.filePath!, context);
  const line = lines[ref.line - 1];
  if (line === undefined) return null;
  const name = ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1);
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  // The name's first mention from the reference on that a `.` does not
  // follow: mORMot's `log.Log(sllWarning, …)` calls `Log` on a local `log`.
  const word = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
  word.lastIndex = Math.max(0, ref.column ?? 0);
  let found = word.exec(line);
  while (found && /^\s*(?:\^\s*)?\./.test(line.slice(found.index + found[0].length))) found = word.exec(line);
  if (!found) return null;
  // The text after the name, a line more at a time while the call runs on (40 at most).
  let text = line.slice(found.index + found[0].length);
  let next = ref.line;
  const more = (): boolean => {
    if (next >= lines.length || next >= ref.line + 40) return false;
    text += '\n' + lines[next++]!;
    return true;
  };
  const find = (token: string, from: number): number => {
    for (;;) {
      const at = text.indexOf(token, from);
      if (at >= 0 || !more()) return at;
    }
  };
  let i = 0;
  const skipBlanks = (): void => {
    do {
      while (i < text.length && /\s/.test(text[i]!)) i++;
    } while (i >= text.length && more());
  };
  skipBlanks();
  // Explicit generic arguments: `Make<TFoo>(…)`.
  if (text[i] === '<') {
    const close = find('>', i);
    if (close < 0) return null;
    i = close + 1;
    skipBlanks();
  }
  if (text[i] === '[') return null;
  if (text[i] !== '(') return 0;
  // Inside the call's own parentheses.
  i++;
  let depth = 1;
  let commas = 0;
  let any = false;
  for (;;) {
    if (i >= text.length && !more()) return null;
    const c = text[i]!;
    if (c === "'") {
      // A string, on its line; '' is a quote inside it.
      for (i++; i < text.length && !(text[i] === "'" && text[i + 1] !== "'"); i += text[i] === "'" ? 2 : 1);
      any = true;
      i++;
      continue;
    }
    if (c === '{' || (c === '(' && text[i + 1] === '*') || (c === '/' && text[i + 1] === '/')) {
      const end = c === '{' ? find('}', i) : c === '(' ? find('*)', i + 2) : find('\n', i);
      if (end < 0) return null;
      i = end + (c === '(' ? 2 : 1);
      continue;
    }
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) return any ? commas + 1 : 0;
    } else if (c === ',' && depth === 1) {
      commas++;
    }
    if (!/\s/.test(c)) any = true;
    i++;
  }
}

/**
 * The fewest and most arguments a Pascal routine takes, from its signature
 * (`(const A, B: Integer; C: string = ''): Boolean`): a parameter with a
 * default may be left out. [0, 0] for a routine with no parameter list.
 */
function pascalParameterRange(signature: string | undefined): [number, number] | null {
  const groups = pascalParameterGroups(signature);
  if (!groups) return null;
  let min = 0;
  let max = 0;
  for (const group of groups) {
    const names = groupNames(group).length;
    max += names;
    const colon = group.indexOf(':');
    if (colon < 0 || !group.slice(colon).includes('=')) min += names;
  }
  return [min, max];
}

/**
 * The type of each of a Pascal routine's parameters, with how it is passed
 * (`const integer`, `var tstrings`), from its signature
 * (`(const A, B: Integer; var L: TStrings)`); [] for none, null when the
 * signature can't be read.
 */
function pascalParameterTypes(signature: string | undefined): string[] | null {
  const groups = pascalParameterGroups(signature);
  if (!groups) return null;
  const types: string[] = [];
  for (const group of groups) {
    const colon = group.indexOf(':');
    const passed = /^\s*(?:\[[^\]]*\]\s*)*(const|constref|var|out)\b/i.exec(group)?.[1]?.toLowerCase() ?? '';
    const type = colon < 0 ? '' : group.slice(colon + 1).replace(/=[\s\S]*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (let k = groupNames(group).length; k > 0; k--) types.push(`${passed} ${type}`);
  }
  return types;
}

/** The names a parameter group declares (`const A, B: Integer` → A, B). */
function groupNames(group: string): string[] {
  const colon = group.indexOf(':');
  return (colon < 0 ? group : group.slice(0, colon))
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:const|constref|var|out)\b/gi, ' ')
    .split(',')
    .filter((n) => n.trim());
}

/**
 * A Pascal signature's parameter groups, the text between its parentheses
 * split at the `;`s outside brackets and strings; [] when it has no
 * parameter list, null when the list doesn't close.
 */
function pascalParameterGroups(signature: string | undefined): string[] | null {
  const text = signature ?? '';
  const open = text.indexOf('(');
  if (open < 0) return [];
  const groups: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'") {
      for (i++; i < text.length && !(text[i] === "'" && text[i + 1] !== "'"); i += text[i] === "'" ? 2 : 1);
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
      if (depth === 0) {
        groups.push(text.slice(start, i));
        return groups;
      }
    } else if (c === ';' && depth === 1) {
      groups.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return null;
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
 * that swallowed the ones after it; else the reference's method's class. A
 * helper's method (`procedure TFooHelper.Bar;`) is its helper's, whose
 * ancestors include the type it helps (see ancestorsOf).
 */
function classOfCall(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const qn = headerClassAt(ref.filePath!, ref.line, context);
  const cls = qn ? classByQualifiedName(qn, ref.filePath!, context) : null;
  if (cls) return cls;
  const routine = context.getNodeById?.(ref.fromNodeId);
  return routine?.kind === 'method' ? classOfRoutine(routine, context) : null;
}

/**
 * Whether what a file's code sees is known: a unit's or a program's file,
 * or an include file whose unit includes it. One no file of the project
 * includes with `{$I}` (an Inno Setup script's, pulled in by `#include`) may
 * see declarations its includer's other files make.
 */
function scopeKnown(filePath: string, context: ResolutionContext): boolean {
  return !/\.inc$/i.test(filePath) || unitFilesOf(filePath, context)[0] !== filePath;
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
        headers.push({ line: i + 1, classQn: null, routine: false, qn: null });
        continue;
      }
      const m = header.exec(text);
      if (!m) continue;
      const parts = m[1]!.replace(/<[^>]*>/g, '').replace(/\s+/g, '').split('.');
      headers.push({ line: i + 1, classQn: parts.length > 1 ? parts.slice(0, -1).join('::') : null, routine: true, qn: parts.join('::') });
    }
    memo.set(filePath, headers);
  }
  return headerAt(headers, line)?.classQn ?? null;
}

/** The qualified name of the routine the nearest routine header at or above a line names (`TFoo::Bar`), or null as for headerClassAt. */
function headerRoutineAt(filePath: string, line: number, context: ResolutionContext): string | null {
  headerClassAt(filePath, line, context);
  return headerAt(memos(context).headerClasses.get(filePath) ?? [], line)?.qn ?? null;
}

/** The last of a file's header lines (see headerClassAt) at or above a line. */
function headerAt<T extends { line: number }>(headers: T[], line: number): T | undefined {
  let lo = 0;
  let hi = headers.length - 1;
  let hit: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headers[mid]!.line <= line) {
      hit = headers[mid];
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
 * unit. Null when none is. Code the graph gives to the file — a helper's
 * method, which is no node — is the routine's whose header is above it.
 */
function nestedRoutineInScope(lower: string, ref: UnresolvedRef, context: ResolutionContext): Found | null {
  // Most names no nested routine has: settled before any other lookup.
  const named = pascalNamed(lower, context);
  if (!named.some((n) => n.kind === 'function' && n.qualifiedName.includes('::'))) return null;
  const caller = routineNode(ref.fromNodeId, context);
  const fromHeader = caller ? null : headerRoutineAt(ref.filePath!, ref.line, context);
  const memo = memos(context).nestedInScope;
  const key = `${ref.fromNodeId}|${fromHeader ?? ''}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Found | null = null;
  if ((caller && caller.language === 'pascal') || fromHeader) {
    const chain = (caller?.qualifiedName ?? fromHeader!).toLowerCase();
    let best: Node | null = null;
    let depth = -1;
    for (const n of named) {
      // A routine whose header is above the code is no node: what is nested in it is one by its name alone.
      const nested = caller ? isNestedRoutine(n, context) : n.kind === 'function' && n.language === 'pascal' && n.qualifiedName.includes('::');
      if (n.filePath !== ref.filePath || !nested) continue;
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
  const member = cls ? memberOfSelf(cls, lower, ref.filePath!, context) : null;
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
    const member = memberOfValue(type, lower, ref.filePath!, context);
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
    const member = memberOfSelf(cls, lower, ref.filePath!, context);
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
// `with` statements
// ---------------------------------------------------------------------------

/**
 * A `with` statement of a file: its subjects as written (`with A, B do` has
 * two) and the span of its body, as offsets into the file's lines joined by
 * `\n`.
 */
interface WithStatement {
  subjects: string[];
  /** Just after its `do`. */
  start: number;
  /** Where its statement ends: its `;`, or the `end`, `until`, `except`, `finally` or `else` after it. */
  end: number;
  /** The `with` statement whose body holds this one, or -1. */
  parent: number;
}

/**
 * The routine member a bare call in a `with` body reaches as a member of a
 * subject (Delphi looks a name up in the subjects first, the innermost one
 * first, before the routine, its class or its units): in
 * `with TJsonWriter.CreateOwnedStream(tmp) do SetText(result)`, the writer's
 * `SetText` (see withSubjectType). The member may be data. Null when no
 * subject's type declares the name, and when a subject nearer the call than
 * one that does has a type the project doesn't declare whole — an RTL class
 * (`with TRegistry.Create do OpenKeyReadOnly(…)`), a class with an ancestor
 * outside the project, a type the subject's text doesn't say — whose members
 * aren't known.
 */
function withSubjectMember(lower: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const statements = withStatementsAt(ref, context);
  if (statements.length === 0) return null;
  const cls = classOfCall(ref, context);
  // The subjects in the order a name is looked up in them: `with A, B do` is `with A do with B do`.
  const subjects: Subject[] = [];
  for (const statement of statements) {
    for (let k = statement.subjects.length - 1; k >= 0; k--) subjects.push({ statement, k });
  }
  for (let p = 0; p < subjects.length; p++) {
    const type = withSubjectType(subjects, p, cls, ref, context);
    if (!type) return null;
    const member = memberOfValue(type, lower, ref.filePath!, context);
    if (member) return member;
    if (!hierarchyInProject(type, context)) return null;
  }
  return null;
}

/** One subject of a `with` statement: its `k`-th. */
interface Subject {
  statement: WithStatement;
  k: number;
}

/** The `with` statements whose bodies hold a reference, the innermost first. */
function withStatementsAt(ref: UnresolvedRef, context: ResolutionContext): WithStatement[] {
  const { statements, lineStarts } = withOutlineOf(ref.filePath!, context);
  if (statements.length === 0) return [];
  const at = (lineStarts[ref.line - 1] ?? Infinity) + (ref.column ?? 0);
  // The last statement whose body starts at or before the reference; the
  // statements holding the reference are it or the ones around it.
  let lo = 0;
  let hi = statements.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (statements[mid]!.start <= at) {
      k = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const holding: WithStatement[] = [];
  for (; k >= 0; k = statements[k]!.parent) if (statements[k]!.end > at) holding.push(statements[k]!);
  return holding;
}

/** A file's `with` statements (see scanWithStatements), and where each of its lines starts in its text. */
function withOutlineOf(filePath: string, context: ResolutionContext): { statements: WithStatement[]; lineStarts: number[] } {
  const memo = memos(context).withOutlines;
  let outline = memo.get(filePath);
  if (!outline) {
    const lines = fileLines(filePath, context);
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const text = lines.join('\n');
    let statements: WithStatement[] = [];
    if (/\bwith\b/i.test(text)) {
      // What a routine header at the start of a line follows is over, however
      // the blocks before it balanced (see headerClassAt).
      headerClassAt(filePath, 1, context);
      const resets = (memos(context).headerClasses.get(filePath) ?? []).map((h) => lineStarts[h.line - 1] ?? text.length);
      statements = scanWithStatements(text, resets);
    }
    outline = { statements, lineStarts };
    memo.set(filePath, outline);
  }
  return outline;
}

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32, CH_QUOTE = 39, CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42;
const CH_COMMA = 44, CH_DOT = 46, CH_SLASH = 47, CH_SEMI = 59, CH_AMP = 38, CH_LBRACKET = 91, CH_RBRACKET = 93, CH_LBRACE = 123;
const CH_DOLLAR = 36;

function isWordStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isWordPart(c: number): boolean {
  return isWordStart(c) || (c >= 48 && c <= 57);
}

/**
 * The offset after the comment or string that starts at `i` — `{…}`
 * (directives too), `(*…*)`, `//…`, `'…'` with `''` for a quote, ending at
 * its line's end when unterminated — or `i` when none does.
 */
function triviaEnd(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === CH_LBRACE) {
    const e = text.indexOf('}', i + 1);
    return e < 0 ? text.length : e + 1;
  }
  if (c === CH_LPAREN && text.charCodeAt(i + 1) === CH_STAR) {
    const e = text.indexOf('*)', i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (c === CH_SLASH && text.charCodeAt(i + 1) === CH_SLASH) {
    const e = text.indexOf('\n', i + 2);
    return e < 0 ? text.length : e;
  }
  if (c === CH_QUOTE) {
    let j = i + 1;
    while (j < text.length) {
      const d = text.charCodeAt(j);
      if (d === CH_QUOTE) {
        if (text.charCodeAt(j + 1) !== CH_QUOTE) return j + 1;
        j += 2;
      } else if (d === CH_LF) {
        return j;
      } else {
        j++;
      }
    }
    return j;
  }
  return i;
}

/**
 * The `with` statements of a Pascal text, in the order they start. A
 * statement's body runs from its `do` to the `;` that ends the statement, or
 * to the `end`, `until`, `except` or `finally` of the block it is in, or to
 * an `else` that isn't one of its own `if`s'. `begin`, `try`, `case`, `asm`
 * and `repeat` open blocks; a block's `end` with none open (a record's, a
 * class's) is passed over. At each offset in `resets` — the routine headers
 * at the start of a line — every open statement and block ends.
 */
function scanWithStatements(text: string, resets: number[]): WithStatement[] {
  const statements: WithStatement[] = [];
  const blocks: string[] = [];
  const open: Array<{ index: number; depth: number; parens: number; ifs: number }> = [];
  let parens = 0;
  const closeWhile = (at: number, ends: (o: { depth: number; parens: number }) => boolean): void => {
    while (open.length > 0 && ends(open[open.length - 1]!)) statements[open.pop()!.index]!.end = at;
  };
  let reset = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (reset < resets.length && i >= resets[reset]!) {
      closeWhile(resets[reset]!, () => true);
      blocks.length = 0;
      parens = 0;
      while (reset < resets.length && resets[reset]! <= i) reset++;
    }
    const c = text.charCodeAt(i);
    if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
      i++;
      continue;
    }
    const skip = triviaEnd(text, i);
    if (skip > i) {
      i = skip;
      continue;
    }
    if (!isWordStart(c)) {
      if (c === CH_LPAREN || c === CH_LBRACKET) {
        parens++;
      } else if (c === CH_RPAREN || c === CH_RBRACKET) {
        if (parens > 0) parens--;
        closeWhile(i, (o) => o.parens > parens);
      } else if (c === CH_SEMI) {
        closeWhile(i, (o) => o.depth >= blocks.length && o.parens >= parens);
      }
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && isWordPart(text.charCodeAt(j))) j++;
    const top = blocks[blocks.length - 1];
    const before = i > 0 ? text.charCodeAt(i - 1) : 0;
    // A keyword written as a name (`&begin`, `Foo.End`) is a name, and an
    // assembler block is over only at its `end`.
    const word = before === CH_AMP || before === CH_DOT ? '' : text.slice(i, j).toLowerCase();
    if (top === 'asm' && word !== 'end') {
      i = j;
      continue;
    }
    switch (word) {
      case 'begin': case 'try': case 'case': case 'asm': case 'repeat':
        blocks.push(word);
        break;
      case 'end':
        closeWhile(i, (o) => o.depth >= blocks.length);
        blocks.pop();
        break;
      case 'until':
        if (top === 'repeat') {
          closeWhile(i, (o) => o.depth >= blocks.length);
          blocks.pop();
        }
        break;
      case 'except': case 'finally':
        closeWhile(i, (o) => o.depth >= blocks.length);
        break;
      case 'if': {
        const o = open[open.length - 1];
        if (o && o.depth === blocks.length && o.parens === parens) o.ifs++;
        break;
      }
      case 'else':
        // The `else` of an `if` in a statement's body, else the statement's end.
        while (open.length > 0) {
          const o = open[open.length - 1]!;
          if (o.depth < blocks.length || o.parens !== parens) break;
          if (o.ifs > 0) {
            o.ifs--;
            break;
          }
          statements[open.pop()!.index]!.end = i;
        }
        break;
      case 'with': {
        const parsed = withSubjectsAt(text, j);
        if (!parsed) break;
        statements.push({ subjects: parsed.subjects, start: parsed.end, end: n, parent: open.length > 0 ? open[open.length - 1]!.index : -1 });
        open.push({ index: statements.length - 1, depth: blocks.length, parens, ifs: 0 });
        j = parsed.end;
        break;
      }
      default:
        break;
    }
    i = j;
  }
  return statements;
}

/**
 * A `with` statement's subjects, from just after its `with` to its `do`, and
 * the offset after the `do`; null when no `do` closes them within a couple
 * of thousand characters.
 */
function withSubjectsAt(text: string, from: number): { subjects: string[]; end: number } | null {
  const subjects: string[] = [];
  const clean = (s: string): string => s.replace(/\{[^}]*\}|\(\*[\s\S]*?\*\)|\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  let depth = 0;
  let partStart = from;
  const limit = Math.min(text.length, from + 2000);
  let i = from;
  while (i < limit) {
    const c = text.charCodeAt(i);
    const skip = triviaEnd(text, i);
    if (skip > i) {
      i = skip;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < text.length && isWordPart(text.charCodeAt(j))) j++;
      if (depth === 0 && j - i === 2 && text.slice(i, j).toLowerCase() === 'do' && text.charCodeAt(i - 1) !== CH_AMP) {
        subjects.push(clean(text.slice(partStart, i)));
        return { subjects, end: j };
      }
      i = j;
      continue;
    }
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      depth++;
    } else if (c === CH_RPAREN || c === CH_RBRACKET) {
      if (--depth < 0) return null;
    } else if (c === CH_COMMA && depth === 0) {
      subjects.push(clean(text.slice(partStart, i)));
      partStart = i + 1;
    } else if (c === CH_SEMI && depth === 0) {
      return null;
    }
    i++;
  }
  return null;
}

/** One link of a `with` subject: `Items[I]` is `Items`, indexed; `TFoo.Create(Self)` two, the second called. */
interface SubjectLink {
  name: string;
  called: boolean;
  indexed: boolean;
}

/**
 * The class (or record or interface) the project declares that a `with`
 * statement's subject is a value of, read as Delphi reads it: `Self`; a
 * local or parameter of the calling routine, by its declared type; a member
 * of the routine's class, its unit or the units it uses, by its declared
 * type or its result's; then member by member through a chain
 * (`Owner.Items[I]`, an indexed array or generic list giving its element). A
 * class's constructor gives an instance of the class
 * (`TJsonWriter.CreateOwnedStream(tmp)`), a typecast (`TFoo(Sender)`,
 * `Sender as TFoo`) its type, a class's name the class. A subject's first
 * name is first a member of a subject around it (`with Orm do with
 * DynArrayFields[F] do`), as any name in a `with` body is. Null when the type
 * is one the project doesn't declare, or the text doesn't say.
 *
 * `subjects` are the subjects around a reference, the innermost first; the
 * one typed is the `p`-th, and the ones after it are around it.
 */
function withSubjectType(subjects: Subject[], p: number, cls: Node | null, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const { statement, k } = subjects[p]!;
  const memo = memos(context).subjectTypes;
  const key = `${ref.filePath}|${statement.start}|${k}`;
  if (memo.has(key)) return memo.get(key)!;
  // Guards a cycle while the subjects around it are typed.
  memo.set(key, null);
  let type: Node | null = null;
  let text = statement.subjects[k]!;
  while (text.startsWith('(') && closingBracket(text, 0) === text.length - 1) text = text.slice(1, -1).trim();
  const cast = /^(?:.*\S)\s+as\s+&?([A-Za-z_][\w.]*)$/i.exec(text);
  if (cast) {
    type = classNamed(cast[1]!, ref.filePath!, context);
  } else {
    const links = subjectLinks(text);
    // A member of a subject around this one, the innermost first.
    const outer = (lower: string): Node | null => {
      for (let q = p + 1; q < subjects.length; q++) {
        const around = withSubjectType(subjects, q, cls, ref, context);
        const member = around && memberOfValue(around, lower, ref.filePath!, context);
        if (member) return member;
      }
      return null;
    };
    if (links) type = typeOfLinks(links, cls, ref, context, outer);
  }
  memo.set(key, type);
  return type;
}

/** The offset of the bracket that closes the one at `open` (`(`/`[`), or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const skip = triviaEnd(text, i);
    if (skip > i) {
      i = skip - 1;
      continue;
    }
    const c = text.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET) depth++;
    else if ((c === CH_RPAREN || c === CH_RBRACKET) && --depth === 0) return i;
  }
  return -1;
}

/** The links of a `with` subject (see SubjectLink), or null for any other expression. */
function subjectLinks(text: string): SubjectLink[] | null {
  const links: SubjectLink[] = [];
  let i = 0;
  const blanks = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  for (;;) {
    blanks();
    const m = /^&?([A-Za-z_]\w*)/.exec(text.slice(i));
    if (!m) return null;
    const link: SubjectLink = { name: m[1]!, called: false, indexed: false };
    i += m[0].length;
    blanks();
    // A generic type's arguments: `TList<TFoo>.Create`.
    if (text[i] === '<') {
      const close = text.indexOf('>', i);
      if (close < 0) return null;
      i = close + 1;
    }
    for (;;) {
      blanks();
      if (text[i] === '(' || text[i] === '[') {
        const close = closingBracket(text, i);
        if (close < 0) return null;
        if (text[i] === '(') link.called = true;
        else link.indexed = true;
        i = close + 1;
      } else if (text[i] === '^') {
        // Delphi reaches a pointer's members through it: `P^.Name` is `P.Name`.
        i++;
      } else {
        break;
      }
    }
    links.push(link);
    blanks();
    if (i >= text.length) return links;
    if (text[i] !== '.') return null;
    i++;
  }
}

/** What a `with` subject's links reach (see withSubjectType). */
function typeOfLinks(
  links: SubjectLink[], cls: Node | null, ref: UnresolvedRef, context: ResolutionContext, outer: (lower: string) => Node | null,
): Node | null {
  const head = links[0]!;
  const lower = head.name.toLowerCase();
  let rest = links.slice(1);
  let type: Node | null = null;
  // A class written as a value (`TFoo.Create`), whose members are its class's.
  let classRef = false;
  const around = lower === 'self' || lower === 'result' ? null : outer(lower);
  if (lower === 'self') {
    type = cls;
  } else if (lower === 'result') {
    // A function's result, of the type the function declares.
    type = typeOfText(resultTypeText(ref, context) ?? '', ref.filePath!, head.indexed, context);
  } else if (around) {
    ({ type, classRef } = valueOfDeclaration(around, head, context));
  } else {
    const local = head.called ? undefined : localTypeText(lower, ref, context);
    if (local !== undefined) {
      type = typeOfText(local, ref.filePath!, head.indexed, context);
    } else {
      const decl = nestedRoutineInScope(lower, ref, context)?.node ??
        (cls ? memberOfSelf(cls, lower, ref.filePath!, context) : null) ?? ownUnitDeclaration(ref.filePath!, lower, context) ??
        usedUnitFiles(ref.filePath!, context).reduceRight<Node | undefined>(
          (hit, file) => hit ?? unitDeclaration(file, lower, context, ref.filePath!), undefined);
      const unitFile = decl ? null : unitFileNamed(lower, ref.filePath!, context);
      if (decl) {
        ({ type, classRef } = valueOfDeclaration(decl, head, context));
      } else if (unitFile && rest.length > 0) {
        // `UnitName.Name`: what the unit declares.
        const inUnit = unitDeclaration(unitFile, rest[0]!.name.toLowerCase(), context, ref.filePath!);
        if (!inUnit) return null;
        ({ type, classRef } = valueOfDeclaration(inUnit, rest[0]!, context));
        rest = rest.slice(1);
      } else {
        // A class the unit's `uses` don't show, by its name alone.
        type = /^T[A-Z]/.test(head.name) ? classNamed(head.name, ref.filePath!, context) : null;
        classRef = !head.called;
      }
    }
  }
  for (const link of rest) {
    if (!type) return null;
    const name = link.name.toLowerCase();
    const member = memberOfValue(type, name, ref.filePath!, context);
    // A constructor called on a class gives an instance of it: one the class
    // declares, or `Create`, which every class inherits.
    if (classRef && (member ? routineKeyword(member, context) === 'constructor' : name === 'create')) {
      classRef = false;
      continue;
    }
    if (!member) return null;
    type = valueTypeOf(member, link.indexed, context);
    classRef = false;
  }
  return type;
}

/** What a subject's first link is when it names a declaration: a class (a value of it when called, a typecast), or a value of a type. */
function valueOfDeclaration(decl: Node, link: SubjectLink, context: ResolutionContext): { type: Node | null; classRef: boolean } {
  if (CLASS_KINDS.has(decl.kind)) return { type: decl, classRef: !link.called };
  if (decl.kind === 'type_alias') return { type: classNamed(decl.name, decl.filePath, context), classRef: !link.called };
  return { type: valueTypeOf(decl, link.indexed, context), classRef: false };
}

/**
 * The class a member's value is of: a field's, a variable's or a property's
 * declared type, a function's result; indexed, the element of an array or a
 * generic list, or what an array property gives.
 */
function valueTypeOf(member: Node, indexed: boolean, context: ResolutionContext): Node | null {
  if (isRoutine(member)) {
    const result = member.returnType ?? /(?:^|\))\s*:\s*([^;]+?)\s*;?\s*$/.exec(member.signature ?? '')?.[1];
    return result ? typeOfText(result, member.filePath, indexed, context) : null;
  }
  // An array property's declared type is its element's: `property Items[I: Integer]: TItem`.
  const arrayProperty = indexed && member.kind === 'property' &&
    new RegExp(`\\bproperty\\s+${escapeRegExp(member.name)}\\s*\\[`, 'i').test(fileLines(member.filePath, context)[member.startLine - 1] ?? '');
  return typeOfText(declaredTypeText(member, context), member.filePath, indexed && !arrayProperty, context);
}

/**
 * The class a written type names (through its aliases, see classNamed); for
 * an indexed value, the element of an array (`array of TFoo`, an alias of
 * one like `TFooDynArray = array of TFoo;`), of a generic collection
 * (`TObjectList<TFoo>`, a dictionary's value) or what a class's default
 * array property gives.
 */
function typeOfText(text: string, fromFile: string, indexed: boolean, context: ResolutionContext, depth = 0): Node | null {
  // Delphi reaches a pointer's members through it (`F: ^TRec`).
  const t = text.trim().replace(/^\^\s*/, '');
  // The type's name, which a property's `read`/`write` may follow; a generic
  // instance's (`TList<TFoo>`) is no class the project declares by that name.
  const name = /^&?([A-Za-z_][\w.]*)(?![\w.]|\s*<)/.exec(t)?.[1];
  if (!indexed) return name ? classNamed(name, fromFile, context) : null;
  const element = /^(?:packed\s+)?array\s*(?:\[[^\]]*\]\s*)?of\s+&?([A-Za-z_][\w.]*)/i.exec(t)?.[1] ??
    /^[A-Za-z_][\w.]*\s*<\s*(?:[^<>]*,\s*)?&?([A-Za-z_][\w.]*)\s*>/.exec(t)?.[1];
  if (element) return classNamed(element, fromFile, context);
  if (!name || depth > 3) return null;
  for (const alias of typesNamed(name.split('.').pop()!.toLowerCase(), context)) {
    if (alias.kind !== 'type_alias') continue;
    const type = typeOfText(aliasedTypeText(alias, context), alias.filePath, true, context, depth + 1);
    if (type) return type;
  }
  const cls = classNamed(name, fromFile, context);
  return cls ? defaultPropertyType(cls, context) : null;
}

/** What a class's default array property gives (`property Items[I: Integer]: TFoo …; default;`), or null. */
function defaultPropertyType(cls: Node, context: ResolutionContext): Node | null {
  const memo = memos(context).defaultProperties;
  if (memo.has(cls.id)) return memo.get(cls.id)!;
  memo.set(cls.id, null);
  let type: Node | null = null;
  for (const c of ancestorsOf(cls, context)) {
    const owner = c.qualifiedName.toLowerCase();
    const property = context.getNodesInFile(c.filePath).find((n) => {
      if (n.kind !== 'property' || ownerOf(n) !== owner) return false;
      const lines = fileLines(n.filePath, context);
      const text = `${lines[n.startLine - 1] ?? ''} ${lines[n.startLine] ?? ''}`.replace(/\/\/.*$|\{[^}]*\}/gm, ' ');
      return /\bproperty\s+\w+\s*\[[^\]]*\][^;]*;\s*default\s*;/i.test(text);
    });
    if (property) {
      type = valueTypeOf(property, false, context);
      break;
    }
  }
  memo.set(cls.id, type);
  return type;
}

/**
 * The result type, as written, of the function making a call: the routine
 * the reference comes from, or, for code the graph gives to the file (a
 * helper's method), the one whose header is above it.
 */
function resultTypeText(ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  const routine = routineNode(ref.fromNodeId, context);
  const signature = routine ? routine.signature ?? '' : (() => {
    const lines = fileLines(ref.filePath!, context);
    const from = routineHeaderAt(ref.filePath!, ref.line, context);
    // A header's parameters may go on over a few lines.
    let text = '';
    for (let i = from; i <= ref.line && i < from + 6 && i <= lines.length; i++) {
      text += ' ' + lines[i - 1]!.replace(/\/\/.*$|\{[^}]*\}/g, ' ');
      if (/;\s*$/.test(text) && text.split('(').length <= text.split(')').length) break;
    }
    return text.replace(/^\s*(?:class\s+)?function\s+[\w.<>, ]*?(?=[(:])/i, '');
  })();
  return routine?.returnType ?? /(?:^|\))\s*:\s*([^;]+?)\s*;?\s*$/.exec(signature.trim())?.[1];
}

/**
 * The declared type, as written, of a parameter or a local the calling
 * routine declares above a reference, the nearest one (`Writer: TWriter;`,
 * `A, Writer: TWriter`, `var Writer := TWriter.Create;`); not one a routine
 * nested in it declares for itself. Undefined when it declares none.
 */
function localTypeText(lower: string, ref: UnresolvedRef, context: ResolutionContext): string | undefined {
  const lines = fileLines(ref.filePath!, context);
  const from = routineHeaderAt(ref.filePath!, ref.line, context);
  const name = escapeRegExp(lower);
  const mentions = new RegExp(`\\b${name}\\b`, 'i');
  const declares = new RegExp(`(?:^|[^.\\w])${name}(?:\\s*,\\s*&?[A-Za-z_]\\w*)*\\s*:(?!=)\\s*([^;=)]*)`, 'i');
  const created = new RegExp(`\\bvar\\s+${name}\\s*:=\\s*&?([A-Za-z_][\\w.]*)\\s*\\.\\s*create\\b`, 'i');
  const elsewhere = nestedRoutineSpans(ref.filePath!, context).filter(([start, end]) => ref.line < start || ref.line > end);
  let found: string | undefined;
  for (let i = Math.max(1, from); i <= ref.line && i <= lines.length; i++) {
    const raw = lines[i - 1]!;
    if (!mentions.test(raw) || elsewhere.some(([start, end]) => i >= start && i <= end)) continue;
    const text = raw.replace(/\/\/.*$|\{[^}]*\}|\(\*.*?\*\)|'(?:[^']|'')*'/g, ' ');
    const m = declares.exec(text) ?? created.exec(text);
    if (m && m[1]!.trim()) found = m[1]!.trim();
  }
  return found;
}

/** The lines (first, last) of the routines a file nests in others. */
function nestedRoutineSpans(filePath: string, context: ResolutionContext): Array<[number, number]> {
  const memo = memos(context).nestedSpans;
  let spans = memo.get(filePath);
  if (!spans) {
    spans = context.getNodesInFile(filePath)
      .filter((n) => isNestedRoutine(n, context))
      .map((n): [number, number] => [n.startLine, n.endLine ?? n.startLine]);
    memo.set(filePath, spans);
  }
  return spans;
}

/** Roots every class or interface has, whose members a call by name doesn't reach in the project. */
const IMPLICIT_ROOTS: ReadonlySet<string> = new Set(['tobject', 'tinterfacedobject', 'iinterface', 'iunknown', 'idispatch']);

/**
 * Whether the project declares a class's whole hierarchy, so a name its
 * classes don't declare isn't its member (save TObject's): no ancestor is
 * outside the project — for a helper, nor the type it helps — and it is no
 * old-style object or interface with an ancestor of its own, whose
 * ancestors aren't read.
 */
function hierarchyInProject(cls: Node, context: ResolutionContext): boolean {
  const memo = memos(context).wholeHierarchies;
  const hit = memo.get(cls.id);
  if (hit !== undefined) return hit;
  let whole = true;
  for (const c of ancestorsOf(cls, context)) {
    if (helperHead(c)) {
      if (supertypesOf(c, context).some((name) => !visibleClassNamed(name, c.filePath, context))) {
        whole = false;
        break;
      }
      continue;
    }
    const head = fileLines(c.filePath, context).slice(c.startLine - 1, c.startLine + 1).join(' ').replace(/\{[^}]*\}|\/\/.*$/gm, ' ');
    const parentInterface = /=\s*(?:disp)?interface\s*\(\s*&?([A-Za-z_][\w.]*)/i.exec(head)?.[1]?.split('.').pop()!.toLowerCase();
    if (/=\s*(?:packed\s+)?object\s*\(/i.test(head) ||
        (parentInterface !== undefined && !IMPLICIT_ROOTS.has(parentInterface))) {
      whole = false;
      break;
    }
    // A class's first supertype is its ancestor; the others are interfaces it implements.
    const base = declaredSupertypes(c, context)[0];
    if (base && !/^I[A-Z]/.test(base) && !IMPLICIT_ROOTS.has(base.toLowerCase()) && !classNamed(base, c.filePath, context)) {
      whole = false;
      break;
    }
  }
  memo.set(cls.id, whole);
  return whole;
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
  inheritedChains: Map<string, Node[]>;
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
  headerClasses: Map<string, Array<{ line: number; classQn: string | null; routine: boolean; qn: string | null }>>;
  outlines: Map<string, { classes: Node[]; imports: Node[]; routineColumn: number }>;
  conditionDepths: Map<string, number[]>;
  nestedInScope: Map<string, Found | null>;
  routineNodes: Map<string, Node | null>;
  routineQns: Map<string, boolean>;
  withOutlines: Map<string, { statements: WithStatement[]; lineStarts: number[] }>;
  subjectTypes: Map<string, Node | null>;
  nestedSpans: Map<string, Array<[number, number]>>;
  wholeHierarchies: Map<string, boolean>;
  helperMembers: Map<string, Node | null>;
  helpers?: Map<string, Node[]>;
  helperNames?: Set<string>;
  interfaceNames: Map<string, Set<string> | null>;
  defaultProperties: Map<string, Node | null>;
  usesIncludes: Map<string, string[]>;
}
const MEMOS = new WeakMap<ResolutionContext, Memos>();

function memos(context: ResolutionContext): Memos {
  let m = MEMOS.get(context);
  if (!m) {
    m = {
      named: new Map(), inScope: new Map(), classOfRoutine: new Map(), classByQn: new Map(),
      ancestors: new Map(), inheritedChains: new Map(), usedFiles: new Map(), classByName: new Map(), unitFiles: new Map(), hierarchy: new Map(),
      memberTypes: new Map(), keywords: new Map(), procedural: new Map(), headerClasses: new Map(), outlines: new Map(),
      conditionDepths: new Map(), unitFileSets: new Map(), includes: new Map(), includers: new Map(), ownFiles: new Map(),
      nestedInScope: new Map(), routineNodes: new Map(), routineQns: new Map(), withOutlines: new Map(),
      subjectTypes: new Map(), nestedSpans: new Map(), wholeHierarchies: new Map(), helperMembers: new Map(),
      defaultProperties: new Map(), usesIncludes: new Map(), interfaceNames: new Map(),
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

/**
 * A class and its ancestors the project declares, nearest first. A helper's
 * are the helper it descends from, then the type it helps and that type's,
 * whose members its methods reach by name as their own.
 */
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
      // What a helper names is a class its unit sees (see visibleClassNamed).
      const named = helperHead(c) ? visibleClassNamed : classNamed;
      for (const name of supertypesOf(c, context)) {
        const sup = named(name, c.filePath, context);
        if (sup) next.push(sup);
      }
    }
    frontier = next;
  }
  memo.set(cls.id, order);
  return order;
}

/**
 * The class a name means in a file, when the file's unit declares it or a
 * unit it uses does: not the one class of that name anywhere in the project
 * (classNamed's last resort), which an outside type sharing the name isn't.
 */
function visibleClassNamed(typeName: string, fromFile: string, context: ResolutionContext): Node | null {
  const cls = classNamed(typeName, fromFile, context);
  return cls && (ownUnitFiles(fromFile, context).includes(cls.filePath) || usedUnitFiles(fromFile, context).includes(cls.filePath))
    ? cls : null;
}

/**
 * What a helper's head says (`class helper(TBaseHelper) for TFoo`, kept as
 * the helper's signature): the helper it descends from, and the type it
 * helps. Null for any other class.
 */
function helperHead(cls: Node): { parent: string | null; helped: string } | null {
  const m = /^(?:class|record)\s+helper\s*(?:\(\s*&?([A-Za-z_][\w.]*)\s*\))?\s*for\s+&?([A-Za-z_][\w.]*)/i.exec(cls.signature ?? '');
  return m ? { parent: m[1] ?? null, helped: m[2]! } : null;
}

/** The names of the types a class's members come from after its own (see ancestorsOf). */
function supertypesOf(cls: Node, context: ResolutionContext): string[] {
  const helper = helperHead(cls);
  if (!helper) return declaredSupertypes(cls, context);
  return helper.parent ? [helper.parent, helper.helped] : [helper.helped];
}

/**
 * The member a name reaches on a value of a type: one the helper in scope
 * for the type adds (`TFooHelper = class helper for TFoo`, see
 * nearestHelper), which hides one the type declares of that name — Delphi's
 * documentation calls the helper's `MyFunc` for `X.MyFunc` where the class
 * declares one too — else the type's own; then the same for each ancestor.
 */
function memberOfValue(type: Node, lower: string, fromFile: string, context: ResolutionContext): Node | null {
  // A helper's own methods see its scope: its members, the helpers it
  // descends from, then the type it helps (see ancestorsOf).
  if (helperHead(type) || helpersByType(context).size === 0) return memberInHierarchy(type, lower, context);
  const memo = memos(context).helperMembers;
  const key = `value|${type.id}|${fromFile}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  // Class by class from the type up, the helper in scope for each before the
  // class itself: a class's own method comes before a helper for its ancestor
  // (DWScript's `TdwsLLVMCodeGen(Self).TypeSymbolToLLVMType(…)`, inside the
  // helper for `TdwsCodeGen` that declares it too, calls the class's).
  let found: Node | null = null;
  for (const c of ancestorsOf(type, context)) {
    found = helperChainMember(nearestHelper(c, fromFile, context), lower, context) ?? ownMember(c, lower, context);
    if (found) break;
  }
  memo.set(key, found);
  return found;
}

/**
 * The member a bare name reaches in a method of `cls` (an implicit `Self`):
 * one the class or its ancestors declare, else one the helper in scope adds.
 */
function memberOfSelf(cls: Node, lower: string, fromFile: string, context: ResolutionContext): Node | null {
  return memberInHierarchy(cls, lower, context) ??
    (helperHead(cls) ? null : helperMember(cls, lower, fromFile, context));
}

/**
 * A member the helper in scope adds to a type's values, the type's own
 * aside: Delphi applies the nearest helper for a type that the code's unit
 * declares or uses — its own unit's, else the unit it uses last — and a
 * helper for an ancestor to its descendants.
 */
function helperMember(type: Node, lower: string, fromFile: string, context: ResolutionContext): Node | null {
  if (helpersByType(context).size === 0) return null;
  const memo = memos(context).helperMembers;
  const key = `helper|${type.id}|${fromFile}|${lower}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: Node | null = null;
  for (const c of ancestorsOf(type, context)) {
    found = helperChainMember(nearestHelper(c, fromFile, context), lower, context);
    if (found) break;
  }
  memo.set(key, found);
  return found;
}

/**
 * The helper for a class that applies in a file: of those its unit declares
 * or uses, its own unit's, else the one of the unit it uses last, the one
 * declared last of them. Null when none does.
 */
function nearestHelper(cls: Node, fromFile: string, context: ResolutionContext): Node | null {
  const helpers = helpersByType(context).get(cls.id);
  if (!helpers) return null;
  const own = ownUnitFiles(fromFile, context);
  const used = usedUnitFiles(fromFile, context);
  // How near a helper's unit is: its own unit's nearest, then the units used last.
  const rank = (file: string): number => (own.includes(file) ? Infinity : used.indexOf(file));
  return helpers.filter((h) => rank(h.filePath) >= 0)
    .sort((a, b) => rank(b.filePath) - rank(a.filePath) || b.startLine - a.startLine)[0] ?? null;
}

/** A member a helper declares, or one of the helpers it descends from. */
function helperChainMember(helper: Node | null, lower: string, context: ResolutionContext): Node | null {
  for (let h = helper, depth = 0; h && depth < MAX_HIERARCHY_DEPTH; depth++) {
    const member = ownMember(h, lower, context);
    if (member) return member;
    const parent: string | null | undefined = helperHead(h)?.parent;
    h = parent ? visibleClassNamed(parent, h.filePath, context) : null;
  }
  return null;
}

/** A member a class declares itself; a parameterless overload before the others. */
function ownMember(cls: Node, lower: string, context: ResolutionContext): Node | null {
  const owner = cls.qualifiedName.toLowerCase();
  const members = pascalNamed(lower, context).filter((n) => MEMBER_KINDS.has(n.kind) && n.filePath === cls.filePath && ownerOf(n) === owner);
  return members.find((n) => !needsArguments(n)) ?? members[0] ?? null;
}

/**
 * A Pascal call through a receiver (`R.Total(3)`, `DataGrid.TrySetFocus`) to
 * a method of a name some helper declares (`TRecordHelper = class helper for
 * TRecord`): a guess by name can't tell the helper's from its namesakes, a
 * method of the type's own among them, so the receiver's type decides: the
 * method the helper in scope for it adds, which hides one of the type's own
 * of that name, else the type's own (see memberOfValue). HeidiSQL declares
 * `TrySetFocus` in a helper for the VCL's `TWinControl` and in its virtual
 * tree. Undefined for any other call, which the other strategies resolve as
 * before: a name no helper declares, a receiver whose type isn't read, a
 * method its type doesn't reach.
 */
export function matchPascalHelperCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | undefined {
  if (ref.language !== 'pascal' || ref.referenceKind !== 'calls') return undefined;
  const dot = ref.referenceName.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const method = ref.referenceName.slice(dot + 1).toLowerCase();
  // Most names no helper declares: settled before the receiver is read.
  if (!helperMemberNames(context).has(method)) return undefined;
  const links = subjectLinks(ref.referenceName.slice(0, dot));
  if (!links) return undefined;
  const cls = classOfCall(ref, context);
  // The receiver's first name may be a member of a `with` subject around the call.
  const statements = withStatementsAt(ref, context);
  const subjects: Subject[] = [];
  for (const statement of statements) {
    for (let k = statement.subjects.length - 1; k >= 0; k--) subjects.push({ statement, k });
  }
  const outer = (lower: string): Node | null => {
    for (let p = 0; p < subjects.length; p++) {
      const type = withSubjectType(subjects, p, cls, ref, context);
      const member = type && memberOfValue(type, lower, ref.filePath!, context);
      if (member) return member;
    }
    return null;
  };
  const type = typeOfLinks(links, cls, ref, context, outer);
  if (!type) return undefined;
  // A type a lone name gives is one the file sees, not the project namesake
  // of an outside type (swagdoc's `System.JSON` `TJSONObject`, which
  // JsonDataObjects' `TJsonObject` is not; see visibleClassNamed).
  if (links.length === 1 && !(ownUnitFiles(ref.filePath!, context).includes(type.filePath) ||
      usedUnitFiles(ref.filePath!, context).includes(type.filePath))) return undefined;
  const reached = memberOfValue(type, method, ref.filePath!, context);
  if (!reached || !isRoutine(reached)) return undefined;
  const member = overloadByArity(reached, ref, context);
  context.rememberNode?.(member);
  return pascalOverloadFor({ original: ref, targetNodeId: member.id, confidence: 0.9, resolvedBy: 'instance-method' }, ref, context);
}

/** The names of the routines the project's helpers declare, lowercased, whatever type each helps. */
function helperMemberNames(context: ResolutionContext): Set<string> {
  const m = memos(context);
  if (!m.helperNames) {
    const names = new Set<string>();
    for (const helper of context.iterateNodesByKind?.('class') ?? context.getNodesByKind('class')) {
      if (helper.language !== 'pascal' || !helperHead(helper)) continue;
      const owner = helper.qualifiedName.toLowerCase();
      for (const n of context.getNodesInFile(helper.filePath)) {
        if (isRoutine(n) && ownerOf(n) === owner) names.add(n.name.toLowerCase());
      }
    }
    m.helperNames = names;
  }
  return m.helperNames;
}

/**
 * The project's helpers by the id of the class each helps: a class the
 * helper's unit declares or uses. A helper for a type outside the project
 * helps none of the project's classes, though one shares its name
 * (swagdoc's `class helper for TJsonObject`, under `uses System.JSON`, is
 * not for JsonDataObjects' `TJsonObject`).
 */
function helpersByType(context: ResolutionContext): Map<string, Node[]> {
  const m = memos(context);
  if (!m.helpers) {
    const helpers = new Map<string, Node[]>();
    for (const n of context.iterateNodesByKind?.('class') ?? context.getNodesByKind('class')) {
      if (n.language !== 'pascal') continue;
      const head = helperHead(n);
      const helped = head ? visibleClassNamed(head.helped, n.filePath, context) : null;
      if (!helped) continue;
      const list = helpers.get(helped.id);
      if (list) list.push(n);
      else helpers.set(helped.id, [n]);
    }
    m.helpers = helpers;
  }
  return m.helpers;
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
  // Another unit sees only the routines a unit's interface section declares.
  const otherUnit = fromFile !== filePath && !ownUnitFiles(fromFile, context).includes(filePath);
  const decls = pascalNamed(lower, context).filter((n) =>
    n.filePath === filePath && UNIT_KINDS.has(n.kind) && (n.kind === 'enum_member' || !n.qualifiedName.includes('::')) &&
    !(fromFile !== filePath && n.kind === 'function' && n.startColumn > unitRoutineColumn(filePath, context)) &&
    !(otherUnit && n.kind === 'function' && !exportedRoutine(n, context)));
  // A routine declared in the interface and defined in the implementation is
  // one name; of overloads, one called without arguments first.
  return decls.find((n) => !isRoutine(n)) ?? decls.find((n) => !needsArguments(n)) ?? decls[0];
}

/**
 * Whether other units see a unit's routine: one its unit's interface section
 * declares (`function Foo…` above `implementation`), whatever file implements
 * it. One its implementation alone declares is the unit's own (mORMot's
 * `IdemPChar` in `mormot.core.os.posix.inc`, which `mormot.core.os`'s
 * implementation includes). A file without sections (a program, a script)
 * hides nothing.
 */
function exportedRoutine(routine: Node, context: ResolutionContext): boolean {
  const names = interfaceRoutineNames(unitFilesOf(routine.filePath, context)[0]!, context);
  return names === null || names.has(routine.name.toLowerCase());
}

/**
 * The names of the routines a unit file's interface section declares,
 * lowercased, the include files it pulls in there too; null when it has no
 * implementation section. Only code counts (a comment may start a line with
 * "implementation"), and a `{$ifdef}` branch that starts the implementation
 * starts it for that branch alone: mORMot's `mormot.lib.sspi.pas` is
 * `{$ifdef OSPOSIX} implementation {$else} …its interface… implementation
 * … {$endif}`. A name any branch declares there counts.
 */
function interfaceRoutineNames(unitFile: string, context: ResolutionContext): Set<string> | null {
  const memo = memos(context).interfaceNames;
  if (memo.has(unitFile)) return memo.get(unitFile)!;
  const names = new Set<string>();
  const sections = scanInterface(unitFile, true, names, context, 0);
  const result = sections.implementation ? names : null;
  memo.set(unitFile, result);
  return result;
}

/**
 * Adds the routine names a Pascal file declares while in an interface
 * section to `names` (see interfaceRoutineNames), starting in one or not;
 * whether it ends in one, and whether it starts an implementation.
 */
function scanInterface(filePath: string, inInterface: boolean, names: Set<string>, context: ResolutionContext, depth: number):
    { inInterface: boolean; implementation: boolean } {
  const text = fileLines(filePath, context).join('\n');
  let implementation = false;
  // Per open `{$if…}`: the section it opened in, whether a branch of it so
  // far ended in the interface, and whether it has an `{$else}`.
  const open: { from: boolean; anyInterface: boolean; hasElse: boolean }[] = [];
  // After `procedure` or `function` in the interface, the next word is a
  // routine's name, whatever comments and directives come between:
  // mORMot's `{$ifdef OSLINUXANDROID} function {$endif} CpuThreads: cardinal;`.
  let nameDue = false;
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    const end = triviaEnd(text, i);
    if (end > i) {
      if (c === CH_LBRACE && text.charCodeAt(i + 1) === CH_DOLLAR) {
        const directive = text.slice(i, Math.min(end, i + 400));
        const word = /^\{\$(\w+)/.exec(directive)?.[1]?.toLowerCase();
        const top = open[open.length - 1];
        if (word === 'if' || word === 'ifdef' || word === 'ifndef' || word === 'ifopt') {
          open.push({ from: inInterface, anyInterface: false, hasElse: false });
        } else if ((word === 'else' || word === 'elseif') && top) {
          top.anyInterface ||= inInterface;
          top.hasElse ||= word === 'else';
          inInterface = top.from;
        } else if ((word === 'endif' || word === 'ifend') && top) {
          inInterface = top.anyInterface || inInterface || (!top.hasElse && top.from);
          open.pop();
        } else if (inInterface && depth < 3) {
          const inc = /^\{\$(?:I|INCLUDE)\s+['"]?([^'"}\s*]+)/i.exec(directive);
          if (inc) {
            let name = inc[1]!.replace(/\\/g, '/');
            name = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
            if (!name.includes('.')) name += '.inc';
            const file = nearest(projectFiles(context).byName.get(name) ?? [], filePath);
            if (file && file !== filePath) {
              const after = scanInterface(file, inInterface, names, context, depth + 1);
              inInterface = after.inInterface;
              implementation ||= after.implementation;
            }
          }
        }
      }
      i = end;
      continue;
    }
    if (!isWordStart(c)) {
      // Blanks and an identifier's `&` keep a name due; anything else ends it.
      if (c !== CH_SPACE && c !== CH_TAB && c !== CH_LF && c !== CH_CR && c !== CH_AMP) nameDue = false;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && isWordPart(text.charCodeAt(j))) j++;
    const word = text.slice(i, j).toLowerCase();
    if (nameDue) {
      names.add(word);
      nameDue = false;
    } else if (word === 'implementation') {
      inInterface = false;
      implementation = true;
      // Outside any `{$if…}`, the rest is the implementation.
      if (open.length === 0) break;
    } else if (inInterface && (word === 'procedure' || word === 'function')) {
      nameDue = true;
    }
    i = j;
  }
  return { inInterface, implementation };
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
  const add = (name: string, own: string): void => {
    const file = unitFileNamed(name.toLowerCase(), own, context);
    if (file && !unit.includes(file) && !files.includes(file)) files.push(file);
  };
  for (const own of unit) {
    // What an include file in a clause lists comes first: `uses {$I mormot.uses.inc} mormot.core.base, …`.
    for (const name of unitsIncludedInUses(own, context)) add(name, own);
    for (const imp of outlineOf(own, context).imports) add(imp.name, own);
  }
  memo.set(fromFile, files);
  return files;
}

/**
 * The units an include file in one of a file's `uses` clauses lists
 * (`uses {$I mormot.uses.inc} …`), which the parse doesn't see: every
 * name its text lists, whatever conditions it is under.
 */
function unitsIncludedInUses(filePath: string, context: ResolutionContext): string[] {
  const memo = memos(context).usesIncludes;
  let names = memo.get(filePath);
  if (names) return names;
  names = [];
  const text = fileLines(filePath, context).join('\n');
  if (/\{\$I(?:NCLUDE)?\s/i.test(text)) {
    for (const clause of text.matchAll(/\buses\b([^;]*);/gi)) {
      for (const directive of clause[1]!.matchAll(/\{\$I(?:NCLUDE)?\s+['"]?([^'"}\s*]+)/gi)) {
        let name = directive[1]!.replace(/\\/g, '/');
        name = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
        if (!name.includes('.')) name += '.inc';
        const inc = nearest(projectFiles(context).byName.get(name) ?? [], filePath);
        if (!inc) continue;
        const listed = fileLines(inc, context).join('\n').replace(/\{[^}]*\}|\(\*[\s\S]*?\*\)|\/\/[^\n]*/g, ' ');
        for (const part of listed.split(',')) if (/^[A-Za-z_][\w.]*$/.test(part.trim())) names.push(part.trim());
      }
    }
  }
  memo.set(filePath, names);
  return names;
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
function classNamed(typeName: string, fromFile: string, context: ResolutionContext): Node | null {
  const simple = typeName.split('.').pop()!.toLowerCase();
  const memo = memos(context).classByName;
  const key = `${fromFile}|${simple}`;
  if (memo.has(key)) return memo.get(key)!;
  const cls = classThroughAliases(simple, fromFile, context, new Set([key]));
  memo.set(key, cls);
  return cls;
}

/**
 * The steps an alias walk takes at most: well past any real chain, and short
 * enough that its recursion can't run out of stack. The walk reads no memo, so
 * where it stops depends on where it started alone.
 */
const MAX_ALIAS_WALK = 1000;

/**
 * The class `simple` names from `fromFile`, through its type aliases: a walk,
 * since a name can be an alias several times over (once in each branch of an
 * `{$IFDEF}`), and the first of them that leads to a class is the answer. `seen`
 * ends a cycle, so what a step finds can lean on where the walk came from: only
 * classNamed's answer, for where it started, is kept.
 */
function classThroughAliases(simple: string, fromFile: string, context: ResolutionContext, seen: Set<string>): Node | null {
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
  const cls = declarationOf(visible(CLASS_KINDS));
  if (cls) return cls;
  // A type alias names the class it stands for: `TVTAncestor = TVTAncestorVcl;`,
  // and so do a pointer type and a class reference type, whose values reach
  // its members (`PVirtualNode = ^TVirtualNode;`, `TSynLogClass = class of
  // TSynLog;`, #2550).
  for (const alias of visible(ALIAS_KINDS)) {
    const line = (fileLines(alias.filePath, context)[alias.startLine - 1] ?? '').replace(/\/\/.*$|\{[^}]*\}/g, '');
    const target = /=\s*(?:\^|class\s+of\b)?\s*([A-Za-z_][\w.]*)\s*;/i.exec(line)?.[1]?.split('.').pop()!.toLowerCase();
    const key = `${alias.filePath}|${target}`;
    if (!target || seen.has(key)) continue;
    if (seen.size >= MAX_ALIAS_WALK) return null;
    seen.add(key);
    const through = classThroughAliases(target, alias.filePath, context, seen);
    if (through) return through;
  }
  return null;
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
