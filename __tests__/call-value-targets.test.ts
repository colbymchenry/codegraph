/**
 * A call or `new` written with a name that a TypeScript file declares both as
 * a type and as a value (`interface Ok` beside `function Ok`, a class merged
 * with an interface) reached the type, and a `new` of a value that only a
 * project type shares its name with (`interface Response` for the global
 * `Response`) was linked to that type. Nothing calls an interface or a type
 * alias, or makes an instance of one: the call reaches the value its file
 * declares under the name, or links nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-call-value-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** `kind name(kind)@file` of every edge of `kinds` out of `file`'s nodes. */
function edgesFrom(graph: CodeGraph, file: string, kinds: string[]): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (!kinds.includes(e.kind)) continue;
      const target = graph.getNode(e.target)!;
      out.push(`${e.kind} ${target.name}(${target.kind})@${target.filePath}`);
    }
  }
  return out.sort();
}

describe('a call or `new` never lands on an interface or a type alias', () => {
  /** memfs's fs-core/src/result.ts: each result type beside the function that makes one. */
  const result =
    'export interface Ok<T> {\n  ok: true;\n  value: T;\n}\n\nexport interface Err<E> {\n  ok: false;\n  err: E;\n}\n\n' +
    'export type Result<T, E> = Ok<T> | Err<E>;\n\n' +
    'export function Ok<T>(value: T): Ok<T> {\n  return { ok: true, value };\n}\n\n' +
    'export function Err<E>(err: E): Err<E> {\n  return { ok: false, err };\n}\n';

  it('reaches the value declared beside the type, directly and through a barrel', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/result.ts': result,
      'lib/index.ts': "export * from './result';\n",
      'direct.ts':
        "import { Ok, Err } from './lib/result';\n\nexport const direct = (fail: boolean) => (fail ? Err('no') : Ok(1));\nexport const typed = (r: Ok<number>) => r;\n",
      'barrel.ts': "import { Ok } from './lib';\n\nexport const barrel = () => Ok(2);\n",
    });
    expect(edgesFrom(graph, 'direct.ts', ['calls'])).toEqual(['calls Err(function)@lib/result.ts', 'calls Ok(function)@lib/result.ts']);
    expect(edgesFrom(graph, 'barrel.ts', ['calls'])).toEqual(['calls Ok(function)@lib/result.ts']);
    // A type position still names the type.
    expect(edgesFrom(graph, 'direct.ts', ['references'])).toContain('references Ok(interface)@lib/result.ts');
  }, 120_000);

  it('links nothing for a value only a project type answers', async () => {
    // insomnia's Postman `interface Response`, vite's `interface Worker`, jest-circus's `type Event`: globals.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'types/postman.ts': 'export interface Response {\n  code: number;\n}\n\nexport type Event = { name: string };\n',
      'types/worker.d.ts': 'export interface Worker {\n  postMessage(data: unknown): void;\n}\n',
      'fetch.ts': "export function respond(): unknown {\n  return [new Response('ok'), new Event('ready'), new Worker('w.js')];\n}\n",
      // jest's DefaultReporter: a `write` parameter beside a `type write` declared for it.
      'types/stream.ts': 'export type write = (chunk: string) => boolean;\n',
      'flush.ts': "export function flush(write: (chunk: string) => boolean): void {\n  write('done');\n}\n",
    });
    expect(edgesFrom(graph, 'fetch.ts', ['calls', 'instantiates'])).toEqual([]);
    expect(edgesFrom(graph, 'flush.ts', ['calls'])).toEqual([]);
  }, 120_000);

  it('reaches the class an interface merges with', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'store.ts': 'export interface Store {\n  size: number;\n}\n\nexport class Store {\n  size = 0;\n}\n',
      'use.ts': "import { Store } from './store';\n\nexport const make = () => new Store();\n",
    });
    expect(edgesFrom(graph, 'use.ts', ['instantiates'])).toEqual(['instantiates Store(class)@store.ts']);
  }, 120_000);
});
