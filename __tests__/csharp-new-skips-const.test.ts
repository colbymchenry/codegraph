/**
 * `new Station { ... }` is a type context: a `private const string Station`
 * in another class of the same folder is never a candidate, so the
 * `instantiates` edge must reach the imported class.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-newconst-'));
  const files: Record<string, string> = {
    'src/Core/Station.cs': `namespace Demo.Core;

public class Station
{
    public string Id { get; set; }
}
`,
    'tests/App.Tests/Consumer.cs': `using Demo.Core;

namespace Demo.Tests
{
    public class Consumer
    {
        public Station Make() => new Station { Id = "a" };
    }
}
`,
    'tests/App.Tests/ConstHolder.cs': `namespace Demo.Tests
{
    public class ConstHolder
    {
        private const string Station = "S1";

        public string Get() => Station;
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

describe('C# new X() with a same-named constant elsewhere', () => {
  it('instantiates the imported class, not the constant', () => {
    const ids = cg.getNodesInFile('tests/App.Tests/Consumer.cs').map((n) => n.id);
    const inst = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'instantiates')
      .map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(inst).toContain('Demo.Core::Station');
  });
});
