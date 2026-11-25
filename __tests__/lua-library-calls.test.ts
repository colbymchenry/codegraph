/**
 * A Lua call through a standard or host library table (`string`, `table`,
 * `vim`, `ngx`, busted's `assert` …), or a string method on a value
 * (`s:find(…)`), is the library's — never the one project method that shares
 * the name. kong's specs sent `assert.truthy(…)` to a condition helper 987
 * times; telescope's `line:find(…)` went to its picker's `find`. A method the
 * project defines on the table itself (kong patches `ngx.sleep`) keeps it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-library-'));
  const files: Record<string, string> = {
    'spec/helpers/wait.lua': `local COND = {}
function COND:truthy(v)
  return v
end
return COND
`,
    'lua/picker.lua': `local Picker = {}
function Picker:find(text)
  return text
end
return Picker
`,
    'lua/patches.lua': `function ngx.sleep(s)
  return s
end
`,
    'lua/widget.lua': `local Widget = {}
function Widget:refresh()
  return true
end
return Widget
`,
    'spec/run_spec.lua': `local function run(line, w)
  assert.truthy(line)
  local at = line:find("x")
  ngx.sleep(1)
  w:refresh()
  return at
end
return run
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

describe('Lua library calls', () => {
  it('stay the library’s; a project method keeps a plain receiver and a patched library function', () => {
    const ids = cg.getNodesInFile('spec/run_spec.lua').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).not.toContain('COND::truthy');
    expect(targets).not.toContain('Picker::find');
    expect(targets).toContain('Widget::refresh');
    expect(targets.some((t) => t.endsWith('sleep'))).toBe(true);
  });
});
