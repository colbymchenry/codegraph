/**
 * What counts as a circular import: the strongly connected components of the
 * file import graph, and nothing else the graph knows about two files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { findFileCycles } from '../src/graph/file-cycles';

const pairs = (...edges: string[]) =>
  edges.map((edge) => {
    const [source, target] = edge.split('>') as [string, string];
    return { source, target };
  });

describe('findFileCycles', () => {
  it('finds nothing in a graph with no loop, a diamond included', () => {
    expect(findFileCycles(pairs('a>b', 'a>c', 'b>d', 'c>d'))).toEqual([]);
    expect(findFileCycles([])).toEqual([]);
  });

  it('reports a knot once, with every file in it', () => {
    // a>b>a is a loop and so is a>c>b>a. A walk meets b first and has nothing
    // left to do at c>b, so it reported a>b and left c out.
    expect(findFileCycles(pairs('a>b', 'b>a', 'a>c', 'c>b'))).toEqual([['a', 'b', 'c']]);
    // Two loops through one file are one group, however many ways round there are.
    expect(findFileCycles(pairs('a>b', 'b>a', 'a>c', 'c>a'))).toEqual([['a', 'b', 'c']]);
  });

  it('keeps separate knots apart, smallest first, and leaves out the files between them', () => {
    expect(findFileCycles(pairs('p>q', 'q>r', 'r>p', 'q>x', 'x>a', 'a>b', 'b>a'))).toEqual([
      ['a', 'b'],
      ['p', 'q', 'r'],
    ]);
  });

  it('gives the same report for the pairs in any order', () => {
    const edges = pairs('a>b', 'b>c', 'c>a', 'd>e', 'e>d', 'c>d');
    expect(findFileCycles([...edges].reverse())).toEqual(findFileCycles(edges));
  });

  it('walks a chain deeper than the call stack', () => {
    const length = 200_000;
    const chain = Array.from({ length }, (_, i) => ({ source: `f${i}`, target: `f${i + 1}` }));
    chain.push({ source: `f${length}`, target: 'f0' });
    const cycles = findFileCycles(chain);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(length + 1);
  });
});

describe('findCircularDependencies', () => {
  let dir: string;
  let cg: CodeGraph | null = null;

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    return cg;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-file-cycles-'));
  });
  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a loop that runs through a barrel', async () => {
    const graph = await index({
      'src/index.ts': "export * from './a';\n",
      'src/a.ts': "import { helper } from './helper';\nexport function a() { return helper(); }\n",
      'src/helper.ts': "import { a } from './index';\nexport function helper() { return a; }\n",
    });
    expect(graph.findCircularDependencies()).toEqual([['src/a.ts', 'src/helper.ts', 'src/index.ts']]);
  });

  it('finds a loop in Python', async () => {
    const graph = await index({
      'a.py': 'from b import bb\n\ndef aa():\n    return bb()\n',
      'b.py': 'from a import aa\n\ndef bb():\n    return aa()\n',
    });
    expect(graph.findCircularDependencies()).toEqual([['a.py', 'b.py']]);
  });

  it('does not take an interface call reaching a test fake for an import', async () => {
    // Production code imports nothing from the test. The interface's call fans
    // out to every implementer, the fake included, so the file edge list holds
    // the loop src>test>src that no import makes.
    const graph = await index({
      'src/pool.ts': [
        'export interface Worker { post(task: string): void }',
        'export function run(worker: Worker) { worker.post("x"); }',
        '',
      ].join('\n'),
      'src/pool.test.ts': [
        "import { run, Worker } from './pool';",
        'class FakeWorker implements Worker { post(task: string): void { void task; } }',
        'export function check() { run(new FakeWorker()); }',
        '',
      ].join('\n'),
    });
    const edgeList = graph.getFileDependencyPairs();
    expect(edgeList).toContainEqual({ source: 'src/pool.ts', target: 'src/pool.test.ts' });
    expect(edgeList).toContainEqual({ source: 'src/pool.test.ts', target: 'src/pool.ts' });
    expect(graph.findCircularDependencies()).toEqual([]);
  });

  it('does not take two pages that link to each other for an import', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '15.0.0', react: '19.0.0' } }),
      'app/page.tsx': [
        "import Link from 'next/link';",
        'export default function Home() { return <Link href="/about">About</Link>; }',
        '',
      ].join('\n'),
      'app/about/page.tsx': [
        "import Link from 'next/link';",
        'export default function About() { return <Link href="/">Home</Link>; }',
        '',
      ].join('\n'),
    });
    const edgeList = graph.getFileDependencyPairs();
    expect(edgeList).toContainEqual({ source: 'app/page.tsx', target: 'app/about/page.tsx' });
    expect(edgeList).toContainEqual({ source: 'app/about/page.tsx', target: 'app/page.tsx' });
    expect(graph.findCircularDependencies()).toEqual([]);
  });

  it('does not take the files of one Go package calling each other for an import', async () => {
    const graph = await index({
      'go.mod': 'module example.com/m\n\ngo 1.21\n',
      'one.go': 'package m\n\nfunc One() { Two() }\n',
      'two.go': 'package m\n\nfunc Two() { One() }\n',
    });
    expect(graph.findCircularDependencies()).toEqual([]);
  });
});
