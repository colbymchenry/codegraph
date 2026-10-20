/**
 * A Swift call keeps its name and receiver through a prefix operator, `try`
 * and `await`.
 *
 * tree-sitter-swift binds a prefix operator to the leftmost operand:
 * `!isReady()` parses as `(!isReady)()` and `!store.contains(id)` as
 * `(!store).contains(id)`. `try` and `await` before a chain bind to the part
 * before its last call: `try! Reader().read(s)` is `(try! Reader()).read(s)`.
 * The call came out named `!isReady`, which links nothing, or lost its
 * receiver and name-matched whichever `contains` came first. Every target
 * here has a namesake on another type, so a guess can't pass.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'Sources/App/Store.swift': `final class Store {
    func contains(_ id: Int) -> Bool { false }
}
final class Bag {
    func contains(_ id: Int) -> Bool { true }
}
`,
  'Sources/App/Config.swift': `enum Config {
    static func check() -> Bool { true }
    static func offset() -> Int { 1 }
}
enum Audit {
    static func check() -> Bool { false }
    static func offset() -> Int { 2 }
}
`,
  'Sources/App/Settings.swift': `enum Settings {
    enum Defaults {
        static func isOn() -> Bool { true }
    }
}
enum Flags {
    enum Defaults {
        static func isOn() -> Bool { false }
    }
}
`,
  'Sources/App/Parser.swift': `final class Parser {
    static func make() -> Parser { Parser() }
    func parse(_ s: String) throws -> Int { 0 }
}
final class Lexer {
    func parse(_ s: String) throws -> Int { 1 }
}
final class Reader {
    func read(_ s: String) throws -> Int { 0 }
}
final class Tape {
    func read(_ s: String) throws -> Int { 1 }
}
final class Loader {
    static func shared() -> Loader { Loader() }
    func fetch(_ s: String) async throws -> Int { 0 }
}
final class Cache {
    func fetch(_ s: String) async throws -> Int { 1 }
}
`,
  'Sources/App/Screen.swift': `final class Screen {
    let store = Store()
    func isReady() -> Bool { true }
    func one() -> Bool { !isReady() }
    func two(_ id: Int) -> Bool { !store.contains(id) }
    func three() -> Bool { !Config.check() }
    func four() -> Int { -Config.offset() }
    func five() -> Bool { !Settings.Defaults.isOn() }
    func six(_ s: String) throws -> Int { try Parser.make().parse(s) }
    func seven(_ s: String) -> Int { try! Reader().read(s) }
    func eight(_ s: String) async throws -> Int { try await Loader.shared().fetch(s) }
    func nine() -> Bool { !(isReady()) }
}
`,
};

describe('Swift: a call through a prefix operator, try or await', () => {
  it('keeps its name and receiver', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-wrapped-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const reached = (caller: string): string[] => {
        const from = cg.getNodesByName(caller).find((n) => n.kind === 'method');
        expect(from, caller).toBeDefined();
        return cg
          .getOutgoingEdgesFrom([from!.id], ['calls', 'instantiates'])
          .map((e) => cg.getNode(e.target))
          .filter((n) => n && n.language === 'swift')
          .map((n) => n!.qualifiedName)
          .sort();
      };
      // `!isReady()` was a call of `!isReady`.
      expect(reached('one')).toEqual(['Screen::isReady']);
      // Through the receiver's type, not the first `contains`/`check`/`isOn`.
      expect(reached('two')).toEqual(['Store::contains']);
      expect(reached('three')).toEqual(['Config::check']);
      expect(reached('four')).toEqual(['Config::offset']);
      expect(reached('five')).toEqual(['Settings::Defaults::isOn']);
      // A chain after `try`, `try!` and `try await`: on what the first call returns.
      expect(reached('six')).toEqual(['Parser::make', 'Parser::parse']);
      expect(reached('seven')).toEqual(['Reader', 'Reader::read']);
      expect(reached('eight')).toEqual(['Loader::fetch', 'Loader::shared']);
      // A negated parenthesized call reaches the call inside.
      expect(reached('nine')).toEqual(['Screen::isReady']);
    } finally {
      cg.close();
    }
  });
});
