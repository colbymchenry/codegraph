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
});
