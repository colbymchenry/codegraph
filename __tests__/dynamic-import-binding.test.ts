/**
 * Issue #2491: a function imported from a Node built-in names nothing in the
 * project. The static forms (`import { resolve } from 'node:path'`, bare
 * `'fs'`, `require('node:fs')`) stopped linking to same-named project
 * functions in #2120; a DYNAMIC import still did. vite's
 * `const { createServer } = await import('node:http'); return createServer(app)`
 * linked to vite's own `createServer`, and `readFile` from
 * `await import('node:fs/promises')` to a playground helper.
 *
 * The binding counts only where it is in scope: nitro's
 * `async function createWebSocketProxy()` imports crossws's
 * `createWebSocketProxy` inside itself, so the call there is crossws's, while
 * the file's other calls still mean the local function.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', type: 'module', dependencies: { crossws: '^0.3.0', chalk: '^5.0.0' } }),
  'src/server/index.ts': `export function createServer(app: unknown): unknown { return app; }
`,
  'src/io.ts': `export function readFile(p: string): string { return p; }
export function chalk(s: string): string { return s; }
export class Worker { constructor(readonly file: string) {} }
`,
  'src/helper.ts': `export function helper(): number { return 1; }
`,
  'src/http.ts': `export async function resolveHttpServer(app: unknown) {
  const { createServer } = await import('node:http');
  return createServer(app as never);
}
`,
  'src/wasm.ts': `const instantiateFromFile = async (fileUrl: string) => {
  const { readFile: read, readFile } = await import('node:fs/promises');
  await read(fileUrl);
  return readFile(fileUrl);
};
export async function paint(s: string) {
  const { default: chalk } = await import('chalk');
  return chalk(s);
}
export function later(p: string) {
  return import('node:fs/promises').then(({ readFile }) => readFile(p));
}
export async function spawn() {
  const { Worker } = await import('node:worker_threads');
  return new Worker('x');
}
export async function wrap() {
  const { readFile } = await import('node:fs/promises');
  return [readFile].map((f) => f);
}
export { instantiateFromFile };
`,
  'src/proxy.ts': `async function createWebSocketProxy(opts: string) {
  const { createWebSocketProxy } = await import('crossws');
  return createWebSocketProxy(opts as never);
}
export function outer(o: string) { return createWebSocketProxy(o); }
export async function inner(p: string) {
  if (p) {
    const { readFile } = await import('node:fs/promises');
    await readFile(p);
  }
  return readFile(p);
}
export async function project() {
  const { helper } = await import('./helper');
  return helper();
}
`,
  'src/top.mjs': `const { readFile } = await import('node:fs/promises');
export async function fromTop(p) { return readFile(p); }
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dynamic-import-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file:line name` of every edge of `kinds` leaving `file`. */
function edgesFrom(file: string, kinds: string[]): string[] {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const e of cg.getOutgoingEdges(node.id)) {
      if (!kinds.includes(e.kind)) continue;
      const target = cg.getNode(e.target)!;
      out.push(`${e.line} ${target.filePath}:${target.name}`);
    }
  }
  return out;
}

describe('a name a dynamic import binds from outside the project (#2491)', () => {
  it("never links to a same-named project function: vite's `await import('node:http')`", () => {
    expect(edgesFrom('src/http.ts', ['calls'])).not.toContain('3 src/server/index.ts:createServer');
  });

  it('holds for renamed and default bindings, `.then` destructuring, constructors and function values', () => {
    const edges = edgesFrom('src/wasm.ts', ['calls', 'instantiates', 'references', 'function_ref']);
    expect(edges.filter((e) => e.includes('src/io.ts'))).toEqual([]);
  });

  it('holds for a top-level `await import()` binding', () => {
    expect(edgesFrom('src/top.mjs', ['calls']).filter((e) => e.includes('src/io.ts'))).toEqual([]);
  });

  it("binds only where it is in scope: nitro's function importing its own name", () => {
    const edges = edgesFrom('src/proxy.ts', ['calls']);
    // Inside the function, `createWebSocketProxy(opts)` is crossws's: no self-loop.
    expect(edges).not.toContain('3 src/proxy.ts:createWebSocketProxy');
    // Outside it, the call still means the file's own function.
    expect(edges).toContain('5 src/proxy.ts:createWebSocketProxy');
    // Inside the `if` block the name is node's; after the block it is bound by nothing, as before.
    expect(edges).not.toContain('9 src/io.ts:readFile');
    expect(edges).toContain('11 src/io.ts:readFile');
  });

  it("keeps a dynamic import of the project's own module", () => {
    expect(edgesFrom('src/proxy.ts', ['calls'])).toContain('15 src/helper.ts:helper');
  });
});

describe('sync reads the dynamic import an edit adds or removes (#2491)', () => {
  it('drops the name match when the import appears and restores it when it goes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dynamic-import-sync-'));
    const write = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    const plain = 'export async function a(p: string) {\n  return readFile(p);\n}\n';
    const dynamic = "export async function a(p: string) {\n  const { readFile } = await import('node:fs/promises');\n  return readFile(p);\n}\n";
    write('src/io.ts', 'export function readFile(p: string): string { return p; }\n');
    write('src/use.ts', plain);
    const graph = await CodeGraph.init(dir, { index: true });
    const calls = (): string[] =>
      graph.getNodesInFile('src/use.ts').flatMap((n) =>
        graph.getOutgoingEdges(n.id).filter((e) => e.kind === 'calls').map((e) => `${graph.getNode(e.target)!.filePath}:${graph.getNode(e.target)!.name}`));
    try {
      expect(calls()).toContain('src/io.ts:readFile');
      write('src/use.ts', dynamic);
      await graph.sync();
      expect(calls()).not.toContain('src/io.ts:readFile');
      write('src/use.ts', plain);
      await graph.sync();
      expect(calls()).toContain('src/io.ts:readFile');
    } finally {
      graph.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
