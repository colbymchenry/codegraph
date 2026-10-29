/**
 * codegraph_node on a name with more definitions than its caps hold (#1657).
 *
 * The index lists a name's definitions by path, and the multi-definition
 * answer rendered and listed them in that order until its caps ran out: 16
 * bodies, 20 list lines, then a bare "+N more". So hundreds of definitions
 * under an early-sorting folder hid the only one in another language or a
 * late folder, and nothing in the answer said another existed. Now a language
 * with no body gets one on top of the overloads that fit, each language and
 * top-level folder gets an early list line, and the overflow names what it
 * leaves out. The overloads that rendered before still render.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, definitionCapOrder, describeOmittedDefinitions } from '../src/mcp/tools';
import type { Node } from '../src/types';

const MAX_OUTPUT_LENGTH = 15000;

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

async function indexed(root: string): Promise<{ cg: CodeGraph; handler: ToolHandler }> {
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  return { cg, handler: new ToolHandler(cg) };
}

async function nodeText(handler: ToolHandler, args: Record<string, unknown>): Promise<string> {
  const res = await handler.execute('codegraph_node', args);
  expect(res.isError).toBeFalsy();
  return res.content?.[0]?.text ?? '';
}

describe('codegraph_node: definitions past the caps (#1657)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    // 400 TypeScript `num` methods under an early-sorting folder, one more in
    // another top-level folder, and the only Python `num` in a late one.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-spread-'));
    for (let f = 0; f < 40; f++) {
      const classes = Array.from({ length: 10 }, (_, c) =>
        `export class C${f}_${c} {\n  num(v: number): string {\n    return v.toFixed(${c});\n  }\n}\n`).join('\n');
      write(root, `aaa_client/m${String(f).padStart(2, '0')}.ts`, classes);
    }
    write(root, 'bbb_lib/helper.ts', 'export function num(v: number): number {\n  return Math.round(v);\n}\n');
    write(root, 'zzz_server/format.py', 'def num(value):\n    return round(value, 2)\n');
    ({ cg, handler } = await indexed(root));
  }, 120_000);

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders the only Python definition beside the TypeScript overloads that fit', async () => {
    const text = await nodeText(handler, { symbol: 'num', includeCode: true });
    expect(text).toContain('**402 definitions named "num"**');
    expect(text).toContain('Returning 17 in full; 385 more listed below');
    // main: the Python body, and the file, appeared nowhere.
    expect(text).toContain('**Location:** zzz_server/format.py:1');
    expect(text).toContain('def num(value):');
    // The same sixteen TypeScript bodies as before still render, in index order.
    const tsBodies = [...text.matchAll(/^\*\*Location:\*\* (aaa_client\/\S+)/gm)].map((m) => m[1]);
    expect(tsBodies).toEqual([
      ...Array.from({ length: 10 }, (_, c) => `aaa_client/m00.ts:${2 + 6 * c}`),
      ...Array.from({ length: 6 }, (_, c) => `aaa_client/m01.ts:${2 + 6 * c}`),
    ]);
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
  });

  it('gives another top-level folder an early list line and names the overflow', async () => {
    const text = await nodeText(handler, { symbol: 'num', includeCode: true });
    const listed = [...text.slice(text.indexOf('**Other definitions**')).matchAll(/^- `num` \(\w+\) — (\S+)$/gm)].map((m) => m[1]);
    expect(listed).toHaveLength(20);
    // main: bbb_lib/helper.ts was behind a bare "- … +365 more".
    expect(listed).toContain('bbb_lib/helper.ts:1');
    expect(text).toContain('- … +365 more: 365 typescript in aaa_client/');
    expect(text).not.toMatch(/^- … \+\d+ more$/m);
  });

  it('keeps every language and folder in a list too long for the output cap', async () => {
    const text = await nodeText(handler, { symbol: 'num' });
    // main: the output cap cut the list at "... (output truncated)", past
    // which both late folders fell.
    expect(text).not.toContain('(output truncated)');
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);
    expect(text).toContain('- `num` (function) — zzz_server/format.py:1');
    expect(text).toContain('- `num` (function) — bbb_lib/helper.ts:1');
    expect(text).toMatch(/^- … \+\d+ more: \d+ typescript in aaa_client\/$/m);
  });
});

describe('codegraph_node: a set that fits every cap reads as before (#1657)', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-fits-'));
    write(root, 'a/x.ts', 'export function num(v: number): string {\n  return String(v);\n}\n');
    write(root, 'b/y.py', 'def num(value):\n    return str(value)\n');
    write(root, 'c/z.ts', 'export function num(v: number): number {\n  return v;\n}\n');
    ({ cg, handler } = await indexed(root));
  }, 60_000);

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders every definition in index order with nothing listed', async () => {
    const text = await nodeText(handler, { symbol: 'num', includeCode: true });
    expect(text).toContain('Returning 3 in full — pick the one you need');
    expect([...text.matchAll(/^\*\*Location:\*\* (\S+)/gm)].map((m) => m[1])).toEqual(['a/x.ts:1', 'b/y.py:1', 'c/z.ts:1']);
    expect(text).not.toContain('**Other definitions**');
  });
});

describe('definitionCapOrder / describeOmittedDefinitions (#1657)', () => {
  const def = (filePath: string, language: string, startLine = 1): Node =>
    ({ id: `${filePath}:${startLine}`, name: 'num', kind: 'function', filePath, language, startLine } as unknown as Node);

  it('puts each language first, then each top-level folder, then the rest in order', () => {
    const nodes = [
      def('a/1.ts', 'typescript'), def('a/2.ts', 'typescript'), def('b/1.ts', 'typescript'),
      def('b/2.ts', 'typescript'), def('root.py', 'python'), def('z/1.py', 'python'),
    ];
    expect(definitionCapOrder(nodes).map((n) => n.filePath)).toEqual([
      'a/1.ts', 'root.py', // the first in each language
      'b/1.ts', 'z/1.py', // the first in each other folder within a language
      'a/2.ts', 'b/2.ts', // the rest
    ]);
    const oneFolder = [def('a/1.ts', 'typescript'), def('a/2.ts', 'typescript', 9), def('a/3.ts', 'typescript')];
    expect(definitionCapOrder(oneFolder)).toEqual(oneFolder);
  });

  it('names omitted definitions by language and folder, largest first', () => {
    expect(describeOmittedDefinitions([
      def('z/1.py', 'python'), def('a/1.ts', 'typescript'), def('a/2.ts', 'typescript'), def('main.go', 'go'),
    ])).toBe('2 typescript in a/, 1 python in z/, 1 go at the project root');
    const many = Array.from({ length: 8 }, (_, i) => def(`d${i}/x.ts`, 'typescript'));
    expect(describeOmittedDefinitions(many)).toBe(
      '1 typescript in d0/, 1 typescript in d1/, 1 typescript in d2/, 1 typescript in d3/, 1 typescript in d4/, 1 typescript in d5/, 2 elsewhere',
    );
  });
});
