import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

const RUST = `
pub struct Engine;
impl Engine {
 pub fn run(&mut self, request: &str) {}
 pub fn read(&mut self, request: &str) {}
 pub fn cleanup(&mut self, request: &str) {}
 pub fn handler(op: &str) -> Option<fn(&mut Engine, &str)> {
  Some(match op {
   "task.run" => Engine::run,
   "task.read" => Engine::read,
   "task.cleanup" => Engine::cleanup,
   _ => return None,
  })
 }
 pub fn dispatch(&mut self, op: &str, request: &str) {
  if let Some(handler) = Engine::handler(op) { handler(self, request); }
 }
}
#[unsafe(no_mangle)]
pub extern "C" fn wire_send(op: &str, request: &str) {
 let mut engine = Engine;
 engine.dispatch(op, request);
}
`;
const LUA = `
local ffi = require("ffi")
local library = ffi.load("example")
local Bridge = {}
local function native(op, request)
 return library.wire_send(op, request)
end
function Bridge.call(op, request)
 native("task.cleanup", "{}")
 return native(op, request)
end
return Bridge
`;
const CALLERS = `
local Bridge = require("bridge")
function run_task() return Bridge.call("task.run", "{}") end
function read_task() return Bridge.call("task.read", "{}") end
function unknown_task() return Bridge.call("task.missing", "{}") end
function dynamic_task(op) return Bridge.call(op, "{}") end
`;

describe('source-derived LuaJIT → Rust operation bridge', { timeout: 60000 }, () => {
 let dir: string;
 let cg: CodeGraph | undefined;
 beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-rust-')); });
 afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(dir, { recursive: true, force: true }); });
 function write(file: string, source: string) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), source); }
 async function index(files: Record<string, string>) {
  for (const [file, source] of Object.entries(files)) write(file, source);
  cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
 }
 const node = (name: string, language?: string) => cg!.getNodesByName(name).find(n => ['function','method'].includes(n.kind) && (!language || n.language === language))!;
 const callees = (name: string) => cg!.getCallees(node(name).id, 12).map(e => e.node.name);
 const callers = (name: string) => cg!.getCallers(node(name, 'rust').id, 12).map(e => e.node.name);
 it('bridges verified plain FFI calls without relaxing cross-language name matching', async () => {
  await index({ 'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}\npub fn ordinary() {}',
   'caller.lua': 'local ffi = require("ffi")\nlocal lib = ffi.load("example")\nfunction ping() lib.native_ping() end\nfunction nope() lib.ordinary() end\nfunction bare() native_ping() end' });
  expect(callees('ping')).toContain('native_ping');
  expect(callees('nope')).not.toContain('ordinary');
  expect(callees('bare')).not.toContain('native_ping');
 });
 it('preserves operation-specific callers, flow and impact through shared wrappers', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': CALLERS });
  expect(callees('run_task')).toContain('run');
  expect(callees('run_task')).not.toContain('read');
  expect(callees('read_task')).toContain('read');
  expect(callees('read_task')).not.toContain('run');
  expect(callees('run_task')).toContain('cleanup');
  for (const caller of ['unknown_task','dynamic_task']) {
   expect(callees(caller)).not.toContain('run');
   expect(callees(caller)).not.toContain('read');
   expect(callees(caller)).toContain('cleanup');
  }
  expect(callers('run')).toContain('run_task');
  expect(callers('run')).not.toContain('read_task');
  const impact = cg!.getImpactRadius(node('run', 'rust').id, 12);
  expect([...impact.nodes.values()].map(n => n.name)).toContain('run_task');
  expect([...impact.nodes.values()].map(n => n.name)).not.toContain('read_task');
 });
 it('removes obsolete operation routes after a Rust-only incremental edit', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': CALLERS });
  expect(callees('run_task')).toContain('run');
  write('native.rs', RUST.replace('"task.run" => Engine::run,', '"task.run" => Engine::read,'));
  await cg!.sync({ paths: ['native.rs'] });
  expect(callees('run_task')).toContain('read');
  expect(callees('run_task')).not.toContain('run');
 });
 it('follows aliases and constant operations without merging same-line calls', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': `
local Bridge = require("bridge")
local send = Bridge.call
local RUN = "task.run"
function alias_task() return send(RUN, "{}") end
function both_tasks() Bridge.call("task.run", "{}"); Bridge.call("task.read", "{}") end
` });
  expect(callees('alias_task')).toContain('run');
  expect(callees('alias_task')).not.toContain('read');
  expect(callees('both_tasks')).toEqual(expect.arrayContaining(['run', 'read', 'cleanup']));
 });
 it('rejects ambiguous native exports instead of picking the first library', async () => {
  await index({ 'a.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}',
   'b.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}',
   'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("example")\nfunction ping() lib.native_ping() end' });
  expect(callees('ping')).not.toContain('native_ping');
 });
 it('uses the exported ABI name and rejects mere extern C signatures', async () => {
  await index({ 'native.rs': '#[unsafe(export_name = "native_ping")]\npub extern "C" fn internal_ping() {}\npub extern "C" fn mangled() {}',
   'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.C\nfunction ping() lib.native_ping() end\nfunction nope() lib.mangled() end' });
  expect(callees('ping')).toContain('internal_ping');
  expect(callees('nope')).not.toContain('mangled');
 });
 it('removes stale boundary links after FFI receiver rebinding', async () => {
  const src = 'local ffi=require("ffi")\nlocal lib=ffi.load("example")\nfunction ping() lib.native_ping() end';
  await index({ 'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}', 'caller.lua': src });
  expect(callees('ping')).toContain('native_ping');
  write('caller.lua', src.replace('function ping()', 'lib={}\nfunction ping()'));
  await cg!.sync({ paths: ['caller.lua'] });
  expect(callees('ping')).not.toContain('native_ping');
 });
 it('does not route unknown runtime values or uninvoked handler lookups', async () => {
  await index({ 'native.rs': RUST.replace('handler(self, request);', 'let _ignored = handler;'), 'bridge.lua': LUA, 'caller.lua': CALLERS });
  for (const caller of ['run_task', 'read_task', 'unknown_task', 'dynamic_task']) {
   expect(callees(caller)).not.toContain('run');
   expect(callees(caller)).not.toContain('read');
  }
 });
 it('removes deleted handler targets and agrees with a full rebuild', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': CALLERS });
  expect(callees('run_task')).toContain('run');
  write('native.rs', RUST.replace(' pub fn run(&mut self, request: &str) {}', ''));
  await cg!.sync({ paths: ['native.rs'] });
  const synced = callees('run_task').sort();
  expect(synced).not.toContain('run');
  await cg!.indexAll({ force: true });
  expect(callees('run_task').sort()).toEqual(synced);
 });

 it('does not promote unrelated or shadowed Lua wrapper receivers into native calls', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': `
local Bridge = require("bridge")
function unrelated(other) return other.call("task.run", "{}") end
function shadowed(Bridge) return Bridge.call("task.run", "{}") end
function lookalike() return Missing.call("task.run", "{}") end
` });
  for (const caller of ['unrelated', 'shadowed', 'lookalike']) expect(callees(caller)).not.toContain('run');
 });

 it('derives renamed protocols and reordered wrapper parameters without configuration', async () => {
  const rust = RUST.replaceAll('Engine', 'Machine').replaceAll('wire_send', 'submit_packet')
   .replaceAll('task.run', 'alpha').replaceAll('task.read', 'beta').replaceAll('task.cleanup', 'gamma');
  const lua = LUA.replaceAll('wire_send', 'submit_packet').replaceAll('task.cleanup', 'gamma')
   .replace('function Bridge.call(op, request)', 'function Bridge.call(request, op)');
  await index({ 'service.rs': rust, 'bridge.lua': lua, 'caller.lua': `
local Service = require("bridge")
function renamed_task() return Service.call("{}", "alpha") end
` });
  expect(callees('renamed_task')).toEqual(expect.arrayContaining(['run', 'cleanup']));
  expect(callees('renamed_task')).not.toContain('read');
 });
 it('aligns colon methods with their implicit self parameter', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA.replace('function Bridge.call', 'function Bridge:call'),
   'caller.lua': 'local Bridge=require("bridge")\nfunction method_task() return Bridge:call("task.run", "{}") end' });
  expect(callees('method_task')).toContain('run');
  expect(callees('method_task')).not.toContain('read');
 });
 it('does not turn unsupported multi-statement dispatch arms into all-handler reachability', async () => {
  const rust = `fn run() {} fn read() {} fn log() {}
#[no_mangle] pub extern "C" fn wire_send(op: &str, request: &str) {
 match op { "task.run" => { log(); run(); }, "task.read" => { log(); read(); }, _ => () }
}`;
  await index({ 'native.rs': rust, 'bridge.lua': LUA, 'caller.lua': CALLERS });
  for (const caller of ['run_task', 'read_task', 'unknown_task', 'dynamic_task']) {
   expect(callees(caller)).not.toContain('run');
   expect(callees(caller)).not.toContain('read');
  }
 });

 it('requires the module to actually export the bridge member', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA.replace('return Bridge', 'return {}'), 'caller.lua': CALLERS });
  expect(callees('run_task')).not.toContain('run');
 });
 it('refuses ambiguous required module files', async () => {
  await index({ 'native.rs': RUST, 'one/bridge.lua': LUA, 'two/bridge.lua': LUA, 'caller.lua': CALLERS });
  expect(callees('run_task')).not.toContain('run');
 });

 it('retains separate operation channels forwarded from the same Lua parameter', async () => {
  await index({ 'native.rs': `fn run() {} fn read() {}
#[no_mangle] pub extern "C" fn wire_send(first: &str, second: &str) {
 match first { "alpha" => run(), _ => () }
 match second { "beta" => read(), _ => () }
}`, 'bridge.lua': `local ffi=require("ffi")
local lib=ffi.load("native")
local Bridge={}
function Bridge.call(op) lib.wire_send(op, op) end
return Bridge`, 'caller.lua': `local Bridge=require("bridge")
function beta_task() Bridge.call("beta") end` });
  expect(callees('beta_task')).toContain('read');
  expect(callees('beta_task')).not.toContain('run');
 });

 it('links FFI calls made at the module top level', async () => {
  await index({ 'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}',
   'caller.lua': 'local ffi=require("ffi")\nlocal lib=ffi.load("native")\nlib.native_ping()' });
  const file = cg!.getNodesByName('caller.lua').find(n => n.kind === 'file')!;
  expect(cg!.getCallees(file.id).map(edge => edge.node.name)).toContain('native_ping');
 });

 it('distinguishes same-line Lua methods and Rust methods by source position', async () => {
  await index({ 'native.rs': `pub struct One; pub struct Two;
impl One { pub fn run() {} } impl Two { pub fn run() {} }
#[no_mangle] pub extern "C" fn wire_send(op: &str) {
 match op { "one" => One::run(), "two" => Two::run(), _ => () }
}`, 'caller.lua': `local ffi=require("ffi"); local lib=ffi.load("native")
local One={}; local Two={}; function One.call() lib.wire_send("one") end; function Two.call() lib.wire_send("two") end` });
  const calls = cg!.getNodesByName('call').filter(n => n.language === 'lua');
  expect(calls).toHaveLength(2);
  for (const call of calls) {
   const targets = cg!.getCallees(call.id).filter(edge => edge.node.language === 'rust');
   // The export appears as transport; the operation edge names the handler.
   expect(targets.filter(edge => edge.edge.metadata?.transportOnly).map(edge => edge.node.name)).toEqual(['wire_send']);
   const handlers = targets.filter(edge => !edge.edge.metadata?.transportOnly);
   expect(handlers).toHaveLength(1);
   expect(handlers[0]!.node.qualifiedName).toContain(call.qualifiedName.includes('One') ? 'One' : 'Two');
  }
 });

 it('bridges a literal operation through a proven local module getter', async () => {
  await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': `
local function core(ignored) return require("bridge") end
function run_task() return core("unused").call("task.run", "{}") end
function read_task() return core().call("task.read", "{}") end
` });
  expect(callees('run_task')).toContain('run');
  expect(callees('run_task')).not.toContain('read');
  expect(callees('read_task')).toContain('read');
  expect(callees('read_task')).not.toContain('run');
  expect(callers('run')).toContain('run_task');
  expect(callers('run')).not.toContain('read_task');
  expect(callees('run_task')).toContain('cleanup');
  expect(callees('read_task')).toContain('cleanup');
 });

 it('links a Lua file whose first FFI call arrives in an incremental edit', async () => {
  await index({ 'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}', 'caller.lua': 'function ping() return 1 end' });
  expect(callees('ping')).not.toContain('native_ping');
  write('caller.lua', 'local ffi = require("ffi")\nlocal lib = ffi.load("native")\nfunction ping() lib.native_ping() end');
  await cg!.sync({ paths: ['caller.lua'] });
  expect(callees('ping')).toContain('native_ping');
 });

 it('follows cdef asm labels to the linked symbol and refuses conflicting declarations', async () => {
  const exports = ['ping', 'native_real', 'left_real', 'right_real']
   .map(name => `#[no_mangle]\npub extern "C" fn ${name}() {}`).join('\n');
  await index({ 'native.rs': exports,
   'caller.lua': 'local ffi = require("ffi")\nffi.cdef[[ void ping(void) asm("native_real"); ]]\nfunction renamed() ffi.C.ping() end',
   // One LuaJIT state shares cdef declarations, so two labels for one name link neither.
   'left.lua': 'local ffi = require("ffi")\nffi.cdef[[ void twin(void) asm("left_real"); ]]\nfunction left() ffi.C.twin() end',
   'right.lua': 'local ffi = require("ffi")\nffi.cdef[[ void twin(void) asm("right_real"); ]]\nfunction right() ffi.C.twin() end' });
  expect(callees('renamed')).toContain('native_real');
  expect(callees('renamed')).not.toContain('ping');
  for (const caller of ['left', 'right']) {
   expect(callees(caller)).not.toContain('left_real');
   expect(callees(caller)).not.toContain('right_real');
  }
 });

 it('keeps every operation that reaches one handler on its single edge', async () => {
  await index({ 'native.rs': RUST.replace('"task.read" => Engine::read,', '"task.read" => Engine::read,\n   "task.again" => Engine::run,'),
   'bridge.lua': LUA, 'caller.lua': `
local Bridge = require("bridge")
function twice() Bridge.call("task.run", "{}"); Bridge.call("task.again", "{}") end
` });
  const twice = node('twice');
  const edges = cg!.getIncomingEdges(node('run', 'rust').id)
   .filter(edge => edge.source === twice.id && edge.metadata?.synthesizedBy === 'lua-rust-operation');
  expect(edges).toHaveLength(1);
  expect(edges[0]!.metadata).toMatchObject({ operation: 'task.again', operations: ['task.again', 'task.run'] });
 });
});
