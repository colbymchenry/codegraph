/**
 * Branch guards — the conditions under which a call site runs.
 *
 * An edge says `handlePress → openObjectDetail`. What a reader wants to know
 * is that it happens **when `isCollected`** and **not while `isUploading`**:
 *
 *   if (isUploading) return            ← early-return guard: !isUploading
 *   if (isCollected) {                 ← if: isCollected
 *     openObjectDetail(item)           ← the call site
 *
 * This module derives that from the AST at query time. Given a file, its
 * language and a call site (line, column), it walks from the innermost node at
 * that position up to the enclosing function boundary and records every
 * branch it passes through: `if` / `else` / `else if`, the arms of a ternary,
 * `switch` cases, the right side of `&&` / `||`, a `catch`, and — at each
 * statement block on the way — the early exits that precede the site
 * (`if (x) return`, Swift `guard x else { return }`).
 *
 * Nothing is stored in the index. The viewer and `codegraph_explore` already
 * re-read source per request (drift checks, source windows, highlighting), the
 * grammars are loaded in both processes, and a file parses in about a
 * millisecond — so labels are computed where they are shown, from the source
 * as it is now, and the index schema and the native kernel are untouched. A
 * small LRU keeps the last few parsed trees so a Symbol view that asks about
 * forty call sites in one file parses it once.
 *
 * Only what the AST states is reported. Loops are not conditions and are not
 * listed; a condition that cannot be read (a language without rules here, a
 * file that will not parse) yields no label rather than a wrong one.
 */

import * as fs from 'fs';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { Language } from '../types';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';

// =============================================================================
// Public shape
// =============================================================================

export type GuardForm = 'if' | 'else' | 'ternary' | 'case' | 'guard' | 'and' | 'or' | 'catch';

/** How an arm leaves the flow: back to the caller, or by an error. */
export type GuardExit = 'return' | 'throw' | 'exit';

export interface BranchGuard {
  /** The condition's source, whitespace-collapsed, outer parens dropped, capped in length. */
  text: string;
  /** The site runs when the condition is FALSE (an else arm, an early-return guard, `||`). */
  negated: boolean;
  form: GuardForm;
  /** Line of the condition (1-based). */
  line: number;
  /**
   * Where the branching construct starts, `line:column` (1-based line, 0-based
   * column) — the identity of the FORK rather than of the arm: the `if` an
   * `if` guard and its `else` guard both come from, the `switch` every one of
   * its cases comes from, the `try` a `catch` belongs to. Two guards with the
   * same `branch` are arms of one decision, which is what a reader of the code
   * in its own order needs and a joined condition string cannot say.
   * '' when the walk could not place it.
   */
  branch: string;
  /** How the arm the site is IN leaves, when it always does — `return`, `throw`. */
  armExit?: GuardExit;
  /** For an early exit (`form: 'guard'`), how the arm that was NOT taken leaves. */
  exit?: GuardExit;
}

/** Longest condition text kept before it is cut with an ellipsis. */
const MAX_TEXT = 80;

const JS_FAMILY: ReadonlySet<Language> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/** Languages with walk rules below. Others yield no guards (never a wrong one). */
export function supportsBranchGuards(language: Language | string | undefined | null): boolean {
  return !!language && RULES_BY_LANGUAGE.has(language as Language);
}

/**
 * The label a rail or a flow connector prints: the conditions in execution
 * order, joined with `&&`, each negated one written as `!x`. Empty when the
 * site is unconditional.
 */
export function guardLabel(guards: readonly BranchGuard[]): string {
  return guards.map(renderGuard).join(' && ');
}

function renderGuard(g: BranchGuard): string {
  if (g.form === 'catch') return g.text;
  // `if (!object?.id || !object?.name)` joined to the guard before it with
  // `&&` would read as two conditions: it keeps its parentheses.
  if (!g.negated) return hasTopLevelOr(g.text) ? `(${g.text})` : g.text;
  // `!x` negated reads back as `x`; a simple operand takes a bare `!`;
  // anything with operators is parenthesised so the negation is unambiguous.
  if (/^!(?![=])/.test(g.text) && isSimpleOperand(g.text.slice(1))) return g.text.slice(1);
  if (/^not\s+/.test(g.text) && isSimpleOperand(g.text.slice(4).trim())) return g.text.slice(4).trim();
  // One comparison flips instead of wrapping: the reader of a Go `if err !=
  // nil { return }` wants `err == nil`, not `!(err != nil)`.
  const flipped = flipComparison(g.text);
  if (flipped !== null) return flipped;
  return isSimpleOperand(g.text) ? `!${g.text}` : `!(${g.text})`;
}

/** `a != b` → `a == b`, `x is None` → `x is not None`; null when the text is not one plain comparison. */
function flipComparison(text: string): string | null {
  if (/&&|\|\||\band\b|\bor\b|\?/.test(text)) return null;
  if (hasTopLevelOr(text)) return null;
  const m = /^([^=!<>]+?)\s*(===|!==|==|!=|\bis not\b|\bis\b)\s*([^=!<>]+)$/.exec(text);
  if (!m) return null;
  const flip: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', is: 'is not', 'is not': 'is' };
  const op = flip[m[2]!];
  return op ? `${m[1]!.trim()} ${op} ${m[3]!.trim()}` : null;
}

/** A `||` outside every bracket and string — the condition is a disjunction as written. */
function hasTopLevelOr(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === '|' && text[i + 1] === '|') return true;
  }
  return false;
}

function isSimpleOperand(text: string): boolean {
  // A name, a member chain, or one call on it — `Objects.equals(owner.getId(), id)`
  // included: the parens must balance and nothing may sit outside them.
  if (/[=<>]/.test(text) || /\s(?:&&|\|\||and|or)\s/.test(text)) return false;
  const m = /^([\w$.?!]+)(\(.*\))?$/s.exec(text);
  if (!m) return false;
  if (!m[2]) return true;
  let depth = 0;
  for (let i = 0; i < m[2].length; i++) {
    const ch = m[2][i]!;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0 && i < m[2].length - 1) return false;
    }
  }
  return depth === 0;
}

// =============================================================================
// Trees, cached per file version
// =============================================================================

interface CachedTree {
  key: string;
  tree: Tree;
  source: string;
}

const TREE_CACHE_SIZE = 8;
const treeCache = new Map<string, CachedTree>();

/**
 * Files above this size are not parsed for labels. A 300 KB source file costs
 * tens of milliseconds to parse, and a Symbol view is budgeted at 100 ms end
 * to end; a call site in such a file simply shows no `when`.
 */
export const MAX_PARSE_BYTES = 256 * 1024;

/** The `web-tree-sitter` trees held above are native memory: evict explicitly. */
function remember(path: string, entry: CachedTree): void {
  const old = treeCache.get(path);
  if (old) old.tree.delete();
  treeCache.delete(path);
  treeCache.set(path, entry);
  if (treeCache.size > TREE_CACHE_SIZE) {
    const oldest = treeCache.keys().next().value as string;
    treeCache.get(oldest)?.tree.delete();
    treeCache.delete(oldest);
  }
}

async function treeFor(absPath: string, language: Language): Promise<CachedTree | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  const key = `${language}:${stat.mtimeMs}:${stat.size}`;
  const hit = treeCache.get(absPath);
  if (hit && hit.key === key) return hit;
  if (stat.size > MAX_PARSE_BYTES) return null;
  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const tree = await parse(source, language);
  if (!tree) return null;
  const entry = { key, tree, source };
  remember(absPath, entry);
  return entry;
}

async function parse(source: string, language: Language): Promise<Tree | null> {
  try {
    await loadGrammarsForLanguages([language]);
    const parser = getParser(language);
    if (!parser) return null;
    return parser.parse(source) ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// Entry points
// =============================================================================

export interface CallSite {
  line: number;
  /** 0-based; null/undefined = the first non-blank column of the line. */
  column?: number | null;
  /**
   * The callee's last segment, when known (`json` for `res.status(201).json(…)`):
   * a position at the start of a chain sits on the innermost call, and the
   * climb continues to the call that is actually this one.
   */
  callee?: string;
}

export function siteKey(site: CallSite): string {
  return `${site.line}:${typeof site.column === 'number' ? site.column : ''}${site.callee ? `:${site.callee}` : ''}`;
}

/**
 * Guards for many call sites in one file, keyed by {@link siteKey}. The file
 * is parsed once (and cached across requests until it changes on disk). A
 * language without rules, or a file that cannot be read or parsed, yields an
 * empty map.
 */
export async function guardsForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, BranchGuard[]>> {
  const out = new Map<string, BranchGuard[]>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    out.set(key, guardsInTree(cached.tree.rootNode, cached.source, language, site.line, site.column ?? null));
  }
  return out;
}

/**
 * Synchronous twin of {@link guardsForFile} for callers that cannot await
 * (the explore text builder). It only serves languages whose grammar is
 * ALREADY loaded — see {@link warmBranchGuardGrammars} — and yields an empty
 * map otherwise, never a wrong label.
 */
export function guardsForFileSync(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Map<string, BranchGuard[]> {
  const out = new Map<string, BranchGuard[]>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return out;
  }
  const key = `${language}:${stat.mtimeMs}:${stat.size}`;
  let cached = treeCache.get(absPath);
  if (!cached || cached.key !== key) {
    if (stat.size > MAX_PARSE_BYTES) return out;
    const parser = getParser(language);
    if (!parser) return out;
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch {
      return out;
    }
    const tree = parser.parse(source);
    if (!tree) return out;
    cached = { key, tree, source };
    remember(absPath, cached);
  }
  for (const site of sites) {
    const k = siteKey(site);
    if (!out.has(k)) out.set(k, guardsInTree(cached.tree.rootNode, cached.source, language, site.line, site.column ?? null));
  }
  return out;
}

/** The languages with rules here — what {@link warmBranchGuardGrammars} loads. */
export const BRANCH_GUARD_LANGUAGES: readonly Language[] = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'swift',
  'python',
  'java',
  'kotlin',
  'csharp',
  'go',
  'c',
  'cpp',
  'objc',
];

// =============================================================================
// Call arguments — what a site passes
// =============================================================================

/** Longest argument list kept before it is cut with an ellipsis. */
const MAX_ARGS_TEXT = 96;
/** Longest single argument (a string literal, a name) kept whole. */
const MAX_ARG_TEXT = 40;
/** Object keys listed before `…` stands for the rest. */
const MAX_OBJECT_KEYS = 4;
/** Call nodes, across the grammars with rules here: JS, Swift, Python, Java, Kotlin, C#, Go, C. */
const CALL_TYPES: ReadonlySet<string> = new Set([
  'call_expression',
  'new_expression',
  'call',
  'method_invocation',
  'object_creation_expression',
  'invocation_expression',
  'constructor_invocation',
]);
const ARGUMENT_CONTAINERS: ReadonlySet<string> = new Set(['arguments', 'value_arguments', 'argument_list']);
const STRING_TYPES: ReadonlySet<string> = new Set([
  'string',
  'template_string',
  'line_string_literal',
  'multi_line_string_literal',
  'raw_string_literal',
  'string_literal',
  'interpreted_string_literal',
  'concatenated_string',
  'verbatim_string_literal',
  'interpolated_string_expression',
  'char_literal',
]);
const OBJECT_TYPES: ReadonlySet<string> = new Set(['object', 'object_expression', 'dictionary', 'anonymous_object_creation_expression']);
const ARRAY_TYPES: ReadonlySet<string> = new Set([
  'array',
  'array_literal',
  'dictionary_literal',
  'list',
  'tuple',
  'set',
  'list_comprehension',
  'array_creation_expression',
  'array_initializer',
  'initializer_list',
  'collection_expression',
  'collection_literal',
]);
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'lambda',
  'lambda_expression',
  'func_literal',
  'anonymous_function',
  'anonymous_method_expression',
]);

/**
 * The arguments a call site passes, as written, abbreviated to what a reader
 * scans for: a string literal whole (a storage key, a URL, a message), a name
 * whole, an object as its keys (`{ email, password }`), an array as `[…]`, a
 * function as `() => …`, a nested call as `f(…)`. The conditions say WHEN a
 * step runs; this says WITH WHAT — `SecureStore.setItemAsync('userEmail',
 * values.email)` is a different fact from `SecureStore.setItemAsync`.
 *
 * Keyed by {@link siteKey} like the guards, read from the same cached tree.
 * A site that is not inside a call, or a language without rules, is absent.
 */
export async function callArgumentsForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    const text = callArgumentsInTree(cached.tree.rootNode, cached.source, site.line, site.column ?? null);
    if (text !== null) out.set(key, text);
  }
  return out;
}

/** {@link callArgumentsForFile} over source text — the test surface. */
export async function callArgumentsInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null
): Promise<string | null> {
  if (!supportsBranchGuards(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return callArgumentsInTree(tree.rootNode, source, line, column);
  } finally {
    tree.delete();
  }
}

export function callArgumentsInTree(
  root: SyntaxNode,
  source: string,
  line: number,
  column: number | null
): string | null {
  return callSiteInTree(root, source, line, column)?.args ?? null;
}

/** One call site, both halves: what is called, as written, and what it is passed. */
export interface CallSiteText {
  /**
   * The callee as written, normalised: `prisma.article.findFirst`,
   * `this.owners.findById().orElseThrow`, `res.status().json` — member
   * chains kept whole (the index keeps only the last segment of a deep
   * chain), argument lists emptied, `await`/`new` dropped, `?.` as `.`.
   */
  callee: string;
  /** The argument list, abbreviated as {@link callArgumentsForFile} says. */
  args: string;
  /** The same arguments one by one — a registration site's middleware chain is `argList.slice(1, -1)`. */
  argList: string[];
  /** A status code written as an object property in the arguments (`{ status: 201 }`), which the abbreviation to keys would hide. */
  status?: number;
  /** Where the call starts and ends in the source (1-based lines) — the span another site may be written inside. */
  span?: { start: { line: number; column: number }; end: { line: number; column: number } };
  /**
   * The call this one is written inside the arguments of — `res.json` for the
   * `generateToken(…)` in `res.json({ token: generateToken(…) })` — normalised
   * like `callee`. Absent at the top of a statement, and never reaching out of
   * the function or block the call is in.
   */
  within?: string;
}

/** A node the climb to an enclosing call must not cross: the call is then a statement of its own inside a callback. */
const CALL_BOUNDARY = /function|lambda|closure|block|statement|body|declaration/;

/** The nearest call whose ARGUMENTS contain `call`, as its callee chain; null when there is none this side of a function or block. */
function enclosingCallText(call: SyntaxNode): string | null {
  for (let node = call.parent, up = 0; node && up < 12; node = node.parent, up++) {
    if (CALL_BOUNDARY.test(node.type)) return null;
    if (!CALL_TYPES.has(node.type)) continue;
    const container = argumentsOf(node);
    if (container && container.startIndex <= call.startIndex && call.endIndex <= container.endIndex) return calleeChainText(node, container);
    return null;
  }
  return null;
}

const STATUS_KEY = /^(?:status|statusCode|status_code|code)$/;

/** `{ status: 201 }` inside an argument — the literal an abbreviated object hides. */
function statusPropertyIn(node: SyntaxNode, depth = 0): number | null {
  if (depth > 2) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === 'pair' || c.type === 'keyword_argument' || c.type === 'named_argument' || c.type === 'property_assignment' || c.type === 'object_property') {
      const key = c.childForFieldName('key') ?? c.childForFieldName('name') ?? c.namedChild(0);
      const value = c.childForFieldName('value') ?? c.namedChild(c.namedChildCount - 1);
      if (key && value && STATUS_KEY.test(key.text.replace(/['"]/g, '')) && /^[1-5]\d{2}$/.test(value.text)) return Number(value.text);
    }
    const inner = statusPropertyIn(c, depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/** Longest callee text kept before it is cut. */
const MAX_CALLEE_TEXT = 96;

/** The call node a site belongs to: climb from the callee to the call. A few levels cover a member chain. */
function callAt(root: SyntaxNode, source: string, line: number, column: number | null, callee?: string): SyntaxNode | null {
  const row = line - 1;
  // The recorded column may sit a character off the callee (a 1-based
  // column, the space before `prisma`): a near miss is tried before giving up.
  const columns = column === null ? [firstNonBlankColumn(source, row)] : [column, column + 1, Math.max(0, column - 1), firstNonBlankColumn(source, row)];
  const want = callee ? callee.split(/[.:]/).pop() ?? callee : null;
  for (const col of columns) {
    const start = innermostAt(root, row, col);
    if (!start) continue;
    let node: SyntaxNode | null = start;
    let first: SyntaxNode | null = null;
    for (let up = 0; node && up < 10; up++, node = node.parent) {
      if (!CALL_TYPES.has(node.type)) continue;
      if (!first) first = node;
      if (want === null) return node;
      // A chain's position is its start: `res.status(201).json(…)` at `res`
      // meets `res.status(…)` first; the call that is THIS one names `json`.
      const container = argumentsOf(node);
      const text = container ? calleeChainText(node, container) : '';
      if ((text.replace(/\([^()]*\)/g, '').split(/[.:]/).pop() ?? '') === want) return node;
    }
    if (first) return first;
  }
  return null;
}

export function callSiteInTree(root: SyntaxNode, source: string, line: number, column: number | null, want?: string): CallSiteText | null {
  const call = callAt(root, source, line, column, want);
  if (!call) return null;
  const container = argumentsOf(call);
  if (!container) return null;
  const callee = calleeChainText(call, container);
  if (container.type === 'lambda_literal') return { callee, args: '{ … }', argList: ['{ … }'] };
  const parts: string[] = [];
  let status: number | null = null;
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i);
    if (!c || c.type === 'comment') continue;
    parts.push(abbreviateArgument(c, source));
    if (status === null && c.type !== 'comment') status = statusPropertyIn(c);
  }
  const text = parts.join(', ');
  if (status === null) status = statusSetBefore(call, callee);
  const span = {
    start: { line: call.startPosition.row + 1, column: call.startPosition.column },
    end: { line: call.endPosition.row + 1, column: call.endPosition.column },
  };
  const within = enclosingCallText(call);
  return {
    callee,
    args: text.length > MAX_ARGS_TEXT ? `${text.slice(0, MAX_ARGS_TEXT - 1)}…` : text,
    argList: parts,
    span,
    ...(within ? { within } : {}),
    ...(status !== null ? { status } : {}),
  };
}

const BODY_REPLY = /^(?:res|response|reply|rep|ctx|c|context)\.(?:json|jsonp|send|render|sendFile|download|end|text|html|body)$/;
const STATEMENT_BLOCKS: ReadonlySet<string> = new Set(['statement_block', 'program', 'block', 'class_body', 'module']);
/** Statements looked back through for a status the reply's own chain does not carry. */
const STATUS_LOOKBACK = 6;

/**
 * `res.status(202); res.json(user)` — the status set by an earlier statement
 * in the same block, when the reply's own chain sets none. Only a statement
 * that IS the status call counts (`res.status(404)` inside an `if` before it
 * is another path, not this reply's); the first one found walking back wins.
 */
function statusSetBefore(call: SyntaxNode, callee: string): number | null {
  const bare = callee.replace(/\([^()]*\)/g, '');
  if (!BODY_REPLY.test(bare) || /\b(?:status|code|sendStatus|writeHead)\(/.test(callee)) return null;
  const receiver = bare.split('.')[0]!;
  let statement: SyntaxNode | null = call;
  while (statement.parent && !STATEMENT_BLOCKS.has(statement.parent.type)) statement = statement.parent;
  const re = new RegExp(`^\\s*(?:await\\s+)?${receiver}\\s*\\.\\s*(?:status|code)\\s*\\(\\s*([1-5]\\d{2})\\s*\\)\\s*;?\\s*$|^\\s*${receiver}\\s*\\.\\s*statusCode\\s*=\\s*([1-5]\\d{2})\\s*;?\\s*$`);
  let prev: SyntaxNode | null = statement.previousNamedSibling;
  for (let i = 0; prev && i < STATUS_LOOKBACK; i++, prev = prev.previousNamedSibling) {
    if (prev.type === 'comment') continue;
    const m = re.exec(prev.text);
    if (m) return Number(m[1] ?? m[2]);
  }
  return null;
}

/** The text of a call before its arguments, normalised to a member chain. */
function calleeChainText(call: SyntaxNode, container: SyntaxNode): string {
  // Kotlin and Swift wrap the arguments in a `call_suffix`; the callee is
  // everything before that suffix.
  let end = container.startIndex;
  const suffix = container.parent && container.parent.type === 'call_suffix' ? container.parent : null;
  if (suffix) end = suffix.startIndex;
  let text = collapse(call.text.slice(0, Math.max(0, end - call.startIndex)));
  text = text.replace(/^(?:await|new|yield|return)\s+/, '').replace(/^(?:await|new)\s+/, '');
  // Empty every nested argument list, innermost first: `a(b(c)).d` → `a().d`
  // — keeping one short literal or name (`res.status(404).json`,
  // `ResponseEntity.status(HttpStatus.NOT_FOUND).body`), which is the fact a
  // reader of the chain wants.
  for (let i = 0; i < 6 && /\([^()]*\)/.test(text); i++) {
    text = text.replace(/\(([^()]*)\)/g, (_m, inner: string) => (/^\s*[\w.]{1,28}\s*$/.test(inner) ? `(${inner.trim()})` : '()'));
  }
  text = text
    .replace(/\?\./g, '.')
    .replace(/!\./g, '.')
    .replace(/\s+/g, '')
    .replace(/<[^<>]*>/g, '')
    .replace(/\([^()]*\)$/, '');
  return text.length > MAX_CALLEE_TEXT ? `${text.slice(0, MAX_CALLEE_TEXT - 1)}…` : text;
}

/** Both halves of every site, keyed by {@link siteKey}, from one cached tree. */
export async function callSitesForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, CallSiteText>> {
  const out = new Map<string, CallSiteText>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    const found = callSiteInTree(cached.tree.rootNode, cached.source, site.line, site.column ?? null, site.callee);
    if (found !== null) out.set(key, found);
  }
  return out;
}

/** {@link callSitesForFile} over source text — the test surface. */
export async function callSiteInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null
): Promise<CallSiteText | null> {
  if (!supportsBranchGuards(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return callSiteInTree(tree.rootNode, source, line, column);
  } finally {
    tree.delete();
  }
}

/** The node holding a call's arguments: the `arguments` field, a container child, or Swift's `call_suffix` contents. */
function argumentsOf(call: SyntaxNode): SyntaxNode | null {
  const field = call.childForFieldName('arguments');
  if (field) return field;
  for (let i = 0; i < call.namedChildCount; i++) {
    const c = call.namedChild(i);
    if (!c) continue;
    if (ARGUMENT_CONTAINERS.has(c.type)) return c;
    if (c.type === 'call_suffix') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const inner = c.namedChild(j);
        if (inner && (ARGUMENT_CONTAINERS.has(inner.type) || inner.type === 'lambda_literal')) return inner;
      }
      return c;
    }
  }
  return null;
}

function abbreviateArgument(node: SyntaxNode, source: string): string {
  const type = node.type;
  // Python `name=value`, C# `name: value` — the name is half the meaning.
  if (type === 'keyword_argument') {
    const name = node.childForFieldName('name');
    const value = node.childForFieldName('value');
    return `${name?.text ?? ''}=${value ? abbreviateArgument(value, source) : ''}`;
  }
  if (type === 'argument') {
    // C#: an `argument` wraps the expression, optionally with a name.
    const name = node.childForFieldName('name');
    const inner = lastNamed(node);
    const value = inner ? abbreviateArgument(inner, source) : cut(collapse(node.text), MAX_ARG_TEXT);
    return name && inner && name.id !== inner.id ? `${name.text}: ${value}` : value;
  }
  // Go `gin.H{"error": err}` / `User{Name: n}`: the type, then the braces.
  if (type === 'composite_literal') {
    const t = node.childForFieldName('type');
    return `${t ? cut(collapse(t.text), 24) : ''}{…}`;
  }
  if (STRING_TYPES.has(type)) return cut(collapse(node.text), MAX_ARG_TEXT);
  if (OBJECT_TYPES.has(type)) return objectKeys(node, source);
  if (ARRAY_TYPES.has(type)) return '[…]';
  if (FUNCTION_TYPES.has(type)) return '() => …';
  if (type === 'lambda_literal') return '{ … }';
  if (type === 'spread_element') return cut(collapse(node.text), MAX_ARG_TEXT);
  if (type === 'await_expression') {
    const inner = node.namedChild(0);
    return inner ? `await ${abbreviateArgument(inner, source)}` : 'await …';
  }
  if (CALL_TYPES.has(type)) {
    const callee = node.childForFieldName('function') ?? node.childForFieldName('constructor') ?? node.namedChild(0);
    const name = callee ? cut(collapse(callee.text), 28) : '';
    return `${type === 'new_expression' ? 'new ' : ''}${name}(…)`;
  }
  // Swift `label: value` — the label is half the meaning (`withName:`).
  if (type === 'value_argument') {
    const named: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) named.push(c);
    }
    if (named.length >= 2 && (named[0]!.type === 'simple_identifier' || named[0]!.type === 'value_argument_label')) {
      return `${named[0]!.text}: ${abbreviateArgument(named[named.length - 1]!, source)}`;
    }
    return named.length > 0 ? abbreviateArgument(named[named.length - 1]!, source) : cut(collapse(node.text), MAX_ARG_TEXT);
  }
  if (type === 'lambda_argument' || type === 'trailing_closure' || type === 'annotated_lambda') return '{ … }';
  return cut(collapse(node.text), MAX_ARG_TEXT);
}

/** `{ email, password, …}` — the keys an object literal passes, not its bulk. */
function objectKeys(node: SyntaxNode, source: string): string {
  const keys: string[] = [];
  let more = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type === 'comment') continue;
    let key: string | null = null;
    if (c.type === 'pair') key = c.childForFieldName('key')?.text ?? null;
    else if (c.type === 'shorthand_property_identifier' || c.type === 'shorthand_property_identifier_pattern') key = c.text;
    else if (c.type === 'spread_element') key = collapse(c.text);
    else if (c.type === 'method_definition') key = c.childForFieldName('name')?.text ?? null;
    if (key === null) continue;
    if (keys.length >= MAX_OBJECT_KEYS) {
      more++;
      continue;
    }
    keys.push(cut(key, 24));
  }
  void source;
  if (keys.length === 0) return '{…}';
  return `{ ${keys.join(', ')}${more > 0 ? ', …' : ''} }`;
}

// =============================================================================
// Triggers — what fires a site
// =============================================================================

/**
 * What binds a call site to an event, when something does — the answer to
 * "at what point does this run": the JSX attribute the site sits under
 * (`onPress` of `<Button>`), the `on*` option it is written in (`onSubmit`
 * of `useFormik({…})`), or the runs-later call it is an argument of
 * (`useEffect`, `setTimeout`, `addListener('x')`, `.then`).
 */
export interface SiteTrigger {
  /**
   * `prop` / `option` / `callback` are read at the site (below). `request`
   * (a route: `name` the verb, `of` the path), `decorator` (`@Process('email')`:
   * `name` the decorator, `of` its literal argument) and `load` (a page's own
   * load-time work) are set by the Steps endpoint from the registration
   * site, not read from the tree.
   */
  kind: 'prop' | 'option' | 'callback' | 'request' | 'decorator' | 'load';
  /** `onPress`, `onSubmit`, `useEffect`, `addListener`, `POST`, `Process`. */
  name: string;
  /** `Button` for a prop, `useFormik` for an option, the first string argument for a callback; null when unknown. */
  of: string | null;
  /** What runs before it fires — the middleware / guard chain at the registration site, in order. */
  after?: string[];
}

/** Callees whose function argument runs LATER — a callback, not a call. Matched on the last segment. */
const LATER_CALLEES: ReadonlySet<string> = new Set([
  'useEffect',
  'useLayoutEffect',
  'useFocusEffect',
  'useImperativeHandle',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'runAfterInteractions',
  'addListener',
  'addEventListener',
  'on',
  'once',
  'subscribe',
  'then',
  'catch',
  'finally',
  'runOnJS',
  'runOnUI',
  'scheduleOnRN',
]);
/** The walk up never leaves the function the site belongs to — unless that function is inline. */
const TRIGGER_BOUNDARIES: ReadonlySet<string> = new Set(['function_declaration', 'method_definition', 'class_declaration', 'class_body', 'program']);
const MAX_TRIGGER_CLIMB = 24;

export async function triggersForFile(
  absPath: string,
  language: Language,
  sites: readonly CallSite[]
): Promise<Map<string, SiteTrigger>> {
  const out = new Map<string, SiteTrigger>();
  if (!JS_FAMILY.has(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (out.has(key)) continue;
    const t = triggerInTree(cached.tree.rootNode, cached.source, site.line, site.column ?? null);
    if (t !== null) out.set(key, t);
  }
  return out;
}

/** {@link triggersForFile} over source text — the test surface. */
export async function triggerInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null
): Promise<SiteTrigger | null> {
  if (!JS_FAMILY.has(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return triggerInTree(tree.rootNode, source, line, column);
  } finally {
    tree.delete();
  }
}

export function triggerInTree(root: SyntaxNode, source: string, line: number, column: number | null): SiteTrigger | null {
  const row = line - 1;
  const col = column ?? firstNonBlankColumn(source, row);
  let node: SyntaxNode | null = innermostAt(root, row, col);
  let prev: SyntaxNode | null = null;
  // Whether the climb crossed an inline function: `onPress={() => go()}`
  // fires later, `behavior={isAndroid() ? 'a' : 'b'}` runs at render.
  let deferred = false;
  for (let up = 0; node && up < MAX_TRIGGER_CLIMB; up++, prev = node, node = node.parent) {
    const type = node.type;
    if (TRIGGER_BOUNDARIES.has(type)) return null;
    // A named handler is its own story: `const handleX = useCallback(() => …)`
    // binds a name, and whoever uses the name is the trigger of what is inside.
    if (type === 'arrow_function' || type === 'function_expression') {
      const p = node.parent;
      if (p?.type === 'variable_declarator') return null;
      if (p?.type === 'arguments' && p.parent) {
        const callee = lastSegment(calleeText(p.parent));
        if (callee === 'useCallback' || callee === 'useMemo' || callee === 'useEffectEvent' || callee === 'useEvent') return null;
      }
      deferred = true;
    }
    if (type === 'jsx_attribute') {
      const name = node.namedChild(0);
      const propName = name ? name.text : 'prop';
      // An event prop, or any prop given a function: fired later. A value
      // computed in the attribute (`behavior={isAndroid() ? …}`) is not.
      if (!deferred && !/^on[A-Z]/.test(propName)) return null;
      const element = node.parent;
      const tag = element ? element.childForFieldName('name') : null;
      return { kind: 'prop', name: propName, of: tag ? collapseText(tag.text) : null };
    }
    if (type === 'pair') {
      const key = node.childForFieldName('key');
      const keyText = key ? key.text.replace(/^['"`]|['"`]$/g, '') : '';
      if (/^on[A-Z]\w*$/.test(keyText)) {
        // `useFormik({ onSubmit: … })`, `Alert.alert(t, m, [{ onPress: … }])`:
        // the object — possibly inside an array — is an argument of a call.
        let holder: SyntaxNode | null = node.parent;
        for (let hop = 0; holder && hop < 4 && (holder.type === 'object' || holder.type === 'array' || holder.type === 'pair'); hop++) {
          holder = holder.parent;
        }
        const call = holder?.type === 'arguments' ? holder.parent : null;
        return { kind: 'option', name: keyText, of: call && CALL_TYPES.has(call.type) ? calleeText(call) : null };
      }
    }
    if (type === 'arguments' && node.parent && CALL_TYPES.has(node.parent.type) && prev !== null) {
      const callee = lastSegment(calleeText(node.parent));
      if (callee !== null && LATER_CALLEES.has(callee)) {
        const first = node.namedChild(0);
        const of = first && STRING_TYPES.has(first.type) ? cut(collapseText(first.text), MAX_ARG_TEXT) : null;
        return { kind: 'callback', name: callee, of };
      }
    }
  }
  return null;
}

/** A call's callee as written: `nativeEmitter.addListener`, `Alert.alert`, `useFormik`. */
function calleeText(call: SyntaxNode): string | null {
  const callee = call.childForFieldName('function') ?? call.childForFieldName('constructor');
  return callee ? cut(collapseText(callee.text), 40) : null;
}

/** The last segment of a callee: `nativeEmitter.addListener` → `addListener`. */
function lastSegment(text: string | null): string | null {
  if (text === null) return null;
  const m = text.match(/([A-Za-z_$][\w$]*)\s*$/);
  return m ? m[1]! : text;
}

function collapseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function collapse(text: string): string {
  return collapseText(text);
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstNonBlankColumn(source: string, row: number): number {
  const line = source.split('\n')[row] ?? '';
  const m = line.match(/\S/);
  return m ? (m.index ?? 0) : 0;
}

/** Load the grammars {@link guardsForFileSync} needs; a no-op once loaded, never throws. */
export async function warmBranchGuardGrammars(only?: readonly Language[]): Promise<void> {
  const wanted = BRANCH_GUARD_LANGUAGES.filter((l) => !only || only.includes(l));
  if (wanted.length === 0) return;
  try {
    await loadGrammarsForLanguages(wanted);
  } catch {
    // Explore prints no `when` for that language; nothing else changes.
  }
}

/** Guards for one site in source text — the test seam; production reads files. */
export async function guardsInSource(
  source: string,
  language: Language,
  line: number,
  column: number | null = null
): Promise<BranchGuard[]> {
  if (!supportsBranchGuards(language)) return [];
  const tree = await parse(source, language);
  if (!tree) return [];
  try {
    return guardsInTree(tree.rootNode, source, language, line, column);
  } finally {
    tree.delete();
  }
}

/** Loops for one site in source text — the test seam; production reads files. */
export async function loopsInSource(source: string, language: Language, line: number, column: number | null = null): Promise<SiteLoop[]> {
  if (!supportsBranchGuards(language)) return [];
  const tree = await parse(source, language);
  if (!tree) return [];
  try {
    return loopsInTree(tree.rootNode, source, language, line, column);
  } finally {
    tree.delete();
  }
}

/** A loop a site is written inside: its header as written, and where the loop starts. */
export interface SiteLoop {
  /** `const item of items`, `i = 0; i < n; i++`, `queue.length > 0` — the header, without its keyword. */
  text: string;
  /** `each` for a `for` / `foreach` / `for … in`, `while` for a `while` / `do` / `repeat`. */
  kind: 'each' | 'while';
  /** Where the loop starts, `line:column` — the same identity a guard's `branch` carries. */
  branch: string;
}

/** Loop node types across the grammars with rules here. A type absent yields nothing, never a wrong label. */
const LOOP_TYPES: ReadonlyMap<string, 'each' | 'while'> = new Map([
  ['for_statement', 'each'],
  ['for_in_statement', 'each'],
  ['for_of_statement', 'each'],
  ['for_each_statement', 'each'],
  ['enhanced_for_statement', 'each'],
  ['foreach_statement', 'each'],
  ['for_range_loop', 'each'],
  ['for_expression', 'each'],
  ['while_statement', 'while'],
  ['while_expression', 'while'],
  ['do_statement', 'while'],
  ['do_while_statement', 'while'],
  ['repeat_while_statement', 'while'],
]);

/**
 * The loops a site is written inside, outermost first — what tells a reading in
 * the code's order that a run of calls happens once PER ITEM rather than once.
 * The climb is the guards' climb (the same boundaries, the same transparent
 * inline functions), so a callback's body is read in its own function and a
 * `.forEach` body under the loop it is written in.
 */
export function loopsInTree(root: SyntaxNode, source: string, language: Language, line: number, column: number | null): SiteLoop[] {
  const rules = RULES_BY_LANGUAGE.get(language);
  if (!rules) return [];
  const row = line - 1;
  if (row < 0) return [];
  let col = column ?? 0;
  if (column === null) {
    const text = source.split('\n')[row] ?? '';
    const first = text.search(/\S/);
    col = first < 0 ? 0 : first;
  }
  let node: SyntaxNode | null = innermostAt(root, row, col);
  if (!node) return [];
  const found: SiteLoop[] = [];
  while (node) {
    const parent: SyntaxNode | null = node.parent;
    if (!parent || rules.boundaries.has(parent.type)) break;
    if (rules.inlineFunctions.has(parent.type)) {
      const holder = parent.parent?.type ?? '';
      if (rules.bindingParents.has(holder)) break;
      node = parent;
      continue;
    }
    const kind = LOOP_TYPES.get(parent.type);
    // The header, not the body: a site is in the loop only when it is under it.
    if (kind && !isField(parent, 'condition', node) && !isField(parent, 'value', node)) {
      const text = loopHeader(parent);
      if (text) found.push({ text, kind, branch: branchKey(parent) });
    }
    node = parent;
  }
  found.reverse();
  return found;
}

/** Loops for many sites in one file, keyed by {@link siteKey}. */
export async function loopsForFile(absPath: string, language: Language, sites: readonly CallSite[]): Promise<Map<string, SiteLoop[]>> {
  const out = new Map<string, SiteLoop[]>();
  if (!supportsBranchGuards(language) || sites.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const site of sites) {
    const key = siteKey(site);
    if (!out.has(key)) out.set(key, loopsInTree(cached.tree.rootNode, cached.source, language, site.line, site.column ?? null));
  }
  return out;
}

/** A loop's header as written, keyword and braces dropped: `item of items`, `queue.length > 0`. */
function loopHeader(loop: SyntaxNode): string {
  const body = loop.childForFieldName('body') ?? namedChildren(loop).find((c) => BLOCKISH.has(c.type)) ?? null;
  const raw = body && body.startIndex > loop.startIndex ? loop.text.slice(0, body.startIndex - loop.startIndex) : loop.text;
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text.replace(/^(?:for|foreach|while|do|repeat)\b\s*/i, '');
  text = text.replace(/[{:]\s*$/, '').trim();
  const inner = /^\((.*)\)$/s.exec(text);
  if (inner) text = inner[1]!.trim();
  // `const item of items` reads as `item of items`; the binding word is noise here.
  text = text.replace(/^(?:const|let|var|val|final)\s+/, '');
  return cut(text, 60);
}

/**
 * The walk. `line` is 1-based, `column` 0-based (null → first non-blank).
 * Returns the guards outermost first — execution order, the way a reader
 * would list them.
 */
export function guardsInTree(
  root: SyntaxNode,
  source: string,
  language: Language,
  line: number,
  column: number | null
): BranchGuard[] {
  const row = line - 1;
  if (row < 0) return [];
  let col = column ?? 0;
  if (column === null) {
    const text = source.split('\n')[row] ?? '';
    const first = text.search(/\S/);
    col = first < 0 ? 0 : first;
  }
  let node: SyntaxNode | null = innermostAt(root, row, col);
  if (!node) return [];
  const rules = RULES_BY_LANGUAGE.get(language);
  if (!rules) return [];
  const found: BranchGuard[] = [];

  // Innermost → outermost. `found` is reversed at the end, so within one level
  // anything meant to read as OUTER must be pushed LATER.
  while (node) {
    const parent: SyntaxNode | null = node.parent;
    if (!parent || rules.boundaries.has(parent.type)) break;
    if (rules.inlineFunctions.has(parent.type)) {
      const holder = parent.parent?.type ?? '';
      if (rules.bindingParents.has(holder)) break;
      node = parent;
      continue;
    }
    // Anything `enclosing` pushed came from THIS construct, and the arm the
    // site is in is the child the walk came up through: stamp both, unless the
    // rule already named a different branch (a `switch` case's is the switch).
    const before = found.length;
    rules.enclosing(parent, node, found);
    for (let i = before; i < found.length; i++) {
      const g = found[i]!;
      if (!g.branch) g.branch = branchKey(parent);
      const arm = exitKind(node);
      if (arm && !g.armExit) g.armExit = arm;
    }
    if (rules.blocks.has(parent.type)) rules.earlyExits(parent, node, found);
    node = parent;
  }
  found.reverse();
  return found;
}

/**
 * The innermost named node containing (row, col). `descendantForPosition` is
 * the fast path, but some grammars (Swift's `statements`) answer with the
 * container, so the result is refined by descending while a named child still
 * contains the point.
 */
function innermostAt(root: SyntaxNode, row: number, col: number): SyntaxNode | null {
  let node: SyntaxNode | null = root.descendantForPosition({ row, column: col });
  if (!node) return null;
  for (;;) {
    let next: SyntaxNode | null = null;
    const here: SyntaxNode = node;
    for (let i = 0; i < here.namedChildCount; i++) {
      const c: SyntaxNode = here.namedChild(i)!;
      const s = c.startPosition;
      const e = c.endPosition;
      const afterStart = s.row < row || (s.row === row && s.column <= col);
      const beforeEnd = e.row > row || (e.row === row && e.column > col);
      if (afterStart && beforeEnd) {
        next = c;
        break;
      }
    }
    if (!next) return node;
    node = next;
  }
}

// =============================================================================
// Language rules
// =============================================================================

interface Rules {
  /**
   * Node types the walk never climbs past: the function the site belongs to.
   * An INLINE function — an arrow passed as an argument, a closure in an
   * object literal, a trailing closure — is not a boundary: the conditions
   * around its definition are the conditions under which it exists at all,
   * which is what a reader asking "when does this run" wants. A function that
   * is declared, or assigned to a name, starts its own story.
   */
  boundaries: ReadonlySet<string>;
  /** Function-expression types that are boundaries only when named/assigned. */
  inlineFunctions: ReadonlySet<string>;
  /** Parent types under which an inline function counts as named/assigned. */
  bindingParents: ReadonlySet<string>;
  /** Statement containers whose earlier children may be early exits. */
  blocks: ReadonlySet<string>;
  /** `parent` encloses `child` (the node the walk came up through): record any branch. */
  enclosing(parent: SyntaxNode, child: SyntaxNode, out: BranchGuard[]): void;
  /** `child` is a statement of block `parent`: record the exits before it. */
  earlyExits(parent: SyntaxNode, child: SyntaxNode, out: BranchGuard[]): void;
}

function condText(node: SyntaxNode | null | undefined): string {
  if (!node) return '';
  let n: SyntaxNode = node;
  // `(x)` — the parens are the statement's, not the condition's.
  while (n.type === 'parenthesized_expression' && n.namedChildCount === 1) n = n.namedChild(0)!;
  const text = n.text.replace(/\s+/g, ' ').trim();
  // A bare keyword is a grammar's error recovery (`let` from an `if let` it
  // could not parse), never a condition a reader can use.
  if (/^(?:let|var|case|try|await|guard|if|else|some|any)$/.test(text)) return '';
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
}

/**
 * One guard. `branch` names the construct the arm belongs to: by default the
 * node the walk is climbing THROUGH (an `if`, a ternary, a `catch`), which is
 * right whenever the construct is the site's parent — and overridden where it
 * is not, by a `switch` case (whose parent is the case) and by an early exit
 * (whose branch is the `if` that returned, several statements back).
 */
function guard(
  form: GuardForm,
  cond: SyntaxNode | null | undefined,
  negated: boolean,
  text?: string,
  branch?: SyntaxNode | null,
  exit?: GuardExit | null
): BranchGuard | null {
  const t = text ?? condText(cond);
  if (!t) return null;
  return {
    text: t,
    negated,
    form,
    line: (cond ?? null) ? cond!.startPosition.row + 1 : 0,
    branch: branch ? branchKey(branch) : '',
    ...(exit ? { exit } : {}),
  };
}

/** A branching construct's identity: where it starts, `line:column`. */
function branchKey(node: SyntaxNode): string {
  return `${node.startPosition.row + 1}:${node.startPosition.column}`;
}

/**
 * Containers whose LAST statement decides how the whole thing leaves: a block,
 * and the clause wrappers a grammar puts an arm's block inside (`else_clause`,
 * `except_clause`) — the walk climbs through those, so the node it hands back
 * is the wrapper, not the block. A CONDITIONAL wrapper is not one of them: an
 * `elif` whose body raises does not mean the arm it is in always raises.
 */
const BLOCKISH: ReadonlySet<string> = new Set([
  'statement_block',
  'block',
  'statements',
  'function_body',
  'compound_statement',
  'control_structure_body',
  'else_clause',
  'else_statement',
  'catch_clause',
  'catch_block',
  'except_clause',
  'finally_clause',
]);

/**
 * How a statement — or a block, by its last statement — leaves: `throw` for a
 * raised error, `return` for a return / break / continue, `exit` for a
 * language's other way out (Go's `panic`, C's `exit`) that the language rules
 * count as an exit but no keyword names. Null when it does not always leave.
 */
function exitKind(node: SyntaxNode | null | undefined): GuardExit | null {
  if (!node) return null;
  const t = node.type;
  if (t === 'throw_statement' || t === 'raise_statement' || t === 'throw_expression') return 'throw';
  if (/^(?:return|break|continue|goto|yield)_statement$/.test(t)) return 'return';
  // Swift's `control_transfer_statement` and Kotlin's `jump_expression` say
  // which in their first word.
  if (t === 'control_transfer_statement' || t === 'jump_expression') return /^\s*throw\b/.test(node.text) ? 'throw' : 'return';
  if (BLOCKISH.has(t)) return exitKind(lastNamed(node));
  return null;
}

/** {@link exitKind}, or `exit` when the language's rules call it an exit and no keyword names it. */
function exitKindOr(node: SyntaxNode | null | undefined, exits: boolean): GuardExit | null {
  if (!exits) return null;
  return exitKind(node) ?? 'exit';
}

function push(out: BranchGuard[], g: BranchGuard | null): void {
  if (g) out.push(g);
}

function isField(parent: SyntaxNode, field: string, child: SyntaxNode): boolean {
  const f = parent.childForFieldName(field);
  return !!f && f.id === child.id;
}

function lastNamed(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildCount > 0 ? node.namedChild(node.namedChildCount - 1) : null;
}

/** The named children of `parent` that come before `child`, in source order. */
function precedingSiblings(parent: SyntaxNode, child: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < parent.namedChildCount; i++) {
    const s = parent.namedChild(i)!;
    if (s.id === child.id) break;
    out.push(s);
  }
  return out;
}

// ----------------------------------------------------------------------- JS --

const JS_EXITS = new Set(['return_statement', 'throw_statement', 'break_statement', 'continue_statement']);

/** A statement that always leaves the block: an exit, or a block ending in one. */
function jsAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (JS_EXITS.has(node.type)) return true;
  if (node.type === 'statement_block') return jsAlwaysExits(lastNamed(node));
  return false;
}

const JS: Rules = {
  boundaries: new Set([
    'function_declaration',
    'method_definition',
    'generator_function_declaration',
    'class_declaration',
    'class_body',
    'class',
    'program',
  ]),
  inlineFunctions: new Set(['arrow_function', 'function_expression', 'function', 'generator_function']),
  bindingParents: new Set([
    'variable_declarator',
    'assignment_expression',
    'export_statement',
    'public_field_definition',
    'field_definition',
    'lexical_declaration',
  ]),
  blocks: new Set(['statement_block', 'program', 'switch_case', 'switch_default']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('else', cond, true));
        return;
      }
      case 'ternary_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_case':
      case 'switch_default': {
        // `child` is one of the case's body statements (not its value).
        if (parent.type === 'switch_case' && isField(parent, 'value', child)) return;
        const body = parent.parent; // switch_body
        const stmt = body?.parent; // switch_statement
        const subject = condText(stmt?.childForFieldName('value'));
        if (parent.type === 'switch_default') push(out, guard('case', stmt?.childForFieldName('value'), false, subject ? `${subject}: default` : 'default', stmt));
        else {
          const value = condText(parent.childForFieldName('value'));
          push(out, guard('case', parent.childForFieldName('value'), false, subject ? `${subject} === ${value}` : value, stmt));
        }
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      case 'catch_clause':
        if (!isField(parent, 'parameter', child)) push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    // Outer-most last (the list is reversed once at the end): walk the
    // preceding statements backwards so the FIRST guard in the source ends up
    // first in the final order.
    const before = precedingSiblings(parent, child);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i]!;
      if (s.type !== 'if_statement' || s.childForFieldName('alternative')) continue;
      const body = s.childForFieldName('consequence');
      if (!jsAlwaysExits(body)) continue;
      push(out, guard('guard', s.childForFieldName('condition'), true, undefined, s, exitKindOr(body, true)));
    }
  },
};

// -------------------------------------------------------------------- Swift --

function swiftAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.type === 'control_transfer_statement') return true;
  if (node.type === 'statements') return swiftAlwaysExits(lastNamed(node));
  return false;
}

/** For a Swift `if`: is `child` after the `else` keyword? */
function afterElse(parent: SyntaxNode, child: SyntaxNode): boolean {
  let seenElse = false;
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i)!;
    if (c.id === child.id) return seenElse;
    if (c.type === 'else') seenElse = true;
  }
  return false;
}

/** All `condition` fields of a Swift `if`/`guard`, joined — `if let x, y > 0`. */
function swiftConditions(node: SyntaxNode): { node: SyntaxNode | null; text: string } {
  // The grammar labels several tokens of `if let x = y, z > 0` as `condition`
  // (the binding's own pieces included), so the readable text is the SPAN from
  // the first to the last of them, not the pieces joined.
  const parts: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === 'condition') parts.push(node.child(i)!);
  }
  if (parts.length === 0) return { node: null, text: '' };
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const raw = node.text.slice(first.startIndex - node.startIndex, last.endIndex - node.startIndex);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (/^(?:let|var|case|try|await)$/.test(text)) return { node: null, text: '' };
  return { node: first, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text };
}

const SWIFT: Rules = {
  boundaries: new Set([
    'function_declaration',
    'init_declaration',
    'deinit_declaration',
    'class_declaration',
    'protocol_declaration',
    'computed_property',
    'source_file',
  ]),
  inlineFunctions: new Set(['lambda_literal']),
  bindingParents: new Set(['property_declaration', 'assignment']),
  blocks: new Set(['statements', 'function_body']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const c = swiftConditions(parent);
        if (parent.fieldNameForChild(indexOf(parent, child)) === 'condition') return;
        push(out, guard(afterElse(parent, child) ? 'else' : 'if', c.node, afterElse(parent, child), c.text));
        return;
      }
      case 'guard_statement': {
        // Inside the guard's body the condition FAILED.
        if (parent.fieldNameForChild(indexOf(parent, child)) === 'condition') return;
        const c = swiftConditions(parent);
        push(out, guard('else', c.node, true, c.text));
        return;
      }
      case 'ternary_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'if_true', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'if_false', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_entry': {
        const stmt = parent.parent;
        const subject = condText(stmt?.childForFieldName('expr'));
        const pattern = parent.namedChildren.find((n) => n.type === 'switch_pattern');
        if (pattern && pattern.id === child.id) return;
        const isDefault = parent.children.some((n) => n.type === 'default_keyword');
        const value = pattern ? condText(pattern) : '';
        const text = isDefault ? (subject ? `${subject}: default` : 'default') : subject ? `${subject} == ${value}` : value;
        push(out, guard('case', pattern ?? stmt?.childForFieldName('expr'), false, text, stmt));
        return;
      }
      case 'catch_block':
        push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    const before = precedingSiblings(parent, child);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i]!;
      if (s.type === 'guard_statement') {
        const c = swiftConditions(s);
        const body = s.namedChildren.find((n) => n.type === 'statements') ?? null;
        push(out, guard('guard', c.node, false, c.text, s, exitKindOr(body, true)));
      } else if (s.type === 'if_statement' && !s.children.some((n) => n.type === 'else')) {
        const body = s.namedChildren.find((n) => n.type === 'statements') ?? null;
        if (!swiftAlwaysExits(body)) continue;
        const c = swiftConditions(s);
        push(out, guard('guard', c.node, true, c.text, s, exitKindOr(body, true)));
      }
    }
  },
};

function indexOf(parent: SyntaxNode, child: SyntaxNode): number {
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)!.id === child.id) return i;
  return -1;
}

/** The named children of a node, in order. */
function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

/**
 * Shared shape of "an early exit before the site": the preceding statements
 * of the block that are an `if` with no else whose body always leaves.
 */
function guardsBefore(
  parent: SyntaxNode,
  child: SyntaxNode,
  out: BranchGuard[],
  isIf: (s: SyntaxNode) => boolean,
  hasElse: (s: SyntaxNode) => boolean,
  body: (s: SyntaxNode) => SyntaxNode | null,
  alwaysExits: (b: SyntaxNode | null) => boolean,
  condition: (s: SyntaxNode) => { node: SyntaxNode | null; text: string }
): void {
  const before = precedingSiblings(parent, child);
  for (let i = before.length - 1; i >= 0; i--) {
    const s = before[i]!;
    if (!isIf(s) || hasElse(s)) continue;
    const arm = body(s);
    if (!alwaysExits(arm)) continue;
    const c = condition(s);
    push(out, guard('guard', c.node, true, c.text, s, exitKindOr(arm, true)));
  }
}

// ------------------------------------------------------------------- Python --

const PY_EXITS = new Set(['return_statement', 'raise_statement', 'break_statement', 'continue_statement']);

function pyAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (PY_EXITS.has(node.type)) return true;
  if (node.type === 'block') return pyAlwaysExits(lastNamed(node));
  return false;
}

function pyOperator(node: SyntaxNode): string {
  const field = node.childForFieldName('operator');
  if (field) return field.text;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)!;
    if (!c.isNamed && (c.text === 'and' || c.text === 'or')) return c.text;
  }
  return '';
}

const PYTHON: Rules = {
  boundaries: new Set(['function_definition', 'class_definition', 'module']),
  inlineFunctions: new Set(['lambda']),
  bindingParents: new Set(['assignment', 'augmented_assignment']),
  blocks: new Set(['block', 'module']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (child.type === 'elif_clause' || child.type === 'else_clause') {
          // An elif/else arm runs when the `if` and every earlier elif failed.
          push(out, guard('else', cond, true));
          for (const s of precedingSiblings(parent, child)) {
            if (s.type === 'elif_clause') push(out, guard('else', s.childForFieldName('condition'), true));
          }
        }
        return;
      }
      case 'elif_clause': {
        if (isField(parent, 'consequence', child)) push(out, guard('if', parent.childForFieldName('condition'), false));
        return;
      }
      case 'conditional_expression': {
        // `a if cond else b`: children are [a, cond, b].
        const kids = namedChildren(parent);
        if (kids.length < 3) return;
        if (child.id === kids[0]!.id) push(out, guard('ternary', kids[1], false));
        else if (child.id === kids[2]!.id) push(out, guard('ternary', kids[1], true));
        return;
      }
      case 'case_clause': {
        if (isField(parent, 'consequence', child)) {
          const stmt = parent.parent?.parent;
          const subject = condText(stmt?.childForFieldName('subject'));
          const pattern = namedChildren(parent).find((n) => n.type === 'case_pattern');
          const value = pattern ? condText(pattern) : '';
          const isDefault = value === '_' || value === '';
          const text = isDefault ? (subject ? `${subject}: default` : 'default') : subject ? `${subject} == ${value}` : value;
          push(out, guard('case', pattern ?? null, false, text, stmt));
        }
        return;
      }
      case 'boolean_operator': {
        if (!isField(parent, 'right', child)) return;
        const op = pyOperator(parent);
        const left = parent.childForFieldName('left');
        if (op === 'and') push(out, guard('and', left, false));
        else if (op === 'or') push(out, guard('or', left, true));
        return;
      }
      case 'except_clause':
      case 'except_group_clause':
        if (child.type === 'block') push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_statement',
      (s) => namedChildren(s).some((n) => n.type === 'elif_clause' || n.type === 'else_clause'),
      (s) => s.childForFieldName('consequence'),
      pyAlwaysExits,
      (s) => ({ node: s.childForFieldName('condition'), text: condText(s.childForFieldName('condition')) })
    );
  },
};

// --------------------------------------------------------------------- Java --

const JAVA_EXITS = new Set(['return_statement', 'throw_statement', 'break_statement', 'continue_statement', 'yield_statement']);

function javaAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (JAVA_EXITS.has(node.type)) return true;
  if (node.type === 'block') return javaAlwaysExits(lastNamed(node));
  return false;
}

/** `case A:` / `case A ->` / `default` labels of a Java switch group or rule, as one condition text. */
function javaCaseText(labels: SyntaxNode[], subject: string): string {
  const values = labels.map((l) => namedChildren(l).map((n) => condText(n)).filter(Boolean).join(', ')).filter(Boolean);
  if (values.length === 0) return subject ? `${subject}: default` : 'default';
  const value = values.join(', ');
  return subject ? `${subject} == ${value}` : value;
}

const JAVA: Rules = {
  boundaries: new Set([
    'method_declaration',
    'constructor_declaration',
    'class_declaration',
    'class_body',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
    'program',
  ]),
  inlineFunctions: new Set(['lambda_expression']),
  bindingParents: new Set(['variable_declarator', 'assignment_expression', 'field_declaration']),
  blocks: new Set(['block', 'switch_block_statement_group', 'program', 'constructor_body']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('else', cond, true));
        return;
      }
      case 'ternary_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_block_statement_group':
      case 'switch_rule': {
        if (child.type === 'switch_label') return;
        const stmt = parent.parent?.parent;
        const subject = condText(stmt?.childForFieldName('condition'));
        const labels = namedChildren(parent).filter((n) => n.type === 'switch_label');
        push(out, guard('case', labels[0] ?? null, false, javaCaseText(labels, subject), stmt));
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      case 'catch_clause':
        if (isField(parent, 'body', child)) push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_statement',
      (s) => !!s.childForFieldName('alternative'),
      (s) => s.childForFieldName('consequence'),
      javaAlwaysExits,
      (s) => ({ node: s.childForFieldName('condition'), text: condText(s.childForFieldName('condition')) })
    );
  },
};

// ------------------------------------------------------------------- Kotlin --

function ktAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (node.type === 'jump_expression') return true;
  if (node.type === 'control_structure_body' || node.type === 'statements') return ktAlwaysExits(lastNamed(node));
  return false;
}

/** The two arms of a Kotlin `if`: the bodies, in order (then, else). */
function ktArms(ifExpr: SyntaxNode): SyntaxNode[] {
  return namedChildren(ifExpr).filter((n) => n.type === 'control_structure_body');
}

const KOTLIN: Rules = {
  boundaries: new Set([
    'function_declaration',
    'secondary_constructor',
    'class_declaration',
    'class_body',
    'object_declaration',
    'getter',
    'setter',
    'source_file',
  ]),
  inlineFunctions: new Set(['lambda_literal', 'anonymous_function']),
  bindingParents: new Set(['property_declaration', 'assignment']),
  blocks: new Set(['statements', 'function_body', 'source_file']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_expression': {
        const kids = namedChildren(parent);
        const cond = kids[0] ?? null;
        if (cond && child.id === cond.id) return;
        const arms = ktArms(parent);
        if (arms[0] && child.id === arms[0].id) push(out, guard('if', cond, false));
        else if (arms[1] && child.id === arms[1].id) push(out, guard('else', cond, true));
        return;
      }
      case 'when_entry': {
        if (child.type !== 'control_structure_body') return;
        const when = parent.parent;
        const subject = condText(namedChildren(when!).find((n) => n.type === 'when_subject')).replace(/^\((.*)\)$/, '$1');
        const conds = namedChildren(parent).filter((n) => n.type === 'when_condition');
        if (conds.length === 0) push(out, guard('case', null, false, subject ? `${subject}: else` : 'else', when));
        else {
          const value = conds.map((c) => condText(c)).join(', ');
          push(out, guard('case', conds[0]!, false, subject ? `${subject} == ${value}` : value, when));
        }
        return;
      }
      case 'conjunction_expression':
      case 'disjunction_expression': {
        const kids = namedChildren(parent);
        if (kids.length < 2 || child.id !== kids[kids.length - 1]!.id) return;
        const left = kids[0]!;
        if (parent.type === 'conjunction_expression') push(out, guard('and', left, false));
        else push(out, guard('or', left, true));
        return;
      }
      case 'catch_block':
        if (child.type === 'statements') push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_expression',
      (s) => ktArms(s).length > 1,
      (s) => ktArms(s)[0] ?? null,
      ktAlwaysExits,
      (s) => {
        const cond = namedChildren(s)[0] ?? null;
        return { node: cond, text: condText(cond) };
      }
    );
  },
};

// ----------------------------------------------------------------------- C# --

const CS_EXITS = new Set(['return_statement', 'throw_statement', 'break_statement', 'continue_statement']);

function csAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (CS_EXITS.has(node.type)) return true;
  if (node.type === 'block') return csAlwaysExits(lastNamed(node));
  return false;
}

const CSHARP: Rules = {
  boundaries: new Set([
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    'class_declaration',
    'struct_declaration',
    'record_declaration',
    'interface_declaration',
    'declaration_list',
    'property_declaration',
    'accessor_declaration',
    'compilation_unit',
  ]),
  inlineFunctions: new Set(['lambda_expression', 'anonymous_method_expression']),
  bindingParents: new Set(['variable_declarator', 'assignment_expression', 'equals_value_clause']),
  blocks: new Set(['block', 'switch_section', 'compilation_unit']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('else', cond, true));
        return;
      }
      case 'conditional_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'switch_section': {
        const isLabel = (n: SyntaxNode) => /pattern$|switch_label$/.test(n.type);
        if (isLabel(child)) return;
        const stmt = parent.parent?.parent;
        const subject = condText(stmt?.childForFieldName('value'));
        const labels = namedChildren(parent).filter(isLabel);
        const value = labels.map((l) => condText(l)).filter(Boolean).join(', ');
        const text = value === '' ? (subject ? `${subject}: default` : 'default') : subject ? `${subject} == ${value}` : value;
        push(out, guard('case', labels[0] ?? null, false, text, stmt));
        return;
      }
      case 'switch_expression_arm': {
        if (!isField(parent, 'expression', child)) return;
        const stmt = parent.parent;
        const subject = condText(stmt?.childForFieldName('value'));
        const pattern = parent.childForFieldName('pattern');
        const value = condText(pattern);
        const text = value === '_' || value === '' ? (subject ? `${subject}: default` : 'default') : subject ? `${subject} == ${value}` : value;
        push(out, guard('case', pattern, false, text, stmt));
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      case 'catch_clause':
        if (isField(parent, 'body', child)) push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_statement',
      (s) => !!s.childForFieldName('alternative'),
      (s) => s.childForFieldName('consequence'),
      csAlwaysExits,
      (s) => ({ node: s.childForFieldName('condition'), text: condText(s.childForFieldName('condition')) })
    );
  },
};

// ----------------------------------------------------------------------- Go --

const GO_EXITS = new Set(['return_statement', 'break_statement', 'continue_statement', 'goto_statement']);

function goAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (GO_EXITS.has(node.type)) return true;
  if (node.type === 'block') return goAlwaysExits(lastNamed(node));
  if (node.type === 'expression_statement') {
    const call = node.namedChild(0);
    const fn = call?.type === 'call_expression' ? call.childForFieldName('function')?.text : '';
    return fn === 'panic' || fn === 'os.Exit' || fn === 'log.Fatal' || fn === 'log.Fatalf' || fn === 'log.Fatalln';
  }
  return false;
}

const GO: Rules = {
  boundaries: new Set(['function_declaration', 'method_declaration', 'source_file']),
  inlineFunctions: new Set(['func_literal']),
  bindingParents: new Set(['short_var_declaration', 'var_spec', 'assignment_statement', 'const_spec']),
  blocks: new Set(['block', 'expression_case', 'default_case', 'type_case', 'communication_case', 'source_file']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('else', cond, true));
        return;
      }
      case 'expression_case':
      case 'type_case':
      case 'communication_case': {
        const value = parent.childForFieldName('value') ?? parent.childForFieldName('type') ?? parent.childForFieldName('communication');
        if (value && child.id === value.id) return;
        const stmt = parent.parent;
        const subject = condText(stmt?.childForFieldName('value'));
        const v = condText(value);
        if (parent.type === 'communication_case') push(out, guard('case', value, false, v, stmt));
        else push(out, guard('case', value, false, subject ? `${subject} == ${v}` : v, stmt));
        return;
      }
      case 'default_case': {
        const stmt = parent.parent;
        const subject = condText(stmt?.childForFieldName('value'));
        push(out, guard('case', stmt?.childForFieldName('value'), false, subject ? `${subject}: default` : 'default', stmt));
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_statement',
      (s) => !!s.childForFieldName('alternative'),
      (s) => s.childForFieldName('consequence'),
      goAlwaysExits,
      (s) => ({ node: s.childForFieldName('condition'), text: condText(s.childForFieldName('condition')) })
    );
  },
};

// -------------------------------------------------------------------- C/C++ --

const C_EXITS = new Set(['return_statement', 'break_statement', 'continue_statement', 'goto_statement', 'throw_statement']);

function cAlwaysExits(node: SyntaxNode | null): boolean {
  if (!node) return false;
  if (C_EXITS.has(node.type)) return true;
  if (node.type === 'compound_statement') return cAlwaysExits(lastNamed(node));
  if (node.type === 'expression_statement') {
    const call = node.namedChild(0);
    const fn = call?.type === 'call_expression' ? call.childForFieldName('function')?.text : '';
    return fn === 'exit' || fn === '_exit' || fn === 'abort' || fn === 'longjmp';
  }
  return false;
}

const C: Rules = {
  boundaries: new Set([
    'function_definition',
    'class_specifier',
    'struct_specifier',
    'namespace_definition',
    'translation_unit',
    'field_declaration_list',
  ]),
  inlineFunctions: new Set(['lambda_expression']),
  bindingParents: new Set(['init_declarator', 'assignment_expression']),
  blocks: new Set(['compound_statement', 'case_statement', 'translation_unit']),

  enclosing(parent, child, out) {
    switch (parent.type) {
      case 'if_statement': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('if', cond, false));
        else if (isField(parent, 'alternative', child) || child.type === 'else_clause') push(out, guard('else', cond, true));
        return;
      }
      case 'conditional_expression': {
        const cond = parent.childForFieldName('condition');
        if (isField(parent, 'consequence', child)) push(out, guard('ternary', cond, false));
        else if (isField(parent, 'alternative', child)) push(out, guard('ternary', cond, true));
        return;
      }
      case 'case_statement': {
        const value = parent.childForFieldName('value');
        if (value && child.id === value.id) return;
        const stmt = parent.parent?.parent;
        const subject = condText(stmt?.childForFieldName('condition'));
        if (!value) push(out, guard('case', stmt?.childForFieldName('condition'), false, subject ? `${subject}: default` : 'default', stmt));
        else {
          const v = condText(value);
          push(out, guard('case', value, false, subject ? `${subject} == ${v}` : v, stmt));
        }
        return;
      }
      case 'binary_expression': {
        if (!isField(parent, 'right', child)) return;
        const op = parent.childForFieldName('operator')?.text;
        const left = parent.childForFieldName('left');
        if (op === '&&') push(out, guard('and', left, false));
        else if (op === '||') push(out, guard('or', left, true));
        return;
      }
      case 'catch_clause':
        if (isField(parent, 'body', child)) push(out, guard('catch', null, false, 'on error'));
        return;
      default:
        return;
    }
  },

  earlyExits(parent, child, out) {
    guardsBefore(
      parent,
      child,
      out,
      (s) => s.type === 'if_statement',
      (s) => !!s.childForFieldName('alternative') || namedChildren(s).some((n) => n.type === 'else_clause'),
      (s) => s.childForFieldName('consequence'),
      cAlwaysExits,
      (s) => ({ node: s.childForFieldName('condition'), text: condText(s.childForFieldName('condition')) })
    );
  },
};

/** The rules per language. A language absent here yields no guards — never a wrong one. */
const RULES_BY_LANGUAGE: ReadonlyMap<Language, Rules> = new Map<Language, Rules>([
  ['typescript', JS],
  ['tsx', JS],
  ['javascript', JS],
  ['jsx', JS],
  ['swift', SWIFT],
  ['python', PYTHON],
  ['java', JAVA],
  ['kotlin', KOTLIN],
  ['csharp', CSHARP],
  ['go', GO],
  ['c', C],
  ['cpp', C],
  ['objc', C],
]);

// =============================================================================
// Decorators — what is written on a definition
// =============================================================================

/**
 * The decorators / annotations / attributes on the definition at a line, and
 * on the class that holds it: `UseGuards(AuthGuard('jwt'))`,
 * `PreAuthorize("hasRole('ADMIN')")`, `HttpPost("items")`, `Process('email')`.
 * Text as written, without the `@` or the brackets, whitespace collapsed,
 * capped. The index keeps no decorators, so they are read here at request
 * time like the guards.
 */
export interface DefinitionDecorators {
  own: string[];
  /** The enclosing class's, when the definition is a member. */
  class: string[];
}

const DEFINITION_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_definition',
  'method_definition',
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
  'class_definition',
  'decorated_definition',
  'local_function_statement',
  'lexical_declaration',
  'variable_declaration',
  'public_field_definition',
]);
const CLASS_TYPES: ReadonlySet<string> = new Set(['class_declaration', 'class_definition', 'class', 'object_declaration', 'struct_declaration', 'record_declaration']);
const DECORATOR_TYPES: ReadonlySet<string> = new Set(['decorator', 'annotation', 'marker_annotation', 'attribute']);
const MAX_DECORATOR_TEXT = 80;

export async function decoratorsForFile(
  absPath: string,
  language: Language,
  lines: readonly number[]
): Promise<Map<number, DefinitionDecorators>> {
  const out = new Map<number, DefinitionDecorators>();
  if (!supportsBranchGuards(language) || lines.length === 0) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  for (const line of lines) {
    if (out.has(line)) continue;
    const found = decoratorsInTree(cached.tree.rootNode, cached.source, line);
    if (found !== null) out.set(line, found);
  }
  return out;
}

/** {@link decoratorsForFile} over source text — the test surface. */
export async function decoratorsInSource(source: string, language: Language, line: number): Promise<DefinitionDecorators | null> {
  if (!supportsBranchGuards(language)) return null;
  const tree = await parse(source, language);
  if (!tree) return null;
  try {
    return decoratorsInTree(tree.rootNode, source, line);
  } finally {
    tree.delete();
  }
}

export function decoratorsInTree(root: SyntaxNode, source: string, line: number): DefinitionDecorators | null {
  const row = line - 1;
  const col = firstNonBlankColumn(source, row);
  let node: SyntaxNode | null = innermostAt(root, row, col);
  if (!node) return null;
  // Up to the definition the line belongs to.
  let definition: SyntaxNode | null = null;
  for (let up = 0; node && up < 12; up++, node = node.parent) {
    if (DEFINITION_TYPES.has(node.type)) {
      definition = node;
      break;
    }
  }
  if (!definition) return null;
  // A Python decorated function is the child of the node that holds the decorators.
  const holder = definition.parent && definition.parent.type === 'decorated_definition' ? definition.parent : definition;
  const own = decoratorsOn(holder);
  let cls: SyntaxNode | null = holder.parent;
  for (let up = 0; cls && up < 6 && !CLASS_TYPES.has(cls.type); up++) cls = cls.parent;
  const clsHolder = cls && cls.parent && cls.parent.type === 'decorated_definition' ? cls.parent : cls;
  return { own, class: clsHolder ? decoratorsOn(clsHolder) : [] };
}

/** Decorator texts on one definition node: its own leading decorator children, its modifiers/attribute lists, or the siblings before it. */
function decoratorsOn(definition: SyntaxNode): string[] {
  const out: string[] = [];
  const add = (n: SyntaxNode) => {
    if (n.type === 'attribute_list') {
      for (const a of namedChildren(n)) if (a.type === 'attribute') out.push(decoratorText(a));
      return;
    }
    if (DECORATOR_TYPES.has(n.type)) out.push(decoratorText(n));
  };
  for (const c of namedChildren(definition)) {
    if (c.type === 'modifiers') for (const m of namedChildren(c)) add(m);
    else add(c);
  }
  // JS: decorators are siblings that precede the member in the class body.
  if (out.length === 0 && definition.parent) {
    const before = precedingSiblings(definition.parent, definition);
    for (let i = before.length - 1; i >= 0; i--) {
      const s = before[i]!;
      if (s.type !== 'decorator') break;
      out.unshift(decoratorText(s));
    }
  }
  return out;
}

function decoratorText(node: SyntaxNode): string {
  let text = collapse(node.text).replace(/^@\s*/, '');
  if (node.type === 'attribute_list') text = text.replace(/^\[|\]$/g, '');
  return cut(text, MAX_DECORATOR_TEXT);
}


// =============================================================================
// Member types — what a class declares its members to be
// =============================================================================

/**
 * The declared types of a class's members, read from the tree: the
 * constructor's parameter properties (`private readonly usersService:
 * UsersService`), its fields (`private final OwnerRepository owners`,
 * `val owners: OwnerRepository`, `private readonly IRepo _repo`), its typed
 * properties. The index keeps no type for these, and a member call the
 * extractor kept only the last segment of (`this.usersService.findByEmail`
 * → `findByEmail`) resolves by name alone; the declared type is what says
 * where it really goes, and whether it leaves the index.
 *
 * Keyed by member name, the type as written without generics'
 * arguments (`Repository<Cat>` → `Repository<Cat>` is kept whole; callers
 * strip what they need).
 */
export async function memberTypesForFile(absPath: string, language: Language, line: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!supportsBranchGuards(language)) return out;
  const cached = await treeFor(absPath, language);
  if (!cached) return out;
  return memberTypesInTree(cached.tree.rootNode, cached.source, line);
}

/** {@link memberTypesForFile} over source text — the test surface. */
export async function memberTypesInSource(source: string, language: Language, line: number): Promise<Map<string, string>> {
  if (!supportsBranchGuards(language)) return new Map();
  const tree = await parse(source, language);
  if (!tree) return new Map();
  try {
    return memberTypesInTree(tree.rootNode, source, line);
  } finally {
    tree.delete();
  }
}

const CLASS_BODY_TYPES: ReadonlySet<string> = new Set(['class_body', 'declaration_list', 'field_declaration_list']);

export function memberTypesInTree(root: SyntaxNode, source: string, line: number): Map<string, string> {
  const out = new Map<string, string>();
  const row = line - 1;
  let node: SyntaxNode | null = innermostAt(root, row, firstNonBlankColumn(source, row));
  let cls: SyntaxNode | null = null;
  for (let up = 0; node && up < 16; up++, node = node.parent) {
    if (CLASS_TYPES.has(node.type)) {
      cls = node;
      break;
    }
  }
  if (!cls) return out;
  const typeText = (n: SyntaxNode | null | undefined): string => (n ? collapse(n.text).replace(/^:\s*/, '').trim() : '');
  const put = (name: string | null | undefined, type: string) => {
    if (name && type && !out.has(name)) out.set(name, type);
  };
  const visitParams = (params: SyntaxNode | null) => {
    if (!params) return;
    for (const p of namedChildren(params)) {
      // TS: `private readonly x: T` (a parameter property); Kotlin: `val x: T`; C#/Java: `T x` — a field of the same name may follow.
      if (p.type === 'required_parameter' || p.type === 'optional_parameter') {
        if (!namedChildren(p).some((c) => c.type === 'accessibility_modifier' || c.type === 'override_modifier') && !/^\s*(?:public|private|protected|readonly)\b/.test(p.text)) continue;
        put(p.childForFieldName('pattern')?.text, typeText(p.childForFieldName('type')));
      } else if (p.type === 'class_parameter') {
        const kids = namedChildren(p);
        const name = kids.find((c) => c.type === 'simple_identifier');
        const type = kids.find((c) => c.type === 'user_type' || c.type === 'nullable_type');
        if (kids.some((c) => c.type === 'binding_pattern_kind')) put(name?.text, typeText(type));
      } else if (p.type === 'parameter' || p.type === 'formal_parameter') {
        put(p.childForFieldName('name')?.text, typeText(p.childForFieldName('type')));
      }
    }
  };
  // Kotlin's primary constructor sits on the class node itself.
  for (const c of namedChildren(cls)) if (c.type === 'primary_constructor') visitParams(namedChildren(c).find((n) => n.type === 'class_parameters') ?? c);
  const body = namedChildren(cls).find((c) => CLASS_BODY_TYPES.has(c.type)) ?? cls.childForFieldName('body');
  if (!body) return out;
  for (const m of namedChildren(body)) {
    switch (m.type) {
      case 'public_field_definition':
      case 'field_definition':
        put(m.childForFieldName('name')?.text, typeText(m.childForFieldName('type')));
        break;
      case 'method_definition':
        if (m.childForFieldName('name')?.text === 'constructor') visitParams(m.childForFieldName('parameters'));
        break;
      case 'field_declaration': {
        // Java: `type` + `declarator`; C#: a `variable_declaration` inside.
        const type = m.childForFieldName('type');
        if (type) {
          for (const d of namedChildren(m)) if (d.type === 'variable_declarator') put(d.childForFieldName('name')?.text, typeText(type));
        } else {
          const decl = namedChildren(m).find((c) => c.type === 'variable_declaration');
          const t = decl?.childForFieldName('type');
          for (const d of decl ? namedChildren(decl) : []) if (d.type === 'variable_declarator') put(d.childForFieldName('name')?.text, typeText(t));
        }
        break;
      }
      case 'property_declaration': {
        // C#: `type` + `name`; Kotlin: `variable_declaration (name) (type)`.
        const csType = m.childForFieldName('type');
        if (csType) put(m.childForFieldName('name')?.text, typeText(csType));
        else {
          const decl = namedChildren(m).find((c) => c.type === 'variable_declaration');
          const kids = decl ? namedChildren(decl) : [];
          const name = kids.find((c) => c.type === 'simple_identifier');
          const type = kids.find((c) => c.type === 'user_type' || c.type === 'nullable_type');
          put(name?.text, typeText(type));
        }
        break;
      }
      case 'constructor_declaration':
        visitParams(m.childForFieldName('parameters'));
        break;
      default:
        break;
    }
  }
  return out;
}
