/**
 * GDScript signals and preload/load imports.
 *
 * Signals are indexed as `field` nodes (the same choice VB.NET events made)
 * so emitters and subscribers have a findable declaration; `.emit()` /
 * `.connect()` and the `emit_signal("…")` / `connect("…")` string forms file
 * `references` edges onto it. Engine signals (`pressed`, `finished`, …) are
 * declared nowhere in the file and must add nothing. `preload()` / `load()`
 * produce import nodes — both at script top level and inside function bodies,
 * which the main walker never visits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('gdscript signals and imports', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdscript-signals-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes signal declarations, emit/connect references and preload imports', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'signals.gd'),
      [
        'extends Node',
        'class_name SignalEmitter',
        'signal data_loaded(request_id: String)',
        '',
        'func emit_it() -> void:',
        '\tdata_loaded.emit("x")',
        '',
        'func wire() -> void:',
        '\tdata_loaded.connect(_on_data_loaded)',
        '',
        'func legacy() -> void:',
        '\temit_signal("data_loaded", "x")',
        '',
        'func legacy_connect() -> void:',
        '\tconnect("data_loaded", Callable(self, "_on_data_loaded"))',
        '',
        'func subscribe(other: Node) -> void:',
        '\tother.data_loaded.connect(_on_data_loaded)',
        '',
        'func subscribe_typed(other: SignalEmitter) -> void:',
        '\tother.data_loaded.connect(_on_data_loaded)',
        '',
        'func engine_signal(tween: Tween) -> void:',
        '\ttween.finished.connect(_on_data_loaded)',
        '',
        'func _on_data_loaded(_id: String) -> void:',
        '\tpass',
      ].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'src', 'target.gd'), 'extends Node\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'scene_user.gd'),
      [
        'extends Node',
        '',
        'const TARGET = preload("res://src/target.gd")',
        '',
        'func load_inner() -> void:',
        '\tvar inner = load("res://src/target.gd")',
      ].join('\n')
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const signal = db
      .prepare(`SELECT id, kind FROM nodes WHERE name = 'data_loaded' AND kind = 'field'`)
      .get();
    expect(signal).toBeTruthy();

    const refs = db
      .prepare(
        `SELECT s.name AS src FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND t.name = 'data_loaded'
         ORDER BY s.name`
      )
      .all()
      .map((r: any) => r.src);
    // `other: Node` says nothing of this signal, so `subscribe` isn't linked:
    // a receiver is only followed by the type it declares.
    expect(refs).toEqual(['emit_it', 'legacy', 'legacy_connect', 'subscribe_typed', 'wire']);

    const engineRefs = db
      .prepare(
        `SELECT COUNT(*) n FROM edges e JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND t.name = 'finished'`
      )
      .get();
    expect(engineRefs.n).toBe(0);

    const imports = db
      .prepare(`SELECT name FROM nodes WHERE kind = 'import' ORDER BY name, start_line`)
      .all()
      .map((r: any) => r.name);
    expect(imports).toEqual(['res://src/target.gd', 'res://src/target.gd']);

    cg.destroy();
  });
});
