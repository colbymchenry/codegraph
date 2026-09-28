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
 *    function-ref edge — except Python, where class-as-value is a core
 *    idiom and bare ids ALSO resolve to classes (#1478); methods stay
 *    excluded for bare ids everywhere
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
import { ToolHandler } from '../src/mcp/tools';
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
      // `this.handleClick` resolves class-scoped (#808): the target must be a
      // method of the ENCLOSING class, in the same file.
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'handleClick'))).toEqual(['wire']);
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

  it('THIS-MEMBER SCOPING: this.X resolves only to the enclosing class, never elsewhere', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-thisx-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'declare const bus: { on(ev: string, cb: () => void): void };',
        // Decoy: a same-named method on an UNRELATED class.
        'export class Decoy { refresh(): void {} }',
        'export class Panel {',
        '  views: number[] = [];', // property (post-#808), shares no name
        '  refresh(): void {}',
        '  wire(): void {',
        '    bus.on("update", this.refresh);', // → Panel::refresh, not Decoy::refresh
        '    bus.on("data", this.views as never);', // property → NO edge
        '    bus.on("gone", this.missing as never);', // unknown member → NO edge
        '  }',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      const refreshes = cg.getNodesByName('refresh');
      const panelRefresh = refreshes.find((n) => n.qualifiedName.includes('Panel'))!;
      const decoyRefresh = refreshes.find((n) => n.qualifiedName.includes('Decoy'))!;

      const intoPanel = cg
        .getIncomingEdges(panelRefresh.id)
        .filter((e) => e.metadata?.fnRef === true);
      expect(intoPanel).toHaveLength(1);
      expect(cg.getNode(intoPanel[0]!.source)?.name).toBe('wire');
      expect(
        cg.getIncomingEdges(decoyRefresh.id).filter((e) => e.metadata?.fnRef === true)
      ).toHaveLength(0);

      // The property and the unknown member produce nothing.
      const views = cg.getNodesByName('views').find((n) => n.kind === 'property');
      if (views) {
        expect(
          cg.getIncomingEdges(views.id).filter((e) => e.metadata?.fnRef === true)
        ).toHaveLength(0);
      }
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('INHERITED this.X: resolves on a supertype via the second pass, never on unrelated classes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-inherit-'));
    fs.writeFileSync(
      path.join(tmpDir, 'base.ts'),
      'export class FormBase { handleSubmit(): void {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'unrelated.ts'),
      'export class Unrelated { handleSubmit(): void {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'login.ts'),
      [
        "import { FormBase } from './base';",
        'declare const bus: { on(ev: string, cb: () => void): void };',
        'export class LoginForm extends FormBase {',
        '  wire(): void { bus.on("submit", this.handleSubmit); }',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const handleSubmits = cg.getNodesByName('handleSubmit');
      const baseM = handleSubmits.find((n) => n.qualifiedName.includes('FormBase'))!;
      const unrelatedM = handleSubmits.find((n) => n.qualifiedName.includes('Unrelated'))!;

      const intoBase = cg.getIncomingEdges(baseM.id).filter((e) => e.metadata?.fnRef === true);
      expect(intoBase).toHaveLength(1);
      expect(cg.getNode(intoBase[0]!.source)?.name).toBe('wire');
      expect(
        cg.getIncomingEdges(unrelatedM.id).filter((e) => e.metadata?.fnRef === true)
      ).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('JAVA: Type::method cross-file, this::/super:: scoped, variable:: yields nothing', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-java-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Handlers.java'),
      [
        'package com.example;',
        'public class Handlers {',
        '    public static void onMessage(int x) { System.out.println(x); }',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'BaseForm.java'),
      ['package com.example;', 'public class BaseForm {', '    void baseHandler(int x) {}', '}'].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.java'),
      [
        'package com.example;',
        'import com.example.Handlers;',
        'import java.util.function.IntConsumer;',
        'public class Main extends BaseForm {',
        '    static void registerHandler(IntConsumer cb) { cb.accept(1); }',
        '    void run0() {}',
        '    void crossFile() { registerHandler(Handlers::onMessage); }',
        '    void thisRef() { registerHandler(this::run0); }',
        '    void superRef() { registerHandler(super::baseHandler); }',
        '    void varRef(Main m) { registerHandler(m::run0); }',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      expect(sourceNames(cg, fnRefEdgesInto(cg, 'onMessage'))).toEqual(['crossFile']);
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'baseHandler'))).toEqual(['superRef']);
      // this::run0 resolves class-scoped; m::run0 (variable receiver) must NOT
      // add a second edge — exactly one source.
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'run0'))).toEqual(['thisRef']);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('KOTLIN: companion-object refs resolve cross-file without imports; decoy companion untouched', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-ktcomp-'));
    // Same package, no imports — the Java/Kotlin reality the name gate can't
    // see, which is why qualified `Type::member` candidates skip it.
    fs.writeFileSync(
      path.join(tmpDir, 'Handlers.kt'),
      [
        'class KtHandlers {',
        '  companion object {',
        '    fun handle(x: Int) {}',
        '  }',
        '}',
        'class Decoy {',
        '  companion object {',
        '    fun handle(x: Int) {}',
        '  }',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Wirer.kt'),
      [
        'fun register(cb: Any) {}',
        'class Wirer {',
        '  fun wire() { register(KtHandlers::handle) }',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const handles = cg.getNodesByName('handle');
      const target = handles.find((n) => n.qualifiedName.includes('KtHandlers'))!;
      const decoy = handles.find((n) => n.qualifiedName.includes('Decoy'))!;
      const into = cg.getIncomingEdges(target.id).filter((e) => e.metadata?.fnRef === true);
      expect(into).toHaveLength(1);
      expect(cg.getNode(into[0]!.source)?.name).toBe('wire');
      expect(cg.getIncomingEdges(decoy.id).filter((e) => e.metadata?.fnRef === true)).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('SWIFT SCOPING: bare ids hit only the enclosing type’s methods; top-level bare hits functions only', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-swiftscope-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.swift'),
      [
        'func register(_ cb: (Int) -> Void) { cb(1) }',
        'class Monitor {',
        '  func report(_ x: Int) {}',
        '  func wire() { register(report) }', // implicit self → Monitor::report
        '}',
        'class Other {',
        // `report` here is a PARAMETER; Monitor::report must not win.
        '  func use(report: (Int) -> Void) { register(report) }',
        '}',
        'func topLevel() { register(report) }', // no implicit self → no method target
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'report');
      expect(sourceNames(cg, edges)).toEqual(['wire']);
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

  it('PHP: HOF string callables, [$this,…] and [Cls::class,…] arrays; non-HOF strings ignored', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-php-'));
    fs.writeFileSync(
      path.join(tmpDir, 'handlers.php'),
      "<?php\nfunction cmp_items($a, $b) { return $a <=> $b; }\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, 'main.php'),
      [
        '<?php',
        'class Saver {',
        '    public function onSave($x) {}',
        '    public function wire() {',
        "        register_shutdown_function([$this, 'onSave']);",
        '    }',
        '}',
        'class Loader {',
        '    public static function load($cls) {}',
        '}',
        'function sorter($items) {',
        "    usort($items, 'cmp_items');", // known HOF, cross-file string → edge
        "    spl_autoload_register([Loader::class, 'load']);",
        "    some_random_fn('cmp_items');", // NOT a known HOF → no edge
        '    return $items;',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      // Exactly ONE source for cmp_items: the usort site, not some_random_fn.
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'cmp_items'))).toEqual(['sorter']);
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'onSave'))).toEqual(['wire']);
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'load'))).toEqual(['sorter']);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('RUBY HOOKS: before_action/rescue_from symbols resolve class-scoped incl. inherited; validates is excluded', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-rubyhooks-'));
    fs.writeFileSync(
      path.join(tmpDir, 'posts_controller.rb'),
      [
        'class ApplicationController',
        '  def authenticate; end',
        'end',
        '',
        'class PostsController < ApplicationController',
        '  before_action :authenticate', // inherited → ApplicationController
        '  after_save :reindex',
        '  validates :title, presence: true', // attributes, NOT methods → no edge
        '  rescue_from StandardError, with: :render_500',
        '',
        '  def reindex; end',
        '  def render_500; end',
        '  def title; end',
        'end',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      const auth = fnRefEdgesInto(cg, 'authenticate');
      expect(auth).toHaveLength(1);
      expect(cg.getNode(auth[0]!.target)?.qualifiedName).toContain('ApplicationController');

      expect(fnRefEdgesInto(cg, 'reindex')).toHaveLength(1);
      expect(fnRefEdgesInto(cg, 'render_500')).toHaveLength(1);
      // `validates :title` names an attribute — the same-named METHOD must
      // get no registration edge.
      expect(fnRefEdgesInto(cg, 'title')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('PYTHON CLASSES: return / alias / registry dict / arg positions produce references edges (#1478)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-pycls-'));
    fs.writeFileSync(
      path.join(tmpDir, 'serializers.py'),
      [
        'class OrgSerializerFull:',
        '    pass',
        '',
        'class OrgSerializerBrief:',
        '    pass',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'views.py'),
      [
        'from serializers import OrgSerializerFull, OrgSerializerBrief',
        '',
        'def register(cls):',
        '    pass',
        '',
        'class OrgViewSet:',
        '    def get_serializer_class(self):',
        '        if True:',
        '            return OrgSerializerFull',
        '        return OrgSerializerBrief',
        '',
        'SERIALIZER_REGISTRY = {"org": OrgSerializerFull}',
        'register(OrgSerializerBrief)',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'models.py'),
      [
        'class Config:',
        '    pass',
        '',
        'def make_config_cls():',
        '    return Config',
        '',
        'ActiveConfig = Config',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      // The DRF wiring: get_serializer_class → the imported serializer class,
      // via `return` — the issue's headline gap. The module-level registry
      // dict rides BOTH the assigned name (the initializer walk, #693) and the
      // file node (the dispatcher's own scan, which runs either way).
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'OrgSerializerFull'))).toEqual([
        'SERIALIZER_REGISTRY',
        'get_serializer_class',
        'views.py',
      ]);
      // Second branch return + a module-level call argument.
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'OrgSerializerBrief'))).toEqual([
        'get_serializer_class',
        'views.py',
      ]);

      // Same-file: factory return + module-level alias assignment.
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'Config'))).toEqual([
        'make_config_cls',
        'models.py',
      ]);

      // callers() must now surface the view as a consumer of the serializer.
      const serializer = cg
        .getNodesByName('OrgSerializerFull')
        .find((n) => n.kind === 'class')!;
      const callers = cg.getCallers(serializer.id);
      expect(callers.some((c) => c.node.name === 'get_serializer_class')).toBe(true);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('PYTHON KIND FILTER: bare ids still never resolve to methods; unknown names stay silent', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-pyneg-'));
    fs.writeFileSync(
      path.join(tmpDir, 'svc.py'),
      [
        'class Svc:',
        '    def refresh(self):',
        '        pass',
        '',
        'def wire(cb):',
        '    pass',
        '',
        'def setup(refresh):',
        // A local/parameter sharing a same-file METHOD name: the gate lets it
        // through (methods are in definedHere) but resolution must refuse —
        // a bare id can never be a method value in Python.
        '    wire(refresh)',
        // A name with no matching class/function anywhere: no edge, silently.
        '    return unknown_thing',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      expect(fnRefEdgesInto(cg, 'refresh')).toHaveLength(0);
      expect(fnRefEdgesInto(cg, 'unknown_thing')).toHaveLength(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('#1820 PYTHON: obj.method passed as a callback is a caller; a unique method resolves', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      [
        'class Base:',
        '    pass',
        '',
        'class Store(Base):',
        '    def fetch(self, ids):',
        '        return ids',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'from concurrent.futures import ThreadPoolExecutor',
        'from store import Base',
        '',
        'class Consumer:',
        '    def __init__(self, store: Base):',
        '        self.store = store',
        '',
        '    def direct(self, ids):',
        '        return self.store.fetch(ids)',
        '',
        '    def via_callback(self, ids, pool: ThreadPoolExecutor):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const fetch = cg.getNodesByName('fetch').find((n) => n.kind === 'method')!;
      const callers = cg.getCallers(fetch.id).map((c) => c.node.name).sort();
      expect(callers).toContain('direct');
      expect(callers).toContain('via_callback');
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'fetch'))).toEqual(['via_callback']);
      expect([...cg.getImpactRadius(fetch.id).nodes.values()].map(n => n.name)).toContain('via_callback');
      const response = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'Consumer.via_callback Store.fetch',
      });
      expect(response.isError).not.toBe(true);
      const text = response.content?.[0]?.text ?? '';
      expect(text).toMatch(/`fetch`.*2 callers in `consumer.py`/);
      expect(text).toContain('via_callback(method)');
      expect(text).toContain('pool.submit(self.store.fetch, ids)');
    } finally {
      cg.destroy();
    }
  });

  it('#1820 PYTHON: a test-file method still makes an unknown receiver ambiguous', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-mock-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      'class Store:\n    def fetch(self, ids):\n        return ids\n'
    );
    fs.mkdirSync(path.join(tmpDir, 'tests'));
    fs.writeFileSync(
      path.join(tmpDir, 'tests', 'test_store.py'),
      'class FakeStore:\n    def fetch(self, ids):\n        return ids\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(edges).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  it('#1820 PYTHON: a NotImplementedError base still makes an unknown receiver ambiguous', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-base-'));
    fs.writeFileSync(
      path.join(tmpDir, 'base.py'),
      [
        'class Base:',
        '    def fetch(self, ids):',
        '        raise NotImplementedError("subclass")',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'store.py'),
      [
        'from base import Base',
        'class Store(Base):',
        '    def fetch(self, ids):',
        '        return ids',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(edges).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  it('#1820 PYTHON: two methods of the same name produce no callback edge', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-py-decoy-'));
    fs.writeFileSync(path.join(tmpDir, 'a.py'), 'class A:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(path.join(tmpDir, 'b.py'), 'class B:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.py'),
      [
        'class Consumer:',
        '    def __init__(self, store):',
        '        self.store = store',
        '    def via_callback(self, pool, ids):',
        '        return pool.submit(self.store.fetch, ids)',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      expect(fnRefEdgesInto(cg, 'fetch')).toHaveLength(0);
    } finally {
      cg.destroy();
    }
  });

  it('#1820 GO: method value Submit(c.store.Fetch) is a caller; go Fetch(ids) is a call', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-1820-go-'));
    fs.writeFileSync(
      path.join(tmpDir, 'store.go'),
      [
        'package demo',
        '',
        'type Store struct{}',
        '',
        'func (s *Store) Fetch(ids []string) []string { return ids }',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, 'consumer.go'),
      [
        'package demo',
        '',
        'func Submit(fn func([]string) []string, ids []string) []string { return fn(ids) }',
        '',
        'type Consumer struct{ store *Store }',
        '',
        'func (c *Consumer) Direct(ids []string) []string { return c.store.Fetch(ids) }',
        '',
        'func (c *Consumer) ViaGo(ids []string) { go c.store.Fetch(ids) }',
        '',
        'func (c *Consumer) ViaSubmit(ids []string) []string { return Submit(c.store.Fetch, ids) }',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const fetch = cg.getNodesByName('Fetch').find((n) => n.kind === 'method')!;
      const callers = cg.getCallers(fetch.id).map((c) => c.node.name).sort();
      expect(callers).toContain('Direct');
      expect(callers).toContain('ViaGo');
      expect(callers).toContain('ViaSubmit');
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'Fetch'))).toEqual(['ViaSubmit']);
    } finally {
      cg.destroy();
    }
  });

  it('#1820: receiver identity beats same-file and imported-name decoys', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-receivers-'));
    fs.writeFileSync(path.join(tmpDir, 'store.py'), `class Store:
    def fetch(self, ids):
        return ids
`);
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `from store import Store as Actual
class Store:
    def fetch(self, ids):
        return ids
class Consumer:
    def __init__(self, store: Actual):
        self.store = store
    def callback(self, pool, ids):
        return pool.submit(self.store.fetch, ids)
    def assigned(self):
        cb = self.store.fetch
    def collected(self):
        return [self.store.fetch]
def typed(obj: Actual, pool):
    pool.submit(obj.fetch)
def static(pool):
    pool.submit(Actual.fetch)
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(sourceNames(cg, edges)).toEqual(['assigned', 'callback', 'collected', 'static', 'typed']);
      expect(edges.every(e => cg.getNode(e.target)?.filePath === 'store.py')).toBe(true);
    } finally { cg.close(); }
  });

  it.each(['tasks', '.tasks'])('Python imported members do not fall back to their receiver (%s)', async (module) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-import-members-'));
    fs.writeFileSync(path.join(tmpDir, 'tasks.py'), `from celery import shared_task
@shared_task
def send_welcome(item_id):
    return item_id
class Store:
    @staticmethod
    def fetch():
        return 1
settings = None
`);
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `from ${module} import send_welcome as welcome, Store as Actual, settings
def direct():
    welcome(1)
def callback(pool):
    pool.submit(welcome, 1)
def enqueue():
    welcome.delay(1)
    welcome.apply_async(args=[1])
def member_values(pool):
    pool.submit(welcome.delay, 1)
    cb = welcome.custom_attribute
    return [welcome.apply_async]
def missing_members():
    Actual.missing()
    settings.missing()
def known_member():
    Actual.fetch()
def known_callback(pool):
    pool.submit(Actual.fetch)
def construct():
    return Actual()
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const task = cg.getNodesByName('send_welcome').find(n => n.kind === 'function')!;
      expect(sourceNames(cg, cg.getIncomingEdges(task.id).filter(e => e.kind === 'calls'))).toEqual(['direct']);
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'send_welcome'))).toEqual(['callback']);
      const missing = cg.getNodesByName('missing_members')[0]!;
      expect(cg.getOutgoingEdges(missing.id).filter(e => e.kind === 'calls' || e.kind === 'instantiates')).toEqual([]);
      const fetch = cg.getNodesByName('fetch').find(n => n.kind === 'method')!;
      expect(sourceNames(cg, cg.getIncomingEdges(fetch.id).filter(e => e.kind === 'calls'))).toEqual(['known_member']);
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'fetch'))).toEqual(['known_callback']);
      const store = cg.getNodesByName('Store').find(n => n.kind === 'class')!;
      expect(sourceNames(cg, cg.getIncomingEdges(store.id).filter(e => e.kind === 'instantiates'))).toEqual(['construct']);
    } finally { cg.close(); }
  });

  it('#1820: same-file ambiguity and noncallable receivers stay unlinked', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-ambiguity-'));
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `class A:
    def fetch(self):
        return 1
class B:
    def fetch(self):
        return 2
class Data:
    fetch = 42
class Property:
    @property
    def fetch(self):
        return 42
def unknown(obj, pool):
    pool.submit(obj.fetch)
def data(obj: Data, pool):
    pool.submit(obj.fetch)
def prop(obj: Property, pool):
    pool.submit(obj.fetch)
def bare(fetch, pool):
    pool.submit(fetch)
class Own:
    def fetch(self):
        return 3
    def bound(self, pool):
        pool.submit(self.fetch)
    @classmethod
    def class_bound(cls, pool):
        pool.submit(cls.fetch)
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'fetch');
      expect(sourceNames(cg, edges)).toEqual(['bound', 'class_bound']);
      expect(edges.every(e => cg.getNode(e.target)?.qualifiedName === 'Own::fetch')).toBe(true);
    } finally { cg.close(); }
  });

  it('#1820: typed, constructed and inherited Python receivers exclude noncallable values', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-known-'));
    fs.writeFileSync(path.join(tmpDir, 'main.py'), `class Store:
    def fetch(self):
        return 1
class Child(Store):
    def inherited(self, pool):
        pool.submit(self.fetch)
class Data:
    def __init__(self):
        self.fetch = 42
class Override(Store):
    def __init__(self):
        self.fetch = 42
class Consumer:
    def __init__(self):
        self.store = Store()
    def keyword(self, pool):
        pool.submit(callback=self.store.fetch)
def constructor(pool):
    obj = Store()
    pool.submit(obj.fetch)
def partial_ref(obj: Store):
    return partial(obj.fetch, 1)
def mapped(obj: Store, xs):
    return map(obj.fetch, xs)
def data(obj: Data, pool):
    pool.submit(obj.fetch)
def override(obj: Override, pool):
    pool.submit(obj.fetch)
def primitive(obj: int, pool):
    pool.submit(obj.fetch)
def literal(pool):
    obj = 42
    pool.submit(obj.fetch)
def reassigned(obj: Store, pool):
    obj = 42
    pool.submit(obj.fetch)
def direct(obj: Store):
    obj.fetch()
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      expect(sourceNames(cg, fnRefEdgesInto(cg, 'fetch'))).toEqual([
        'constructor', 'inherited', 'keyword', 'mapped', 'partial_ref',
      ]);
      const fetch = cg.getNodesByName('fetch').find(n => n.kind === 'method')!;
      expect(sourceNames(cg, cg.getIncomingEdges(fetch.id).filter(e => e.kind === 'calls'))).toContain('direct');
    } finally { cg.close(); }
  });

  it('#1820: a module global bound by its assignments resolves as a receiver', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-global-'));
    fs.writeFileSync(path.join(tmpDir, 'store.py'), 'class Store:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(path.join(tmpDir, 'decoy.py'), 'class Decoy:\n    def fetch(self, ids):\n        return []\n');
    fs.writeFileSync(path.join(tmpDir, 'settings.py'), `from decoy import Decoy
conn = None

def init():
    global conn
    from store import Store
    conn = Store()

def shadow():
    conn = Decoy()
    return conn

def same_file(pool):
    pool.submit(conn.fetch, [])

def param_shadow(pool, conn):
    pool.submit(conn.fetch, [])

def loop_shadow(pool, items):
    for conn in items:
        pool.submit(conn.fetch, [])
`);
    fs.writeFileSync(path.join(tmpDir, 'consumer.py'), `import settings
from settings import conn

def via_module(pool):
    pool.submit(settings.conn.fetch, [])

def via_name(pool):
    pool.submit(conn.fetch, [])

def import_shadow(pool, settings):
    pool.submit(settings.conn.fetch, [])

def local_import(pool):
    from settings import conn
    pool.submit(conn.fetch, [])
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const store = cg.getNodesByName('fetch').find(n => n.qualifiedName.startsWith('Store::'))!;
      const into = cg.getIncomingEdges(store.id).filter(e => e.kind === 'references' && e.metadata?.fnRef === true);
      // A parameter or loop variable of the same name is not the global; a local import of it is.
      expect(sourceNames(cg, into)).toEqual(['local_import', 'same_file', 'via_module', 'via_name']);
      const decoy = cg.getNodesByName('fetch').find(n => n.qualifiedName.startsWith('Decoy::'))!;
      expect(cg.getIncomingEdges(decoy.id).filter(e => e.metadata?.fnRef === true)).toHaveLength(0);
    } finally { cg.close(); }
  });

  it('#1820: a module global with several backends binds to the declaration they share', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-global-many-'));
    fs.mkdirSync(path.join(tmpDir, 'backends'));
    fs.writeFileSync(path.join(tmpDir, 'backends', '__init__.py'), '');
    fs.writeFileSync(path.join(tmpDir, 'backends', 'base.py'),
      'class Base:\n    def fetch(self, ids):\n        raise NotImplementedError("backend")\n' +
      '    def search(self):\n        raise NotImplementedError("backend")\n');
    fs.writeFileSync(path.join(tmpDir, 'backends', 'es.py'),
      'from backends.base import Base\nclass ES(Base):\n    def search(self):\n        return []\n');
    fs.writeFileSync(path.join(tmpDir, 'backends', 'vec.py'),
      'from backends.base import (\n    Base,\n)\nclass Vec(Base):\n    def fetch(self, ids):\n        return ids\n' +
      '    def search(self):\n        return []\n');
    fs.writeFileSync(path.join(tmpDir, 'other.py'), 'class Other:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(path.join(tmpDir, 'settings.py'), `import backends.es
conn = None

def init(engine):
    global conn
    if engine == "es":
        conn = backends.es.ES()
    else:
        from backends import vec as vec_module
        conn = vec_module.Vec()
`);
    fs.writeFileSync(path.join(tmpDir, 'unknown.py'), `from other import Other
conn = None
mixed = None

def init(flag):
    global conn, mixed
    conn = make_conn()
    mixed = Other() if flag else None
`);
    fs.writeFileSync(path.join(tmpDir, 'consumer.py'), `import settings
import unknown

def gc(pool):
    pool.submit(settings.conn.fetch, [])

def find(pool):
    pool.submit(settings.conn.search)

def opaque(pool):
    pool.submit(unknown.conn.fetch, [])
    pool.submit(unknown.mixed.fetch, [])
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const byOwner = (owner: string, name = 'fetch') => cg.getNodesByName(name).find(n => n.qualifiedName.startsWith(`${owner}::`))!;
      const fnRefs = (owner: string, name = 'fetch') => cg.getIncomingEdges(byOwner(owner, name).id)
        .filter(e => e.kind === 'references' && e.metadata?.fnRef === true);
      // ES inherits Base.fetch and Vec overrides it: the shared declaration is Base.fetch.
      expect(sourceNames(cg, fnRefs('Base'))).toEqual(['gc']);
      expect(fnRefs('Vec')).toHaveLength(0);
      // Both backends override search: the declaration they inherit is still Base.search.
      expect(sourceNames(cg, fnRefs('Base', 'search'))).toEqual(['find']);
      expect([...fnRefs('ES', 'search'), ...fnRefs('Vec', 'search')]).toHaveLength(0);
      // An opaque initializer (`make_conn()`, a conditional) leaves the global's type unknown.
      expect(fnRefs('Other')).toHaveLength(0);
    } finally { cg.close(); }
  });

  it('#1820: a module global never binds through a shadow, an unknown value or a deeper chain', async () => {
    const header = `from store import Store
from decoy import Decoy
conn = None

def init():
    global conn
    conn = Store()
`;
    // Each case: its files, and the fnRef edges into any `fetch` it must produce.
    const cases: Record<string, [Record<string, string>, string[]]> = {
      control: [{ 'm.py': header + 'def cb(pool):\n    pool.submit(conn.fetch)\n' }, ['cb -> Store::fetch']],
      tuple_first: [{ 'm.py': header + 'def cb(pool):\n    conn, _ = (Decoy(), None)\n    pool.submit(conn.fetch)\n' }, []],
      loop_and_nested_global: [{ 'm.py': header +
        'def cb(pool, items):\n    for conn in items:\n        pass\n    def nested():\n        global conn\n    pool.submit(conn.fetch)\n' }, []],
      multiline_conditional: [{ 'm.py': header.replace('conn = Store()', 'conn = Store(\n        x=1,\n    ) if flag else Decoy()') +
        'def cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      multiline_constructor: [{ 'm.py': header.replace('conn = Store()', 'conn = Store(\n        x=1,\n    )') +
        'def cb(pool):\n    pool.submit(conn.fetch)\n' }, ['cb -> Store::fetch']],
      closure_param: [{ 'm.py': header + 'def outer(conn):\n    def cb(pool):\n        pool.submit(conn.fetch)\n    return cb\n' }, []],
      closure_local: [{ 'm.py': header + 'def outer(pool):\n    conn = Decoy()\n    def cb():\n        pool.submit(conn.fetch)\n    return cb\n' }, []],
      lambda_param: [{ 'm.py': header + 'def cb(pool):\n    pool.submit(lambda conn: pool.map(conn.fetch))\n' }, []],
      comprehension: [{ 'm.py': header + 'def cb(pool, xs):\n    [pool.submit(conn.fetch) for conn in xs]\n' }, []],
      except_as: [{ 'm.py': header + 'def cb(pool):\n    try:\n        pass\n    except Exception as conn:\n        pool.submit(conn.fetch)\n' }, []],
      match_as: [{ 'm.py': header + 'def cb(pool, x):\n    match x:\n        case Decoy() as conn:\n            pool.submit(conn.fetch)\n' }, []],
      global_in_nested_def: [{ 'm.py': 'from decoy import Decoy\nconn = None\n\ndef init():\n    def helper():\n        global conn\n    conn = Decoy()\n\n' +
        'def cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      keyword_in_multiline_call: [{ 'm.py': 'from decoy import Decoy\nconn = None\napp = dict(\n    conn=Decoy()\n)\n\n' +
        'def cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      tuple_rebind: [{ 'm.py': header + 'def reset():\n    global conn\n    conn, other = Decoy(), 1\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      with_rebind: [{ 'm.py': header + 'def reset():\n    global conn\n    with open_decoy() as conn:\n        pass\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      docstring: [{ 'm.py': 'from store import Store\nconn = None\n"""\nconn = Store()\n"""\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      deeper_chain: [{ 'settings.py': header, 'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.pool.fetch)\n' }, []],
      importer_rebinds: [{ 'settings.py': header,
        'c.py': 'from settings import conn\nfrom decoy import Decoy\n\ndef reset():\n    global conn\n    conn = Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      local_import_of_other_module: [{ 'settings.py': header, 'other_settings.py': 'from decoy import Decoy\nconn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    import other_settings as settings\n    pool.submit(settings.conn.fetch)\n' }, []],
      local_from_import_of_other_module: [{ 'settings.py': header, 'other_settings.py': 'from decoy import Decoy\nconn = Decoy()\n',
        'c.py': 'from settings import conn\n\ndef cb(pool):\n    from other_settings import conn\n    pool.submit(conn.fetch)\n' }, []],
      comment_in_parenthesized_import: [{ 'settings.py': header + 'other = 1\n',
        'c.py': 'from settings import (\n    other,  # see fetch()\n    conn,\n)\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, ['cb -> Store::fetch']],
      star_import_override: [{ 'local.py': 'from decoy import Decoy\nconn = Decoy()\n', 'settings.py': header + 'from local import *\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      match_sequence_capture: [{ 'm.py': header + 'def cb(pool, x):\n    match x:\n        case [conn]:\n            pool.submit(conn.fetch)\n' }, []],
      match_keyword_capture: [{ 'm.py': header + 'def cb(pool, x):\n    match x:\n        case Decoy(inner=conn):\n            pool.submit(conn.fetch)\n' }, []],
      match_bare_capture: [{ 'm.py': header + 'def cb(pool, x):\n    match x:\n        case conn:\n            pool.submit(conn.fetch)\n' }, []],
      multiline_loop_target: [{ 'm.py': header + 'def cb(pool, xs):\n    for (a,\n         conn) in xs:\n        pool.submit(conn.fetch)\n' }, []],
      multiline_tuple_local: [{ 'm.py': header + 'def cb(pool):\n    (a,\n     conn) = 1, Decoy()\n    pool.submit(conn.fetch)\n' }, []],
      multiline_tuple_rebind: [{ 'm.py': header + 'def reset():\n    global conn\n    (a,\n     conn) = 1, Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      annotation_contradicts_value: [{ 'm.py': 'from store import Store\nfrom decoy import Decoy\nconn: Store = Decoy()\n\n' +
        'def cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      annotation_over_factory: [{ 'm.py': 'from store import Store\nconn: Store = make_store()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' },
        ['cb -> Store::fetch']],
      external_production_write: [{ 'settings.py': header,
        'reset.py': 'import settings\nfrom decoy import Decoy\n\ndef reset():\n    settings.conn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      external_aliased_write: [{ 'pkg/__init__.py': '', 'pkg/settings.py': header,
        'reset.py': 'import pkg.settings as cfg\n\ndef reset():\n    cfg.conn = make_conn()\n',
        'c.py': 'from pkg import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      external_relative_write: [{ 'pkg/__init__.py': '', 'pkg/settings.py': header,
        'pkg/reset.py': 'from . import settings\nfrom decoy import Decoy\n\ndef reset():\n    settings.conn = Decoy()\n',
        'c.py': 'from pkg import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      external_setattr: [{ 'settings.py': header,
        'reset.py': 'import settings\nfrom decoy import Decoy\n\ndef reset():\n    setattr(settings, "conn", Decoy())\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      external_subclass_write: [{ 'settings.py': header,
        'sub.py': 'from store import Store\nclass SubStore(Store):\n    def fetch(self, ids):\n        return ids\n',
        'reset.py': 'import settings\nfrom sub import SubStore\n\ndef reset():\n    settings.conn = SubStore()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      test_double_write: [{ 'settings.py': header,
        'tests/test_c.py': 'import settings\nfrom unittest.mock import MagicMock\n\ndef test_cb(pool):\n    settings.conn = MagicMock()\n    pool.submit(settings.conn.fetch)\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      test_monkeypatch: [{ 'settings.py': header,
        'tests/test_c.py': 'import settings\n\ndef test_cb(monkeypatch, pool):\n    monkeypatch.setattr(settings, "conn", object())\n    pool.submit(settings.conn.fetch)\n' }, []],
      globals_literal_write: [{ 'm.py': header + 'def reset():\n    globals()["conn"] = Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      globals_dynamic_write: [{ 'm.py': header + 'for name, obj in [("conn", Decoy())]:\n    globals()[name] = obj\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      unrelated_attribute_write: [{ 'settings.py': header,
        'other.py': 'from decoy import Decoy\n\nclass Holder:\n    def __init__(self):\n        self.conn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      // A write lands on the module its import names, never on another module sharing its tail.
      write_path_is_exact: [{ 'x/__init__.py': '', 'y/__init__.py': '', 'x/settings.py': header, 'y/settings.py': header,
        'reset.py': 'from x import settings\nfrom decoy import Decoy\n\ndef reset():\n    settings.conn = Decoy()\n',
        'cx.py': 'from x import settings\n\ndef cb_x(pool):\n    pool.submit(settings.conn.fetch)\n',
        'cy.py': 'from y import settings\n\ndef cb_y(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb_y -> Store::fetch']],
      ambiguous_write_target: [{ 'x/__init__.py': '', 'y/__init__.py': '', 'x/settings.py': header, 'y/settings.py': header,
        'reset.py': 'import settings\nfrom decoy import Decoy\n\ndef reset():\n    settings.conn = Decoy()\n',
        'cx.py': 'from x import settings\n\ndef cb_x(pool):\n    pool.submit(settings.conn.fetch)\n',
        'cy.py': 'from y import settings\n\ndef cb_y(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      relative_write_is_exact: [{ 'pkg/__init__.py': '', 'pkg/sub/__init__.py': '', 'pkg/settings.py': header,
        'other/__init__.py': '', 'other/pkg/__init__.py': '', 'other/pkg/settings.py': header,
        'pkg/sub/reset.py': 'from .. import settings\n\ndef reset():\n    settings.conn = make_conn()\n',
        'c2.py': 'from other.pkg import settings\n\ndef cb2(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb2 -> Store::fetch']],
      namespace_import_binds_root: [{ 'pkg/__init__.py': '', 'pkg/settings.py': header,
        'c.py': 'import pkg.settings\nfrom decoy import Decoy\n\nsettings = Bag()\nsettings.conn = Decoy()\n',
        'd.py': 'from pkg import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      example_write_is_production: [{ 'settings.py': header,
        'examples/wire.py': 'import settings\nfrom decoy import Decoy\n\ndef wire():\n    settings.conn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      conftest_write_is_test: [{ 'settings.py': header,
        'pkg/conftest.py': 'import settings\nfrom decoy import Decoy\n\ndef fixture():\n    settings.conn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      main_block_write: [{ 'settings.py': header,
        'run.py': 'import settings\nfrom decoy import Decoy\n\nif __name__ == "__main__":\n    settings.conn = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      own_main_block_write: [{ 'm.py': header + 'if __name__ == "__main__":\n    conn = Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' },
        ['cb -> Store::fetch']],
      globals_continued_key: [{ 'm.py': header + 'def reset():\n    globals()[\n        "conn"] = Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      globals_alias: [{ 'm.py': header + 'def reset():\n    g = globals()\n    g["conn"] = Decoy()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      globals_in_string: [{ 'm.py': header + 'NOTE = "globals().update(mapping)"\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' },
        ['cb -> Store::fetch']],
      external_dict_write: [{ 'settings.py': header,
        'reset.py': 'import settings\nfrom decoy import Decoy\n\ndef reset():\n    settings.__dict__["conn"] = Decoy()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, []],
      external_annotated_write: [{ 'settings.py': header,
        'reset.py': 'import settings\nfrom store import Store\n\ndef reset():\n    settings.conn: Store = Store()\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      external_parenthesized_write: [{ 'settings.py': header,
        'reset.py': 'import settings\nfrom store import Store\n\ndef reset():\n    settings.conn = (Store())\n',
        'c.py': 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n' }, ['cb -> Store::fetch']],
      dotted_import_collision: [{ 'alpha/__init__.py': '', 'beta/__init__.py': '',
        'alpha/foo.py': 'class Client:\n    def fetch(self):\n        return 1\n', 'beta/foo.py': 'class Client:\n    def fetch(self):\n        return 2\n',
        'm.py': 'import beta.foo\nimport alpha.foo\nconn = None\n\ndef init():\n    global conn\n    conn = alpha.foo.Client()\n\ndef cb(pool):\n    pool.submit(conn.fetch)\n' }, []],
      dotted_base_collision: [{ 'alpha/__init__.py': '', 'beta/__init__.py': '',
        'alpha/foo.py': 'class Client:\n    def fetch(self):\n        return 1\n', 'beta/foo.py': 'class Client:\n    def fetch(self):\n        return 2\n',
        'm.py': 'import beta.foo\nimport alpha.foo\n\nclass Sub(alpha.foo.Client):\n    pass\n\ndef go(pool, s: Sub):\n    pool.submit(s.fetch)\n' }, []],
    };
    const got: Record<string, string[]> = {};
    for (const [name, [files, _]] of Object.entries(cases)) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-fnref-global-${name}-`));
      const all = { 'store.py': 'class Store:\n    def fetch(self, ids):\n        return ids\n',
        'decoy.py': 'class Decoy:\n    def fetch(self, ids):\n        return []\n', ...files };
      for (const [file, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(tmpDir, file)), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, file), content);
      }
      const cg = CodeGraph.initSync(tmpDir);
      try {
        await cg.indexAll();
        got[name] = cg.getNodesByName('fetch').flatMap(t => cg.getIncomingEdges(t.id)
          .filter(e => e.kind === 'references' && e.metadata?.fnRef === true)
          .map(e => `${cg.getNode(e.source)?.name} -> ${t.qualifiedName}`)).sort();
      } finally { cg.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined; }
    }
    expect(got).toEqual(Object.fromEntries(Object.entries(cases).map(([name, [, want]]) => [name, want])));
  });

  it('#1820: a module global re-resolves after its module changes (sync)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-global-sync-'));
    const settings = 'from store import Store\nfrom decoy import Decoy\nconn = None\n\ndef init():\n    global conn\n    conn = Store()\n';
    const consumer = 'import settings\n\ndef cb(pool):\n    pool.submit(settings.conn.fetch)\n';
    fs.writeFileSync(path.join(tmpDir, 'store.py'), 'class Store:\n    def fetch(self, ids):\n        return ids\n');
    fs.writeFileSync(path.join(tmpDir, 'decoy.py'), 'class Decoy:\n    def fetch(self, ids):\n        return []\n');
    fs.writeFileSync(path.join(tmpDir, 'settings.py'), settings);
    fs.writeFileSync(path.join(tmpDir, 'consumer.py'), consumer);
    const cg = CodeGraph.initSync(tmpDir);
    const edges = () => cg.getNodesByName('fetch').flatMap(t => cg.getIncomingEdges(t.id)
      .filter(e => e.metadata?.fnRef === true).map(e => `${cg.getNode(e.source)?.name} -> ${t.qualifiedName}`));
    try {
      await cg.indexAll();
      expect(edges()).toEqual(['cb -> Store::fetch']);
      fs.writeFileSync(path.join(tmpDir, 'settings.py'), settings.replace('conn = Store()', 'conn = Decoy()'));
      fs.writeFileSync(path.join(tmpDir, 'consumer.py'), consumer + '\n# touched\n');
      await cg.sync();
      expect(edges()).toEqual(['cb -> Decoy::fetch']);
    } finally { cg.close(); }
  });

  it('#1820: Go receiver types disambiguate method values and reject external fields', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-go-scope-'));
    fs.writeFileSync(path.join(tmpDir, 'main.go'), `package demo
import "database/sql"
type Store struct{}
func (s *Store) Fetch() {}
type Decoy struct{}
func (d *Decoy) Fetch() {}
type Consumer struct { store *Store; external *sql.DB }
func (c *Consumer) Callback() { Submit(c.store.Fetch) }
func Typed(s *Store) { Submit(s.Fetch) }
func Assigned(s *Store) { cb := s.Fetch }
func Collected(s *Store) { table := []func(){s.Fetch} }
func MethodExpression() { Submit(Store.Fetch) }
func (c *Consumer) External() { Submit(c.external.Fetch) }
func Unknown(obj interface{}) { Submit(obj.Fetch) }
`);
    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const edges = fnRefEdgesInto(cg, 'Fetch');
      expect(sourceNames(cg, edges)).toEqual(['Assigned', 'Callback', 'Collected', 'MethodExpression', 'Typed']);
      expect(edges.every(e => cg.getNode(e.target)?.qualifiedName === 'Store::Fetch')).toBe(true);
    } finally { cg.close(); }
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
