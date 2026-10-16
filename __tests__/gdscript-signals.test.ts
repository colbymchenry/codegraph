/**
 * GDScript signals and preload/load imports (#1499 follow-up).
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
      path.join(dir, 'src', 'battle.gd'),
      [
        'extends Node',
        '',
        'signal battle_finished(battle_id: String)',
        '',
        'func emit_it() -> void:',
        '\tbattle_finished.emit("x")',
        '',
        'func wire() -> void:',
        '\tbattle_finished.connect(_on_battle_finished)',
        '',
        'func legacy() -> void:',
        '\temit_signal("battle_finished", "x")',
        '',
        'func legacy_connect() -> void:',
        '\tconnect("battle_finished", Callable(self, "_on_battle_finished"))',
        '',
        'func engine_signal(tween: Tween) -> void:',
        '\ttween.finished.connect(_on_battle_finished)',
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
      .prepare(`SELECT id, kind FROM nodes WHERE name = 'battle_finished' AND kind = 'field'`)
      .get();
    expect(signal).toBeTruthy();

    const refs = db
      .prepare(
        `SELECT s.name AS src FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND t.name = 'battle_finished'
         ORDER BY s.name`
      )
      .all()
      .map((r: any) => r.src);
    expect(refs).toEqual(['emit_it', 'legacy', 'legacy_connect', 'wire']);

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
