import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, getLanguageDisplayName, isSourceFile, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => { await loadGrammarsForLanguages(['gdscript']); });
let cg: CodeGraph | undefined;
let dir: string | undefined;
afterEach(() => {
  cg?.destroy(); cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function extract(source: string) { return extractFromSource('player.gd', `${source}\n`); }
async function index(files: Record<string, string>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gdscript-'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${source}\n`);
  }
  cg = CodeGraph.initSync(dir, { silent: true });
  await cg.indexAll();
  return cg;
}

describe('GDScript', () => {
  it('detects .gd case-insensitively and exposes its display name', () => {
    expect(detectLanguage('actors/player.gd')).toBe('gdscript');
    expect(detectLanguage('PLAYER.GD')).toBe('gdscript');
    expect(isSourceFile('actors/player.gd')).toBe(true);
    expect(getLanguageDisplayName('gdscript')).toBe('GDScript');
  });

  it('makes the whole script a class, preserving methods and nested ownership', () => {
    const result = extract(`class_name Player
extends Node
signal hit(amount: int)
@export var health: int = 10
const LIMIT = 20
enum State { IDLE, RUNNING = 2 }
enum { UP, DOWN }
class Inner extends RefCounted:
\tfunc tick() -> void:
\t\tpass
static func damage(amount: int) -> int:
\treturn amount`);
    expect(result.errors).toEqual([]);
    const find = (name: string) => result.nodes.find((n) => n.name === name)!;
    expect(find('Player')).toMatchObject({ kind: 'class', isExported: true, endLine: 13 });
    expect(find('damage')).toMatchObject({ kind: 'method', qualifiedName: 'Player::damage', isStatic: true, signature: '(amount: int) -> int' });
    expect(find('tick').qualifiedName).toBe('Player::Inner::tick');
    expect(find('hit')).toMatchObject({ kind: 'field', decorators: ['signal'] });
    expect(find('health').kind).toBe('field');
    expect(find('LIMIT').kind).toBe('constant');
    expect(find('RUNNING').qualifiedName).toBe('Player::State::RUNNING');
    expect(find('UP').qualifiedName).toBe('Player::UP');
    expect(result.nodes.some((n) => n.name === '<anonymous>')).toBe(false);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: find('Player').id, referenceName: 'Node', referenceKind: 'extends' }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: find('Inner').id, referenceName: 'RefCounted', referenceKind: 'extends' }));
  });

  it('gives an unnamed script a class scope without exporting a global name', () => {
    const result = extract('extends Node\nfunc run():\n\tpass');
    expect(result.nodes.find((n) => n.kind === 'class')).toMatchObject({ name: 'player', isExported: false });
    expect(result.nodes.find((n) => n.name === 'run')?.qualifiedName).toBe('player::run');
  });

  it('extracts calls, nested arguments, constructors and literal imports in both walkers', () => {
    const result = extract(`const Helper = preload("res://helper.gd")
var initial = Helper.make()
func run():
\tself.work(nested())
\tHelper.make()
\tvar inner = Helper.new()
\tvar resource = load("res://item.gd")
\tvar local = 1`);
    const refs = result.unresolvedReferences;
    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'self.work', referenceKind: 'calls' }),
      expect.objectContaining({ referenceName: 'nested', referenceKind: 'calls' }),
      expect.objectContaining({ referenceName: 'res://helper.gd.make', referenceKind: 'calls' }),
      expect.objectContaining({ referenceName: 'res://helper.gd', referenceKind: 'instantiates' }),
      expect.objectContaining({ referenceName: 'res://item.gd', referenceKind: 'imports' }),
    ]));
    expect(result.nodes.filter((n) => n.kind === 'import')).toHaveLength(2);
    expect(result.nodes.some((n) => n.name === 'local' || n.name === 'inner')).toBe(false);
  });

  it('does not invent imports or signals from nested or computed arguments', () => {
    const result = extract(`signal done
func run():
\tload(resolve("res://wrong.gd"))
\tload("res://" + filename)
\temit_signal(format_name("done"))
\temit_signal(dynamic_name, "done")`);
    expect(result.nodes.filter((n) => n.kind === 'import')).toEqual([]);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'done')).toBe(false);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'resolve')).toBe(true);
  });

  it('indexes .gd files by default and resolves calls, imports and inheritance end to end', async () => {
    const graph = await index({
      'base.gd': 'class_name Base\nfunc finish():\n\tpass',
      'helper.gd': 'extends Node\nstatic func work():\n\tpass',
      'player.gd': `class_name Player
extends "res://base.gd"
const Helper = preload("res://helper.gd")
func run():
\tself.step()
\tHelper.work()
\tfinish()
func step():
\tpass`,
      'other.gd': 'class_name Other\nfunc finish():\n\tpass\nfunc step():\n\tpass',
    });
    const nodes = graph.getNodesInFile('player.gd');
    const run = nodes.find((n) => n.name === 'run')!;
    expect(run).toBeTruthy();
    expect(graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => `${c.node.filePath}:${c.node.name}`).sort())
      .toEqual(['base.gd:finish', 'helper.gd:work', 'player.gd:step']);
    const player = nodes.find((n) => n.name === 'Player')!;
    const edges = graph.getOutgoingEdges(player.id);
    expect(edges).toContainEqual(expect.objectContaining({ kind: 'extends', target: graph.getNodesInFile('base.gd').find((n) => n.kind === 'class')!.id }));
    expect(edges).toContainEqual(expect.objectContaining({ kind: 'imports', target: graph.getNodesInFile('helper.gd').find((n) => n.kind === 'file')!.id }));
  });

  it('uses receiver types and leaves engine/dynamic receivers unresolved', async () => {
    const graph = await index({
      'emitter.gd': 'class_name Emitter\nsignal done\nfunc work():\n\tpass',
      'caller.gd': `extends Node
func run(emitter: Emitter, engine: Tween, unknown):
\temitter.work()
\temitter.done.connect(handler)
\tengine.work()
\tunknown.work()
\tprint("hi")
func handler():
\tpass`,
      'unrelated.gd': 'class_name Unrelated\nfunc work():\n\tpass\nfunc print():\n\tpass\nsignal done',
    });
    const run = graph.getNodesInFile('caller.gd').find((n) => n.name === 'run')!;
    expect(graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => `${c.node.filePath}:${c.node.name}`)).toEqual(['emitter.gd:work']);
    const refs = graph.getOutgoingEdges(run.id).filter((e) => e.kind === 'references');
    const done = graph.getNodesInFile('emitter.gd').find((n) => n.name === 'done')!;
    expect(refs).toContainEqual(expect.objectContaining({ target: done.id }));
  });

  it('never falls back to the basename of a missing res:// import', async () => {
    const graph = await index({
      'game/project.godot': '[application]',
      'game/scripts/caller.gd': 'extends "res://base.gd"\nconst Missing = preload("res://missing/helper.gd")\nconst Present = preload("res://helper.gd")',
      'game/base.gd': 'extends Node',
      'game/helper.gd': 'extends Node',
      'helper.gd': 'extends Node',
    });
    const cls = graph.getNodesInFile('game/scripts/caller.gd').find((n) => n.kind === 'class')!;
    const edges = graph.getOutgoingEdges(cls.id).filter((e) => e.kind === 'imports' || e.kind === 'extends');
    expect(edges.map((e) => graph.getNode(e.target)?.filePath).sort()).toEqual(['game/base.gd', 'game/helper.gd']);
  });
});

describe('GDScript signal dispatch', () => {
  it('bridges emit to registered handlers across files and keeps signal owners separate', async () => {
    const graph = await index({
      'emitter.gd': `class_name Emitter
signal done
func fire():
\tdone.emit()
func legacy_fire():
\temit_signal("done")`,
      'listener.gd': `extends Node
func wire(emitter: Emitter):
\temitter.done.connect(on_done)
func on_done():
\tfinish()
func finish():
\tpass`,
      'other.gd': `class_name Other
signal done
func fire_other():
\tdone.emit()
func wire():
\tdone.connect(other_handler)
func other_handler():
\tpass`,
    });
    const fire = graph.getNodesInFile('emitter.gd').find((n) => n.name === 'fire')!;
    const handler = graph.getNodesInFile('listener.gd').find((n) => n.name === 'on_done')!;
    expect(graph.getOutgoingEdges(fire.id)).toContainEqual(expect.objectContaining({
      target: handler.id, kind: 'calls', provenance: 'heuristic',
      metadata: expect.objectContaining({ synthesizedBy: 'gdscript-signal', event: 'done', registeredAt: 'listener.gd:3' }),
    }));
    const other = graph.getNodesInFile('other.gd').find((n) => n.name === 'fire_other')!;
    expect(graph.getOutgoingEdges(other.id).some((e) => e.target === handler.id)).toBe(false);
    const before = graph.getNodesInFile('listener.gd').length;
    await graph.indexAll();
    expect(graph.getNodesInFile('listener.gd')).toHaveLength(before);
    expect(graph.getOutgoingEdges(fire.id).filter((e) => e.metadata?.synthesizedBy === 'gdscript-signal')).toHaveLength(1);
  });

  it('supports literal legacy signal forms and Callable(self, method)', async () => {
    const graph = await index({
      'signals.gd': `extends Node
signal done
func wire():
\tconnect("done", Callable(self, "on_done"))
func fire():
\tself.emit_signal("done")
func on_done():
\tpass`,
    });
    const fire = graph.getNodesInFile('signals.gd').find((n) => n.name === 'fire')!;
    const handler = graph.getNodesInFile('signals.gd').find((n) => n.name === 'on_done')!;
    expect(graph.getOutgoingEdges(fire.id)).toContainEqual(expect.objectContaining({ target: handler.id, provenance: 'heuristic' }));
  });
});

describe('Godot project wiring', () => {
  it('tracks project.godot and resolves autoload names within the nearest project', async () => {
    const graph = await index({
      'one/project.godot': '[autoload]\nService="*res://service.gd"\n[application]\nconfig/name="one"',
      'one/service.gd': 'extends Node\nfunc save():\n\tpass',
      'one/caller.gd': 'extends Node\nfunc run():\n\tService.save()',
      'two/project.godot': '[autoload]\nService="*res://service.gd"',
      'two/service.gd': 'extends Node\nfunc save():\n\tpass',
    });
    expect(detectLanguage('one/project.godot')).toBe('godot_resource');
    expect(isSourceFile('one/project.godot')).toBe(true);
    const run = graph.getNodesInFile('one/caller.gd').find((n) => n.name === 'run')!;
    expect(graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.filePath)).toEqual(['one/service.gd']);
  });

  it('keeps calls and signals in property setters attributed to the property', () => {
    const result = extract(`signal changed
var value := 0:
\tset(next):
\t\tvalue = next
\t\tchanged.emit()
\t\tpersist()`);
    const property = result.nodes.find((n) => n.name === 'value')!;
    expect(property.kind).toBe('property');
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: property.id, referenceName: 'changed.emit', referenceKind: 'references' }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: property.id, referenceName: 'persist', referenceKind: 'calls' }));
  });
});

describe('GDScript receiver scopes', () => {
  it('infers a for-loop item from a typed array and an explicit loop annotation', async () => {
    const graph = await index({
      'item.gd': 'class_name Item\nfunc process():\n\tpass',
      'caller.gd': `extends Node
var items: Array[Item] = []
func run():
\tfor item in items:
\t\titem.process()
func explicit(items):
\tfor item: Item in items:
\t\titem.process()`,
    });
    for (const name of ['run', 'explicit']) {
      const method = graph.getNodesInFile('caller.gd').find((n) => n.name === name)!;
      expect(graph.getCallees(method.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.filePath)).toEqual(['item.gd']);
    }
  });

  it('does not link a globally named type from a different Godot project', async () => {
    const graph = await index({
      'one/project.godot': '[application]',
      'one/player.gd': 'class_name Player\nfunc run():\n\tself.step()\nfunc step():\n\tpass',
      'two/project.godot': '[application]',
      'two/player.gd': 'class_name Player\nfunc run():\n\tself.step()\nfunc step():\n\tpass',
      'two/caller.gd': 'extends Node\nfunc run(player: Player):\n\tplayer.step()',
    });
    const run = graph.getNodesInFile('two/caller.gd').find((n) => n.name === 'run')!;
    expect(graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.filePath)).toEqual(['two/player.gd']);
  });
});

describe('GDScript named RPC calls', () => {
  it('follows the method named by rpc and rpc_id rather than a global rpc method', async () => {
    const graph = await index({
      'game.gd': `extends Node
func start():
\tload_world.rpc()
\tself.load_world.rpc_id(2)
@rpc("call_local")
func load_world():
\tpass`,
      'other.gd': 'class_name Other\nfunc rpc():\n\tpass',
    });
    const start = graph.getNodesInFile('game.gd').find((n) => n.name === 'start')!;
    const calls = graph.getCallees(start.id).filter((c) => c.edge.kind === 'calls');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.node.filePath === 'game.gd' && c.node.name === 'load_world')).toBe(true);
  });
});

describe('GDScript live autoload changes', () => {
  it('rebinds unchanged callers when project.godot changes, including scoped sync', async () => {
    const graph = await index({
      'project.godot': '[autoload]\nService="*res://first.gd"',
      'first.gd': 'extends Node\nfunc save():\n\tpass',
      'second.gd': 'extends Node\nfunc save():\n\tpass',
      'caller.gd': 'extends Node\nfunc run():\n\tService.save()',
    });
    const targets = () => {
      const run = graph.getNodesInFile('caller.gd').find((n) => n.name === 'run')!;
      return graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.filePath);
    };
    expect(targets()).toEqual(['first.gd']);
    fs.writeFileSync(path.join(dir!, 'project.godot'), '[autoload]\nService="*res://second.gd"\n');
    await graph.sync({ paths: ['project.godot'] });
    expect(targets()).toEqual(['second.gd']);
    fs.unlinkSync(path.join(dir!, 'project.godot'));
    await graph.sync({ paths: ['project.godot'] });
    expect(targets()).toEqual([]);
  });
});

describe('Godot autoload visibility', () => {
  it('does not expose an autoload whose singleton Enable flag is off', async () => {
    const graph = await index({
      'project.godot': '[autoload]\nService="res://service.gd"',
      'service.gd': 'extends Node\nfunc save():\n\tpass',
      'caller.gd': 'extends Node\nfunc run():\n\tService.save()',
    });
    const run = graph.getNodesInFile('caller.gd').find((n) => n.name === 'run')!;
    expect(graph.getCallees(run.id).filter((c) => c.edge.kind === 'calls')).toEqual([]);
  });
});
