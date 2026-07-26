/**
 * Zig Extraction Tests
 *
 * Zig has no classes — types are values bound to a const (`const X = struct{}`)
 * and modules are `const m = @import(...)`. These tests pin the idioms the
 * extractor must get right: container types, scope-based methods, fields, enum
 * members, constants, imports, test blocks, and the import-namespace mappings
 * that make cross-file `callers`/`callees` resolve.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { ExtractionResult } from '../src/types';
import { extractFromSource } from '../src/extraction';
import {
  detectLanguage,
  isLanguageSupported,
  getSupportedLanguages,
  initGrammars,
  loadAllGrammars,
} from '../src/extraction/grammars';
import { extractImportMappings } from '../src/resolution/import-resolver';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const SAMPLE = `
const std = @import("std");
const helper = @import("./util/helper.zig");

pub const max_items: u32 = 8;

pub const Color = enum { red, green, blue };
pub const Choice = union(enum) { item: u8, none };
pub const Handle = opaque {};
pub const Failure = error{ Missing, Invalid };
const private_limit: u32 = 4;

pub const Point = struct {
    x: f32,
    y: f32,

    pub fn add(self: Point, other: Point) Point {
        return .{ .x = self.x + other.x, .y = self.y + other.y };
    }
};

pub fn translate(p: Point) Point {
    const callback = Point.add;
    var scratch: usize = 0;
    _ = callback;
    _ = scratch;
    return helper.shift(p);
}

test "point add" {
    _ = Point.add;
}
`;

describe('Zig language wiring', () => {
  it('detects .zig as zig and reports it supported', () => {
    expect(detectLanguage('src/main.zig')).toBe('zig');
    expect(isLanguageSupported('zig')).toBe(true);
    expect(getSupportedLanguages()).toContain('zig');
  });
});

describe('Zig extraction', () => {
  // Computed in beforeAll, not at collection time — the file-level beforeAll
  // must load the grammar first.
  let result: ExtractionResult;
  beforeAll(() => {
    result = extractFromSource('shapes.zig', SAMPLE, 'zig');
  });

  const byKind = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);

  it('extracts a const-bound struct as a struct, not a constant', () => {
    expect(byKind('struct', 'Point')).toBeDefined();
    expect(byKind('constant', 'Point')).toBeUndefined();
  });

  it('extracts a struct method as a method (scope-based, no receiver syntax)', () => {
    const add = byKind('method', 'add');
    expect(add).toBeDefined();
    expect(add!.qualifiedName).toContain('Point');
  });

  it('extracts struct fields', () => {
    expect(byKind('field', 'x')).toBeDefined();
    expect(byKind('field', 'y')).toBeDefined();
  });

  it('extracts a const-bound enum and its members', () => {
    expect(byKind('enum', 'Color')).toBeDefined();
    expect(byKind('enum_member', 'red')).toBeDefined();
    expect(byKind('enum_member', 'blue')).toBeDefined();
  });

  it('extracts union and opaque containers and error sets', () => {
    expect(byKind('struct', 'Choice')).toBeDefined();
    expect(byKind('field', 'item')).toBeDefined();
    expect(byKind('struct', 'Handle')).toBeDefined();
    expect(byKind('enum', 'Failure')).toBeDefined();
    expect(byKind('enum_member', 'Missing')).toBeDefined();
    expect(byKind('enum_member', 'Invalid')).toBeDefined();
  });

  it('extracts a top-level fn as a function and a plain const as a constant', () => {
    expect(byKind('function', 'translate')).toBeDefined();
    expect(byKind('constant', 'max_items')).toBeDefined();
  });

  it('records public visibility and excludes function locals', () => {
    expect(byKind('constant', 'max_items')?.visibility).toBe('public');
    expect(byKind('constant', 'private_limit')?.visibility).toBe('private');
    expect(result.nodes.some((n) => n.name === 'callback')).toBe(false);
    expect(result.nodes.some((n) => n.name === 'scratch')).toBe(false);
  });

  it('extracts @import as import nodes', () => {
    expect(byKind('import', 'std')).toBeDefined();
    expect(byKind('import', './util/helper.zig')).toBeDefined();
  });

  it('extracts a test block as a callable function node', () => {
    expect(byKind('function', 'point add')).toBeDefined();
  });

  it('emits a calls reference for a namespaced member call', () => {
    // `helper.shift(p)` — the dotted ref the resolver maps through the import.
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'helper.shift' && r.referenceKind === 'calls'
    );
    expect(ref).toBeDefined();
  });

  it('emits a function reference for a stored method value', () => {
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'add' && r.referenceKind === 'function_ref'
    );
    expect(ref).toBeDefined();
  });

});

describe('Zig comptime dispatch references', () => {
  const DISPATCH = `
fn fast() void {}
fn slow() void {}

const routes = [_]*const fn () void{
    fast,
    slow,
};
`;

  it('links functions stored in a file-scope dispatch table', () => {
    const result = extractFromSource('dispatch.zig', DISPATCH, 'zig');
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'function_ref')
      .map((r) => r.referenceName);
    expect(refs).toContain('fast');
    expect(refs).toContain('slow');
  });
});

describe('Zig import mappings (cross-file resolution)', () => {
  it('maps @import bindings to namespace imports', () => {
    const maps = extractImportMappings('shapes.zig', SAMPLE, 'zig');
    const helper = maps.find((m) => m.localName === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.source).toBe('./util/helper.zig');
    expect(helper!.isNamespace).toBe(true);
    expect(maps.find((m) => m.localName === 'std')).toBeDefined();
  });

  it('accepts bare relative file paths and multiline declarations', () => {
    const maps = extractImportMappings(
      'main.zig',
      'pub const widget = @import(\n    "util/widget.zig"\n);',
      'zig'
    );
    expect(maps).toEqual([
      {
        localName: 'widget',
        exportedName: '*',
        source: 'util/widget.zig',
        isDefault: false,
        isNamespace: true,
      },
    ]);
  });
});

describe('Zig generic-type factories', () => {
  // `fn List(T) type { return struct {...} }` — Zig's generic types are
  // functions returning an anonymous container.
  const FACTORY = `
pub fn List(comptime T: type) type {
    return struct {
        items: []T,
        pub fn append(self: *@This(), x: T) void { _ = self; _ = x; }
        pub fn clear(self: *@This()) void { _ = self; }
    };
}`;
  let nodes: { kind: string; name: string; qualifiedName?: string }[];
  beforeAll(() => {
    nodes = extractFromSource('list.zig', FACTORY, 'zig').nodes;
  });

  it('indexes the factory as a struct named for the function', () => {
    expect(nodes.find((n) => n.kind === 'struct' && n.name === 'List')).toBeDefined();
  });

  it('indexes the returned container declarations as methods of that type', () => {
    const append = nodes.find((n) => n.kind === 'method' && n.name === 'append');
    expect(append).toBeDefined();
    expect(append!.qualifiedName).toContain('List');
    expect(nodes.find((n) => n.kind === 'method' && n.name === 'clear')).toBeDefined();
    expect(nodes.find((n) => n.kind === 'field' && n.name === 'items')).toBeDefined();
  });

  it('indexes a returned enum as an enum with members', () => {
    const enumNodes = extractFromSource(
      'tag.zig',
      'pub fn Tag(comptime T: type) type { _ = T; return enum { one, two }; }',
      'zig'
    ).nodes;
    expect(enumNodes.find((n) => n.kind === 'enum' && n.name === 'Tag')).toBeDefined();
    expect(enumNodes.find((n) => n.kind === 'enum_member' && n.name === 'two')).toBeDefined();
  });
});

describe('Zig resolved project graph', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves a namespaced call through a relative @import', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-import-'));
    fs.writeFileSync(
      path.join(tempDir, 'util.zig'),
      'pub fn shift(value: i32) i32 { return value + 1; }\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'main.zig'),
      'const util = @import("util.zig");\npub fn run() i32 { return util.shift(41); }\n'
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      const shift = cg.getNodesByName('shift').find((n) => n.kind === 'function');
      expect(shift).toBeDefined();
      expect(cg.getCallers(shift!.id).map((c) => c.node.name)).toContain('run');
    } finally {
      cg.destroy();
    }
  });

  it('links functions stored in a comptime dispatch table', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-dispatch-'));
    fs.writeFileSync(
      path.join(tempDir, 'dispatch.zig'),
      [
        'fn fast() void {}',
        'fn slow() void {}',
        'const routes = [_]*const fn () void{ fast, slow };',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tempDir);
    try {
      await cg.indexAll();
      for (const name of ['fast', 'slow']) {
        const fn = cg.getNodesByName(name).find((n) => n.kind === 'function');
        expect(fn).toBeDefined();
        expect(
          cg.getIncomingEdges(fn!.id).some(
            (edge) => edge.kind === 'references' && edge.metadata?.fnRef === true
          )
        ).toBe(true);
      }
    } finally {
      cg.destroy();
    }
  });
});
