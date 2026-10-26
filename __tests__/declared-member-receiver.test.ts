/**
 * A C# / Java call through a field, property or parameter is a call on the
 * type it is declared with — read from the class's own member declarations,
 * those it inherits (with the type arguments the subclass gives), a using
 * alias, or a generic or enhanced-for declaration — never a guess at a
 * same-named method of some project class:
 *
 * - Newtonsoft's `_innerWriter.WriteValue(…)` inside TraceJsonWriter went to
 *   TraceJsonWriter's own `WriteValue`, and `_textWriter.Write(…)` on a
 *   `TextWriter` to a test's `ThrowingWriter.Write`;
 * - a C# interface's members are public, so a call on an interface-typed
 *   field reaches the interface's method (eShop's `_fixUriService.Fix…()`);
 * - `using Assert = …XUnitAssert;` makes `Assert.AreEqual` XUnitAssert's;
 * - a standard .NET name on an untyped receiver (`table.Columns.Add(…)`) is
 *   not a project class's same-named method unless the receiver names it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-member-receiver-'));
  const files: Record<string, string> = {
    'src/Json/JsonWriter.cs': `namespace App.Json;

public abstract class JsonWriter
{
    public virtual void WriteValue(string value) { }
}
`,
    'src/Json/TraceJsonWriter.cs': `using System.IO;

namespace App.Json;

internal class TraceJsonWriter : JsonWriter
{
    private readonly JsonWriter _innerWriter;
    /* a block comment naming the _textWriter field */
    private readonly TextWriter _textWriter;

    public override void WriteValue(string value)
    {
        _innerWriter.WriteValue(value);
        _textWriter.Write(value);
    }
}
`,
    'tests/ThrowingWriter.cs': `using System.IO;

namespace App.Tests;

public class ThrowingWriter : TextWriter
{
    public override void Write(string value) { }
}
`,
    'tests/XUnitAssert.cs': `namespace App.Tests;

public static class XUnitAssert
{
    public static void AreEqual(object a, object b) { }
}
`,
    'src/DefaultJsonNameTable.cs': `namespace App;

public class DefaultJsonNameTable
{
    public void Add(string key) { }
}
`,
    'src/Services/IFixUriService.cs': `namespace App.Services;

public interface IFixUriService
{
    void FixBasketItemPictureUri(string uri);
}
`,
    'src/Services/FixUriService.cs': `namespace App.Services;

public class FixUriService : IFixUriService
{
    public void FixBasketItemPictureUri(string uri) { }
}
`,
    'src/Services/BasketService.cs': `namespace App.Services;

public class BasketService
{
    private readonly IFixUriService _fixUriService;

    public void Load(string uri)
    {
        _fixUriService.FixBasketItemPictureUri(uri);
    }
}
`,
    'tests/Integration/IntegrationTest.cs': `namespace App.Tests.Integration;

public abstract class IntegrationTest<TFixture> where TFixture : new()
{
    protected TFixture Fixture { get; private set; }
}

public class DropCreateDatabaseAlways
{
    public object CreateContext() => null;
}
`,
    'tests/Integration/QueryTests.cs': `using Assert = App.Tests.XUnitAssert;

namespace App.Tests.Integration;

public class QueryTests : IntegrationTest<QueryTests.DatabaseInitializer>
{
    public class DatabaseInitializer : DropCreateDatabaseAlways { }

    public void Runs()
    {
        var context = Fixture.CreateContext();
        Assert.AreEqual(1, 1);
        var table = MakeTable();
        table.Columns.Add("price");
    }
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('C# calls through declared members', () => {
  it('reach the field’s declared type, and nothing for an outside one', () => {
    expect(callsFrom('src/Json/TraceJsonWriter.cs')).toEqual(['App.Json::JsonWriter::WriteValue']);
  });

  it('reach an interface’s method: interface members are public', () => {
    expect(callsFrom('src/Services/BasketService.cs')).toEqual([
      'App.Services::IFixUriService::FixBasketItemPictureUri',
    ]);
  });

  it('follow an inherited property typed by the type argument, a using alias, and leave a .NET name alone', () => {
    expect(callsFrom('tests/Integration/QueryTests.cs')).toEqual([
      'App.Tests.Integration::DropCreateDatabaseAlways::CreateContext',
      'App.Tests::XUnitAssert::AreEqual',
    ]);
  });
});

describe('C# default visibility', () => {
  it('is public in an interface and internal for a type in a namespace', () => {
    const method = cg.getNodesInFile('src/Services/IFixUriService.cs').find((n) => n.kind === 'method')!;
    expect(method.visibility).toBe('public');
    const cls = cg.getNodesInFile('src/Json/TraceJsonWriter.cs').find((n) => n.kind === 'class')!;
    expect(cls.visibility).toBe('internal');
  });
});
