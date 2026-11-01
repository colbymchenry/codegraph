/**
 * A Swift static call `Type.member()` whose member is external records a
 * `references` edge from the caller to the project type, while the call stays
 * unresolved.
 *
 * `MyTool.main()` on an ArgumentParser `ParsableCommand`, or `Todo.query(on:)`
 * on a Fluent `Model`, calls a member the library supplies: no project symbol
 * declares it, so the call cannot resolve. The type it is called on is the
 * project's own, though, and the caller depends on it. When the receiver names
 * a project Swift type (not an `extension X {}`; a nested type only in its
 * scope or through its path; not a `typealias`; not another file's `private`
 * type; not a type in a SwiftPM module the caller's file neither belongs to,
 * imports, nor sees through an `@_exported import`), and neither the type, its extensions, nor its project supertypes and
 * protocols (and their extensions) declare the member, the caller gets one
 * `references` edge to the type. A member the grammar indexes under one of the
 * type's methods still counts as declared; a member of a type nested in it
 * does not. The `calls` reference stays in `unresolved_refs` as `failed`.
 *
 * Known limits, pinned here: an alias receiver gets no edge (an `it.todo` holds
 * the edge it should get); a local or parameter that shadows a project type's
 * name cannot be told from the type, since Swift locals/params are not indexed
 * (`it.fails`); a sync that makes the call resolve leaves the parked
 * `references` edge in place (`it.fails`); and a member of an extension the
 * extraction ends early reads as external (`it.fails`).
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

// No method named `main` anywhere in the project.
const FILES: Record<string, string> = {
  'Sources/Tool/MyTool.swift': `import ArgumentParser
struct MyTool: ParsableCommand { func run() throws {} }
`,
  'Sources/Tool/API.swift': `enum API { struct Tool: ParsableCommand { func run() throws {} } }
`,
  'Sources/Tool/Own.swift': `struct Helper { static func help() -> Int { 1 } }
class BaseCmd { class func launch() {} }
final class SubCmd: BaseCmd {}
protocol Runner {}
extension Runner { static func go() {} }
struct Job: Runner {}
struct Ext {}
extension Ext { static func make() {} }
enum E: Error { case bad(Int) }
extension JSONDecoder { func x() {} }
enum Outer { struct Inner {} }
`,
  'Sources/App/Todo.swift': `import Fluent
final class Todo: Model {}
`,
  // 14. A case of an enum nested in an enum, thrown from the outer enum's method
  // (the shape of a migrator's `MigrationError`).
  'Sources/Enc/EstateMigrator.swift': `import Foundation
public enum EstateMigrator {
    /// Why a migration step refused or failed.
    public enum MigrationError: Error, CustomStringConvertible, Equatable {
        /// The source file is not a readable plaintext SQLite database.
        case sourceNotPlaintext(path: String)
        /// A sqlite3 call failed.
        case sqlite(step: String, detail: String)
        /// The install key file could not be created or read.
        case installKeyUnavailable(path: String, detail: String)
        public var description: String { "migration" }
    }
    public struct LoadedInstallKey { let bytes: [UInt8] }
    public static func encryptedEstate(in directory: URL) throws -> String? {
        let base = directory
        guard let stream = opendir(base.path) else {
            let code = errno
            if code == ENOENT { return nil }
            throw MigrationError.installKeyUnavailable(
                path: directory.path,
                detail: "list the key directory: \\(code)")
        }
        defer { closedir(stream) }
        return nil
    }
}
`,
  // 15. A private case enum nested in a struct.
  'Sources/Enc/MerklePrimitive.swift': `struct MerklePrimitive {
    private enum PrimitiveError: Error, CustomStringConvertible {
        case message(String)
        var description: String { "merkle" }
    }
    func run() throws { throw PrimitiveError.message("bad root") }
}
`,
  // 17. The grammar ends `restore` late (an `if try await f(a,` call split over
  // two lines), indexing `receivedFacts` as `Receiver::restore::receivedFacts`.
  'Sources/Kit/Receiver.swift': `actor Receiver {
    private func restore(_ keys: [String]) async throws -> Int {
        var restored = 0
        for key in keys {
            if try await survive(key,
                                 limit: 1) { restored += 1 }
        }
        _ = try await store(key: 1,
            stamp: 2)
        return restored
    }
    private func survive(_ key: String, limit: Int) async throws -> Bool { true }
    private func store(key: Int, stamp: Int) async throws -> Int { 0 }
    nonisolated static func receivedFacts(_ x: Int) throws -> Int { x }
}
`,
  // 18. Type aliases of project types, used in their own file.
  'Sources/Kit/Wire.swift': `enum WireProtocol { struct Request { let id: Int } }
`,
  'Tests/KitTests/WireTests.swift': `@testable import Enc
@testable import Kit
private typealias P = WireProtocol
private typealias Mig = EstateMigrator
private typealias MigrationError = EstateMigrator.MigrationError
enum WireTests {
    static func request() { _ = P.Request(id: 1) }
    static func loaded() { _ = Mig.LoadedInstallKey(bytes: []) }
    static func thrown() throws { throw MigrationError.sqlite(step: "open", detail: "x") }
    static func external() { _ = P.decodeAll() }
}
`,
  // Todo is in module App and Receiver in Kit; Entry's file imports both.
  'Sources/Tool/Entry.swift': `import App
import Kit
enum Entry {
    static func start() { MyTool.main() }
    static func args() { MyTool.main(["a"]) }
    static func pathed() { API.Tool.main() }
    static func own() -> Int { Helper.help() }
    static func inherited() { SubCmd.launch() }
    static func proto() { Job.go() }
    static func extended() { Ext.make() }
    static func enumCase() throws { throw E.bad(1) }
    static func sdk() { _ = JSONDecoder.default() }
    static func nested() { Inner.main() }
    static func fetch(db: Int) { _ = Todo.query(on: db) }
    static func received() throws -> Int { try Receiver.receivedFacts(1) }
}
`,
};

function makeProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function caller(cg: CodeGraph, name: string) {
  const from = cg
    .getNodesByName(name)
    .find((n) => n.kind === 'method' && n.qualifiedName === `Entry::${name}`);
  expect(from, name).toBeDefined();
  return from!;
}

/** Edges of `kinds` from `Entry.<from>` to Swift nodes named `target`, as `kind -> nodeKind qualifiedName`. */
function edgesTo(cg: CodeGraph, from: string, target: string, kinds?: string[]): string[] {
  return cg
    .getOutgoingEdgesFrom([caller(cg, from).id], kinds as never)
    .map((e) => ({ e, n: cg.getNode(e.target) }))
    .filter(({ n }) => n && n.language === 'swift' && n.name === target)
    .map(({ e, n }) => `${e.kind} -> ${n!.kind} ${n!.qualifiedName}`)
    .sort();
}

/** Edges of `kinds` from the method `qualifiedName` to Swift nodes named `target`, as `kind -> nodeKind qualifiedName`. */
function edgesFromMethod(cg: CodeGraph, qualifiedName: string, target: string, kinds?: string[]): string[] {
  const name = qualifiedName.slice(qualifiedName.lastIndexOf('::') + 2);
  const from = cg.getNodesByName(name).find((n) => n.kind === 'method' && n.qualifiedName === qualifiedName);
  expect(from, qualifiedName).toBeDefined();
  return cg
    .getOutgoingEdgesFrom([from!.id], kinds as never)
    .map((e) => ({ e, n: cg.getNode(e.target) }))
    .filter(({ n }) => n && n.language === 'swift' && n.name === target)
    .map(({ e, n }) => `${e.kind} -> ${n!.kind} ${n!.qualifiedName}`)
    .sort();
}

/** `unresolved_refs` rows from `Entry.<from>` named `refName`, as `kind status`. */
function unresolvedFrom(root: string, cg: CodeGraph, from: string, refName: string): string[] {
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    return (db.getDb()
      .prepare('SELECT reference_kind, status FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ?')
      .all(caller(cg, from).id, refName) as Array<Record<string, unknown>>)
      .map((r) => `${r.reference_kind} ${r.status}`);
  } finally {
    db.close();
  }
}

describe('Swift: a static call to an external member of a project type', () => {
  it('references the project type, keeps the call unresolved, and leaves declared members alone', async () => {
    const root = makeProject('cg-swift-ext-member-');
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // 1. ArgumentParser's `main` on a ParsableCommand.
      expect.soft(edgesTo(cg, 'start', 'MyTool'), 'start').toEqual(['references -> struct MyTool']);
      expect.soft(unresolvedFrom(root, cg, 'start', 'MyTool.main'), 'start unresolved').toEqual(['calls failed']);
      // 2. With arguments.
      expect.soft(edgesTo(cg, 'args', 'MyTool', ['references']), 'args').toEqual(['references -> struct MyTool']);
      // 3. Through a type path, onto the nested type. (A reference to API itself is extraction's business.)
      expect.soft(edgesTo(cg, 'pathed', 'Tool', ['references']), 'pathed').toEqual(['references -> struct API::Tool']);
      // 4. Fluent's `query(on:)` on a Model: the edge, and the unresolved row survives.
      expect.soft(edgesTo(cg, 'fetch', 'Todo', ['references']), 'fetch').toEqual(['references -> class Todo']);
      expect.soft(unresolvedFrom(root, cg, 'fetch', 'Todo.query'), 'fetch unresolved').toEqual(['calls failed']);

      // Controls: a member the project declares, or a receiver out of scope, gets no reference.
      // 7. Declared on the type: the call resolves.
      expect.soft(edgesTo(cg, 'own', 'help', ['calls']), 'own calls').toEqual(['calls -> method Helper::help']);
      expect.soft(edgesTo(cg, 'own', 'Helper', ['references']), 'own').toEqual([]);
      // 8. Declared on a project superclass.
      expect.soft(edgesTo(cg, 'inherited', 'SubCmd', ['references']), 'inherited').toEqual([]);
      // 9. Declared in an extension of a project protocol.
      expect.soft(edgesTo(cg, 'proto', 'Job', ['references']), 'proto').toEqual([]);
      // 10. Declared in an extension of the type.
      expect.soft(
        edgesTo(cg, 'extended', 'Ext', ['references']).filter((s) => s.includes('-> struct ')),
        'extended'
      ).toEqual([]);
      // 11. An enum case.
      expect.soft(edgesTo(cg, 'enumCase', 'E', ['references']), 'enumCase').toEqual([]);
      // 12. The project only extends JSONDecoder; it does not declare it.
      expect.soft(edgesTo(cg, 'sdk', 'JSONDecoder'), 'sdk').toEqual([]);
      // 13. A nested type named bare.
      expect.soft(edgesTo(cg, 'nested', 'Inner'), 'nested').toEqual([]);
      // 14. A case of an enum nested in another enum, thrown from the outer enum's method.
      expect.soft(
        edgesFromMethod(cg, 'EstateMigrator::encryptedEstate', 'MigrationError', ['references']),
        'nested enum case'
      ).toEqual([]);
      // 15. A case of a private enum nested in a struct.
      expect.soft(edgesFromMethod(cg, 'MerklePrimitive::run', 'PrimitiveError', ['references']), 'private nested case').toEqual([]);
      // 17. A member indexed under a method of the type.
      expect.soft(edgesTo(cg, 'received', 'Receiver', ['references']), 'member under a method').toEqual([]);
      // 18. Current behaviour: an alias receiver gets no edge, whatever the member. The index
      // does not hold what an alias names, so whether that type declares the member cannot be
      // told. Pinned for a nested type through an alias (P.Request), a nested type of an alias
      // of the outer type (Mig.LoadedInstallKey), a case of an alias of the nested enum
      // (MigrationError.sqlite), and a member no project type declares (P.decodeAll).
      expect.soft(edgesFromMethod(cg, 'WireTests::request', 'P', ['references']), 'alias nested type').toEqual([]);
      expect.soft(edgesFromMethod(cg, 'WireTests::loaded', 'Mig', ['references']), 'alias outer type').toEqual([]);
      expect.soft(
        edgesFromMethod(cg, 'WireTests::thrown', 'MigrationError', ['references']),
        'alias nested enum'
      ).toEqual([]);
      expect.soft(edgesFromMethod(cg, 'WireTests::external', 'P', ['references']), 'alias external').toEqual([]);
    } finally {
      cg.close();
    }
  });

  it.todo('alias receiver → references edge to the alias once extraction stores its target and visibility');

  it('keeps the reference through a sync, and drops it when the type goes away', async () => {
    const root = makeProject('cg-swift-ext-member-sync-');
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // 5. Re-index the caller's file.
      fs.appendFileSync(path.join(root, 'Sources/Tool/Entry.swift'), '// touched\n');
      await cg.sync();
      expect.soft(edgesTo(cg, 'start', 'MyTool', ['references']), 'after edit').toEqual(['references -> struct MyTool']);

      // 6. Delete the type.
      fs.rmSync(path.join(root, 'Sources/Tool/MyTool.swift'));
      await cg.sync();
      expect(edgesTo(cg, 'start', 'MyTool'), 'after delete').toEqual([]);
      expect(unresolvedFrom(root, cg, 'start', 'MyTool.main'), 'after delete unresolved').toEqual(['calls failed']);
    } finally {
      cg.close();
    }
  });
});

/** A throwaway project of `files`. */
function makeProjectOf(prefix: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** `unresolved_refs` rows from the method `qualifiedName` named `refName`, as `kind status`. */
function rowsFromMethod(root: string, cg: CodeGraph, qualifiedName: string, refName: string): string[] {
  const name = qualifiedName.slice(qualifiedName.lastIndexOf('::') + 2);
  const from = cg.getNodesByName(name).find((n) => n.kind === 'method' && n.qualifiedName === qualifiedName);
  expect(from, qualifiedName).toBeDefined();
  const db = DatabaseConnection.open(getDatabasePath(root));
  try {
    return (db.getDb()
      .prepare('SELECT reference_kind, status FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ?')
      .all(from!.id, refName) as Array<Record<string, unknown>>)
      .map((r) => `${r.reference_kind} ${r.status}`);
  } finally {
    db.close();
  }
}

describe('Swift: what a static call on a type is, before it references the type', () => {
  it('counts a backticked case as declared, and needs a receiver the caller can see', async () => {
    const root = makeProjectOf('cg-swift-ext-member-scope-', {
      // A case whose name is a keyword is indexed with its backticks.
      'Sources/Kit/Predicate.swift': `public enum StoragePredicate {
    case isNull(Int)
    case \`in\`(Int, [Int])
}
`,
      // A private type is visible in its own file only.
      'Tests/KitTests/Aliases.swift': `private typealias W = CoreAINuExtractWorkerProtocol
private struct M { static func x() {} }
`,
      'Sources/Lib/SVD.swift': `struct JacobiSVD {
    func decompose() throws {
        var W = [Float](repeating: 0, count: 4)
        try W.withUnsafeMutableBufferPointer { _ in }
        let M = [1, 2]
        M.withUnsafeBufferPointer { _ in }
    }
}
`,
      // A member of a nested type is not a member of the outer type, and a
      // top-level function is not a member of a type its file declares.
      'Sources/Tool/Tool.swift': `import ArgumentParser
struct Tool: ParsableCommand {
    struct Inner { static func main() {} }
    struct Second { static func main() {} }
}
struct Cmd: ParsableCommand {}
func helpMessage() -> String { "" }
`,
      'Sources/Tool/Gates.swift': `import Kit
enum Gates {
    static func backtick() { _ = StoragePredicate.in(1, []) }
    static func outer() { Tool.main() }
    static func help() -> String { Cmd.helpMessage() }
}
`,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // The fixture indexed what the gates read.
      expect(cg.getNodesByName('`in`').map((n) => n.qualifiedName), 'backticked case').toEqual(['StoragePredicate::`in`']);
      expect(cg.getNodesByName('W').map((n) => n.kind), 'private alias').toEqual(['type_alias']);

      // the case is the project's own, spelled with its backticks.
      expect.soft(edgesFromMethod(cg, 'Gates::backtick', 'StoragePredicate', ['references']), 'backticked case').toEqual([]);
      // a local array named like another file's private alias or type.
      expect.soft(edgesFromMethod(cg, 'JacobiSVD::decompose', 'W', ['references']), 'private alias').toEqual([]);
      expect.soft(edgesFromMethod(cg, 'JacobiSVD::decompose', 'M', ['references']), 'private struct').toEqual([]);
      // `Inner.main` and `Second.main` are not `Tool.main`; ArgumentParser supplies Tool's.
      expect.soft(edgesFromMethod(cg, 'Gates::outer', 'Tool', ['references']), 'nested owner').toEqual(['references -> struct Tool']);
      expect.soft(edgesFromMethod(cg, 'Gates::outer', 'main', ['calls']), 'nested owner calls').toEqual([]);
      expect.soft(rowsFromMethod(root, cg, 'Gates::outer', 'Tool.main'), 'nested owner row').toEqual(['calls failed']);
      // a top-level function beside a type is not its member.
      expect.soft(edgesFromMethod(cg, 'Gates::help', 'helpMessage', ['calls']), 'top-level calls').toEqual([]);
      expect.soft(edgesFromMethod(cg, 'Gates::help', 'Cmd', ['references']), 'top-level function').toEqual(['references -> struct Cmd']);
    } finally {
      cg.close();
    }
  });

  // Known limit (it.fails): Swift locals/params are not indexed, so a local shadowing a project type reads as the type.
  it.fails('does not reference a project type through a local that shadows its name', async () => {
    const root = makeProjectOf('cg-swift-ext-member-shadow-', {
      'Sources/Kit/Config.swift': `struct Config {}
`,
      'Sources/Kit/Use.swift': `enum Use {
    static func run() {
        let Config = [1, 2]
        _ = Config.withUnsafeBufferPointer { _ in 0 }
    }
}
`,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFromMethod(cg, 'Use::run', 'Config', ['references'])).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

describe("Swift: the external-member reference needs the type's module in view", () => {
  it("references a project type only from a file that can see its module", async () => {
    const root = makeProjectOf('cg-swift-ext-member-visible-', {
      'Sources/A/SHA256.swift': `import Foundation
public enum SHA256 { public static func hash(data: Data) -> Int { 0 } }
`,
      // CryptoKit's SHA256: the caller imports CryptoKit, not A.
      'Sources/B/UseCrypto.swift': `import CryptoKit
enum UseCrypto {
    static func go() { _ = SHA256.other() }
}
`,
      'Sources/C/UseA.swift': `import A
enum UseA {
    static func go() { _ = SHA256.other() }
}
`,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect.soft(edgesFromMethod(cg, 'UseA::go', 'SHA256', ['references']), 'imported').toEqual(['references -> enum SHA256']);
      expect.soft(edgesFromMethod(cg, 'UseCrypto::go', 'SHA256', ['references']), 'not imported').toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('references a project type in a module an imported module re-exports', async () => {
    const root = makeProjectOf('cg-swift-ext-member-reexport-', {
      'Sources/Core/CoreType.swift': `public enum CoreType { public static func member() {} }
`,
      'Sources/Facade/Exports.swift': `@_exported import Core
`,
      'Sources/E/UseFacade.swift': `import Facade
enum UseFacade {
    static func go() { _ = CoreType.other() }
}
`,
    });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFromMethod(cg, 'UseFacade::go', 'CoreType', ['references'])).toEqual(['references -> enum CoreType']);
    } finally {
      cg.close();
    }
  });
});

describe('Swift: the external-member reference across a sync', () => {
  const LIFE: Record<string, string> = {
    'Sources/Life/LifeTool.swift': `import ArgumentParser
struct LifeTool: ParsableCommand {}
`,
    'Sources/Life/Caller.swift': `enum Caller {
    static func go() { LifeTool.external() }
}
`,
  };
  const EXT = { 'Sources/Life/LifeExt.swift': `extension LifeTool { static func external() {} }
` };

  /** Edges out of `Caller.go` into LifeTool or its `external`, and its `LifeTool.external` rows. */
  function state(root: string, cg: CodeGraph): { edges: string[]; rows: string[] } {
    return {
      edges: [
        ...edgesFromMethod(cg, 'Caller::go', 'LifeTool', ['references', 'calls']),
        ...edgesFromMethod(cg, 'Caller::go', 'external', ['references', 'calls']),
      ].sort(),
      rows: rowsFromMethod(root, cg, 'Caller::go', 'LifeTool.external'),
    };
  }

  const EXTERNAL = { edges: ['references -> struct LifeTool'], rows: ['calls failed'] };
  const DECLARED = { edges: ['calls -> method LifeTool::external'], rows: [] };

  it('gains the reference when the extension declaring the member goes away, as a cold index has it', async () => {
    const cold = makeProjectOf('cg-swift-ext-member-cold-', LIFE);
    const coldCg = await CodeGraph.init(cold, { index: true });
    try {
      expect(state(cold, coldCg), 'cold, external').toEqual(EXTERNAL);
    } finally {
      coldCg.close();
    }

    const root = makeProjectOf('cg-swift-ext-member-life-', { ...LIFE, ...EXT });
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(state(root, cg), 'declared').toEqual(DECLARED);
      // The caller's file is unchanged; its call is re-resolved when its target goes.
      fs.rmSync(path.join(root, 'Sources/Life/LifeExt.swift'));
      await cg.sync();
      expect(state(root, cg), 'after the extension is deleted').toEqual(EXTERNAL);
    } finally {
      cg.close();
    }
  });

  // Accepted limit (it.fails): the sync retry resolves the call but no query takes back the parked `references` edge.
  it.fails('drops the reference when a new extension declares the member, as a cold index has it', async () => {
    const cold = makeProjectOf('cg-swift-ext-member-cold-', { ...LIFE, ...EXT });
    const coldCg = await CodeGraph.init(cold, { index: true });
    try {
      expect(state(cold, coldCg), 'cold, declared').toEqual(DECLARED);
    } finally {
      coldCg.close();
    }

    const root = makeProjectOf('cg-swift-ext-member-life-', LIFE);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(state(root, cg), 'external').toEqual(EXTERNAL);
      fs.writeFileSync(path.join(root, 'Sources/Life/LifeExt.swift'), EXT['Sources/Life/LifeExt.swift']);
      await cg.sync();
      expect(state(root, cg), 'after the extension is added').toEqual(DECLARED);
    } finally {
      cg.close();
    }
  });
});

describe('Swift: members the index does not hold yet', () => {
  const GAPS: Record<string, string> = {
    // The grammar drops this extension (a `static let` continued on a `|` line),
    // indexing `accessFloor` as a top-level function.
    'Sources/Kit/Fact.swift': `public struct KGFact { var operationalBitmap: Int64 = 0 }
`,
    'Sources/Kit/FactOperational.swift': `public extension KGFact {
    static let recordedMask: Int64 = 1 << 17
    static let perFieldMask: Int64 = 1 << 36
    static let floorMask: Int64 = recordedMask
        | perFieldMask
    static func accessFloor(operational: Int64) -> Int64? { nil }
}
`,
    'Sources/Kit/Uses.swift': `enum Uses {
    static func floor() -> Int64? { KGFact.accessFloor(operational: 0) }
}
`,
  };

  // A known extraction gap, pinned with it.fails so the extraction fix flips
  // it; the first test keeps a broken fixture from passing as the expected
  // failure. Resolution cannot see a declaration the index does not hold.
  it('the fixture indexes the dropped extension as the gate expects', async () => {
    const root = makeProjectOf('cg-swift-ext-member-gaps-', GAPS);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(cg.getNodesByName('accessFloor').map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual(['function accessFloor']);
    } finally {
      cg.close();
    }
  });
  // Extraction gap: Swift extension parsing in src/extraction/tree-sitter.ts — a `|` continuation line ends the extension.
  it.fails('a member of an extension the grammar drops is declared (extraction: the `|` continuation ends the extension)', async () => {
    const root = makeProjectOf('cg-swift-ext-member-gaps-', GAPS);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      expect(edgesFromMethod(cg, 'Uses::floor', 'KGFact', ['references'])).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
