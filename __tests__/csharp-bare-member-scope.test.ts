/**
 * A bare C# name — `TestContext`, `Easing`, `Helper()` — is a member of the
 * types around it, of their base types, or of a type a static using brings in
 * (in the file, as `global using static`, or as a project file's
 * `<Using … Static="true"/>`). eShop's `TestContext.Current` in one test class
 * went to another test class's `TestContext` property; MAUI's `Easing.Linear`
 * to an animation class's `Easing` property.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-scope-'));
  const files: Record<string, string> = {
    'tests/OrderProcessorTests.cs': `namespace App.Tests;

public class OrderProcessorTests
{
    public TestContext TestContext { get; set; } = null!;
}
`,
    'src/Animations/AnimationBase.cs': `namespace App.Animations;

public abstract class AnimationBase
{
    public EasingType Easing { get; set; }
}
`,
    'src/Execution/ExpressionBuilder.cs': `namespace App.Execution;

public static class ExpressionBuilder
{
    public static object Call(object target) => target;
}
`,
    'src/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Using Include="App.Execution.ExpressionBuilder" Static="true"/>
  </ItemGroup>
</Project>
`,
    'src/Specs/SpecBase.cs': `namespace App.Specs;

public abstract class SpecBase
{
    protected void AssertValid() { }
}
`,
    'src/Specs/CatalogSpec.cs': `namespace App.Specs;

public class CatalogSpec : SpecBase
{
    public void Runs()
    {
        var token = TestContext.Current.CancellationToken;
        var easing = Easing.Linear;
        AssertValid();
        Call(token);
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

describe('bare C# names', () => {
  it('reach the base class and a project-wide static using, never another class’s property', () => {
    const ids = cg.getNodesInFile('src/Specs/CatalogSpec.cs').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls' || e.kind === 'references')
      .map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(targets).not.toContain('App.Tests::OrderProcessorTests::TestContext');
    expect(targets).not.toContain('App.Animations::AnimationBase::Easing');
    expect(targets).toContain('App.Specs::SpecBase::AssertValid');
    expect(targets).toContain('App.Execution::ExpressionBuilder::Call');
  });
});
