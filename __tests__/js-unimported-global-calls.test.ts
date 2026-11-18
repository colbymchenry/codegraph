/**
 * A call or `new` of a standard global that an ES module neither declares nor
 * imports is the runtime's (#3238).
 *
 * `parseInt(s, 10)` and `new Response('ok')` in a module with no such import
 * linked to a project export of that name in another file, exact-match: the
 * short built-ins list missed them, and the name fell through to a
 * project-wide match. A standard global (ECMAScript's, the web platform's) in
 * an ES module is now the module's own declaration, a global one (a script's
 * top level, `declare global`, a polyfill hung on `window`) or the runtime's,
 * never another module's export, which only an import reaches. Any other
 * name keeps the name match as a fallback, and a script (no import or export)
 * still shares its top level with other scripts.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unimported-globals-'));
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

/** `caller -kind-> file:name` for every call and instantiation out of `file`. */
function linksFrom(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls' && e.kind !== 'instantiates') continue;
      const target = graph.getNode(e.target)!;
      out.push(`${node.name} -${e.kind}-> ${target.filePath}:${target.name}`);
    }
  }
  return out.sort();
}

const DECOYS =
  'export function parseInt(s: string) { return s.length; }\nexport class Response { constructor(_body: string) {} }\n' +
  'export function structuredClone(x: unknown) { return x; }\nexport class URL { constructor(_u: string) {} }\n';

describe('a standard global an ES module neither declares nor imports', () => {
  it("links no other module's export of that name (#3238)", async () => {
    const graph = await index({
      // The issue's reproduction, and two more globals it lists.
      'lib/other.ts': DECOYS,
      'use.ts':
        'export function parse(s: string) { return parseInt(s, 10); }\n' +
        "export function reply() { return new Response('ok'); }\n" +
        'export function stamp() { return Date.now(); }\n' +
        'export function copy(x: object) { return structuredClone(x); }\n' +
        "export function link() { return new URL('x'); }\n",
      // The same from JavaScript, an ES module too.
      'use.js': 'export function parse(s) { return parseInt(s, 10); }\n',
    });
    expect(linksFrom(graph, 'use.ts')).toEqual([]);
    expect(linksFrom(graph, 'use.js')).toEqual([]);
  }, 120_000);

  it("still links the module's own, an imported, and a global declaration of the name", async () => {
    const graph = await index({
      'lib/other.ts': DECOYS,
      // Polyfills: a script's top level is the global scope; so is `declare global`.
      'polyfills/atob.js': 'function atob(s) { return s; }\n',
      'types/global.d.ts': 'export {};\ndeclare global {\n  function queueMicrotask(cb: () => void): void;\n}\n',
      'polyfills/btoa.js': 'export const installed = true;\nwindow.btoa = function btoa(s) { return s; };\n',
      'own.ts': "class Event { constructor(readonly type: string) {} }\nexport function fire() { return new Event('x'); }\n",
      'imported.ts': "import { parseInt } from './lib/other';\nexport function parse(s: string) { return parseInt(s); }\n",
      'globals.ts':
        "export function decode(s: string) { return atob(s); }\n" +
        'export function later(cb: () => void) { return queueMicrotask(cb); }\n' +
        "export function load() { return btoa('x'); }\n",
      // A script calling another script's top-level function.
      'scripts/page.js': 'function boot() { return atob("x"); }\n',
      // A name a parameter binds is no global: here a dynamic import's export.
      'lazy.ts': "export function later() { return import('./lib/other').then(({ URL }) => new URL('x')); }\n",
    });
    expect(linksFrom(graph, 'own.ts')).toEqual(['fire -instantiates-> own.ts:Event']);
    expect(linksFrom(graph, 'imported.ts')).toEqual(['parse -calls-> lib/other.ts:parseInt']);
    expect(linksFrom(graph, 'globals.ts')).toEqual([
      'decode -calls-> polyfills/atob.js:atob',
      'later -calls-> types/global.d.ts:queueMicrotask',
      'load -calls-> polyfills/btoa.js:btoa',
    ]);
    expect(linksFrom(graph, 'scripts/page.js')).toEqual(['boot -calls-> polyfills/atob.js:atob']);
    expect(linksFrom(graph, 'lazy.ts')).toEqual(['later -instantiates-> lib/other.ts:URL']);
  }, 120_000);

  it("keeps an app's auto-imported exports linked by name, and any other name's match", async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { nuxt: '^3.0.0' } }),
      'composables/useRequest.ts': 'export class Request { constructor(readonly url: string) {} }\n',
      'utils/format.ts': "export function make() { return new Request('x'); }\n",
    });
    expect(linksFrom(graph, 'utils/format.ts')).toEqual(['make -instantiates-> composables/useRequest.ts:Request']);
  }, 120_000);
});
