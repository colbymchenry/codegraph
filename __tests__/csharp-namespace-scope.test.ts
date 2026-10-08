/**
 * C# names follow the scopes the language gives them:
 * - a block `namespace X { … }` holds only its body — serilog's Guard.cs
 *   declares `static class Guard` after a `namespace JetBrains.Annotations`
 *   block, and a file's second namespace (or one nested inside another,
 *   `Outer.Inner`) is its own;
 * - `using X;` names the project's namespace X, never another file's using;
 * - a `global using` is its own project's — serilog's two test projects each
 *   `global using` their own `Support` namespace, and both define `Some`;
 * - a nested type is reached by bare name only from inside its owner or a
 *   type deriving from it, through any partial part.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-ns-'));
  const files: Record<string, string> = {
    'src/Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'src/Lib/Guard.cs': `using JetBrains.Annotations;

namespace JetBrains.Annotations
{
    sealed class NoEnumerationAttribute : System.Attribute { }
}

static class Guard
{
    public static T AgainstNull<T>(T value) where T : class => value;
}
`,
    'src/Lib/Multi.cs': `namespace Alpha
{
    class X { }
}

namespace Beta
{
    class Y { }

    namespace Inner
    {
        class Z { }
    }
}
`,
    'src/Lib/Uses.cs': `using Beta;

namespace Gamma
{
    class Consumer { }
}
`,
    'src/Lib/Reader.cs': `namespace Lib
{
    public abstract class Reader
    {
        internal enum State { Start, Done }
    }

    public partial class TextReader : Reader
    {
    }
}
`,
    'src/Lib/TextReader.Async.cs': `namespace Lib
{
    public partial class TextReader
    {
        object Peek() => State.Start;
    }
}
`,
    'src/Lib/Writer.cs': `namespace Lib
{
    public abstract class Writer
    {
        internal enum State { Start, Done }

        object Current() => State.Done;
    }
}
`,
    'test/Unit/Unit.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'test/Unit/GlobalUsings.cs': 'global using Unit.Support;\n',
    'test/Unit/Support/Some.cs': `namespace Unit.Support;

static class Some
{
    public static int InformationEvent() => 1;
}
`,
    'test/Unit/LogTests.cs': `namespace Unit.Context;

class LogTests
{
    int Run() => Some.InformationEvent();
}
`,
    'test/Unit/MappingTests.cs': `namespace Unit.Mapping;

class FirstCase
{
    class Source { }
    object Make() => new Source();
}

class SecondCase
{
    class Source { }
    object Make() => new Source();
}
`,
    'test/Perf/Perf.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'test/Perf/GlobalUsings.cs': 'global using Perf.Support;\n',
    'test/Perf/Support/Some.cs': `namespace Perf.Support;

static class Some
{
    public static int InformationEvent() => 2;
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

const qualifiedNames = (file: string) => cg.getNodesInFile(file).filter((n) => n.kind !== 'file').map((n) => `${n.kind} ${n.qualifiedName}`);
const targetsAt = (file: string, line: number, kind?: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.line === line && (!kind || e.kind === kind))
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.filePath}:${t.qualifiedName}`);
};

describe('C# namespaces, usings and nested types', () => {
  it('a block namespace qualifies only its own body', () => {
    expect(qualifiedNames('src/Lib/Guard.cs')).toEqual(expect.arrayContaining([
      'class JetBrains.Annotations::NoEnumerationAttribute', 'class Guard', 'method Guard::AgainstNull',
    ]));
    expect(qualifiedNames('src/Lib/Multi.cs')).toEqual(expect.arrayContaining([
      'class Alpha::X', 'class Beta::Y', 'class Beta.Inner::Z',
    ]));
  });

  it('a using names the project’s namespace', () => {
    expect(targetsAt('src/Lib/Uses.cs', 1, 'imports')).toEqual(['namespace src/Lib/Multi.cs:Beta']);
  });

  it('a global using is its own project’s', () => {
    expect(targetsAt('test/Unit/LogTests.cs', 5, 'calls')).toEqual(['method test/Unit/Support/Some.cs:Unit.Support::Some::InformationEvent']);
  });

  it('a nested type is its owner’s, or a derived type’s through any partial part', () => {
    expect(targetsAt('test/Unit/MappingTests.cs', 12, 'instantiates')).toEqual(['class test/Unit/MappingTests.cs:Unit.Mapping::SecondCase::Source']);
    expect(targetsAt('src/Lib/TextReader.Async.cs', 5)).toContain('enum src/Lib/Reader.cs:Lib::Reader::State');
    expect(targetsAt('src/Lib/Writer.cs', 7)).toContain('enum src/Lib/Writer.cs:Lib::Writer::State');
  });
});
