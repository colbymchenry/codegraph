/**
 * Godot text scenes (.tscn): scene node tree, script attachment, signal
 * connections, and `res://` references resolving to real files.
 *
 * The extractor is ported from #1098 (i-snyder) onto the current extraction
 * architecture; the `res://` normalization lives in the name matcher.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('godot scenes', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-scene-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes scene nodes, script attachment, connections and scene preloads', async () => {
    fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'scenes', 'bar.tscn'),
      [
        '[gd_scene load_steps=2 format=3 uid="uid://abc"]',
        '',
        '[ext_resource type="Script" path="res://scripts/bar.gd" id="1_xyz"]',
        '',
        '[node name="Bar" type="Control"]',
        'script = ExtResource("1_xyz")',
        '',
        '[node name="Label" type="Label" parent="."]',
        '',
        '[connection signal="pressed" from="Label" to="." method="_on_pressed"]',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'scripts', 'bar.gd'),
      ['extends Control', '', 'func _on_pressed() -> void:', '\tpass', ''].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'scripts', 'user.gd'),
      ['extends Node', '', 'const BAR = preload("res://scenes/bar.tscn")', ''].join('\n')
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const nodes = db
      .prepare(`SELECT kind, name FROM nodes WHERE name IN ('Bar', 'Label', 'bar.tscn')`)
      .all();
    expect(nodes).toContainEqual({ kind: 'file', name: 'bar.tscn' });
    expect(nodes).toContainEqual({ kind: 'component', name: 'Bar' });
    expect(nodes).toContainEqual({ kind: 'component', name: 'Label' });

    const contains = db
      .prepare(
        `SELECT s.kind sk, s.name sn, t.kind tk, t.name tn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'contains' AND t.name IN ('Bar', 'Label')`
      )
      .all();
    expect(contains).toContainEqual({ sk: 'file', sn: 'bar.tscn', tk: 'component', tn: 'Bar' });
    expect(contains).toContainEqual({ sk: 'component', sn: 'Bar', tk: 'component', tn: 'Label' });

    // `script = ExtResource(...)` attaches the script file to the scene node.
    const scriptRefs = db
      .prepare(
        `SELECT t.name tn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'references' AND s.name = 'Bar'`
      )
      .all()
      .map((r: any) => r.tn);
    expect(scriptRefs).toContain('bar.gd');

    // `[connection ...]` links the emitting node to its handler and target.
    const connectionCalls = db
      .prepare(
        `SELECT t.name tn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND s.name = 'Label'`
      )
      .all()
      .map((r: any) => r.tn);
    expect(connectionCalls).toContain('_on_pressed');

    // `preload("res://scenes/bar.tscn")` resolves to the scene file itself.
    const sceneUsers = db
      .prepare(
        `SELECT s.name sn FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'imports' AND t.kind = 'file' AND t.name = 'bar.tscn'`
      )
      .all()
      .map((r: any) => r.sn);
    expect(sceneUsers).toContain('user.gd');

    cg.destroy();
  });
});
