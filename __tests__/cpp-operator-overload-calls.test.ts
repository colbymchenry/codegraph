/**
 * An overloaded operator that calls its own name: `operator++(int)` written
 * as `this->operator++(); return before;`. Choosing the overload reads the argument
 * list after the name — and the name went into a pattern unescaped, so `++`
 * was "Nothing to repeat" and the whole index stopped at reference resolution
 * (#2457); `operator()` read the empty `()` of its own name as the arguments.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-operator-overload-'));
  const files: Record<string, string> = {
    'src/counter.hpp': `#pragma once

struct Counter {
  int value = 0;

  Counter operator++(int) {
    Counter before = *this;
    this->operator++();
    return before;
  }

  Counter& operator++() {
    ++value;
    return *this;
  }
};
`,
    'src/scale.hpp': `#pragma once

struct Scale {
  int operator()(int x) {
    return this->operator()(x, 2);
  }

  int operator()(int x, int factor) {
    return x * factor;
  }
};
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

/** `callerLine -> targetLine` of the calls between same-named methods of a file. */
const selfNamed = (file: string, name: string) => {
  const nodes = cg.getNodesInFile(file).filter((n) => n.name === name);
  const ids = new Set(nodes.map((n) => n.id));
  return cg.getOutgoingEdgesFrom([...ids]).filter((e) => e.kind === 'calls' && ids.has(e.target))
    .map((e) => `${cg.getNode(e.source)!.startLine} -> ${cg.getNode(e.target)!.startLine}`);
};

describe('a C++ operator calling its own name', () => {
  it('operator++: the index is built, and the call reaches the overload the arguments fit', () => {
    expect(selfNamed('src/counter.hpp', 'operator++')).toEqual(['6 -> 12']);
  });

  it('operator(): the arguments are the list after the name, not the name\'s own parentheses', () => {
    expect(selfNamed('src/scale.hpp', 'operator()')).toEqual(['4 -> 8']);
  });
});
