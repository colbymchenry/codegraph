/**
 * A name an enclosing declaration declares as a TYPE PARAMETER means that
 * parameter, never a project symbol that happens to share it.
 *
 * `def zipWith[A, B, C](fa: ISeq[A], …)` in cats sent its `A` to an
 * `implicit def A` elsewhere (4,916 dependents) and its `B` to a
 * `case class B()` declared inside some test; getx's `T` landed on a constant
 * named `T`. The index does not record type parameters, so they are read
 * from the declaration heads around the reference: after the declared name
 * (`class Foo<T>`, `fn f<T: Display>`, `func F[T any]`, `def f[F[_]: Monad, A]`,
 * `struct Stack<Element>`), before it where the language puts them
 * (Java's `<T extends X> T max(…)`, Kotlin's `fun <T> f()`), a C++
 * `template <typename T>` line above it, and a Go method's receiver
 * (`func (p *Pool[T]) Get() T`). Applied at resolveOne's seam, so every
 * strategy's result obeys it.
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const GENERIC_LANGUAGES: ReadonlySet<string> = new Set([
  'scala', 'java', 'kotlin', 'csharp', 'typescript', 'tsx', 'swift', 'rust', 'dart', 'go', 'cpp', 'vbnet', 'arkts',
]);

/** Where a reference names a type. */
const TYPE_REF_KINDS: ReadonlySet<string> = new Set(['references', 'type_of', 'returns', 'instantiates']);

/** Declarations that can carry type parameters. */
const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias', 'function', 'method', 'union', 'module',
]);

/** How far past a declaration's first line its head can run: a parameter list may take a line per parameter. */
const HEAD_LINES = 40;

const memos = new WeakMap<ResolutionContext, Map<string, ReadonlySet<string>>>();

/** Drop the memos (see ReferenceResolver.clearCaches). */
export function clearTypeParameterMemos(context: ResolutionContext): void {
  memos.delete(context);
  valueMemos.delete(context);
}

/**
 * The resolved reference, or null when a declaration around it declares its
 * name: as a type parameter (a type reference), or — Scala — as a value
 * parameter of the enclosing `def` (`f(a)` where `f: A => B` is the def's own
 * argument; cats bound 846 such calls to a case class's `f` field).
 */
export function gateTypeParameter(resolved: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!resolved) return resolved;
  let result = resolved;
  if (ref.language === 'scala' && (ref.referenceKind === 'calls' || ref.referenceKind === 'references') &&
    /^[A-Za-z_]\w*$/.test(ref.referenceName)) {
    for (const declaration of enclosingDeclarations(ref, context)) {
      if ((declaration.kind === 'function' || declaration.kind === 'method') &&
        declaredValueParameters(declaration, context).has(ref.referenceName)) return null;
    }
  }
  if (ref.language === 'scala' && !scalaMemberInScope(result, ref, context)) {
    // Out of scope: the type of that name that IS in scope — cats' own
    // `trait FlatMap`, not `Eval`'s nested `FlatMap` case class — when one fits.
    const target = context.getNodeById?.(result.targetNodeId);
    if (!target || !SCALA_TYPE_KINDS.has(target.kind)) return null;
    const inScope = context
      .getNodesByName(ref.referenceName)
      .filter((n) => n.id !== target.id && n.language === 'scala' && SCALA_TYPE_KINDS.has(n.kind))
      .filter((n) => scalaMemberInScope({ ...result, targetNodeId: n.id }, ref, context));
    const chosen = inScope.length === 1 ? inScope[0]! : inScope.find((n) => n.filePath === ref.filePath);
    if (!chosen) return null;
    result = { ...result, targetNodeId: chosen.id };
  }
  if (!GENERIC_LANGUAGES.has(ref.language) || !TYPE_REF_KINDS.has(ref.referenceKind)) return result;
  const name = ref.referenceName;
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) return result;
  for (const declaration of enclosingDeclarations(ref, context)) {
    if (declaredTypeParameters(declaration, context).has(name)) return null;
  }
  return result;
}

const SCALA_OWNER_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'module', 'interface', 'struct', 'enum']);
const SCALA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'trait', 'interface', 'struct', 'enum', 'type_alias']);

/**
 * A bare Scala name reaches a member of another type — `FreeT.FlatMapped`'s
 * `type A`, a test suite's `val P` — only from inside that type, a type that
 * extends it, or a file importing its members (`import Owner._`,
 * `Owner.{A}`, `Owner.*`). cats' bare type parameters landed on such members
 * across the library once the test-local classes stopped catching them.
 */
function scalaMemberInScope(result: ResolvedRef, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!/^[A-Za-z_]\w*$/.test(ref.referenceName) || ref.referenceKind !== 'references') return true;
  // Bare in the SOURCE: the index keeps `SttpClient.Service` by its last
  // segment, and a qualified name reaches any member.
  const line = context.getFileLines?.(ref.filePath)?.[ref.line - 1] ?? context.readFile(ref.filePath)?.split(/\r?\n/)[ref.line - 1];
  if (line === undefined || !line.startsWith(ref.referenceName, ref.column) || /\.\s*$/.test(line.slice(0, ref.column))) return true;
  const target = context.getNodeById?.(result.targetNodeId);
  if (!target || target.language !== 'scala') return true;
  const cut = target.qualifiedName.lastIndexOf('::');
  if (cut < 0) return true;
  const ownerQn = target.qualifiedName.slice(0, cut);
  const containers = context
    .getNodesByQualifiedName(ownerQn)
    .filter((o) => o.filePath === target.filePath && o.startLine <= target.startLine && o.endLine >= target.endLine);
  const inside = (o: Node): boolean => ref.filePath === o.filePath && ref.line >= o.startLine && ref.line <= o.endLine;
  // A def's local (`case class B()` in a test method): only in there.
  const def = containers.find((o) => o.kind === 'function' || o.kind === 'method');
  if (def) return inside(def);
  const owner = containers.find((o) => SCALA_OWNER_KINDS.has(o.kind));
  if (!owner) return true; // a package member
  if (inside(owner)) return true;
  // Inherited: the reference sits in a type that extends the owner.
  for (const around of enclosingDeclarations(ref, context)) {
    if (!SCALA_OWNER_KINDS.has(around.kind)) continue;
    if (around.name === owner.name) return true;
    if (context.getSupertypes?.(around.name, 'scala').includes(owner.name)) return true;
  }
  // Imported: `import cats.data.FreeT.FlatMapped._`, `Owner.{A, B}`, `Owner.*`.
  const text = context.readFile(ref.filePath) ?? '';
  const imports = new RegExp(
    String.raw`\bimport\s+[\w.]*\b${owner.name}\.(?:_|\*|given\b|\{[^}]*\b(?:_|\*|${target.name})\b[^}]*\}|${target.name}\b)`,
  );
  return /^[A-Za-z_]\w*$/.test(owner.name) && /^[A-Za-z_]\w*$/.test(target.name) ? imports.test(text) : true;
}

function enclosingDeclarations(ref: UnresolvedRef, context: ResolutionContext): Node[] {
  return context
    .getNodesInFile(ref.filePath)
    .filter((n) => DECLARATION_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line);
}

function declaredTypeParameters(node: Node, context: ResolutionContext): ReadonlySet<string> {
  let memo = memos.get(context);
  if (!memo) {
    memo = new Map();
    memos.set(context, memo);
  }
  const hit = memo.get(node.id);
  if (hit) return hit;
  const names = new Set<string>();
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/) ?? null;
  if (lines) {
    const head = lines.slice(node.startLine - 1, Math.min(node.endLine, node.startLine - 1 + HEAD_LINES)).join('\n');
    const at = nameIndex(head, node.name);
    if (at >= 0) {
      // After the declared name: `Foo<T>`, `f[A]`.
      let open = at + node.name.length;
      while (open < head.length && /[ \t]/.test(head[open]!)) open++;
      if (head[open] === '<' || head[open] === '[') collect(head, open, names);
      // Before it, detached from any type name: `static <T> T max(`, `fun <T> f(`.
      const before = head.slice(0, at);
      for (let i = 0; i < before.length; i++) {
        if (before[i] === '<' && (i === 0 || /[\s(,]/.test(before[i - 1]!))) collect(before, i, names);
      }
    }
    // Go: a method of a generic type declares the type's parameters again in
    // its receiver — `func (p *Pool[T]) Get() T`, `func (LazyLoader[K, V]) …`.
    if (node.language === 'go' && node.kind === 'method') {
      const receiver = /^\s*func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*[A-Za-z_]\w*\s*\[/.exec(head);
      if (receiver) collect(head, receiver[0].length - 1, names);
    }
    // C++: `template <typename T, class U>` on the lines just above.
    if (node.language === 'cpp') {
      const above = lines.slice(Math.max(0, node.startLine - 3), node.startLine).join('\n');
      const template = /\btemplate\s*</g;
      for (let m = template.exec(above); m; m = template.exec(above)) collect(above, m.index + m[0].length - 1, names);
    }
  }
  memo.set(node.id, names);
  return names;
}

const valueMemos = new WeakMap<ResolutionContext, Map<string, ReadonlySet<string>>>();

/**
 * A Scala def's value parameters, every curried list: `def f[A](fa: F[A])(f:
 * A => B)(implicit G: Applicative[G])` → fa, f, G.
 */
function declaredValueParameters(node: Node, context: ResolutionContext): ReadonlySet<string> {
  let memo = valueMemos.get(context);
  if (!memo) {
    memo = new Map();
    valueMemos.set(context, memo);
  }
  const hit = memo.get(node.id);
  if (hit) return hit;
  const names = new Set<string>();
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/) ?? null;
  if (lines) {
    const head = lines.slice(node.startLine - 1, Math.min(node.endLine, node.startLine - 1 + HEAD_LINES)).join('\n');
    const at = nameIndex(head, node.name);
    if (at >= 0) {
      let i = at + node.name.length;
      const skipSpace = (): void => {
        while (i < head.length && /\s/.test(head[i]!)) i++;
      };
      skipSpace();
      if (head[i] === '[') {
        const close = matchingBracket(head, i);
        i = close < 0 ? head.length : close + 1;
      }
      for (skipSpace(); head[i] === '('; skipSpace()) {
        const close = matchingBracket(head, i);
        if (close < 0) break;
        for (const item of splitTopLevel(head.slice(i + 1, close), false)) {
          const bare = item.replace(/^\s*(?:@[\w.]+(?:\([^()]*\))?\s*)+/, '');
          const param = /^\s*(?:(?:implicit|using|val|var|override|private|protected|final|inline|erased)\s+)*([A-Za-z_]\w*)\s*:/.exec(bare)?.[1];
          if (param) names.add(param);
        }
        i = close + 1;
      }
    }
  }
  memo.set(node.id, names);
  return names;
}

/**
 * The declared name's position in its head: the whole word, past attributes
 * and modifiers. A plain search — a declared name can be an operator (Scala's
 * `*`, `|+|`), which no pattern built from it could match safely.
 */
function nameIndex(head: string, name: string): number {
  if (!name) return -1;
  const word = /[\w$]/;
  for (let at = head.indexOf(name); at >= 0; at = head.indexOf(name, at + 1)) {
    const before = at > 0 ? head[at - 1]! : '';
    const after = head[at + name.length] ?? '';
    if (!word.test(before) && !word.test(after)) return at;
  }
  return -1;
}

/** Add the parameter names of the bracket group opening at `open`. */
function collect(text: string, open: number, names: Set<string>): void {
  const close = matchingBracket(text, open);
  if (close < 0) return;
  for (const item of splitTopLevel(text.slice(open + 1, close), text[open] === '<')) {
    // Past annotations (`@sp(Int, Long) A`, `@NonNull T`), variance and keywords.
    const bare = item.replace(/^\s*(?:@[\w.]+(?:\([^()]*\))?\s*)+/, '');
    const param = /^\s*(?:(?:in|out|reified|const|typename|class|struct)\s+|[+\-']\s*)*([A-Za-z_]\w*)/.exec(bare)?.[1];
    if (param && param !== 'typename' && param !== 'class') names.add(param);
  }
}

/**
 * The bracket closing the one at `open`. A `[…]` list counts only square
 * brackets and parentheses — Scala's bounds `B >: A` and `A <: AnyRef` are not
 * angle brackets — and a `<…>` list skips the `->` / `=>` inside its bounds.
 */
function matchingBracket(text: string, open: number): number {
  const angle = text[open] === '<';
  const closer = angle ? '>' : text[open] === '[' ? ']' : ')';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{' || c === ';') return -1;
    if (isOpener(c, angle)) depth++;
    else if (isCloser(c, angle, text[i - 1])) {
      depth--;
      if (depth === 0) return c === closer ? i : -1;
    }
  }
  return -1;
}

function splitTopLevel(inner: string, angle: boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (isOpener(c, angle)) depth++;
    else if (isCloser(c, angle, inner[i - 1])) depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

function isOpener(c: string, angle: boolean): boolean {
  return c === '[' || c === '(' || (angle && c === '<');
}

function isCloser(c: string, angle: boolean, previous: string | undefined): boolean {
  if (c === ']' || c === ')') return true;
  return angle && c === '>' && previous !== '-' && previous !== '=';
}
