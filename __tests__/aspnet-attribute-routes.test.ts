/**
 * ASP.NET attribute routing read as ASP.NET Core builds it (#2905). The class
 * prefix was the first `[Route] … class` of the file, applied to every class
 * in it; `[controller]`, `[action]` and `~/` stayed in the path as written; an
 * action's own `[Route]`, `[AcceptVerbs]`, `[HttpHead]`, `[HttpOptions]`, a
 * verb attribute with empty parentheses and one sharing its `[…]` with another
 * attribute were not read.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { aspnetResolver } from '../src/resolution/frameworks/csharp';

/** `<line> <route name> -> <handler>` for every route extract() gives a file. */
function routes(file: string, src: string): string[] {
  const { nodes, references } = aspnetResolver.extract!(file, src);
  return nodes.map((n) => `${n.startLine} ${n.name} -> ${references.find((r) => r.fromNodeId === n.id)?.referenceName ?? '?'}`);
}

/** The issue's two files. */
const ORDERS = `using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [HttpPost]
    [Route("import")]
    public IActionResult Import() => Ok();

    [HttpGet()]
    public IActionResult Count() => Ok();

    [HttpPut("{id}"), Produces("application/json")]
    public IActionResult Update(int id) => Ok();

    [AcceptVerbs("GET", "HEAD")]
    [Route("ping")]
    public IActionResult Ping() => Ok();

    [HttpGet("~/health")]
    public IActionResult Health() => Ok();

    [HttpGet("[action]")]
    public IActionResult Stats() => Ok();
}
`;

const CATALOG = `using Microsoft.AspNetCore.Mvc;

[Route("api/v{version:apiVersion}/products")]
[Route("api/products")]
public class ProductsController : Controller
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();
}

[Route("api/brands")]
public class BrandsController : Controller
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [HttpHead("{id}")]
    public IActionResult Exists(int id) => Ok();
}
`;

describe('ASP.NET attribute routes (#2905)', () => {
  it("names the issue's routes as ASP.NET Core serves them", () => {
    expect(routes('Controllers/OrdersController.cs', ORDERS)).toEqual([
      '7 GET /api/Orders -> List',
      '10 GET /api/Orders/{id} -> Get',
      '14 POST /api/Orders/import -> Import',
      '17 GET /api/Orders -> Count',
      '20 PUT /api/Orders/{id} -> Update',
      '24 GET /api/Orders/ping -> Ping',
      '24 HEAD /api/Orders/ping -> Ping',
      '27 GET /health -> Health',
      '30 GET /api/Orders/Stats -> Stats',
    ]);
  });

  it("gives each class its own templates, all of them", () => {
    expect(routes('Controllers/CatalogControllers.cs', CATALOG)).toEqual([
      '7 GET /api/v{version:apiVersion}/products/{id} -> Get',
      '7 GET /api/products/{id} -> Get',
      '14 GET /api/brands/{id} -> Get',
      '17 HEAD /api/brands/{id} -> Exists',
    ]);
  });

  it('reads verbs, names and templates as ASP.NET Core combines them', () => {
    const src = `namespace App.Controllers
{
    [Area("Admin")]
    [Route("[area]/[controller]")]
    public sealed class UsersController : Controller
    {
        [HttpGet("a")]
        [HttpPost]
        public IActionResult Both() => Ok();

        [HttpGet(Name = "List")]
        public async Task<ActionResult<IEnumerable<User>>> ListAsync() => Ok();

        [HttpOptions("[action]")]
        [ActionName("Opts")]
        public IActionResult Options() => Ok();

        [HttpGet("[action]")]
        public Task<IActionResult> ExportAsync() => Ok();

        [Microsoft.AspNetCore.Mvc.HttpDeleteAttribute(template: "{id:int}")]
        public IActionResult Remove(int id) => Ok();

        [Route("any")]
        public IActionResult Anything() => Ok();

        [HttpGet(Routes.Report)]
        public IActionResult Report() => Ok();

        [NonAction]
        [HttpGet("helper")]
        public IActionResult Helper() => Ok();

        [JsonIgnore]
        public string Name { get; set; }

        public IActionResult Create([FromBody] User user, [FromQuery(Name = "x")] string x) => Ok();

        public class Nested
        {
            [HttpGet("inner")]
            public void Inner() { }
        }
    }
}
`;
    expect(routes('Controllers/UsersController.cs', src)).toEqual([
      '7 GET /Admin/Users/a -> Both',
      '8 POST /Admin/Users -> Both',
      // `ListAsync` is the action `List`; `Name` makes a route of the controller's template.
      '11 GET /Admin/Users -> ListAsync',
      // `[action]` is the `[ActionName]`, or the method's name without `Async`.
      '14 OPTIONS /Admin/Users/Opts -> Options',
      '18 GET /Admin/Users/Export -> ExportAsync',
      '21 DELETE /Admin/Users/{id:int} -> Remove',
      // A `[Route]` with no verb attribute serves every verb.
      '24 ANY /Admin/Users/any -> Anything',
      // A nested class is a class of its own, with no template.
      '41 GET /inner -> Inner',
    ]);
  });

  it('keeps an action outside any class, and skips commented attributes', () => {
    const src = `
// [HttpGet("/fake")]
/* [Route("api/[controller]")] */
[HttpGet("/users")]
public IActionResult ListUsers() { return Ok(); }
`;
    expect(routes('UserController.cs', src)).toEqual(['4 GET /users -> ListUsers']);
  });

  it('reads past preprocessor lines around attributes', () => {
    const src = `[Route("api/[controller]")]
public class ItemsController : ControllerBase
{
    #region Queries

    [HttpGet]
    public IActionResult List() => Ok();

#if DEBUG
    [HttpGet("debug")]
#endif
    public IActionResult Debug() => Ok();

    [HttpDelete("{id}")]
    #pragma warning disable CS1998
    public async Task<IActionResult> Remove(int id) => Ok();
    #pragma warning restore CS1998

    #endregion
}
`;
    expect(routes('Controllers/ItemsController.cs', src)).toEqual([
      '6 GET /api/Items -> List',
      '10 GET /api/Items/debug -> Debug',
      '14 DELETE /api/Items/{id} -> Remove',
    ]);
  });
});

describe("ASP.NET: a controller with no [Route] takes its base class's (#2905)", () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-aspnet-routes-'));
    const files: Record<string, string> = {
      'App.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
      'Api/BaseApiController.cs': `using Microsoft.AspNetCore.Mvc;

namespace App.Api;

[ApiController]
[Route("[controller]")]
public class BaseApiController : ControllerBase
{
}

public class VersionedController : BaseApiController
{
}
`,
      'Api/Controllers/AudioController.cs': `using Microsoft.AspNetCore.Mvc;

namespace App.Api.Controllers;

public class AudioController : VersionedController
{
    [HttpGet("{itemId}/stream", Name = "GetAudioStream")]
    [HttpHead("{itemId}/stream", Name = "HeadAudioStream")]
    public IActionResult GetAudioStream(string itemId) => Ok();

    [HttpGet]
    public IActionResult Root() => Ok();

    [HttpGet("~/ping")]
    public IActionResult Ping() => Ok();
}
`,
      'Api/Controllers/SystemController.cs': `using Microsoft.AspNetCore.Mvc;

namespace App.Api.Controllers;

[Route("System/Info")]
public class SystemController : BaseApiController
{
    [HttpGet("Public")]
    public IActionResult Public() => Ok();
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<route name> -> <handler>` for every route of a file. */
  function routesOf(file: string): string[] {
    return cg
      .getNodesInFile(file)
      .filter((n) => n.kind === 'route')
      .map((n) => `${n.name} -> ${cg.getOutgoingEdges(n.id).map((e) => cg.getNode(e.target)!.name).join(',')}`)
      .sort();
  }

  it("names the routes from the nearest base's template, two levels and a file away", () => {
    expect(routesOf('Api/Controllers/AudioController.cs')).toEqual([
      'GET /Audio -> Root',
      'GET /Audio/{itemId}/stream -> GetAudioStream',
      'GET /ping -> Ping',
      'HEAD /Audio/{itemId}/stream -> GetAudioStream',
    ]);
  });

  it("lets a controller's own [Route] replace its base's", () => {
    expect(routesOf('Api/Controllers/SystemController.cs')).toEqual(['GET /System/Info/Public -> Public']);
  });
});
