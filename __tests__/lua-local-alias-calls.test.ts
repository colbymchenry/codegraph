/**
 * A bare Lua call through a `local` alias reaches what the alias names. Kong
 * localizes everything it calls — `local splitn = require("kong.tools.string").splitn`,
 * `local check_phase = phase_checker.check`, `local fmt = string.format`,
 * `local type = type` — so its calls stopped at a same-file variable: 8,000 of
 * them, most for the standard library. A module member is followed to its
 * function, including one the module hands out under another name
 * (`return { check = check_phase }`) or re-exports from a module of its own
 * (`unindent = misc.unindent`); the standard library and outside modules are
 * no edge at all.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-alias-'));
  const files: Record<string, string> = {
    'kong/tools/string.lua': `local _M = {}

function _M.splitn(value)
  return value
end

return _M
`,
    'kong/pdk/phases.lua': `local function check_phase(accepted)
  return accepted
end

return {
  check = check_phase,
}
`,
    'kong/handler.lua': `local type = type
local fmt = string.format
local splitn = require("kong.tools.string").splitn
local phase_checker = require "kong.pdk.phases"
local check_phase = phase_checker.check
local cjson_encode = require("cjson").encode

local function run(v)
  check_phase("access")
  if type(v) ~= "string" then
    error(fmt("bad %s", v))
  end
  return splitn(v), cjson_encode(v)
end

return { run = run }
`,
    'spec/internal/misc.lua': `local function unindent(s)
  return s
end

return { unindent = unindent }
`,
    'spec/helpers.lua': `local misc = require("spec.internal.misc")

return {
  unindent = misc.unindent,
}
`,
    'spec/handler_spec.lua': `local helpers = require "spec.helpers"
local unindent = helpers.unindent

describe("handler", function()
  it("runs", function()
    unindent("a")
  end)
end)
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file: qualified name` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${t.filePath}: ${t.qualifiedName}`;
    })
    .sort();
}

describe('bare Lua calls through a local alias', () => {
  it('reach the module function the alias names, and nothing for the standard library', () => {
    expect(callsFrom('kong/handler.lua')).toEqual([
      'kong/pdk/phases.lua: check_phase',
      'kong/tools/string.lua: _M::splitn',
    ]);
  });

  it('follow a module that re-exports another module’s member', () => {
    expect(callsFrom('spec/handler_spec.lua')).toEqual(['spec/internal/misc.lua: unindent']);
  });
});
