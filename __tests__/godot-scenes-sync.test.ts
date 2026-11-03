/**
 * A scene's signal connections, what a script's references depend on in its
 * scenes, and a sync giving the same graph a fresh index does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const open: CodeGraph[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const graph of open.splice(0)) graph.destroy();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${source}\n`);
  }
}

async function indexIn(dir: string): Promise<CodeGraph> {
  const graph = CodeGraph.initSync(dir, { silent: true });
  open.push(graph);
  await graph.indexAll();
  return graph;
}

async function index(files: Record<string, string>): Promise<{ graph: CodeGraph; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-godot-sync-'));
  dirs.push(dir);
  write(dir, files);
  return { graph: await indexIn(dir), dir };
}

function edges(graph: CodeGraph, kinds = `'calls','references','extends','instantiates','imports'`): string[] {
  return (graph as any).db.db.prepare(
    `SELECT e.kind k, s.file_path sf, s.name sn, t.file_path tf, t.name tn FROM edges e
     JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
     WHERE e.kind IN (${kinds}) ORDER BY 1, 2, 3, 4, 5`
  ).all().map((r: any) => `${r.k} ${r.sf}:${r.sn} -> ${r.tf}:${r.tn}`);
}

/** Every edge of `graph`'s project against an index of the same files built from nothing. */
async function expectSameAsFresh(graph: CodeGraph, dir: string): Promise<void> {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-godot-fresh-'));
  dirs.push(fresh);
  fs.cpSync(dir, fresh, { recursive: true, filter: (src) => path.basename(src) !== '.codegraph' });
  const freshGraph = await indexIn(fresh);
  expect(edges(graph)).toEqual(edges(freshGraph));
}

const scene = (root: string, script: string | null, extra: string[] = []) => [
  '[gd_scene format=3]',
  ...(script ? [`[ext_resource type="Script" path="res://${script}" id="1"]`] : []),
  `[node name="${root}" type="Control"]`,
  ...(script ? ['script = ExtResource("1")'] : []),
  '[node name="Panel" type="Panel" parent="."]',
  '[node name="Label" type="Label" parent="Panel"]',
  ...extra,
].join('\n');
const handler = 'extends Control\nfunc _on_pressed():\n\tpass';
const connection = '[connection signal="pressed" from="Panel" to="." method="_on_pressed"]';

describe('a scene connection', () => {
  const calls = (graph: CodeGraph) => edges(graph, `'calls'`).filter((e) => e.includes('_on_pressed'));

  it('goes to the script on its `to` node when two scripts have the method', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': scene('Menu', 'menu.gd', [connection]),
      'pause.tscn': scene('Pause', 'pause.gd', [connection]),
      'menu.gd': handler,
      'pause.gd': handler,
    });
    expect(calls(graph)).toEqual([
      'calls menu.tscn:Panel -> menu.gd:_on_pressed',
      'calls pause.tscn:Panel -> pause.gd:_on_pressed',
    ]);
  });

  it('does not go to another script when its own lacks the method', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': scene('Menu', 'menu.gd', [connection]),
      'menu.gd': 'extends Control',
      'other.gd': handler,
    });
    expect(calls(graph)).toEqual([]);
  });

  it('has no edge when the `to` node has no script', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': scene('Menu', null, [connection]),
      'other.gd': handler,
    });
    expect(calls(graph)).toEqual([]);
  });

  it('stays in its own project in a monorepo', async () => {
    const { graph } = await index({
      'one/project.godot': '[application]',
      'one/menu.tscn': scene('Menu', 'menu.gd', [connection]),
      'one/menu.gd': 'extends Control',
      'two/project.godot': '[application]',
      'two/menu.gd': handler,
    });
    expect(calls(graph)).toEqual([]);
  });

  it('reaches a method the script inherits', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': scene('Menu', 'menu.gd', [connection]),
      'menu.gd': 'extends "res://base.gd"',
      'base.gd': handler,
    });
    expect(calls(graph)).toEqual(['calls menu.tscn:Panel -> base.gd:_on_pressed']);
  });

  it('reaches the root script of an instanced scene', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'item.tscn': scene('Item', 'item.gd'),
      'item.gd': handler,
      'menu.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="PackedScene" path="res://item.tscn" id="1"]',
        '[node name="Menu" type="Control"]',
        '[node name="Panel" type="Panel" parent="."]',
        '[node name="Item" parent="." instance=ExtResource("1")]',
        '[connection signal="pressed" from="Panel" to="Item" method="_on_pressed"]',
      ].join('\n'),
    });
    expect(calls(graph)).toEqual(['calls menu.tscn:Panel -> item.gd:_on_pressed']);
  });

  it('reads a Godot 3 scene', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': [
        '[gd_scene load_steps=2 format=2]',
        '[ext_resource path="res://menu.gd" type="Script" id=1]',
        '[node name="Menu" type="Control"]',
        'script = ExtResource( 1 )',
        '[node name="Panel" type="Panel" parent="."]',
        connection,
      ].join('\n'),
      'menu.gd': handler,
    });
    expect(calls(graph)).toEqual(['calls menu.tscn:Panel -> menu.gd:_on_pressed']);
  });
});

describe('a scene has no guessed edges', () => {
  it('does not link a node to a class from the file name or its own name', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'a.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]',
        '[ext_resource type="PackedScene" path="res://enemy.tscn" id="2"]',
        '[node name="Root" type="Node"]',
        'script = ExtResource("1")',
        '[node name="Enemy" parent="." instance=ExtResource("2")]',
      ].join('\n'),
      'enemy.tscn': scene('Enemy', null),
      'scripts/player.gd': 'extends Node',
      'other/player.gd': 'class_name Player\nextends Node',
    });
    const fromScene = edges(graph, `'references'`).filter((e) => e.includes(' a.tscn:'));
    expect(fromScene.filter((e) => /-> [^:]+:(Player|player|Enemy|Root)$/.test(e))).toEqual([]);
    expect(fromScene).toContain('references a.tscn:Root -> scripts/player.gd:player.gd');
    expect(fromScene).toContain('references a.tscn:Enemy -> enemy.tscn:enemy.tscn');
  });

  it('makes no constants out of a resource file\'s fields', async () => {
    const { graph } = await index({
      'item.tres': '[gd_resource type="Resource" format=3]\n[resource]\nid = "sword"\nitem_id = "sword"',
    });
    expect(graph.getNodesInFile('item.tres').filter((n) => n.name === 'sword')).toEqual([]);
  });
});

describe('a sync gives what a fresh index gives', () => {
  it('restores extends and new through a preload when a script without class_name returns', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'base.gd': 'extends Node\nfunc go():\n\tpass',
      'b.gd': 'extends Node',
      'child.gd': 'extends "res://base.gd"',
      'user.gd': 'extends Node\nconst B = preload("res://b.gd")\nfunc run():\n\tB.new()',
    });
    const before = edges(graph);
    expect(before).toContain('extends child.gd:child -> base.gd:base');
    expect(before).toContain('instantiates user.gd:run -> b.gd:b');
    const sources = { base: fs.readFileSync(path.join(dir, 'base.gd'), 'utf8'), b: fs.readFileSync(path.join(dir, 'b.gd'), 'utf8') };
    fs.unlinkSync(path.join(dir, 'base.gd'));
    fs.unlinkSync(path.join(dir, 'b.gd'));
    await graph.sync();
    expect(edges(graph).filter((e) => e.includes('base.gd') || e.includes('b.gd:'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'base.gd'), sources.base);
    fs.writeFileSync(path.join(dir, 'b.gd'), sources.b);
    await graph.sync();
    expect(edges(graph)).toEqual(before);
  });

  const autoloaded = () => ({
    'project.godot': '[autoload]\nService="*res://service.tscn"',
    'service.tscn': scene('Service', 'a.gd'),
    'a.gd': 'extends Node\nfunc save():\n\tpass',
    'b.gd': 'extends Node\nfunc save():\n\tpass',
    'caller.gd': 'extends Node\nfunc run():\n\tService.save()',
  });

  it('follows an autoload scene that changes its root script', async () => {
    const { graph, dir } = await index(autoloaded());
    expect(edges(graph, `'calls'`)).toContain('calls caller.gd:run -> a.gd:save');
    write(dir, { 'service.tscn': scene('Service', 'b.gd') });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toContain('calls caller.gd:run -> b.gd:save');
    await expectSameAsFresh(graph, dir);
  });

  it('drops the edge when the autoload scene goes', async () => {
    const { graph, dir } = await index(autoloaded());
    fs.unlinkSync(path.join(dir, 'service.tscn'));
    await graph.sync();
    expect(edges(graph, `'calls'`)).not.toContain('calls caller.gd:run -> a.gd:save');
    await expectSameAsFresh(graph, dir);
  });

  const nodePaths = () => ({
    'project.godot': '[application]',
    'one.tscn': scene('One', 's.gd'),
    'two.tscn': scene('Two', null),
    's.gd': 'extends Control\nfunc run():\n\tvar l = $Panel/Label',
  });
  const labels = (graph: CodeGraph) => edges(graph, `'references'`).filter((e) => e.endsWith(':Label'));

  it('follows a script attached to a second scene', async () => {
    const { graph, dir } = await index(nodePaths());
    expect(labels(graph)).toEqual(['references s.gd:run -> one.tscn:Label']);
    write(dir, { 'two.tscn': scene('Two', 's.gd') });
    await graph.sync();
    expect(labels(graph)).toEqual(['references s.gd:run -> one.tscn:Label', 'references s.gd:run -> two.tscn:Label']);
    await expectSameAsFresh(graph, dir);
  });

  it('follows a script detached from its scene', async () => {
    const { graph, dir } = await index(nodePaths());
    write(dir, { 'one.tscn': scene('One', null) });
    await graph.sync();
    expect(labels(graph)).toEqual([]);
    await expectSameAsFresh(graph, dir);
  });

  it('follows a connection whose `to` node gets another script', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'menu.tscn': scene('Menu', 'a.gd', [connection]),
      'a.gd': handler,
      'b.gd': handler,
    });
    write(dir, { 'menu.tscn': scene('Menu', 'b.gd', [connection]) });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toEqual(['calls menu.tscn:Panel -> b.gd:_on_pressed']);
    await expectSameAsFresh(graph, dir);
  });

  it('follows a script that gives up its class_name', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'service.gd': 'class_name Service\nextends Node\nfunc save():\n\tpass',
      'caller.gd': 'extends Node\nfunc run():\n\tService.save()',
    });
    expect(edges(graph, `'calls'`)).toContain('calls caller.gd:run -> service.gd:save');
    write(dir, { 'service.gd': 'extends Node\nfunc save():\n\tpass' });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toEqual([]);
    await expectSameAsFresh(graph, dir);
  });

  it('follows a class that extends something else', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'a.gd': 'extends Node\nfunc go():\n\tpass',
      'b.gd': 'extends Node\nfunc go():\n\tpass',
      'child.gd': 'class_name Child\nextends "res://a.gd"',
      'caller.gd': 'extends Node\nfunc run(c: Child):\n\tc.go()',
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls caller.gd:run -> a.gd:go']);
    write(dir, { 'child.gd': 'class_name Child\nextends "res://b.gd"' });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toEqual(['calls caller.gd:run -> b.gd:go']);
    await expectSameAsFresh(graph, dir);
  });

  it('follows a node added to a second scene, which makes a path ambiguous', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'one.tscn': scene('One', null),
      'two.tscn': '[gd_scene format=3]\n[node name="Two" type="Control"]',
      's.gd': 'extends Control\nfunc run():\n\tvar l = $Panel/Label',
    });
    expect(labels(graph)).toEqual(['references s.gd:run -> one.tscn:Label']);
    write(dir, { 'two.tscn': scene('Two', null) });
    await graph.sync();
    expect(labels(graph)).toEqual([]);
    await expectSameAsFresh(graph, dir);
  });

  const bus = 'class_name Bus\nextends Node\nfunc fire():\n\tpass';
  const firing = 'class_name Bus\nextends Node\nsignal fired\nfunc fire():\n\tfired.emit()';
  const subscriber = 'extends Node\nfunc wire(b: Bus):\n\tb.fired.connect(on_fired)\nfunc on_fired():\n\tpass';

  it('binds a connect written before its signal is declared', async () => {
    const { graph, dir } = await index({ 'project.godot': '[application]', 'bus.gd': bus, 'c.gd': subscriber });
    write(dir, { 'bus.gd': firing });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toContain('calls bus.gd:fire -> c.gd:on_fired');
    await expectSameAsFresh(graph, dir);
  });

  it('follows a signal renamed and back, its users untouched', async () => {
    const sender = 'extends Node\nfunc send(b: Bus):\n\tb.fired.emit()';
    const { graph, dir } = await index({ 'project.godot': '[application]', 'bus.gd': firing, 'c.gd': subscriber, 'e.gd': sender });
    expect(edges(graph, `'calls'`)).toContain('calls e.gd:send -> c.gd:on_fired');
    write(dir, { 'bus.gd': firing.replace(/fired/g, 'fired2') });
    await graph.sync();
    expect(edges(graph, `'calls'`)).not.toContain('calls e.gd:send -> c.gd:on_fired');
    await expectSameAsFresh(graph, dir);
    write(dir, { 'bus.gd': firing });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toContain('calls e.gd:send -> c.gd:on_fired');
    await expectSameAsFresh(graph, dir);
  });

  it('binds an inherited signal when the parent gains it', async () => {
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'b.gd': 'class_name B\nextends Node\nfunc f():\n\tpass',
      'c.gd': 'extends B\nfunc run():\n\tfired.emit()',
    });
    write(dir, { 'b.gd': 'class_name B\nextends Node\nsignal fired\nfunc f():\n\tpass' });
    await graph.sync();
    expect(edges(graph, `'references'`)).toContain('references c.gd:run -> b.gd:fired');
    await expectSameAsFresh(graph, dir);
  });

  it('follows the type of an inherited field', async () => {
    const parent = (type: string) => `extends Node\nvar helper: ${type}`;
    const { graph, dir } = await index({
      'project.godot': '[application]',
      'x.gd': 'class_name X\nextends Node\nfunc go():\n\tpass',
      'y.gd': 'class_name Y\nextends Node\nfunc go():\n\tpass',
      'parent.gd': parent('X'),
      'child.gd': 'extends "res://parent.gd"\nfunc run():\n\thelper.go()',
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls child.gd:run -> x.gd:go']);
    write(dir, { 'parent.gd': parent('Y') });
    await graph.sync();
    expect(edges(graph, `'calls'`)).toEqual(['calls child.gd:run -> y.gd:go']);
    await expectSameAsFresh(graph, dir);
  });

  it('binds scene and script paths when a project.godot appears in a subfolder', async () => {
    const { graph, dir } = await index({
      'game/menu.tscn': scene('Menu', 'menu.gd', [connection]),
      'game/menu.gd': handler,
      'game/caller.gd': 'extends Node\nconst M = preload("res://menu.gd")',
    });
    expect(edges(graph).filter((e) => e.includes('game/menu.tscn:Menu ->'))).toEqual([]);
    write(dir, { 'game/project.godot': '[application]' });
    await graph.sync();
    expect(edges(graph)).toContain('references game/menu.tscn:Menu -> game/menu.gd:menu.gd');
    expect(edges(graph)).toContain('imports game/caller.gd:caller.gd -> game/menu.gd:menu.gd');
    expect(edges(graph)).toContain('calls game/menu.tscn:Panel -> game/menu.gd:_on_pressed');
    await expectSameAsFresh(graph, dir);
  });
});

describe('line endings', () => {
  it('reads CRLF files as it reads LF ones', async () => {
    const files = {
      'project.godot': '[application]\n\n[autoload]\nService="*res://service.tscn"\n\n[input]\nx=1',
      'service.tscn': scene('Service', 'service.gd', [connection]),
      'service.gd': 'class_name Service\nextends "res://base.gd"\nconst B = preload("res://base.gd")\nsignal fired\nfunc _on_pressed():\n\tfired.emit()\n\tvar l = $Panel/Label\n\tvar n = get_node("Panel")\n\tB.new()',
      'base.gd': 'extends Control\nfunc save():\n\tpass',
      'caller.gd': 'extends Node\nfunc run():\n\tService.save()\n\tService.fired.connect(on)\nfunc on():\n\tpass',
      'item.tres': '[gd_resource type="Resource" script_class="Service" format=3]\n[ext_resource type="Script" path="res://service.gd" id="1"]\n[resource]\nscript = ExtResource("1")',
    };
    const lf = await index(files);
    const crlf = await index(Object.fromEntries(Object.entries(files).map(([f, s]) => [f, s.replace(/\n/g, '\r\n')])));
    const all = edges(lf.graph);
    expect(all).toContain('calls service.tscn:Panel -> service.gd:_on_pressed');
    expect(all).toContain('calls caller.gd:run -> base.gd:save');
    expect(all).toContain('references service.tscn:Service -> service.gd:service.gd');
    expect(edges(crlf.graph)).toEqual(all);
  });
});

describe('a scene\'s multi-line text', () => {
  it('ends where its closing quote is, past an escaped one at the start of a line', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://menu.gd" id="1"]',
        '[node name="Menu" type="Control"]',
        'editor_description = "one',
        '\\"two\\" three"',
        'script = ExtResource("1")',
        '[node name="Panel" type="Panel" parent="."]',
        connection,
      ].join('\n'),
      'menu.gd': handler,
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls menu.tscn:Panel -> menu.gd:_on_pressed']);
  });

  it('is not read as a section', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'menu.tscn': [
        '[gd_scene format=3]',
        '[ext_resource type="Script" path="res://menu.gd" id="1"]',
        '[node name="Menu" type="RichTextLabel"]',
        'text = "first',
        '[center]second \\" quoted[/center]',
        '[node name=\\"NotANode\\" type=\\"Label\\"]"',
        'script = ExtResource("1")',
        '[node name="Panel" type="Panel" parent="."]',
        connection,
      ].join('\n'),
      'menu.gd': handler,
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls menu.tscn:Panel -> menu.gd:_on_pressed']);
    expect(graph.getNodesInFile('menu.tscn').filter((n) => n.name === 'NotANode')).toEqual([]);
  });
});

describe('script forms', () => {
  const inWire = (body: string) => `extends Node\nfunc wire():\n\t${body}\nfunc handler():\n\tpass`;
  const registered = (graph: CodeGraph) => edges(graph, `'references'`).filter((e) => e.endsWith(':handler'));

  it.each([
    ['a node path', '$Timer.timeout.connect(handler)'],
    ['a call result', 'get_tree().process_frame.connect(handler)'],
    ['a string signal on a node path', '$Btn.connect("pressed", handler)'],
    ['a signal in a variable on a node path', '$Btn.connect(sig_var, handler)'],
  ])('keeps the handler when the receiver is %s', async (_name, body) => {
    const { graph } = await index({ 'a.gd': inWire(body) });
    expect(registered(graph)).toEqual(['references a.gd:wire -> a.gd:handler']);
  });

  it.each([
    ['a call on a call\'s result', 'get_tree().create_timer(1.0).timeout.connect(handler)'],
    ['a chain of fields', 'ui.start_button.pressed.connect(handler)'],
    ['an autoload\'s field', 'Global.popup.removed.connect(handler)'],
  ])('keeps the handler on %s', async (_name, body) => {
    const { graph } = await index({ 'a.gd': inWire(body) });
    expect(registered(graph)).toEqual(['references a.gd:wire -> a.gd:handler']);
  });

  it('reads a node path in single quotes', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'a.tscn': scene('A', 'a.gd'),
      'a.gd': "extends Control\nfunc run():\n\tvar l = $'Panel/Label'",
    });
    expect(edges(graph, `'references'`)).toContain('references a.gd:run -> a.tscn:Label');
  });

  it('takes a receiver from an inherited field, not from its own file\'s name', async () => {
    const { graph } = await index({
      'base.gd': 'class_name Ba\nextends Node\nvar player: Ba\nfunc a():\n\tpass',
      'player.gd': 'extends Ba\nfunc a():\n\tpass\nfunc go():\n\tplayer.a()',
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls player.gd:go -> base.gd:a']);
  });

  it('does not read a name as its own script without class_name', async () => {
    const { graph } = await index({ 'player.gd': 'extends Node\nfunc a():\n\tpass\nfunc go():\n\tplayer.a()' });
    expect(edges(graph, `'calls'`)).toEqual([]);
  });

  it('survives a cycle of bases', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'a.gd': 'extends "res://b.gd"\nfunc go():\n\tthing.x()',
      'b.gd': 'extends "res://a.gd"',
    });
    expect(edges(graph, `'calls'`)).toEqual([]);
  });

  it('extends an inner class of a script by path', async () => {
    const { graph } = await index({
      'project.godot': '[application]',
      'base.gd': 'extends Node\nclass Inner:\n\tfunc im():\n\t\tpass\nfunc bm():\n\tpass',
      'a.gd': 'extends "res://base.gd".Inner\nfunc f():\n\tim()\n\tbm()',
    });
    expect(edges(graph, `'extends'`)).toEqual(['extends a.gd:a -> base.gd:Inner']);
    expect(edges(graph, `'calls'`)).toEqual(['calls a.gd:f -> base.gd:im']);
  });

  it('reads a flags variable after the handler', async () => {
    const { graph } = await index({
      'bus.gd': 'class_name Bus\nextends Node\nsignal fired\nfunc fire():\n\tfired.emit()',
      'a.gd': 'extends Node\nfunc wire(bus: Bus, flags: int):\n\tbus.fired.connect(handler, flags)\nfunc handler():\n\tpass',
    });
    expect(edges(graph, `'calls'`)).toContain('calls bus.gd:fire -> a.gd:handler');
  });

  it('links a named accessor to its property', async () => {
    const { graph } = await index({
      'a.gd': 'extends Node\nvar hp: int: set = _set_hp, get = _get_hp\nfunc _set_hp(v):\n\tpass\nfunc _get_hp():\n\treturn 1',
    });
    const fromHp = edges(graph, `'references'`).filter((e) => e.includes('a.gd:hp ->'));
    expect(fromHp).toEqual(['references a.gd:hp -> a.gd:_get_hp', 'references a.gd:hp -> a.gd:_set_hp']);
  });

  it('reads a call_deferred on a method as a call of it', async () => {
    const { graph } = await index({
      'a.gd': 'extends Node\nfunc run():\n\t_changed.call_deferred()\nfunc _changed():\n\tpass',
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls a.gd:run -> a.gd:_changed']);
  });

  it('follows a receiver typed by an inner class of another script', async () => {
    const { graph } = await index({
      'types.gd': 'class_name Types\nextends Node\nclass Foo:\n\tfunc bar():\n\t\tpass',
      'a.gd': 'extends Node\nfunc run(x: Types.Foo):\n\tx.bar()',
    });
    expect(edges(graph, `'calls'`)).toEqual(['calls a.gd:run -> types.gd:bar']);
  });

  it('leaves .godot out of the index', async () => {
    const { graph } = await index({
      'a.gd': 'extends Node',
      '.godot/editor/copy.gd': 'extends Node',
    });
    expect(graph.getNodesInFile('.godot/editor/copy.gd')).toEqual([]);
    expect(graph.getNodesInFile('a.gd').length).toBeGreaterThan(0);
  });
});
