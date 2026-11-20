/**
 * Choosing among a C++ method's overloads types the call's arguments, and an
 * argument can be a call of that same overloaded method:
 * `extras(extras(id).prev()).set_next(…)` on a class with a const and a
 * non-const `extras(id)`. Typing `extras(id).prev()` types `extras(id)`, whose
 * overload is chosen by the arguments of the call the reference is at — the
 * outer one — so the choice re-entered itself with a fresh depth on every lap
 * until the stack ran out, and the whole index failed ("Maximum call stack size
 * exceeded"). A re-entered choice now takes the first overload, as one whose
 * arguments' types are unknown does.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-overload-reentry-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/builder.h'), `#pragma once

class Builder {
 public:
  struct Extra {
    int prev() const { return prev_; }
    int next() const { return next_; }
    void set_prev(int prev) { prev_ = prev; }
    void set_next(int next) { next_ = next; }
    int prev_;
    int next_;
  };

  void unlink(int id) {
    extras(extras(id).prev()).set_next(extras(id).next());
    extras(extras(id).next()).set_prev(extras(id).prev());
  }

 private:
  const Extra &extras(int id) const { return extras_[id]; }
  Extra &extras(int id) { return extras_[id]; }

  Extra extras_[16];
};
`);
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('a C++ overload chosen by arguments that call the same overloaded method', () => {
  it('indexes, and links the calls in the method', async () => {
    cg = await CodeGraph.init(root, { index: true });
    const unlink = cg.getNodesInFile('src/builder.h').find((n) => n.name === 'unlink')!;
    expect(unlink).toBeDefined();
    const called = new Set(cg.getOutgoingEdges(unlink.id).filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!.name));
    expect(called).toContain('extras');
    expect(called).toContain('set_next');
    expect(called).toContain('set_prev');
  });
});
