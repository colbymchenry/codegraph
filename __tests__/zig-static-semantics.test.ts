import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { getParser } from '../src/extraction/grammars';
import cases from './fixtures/zig-static-cases.json';

let graph: CodeGraph | undefined;
let dir: string | undefined;
afterEach(() => { graph?.close(); graph = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
describe('Zig compiler-valid static semantics', () => {
  for (const fixture of cases) it(fixture.name, async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-static-'));
    for (const [file, source] of Object.entries(fixture.files)) fs.writeFileSync(path.join(dir, file), source!);
    // Optional in ordinary JS test runs; required by the Zig release verification job.
    const zig = process.env.ZIG_COMPILER;
    if (zig) {
      const exe = path.join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      const args = fixture.name === 'build_module' ? ['build', 'test'] : fixture.name === 'root_module' ? ['build-exe', 'main.zig', '-femit-bin=' + exe] : ['test', 'main.zig'];
      const result = spawnSync(zig, args, { cwd: dir, encoding: 'utf8', timeout: 60000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      if (fixture.name === 'root_module') expect(spawnSync(exe, [], { timeout: 10000 }).status).toBe(0);
    }
    graph = await CodeGraph.init(dir, { index: true });
    for (const source of Object.values(fixture.files)) {
      const tree = getParser('zig')!.parse(source!);
      try { expect(tree?.rootNode.hasError).toBe(false); } finally { tree?.delete(); }
    }
    const nodes = [...graph.getNodesByKind('function'), ...graph.getNodesByKind('method')];
    const key = (node: (typeof nodes)[number]) => node.filePath + '::' + node.qualifiedName;
    const caller = nodes.find(n => key(n) === fixture.caller);
    expect(caller).toBeDefined();
    const targets = graph.getOutgoingEdges(caller!.id).filter(e => e.kind === 'calls').map(e => key(graph!.getNode(e.target)!));
    expect(targets.sort()).toEqual((Array.isArray(fixture.target) ? fixture.target : fixture.target ? [fixture.target] : []).sort());
    if (fixture.name === 'quoted_spaces') {
      expect(nodes.filter(n => n.name === '@"two words"')).toHaveLength(1);
      expect(nodes.filter(n => n.name === 'twowords')).toHaveLength(1);
    }
  }, 90000);
});

describe('Zig alias invalidation and conservative resolution', () => {
  it('rebinds unchanged callers when a build registration changes and rejects conditional overrides', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-build-'));
    const fixture = cases.find(f => f.name === 'build_module')!;
    for (const [file, source] of Object.entries(fixture.files)) fs.writeFileSync(path.join(dir, file), source!);
    fs.writeFileSync(path.join(dir, 'other.zig'), 'pub fn run() void {}');
    graph = await CodeGraph.init(dir, { index: true });
    const targets = () => {
      const caller = graph!.getNodesByKind('function').find(n => n.name === 'entry')!;
      return graph!.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => graph!.getNode(e.target)!.filePath);
    };
    expect(targets()).toEqual(['lib.zig']);
    const build = fixture.files['build.zig']!;
    fs.writeFileSync(path.join(dir, 'build.zig'), build.replace('b.path("lib.zig")', 'b.path("other.zig")'));
    await graph.sync();
    expect(targets()).toEqual(['other.zig']);
    fs.writeFileSync(path.join(dir, 'build.zig'), build.replace('root.addImport("helper", lib);', 'root.addImport("helper", lib); if (b.option(bool, "override", "Override") orelse false) root.addImport("helper", lib);'));
    await graph.sync();
    expect(targets()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'build.zig'), build);
    await graph.sync();
    expect(targets()).toEqual(['lib.zig']);
  });
  it('rebinds unchanged callers when an intermediate alias changes', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-alias-'));
    fs.writeFileSync(path.join(dir, 'main.zig'), 'const api = @import("api.zig"); pub fn entry() void { api.run(); }');
    fs.writeFileSync(path.join(dir, 'lib.zig'), 'pub fn first() void {} pub fn second() void {}');
    fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib = @import("lib.zig"); pub const run = lib.first;');
    graph = await CodeGraph.init(dir, { index: true });
    const targets = () => {
      const caller = graph!.getNodesByKind('function').find(n => n.name === 'entry')!;
      return graph!.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => graph!.getNode(e.target)!.name);
    };
    expect(targets()).toEqual(['first']);
    fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib = @import("lib.zig"); pub const run = lib.second;');
    await graph.sync();
    expect(targets()).toEqual(['second']);
    fs.writeFileSync(path.join(dir, 'api.zig'), 'pub const run = run;');
    await graph.sync();
    expect(targets()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib = @import("lib.zig"); pub const run = lib.first;');
    await graph.sync();
    expect(targets()).toEqual(['first']);
  });
  it('rejects private imports and cyclic aliases instead of matching decoys', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-negative-'));
    fs.writeFileSync(path.join(dir, 'main.zig'), 'const lib = @import("lib.zig"); pub fn entry() void { lib.hidden(); lib.cycle(); lib.Public.secret(); }');
    fs.writeFileSync(path.join(dir, 'lib.zig'), 'fn hidden() void {} pub const cycle = other; const other = cycle; const Internal=struct{fn secret()void{}};pub const Public=Internal;');
    fs.writeFileSync(path.join(dir, 'decoy.zig'), 'pub fn hidden() void {} pub fn cycle() void {}');
    graph = await CodeGraph.init(dir, { index: true });
    const caller = graph.getNodesByKind('function').find(n => n.name === 'entry')!;
    expect(graph.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls')).toEqual([]);
  });
});

it('loads Zig bindings in a fresh packaged process and resolver workers', () => {
  const result = spawnSync(process.execPath, ['--liftoff-only', 'scripts/check-zig-package.mjs', '.'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CODEGRAPH_PARALLEL_RESOLVE_MIN: '0' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('incremental rebind and reopen passed');
}, 65000);
