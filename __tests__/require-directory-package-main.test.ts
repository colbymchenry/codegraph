/**
 * A relative require of a directory loads the file its `package.json` names
 * as `main`, as Node does before trying `index.js` (#2964): every fastify test
 * starts with `const Fastify = require('..')` for the root's
 * `"main": "fastify.js"`, and the call linked to the test file's own `Fastify`
 * constant instead of the `fastify()` the package exports.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-require-dir-main-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'srv', main: 'srv.js' }),
    'srv.js': `'use strict'
function srv (opts) { return build(opts) }
function build (o) { return o }
module.exports = srv
`,
    'lib/index.js': `function helper () { return 1 }
module.exports = helper
`,
    'lib/inner/package.json': JSON.stringify({ main: 'entry.js' }),
    'lib/inner/entry.js': `function inner () { return 2 }
module.exports = inner
`,
    'lib/bare/package.json': JSON.stringify({ main: './main' }),
    'lib/bare/main.js': `function bare () { return 3 }
module.exports = bare
`,
    'test/a.test.js': `'use strict'
const Srv = require('..')
const Srv2 = require('../')
const Srv3 = require('../srv')
function t () { Srv(); Srv2(); Srv3() }
`,
    'b.js': `const helper = require('./lib')
const inner = require('./lib/inner')
const bare = require('./lib/bare')
function u () { helper(); inner(); bare() }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `name file` of what a function calls. */
const callsOf = (file: string, name: string) => {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name)!;
  return cg.getOutgoingEdges(fn.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
    .map((t) => `${t.name} ${t.filePath}`).sort();
};

describe('a relative require of a directory', () => {
  it("reaches the package root's main through '..' and '../'", () => {
    expect(callsOf('test/a.test.js', 't')).toEqual(['srv srv.js', 'srv srv.js', 'srv srv.js']);
  });

  it("reaches a subdirectory's main, with or without its extension, and still an index.js", () => {
    expect(callsOf('b.js', 'u')).toEqual(['bare lib/bare/main.js', 'helper lib/index.js', 'inner lib/inner/entry.js']);
  });
});
