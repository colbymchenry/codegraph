/**
 * Where a Swift reference to a type lands.
 *
 * `extension View { … }` is indexed as a `class View` node, so with no
 * declaration of SwiftUI's `View` in the project every `struct X: View`,
 * `Text("…")` and `Color.red` bound to whichever file extended it — on
 * IceCubesApp half of the "most depended on" list was extension files. And a
 * bare `@State` bound to some view model's nested `enum State`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-types-'));
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** Every non-`contains` edge as `kind source -> target (file)`. */
function edges(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of cg.getFiles()) {
    for (const node of cg.getNodesInFile(file.path)) {
      for (const c of cg.getCallees(node.id)) {
        out.push(`${c.edge.kind} ${node.qualifiedName} -> ${c.node.qualifiedName} (${path.basename(c.node.filePath)}:${c.node.startLine})`);
      }
    }
  }
  return out.sort();
}

describe('Swift: an extension is not the type it extends', () => {
  let cg: CodeGraph;
  let all: string[];
  beforeAll(async () => {
    cg = await project({
      'App/DesignSystem/Card.swift': `import SwiftUI
extension View {
    func cardStyle() -> some View { padding() }
}
`,
      'App/DesignSystem/Text+Style.swift': `import SwiftUI
extension Text {
    func headline() -> Text { bold() }
}
`,
      'App/Models/Account.swift': `struct Account {
    let id: String
}
`,
      'App/Other/Account+Display.swift': `extension Account {
    var display: String { id }
}
struct AccountRow {
    let account: Account
}
`,
      'App/Home/HomeView.swift': `import SwiftUI
struct HomeView: View {
    @State private var count = 0
    var last: Result<Int, LoadError>?
    var body: some View {
        Text("Hello").headline()
    }
}
func makeHome() -> some View {
    HomeView().cardStyle()
}
enum LoadError: Error {
    case offline
}
`,
      'App/Home/ListViewModel.swift': `public final class ListViewModel {
    public enum State { case loading, loaded }
    public struct Result { let ok: Bool }
    var state: State = .loading
    var latest: Result?
}
`,
    });
    all = edges(cg);
  });
  afterAll(() => cg.close());

  it('leaves a reference to an SDK type the project only extends unresolved', () => {
    // `struct HomeView: View`, `-> some View`, `Text("Hello")`: SwiftUI's, not the extension files'.
    expect(all.filter((e) => / -> (View|Text) \(/.test(e))).toEqual([]);
  });

  it("moves a reference from a type's extension to its declaration", () => {
    // `AccountRow` sits in the extension's own file — proximity used to pick the extension.
    expect(all.filter((e) => e.includes(' -> Account ('))).toEqual(['references AccountRow -> Account (Account.swift:1)']);
  });

  it("keeps a nested type to its parent's scope", () => {
    // HomeView's \`Result<Int, LoadError>\` is Swift's, and its \`@State\` SwiftUI's; inside
    // ListViewModel, \`State\` and \`Result\` are its own.
    expect(all.filter((e) => /ListViewModel::(State|Result)/.test(e))).toEqual([
      'references ListViewModel -> ListViewModel::Result (ListViewModel.swift:3)',
      'references ListViewModel -> ListViewModel::State (ListViewModel.swift:2)',
    ]);
  });

  it("still resolves an SDK type's extension members on a conforming type", () => {
    // `HomeView().cardStyle()`: `cardStyle` comes from `extension View`, and HomeView conforms to View.
    expect(all).toContain('calls makeHome -> View::cardStyle (Card.swift:3)');
    expect(all).toContain('calls HomeView::body -> Text::headline (Text+Style.swift:3)');
  });
});

describe('Swift: the scopes that can name a nested type bare', () => {
  it('reaches a supertype, a generic qualifier and the type itself', async () => {
    const cg = await project({
      'Sources/Core/Channel.swift': `class BaseChannel {
    enum ReadResult { case some, none }
}
final class StreamChannel: BaseChannel {
    var last: ReadResult?
}
`,
      'Sources/Core/Future.swift': `struct Future<Value> {
    struct Isolated { let id: Int }
}
struct Waiter {
    var isolated: Future<Int>.Isolated?
}
`,
      'Sources/Core/Socket.swift': `enum Socket {
    struct Option { let raw: Int }
}
extension Socket.Option {
    static let none: Option = Option(raw: 0)
}
`,
    });
    try {
      const all = edges(cg);
      // A subclass names its superclass's nested type bare.
      expect(all).toContain('references StreamChannel -> BaseChannel::ReadResult (Channel.swift:2)');
      // `Future<Int>.Isolated`: the generic argument is not part of the path.
      expect(all).toContain('references Waiter -> Future::Isolated (Future.swift:2)');
      // Inside `extension Socket.Option`, `Option` is the type itself.
      expect(all.filter((e) => e.includes(' -> Socket::Option '))).toEqual(['instantiates Option -> Socket::Option (Socket.swift:2)']);
    } finally {
      cg.close();
    }
  });
});

describe('Swift: a qualified type name lands on the type on that path', () => {
  it('binds Build.Id and Package.Id to their own nested types, and a construction through a namespace', async () => {
    const cg = await project({
      'Sources/App/Models/Build.swift': `import Foundation
final class Build {
    typealias Id = UUID
}
`,
      'Sources/App/Models/Package.swift': `import Foundation
final class Package {
    typealias Id = UUID
}
`,
      'Sources/App/Controllers/API.swift': `enum API {}
extension API {
    enum PackageController {
        struct Model { let name: String }
    }
}
`,
      'Sources/App/Views/Other.swift': `enum Other {
    struct Model { let name: String }
}
`,
      'Sources/App/Commands/Trigger.swift': `struct Trigger {
    let build: Build.Id
    let package: Package.Id
}
func makeModel() {
    let m = API.PackageController.Model(name: "x")
    _ = m
}
`,
    });
    try {
      const all = edges(cg);
      // The index keeps both as a ref named \`Id\`; the site says which.
      expect(all.filter((e) => e.startsWith('references Trigger -> '))).toEqual([
        'references Trigger -> Build (Build.swift:2)',
        'references Trigger -> Build::Id (Build.swift:3)',
        'references Trigger -> Package (Package.swift:2)',
        'references Trigger -> Package::Id (Package.swift:3)',
      ]);
      // A construction's column is the chain's start: `API.PackageController.Model(`.
      expect(all.filter((e) => e.startsWith('instantiates makeModel'))).toEqual([
        'instantiates makeModel -> API::PackageController::Model (API.swift:4)',
      ]);
    } finally {
      cg.close();
    }
  });
});
