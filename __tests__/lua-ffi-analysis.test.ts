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
