import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * The EventEmitter pass (`x.on('e', handler)` ↔ `y.emit('e')`) pairs an emit
 * with the handlers registered on the same object, not with every handler of
 * that event name (#2973):
 *  - the handler is the function the registration names in its own scope,
 *    never a namesake in another file;
 *  - two module-level emitters are two channels; an emitter a module exports
 *    is one channel with everything that imports it;
 *  - `this` in a class method, a `new C()` binding and a typed parameter are
 *    instances of C, and a method of a base class emits on its subclasses' too;
 *  - a receiver the code ties to nothing pairs only within its own file;
 *  - every edge carries the line of its `emit` and its own registration site.
 */

type Files = Record<string, string>;

interface EmitterEdge {
  from: string;
  fromFile: string;
  to: string;
  toFile: string;
  line: number | null;
  event: string;
  registeredAt: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function emitterEdges(files: Files): Promise<EmitterEdge[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-emitter-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  const cg = await CodeGraph.init(root, { silent: true });
  try {
    await cg.indexAll();
    const db = (cg as any).db.db;
    return db
      .prepare(
        `SELECT s.name AS "from", s.file_path AS fromFile, t.name AS "to", t.file_path AS toFile, e.line AS line,
                json_extract(e.metadata, '$.event') AS event, json_extract(e.metadata, '$.registeredAt') AS registeredAt
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.provenance = 'heuristic' AND json_extract(e.metadata, '$.synthesizedBy') = 'event-emitter'
         ORDER BY s.file_path, s.name, t.file_path, t.name`
      )
      .all() as EmitterEdge[];
  } finally {
    cg.close();
  }
}

const hop = (e: EmitterEdge): string => `${e.from}@${e.fromFile} -> ${e.to}@${e.toFile}`;

describe('EventEmitter synthesis pairs an emit with its own object (#2973)', () => {
  it('links each module emitter to its own same-named handler, at the emit line and its own registration', async () => {
    const edges = await emitterEdges({
      'src/a_cart.js': [
        "const EventEmitter = require('events')",
        'const cart = new EventEmitter()',
        "function handleSave () { return 'cart' }",
        "cart.on('save', handleSave)",
        "function saveCart () { cart.emit('save') }",
      ].join('\n'),
      'src/b_profile.js': [
        "const EventEmitter = require('events')",
        'const profile = new EventEmitter()',
        "function handleSave () { return 'profile' }",
        "profile.on('save', handleSave)",
        "function saveProfile () { profile.emit('save') }",
      ].join('\n'),
    });
    expect(edges.map(hop)).toEqual([
      'saveCart@src/a_cart.js -> handleSave@src/a_cart.js',
      'saveProfile@src/b_profile.js -> handleSave@src/b_profile.js',
    ]);
    expect(edges.map((e) => [e.line, e.event, e.registeredAt])).toEqual([
      [5, 'save', 'src/a_cart.js:4'],
      [5, 'save', 'src/b_profile.js:4'],
    ]);
  });

  it('keeps two emitters that share an event name apart when their handlers differ', async () => {
    const edges = await emitterEdges({
      'src/a_cart.js': [
        "const EventEmitter = require('events')",
        'const cart = new EventEmitter()',
        "function onCartSaved () { return 'cart' }",
        "cart.on('save', onCartSaved)",
        "function saveCart () { cart.emit('save') }",
      ].join('\n'),
      'src/b_profile.js': [
        "const EventEmitter = require('events')",
        'const profile = new EventEmitter()',
        "function onProfileSaved () { return 'profile' }",
        "profile.on('save', onProfileSaved)",
        "function saveProfile () { profile.emit('save') }",
      ].join('\n'),
    });
    expect(edges.map(hop)).toEqual([
      'saveCart@src/a_cart.js -> onCartSaved@src/a_cart.js',
      'saveProfile@src/b_profile.js -> onProfileSaved@src/b_profile.js',
    ]);
  });

  it('pairs across files through an emitter a module exports and others import', async () => {
    const edges = await emitterEdges({
      'src/bus.js': "const { EventEmitter } = require('events');\nconst bus = new EventEmitter();\nmodule.exports = { bus };\n",
      'src/handlers.js': "const { bus } = require('./bus');\nfunction onSaved(doc) { return doc; }\nbus.on('saved', onSaved);\n",
      'src/service.js': "const { bus } = require('./bus');\nfunction save(doc) { bus.emit('saved', doc); return doc; }\n",
      'src/events.ts': "import { EventEmitter } from 'events';\nconst events = new EventEmitter();\nexport default events;\n",
      'src/audit.ts': "import events from './events';\nexport function record(x: unknown) { return x; }\nevents.on('changed', record);\n",
      'src/store.ts': "import events from './events';\nexport function update(x: unknown) { events.emit('changed', x); }\n",
      // Its own emitter, same event names: no edge into or out of it.
      'src/local.js': "const { EventEmitter } = require('events');\nconst own = new EventEmitter();\nfunction onLocal() {}\nown.on('saved', onLocal);\nown.on('changed', onLocal);\n",
    });
    expect(edges.map(hop)).toEqual([
      'save@src/service.js -> onSaved@src/handlers.js',
      'update@src/store.ts -> record@src/audit.ts',
    ]);
    expect(edges.map((e) => e.registeredAt)).toEqual(['src/handlers.js:3', 'src/audit.ts:3']);
  });

  it("links a class's emit to listeners on its instances and its subclasses, not to another class's", async () => {
    const edges = await emitterEdges({
      'lib/receiver.js': [
        "const EventEmitter = require('events');",
        'class Receiver extends EventEmitter {',
        "  dataMessage(data) { this.emit('message', data); }",
        '}',
        'module.exports = Receiver;',
      ].join('\n'),
      'lib/sender.js': [
        "const EventEmitter = require('events');",
        'class Sender extends EventEmitter {',
        "  flush() { this.emit('message', 'sent'); }",
        '}',
        'module.exports = Sender;',
      ].join('\n'),
      'lib/socket.js': [
        "const Receiver = require('./receiver');",
        'function onMessage(data) { return data; }',
        'function setSocket() {',
        '  const receiver = new Receiver();',
        "  receiver.on('message', onMessage);",
        '}',
        'module.exports = { setSocket };',
      ].join('\n'),
      'lib/ticker.ts': [
        "import { EventEmitter } from 'events';",
        'export class Ticker extends EventEmitter {',
        "  fire() { this.emit('tick'); }",
        '}',
        'export class Clock extends Ticker {',
        "  constructor() { super(); this.on('tick', this.onTick); }",
        '  onTick() { return 1; }',
        '}',
      ].join('\n'),
      'lib/watch.ts': [
        "import { Ticker } from './ticker';",
        'export function onTock() { return 2; }',
        "export function watch(ticker: Ticker) { ticker.on('tock', onTock); }",
        "export class Pendulum extends Ticker { swing() { this.emit('tock'); } }",
      ].join('\n'),
    });
    expect(edges.map(hop)).toEqual([
      'dataMessage@lib/receiver.js -> onMessage@lib/socket.js',
      'fire@lib/ticker.ts -> onTick@lib/ticker.ts',
      'swing@lib/watch.ts -> onTock@lib/watch.ts',
    ]);
  });

  it('reads a field by its declared type, a parameter by its JSDoc, and a class through the index that hands it on', async () => {
    const edges = await emitterEdges({
      'src/transport.ts': [
        "import { EventEmitter } from 'events';",
        'export class Transport extends EventEmitter {',
        "  onPacket(packet: unknown) { this.emit('packet', packet); }",
        '}',
        "export class Polling extends Transport { write() { this.emit('drain'); } }",
      ].join('\n'),
      'src/socket.ts': [
        "import { Transport } from './transport';",
        'export class Socket {',
        '  public transport: Transport;',
        '  constructor(transport: Transport) {',
        '    this.transport = transport;',
        "    this.transport.on('drain', this.onDrain);",
        '    const onPacket = this.onPacket.bind(this);',
        "    this.transport.on('packet', onPacket);",
        '  }',
        '  onDrain() { return 1; }',
        '  onPacket(packet: unknown) { return packet; }',
        '}',
      ].join('\n'),
      // Another class that emits the same events on itself: never the transport.
      'src/stream.js': [
        "const EventEmitter = require('events');",
        'class Stream extends EventEmitter { flush() { this.emit(\'drain\'); } }',
        '/**',
        ' * @param {Stream} stream The stream.',
        ' */',
        'function pipe(stream) {',
        "  stream.on('packet', onStreamPacket);",
        '}',
        'function onStreamPacket() {}',
        'module.exports = { Stream, pipe };',
      ].join('\n'),
      'index.js': "module.exports = { Stream: require('./src/stream').Stream };\n",
      'test/stream.test.js': [
        "const { Stream } = require('..');",
        'function onTestDrain() {}',
        'function run() {',
        '  const stream = new Stream();',
        "  stream.on('drain', onTestDrain);",
        '}',
        'module.exports = { run };',
      ].join('\n'),
    });
    expect(edges.map(hop).sort()).toEqual([
      'flush@src/stream.js -> onTestDrain@test/stream.test.js',
      'onPacket@src/transport.ts -> onPacket@src/socket.ts',
      'write@src/transport.ts -> onDrain@src/socket.ts',
    ]);
  });

  it('keeps receivers the code ties to nothing inside their own file', async () => {
    const edges = await emitterEdges({
      // express's shape: the app passed in emits, `this` listens.
      'lib/application.js': [
        'var app = exports = module.exports = {};',
        'app.init = function init() {',
        "  this.on('mount', function onmount(parent) { return parent; });",
        '};',
        'app.use = function use(fn) {',
        "  fn.emit('mount', this);",
        '};',
      ].join('\n'),
      'lib/other.js': [
        'function onOtherMount(parent) { return parent; }',
        "function boot(x) { x.on('mount', onOtherMount); }",
        'module.exports = { boot };',
      ].join('\n'),
    });
    expect(edges.map(hop)).toEqual(['use@lib/application.js -> onmount@lib/application.js']);
    expect(edges[0]!.line).toBe(6);
  });

  it('never takes a handler from another file the registering file does not import', async () => {
    const edges = await emitterEdges({
      'lib/extension.js': 'function push(list, item) { list.push(item); }\nmodule.exports = { push };\n',
      'lib/receiver.js': [
        "const EventEmitter = require('events');",
        'class Receiver extends EventEmitter {',
        "  dataMessage(data) { this.emit('message', data); }",
        '}',
        'module.exports = Receiver;',
      ].join('\n'),
      'test/receiver.test.js': [
        "const Receiver = require('../lib/receiver');",
        'function run(results) {',
        '  const receiver = new Receiver();',
        '  const push = results.push.bind(results);',
        "  receiver.on('message', push);",
        '}',
        'module.exports = { run };',
      ].join('\n'),
    });
    expect(edges).toEqual([]);
  });
});
