import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { analyzeLua } from '../src/resolution/lua-ffi-analysis';

beforeAll(async () => { await loadGrammarsForLanguages(['lua']); });

const symbols = (source: string): string[] => analyzeLua(source).calls.flatMap(call => call.ffiSymbol ? [call.ffiSymbol] : []);

describe('Lua bridge provenance respects shared modules and lexical cells', () => {
  it('invalidates a separately required alias of the mutated ffi module', () => {
    expect(symbols(`local first = require("ffi")
local second = require("ffi")
first.load = other
local library = second.load("example")
function ping() return library.native_ping() end`)).toEqual([]);
  });

  it('invalidates a separately required alias of a mutated Lua module', () => {
    const analysis = analyzeLua(`local first = require("bridge")
local second = require("bridge")
first.call = other
function run_task() return second.call("task.run") end`);
    const call = analysis.calls.find(call => call.callee === 'second.call')!;
    expect(call.importedModule).toBeUndefined();
    expect(call.resolvedCallee).toBeUndefined();
  });

  it('updates an outer cell captured by a conditionally declared function', () => {
    expect(symbols(`local ffi = require("ffi")
local library = ffi.load("example")
if enabled then
  function ping() return library.native_ping() end
end
library = {}
ping()`)).toEqual([]);
  });

  it('keeps repeat body locals visible in the until condition', () => {
    expect(symbols(`local ffi = require("ffi")
repeat
  local ffi = { C = { run = function() return true end } }
until ffi.C.run()`)).toEqual([]);
  });

  it('keeps a branch-local captured library distinct from an outer binding', () => {
    expect(symbols(`local ffi = require("ffi")
local library = {}
if enabled then
  local library = ffi.load("example")
  function ping() return library.native_ping() end
end
library = other
ping()`)).toEqual(['native_ping']);
  });

  it('names inline table functions using their statically authored member paths', () => {
    const analysis = analyzeLua(`local ffi = require("ffi")
local library = ffi.load("example")
local Bridge = {
  call = function(op) return library.wire_send(op) end,
  nested = { send = function(op) return library.wire_send(op) end },
}
return Bridge`);
    expect(analysis.functions.map(fn => fn.name)).toEqual(['Bridge.call', 'Bridge.nested.send']);
    expect(analysis.exportedFunctions).toEqual({
      call: analysis.functions[0]!.startIndex,
      'nested.send': analysis.functions[1]!.startIndex,
    });
    expect(analysis.functions[0]).toMatchObject({ line: 4, column: 9 });
    expect(analysis.calls.filter(call => call.ffiSymbol).map(call => call.args[0]!.parameterIndex)).toEqual([0, 0]);
  });

  it('preserves callable exports when a different public state member changes', () => {
    const analysis = analyzeLua(`local Bridge = {}
function Bridge.call(op) return op end
function Bridge.reset() Bridge.ready = false end
return Bridge`);
    expect(analysis.exportedFunctions).toEqual({
      call: analysis.functions[0]!.startIndex,
      reset: analysis.functions[1]!.startIndex,
    });
  });

  it('withholds a mutated member while retaining unchanged callable members', () => {
    const analysis = analyzeLua(`local Bridge = {}
function Bridge.call(op) return op end
function Bridge.read(op) return op end
if enabled then Bridge.call = other end
return Bridge`);
    expect(analysis.exportedFunctions).toEqual({ read: analysis.functions[1]!.startIndex });
  });

  it('marks captured parameter receivers, colon calls, and parameter function aliases', () => {
    const analysis = analyzeLua(`function outer(Bridge, callback)
  local invoke = callback
  local member = Bridge.call
  local function nested()
    Bridge.call("task.run")
    Bridge:call("task.run")
    invoke()
    member()
  end
  return nested()
end`);
    const calls = analysis.calls.filter(call => ['Bridge.call', 'Bridge:call', 'invoke', 'member'].includes(call.callee));
    expect(calls).toHaveLength(4);
    expect(calls.every(call => call.parameterReceiver === true)).toBe(true);
  });

  it('clears parameter receiver provenance after an unconditional module rebinding', () => {
    const analysis = analyzeLua(`function rebound(Bridge)
  Bridge = require("bridge")
  return Bridge.call("task.run")
end`);
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')).toMatchObject({ importedModule: 'bridge', resolvedCallee: 'call' });
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')!.parameterReceiver).toBeUndefined();
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')!.parameterBinding).toBe(true);
  });

  it('retains parameter declaration identity after an unknown captured rebinding', () => {
    const analysis = analyzeLua(`function outer(Bridge)
  Bridge = other
  local function nested() return Bridge:call("task.run") end
  return nested()
end`);
    const call = analysis.calls.find(call => call.callee === 'Bridge:call')!;
    expect(call.parameterReceiver).toBeUndefined();
    expect(call.parameterBinding).toBe(true);
    expect(call.importedModule).toBeUndefined();
  });

  it('does not transfer parameter declaration identity into a new local shadow', () => {
    const analysis = analyzeLua(`function outer(Bridge)
  local Bridge = require("bridge")
  return Bridge.call("task.run")
end`);
    const call = analysis.calls.find(call => call.callee === 'Bridge.call')!;
    expect(call.parameterBinding).toBeUndefined();
    expect(call.importedModule).toBe('bridge');
  });

  it('does not forward a member of a parameter as the entire operation parameter', () => {
    const analysis = analyzeLua(`local ffi = require("ffi")
local library = ffi.load("example")
function send(request)
  local op = request.operation
  return library.wire_send(op)
end`);
    const call = analysis.calls.find(call => call.ffiSymbol === 'wire_send')!;
    expect(call.args[0]!.parameterIndex).toBeUndefined();
  });

  it('proves single-return local module getters whose parameters are ignored', () => {
    const analysis = analyzeLua(`local function core(ignored) return require("bridge") end
function run_task() return core("unused").call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core("unused").call')).toMatchObject({
      importedModule: 'bridge', resolvedCallee: 'call',
    });
  });

  it('proves forward-declared getter aliases through their captured namespace', () => {
    const analysis = analyzeLua(`local Module = require("bridge")
local getter
local function first() return getter() end
function run_task() return first().call("task.run") end
getter = function() return Module end`);
    expect(analysis.calls.find(call => call.callee === 'first().call')).toMatchObject({
      importedModule: 'bridge', resolvedCallee: 'call',
    });
  });

  it('proves a library getter after a captured lazy loader settles', () => {
    expect(symbols(`local ffi = require("ffi")
local library
local function getter() return library end
function ping() return getter().native_ping() end
local function open() library = ffi.load("example") end`)).toEqual(['native_ping']);
  });

  it.each([
    'local function core() mutate(); return require("bridge") end',
    'local function core() if enabled then return require("bridge") end end',
    'local function core() return unknown() end',
    'local function core(name) return require(name) end',
    'local function core(require) return require("bridge") end',
    'function core() return require("bridge") end',
    'local function core() return require("bridge"), other end',
    'local function core() return require("bridge").load() end',
  ])('withholds unsupported getter returns: %s', getter => {
    const analysis = analyzeLua(`${getter}\nfunction run_task() return core().call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core().call')!.importedModule).toBeUndefined();
  });

  it.each([
    'Module = other',
    'function mutate() Module = other end',
    'Module.call = other',
    'local Alias = require("bridge"); Alias.call = other',
  ])('invalidates getter proof after captured namespace mutation: %s', mutation => {
    const analysis = analyzeLua(`local Module = require("bridge")
local function core() return Module end
${mutation}
function run_task() return core().call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core().call')!.importedModule).toBeUndefined();
  });

  it('invalidates a library getter when its captured library is mutated', () => {
    expect(symbols(`local ffi = require("ffi")
local library = ffi.load("example")
local function getter() return library end
function mutate() library.native_ping = other end
function ping() return getter().native_ping() end`)).toEqual([]);
  });

  it('does not infer a rebound local getter from its former declaration', () => {
    const analysis = analyzeLua(`local function core() return require("bridge") end
core = other
function run_task() return core().call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core().call')!.importedModule).toBeUndefined();
  });

  it.each(['ffi.load = other', 'holder.ffi.load = other'])('invalidates a table-held FFI namespace after %s', mutation => {
    expect(symbols(`local ffi = require("ffi")
local holder = { ffi = ffi }
${mutation}
local library = holder.ffi.load("example")
function ping() return library.native_ping() end`)).toEqual([]);
  });

  it.each(['Module.call = other', 'holder.Module.call = other'])('invalidates a table-held module namespace after %s', mutation => {
    const analysis = analyzeLua(`local Module = require("bridge")
local holder = { Module = Module }
${mutation}
function run_task() return holder.Module.call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'holder.Module.call')!.importedModule).toBeUndefined();
  });

  it('invalidates a loaded library mutated through a table member', () => {
    expect(symbols(`local ffi = require("ffi")
local holder = { library = ffi.load("example") }
function mutate() holder.library.native_ping = other end
function ping() return holder.library.native_ping() end`)).toEqual([]);
  });

  it('preserves namespace provenance when an unrelated holder field is mutated', () => {
    const analysis = analyzeLua(`local holder = { Module = require("bridge"), ready = true }
function reset() holder.ready = false end
function run_task() return holder.Module.call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'holder.Module.call')).toMatchObject({
      importedModule: 'bridge', resolvedCallee: 'call',
    });
  });

  it('marks a captured parameter that shadowed a proven outer module', () => {
    const analysis = analyzeLua(`local Bridge = require("bridge")
function outer(Bridge)
  Bridge = other
  local function nested() return Bridge:call("task.run") end
  return nested()
end`);
    expect(analysis.calls.find(call => call.callee === 'Bridge:call')).toMatchObject({
      parameterBinding: true, parameterShadowsNamespace: true,
    });
  });

  it('distinguishes namespace shadows from ordinary runtime receiver parameters', () => {
    const analysis = analyzeLua(`local ffi = require("ffi")
local library = ffi.load("example")
local function callback() end
function shadow(ffi, library, callback, receiver)
  ffi:C()
  library:native_ping()
  callback:run()
  receiver:run()
end`);
    for (const callee of ['ffi:C', 'library:native_ping', 'callback:run']) {
      expect(analysis.calls.find(call => call.callee === callee)!.parameterShadowsNamespace).toBe(true);
    }
    expect(analysis.calls.find(call => call.callee === 'receiver:run')!.parameterShadowsNamespace).toBeUndefined();
  });
});
