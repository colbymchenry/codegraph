'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {watchProbe} = require('./watch-probe.cjs');

function harness(overrides = {}) {
  const watcher = new EventEmitter();
  let callback, closed = 0, next = 0;
  const intervals = new Map(), deadlines = new Map(), writes = [];
  watcher.close = () => closed++;
  const options = {
    watch(_root, _options, cb) { callback = cb; return watcher; },
    writeFileSync(file, content) { writes.push([file, content]); },
    timers: {
      setTimeout(fn) { const id=++next; deadlines.set(id, fn); return id; },
      clearTimeout(id) { deadlines.delete(id); },
      setInterval(fn) { const id=++next; intervals.set(id, fn); return id; },
      clearInterval(id) { intervals.delete(id); },
    }, ...overrides,
  };
  const promise = watchProbe('/fixture', options);
  return {promise, watcher, writes, deadlines, intervals, get closed() { return closed; },
    event(name) { callback('change', name); }, tick() { for(const fn of [...intervals.values()]) fn(); },
    timeout() { for(const fn of [...deadlines.values()]) fn(); }};
}

test('does not race a synchronous write with registration; repeated writes are distinct', async () => {
  const h = harness();
  assert.equal(h.writes.length, 0);
  h.tick(); h.tick();
  assert.equal(h.writes.length, 2);
  assert.notEqual(h.writes[0][1], h.writes[1][1]);
  h.event('runtime-watch-probe.txt'); await h.promise;
  assert.equal(h.closed, 1); assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  h.tick(); assert.equal(h.writes.length, 2);
});
test('unrelated and unnamed events cannot satisfy the probe', async () => {
  const h = harness(); h.event('another-file.txt'); h.event(null);
  assert.equal(h.closed, 0);
  h.event('nested/runtime-watch-probe.txt'); await h.promise;
  assert.equal(h.closed, 1);
});
test('missing event fails at the deadline and releases all resources', async () => {
  const h = harness(); const failure = assert.rejects(h.promise, /event missing/);
  h.tick(); h.timeout(); await failure;
  assert.equal(h.closed, 1); assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
});
test('watcher error fails without waiting for the deadline', async () => {
  const h = harness(); const failure = assert.rejects(h.promise, /watch failed/);
  h.watcher.emit('error', new Error('watch failed')); await failure;
  assert.equal(h.closed, 1); assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
});
test('write failure rejects and clears timers', async () => {
  const h = harness({writeFileSync() { throw new Error('write failed'); }});
  const failure = assert.rejects(h.promise, /write failed/);
  h.tick(); await failure; assert.equal(h.closed, 1); assert.equal(h.intervals.size, 0);
});
test('registration failure propagates', async () => {
  const h = harness({watch() { throw new Error('registration failed'); }});
  await assert.rejects(h.promise, /registration failed/);
  assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
});
test('duplicate delivery closes only once', async () => {
  const h = harness(); h.event('runtime-watch-probe.txt'); h.event('runtime-watch-probe.txt');
  await h.promise; assert.equal(h.closed, 1);
});
test('real native directory event is observed in a Unicode/spaces path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Pinable 监听 probe-'));
  try { await watchProbe(root); }
  finally { fs.rmSync(root, {recursive:true, force:true}); }
});
