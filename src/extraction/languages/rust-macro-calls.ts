/**
 * Calls and variant paths written in the arguments of Rust's expression
 * macros (#3251): `format!("{}", label())`, `assert_eq!(count(), 3)`,
 * `vec![false; size()]`, `write!(f, "{}", self.code.as_str())`,
 * `json!({"k": v()})`, `matches!(self, Code::Bad | Code::Good)`. Tree-sitter
 * leaves a macro's arguments as a flat `token_tree`, so the body walker never
 * sees them. For the macros whose arguments are plain Rust expressions this
 * reads the tokens back into the shapes the call extractor names — a bare
 * call, a path call, a method call and its receiver chain — and a variant
 * path's receiver, each at the place the call extractor would put it: where
 * its expression starts. Macros with a syntax of their own (a DSL: `select!`,
 * `quote!`, `html!`, logging fields) are left alone, and so is a nested macro
 * that isn't one of these.
 *
 * Mirrored byte-for-byte by the native kernel's `rust_macro_arg_refs`
 * (codegraph-kernel/src/rustlang.rs) — change both.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';

/** Macros whose arguments are Rust expressions: std's formatting, assertion and collection macros, and serde_json's `json!`. */
export const RUST_EXPRESSION_MACROS: ReadonlySet<string> = new Set([
  'format', 'format_args', 'print', 'println', 'eprint', 'eprintln', 'write', 'writeln', 'panic',
  'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'debug_assert_ne',
  'vec', 'matches', 'dbg', 'todo', 'unimplemented', 'unreachable', 'json',
]);

/** Words a token tree writes as an `identifier` that are Rust keywords: never a name to call or a path's head. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'as', 'async', 'await', 'box', 'break', 'const', 'continue', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for',
  'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'static', 'struct',
  'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'yield',
]);

/**
 * Contextual keywords a token tree writes as tokens of their own, which name
 * items as an identifier does: `Default::default()`, `a.union(b)`, `gen()`.
 */
const CONTEXTUAL_NAMES: ReadonlySet<string> = new Set(['default', 'union', 'gen']);

/** Whether `t` is a name: an identifier that is no keyword, or a contextual keyword's token. */
function isName(t: SyntaxNode | undefined, source: string): boolean {
  if (!t) return false;
  return t.type === 'identifier' ? !KEYWORDS.has(getNodeText(t, source)) : CONTEXTUAL_NAMES.has(t.type);
}

/** Literal tokens: a method called on one names nothing (the call extractor's literal receivers). */
const LITERALS: ReadonlySet<string> = new Set([
  'string_literal', 'raw_string_literal', 'char_literal', 'integer_literal', 'float_literal', 'boolean_literal',
]);

const IDENT = /^[A-Za-z_]\w*$/;
const FIELD = /^(?:[A-Za-z_]\w*|\d+)$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9_]*$/;
/** The most links a receiver chain is kept with, as the call extractor keeps it. */
const MAX_LINKS = 16;

/** One reference a macro's arguments make: its name, kind, and the token it is placed at. */
export interface RustMacroRef {
  name: string;
  kind: 'calls' | 'references';
  at: SyntaxNode;
}

type Expr =
  | { k: 'lit' }
  | { k: 'name'; name: string }
  | { k: 'self' }
  | { k: 'path'; text: string }
  | { k: 'call'; callee: Expr }
  | { k: 'field'; base: Expr; name: string }
  | { k: 'method'; base: Expr; name: string }
  | { k: 'other' };

/** The receiver chain of `e` as the call extractor keeps it (rustReceiverChain), or null. */
function receiverChain(e: Expr): string | null {
  const links: string[] = [];
  let cur: Expr = e;
  while (links.length <= MAX_LINKS) {
    if (cur.k === 'self' || cur.k === 'name') {
      const root = cur.k === 'self' ? 'self' : cur.name;
      if (links.length === 0 || !IDENT.test(root)) return null;
      return [root, ...links.reverse()].join('.');
    }
    if (cur.k === 'method') {
      if (!IDENT.test(cur.name)) return null;
      links.push(`${cur.name}()`);
      cur = cur.base;
    } else if (cur.k === 'field') {
      if (!FIELD.test(cur.name)) return null;
      links.push(cur.name);
      cur = cur.base;
    } else {
      return null;
    }
  }
  return null;
}

/** The name the call extractor gives `<base>.<method>(…)`; null for none (a literal's). */
function methodCallName(base: Expr, method: string): string | null {
  switch (base.k) {
    case 'lit': return null;
    case 'name': return base.name === 'this' || base.name === 'cls' || base.name === 'super' ? method : `${base.name}.${method}`;
    case 'self': return `self.${method}`;
    case 'field':
      if (base.base.k === 'self' && IDENT.test(base.name)) return `self.${base.name}.${method}`;
      break;
    case 'call':
      if (base.callee.k === 'path') return `${base.callee.text}().${method}`;
      break;
    case 'method':
      break;
    default:
      return method;
  }
  const chain = receiverChain(base);
  return chain === null ? method : `${chain}.${method}`;
}

/**
 * The references the arguments of `macro`, a `macro_invocation`, make — none
 * unless it is one of RUST_EXPRESSION_MACROS.
 */
export function rustMacroArgRefs(macro: SyntaxNode, source: string): RustMacroRef[] {
  const out: RustMacroRef[] = [];
  const nameNode = macro.namedChild(0);
  const tree = macro.namedChildren.find((c: SyntaxNode) => c.type === 'token_tree');
  if (!nameNode || !tree) return out;
  const name = getNodeText(nameNode, source).split('::').pop()!.trim();
  if (RUST_EXPRESSION_MACROS.has(name)) scanGroup(tree, name === 'matches', false, source, out);
  return out;
}

/** A group's tokens, its delimiters left out. */
function groupTokens(group: SyntaxNode): SyntaxNode[] {
  const tokens: SyntaxNode[] = [];
  for (let i = 1; i < group.childCount - 1; i++) {
    const t = group.child(i);
    if (t) tokens.push(t);
  }
  return tokens;
}

/** The delimiter a group opens with: `(`, `[` or `{`. */
function delimiter(group: SyntaxNode): string {
  return group.child(0)?.type ?? '';
}

/**
 * Scan one group. `matchesArgs`: the group is `matches!`'s, whose arguments
 * after the first are a pattern (and its `if` guard an expression again).
 * `pattern`: the group is read as a pattern from its start.
 */
function scanGroup(group: SyntaxNode, matchesArgs: boolean, pattern: boolean, source: string, out: RustMacroRef[]): void {
  const tokens = groupTokens(group);
  let inPattern = pattern;
  let commaSeen = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (matchesArgs && t.type === ',' && !commaSeen) {
      commaSeen = true;
      inPattern = true;
      i++;
      continue;
    }
    if (inPattern && t.type === 'if') {
      inPattern = false;
      i++;
      continue;
    }
    const next = parseChain(tokens, i, inPattern, source, out);
    i = next > i ? next : i + 1;
  }
}

/** Whether `t` can start an expression the scan reads. */
function startsExpr(tokens: readonly SyntaxNode[], i: number, source: string): boolean {
  const t = tokens[i]!;
  switch (t.type) {
    case 'self': case 'crate': case 'super': case '::': case 'token_tree': return true;
    case 'primitive_type': return tokens[i + 1]?.type === '::';
    default: return isName(t, source) || LITERALS.has(t.type);
  }
}

/** Past a turbofish's `<…>` that starts at `i` (a `<`), or -1 when it doesn't close. */
function skipAngles(tokens: readonly SyntaxNode[], i: number): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    const ty = tokens[j]!.type;
    if (ty === '<') depth++;
    else if (ty === '<<') depth += 2;
    else if (ty === '>') depth--;
    else if (ty === '>>') depth -= 2;
    else if (ty === ';' || (ty === 'token_tree' && delimiter(tokens[j]!) === '{')) return -1;
    if (depth <= 0) return depth === 0 ? j + 1 : -1;
  }
  return -1;
}

/** A path segment token: a name, `self`, `super`, `crate`, a primitive type. */
function isSegment(t: SyntaxNode | undefined, source: string): boolean {
  if (!t) return false;
  return isName(t, source) || t.type === 'self' || t.type === 'super' || t.type === 'crate' || t.type === 'primitive_type';
}

/**
 * Read the expression that starts at `i` — a primary, then its calls, fields,
 * method calls, `?`, `.await` and indexes — emitting what it calls (or, in a
 * pattern, the variants it names). Returns the index past it.
 */
function parseChain(tokens: readonly SyntaxNode[], i: number, inPattern: boolean, source: string, out: RustMacroRef[]): number {
  if (!startsExpr(tokens, i, source)) return i;
  const start = tokens[i]!;
  let expr: Expr;
  // Each segment of a path, with the node it is written at.
  const segs: Array<{ text: string; node: SyntaxNode }> = [];
  if (LITERALS.has(start.type)) {
    expr = { k: 'lit' };
    i++;
  } else if (start.type === 'token_tree') {
    scanGroup(start, false, inPattern, source, out);
    expr = { k: 'other' };
    i++;
  } else {
    // A path: `a`, `a::b`, `::std::f`, `Vec::<u8>::new`, `u8::max`.
    const leading = start.type === '::';
    if (leading) i++;
    if (!isSegment(tokens[i], source)) return i;
    for (;;) {
      segs.push({ text: getNodeText(tokens[i]!, source), node: tokens[i]! });
      i++;
      if (tokens[i]?.type !== '::') break;
      if (tokens[i + 1]?.type === '<') {
        const past = skipAngles(tokens, i + 1);
        if (past < 0) break;
        i = past;
        if (tokens[i]?.type === '::' && isSegment(tokens[i + 1], source)) {
          i++;
          continue;
        }
        break;
      }
      if (!isSegment(tokens[i + 1], source)) break;
      i++;
    }
    // A macro of its own: read only when it is one of the expression macros.
    if (tokens[i]?.type === '!' && tokens[i + 1]?.type === 'token_tree') {
      const name = segs[segs.length - 1]!.text;
      if (RUST_EXPRESSION_MACROS.has(name)) scanGroup(tokens[i + 1]!, name === 'matches', false, source, out);
      expr = { k: 'other' };
      i += 2;
    } else if (segs.length === 1 && !leading) {
      const only = segs[0]!.text;
      expr = only === 'self' ? { k: 'self' } : isName(start, source) ? { k: 'name', name: only } : { k: 'other' };
    } else {
      expr = { k: 'path', text: (leading ? '::' : '') + segs.map((s) => s.text).join('::') };
    }
  }
  // A path to a capitalized member that no call or struct literal follows
  // names a variant: its receiver, the segment before the member, is
  // referenced where it is written (the call extractor's static member ref).
  const variantRef = (): void => {
    if (segs.length < 2) return;
    const member = segs[segs.length - 1]!.text;
    const recv = segs[segs.length - 2]!;
    if (/^[A-Z]/.test(member) && recv.text !== 'Self' && TYPE_NAME.test(recv.text) && recv.node.type === 'identifier') {
      out.push({ name: recv.text, kind: 'references', at: recv.node });
    }
  };
  if (expr.k === 'path') {
    // In a pattern every variant path names its enum (`Mode::C(x)`,
    // `Mode::D { .. }`); in an expression a call's callee and a struct
    // literal's name are their own.
    const following = tokens[i];
    const struct = following?.type === 'token_tree' && delimiter(following) === '{';
    const called = following?.type === 'token_tree' && delimiter(following) === '(';
    if (inPattern || (!called && !struct)) variantRef();
  }
  for (;;) {
    const t = tokens[i];
    if (!t) break;
    if (t.type === 'token_tree' && delimiter(t) === '(') {
      // A call: of a name or a path; in a pattern, a tuple variant's fields.
      if (!inPattern) {
        if (expr.k === 'name') out.push({ name: expr.name, kind: 'calls', at: start });
        else if (expr.k === 'path') out.push({ name: expr.text, kind: 'calls', at: start });
      }
      scanGroup(t, false, inPattern, source, out);
      expr = { k: 'call', callee: expr };
      i++;
      continue;
    }
    if (t.type === 'token_tree' && delimiter(t) === '[') {
      scanGroup(t, false, false, source, out);
      expr = { k: 'other' };
      i++;
      continue;
    }
    if (t.type === 'token_tree' && delimiter(t) === '{') {
      // A struct literal's (or pattern's) fields.
      scanGroup(t, false, inPattern, source, out);
      expr = { k: 'other' };
      i++;
      continue;
    }
    if (t.type === '?') {
      expr = { k: 'other' };
      i++;
      continue;
    }
    if (t.type !== '.') break;
    const n = tokens[i + 1];
    if (!n) break;
    if (n.type === 'await') {
      expr = { k: 'other' };
      i += 2;
      continue;
    }
    if (n.type === 'integer_literal') {
      expr = { k: 'field', base: expr, name: getNodeText(n, source) };
      i += 2;
      continue;
    }
    if (n.type !== 'identifier' && !CONTEXTUAL_NAMES.has(n.type)) break;
    const member = getNodeText(n, source);
    let j = i + 2;
    if (tokens[j]?.type === '::' && tokens[j + 1]?.type === '<') {
      const past = skipAngles(tokens, j + 1);
      if (past < 0) break;
      j = past;
    }
    const args = tokens[j];
    if (args?.type === 'token_tree' && delimiter(args) === '(') {
      if (!inPattern) {
        const name = methodCallName(expr, member);
        if (name !== null) out.push({ name, kind: 'calls', at: start });
      }
      scanGroup(args, false, false, source, out);
      expr = { k: 'method', base: expr, name: member };
      i = j + 1;
      continue;
    }
    expr = { k: 'field', base: expr, name: member };
    i = j;
  }
  return i;
}
