/**
 * C# field and property initializers belong to the member they initialize.
 * `private readonly ILogger _log = LogManager.GetLogger(typeof(X));` and
 * `public List<Foo> Items { get; } = new List<Foo>();` used to be skipped by
 * both extractors, so the calls, instantiations and static reads written
 * there were lost, and a method passed as a value there was the class's
 * reference rather than the member's.
 *
 * A target-typed `new()` names no type of its own; as an initializer it
 * constructs the member's declared type.
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
  'Lib.cs': `namespace Lib
{
    public class Crate { }
}
public interface ILogger { }
public static class LogManager
{
    public static ILogger GetLogger(System.Type t) => null;
}
public static class Helper
{
    public static int Compute(int n) => n;
    public static int Seed() => 1;
    public static void Register(System.Action a) { }
    public static System.Action Wrap(System.Action a) => a;
}
public class Widget
{
    public Widget() { }
    public Widget(int n) { }
    public int Size { get; set; }
}
public class Bag<T> { }
public static class Defaults
{
    public const string Name = "x";
    public static readonly Widget Empty = new Widget();
}
`,
  'Box.cs': `using Lib;

public class Box
{
    private readonly ILogger _log = LogManager.GetLogger(typeof(Box));
    private int _a = 1, _b = Helper.Compute(2);
    private static readonly int Max = Helper.Seed();
    private readonly Widget _made = new Widget(3);
    private readonly Widget _typed = new() { Size = Helper.Seed() };
    private Widget? _maybe = new();
    private readonly Bag<Widget> _bag = new();
    private readonly Lib.Crate _crate = new();
    private readonly string _label = Defaults.Name;
    private readonly System.Func<int, int> _square = x => Helper.Compute(x * x);
    private readonly System.Action _later = () => Helper.Register(Handle);
    private readonly System.Action _direct = Handle;
    [System.Obsolete("use Helper.Seed()")] private int _flagged;
    public Bag<Widget> Items { get; } = new Bag<Widget>();
    public Widget Made { get; set; } = new();
    public Widget Copy { get; } = Defaults.Empty;
    public System.Action Wrapped { get; } = Helper.Wrap(Handle);
    public int Seeded { get; } = Helper.Seed();
    private static void Handle() { }
}
`,
};

describe('C# field and property initializers', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-initializers-'));
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

  it.each(['default', 'wasm'])('are walked as the member they initialize (%s)', async (backend) => {
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

    // Calls, per declarator.
    expect(targets(member('Box::_log'), 'calls')).toEqual(['LogManager::GetLogger']);
    expect(targets(member('Box::_a'), 'calls')).toEqual([]);
    expect(targets(member('Box::_b'), 'calls')).toEqual(['Helper::Compute']);
    expect(member('Box::Max').kind).toBe('constant');
    expect(targets(member('Box::Max'), 'calls')).toEqual(['Helper::Seed']);
    expect(targets(member('Box::Seeded'), 'calls')).toEqual(['Helper::Seed']);

    // Instantiations, including a target-typed `new()` of the declared type.
    expect(targets(member('Box::_made'), 'instantiates')).toEqual(['Widget']);
    expect(targets(member('Box::_typed'), 'instantiates')).toEqual(['Widget']);
    expect(targets(member('Box::_typed'), 'calls')).toEqual(['Helper::Seed']);
    expect(targets(member('Box::_maybe'), 'instantiates')).toEqual(['Widget']);
    expect(targets(member('Box::_bag'), 'instantiates')).toEqual(['Bag']);
    expect(targets(member('Box::_crate'), 'instantiates')).toEqual(['Lib::Crate']);
    expect(targets(member('Box::Items'), 'instantiates')).toEqual(['Bag']);
    expect(targets(member('Box::Made'), 'instantiates')).toEqual(['Widget']);

    // Static reads.
    expect(targets(member('Box::_label'), 'references')).toContain('Defaults');
    expect(targets(member('Box::Copy'), 'references')).toContain('Defaults');

    // Lambda bodies belong to the member the lambda initializes.
    expect(targets(member('Box::_square'), 'calls')).toEqual(['Helper::Compute']);
    expect(targets(member('Box::_later'), 'calls')).toEqual(['Helper::Register']);

    // A method passed as a value is the member's reference, captured once —
    // not the class's as well.
    expect(targets(member('Box::_later'), 'references')).toContain('Box::Handle');
    expect(targets(member('Box::_direct'), 'references')).toContain('Box::Handle');
    expect(targets(member('Box::Wrapped'), 'calls')).toEqual(['Helper::Wrap']);
    expect(targets(member('Box::Wrapped'), 'references')).toContain('Box::Handle');
    expect(targets(member('Box'), 'references')).not.toContain('Box::Handle');

    // Attribute arguments are not an initializer, and the class itself
    // calls and creates nothing.
    expect(targets(member('Box::_flagged'), 'calls')).toEqual([]);
    expect(targets(member('Box'), 'calls')).toEqual([]);
    expect(targets(member('Box'), 'instantiates')).toEqual([]);
  });
});
