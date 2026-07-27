/**
 * cFnPtr native extraction sweep — differential gate (task #5 step 2).
 *
 * The synthesizer's extraction sweep has two implementations: the JS regex
 * sweep and the kernel's `cfnptrScanFiles` (codegraph-kernel/src/cfnptr.rs).
 * They must be record-identical, which this suite pins end-to-end: the same
 * adversarial project is indexed twice — CODEGRAPH_KERNEL_CFNPTR toggled —
 * and the synthesized fn-pointer-dispatch edges must match EXACTLY, including
 * order (edge order is observable through FANOUT_CAP truncation).
 *
 * The fixture deliberately stacks the sweep's edge cases: macro-built tables
 * behind a non-indexed include, `#ifdef`-guarded inline structs, object-macro
 * type aliases, bare fn-pointer arrays with casts and designators, chained
 * receivers, field←field propagation, CRLF line endings, NBSP whitespace,
 * `\`-continuations, strings containing decoy syntax, an unterminated block
 * comment, and modifier/type backtracking shapes (`static x = {…}`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { getKernel } from '../src/extraction/kernel/loader';

const kernel = getKernel();
const nativeAvailable = !!kernel && typeof kernel.cfnptrScanFiles === 'function';

interface EdgeRow {
  src: string;
  tgt: string;
  via: string;
  line: number;
}

describe.runIf(nativeAvailable)('cFnPtr sweep: native vs JS differential', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-k-')); });
  afterEach(() => {
    delete process.env.CODEGRAPH_KERNEL_CFNPTR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const indexAndCollect = async (): Promise<{ edges: EdgeRow[]; nodes: number }> => {
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges: EdgeRow[] = db
      .prepare(
        `SELECT s.name src, t.name tgt, json_extract(e.metadata,'$.via') via, e.line line
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'fn-pointer-dispatch'
         ORDER BY e.id`
      )
      .all();
    const nodes = db.prepare('SELECT count(*) c FROM nodes').get().c as number;
    cg.close?.();
    return { edges, nodes };
  };

  const writeFixture = () => {
    // The git shape + designated init + assignment registration.
    write('cmd.c', `
struct cmd { const char *name; int (*fn)(int argc); };
static int cmd_add(int argc) { return argc + 1; }
static int cmd_rm(int argc) { return argc - 1; }
static struct cmd commands[] = {
    { "add", cmd_add },
    { "rm", cmd_rm },
};
int run(int i, int argc) { return commands[i].fn(argc); }
`);
    // Macro-built table with an object-macro struct alias and a non-indexed
    // include, redis-style; plus a typedef'd fn-TYPE field.
    write('table.c', `
#include "table.h"
#include "cmds.def"
int dispatch(struct client *c, int a) { return c->cur->proc(a); }
`);
    write('table.h', `
typedef int cmdProc(int a);
#define TBL_STRUCT redisCmd
struct redisCmd { const char *name; cmdProc *proc; };
struct client { struct redisCmd *cur; };
#define MK(nm, fn) { nm, fn }
static int getCmd(int a);
static int setCmd(int a);
`);
    write('cmds.def', `
struct TBL_STRUCT tbl[] = {
    MK("get", getCmd),
    MK("set", setCmd),
};
`);
    write('impl.c', `
#include "table.h"
static int getCmd(int a) { return a; }
static int setCmd(int a) { return a + 1; }
`);
    // #ifdef-guarded inline struct table + parenthesized subscript dispatch
    // (the vim shape), switched on by the includer.
    write('ex.c', `
#define WANT_TABLE
#include "ex_cmds.h"
int exec(int i, int a) { return (cmdtab[i].cmd_fn)(a); }
`);
    write('ex_cmds.h', `
#ifdef WANT_TABLE
static int ex_quit(int a);
struct excmd { char *nm; int (*cmd_fn)(int); } cmdtab[] = { { "q", ex_quit } };
#endif
`);
    write('ex_impl.c', `static int ex_quit(int a) { return -a; }\n`);
    // Bare arrays: fn-TYPE typedef with star, casts, index designators, and a
    // same-named file-local collision (the SameBoy/Zend shapes).
    write('ops.c', `
typedef int op_t(int);
static int nop(int x) { return x; }
static int halt(int x) { return -x; }
static op_t *ops[4] = { nop, [2] = (op_t *)halt };
int step(int pc, int x) { return ops[pc](x); }
`);
    write('ops2.c', `
typedef int op_t(int);
static int trace(int x) { return x * 2; }
static op_t *ops[4] = { trace };
int step2(int pc, int x) { return (*ops[pc])(x); }
`);
    // Field←field propagation (the hook_demo shape) + chained receiver.
    write('hook.c', `
typedef void hook_fn(int);
struct entry { const char *nm; hook_fn *fn; };
struct hook { hook_fn *func; };
static void on_commit(int v) { (void)v; }
static struct entry entries[] = { { "commit", on_commit } };
void wire(struct hook *h, struct entry *found) { h->func = found->fn; }
void fire(struct hook *h, int v) { h->func(v); }
`);
    // Adversarial text: CRLF, NBSP after 'struct', continuation before a
    // #define, decoy syntax inside strings, backtick, unterminated comment,
    // and the `static x = {` backtracking shape.
    write('nasty.c', [
      'struct weird { int (*go)(int); };',
      'static int impl_go(int a) { return a; }\r',
      'static struct weird w = { impl_go };\r',
      // NBSP (U+00A0) between `struct` and the tag: JS `\s` is the Unicode
      // class, so the initializer scan crosses it — the native sweep must too.
      'static struct\u00A0weird w2 = { impl_go };',
      'int poke(struct weird *p, int a) { return p->go(a); }',
      'static x = {1};',
      'const char *s = "struct fake { int (*f)(int); } decoy[] = { impl_go };";',
      'int bt = 0; /* unterminated ` tick',
    ].join('\n'));
  };

  it('indexes to identical fn-pointer-dispatch edges with the sweep native vs JS', async () => {
    writeFixture();
    process.env.CODEGRAPH_KERNEL_CFNPTR = '0';
    const js = await indexAndCollect();
    delete process.env.CODEGRAPH_KERNEL_CFNPTR;
    const native = await indexAndCollect();

    expect(native.nodes).toBe(js.nodes);
    expect(native.edges).toEqual(js.edges);
    // The fixture must actually exercise the synthesizer, not vacuously pass.
    expect(js.edges.length).toBeGreaterThanOrEqual(8);
    const vias = new Set(js.edges.map((e) => e.via));
    expect([...vias].some((v) => v.endsWith('[]'))).toBe(true); // bare-array path
    expect([...vias].some((v) => v.includes('.'))).toBe(true); // struct-field path
  }, 120_000);

  it('native facts match the JS sweep on the raw scanner surface', () => {
    // Direct record-level check of one adversarial file (no indexing): the
    // kernel's per-file facts vs what the JS sweep's scans produce. Guards
    // the scanner surface even for shapes the edge-level fixture might not
    // reach (alias names, d-pairs, include capture order).
    const text = [
      '#define ALIAS realStruct',
      '#define NUM 0x10',
      '#define FN(x) x',
      'typedef void (*cb_t)(int);',
      'typedef int fnt(int);',
      '#include "a.def"',
      '#include "b.h"',
      'struct realStruct { cb_t cb; fnt *f; int n; };',
      'void go(struct realStruct *r, struct realStruct *q) {',
      '  r->cb = q->cb;',
      '  r->cb(1);',
      '  tbl[NUM](2);',
      '}',
      'static struct ALIAS one = { 0 };',
      'static x = {1};',
    ].join('\n');
    const out = kernel!.cfnptrScanFiles!([{ text, structs: [] }])[0]!;
    expect(out.fnPtrTypedefs).toEqual(['cb_t']);
    expect(out.fnTypeTypedefs).toEqual(['fnt']);
    expect(out.aliasNames).toEqual(['ALIAS']); // NUM numeric, FN function-like
    expect(out.includes).toEqual(['a.def', 'b.h']);
    expect(out.dPairs).toEqual(['cb\0cb']);
    expect(out.dispatchFields).toContain('cb');
    expect(out.arrayDispatchNames).toContain('tbl');
    expect(out.initTokens).toContain('ALIAS');
    expect(out.initTokens).toContain('static'); // the backtracking shape
    // `struct realStruct { … };` is followed by `;`, so it fails the
    // inline-TABLE var check (`^\s*(\w+)`) — no candidate, like the JS scan.
    expect(out.inlineTags).toEqual([]);
  });
});
