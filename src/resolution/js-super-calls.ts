/**
 * A TS/JS call written `super.run(…)` runs the method of the class's parent
 * (#2497): the one the class `extends`, or the nearest ancestor of that one
 * that has the method, and a static method's `super` reaches the parent's
 * static methods. The extractor keeps the call under its bare name, so the
 * name strategies answered for it: inside an override of `run` they found the
 * calling method itself, a self-edge gateSuperSelfCall then declined, and
 * elsewhere they took any method of the name, like a sibling class's `run` in
 * the same file, or a project `connectedCallback` for a web component whose
 * parent is `HTMLElement`.
 *
 * The parent comes from the class's resolved `extends` edge, which the
 * resolver persists before it resolves calls. A parent outside the project,
 * or an ancestry without the method, links nothing: never a guess by name.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { escapeRegExp } from '../utils';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';

const SUPER_CALL_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** How far up a class's ancestry a `super` call is looked for. */
const MAX_ANCESTRY = 8;

/** Whether `super` calls of `language` are read where each call starts (isJsSuperCallSite). */
export function isJsSuperCallLanguage(language: string): boolean {
  return SUPER_CALL_LANGUAGES.has(language);
}

/**
 * Whether the call `ref` records is written on `super` where it starts:
 * `super.run(…)`, the member on the next line or two included. Only the
 * call's own position counts, so a `this.run()` on the same line is not one.
 */
export function isJsSuperCallSite(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls' || !SUPER_CALL_LANGUAGES.has(ref.language) || !IDENTIFIER.test(ref.referenceName)) return false;
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  const line = lines?.[ref.line - 1];
  if (!line || !line.startsWith('super', ref.column)) return false;
  const written = new RegExp(String.raw`^super\s*\.\s*${escapeRegExp(ref.referenceName)}(?![\w$])`);
  if (written.test(line.slice(ref.column))) return true;
  return written.test(lines!.slice(ref.line - 1, ref.line + 2).join('\n').slice(ref.column));
}

/**
 * The method a TS/JS `super.name(…)` call runs (see the file comment).
 * Undefined when the call isn't written on `super`, or the index can't place
 * it in a member of a class (an object literal's method, a class
 * expression's), which leaves it to the other strategies; null when no
 * ancestor the project declares has the method.
 */
export function matchJsSuperCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (!isJsSuperCallSite(ref, context) || !context.getSuperclassNodes) return undefined;
  const caller = context.getNodeById?.(ref.fromNodeId);
  const placed = caller ? classMemberAround(caller, context) : undefined;
  if (!placed || writesClassBefore(placed.member, ref, context)) return undefined;
  const target = inheritedMethod(placed.cls, ref.referenceName, placed.member.isStatic === true, context);
  return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'instance-method' } : null;
}

/**
 * The class member a call made in `caller` belongs to, and its class: the
 * caller itself when it is a method or a field of a class, or the member an
 * arrow function nested in it is written in (`run() { const go = () =>
 * super.run(); }`), whose `super` is the member's. A `function` can't use
 * `super`, so a function node named under a member is an arrow function.
 */
function classMemberAround(caller: Node, context: ResolutionContext): { member: Node; cls: Node } | undefined {
  let member = caller;
  for (let depth = 0; member.kind === 'function' && depth < 4; depth++) {
    const outer = ownerOf(member, context, (n) => n.kind === 'function' || n.kind === 'method' || n.kind === 'property');
    if (!outer) return undefined;
    member = outer;
  }
  if (member.kind !== 'method' && member.kind !== 'property') return undefined;
  const cls = ownerOf(member, context, (n) => n.kind === 'class');
  return cls ? { member, cls } : undefined;
}

/** The node `node` is declared in, by its qualified name, in its file and around it. */
function ownerOf(node: Node, context: ResolutionContext, accept: (n: Node) => boolean): Node | undefined {
  const cut = node.qualifiedName.lastIndexOf('::');
  if (cut <= 0) return undefined;
  return context.getNodesByQualifiedName(node.qualifiedName.slice(0, cut)).find((n) => accept(n) &&
    n.filePath === node.filePath && n.startLine <= node.startLine && n.endLine >= node.endLine);
}

/**
 * Whether a `class` is written between where `member` starts and the call,
 * outside comments and strings: a class expression's methods have no nodes,
 * so a call in one is recorded from the member around it (`make() { return
 * class extends Other { run() { super.run(); } }; }`), and its `super` is
 * that class's.
 */
function writesClassBefore(member: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if (!lines || member.startLine > ref.line) return false;
  const span = lines.slice(member.startLine - 1, ref.line);
  span[span.length - 1] = (span[span.length - 1] ?? '').slice(0, ref.column);
  span[0] = (span[0] ?? '').slice(member.startLine === ref.line ? Math.min(member.startColumn, ref.column) : member.startColumn);
  const text = span.join('\n');
  if (!/(?<![\w$.])class(?![\w$])/.test(text)) return false;
  return /(?<![\w$.])class(?![\w$])/.test(blankStringContents(stripCommentsForRegex(text, 'javascript')));
}

/** The nearest method named `name` of `cls`'s ancestors, static or instance as asked. */
function inheritedMethod(cls: Node, name: string, isStatic: boolean, context: ResolutionContext): Node | undefined {
  const seen = new Set<string>([cls.id]);
  let level = superclassesOf(cls, context);
  for (let depth = 0; depth < MAX_ANCESTRY && level.length > 0; depth++) {
    const next: Node[] = [];
    for (const parent of level) {
      if (seen.has(parent.id)) continue;
      seen.add(parent.id);
      const own = ownMethod(parent, name, isStatic, context);
      if (own) return own;
      next.push(...superclassesOf(parent, context));
    }
    level = next;
  }
  return undefined;
}

function superclassesOf(cls: Node, context: ResolutionContext): Node[] {
  return (context.getSuperclassNodes?.(cls.id) ?? []).filter((n) => n.kind === 'class' && SUPER_CALL_LANGUAGES.has(n.language));
}

/**
 * A method `cls` itself declares under `name`, static or instance as asked.
 * Of a TypeScript method's overload signatures and its body, the body, which
 * comes last.
 */
function ownMethod(cls: Node, name: string, isStatic: boolean, context: ResolutionContext): Node | undefined {
  const own = context.getNodesByQualifiedName(`${cls.qualifiedName}::${name}`).filter((m) =>
    m.kind === 'method' && m.filePath === cls.filePath && m.startLine >= cls.startLine && m.endLine <= cls.endLine &&
    (m.isStatic === true) === isStatic);
  return own.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn).pop();
}
