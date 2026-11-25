/**
 * A Vapor route binds to the handler it names — on the type it names.
 *
 * `app.get("search", use: SearchController.show)` used to keep only `show`,
 * and name matching bound every controller's `show` route to whichever `show`
 * came first (SwiftPackageIndex: 7 of 13 routes drew another endpoint's code).
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vapor-handlers-'));
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** Each route's handler, as `METHOD path -> Owner::method (file)`. */
function handlers(cg: CodeGraph): string[] {
  return cg
    .getNodesByKind('route')
    .map((route) => {
      const bound = cg.getCallees(route.id).map((c) => `${c.node.qualifiedName} (${path.basename(c.node.filePath)})`);
      return `${route.name} :${route.startLine} -> ${bound.join(', ') || 'nothing'}`;
    })
    .sort();
}

const PACKAGE = `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "App", dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")])
`;

const controller = (name: string, method = 'show') => `import Vapor
enum ${name} {
    static func ${method}(req: Request) async throws -> String { "${name}" }
}
`;

describe('Vapor: use: Type.method binds to that type', () => {
  it('binds same-named handlers on different controllers, nested API types and extensions to their own', async () => {
    const cg = await project({
      'Package.swift': PACKAGE,
      'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    app.get("authors", use: AuthorController.show)
    app.get("search", use: SearchController.show)
    app.get("health", use: HealthCheckController.show)
    app.get("packages", use: PackageController.show)
    app.get("api", "packages", use: API.PackageController.get)
    app.get("api", "search", use: API.SearchController.get)
    app.get("missing", use: MissingController.show)
}
`,
      'Sources/App/Controllers/AuthorController.swift': controller('AuthorController'),
      'Sources/App/Controllers/SearchController.swift': controller('SearchController'),
      'Sources/App/Controllers/HealthCheckController.swift': controller('HealthCheckController'),
      'Sources/App/Controllers/PackageController.swift': `import Vapor
enum PackageController {}
`,
      // A handler declared in an extension of the type, in another file.
      'Sources/App/Controllers/PackageController+routes.swift': `import Vapor
extension PackageController {
    static func show(req: Request) async throws -> String { "package" }
    static func get(req: Request) async throws -> String { "html get" }
}
`,
      'Sources/App/Controllers/API/API.swift': 'enum API {}\n',
      'Sources/App/Controllers/API/API+PackageController.swift': `import Vapor
extension API {
    enum PackageController {
        static func get(req: Request) async throws -> String { "api package" }
    }
}
`,
      // Declared in \`extension API.SearchController\` — its node is named
      // \`SearchController\`, the same qualified name the HTML controller's has.
      'Sources/App/Controllers/API/API+SearchController.swift': `import Vapor
extension API {
    enum SearchController {}
}
extension API.SearchController {
    static func get(req: Request) async throws -> String { "api search" }
}
`,
    });
    try {
      expect(handlers(cg)).toEqual([
        'GET /api/packages :7 -> API::PackageController::get (API+PackageController.swift)',
        'GET /api/search :8 -> SearchController::get (API+SearchController.swift)',
        'GET /authors :3 -> AuthorController::show (AuthorController.swift)',
        'GET /health :5 -> HealthCheckController::show (HealthCheckController.swift)',
        // Never another controller's `show`.
        'GET /missing :9 -> nothing',
        'GET /packages :6 -> PackageController::show (PackageController+routes.swift)',
        'GET /search :4 -> SearchController::show (SearchController.swift)',
      ]);
    } finally {
      cg.close();
    }
  });

  it("picks the overload that takes the request, wherever it sits in the file", async () => {
    const cg = await project({
      'Package.swift': PACKAGE,
      'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    app.get("sitemap", use: SiteMapController.index)
}
`,
      'Sources/App/Controllers/SiteMapController.swift': `import Vapor
enum SiteMapController {
    static func index(packages: [String]) -> String { packages.joined() }
    @Sendable
    static func index(req: Request) async throws -> String { index(packages: []) }
}
`,
    });
    try {
      const route = cg.getNodesByKind('route')[0]!;
      expect(cg.getCallees(route.id).map((c) => `${c.node.qualifiedName}:${c.node.startLine}`)).toEqual(['SiteMapController::index:4']);
    } finally {
      cg.close();
    }
  });

  it('binds use: self.x and a bare x to the method of the type the route is written in', async () => {
    const cg = await project({
      'Package.swift': PACKAGE,
      'Sources/App/Controllers/Collections.swift': `import Vapor
struct TodoController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let todos = routes.grouped("todos")
        todos.get(use: index)
        todos.post(use: self.create)
    }
    func index(req: Request) async throws -> String { "todos" }
    func create(req: Request) async throws -> String { "new todo" }
}
struct UserController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let users = routes.grouped("users")
        users.get(use: index)
    }
    func index(req: Request) async throws -> String { "users" }
}
`,
      // A handler declared in another extension of the collection's type.
      'Sources/App/Controllers/Tags.swift': `import Vapor
struct TagController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        routes.get("tags", use: self.index)
    }
}
`,
      'Sources/App/Controllers/Tags+handlers.swift': `import Vapor
extension TagController {
    func index(req: Request) async throws -> String { "tags" }
}
`,
      'Sources/App/routes.swift': `import Vapor
func routes(_ app: Application) throws {
    let todos = TodoController()
    app.get("all-todos", use: todos.index)
    app.get("hello", use: hello)
}
func hello(req: Request) -> String { "hi" }
`,
    });
    try {
      expect(handlers(cg)).toEqual([
        'GET /all-todos :4 -> TodoController::index (Collections.swift)',
        'GET /hello :5 -> hello (routes.swift)',
        'GET /tags :4 -> TagController::index (Tags+handlers.swift)',
        'GET /todos :5 -> TodoController::index (Collections.swift)',
        'GET /users :14 -> UserController::index (Collections.swift)',
        'POST /todos :6 -> TodoController::create (Collections.swift)',
      ]);
    } finally {
      cg.close();
    }
  });
});
