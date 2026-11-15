import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { getCodeGraphDir } from '../src/directory';
import { opensLuaRustBridge } from '../src/resolution/callback-synthesizer';
import { requireNamePattern } from '../src/resolution/lua-rust-synthesizer';

const NATIVE = `fn step() {}
fn reset() {}
#[no_mangle]
pub extern "C" fn dispatch(op: &str, request: &str) {
  match op { "step" => step(), "reset" => reset(), _ => () }
}
`;
const BRIDGE = `local ffi = require("ffi")
local lib = ffi.load("core")
local M = {}
function M.call(op) return lib.dispatch(op, "{}") end
return M
`;
const EVENTS = `const { EventEmitter } = require('events');
const bus = new EventEmitter();
function onSaved(doc) { return doc; }
bus.on('saved', onSaved);
function save(doc) { bus.emit('saved', doc); }
module.exports = { save };
`;

describe('the LuaJIT → Rust bridge pass', { timeout: 60000 }, () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-rust-pass-')); });
  afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return cg;
  }
  /** Every synthesized edge, as `pass: file:source -> file:target @line:column`. */
  function synthesized(graph: CodeGraph): string[] {
    const nodes = graph.getNodesInFiles(graph.getFiles().map(f => f.path));
    const name = new Map(nodes.map(n => [n.id, `${n.filePath}:${n.name}`]));
    return graph.getOutgoingEdgesFrom(nodes.map(n => n.id))
      .filter(e => e.metadata?.synthesizedBy)
      .map(e => `${String(e.metadata!.synthesizedBy)}: ${name.get(e.source)} -> ${name.get(e.target)} @${e.line}:${e.column}`)
      .sort();
  }

  it('costs no other pass its edges when a file is past what it can analyze', async () => {
    const edges = synthesized(await index({
      'native.rs': NATIVE,
      'deep.rs': `pub fn total(x: u64) -> u64 { ${Array.from({ length: 1200 }, () => 'x').join(' + ')} }\n`,
      'bridge.lua': BRIDGE,
      'deep.lua': 'local ffi = require("ffi")\nlocal s = ' + Array.from({ length: 3000 }, (_, i) => `"${i}"`).join(' .. ') + '\n',
      'caller.lua': 'local bridge = require("bridge")\nfunction tick() bridge.call("step") end\n',
      'bus.js': EVENTS,
    }));
    expect(edges.some(e => e.startsWith('event-emitter: bus.js:save -> bus.js:onSaved'))).toBe(true);
    expect(edges.some(e => e.startsWith('lua-rust-operation: caller.lua:tick -> native.rs:step'))).toBe(true);
  });

  it.each([
    ['no Lua file names ffi', { 'native.rs': NATIVE, 'config.lua': 'return { level = "debug" }\n' }],
    ['no Rust file declares an export', { 'native.rs': 'pub fn step() {}\n', 'bridge.lua': BRIDGE }],
  ])('reads no file when %s', async (_name, files) => {
    expect(synthesized(await index(files)).filter(e => e.startsWith('lua-'))).toEqual([]);
    expect(fs.existsSync(path.join(getCodeGraphDir(dir), 'bridge-analyses'))).toBe(false);
  });

  it('stores each file analysis in the index, and a sync replaces only the edited file\'s', async () => {
    const graph = await index({
      'native.rs': NATIVE,
      'cdefs.lua': 'local ffi = require("ffi")\nreturn { lib = ffi.load("core") }\n',
      'caller.lua': 'local cdefs = require("cdefs")\nfunction run() cdefs.lib.dispatch("step", "{}") end\n',
    });
    const store = path.join(getCodeGraphDir(dir), 'bridge-analyses');
    const entries = (): string[] => fs.readdirSync(store).flatMap(version => fs.readdirSync(path.join(store, version))).sort();
    const before = entries();
    expect(before).toHaveLength(3);
    fs.writeFileSync(path.join(dir, 'caller.lua'), 'local cdefs = require("cdefs")\nfunction walk() cdefs.lib.dispatch("reset", "{}") end\n');
    await graph.sync();
    expect(synthesized(graph).some(e => e.startsWith('lua-rust-ffi: caller.lua:walk -> native.rs:dispatch'))).toBe(true);
    const after = entries();
    expect(after).toHaveLength(3);
    expect(after.filter(entry => before.includes(entry))).toHaveLength(2);
  });

  it('records no input of a project with no FFI, and opens when a sync brings the first', async () => {
    const graph = await index({ 'native.rs': NATIVE, 'config.lua': 'return { level = "debug" }\n' });
    // Another pass may read the Rust file; the Lua file is no pass's input until the bridge opens.
    const inputs = (): boolean[] => ['native.rs', 'config.lua'].map(file => graph['queries'].wasSynthesisInput(file));
    expect(inputs()[1]).toBe(false);
    fs.writeFileSync(path.join(dir, 'config.lua'), BRIDGE.replace('return M', 'function tick() M.call("step") end\nreturn M'));
    await graph.sync();
    expect(synthesized(graph).some(e => e.startsWith('lua-rust-operation: config.lua:tick -> native.rs:step'))).toBe(true);
    expect(inputs()).toEqual([true, true]);
  });

  it('credits a function assigned under a bracketed key to its own node', async () => {
    const edges = synthesized(await index({ 'native.rs': NATIVE, 'api.lua': `local ffi = require("ffi")
local lib = ffi.load("core")
local M = {}
M["send"] = function(op) return lib.dispatch(op, "") end
function run() M.send("reset") end
return M
` }));
    expect(edges.some(e => e.startsWith('lua-rust-operation: api.lua:run -> native.rs:reset'))).toBe(true);
    expect(edges.some(e => e.startsWith('lua-rust-ffi: api.lua:send -> native.rs:dispatch'))).toBe(true);
    expect(edges.filter(e => e.includes('api.lua:api.lua'))).toEqual([]);
  });

  it('follows a library a module loads, holds and returns, into the modules that require it', async () => {
    // The layout of an OpenResty binding: a loader that returns `ffi.load` on one branch, a handle exported as `clib`.
    const edges = synthesized(await index({
      'src/ffi.rs': '#[no_mangle] pub unsafe extern "C" fn router_new() {}\n#[no_mangle] pub unsafe extern "C" fn context_free(_c: *mut u8) {}\n',
      'lib/resty/router/cdefs.lua': `local ffi = require("ffi")
ffi.cdef([[ struct Router *router_new(void); void context_free(void *c); ]])
local load_shared_lib
do
  local tried = {}
  function load_shared_lib(so_name)
    for path in package.cpath:gmatch("[^;]+") do
      local fpath = path:gsub("%?.so", so_name)
      local f = io.open(fpath)
      if f ~= nil then
        io.close(f)
        return ffi.load(fpath)
      end
      tried[#tried + 1] = fpath
    end
    return nil, tried
  end
end
local clib, tried_paths = load_shared_lib("libatc_router.so")
if not clib then error("could not load: " .. table.concat(tried_paths, ", ")) end
return {
  clib = clib,
  context_free = function(c) clib.context_free(c) end,
}
`,
      'lib/resty/router/router.lua': 'local cdefs = require("resty.router.cdefs")\nlocal clib = cdefs.clib\nlocal _M = {}\nfunction _M.new() return clib.router_new() end\nreturn _M\n',
    }));
    expect(edges.some(e => e.startsWith('lua-rust-ffi: lib/resty/router/router.lua:new -> src/ffi.rs:router_new'))).toBe(true);
    // The closure in the returned table has no node of its own, so its call counts for the file.
    expect(edges.some(e => e.startsWith('lua-rust-ffi: lib/resty/router/cdefs.lua:cdefs.lua -> src/ffi.rs:context_free'))).toBe(true);
  });

  it('follows a library a module function returns, and a library a module keeps', async () => {
    const edges = synthesized(await index({
      'native.rs': '#[no_mangle] pub extern "C" fn cbo_init() {}\n#[no_mangle] pub extern "C" fn cbo_count() -> u32 { 0 }\n#[no_mangle] pub extern "C" fn no_run() -> i32 { 0 }\n',
      'cbo_cdef.lua': `local ffi = require("ffi")
local M = {}
function M.load()
  for _, path in ipairs({ "./libcbo.so", "libcbo.so" }) do
    local ok, lib = pcall(ffi.load, path)
    if ok then M.lib = lib; return lib end
  end
  return nil
end
return M
`,
      'smoke.lua': 'local lib = require("cbo_cdef").load()\nfunction smoke() lib.cbo_init(); return lib.cbo_count() end\n',
      'kept.lua': 'local cdef = require("cbo_cdef")\nfunction later() return cdef.lib.cbo_count() end\n',
      'native.lua': 'local ffi = require("ffi")\nlocal M = { lib = ffi.load("noita_online") }\nreturn M\n',
      'nextrun.lua': 'local NO = require("native")\nfunction step() return NO.lib.no_run() end\n',
      // A handle that may be a Lua mock proves nothing.
      'mocked.lua': 'local ok, lib = pcall(require("cbo_cdef").load)\nif not ok then lib = require("core_mock") end\nfunction tick() lib.cbo_init() end\n',
      'core_mock.lua': 'return { cbo_init = function() end }\n',
    }));
    for (const edge of ['smoke.lua:smoke -> native.rs:cbo_init', 'smoke.lua:smoke -> native.rs:cbo_count', 'kept.lua:later -> native.rs:cbo_count', 'nextrun.lua:step -> native.rs:no_run']) {
      expect(edges.some(e => e.startsWith(`lua-rust-ffi: ${edge}`))).toBe(true);
    }
    expect(edges.filter(e => e.includes('mocked.lua'))).toEqual([]);
  });

  it('finds what analyzing every Lua file finds', async () => {
    const files = {
      'native.rs': NATIVE,
      'net/init.lua': BRIDGE,
      'service.lua': 'local api = require("init")\nlocal S = {}\nfunction S.go(op) return api.call(op) end\nreturn S\n',
      'caller.lua': 'local service = require("service")\nfunction both()\n  service.go("step")\n  service.go("reset")\n  service.go("step")\nend\n',
      'quoted.lua': "local service = require 'service'\nfunction quoted() service.go('reset') end\n",
      'bracket.lua': 'local service = require[[\nservice]]\nfunction bracket() service.go("reset") end\n',
      'mention.lua': '-- the service module\nfunction mention() return service.go("reset") end\n',
    };
    const filtered = synthesized(await index(files));
    for (const caller of ['caller.lua:both', 'quoted.lua:quoted', 'bracket.lua:bracket']) {
      expect(filtered.some(e => e.startsWith(`lua-rust-operation: ${caller} -> native.rs:reset`)), caller).toBe(true);
    }
    cg!.close(); cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-rust-pass-'));
    // A Lua file holding "ffi", here in a trailing comment, is analyzed in the first round.
    const everything = synthesized(await index(Object.fromEntries(Object.entries(files)
      .map(([file, source]) => [file, file.endsWith('.lua') ? `${source}-- "ffi"\n` : source]))));
    expect(filtered).toEqual(everything);
  });

  it('finds what analyzing every Lua file finds, through a module that holds a library', async () => {
    const files = {
      'native.rs': NATIVE,
      'app/net/init.lua': 'local ffi = require("ffi")\nreturn { lib = ffi.load("core") }\n',
      'service.lua': 'local api = require("init")\nlocal S = {}\nfunction S.go() return api.lib.dispatch("step", "{}") end\nreturn S\n',
      'caller.lua': 'local net = require("net")\nfunction both()\n  net.lib.dispatch("step", "{}")\n  net.lib.dispatch("reset", "{}")\nend\n',
      // Every way a literal can spell the module's name.
      'quoted.lua': "local net = require 'app.net'\nfunction quoted() net.lib.dispatch('step', '{}') end\n",
      'bracket.lua': 'local net = require[==[\napp/net]==]\nfunction bracket() net.lib.dispatch("step", "{}") end\n',
      // Naming the module only outside a literal can't reach it.
      'mention.lua': '-- net: see app/net\nfunction mention() return net.lib.dispatch("step", "{}") end\n',
    };
    const filtered = synthesized(await index(files));
    for (const caller of ['service.lua:go', 'caller.lua:both', 'quoted.lua:quoted', 'bracket.lua:bracket']) {
      expect(filtered.some(e => e.startsWith(`lua-rust-ffi: ${caller} -> native.rs:dispatch`)), caller).toBe(true);
    }
    cg!.close(); cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-rust-pass-'));
    // A Lua file holding "ffi", here in a trailing comment, is analyzed in the first round.
    const everything = synthesized(await index(Object.fromEntries(Object.entries(files)
      .map(([file, source]) => [file, file.endsWith('.lua') ? `${source}-- "ffi"\n` : source]))));
    expect(filtered).toEqual(everything);
  });
});

describe('the files that can name a module in require', () => {
  it('hold a literal that ends with its name after a dot, a slash or nothing', () => {
    const core = requireNamePattern('core');
    for (const text of ['require("game.core")', "require 'core'", 'require[[game/core]]', 'require [==[\ncore]==]', 'x = "a\\"b.core"']) {
      expect(core.test(text), text).toBe(true);
    }
    for (const text of ['require("score")', 'require("core_x")', 'require("core.x")', '-- core', 'local core = 1', 'f("core\nx")']) {
      expect(core.test(text), text).toBe(false);
    }
    // A name an escape sequence could spell is never ruled out.
    expect(requireNamePattern('we"ird').test('anything')).toBe(true);
  });
});

describe('what opens the LuaJIT → Rust bridge', () => {
  it('opens only for an FFI file or an export in a project with the other language', () => {
    const both = new Set(['lua', 'rust', 'typescript']);
    const ffi = 'local ffi = require("ffi")';
    const exported = '#[no_mangle] pub extern "C" fn ping() {}';
    expect(opensLuaRustBridge('lua', ffi, both)).toBe(true);
    expect(opensLuaRustBridge('rust', exported, both)).toBe(true);
    expect(opensLuaRustBridge('lua', 'return {}', both)).toBe(false);
    expect(opensLuaRustBridge('rust', 'pub fn ping() {}', both)).toBe(false);
    expect(opensLuaRustBridge('typescript', ffi, both)).toBe(false);
    expect(opensLuaRustBridge('lua', ffi, new Set(['lua']))).toBe(false);
    expect(opensLuaRustBridge('rust', exported, new Set(['rust', 'typescript']))).toBe(false);
  });
});

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
  });

  it('re-indexes to the graph a fresh index builds', async () => {
    // Two getter calls in one function: the edges the last pass synthesized are
    // still in the index when a re-index synthesizes again.
    await index({ 'native.rs': RUST, 'bridge.lua': LUA, 'caller.lua': `
local function core() return require("bridge") end
function both_tasks()
    core().call("task.run", "{}")
    return core().call("task.read", "{}")
end
` });
    const edges = () => {
      const nodes = cg!.getNodesInFiles(cg!.getFiles().map(f => f.path));
      const name = new Map(nodes.map(n => [n.id, `${n.filePath}:${n.qualifiedName}`]));
      return cg!.getOutgoingEdgesFrom(nodes.map(n => n.id))
        .map(e => `${name.get(e.source)} -${e.kind}@${e.line}:${e.column}-> ${name.get(e.target)} ${JSON.stringify(e.metadata ?? {})}`).sort();
    };
    const fresh = edges();
    expect(fresh.filter(e => e.includes('both_tasks -calls') && e.includes('lua-rust-operation'))).toHaveLength(2);
    await cg!.indexAll();
    expect(edges()).toEqual(fresh);
  });

  it('follows wrappers in modules that hold no FFI call, however deep', async () => {
    // Only bridge.lua says "ffi". service.lua names it, and caller.lua names
    // service, so each wrapper is found only after the one it forwards to.
    await index({ 'native.rs': RUST, 'bridge.lua': LUA,
      'lib/service.lua': 'local Bridge = require("bridge")\nlocal Service = {}\nfunction Service.run(op) return Bridge.call(op, "{}") end\nreturn Service',
      'app/caller.lua': 'local Service = require("lib.service")\nfunction run_task() return Service.run("task.run") end\nfunction read_task() return Service.run("task.read") end',
      'app/other.lua': 'local M = {}\nfunction M.run(op) return op end\nfunction unrelated() return M.run("task.run") end\nreturn M' });
    expect(callees('run_task')).toContain('run');
    expect(callees('run_task')).not.toContain('read');
    expect(callees('read_task')).toContain('read');
    expect(callers('run')).toContain('run_task');
    expect(callees('unrelated')).not.toContain('run');
  });

  it('credits a call in an anonymous function to the function around it', async () => {
    await index({ 'native.rs': `${RUST}\n#[no_mangle]\npub extern "C" fn native_ping() {}\n`, 'bridge.lua': LUA, 'caller.lua': `
local Bridge = require("bridge")
local ffi = require("ffi")
local lib = ffi.load("example")
local function guarded(name, fn) return fn() end
function run_task() return guarded("run", function() return Bridge.call("task.run", "{}") end) end
function ping() return pcall(function() return lib.native_ping() end) end
function forward(op) return guarded("forward", function() return Bridge.call(op, "{}") end) end
function read_task() return forward("task.read") end
function own(op) return guarded("own", function(inner) return Bridge.call(inner, "{}") end) end
function own_task() return own("task.read") end
` });
    // The literal operation and the FFI call each count for the function around their closure.
    expect(callees('run_task')).toContain('run');
    expect(callees('run_task')).not.toContain('read');
    expect(callers('run')).toContain('run_task');
    expect(callees('ping')).toContain('native_ping');
    // A parameter the closure captures from that function is that function's to forward.
    expect(callees('read_task')).toContain('read');
    expect(callees('read_task')).not.toContain('run');
    // The closure's own parameter is not.
    expect(callees('own_task')).not.toContain('read');
    expect(callees('own_task')).not.toContain('run');
  });

  it('links a Lua file whose first FFI call arrives in an incremental edit', async () => {
    await index({ 'native.rs': '#[no_mangle]\npub extern "C" fn native_ping() {}', 'caller.lua': 'function ping() return 1 end' });
    expect(callees('ping')).not.toContain('native_ping');
    write('caller.lua', 'local ffi = require("ffi")\nlocal lib = ffi.load("native")\nfunction ping() lib.native_ping() end');
    await cg!.sync({ paths: ['caller.lua'] });
    expect(callees('ping')).toContain('native_ping');
  });

  it('links a project whose first Lua and first Rust files arrive in one sync', async () => {
    await index({ 'notes.py': 'def note():\n    return 1\n' });
    write('native.rs', '#[no_mangle]\npub extern "C" fn native_ping() {}');
    write('caller.lua', 'local ffi = require("ffi")\nlocal lib = ffi.load("native")\nfunction ping() lib.native_ping() end');
    await cg!.sync({ paths: ['native.rs', 'caller.lua'] });
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
