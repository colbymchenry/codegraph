/**
 * C# property accessor bodies belong to the property. `get { … }`,
 * `set { … }`, `get => …` and an expression-bodied `=> …` property used to
 * be skipped by both extractors, so the calls, instantiations and static
 * reads written there were lost and a getter's callee looked unused.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'Helper.cs': `public static class Helper {
    public static int Compute(int n) => n;
    public static void Store(int n) {}
    public static int Arrow() => 1;
    public static int GetA() => 1;
    public static void SetA(int v) {}
}
public class Widget {}
public static class Defaults { public const string Name = "x"; }
`,
  'Box.cs': `public class Box {
    private int _x;
    public int Value {
        get { return Helper.Compute(_x); }
        set { Helper.Store(value); _x = value; }
    }
    public int Arrow => Helper.Arrow();
    public int Both { get => Helper.GetA(); set => Helper.SetA(value); }
    public Widget Made { get { return new Widget(); } }
    public string Label { get { return Defaults.Name; } }
    private void Handle(int v) { }
    public System.Action<int> Handler { get { return Pick(Handle); } }
}
`,
};

describe('C# property accessor bodies', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-accessors-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    kernel = process.env.CODEGRAPH_KERNEL;
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it.each(['default', 'wasm'])('are walked as the property (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const member = (qualifiedName: string): Node => {
      const node = graph.getNodesInFile('Box.cs').find((n) => n.qualifiedName === qualifiedName);
      expect(node, qualifiedName).toBeDefined();
      return node!;
    };
    const targets = (node: Node, kind: string): string[] =>
      graph
        .getOutgoingEdgesFrom([node.id])
        .filter((e) => e.kind === kind)
        .map((e) => graph.getNode(e.target)!.qualifiedName)
        .sort();

    expect(targets(member('Box::Value'), 'calls')).toEqual(['Helper::Compute', 'Helper::Store']);
    expect(targets(member('Box::Arrow'), 'calls')).toEqual(['Helper::Arrow']);
    expect(targets(member('Box::Both'), 'calls')).toEqual(['Helper::GetA', 'Helper::SetA']);
    expect(targets(member('Box::Made'), 'instantiates')).toEqual(['Widget']);
    expect(targets(member('Box::Label'), 'references')).toContain('Defaults');
    // A method passed as a value inside an accessor is the property's
    // reference, captured once — not the class's as well.
    expect(targets(member('Box::Handler'), 'references')).toContain('Box::Handle');
    expect(targets(member('Box'), 'references')).not.toContain('Box::Handle');
    expect(targets(member('Box'), 'calls')).toEqual([]);
  });
});
