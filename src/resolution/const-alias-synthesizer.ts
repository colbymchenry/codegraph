/**
 * A module-level value that hands a function on.
 *
 *   export const extname = (isWin ? win32.extname : posix.extname);
 *   export const lexer = _Lexer.lex;
 *   export const parse = marked;
 *   const $ = dom.$;
 *
 * Calling `extname` runs one of two methods, yet no call to either is written
 * anywhere: the initializer only names them. An import of `extname` rightly
 * lands on the const (#2945), and the const had no edge to what it holds, so
 * every flow through it stopped there.
 *
 * This pass reads each value's initializer and links it to every function the
 * initializer can hand on: a `calls` edge from the value, `provenance:
 * 'heuristic'`, `synthesizedBy: 'const-alias'`, `via` the name as written and
 * `registeredAt` the declaration. A conditional, `??` and `||` link each arm.
 * It reads the `signature` extraction keeps, as the thunk pass does, so most
 * of the work needs no file and both engines feed it alike.
 *
 * A wrong edge is worse than none, so every name has to reach a real binding:
 * the file's own declaration or one of its imports, then the members of that.
 * `const keys = Object.keys` is not a project's `keys`, and `const h =
 * settings.handler` is no `handler` method, whatever the project declares. A
 * name that ends on data (`win32.sep`, `Color.Red`, a class) links nothing.
 */

import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext, UnresolvedRef } from './types';
import type { MaybeYield } from './cooperative-yield';
import { isGeneratedFile } from '../extraction/generated-detection';
import { stripCommentsForRegex } from './strip-comments';
import { matchBracket, skipString } from './frameworks/object-literal';
import { declarationText, initializerAt } from './frameworks/react';
import { isStatedDefaultExport } from './import-resolver';
import { resolveObjectLiteralBinding, resolveObjectLiteralMember } from './name-matcher';
import { FN_KINDS } from './synth-utils';

const ALIAS_KINDS = ['constant', 'variable'] as const;
const ALIAS_LANGUAGES = ['typescript', 'javascript', 'tsx', 'jsx'];

/** What a file's own top-level name can be, for a value to name it or a member of it. */
const BINDING_KINDS: ReadonlySet<string> = new Set(['function', 'component', 'class', 'constant', 'variable']);

/** Words shaped like a name that bind nothing a value could hand on. */
const NOT_A_BINDING: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined', 'this', 'super', 'NaN', 'Infinity']);

const NAME_PATH = /^[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*$/;
const CAST_AT = /\s+(?:as|satisfies)\s/y;

/** `useAuth as jest.Mock`: what a test holds to set a mock up. The function it names never runs there. */
const MOCK_TYPE = /\bMock/;

/** How far a conditional may nest in its own arms before it is no alias a person wrote. */
const MAX_NESTING = 8;

/** What extraction keeps of an initializer in `signature`, before its `...`. */
const SIGNATURE_CHARS = 100;

/** Changed definitions a sync looks each alias up by. Past this it has changed enough to redraw them all. */
const MAX_NAMES_LOOKED_UP = 64;

/** An initializer that opens as an object, an array, a string, a number or a `new`, which is no name. */
const OPENS_AS_NO_NAME = /^(?:[{['"`\d]|new\s)/;

/** `createIcon(`, `nls.localize(`, `register<State>(`: the paren an initializer's call opens with. */
const OPENS_AS_CALL = /^[\w$.]+(?:<[^(]*>)?\s*\(/;

interface TopLevel {
  /** The arms of a conditional, or the operands of a `??` / `||` chain. */
  operands: string[] | null;
  /** Where an `as` or `satisfies` cast starts, or -1. */
  cast: number;
}

/**
 * What `code` does at its own top level, past its strings and brackets. Null
 * when it can't be read that way, or is an arrow function: `x => x ? a : b`
 * hands on no name it writes.
 */
function readTopLevel(code: string): TopLevel | null {
  const operands: string[] = [];
  let question = -1;
  let nested = 0;
  let start = 0;
  let cast = -1;
  for (let i = 0; i < code.length && cast < 0; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      if (i < 0) return null;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      i = matchBracket(code, i);
      if (i < 0) return null;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      return null;
    } else if (ch === '?') {
      if (code[i + 1] === '?') {
        if (question < 0) {
          operands.push(code.slice(start, i));
          start = i + 2;
        }
        i++;
      } else if (code[i + 1] !== '.' || /\d/.test(code[i + 2] ?? '')) {
        if (question < 0) question = i;
        else nested++;
      }
    } else if (ch === ':' && question >= 0) {
      if (nested-- === 0) return { operands: [code.slice(question + 1, i), code.slice(i + 1)], cast: -1 };
    } else if (ch === '|' && code[i + 1] === '|') {
      if (question < 0) {
        operands.push(code.slice(start, i));
        start = i + 2;
      }
      i++;
    } else if (question < 0) {
      if (ch === '=' && code[i + 1] === '>' && operands.length === 0) return null;
      CAST_AT.lastIndex = i;
      if (CAST_AT.test(code)) cast = i;
    }
  }
  if (question >= 0) return null;
  if (operands.length === 0) return { operands: null, cast };
  operands.push(code.slice(start));
  return { operands, cast: -1 };
}

function pathsIn(code: string, nesting: number): string[] {
  const text = code.trim();
  if (!text || nesting > MAX_NESTING) return [];
  const top = readTopLevel(text);
  if (!top) return [];
  if (top.operands) return top.operands.flatMap((operand) => pathsIn(operand, nesting + 1));
  if (top.cast >= 0) return MOCK_TYPE.test(text.slice(top.cast)) ? [] : pathsIn(text.slice(0, top.cast), nesting + 1);
  if (text.endsWith('!')) return pathsIn(text.slice(0, -1), nesting + 1);
  if (text.startsWith('(')) {
    return matchBracket(text, 0) === text.length - 1 ? pathsIn(text.slice(1, -1), nesting + 1) : [];
  }
  if (!NAME_PATH.test(text)) return [];
  const path = text.replace(/[\s?]/g, '');
  return NOT_A_BINDING.has(path.split('.')[0]!) ? [] : [path];
}

/**
 * The names an initializer hands on, dotted: `a.b` for `a.b`, `a?.b`, `(a.b)`
 * and `a.b as F`, both arms of a conditional, every operand of `??` and `||`.
 * A call, a `bind`, `new`, a literal, an `&&` or a cast to a mock hands on no
 * name it writes, and an arm that is one of those is just left out.
 */
export function aliasedPaths(initializer: string): string[] {
  const code = /\/[/*]/.test(initializer) ? stripCommentsForRegex(initializer, 'typescript') : initializer;
  return [...new Set(pathsIn(code, 0))];
}

/**
 * A module-level value's initializer: what extraction kept, or the declaration
 * itself where it kept only the start (vue's `queuePostRenderEffect`, whose
 * conditional runs past that). Null for an initializer that can't hand a name on.
 */
function initializerOf(value: Node, ctx: ResolutionContext): string | null {
  if (value.qualifiedName !== value.name || !value.signature?.startsWith('= ')) return null;
  const kept = value.signature.slice(2);
  if (OPENS_AS_NO_NAME.test(kept)) return null;
  if (kept.length < SIGNATURE_CHARS || !kept.endsWith('...')) return kept;
  // Most long initializers are one call, and its arguments are no reason to open the file.
  const call = OPENS_AS_CALL.exec(kept);
  if (call && matchBracket(kept, call[0].length - 1) < 0) return null;
  const code = stripCommentsForRegex(declarationText(value, ctx), 'typescript');
  const at = initializerAt(code, value.name.length);
  return at < 0 ? null : code.slice(at);
}

/** What `file` declares as `name` at its own top level. */
function ownBinding(name: string, file: string, ctx: ResolutionContext): Node | undefined {
  return (ctx.getNodesInFileNamed?.(file, name) ?? ctx.getNodesInFile(file).filter((n) => n.name === name))
    .find((n) => n.qualifiedName === name && BINDING_KINDS.has(n.kind));
}

/** The `member` of what `owner` is: a class's static, or a member of an object literal, written there or only named. */
function memberOf(owner: Node, member: string, at: UnresolvedRef, ctx: ResolutionContext): Node | null {
  if (owner.kind === 'class') {
    return ctx.getNodesByQualifiedName(`${owner.qualifiedName}::${member}`)
      .find((n) => n.filePath === owner.filePath && n.kind === 'method' && n.isStatic) ?? null;
  }
  const ref = { ...at, referenceName: member };
  const hit = resolveObjectLiteralMember(owner, member, ref, ctx, 0.9, 'import') ??
    resolveObjectLiteralBinding(owner, member, ref, ctx);
  return hit ? ctx.getNodeById?.(hit.targetNodeId) ?? null : null;
}

/**
 * The node a dotted name reaches from `alias`, through the file's imports and
 * then its own top level, never by the name alone. An import comes first: a
 * CommonJS `const m = require('./m')` is a const of the file and also the
 * module. A default import counts only where the module states it: elsewhere
 * the resolver falls back on a guess at the first export, and an edge from here
 * would present that guess as fact.
 */
function aliasTarget(path: string, alias: Node, ctx: ResolutionContext): Node | null {
  const at: UnresolvedRef = {
    fromNodeId: alias.id,
    referenceName: path,
    referenceKind: 'calls',
    line: alias.startLine,
    column: alias.startColumn,
    filePath: alias.filePath,
    language: alias.language,
  };
  const [root, ...members] = path.split('.') as [string, ...string[]];
  const binding = ctx.getImportMappings(alias.filePath, alias.language).find((m) => m.localName === root);
  let target: Node | null;
  if (binding) {
    // `ns.f` is the module's export `f`, and an import of a symbol is that symbol.
    if (binding.isNamespace && members.length === 0) return null;
    const referenceName = binding.isNamespace ? `${root}.${members.shift()!}` : root;
    const hit = ctx.resolveImport?.({ ...at, referenceName });
    target = hit ? ctx.getNodeById?.(hit.targetNodeId) ?? null : null;
    if (target && binding.isDefault && !isStatedDefaultExport(target, ctx)) return null;
  } else {
    target = ownBinding(root, alias.filePath, ctx) ?? null;
  }
  for (const member of members) {
    if (!target) return null;
    target = memberOf(target, member, at, ctx);
  }
  return target;
}

const isValue = (n: Node): boolean => n.kind === 'constant' || n.kind === 'variable';

const JS_FILE = /\.[cm]?[jt]sx?$/;

/** A declaration at the start of a line whose value opens like an alias: a name or a paren, and no call on that line. */
const ALIAS_SHAPE = /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+[\w$]+[^=\n;]*=[ \t\r\n]*[(A-Za-z_$][^;\n(]*(?:[;\n]|$)/m;

/** Input gate for the pass: whether a file may declare an alias. A false yes costs one refresh, so it stays loose. */
export function hasConstAliasShape(filePath: string, content: string): boolean {
  return JS_FILE.test(filePath) && ALIAS_SHAPE.test(content);
}

/**
 * Whether a value in the project names one of the definitions a sync just
 * changed. `const late = fns.join` gets its edge from a sync that adds `join`
 * to `fns.ts`, a file with nothing else to mark it as read by a pass, and the
 * alias's own file is not among those it touches.
 */
export function aliasMayName(queries: QueryBuilder, defined: readonly Node[]): boolean {
  const names = new Set(defined.filter((n) => ALIAS_LANGUAGES.includes(n.language) && (FN_KINDS.has(n.kind) || isValue(n))).map((n) => n.name));
  if (names.size === 0) return false;
  if (names.size > MAX_NAMES_LOOKED_UP) return true;
  return queries.getTopLevelSignaturesMentioning(ALIAS_KINDS, ALIAS_LANGUAGES, [...names]).some((signature) =>
    signature.startsWith('= ') && aliasedPaths(signature.slice(2)).some((path) => names.has(path.slice(path.lastIndexOf('.') + 1))));
}

export async function constAliasEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const named = new Map<string, { alias: Node; links: Array<{ target: Node; via: string }> }>();
  let scanned = 0;
  for (const alias of queries.iterateNodesByKindIn(ALIAS_KINDS, ALIAS_LANGUAGES)) {
    if ((++scanned & 255) === 0) await onYield();
    const initializer = initializerOf(alias, ctx);
    const paths = initializer === null ? [] : aliasedPaths(initializer);
    if (paths.length === 0 || isGeneratedFile(alias.filePath)) continue;
    const links: Array<{ target: Node; via: string }> = [];
    for (const via of paths) {
      const target = aliasTarget(via, alias, ctx);
      if (target && target.id !== alias.id && (FN_KINDS.has(target.kind) || isValue(target))) links.push({ target, via });
    }
    if (links.length > 0) named.set(alias.id, { alias, links });
  }

  // A value another one names counts only once it reaches a function.
  const live = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, { links }] of named) {
      if (!live.has(id) && links.some((l) => !isValue(l.target) || live.has(l.target.id))) {
        live.add(id);
        grew = true;
      }
    }
  }

  const edges: Edge[] = [];
  for (const { alias, links } of named.values()) {
    for (const { target, via } of links) {
      if (isValue(target) && !live.has(target.id)) continue;
      edges.push({
        source: alias.id,
        target: target.id,
        kind: 'calls',
        line: alias.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'const-alias', via, registeredAt: `${alias.filePath}:${alias.startLine}` },
      });
    }
  }
  return edges;
}
