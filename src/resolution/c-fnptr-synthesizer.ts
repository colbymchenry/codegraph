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
 *     value of struct type `S` (from the enclosing function's params / locals),
 *     falling back to the field name when it is unique to one struct;
 *   • field←field propagation — `a->f = b->g` merges `B.g`'s handlers into
 *     `A.f`, so a generic single-slot hook that is reassigned from a registry
 *     (the `hook_demo.c` shape: `h->func = found->fn`) still resolves.
 *
 * Whole-graph pass after base resolution; all edges are `provenance:'heuristic'`
 * (`synthesizedBy:'fn-pointer-dispatch'`). High precision via the (type, field)
 * key + a real-function gate; a project with no fn-pointer dispatch is a no-op.
 */
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

/** A fn-pointer field looks like `… (*name)(…)` — capture `name`. */
const FNPTR_DECL_RE = /\(\s*\*\s*(\w+)\s*\)\s*\(/;
/** `typedef RET (*NAME)(…)` — a function-pointer typedef. */
const FNPTR_TYPEDEF_RE = /\btypedef\b[^;{}]*?\(\s*\*\s*(\w+)\s*\)\s*\(/g;

export function cFnPointerDispatchEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const files = ctx.getAllFiles().filter((f) => C_CPP_EXT.test(f));
  if (files.length === 0) return [];

  // Cache stripped source per file (read once, reused across passes).
  const srcCache = new Map<string, string>();
  const src = (file: string): string | null => {
    if (srcCache.has(file)) return srcCache.get(file)!;
    const raw = ctx.readFile(file);
    const s = raw == null ? '' : stripCommentsForRegex(raw, 'c');
    srcCache.set(file, s);
    return raw == null ? null : s;
  };

  // ---- Pass A: function-pointer typedefs (cross-file) ----
  const fnPtrTypedefs = new Set<string>();
  for (const file of files) {
    const s = src(file);
    if (!s || !s.includes('typedef')) continue;
    FNPTR_TYPEDEF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FNPTR_TYPEDEF_RE.exec(s))) fnPtrTypedefs.add(m[1]!);
  }

  // ---- Pass B: struct field layouts ----
  // structLayout: struct name → ordered fields (with fn-pointer flag).
  // fieldToStructs: fn-pointer field name → set of struct names that declare it.
  const structLayout = new Map<string, FieldInfo[]>();
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
      let name: string | null = null;
      let isFnPtr = false;
      const ptr = decl.match(FNPTR_DECL_RE);
      if (ptr) {
        name = ptr[1]!;
        isFnPtr = true;
      } else {
        // `TYPE [*]name` — fn-pointer when TYPE is a fn-pointer typedef.
        const fm = decl.match(/(\w+)\s+\*?\s*(\w+)\s*$/);
        if (fm) {
          name = fm[2]!;
          isFnPtr = fnPtrTypedefs.has(fm[1]!);
        }
      }
      if (!name) continue;
      fields.push({ name, index: idx, isFnPtr });
      if (isFnPtr) {
        if (!fieldToStructs.has(name)) fieldToStructs.set(name, new Set());
        fieldToStructs.get(name)!.add(st.name);
      }
      idx++;
    }
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
  const registerStructValue = (struct: string, valueBody: string, file: string): void => {
    const layout = structLayout.get(struct);
    if (!layout) return;
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

  // `(?:struct )?TYPE name[opt] = {` initializers, where TYPE is a struct that
  // has ≥1 fn-pointer field. Handles both single (`= {…}`) and array
  // (`[] = { {…}, {…} }`) forms.
  const INIT_RE =
    /(?:^|[;{}])\s*(?:(?:static|const|extern|register|volatile)\s+)*(?:struct\s+)?(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*=\s*\{/g;
  for (const file of files) {
    const s = srcCache.get(file);
    if (!s || !s.includes('=')) continue;
    INIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INIT_RE.exec(s))) {
      const struct = m[1]!;
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
            if (e > 0) registerStructValue(struct, t.slice(1, e), file);
          } else if (t) {
            // array of bare values (rare for structs) — treat as one positional slot
            registerStructValue(struct, t, file);
          }
        }
      } else {
        registerStructValue(struct, body, file);
      }
      INIT_RE.lastIndex = close;
    }
  }

  // ---- receiver-type resolution within a function's source ----
  // `(?:struct )?TYPE [*]recv` declared in the params or body → TYPE (if a known struct).
  const recvTypeIn = (fnSrc: string, recv: string): string | null => {
    const re = new RegExp(`(?:struct\\s+)?(\\w+)\\s*\\*?\\s*\\b${recv}\\b\\s*(?:[,)=;]|\\[)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(fnSrc))) {
      if (structLayout.has(m[1]!)) return m[1]!;
    }
    return null;
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
  // recv->field( or recv.field( where field is a known fn-pointer field.
  const DISPATCH_RE = /(\w+)\s*(?:->|\.)\s*(\w+)\s*\(/g;
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
      const recv = m[1]!;
      const field = m[2]!;
      const owners = fieldToStructs.get(field);
      if (!owners || owners.size === 0) continue;
      // Resolve the receiver's struct type; else fall back to a field name that
      // belongs to exactly one struct.
      let struct = recvTypeIn(body, recv);
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
