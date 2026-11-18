/**
 * A member a required project module doesn't have links nothing (#3272).
 *
 * `const utils = require('./utils'); utils.missing()`, where `utils.js`
 * exports no `missing`, linked to `missing` of an unrelated class elsewhere,
 * the one method of that name, picked by name alone. The import resolver had
 * read the module's exports and found none; a namespace import (`import * as
 * utils`) and a package's binding were already kept from that guess, a local
 * module's default binding was not. What the module does export under the
 * name, or what its stated default (a class, an instance) has as a member,
 * still links.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-require-missing-'));
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

const DECOY = 'export class Decoy { missing() { return 42; } render() { return 1; } create() { return 2; } }\n';

describe('a member of a required project module', () => {
  it("links nothing when the module doesn't export it (#3272)", async () => {
    const graph = await index({
      // The issue's reproduction.
      'main.js': "const utils = require('./utils');\nfunction run() { return utils.missing(); }\nmodule.exports = run;\n",
      'utils.js': 'exports.known = function known() { return 1; };\n',
      'decoy.js': DECOY,
      // The same through a default import of the CommonJS module, from TypeScript.
      'use.ts': "import utils from './utils';\nexport function go() { return utils.missing(); }\n",
    });
    expect(callsFrom(graph, 'main.js')).toEqual([]);
    expect(callsFrom(graph, 'use.ts')).toEqual([]);
  }, 120_000);

  it('still links what the module exports, or what its stated default has', async () => {
    const graph = await index({
      'main.js':
        "const utils = require('./utils');\nconst Widget = require('./widget');\nconst panel = require('./panel');\n" +
        'function run() { return utils.missing(); }\n' +
        'function make() { return Widget.create(); }\n' +
        'function draw() { return panel.render(); }\n' +
        'function lost() { return panel.missing(); }\n',
      'utils.js': 'exports.known = function known() { return 1; };\nexports.missing = function missing() { return 2; };\n',
      'widget.js': 'module.exports = class Widget {\n  static create() { return new Widget(); }\n};\n',
      'panel.js': 'class Panel {\n  render() { return 3; }\n}\nmodule.exports = new Panel();\n',
      'decoy.js': DECOY,
    });
    expect(callsFrom(graph, 'main.js')).toEqual([
      'draw -> panel.js:Panel::render',
      'make -> widget.js:Widget::create',
      'run -> utils.js:missing',
    ]);
  }, 120_000);

  it('reads a parameter that shadows the module binding as itself, not as the module', async () => {
    const graph = await index({
      // The same function with and without a module binding of its parameter's name.
      'shadowed.js': "const utils = require('./utils');\nfunction run(utils) { return utils.missing(); }\nmodule.exports = run;\n",
      'plain.js': 'function run(utils) { return utils.missing(); }\nmodule.exports = run;\n',
      'typed.ts':
        "import utils from './utils';\nimport { Decoy } from './decoy';\n" +
        'export function go(utils: Decoy) { return utils.missing(); }\n',
      'utils.js': 'exports.known = function known() { return 1; };\n',
      'decoy.js': DECOY,
    });
    // The parameter is read as any untyped receiver is; the module's lack of a `missing` says nothing of it.
    expect(callsFrom(graph, 'plain.js')).not.toEqual([]);
    expect(callsFrom(graph, 'shadowed.js')).toEqual(callsFrom(graph, 'plain.js'));
    expect(callsFrom(graph, 'typed.ts')).toEqual(['go -> decoy.js:Decoy::missing']);
  }, 120_000);

  it('keeps the guess for a receiver no import binds, and a package binding linking nothing', async () => {
    const graph = await index({
      'package.json': JSON.stringify({ name: 'app', dependencies: { lodash: '^4.0.0' } }),
      'main.js':
        "const _ = require('lodash');\nfunction pick() { return _.missing(); }\n" +
        'function anyone(thing) { return thing.missing(); }\nmodule.exports = { pick, anyone };\n',
      'decoy.js': DECOY,
    });
    expect(callsFrom(graph, 'main.js').filter((c) => c.startsWith('pick'))).toEqual([]);
  }, 120_000);
});
