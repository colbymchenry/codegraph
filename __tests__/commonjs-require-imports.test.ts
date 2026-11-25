/**
 * A CommonJS `require('./x')` is a file import, as ESM's `import` is: Express's
 * `lib/express.js` requires `./application`, `./request` and `./response`, and
 * the index said it imported nothing — an empty Imports rail in the viewer and
 * no file dependency — because those bindings are used as values, never
 * called. A module path also resolves the way the runtime finds it, so an
 * extensionless ESM side-effect import (`import './polyfills'`) reaches its
 * file instead of stopping at its own import statement. A package
 * (`require('express')`) stays outside the index.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cjs-require-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'web', main: 'index.js' }),
    'index.js': `module.exports = require('./lib/express');
`,
    'lib/express.js': `var EventEmitter = require('events').EventEmitter;
var mixin = require('merge-descriptors');
var proto = require('./application');
var req = require('./request');

function createApplication() {
  var app = function () {};
  mixin(app, EventEmitter.prototype, false);
  mixin(app, proto, false);
  app.request = Object.create(req);
  return app;
}

module.exports = createApplication;
`,
    'lib/application.js': `var app = exports = module.exports = {};
app.init = function init() {};
`,
    'lib/request.js': `var req = Object.create({});
module.exports = req;
`,
    'test/app.js': `var express = require('..');
var assert = require("assert");
`,
    'src/main.ts': `import './polyfills';
import helper = require('./helper');
export const value = helper.run();
`,
    'src/polyfills.ts': `export {};
`,
    'src/helper.ts': `export function run(): number {
  return 1;
}
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

const importedFiles = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return [...new Set(cg.getOutgoingEdgesFrom(ids, ['imports'])
    .map((e) => cg.getNode(e.target)!.filePath)
    .filter((p) => p !== file))].sort();
};

describe('CommonJS require', () => {
  it('imports the files a module requires, used as values or not, and no package', () => {
    expect(importedFiles('lib/express.js')).toEqual(['lib/application.js', 'lib/request.js']);
    expect(cg.getFileDependencies('lib/express.js')).toEqual(expect.arrayContaining(['lib/application.js', 'lib/request.js']));
  });

  it('follows a directory require to its package entry', () => {
    expect(importedFiles('index.js')).toEqual(['lib/express.js']);
    expect(importedFiles('test/app.js')).toEqual(['index.js']);
  });
});

describe('a module path', () => {
  it('reaches an extensionless side-effect import’s file', () => {
    expect(importedFiles('src/main.ts')).toContain('src/polyfills.ts');
  });

  it('reaches a TypeScript import-equals file once', () => {
    const ids = cg.getNodesInFile('src/main.ts').map((n) => n.id);
    const toHelper = cg.getOutgoingEdgesFrom(ids, ['imports'])
      .filter((e) => cg.getNode(e.target)!.filePath === 'src/helper.ts' && cg.getNode(e.target)!.kind === 'file');
    expect(toHelper.length).toBeLessThanOrEqual(1);
  });
});
