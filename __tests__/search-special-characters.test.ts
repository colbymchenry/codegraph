/**
 * A character full-text search can't take literally separates the words on
 * either side of it, as it separates them in the index (#2971).
 *
 * The index splits text into words at anything that isn't a letter or digit,
 * so `leaf(entry)` in a signature is stored as `leaf` and `entry`. The query
 * side dropped `( ) ^ " ' * :` instead, gluing `leaf(entry)` into `leafentry`,
 * a word no symbol has: a pasted call like `render(props)` or `getUser(id)`
 * came back "No results found" while `render props` found both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-special-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    [
      'export function entry() { mid1(); mid2(); }',
      'export function leaf() { return 1; }',
      'function mid1() { return leaf(); }',
      'function mid2() { return 2; }',
      'export function render(props: { title: string }) { return props.title; }',
      '',
    ].join('\n'),
  );
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const names = (query: string) => [...new Set(cg.searchNodes(query).map((r) => r.node.name))].sort();

describe('a character search cannot take literally', () => {
  it.each(['leaf(entry)', 'leaf^entry', 'leaf"entry', "leaf'entry", 'leaf*entry', 'leaf:entry'])(
    'separates the words around it: %s',
    (query) => {
      expect(names(query)).toEqual(expect.arrayContaining(['entry', 'leaf']));
    },
  );

  it('finds the function a pasted call names', () => {
    expect(names('render(props)')).toContain('render');
    expect(names('mid1()')).toContain('mid1');
  });

  it('reads as the words alone did, and a query of nothing else finds nothing', () => {
    expect(names('leaf(entry)')).toEqual(names('leaf entry'));
    expect(names('leaf()')).toEqual(names('leaf'));
    expect(names('()')).toEqual([]);
  });
});
