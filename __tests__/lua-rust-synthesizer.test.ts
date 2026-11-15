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
    expect(edges.some(e => e.startsWith('lua-rust-ffi: bridge.lua:call -> native.rs:dispatch'))).toBe(true);
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
    expect(synthesized(graph).some(e => e.startsWith('lua-rust-ffi: config.lua:call -> native.rs:dispatch'))).toBe(true);
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
