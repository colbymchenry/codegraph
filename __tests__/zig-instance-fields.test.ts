import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';

it('keeps receiver inference when a local value has the same name as a container field', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-field-'));
  let graph: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(dir, 'main.zig'), `const Db = struct { pub fn exec(_: *Db) void {} };
const Service = struct {
    db: Db = .{},
    pub fn run(self: *Service) void {
        var db = self.db;
        db.exec();
    }
};
pub fn entry() void { var service: Service = .{}; service.run(); }
test { entry(); }
`);
    if (process.env.ZIG_COMPILER) {
      const result = spawnSync(process.env.ZIG_COMPILER, ['test', 'main.zig'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
    graph = await CodeGraph.init(dir, { index: true });
    const caller = graph.getNodesByKind('method').find(n => n.qualifiedName === 'Service::run')!;
    expect(caller).toBeDefined();
    const calls = graph.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => graph!.getNode(e.target)!.qualifiedName);
    expect(calls).toEqual(['Db::exec']);
  } finally { graph?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 90000);
