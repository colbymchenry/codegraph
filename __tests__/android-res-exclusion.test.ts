/**
 * Android resource XML is excluded from the index by default (#1047).
 *
 * A `res/` tree holds only non-code resources (layouts, value bags, drawables,
 * menus) split into typed, optionally qualified subdirectories. None of it yields
 * a code symbol, yet on an Android app it dominates the file count (one report:
 * 26k XML = 97% of files, 0 symbols), bloating the DB, slowing indexing, and
 * skewing explore results. CodeGraph now default-ignores the Android resource
 * type directories — `res/layout/`, `res/values/`, `res/drawable/`, … and their
 * `-<qualifier>` variants — at discovery.
 *
 * Guardrails this locks in:
 *  - Real code (`.java`) is still indexed.
 *  - The one XML that DOES carry symbols — a MyBatis mapper under
 *    `src/main/resources/` — is untouched (it never lives under `res/`).
 *  - Plain non-`res/` XML (`pom.xml`) is unaffected.
 *  - `res/raw/` is deliberately KEPT — it holds arbitrary bundled assets that can
 *    be code-ish, so we don't drop it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('Android resource XML exclusion (#1047)', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-android-res-'));

    // Android resource files (every typed subdir, incl. a locale qualifier) — all
    // should be EXCLUDED.
    write('app/src/main/res/layout/activity_main.xml', '<LinearLayout><TextView/></LinearLayout>\n');
    write('app/src/main/res/values/strings.xml', '<resources><string name="app_name">App</string></resources>\n');
    write('app/src/main/res/values-es/strings.xml', '<resources><string name="app_name">App</string></resources>\n');
    write('app/src/main/res/drawable/ic_foo.xml', '<vector android:height="24dp"/>\n');
    write('app/src/main/res/menu/main_menu.xml', '<menu><item android:id="@+id/x"/></menu>\n');

    // Real code, a MyBatis mapper (the one XML with symbols), plain XML, and a
    // res/raw asset — all should be KEPT.
    write('app/src/main/java/com/example/Main.java', 'package com.example;\npublic class Main { void run(){} }\n');
    write('src/main/resources/FooMapper.xml',
      '<mapper namespace="com.example.FooDao"><select id="findAll">SELECT * FROM foo</select></mapper>\n');
    write('pom.xml', '<project><artifactId>demo</artifactId></project>\n');
    write('app/src/main/res/raw/payload.xml', '<data><item>1</item></data>\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('excludes Android resource XML but keeps code, MyBatis mappers, plain XML, and res/raw', () => {
    const indexed = new Set(cg.getFiles().map((f) => f.path));

    // Excluded: every resource type dir, including the qualifier variant.
    expect(indexed).not.toContain('app/src/main/res/layout/activity_main.xml');
    expect(indexed).not.toContain('app/src/main/res/values/strings.xml');
    expect(indexed).not.toContain('app/src/main/res/values-es/strings.xml');
    expect(indexed).not.toContain('app/src/main/res/drawable/ic_foo.xml');
    expect(indexed).not.toContain('app/src/main/res/menu/main_menu.xml');

    // Kept: real code, plain XML, and the deliberately-spared res/raw asset.
    expect(indexed).toContain('app/src/main/java/com/example/Main.java');
    expect(indexed).toContain('pom.xml');
    expect(indexed).toContain('app/src/main/res/raw/payload.xml');

    // Kept AND still carries symbols: the MyBatis mapper (non-regression — the
    // only valuable XML, and it never lives under res/).
    const mapper = cg.getFiles().find((f) => f.path === 'src/main/resources/FooMapper.xml');
    expect(mapper).toBeDefined();
    expect(mapper!.nodeCount).toBeGreaterThan(1); // file node + ≥1 statement
  });
});
