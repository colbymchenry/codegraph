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
 * e.g. redis' command table and sqlite's builtin functions. The fn-pointer arg
 * lives inside a macro call (`MAKE_CMD(…,proc,…)` / `FUNCTION(…,xFunc)`) in a
 * generated, `#include`-d file, the table's struct type may itself be an object
 * macro alias, and the field may use a function-TYPE typedef. The registration
 * pass reads each `#include`-d file as a unit with the includer's effective
 * macro env (own + header) in scope, expands object/function macros, and peels a
 * brace-wrapped element before reading the positional/designated bindings.
 *
 * Whole-graph pass after base resolution; all edges are `provenance:'heuristic'`
 * (`synthesizedBy:'fn-pointer-dispatch'`). High precision via the (type, field)
 * key + a real-function gate; a project with no fn-pointer dispatch is a no-op.
 */
import * as path from 'node:path';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';

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

function sliceLines(content: string, startLine?: number, endLine?: number): string {
  if (!startLine) return '';
  return content.split('\n').slice(startLine - 1, endLine ?? startLine).join('\n');
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

/** A fn-pointer field looks like `… (*name)(…)` — capture `name`. */
const FNPTR_DECL_RE = /\(\s*\*\s*(\w+)\s*\)\s*\(/;
/** `typedef RET (*NAME)(…)` — a function-pointer typedef. */
const FNPTR_TYPEDEF_RE = /\btypedef\b[^;{}]*?\(\s*\*\s*(\w+)\s*\)\s*\(/g;
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

export function cFnPointerDispatchEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const files = ctx.getAllFiles().filter((f) => C_CPP_EXT.test(f));
  if (files.length === 0) return [];

  // Cache raw + stripped source per file (read once, reused across passes).
  // Raw is needed for `#include "…"` directives — strip blanks string contents.
  const rawCache = new Map<string, string | null>();
  const raw = (file: string): string | null => {
    if (rawCache.has(file)) return rawCache.get(file)!;
    const r = ctx.readFile(file);
    rawCache.set(file, r);
    return r;
  };
  const srcCache = new Map<string, string>();
  const src = (file: string): string | null => {
    if (srcCache.has(file)) return srcCache.get(file)!;
    const r = raw(file);
    const s = r == null ? '' : stripCommentsForRegex(r, 'c');
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

  // ---- Pass A: function-pointer AND function-type typedefs (cross-file) ----
  //   fn-pointer:  typedef RET (*NAME)(…)        → a field `NAME f` is a fn ptr
  //   fn-type:     typedef RET NAME(params)       → a field `NAME *f` is a fn ptr
  // The fn-type form is redis' command idiom: `typedef void redisCommandProc(client*)`
  // declared as `redisCommandProc *proc;`. Without this, `proc` reads as data.
  const fnPtrTypedefs = new Set<string>();
  const fnTypeTypedefs = new Set<string>();
  for (const file of files) {
    const s = src(file);
    if (!s || !s.includes('typedef')) continue;
    FNPTR_TYPEDEF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FNPTR_TYPEDEF_RE.exec(s))) fnPtrTypedefs.add(m[1]!);
    FNTYPE_TYPEDEF_STMT_RE.lastIndex = 0;
    while ((m = FNTYPE_TYPEDEF_STMT_RE.exec(s))) {
      const guts = m[1]!;
      if (guts.includes('(*') || guts.includes('( *')) continue; // pointer form — handled above
      const fm = guts.match(/\b(\w+)\s*\(/); // last identifier before the param list
      if (fm && !C_TYPE_KEYWORDS.has(fm[1]!)) fnTypeTypedefs.add(fm[1]!);
    }
  }

  // ---- Pass B: struct field layouts ----
  // structLayout: struct name → ordered fields, for structs with ≥1 fn-pointer
  //   field (drives positional registration + dispatch).
  // allStructFields: EVERY struct name → ALL its field layouts (a name can be
  //   reused across files — e.g. redis has two unrelated `client` structs), used
  //   to walk a chained receiver's field types (`c->cmd->proc`: client.cmd →
  //   redisCommand). The walk searches every same-named layout for the field.
  // fieldToStructs: fn-pointer field name → set of struct names that declare it.
  const structLayout = new Map<string, FieldInfo[]>();
  const allStructFields = new Map<string, FieldInfo[][]>();
  const fieldToStructs = new Map<string, Set<string>>();
  for (const st of ctx.getNodesByKind('struct')) {
    if (!C_CPP_EXT.test(st.filePath)) continue;
    const s = srcCache.get(st.filePath) ?? src(st.filePath);
    if (!s) continue;
    const body = sliceLines(s, st.startLine, st.endLine);
    const open = body.indexOf('{');
    const close = open >= 0 ? matchBrace(body, open) : -1;
    if (open < 0 || close < 0) continue;
    const inner = body.slice(open + 1, close);
    const fields: FieldInfo[] = [];
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
        let isFnPtr = false;
        const ptr = p.match(FNPTR_DECL_RE);
        if (ptr) {
          name = ptr[1]!; // `… (*name)(…)` — a function pointer
          isFnPtr = true;
        } else if (pi === 0) {
          if (firstTyped) { name = firstTyped[2]!; type = sharedType; }
        } else {
          // a subsequent declarator: `*name` / `**name` / `name`
          const dm = p.match(/^\**\s*(\w+)/);
          if (dm) { name = dm[1]!; type = sharedType; }
        }
        if (!ptr && type) isFnPtr = fnPtrTypedefs.has(type) || fnTypeTypedefs.has(type);
        // Always advance the positional index. An unparsed field (anonymous
        // union, exotic declarator) still occupies one slot, and macro-expanded
        // positional tables (redis' MAKE_CMD) only align if every field counts.
        fields.push({ name: name ?? '', index: idx, isFnPtr: !!name && isFnPtr, type });
        if (name && isFnPtr) {
          if (!fieldToStructs.has(name)) fieldToStructs.set(name, new Set());
          fieldToStructs.get(name)!.add(st.name);
        }
        idx++;
      }
    }
    if (!allStructFields.has(st.name)) allStructFields.set(st.name, []);
    allStructFields.get(st.name)!.push(fields);
    if (fields.some((f) => f.isFnPtr)) structLayout.set(st.name, fields);
  }
  if (structLayout.size === 0) return [];

  const fnPtrFieldOf = (struct: string, field: string): boolean =>
    !!structLayout.get(struct)?.some((f) => f.name === field && f.isFnPtr);

  // C/C++ function + method nodes, materialized once (bounded by C/C++ files).
  const cFns: Node[] = [];
  for (const fn of iterateFns(queries)) {
    if (C_CPP_EXT.test(fn.filePath)) cFns.push(fn);
  }

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

  // ---- Pass C: registrations — Map<"struct.field", Set<funcNodeId>> ----
  const reg = new Map<string, Set<string>>();
  const idToNode = new Map<string, Node>();
  const addReg = (struct: string, field: string, fn: Node): void => {
    const key = `${struct}.${field}`;
    if (!reg.has(key)) reg.set(key, new Set());
    reg.get(key)!.add(fn.id);
    idToNode.set(fn.id, fn);
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

  // Per-file macro + include parsing (any file, indexed or not), cached.
  const fnMacroCache = new Map<string, Map<string, MacroDef>>();
  const fileFnMacros = (file: string): Map<string, MacroDef> => {
    let m = fnMacroCache.get(file);
    if (!m) { m = parseFunctionMacros(src(file) ?? ''); fnMacroCache.set(file, m); }
    return m;
  };
  const objMacroCache = new Map<string, Map<string, string>>();
  const fileObjMacros = (file: string): Map<string, string> => {
    let m = objMacroCache.get(file);
    if (!m) { m = parseObjectMacros(src(file) ?? ''); objMacroCache.set(file, m); }
    return m;
  };
  const includeCache = new Map<string, string[]>();
  const localIncludesOf = (file: string): string[] => {
    let out = includeCache.get(file);
    if (out) return out;
    out = [];
    const rawText = raw(file);
    if (rawText && rawText.includes('include')) {
      INCLUDE_RE.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = INCLUDE_RE.exec(rawText))) {
        if (!INCLUDABLE_EXT.test(im[1]!)) continue;
        const t = resolveInclude(file, im[1]!);
        if (t) out.push(t);
      }
    }
    includeCache.set(file, out);
    return out;
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
  ): void => {
    if (depth < 0 || seen.has(file)) return;
    seen.add(file);
    for (const [k, v] of fileFnMacros(file)) if (!fn.has(k)) fn.set(k, v);
    for (const [k, v] of fileObjMacros(file)) if (!obj.has(k)) obj.set(k, v);
    for (const inc of localIncludesOf(file)) buildEnv(inc, depth - 1, seen, fn, obj);
  };

  // Registration units: every indexed C file, plus the local headers/tables it
  // `#include`s that are NOT independently indexed (e.g. redis' generated
  // `commands.def`). An included file is scanned with the INCLUDER's effective
  // env — it is textually pasted in, so its `MAKE_CMD(…)` resolves there. The
  // same `.def` included by two files with different macro defs is processed
  // once per includer; `reg` is a Set, so the (correct) union is what survives.
  interface Unit {
    text: string;
    file: string;
    env: Map<string, MacroDef>;
    objEnv: Map<string, string>;
  }
  const indexedSet = new Set(files);
  const units: Unit[] = [];
  const seenInclude = new Set<string>();
  for (const file of files) {
    const env = new Map<string, MacroDef>();
    const objEnv = new Map<string, string>();
    buildEnv(file, 2, new Set(), env, objEnv);
    const s = src(file);
    if (s) units.push({ text: s, file, env, objEnv });
    for (const target of localIncludesOf(file)) {
      if (indexedSet.has(target) || seenInclude.has(`${file}>${target}`)) continue;
      seenInclude.add(`${file}>${target}`);
      const incSrc = src(target);
      if (incSrc) units.push({ text: incSrc, file: target, env, objEnv });
    }
  }

  // `(?:struct )?TYPE name[opt] = {` initializers, where TYPE is a struct that
  // has ≥1 fn-pointer field. Handles both single (`= {…}`) and array
  // (`[] = { {…}, {…} }`) forms. Macro calls inside an element are expanded first.
  const INIT_RE =
    /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(?:struct\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*=\s*\{/g;
  for (const unit of units) {
    const s = unit.text;
    if (!s || !s.includes('=')) continue;
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
      const body = s.slice(open + 1, close);
      if (isArray) {
        // top-level `{ … }` element groups
        for (const el of splitTopLevel(body, ',')) {
          const t = el.trim();
          if (t.startsWith('{')) {
            const e = matchBrace(t, 0);
            if (e > 0) registerStructValue(struct, t.slice(1, e), unit.file, unit.env);
          } else if (t) {
            // array of bare values (rare for structs) — treat as one positional slot
            registerStructValue(struct, t, unit.file, unit.env);
          }
        }
      } else {
        registerStructValue(struct, body, unit.file, unit.env);
      }
      INIT_RE.lastIndex = close;
    }
  }

  // ---- receiver-type resolution within a function's source ----
  // `(?:struct )?TYPE [*]recv` declared in the params or body → TYPE (if a known
  //  fn-pointer-bearing struct).
  const recvTypeIn = (fnSrc: string, recv: string): string | null => {
    const re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${recv}\\b\\s*(?:[,)=;]|\\[)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (structLayout.has(m[1]!)) return m[1]!;
    }
    return null;
  };

  // Declared type of a local/param `v` — ANY type token, not just fn-pointer
  // structs (the base of a chained receiver needn't carry a fn pointer itself).
  const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const varTypeIn = (fnSrc: string, v: string): string | null => {
    const re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${escapeRe(v)}\\b\\s*(?:[,)=;]|\\[)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (!C_TYPE_KEYWORDS.has(m[1]!)) return m[1]!;
    }
    return null;
  };

  // Resolve a member-access chain (`c->cmd`, or just `p`) to a struct type,
  // walking each segment's declared field type. `c->cmd->proc` dispatch:
  // base chain `c->cmd` → client.cmd's type `redisCommand`, the proc owner.
  const resolveChainType = (fnSrc: string, chain: string): string | null => {
    const segs = chain.split(/\s*(?:->|\.)\s*/).filter(Boolean);
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

  // ---- Pass D: field←field propagation (`a->f = b->g`) ----
  // Collected as (targetStruct.field ← sourceStruct.field) pairs, then merged to
  // a fixpoint so a hook slot inherits a registry field's handlers.
  const FIELD_ASSIGN_RE = /(\w+)\s*(?:->|\.)\s*(\w+)\s*=\s*(\w+)\s*(?:->|\.)\s*(\w+)/g;
  const propagations: { to: string; from: string }[] = [];
  for (const fn of cFns) {
    const s = srcCache.get(fn.filePath);
    if (!s) continue;
    const body = sliceLines(s, fn.startLine, fn.endLine);
    if (!body.includes('=')) continue;
    FIELD_ASSIGN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FIELD_ASSIGN_RE.exec(body))) {
      const [, lrecv, lfield, rrecv, rfield] = m;
      const lt = recvTypeIn(body, lrecv!);
      const rt = recvTypeIn(body, rrecv!);
      if (lt && rt && fnPtrFieldOf(lt, lfield!) && fnPtrFieldOf(rt, rfield!)) {
        propagations.push({ to: `${lt}.${lfield}`, from: `${rt}.${rfield}` });
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
  if (reg.size === 0) return [];

  // ---- Pass E: dispatch sites → edges ----
  // `base->…->field(` or `base.…field(` where `field` is a known fn-pointer field.
  // The base may be a chain (`c->cmd->proc`), resolved through field types.
  const DISPATCH_RE = /((?:\w+\s*(?:->|\.)\s*)+)(\w+)\s*\(/g;
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const fn of cFns) {
    const s = srcCache.get(fn.filePath);
    if (!s) continue;
    const body = sliceLines(s, fn.startLine, fn.endLine);
    DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
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
        const lastSeg = baseChain.split(/\s*(?:->|\.)\s*/).pop()!;
        const t = recvTypeIn(body, lastSeg);
        struct = t && owners.has(t) ? t : null;
      }
      if (!struct || !owners.has(struct)) struct = owners.size === 1 ? [...owners][0]! : null;
      if (!struct) continue;
      const targets = reg.get(`${struct}.${field}`);
      if (!targets) continue;
      const line = fn.startLine + body.slice(0, m.index).split('\n').length - 1;
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
  }
  return edges;
}

/** C/C++ function + method nodes, streamed (memory-safe on symbol-dense repos). */
function* iterateFns(queries: QueryBuilder): IterableIterator<Node> {
  yield* queries.iterateNodesByKind('function');
  yield* queries.iterateNodesByKind('method');
}
