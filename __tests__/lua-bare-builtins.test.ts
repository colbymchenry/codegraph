/**
 * A bare Lua call cannot reach a table's method — `function M.error()` is
 * `M.error(…)`, never `error(…)` — and a Lua global (`ipairs`, `error`,
 * busted's `setup`) is Lua's unless the file defines its own. Telescope's
 * 120 `for _, v in ipairs(…)` went to a linked list's `ipairs` method,
 * kong's 118 `error(…)` to its response PDK's `error`. A function's own
 * `local get_query = kong.request.get_query` alias still reaches the method
 * of the table named after its holder.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-builtins-'));
  const files: Record<string, string> = {
    'lua/app/linked_list.lua': `local LinkedList = {}

function LinkedList:ipairs()
  return function() end
end

return LinkedList
`,
    'lua/app/response.lua': `local _RESPONSE = {}

function _RESPONSE.error(status)
  return status
end

return _RESPONSE
`,
    'lua/app/request.lua': `local _REQUEST = {}

function _REQUEST.get_query()
  return {}
end

return _REQUEST
`,
    'lua/app/handler.lua': `local M = {}

function M.run(items)
  for _, v in ipairs(items) do
    if not v then
      error("missing")
    end
  end
  local get_query = kong.request.get_query
  return get_query()
end

return M
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

const callsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName).sort();
};

describe('bare Lua calls', () => {
  it('are Lua’s globals, never a table’s method of that name', () => {
    const calls = callsFrom('lua/app/handler.lua');
    expect(calls).not.toContain('LinkedList::ipairs');
    expect(calls).not.toContain('_RESPONSE::error');
  });

  it('still follow a function’s own alias of a host table’s member', () => {
    expect(callsFrom('lua/app/handler.lua')).toContain('_REQUEST::get_query');
  });
});
