/**
 * C/C++ function-pointer dispatch synthesis (#932).
 *
 * C/C++ polymorphism is the function pointer: a struct carries a fn-pointer
 * field (`int (*fn)(int)`, or a fn-pointer-typedef field `hook_func func`),
 * concrete functions are *registered* into it through a table
 * (`static struct cmd cmds[] = {{"add", cmd_add}, …}`, a designated
 * `.fn = cmd_add`, or `x->fn = cmd_add`), and the dispatcher calls through it
 * indirectly (`p->fn(argv)`). Static extraction captures neither the
 * registration→field binding nor the indirect call, so the dispatcher→handler
 * edge is missing and `git`'s `run_builtin` looks like it calls nothing, the
 * hooks in `hook_demo.c` are unreachable, etc.
 *
 * This bridges it, keyed by **(struct type, fn-pointer field)**:
 *   • registrations — a function bound to `S.field` via a positional
 *     initializer (matched by field index), a designated `.field = fn`, or a
 *     direct `x.field = fn` / `x->field = fn` assignment;
 *   • dispatch — `recv->field(…)` / `recv.field(…)` where `recv` resolves to a
 *     value of struct type `S` (from the enclosing function's params / locals,
 *     or by walking a chained/array receiver `c->cmd->proc` across field types),
 *     falling back to the field name when it is unique to one struct;
 *   • field←field propagation — `a->f = b->g` merges `B.g`'s handlers into
 *     `A.f`, so a generic single-slot hook that is reassigned from a registry
 *     (the `hook_demo.c` shape: `h->func = found->fn`) still resolves.
 *
 * Also handles **macro-built tables** (#991) — the dominant real-world shape,
 * e.g. redis' command table, sqlite's builtin functions, and vim's `:ex` /
 * normal-mode commands. The fn-pointer arg lives inside a macro call
 * (`MAKE_CMD(…,proc,…)` / `FUNCTION(…,xFunc)` / `EXCMD(…,fn,…)`) in a generated
 * or `#include`-d file; the table's struct type may itself be an object-macro
 * alias; the field may use a function-TYPE typedef; the struct may be defined
 * INLINE with the array; and the whole thing may sit behind `#ifdef` switched on
 * by the includer. The registration pass reads each `#include`-d file as a unit
 * with the includer's effective macro env (own + headers) in scope, evaluates
 * its `#ifdef`s against the includer's defined set, expands object/function
 * macros, peels a brace-wrapped element, and parses an inline struct in place —
 * then reads the positional/designated bindings. Dispatch additionally resolves
 * an array subscript through a file-scope table (`(cmdnames[i].cmd_func)(…)`).
 *
 * Also bridges **bare arrays of function pointers** (no struct, no field) —
 * `opcode_t *opcodes[256] = {nop,…}` dispatched `opcodes[op](…)` (SameBoy's CPU),
 * `zend_rc_dtor_func_t t[] = {[IS_STRING]=(cast)fn,…}` dispatched `t[GC_TYPE(p)](…)`
 * (php's Zend) — keyed by the array VARIABLE name. The element type must be a
 * function typedef (the precision gate), entries are literal function names, and
 * the same-file table wins on a name collision (two file-local `opcodes[256]`).
 *
 * Whole-graph pass after base resolution; all edges are `provenance:'heuristic'`
 * (`synthesizedBy:'fn-pointer-dispatch'`). High precision via the (type, field)
 * key + a real-function gate; a project with no fn-pointer dispatch is a no-op.
 *
 * ## Fuse-then-link architecture (§7a.8, task #5 step 1)
 *
 * The pass used to sweep every file's text FOUR times (typedefs, registrations,
 * propagation, dispatch), and on the Linux kernel the all-or-nothing source
 * cache declines, so each sweep re-read + re-stripped the whole corpus — 4.4
 * strips/file, ~78s of the ~230s kernel-scale wall (§7a.8 calibration). It now
 * runs as ONE extraction sweep plus filtered linking stages:
 *
 *   1. **Extraction sweep** — reads + strips each file ONCE and collects, per
 *      file: typedef names, each struct node's field declarations (parsed
 *      structurally, fn-pointer classification deferred — the typedef sets
 *      aren't complete mid-sweep), the resolved local includes, and cheap
 *      SURVIVAL FILTERS for the later stages (distinct initializer type
 *      tokens, array element types, inline-struct summaries, field-assignment
 *      field pairs, dispatch field / array names — all interned, a few MB even
 *      on the kernel).
 *   2. **Struct-layout linking** — classifies the deferred fields against the
 *      now-complete typedef sets and registers layouts by replaying the struct
 *      kind-scan, so registration order (which decides same-name layout
 *      precedence) is byte-identical to the old dedicated pass.
 *   3. **Registration / propagation / dispatch** — the original pass bodies,
 *      UNCHANGED, but each file is first checked against its survival filter
 *      and only surviving files are re-stripped (LRU-served). The filters only
 *      ever over-approximate: a filtered-out file is one where every match
 *      would have failed the pass's own gates before any side effect, so
 *      skipping it cannot change the edge set. On the kernel only ~16% of
 *      files have any dispatch-shaped match at all, so the lazy re-strips are
 *      a fraction of a sweep and total strip work drops ~4.4× → ~1.5×.
 *
 * The extraction sweep is also the step-2 boundary: a native per-file extractor
 * can replace the sweep's scans without touching the linking stages.
 */
import * as path from 'node:path';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { memoryBudgetBytes } from './memory-budget';
import { LRUCache } from './lru-cache';
import { stripCommentsForRegex } from './strip-comments';
import { getKernel } from '../extraction/kernel/loader';
import type { CfnptrFactsOut, CfnptrFileIn } from '../extraction/kernel/loader';

const C_CPP_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|cppm|ipp|inl|tcc)$/i;
const FN_KINDS = new Set(['function', 'method']);
const FANOUT_CAP = 300; // a real command table (git ~150) is legitimate fan-out; this only stops pathological cases.

/** A struct field, in declaration order, flagged when it is a function pointer. */
interface FieldInfo {
  name: string;
  index: number;
  isFnPtr: boolean;
  /** The field's declared type token (e.g. `redisCommand` for `struct redisCommand *cmd`),
   *  used to walk a chained receiver `c->cmd->proc`. Empty for fn-pointer fields. */
  type: string;
}

/** A struct field as parsed during the extraction sweep: structure only. The
 *  `(*name)(…)` pointer syntax is a local fact (`ptr`), but a typedef-typed
 *  field's fn-pointer-ness depends on the GLOBAL typedef sets, which aren't
 *  complete until the sweep ends — so classification into `FieldInfo.isFnPtr`
 *  is deferred to the linking stage. */
interface RawFieldDecl {
  name: string | null;
  index: number;
  ptr: boolean;
  type: string;
}

/** Slice a node's body from a pre-split line array — the per-file sweeps
 *  call this once per NODE, and splitting the whole file per node was an
 *  O(nodes × file-size) term (~1.6M full-file splits on the Linux tree,
 *  §7a.3 cFnPtr round). Split once per file, slice many times. */
function sliceLinesPre(lines: string[], startLine?: number, endLine?: number): string {
  if (!startLine) return '';
  return lines.slice(startLine - 1, endLine ?? startLine).join('\n');
}

/** Index of the `}` matching the `{` at `open` (which must point at a `{`). -1 if unbalanced. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `body` on `sep` at brace/paren/bracket depth 0 (commas inside `{…}` / `(…)` stay together). */
function splitTopLevel(body: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** Index of the `)` matching the `(` at `open` (which must point at a `(`). -1 if unbalanced. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A function-like macro: `#define NAME(p0,p1,…) expansion`. */
interface MacroDef {
  params: string[];
  expansion: string;
}

/**
 * Collect function-like macros from (comment-stripped) source, joining
 * `\`-continuations first. Only object/positional table macros matter here, so
 * variadic macros are skipped. Used to expand registration tables built through
 * a macro (redis' `MAKE_CMD(…)`) before reading the struct-field bindings.
 */
function parseFunctionMacros(stripped: string): Map<string, MacroDef> {
  const out = new Map<string, MacroDef>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const joined = stripped.replace(/\\\r?\n/g, ' ');
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)\(([^)]*)\)\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(joined))) {
    const params = m[2]!.split(',').map((p) => p.trim()).filter(Boolean);
    if (params.some((p) => p === '...' || p.endsWith('...'))) continue; // variadic — skip
    out.set(m[1]!, { params, expansion: m[3]!.trim() });
  }
  return out;
}

/**
 * Collect object-like macros `#define NAME value` (NAME not immediately followed
 * by `(`). redis aliases the table's struct type this way:
 * `#define COMMAND_STRUCT redisCommand`, used as `struct COMMAND_STRUCT table[]`.
 */
function parseObjectMacros(stripped: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const joined = stripped.replace(/\\\r?\n/g, ' ');
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(\S[^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(joined))) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** All macro names a file `#define`s (value-ful or not) — the "defined" set for #ifdef. */
function parseDefinedNames(stripped: string): Set<string> {
  const out = new Set<string>();
  if (!stripped.includes('#define') && !stripped.includes('# define')) return out;
  const RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(stripped))) out.add(m[1]!);
  return out;
}

/**
 * Drop the inactive arms of `#ifdef`/`#ifndef`/`#if defined(X)`/`#else`/`#elif`/
 * `#endif` given a set of defined macro names, keeping line offsets (inactive
 * lines are blanked, not removed). A conditional whose expression we can't
 * evaluate (`#if SOME_EXPR`) keeps its body — better to over-keep than to drop
 * live code. This is what makes a header included with a switch macro defined
 * (vim's `ex_cmds.h` under `DO_DECLARE_EXCMD`) expose only its active table.
 */
function evalConditionals(text: string, defined: Set<string>): string {
  if (!/#\s*if/.test(text)) return text;
  const lines = text.split('\n');
  // stack frame: parentActive = enclosing kept?; active = this arm kept?; taken = any arm taken yet
  const stack: { parentActive: boolean; active: boolean; taken: boolean }[] = [];
  const activeNow = (): boolean => (stack.length === 0 ? true : stack[stack.length - 1]!.active);
  const condDefined = (expr: string): boolean | null => {
    let mm = expr.match(/^defined\s*\(?\s*(\w+)\s*\)?$/);
    if (mm) return defined.has(mm[1]!);
    mm = expr.match(/^!\s*defined\s*\(?\s*(\w+)\s*\)?$/);
    if (mm) return !defined.has(mm[1]!);
    return null; // unevaluable
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    let mm: RegExpMatchArray | null;
    if ((mm = t.match(/^#\s*ifdef\s+(\w+)/))) {
      const pa = activeNow();
      const cond = defined.has(mm[1]!);
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if ((mm = t.match(/^#\s*ifndef\s+(\w+)/))) {
      const pa = activeNow();
      const cond = !defined.has(mm[1]!);
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if ((mm = t.match(/^#\s*if\s+(.+)$/))) {
      const pa = activeNow();
      const c = condDefined(mm[1]!.trim());
      const cond = c === null ? true : c; // unevaluable → keep
      stack.push({ parentActive: pa, active: pa && cond, taken: cond });
      lines[i] = '';
      continue;
    }
    if (/^#\s*elif\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top) { top.active = top.parentActive && !top.taken; top.taken = true; }
      lines[i] = '';
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top) { top.active = top.parentActive && !top.taken; top.taken = true; }
      lines[i] = '';
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      stack.pop();
      lines[i] = '';
      continue;
    }
    if (!activeNow()) lines[i] = ''; // blank an inactive line (keep the newline)
  }
  return lines.join('\n');
}

/** Resolve a type token through object-like macro aliases (transitive, capped). */
function resolveTypeName(name: string, objEnv: Map<string, string> | undefined): string {
  let n = name;
  for (let i = 0; objEnv && i < 5; i++) {
    const v = objEnv.get(n);
    const t = v?.trim().match(/^(?:struct\s+)?(\w+)$/);
    if (!t) break;
    n = t[1]!;
  }
  return n;
}

/** Substitute call args for the macro's params (whole-token) in its expansion. */
function substituteMacro(def: MacroDef, args: string[]): string {
  const map = new Map<string, string>();
  def.params.forEach((p, i) => map.set(p, args[i] ?? ''));
  return def.expansion.replace(/\b\w+\b/g, (tok) => (map.has(tok) ? map.get(tok)! : tok));
}

/**
 * Expand known function-like macro calls in `text` to a fixpoint (depth-capped).
 * `MAKE_CMD("get",…,getCommand,…)` → the positional value list whose slots line
 * up with the struct's fields, so the existing positional registration can read
 * `getCommand` straight out of the `proc` slot.
 */
function expandMacroCalls(text: string, env: Map<string, MacroDef>): string {
  if (env.size === 0) return text;
  let out = text;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const RE = /\b(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(out))) {
      const def = env.get(m[1]!);
      if (!def) continue;
      const open = m.index + m[0].length - 1; // index of the `(`
      const close = matchParen(out, open);
      if (close < 0) continue;
      const args = splitTopLevel(out.slice(open + 1, close), ',').map((a) => a.trim());
      out = out.slice(0, m.index) + substituteMacro(def, args) + out.slice(close + 1);
      changed = true;
      break; // restart scan — offsets shifted
    }
    if (!changed) break;
  }
  return out;
}

/** A fn-pointer field looks like `… (*name)(…)` — capture `name`. A
 *  calling-convention / attribute macro may precede the `*`
 *  (`(ZEND_FASTCALL *name)`), so allow leading word tokens. */
const FNPTR_DECL_RE = /\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/;
/** `typedef RET (*NAME)(…)` — a function-pointer typedef (CC/attr macro before
 *  the `*` allowed, as in php's `typedef void (ZEND_FASTCALL *fn_t)(…)`). */
const FNPTR_TYPEDEF_RE = /\btypedef\b[^;{}]*?\(\s*(?:\w+\s+)*\*\s*(\w+)\s*\)\s*\(/g;
/** A whole brace-free `typedef … ;` statement — capture the guts to spot the
 *  function-TYPE form `typedef RET NAME(params)` (no `(*name)` pointer form). */
const FNTYPE_TYPEDEF_STMT_RE = /\btypedef\b([^;{}]*);/g;
/** Return-type keywords that must never be mistaken for the typedef's name. */
const C_TYPE_KEYWORDS = new Set([
  'void', 'int', 'char', 'short', 'long', 'unsigned', 'signed', 'float', 'double',
  'const', 'struct', 'union', 'enum', 'static', 'volatile', 'register', 'inline',
]);
/** `#include "local/header"` — captured from RAW source (string contents survive). */
const INCLUDE_RE = /#[ \t]*include[ \t]+"([^"\n]+)"/g;
/** Included files worth scanning for registration tables (e.g. a generated `.def`). */
const INCLUDABLE_EXT = /\.(def|inc|h|hh|hpp|hxx|c|cc|cpp|cxx|ipp|tcc|tbl)$/i;

/** `#define NAME single_identifier` (possibly `struct`-prefixed) — an
 *  object-macro that COULD alias a struct type name (`resolveTypeName`'s exact
 *  value shape). The extraction sweep collects every such NAME into a global
 *  set: an initializer type token that direct-misses the struct layouts still
 *  survives the registration filter when it is alias-SHAPED anywhere, so the
 *  per-file macro-env alias resolution (redis' `COMMAND_STRUCT`) keeps working
 *  without retaining per-file object-macro tables (6.1M `#define`s on the
 *  Linux tree — the amdgpu register headers — rule that out). Numeric values
 *  are excluded: `resolveTypeName` would rewrite to a dead-end token that can
 *  never name a struct, so skipping them is exact, and it drops the register
 *  flood. */
const OBJ_ALIAS_RE = /^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(?:struct[ \t]+)*[A-Za-z_]\w*[ \t\r]*$/gm;

/** `(?:struct )?TYPE name[opt] = {` initializers, where TYPE is a struct that
 *  has ≥1 fn-pointer field. Handles both single (`= {…}`) and array
 *  (`[] = { {…}, {…} }`) forms. Macro calls inside an element are expanded first. */
const INIT_RE =
  /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(?:struct\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*=\s*\{/g;
/** `struct TAG { … } var[opt] [= {…}]` — the struct is defined INLINE with the
 *  table (vim's `cmdname`/`nv_cmd`); its layout never became a node, so parse it
 *  here and register it before reading the entries. No leading anchor: a
 *  `struct TAG {` with a brace body is always a definition (it may be preceded
 *  by a `#define …` line ending in a digit, as in vim), and the trailing
 *  `var … = {` check below is what distinguishes a TABLE from a plain type. */
const INLINE_STRUCT_RE = /\bstruct\s+(\w+)\s*\{/g;
/** `(?:static …)* ELEMTYPE [*] name[…] = { … }` — a bare array of function
 *  pointers (no struct wrapper). The optional `*` covers a function-TYPE
 *  typedef element (`opcode_t *opcodes[]`); a function-pointer typedef element
 *  (`zend_rc_dtor_func_t t[]`) needs none. The typedef-set membership gate
 *  is what separates this from a plain data/struct array. */
const ARRAY_TABLE_RE =
  /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(\w+)\s+(\*\s*)?(\w+)\s*\[[^\]]*\]\s*=\s*\{/g;
/** Dispatch sites: `base->…->field(` or `base.…field(` where `field` is a known
 *  fn-pointer field. The base may be a chain (`c->cmd->proc`) or carry array
 *  subscripts (`cmdnames[i].cmd_func`). An optional `)` before the call covers
 *  the parenthesized form `(cmdnames[i].cmd_func)(&ea)` vim uses. */
const DISPATCH_RE = /((?:\w+(?:\s*\[[^\][]*\])?\s*(?:->|\.)\s*)+)(\w+)\s*\)?\s*\(/g;
/** Bare-array dispatch: `tbl[i](…)` or the explicit-deref `(*tbl[i])(…)`. The
 *  subscript may itself contain a call (`tbl[GC_TYPE(p)](…)`), so the index
 *  class excludes only brackets. Precision comes from the `arrayReg` gate —
 *  this fires only when `tbl` is a known fn-pointer array. */
const ARRAY_DISPATCH_RE = /(?:\(\s*\*\s*)?\b(\w+)\s*\[[^\][]*\]\s*\)?\s*\(/g;
/** Field←field propagation sites: `a->f = b->g`. */
const FIELD_ASSIGN_RE = /(\w+)\s*(?:->|\.)\s*(\w+)\s*=\s*(\w+)\s*(?:->|\.)\s*(\w+)/g;

/** Per-file facts the extraction sweep leaves behind for the linking stages.
 *  Everything here is a SURVIVAL FILTER (over-approximate by construction —
 *  collected with full-file, no-skip scans that match a superset of what the
 *  original pass bodies can act on) except `includes`, which is exact. */
interface FileFacts {
  /** Distinct `INIT_RE` type tokens (registration filter). */
  initTokens: string[] | null;
  /** Distinct `ARRAY_TABLE_RE` element types, `*`-prefixed when the decl has
   *  the pointer star (registration filter). */
  arrayElems: string[] | null;
  /** Any inline-struct candidate with a `(*name)(…)` field (registration filter). */
  inlinePtr: boolean;
  /** Field type tokens across inline-struct candidates (registration filter —
   *  fn-pointer-ness via typedef is only decidable once the sweep completes). */
  inlineTypes: string[] | null;
  /** Distinct `FIELD_ASSIGN_RE` `lfield\0rfield` pairs (propagation filter). */
  dPairs: string[] | null;
  /** Distinct `DISPATCH_RE` field names (dispatch filter). */
  dispatchFields: string[] | null;
  /** Distinct `ARRAY_DISPATCH_RE` array names (dispatch filter). */
  arrayDispatchNames: string[] | null;
  /** Resolved local `#include` targets, in source order (exact, from raw text). */
  includes: string[];
}

const NO_INCLUDES: string[] = [];

export async function cFnPointerDispatchEdges(
  _queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
  onFraction?: (fraction: number) => void
): Promise<Edge[]> {
  let scannedFiles = 0;
  const files = ctx.getAllFiles().filter((f) => C_CPP_EXT.test(f));
  if (files.length === 0) return [];

  // CODEGRAPH_SYNTH_TIMINGS sub-attribution: this pass is 86% of kernel-scale
  // synthesis (306s, §7a.2/§7a.3) — per-stage walls + read/strip accounting
  // name which stage and which cost class owns it. Post-refactor mapping:
  // A = extraction sweep, B = struct-layout linking, C = registration,
  // D = propagation, E = dispatch.
  const prof = process.env.CODEGRAPH_SYNTH_TIMINGS
    ? { A: 0, B: 0, C: 0, D: 0, E: 0, readMs: 0, readN: 0, stripMs: 0, stripN: 0, nodesMs: 0, nodesN: 0 }
    : null;

  // Within-pass progress: this is the pass that parks the "Linking dynamic
  // dispatch" bar on C-heavy repos, so it reports a real fraction of its
  // dominant work. `files` is swept once per stage loop below (extraction,
  // registration, propagation, dispatch), reported at the same per-16-files
  // cadence as the cooperative yield.
  const FILE_SWEEPS = 4;
  const tick = async (): Promise<void> => {
    if ((++scannedFiles & 15) === 0) {
      onFraction?.(scannedFiles / (files.length * FILE_SWEEPS));
      await onYield();
    }
  };

  // Cache raw + stripped source per file, LRU-BOUNDED. The old unbounded Maps
  // retained every C/C++ file's raw AND stripped text for the whole pass —
  // multiple GB on the Linux kernel, one of the two OOM culprits in #1212.
  // The extraction sweep reads sequentially; the linking stages re-request
  // only surviving files (plus include units), so access is near-sequential
  // and a small LRU hits; a miss just re-reads + re-strips.
  // Cache sizing is memory-budget-aware AND all-or-nothing (§7a.3 cFnPtr
  // round): a partial LRU is WORSE than useless for cyclic sweeps (a first
  // attempt sized ~61k against 63.8k files thrashed to a ~0% cross-sweep hit
  // rate). Hold every stripped file (~24KB each measured on the Linux tree)
  // only when 40% of the live memory budget covers it; otherwise keep the
  // within-stage-locality 128. When the big cache declines (the kernel), the
  // survival filters keep the linking stages' re-strips to a fraction of a
  // sweep. Slack over files.length: non-indexed includes (.def/.inc, generated
  // headers) join the working set mid-pass. Pass-scoped transient, freed on
  // return.
  const fullCacheCap = Math.ceil(files.length * 1.05) + 512;
  const cacheCap = memoryBudgetBytes() * 0.5 >= fullCacheCap * 24_576 ? fullCacheCap : 128;
  const rawCache = new LRUCache<string, string | null>(Math.min(cacheCap, 4096));
  const raw = (file: string): string | null => {
    if (rawCache.has(file)) return rawCache.get(file)!;
    const t0 = prof ? Date.now() : 0;
    const r = ctx.readFile(file);
    if (prof) { prof.readMs += Date.now() - t0; prof.readN++; }
    rawCache.set(file, r);
    return r;
  };
  const srcCache = new LRUCache<string, string>(cacheCap);
  const src = (file: string): string | null => {
    // A cached '' (empty or unreadable file) returns '' where the miss path
    // returns null for unreadable — every caller falsy-checks, so the two are
    // interchangeable.
    const hit = srcCache.get(file);
    if (hit !== undefined) return hit;
    const r = raw(file);
    const t0 = prof ? Date.now() : 0;
    const s = r == null ? '' : stripCommentsForRegex(r, 'c');
    if (prof) { prof.stripMs += Date.now() - t0; prof.stripN++; }
    srcCache.set(file, s);
    return r == null ? null : s;
  };

  // Resolve a quoted include relative to the includer's directory, then the
  // project root. Returns a project-root-relative path that exists on disk
  // (even if it was never indexed — e.g. redis' generated `commands.def`).
  const resolveInclude = (includer: string, inc: string): string | null => {
    const dir = path.posix.dirname(includer.replace(/\\/g, '/'));
    const cand = path.posix.normalize(path.posix.join(dir, inc));
    if (ctx.fileExists(cand)) return cand;
    if (ctx.fileExists(inc)) return inc;
    return null;
  };

  // Retained strings are interned through here. Regex captures off a big file
  // string are V8 sliced strings — retaining one pins the whole parent file
  // text, and the facts tables retain captures from EVERY file for the whole
  // pass. The Buffer round-trip forces a flat copy on first sight; repeats
  // (field names recur heavily) then share the one flat instance.
  const interned = new Map<string, string>();
  const intern = (x: string): string => {
    let f = interned.get(x);
    if (f === undefined) {
      f = Buffer.from(x, 'utf8').toString('utf8');
      interned.set(f, f);
    }
    return f;
  };

  // ---- Global tables the extraction sweep fills ----
  //   fn-pointer:  typedef RET (*NAME)(…)        → a field `NAME f` is a fn ptr
  //   fn-type:     typedef RET NAME(params)       → a field `NAME *f` is a fn ptr
  // The fn-type form is redis' command idiom: `typedef void redisCommandProc(client*)`
  // declared as `redisCommandProc *proc;`. Without this, `proc` reads as data.
  const fnPtrTypedefs = new Set<string>();
  const fnTypeTypedefs = new Set<string>();
  /** Struct node id → its structurally-parsed fields (classified + registered
   *  in the linking stage, in kind-scan order). */
  const rawFieldsByNode = new Map<string, RawFieldDecl[]>();
  const factsByFile = new Map<string, FileFacts>();
  /** Every inline-struct candidate tag anywhere — an over-approximation of the
   *  tags the registration stage can add to `structLayout` mid-stage, folded
   *  into the registration filter's layout check. */
  const inlineTags = new Set<string>();
  /** Object-macro names with an alias-shaped value anywhere (see OBJ_ALIAS_RE). */
  const aliasNames = new Set<string>();

  // Parse a struct body (the text between its `{` and `}`) into ordered fields,
  // structure only — see RawFieldDecl for why classification is deferred.
  const parseStructFieldsRaw = (inner: string): RawFieldDecl[] => {
    const fields: RawFieldDecl[] = [];
    let idx = 0;
    for (const rawDecl of splitTopLevel(inner, ';')) {
      const decl = rawDecl.trim();
      if (!decl) continue;
      // A field decl can declare several names sharing a leading type:
      // `struct redisCommand *cmd, *lastcmd;`. Each declarator is its own
      // positional slot and carries that type (so `client.cmd → redisCommand`).
      const parts = splitTopLevel(decl, ',');
      const firstTyped = parts[0]!.match(/(\w+)\s+\**\s*(\w+)\s*$/);
      const sharedType = firstTyped ? firstTyped[1]! : '';
      for (let pi = 0; pi < parts.length; pi++) {
        const p = parts[pi]!.trim();
        let name: string | null = null;
        let type = '';
        let ptr = false;
        const pm = p.match(FNPTR_DECL_RE);
        if (pm) {
          name = pm[1]!; // `… (*name)(…)` — a function pointer
          ptr = true;
        } else if (pi === 0) {
          if (firstTyped) { name = firstTyped[2]!; type = sharedType; }
        } else {
          // a subsequent declarator: `*name` / `**name` / `name`
          const dm = p.match(/^\**\s*(\w+)/);
          if (dm) { name = dm[1]!; type = sharedType; }
        }
        // Always advance the positional index. An unparsed field (anonymous
        // union, exotic declarator) still occupies one slot, and macro-expanded
        // positional tables (redis' MAKE_CMD) only align if every field counts.
        fields.push({ name, index: idx, ptr, type });
        idx++;
      }
    }
    return fields;
  };

  // Classify deferred fields against the (now-complete) typedef sets.
  const classifyFields = (rawFields: RawFieldDecl[]): FieldInfo[] =>
    rawFields.map((f) => ({
      name: f.name ?? '',
      index: f.index,
      isFnPtr:
        !!f.name &&
        (f.ptr || (!!f.type && (fnPtrTypedefs.has(f.type) || fnTypeTypedefs.has(f.type)))),
      type: f.type,
    }));
  const parseStructFields = (inner: string): FieldInfo[] => classifyFields(parseStructFieldsRaw(inner));

  // Exact per-file include resolution (from RAW source — string contents survive).
  const scanIncludes = (file: string): string[] => {
    const rawText = raw(file);
    if (!rawText || !rawText.includes('include')) return NO_INCLUDES;
    const out: string[] = [];
    INCLUDE_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = INCLUDE_RE.exec(rawText))) {
      if (!INCLUDABLE_EXT.test(im[1]!)) continue;
      const t = resolveInclude(file, im[1]!);
      if (t) out.push(intern(t));
    }
    return out.length ? out : NO_INCLUDES;
  };
  // Indexed files answer from their facts; non-indexed includes (reached by
  // buildEnv's depth-2 recursion) fall back to a bounded lazy scan.
  const includeCache = new LRUCache<string, string[]>(1024);
  const localIncludesOf = (file: string): string[] => {
    const f = factsByFile.get(file);
    if (f) return f.includes;
    let out = includeCache.get(file);
    if (out) return out;
    out = scanIncludes(file);
    includeCache.set(file, out);
    return out;
  };

  // ---- Stage A: the extraction sweep — ONE read + strip per file ----
  //
  // Two implementations, record-identical by the differential suite:
  //   • native (task #5 step 2): the kernel's `cfnptrScanFiles` strips and
  //     scans a BATCH of files per NAPI call (codegraph-kernel/src/cfnptr.rs —
  //     hand-rolled byte machines replicating the JS regex semantics), and the
  //     TS side only reads files, ships batches, and interns the returned
  //     facts. Include-path resolution stays here (it needs the filesystem).
  //   • JS: the original sweep, kept verbatim — the fallback for platforms
  //     without a kernel binary, older binaries (feature detection), the
  //     CODEGRAPH_KERNEL=0 kill switch, and CODEGRAPH_KERNEL_CFNPTR=0 (this
  //     scanner's own switch).
  const kernel =
    process.env.CODEGRAPH_KERNEL === '0' || process.env.CODEGRAPH_KERNEL_CFNPTR === '0'
      ? null
      : getKernel();
  const nativeSweep =
    kernel && typeof kernel.cfnptrScanFiles === 'function' ? kernel.cfnptrScanFiles.bind(kernel) : null;

  const mergeNativeFacts = (file: string, out: CfnptrFactsOut): void => {
    for (const t of out.fnPtrTypedefs) fnPtrTypedefs.add(intern(t));
    for (const t of out.fnTypeTypedefs) fnTypeTypedefs.add(intern(t));
    for (const so of out.structs) {
      if (!so.parsed) continue; // body never parsed — the JS sweep records nothing either
      rawFieldsByNode.set(
        so.id,
        so.fields.map((f) => ({ name: f.name || null, index: f.index, ptr: f.ptr, type: f.type }))
      );
    }
    for (const t of out.inlineTags) inlineTags.add(intern(t));
    for (const t of out.aliasNames) aliasNames.add(intern(t));
    const includes: string[] = [];
    for (const cap of out.includes) {
      if (!INCLUDABLE_EXT.test(cap)) continue;
      const t = resolveInclude(file, cap);
      if (t) includes.push(intern(t));
    }
    if (
      out.initTokens.length || out.arrayElems.length || out.inlinePtr || out.inlineTypes.length ||
      out.dPairs.length || out.dispatchFields.length || out.arrayDispatchNames.length || includes.length
    ) {
      factsByFile.set(file, {
        initTokens: out.initTokens.length ? out.initTokens.map(intern) : null,
        arrayElems: out.arrayElems.length ? out.arrayElems.map(intern) : null,
        inlinePtr: out.inlinePtr,
        inlineTypes: out.inlineTypes.length ? out.inlineTypes.map(intern) : null,
        dPairs: out.dPairs.length ? out.dPairs.map(intern) : null,
        dispatchFields: out.dispatchFields.length ? out.dispatchFields.map(intern) : null,
        arrayDispatchNames: out.arrayDispatchNames.length ? out.arrayDispatchNames.map(intern) : null,
        includes: includes.length ? includes : NO_INCLUDES,
      });
    }
  };

  let tPass = Date.now();
  if (nativeSweep) {
    // Batch of 16 = the tick/onFraction cadence, so yielding and progress
    // reporting keep their shape while the boundary crossing amortizes.
    const BATCH = 16;
    let batch: { file: string; input: CfnptrFileIn }[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      const outs = nativeSweep(batch.map((b) => b.input));
      for (let bi = 0; bi < batch.length; bi++) mergeNativeFacts(batch[bi]!.file, outs[bi]!);
      batch = [];
    };
    for (const file of files) {
      await tick();
      const rawText = raw(file);
      if (!rawText) continue; // unreadable or empty — the JS sweep skips these too
      const tN = prof ? Date.now() : 0;
      const fileNodes = ctx.getNodesInFile(file);
      if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
      const structs: CfnptrFileIn['structs'] = [];
      for (const st of fileNodes) {
        if (st.kind !== 'struct') continue;
        // sliceLinesPre semantics ride along: falsy startLine never parses,
        // and `endLine ?? startLine` is applied here so the kernel sees the
        // exact slice bounds the JS sweep would use.
        structs.push({ id: st.id, startLine: st.startLine ?? 0, endLine: st.endLine ?? st.startLine ?? 0 });
      }
      batch.push({ file, input: { text: rawText, structs } });
      if (batch.length >= BATCH) flush();
    }
    flush();
  }
  // JS sweep (fallback path — see the stage comment above).
  if (!nativeSweep) for (const file of files) {
    await tick();
    const s = src(file);
    if (!s) continue;

    // Typedefs (cross-file).
    if (s.includes('typedef')) {
      FNPTR_TYPEDEF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FNPTR_TYPEDEF_RE.exec(s))) fnPtrTypedefs.add(intern(m[1]!));
      FNTYPE_TYPEDEF_STMT_RE.lastIndex = 0;
      while ((m = FNTYPE_TYPEDEF_STMT_RE.exec(s))) {
        const guts = m[1]!;
        if (guts.includes('(*') || guts.includes('( *')) continue; // pointer form — handled above
        const fm = guts.match(/\b(\w+)\s*\(/); // last identifier before the param list
        if (fm && !C_TYPE_KEYWORDS.has(fm[1]!)) fnTypeTypedefs.add(intern(fm[1]!));
      }
    }

    // Struct-node field declarations (registered later in kind-scan order).
    const tN = prof ? Date.now() : 0;
    const fileNodes = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    let lines: string[] | null = null;
    for (const st of fileNodes) {
      if (st.kind !== 'struct') continue;
      lines ??= s.split('\n');
      const body = sliceLinesPre(lines, st.startLine, st.endLine);
      const open = body.indexOf('{');
      const close = open >= 0 ? matchBrace(body, open) : -1;
      if (open < 0 || close < 0) continue;
      rawFieldsByNode.set(st.id, parseStructFieldsRaw(body.slice(open + 1, close)));
    }

    // Registration filters. These are full-file, NO-SKIP scans: the original
    // registration pass jumps its scan cursor past a processed initializer
    // body, so a no-skip scan finds a SUPERSET of its matches — exactly the
    // over-approximation the filter needs.
    const initTokens = new Set<string>();
    const arrayElems = new Set<string>();
    const inlineTypes = new Set<string>();
    let inlinePtr = false;
    if (s.includes('{')) {
      INLINE_STRUCT_RE.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = INLINE_STRUCT_RE.exec(s))) {
        const sOpen = im.index + im[0].length - 1;
        const sClose = matchBrace(s, sOpen);
        if (sClose < 0) continue;
        // After `}`, expect `var [opt] [= {…}]` to be a table candidate.
        const vm = s.slice(sClose + 1).match(/^\s*(\w+)\s*(\[[^\]]*\])?\s*(=\s*\{)?/);
        if (!vm || !vm[1]) continue;
        inlineTags.add(intern(im[1]!));
        for (const f of parseStructFieldsRaw(s.slice(sOpen + 1, sClose))) {
          if (!f.name) continue;
          if (f.ptr) inlinePtr = true;
          else if (f.type) inlineTypes.add(intern(f.type));
        }
      }
      if (s.includes('=')) {
        INIT_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = INIT_RE.exec(s))) initTokens.add(intern(m[1]!));
        ARRAY_TABLE_RE.lastIndex = 0;
        while ((m = ARRAY_TABLE_RE.exec(s))) arrayElems.add(intern((m[2] ? '*' : '') + m[1]!));
      }
    }

    // Alias-shaped object macros (registration filter support).
    if (s.includes('#define') || s.includes('# define')) {
      const joined = s.replace(/\\\r?\n/g, ' ');
      OBJ_ALIAS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = OBJ_ALIAS_RE.exec(joined))) aliasNames.add(intern(m[1]!));
    }

    // Propagation + dispatch filters (full-file scans ⊇ the per-function-body
    // scans the pass bodies run — a body slice is a substring of the file).
    const dPairs = new Set<string>();
    if (s.includes('=')) {
      FIELD_ASSIGN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FIELD_ASSIGN_RE.exec(s))) dPairs.add(intern(m[2]! + '\0' + m[4]!));
    }
    const dispatchFields = new Set<string>();
    const arrayNames = new Set<string>();
    DISPATCH_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = DISPATCH_RE.exec(s))) dispatchFields.add(intern(dm[2]!));
    ARRAY_DISPATCH_RE.lastIndex = 0;
    while ((dm = ARRAY_DISPATCH_RE.exec(s))) arrayNames.add(intern(dm[1]!));

    const includes = scanIncludes(file);
    if (
      initTokens.size || arrayElems.size || inlinePtr || inlineTypes.size ||
      dPairs.size || dispatchFields.size || arrayNames.size || includes.length
    ) {
      factsByFile.set(file, {
        initTokens: initTokens.size ? [...initTokens] : null,
        arrayElems: arrayElems.size ? [...arrayElems] : null,
        inlinePtr,
        inlineTypes: inlineTypes.size ? [...inlineTypes] : null,
        dPairs: dPairs.size ? [...dPairs] : null,
        dispatchFields: dispatchFields.size ? [...dispatchFields] : null,
        arrayDispatchNames: arrayNames.size ? [...arrayNames] : null,
        includes,
      });
    }
  }
  if (prof) { prof.A = Date.now() - tPass; tPass = Date.now(); }

  // ---- Stage B: struct field layouts (linking — text-free) ----
  // structLayout: struct name → ordered fields, for structs with ≥1 fn-pointer
  //   field (drives positional registration + dispatch).
  // allStructFields: EVERY struct name → ALL its field layouts (a name can be
  //   reused across files — e.g. redis has two unrelated `client` structs), used
  //   to walk a chained receiver's field types (`c->cmd->proc`: client.cmd →
  //   redisCommand). The walk searches every same-named layout for the field.
  // fieldToStructs: fn-pointer field name → set of struct names that declare it.
  // Registration REPLAYS the struct kind-scan (rowid order, ≠ the extraction
  // sweep's path order): same-name layout precedence — `structLayout.set`
  // last-wins, `allStructFields` first-match in the chain walk — depends on it.
  const structLayout = new Map<string, FieldInfo[]>();
  const allStructFields = new Map<string, FieldInfo[][]>();
  const fieldToStructs = new Map<string, Set<string>>();

  // Register a parsed struct under `name` into the three indexes.
  const registerStructLayout = (name: string, fields: FieldInfo[]): void => {
    if (!allStructFields.has(name)) allStructFields.set(name, []);
    allStructFields.get(name)!.push(fields);
    for (const f of fields) {
      if (f.name && f.isFnPtr) {
        if (!fieldToStructs.has(f.name)) fieldToStructs.set(f.name, new Set());
        fieldToStructs.get(f.name)!.add(name);
      }
    }
    if (fields.some((f) => f.isFnPtr)) structLayout.set(name, fields);
  };

  for (const st of (ctx.iterateNodesByKind?.('struct') ?? ctx.getNodesByKind('struct'))) {
    if ((++scannedFiles & 255) === 0) await onYield();
    if (!C_CPP_EXT.test(st.filePath)) continue;
    const rawFields = rawFieldsByNode.get(st.id);
    if (!rawFields) continue; // file unreadable or body unparsable at sweep time — the old pass skipped it too
    registerStructLayout(st.name, classifyFields(rawFields));
  }
  rawFieldsByNode.clear();
  if (prof) { prof.B = Date.now() - tPass; tPass = Date.now(); }
  // NB: no early return on an empty structLayout here — an inline `struct TAG
  // { … } var[]` table whose struct never became a node (vim's `cmdname`, broken
  // up by `#ifdef`) is discovered later during the unit scan. The `reg.size === 0`
  // guard after registration still short-circuits when nothing bridges.

  const fnPtrFieldOf = (struct: string, field: string): boolean =>
    !!structLayout.get(struct)?.some((f) => f.name === field && f.isFnPtr);

  // C/C++ function + method nodes are STREAMED per stage (see D/E) —
  // the old materialized `cFns` array held every function node on the repo
  // (O(nodes) memory, part of the #1212 kernel OOM).

  // ---- function-name → node resolution (prefer a function in the same file) ----
  const resolveFn = (name: string, preferFile?: string): Node | null => {
    const cands = ctx.getNodesByName(name).filter((n) => FN_KINDS.has(n.kind));
    if (cands.length === 0) return null;
    if (cands.length === 1) return cands[0]!;
    if (preferFile) {
      const same = cands.find((n) => n.filePath === preferFile);
      if (same) return same;
    }
    return cands[0]!;
  };

  // ---- Stage C: registrations — Map<"struct.field", Set<funcNodeId>> ----
  // Ids only — retaining the full Node per registration (the old `idToNode`)
  // was write-only dead weight at O(registrations) memory.
  const reg = new Map<string, Set<string>>();
  const addReg = (struct: string, field: string, fn: Node): void => {
    const key = `${struct}.${field}`;
    if (!reg.has(key)) reg.set(key, new Set());
    reg.get(key)!.add(fn.id);
  };

  // Bare arrays-of-fn-pointers (no struct): array VARIABLE name → per-file sets
  // of registered function ids. Multi-entry because a file-scope `static` table
  // name can recur across files (SameBoy declares `static opcode_t *opcodes[256]`
  // in BOTH sm83_cpu.c and sm83_disassembler.c), so dispatch resolves same-file.
  const arrayReg = new Map<string, { file: string; ids: Set<string> }[]>();
  const addArrayReg = (name: string, file: string, fn: Node): void => {
    let entries = arrayReg.get(name);
    if (!entries) { entries = []; arrayReg.set(name, entries); }
    let e = entries.find((x) => x.file === file);
    if (!e) { e = { file, ids: new Set() }; entries.push(e); }
    e.ids.add(fn.id);
  };

  // A struct value `{ … }` (one element) — register its function entries to the
  // struct's fields, by `.field = fn` designators or by positional slot.
  const registerStructValue = (
    struct: string,
    valueBody: string,
    file: string,
    env?: Map<string, MacroDef>,
  ): void => {
    const layout = structLayout.get(struct);
    if (!layout) return;
    if (env && env.size) valueBody = expandMacroCalls(valueBody, env);
    // A macro can expand to a whole brace-wrapped element (sqlite's
    // `FUNCTION(…)` → `{nArg, …, xFunc, …}`); peel one outer layer so the
    // positional slots are visible.
    valueBody = valueBody.trim();
    if (valueBody.startsWith('{')) {
      const e = matchBrace(valueBody, 0);
      if (e > 0 && valueBody.slice(e + 1).trim() === '') valueBody = valueBody.slice(1, e);
    }
    const items = splitTopLevel(valueBody, ',');
    let pos = 0;
    for (const rawItem of items) {
      const item = rawItem.trim();
      if (!item) continue;
      const des = item.match(/^\.\s*(\w+)\s*=\s*(?:&\s*)?(\w+)\s*$/);
      if (des) {
        const field = des[1]!;
        if (fnPtrFieldOf(struct, field)) {
          const fn = resolveFn(des[2]!, file);
          if (fn) addReg(struct, field, fn);
        }
        // a designated item does not advance positional counting
        continue;
      }
      const field = layout.find((f) => f.index === pos);
      if (field?.isFnPtr) {
        const id = item.match(/^&?\s*(\w+)\s*$/);
        if (id) {
          const fn = resolveFn(id[1]!, file);
          if (fn) addReg(struct, field.name, fn);
        }
      }
      pos++;
    }
  };

  // Collect the literal function entries of an array-of-fn-pointers initializer
  // and register them under the array's variable name. Entries may be positional
  // (`fn`, `&fn`), designated by index (`[OP] = fn`), or cast-wrapped
  // (`(handler_t)fn`, as in php's Zend dtor table). Non-identifier entries
  // (`NULL`, `0`, a nested expression) are skipped — a miss, never a wrong edge.
  // No index tracking: a runtime subscript fans the dispatch out to the whole
  // set, exactly like a command table reaches every command.
  const registerArrayValue = (
    name: string,
    body: string,
    file: string,
    env?: Map<string, MacroDef>,
  ): void => {
    if (env && env.size) body = expandMacroCalls(body, env);
    for (const rawItem of splitTopLevel(body, ',')) {
      let item = rawItem.trim();
      if (!item) continue;
      const des = item.match(/^\[[^\]]*\]\s*=\s*([\s\S]*)$/); // `[IDX] = …` designator
      if (des) item = des[1]!.trim();
      item = item.replace(/^\((?:[\w\s*]+)\)\s*/, '').replace(/^&\s*/, '').trim(); // (cast) / &
      const id = item.match(/^(\w+)$/);
      if (!id) continue;
      const fn = resolveFn(id[1]!, file);
      if (fn) addArrayReg(name, file, fn);
    }
  };

  // Per-file macro + include parsing (any file, indexed or not), cached.
  // Derived per-file caches, LRU-bounded like the content caches (#1212).
  // These stay LAZY (recompute-on-miss through `src`): retaining every file's
  // parsed tables is ruled out by the kernel's 6.1M `#define`s, and the
  // registration stage below only builds an env for files that survive its
  // filter or carry local includes, so most files never need one.
  const fnMacroCache = new LRUCache<string, Map<string, MacroDef>>(256);
  const fileFnMacros = (file: string): Map<string, MacroDef> => {
    let m = fnMacroCache.get(file);
    if (!m) { m = parseFunctionMacros(src(file) ?? ''); fnMacroCache.set(file, m); }
    return m;
  };
  const objMacroCache = new LRUCache<string, Map<string, string>>(256);
  const fileObjMacros = (file: string): Map<string, string> => {
    let m = objMacroCache.get(file);
    if (!m) { m = parseObjectMacros(src(file) ?? ''); objMacroCache.set(file, m); }
    return m;
  };
  const definedCache = new LRUCache<string, Set<string>>(256);
  const fileDefinedNames = (file: string): Set<string> => {
    let d = definedCache.get(file);
    if (!d) { d = parseDefinedNames(src(file) ?? ''); definedCache.set(file, d); }
    return d;
  };

  // A file's effective macro environment = its own #defines PLUS those of the
  // headers it #includes (redis' `MAKE_CMD` sits beside the table; sqlite's
  // `FUNCTION` lives in `sqliteInt.h`, included by the file with the table).
  // First writer wins, so the file's own defs override included ones; depth-2
  // covers a macro defined in a header-of-a-header.
  const buildEnv = (
    file: string,
    depth: number,
    seen: Set<string>,
    fn: Map<string, MacroDef>,
    obj: Map<string, string>,
    def: Set<string>,
  ): void => {
    if (depth < 0 || seen.has(file)) return;
    seen.add(file);
    for (const [k, v] of fileFnMacros(file)) if (!fn.has(k)) fn.set(k, v);
    for (const [k, v] of fileObjMacros(file)) if (!obj.has(k)) obj.set(k, v);
    for (const n of fileDefinedNames(file)) def.add(n);
    for (const inc of localIncludesOf(file)) buildEnv(inc, depth - 1, seen, fn, obj, def);
  };

  // Registration units: every indexed C file, plus the local headers/tables it
  // `#include`s. A non-indexed include (redis' generated `commands.def`) is
  // always scanned; an INDEXED header is re-scanned in an includer's context
  // ONLY when that includer switches on conditional code the header guards — it
  // `#define`s a name the header itself doesn't and the header has `#if` (vim's
  // `ex_cmds.h`, whose command table is behind `#ifdef DO_DECLARE_EXCMD` set by
  // `ex_docmd.c`). The include is scanned with the includer's effective macro
  // env (its `MAKE_CMD(…)` resolves there) and its conditionals evaluated
  // against the includer's defined set. `reg` is a Set, so unioning across
  // multiple includers is safe.
  interface Unit {
    text: string;
    file: string;
    env: Map<string, MacroDef>;
    objEnv: Map<string, string>;
  }
  const indexedSet = new Set(files);
  const seenInclude = new Set<string>();

  // Global variable → struct type, for resolving a dispatch through a file-scope
  // table by subscript (`cmdnames[i].cmd_func(…)`).
  const globalVarType = new Map<string, string>();

  // Process a `{ … }` initializer body (array of elements or a single struct).
  const processInit = (
    struct: string,
    body: string,
    isArray: boolean,
    file: string,
    env: Map<string, MacroDef>,
  ): void => {
    if (isArray) {
      for (const el of splitTopLevel(body, ',')) {
        const t = el.trim();
        if (t.startsWith('{')) {
          const e = matchBrace(t, 0);
          if (e > 0) registerStructValue(struct, t.slice(1, e), file, env);
        } else if (t) {
          // an element built by a macro (`MAKE_CMD(…)`/`FUNCTION(…)`) or a bare value
          registerStructValue(struct, t, file, env);
        }
      }
    } else {
      registerStructValue(struct, body, file, env);
    }
  };

  // Process ONE unit's text and discard it. The old shape built every unit up
  // front (`const units: Unit[]`) — the full text of every C file plus its
  // expanded includes held simultaneously, gigabytes on the kernel (#1212).
  const processUnit = (unit: Unit): void => {
    const s = unit.text;
    if (!s || !s.includes('{')) return;

    INLINE_STRUCT_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = INLINE_STRUCT_RE.exec(s))) {
      const tag = im[1]!;
      const sOpen = im.index + im[0].length - 1; // the struct body's `{`
      const sClose = matchBrace(s, sOpen);
      if (sClose < 0) continue;
      // After `}`, expect `var [opt] [= {…}]` to be a table; else it's a plain type.
      const after = s.slice(sClose + 1);
      const vm = after.match(/^\s*(\w+)\s*(\[[^\]]*\])?\s*(=\s*\{)?/);
      if (!vm || !vm[1]) continue;
      const fields = parseStructFields(s.slice(sOpen + 1, sClose));
      if (!fields.some((f) => f.isFnPtr)) continue; // only tables of fn pointers matter
      if (!structLayout.has(tag)) registerStructLayout(tag, fields);
      globalVarType.set(vm[1]!, tag);
      if (vm[3]) {
        const aOpen = sClose + 1 + after.indexOf('{', vm[0].length - 1);
        const aClose = matchBrace(s, aOpen);
        if (aClose > 0) {
          processInit(tag, s.slice(aOpen + 1, aClose), !!vm[2], unit.file, unit.env);
          INLINE_STRUCT_RE.lastIndex = aClose;
        }
      }
    }

    if (!s.includes('=')) return;
    INIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INIT_RE.exec(s))) {
      let struct = m[1]!;
      if (!structLayout.has(struct)) struct = resolveTypeName(struct, unit.objEnv);
      if (!structLayout.has(struct)) continue;
      const isArray = !!m[3];
      const open = m.index + m[0].length - 1; // points at the `{`
      const close = matchBrace(s, open);
      if (close < 0) continue;
      globalVarType.set(m[2]!, struct);
      processInit(struct, s.slice(open + 1, close), isArray, unit.file, unit.env);
      INIT_RE.lastIndex = close;
    }

    // Bare arrays-of-function-pointers (no struct, no field). Gated on the
    // element type being a function typedef — a fn-TYPE typedef needs the `*`
    // (array of pointers to it), a fn-pointer typedef does not. A data or
    // struct array's element type is never in these sets, so it never fires.
    ARRAY_TABLE_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ARRAY_TABLE_RE.exec(s))) {
      const elemType = am[1]!;
      const hasStar = !!am[2];
      if (!((fnTypeTypedefs.has(elemType) && hasStar) || fnPtrTypedefs.has(elemType))) continue;
      const open = am.index + am[0].length - 1; // the `{`
      const close = matchBrace(s, open);
      if (close < 0) continue;
      registerArrayValue(am[3]!, s.slice(open + 1, close), unit.file, unit.env);
      ARRAY_TABLE_RE.lastIndex = close;
    }
  };

  // Can this file's OWN unit have any side effect? Every check mirrors a gate
  // in processUnit, over-approximated to the filter's coarser knowledge:
  //   • inline structs — the fn-ptr-field gate, with per-candidate field types
  //     unioned per file;
  //   • initializers — `structLayout.has` against the layouts' SUPERSET
  //     (kind-scan layouts ∪ every inline tag — structLayout only grows during
  //     this stage), with alias-shaped tokens surviving in place of the
  //     per-file `resolveTypeName` walk;
  //   • bare arrays — the exact typedef-set gate.
  // A filtered-out file is one where every match fails its gate before any
  // side effect, so skipping the unit cannot change the outcome.
  const typedefHit = (t: string): boolean => fnPtrTypedefs.has(t) || fnTypeTypedefs.has(t);
  const regSurvives = (f: FileFacts): boolean =>
    f.inlinePtr ||
    (f.inlineTypes?.some(typedefHit) ?? false) ||
    (f.initTokens?.some((t) => structLayout.has(t) || inlineTags.has(t) || aliasNames.has(t)) ?? false) ||
    (f.arrayElems?.some((e) =>
      e.charCodeAt(0) === 42 /* '*' */ ? typedefHit(e.slice(1)) : fnPtrTypedefs.has(e)
    ) ?? false);

  // ---- Stage C: registrations — stream each surviving file (and every file's
  // qualifying local includes) through processUnit, one at a time.
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (!facts) continue; // no facts ⇒ nothing matched at sweep time ⇒ the old pass would no-op here
    const survives = regSurvives(facts);
    if (!survives && facts.includes.length === 0) continue;
    const env = new Map<string, MacroDef>();
    const objEnv = new Map<string, string>();
    const defined = new Set<string>();
    buildEnv(file, 2, new Set(), env, objEnv, defined);
    if (survives) {
      const s = src(file);
      if (s) processUnit({ text: s, file, env, objEnv });
    }
    for (const target of facts.includes) {
      if (seenInclude.has(`${file}>${target}`)) continue;
      const incSrc = src(target);
      if (!incSrc) continue;
      if (indexedSet.has(target)) {
        // Re-scan an indexed header only when this includer unlocks guarded code.
        const ownDef = fileDefinedNames(target);
        const adds = [...defined].some((n) => !ownDef.has(n));
        if (!adds || !/#\s*if/.test(incSrc)) continue;
      }
      seenInclude.add(`${file}>${target}`);
      // The include is pasted into the includer — evaluate its conditionals in
      // the includer's defined set (a no-op when it has none). Re-parse the
      // included file's OWN macros from that resolved text so a macro it defines
      // conditionally (vim's `EXCMD`, whose plain last-wins parse picks the enum
      // arm) overrides with the ARM THAT IS ACTUALLY ACTIVE here.
      const text = evalConditionals(incSrc, defined);
      const incEnv = new Map(env);
      for (const [k, v] of parseFunctionMacros(text)) incEnv.set(k, v);
      const incObjEnv = new Map(objEnv);
      for (const [k, v] of parseObjectMacros(text)) incObjEnv.set(k, v);
      processUnit({ text, file: target, env: incEnv, objEnv: incObjEnv });
    }
  }
  if (prof) { prof.C = Date.now() - tPass; tPass = Date.now(); }

  // ---- receiver-type resolution within a function's source ----
  // `(?:struct )?TYPE [*]recv` declared in the params or body → TYPE (if a known
  //  fn-pointer-bearing struct).
  const recvReCache = new Map<string, RegExp>();
  const recvTypeIn = (fnSrc: string, recv: string): string | null => {
    let re = recvReCache.get(recv);
    if (!re) {
      re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${recv}\\b\\s*(?:[,)=;]|\\[)`, 'g');
      recvReCache.set(recv, re);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (structLayout.has(m[1]!)) return m[1]!;
    }
    return null;
  };

  // Declared type of a local/param `v` — ANY type token, not just fn-pointer
  // structs (the base of a chained receiver needn't carry a fn pointer itself).
  // Falls back to a file-scope table variable (`cmdnames` in `cmdnames[i].fn()`).
  const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const varReCache = new Map<string, RegExp>();
  const varTypeIn = (fnSrc: string, v: string): string | null => {
    let re = varReCache.get(v);
    if (!re) {
      re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${escapeRe(v)}\\b\\s*(?:[,)=;]|\\[)`, 'g');
      varReCache.set(v, re);
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (!C_TYPE_KEYWORDS.has(m[1]!)) return m[1]!;
    }
    return globalVarType.get(v) ?? null;
  };

  // Resolve a member-access chain (`c->cmd`, or just `p`) to a struct type,
  // walking each segment's declared field type. `c->cmd->proc` dispatch:
  // base chain `c->cmd` → client.cmd's type `redisCommand`, the proc owner.
  // Array subscripts (`cmdnames[i]`) are stripped — an index yields one element.
  const resolveChainType = (fnSrc: string, chain: string): string | null => {
    const segs = chain.replace(/\s*\[[^\]]*\]/g, '').split(/\s*(?:->|\.)\s*/).filter(Boolean);
    if (segs.length === 0) return null;
    let t = varTypeIn(fnSrc, segs[0]!);
    for (let i = 1; t && i < segs.length; i++) {
      let next: string | null = null;
      for (const fields of allStructFields.get(t) ?? []) {
        const f = fields.find((fl) => fl.name === segs[i] && fl.type);
        if (f) { next = f.type; break; }
      }
      t = next;
    }
    return t;
  };

  // ---- Stage D: field←field propagation (`a->f = b->g`) ----
  // Collected as (targetStruct.field ← sourceStruct.field) pairs, then merged to
  // a fixpoint so a hook slot inherits a registry field's handlers.
  // Filter: a file matters only if SOME collected pair has BOTH fields known as
  // fn-pointer fields — the loop body's own pre-gate. A skipped file's matches
  // would all `continue` there, so skipping is side-effect-free.
  const propagations: { to: string; from: string }[] = [];
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (
      !facts?.dPairs?.some((p) => {
        const i = p.indexOf('\0');
        return fieldToStructs.has(p.slice(0, i)) && fieldToStructs.has(p.slice(i + 1));
      })
    ) continue;
    const s = src(file);
    if (!s || !s.includes('=')) continue;
    const tN = prof ? Date.now() : 0;
    const fnsD = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    const dLines = s.split('\n');
    for (const fn of fnsD) {
      if (!FN_KINDS.has(fn.kind)) continue;
      const body = sliceLinesPre(dLines, fn.startLine, fn.endLine);
      if (!body.includes('=')) continue;
      FIELD_ASSIGN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FIELD_ASSIGN_RE.exec(body))) {
        const [, lrecv, lfield, rrecv, rfield] = m;
        // Pre-gate on field NAMES: `a->f = b->g` matches every struct-field
        // assignment in the tree (millions on the kernel), but only fields
        // that are fn-pointer fields of SOME struct can pass fnPtrFieldOf —
        // skip the two regex type resolutions for the ~99% that can't.
        if (!fieldToStructs.has(lfield!) || !fieldToStructs.has(rfield!)) continue;
        const lt = recvTypeIn(body, lrecv!);
        const rt = recvTypeIn(body, rrecv!);
        if (lt && rt && fnPtrFieldOf(lt, lfield!) && fnPtrFieldOf(rt, rfield!)) {
          propagations.push({ to: `${lt}.${lfield}`, from: `${rt}.${rfield}` });
        }
      }
    }
  }
  for (let pass = 0; pass < 3 && propagations.length; pass++) {
    let changed = false;
    for (const { to, from } of propagations) {
      const fromSet = reg.get(from);
      if (!fromSet) continue;
      if (!reg.has(to)) reg.set(to, new Set());
      const toSet = reg.get(to)!;
      for (const id of fromSet) {
        if (!toSet.has(id)) {
          toSet.add(id);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  if (prof) { prof.D = Date.now() - tPass; tPass = Date.now(); }
  if (reg.size === 0 && arrayReg.size === 0) return [];

  // ---- Stage E: dispatch sites → edges ----
  // Filter: a file matters only if some dispatch field is a known fn-pointer
  // field, or some subscripted name is a registered fn-pointer array — the loop
  // body's own first gates (`owners` / `entries`), which a skipped file's
  // matches would all fail before touching `seen`/`added`/`edges`.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    await tick();
    const facts = factsByFile.get(file);
    if (!facts) continue;
    const eSurvives =
      (facts.dispatchFields?.some((f) => fieldToStructs.has(f)) ?? false) ||
      (arrayReg.size > 0 && (facts.arrayDispatchNames?.some((n) => arrayReg.has(n)) ?? false));
    if (!eSurvives) continue;
    const s = src(file);
    if (!s) continue;
    const tN = prof ? Date.now() : 0;
    const fnsE = ctx.getNodesInFile(file);
    if (prof) { prof.nodesMs += Date.now() - tN; prof.nodesN++; }
    const eLines = s.split('\n');
    for (const fn of fnsE) {
    if (!FN_KINDS.has(fn.kind)) continue;
    const body = sliceLinesPre(eLines, fn.startLine, fn.endLine);
    DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    // Incremental line counting: matches arrive in ascending index order, so
    // count newlines since the previous match instead of re-splitting the
    // whole body prefix per match (O(body) each — real time on god-files).
    let lcIdx = 0;
    let lcLine = fn.startLine;
    const lineAt = (idx: number): number => {
      for (let i = lcIdx; i < idx; i++) if (body.charCodeAt(i) === 10) lcLine++;
      lcIdx = idx;
      return lcLine;
    };
    while ((m = DISPATCH_RE.exec(body)) && added < FANOUT_CAP) {
      const baseChain = m[1]!.replace(/\s*(?:->|\.)\s*$/, '').trim(); // receiver, minus the trailing arrow
      const field = m[2]!;
      const owners = fieldToStructs.get(field);
      if (!owners || owners.size === 0) continue;
      // 1) resolve the receiver chain's struct type precisely (handles c->cmd->proc);
      // 2) else the last segment as a simple local/param of a fn-pointer-bearing struct;
      // 3) else fall back to a field name that belongs to exactly one struct.
      let struct = resolveChainType(body, baseChain);
      if (!struct || !owners.has(struct)) {
        const lastSeg = baseChain.replace(/\s*\[[^\]]*\]/g, '').split(/\s*(?:->|\.)\s*/).pop()!;
        const t = recvTypeIn(body, lastSeg);
        struct = t && owners.has(t) ? t : null;
      }
      if (!struct || !owners.has(struct)) struct = owners.size === 1 ? [...owners][0]! : null;
      if (!struct) continue;
      const targets = reg.get(`${struct}.${field}`);
      if (!targets) continue;
      const line = lineAt(m.index);
      for (const tid of targets) {
        if (tid === fn.id) continue;
        const key = `${fn.id}>${tid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: fn.id,
          target: tid,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'fn-pointer-dispatch',
            via: `${struct}.${field}`,
            registeredAt: `${fn.filePath}:${line}`,
          },
        });
        if (++added >= FANOUT_CAP) break;
      }
    }

    // ---- bare array-of-fn-pointers dispatch (`tbl[i](…)`) ----
    if (arrayReg.size && added < FANOUT_CAP) {
      // Fresh scan from the body's start — rewind the line-count cursor too.
      lcIdx = 0;
      lcLine = fn.startLine;
      ARRAY_DISPATCH_RE.lastIndex = 0;
      while ((m = ARRAY_DISPATCH_RE.exec(body)) && added < FANOUT_CAP) {
        const entries = arrayReg.get(m[1]!);
        if (!entries) continue;
        // Same-file table wins on a name collision (two file-local `opcodes`);
        // a unique name resolves cross-file; otherwise ambiguous — bail.
        const ids = entries.length === 1
          ? entries[0]!.ids
          : (entries.find((e) => e.file === fn.filePath)?.ids ?? null);
        if (!ids) continue;
        const line = lineAt(m.index);
        for (const tid of ids) {
          if (tid === fn.id) continue;
          const key = `${fn.id}>${tid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: fn.id,
            target: tid,
            kind: 'calls',
            line,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'fn-pointer-dispatch',
              via: `${m[1]}[]`,
              registeredAt: `${fn.filePath}:${line}`,
            },
          });
          if (++added >= FANOUT_CAP) break;
        }
      }
    }
    }
  }
  if (prof) {
    prof.E = Date.now() - tPass;
    console.error(
      `[synth-timing] cFnPtr sub: A=${prof.A}ms B=${prof.B}ms C=${prof.C}ms D=${prof.D}ms E=${prof.E}ms | read n=${prof.readN} ${prof.readMs}ms strip n=${prof.stripN} ${prof.stripMs}ms nodesInFile n=${prof.nodesN} ${prof.nodesMs}ms`
    );
  }
  return edges;
}
