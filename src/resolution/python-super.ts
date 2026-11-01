/**
 * Both extractors record `super().run()`, with or without arguments, as the name
 * `super().run`, which no other strategy reads. A call through `super()` runs
 * the first class after the caller's in its method resolution order that defines
 * the name, so that's the answer: read from the class's own bases, and never by
 * name, because a base from outside the project has no node and a project method
 * of that name is not what runs. `class Site(models.Model)`'s `super().save()`
 * stays unlinked, and is no call to whichever `save` the project has.
 *
 * Such a base stays in the order, since it may define the name itself: in
 * `class C(models.Model, Local)`, `super().save()` runs `Model.save`, not
 * `Local.save`, while `class C(Local, models.Model)` reaches `Local.save` first.
 *
 * The order is that of the class the call is written in. On an instance of a
 * subclass with several bases, `super()` can run a sibling instead: in `Left.run`,
 * on a `Both(Left, Right)`, it's `Right.run`. What a `Left` runs is still the
 * edge here, since the call really does that, and the sibling goes unlinked.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const SUPER_CALL = /^super\(\)\.([A-Za-z_]\w*)$/;
/** The first `super(…)` of a text, with the class the two-argument form names. */
const SUPER_FORM = /\bsuper\s*\(\s*(?:(?:\w+\.)*(\w+)\s*,)?/;
/** Bases with no method of their own for a project's `super()` to reach. */
const EMPTY_BASES = new Set(['object', 'ABC', 'Generic', 'Protocol']);
/** What `Generic` and `Protocol` do define: for these names each is a base like any from outside. */
const TYPING_HOOKS = new Set(['__init_subclass__', '__class_getitem__']);

/** A place in a linearization: a project class, or a base with no node, which could define anything. */
interface Entry {
  id: string;
  cls: Node | null;
}

/** A base as the class header writes it: where it starts, and its dotted name (null for `*bases`). */
interface WrittenBase {
  line: number;
  column: number;
  name: string | null;
}

/** Whether a base with no node can be stepped over when looking for `method`. */
function definesNothing(base: string, method: string): boolean {
  if (!EMPTY_BASES.has(base)) return false;
  return !((base === 'Generic' || base === 'Protocol') && TYPING_HOOKS.has(method));
}

export function isPythonSuperCall(ref: UnresolvedRef): boolean {
  return ref.language === 'python' && ref.referenceKind === 'calls' && SUPER_CALL.test(ref.referenceName);
}

/** The bases a class header lists, in order, past any `metaclass=…`. Null when the header can't be read. */
function writtenBases(cls: Node, context: ResolutionContext): WrittenBase[] | null {
  const lines = context.getFileLines?.(cls.filePath) ?? context.readFile(cls.filePath)?.split(/\r?\n/) ?? [];
  const opening = new RegExp(`^\\s*class\\s+${cls.name}\\s*(?:\\[[^\\]]*\\]\\s*)?`);
  let row = cls.startLine - 1;
  while (row < cls.endLine && row < lines.length && !opening.test(lines[row]!)) row++;
  const head = opening.exec(lines[row] ?? '');
  if (!head) return null;
  if (lines[row]![head[0].length] !== '(') return [];

  const bases: WrittenBase[] = [];
  let depth = 0;
  let expecting = true;
  for (let from = head[0].length; row < cls.endLine && row < lines.length; row++, from = 0) {
    const text = lines[row]!;
    for (let c = from; c < text.length; c++) {
      const ch = text[c]!;
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        c = text.indexOf(ch, c + 1);
        if (c < 0) break;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        if (depth === 1) continue;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth === 0) return bases;
      } else if (ch === ',' && depth === 1) {
        expecting = true;
        continue;
      }
      if (expecting && depth === 1 && !/\s/.test(ch)) {
        expecting = false;
        const rest = text.slice(c);
        if (!/^\w+\s*=(?!=)/.test(rest)) bases.push({ line: row + 1, column: c, name: /^[\w.]+/.exec(rest)?.[0] ?? null });
      }
    }
  }
  return null;
}

/**
 * A class's bases in the order its header lists them. Each is matched to its
 * `extends` edge by where it's written, the one thing that tells apart two
 * bases imported as `First` and `Second` that are both named `Base`.
 */
function basesOf(cls: Node, method: string, context: ResolutionContext): Entry[] | null {
  const written = writtenBases(cls, context);
  if (!written) return null;
  const edges = context.getSuperclassEdges?.(cls.id) ?? [];
  const bases: Entry[] = [];
  written.forEach((base, i) => {
    const target = edges.find((e) => e.line === base.line && e.column === base.column)?.target;
    if (target?.kind === 'class') bases.push({ id: target.id, cls: target });
    else if (!target && definesNothing(base.name?.split('.').pop() ?? '', method)) return;
    else bases.push({ id: `${cls.id}?${i}`, cls: null });
  });
  return bases;
}

/** C3, Python's linearization. Null for a hierarchy Python would refuse, or one that loops. */
function linearization(entry: Entry, method: string, context: ResolutionContext, active: Set<string>): Entry[] | null {
  if (!entry.cls) return [entry];
  if (active.has(entry.id)) return null;
  const bases = basesOf(entry.cls, method, context);
  if (!bases) return null;
  active.add(entry.id);
  const parents = bases.map((base) => linearization(base, method, context, active));
  active.delete(entry.id);
  if (parents.some((p) => p === null)) return null;

  const order = [entry];
  const pending = [...(parents as Entry[][]).map((p) => [...p]), [...bases]].filter((p) => p.length > 0);
  while (pending.length > 0) {
    const next = pending.map((p) => p[0]!).find((head) => !pending.some((p) => p.slice(1).some((n) => n.id === head.id)));
    if (!next) return null;
    order.push(next);
    for (const p of pending) if (p[0]!.id === next.id) p.shift();
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.length === 0) pending.splice(i, 1);
  }
  return order;
}

/** The innermost class around a line of a file. */
function classAround(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  let found: Node | null = null;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (n.kind === 'class' && n.startLine <= ref.line && n.endLine >= ref.line && (!found || n.startLine > found.startLine)) found = n;
  }
  return found;
}

export function matchPythonSuperCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = SUPER_CALL.exec(ref.referenceName)?.[1];
  const cls = name ? classAround(ref, context) : null;
  if (!name || !cls) return null;
  // `super(Other, self)` starts somewhere else in the order, past a class that isn't the caller's.
  // Read from the ref's own column: a line can hold another `super` in the other form.
  const line = (context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/))?.[ref.line - 1] ?? '';
  const named = SUPER_FORM.exec(line.slice(Math.max(0, ref.column)))?.[1];
  if (named !== undefined && named !== cls.name) return null;

  for (const entry of (linearization({ id: cls.id, cls }, name, context, new Set()) ?? []).slice(1)) {
    if (!entry.cls) return null;
    const base = entry.cls;
    // The last `def` of a name in a class body is the one the name holds, below any `@overload` stubs.
    const defined = context.getNodesInFile(base.filePath)
      .filter((n) => n.kind === 'method' && n.name === name && n.qualifiedName === `${base.qualifiedName}::${name}`)
      .sort((a, b) => b.startLine - a.startLine)[0];
    if (defined) return { original: ref, targetNodeId: defined.id, confidence: 0.95, resolvedBy: 'instance-method' };
  }
  return null;
}
