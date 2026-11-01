/**
 * Swift overloads can differ in nothing but whether they take a function:
 *
 *   func write<U>(_ closure: (inout Value) throws -> U) rethrows -> U  // Alamofire's Protected
 *   func write(_ value: Value)
 *
 * `didStop.write(true)` passes a value and `write { $0 = value }` a closure, and
 * both reached the first declared, or, inside `write(_ value:)`, that method
 * itself. A trailing closure also dropped out of the label check altogether, so
 * Kingfisher's `clearCache { … }` in `clearCache() async` called itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'Protected.swift': `final class Protected<Value> {
    private var value: Value
    init(_ value: Value) { self.value = value }
    @discardableResult
    func write<U>(_ closure: (inout Value) throws -> U) rethrows -> U {
        try closure(&self.value)
    }
    func write(_ value: Value) {
        write { $0 = value }
    }
}
`,
  'Cache.swift': `final class Cache {
    func clear(handler: (@Sendable () -> Void)? = nil) {}
    func clear() async {
        await withCheckedContinuation { continuation in
            clear { continuation.resume() }
        }
    }
    func store(_ image: String, forKey key: String, options: Int, done: @escaping (Int) -> Void) {}
    func store(_ image: String, forKey key: String, done: @escaping (Int) -> Void) {}
    func accept(contentType: @autoclosure () -> String) {}
    func accept(statusCode: Int) {}
    func take(_ items: [() -> Void]) {}
    func take(_ count: Int) {}
    func has(_ key: String, then done: () -> Void) -> Bool { true }
    func has(_ key: String) -> Bool { true }
}
`,
  'Use.swift': `final class Use {
    func value() {
        let completed = Protected<Int?>(nil)
        completed.write(3)
    }
    func closure() {
        let completed = Protected<Int?>(nil)
        completed.write { $0 = 1 }
    }
    func closureInParens() {
        let completed = Protected<Int?>(nil)
        completed.write({ $0 = 1 })
    }
    func trailingWithLabels(cache: Cache) {
        cache.store("a", forKey: "k") { _ in }
    }
    func trailingWithAllLabels(cache: Cache) {
        cache.store("a", forKey: "k", options: 1) { _ in }
    }
    func autoclosure(cache: Cache) {
        cache.accept(contentType: "text")
    }
    func condition(cache: Cache) {
        if cache.has("k") {
            print("yes")
        }
    }
}
`,
};

describe('a Swift closure goes to the overload that takes a function', () => {
  let dir: string;
  let cg: CodeGraph;

  /** The source a declaration's first lines hold: its attribute and its `func` line. */
  const declaration = (n: Node): string => FILES[n.filePath]!.split('\n').slice(n.startLine - 1, n.startLine + 1).join(' ');

  const paramsCalled = (name: string, callee: string, file = 'Use.swift'): string[] => {
    const from = cg.getNodesByKind('method').find((n: Node) => n.name === name && n.filePath === file && !declaration(n).includes('_ closure:'));
    expect(from, name).toBeDefined();
    return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
      .filter((n) => n.name === callee).map(declaration);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-closure-'));
    for (const [rel, text] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, rel), text);
    cg = await CodeGraph.init(dir, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends a value to the overload that takes one', () => {
    expect(paramsCalled('value', 'write').join()).toContain('_ value: Value');
  });

  it('sends a closure there or trailing to the overload that takes a function', () => {
    expect(paramsCalled('closure', 'write').join()).toContain('_ closure:');
    expect(paramsCalled('closureInParens', 'write').join()).toContain('_ closure:');
  });

  it('takes a call inside an overload to the other one, not to itself', () => {
    expect(paramsCalled('write', 'write', 'Protected.swift').join()).toContain('_ closure:');
    const async = cg.getNodesByKind('method').find((n) => n.name === 'clear' && FILES[n.filePath]!.split('\n')[n.startLine - 1]!.includes('async'))!;
    const called = cg.getOutgoingEdges(async.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
      .filter((n) => n.name === 'clear').map(declaration);
    expect(called.join()).toContain('handler:');
  });

  it('reads a trailing closure with the labels before it', () => {
    expect(paramsCalled('trailingWithLabels', 'store').join()).not.toContain('options:');
    expect(paramsCalled('trailingWithAllLabels', 'store').join()).toContain('options:');
  });

  it('takes the `{` after a condition for the statement\'s', () => {
    const called = paramsCalled('condition', 'has').join();
    expect(called).not.toContain('then done');
  });

  it('takes an `@autoclosure` parameter for a value', () => {
    expect(paramsCalled('autoclosure', 'accept').join()).toContain('contentType:');
  });
});
