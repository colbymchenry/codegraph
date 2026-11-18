/**
 * A local that holds what a required module's function returns is not the
 * module.
 *
 * `const fastify = require('..')()` was read as binding `fastify` to the
 * module, for the whole file, so every `fastify.get(…)`, `fastify.listen(…)`
 * in it linked to the `fastify()` factory itself: 101 such calls in fastify's
 * examples, and with #2964's `require('..')` resolved, about 400 across its
 * tests. The call's value is now typed by what the module's function returns,
 * when that is known, and is no binding of the module otherwise. A package's
 * call result (`require('debug')('app')`) stays bound to the package, which
 * keeps a name match off it.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-require-call-'));
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

/** `caller -> file:qualifiedName` for every `calls` edge out of `file`. */
function callsFrom(graph: CodeGraph, file: string): string[] {
  const out: string[] = [];
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      if (e.kind !== 'calls') continue;
      const target = graph.getNode(e.target)!;
      out.push(`${node.name} -> ${target.filePath}:${target.qualifiedName}`);
    }
  }
  return out.sort();
}

describe("a local holding a required module's call result", () => {
  it('is not the module, so its members are no calls of the factory', async () => {
    const graph = await index({
      'app.js': "'use strict'\nfunction app (opts) {\n  const instance = { get () {}, listen () {} }\n  return instance\n}\nmodule.exports = app\n",
      // fastify's tests: one test gets its instance from the call, another from a binding of the factory.
      'test/a.test.js':
        "'use strict'\nconst App = require('../app')\n" +
        "function one () { const server = require('../app')(); server.get('/'); server.listen() }\n" +
        "function two () { const server = App(); server.get('/') }\n",
    });
    expect(callsFrom(graph, 'test/a.test.js')).toEqual(['two -> app.js:app']);
  }, 120_000);

  it("is typed by what the module's function returns, when that is known", async () => {
    const graph = await index({
      'factory.js':
        "class Server {\n  listen () { return 1 }\n}\nfunction create () { return new Server() }\nmodule.exports = create\n",
      'use.js': "const srv = require('./factory')()\nfunction run () { return srv.listen() }\nmodule.exports = run\n",
      'other.js': 'class Decoy {\n  listen () { return 2 }\n}\nmodule.exports = Decoy\n',
    });
    expect(callsFrom(graph, 'use.js')).toEqual(['run -> factory.js:Server::listen']);
  }, 120_000);

  it("keeps a package's call result bound to the package", async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { debug: '^4.0.0' } }),
      'log.js': "const debug = require('debug')('app')\nfunction log () { debug('x') }\nmodule.exports = log\n",
      'mine.js': 'function debug (m) { return m }\nmodule.exports = debug\n',
    });
    expect(callsFrom(graph, 'log.js')).toEqual([]);
  }, 120_000);
});
