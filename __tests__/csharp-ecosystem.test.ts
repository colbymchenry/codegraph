import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-csharp-eco-${prefix}-`));
}

describe('C# NuGet package dependencies (issue #1181)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('parses <PackageReference> into module nodes and links consuming files', async () => {
    tmpDir = tempDir('nuget');
    fs.writeFileSync(
      path.join(tmpDir, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk">\n<ItemGroup>\n' +
        '<PackageReference Include="Dapper" Version="2.0.123" />\n' +
        '<PackageReference Include="Serilog" Version="3.1.1" />\n' +
        '</ItemGroup>\n</Project>\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Repo.cs'),
      'using Dapper;\nusing Serilog;\n' +
        'public class Repo { public int Count(int id) { throw new System.NotImplementedException(); } }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Unused.cs'),
      'public class Unused { public void Nop() {} }\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const modules = cg.getNodesByKind('module');
    const dapper = modules.find((n) => n.id === 'package:Dapper');
    const serilog = modules.find((n) => n.id === 'package:Serilog');
    expect(dapper, 'Dapper package node should exist').toBeDefined();
    expect(serilog, 'Serilog package node should exist').toBeDefined();
    expect(dapper!.filePath).toBe('App.csproj');
    expect(dapper!.docstring).toContain('synthesized');

    // The consuming file node is linked by a references edge from the package.
    const repoFile = cg.getNodesByKind('file').find((n) => n.filePath === 'Repo.cs');
    expect(repoFile, 'Repo.cs should be indexed as a file node').toBeDefined();
    const edges = cg.getOutgoingEdges(dapper!.id);
    expect(edges.some((e) => e.kind === 'references' && e.target === repoFile!.id)).toBe(true);
  });

  it('never reads .csproj files outside the project root via a symlink escape', async () => {
    tmpDir = tempDir('nuget-security');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-eco-outside-'));
    try {
      // A manifest OUTSIDE the project, reachable only through a symlink.
      fs.writeFileSync(
        path.join(outside, 'Evil.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
          '<PackageReference Include="EvilPkg" Version="9.9.9" />' +
          '</ItemGroup></Project>\n',
      );
      fs.symlinkSync(outside, path.join(tmpDir, 'lib'));
      fs.writeFileSync(
        path.join(tmpDir, 'App.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
          '<PackageReference Include="Dapper" Version="2.0.123" />' +
          '</ItemGroup></Project>\n',
      );
      fs.writeFileSync(path.join(tmpDir, 'Dummy.cs'), 'public class Dummy { }\n');

      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();

      const modules = cg.getNodesByKind('module');
      expect(modules.some((n) => n.id === 'package:Dapper')).toBe(true);
      expect(modules.some((n) => n.id === 'package:EvilPkg'), 'symlink escape must not be read').toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips build/dependency directories when discovering manifests', async () => {
    tmpDir = tempDir('nuget-skip');
    fs.mkdirSync(path.join(tmpDir, 'obj'));
    fs.writeFileSync(
      path.join(tmpDir, 'obj/Cached.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
        '<PackageReference Include="CachedPkg" Version="1.0.0" />' +
        '</ItemGroup></Project>\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
        '<PackageReference Include="Dapper" Version="2.0.123" />' +
        '</ItemGroup></Project>\n',
    );
    fs.writeFileSync(path.join(tmpDir, 'Dummy.cs'), 'public class Dummy { }\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const modules = cg.getNodesByKind('module');
    expect(modules.some((n) => n.id === 'package:Dapper')).toBe(true);
    expect(modules.some((n) => n.id === 'package:CachedPkg')).toBe(false);
  });
});

describe('C# DI registration scanning (issue #1181)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges IService -> registration -> Service', async () => {
    tmpDir = tempDir('di');
    fs.writeFileSync(path.join(tmpDir, 'IService.cs'), 'public interface IService { void Run(); }\n');
    fs.writeFileSync(
      path.join(tmpDir, 'Service.cs'),
      'public class Service : IService { public void Run() {} }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Program.cs'),
      'using Microsoft.Extensions.DependencyInjection;\n' +
        'public class Program { public static void Main() {\n' +
        '  var services = new ServiceCollection();\n' +
        '  services.AddScoped<IService, Service>();\n' +
        '} }\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const iface = cg.getNodesByKind('interface').find((n) => n.name === 'IService');
    const impl = cg.getNodesByKind('class').find((n) => n.name === 'Service');
    expect(iface).toBeDefined();
    expect(impl).toBeDefined();

    const reg = cg.getNodesByKind('module').find((n) => n.qualifiedName === 'di:Service->IService');
    expect(reg, 'DI registration node should exist').toBeDefined();

    const out = cg.getOutgoingEdges(reg!.id);
    const toIface = out.find((e) => e.kind === 'implements' && e.target === iface!.id);
    const toImpl = out.find((e) => e.kind === 'references' && e.target === impl!.id);
    expect(toIface, 'registration should implement the interface').toBeDefined();
    expect(toImpl, 'registration should reference the implementation').toBeDefined();
  });
});

describe('C# EF Core schema (issue #1181)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes table/column nodes from OnModelCreating and migrations', async () => {
    tmpDir = tempDir('ef');
    fs.writeFileSync(
      path.join(tmpDir, 'User.cs'),
      'public class User { public int Id { get; set; } public string Name { get; set; } public string Email { get; set; } }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppDbContext.cs'),
      'public class AppDbContext : DbContext {\n' +
        '  protected override void OnModelCreating(ModelBuilder modelBuilder) {\n' +
        '    modelBuilder.Entity<User>(entity => {\n' +
        '      entity.ToTable("Users");\n' +
        '      entity.Property(e => e.Name).HasColumnName("full_name");\n' +
        '      entity.HasIndex(e => e.Email);\n' +
        '    });\n' +
        '  }\n' +
        '}\n',
    );
    fs.mkdirSync(path.join(tmpDir, 'Migrations'));
    fs.writeFileSync(
      path.join(tmpDir, 'Migrations/20250101000000_Initial.cs'),
      'public partial class Initial : Migration {\n' +
        '  protected override void Up(MigrationBuilder migrationBuilder) {\n' +
        '    migrationBuilder.CreateTable(\n' +
        '      name: "Orders",\n' +
        '      columns: table => new {\n' +
        '        Id = table.Column<int>(nullable: false),\n' +
        '        Total = table.Column<decimal>(type: "decimal(18,2)")\n' +
        '      },\n' +
        '      constraints: table => {\n' +
        '        table.PrimaryKey("PK_Orders", x => x.Id);\n' +
        '      });\n' +
        '  }\n' +
        '}\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const modules = cg.getNodesByKind('module');
    const users = modules.find((n) => n.qualifiedName === 'ef:table:Users');
    const orders = modules.find((n) => n.qualifiedName === 'ef:table:Orders');
    expect(users, 'Users table should be synthesized').toBeDefined();
    expect(orders, 'Orders table should be synthesized from the migration').toBeDefined();

    const fields = cg.getNodesByKind('field');
    expect(fields.some((n) => n.qualifiedName === 'ef:column:Users.full_name')).toBe(true);
    expect(fields.some((n) => n.qualifiedName === 'ef:column:Orders.Id')).toBe(true);
    expect(fields.some((n) => n.qualifiedName === 'ef:column:Orders.Total')).toBe(true);

    // The Users table links to the real entity class.
    const user = cg.getNodesByKind('class').find((n) => n.name === 'User');
    expect(user).toBeDefined();
    expect(
      cg.getOutgoingEdges(users!.id).some((e) => e.kind === 'references' && e.target === user!.id),
    ).toBe(true);
  });
});

describe('C# AWS Lambda entry points (issue #1181)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('flags a [LambdaSerializer] handler as an entry point', async () => {
    tmpDir = tempDir('lambda');
    fs.writeFileSync(
      path.join(tmpDir, 'Function.cs'),
      'using Amazon.Lambda.Core;\n' +
        'public class Function {\n' +
        '  [LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]\n' +
        '  public string FunctionHandler(string input, ILambdaContext context) {\n' +
        '    return input;\n' +
        '  }\n' +
        '}\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const entry = cg.getNodesByKind('route').find((n) => n.name === 'Lambda FunctionHandler');
    expect(entry, 'Lambda handler should surface as an entry point route').toBeDefined();
    expect(entry!.docstring).toContain('synthesized');

    const handler = cg.getNodesByKind('method').find((n) => n.name === 'FunctionHandler');
    expect(handler).toBeDefined();
    expect(
      cg.getOutgoingEdges(entry!.id).some((e) => e.kind === 'references' && e.target === handler!.id),
    ).toBe(true);
  });
});

describe('C# route extraction robustness (issue #1181)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extracts multi-line url and #if-wrapped attributes', async () => {
    tmpDir = tempDir('routes');
    fs.writeFileSync(
      path.join(tmpDir, 'OrderController.cs'),
      '[Route("api/orders")]\n' +
        '[ApiController]\n' +
        'public class OrderController : ControllerBase {\n' +
        '  [HttpGet(\n' +
        '    "{id}")]\n' +
        '  [ProducesResponseType(typeof(object))]\n' +
        '  public async Task<object> GetById(long id) { throw new System.NotImplementedException(); }\n' +
        '\n' +
        '#if NET6_0\n' +
        '  [HttpPost]\n' +
        '#endif\n' +
        '  public async Task<object> Save() { throw new System.NotImplementedException(); }\n' +
        '}\n',
    );

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route').map((n) => n.name);
    expect(routes).toContain('GET /api/orders/{id}');
    expect(routes).toContain('POST /api/orders');
  });
});
