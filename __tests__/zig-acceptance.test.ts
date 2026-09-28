import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { getParser } from '../src/extraction/grammars';
import recoveryCases from './fixtures/zig-recovery-cases.json';

let graph: CodeGraph | undefined;
let dir: string | undefined;
afterEach(() => { graph?.close(); graph = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('Zig recovery contract (not compiler-valid programs)', () => {
  for (const fixture of recoveryCases) it(fixture.name, async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-recovery-'));
    fs.writeFileSync(path.join(dir, 'main.zig'), fixture.source);
    fs.writeFileSync(path.join(dir, 'decoy.zig'), 'pub fn run()void{} pub fn handler()void{}');
    graph = await CodeGraph.init(dir, { index: true });
    const tree = getParser('zig')!.parse(fixture.source)!;
    try { expect(!tree.rootNode.hasError).toBe(fixture.wasmAccepted); } finally { tree.delete(); }
    const nodes = graph.getNodesInFile('main.zig').filter(n => n.kind !== 'file');
    expect(nodes.map(n => `${n.kind}:${n.qualifiedName}`).sort()).toEqual([...fixture.nodes].sort());
    const calls = nodes.flatMap(n => graph!.getOutgoingEdges(n.id).filter(e => e.kind === 'calls').map(e => {
      const target = graph!.getNode(e.target)!;
      expect(target.filePath).toBe('main.zig');
      return `${n.qualifiedName}->${target.qualifiedName}`;
    }));
    expect(calls.sort()).toEqual([...fixture.calls].sort());
  });
});

it('matches exact declaration kinds, ownership and calls for a controlled node schema', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-schema-'));
  fs.writeFileSync(path.join(dir, 'main.zig'), `pub const Label = u32;
pub const Widget = struct {
    value: Label,
    pub fn init() Widget { return .{ .value = 1 }; }
    pub fn run(self: *Widget) void { _ = self; }
};
pub const Mode = enum { on, off };
pub const Event = union(enum) { ready: Widget, idle };
pub const Handle = opaque {};
pub const Failure = error { Failed };
pub var count: u32 = 0;
pub const answer: u32 = 42;
pub fn entry() void { var widget = Widget.init(); widget.run(); }
`);
  graph = await CodeGraph.init(dir, { index: true });
  const nodes = graph.getNodesInFile('main.zig').filter(n => n.kind !== 'file');
  expect(nodes.map(n => `${n.kind}:${n.qualifiedName}`).sort()).toEqual([
    'type_alias:Label', 'struct:Widget', 'field:Widget::value', 'method:Widget::init', 'method:Widget::run',
    'enum:Mode', 'enum_member:Mode::on', 'enum_member:Mode::off', 'struct:Event',
    'enum_member:Event::ready', 'enum_member:Event::idle', 'struct:Handle', 'enum:Failure', 'enum_member:Failure::Failed',
    'variable:count', 'constant:answer', 'function:entry',
  ].sort());
  for (const n of nodes.filter(n => !n.qualifiedName.includes('::'))) expect(n.isExported).toBe(true);
  for (const n of nodes.filter(n => n.kind === 'enum_member')) expect(n.visibility).toBe('public');
  const entry = nodes.find(n => n.qualifiedName === 'entry')!;
  expect(graph.getOutgoingEdges(entry.id).filter(e => e.kind === 'calls').map(e => graph!.getNode(e.target)!.qualifiedName).sort()).toEqual(['Widget::init', 'Widget::run']);
  if (process.env.ZIG_COMPILER) {
    fs.writeFileSync(path.join(dir, 'check.zig'), 'const root=@import("main.zig");test{root.entry();}');
    const result = spawnSync(process.env.ZIG_COMPILER, ['test', 'check.zig'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  }
}, 90000);

it('has the same graph after alias, build, deletion and restoration edits as a clean index', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-parity-'));
  const build = (file: string) => `pub fn build(b: *Build) void { const lib=b.createModule(.{.root_source_file=b.path("${file}")});const root=b.createModule(.{.root_source_file=b.path("main.zig")});root.addImport("helper",lib); }`;
  fs.writeFileSync(path.join(dir, 'main.zig'), 'const lib=@import("helper");pub fn entry()void{lib.run();}');
  fs.writeFileSync(path.join(dir, 'a.zig'), 'pub fn run()void{}');
  fs.writeFileSync(path.join(dir, 'b.zig'), 'pub fn run()void{}');
  fs.writeFileSync(path.join(dir, 'build.zig'), build('a.zig'));
  graph = await CodeGraph.init(dir, { index: true });
  const snapshot = () => {
    const nodes = ['main.zig', 'a.zig', 'b.zig', 'build.zig'].flatMap(file => graph!.getNodesInFile(file));
    const key = (n: (typeof nodes)[number]) => `${n.filePath}:${n.kind}:${n.qualifiedName}`;
    return { nodes: nodes.map(key).sort(), edges: nodes.flatMap(n => graph!.getOutgoingEdges(n.id).map(e => `${key(n)}-${e.kind}->${key(graph!.getNode(e.target)!)}`)).sort() };
  };
  for (const mutate of [
    () => fs.writeFileSync(path.join(dir!, 'build.zig'), build('b.zig')),
    () => fs.unlinkSync(path.join(dir!, 'b.zig')),
    () => fs.writeFileSync(path.join(dir!, 'b.zig'), 'pub const run=actual; fn actual()void{}'),
  ]) {
    mutate(); await graph.sync(); const incremental = snapshot(); graph.close();
    graph = await CodeGraph.recreate(dir); await graph.indexAll();
    expect(snapshot()).toEqual(incremental);
  }
// Three sync/rebuild cycles can exceed Vitest's 5s default on Windows ARM runners.
}, 30000);
