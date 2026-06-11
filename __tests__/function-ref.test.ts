/**
 * Function-as-value capture tests (#756) — registration-linking for callbacks.
 *
 * A function name used as a VALUE (passed as an argument, assigned to a
 * field/function pointer, placed in a struct/object initializer or function
 * table) must produce a `references` edge from the registration site to the
 * function, so `callers`/`impact` surface where a callback is wired up.
 *
 * Safety properties verified here, per the dynamic-dispatch discipline
 * ("a wrong edge is worse than none"):
 *  - decoy: an ambiguous cross-file name (no import, ≥2 definitions) → NO edge
 *  - same-file priority: a same-file definition beats a same-named decoy
 *  - kind filter: a class/variable passed as a value never gets a
 *    function-ref edge
 *  - self: a function passing itself → no self-loop
 *  - drain: all resolvable function_ref rows leave unresolved_refs (no
 *    batched-resolver runaway), and re-index is idempotent
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import type { Edge } from '../src/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Incoming edges to `name`'s node that came from function-as-value capture. */
function fnRefEdgesInto(cg: CodeGraph, name: string): Edge[] {
  const targets = cg.getNodesByName(name);
  const edges: Edge[] = [];
  for (const t of targets) {
    for (const e of cg.getIncomingEdges(t.id)) {
      if (e.kind === 'references' && e.metadata?.fnRef === true) {
        edges.push(e);
      }
    }
  }
  return edges;
}

/** Names of the source nodes of the given edges, sorted. */
function sourceNames(cg: CodeGraph, edges: Edge[]): string[] {
  const names: string[] = [];
  for (const e of edges) {
    const n = cg.getNode(e.source);
    if (n) names.push(n.name);
  }
  return names.sort();
}

describe('Function-as-value capture (#756)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('C: registration sites produce references edges (the #756 scenario)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-c-'));
    fs.writeFileSync(
      path.join(tmpDir, 'driver.c'),
      [
        'struct ops { void (*recv_cb)(int); void (*send_cb)(int); };',
        'typedef void (*cb_t)(int);',
        '',
        'static void my_recv_cb(int x) { (void)x; }',
        'static void my_send_cb(int x) { (void)x; }',
        '',
        'void register_handler(void (*cb)(int)) { cb(1); }',
        '',
        'void direct_caller(void) { my_recv_cb(5); }',
        '',
        'void arg_registrar(void) { register_handler(my_recv_cb); }',
        'void addr_registrar(void) { register_handler(&my_recv_cb); }',
        'void assign_registrar(struct ops *o) { o->recv_cb = my_recv_cb; }',
        '',
        'static struct ops global_ops = { .recv_cb = my_recv_cb, .send_cb = my_send_cb };',
        'static cb_t cb_table[] = { my_recv_cb, my_send_cb };',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      const intoRecv = fnRefEdgesInto(cg, 'my_recv_cb');
      expect(sourceNames(cg, intoRecv)).toEqual([
        'addr_registrar',
        'arg_registrar',
        'assign_registrar',
        'driver.c', // file-scope: designated init + positional table (deduped per source)
      ]);

      // The direct call is still a `calls` edge — unchanged by this feature.
      const recv = cg.getNodesByName('my_recv_cb')[0]!;
      const callEdges = cg
        .getIncomingEdges(recv.id)
        .filter((e) => e.kind === 'calls');
      expect(sourceNames(cg, callEdges)).toEqual(['direct_caller']);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('TypeScript: arg / object / array / member / assignment forms', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-ts-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'export function targetCb(x: number): void { console.log(x); }',
        'function registerHandler(cb: (x: number) => void): void { cb(1); }',
        '',
        'export function argRegistrar(): void { registerHandler(targetCb); }',
        'export function timerRegistrar(): void { setTimeout(targetCb, 100); }',
        'export function objRegistrar(): unknown { return { recv: targetCb }; }',
        'export function arrRegistrar(): unknown { return [targetCb]; }',
        '',
        'class Emitter { cb: ((x: number) => void) | null = null; }',
        'export function assignRegistrar(e: Emitter): void { e.cb = targetCb; }',
        '',
        'interface Btn { on(ev: string, cb: () => void): void; }',
        'export class Comp {',
        '  handleClick(): void {}',
        '  wire(btn: Btn): void { btn.on("click", this.handleClick); }',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      expect(sourceNames(cg, fnRefEdgesInto(cg, 'targetCb'))).toEqual([
        'argRegistrar',
        'arrRegistrar',
        'assignRegistrar',
        'objRegistrar',
        'timerRegistrar',
      ]);
      // `this.handleClick` is deliberately NOT captured in TS/JS: class fields
      // extract as method-kind nodes, so `this.X` value positions (mostly data
      // reads in real code) produced wrong edges — see TS_JS_SPEC note.
      expect(fnRefEdgesInto(cg, 'handleClick')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('resolves an imported callback across files via its import', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-import-'));
    fs.writeFileSync(
      path.join(tmpDir, 'handlers.ts'),
      'export function onMessage(x: number): void { console.log(x); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'wiring.ts'),
      [
        "import { onMessage } from './handlers';",
        'export function wire(bus: { on(cb: (x: number) => void): void }): void {',
        '  bus.on(onMessage);',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'onMessage');
      expect(sourceNames(cg, edges)).toContain('wire');
      // The edge must target the handlers.ts definition.
      const target = cg.getNode(edges[0]!.target);
      expect(target?.filePath.endsWith('handlers.ts')).toBe(true);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('DECOY: ambiguous cross-file name without an import resolves to NO edge', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-decoy-'));
    // Two same-named functions in different files…
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'export function process(x: number): void {}\n');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'export function process(x: number): void {}\n');
    // …and a registrar that names `process` WITHOUT importing it. The name
    // still passes the extraction gate only if imported/defined here — it is
    // neither, so this asserts the gate; even if it leaked through, the
    // ambiguity rule (unique-only cross-file) must yield no edge.
    fs.writeFileSync(
      path.join(tmpDir, 'c.ts'),
      'export function wire(bus: { on(cb: unknown): void }, process: unknown): void { bus.on(process); }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'process');
      expect(sourceNames(cg, edges)).not.toContain('wire');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('SAME-FILE PRIORITY: a same-file definition beats a same-named decoy elsewhere', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-samefile-'));
    fs.writeFileSync(path.join(tmpDir, 'decoy.c'), 'void my_cb(int x) { (void)x; }\n');
    fs.writeFileSync(
      path.join(tmpDir, 'real.c'),
      [
        'static void my_cb(int x) { (void)x; }',
        'void register_handler(void (*cb)(int)) { cb(1); }',
        'void wire(void) { register_handler(my_cb); }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const wires = fnRefEdgesInto(cg, 'my_cb').filter((e) => {
        const src = cg.getNode(e.source);
        return src?.name === 'wire';
      });
      expect(wires).toHaveLength(1);
      const target = cg.getNode(wires[0]!.target);
      expect(target?.filePath.endsWith('real.c')).toBe(true);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('KIND FILTER: a class passed as a value gets no function-ref edge', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-kind-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'export class Strategy { run(): void {} }',
        'export function consume(x: unknown): void { void x; }',
        'export function wire(): void { consume(Strategy); }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const strategy = cg.getNodesByName('Strategy').find((n) => n.kind === 'class')!;
      const fnRef = cg
        .getIncomingEdges(strategy.id)
        .filter((e) => e.metadata?.fnRef === true);
      expect(fnRef).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('SELF: a function registering itself produces no self-loop', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-self-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'declare function schedule(cb: () => void): void;',
        'export function retry(): void { schedule(retry); }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const retry = cg.getNodesByName('retry')[0]!;
      const selfLoops = cg
        .getIncomingEdges(retry.id)
        .filter((e) => e.source === retry.id && e.metadata?.fnRef === true);
      expect(selfLoops).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('C++: &Cls::method member pointers resolve scoped; bare ids are free-function-only', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'widget.cpp'),
      [
        'struct Widget {',
        '  void on_click(int x);',
        '};',
        'void Widget::on_click(int x) { (void)x; }',
        'struct Decoy {',
        '  void on_click(int x);',
        '};',
        'void Decoy::on_click(int x) { (void)x; }',
        'void free_cb(int x) { (void)x; }',
        'void bare_fn(int x) { (void)x; }',
        'void reg(void* p) { (void)p; }',
        'void wire() {',
        '  auto p = &Widget::on_click;', // qualified — must hit Widget, not Decoy
        '  reg(p);',
        '  reg(&free_cb);', // explicit address-of — captured
        '  reg(bare_fn);', // bare id in args — NOT captured for C++ (addressOfOnly)
        '}',
        // A method named like a local: passing the LOCAL must not resolve to
        // the method (cpp args accept only explicit & forms).
        'struct Buf { char* out(); };',
        'void copy_to(void* out_) { (void)out_; }',
        'void caller(char* out) { copy_to(out); }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      // Qualified member pointer resolves to Widget::on_click specifically.
      const onClicks = cg.getNodesByName('on_click');
      const widgetOnClick = onClicks.find((n) => n.qualifiedName.includes('Widget'))!;
      const decoyOnClick = onClicks.find((n) => n.qualifiedName.includes('Decoy'))!;
      const intoWidget = cg
        .getIncomingEdges(widgetOnClick.id)
        .filter((e) => e.metadata?.fnRef === true);
      expect(intoWidget).toHaveLength(1);
      expect(cg.getNode(intoWidget[0]!.source)?.name).toBe('wire');
      expect(
        cg.getIncomingEdges(decoyOnClick.id).filter((e) => e.metadata?.fnRef === true)
      ).toHaveLength(0);

      // Explicit &fn resolves; bare identifier in C++ args does NOT (the
      // generic-name collision class: fmt's `begin`/`out`/`size` params).
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'free_cb'))).toContain('wire');
      expect(fnRefEdgesInto(cg, 'bare_fn')).toHaveLength(0);

      // The local `out` param must NOT produce an edge to Buf::out.
      const outMethod = cg.getNodesByName('out').find((n) => n.kind === 'method');
      if (outMethod) {
        expect(
          cg.getIncomingEdges(outMethod.id).filter((e) => e.metadata?.fnRef === true)
        ).toHaveLength(0);
      }
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('Pascal: := event wiring, @addr and bare args', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-pas-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.pas'),
      [
        'unit Main;',
        'interface',
        'type',
        '  TCallback = procedure(X: Integer);',
        '  THolder = class',
        '  public',
        '    OnFire: TCallback;',
        '    procedure Wire;',
        '  end;',
        'procedure TargetCb(X: Integer);',
        'procedure RegisterHandler(Cb: TCallback);',
        'procedure ArgRegistrar;',
        'procedure AddrRegistrar;',
        'implementation',
        'procedure TargetCb(X: Integer);',
        'begin',
        '  WriteLn(X);',
        'end;',
        'procedure RegisterHandler(Cb: TCallback);',
        'begin',
        '  Cb(1);',
        'end;',
        'procedure ArgRegistrar;',
        'begin',
        '  RegisterHandler(TargetCb);',
        'end;',
        'procedure AddrRegistrar;',
        'begin',
        '  RegisterHandler(@TargetCb);',
        'end;',
        'procedure THolder.Wire;',
        'begin',
        '  OnFire := TargetCb;',
        'end;',
        'end.',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'TargetCb'))).toEqual([
        'AddrRegistrar',
        'ArgRegistrar',
        'Wire',
      ]);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('C UNGATED TABLES: a command table names handlers defined in OTHER files (redis pattern)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-ctable-'));
    // Handler defined in its own file…
    fs.writeFileSync(path.join(tmpDir, 't_string.c'), 'void getCommand(int c) { (void)c; }\n');
    // …and registered in a table in ANOTHER file, with no import mechanism (C).
    fs.writeFileSync(
      path.join(tmpDir, 'server.c'),
      [
        'struct cmd { const char *name; void (*proc)(int); };',
        'static struct cmd commandTable[] = {',
        '  { "get", getCommand },',
        '};',
      ].join('\n')
    );
    // Ambiguity safety: two files define dupCmd; a third table references it →
    // NO edge (unique-or-drop).
    fs.writeFileSync(path.join(tmpDir, 'dup_a.c'), 'void dupCmd(int c) { (void)c; }\n');
    fs.writeFileSync(path.join(tmpDir, 'dup_b.c'), 'void dupCmd(int c) { (void)c; }\n');
    fs.writeFileSync(
      path.join(tmpDir, 'other.c'),
      [
        'struct cmd2 { void (*proc)(int); };',
        'static struct cmd2 otherTable[] = { { dupCmd } };',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      // Cross-file unique handler resolves from the table's file.
      const intoGet = fnRefEdgesInto(cg, 'getCommand');
      expect(sourceNames(cg, intoGet)).toEqual(['server.c']);
      const target = cg.getNode(intoGet[0]!.target);
      expect(target?.filePath.endsWith('t_string.c')).toBe(true);

      // Ambiguous handler resolves to NOTHING — silent beats wrong.
      expect(fnRefEdgesInto(cg, 'dupCmd')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('DRAIN: resolvable function_ref rows leave unresolved_refs; re-index is stable', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-drain-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.c'),
      [
        'static void cb_a(int x) { (void)x; }',
        'void reg(void (*cb)(int)) { cb(1); }',
        'void wire(void) { reg(cb_a); }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const stats1 = cg.getStats();

      // No function_ref rows may linger for resolvable names — the batched
      // resolver must have drained them (delete keyed on the ORIGINAL stored
      // ref; the #760 runaway came from violating that).
      const db = (cg as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
      let leftover: unknown[] = [];
      try {
        leftover = db
          .prepare("SELECT * FROM unresolved_refs WHERE reference_kind = 'function_ref'")
          .all();
      } catch {
        // If internals aren't reachable this guard is covered by the edge
        // assertions below.
      }
      expect(leftover).toHaveLength(0);

      // Re-index: identical node/edge counts (idempotent, no accumulation).
      await cg.indexAll();
      const stats2 = cg.getStats();
      expect(stats2.totalNodes).toBe(stats1.totalNodes);
      expect(stats2.totalEdges).toBe(stats1.totalEdges);

      expect(sourceNames(cg, fnRefEdgesInto(cg, 'cb_a'))).toEqual(['wire']);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });
});
