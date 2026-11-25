/**
 * A C++ call on a dereferenced variable, like `(*it)->Visit()` over a
 * `std::vector<Node*>`, or on a local an iterator's dereference initializes,
 * like `auto first = *nodes.begin(); first->Visit()`, calls a member of the
 * class the dereferenced value has. The extractor records the first by its
 * bare name, which went to whichever class had a method of that name, and
 * the second's local had no type.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-deref-iterator-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName`. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => r.node.qualifiedName)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** `Other` comes first: a call matched by its bare name lands on it. */
const NODES = {
  'src/node.h': lines(
    'class Other {',
    ' public:',
    '  int Visit() { return 2; }',
    '  int Weight() const { return 3; }',
    '};',
    'class Node {',
    ' public:',
    '  int Visit() { return 0; }',
    '  int Weight() const { return 1; }',
    '  Node* Child() { return this; }',
    '};',
  ),
};

describe('a C++ call on a dereferenced iterator or pointer', () => {
  it('reproduction: `(*it)->Visit()` over a `std::vector<Node*>`, and `(*it).Weight()` over a `std::vector<Node>`', async () => {
    const cg = await indexed({
      ...NODES,
      'src/walk.cc': lines(
        '#include <vector>',
        '#include "src/node.h"',
        'int Walk(std::vector<Node*>& nodes) {',
        '  int sum = 0;',
        '  for (std::vector<Node*>::iterator it = nodes.begin(); it != nodes.end(); ++it) sum += (*it)->Visit();',
        '  return sum;',
        '}',
        'int Weigh(std::vector<Node>& values) {',
        '  int sum = 0;',
        '  for (auto vit = values.begin(); vit != values.end(); ++vit) sum += (*vit).Weight();',
        '  return sum;',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Walk')).toEqual(['Node::Visit']);
      expect(calls(cg, 'Weigh')).toEqual(['Node::Weight']);
    } finally {
      cg.close();
    }
  });

  it('a local the dereference initializes, an element held in a smart pointer, and a raw pointer', async () => {
    const cg = await indexed({
      ...NODES,
      'src/first.cc': lines(
        '#include <memory>',
        '#include <vector>',
        '#include "src/node.h"',
        'int First(std::vector<Node*>& nodes) {',
        '  auto first = *nodes.begin();',
        '  return first->Visit();',
        '}',
        'int Owned(std::vector<std::unique_ptr<Node>>& owned) {',
        '  auto oit = owned.begin();',
        '  return (*oit)->Weight();',
        '}',
        'int Pointed(Node* node) {',
        '  return (*node).Weight();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'First')).toEqual(['Node::Visit']);
      expect(calls(cg, 'Owned')).toEqual(['Node::Weight']);
      expect(calls(cg, 'Pointed')).toEqual(['Node::Weight']);
    } finally {
      cg.close();
    }
  });

  it('`->` through an iterator in a chain, and in what initializes a local', async () => {
    const cg = await indexed({
      ...NODES,
      'src/chain.cc': lines(
        '#include <vector>',
        '#include "src/node.h"',
        'int Chain(std::vector<Node>& values) {',
        '  std::vector<Node>::iterator it = values.begin();',
        '  return it->Child()->Visit();',
        '}',
        'int Local(std::vector<Node>& values) {',
        '  std::vector<Node>::iterator it = values.begin();',
        '  auto child = it->Child();',
        '  return child->Visit();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Chain')).toEqual(['Node::Child', 'Node::Visit']);
      expect(calls(cg, 'Local')).toEqual(['Node::Child', 'Node::Visit']);
    } finally {
      cg.close();
    }
  });

  it('an element of a library type has no project method to call, nor does a free function of the name', async () => {
    const cg = await indexed({
      ...NODES,
      'src/names.cc': lines(
        '#include <string>',
        '#include <vector>',
        '#include "src/node.h"',
        'class Label {',
        ' public:',
        '  int size() const { return 0; }',
        '};',
        'int Visit() { return 9; }',
        'int Total(std::vector<std::string>& names) {',
        '  int n = 0;',
        '  for (auto sit = names.begin(); sit != names.end(); ++sit) n += (*sit).size();',
        '  return n;',
        '}',
        'int Each(std::vector<Node*>& nodes) {',
        '  std::vector<Node*>::iterator it = nodes.begin();',
        '  return (*it)->Visit();',
        '}',
      ),
    });
    try {
      expect(calls(cg, 'Total')).toEqual([]);
      expect(calls(cg, 'Each')).toEqual(['Node::Visit']);
    } finally {
      cg.close();
    }
  });
});
