/**
 * The classic JavaScript ways to give a constructor its methods (#2966):
 *
 *   function Hooks () {}
 *   Hooks.prototype.validate = function (hook, fn) {…}   // a method
 *   Hooks.create = function () {…}                       // a static method
 *   module.exports = { inspect () {…}, toJSON () {…} }   // the module's object
 *
 * None of them had a node: the calls inside were credited to the file, and a
 * `this.validate()` between them linked by bare name to whatever else in the
 * project is called `validate`, a function in another file or an interface's
 * method in a `.d.ts`. Now a function assigned to `Ctor.prototype.m` or
 * `Ctor.m`, `Ctor` a function or class the same scope declares, is method `m`
 * of `Ctor` (`Ctor::m`, contained by it, static for `Ctor.m`), and the
 * members of `module.exports = {…}` are the module's exported functions
 * (`module.exports::m`). `this.m()` in any of them means the owner's own `m`,
 * and `Ctor.m()` / `require('./x').m()` from another file reach them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel, resetKernelForTests } from '../src/extraction/kernel';

const kernelBuilt = fs.existsSync(path.join(__dirname, '../codegraph-kernel/prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));

/** The issue's files, as written there. */
const ISSUE: Record<string, string> = {
  'lib/hooks.js': [
    "'use strict'",
    'function Hooks () { this.list = [] }',
    'Hooks.prototype.validate = function (hook, fn) { return typeof fn === \'function\' }',
    'Hooks.prototype.add = function (hook, fn) {',
    '  this.validate(hook, fn)                       // line 5',
    '  this.list.push(fn)',
    '}',
    'module.exports = Hooks',
    '',
  ].join('\n'),
  'lib/validation.js': 'function validate (schema, data) { return true }\nmodule.exports = { validate }\n',
  'lib/reply.js': [
    'function Reply () {}',
    'Reply.prototype.getHeader = function (k) { return k }',
    "Reply.prototype.send = function () { return this.getHeader('content-type') }   // line 3",
    'module.exports = Reply',
    '',
  ].join('\n'),
  'lib/types.d.ts': 'export interface FastifyReply { getHeader(key: string): string | undefined; }\n',
  'lib/model.js': [
    'function Model () {}',
    'Model.insertMany = async function insertMany (arr) { return arr }',
    'Model.init = function init () { return Model.insertMany([]) }',
    'module.exports = Model',
    '',
  ].join('\n'),
  'lib/other.js': 'class Cast { init () { return 1 } insertMany () { return 2 } }\n',
  'test/model.test.js': [
    "const Model = require('../lib/model')",
    'async function t () { await Model.init(); await Model.insertMany([1]) }',
    '',
  ].join('\n'),
  'lib/context.js': [
    'module.exports = {',
    '  inspect () { return this.toJSON() },',
    '  toJSON () { return {} }',
    '}',
    '',
  ].join('\n'),
  'lib/application.js': 'class Application { toJSON () { return { app: 1 } } }\nmodule.exports = Application\n',
};

describe.each(['native', 'wasm'].filter((backend) => backend === 'wasm' || kernelBuilt))(
  'constructor and module-object methods (%s, #2966)', (backend) => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_KERNEL', backend === 'wasm' ? '0' : '1');
    vi.stubEnv('CODEGRAPH_KERNEL_LANGS', 'all');
    resetKernelForTests();
    if (backend === 'native') expect(getKernel()).not.toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2966-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetKernelForTests();
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = await CodeGraph.init(dir, { index: true });
    return cg;
  }

  /** The one node with this qualified name (in `file`, when several share it). */
  function node(g: CodeGraph, qualifiedName: string, file?: string) {
    const found = g.getNodesByQualifiedName(qualifiedName).filter((n) => !file || n.filePath === file);
    expect(found, qualifiedName).toHaveLength(1);
    return found[0]!;
  }
  /** `qualifiedName@file` at the other end of a node's `calls` edges. */
  const callees = (g: CodeGraph, qn: string, file?: string) =>
    g.getOutgoingEdges(node(g, qn, file).id)
      .filter((e) => e.kind === 'calls')
      .map((e) => { const t = g.getNode(e.target)!; return `${t.qualifiedName}@${t.filePath}`; })
      .sort();

  it("indexes the issue's methods on their constructors, and links the calls between them there", async () => {
    const g = await index(ISSUE);
    for (const [qn, isStatic] of [
      ['Hooks::validate', false], ['Hooks::add', false], ['Reply::getHeader', false], ['Reply::send', false],
      ['Model::insertMany', true], ['Model::init', true],
    ] as const) {
      const method = node(g, qn);
      expect(method.kind, qn).toBe('method');
      expect(method.isStatic ?? false, qn).toBe(isStatic);
      // Contained by the constructor, as a class contains its methods.
      const owner = g.getIncomingEdges(method.id).filter((e) => e.kind === 'contains').map((e) => g.getNode(e.source)!.qualifiedName);
      expect(owner, qn).toEqual([qn.split('::')[0]]);
    }
    expect(node(g, 'Model::insertMany').isAsync).toBe(true);

    expect(callees(g, 'Hooks::add')).toEqual(['Hooks::validate@lib/hooks.js']);
    expect(callees(g, 'Reply::send')).toEqual(['Reply::getHeader@lib/reply.js']);
    expect(callees(g, 'Model::init')).toEqual(['Model::insertMany@lib/model.js']);
    expect(callees(g, 't')).toEqual(['Model::init@lib/model.js', 'Model::insertMany@lib/model.js']);
    // The module's object owns its members, and `this.toJSON()` is its own.
    for (const qn of ['module.exports::inspect', 'module.exports::toJSON']) {
      expect(node(g, qn).kind, qn).toBe('function');
      expect(node(g, qn).isExported, qn).toBe(true);
    }
    expect(callees(g, 'module.exports::inspect')).toEqual(['module.exports::toJSON@lib/context.js']);
    // Nothing is credited to the files any more.
    for (const file of ['lib/hooks.js', 'lib/reply.js', 'lib/context.js']) {
      const calls = g.getOutgoingEdges(`file:${file}`).filter((e) => e.kind === 'calls');
      expect(calls, file).toEqual([]);
    }
  });

  it('takes every function shape, and a constructor in a wrapper or factory scope', async () => {
    const g = await index({
      'lib/queue.js': [
        '(function (root) {',
        '  function Queue () { this.items = []; this.reset() }',
        '  Queue.prototype.reset = function () { this.items = [] }',
        '  Queue.prototype.push = async function (x) { this.items.push(x); return this.size() }',
        '  Queue.prototype.size = () => 0',
        '  Queue.prototype.drain = function* () { yield 1 }',
        '  Queue.from = function build (list) { return new Queue() }',
        '  root.Queue = Queue',
        '})(this)',
        '',
      ].join('\n'),
      'lib/factory.js': [
        'function makeStack () {',
        '  function Stack () {}',
        '  Stack.prototype.peek = function () { return this.top() }',
        '  Stack.prototype.top = function () { return 1 }',
        '  return Stack',
        '}',
        'class Widget {}',
        'Widget.prototype.render = function () { return 1 }',
        'Widget.create = function () { return new Widget() }',
        'module.exports = { makeStack, Widget }',
        '',
      ].join('\n'),
    });
    for (const qn of ['Queue::reset', 'Queue::push', 'Queue::size', 'Queue::drain', 'Queue::from',
      'makeStack::Stack::peek', 'makeStack::Stack::top', 'Widget::render', 'Widget::create']) {
      expect(node(g, qn).kind, qn).toBe('method');
    }
    // The static is named by the property callers use, not the expression's own name.
    expect(g.getNodesByName('build')).toEqual([]);
    expect(callees(g, 'Queue::push')).toEqual(['Queue::size@lib/queue.js']);
    // The constructor's own `this.reset()` is its method.
    expect(callees(g, 'Queue')).toEqual(['Queue::reset@lib/queue.js']);
    expect(callees(g, 'makeStack::Stack::peek')).toEqual(['makeStack::Stack::top@lib/factory.js']);
  });

  it('leaves other assignment targets as they were', async () => {
    const g = await index({
      'lib/app.js': [
        "const EventEmitter = require('events')",
        'var app = exports = module.exports = {}',
        'app.use = function use (fn) { return fn }',
        'exports.handle = function (req) { return req }',
        'EventEmitter.prototype.patched = function () { return 1 }',
        'Later.prototype.early = function () { return 1 }',
        'function Later () {}',
        "Later.prototype['computed'] = function () { return 1 }",
        'Later.prototype = { literal () { return 1 } }',
        '',
      ].join('\n'),
    });
    // An object's member, a CommonJS export and an imported constructor keep
    // the shape they had: a function named by its expression or export.
    expect(node(g, 'use').kind).toBe('function');
    expect(node(g, 'handle').kind).toBe('function');
    for (const name of ['patched', 'early', 'computed', 'literal']) expect(g.getNodesByName(name), name).toEqual([]);
    expect(g.getNodesByName('Later').map((n) => n.kind)).toEqual(['function']);
  });

  it('reaches a constructor\'s statics and the module object\'s members from another file', async () => {
    const g = await index({
      'lib/hooks.js': [
        'function Hooks () {}',
        'Hooks.create = function () { return new Hooks() }',
        'Hooks.prototype.add = function () { return 1 }',
        'module.exports = Hooks',
        '',
      ].join('\n'),
      'lib/context.js': 'const proto = module.exports = {\n  inspect () { return 1 },\n  toJSON () { return {} }\n}\n',
      'lib/app.js': [
        "const Hooks = require('./hooks')",
        "const context = require('./context')",
        "const { inspect } = require('./context')",
        'function run () {',
        '  Hooks.create()',
        '  context.toJSON()',
        '  return inspect()',
        '}',
        'module.exports = { run }',
        '',
      ].join('\n'),
    });
    expect(callees(g, 'run')).toEqual([
      'Hooks::create@lib/hooks.js', 'module.exports::inspect@lib/context.js', 'module.exports::toJSON@lib/context.js',
    ]);
  });

  it('keeps this.m() on the constructor\'s own m where the file also imports an m', async () => {
    const g = await index({
      'lib/validation.js': 'function validate (s) { return !!s }\nmodule.exports = { validate }\n',
      'lib/schemas.js': [
        "const { validate } = require('./validation')",
        'function Schemas () {}',
        'Schemas.prototype.validate = function (s) { return validate(s) }',
        'Schemas.prototype.add = function (s) { return this.validate(s) }',
        'module.exports = Schemas',
        '',
      ].join('\n'),
    });
    expect(callees(g, 'Schemas::add')).toEqual(['Schemas::validate@lib/schemas.js']);
    // A bare call is still the import's.
    expect(callees(g, 'Schemas::validate')).toEqual(['validate@lib/validation.js']);
  });
});
