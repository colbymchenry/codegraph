/**
 * C/C++ function-pointer dispatch synthesis (#932).
 *
 * C polymorphism is the function pointer: a struct fn-pointer field, registered
 * to concrete functions in a table (positional `{"add", cmd_add}` or designated
 * `.fn = cmd_add`) or by assignment, then dispatched indirectly (`p->fn(argv)`).
 * Static extraction sees neither the registration→field binding nor the
 * indirect call, so the dispatcher→handler edge is missing. These tests prove
 * the bridge keyed by (struct type, fn-pointer field): the command-table shape,
 * designated init, the typedef'd-field + field←field double-hop (the issue's
 * own hook_demo.c shape), by-value dispatch, and the precision boundaries
 * (a data field is never bridged, distinct fn-pointer fields don't cross-bleed,
 * and a non-C project is a no-op).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('c-fnptr dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges: { src: string; tgt: string; via: string }[] = db
      .prepare(
        `SELECT s.name src, t.name tgt, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'fn-pointer-dispatch'`
      )
      .all();
    cg.close?.();
    return edges;
  };
  const has = (edges: any[], src: string, tgt: string) => edges.some((e) => e.src === src && e.tgt === tgt);

  it('bridges a {name, fn} command table dispatched through p->fn() (the git shape)', async () => {
    write('cmd.c', `
struct cmd { const char *name; int (*fn)(int argc); };
static int cmd_add(int argc) { return argc + 1; }
static int cmd_rm(int argc) { return argc - 1; }
static int cmd_noop(int argc) { return argc; }   /* defined, NOT in the table */

static struct cmd commands[] = {
    { "add", cmd_add },
    { "rm",  cmd_rm  },
};

int run_builtin(struct cmd *p, int argc) {
    return p->fn(argc);
}
`);
    const edges = await load();
    expect(has(edges, 'run_builtin', 'cmd_add')).toBe(true);
    expect(has(edges, 'run_builtin', 'cmd_rm')).toBe(true);
    expect(edges.every((e) => e.via === 'cmd.fn')).toBe(true);
    // PRECISION: a function not registered in the table is never a target.
    expect(has(edges, 'run_builtin', 'cmd_noop')).toBe(false);
  });

  it('bridges designated-init (.handler = fn) and by-value c.fn() dispatch', async () => {
    write('ops.c', `
struct ops { int (*handler)(void); int size; };
static int on_open(void) { return 1; }
static struct ops the_ops = { .handler = on_open, .size = 4 };

int dispatch(struct ops o) { return o.handler(); }
`);
    const edges = await load();
    expect(has(edges, 'dispatch', 'on_open')).toBe(true);
    expect(edges.every((e) => e.via === 'ops.handler')).toBe(true);
  });

  it('bridges the typedef-field + field←field double-hop (the hook_demo.c shape)', async () => {
    write('hook.c', `
typedef void (*hook_func)(void);
struct hooks { hook_func func; };
struct entry { const char *name; hook_func fn; };

static void hk_set(void) {}
static void hk_get(void) {}

static const struct entry registry[] = {
    { "set", hk_set },
    { "get", hk_get },
};

void call(struct hooks *h, const struct entry *found) {
    h->func = found->fn;   /* generic slot reassigned from the registry */
    h->func();             /* dispatch through hooks.func */
}
`);
    const edges = await load();
    // hooks.func has no direct registration; it inherits entry.fn's via h->func = found->fn.
    expect(has(edges, 'call', 'hk_set')).toBe(true);
    expect(has(edges, 'call', 'hk_get')).toBe(true);
  });

  it('keys by (struct, field): distinct fn-pointer fields do not cross-bleed', async () => {
    write('vtable.c', `
struct io { int (*read)(void); int (*write)(int); };
static int do_read(void) { return 0; }
static int do_write(int x) { return x; }
static struct io io = { .read = do_read, .write = do_write };

int only_reads(struct io *p) { return p->read(); }
`);
    const edges = await load();
    // only_reads dispatches ->read → do_read, and must NOT reach do_write (a different field).
    expect(has(edges, 'only_reads', 'do_read')).toBe(true);
    expect(has(edges, 'only_reads', 'do_write')).toBe(false);
  });

  it('does not bridge a plain data field, and no-ops on a struct with no dispatch', async () => {
    write('data.c', `
struct box { int count; int (*fn)(void); };
static int helper(void) { return 0; }
static struct box b = { .count = 3, .fn = helper };

/* reads a data field and never dispatches the fn pointer */
int total(struct box *x) { return x->count + 1; }
`);
    const edges = await load();
    // No indirect dispatch happens, so there are no synthesized edges at all.
    expect(edges.length).toBe(0);
  });

  it('is a no-op on a project with no C/C++ (clean control)', async () => {
    write('app.js', `
const handlers = { add: (x) => x + 1, rm: (x) => x - 1 };
function run(name, x) { return handlers[name](x); }
`);
    const edges = await load();
    expect(edges.length).toBe(0);
  });

  // The redis command-table shape, minimized: the handler is wrapped in a
  // function-like macro, the table's struct type is an object-like macro alias,
  // the fn-pointer field uses a function-TYPE typedef, and the dispatch receiver
  // is a chained field access through a multi-declarator field.
  it('bridges a macro-built table with a typedef field, type-alias macro, and chained dispatch', async () => {
    write('reg.h', `
typedef void cmdProc(int x);                 /* function-TYPE typedef, not (*name) */
struct command { const char *name; cmdProc *proc; };
struct context { int id; struct command *cmd, *last; };  /* multi-declarator field */
`);
    write('reg.c', `
#include "reg.h"
#define ENTRY(nm, handler) nm, handler       /* function-like macro wrapping the handler */
#define CMD_T command                        /* object-like macro: the struct-type alias */
static void getCmd(int x) {}
static void setCmd(int x) {}
static void unusedCmd(int x) {}              /* defined, NOT in the table */
static struct CMD_T table[] = {
    { ENTRY("get", getCmd) },
    { ENTRY("set", setCmd) },
};
void run(struct context *ctx, int x) { ctx->cmd->proc(x); }  /* context.cmd → command → proc */
`);
    const edges = await load();
    expect(has(edges, 'run', 'getCmd')).toBe(true);
    expect(has(edges, 'run', 'setCmd')).toBe(true);
    expect(edges.every((e) => e.via === 'command.proc')).toBe(true);
    // PRECISION: a function not registered in the table is never a target.
    expect(has(edges, 'run', 'unusedCmd')).toBe(false);
  });

  // redis generates its command table into a `.def` that is #included (and never
  // indexed on its own). The synthesizer reads the included file with the
  // includer's macros in scope so the table still resolves.
  it('reads a macro-built table from a non-indexed #included file', async () => {
    write('inc.h', `
typedef int opRun(void);
struct op { const char *name; opRun *run; };
`);
    write('inc.c', `
#include "inc.h"
#define MK(nm, fn) nm, fn
#define CMD_T op
static int a_impl(void){return 0;}
static int b_impl(void){return 0;}
#include "ops.def"
int go(struct op *o) { return o->run(); }
`);
    // `.def` is not a C source extension, so this file is never indexed — it is
    // only visible to the synthesizer through inc.c's #include.
    write('ops.def', `
static struct CMD_T optable[] = {
  { MK("a", a_impl) },
  { MK("b", b_impl) },
};
`);
    const edges = await load();
    expect(has(edges, 'go', 'a_impl')).toBe(true);
    expect(has(edges, 'go', 'b_impl')).toBe(true);
    expect(edges.every((e) => e.via === 'op.run')).toBe(true);
  });

  // The sqlite builtin-function-table shape: the table-building macro lives in a
  // header (`sqliteInt.h`), separate from the file with the table (`func.c`), and
  // expands to a whole brace-wrapped struct element `{ …, xFunc, … }`.
  it('expands a header-defined macro that produces a brace-wrapped element', async () => {
    write('fn.h', `
typedef void sqlFn(int *ctx);
struct FuncDef { int nArg; sqlFn *xFunc; const char *zName; };
#define MKFUNC(name, impl) { 1, impl, #name }
`);
    write('fn.c', `
#include "fn.h"
static void absImpl(int *ctx) {}
static void lenImpl(int *ctx) {}
static struct FuncDef builtins[] = {
    MKFUNC(abs, absImpl),
    MKFUNC(len, lenImpl),
};
void invoke(struct FuncDef *p, int *x) { p->xFunc(x); }
`);
    const edges = await load();
    expect(has(edges, 'invoke', 'absImpl')).toBe(true);
    expect(has(edges, 'invoke', 'lenImpl')).toBe(true);
    expect(edges.every((e) => e.via === 'FuncDef.xFunc')).toBe(true);
  });
});
