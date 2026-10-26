/**
 * A Lua `local` belongs to its chunk: another file can never name it.
 *
 * kong's spec helpers re-bind busted's globals (`local it = it`,
 * `local assert = require "luassert"`); every other spec file's `it(…)` and
 * `assert(…)` linked to them — 4,166 and 1,234 times. koreader's
 * `local ipairs = ipairs` in one module took the whole project's `ipairs`.
 * A global function stays reachable.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('Lua locals', () => {
  it('are invisible outside their file; globals are not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-local-'));
    roots.push(root);
    const files: Record<string, string> = {
      'spec/helpers.lua': `local it = it
local ipairs = ipairs
local function helper() return 1 end
function global_helper() return 2 end
return {}
`,
      'spec/plugin_spec.lua': `describe("plugin", function()
  it("works", function()
    for _, v in ipairs({ 1 }) do helper(v) end
    global_helper()
  end)
end)
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targets = cg
        .getOutgoingEdgesFrom(cg.getNodesInFile('spec/plugin_spec.lua').map((n) => n.id), ['calls'])
        .map((e) => cg.getNode(e.target)!.name)
        .sort();
      expect(targets).toEqual(['global_helper']);
    } finally {
      cg.close();
    }
  });
});
