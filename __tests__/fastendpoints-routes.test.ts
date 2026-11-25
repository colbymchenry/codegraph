/**
 * FastEndpoints routes: an endpoint class declares its verb and path in
 * `Configure()` — `Get("/Contributors")`, `Post(CreateContributorRequest.Route)`
 * with the constant in the request's own file — and handles the request in
 * its own `HandleAsync` / `ExecuteAsync`. ardalis/CleanArchitecture had no
 * routes at all. A minimal API's `app.MapGet("api/todos", …)` serves
 * `/api/todos`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fastendpoints-'));
  const files: Record<string, string> = {
    'src/Web/Contributors/Create.CreateContributorRequest.cs': `namespace Web.Contributors;

public class CreateContributorRequest
{
  public const string Route = "/Contributors";
  public string Name { get; set; } = "";
}
`,
    'src/Web/Contributors/Create.cs': `namespace Web.Contributors;

public class Create : Endpoint<CreateContributorRequest, CreateContributorResponse>
{
  public override void Configure()
  {
    Post(CreateContributorRequest.Route);
    AllowAnonymous();
  }

  public override async Task ExecuteAsync(CreateContributorRequest request, CancellationToken ct)
  {
  }
}
`,
    'src/Web/Contributors/List.cs': `namespace Web.Contributors;

public class List : EndpointWithoutRequest<ContributorListResponse>
{
  public override void Configure()
  {
    Get("/Contributors");
    AllowAnonymous();
  }

  public override async Task HandleAsync(CancellationToken ct)
  {
  }
}
`,
    'src/Web/Projects/List.cs': `namespace Web.Projects;

public class List : EndpointWithoutRequest<ProjectListResponse>
{
  public override void Configure()
  {
    Get($"/{nameof(Project)}s");
  }

  public override async Task HandleAsync(CancellationToken ct)
  {
  }
}
`,
    'src/Api/Program.cs': `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("api/todos", GetTodos);
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

const handlerOf = (file: string): string[] => {
  const route = cg.getNodesByKind('route').find((r) => r.filePath === file)!;
  return cg.getOutgoingEdges(route.id).map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('FastEndpoints and minimal API routes', () => {
  it('names each endpoint by its path, constant paths included, and links its own handler', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name).sort();
    expect(names).toEqual(['GET /Contributors', 'GET /Projects', 'GET /api/todos', 'POST /Contributors']);
    expect(handlerOf('src/Web/Contributors/Create.cs')).toEqual(['Web.Contributors::Create::ExecuteAsync']);
    // Two classes named `List`: each route reaches its own class's handler.
    expect(handlerOf('src/Web/Contributors/List.cs')).toEqual(['Web.Contributors::List::HandleAsync']);
    expect(handlerOf('src/Web/Projects/List.cs')).toEqual(['Web.Projects::List::HandleAsync']);
  });
});
