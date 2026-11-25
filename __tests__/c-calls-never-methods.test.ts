/**
 * C has no methods and cannot call a C++ one: redis' POSIX `read(fd, buf, n)`
 * calls and hiredis' function pointer `c->funcs->read(c, buf, …)` all went to
 * the Qt adapter's `RedisQtAdapter::read` in a C++ header.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c-methods-'));
  const files: Record<string, string> = {
    'deps/hiredis/adapters/qt.hpp': `class RedisQtAdapter {
public:
    void read() { }
};
`,
    'src/util.c': `#include <unistd.h>

long slurp(int fd, char *buf, long n) {
    return read(fd, buf, n);
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('C calls', () => {
  it('never reach a C++ method', () => {
    const ids = cg.getNodesInFile('src/util.c').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(targets).not.toContain('RedisQtAdapter::read');
  });
});
