/**
 * Synthesis-tail scaling regressions (#1212).
 *
 * On a 2M-node graph (Linux kernel) the dynamic-edge synthesis tail OOM'd
 * Node's default heap and/or starved the #850 liveness watchdog: the kotlin
 * expect/actual pass opened with `getAllNodes()` (hydrating the entire node
 * table into one array), and most passes ran start-to-finish with no yield
 * points. The fix streams every whole-kind scan, filters the kotlin pass
 * SQL-side, and language-gates passes off the files table.
 *
 * These tests pin the query-level building blocks and the end-to-end kotlin
 * bridge so the memory fix can't silently change what gets synthesized.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('synthesis-tail scaling (#1212)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-scaling-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('kotlin expect/actual still bridges through the streamed decorator query', async () => {
    fs.writeFileSync(
      path.join(dir, 'Platform.kt'),
      `package com.example.shared

expect fun platformName(): String
`
    );
    fs.writeFileSync(
      path.join(dir, 'Platform.jvm.kt'),
      `package com.example.shared

actual fun platformName(): String = "JVM"
`
    );
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const db = (cg as any).db.db;
    const edges = db
      .prepare(
        `SELECT e.source, e.target FROM edges e
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'kotlin-expect-actual'`
      )
      .all();
    expect(edges.length).toBeGreaterThanOrEqual(1);
    cg.close();
  });

  it('iterateNodesByLanguageWithDecorator matches getAllNodes().filter exactly', async () => {
    fs.writeFileSync(
      path.join(dir, 'A.kt'),
      `package p

actual fun realActual(): Int = 1
`
    );
    // TypeScript decorator whose name CONTAINS "actual" — the SQL LIKE
    // pre-filter must not surface it as a kotlin actual.
    fs.writeFileSync(
      path.join(dir, 'b.ts'),
      `function actual(target: object): void {}
class C {
  m(): number { return 1; }
}
`
    );
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const queries = (cg as unknown as { queries: import('../src/db/queries').QueryBuilder }).queries;
    const streamed = [...queries.iterateNodesByLanguageWithDecorator('kotlin', 'actual')]
      .filter((n) => n.decorators?.includes('actual'))
      .map((n) => n.id)
      .sort();
    const reference = queries
      .getAllNodes()
      .filter((n) => n.language === 'kotlin' && !!n.decorators?.includes('actual'))
      .map((n) => n.id)
      .sort();
    expect(streamed).toEqual(reference);
    expect(reference.length).toBeGreaterThanOrEqual(1); // the fixture really has one
    cg.close();
  });

  it('getDistinctFileLanguages reports exactly the languages present', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'y.py'), 'def f():\n    return 1\n');
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();

    const queries = (cg as unknown as { queries: import('../src/db/queries').QueryBuilder }).queries;
    const langs = queries.getDistinctFileLanguages();
    expect(langs.has('typescript')).toBe(true);
    expect(langs.has('python')).toBe(true);
    expect(langs.has('kotlin')).toBe(false);
    cg.close();
  });
});
