import { beforeAll, describe, expect, it } from 'vitest';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { analyzeLua } from '../src/resolution/lua-ffi-analysis';

beforeAll(async () => { await loadGrammarsForLanguages(['lua']); });

const symbols = (source: string): string[] => analyzeLua(source).calls.flatMap(call => call.ffiSymbol ? [call.ffiSymbol] : []);

describe('LuaJIT AST provenance', () => {
  it.each([
    ['ffi.C', 'local f=require "ffi"; f.C.run("yes")', ['run']],
    ['library and function aliases', 'local f=require "ffi"; local lib=f.load("x"); local alias=lib; local run=alias.run; run("yes")', ['run']],
    ['pcall result assignment', 'local f=require "ffi"; local lib; do local ok,loaded=pcall(f.load,"x"); if ok then lib=loaded end end; lib.run()', ['run']],
    ['unrelated module', 'local ffi=require "other"; local lib=ffi.load("x"); lib.run()', []],
    ['parameter shadow', 'local ffi=require "ffi"; function f(ffi) ffi.C.run() end', []],
    ['generic loop shadow', 'local ffi=require "ffi"; for ffi in pairs(xs) do ffi.C.run() end', []],
    ['numeric loop shadow', 'local ffi=require "ffi"; for ffi=1,4 do ffi.C.run() end', []],
    ['receiver reassignment', 'local ffi=require "ffi"; local lib=ffi.load("x"); lib={}; lib.run()', []],
    ['conflicting branches', 'local ffi=require "ffi"; local lib=ffi.load("x"); if x then lib={} else lib=ffi.load("y") end; lib.run()', []],
    ['captured conflicting assignment', 'local ffi=require "ffi"; local lib; function open() lib=ffi.load("x") end; function bad() lib={} end; function run() lib.run() end', []],
    ['lazy loader declared after consumer', 'local ffi=require "ffi"; local lib; function run() lib.run() end; function open() lib=ffi.load("x") end', ['run']],
    ['lexical block scope', 'do local ffi=require "ffi"; ffi.C.run() end; ffi.C.bad()', ['run']],
    ['strings and comments', '-- ffi.C.fake()\nlocal text="ffi.C.fake()"', []],
    ['shadowed require', 'local require = other; local ffi=require("ffi"); ffi.C.run()', []],
    ['shadowed pcall', 'local ffi=require "ffi"; local pcall=other; local ok,lib=pcall(ffi.load,"x"); lib.run()', []],
    ['literal bracket symbol', 'local ffi=require "ffi"; ffi.C["run"]()', ['run']],
    ['dynamic bracket symbol', 'local ffi=require "ffi"; ffi.C[operation]()', []],
    ['module mutation', 'local ffi=require "ffi"; local alias=ffi; ffi.load=other; local lib=alias.load("x"); lib.run()', []],
    ['captured module mutation', 'local ffi=require "ffi"; function mutate() ffi.load=other end; function run() ffi.C.run() end', []],
    ['captured library mutation', 'local ffi=require "ffi"; local lib=ffi.load("x"); function mutate() lib.run=other end; function run() lib.run() end', []],
    ['library mutation through alias', 'local ffi=require "ffi"; local lib=ffi.load("x"); local alias=lib; lib.run=other; alias.run()', []],
  ] satisfies Array<[string, string, string[]]>)('%s', (_name, source, expected) => {
    expect(symbols(source)).toEqual(expected);
  });

  it('resolves required module function aliases without treating them as FFI', () => {
    const analysis = analyzeLua('local Core=require("transport"); local send=Core.call; send("job.start")');
    const call = analysis.calls.find(c => c.callee === 'send')!;
    expect(call).toMatchObject({ importedModule: 'transport', resolvedCallee: 'call', args: [{ kind: 'string', value: 'job.start' }] });
    expect(call.ffiSymbol).toBeUndefined();
  });

  it('preserves constant operation values and parameter forwarding through aliases', () => {
    const source = `local ffi=require("ffi")
local lib=ffi.load("example")
local OP="job.start"
local function send(operation, body)
  local forwarded = operation
  lib.send(forwarded, body)
end
send(OP, "{}")`;
    const analysis = analyzeLua(source);
    expect(analysis.calls.find(c => c.callee === 'send')!.args[0]).toMatchObject({ text: 'OP', kind: 'string', value: 'job.start' });
    expect(analysis.calls.find(c => c.ffiSymbol === 'send')!.args).toEqual([
      { text: 'forwarded', kind: 'identifier', value: 'forwarded', parameterIndex: 0 },
      { text: 'body', kind: 'identifier', value: 'body', parameterIndex: 1 },
    ]);
    expect(analysis.functions).toEqual([expect.objectContaining({ name: 'send', parameters: ['operation', 'body'], line: 4, endLine: 7 })]);
    const call = analysis.calls.find(c => c.ffiSymbol === 'send')!;
    expect(source.slice(call.startIndex, call.endIndex)).toBe('lib.send(forwarded, body)');
    expect(call.functionStartIndex).toBe(analysis.functions[0]!.startIndex);
  });

  it('supports long-string literals without inspecting their contents as Lua', () => {
    const analysis = analyzeLua('local ffi=require [=[ffi]=]; ffi.C.send([=[job.start]=]); local text=[[ffi.C.fake()]]');
    expect(analysis.calls.filter(c => c.ffiSymbol)).toEqual([expect.objectContaining({ ffiSymbol: 'send', args: [{ text: '[=[job.start]=]', kind: 'string', value: 'job.start' }] })]);
  });

  it('does not leak function-local library assignments to another function', () => {
    expect(symbols('local lib; function make() local ffi=require "ffi"; local lib=ffi.load("x") end; function run() lib.run() end')).toEqual([]);
  });
  it('identifies lexical function targets and their direct aliases', () => {
    const analysis = analyzeLua(`local function native(op) return op end
local alias = native
local assigned = function(op) return native(op) end
function global_send(op) return alias(op) end
native("job.start")
alias("job.stop")
assigned("job.read")
global_send("job.read")`);
    const native = analysis.functions.find(fn => fn.name === 'native')!;
    const assigned = analysis.functions.find(fn => fn.name === 'assigned')!;
    const global = analysis.functions.find(fn => fn.name === 'global_send')!;
    for (const call of analysis.calls.filter(call => ['native', 'alias'].includes(call.callee))) {
      expect(call.localFunctionStartIndex).toBe(native.startIndex);
    }
    expect(analysis.calls.find(call => call.callee === 'assigned')!.localFunctionStartIndex).toBe(assigned.startIndex);
    expect(analysis.calls.find(call => call.callee === 'global_send')!.localFunctionStartIndex).toBe(global.startIndex);
  });

  it('withholds callable provenance from shadowed parameters and unknown receivers', () => {
    const analysis = analyzeLua(`local Bridge=require("transport")
local function native(op) return Bridge.call(op) end
function shadow(Bridge, native)
  Bridge.call("job.start")
  native("job.start")
  Unknown.call("job.start")
end`);
    const shadow = analysis.functions.find(fn => fn.name === 'shadow')!;
    const calls = analysis.calls.filter(call => call.functionStartIndex === shadow.startIndex);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.importedModule).toBeUndefined();
      expect(call.localFunctionStartIndex).toBeUndefined();
    }
  });

  it('invalidates lexical function and imported-module provenance on reassignment', () => {
    const analysis = analyzeLua(`local Bridge=require("transport")
local alias = Bridge
local function native(op) return op end
native = other
Bridge.call = other
native("job.start")
alias.call("job.start")`);
    for (const call of analysis.calls.filter(call => call.callee !== 'require')) {
      expect(call.importedModule).toBeUndefined();
      expect(call.localFunctionStartIndex).toBeUndefined();
    }
  });

  it('does not relabel captured outer parameters as nested function parameters', () => {
    const analysis = analyzeLua(`local ffi=require("ffi")
local lib=ffi.load("example")
local function outer(op)
  local function nested(unrelated) return lib.wire_send(op) end
  return nested("job.read")
end
function run_task() return outer("job.run") end`);
    const call = analysis.calls.find(call => call.ffiSymbol === 'wire_send')!;
    expect(call.args[0]).toMatchObject({ kind: 'identifier', value: 'op' });
    expect(call.args[0]!.parameterIndex).toBeUndefined();
    // It is outer's first parameter, captured, and nested is defined in outer.
    const outer = analysis.functions.find(fn => fn.name === 'outer')!;
    expect(call.args[0]!.capturedParameter).toEqual({ owner: outer.startIndex, index: 0 });
    expect(analysis.functions.find(fn => fn.name === 'nested')!.parentStartIndex).toBe(outer.startIndex);
    expect(outer.parentStartIndex).toBeUndefined();
  });

  it('aligns colon method calls with the implicit self parameter', () => {
    const analysis = analyzeLua(`local Core={}
local ffi=require("ffi")
local lib=ffi.load("example")
function Core:send(op) return lib.wire_send(op) end
Core:send("job.run")
lib:wire_send("job.run")`);
    const fn = analysis.functions.find(fn => fn.name === 'Core:send')!;
    expect(fn.parameters).toEqual(['self', 'op']);
    const forward = analysis.calls.find(call => call.callee === 'lib.wire_send')!;
    expect(forward.args[0]!.parameterIndex).toBe(1);
    const method = analyzeLua('local Core=require("transport"); Core:send("job.run")').calls.find(call => call.callee === 'Core:send')!;
    expect(method).toMatchObject({ importedModule: 'transport', resolvedCallee: 'send' });
    expect(method.args).toEqual([{ text: 'Core', kind: 'unknown' }, { text: '"job.run"', kind: 'string', value: 'job.run' }]);
    const ffiMethod = analysis.calls.find(call => call.callee === 'lib:wire_send')!;
    expect(ffiMethod.ffiSymbol).toBe('wire_send');
    expect(ffiMethod.args[0]).toEqual({ text: 'lib', kind: 'unknown' });
  });

  it('invalidates imported-module provenance when a member declaration overwrites it', () => {
    const analysis = analyzeLua('local Bridge=require("transport"); function Bridge.call(op) return op end; Bridge.call("job.run")');
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')!.importedModule).toBeUndefined();
  });

  it('exports only functions on the table actually returned by the module', () => {
    const analysis = analyzeLua(`local Hidden={}
local Public={}
function Hidden.call(op) return op end
function Public.call(op) return op end
return Public`);
    const hidden = analysis.functions.find(fn => fn.name === 'Hidden.call')!;
    const publicFn = analysis.functions.find(fn => fn.name === 'Public.call')!;
    expect(analysis.exportedFunctions).toEqual({ call: publicFn.startIndex });
    expect(Object.values(analysis.exportedFunctions)).not.toContain(hidden.startIndex);
    expect(analyzeLua('local Hidden={}; function Hidden.call(op) return op end; return {}').exportedFunctions).toEqual({});
  });

  it('tracks returned table aliases and member function assignments', () => {
    const analysis = analyzeLua('local Public={}; local alias=Public; alias.call=function(op) return op end; return alias');
    expect(analysis.exportedFunctions).toEqual({ call: analysis.functions[0]!.startIndex });
  });

  it('tracks literal returned tables, nested members and direct returned functions', () => {
    const literal = analyzeLua('local function send(op) return op end; return {call=send,nested={send=send}}');
    expect(literal.exportedFunctions).toEqual({ call: literal.functions[0]!.startIndex, 'nested.send': literal.functions[0]!.startIndex });
    const direct = analyzeLua('local function send(op) return op end; return send');
    expect(direct.exportedFunctions).toEqual({ '': direct.functions[0]!.startIndex });
  });

  it('provides exact local table member call identities', () => {
    const analysis = analyzeLua('local Core={}; function Core.call(op) return op end; Core.call("job.run"); return Core');
    expect(analysis.calls.find(call => call.callee === 'Core.call')!.localFunctionStartIndex).toBe(analysis.functions[0]!.startIndex);
  });

  it.each([
    'local function send() end; if flag then return {call=send} end; return {}',
    'local function send() end; return {[dynamic]=send}',
    'local Public={}; function Public.call() end; Public[key]=other; return Public',
    'local Public={}; function Public.call() end; if flag then Public.call=other end; return Public',
    'local Public={}; function Public.call() end; while flag do Public.call=other end; return Public',
    'local Public={}; function Public.call() end; mutate(Public); return Public',
    'local Public={}; function Public.call() end; function change() Public.call=other end; return Public',
    'local Public={}; function Public.call() end; Public.call=other; return Public',
  ])('withholds dynamic or conflicting exports: %s', source => {
    expect(analyzeLua(source).exportedFunctions).toEqual({});
  });

});

describe('writes the analysis cannot place', () => {
  const head = 'local ffi=require "ffi"; ';
  it.each([
    ['a method that rewrites its receiver', head + 'local Native={lib=ffi.load("x")}; function Native:use(l) self.lib=l end; Native:use({}); function tick() Native.lib.run() end', []],
    ['a method that writes another member', head + 'local Native={lib=ffi.load("x")}; function Native:rename(n) self.label=n end; Native:rename("x"); function tick() Native.lib.run() end', ['run']],
    ['a helper that rewrites what it is given', head + 'local H={lib=ffi.load("x")}; local function swap(t) t.lib=nil end; swap(H); H.lib.run()', []],
    ['a helper that rewrites what it is given, through a member', head + 'local H={inner={lib=ffi.load("x")}}; local function swap(t) t.inner.lib=nil end; swap(H); H.inner.lib.run()', []],
    ['a helper that hands what it is given to unknown code', head + 'local H={lib=ffi.load("x")}; local function give(t) install(t) end; give(H); H.lib.run()', []],
    ['a table inside a table handed to unknown code', head + 'local a={lib=ffi.load("x")}; install({backend=a}); a.lib.run()', []],
    ['a table stored into a table unknown code holds', head + 'local a={lib=ffi.load("x")}; local t={}; install(t); t.backend=a; a.lib.run()', []],
    ['a write through a loop variable', head + 'local b={lib=ffi.load("x")}; for _,v in pairs({b}) do v.lib=other end; b.lib.run()', []],
    ['a write through what assert returns', head + 'local c={lib=ffi.load("x")}; assert(c).lib=other; c.lib.run()', []],
    ['a write through a parameter, to a table the module returns', head + 'local M={lib=ffi.load("x")}; function M.set(t,l) t.lib=l end; function M.run() M.lib.run() end; return M', []],
    ['a write of another member through a parameter', head + 'local M={lib=ffi.load("x")}; function M.set(t,v) t.state=v end; function M.run() M.lib.run() end; return M', ['run']],
    ['arguments past a vararg function\'s parameters', head + 'local H={lib=ffi.load("x")}; local function each(...) end; each(H); H.lib.run()', []],
    ['a write through package.loaded', 'package.loaded.ffi={C={}}; local ffi=require("ffi"); ffi.C.run()', []],
    ['assert returns what it is given', 'local ffi=assert(require("ffi")); local lib=assert(ffi.load("x")); lib.run()', ['run']],
    ['a local alias of require', 'local require=require; local ffi=require("ffi"); ffi.C.run()', ['run']],
    ['a renamed alias of require', 'local req=require; local f=req "ffi"; f.C.run()', ['run']],
  ] satisfies Array<[string, string, string[]]>)('%s', (_name, source, expected) => {
    expect(symbols(source)).toEqual(expected);
  });

  const moduleCall = (source: string, callee: string) => analyzeLua(source).calls.find(call => call.callee === callee)!;
  it.each([
    ['a helper that replaces a module member', 'local b=require("bridge"); local function stub(m,k) m[k]=function() end end; stub(b,"call"); b.call("step")'],
    ['package.loaded replacing the module', 'package.loaded["bridge"]={}; local b=require("bridge"); b.call("step")'],
    ['package.loaded under a key the analysis can\'t read', 'package.loaded[name]={}; local b=require("bridge"); b.call("step")'],
    ['the module handed to other code', 'local b=require("bridge"); other.install(b); b.call("step")'],
    ['a getter for the module, after a helper replaced its member', 'local b=require("bridge"); local function stub(m) m.call=nil end; stub(b); local function api() return b end; api().call("step")'],
  ])('withdraws a module member after %s', (_name, source) => {
    const call = analyzeLua(source).calls.find(call => /\.call$/.test(call.callee))!;
    expect(call.importedModule).toBeUndefined();
  });

  it('keeps a module whose function\'s result a join loses', () => {
    // The result is another object than the module: losing it to a join, then writing
    // under keys the analysis can't read, leaves the module's members as they were.
    const call = analyzeLua(`local Core = require("core")
function step(self, x)
  local view = Core.call("battle.view").view or {}
  self.items[x] = view
  Core.call("battle.command")
end`).calls.filter(call => call.callee === 'Core.call').at(-1)!;
    expect(call).toMatchObject({ importedModule: 'core', resolvedCallee: 'call' });
  });

  it('keeps a module after its search path changes, and withdraws it when the searchers do', () => {
    const member = (setup: string) => analyzeLua(`${setup}\nlocal b = require("bridge")\nb.call("step")`).calls.find(call => call.callee === 'b.call')!;
    expect(member('package.path = "./?.lua;" .. package.path')).toMatchObject({ importedModule: 'bridge' });
    expect(member('package.searchers = {}').importedModule).toBeUndefined();
  });

  it('keeps a module whose own method is called on it', () => {
    expect(moduleCall('local b=require("bridge"); b:init(); b.call("step")', 'b.call')).toMatchObject({ importedModule: 'bridge', resolvedCallee: 'call' });
  });

  it('forwards no parameter from a closure kept beyond the call that made it', () => {
    const analysis = analyzeLua(head + `local lib=ffi.load("x")
local cached
local function send(op)
  cached = cached or function() lib.dispatch(op, "") end
  cached()
end
local function now(op) local run = function() lib.dispatch(op, "") end; run() end`);
    const [kept, local] = analysis.calls.filter(call => call.ffiSymbol === 'dispatch');
    expect(kept!.args[0]).not.toHaveProperty('capturedParameter');
    expect(local!.args[0]).toMatchObject({ capturedParameter: { index: 0 } });
  });
});

describe('files the analysis declines', () => {
  it('declines a file nested past what the walks follow, without throwing', () => {
    const source = 'local ffi=require "ffi"\nlocal s = ' + Array.from({ length: 3000 }, (_, i) => `"${i}"`).join(' .. ') + '\nffi.C.run()\n';
    expect(analyzeLua(source)).toMatchObject({ partial: true, calls: [] });
  });

  it('declines a file the parser could not read as a chunk', () => {
    // A string continued over a CRLF line ending is valid LuaJIT that tree-sitter-lua misreads.
    const source = 'local ffi = require("ffi")\r\nlocal lib = ffi.load("core")\r\nfunction tick()\r\n  ffi.C.puts("st\\\r\nlib.core_step", "")\r\nend\r\n';
    expect(symbols(source)).not.toContain('core_step');
  });

  it('declines nested loops that would take exponential work', () => {
    // Every loop re-converges on each entry, and each level resets what the level inside changes.
    const depth = 26;
    let source = 'local ffi=require "ffi"\nlocal x = 0\n';
    for (let i = 0; i < depth; i++) source += `for i${i} = 1, 2 do\nx = 0\n`;
    source += 'x = x + 1\nffi.C.run(x)\n' + 'end\n'.repeat(depth);
    expect(analyzeLua(source).partial).toBe(true);
  });

  it('settles a long chain of member writes', () => {
    let source = 'local ffi=require "ffi"\nlocal lib=ffi.load("x")\nlocal T={}\n';
    for (let i = 1; i < 150; i++) source += `local function f${i}() T.k${i} = T.k${i + 1} end\n`;
    source += 'local function f150() T.k150 = "x" end\nfunction tick() lib.core_step() end\n';
    const analysis = analyzeLua(source);
    expect(analysis.partial).toBeUndefined();
    expect(analysis.calls.filter(call => call.ffiSymbol).map(call => call.ffiSymbol)).toEqual(['core_step']);
  });
});

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

  it('resolves a parameter unconditionally rebound to a module as that module', () => {
    const analysis = analyzeLua(`function rebound(Bridge)
  Bridge = require("bridge")
  return Bridge.call("task.run")
end`);
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')).toMatchObject({ importedModule: 'bridge', resolvedCallee: 'call' });
  });

  it('does not resolve a captured parameter rebound to an unknown value as a module', () => {
    const analysis = analyzeLua(`function outer(Bridge)
  Bridge = other
  local function nested() return Bridge:call("task.run") end
  return nested()
end`);
    expect(analysis.calls.find(call => call.callee === 'Bridge:call')!.importedModule).toBeUndefined();
  });

  it('resolves a local that shadows a parameter as the module it requires', () => {
    const analysis = analyzeLua(`function outer(Bridge)
  local Bridge = require("bridge")
  return Bridge.call("task.run")
end`);
    expect(analysis.calls.find(call => call.callee === 'Bridge.call')!.importedModule).toBe('bridge');
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
    'local function core() return unknown() end',
    'local function core(name) return require(name) end',
    'local function core(require) return require("bridge") end',
    'local function core() if enabled then return require("bridge") end return require("other") end',
  ])('withholds a return that is no one module: %s', getter => {
    const analysis = analyzeLua(`${getter}\nfunction run_task() return core().call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core().call')!.importedModule).toBeUndefined();
  });

  it.each([
    ['a call before the return', 'local function core() mutate(); return require("bridge") end', 'call'],
    ['a return on one branch', 'local function core() if enabled then return require("bridge") end end', 'call'],
    ['a global function', 'function core() return require("bridge") end', 'call'],
    ['the first of several values', 'local function core() return require("bridge"), other end', 'call'],
    ['a module function\'s result', 'local function core() return require("bridge").load() end', 'load().call'],
  ])('follows what a function returns through %s', (_name, getter, member) => {
    const analysis = analyzeLua(`${getter}\nfunction run_task() return core().call("task.run") end`);
    expect(analysis.calls.find(call => call.callee === 'core().call')).toMatchObject({ importedModule: 'bridge', resolvedCallee: member });
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

});

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
    // The analysis's budget grows with the file: a round per link would run out of it and be declined.
    const analysis = analyzeLua(source);
    expect(analysis.partial).toBeUndefined();
    expect(analysis.calls.flatMap(call => call.ffiSymbol ? [call.ffiSymbol] : [])).toEqual(['native_ping']);
  });

  it('scales linearly with locals and functions', () => {
    const sourceOf = (k: number): string => {
      let source = '';
      for (let i = 0; i < k; i++) source += `local v${i} = {}\n`;
      for (let i = 0; i < k; i++) source += `local function f${i}(x) if x then return v${i} end return nil end\n`;
      return source;
    };
    // A budget in proportion to the file declines an analysis that grows faster than the file does.
    expect(analyzeLua(sourceOf(4000)).partial).toBeUndefined();
  });
});
