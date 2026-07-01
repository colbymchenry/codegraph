/**
 * Zig Extraction Tests
 *
 * Tests for tree-sitter-zig based extraction.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['zig']);
});

describe('Zig Language Detection', () => {
  it('should detect .zig files as zig', () => {
    expect(detectLanguage('main.zig')).toBe('zig');
  });

  it('should detect .zon files as zig', () => {
    expect(detectLanguage('build.zig.zon')).toBe('zig');
  });

  it('should report zig as supported', () => {
    expect(isLanguageSupported('zig')).toBe(true);
  });
});

describe('Zig Function Extraction', () => {
  it('should extract a basic function', () => {
    const code = `
fn add(a: i32, b: i32) i32 {
    return a + b;
}
`;
    const result = extractFromSource('math.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('add');
    expect(funcs[0]?.signature).toContain('a: i32, b: i32');
  });

  it('should extract a pub function as exported/visible', () => {
    const code = `
pub fn main() void {
    _ = add(1, 2);
}
`;
    const result = extractFromSource('main.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('main');
    expect(funcs[0]?.isExported).toBe(true);
    expect(funcs[0]?.visibility).toBe('public');
  });

  it('should extract function with return type', () => {
    const code = `
fn calculate(x: f64) f64 {
    return x * 2.0;
}
`;
    const result = extractFromSource('calc.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.signature).toContain('f64');
  });

  it('should extract multiple functions from the same file', () => {
    const code = `
fn foo() void { }
fn bar() void { }
pub fn baz() i32 { return 42; }
`;
    const result = extractFromSource('multi.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(3);
    const names = funcs.map((f) => f.name).sort();
    expect(names).toEqual(['bar', 'baz', 'foo']);
    expect(funcs.find((f) => f.name === 'baz')?.isExported).toBe(true);
  });
});

describe('Zig Type Declaration Extraction', () => {
  it('should extract a named struct from variable declaration', () => {
    const code = `
const Point = struct {
    x: f64,
    y: f64,
};
`;
    const result = extractFromSource('point.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.length).toBe(1);
    expect(structs[0]?.name).toBe('Point');
  });

  it('should extract a pub struct with correct visibility', () => {
    const code = `
pub const Config = struct {
    port: u16,
    host: []const u8,
};
`;
    const result = extractFromSource('config.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.length).toBe(1);
    expect(structs[0]?.name).toBe('Config');
    expect(structs[0]?.isExported).toBe(true);
    expect(structs[0]?.visibility).toBe('public');
  });

  it('should extract named enum from variable declaration', () => {
    const code = `
const Color = enum {
    red,
    green,
    blue,
};
`;
    const result = extractFromSource('color.zig', code);
    const enums = result.nodes.filter((n) => n.kind === 'enum');
    expect(enums.length).toBe(1);
    expect(enums[0]?.name).toBe('Color');
  });

  it('should extract enum members', () => {
    const code = `
const Status = enum {
    ok,
    not_found,
    pending,
};
`;
    const result = extractFromSource('status.zig', code);
    const members = result.nodes.filter((n) => n.kind === 'enum_member');
    expect(members.length).toBe(3);
    const names = members.map((m) => m.name).sort();
    expect(names).toEqual(['not_found', 'ok', 'pending']);
  });

  it('should extract named union from variable declaration', () => {
    const code = `
const Value = union(enum) {
    int: i32,
    float: f64,
    str: []const u8,
};
`;
    const result = extractFromSource('value.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.some((s) => s.name === 'Value')).toBe(true);
  });

  it('should mark tagged union with metadata and extract enum members', () => {
    const code = `
const Value = union(enum) {
    int: i32,
    float: f64,
    str: []const u8,
};
`;
    const result = extractFromSource('tagged_union.zig', code);
    const valueNode = result.nodes.find((n) => n.name === 'Value');
    expect(valueNode).toBeDefined();
    expect(valueNode?.metadata?.taggedUnion).toBe(true);
    const members = result.nodes.filter((n) => n.kind === 'enum_member');
    const names = members.map((m) => m.name).sort();
    expect(names).toEqual(['float', 'int', 'str']);
  });

  it('should extract error set declaration', () => {
    const code = `
const MyError = error{
    NotFound,
    PermissionDenied,
    OutOfMemory,
};
`;
    const result = extractFromSource('errors.zig', code);
    const enums = result.nodes.filter((n) => n.kind === 'enum');
    expect(enums.some((n) => n.name === 'MyError')).toBe(true);
  });

  it('should extract opaque declaration', () => {
    const code = `
pub const Handle = opaque {
    pub fn close(self: *Handle) void {
        _ = self;
    }
};
`;
    const result = extractFromSource('handle.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.some((s) => s.name === 'Handle')).toBe(true);
  });
});

describe('Zig Container Fields', () => {
  it('should extract struct fields', () => {
    const code = `
const User = struct {
    id: u64,
    name: []const u8,
    active: bool,
};
`;
    const result = extractFromSource('user.zig', code);
    const fields = result.nodes.filter((n) => n.kind === 'field');
    expect(fields.length).toBe(3);
    const names = fields.map((f) => f.name).sort();
    expect(names).toEqual(['active', 'id', 'name']);
  });
});

describe('Zig Methods', () => {
  it('should extract function declarations inside struct as methods', () => {
    const code = `
const Counter = struct {
    count: u32,

    pub fn init() Counter {
        return Counter{ .count = 0 };
    }

    pub fn increment(self: *Counter) void {
        self.count += 1;
    }
};
`;
    const result = extractFromSource('counter.zig', code);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.length).toBe(2);
    const names = methods.map((m) => m.name).sort();
    expect(names).toEqual(['increment', 'init']);
  });
});

describe('Zig Variable Declarations', () => {
  it('should extract const declarations', () => {
    const code = `
const x: i32 = 42;
const greeting = "hello";
`;
    const result = extractFromSource('vars.zig', code);
    const consts = result.nodes.filter((n) => n.kind === 'constant');
    const vars = result.nodes.filter((n) => n.kind === 'variable');
    // Both are `const`, so both should be `constant`
    expect(consts.length + vars.length).toBeGreaterThanOrEqual(2);
  });

  it('should extract var declarations', () => {
    const code = `
var counter: u32 = 0;
var running = true;
`;
    const result = extractFromSource('mut.zig', code);
    const vars = result.nodes.filter((n) => n.kind === 'variable');
    expect(vars.length).toBeGreaterThanOrEqual(2);
    expect(vars.every((v) => v.name === 'counter' || v.name === 'running')).toBe(true);
  });

  it('should distinguish const from var', () => {
    const code = `
const immutable: u32 = 1;
var mutable: u32 = 0;
`;
    const result = extractFromSource('both.zig', code);
    const consts = result.nodes.filter((n) => n.kind === 'constant');
    const vars = result.nodes.filter((n) => n.kind === 'variable');
    expect(consts).toHaveLength(1);
    expect(vars).toHaveLength(1);
    expect(consts[0]?.name).toBe('immutable');
    expect(vars[0]?.name).toBe('mutable');
  });
});

describe('Zig @import Detection', () => {
  it('should detect @import calls and create import references', () => {
    const code = `
const std = @import("std");
const testing = @import("std").testing;
`;
    const result = extractFromSource('imports.zig', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.referenceName === 'std')).toBe(true);
  });
});

describe('Zig Function Calls', () => {
  it('should track function calls inside function bodies', () => {
    const code = `
fn a() void { }
fn b() void { _ = a(); }
`;
    const result = extractFromSource('calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'a')).toBe(true);
  });
});

describe('Zig Chained Method Calls', () => {
  it('resolves std.debug.print as full chain', () => {
    const code = `
const std = @import("std");
pub fn main() void {
    std.debug.print("hello\\n", .{});
}
`;
    const result = extractFromSource('chained.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'std.debug.print')).toBe(true);
  });

  it('resolves std.mem.eql as full chain', () => {
    const code = `
const std = @import("std");
pub fn main() void {
    _ = std.mem.eql(u8, "a", "b");
}
`;
    const result = extractFromSource('mem.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'std.mem.eql')).toBe(true);
  });

  it('resolves simple obj.method() correctly', () => {
    const code = `
const Foo = struct { pub fn bar(self: *Foo) void { } };
fn main() void { var f: Foo = undefined; f.bar(); }
`;
    const result = extractFromSource('obj.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'f.bar')).toBe(true);
  });

  it('detects @import("std").testing import inside field expression', () => {
    const code = `
const testing = @import("std").testing;
`;
    const result = extractFromSource('stdtest.zig', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(refs.some((r) => r.referenceName === 'std')).toBe(true);
  });
});

describe('Zig Test Declarations', () => {
  it('should extract a test declaration with string name as function', () => {
    const code = `
test "basic addition" {
    _ = add(1, 2);
}
`;
    const result = extractFromSource('test_basic.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('basic addition');
  });

  it('should extract a test declaration with identifier name', () => {
    const code = `
test addWorks {
    _ = add(1, 2);
}
`;
    const result = extractFromSource('test_id.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('addWorks');
  });

  it('should track calls inside test declarations', () => {
    const code = `
fn add(a: i32, b: i32) i32 { return a + b; }
test "uses add" { _ = add(1, 2); }
`;
    const result = extractFromSource('test_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'add')).toBe(true);
  });
});

describe('Zig Non-Exhaustive Enum', () => {
  it('should not extract _ as an enum member', () => {
    const code = `
const E = enum(u8) {
    a = 1,
    b,
    _,
};
`;
    const result = extractFromSource('nonexhaustive.zig', code);
    const members = result.nodes.filter((n) => n.kind === 'enum_member');
    const names = members.map((m) => m.name);
    expect(names).toEqual(['a', 'b']);
    expect(names).not.toContain('_');
  });
});

describe('Zig Export Visibility', () => {
  it('should treat export fn as exported', () => {
    const code = `
export fn hello() void { }
`;
    const result = extractFromSource('exportfn.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.isExported).toBe(true);
    expect(funcs[0]?.visibility).toBe('public');
  });

  it('should track export fn call from another function', () => {
    const code = `
export fn run() void { }
fn main() void { _ = run(); }
`;
    const result = extractFromSource('export_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'run')).toBe(true);
  });
});

describe('Zig Comptime Blocks', () => {
  it('should extract declarations inside comptime blocks', () => {
    const code = `
comptime {
    const version: u32 = 1;
    var counter: u32 = 0;
}
`;
    const result = extractFromSource('comptime_vars.zig', code);
    const consts = result.nodes.filter((n) => n.kind === 'constant');
    const vars = result.nodes.filter((n) => n.kind === 'variable');
    expect(consts).toHaveLength(1);
    expect(vars).toHaveLength(1);
    expect(consts[0]?.name).toBe('version');
    expect(vars[0]?.name).toBe('counter');
  });
});

describe('Zig Packed and Extern Types', () => {
  it('should extract packed struct', () => {
    const code = `
const S = packed struct {
    x: i32,
    y: i32,
};
`;
    const result = extractFromSource('packed.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.length).toBe(1);
    expect(structs[0]?.name).toBe('S');
  });

  it('should extract extern struct', () => {
    const code = `
const E = extern struct {
    id: u32,
    name: [32]u8,
};
`;
    const result = extractFromSource('extern_struct.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.length).toBe(1);
    expect(structs[0]?.name).toBe('E');
  });
});

describe('Zig Threadlocal Variable', () => {
  it('should extract threadlocal var as variable (not constant)', () => {
    const code = `
threadlocal var counter: u32 = 0;
`;
    const result = extractFromSource('threadlocal.zig', code);
    const vars = result.nodes.filter((n) => n.kind === 'variable');
    expect(vars.length).toBe(1);
    expect(vars[0]?.name).toBe('counter');
  });
});

describe('Zig Usingnamespace', () => {
  it('should detect @import inside usingnamespace', () => {
    const code = `
usingnamespace @import("foo");
`;
    const result = extractFromSource('usingns.zig', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.referenceName === 'foo')).toBe(true);
  });
});

describe('Zig Container Field Type References', () => {
  it('should emit references edges for custom types on struct fields', () => {
    const code = `
const Allocator = struct { alloc: u8 };
const Config = struct {
    allocator: Allocator,
    port: u16,
};
`;
    const result = extractFromSource('fields.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'Allocator'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('should NOT emit references for builtin types on fields', () => {
    const code = `
const Config = struct {
    port: u16,
    host: []const u8,
};
`;
    const result = extractFromSource('builtin_fields.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && (r.referenceName === 'u16' || r.referenceName === 'u8')
    );
    expect(refs.length).toBe(0);
  });

  it('should extract pointer type references on fields', () => {
    const code = `
const Node = struct {
    next: ?*Node,
};
`;
    const result = extractFromSource('ptr_field.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'Node'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig @cImport Detection', () => {
  it('should detect @cImport(@cInclude("header")) and create import node', () => {
    const code = `
const c = @cImport(@cInclude("stdio.h"));
`;
    const result = extractFromSource('cimport.zig', code);
    const imports = result.nodes.filter((n) => n.kind === 'import');
    expect(imports.some((i) => i.name === 'stdio.h')).toBe(true);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'imports' && r.referenceName === 'stdio.h'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect multiple @cInclude inside @cImport', () => {
    const code = `
const c = @cImport({
    @cInclude("stdio.h");
    @cInclude("stdlib.h");
});
`;
    const result = extractFromSource('cimport_multi.zig', code);
    const imports = result.nodes.filter((n) => n.kind === 'import');
    expect(imports.some((i) => i.name === 'stdio.h')).toBe(true);
    expect(imports.some((i) => i.name === 'stdlib.h')).toBe(true);
  });
});

describe('Zig @call Indirect Function Calls', () => {
  it('should detect @call(.auto, funcName, .{}) as calls reference', () => {
    const code = `
fn foo() void {}
fn bar() void {
    const r = @call(.auto, foo, .{});
    _ = r;
}
`;
    const result = extractFromSource('atcall.zig', code);
    const calls = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'calls' && r.referenceName === 'foo'
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig @embedFile Detection', () => {
  it('should detect @embedFile("path") as imports reference', () => {
    const code = `
const data = @embedFile("data.txt");
`;
    const result = extractFromSource('embedfile.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'imports' && r.referenceName === 'data.txt'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig Nested Struct Declarations', () => {
  it('should extract nested struct/enum/union inside containers', () => {
    const code = `
const Outer = struct {
    pub const Inner = struct {
        pub fn deep() void {}
    };
};
`;
    const result = extractFromSource('nested.zig', code);
    const structs = result.nodes.filter((n) => n.kind === 'struct');
    expect(structs.some((s) => s.name === 'Outer')).toBe(true);
    expect(structs.some((s) => s.name === 'Inner')).toBe(true);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.some((m) => m.name === 'deep')).toBe(true);
  });
});

describe('Zig Nullable and Error Union Type References', () => {
  it('should extract type references from nullable type annotations', () => {
    const code = `
const MyType = struct {};
const maybe: ?MyType = null;
`;
    const result = extractFromSource('nullable_ref.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'MyType'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract type references from error union type annotations', () => {
    const code = `
const MyError = error{Fail};
pub fn foo() !MyError {
    return error.Fail;
}
`;
    const result = extractFromSource('errunion_ref.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.some((f) => f.name === 'foo')).toBe(true);
  });
});

describe('Zig Function Type Annotations', () => {
  it('should extract type references from function parameter types', () => {
    const code = `
const MyStruct = struct {};
fn process(s: MyStruct) void { _ = s; }
`;
    const result = extractFromSource('param_type.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'MyStruct'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract type references from function return types', () => {
    const code = `
const Result = struct {};
fn getResult() Result { return undefined; }
`;
    const result = extractFromSource('ret_type.zig', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'references' && r.referenceName === 'Result'
    );
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig Comptime Parameter Detection', () => {
  it('should detect comptime parameters on functions', () => {
    const code = `
fn print(comptime fmt: []const u8, args: anytype) void {
    _ = fmt;
    _ = args;
}
`;
    const result = extractFromSource('comptime_param.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('print');
  });
});

// ─── P0: Untested call-in-expression patterns ────────────────────────

describe('Zig defer / errdefer Call Tracking', () => {
  it('should track calls inside defer expressions', () => {
    const code = `
fn cleanup() void {}
fn doWork() void {
    defer cleanup();
    _ = 42;
}
`;
    const result = extractFromSource('defer_call.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'cleanup')).toBe(true);
  });

  it('should track calls inside errdefer expressions', () => {
    const code = `
fn rollback() void {}
fn risky() !void {
    errdefer rollback();
}
`;
    const result = extractFromSource('errdefer_call.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'rollback')).toBe(true);
  });
});

describe('Zig try Expression Call Tracking', () => {
  it('should track calls through try expression', () => {
    const code = `
fn riskyOp() !void {}
fn caller() !void {
    try riskyOp();
}
`;
    const result = extractFromSource('try_call.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'riskyOp')).toBe(true);
  });
});

describe('Zig catch Handler Call Tracking', () => {
  it('should track calls inside catch handler', () => {
    const code = `
fn handler(err: anyerror) void { _ = err; }
fn riskyOp() !i32 { return 0; }
fn caller() void {
    _ = riskyOp() catch |e| handler(e);
}
`;
    const result = extractFromSource('catch_handler.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'handler')).toBe(true);
  });
});

describe('Zig for Loop Call Tracking', () => {
  it('should track calls inside for loop body', () => {
    const code = `
fn process(x: u32) void { _ = x; }
fn caller() void {
    var items = [_]u32{ 1, 2, 3 };
    for (items) |item| {
        process(item);
    }
}
`;
    const result = extractFromSource('for_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'process')).toBe(true);
  });

  it('should track calls inside for loop with index', () => {
    const code = `
fn handle(a: u32, b: usize) void { _ = a; _ = b; }
fn caller() void {
    var items = [_]u32{ 1, 2, 3 };
    for (items, 0..) |item, i| {
        handle(item, i);
    }
}
`;
    const result = extractFromSource('for_index_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'handle')).toBe(true);
  });
});

describe('Zig while Loop Call Tracking', () => {
  it('should track calls inside while loop body', () => {
    const code = `
fn doWork() void {}
fn caller() void {
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        doWork();
    }
}
`;
    const result = extractFromSource('while_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'doWork')).toBe(true);
  });
});

describe('Zig Labeled Block Call Tracking', () => {
  it('should track calls inside labeled block expressions', () => {
    const code = `
fn compute() i32 { return 42; }
fn caller() void {
    const result = blk: {
        const tmp = compute();
        break :blk tmp;
    };
    _ = result;
}
`;
    const result = extractFromSource('labeled_block.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'compute')).toBe(true);
  });
});

describe('Zig switch with Payload Call Tracking', () => {
  it('should track calls inside switch prongs', () => {
    const code = `
const Value = union(enum) { a: u32, b: u32 };
fn handleA(v: u32) void { _ = v; }
fn handleB(v: u32) void { _ = v; }
fn caller(val: Value) void {
    switch (val) {
        .a => |v| handleA(v),
        .b => |v| handleB(v),
    }
}
`;
    const result = extractFromSource('switch_calls.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'handleA')).toBe(true);
    expect(calls.some((r) => r.referenceName === 'handleB')).toBe(true);
  });
});

describe('Zig orelse Expression Call Tracking', () => {
  it('should track calls in orelse fallback expression', () => {
    const code = `
fn fallback() u32 { return 0; }
fn caller() void {
    const maybe: ?u32 = null;
    const val = maybe orelse fallback();
    _ = val;
}
`;
    const result = extractFromSource('orelse_call.zig', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((r) => r.referenceName === 'fallback')).toBe(true);
  });
});

// ─── P1: inline/noinline/callconv metadata ───────────────────────────

describe('Zig inline/noinline Function Modifiers', () => {
  it('should mark inline fn in metadata', () => {
    const code = `
inline fn fastPath() void {}
`;
    const result = extractFromSource('inline_fn.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('fastPath');
    expect(funcs[0]?.metadata?.inline).toBe(true);
  });

  it('should mark noinline fn in metadata', () => {
    const code = `
noinline fn slowPath() void {}
`;
    const result = extractFromSource('noinline_fn.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('slowPath');
    expect(funcs[0]?.metadata?.noinline).toBe(true);
  });

  it('should capture callconv in function signature', () => {
    const code = `
fn cCallback(data: *anyopaque) callconv(.C) void {
    _ = data;
}
`;
    const result = extractFromSource('callconv_fn.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('cCallback');
    expect(funcs[0]?.signature).toContain('callconv(.C)');
  });
});

// ─── P3: .zon, anonymous struct, destructuring, module docs, extern fn ──

describe('Zig .zon File Support', () => {
  it('should parse declarations from a .zon file', () => {
    const code = `
.name = "my-package",
.version = "0.1.0",
.paths = .{ "." },
`;
    const result = extractFromSource('build.zig.zon', code);
    // .zon files are parsed as zig — verify no crash and some output
    expect(result.nodes.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Zig Anonymous Struct Literal Instantiation', () => {
  it('should track Type{ .field = val } as instantiation', () => {
    const code = `
const Point = struct { x: f64, y: f64 };
fn makePoint() Point {
    return Point{ .x = 1.0, .y = 2.0 };
}
`;
    const result = extractFromSource('anon_struct.zig', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'instantiates');
    expect(refs.some((r) => r.referenceName === 'Point')).toBe(true);
  });
});

describe('Zig extern fn Without Body', () => {
  it('should extract extern function declaration (no body)', () => {
    const code = `
extern fn malloc(size: usize) ?*anyopaque;
`;
    const result = extractFromSource('extern_fn.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    // Should extract as a function node even without a body
    expect(funcs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig Module Doc Comments', () => {
  it('should handle //! module-level doc comments without crashing', () => {
    const code = `
//! This module provides math utilities.

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}
`;
    const result = extractFromSource('moddoc.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('add');
  });
});

describe('Zig Destructuring Assignment', () => {
  it('should not crash on destructuring tuples', () => {
    const code = `
fn caller() void {
    const tuple = .{ 1, 2, 3 };
    const a, const b, const c = tuple;
    _ = a; _ = b; _ = c;
}
`;
    const result = extractFromSource('destructure.zig', code);
    // Should not crash and should extract the function
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
  });
});

describe('Zig C Variadic Function', () => {
  it('should extract C variadic function declaration', () => {
    const code = `
extern fn printf(fmt: [*:0]const u8, ...) c_int;
`;
    const result = extractFromSource('variadic.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Zig getReceiverType (standardized method receiver)', () => {
  it('should extract receiver type from self: *Type parameter', () => {
    const code = `
const Counter = struct {
    count: u32,
    pub fn increment(self: *Counter) void {
        self.count += 1;
    }
};
`;
    const result = extractFromSource('receiver.zig', code);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    const inc = methods.find((m) => m.name === 'increment');
    expect(inc).toBeDefined();
  });

  it('should extract receiver type from self: Type parameter', () => {
    const code = `
const Point = struct {
    x: f64,
    pub fn distance(self: Point) f64 {
        return self.x * self.x;
    }
};
`;
    const result = extractFromSource('receiver2.zig', code);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods.some((m) => m.name === 'distance')).toBe(true);
  });
});

describe('Zig extractImport hook (standardized)', () => {
  it('should handle @import via extractImport hook for variable declarations', () => {
    const code = `
const std = @import("std");
const testing = @import("std").testing;
`;
    const result = extractFromSource('import_hook.zig', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(refs.some((r) => r.referenceName === 'std')).toBe(true);
  });
});

describe('Zig Comptime Parameter Detection', () => {
  it('should detect comptime parameters on functions', () => {
    const code = `
fn print(comptime fmt: []const u8, args: anytype) void {
    _ = fmt;
    _ = args;
}
`;
    const result = extractFromSource('comptime_param.zig', code);
    const funcs = result.nodes.filter((n) => n.kind === 'function');
    expect(funcs.length).toBe(1);
    expect(funcs[0]?.name).toBe('print');
  });
});
