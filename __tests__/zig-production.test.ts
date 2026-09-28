import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource, initGrammars, loadGrammarsForLanguages } from '../src/extraction';
import { getParser } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['zig']);
});

describe('Zig production regressions', () => {
  it.each(['struct', 'enum', 'union', 'opaque'])('parses an empty %s without synthetic missing fields', kind => {
    const tree = getParser('zig')!.parse(`const Empty = ${kind} {};`)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });

  it('keeps initializer calls when an argument imports a module', () => {
    const result = extractFromSource('main.zig', 'const value = wrap(@import("a.zig"), other());');
    expect(result.nodes.find(n => n.name === 'value')?.kind).toBe('constant');
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName)).toEqual(expect.arrayContaining(['wrap', 'other']));
    const value = result.nodes.find(n => n.name === 'value')!;
    expect(result.unresolvedReferences.find(r => r.referenceName === 'wrap')?.fromNodeId).toBe(value.id);
  });

  it('preserves tagged union payload type dependencies', () => {
    const result = extractFromSource('main.zig', 'const Value = union(enum) { item: Payload, empty };');
    expect(result.unresolvedReferences.some(r => r.referenceName === 'Payload' && r.referenceKind === 'references')).toBe(true);
  });

  it('unwraps the success type of explicit error unions and @This()', () => {
    const result = extractFromSource('main.zig', 'fn create() Failure!Widget { unreachable; } const Widget = struct { pub fn init() @This() { unreachable; } };');
    expect(result.nodes.find(n => n.name === 'create')?.returnType).toBe('Widget');
    expect(result.nodes.find(n => n.name === 'init')?.returnType).toBe('self');
  });

  it('keeps enclosing containers in nested method qualified names', () => {
    const result = extractFromSource('main.zig', 'const Outer = struct { const Inner = struct { fn run(self: *Inner) void {} }; };');
    expect(result.nodes.find(n => n.name === 'run')?.qualifiedName).toBe('Outer::Inner::run');
  });

  it('preserves namespace-qualified type references', () => {
    const result = extractFromSource('main.zig', 'fn consume(value: lib.Payload) void {}');
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'references').map(r => r.referenceName)).toEqual(['lib.Payload']);
  });

  it('reads unnamed parameter types from the grammar type field', () => {
    const result = extractFromSource('main.zig', 'extern fn consume(Payload) void;');
    expect(result.unresolvedReferences.some(r => r.referenceName === 'Payload')).toBe(true);
  });

  it('does not truncate C include paths or lose builtin arguments containing comments', () => {
    const header = 'headers/' + 'x'.repeat(100) + '.h';
    const result = extractFromSource('main.zig', `const c = @cImport({ @cInclude(// header
"${header}"); });`);
    expect(result.nodes.filter(n => n.kind === 'import').map(n => n.name)).toEqual([header]);
  });

  it('keeps field default calls and local variable type dependencies', () => {
    const result = extractFromSource('main.zig', 'const Box = struct { value: u32 = defaultValue() }; fn use() void { var value: Payload = undefined; }');
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'calls' && r.referenceName === 'defaultValue')).toBe(true);
    expect(result.unresolvedReferences.some(r => r.referenceKind === 'references' && r.referenceName === 'Payload')).toBe(true);
  });

  it('extracts each nested import once without swallowing surrounding builtin calls', () => {
    const result = extractFromSource('main.zig', 'fn use() void { const value = @as(@import("a.zig").Thing, make()); }');
    expect(result.nodes.filter(n => n.kind === 'import').map(n => n.name)).toEqual(['a.zig']);
    expect(result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName)).toEqual(expect.arrayContaining(['@as', 'make']));
  });

  it('finds the returned generic container rather than an unrelated local type', () => {
    const result = extractFromSource('main.zig', 'fn Box(comptime T: type) type { const Helper = struct { wrong: u32 }; validate(T); return struct { value: T }; }');
    expect(result.nodes.find(n => n.name === 'value')?.qualifiedName).toBe('Box::Box::value');
    expect(result.unresolvedReferences.some(r => r.referenceName === 'validate' && r.referenceKind === 'calls')).toBe(true);
  });

  let cg: CodeGraph | undefined;
  let dir: string | undefined;
  afterEach(() => { cg?.destroy(); cg = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('resolves sibling imports and aliases without choosing same-named decoys', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-production-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.zig'), 'const lib = @import("lib.zig");\npub fn entry() void { lib.run(); }');
    fs.writeFileSync(path.join(dir, 'src', 'lib.zig'), 'pub fn run() void {}');
    fs.writeFileSync(path.join(dir, 'lib.zig'), 'pub fn run() void {}');
    cg = await CodeGraph.init(dir, { index: true });
    cg.resolveReferences();
    const entry = cg.getNodesByKind('function').find(n => n.name === 'entry')!;
    const run = cg.getNodesByKind('function').find(n => n.name === 'run' && n.filePath === 'src/lib.zig')!;
    expect(cg.getOutgoingEdges(entry.id).filter(e => e.kind === 'calls').map(e => e.target)).toEqual([run.id]);
    const imp = cg.getNodesByKind('import').find(n => n.filePath === 'src/main.zig')!;
    const file = cg.getNodesByKind('file').find(n => n.filePath === 'src/lib.zig')!;
    expect(cg.getOutgoingEdges(imp.id).filter(e => e.kind === 'imports').map(e => e.target)).toEqual([file.id]);
    fs.writeFileSync(path.join(dir, 'src', 'lib.zig'), 'pub fn renamed() void {}');
    await cg.sync();
    expect(cg.getOutgoingEdges(entry.id).filter(e => e.kind === 'calls')).toEqual([]);
    fs.writeFileSync(path.join(dir, 'src', 'lib.zig'), 'pub fn run() void {}');
    await cg.sync();
    expect(cg.getOutgoingEdges(entry.id).filter(e => e.kind === 'calls').map(e => e.target)).toEqual([run.id]);
  });

  it('resolves local import aliases within their own scopes and rejects missing targets', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-scopes-'));
    fs.writeFileSync(path.join(dir, 'main.zig'), `const lib = @import("a.zig");
pub fn first() void { const lib = @import("b.zig"); lib.run(); }
pub fn second() void { lib.run(); }
pub fn missing() void { const lib = @import("missing.zig"); lib.run(); }
pub fn named() void { const execute = @import("b.zig").run; execute(); }
`);
    fs.writeFileSync(path.join(dir, 'a.zig'), 'pub fn run() void {}');
    fs.writeFileSync(path.join(dir, 'b.zig'), 'pub fn run() void {}');
    cg = await CodeGraph.init(dir, { index: true });
    cg.resolveReferences();
    for (const [name, target] of [['first', 'b.zig'], ['second', 'a.zig'], ['missing', null], ['named', 'b.zig']]) {
      const fn = cg.getNodesByKind('function').find(n => n.name === name)!;
      const calls = cg.getOutgoingEdges(fn.id).filter(e => e.kind === 'calls').map(e => cg!.getNode(e.target)?.filePath);
      expect(calls, name!).toEqual(target ? [target] : []);
    }
  });
});
