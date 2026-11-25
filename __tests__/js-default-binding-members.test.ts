/**
 * A member read through a default binding: `const named = require('./m');
 * named.second()`, or `import named from './m'` on the same module.
 *
 * Such a binding is the whole module where the module states no default of its
 * own, and the default lookup could only guess at its first export: every
 * member of a CommonJS module of `exports.x = …` assignments landed on
 * whichever function was assigned first, a method that doesn't exist among them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-default-member-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

/** What each line of `fn` calls: `<line> <file>:<qualified name>`, sorted. */
function callsOf(cg: CodeGraph, fn: string): string[] {
  const node = cg.getNodesByName(fn).find((n) => n.kind === 'function');
  expect(node, fn).toBeDefined();
  return cg.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${e.line} ${t.filePath}:${t.qualifiedName}`;
    })
    .sort();
}

const CALLER = (binding: string, members: string[]): string =>
  `${binding}\nfunction run() {\n${members.map((m) => `  named.${m}();`).join('\n')}\n}\nmodule.exports.run = run;\n`;

describe('a member read through a default binding', () => {
  it.each([
    ['anonymous functions', 'exports.first = function () {};\nexports.second = function () {};\n', 'm.js:second'],
    ['named functions', 'exports.first = function first() {};\nexports.second = function second() {};\n', 'm.js:second'],
    ['a function of another name', 'exports.first = function one() {};\nexports.second = function two() {};\n', 'm.js:two'],
    ['local functions', 'function first() {}\nfunction second() {}\nexports.first = first;\nexports.second = second;\n', 'm.js:second'],
    ['an object of them', 'function first() {}\nfunction second() {}\nmodule.exports = { first, second };\n', 'm.js:second'],
  ])('reaches the export of that name on a CommonJS module of %s', async (_shape, module, target) => {
    const cg = await indexProject({
      'm.js': module,
      'use.js': CALLER("const named = require('./m');", ['second']),
    });
    expect(callsOf(cg, 'run')).toEqual([`3 ${target}`]);
  });

  it('reaches it through a module that forwards another whole', async () => {
    const cg = await indexProject({
      'index.js': "module.exports = require('./lib/m');\n",
      'lib/m.js': 'exports.first = function () {};\nexports.second = function () {};\n',
      'use.js': CALLER("const named = require('./index');", ['second']),
    });
    expect(callsOf(cg, 'run')).toEqual(['3 lib/m.js:second']);
  });

  it('reaches it through a default import of the module too', async () => {
    const cg = await indexProject({
      'm.js': 'exports.first = function () {};\nexports.second = function () {};\n',
      'use.mjs': "import named from './m.js';\nexport function run() {\n  named.second();\n}\n",
    });
    expect(callsOf(cg, 'run')).toEqual(['3 m.js:second']);
  });

  it('reaches it on an ES module with no default, or one whose default is an expression', async () => {
    const cg = await indexProject({
      'plain.mjs': 'export function first() {}\nexport function second() {}\n',
      'made.mjs': 'export function first() {}\nexport function second() {}\nexport default make();\nfunction make() { return {}; }\n',
      'use.js': "const plain = require('./plain.mjs');\nconst made = require('./made.mjs');\nfunction run() {\n  plain.second();\n  made.second();\n}\nmodule.exports.run = run;\n",
    });
    expect(callsOf(cg, 'run')).toEqual(['4 plain.mjs:second', '5 made.mjs:second']);
  });

  it('keeps the value a declaration file says a module is', async () => {
    const cg = await indexProject({
      'typings/passport.d.ts': "declare module 'passport-x' {\n  const passport: { use(): void };\n  export = passport;\n}\n",
      'use.ts': "import passport from 'passport-x';\nexport function run() {\n  passport.use();\n}\n",
    });
    expect(callsOf(cg, 'run')).toEqual(['3 typings/passport.d.ts:passport']);
  });

  it('links nothing for a name the module does not export', async () => {
    const cg = await indexProject({
      'm.js': 'exports.first = function () {};\nexports.second = function () {};\n',
      'plain.mjs': 'export function first() {}\n',
      'use.js': "const named = require('./m');\nconst plain = require('./plain.mjs');\nfunction run() {\n  named.missing();\n  plain.missing();\n}\nmodule.exports.run = run;\n",
    });
    expect(callsOf(cg, 'run')).toEqual([]);
  });

  it('takes what `module.exports =` states over a neighbour assigned to it', async () => {
    const cg = await indexProject({
      'm.js': 'function main() {}\nmodule.exports = main;\nmodule.exports.extra = function () {};\n',
      'use.js': "const named = require('./m');\nfunction run() {\n  named();\n  named.extra();\n}\nmodule.exports.run = run;\n",
    });
    expect(callsOf(cg, 'run')).toEqual(['3 m.js:main', '4 m.js:extra']);
  });

  it('links the member a sync brings, and drops the one it takes away', async () => {
    const cg = await indexProject({
      'm.js': 'exports.first = function () {};\n',
      'use.js': CALLER("const named = require('./m');", ['second']),
    });
    expect(callsOf(cg, 'run')).toEqual([]);
    const moduleFile = path.join(roots[roots.length - 1]!, 'm.js');
    fs.writeFileSync(moduleFile, 'exports.first = function () {};\nexports.second = function () {};\n');
    await cg.sync();
    expect(callsOf(cg, 'run')).toEqual(['3 m.js:second']);
    fs.writeFileSync(moduleFile, 'exports.first = function () {};\n');
    await cg.sync();
    expect(callsOf(cg, 'run')).toEqual([]);
  });

  it("keeps a stated default's own member, and a class the module makes its default", async () => {
    const cg = await indexProject({
      'stated.ts': 'export class Widget { static make() {} }\nexport function make() {}\nexport default Widget;\n',
      'instance.ts': 'export class Store { load() {} }\nexport default new Store();\n',
      'value.ts': 'class Cache { read() {} }\nconst cache: Cache = new Cache();\nexport function read() {}\nexport default cache;\n',
      'use.ts': "import Widget from './stated';\nimport store from './instance';\nimport cache from './value';\nexport function run() {\n  Widget.make();\n  store.load();\n  cache.read();\n}\n",
    });
    expect(callsOf(cg, 'run')).toEqual(['5 stated.ts:Widget::make', '6 instance.ts:Store::load', '7 value.ts:Cache::read']);
  });
});
