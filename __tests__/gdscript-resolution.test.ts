/**
 * What GDScript and Godot resolution may and may not touch: a slash means a
 * scene path only in Godot's own languages, and a script's scope answers only
 * the reference kinds it knows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { matchByFilePath, matchByQualifiedName } from '../src/resolution/name-matcher';
import { matchGodotReference } from '../src/resolution/gdscript';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Language, ReferenceKind } from '../src/types';

let cg: CodeGraph | undefined;
let dir: string | undefined;
afterEach(() => {
  cg?.destroy(); cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gdscript-resolution-'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${source}\n`);
  }
  cg = CodeGraph.initSync(dir, { silent: true });
  await cg.indexAll();
  return cg;
}

function ref(referenceName: string, language: string, referenceKind: ReferenceKind = 'calls'): UnresolvedRef {
  return { fromNodeId: 'caller', referenceName, referenceKind, line: 1, column: 0, filePath: 'a.x', language: language as Language };
}

/** A context with nothing in it that records the names asked of it. */
function recordingContext(): { ctx: ResolutionContext; getNodesByName: ReturnType<typeof vi.fn> } {
  const getNodesByName = vi.fn(() => []);
  const ctx = new Proxy({ getNodesByName } as unknown as ResolutionContext, {
    get: (target, prop) => (target as never)[prop] ?? (() => []),
  });
  return { ctx, getNodesByName };
}

describe('a slash outside Godot', () => {
  it.each(['erlang', 'elixir', 'typescript'])('leaves %s `f/1` unqualified', (language) => {
    const { ctx, getNodesByName } = recordingContext();
    expect(matchByQualifiedName(ref('f/1', language), ctx)).toBeNull();
    expect(getNodesByName).not.toHaveBeenCalled();
  });

  it.each(['erlang', 'elixir'])('keeps %s `mod::f/2` whole in its last segment', (language) => {
    const { ctx, getNodesByName } = recordingContext();
    matchByQualifiedName(ref('mod::f/2', language), ctx);
    expect(getNodesByName).not.toHaveBeenCalledWith('2');
  });

  it('does not read res:// as a project path in another language', () => {
    const file = { kind: 'file', qualifiedName: 'x/a.gd', filePath: 'x/a.gd', id: 'file:x/a.gd' };
    const ctx = new Proxy({ getNodesByName: () => [file] } as unknown as ResolutionContext, {
      get: (target, prop) => (target as never)[prop] ?? (() => []),
    });
    const written = ref('res://x/a.gd', 'typescript', 'references');
    // main's answer: no exact or suffix match, only the one file of that name.
    expect(matchByFilePath(written, ctx)?.confidence).toBe(0.7);
    expect(matchGodotReference(written, ctx)).toBeUndefined();
  });

  it('resolves Erlang local and remote calls end to end', async () => {
    const graph = await index({
      'lib.erl': '-module(lib).\n-export([f/1]).\nf(X) -> X.',
      'main.erl': '-module(main).\n-export([g/0]).\ng() -> h(1), lib:f(2).\nh(X) -> X.',
    });
    const g = graph.getNodesInFile('main.erl').find((n) => n.name === 'g')!;
    const callees = graph.getCallees(g.id).filter((c) => c.edge.kind === 'calls').map((c) => `${c.node.filePath}:${c.node.name}`).sort();
    expect(callees).toEqual(['lib.erl:f', 'main.erl:h']);
  });
});

describe('reference kinds in a script', () => {
  it('leaves a kind the script scope does not know to the shared strategies', () => {
    const { ctx } = recordingContext();
    for (const kind of ['implements', 'overrides', 'returns', 'type_of', 'exports', 'contains'] as const) {
      expect(matchGodotReference(ref('Foo', 'gdscript', kind), ctx)).toBeUndefined();
    }
  });

  it('does not take an annotation for a method of its name', async () => {
    const graph = await index({
      'base.gd': '@abstract\nclass_name Base\nextends Node\nfunc abstract():\n\tpass',
    });
    const abstract = graph.getNodesInFile('base.gd').find((n) => n.name === 'abstract')!;
    expect(graph.getCallers(abstract.id)).toEqual([]);
    const db = (graph as any).db.db;
    expect(db.prepare(`SELECT COUNT(*) n FROM edges WHERE kind = 'decorates'`).get().n).toBe(0);
  });
});

describe('scene node references', () => {
  const scene = (root: string, script: string) => [
    '[gd_scene format=3]',
    `[ext_resource type="Script" path="res://${script}" id="1"]`,
    `[node name="${root}" type="Control"]`,
    'script = ExtResource("1")',
    `[node name="Panel" type="Panel" parent="."]`,
    '[node name="Label" type="Label" parent="Panel"]',
  ].join('\n');
  const labelFile = (graph: CodeGraph, script: string) => {
    const run = graph.getNodesInFile(script).find((n) => n.name === 'run')!;
    return (graph as any).db.db.prepare(
      `SELECT t.file_path f FROM edges e JOIN nodes t ON t.id = e.target
       WHERE e.source = ? AND e.kind = 'references' AND t.name = 'Label' ORDER BY f`
    ).all(run.id).map((r: any) => r.f);
  };

  it('goes to the scene its script is attached to, not a namesake in another', async () => {
    const graph = await index({
      'project.godot': '[application]',
      'a.tscn': scene('A', 'a.gd'),
      'b.tscn': scene('B', 'b.gd'),
      'a.gd': 'extends Control\nfunc run():\n\tvar l = $Panel/Label',
      'b.gd': 'extends Control\nfunc run():\n\tvar l = get_node("Panel/Label")',
    });
    expect(labelFile(graph, 'a.gd')).toEqual(['a.tscn']);
    expect(labelFile(graph, 'b.gd')).toEqual(['b.tscn']);
  });

  it('reaches every scene the script is attached to', async () => {
    const graph = await index({
      'project.godot': '[application]',
      'a.tscn': scene('A', 'shared.gd'),
      'b.tscn': scene('B', 'shared.gd'),
      'shared.gd': 'extends Control\nfunc run():\n\tvar l = %Label',
    });
    expect(labelFile(graph, 'shared.gd')).toEqual(['a.tscn', 'b.tscn']);
  });

  it('takes a scene the script is not attached to only when no other has the node', async () => {
    const graph = await index({
      'project.godot': '[application]',
      'a.tscn': scene('A', 'other.gd'),
      'b.tscn': scene('B', 'other.gd'),
      'only.tscn': '[gd_scene format=3]\n[node name="Solo" type="Control"]',
      'other.gd': 'extends Control',
      'free.gd': 'extends Node\nfunc run():\n\tvar l = get_node("Panel/Label")\n\tvar s = get_node("Solo")',
    });
    expect(labelFile(graph, 'free.gd')).toEqual([]);
    const run = graph.getNodesInFile('free.gd').find((n) => n.name === 'run')!;
    const solo = (graph as any).db.db.prepare(
      `SELECT COUNT(*) n FROM edges e JOIN nodes t ON t.id = e.target WHERE e.source = ? AND t.name = 'Solo'`
    ).get(run.id).n;
    expect(solo).toBe(1);
  });
});

describe('signal dispatch', () => {
  const synthesized = (graph: CodeGraph) => (graph as any).db.db.prepare(
    `SELECT s.name src, t.name tgt, json_extract(e.metadata, '$.event') event, json_extract(e.metadata, '$.registeredAt') site
     FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
     WHERE json_extract(e.metadata, '$.synthesizedBy') = 'gdscript-signal' ORDER BY tgt`
  ).all();
  const withHandlers = (count: number) => {
    const handlers = Array.from({ length: count }, (_, i) => `h${i}`);
    return [
      'extends Node',
      'signal fired',
      'func fire():',
      '\tfired.emit()',
      'func wire():',
      ...handlers.map((h) => `\tfired.connect(${h})`),
      ...handlers.flatMap((h) => [`func ${h}():`, '\tpass']),
    ].join('\n');
  };

  it('bridges up to six handlers of a signal and none of a signal with seven', async () => {
    const six = await index({ 'six.gd': withHandlers(6) });
    expect(synthesized(six)).toHaveLength(6);
    six.destroy(); cg = undefined;
    fs.rmSync(dir!, { recursive: true, force: true });
    const seven = await index({ 'seven.gd': withHandlers(7) });
    expect(synthesized(seven)).toEqual([]);
  });

  it('says where a handler was registered, in another file', async () => {
    const graph = await index({
      'bus.gd': 'class_name Bus\nextends Node\nsignal fired\nfunc fire():\n\tfired.emit()',
      'sub.gd': 'extends Node\nfunc wire(bus: Bus):\n\tbus.fired.connect(on_fired)\nfunc on_fired():\n\tpass',
    });
    expect(synthesized(graph)).toEqual([{ src: 'fire', tgt: 'on_fired', event: 'fired', site: 'sub.gd:3' }]);
  });

  it.each([
    ['bound', 'fired.connect(on_fired.bind(1))'],
    ['self', 'fired.connect(self.on_fired)'],
    ['self bound', 'fired.connect(self.on_fired.bind(1))'],
    ['Callable', 'fired.connect(Callable(self, "on_fired"))'],
    ['string form', 'connect("fired", on_fired)'],
    ['flags', 'fired.connect(on_fired, CONNECT_ONE_SHOT)'],
    ['Godot 3 string form', 'connect("fired", self, "on_fired")'],
  ])('finds the handler of a %s connect', async (_name, connect) => {
    const graph = await index({
      'a.gd': `extends Node\nsignal fired\nfunc fire():\n\tfired.emit()\nfunc wire():\n\t${connect}\nfunc on_fired():\n\tpass`,
    });
    expect(synthesized(graph).map((e: any) => e.tgt)).toEqual(['on_fired']);
  });

  it('does not take the object of a Godot 3 connect for a signal', async () => {
    const graph = await index({
      'a.gd': [
        'extends Node',
        'signal button',
        'var sig_var',
        'func fire():',
        '\tbutton.emit()',
        'func wire(button: Object):',
        '\tbutton.connect(sig_var, self, "m")',
        'func wire_field():',
        '\tself.button.connect(sig_var, self, "m")',
        'func m():',
        '\tpass',
      ].join('\n'),
    });
    const db = (graph as any).db.db;
    const signalRefs = db.prepare(
      `SELECT s.name src FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'references' AND t.name = 'button' ORDER BY src`
    ).all().map((r: any) => r.src);
    expect(signalRefs).toEqual(['fire']);
    expect(synthesized(graph)).toEqual([]);
    // The registration itself is still known.
    const registrations = db.prepare(
      `SELECT s.name src FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE e.kind = 'references' AND t.name = 'm' ORDER BY src`
    ).all().map((r: any) => r.src);
    expect(registrations).toEqual(['wire', 'wire_field']);
  });

  it('picks up a connect added to a file with no class or extends in it', async () => {
    const graph = await index({
      'bus.gd': 'class_name Bus\nextends Node\nsignal fired\nfunc fire():\n\tfired.emit()',
      'sub.gd': 'func wire(bus: Bus):\n\tpass\nfunc on_fired():\n\tpass',
    });
    expect(synthesized(graph)).toEqual([]);
    fs.writeFileSync(path.join(dir!, 'sub.gd'), 'func wire(bus: Bus):\n\tbus.fired.connect(on_fired)\nfunc on_fired():\n\tpass\n');
    await graph.sync({ paths: ['sub.gd'] });
    expect(synthesized(graph).map((e: any) => e.tgt)).toEqual(['on_fired']);
  });
});

describe('autoloads', () => {
  const calleeFiles = (graph: CodeGraph, script = 'caller.gd') => {
    const run = graph.getNodesInFile(script).find((n) => n.name === 'run')!;
    return graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.filePath);
  };
  const caller = 'extends Node\nfunc run():\n\tService.save()';
  const service = 'extends Node\nfunc save():\n\tpass';

  it('reaches the script on the root of an autoload scene', async () => {
    const graph = await index({
      'project.godot': '[autoload]\nService="*res://service.tscn"',
      'service.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://child.gd" id="2"]',
        '[ext_resource type="Script" path="res://root.gd" id="1"]',
        '[node name="Root" type="Node"]',
        'script = ExtResource("1")',
        '[node name="Child" type="Node" parent="."]',
        'script = ExtResource("2")',
      ].join('\n'),
      'root.gd': service,
      'child.gd': service,
      'caller.gd': caller,
    });
    expect(calleeFiles(graph)).toEqual(['root.gd']);
  });

  it('finds nothing for a scene whose root has no script, not the script of a child', async () => {
    const graph = await index({
      'project.godot': '[autoload]\nService="*res://service.tscn"',
      'service.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://child.gd" id="2"]',
        '[node name="Root" type="Node"]',
        '[node name="Child" type="Node" parent="."]',
        'script = ExtResource("2")',
      ].join('\n'),
      'child.gd': service,
      'caller.gd': caller,
    });
    expect(calleeFiles(graph)).toEqual([]);
  });

  it('rebinds without parsing a script again, and leaves them alone for any other edit', async () => {
    const graph = await index({
      'project.godot': '[application]\nconfig/name="x"\n[autoload]\nService="*res://first.gd"',
      'first.gd': service,
      'second.gd': service,
      'caller.gd': caller,
    });
    const indexed = () => (graph as any).db.db.prepare(`SELECT indexed_at i FROM files WHERE path = 'caller.gd'`).get().i;
    const edgeId = () => (graph as any).db.db.prepare(
      `SELECT e.rowid r FROM edges e JOIN nodes t ON t.id = e.target WHERE e.kind = 'calls' AND t.name = 'save'`
    ).get().r;
    const before = { indexed: indexed(), edge: edgeId() };

    fs.writeFileSync(path.join(dir!, 'project.godot'), '[application]\nconfig/name="y"\n[autoload]\nService="*res://first.gd"\n');
    await graph.sync({ paths: ['project.godot'] });
    expect(calleeFiles(graph)).toEqual(['first.gd']);
    expect(edgeId()).toBe(before.edge);

    fs.writeFileSync(path.join(dir!, 'project.godot'), '[application]\nconfig/name="y"\n[autoload]\nService="*res://second.gd"\n');
    await graph.sync({ paths: ['project.godot'] });
    expect(calleeFiles(graph)).toEqual(['second.gd']);
    expect(indexed()).toBe(before.indexed);
  });

  it('rebinds a project.godot in a subfolder, and binds a name added later', async () => {
    const graph = await index({
      'game/project.godot': '[application]\nconfig/name="x"',
      'game/service.gd': service,
      'game/caller.gd': caller,
    });
    expect(calleeFiles(graph, 'game/caller.gd')).toEqual([]);
    fs.writeFileSync(path.join(dir!, 'game/project.godot'), '[autoload]\nService="*res://service.gd"\n');
    await graph.sync({ paths: ['game/project.godot'] });
    expect(calleeFiles(graph, 'game/caller.gd')).toEqual(['game/service.gd']);
  });
});

describe('receivers', () => {
  const callees = (graph: CodeGraph, script: string, fn = 'run') => {
    const node = graph.getNodesInFile(script).find((n) => n.name === fn)!;
    return graph.getCallees(node.id).filter((c) => c.edge.kind === 'calls').map((c) => `${c.node.filePath}:${c.node.name}`);
  };
  const exported = 'class_name Service\nextends Node\nfunc save():\n\tpass\nstatic func make():\n\tpass';

  it('reads an undeclared identifier as the exported class of that name', async () => {
    const graph = await index({ 'service.gd': exported, 'a.gd': 'extends Node\nfunc run():\n\tService.make()' });
    expect(callees(graph, 'a.gd')).toEqual(['service.gd:make']);
  });

  it('reads nothing into a declared local without a type, even with the name of a class', async () => {
    const graph = await index({
      'service.gd': exported,
      'a.gd': 'extends Node\nfunc run():\n\tvar Service = get_child(0)\n\tService.save()',
    });
    expect(callees(graph, 'a.gd')).toEqual([]);
  });

  it('reads nothing into a parameter without a type, even with the name of a class', async () => {
    const graph = await index({
      'service.gd': exported,
      'a.gd': 'extends Node\nfunc run(Service):\n\tService.save()',
    });
    expect(callees(graph, 'a.gd')).toEqual([]);
  });

  it('reads a local declared after the call as not yet in view', async () => {
    const graph = await index({
      'service.gd': exported,
      'a.gd': 'extends Node\nfunc run():\n\tService.make()\n\tvar Service = get_child(0)',
    });
    expect(callees(graph, 'a.gd')).toEqual(['service.gd:make']);
  });
});

describe('inner classes and the script around them', () => {
  const callees = (graph: CodeGraph, script: string) => {
    const node = graph.getNodesInFile(script).find((n) => n.name === 'run')!;
    return graph.getCallees(node.id).map((c) => `${c.edge.kind}:${c.node.filePath}:${c.node.name}`).sort();
  };
  const helper = 'extends Node\nstatic func help():\n\tpass';

  it('sees an outer script constant holding a preload', async () => {
    const graph = await index({
      'helper.gd': helper,
      'a.gd': 'extends Node\nconst Helper = preload("helper.gd")\nclass Inner:\n\tfunc run():\n\t\tHelper.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual(['calls:helper.gd:help']);
  });

  it('sees it from two classes in', async () => {
    const graph = await index({
      'helper.gd': helper,
      'a.gd': 'extends Node\nconst Helper = preload("helper.gd")\nclass Mid:\n\tclass Inner:\n\t\tfunc run():\n\t\t\tHelper.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual(['calls:helper.gd:help']);
  });

  it('does not see an outer script field', async () => {
    const graph = await index({
      'helper.gd': 'class_name Helper\nextends Node\nfunc help():\n\tpass',
      'a.gd': 'extends Node\nvar helper: Helper\nclass Inner:\n\tfunc run():\n\t\thelper.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual([]);
  });

  it('prefers its own constant to the one outside', async () => {
    const graph = await index({
      'one.gd': helper,
      'two.gd': helper,
      'a.gd': 'extends Node\nconst Helper = preload("one.gd")\nclass Inner:\n\tconst Helper = preload("two.gd")\n\tfunc run():\n\t\tHelper.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual(['calls:two.gd:help']);
  });

  it('reaches a sibling inner class of the script', async () => {
    const graph = await index({
      'a.gd': 'extends Node\nclass Sibling:\n\tstatic func help():\n\t\tpass\nclass Inner:\n\tfunc run():\n\t\tSibling.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual(['calls:a.gd:help']);
  });

  it('follows a preload bound over two lines or with a comment', async () => {
    const graph = await index({
      'helper.gd': helper,
      'a.gd': 'extends Node\nconst Helper = preload(\n\t"helper.gd"\n) # the helper\nfunc run():\n\tHelper.help()',
    });
    expect(callees(graph, 'a.gd')).toEqual(['calls:helper.gd:help']);
  });
});
