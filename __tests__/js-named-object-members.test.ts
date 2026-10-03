import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { resetKernelForTests, getKernel } from '../src/extraction/kernel';

describe.each(['native', 'wasm'])('named literal ownership (%s)', mode => {
  let root: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_KERNEL', mode === 'wasm' ? '0' : '1');
    vi.stubEnv('CODEGRAPH_KERNEL_LANGS', 'all');
    resetKernelForTests();
    if (mode === 'native') expect(getKernel()).not.toBeNull();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-named-literal-'));
  });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetKernelForTests();
  });
  function write(file: string, source: string) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  async function index(files: Record<string, string>) {
    for (const [file, source] of Object.entries(files)) write(file, source);
    cg = await CodeGraph.init(root, { index: true });
  }
  const symbol = (name: string) => {
    const nodes = cg!.getNodesByQualifiedName(name);
    expect(nodes, name).toHaveLength(1);
    return nodes[0]!;
  };
  const callees = (name: string) => cg!.getOutgoingEdgesFrom([symbol(name).id]).filter(e => e.kind === 'calls').map(e => cg!.getNode(e.target)!);

  it('direct plain/exported members own their calls, while primitive locals and factory noise remain absent', async () => {
    await index({ 'objects.js': `function helper() {}
const Api = { read() { helper(); }, close: () => helper(), eager: helper() };
export const Exported = { save: function () { helper(); } };
function useApi() { Api.read(); Api.close(); }
function bare() { read(); setTimeout(read); }
const factory = wrap(() => ({ shouldNotExtract() { helper(); } }));
consume({ ephemeral() { helper(); } });
function local() { const primitive = 1; const data = { x: 1 }; const wrapped = wrap(() => ({ noise() {} })); }
` });
    const owner = symbol('Api');
    const read = symbol('Api::read');
    expect(cg!.getOutgoingEdgesFrom([owner.id]).find(e => e.target === read.id && e.kind === 'contains')?.metadata?.jsObjectMember).toBe(true);
    expect(callees('Api::read').map(n => n.name)).toEqual(['helper']);
    expect(callees('Api::close').map(n => n.name)).toEqual(['helper']);
    expect(callees('Exported::save').map(n => n.name)).toEqual(['helper']);
    expect(callees('useApi').map(n => n.id).sort()).toEqual([read.id, symbol('Api::close').id].sort());
    expect(callees('bare')).toEqual([]);
    for (const name of ['shouldNotExtract', 'ephemeral', 'primitive', 'data', 'wrapped', 'noise']) expect(cg!.getNodesByName(name)).toEqual([]);
    expect(callees('Api').filter(n => n.name === 'helper')).toHaveLength(1); // eager value, not method-body duplication.
  });

  it('same-line sibling IIFEs retain exact lexical ownership after Unicode and reject outside use', async () => {
    const source = '/* русский 😀 */ (function(){const Api={run(){left()}};Api.run()})(); (function(){const Api={run(){right()}};Api.run()})(); function left(){} function right(){} function outside(){Api.run()}';
    await index({ 'iife.js': source });
    const members = cg!.getNodesByQualifiedName('Api::run').sort((a, b) => a.startColumn - b.startColumn);
    expect(members).toHaveLength(2);
    expect(members.map(n => n.startColumn)).toEqual([source.indexOf('run(){left'), source.indexOf('run(){right')]);
    const incoming = cg!.getOutgoingEdgesFrom(cg!.getNodesInFile('iife.js').map(n => n.id)).filter(e => e.kind === 'calls' && members.some(n => n.id === e.target));
    expect(incoming.map(e => e.target).sort()).toEqual(members.map(n => n.id).sort());
    expect(cg!.getOutgoingEdgesFrom([members[0]!.id]).filter(e => e.kind === 'calls').map(e => cg!.getNode(e.target)!.name)).toEqual(['left']);
    expect(cg!.getOutgoingEdgesFrom([members[1]!.id]).filter(e => e.kind === 'calls').map(e => cg!.getNode(e.target)!.name)).toEqual(['right']);
    expect(callees('outside')).toEqual([]);
  });

  it('global namespaces from IIFEs reach their own full paths, never namesakes or shadowed roots', async () => {
    await index({ 'namespace.js': `function left(){} function right(){}
(function(){window.A={run(){left()}}})();
window.B={run(){right()}};
window.Known={run:left}; function useAlias(){window.Known.run()}
function useA(){window.A.run()} function useB(){window.B.run()}
function missing(){window.Missing.run();window.deep.A.run()}
function shadowed(window){window.A.run();setTimeout(window.A.run)}
const ns={}; ns.mod={run(){left()}}; function useNs(){ns.mod.run()}
function setup(){ns.late={run(){right()}}} function useLate(){ns.late.run()}
` });
    expect(callees('useA').map(n => n.id)).toEqual([symbol('window.A::run').id]);
    expect(callees('useB').map(n => n.id)).toEqual([symbol('window.B::run').id]);
    expect(callees('useAlias').map(n => n.id)).toEqual([symbol('left').id]);
    expect(callees('useNs').map(n => n.id)).toEqual([symbol('ns.mod::run').id]);
    expect(callees('useLate').map(n => n.id)).toEqual([symbol('ns.late::run').id]);
    expect(callees('missing')).toEqual([]);
    expect(callees('shadowed')).toEqual([]);
  });

  it('unknown host namespaces reject class decoys while lexical window holders/typed parameters keep their targets', async () => {
    await index({
      'umd.js': `(function (root, factory) { root.Umd = factory(); })(this, function () { function create(){} return { create }; });
function useUmd(){window.Umd.create()}
`,
      'hosts.ts': `class Service { ping(){} }
function unknownWindow(){window.Missing.ping()}
function unknownGlobal(){globalThis.Missing.ping()}
function unknownSelf(){self.Missing.ping()}
function typedWindow(window:Service){window.ping()}
`,
      'lexical.ts': `const window={}; window.MyNs={ping(){return 1}};
function lexicalWindow(){window.MyNs.ping()}
`,
    });
    for (const name of ['unknownWindow', 'unknownGlobal', 'unknownSelf']) expect(callees(name)).toEqual([]);
    // No `window.Umd = {…}` is indexed: the #1707 window escape still reaches a free function.
    expect(callees('useUmd').map(n => n.id)).toEqual([symbol('create').id]);
    expect(callees('typedWindow').map(n => n.id)).toEqual([symbol('Service::ping').id]);
    expect(callees('lexicalWindow').map(n => n.id)).toEqual([symbol('window.MyNs::ping').id]);
  });

  it('calls named by their bare member keep their usual targets unless a literal proves the receiver', async () => {
    await index({ 'bare.ts': `class Node { childForFieldName(name: string): Node | null { return null; } }
function typed(root: Node) { const cls: Node = root; return cls.childForFieldName('body'); }
class K { a() {} b() { const self = this; return () => self.a(); } }
const cls = { pick() {} };
function literal() { cls.pick(); }
` });
    expect(callees('typed').map(n => n.id)).toEqual([symbol('Node::childForFieldName').id]);
    expect(callees('K::b').map(n => n.id)).toEqual([symbol('K::a').id]);
    expect(callees('literal').map(n => n.id)).toEqual([symbol('cls::pick').id]);
  });

  it('global shorthand aliases use the initializer binding, including anonymous scopes and unindexed shadows', async () => {
    await index({ 'aliases.js': `function ping(){}
window.Root={ping}; function rootAlias(){window.Root.ping()}
(function(ping){window.Parameter={ping}})(external);
(function({ping}){window.Destructured={ping}})(external);
(function(){const ping=external;window.Value={ping}})();
(function(){window.Closure={ping}})();
(function(){const ping=()=>1;window.Local={ping}})();
const Named={run:function ping(){window.Named={ping}}};
(function ping(){window.NamedIife={ping}})();
function parameterAlias(){window.Parameter.ping()}
function destructuredAlias(){window.Destructured.ping()}
function valueAlias(){window.Value.ping()}
function closureAlias(){window.Closure.ping()}
function localAlias(){window.Local.ping()}
function namedAlias(){window.Named.ping()}
function namedIifeAlias(){window.NamedIife.ping()}
` });
    const outer = cg!.getNodesByQualifiedName('ping').find(n => n.startLine === 1)!;
    const inner = cg!.getNodesByQualifiedName('ping').find(n => n.startLine !== 1)!;
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(callees('rootAlias').map(n => n.id)).toEqual([outer.id]);
    expect(callees('closureAlias').map(n => n.id)).toEqual([outer.id]);
    expect(callees('localAlias').map(n => n.id)).toEqual([inner.id]);
    for (const name of ['parameterAlias', 'destructuredAlias', 'valueAlias', 'namedAlias', 'namedIifeAlias']) expect(callees(name)).toEqual([]);
  });

  it('nearest literals close missing-member fallback; parameters and nonliteral class values preserve typed calls', async () => {
    await index({ 'shadow.ts': `class Service { read(){return 1} }
const Api={read(){return 2},Api(){return Api.read()},window(){return window.A.run()}};
window.A={run(){return 3}};
function parameter(Api:Service){return Api.read()}
function nonliteral(){const Api=new Service();return Api.read()}
function block(){const Api={other(){}};Api.read();setTimeout(Api.read);const alias=Api.read}
function hoisted(){if(flag){var Local={read(){return 4}}}Local.read()}
function caught(){try{}catch(Api){Api.read()}}
` });
    expect(callees('parameter').map(n => n.id)).toEqual([symbol('Service::read').id]);
    expect(callees('nonliteral').map(n => n.id)).toEqual([symbol('Service::read').id]);
    expect(callees('block')).toEqual([]);
    expect(callees('caught').some(n => n.id === symbol('Api::read').id)).toBe(false);
    expect(callees('hoisted').map(n => n.id)).toEqual([symbol('hoisted::Local::read').id]);
    expect(callees('Api::Api').map(n => n.id)).toEqual([symbol('Api::read').id]);
    expect(callees('Api::window').map(n => n.id)).toEqual([symbol('window.A::run').id]);
  });

  it('last own property and unknown writes keep their established precision boundary', async () => {
    await index({ 'writes.js': `const Replaced={run(){},run:0};
const SpreadAfter={run(){},...unknown};
const SpreadBefore={...unknown,run(){}};
const Computed={run(){},[unknownKey]:0};
const Nested={box:{run(){}},other(){function run(){};run()}};
function replaced(){Replaced.run()} function after(){SpreadAfter.run()}
function before(){SpreadBefore.run()} function computed(){Computed.run()}
function nested(){Nested.run()}
` });
    expect(callees('replaced')).toEqual([]);
    expect(callees('after')).toEqual([]);
    expect(callees('computed')).toEqual([]);
    expect(callees('nested')).toEqual([]);
    expect(callees('before').map(n => n.id)).toEqual([symbol('SpreadBefore::run').id]);
  });

  it('explicit reassignments/writes and competing globals never keep an obsolete literal target', async () => {
    await index({ 'mutations.js': `let Reassigned={read(){oldHelper()}}; Reassigned=makeExternal();
const Overwritten={read(){oldHelper()},kept(){}}; Overwritten.read=external;
window.A={read(){oldHelper()}};
function redefine(){window.A={read(){newerHelper()}}}
function reassign(){Reassigned.read()} function overwrite(){Overwritten.read()}
function kept(){Overwritten.kept()} function global(){window.A.read()}
function oldHelper(){} function newerHelper(){}
` });
    expect(callees('reassign')).toEqual([]);
    expect(callees('overwrite')).toEqual([]);
    expect(callees('global')).toEqual([]);
    expect(callees('kept').map(n => n.id)).toEqual([symbol('Overwritten::kept').id]);
  });

  it('named function expressions retain their real self binding; a parameter closes self/outer guesses', async () => {
    await index({ 'self.js': `function helper(){}
const Api={read:function helper(){helper()}, opaque:function helper(helper){helper()}, method(){method()}};
function use(){Api.read();Api.opaque(external)}
` });
    expect(callees('Api::read').every(n => n.id === symbol('Api::read').id)).toBe(true); // self edges may be omitted by the public graph.
    expect(callees('Api::opaque')).toEqual([]);
    expect(callees('Api::method')).toEqual([]);
  });

  it('script folding keeps containment provenance and offsets for SFC literal holders/members', async () => {
    await index({ 'App.vue': `<template><div /></template>
<script lang="ts">
const Api={read(){return 1}};
function consume(){Api.read()}
function nested(){const inner={read(){return 2}};inner.read()}
</script>
` });
    expect(callees('consume').map(n => n.id)).toEqual([symbol('Api::read').id]);
    expect(callees('nested').map(n => n.id)).toEqual([symbol('nested::inner::read').id]);
    const owner = symbol('Api');
    const edge = cg!.getOutgoingEdgesFrom(cg!.getNodesInFile('App.vue').map(n => n.id)).find(e => e.kind === 'contains' && e.target === owner.id)!;
    expect((edge.metadata?.jsObject as { binding: string }).binding).toBe(`binding:${owner.startLine}:${owner.startColumn}`);
    expect(cg!.getOutgoingEdgesFrom([owner.id]).find(e => e.target === symbol('Api::read').id && e.kind === 'contains')?.metadata?.jsObjectMember).toBe(true);
  });

  it('deferred candidates support later declarations and survive target-only sync/reopen', async () => {
    await index({
      'api.js': 'window.B={read(){return 2}};window.A={read(){return 1}};\n',
      'use.js': 'export function consume(){window.A.read()}\n',
      'later.js': 'export const later=()=>Api.read();const Api={read(){return 3}};\n',
    });
    expect(callees('later').map(n => n.id)).toEqual([symbol('Api::read').id]);
    expect(callees('consume').map(n => n.id)).toEqual([symbol('window.A::read').id]);
    const edge = cg!.getOutgoingEdgesFrom([symbol('consume').id]).find(e => e.kind === 'calls')!;
    expect(edge.metadata?.refCandidates).toEqual(['window.A::read']);
    write('api.js', 'window.A={read(){return 5}};window.B={read(){return 4}};\n');
    await cg!.sync();
    expect(callees('consume').map(n => n.id)).toEqual([symbol('window.A::read').id]);
    cg!.close();
    cg = CodeGraph.openSync(root);
    expect(callees('consume').map(n => n.id)).toEqual([symbol('window.A::read').id]);
    expect(cg.getOutgoingEdgesFrom([symbol('consume').id]).find(e => e.kind === 'calls')?.metadata?.refCandidates).toEqual(['window.A::read']);
    write('api.js', 'window.A={renamed(){return 6}};window.B={read(){return 4}};\n');
    await cg.sync();
    expect(callees('consume')).toEqual([]);
    const unavailable = cg.getUnresolvedReferencesFrom(symbol('consume').id)
      .find(ref => ref.referenceName === 'window.A.read');
    expect(unavailable?.candidates).toEqual(['window.A::read']);
    cg.close();
    cg = CodeGraph.openSync(root);
    expect(callees('consume')).toEqual([]);
  });

  it('imported literal members keep qualified ownership through same-line target reorder and reopen', async () => {
    await index({
      'api.js': 'export const B={read(){return 2}};export const A={read(){return 1}};\n',
      'use.js': "import { A } from './api';export function consume(){A.read()}\n",
    });
    expect(callees('consume').map(n => n.id)).toEqual([symbol('A::read').id]);
    const edge = cg!.getOutgoingEdgesFrom([symbol('consume').id]).find(e => e.kind === 'calls')!;
    expect(edge.metadata?.refName).toBe('A.read');
    expect(edge.metadata?.refCandidates).toBeUndefined();
    write('api.js', 'export const A={read(){return 5}};export const B={read(){return 4}};\n');
    await cg!.sync();
    expect(callees('consume').map(n => n.id)).toEqual([symbol('A::read').id]);
    cg!.close();
    cg = CodeGraph.openSync(root);
    expect(callees('consume').map(n => n.id)).toEqual([symbol('A::read').id]);
    write('api.js', 'export const A={renamed(){return 6}};export const B={read(){return 4}};\n');
    await cg.sync();
    expect(callees('consume')).toEqual([]);
    cg.close();
    cg = CodeGraph.openSync(root);
    expect(callees('consume')).toEqual([]);
  });

  it('parallel parse/store/resolution preserves ownership instead of borrowing a same-named file', async () => {
    vi.stubEnv('CODEGRAPH_PARSE_WORKERS', '2');
    vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '0');
    vi.stubEnv('CODEGRAPH_RESOLVE_WORKERS', '2');
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`file-${i}.js`] = `const Api={run(){return ${i}}};function consume${i}(){Api.run()}`;
    await index(files);
    for (let i = 0; i < 20; i++) {
      const result = callees(`consume${i}`);
      expect(result).toHaveLength(1);
      expect(result[0]!.filePath).toBe(`file-${i}.js`);
      expect(result[0]!.qualifiedName).toBe('Api::run');
    }
  });
});
