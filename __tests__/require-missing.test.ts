import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Edge } from '../src/types';

let root = '';
let cg: CodeGraph;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-require-missing-`));
});

afterEach(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const node = (file: string, name: string) => {
  const found = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import');
  expect(found, `${file}: ${name}`).toBeDefined();
  return found!;
};

/** The edges into `target`, as `kind source-file resolvedBy`. */
const into = (target: { id: string }, kinds: Edge['kind'][]) =>
  cg
    .getIncomingEdges(target.id)
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${e.kind} ${cg.getNode(e.source)!.filePath} ${(e.metadata as { resolvedBy?: string }).resolvedBy}`)
    .sort();

/** The call and instantiation edges out of a file's nodes, as `kind target-file:target-name`. */
const outOf = (file: string) =>
  cg
    .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => {
      const target = cg.getNode(e.target)!;
      return `${e.kind} ${target.filePath}:${target.name}`;
    })
    .sort();

describe('require() missing member on a known local module stays unresolved', () => {
  // Main case
  it('main case: require(\'./utils\').missing should stay unresolved', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `exports.known = function known() { return 1; };`,
      'decoy.js': `export class Decoy { missing() { return 42; } }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual([]);
    expect(into(node('utils.js', 'known'), ['calls'])).toEqual([]);
  });

  // Variant 1: no decoy.js
  it('variant 1: no decoy.js', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `exports.known = function known() { return 1; };`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual([]);
  });

  // Variant 2: Decoy is a standalone export function missing()
  it('variant 2: Decoy is a standalone export function missing()', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `exports.known = function known() { return 1; };`,
      'decoy.js': `export function missing() { return 42; }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual([]);
  });

  // Variant 3: utils.js also has exports.missing = function missing() {}
  it('variant 3: utils.js also has exports.missing', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `exports.known = function known() { return 1; };
exports.missing = function missing() { return 2; }`,
      'decoy.js': `export class Decoy { missing() { return 42; } }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual(['calls utils.js:missing']);
  });

  // Variant 4: ESM import * as utils from ./utils, no missing export
  it('variant 4: ESM import * as utils from ./utils, no missing export', async () => {
    const files: Record<string, string> = {
      'main.js': `import * as utils from './utils';
function run() { return utils.missing(); }
export { run };`,
      'utils.js': `exports.known = function known() { return 1; };`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual([]);
  });

  // Variant 5: ESM import { default } as utils from ./utils, no missing
  it('variant 5: ESM import { default } as utils from ./utils, no missing', async () => {
    const files: Record<string, string> = {
      'main.js': `import { default as utils } from './utils';
function run() { return utils.missing(); }
export { run };`,
      'utils.js': `exports.known = function known() { return 1; };`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual([]);
  });

  // Variant 6: module.exports = new Widget() — a call on the instance is legitimate
  it('variant 6: module.exports = new Widget()', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `class Widget { missing() { return 42; } }
module.exports = new Widget();`,
      'decoy.js': `export class Decoy { missing() { return 42; } }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual(['calls utils.js:missing']);
  });

  // Variant 7: module.exports = class Widget { missing() {} }
  it('variant 7: module.exports = class Widget with an instance method', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `module.exports = class Widget { missing() { return 42; } };`,
      'decoy.js': `export class Decoy { missing() { return 42; } }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual(['calls utils.js:missing']);
  });

  // Variant 8: module.exports = class Widget { static missing() {} }
  it('variant 8: module.exports = class Widget with a static method', async () => {
    const files: Record<string, string> = {
      'main.js': `const utils = require('./utils');
function run() { return utils.missing(); }
module.exports = run;`,
      'utils.js': `module.exports = class Widget { static missing() { return 42; } };`,
      'decoy.js': `export class Decoy { missing() { return 42; } }`,
      'package.json': JSON.stringify({ name: 'test-3272', devDependencies: {} }),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
    expect(outOf('main.js')).toEqual(['calls utils.js:missing']);
  });
});
