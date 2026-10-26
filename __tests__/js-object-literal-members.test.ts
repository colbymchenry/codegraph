/**
 * A named object literal owns its function members (#2300). Members used to
 * become nodes only when the object was an `export const`; a plain `const`, an
 * object inside an IIFE and one hung on a path (`window.WS = {…}`) produced
 * none, so script-tag JavaScript was nearly invisible and the calls inside a
 * member were credited to the enclosing constant (or lost).
 *
 * Now each member is a `function` node qualified under its owner
 * (`store::shorthand`, `window.WS::wsM`), the calls written in it are its own,
 * and the calls that reach it — `App.init()`, `window.App.init()`, a sibling's
 * `this.render()`, `App.utils.pad()`, a classic script's `WS.wsM()` from
 * another file — resolve to it. A bare `init()` never does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel, resetKernelForTests } from '../src/extraction/kernel';

const kernelBuilt = fs.existsSync(path.join(__dirname, '../codegraph-kernel/prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));

describe.each(['native', 'wasm'].filter((backend) => backend === 'wasm' || kernelBuilt))(
  'object-literal members (%s, #2300)', (backend) => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_KERNEL', backend === 'wasm' ? '0' : '1');
    vi.stubEnv('CODEGRAPH_KERNEL_LANGS', 'all');
    resetKernelForTests();
    if (backend === 'native') expect(getKernel()).not.toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2300-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetKernelForTests();
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = await CodeGraph.init(dir, { index: true });
    return cg;
  }

  /** The one node with this qualified name (in `file`, when several share it). */
  function node(g: CodeGraph, qualifiedName: string, file?: string) {
    const found = g.getNodesByQualifiedName(qualifiedName).filter((n) => !file || n.filePath === file);
    expect(found, qualifiedName).toHaveLength(1);
    return found[0]!;
  }
  /** The qualified names at the other end of a node's `calls` edges. */
  const calls = (g: CodeGraph, id: string, direction: 'in' | 'out') =>
    (direction === 'in' ? g.getIncomingEdges(id) : g.getOutgoingEdges(id))
      .filter((e) => e.kind === 'calls')
      .map((e) => g.getNode(direction === 'in' ? e.source : e.target)!.qualifiedName)
      .sort();
  const callers = (g: CodeGraph, qn: string, file?: string) => calls(g, node(g, qn, file).id, 'in');
  const callees = (g: CodeGraph, qn: string, file?: string) => calls(g, node(g, qn, file).id, 'out');

  it('gives every container shape from the issue its members, and the calls in a member to that member', async () => {
    const g = await index({
      'src/a_export.ts': 'export const objTsExp = { tsExpM() { return 1; }, tsExpProp: () => 1 };\n',
      'src/b_plain.ts': 'const objTsPlain = { tsPlainM() { return 1; }, tsPlainProp: () => 1 };\n',
      'src/c_export.js': 'export const objJsExp = { jsExpM() { return 1; }, jsExpProp: () => 1 };\n',
      'src/d_plain.js': 'const objJsPlain = { jsPlainM() { return 1; }, jsPlainProp: () => 1 };\n',
      'src/e_iife.js': [
        '(function () {',
        '  const objIife = { iifeM() { return 1; } };',
        '  window.WS = { wsM() { return objIife.iifeM(); } };',
        '})();',
        '',
      ].join('\n'),
      'src/f_calls.js': [
        'function helper() { return 2; }',
        'var store = { shorthand() { return helper(); } };',
        'function useStore() { return store.shorthand(); }',
        'window.api = { load() { return store.shorthand(); } };',
        'function viaWindow() { return window.WS.wsM(); }',
        'function viaGlobal() { return WS.wsM(); }',
        '',
      ].join('\n'),
    });

    for (const qn of [
      'objTsExp::tsExpM', 'objTsExp::tsExpProp', 'objTsPlain::tsPlainM', 'objTsPlain::tsPlainProp',
      'objJsExp::jsExpM', 'objJsExp::jsExpProp', 'objJsPlain::jsPlainM', 'objJsPlain::jsPlainProp',
      'objIife::iifeM', 'window.WS::wsM', 'store::shorthand', 'window.api::load',
    ]) {
      expect(node(g, qn).kind, qn).toBe('function');
    }
    // The member belongs to its owner, and `window.WS` is the global `WS`.
    const plain = node(g, 'objTsPlain');
    expect(g.getOutgoingEdges(plain.id).filter((e) => e.kind === 'contains').map((e) => g.getNode(e.target)!.name).sort())
      .toEqual(['tsPlainM', 'tsPlainProp']);
    expect(g.getNodesByName('WS').map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual(['variable window.WS']);
    // An exported literal's members stay exported, a plain one's do not.
    expect(node(g, 'objTsExp::tsExpM').isExported).toBe(true);
    expect(node(g, 'objTsPlain::tsPlainM').isExported).toBeFalsy();

    // The call inside a member is the member's, not the constant's.
    expect(callers(g, 'helper')).toEqual(['store::shorthand']);
    expect(callers(g, 'objIife::iifeM')).toEqual(['window.WS::wsM']);
    expect(callers(g, 'store::shorthand')).toEqual(['useStore', 'window.api::load']);
    // `window.WS.wsM()`, and `WS.wsM()` from another classic script.
    expect(callers(g, 'window.WS::wsM')).toEqual(['viaGlobal', 'viaWindow']);
  });

  it('resolves through the object the call names — never by the bare name', async () => {
    const g = await index({
      'app.js': [
        'function init() { return "global"; }',
        'var App = {',
        '  init: function () { this.render(); helpers.fmt(); },',
        '  render: function () { return 1; },',
        '};',
        'var helpers = { fmt() { return 2; } };',
        'App.utils = { pad(s) { return s; } };',
        'function boot() { App.init(); App.utils.pad("x"); init(); }',
        'dw_page = { start() { App.render(); } };',
        '',
      ].join('\n'),
      'page.js': [
        'function main() { App.init(); window.App.render(); dw_page.start(); App.utils.pad("y"); }',
        'function shadow(App) { return App.init(); }',
        'function bare() { return render(); }',
        '',
      ].join('\n'),
    });

    expect(callees(g, 'boot')).toEqual(['App.utils::pad', 'App::init', 'init']);
    expect(callees(g, 'App::init')).toEqual(['App::render', 'helpers::fmt']);
    expect(callees(g, 'dw_page::start')).toEqual(['App::render']);
    // Another script reaches the page's globals; a parameter of the same name does not.
    expect(callees(g, 'main')).toEqual(['App.utils::pad', 'App::init', 'App::render', 'dw_page::start']);
    expect(callees(g, 'shadow')).toEqual([]);
    // `render()` alone is not `App.render`, and `init()` stays the global function.
    expect(callees(g, 'bare')).toEqual([]);
    expect(callers(g, 'init')).toEqual(['boot']);
  });

  it('never takes an object hung on a path, or one local to an IIFE, for a name elsewhere', async () => {
    const g = await index({
      // A Svelte project, where `$count` reads the store `count` — in a `.svelte` component.
      'package.json': '{ "dependencies": { "svelte": "^4.0.0" } }\n',
      'lib.js': [
        '$.event.special.swipe = { setup: function () { return 1; } };',
        'todos.model = { add: function () { return 2; } };',
        '(function () { var n = { touch: function () { return 3; } }; n.touch(); })();',
        '',
      ].join('\n'),
      'widget.js': [
        'var Widget = {',
        '  drag: function () { this.swipe(1); },',
        '  make: function () { return new this.model(); },',
        '};',
        '',
      ].join('\n'),
      // Two compiled scripts, each with its own `$n`.
      'gwt1.js': 'function $n(a) { this.a = a; }\nfunction make1() { return new $n(1); }\n',
      'gwt2.js': 'function $n(a) { this.a = a; }\nfunction make2() { return new $n(2); }\n',
    });
    const edges = (qn: string) => g.getOutgoingEdges(node(g, qn).id).filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${g.getNode(e.target)!.qualifiedName} ${g.getNode(e.target)!.filePath}`);
    // `this.swipe()` and `new this.model()` are not the objects at `$.event.special.swipe` and `todos.model`.
    expect(edges('Widget::drag')).toEqual([]);
    expect(edges('Widget::make')).toEqual([]);
    // A plain script's `$n` is its own function, not a store read of the IIFE's `n`.
    expect(edges('make1')).toEqual(['instantiates $n gwt1.js']);
    expect(edges('make2')).toEqual(['instantiates $n gwt2.js']);
  });

  it('keeps each IIFE and function its own literal, and a module its private ones', async () => {
    const g = await index({
      'iife.js': [
        '(function () { const Api = { run() { left(); } }; Api.run(); })();',
        '(function () { const Api = { run() { right(); } }; Api.run(); })();',
        'function left() {}',
        'function right() {}',
        'function outside() { return Api.run(); }',
        'function a() { const local = { go() { left(); } }; local.go(); }',
        'function b() { const local = { go() { right(); } }; local.go(); }',
        '',
      ].join('\n'),
      'mod.js': 'import { x } from "./x.js";\nconst Local = { run() { return x; } };\nexport function useLocal() { return Local.run(); }\n',
      'other.js': 'import { y } from "./y.js";\nexport function nope() { return Local.run(y); }\n',
    });

    const [first, second] = g.getNodesByQualifiedName('Api::run').sort((p, q) => p.startLine - q.startLine);
    expect(calls(g, first!.id, 'out')).toEqual(['left']);
    expect(calls(g, second!.id, 'out')).toEqual(['right']);
    // Each IIFE's `Api.run()` reaches its own literal (the file runs both).
    expect(calls(g, first!.id, 'in')).toEqual(['iife.js']);
    expect(calls(g, second!.id, 'in')).toEqual(['iife.js']);
    // Outside both IIFEs, `Api` is neither of them — not even as a value read.
    expect(callees(g, 'outside')).toEqual([]);
    expect(g.getOutgoingEdges(node(g, 'outside').id).filter((e) => e.kind !== 'contains')).toEqual([]);
    expect(callees(g, 'a')).toEqual(['a::local::go']);
    expect(callees(g, 'b')).toEqual(['b::local::go']);
    expect(callees(g, 'useLocal')).toEqual(['Local::run']);
    expect(callees(g, 'nope')).toEqual([]);
  });

  it('gives arrow members and values the `this` of the method around the literal', async () => {
    const g = await index({
      'app.ts': [
        'class Emitter { on(cb: () => void) { return cb; } }',
        'export class App {',
        '  private emitter = new Emitter();',
        '  updateScene() { return 1; }',
        '  createApi() {',
        '    const api = {',
        '      updateScene: this.updateScene,',
        '      onChange: (cb: () => void) => this.emitter.on(cb),',
        '      refresh: () => this.updateScene(),',
        '      own() { return this.refresh(); },',
        '    };',
        '    return api;',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    // A value in a method's literal is that method's own reference, as before.
    const createApi = node(g, 'App::createApi');
    expect(g.getOutgoingEdges(createApi.id).filter((e) => e.kind === 'references')
      .map((e) => g.getNode(e.target)!.qualifiedName)).toContain('App::updateScene');
    // An arrow member's `this` is the class instance…
    expect(callees(g, 'App::createApi::api::onChange')).toEqual(['Emitter::on']);
    expect(callees(g, 'App::createApi::api::refresh')).toEqual(['App::updateScene']);
    // …an object's own method's `this` is the object.
    expect(callees(g, 'App::createApi::api::own')).toEqual(['App::createApi::api::refresh']);
  });

  it('keeps a cross-file member edge through edits of the defining script', async () => {
    const g = await index({
      'ns.js': 'window.WS = { a() { return 1; }, wsM() { return 2; } };\n',
      'use.js': 'function viaGlobal() { return WS.wsM(); }\n',
    });
    expect(callers(g, 'window.WS::wsM')).toEqual(['viaGlobal']);
    fs.writeFileSync(path.join(dir, 'ns.js'), '// moved\nwindow.WS = {\n  wsM() { return 3; },\n};\n');
    await g.sync();
    expect(callers(g, 'window.WS::wsM')).toEqual(['viaGlobal']);
    fs.writeFileSync(path.join(dir, 'ns.js'), 'window.WS = { renamed() { return 4; } };\n');
    await g.sync();
    expect(g.getNodesByQualifiedName('window.WS::wsM')).toEqual([]);
    expect(callees(g, 'viaGlobal')).toEqual([]);
  }, 30_000);

  it('reaches an imported literal and a binding destructured off one', async () => {
    const g = await index({
      'api.js': [
        'export const api = { get() { return 1; }, post() { return 2; } };',
        'const { post } = api;',
        'export function b() { return post(); }',
        'export function c() { return get(); }',
        '',
      ].join('\n'),
      'use.js': [
        'import { api } from "./api.js";',
        'export function a() { return api.get(); }',
        '',
      ].join('\n'),
    });
    expect(callees(g, 'a')).toEqual(['api::get']);
    expect(callees(g, 'b')).toEqual(['api::post']);
    // `get` was never destructured: a bare `get()` is not `api.get`.
    expect(callees(g, 'c')).toEqual([]);
  });

  it('leaves CommonJS exports, prototypes, call arguments, data and minified bundles as they were', async () => {
    const g = await index({
      'shapes.js': [
        'module.exports = { cjs() { return 1; } };',
        'Foo.prototype = { proto() { return 1; } };',
        'consume({ ephemeral() { return 1; } });',
        'const data = { a: 1, b: [1, 2] };',
        'this.state = { onThis() { return 1; } };',
        '',
      ].join('\n'),
      'vendor/lib.min.js': 'var a={b:function(){return 1},c:function(){return 2}};window.L={d:function(){return a.b()}};\n',
      // A bundle not named so: its lines are what gives it away.
      'dist/bundle.js': `${'var q={b:function(){return r(1,2)},c:function(s){return s}};window.M={d:function(){return q.b()}};'.repeat(60)}\n`.repeat(2),
      'iife.js': '(function () { var e; if (!e) { e = { getItem: function () { return 1; } }; } })();\n',
    });
    // …and a plain name reassigned inside a function (a bundle's `e = {…}`) is a local.
    for (const name of ['cjs', 'proto', 'ephemeral', 'onThis', 'b', 'c', 'd', 'getItem']) {
      expect(g.getNodesByName(name), name).toEqual([]);
    }
    expect(node(g, 'data').kind).toBe('constant');
  });

  it('keeps a <script setup> literal\'s members under their owner', async () => {
    const g = await index({
      'Panel.vue': [
        '<template><button @click="save">Save</button></template>',
        '<script setup>',
        'const handlers = { onSave() { persist(); } };',
        'function persist() {}',
        'function save() { handlers.onSave(); }',
        '</script>',
        '',
      ].join('\n'),
    });
    const owner = node(g, 'handlers');
    const member = node(g, 'handlers::onSave');
    expect(g.getIncomingEdges(member.id).filter((e) => e.kind === 'contains').map((e) => e.source)).toEqual([owner.id]);
    expect(callees(g, 'handlers::onSave')).toEqual(['persist']);
    expect(callees(g, 'save')).toEqual(['handlers::onSave']);
  });
});
