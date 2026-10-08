/**
 * The Kotlin grammar's scanner inserted an automatic semicolon on the same
 * line before any word starting with `e` that was not `else` — so an infix
 * call named like Exposed's `eq` (`Users.id eq id1`) ended its statement
 * early and the rest became a parse error. Error recovery could then swallow
 * the class around it: Exposed's r2dbc `UpsertTests` came out as one loose
 * function nesting all its tests. The vendored scanner (wasm and kernel) is
 * patched; see docs/grammars/tree-sitter-kotlin.md.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-infix-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/Ops.kt'), `package app

infix fun Int.eq(other: Int): Boolean = this == other

class Ops {
    fun same(a: Int, b: Int): Boolean = a eq b

    fun found(id1: Int): Int = listOf(1).filter { it eq id1 }.single()
}
`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('a Kotlin infix call named with a leading `e`', () => {
  it('parses clean', async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['kotlin']);
    const parser = getParser('kotlin')!;
    for (const src of ['fun f() { val c = a eq b }', 'fun f() { w { t.id eq id1 }.single() }', 'fun f() { if (a) b else c }']) {
      expect(parser.parse(src)!.rootNode.hasError, src).toBe(false);
    }
  });

  it('leaves the class around it and its methods intact', () => {
    const methods = cg.getNodesInFile('src/Ops.kt').filter((n) => n.qualifiedName.startsWith('app::Ops::')).map((n) => n.name).sort();
    expect(methods).toEqual(['found', 'same']);
  });
});
