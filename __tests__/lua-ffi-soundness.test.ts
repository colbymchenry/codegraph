import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { analyzeLua } from '../src/resolution/lua-ffi-analysis';

beforeAll(async () => { await loadGrammarsForLanguages(['lua']); });

const symbols = (source: string): string[] => analyzeLua(source).calls.flatMap(call => call.ffiSymbol ? [call.ffiSymbol] : []);
const FFI = 'local ffi = require("ffi")\n';

describe('Lua provenance covers every path a value can take', () => {
  it.each([
    ['a loop that may not run', 'local lib = require("shim")\nfor _, name in ipairs(names) do lib = ffi.load(name) end\nlib.native_ping()'],
    ['a while loop that may not run', 'local lib = require("shim")\nwhile enabled do lib = ffi.load("x") end\nlib.native_ping()'],
    ['a loop that runs again after its body', 'local lib = ffi.load("x")\nfor i = 1, 3 do lib.native_ping(); lib = require("shim") end'],
    ['a break that leaves before the reassignment', 'local lib = ffi.load("x")\nwhile true do lib = require("shim"); if done then break end; lib = ffi.load("y") end\nlib.native_ping()'],
    ['a pcall fallback whose second value is the module', 'local ok, lib = pcall(require, "lua_fallback")\nif not ok then lib = ffi.load("native") end\nlib.native_ping()'],
    ['a vararg slot', 'local _, lib = ...\nif enabled then lib = ffi.load("native") end\nlib.native_ping()'],
    ['an empty then branch', 'local lib = require("shim")\nif enabled then else lib = ffi.load("x") end\nlib.native_ping()'],
    ['a closure rebinding its enclosing local', 'local function outer()\n  local lib = ffi.load("native")\n  local function swap() lib = require("shim") end\n  swap()\n  lib.native_ping()\nend'],
    ['a chunk-level call after a function rebinds the local', 'local lib = ffi.load("native")\nlocal function swap() lib = require("shim") end\nswap()\nlib.native_ping()'],
    ['a table built from a later-rebound capture', 'local lib = ffi.load("x")\nlocal function bad() lib = {} end\nlocal function use() local t = { l = lib }; t.l.native_ping() end'],
    ['a goto that skips the assignment', 'local lib = require("shim")\ngoto skip\nlib = ffi.load("x")\n::skip::\nlib.native_ping()'],
    ['a syntax error that hides a reassignment', 'local lib = ffi.load("x")\nlocal t = { = }\nlib = require("shim")\nlib.native_ping()'],
  ])('withholds proof through %s', (_name, body) => {
    expect(symbols(FFI + body)).not.toContain('native_ping');
  });

  it.each([
    ['a library that every iteration keeps', 'local lib = ffi.load("x")\nfor _, v in ipairs(t) do lib.native_ping(v) end'],
    ['a table rebuilt from a stable library', 'local function f()\n  local t\n  for i = 1, 2 do t = { l = ffi.load("x") } end\n  t.l.native_ping()\nend'],
    ['a lazy loader that only fills a nil slot', 'local lib\nlocal function open() local ok, l = pcall(ffi.load, "x"); if ok then lib = l end end\nfunction ping() open(); lib.native_ping() end'],
    ['an early return before the FFI branch', 'local function f(native)\n  local lib = require("shim")\n  if not native then return lib.other() end\n  lib = ffi.load("x")\n  return lib.native_ping()\nend'],
  ])('keeps proof for %s', (_name, body) => {
    expect(symbols(FFI + body)).toContain('native_ping');
  });

  it('records literal cdef declarations and their asm labels', () => {
    const analysis = analyzeLua(`${FFI}ffi.cdef[[
  /* comment; int hidden(void); */
  void ping(void) asm("native_real");
  int plain(const char *s, size_t n);
  typedef void (*callback)(int);
  struct S { int (*fn)(int); };
]]
local lib = ffi.load("native")
lib.ping()`);
    expect(analysis.cdefSymbols).toEqual({ ping: ['native_real'], plain: ['plain'] });
    expect(analysis.calls.find(call => call.callee === 'lib.ping')!.ffiSymbol).toBe('ping');
  });

  it('invalidates only the module members a write replaces', () => {
    const analysis = analyzeLua(`local T = require("context")
T.tests[#T.tests + 1] = {}
T.patched = function() end
T.run()
T.patched()
T.tests.first()`);
    const call = (callee: string) => analysis.calls.find(c => c.callee === callee)!;
    expect(call('T.run')).toMatchObject({ importedModule: 'context', resolvedCallee: 'run' });
    expect(call('T.patched').importedModule).toBeUndefined();
    expect(call('T.tests.first').importedModule).toBeUndefined();
  });

  it('treats a metatable assignment as reading the table, not mutating it', () => {
    const analysis = analyzeLua(`local M = {}
M.__index = M
function M.new() return setmetatable({}, M) end
function M.ping() return 1 end
M.new()
return M`);
    expect(Object.keys(analysis.exportedFunctions).sort()).toEqual(['new', 'ping']);
    expect(analysis.calls.find(call => call.callee === 'M.new')!.localFunctionStartIndex).toBeDefined();
  });

  it('does not let a stored parameter stand for another function\'s parameter', () => {
    const analysis = analyzeLua(`local holder = {}
local saved
local function remember(callback) holder.callback = callback; saved = callback end
local function later() holder.callback(); saved() end`);
    for (const callee of ['holder.callback', 'saved']) {
      expect(analysis.calls.find(call => call.callee === callee)!.parameterReceiver).toBeUndefined();
    }
  });

  it('resolves a receiver written through a call in an assignment target', () => {
    const analysis = analyzeLua(`local build = require("capture").build
require("capture").build = function(...) return build(...) end`);
    expect(analysis.calls.find(call => call.callee === 'build')!.importedModule).toBeUndefined();
  });

  it('settles long closure chains without one round per link', () => {
    let source = FFI;
    for (let i = 0; i <= 400; i++) source += `local u${i}\n`;
    source += 'u0 = ffi.load("x")\n';
    for (let i = 400; i >= 1; i--) source += `local function g${i}() u${i} = u${i - 1} end\n`;
    source += 'local function use() u400.native_ping() end\n';
    const started = performance.now();
    expect(symbols(source)).toEqual(['native_ping']);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('scales linearly with locals and functions', () => {
    const time = (k: number): number => {
      let source = '';
      for (let i = 0; i < k; i++) source += `local v${i} = {}\n`;
      for (let i = 0; i < k; i++) source += `local function f${i}(x) if x then return v${i} end return nil end\n`;
      const started = performance.now();
      analyzeLua(source);
      return performance.now() - started;
    };
    time(500);
    expect(time(2000)).toBeLessThan(Math.max(250, time(500) * 12));
  });
});
