/**
 * A JS/TS call written on `this` reads a property of the object, never a
 * lexical binding. The extractor records `this.cast(x)` by the bare name
 * `cast`, and since #3345 such a call skips the file's imports (so a class's
 * own `cast` wins over `import { cast }`). Name matching then reached the
 * file's own `const cast = require('./cast')`: a `calls` edge onto a
 * constant, as in mongoose's `Query.prototype._castConditions`. A `function`
 * declaration or a `const f = () => …` is a binding too: `this.validate()`
 * in fastify's hooks is no call of `validation.js`'s `function validate`.
 * A function assigned to a property (`app.set = function set (…)`) is a
 * property, and `this.set()` still reaches it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('a call written on this never links a lexical binding', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-this-binding-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = await CodeGraph.init(dir, { index: true });
    return cg;
  }

  /** `kind name@file:line` of every `calls` edge out of the file's nodes (the file itself included), by call line. */
  function callsFrom(g: CodeGraph, file: string): string[] {
    const sources = new Set([`file:${file}`, ...g.getNodesInFile(file).map((n) => n.id)]);
    return [...sources]
      .flatMap((id) => g.getOutgoingEdges(id).filter((e) => e.kind === 'calls'))
      .map((e) => { const t = g.getNode(e.target)!; return `L${e.line} ${t.kind} ${t.qualifiedName}@${t.filePath}:${t.startLine}`; })
      .sort();
  }

  it("leaves mongoose's this.cast() off the file's require binding", async () => {
    const g = await index({
      'lib/cast.js': 'module.exports = function cast (obj) { return obj }\n',
      'lib/query.js': [
        "'use strict'",
        "const cast = require('./cast')",
        'function Query () { this.model = null }',
        'Query.prototype.cast = function (model) { return cast(model) }',
        'Query.prototype._castConditions = function () { return this.cast(this.model) }',
        'module.exports = Query',
        '',
      ].join('\n'),
      'lib/widget.js': [
        "const cast = require('./cast')",
        'class Widget {',
        '  run () { return this.cast(1) }',
        '  build () { return cast(2) }',
        '}',
        'module.exports = Widget',
        '',
      ].join('\n'),
    });
    // The bare calls are the import's. `this.cast(…)` names no binding: in a
    // prototype method it is the constructor's own `cast` (#3380), and in a
    // class with no `cast` member it is nothing.
    expect(callsFrom(g, 'lib/query.js')).toEqual(['L4 function cast@lib/cast.js:1', 'L5 method Query::cast@lib/query.js:4']);
    expect(callsFrom(g, 'lib/widget.js')).toEqual(['L4 function cast@lib/cast.js:1']);
  });

  it('takes no declared function or local binding for this.m(), in this file or another', async () => {
    const g = await index({
      'lib/validation.js': 'function validate (s) { return !!s }\nmodule.exports = { validate }\n',
      'lib/hooks.js': [
        "const { validate } = require('./validation')",
        'class Hooks {',
        '  add (fn) { this.validate(fn); return validate(fn) }',
        '}',
        'module.exports = Hooks',
        '',
      ].join('\n'),
      'src/finder.ts': [
        'const makeFinder = () => (q: string) => [q]',
        'const findAll = makeFinder()',
        'export const helper = (x: number) => x',
        'export class Repo {',
        "  list () { return this.findAll('x') }",
        '  twice () { return this.helper(2) }',
        "  plain () { return findAll('y') }",
        '}',
        '',
      ].join('\n'),
    });
    expect(callsFrom(g, 'lib/hooks.js')).toEqual(['L3 function validate@lib/validation.js:1']);
    // `findAll('y')` calls the constant's value; `this.findAll()` and `this.helper()` name no binding.
    expect(callsFrom(g, 'src/finder.ts')).toEqual(['L2 function makeFinder@src/finder.ts:1', 'L7 constant findAll@src/finder.ts:2']);
  });

  it('still reaches a function assigned to a property, and a class member', async () => {
    const g = await index({
      'lib/app.js': [
        "var set = require('./set')",
        'var app = exports = module.exports = {}',
        'app.set = function set (setting, val) { return this }',
        'app.enable = function enable (setting) { return this.set(setting, true) }',
        'class Settings {',
        '  get (k) { return k }',
        "  load () { return this.get('a') }",
        '}',
        '',
      ].join('\n'),
      'lib/set.js': 'module.exports = function set (o, k, v) { o[k] = v }\n',
      // fastify's shape: a declared function the file hands to a property of its name.
      'lib/instance.js': [
        'function build () {',
        '  const fastify = {}',
        '  fastify.ready = ready',
        '  fastify.inject = inject',
        '  function ready (cb) { return cb }',
        '  function inject (cb) { return this.ready(cb) }',
        '  return fastify',
        '}',
        'module.exports = build',
        '',
      ].join('\n'),
    });
    expect(callsFrom(g, 'lib/app.js')).toEqual(['L4 function set@lib/app.js:3', 'L7 method Settings::get@lib/app.js:6']);
    expect(callsFrom(g, 'lib/instance.js')).toEqual(['L6 function build::ready@lib/instance.js:5']);
  });
});
