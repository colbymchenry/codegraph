/**
 * A Swift call on a standard-library value — an `[Int]`'s `sorted()`, `map`,
 * `filter`, `contains` — is the standard library's, not a project member that
 * happens to share the name: a `private struct TopKHeap { func sorted() }` is
 * not the target of `arr.sorted()`, nor of `values.map { … }.sorted()`, which
 * the extractor hands over as a bare `sorted`.
 *
 * Genuine calls still resolve: a receiver bound to a project type reaches that
 * type's method, and a bare call reaches a project free function of the name.
 *
 * Callers sit in a different file from the definitions, except the TopKHeap
 * call: the struct is `private`, so Swift only lets its own file call it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const CALLERS = 'Sources/Kit/Callers.swift';
const DEFS = 'Sources/Kit/Defs.swift';

async function indexFixture(prefix: string, files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  return { root, cg };
}

/** Qualified names of every `calls` target from the method `caller` in `file`. */
function callTargets(cg: CodeGraph, file: string, caller: string): string[] {
  const src = cg.getNodesInFile(file).filter((n) => n.name === caller);
  expect(src.length, `caller ${caller} in ${file}`).toBeGreaterThan(0);
  const edges = cg.getOutgoingEdgesFrom(src.map((n) => n.id)).filter((e) => e.kind === 'calls');
  return [...new Set(edges.map((e) => cg.getNode(e.target)!.qualifiedName))].sort();
}

describe('Swift calls on standard-library values (only project sorted/map/filter/contains are members)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexFixture('cg-swift-std-1-', {
      [DEFS]: `struct ProjectType {
    var n: Int = 0
}

private struct TopKHeap {
    var items: [Int] = []
    func sorted() -> [Int] { return items }
}

func useHeapLocal() -> [Int] {
    var heap = TopKHeap()
    return heap.sorted()
}

struct Bag {
    func map(_ f: (Int) -> Int) -> [Int] { return [] }
    func filter(_ f: (Int) -> Bool) -> [Int] { return [] }
    func contains(_ x: Int) -> Bool { return false }
}
`,
      [CALLERS]: `struct Holder {
    var items: [Int] = []

    func localTyped() -> [Int] { let arr: [Int] = [3, 1]; return arr.sorted() }
    func localInferred() -> [Int] { let arr = [3, 1]; return arr.sorted() }
    func param(_ arr: [Int]) -> [Int] { return arr.sorted() }
    func property() -> [Int] { return items.sorted() }
    func untypedLet(_ foo: Holder) -> [Int] { let x = foo.items; return x.sorted() }
    func mapChain(_ values: [Int]) -> [Int] { return values.map { $0 * 2 }.sorted() }
    func projectTypeNoSorted(_ p: ProjectType) -> [Int] { return p.sorted() }
    func arrayMap(_ xs: [Int]) -> [Int] { return xs.map { $0 } }
    func arrayFilter(_ xs: [Int]) -> [Int] { return xs.filter { $0 > 1 } }
    func arrayContains(_ xs: [Int]) -> Bool { return xs.contains(1) }
    func bagMap() -> [Int] { let bag = Bag(); return bag.map { $0 + 1 } }
}
`,
    }));
  }, 60000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a typed local array’s sorted() is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'localTyped')).not.toContain('TopKHeap::sorted');
  });

  it('an inferred array literal local’s sorted() is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'localInferred')).not.toContain('TopKHeap::sorted');
  });

  it('an [Int] parameter’s sorted() is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'param')).not.toContain('TopKHeap::sorted');
  });

  it('an [Int] property’s sorted() is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'property')).not.toContain('TopKHeap::sorted');
  });

  it('an untyped local bound from a property’s sorted() is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'untypedLet')).not.toContain('TopKHeap::sorted');
  });

  it('sorted() after a map chain is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'mapChain')).not.toContain('TopKHeap::sorted');
  });

  it('sorted() on a project type with no sorted is not TopKHeap.sorted', () => {
    expect(callTargets(cg, CALLERS, 'projectTypeNoSorted')).not.toContain('TopKHeap::sorted');
  });

  it('an [Int]’s map, filter and contains are not Bag’s', () => {
    const all = [
      ...callTargets(cg, CALLERS, 'arrayMap'),
      ...callTargets(cg, CALLERS, 'arrayFilter'),
      ...callTargets(cg, CALLERS, 'arrayContains'),
    ];
    expect(all.filter((q) => q.startsWith('Bag::'))).toEqual([]);
  });

  it('a TopKHeap local’s sorted() still reaches TopKHeap.sorted', () => {
    expect(callTargets(cg, DEFS, 'useHeapLocal')).toContain('TopKHeap::sorted');
  });

  it('a Bag local’s map still reaches Bag.map', () => {
    expect(callTargets(cg, CALLERS, 'bagMap')).toContain('Bag::map');
  });
});

describe('Swift calls on standard-library values (project also has a free sorted and a ProjectType.sorted)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexFixture('cg-swift-std-2-', {
      [DEFS]: `func sorted(_ xs: [Int]) -> [Int] { return xs }

struct ProjectType {
    var n: Int = 0
}

extension ProjectType {
    func sorted() -> [Int] { return [] }
}

private struct TopKHeap {
    var items: [Int] = []
    func sorted() -> [Int] { return items }
}
`,
      [CALLERS]: `struct Holder {
    func genuineFree(_ x: [Int]) -> [Int] { return sorted(x) }
    func genuineProject(_ p: ProjectType) -> [Int] { return p.sorted() }
    func localTyped() -> [Int] { let arr: [Int] = [3, 1]; return arr.sorted() }
    func mapChain(_ values: [Int]) -> [Int] { return values.map { $0 }.sorted() }
}
`,
    }));
  }, 60000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const isProjectSorted = (q: string): boolean => q === 'sorted' || q.endsWith('::sorted');

  it('a bare sorted(x) still reaches the free function', () => {
    expect(callTargets(cg, CALLERS, 'genuineFree')).toContain('sorted');
  });

  it('sorted() on a ProjectType parameter still reaches ProjectType.sorted', () => {
    expect(callTargets(cg, CALLERS, 'genuineProject')).toContain('ProjectType::sorted');
  });

  it('a typed local array’s sorted() reaches no project sorted', () => {
    expect(callTargets(cg, CALLERS, 'localTyped').filter(isProjectSorted)).toEqual([]);
  });

  it('sorted() after a map chain reaches no project sorted', () => {
    expect(callTargets(cg, CALLERS, 'mapChain').filter(isProjectSorted)).toEqual([]);
  });
});

// These cases need the receiver's type, which the standard-library name list
// does not give: the name alone cannot tell a std call from a project one here.
describe('Swift standard-library calls the name list alone cannot settle', () => {
  it.todo('bag.map { … }.sorted() on a project Bag whose map returns Bag reaches Bag.sorted, because the chain’s head type decides a std-named link after a trailing closure');
  it.todo('xs.sorted(limit: 1) on an [Int] reaches the project’s extension Array { func sorted(limit:) } by its argument label');
  it.todo('.append( on an array (adj[0].append(x), d[k, default: []].append(v), units.seen.append(x)) reaches no project or test-helper append, and a function declared inside another body is reached only from that body');
  it.todo('a multi-line chain such as let s = posts / .map { … } / .sorted { … }, whose call is recorded on the chain’s first line, reaches no project sorted');
});
