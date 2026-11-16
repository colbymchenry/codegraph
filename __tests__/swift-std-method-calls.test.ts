/**
 * A Swift call on a standard-library value — an `[Int]`'s `sorted()`, `map`,
 * `filter`, `contains` — is the standard library's, not a project member that
 * happens to share the name: a `private struct TopKHeap { func sorted() }` is
 * not the target of `arr.sorted()`, nor of `values.map { … }.sorted()`, which
 * the extractor hands over as a bare `sorted`. The exception: a call that
 * reaches a member the project adds to an outside type (`xs.sorted(limit: 1)`
 * on an `[Int]`, with `extension Array { func sorted(limit:) }`), and only when
 * the call's argument labels fit that member. A call whose only evidence is a
 * label a project member declares (`x.contains(jpeg: 1)` on a `Bag` that
 * `makeBag()` returns) is held, not claimed: a label alone cannot tell a
 * project namesake from an SDK method, and the receiver's type is not read from
 * source text.
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

describe('Swift standard-library names on an untyped receiver: an outside type the project extends, and label-only evidence', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexFixture('cg-swift-std-3-', {
      [DEFS]: `import Foundation

struct Bag {
    func contains(jpeg: Int) -> Bool { return false }
}

func makeBag() -> Bag { return Bag() }

extension Array {
    func sorted(limit: Int) -> [Element] { return self }
}

struct Parser {
    func components(separatedBy s: String) -> [String] { return [] }
}

func makeText() -> String { return "" }

struct Query {
    func appending(queryItems: [Int]) -> Query { return self }
}

func makeURL() -> URL { return URL(fileURLWithPath: "/") }
`,
      [CALLERS]: `import Foundation

struct Holder {
    func factoryLabel() -> Bool {
        let x = makeBag()
        return x.contains(jpeg: 1)
    }
    func factoryNoLabel(_ n: Int) -> Bool {
        let x = makeBag()
        return x.contains(n)
    }
    func factoryWrappedLabel() -> Bool {
        let x = makeBag()
        return x.contains(
            jpeg: 1)
    }
    func factoryWrappedNoLabel(_ n: Int) -> Bool {
        let x = makeBag()
        return x.contains(
            n)
    }
    func factoryLabelAfterArrayCall(_ xs: [Int]) -> Bool {
        let x = makeBag()
        let a = xs.contains(1); return a && x.contains(jpeg: 1)
    }
    func extensionParam(_ xs: [Int]) -> [Int] {
        return xs.sorted(limit: 1)
    }
    func extensionLocal() -> [Int] {
        let xs: [Int] = [3, 1]
        return xs.sorted(limit: 1)
    }
    func extensionNoArgs(_ xs: [Int]) -> [Int] {
        return xs.sorted()
    }
    func stdLabelCall() -> [String] {
        let x = makeText()
        return x.components(separatedBy: ",")
    }
    func urlQueryItems() -> URL {
        let u = makeURL()
        return u.appending(queryItems: [])
    }
    func trailingClosureSort(_ xs: [Int]) -> [Int] {
        return xs.sorted { $0 < $1 }
    }
    func laterLabelledSort(_ ys: [Int]) -> [Int] {
        return ys.sorted(limit: 1)
    }
}
`,
    }));
  }, 60000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.todo('x.contains(jpeg: 1) on a factory result reaches Bag.contains(jpeg:) by its label — held: without the receiver’s type a label cannot tell a project member from an SDK or dependency namesake');

  it('x.contains(n) on a factory result, with no label Bag declares, is not Bag.contains', () => {
    expect(callTargets(cg, CALLERS, 'factoryNoLabel')).not.toContain('Bag::contains');
  });

  it.todo('x.contains( with jpeg: on the next line reaches Bag.contains(jpeg:) by its label — held with the label case above: reading a wrapped argument list refines only that case');

  it('x.contains( with an unlabeled argument on the next line is not Bag.contains', () => {
    expect(callTargets(cg, CALLERS, 'factoryWrappedNoLabel')).not.toContain('Bag::contains');
  });

  it.todo('x.contains(jpeg: 1) after xs.contains(1) on the same line reaches Bag.contains(jpeg:) by its own label — held with the label case above: reading the label at the call’s own column refines only that case');

  it('xs.sorted(limit: 1) on an [Int] parameter reaches the project’s extension Array', () => {
    expect(callTargets(cg, CALLERS, 'extensionParam')).toContain('Array::sorted');
  });

  it('xs.sorted(limit: 1) on a local annotated [Int] reaches the project’s extension Array', () => {
    expect(callTargets(cg, CALLERS, 'extensionLocal')).toContain('Array::sorted');
  });

  it('xs.sorted() on an [Int] parameter, with no argument the extension’s sorted(limit:) takes, is not Array.sorted', () => {
    expect(callTargets(cg, CALLERS, 'extensionNoArgs')).not.toContain('Array::sorted');
  });

  it('x.components(separatedBy: ",") on a String factory result is not the project’s Parser.components: a label alone is no evidence', () => {
    expect(callTargets(cg, CALLERS, 'stdLabelCall')).not.toContain('Parser::components');
  });

  it('u.appending(queryItems: []) on a URL factory result is not the project’s Query.appending', () => {
    expect(callTargets(cg, CALLERS, 'urlQueryItems')).not.toContain('Query::appending');
  });

  it('xs.sorted { … } with a trailing closure does not take the labels of a later sorted(limit:) call, so it is not Array.sorted', () => {
    expect(callTargets(cg, CALLERS, 'trailingClosureSort')).not.toContain('Array::sorted');
  });

  it('ys.sorted(limit: 1) after a trailing-closure sorted still reaches the project’s extension Array', () => {
    expect(callTargets(cg, CALLERS, 'laterLabelledSort')).toContain('Array::sorted');
  });
});

describe('Swift standard-library names on a URL factory result, where the project has one namesake for the name', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexFixture('cg-swift-std-4-', {
      [DEFS]: `import Foundation

struct PathBuilder {
    func appending(components: String...) -> PathBuilder { return self }
}

func makeURL() -> URL { return URL(fileURLWithPath: "/") }
`,
      [CALLERS]: `import Foundation

struct Holder {
    func urlComponents() -> URL {
        let u = makeURL()
        return u.appending(components: "a", "b")
    }
}
`,
    }));
  }, 60000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('u.appending(components: "a", "b") on a URL factory result is not the project’s PathBuilder.appending', () => {
    expect(callTargets(cg, CALLERS, 'urlComponents')).not.toContain('PathBuilder::appending');
  });
});

// These cases need the receiver's type, which the standard-library name list
// does not give: the name alone cannot tell a std call from a project one here.
describe('Swift standard-library calls the name list alone cannot settle', () => {
  it.todo('bag.map { … }.sorted() on a project Bag whose map returns Bag reaches Bag.sorted, because the chain’s head type decides a std-named link after a trailing closure');
  it.todo('.append( on an array (adj[0].append(x), d[k, default: []].append(v), units.seen.append(x)) reaches no project or test-helper append, and a function declared inside another body is reached only from that body');
  it.todo('a multi-line chain such as let s = posts / .map { … } / .sorted { … }, whose call is recorded on the chain’s first line, reaches no project sorted');
});
