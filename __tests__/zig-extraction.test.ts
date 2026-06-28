/**
 * Zig Extraction Tests
 *
 * Zig has no classes — types are values bound to a const (`const X = struct{}`)
 * and modules are `const m = @import(...)`. These tests pin the idioms the
 * extractor must get right: container types, scope-based methods, fields, enum
 * members, constants, imports, test blocks, and the import-namespace mappings
 * that make cross-file `callers`/`callees` resolve.
 */

import { describe, it, expect, beforeAll } from 'vitest';
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

pub const Point = struct {
    x: f32,
    y: f32,

    pub fn add(self: Point, other: Point) Point {
        return .{ .x = self.x + other.x, .y = self.y + other.y };
    }
};

pub fn translate(p: Point) Point {
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

  it('extracts a top-level fn as a function and a plain const as a constant', () => {
    expect(byKind('function', 'translate')).toBeDefined();
    expect(byKind('constant', 'max_items')).toBeDefined();
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
});
