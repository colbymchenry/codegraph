/**
 * Two ways an import landed on the wrong kind of symbol, both on main before
 * the workspace-package fix made them common (jest, memfs, webdriverio):
 *
 * - A default import of a module whose `export default X` names a binding the
 *   module imports was answered by a guess: the first function or class the
 *   module exports itself, or, through `export * from './utils'`, the first
 *   function of the forwarded module — jest-resolve's
 *   `import Resolver from './resolver'; export * from './utils'; export default Resolver`
 *   sent `Resolver.findNodeModule()` to `resolveTestEnvironment`. An ES
 *   module's `export *` never hands on a default, and a default the module
 *   imports is no node of the module.
 * - A call or `new` written with a name that a TypeScript file declares both as
 *   a type and a value (`interface Ok` beside `function Ok`) reached the type,
 *   and one that only a project type answers (`interface Response` for the
 *   global `Response`) was linked to it. Nothing calls or makes an instance of
 *   an interface or a type alias.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-default-value-'));
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

/** `kind name@file` of every edge of `kinds` out of `file`'s nodes. */
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

describe('a default import of a module that hands on a default it does not declare', () => {
  /** jest-resolve's index, cut down. */
  const resolverBarrel: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app' }),
    'lib/resolver.ts':
      'export default class Resolver {\n  static findNodeModule(name: string): string | null {\n    return name;\n  }\n}\n',
    'lib/utils.ts':
      "import Resolver from './resolver';\n\nexport const resolveTestEnvironment = (name: string) => Resolver.findNodeModule(name);\nexport function resolveRunner(name: string): string {\n  return name;\n}\n",
    'lib/index.ts': "import Resolver from './resolver';\n\nexport * from './utils';\n\nexport default Resolver;\n",
    'use.ts':
      "import Resolver, { resolveRunner } from './lib';\n\nexport const find = (name: string) => Resolver.findNodeModule(name);\nexport const make = () => new Resolver();\nexport const keep = (r: Resolver) => [r, resolveRunner('x')];\n",
  };

  it('never reaches a function `export *` forwards', async () => {
    const graph = await index(resolverBarrel);
    const edges = edgesFrom(graph, 'use.ts', ['calls', 'instantiates', 'references']);
    expect(edges.filter((e) => e.includes('resolveTestEnvironment'))).toEqual([]);
    expect(edges).toContain('calls findNodeModule(method)@lib/resolver.ts');
    expect(edges).toContain('instantiates Resolver(class)@lib/resolver.ts');
    expect(edges).toContain('references Resolver(class)@lib/resolver.ts');
    // `export *` still hands on the named exports.
    expect(edges).toContain('calls resolveRunner(function)@lib/utils.ts');
  }, 120_000);

  it("follows the import to its module's own default, past a namesake elsewhere", async () => {
    // webdriver's node entry hands on the default of the module it also star-exports,
    // and a CommonJS twin declares a class of the same name.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/index.ts': 'export default class WebDriver {\n  static newSession(): number {\n    return 1;\n  }\n}\n',
      'lib/index.cts': 'class WebDriver {\n  static newSession(): number {\n    return 2;\n  }\n}\nmodule.exports = WebDriver;\n',
      'lib/node.ts': "import WebDriver from './index.js';\n\nexport default WebDriver;\nexport * from './index.js';\n",
      'use.ts': "import WebDriver from './lib/node';\n\nexport const start = () => WebDriver.newSession();\n",
    });
    expect(edgesFrom(graph, 'use.ts', ['calls'])).toEqual(['calls newSession(method)@lib/index.ts']);
  }, 120_000);

  it('never reaches a function `export *` forwards when the default is an expression', async () => {
    // A barrel whose default is no binding at all: `export *` still forwards none.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/api.ts': "export function createApi(): { get(): number } {\n  return { get: () => 1 };\n}\n",
      'lib/utils.ts': 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n',
      'lib/index.ts': "import { createApi } from './api';\n\nexport * from './utils';\n\nexport default createApi();\n",
      'use.ts': "import api from './lib';\n\nexport const load = () => api.get();\n",
    });
    expect(edgesFrom(graph, 'use.ts', ['calls']).filter((e) => e.includes('formatDate'))).toEqual([]);
  }, 120_000);

  it('never reaches a function the module exports beside it', async () => {
    // insomnia's main/log.ts and outline's logging/sentry.ts: the default is a package's.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'electron-log': '^5.0.0', '@sentry/node': '^8.0.0' } }),
      'lib/log.ts': "import log from 'electron-log/main';\n\nexport function getLogDirectory(): string {\n  return '/tmp';\n}\n\nexport default log;\n",
      'lib/sentry.ts':
        "import * as Sentry from '@sentry/node';\n\nexport function requestErrorHandler(error: unknown): void {\n  Sentry.captureException(error);\n}\n\nexport default Sentry;\n",
      'use.ts':
        "import log from './lib/log';\nimport Sentry from './lib/sentry';\n\nexport function report(error: unknown): void {\n  log.info('failed');\n  Sentry.captureException(error);\n}\n",
    });
    expect(edgesFrom(graph, 'use.ts', ['calls', 'references'])).toEqual([]);
  }, 120_000);

  it('still reaches what a module declares and exports as its default', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/store.ts': "export function helper(): number {\n  return 1;\n}\n\nfunction createStore(): number {\n  return 2;\n}\n\nexport default createStore;\n",
      'use.ts': "import createStore from './lib/store';\n\nexport const store = () => createStore();\n",
    });
    expect(edgesFrom(graph, 'use.ts', ['calls'])).toEqual(['calls createStore(function)@lib/store.ts']);
  }, 120_000);
});

describe('a call or `new` never lands on an interface or a type alias', () => {
  /** memfs's fs-core/src/result.ts: each result type beside the function that makes one. */
  const result = 'export interface Ok<T> {\n  ok: true;\n  value: T;\n}\n\nexport type Result<T> = Ok<T>;\n\nexport function Ok<T>(value: T): Ok<T> {\n  return { ok: true, value };\n}\n';

  it('reaches the value declared beside the type, directly and through a barrel', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'lib/result.ts': result,
      'lib/index.ts': "export * from './result';\n",
      'direct.ts': "import { Ok } from './lib/result';\n\nexport const direct = () => Ok(1);\nexport const typed = (r: Ok<number>) => r;\n",
      'barrel.ts': "import { Ok } from './lib';\n\nexport const barrel = () => Ok(2);\n",
    });
    expect(edgesFrom(graph, 'direct.ts', ['calls'])).toEqual(['calls Ok(function)@lib/result.ts']);
    expect(edgesFrom(graph, 'barrel.ts', ['calls'])).toEqual(['calls Ok(function)@lib/result.ts']);
    // A type position still names the type.
    expect(edgesFrom(graph, 'direct.ts', ['references'])).toContain('references Ok(interface)@lib/result.ts');
  }, 120_000);

  it('links nothing for a value only a project type answers', async () => {
    // insomnia's `interface Response` and jest-circus's `type Event`, for the globals.
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app' }),
      'types/postman.ts': 'export interface Response {\n  code: number;\n}\n\nexport type Event = { name: string };\n',
      'fetch.ts': "export function respond(): unknown {\n  return [new Response('ok'), new Event('ready')];\n}\n",
    });
    expect(edgesFrom(graph, 'fetch.ts', ['calls', 'instantiates'])).toEqual([]);
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
