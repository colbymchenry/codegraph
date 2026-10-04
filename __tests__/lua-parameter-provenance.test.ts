import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('Lua parameter provenance across nested functions and assignments', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-param-review-')); });
  afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(dir, { recursive: true, force: true }); });

  async function index(source: string) {
    fs.writeFileSync(path.join(dir, 'bridge.lua'), `local Bridge = {}
function Bridge.call(op) return op end
return Bridge`);
    fs.writeFileSync(path.join(dir, 'caller.lua'), source);
    // The parameter rule serves the Lua/Rust bridge, so only such projects use it.
    fs.writeFileSync(path.join(dir, 'lib.rs'), 'pub fn native() {}\n');
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  }

  const callees = (name: string) => {
    const node = cg!.getNodesByName(name).find(node => node.kind === 'function' || node.kind === 'method')!;
    return cg!.getCallees(node.id).map(entry => entry.node.name);
  };

  it('does not resolve a colon-call parameter as the shadowed file import', async () => {
    await index(`local Bridge = require("bridge")
function shadowed(Bridge) return Bridge:call("task.run") end
function known() return Bridge:call("task.run") end`);
    expect(callees('shadowed')).not.toContain('call');
    expect(callees('known')).toContain('call');
  });

  it('does not resolve a captured parameter as the file import', async () => {
    await index(`local Bridge = require("bridge")
function outer(Bridge)
  local function nested() return Bridge.call("task.run") end
  return nested()
end`);
    expect(callees('nested')).not.toContain('call');
  });

  it('resolves a parameter after it is unconditionally rebound to a module', async () => {
    await index(`local Bridge = require("bridge")
function rebound(Bridge)
  Bridge = require("bridge")
  return Bridge.call("task.run")
end`);
    expect(callees('rebound')).toContain('call');
  });

  it('does not resolve unknown or branch-merged parameter rebindings as the file import', async () => {
    await index(`local Bridge = require("bridge")
function unknown(Bridge)
  Bridge = other
  return Bridge.call("task.run")
end
function captured_unknown(Bridge)
  Bridge = other
  local function nested_unknown() return Bridge.call("task.run") end
  return nested_unknown()
end
function branch_merged(Bridge)
  if enabled then Bridge = require("bridge") else Bridge = other end
  return Bridge.call("task.run")
end`);
    for (const caller of ['unknown', 'captured_unknown', 'nested_unknown', 'branch_merged']) {
      expect(callees(caller)).not.toContain('call');
    }
  });
});
