import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('Zig Resolution', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeFiles(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
  }

  it('resolves relative @import file edges, cross-file calls, member imports, and re-exports', async () => {
    writeFiles({
      'src/common.zig': `
pub const Point = struct {
    x: i32,
    y: i32,

    pub fn init(x: i32, y: i32) Point {
        return .{ .x = x, .y = y };
    }

    pub fn sum(self: *const Point) i32 {
        return self.x + self.y;
    }
};

pub fn helper(v: i32) i32 {
    return secret(v);
}

fn secret(v: i32) i32 {
    return v * 2;
}
`,
      'src/barrel.zig': `
pub const common = @import("common.zig");
pub const Point = @import("common.zig").Point;
`,
      'src/sub/app.zig': `
const std = @import("std");
const common = @import("../common.zig");
const Point = @import("../barrel.zig").Point;
const barrel = @import("../barrel.zig");

pub fn run(p: *const Point) i32 {
    const q = common.Point.init(1, 2);
    const a = p.sum() + q.sum();
    const b = common.helper(a);
    const c = barrel.common.helper(b);
    return c + @import("../common.zig").helper(1);
}

fn secret(v: i32) i32 {
    return v + 1;
}

test "run smoke" {
    const pt = Point.init(3, 4);
    _ = run(&pt);
    _ = secret(5);
}
`,
      // Should be ignored by DEFAULT_IGNORE_DIRS
      '.zig-cache/o/abc/generated.zig': `pub fn secret(v: i32) i32 { return v; }\n`,
      'zig-out/gen.zig': `pub fn ignoredOut() void {}\n`,
    });

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    const stats = cg.getStats();
    expect(stats.filesByLanguage.zig).toBe(3);

    // File -> file import edges
    const appFile = cg.getNodesInFile('src/sub/app.zig').find((n) => n.kind === 'file')!;
    const commonFile = cg.getNodesInFile('src/common.zig').find((n) => n.kind === 'file')!;
    const barrelFile = cg.getNodesInFile('src/barrel.zig').find((n) => n.kind === 'file')!;
    const appImportTargets = cg
      .getOutgoingEdges(appFile.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => e.target);
    expect(appImportTargets).toContain(commonFile.id);
    expect(appImportTargets).toContain(barrelFile.id);

    // Cross-file calls from app.run
    const runFn = cg.getNodesInFile('src/sub/app.zig').find((n) => n.kind === 'function' && n.name === 'run')!;
    const runCallees = cg.getCallees(runFn.id).map((c) => `${c.node.filePath}::${c.node.qualifiedName}`);
    expect(runCallees).toContain('src/common.zig::Point::init');
    expect(runCallees).toContain('src/common.zig::Point::sum');
    expect(runCallees).toContain('src/common.zig::helper');

    // Private function isolation: common.secret is called only by common.helper, NOT by app's test
    const commonSecret = cg.getNodesInFile('src/common.zig').find((n) => n.kind === 'function' && n.name === 'secret')!;
    const commonSecretCallers = cg.getCallers(commonSecret.id).map((c) => `${c.node.filePath}::${c.node.name}`);
    expect(commonSecretCallers).toEqual(['src/common.zig::helper']);

    // Test block links to run and local secret
    const testFn = cg.getNodesInFile('src/sub/app.zig').find((n) => n.kind === 'function' && n.name === 'test "run smoke"')!;
    const testCallees = cg.getCallees(testFn.id).map((c) => `${c.node.filePath}::${c.node.qualifiedName}`);
    expect(testCallees).toContain('src/sub/app.zig::run');
    expect(testCallees).toContain('src/sub/app.zig::secret');
    expect(testCallees).toContain('src/common.zig::Point::init');
  });

  it('does not falsely link external @import("std") to an unrelated symbol', async () => {
    writeFiles({
      'src/std_helper.zig': `pub fn std() void {}\n`,
      'src/main.zig': `
const std = @import("std");
pub fn main() void {
    _ = std;
}
`,
    });

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    const mainFile = cg.getNodesInFile('src/main.zig').find((n) => n.kind === 'file')!;
    const imports = cg.getOutgoingEdges(mainFile.id).filter((e) => e.kind === 'imports');
    expect(imports).toHaveLength(0);
  });

  it('resolves every consecutive @import binding and re-export without skipping alternating lines', async () => {
    writeFiles({
      'src/a.zig': `pub fn post() void {}\n`,
      'src/b.zig': `pub fn post() void {}\n`,
      'src/c.zig': `pub fn post() void {}\n`,
      'src/d.zig': `pub fn post() void {}\npub fn onlyViaReexport() void {}\n`,
      'src/reexport.zig': `pub const b_mod = @import("b.zig");\npub const d_mod = @import("d.zig");\n`,
      'src/routes.zig': `const a = @import("a.zig");
const b = @import("b.zig");
const c = @import("c.zig");
const d = @import("d.zig");
const rx = @import("reexport.zig");

pub fn dispatch() void {
    a.post();
    b.post();
    c.post();
    d.post();
    rx.d_mod.onlyViaReexport();
}
`,
    });

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    const dispatchFn = cg.getNodesInFile('src/routes.zig').find((n) => n.kind === 'function' && n.name === 'dispatch')!;
    const callees = cg.getCallees(dispatchFn.id).map((c) => `${c.node.filePath}::${c.node.name}`);
    expect(callees).toContain('src/a.zig::post');
    expect(callees).toContain('src/b.zig::post');
    expect(callees).toContain('src/c.zig::post');
    expect(callees).toContain('src/d.zig::post');
    expect(callees).toContain('src/d.zig::onlyViaReexport');
  });

  it('resolves build.zig named modules from addModule, createModule+addImport, .imports, and helper build files', async () => {
    writeFiles({
      'pkg/build.zig': `const std = @import("std");
const server_build = @import("zig/build/server.zig");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    _ = b.addModule("xev", .{
        .root_source_file = b.path("zig/src/xev.zig"),
    });
    const lanes = b.createModule(.{
        .root_source_file = b.path("zig/src/core/lanes.zig"),
        .target = target,
        .optimize = optimize,
    });
    const api = b.createModule(.{
        .root_source_file = b.path("zig/src/core/engine_api.zig"),
        .target = target,
        .imports = &.{.{ .name = "lanes", .module = lanes }},
    });
    const srv = server_build.serverMod(b, target, api);
    srv.addImport("family", @import("zig/build/family.zig").module(b, target));
    const backend_a = b.createModule(.{ .root_source_file = b.path("zig/src/native/cuda.zig"), .target = target });
    const backend_b = b.createModule(.{ .root_source_file = b.path("zig/src/native/xpu.zig"), .target = target });
    srv.addImport("native_engines", backend_a);
    api.addImport("native_engines", backend_b);
}
`,
      'pkg/zig/build/server.zig': `const std = @import("std");

pub fn json(b: *std.Build, target: std.Build.ResolvedTarget) *std.Build.Module {
    return b.createModule(.{ .root_source_file = b.path("zig/src/server/json.zig"), .target = target });
}

pub fn serverMod(b: *std.Build, target: std.Build.ResolvedTarget, api: *std.Build.Module) *std.Build.Module {
    const m = b.createModule(.{
        .root_source_file = b.path("zig/src/server/routes.zig"),
        .target = target,
        .imports = &.{.{ .name = "engine_api", .module = api }},
    });
    const j = json(b, target);
    m.addImport("json", j);
    return m;
}
`,
      'pkg/zig/build/family.zig': `const std = @import("std");

pub fn module(b: *std.Build, target: std.Build.ResolvedTarget) *std.Build.Module {
    return moduleAt(b, "zig/src/families/lfm3.zig", target);
}

fn moduleAt(b: *std.Build, root: []const u8, target: std.Build.ResolvedTarget) *std.Build.Module {
    const helper = b.createModule(.{ .root_source_file = b.path("zig/src/families/rope.zig"), .target = target });
    return b.createModule(.{
        .root_source_file = b.path(root),
        .target = target,
        .imports = &.{.{ .name = "rope_freq", .module = helper }},
    });
}
`,
      'pkg/zig/src/xev.zig': `pub fn tick() void {}\n`,
      'pkg/zig/src/core/lanes.zig': `pub fn schedule() void {}\n`,
      'pkg/zig/src/core/engine_api.zig': `const lanes = @import("lanes");
pub const Engine = struct {
    pub fn open() void {
        lanes.schedule();
    }
};
pub fn learn() void {}
`,
      'pkg/zig/src/server/json.zig': `pub fn stringify() void {}\n`,
      'pkg/zig/src/families/rope.zig': `pub fn freq() void {}\n`,
      'pkg/zig/src/families/lfm3.zig': `const rope = @import("rope_freq");
pub fn forward() void {
    rope.freq();
}
`,
      'pkg/zig/src/native/cuda.zig': `pub fn boot() void {}\n`,
      'pkg/zig/src/native/xpu.zig': `pub fn boot() void {}\n`,
      'pkg/zig/src/unrelated_std.zig': `pub fn std() void {}\npub fn builtin() void {}\npub fn third_party() void {}\n`,
      'pkg/zig/src/server/routes.zig': `const std = @import("std");
const builtin = @import("builtin");
const third_party = @import("third_party");
const native_engines = @import("native_engines");
const xev = @import("xev");
const api = @import("engine_api");
const json = @import("json");
const family = @import("family");

pub fn handle() void {
    _ = std;
    _ = builtin;
    _ = third_party;
    _ = native_engines;
    xev.tick();
    api.Engine.open();
    json.stringify();
    family.forward();
    @import("engine_api").learn();
}
`,
    });

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    const routesFile = cg.getNodesInFile('pkg/zig/src/server/routes.zig').find((n) => n.kind === 'file')!;
    const routeImportFiles = cg
      .getOutgoingEdges(routesFile.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => cg!.getNode(e.target)?.filePath);
    expect(routeImportFiles).toContain('pkg/zig/src/xev.zig');
    expect(routeImportFiles).toContain('pkg/zig/src/core/engine_api.zig');
    expect(routeImportFiles).toContain('pkg/zig/src/server/json.zig');
    expect(routeImportFiles).toContain('pkg/zig/src/families/lfm3.zig');
    // Built-ins, unknown third-party, and genuinely ambiguous multi-backend modules stay silent
    expect(routeImportFiles).not.toContain('pkg/zig/src/unrelated_std.zig');
    expect(routeImportFiles).not.toContain('pkg/zig/src/native/cuda.zig');
    expect(routeImportFiles).not.toContain('pkg/zig/src/native/xpu.zig');

    const handleFn = cg.getNodesInFile('pkg/zig/src/server/routes.zig').find((n) => n.kind === 'function' && n.name === 'handle')!;
    const handleCallees = cg.getCallees(handleFn.id).map((c) => `${c.node.filePath}::${c.node.qualifiedName}`);
    expect(handleCallees).toContain('pkg/zig/src/xev.zig::tick');
    expect(handleCallees).toContain('pkg/zig/src/core/engine_api.zig::Engine::open');
    expect(handleCallees).toContain('pkg/zig/src/core/engine_api.zig::learn');
    expect(handleCallees).toContain('pkg/zig/src/server/json.zig::stringify');
    expect(handleCallees).toContain('pkg/zig/src/families/lfm3.zig::forward');

    const openFn = cg.getNodesInFile('pkg/zig/src/core/engine_api.zig').find((n) => n.name === 'open')!;
    const openCallees = cg.getCallees(openFn.id).map((c) => `${c.node.filePath}::${c.node.name}`);
    expect(openCallees).toContain('pkg/zig/src/core/lanes.zig::schedule');

    const forwardFn = cg.getNodesInFile('pkg/zig/src/families/lfm3.zig').find((n) => n.name === 'forward')!;
    const forwardCallees = cg.getCallees(forwardFn.id).map((c) => `${c.node.filePath}::${c.node.name}`);
    expect(forwardCallees).toContain('pkg/zig/src/families/rope.zig::freq');
  });
});
