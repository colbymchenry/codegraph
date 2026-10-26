/**
 * A Vapor route whose handler is a trailing closure — `app.get("hello") { req
 * in … }`, `app.webSocket("chat") { req, ws in … }` — and a `routes.on(.POST,
 * "x", use:)` registration are routes too; only `use:` handlers were read.
 * A `{` that opens an `if` (`if let v = req.parameters.get("x") {`) or an HTTP
 * client's `req.client.get("https://…") { … }` is not one.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vapor-closure-'));
  const files: Record<string, string> = {
    'Package.swift': `// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "App", dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")])
`,
    'Sources/App/routes.swift': `import Vapor

func routes(_ app: Application) throws {
    app.get("hello", ":name") { req async throws -> String in
        guard let name = req.parameters.get("name") else { throw Abort(.badRequest) }
        return "Hello, \\(name)"
    }
    app.webSocket("chat") { req, client in
        client.send("hi")
    }
    let todos = app.grouped("todos")
    todos.on(.POST, "import", body: .collect(maxSize: "1mb"), use: importTodos)
}

func importTodos(req: Request) async throws -> HTTPStatus { .ok }

func lookup(req: Request) async throws -> String {
    if let owner = req.parameters.get("owner") {
        return owner
    }
    let res = try await req.client.get("https://example.com") { out in
        try out.query.encode(["q": "x"])
    }
    return "\\(res.status)"
}
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

describe('Vapor closure and on(…) routes', () => {
  it('are routes; an if-let body and an HTTP client call are not', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name).sort();
    expect(names).toEqual(['GET /hello/:name', 'POST /todos/import', 'WS /chat']);
    const post = cg.getNodesByKind('route').find((r) => r.name === 'POST /todos/import')!;
    expect(cg.getOutgoingEdges(post.id).map((e) => cg.getNode(e.target)!.name)).toContain('importTodos');
  });
});
