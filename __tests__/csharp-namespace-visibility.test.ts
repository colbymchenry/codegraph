/**
 * A bare C# type name means a type its file can see: one in its own
 * namespace or an enclosing one, or in a namespace it imports (`using`,
 * `global using`, the project's `<Using>` / implicit usings), or the one an
 * alias names. Newtonsoft's `async Task` tests (`using
 * System.Threading.Tasks;`) bound `Task` to a test class of that name in
 * `Newtonsoft.Json.Tests.Schema` 433 times.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-ns-'));
  const files: Record<string, string> = {
    'src/App.Tests/Schema/Generator.cs': `namespace App.Tests.Schema
{
    public class Task
    {
    }
}
`,
    'src/App.Tests/Reader/ReadTests.cs': `using System.Threading.Tasks;

namespace App.Tests.Reader
{
    public class ReadTests
    {
        public async Task Read()
        {
            await System.Threading.Tasks.Task.Yield();
        }
    }
}
`,
    'src/App.Tests/Schema/Planner.cs': `namespace App.Tests.Schema
{
    public class Planner
    {
        public Task Next() { return new Task(); }
    }
}
`,
    'src/App.Tests/Other/Aliased.cs': `using Task = App.Tests.Schema.Task;

namespace App.Tests.Other
{
    public class Aliased
    {
        public Task Make() { return new Task(); }
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

const reachesTask = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).some((e) => cg.getNode(e.target)!.qualifiedName === 'App.Tests.Schema::Task');
};

describe('C# type names and namespaces', () => {
  it('a type another namespace does not import is not in reach', () => {
    expect(reachesTask('src/App.Tests/Reader/ReadTests.cs')).toBe(false);
  });

  it('the same namespace, and an alias naming the type, reach it', () => {
    expect(reachesTask('src/App.Tests/Schema/Planner.cs')).toBe(true);
    expect(reachesTask('src/App.Tests/Other/Aliased.cs')).toBe(true);
  });
});
