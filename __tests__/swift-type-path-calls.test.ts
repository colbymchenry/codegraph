/**
 * A Swift call through a type path lands on the type the path names.
 *
 * `API.PackageController.GetRoute.query(on:)` kept only `query`, which
 * exact-matched whichever type's `query` came first — in a Vapor app every
 * route type has one, so a health check "called" the dependency controller's
 * query. The path is now kept and resolved on its type: declared nested,
 * in `extension API.PackageController { … }`, in `extension A.B.C { … }`,
 * shortened inside its namespace, or module-qualified. A path that names no
 * project type is left unresolved.
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
  'Sources/App/API.swift': `enum API {}
extension API {
    enum PackageController {
        enum GetRoute {
            static func query(on db: Int) -> Int { db }
            static func query(on db: Int, limit: Int) -> Int { db + limit }
        }
        struct Model { let name: String }
    }
}
extension API.PackageController {
    enum ShowRoute {
        static func query(on db: Int) -> Int { db }
    }
}
extension API.DependencyController.GetRoute {
    static func query(on db: Int) -> Int { db }
}
extension API {
    enum DependencyController {
        enum GetRoute {}
        static func inside() -> Int { PackageController.GetRoute.query(on: 0) }
    }
}
`,
  'Sources/App/Other.swift': `enum Other { static func query(on db: Int) -> Int { db } }
enum Gitlab { enum Error: Swift.Error { case requestFailed(status: Int) } }
enum Remote { enum Error: Swift.Error { case requestFailed(status: Int) } }
struct Detail {}
enum Screens {
    @Reducer
    enum Path { case detail(Detail) }
}
enum Zed { enum GetRoute { static func query(on db: Int) -> Int { db } } }
enum Yon { enum GetRoute { static func query(on db: Int) -> Int { db } } }
`,
  'Sources/App/Basics.swift': `struct BasicsView {}
struct ObservableBasicsView {}
extension BasicsView { struct Feature {} }
extension ObservableBasicsView { struct Feature {} }
extension BasicsView.Feature { struct State {} }
extension ObservableBasicsView.Feature { struct State {} }
`,
  'Sources/App/Health.swift': `import Foundation
enum Health {
    static func one() -> Int { API.PackageController.GetRoute.query(on: 1) }
    static func two() -> Int {
        API.PackageController.GetRoute
            .query(on: 2)
    }
    static func three() -> Int { Other.query(on: 3) }
    static func four() -> Int { API.PackageController.ShowRoute.query(on: 4) }
    static func five() -> Int { API.DependencyController.GetRoute.query(on: 5) }
    static func six() -> API.PackageController.Model { API.PackageController.Model(name: "x") }
    static func seven() -> Int { App.Zed.GetRoute.query(on: 7) }
    static func eight() -> Int { Missing.Thing.query(on: 8) }
    static func nine() -> Int { API.PackageController.GetRoute.nothing(on: 9) }
    static func ten() throws { throw Gitlab.Error.requestFailed(status: 10) }
    static func eleven() { _ = Screens.Path.State.detail(Detail()) }
    static func twelve() { _ = ObservableBasicsView.Feature.State() }
}
`,
};

describe('Swift: a call through a type path', () => {
  it('lands on the type the path names, or nowhere', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-type-path-'));
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
          .map((n) => `${n!.qualifiedName}:${n!.startLine}`)
          .sort();
      };
      // The first declared of GetRoute's two overloads.
      expect(reached('one')).toEqual(['API::PackageController::GetRoute::query:5']);
      expect(reached('two')).toEqual(['API::PackageController::GetRoute::query:5']);
      expect(reached('three')).toEqual(['Other::query:1']);
      // Declared in `extension API.PackageController { enum ShowRoute … }`.
      expect(reached('four')).toEqual(['PackageController::ShowRoute::query:13']);
      // Declared in `extension API.DependencyController.GetRoute { … }`.
      expect(reached('five')).toEqual(['GetRoute::query:17']);
      // A nested type's initializer.
      expect(reached('six')).toEqual(['API::PackageController::Model:8']);
      // A module qualifier.
      expect(reached('seven')).toEqual(['Zed::GetRoute::query:9']);
      // No such type, and no such member: nothing, not some other type's `query`.
      expect(reached('eight')).toEqual([]);
      expect(reached('nine')).toEqual([]);
      // A case with associated values.
      expect(reached('ten')).toEqual(['Gitlab::Error::requestFailed:2']);
      // The case a TCA `@Reducer enum` generates its State from.
      expect(reached('eleven')).toContain('Screens::Path::detail:7');
      // Two types share the qualified name `Feature::State`; the extension each is declared in tells them apart.
      expect(reached('twelve')).toEqual(['Feature::State:6']);
      // Shortened inside its namespace.
      expect(reached('inside')).toEqual(['API::PackageController::GetRoute::query:5']);
    } finally {
      cg.close();
    }
  });
});
