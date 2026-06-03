/**
 * `QueryBuilder.iterateNodesByKind` — the streaming scan that fixes the #610
 * OOM. The dynamic-edge synthesizers used to `getNodesByKind('function')` /
 * `('method')`, materializing every symbol into one array (gigabytes on a
 * symbol-dense project → JS-heap OOM). They now iterate. These tests pin the
 * two properties that refactor relies on: the streamed set equals the eager
 * set, and an open iterator cursor coexists with other queries on the same
 * connection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('iterateNodesByKind (#610 streaming)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-iter-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function foo() { return 1; }\n' +
      'export function bar() { return 2; }\n' +
      'export class C { m() { return 3; } n() { return 4; } }\n'
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    try { cg.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('yields exactly the same nodes as the eager getNodesByKind', () => {
    const q = (cg as unknown as { queries: any }).queries;
    for (const kind of ['function', 'method', 'class'] as const) {
      const eager = q.getNodesByKind(kind).map((n: any) => n.id).sort();
      const streamed = [...q.iterateNodesByKind(kind)].map((n: any) => n.id).sort();
      expect(streamed).toEqual(eager);
    }
    // sanity: the fixture actually produced functions + methods to stream
    expect([...q.iterateNodesByKind('function')].length).toBeGreaterThan(0);
    expect([...q.iterateNodesByKind('method')].length).toBeGreaterThan(0);
  });

  it('keeps the cursor valid while other queries run mid-iteration', () => {
    const q = (cg as unknown as { queries: any }).queries;
    let seen = 0;
    for (const n of q.iterateNodesByKind('function')) {
      // A different prepared statement stepped on the same connection while the
      // iterator's cursor is open must not corrupt it.
      const again = q.getNodeById(n.id);
      expect(again?.id).toBe(n.id);
      seen++;
    }
    expect(seen).toBe(q.getNodesByKind('function').length);
  });
});
