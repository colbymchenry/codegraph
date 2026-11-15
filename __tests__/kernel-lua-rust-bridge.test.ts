/**
 * The LuaJIT → Rust bridge builds the same graph whichever extractor indexed
 * the project.
 *
 * Lua and Rust are routed to the native kernel by default, so a release
 * extracts both with it, and with the wasm extractor only where the kernel is
 * missing or switched off, or defers a file that parses with errors. The
 * bridge parses each file again with the wasm grammars on either path, but
 * what it joins that analysis to comes from the extractor that ran: the files'
 * languages, the functions and their positions, and the Lua calls left for
 * resolution. So this indexes one project on each path and requires the same
 * graph from both: every node and edge, the bridge's operation, FFI, transport
 * and getter edges among them, and the callers and impact they answer.
 *
 * The kernel arm is skipped when no kernel binary is staged;
 * CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { kernelRoutes, resetKernelForTests, tryKernelExtract } from '../src/extraction/kernel';
import type { Edge, Node } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const FILES: Record<string, string> = {
  'native/Cargo.toml': '[package]\nname = "native"\nversion = "0.1.0"\n\n[lib]\ncrate-type = ["cdylib"]\n',
  'native/src/lib.rs': `pub struct Engine;

impl Engine {
    pub fn run(&mut self, request: &str) {}
    pub fn read(&mut self, request: &str) {}
    pub fn cleanup(&mut self, request: &str) {}

    pub fn handler(op: &str) -> Option<fn(&mut Engine, &str)> {
        Some(match op {
            "task.run" => Engine::run,
            "task.read" => Engine::read,
            "task.cleanup" => Engine::cleanup,
            _ => return None,
        })
    }

    pub fn dispatch(&mut self, op: &str, request: &str) {
        if let Some(handler) = Engine::handler(op) {
            handler(self, request);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wire_send(op: &str, request: &str) {
    let mut engine = Engine;
    engine.dispatch(op, request);
}

#[no_mangle]
pub extern "C" fn native_ping() {}

#[unsafe(export_name = "native_version")]
pub extern "C" fn version_impl() -> u32 {
    1
}
`,
  'scripts/bridge.lua': `local ffi = require("ffi")
ffi.cdef[[
  void wire_send(const char *op, const char *request);
  void native_ping(void);
  unsigned int version(void) asm("native_version");
]]
local library = ffi.load("native")
local Bridge = {}

local function native(op, request)
  return library.wire_send(op, request)
end

function Bridge.call(op, request)
  native("task.cleanup", "{}")
  return native(op, request)
end

function Bridge.ping()
  return library.native_ping()
end

function Bridge.version()
  return ffi.C.version()
end

return Bridge
`,
  'scripts/caller.lua': `local Bridge = require("bridge")
local function core() return require("bridge") end
local send = Bridge.call
local READ = "task.read"

function run_task() return Bridge.call("task.run", "{}") end
function read_task() return send(READ, "{}") end
function derived_task() return core().call("task.run", "{}") end
function dynamic_task(op) return Bridge.call(op, "{}") end
`,
};

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

interface Indexed {
  /** Every node, by file, kind, qualified name and span: ids and timestamps left out. */
  nodes: string[];
  /** Every edge between those nodes, with its kind, position, provenance and metadata. */
  edges: string[];
  /** The bridge's own edges, in the same form. */
  bridge: string[];
  /** Callers, callees and impact the bridge answers, by name. */
  answers: Record<string, string[]>;
}

const nodeKey = (n: Node) => `${n.filePath}|${n.kind}|${n.qualifiedName}|${n.startLine}:${n.startColumn}-${n.endLine}:${n.endColumn}`;

function edgeKey(e: Edge, byId: Map<string, Node>): string {
  const meta = e.metadata ? JSON.stringify(e.metadata, Object.keys(e.metadata).sort()) : '';
  return `${nodeKey(byId.get(e.source)!)} -${e.kind}@${e.line ?? ''}:${e.column ?? ''}/${e.provenance ?? ''}-> ${nodeKey(byId.get(e.target)!)} ${meta}`;
}

async function indexOn(arm: 'kernel' | 'wasm'): Promise<Indexed> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-bridge-${arm}-`));
  let cg: CodeGraph | undefined;
  try {
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    delete process.env.CODEGRAPH_KERNEL_LANGS;
    if (arm === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    resetKernelForTests();
    if (arm === 'kernel') {
      // The default routing a release ships, and no file left to wasm.
      expect(kernelRoutes('lua') && kernelRoutes('rust')).toBe(true);
      for (const [rel, content] of Object.entries(FILES)) {
        const language = rel.endsWith('.lua') ? 'lua' : rel.endsWith('.rs') ? 'rust' : null;
        if (language) expect(tryKernelExtract(rel, content, language), `${rel} deferred to wasm`).not.toBeNull();
      }
    } else {
      expect(kernelRoutes('lua') || kernelRoutes('rust')).toBe(false);
    }
    cg = await CodeGraph.init(root, { index: true });
    const nodes = cg.getNodesInFiles(cg.getFiles().map((f) => f.path));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = cg.getOutgoingEdgesFrom([...byId.keys()]);
    const fn = (name: string, language: string) =>
      nodes.find((n) => n.name === name && n.language === language && (n.kind === 'function' || n.kind === 'method'))!;
    const names = (rows: Array<{ node: Node }>) => [...new Set(rows.map((r) => r.node.name))].sort();
    const answers: Record<string, string[]> = {};
    for (const lua of ['run_task', 'read_task', 'derived_task', 'dynamic_task']) answers[`callees ${lua}`] = names(cg.getCallees(fn(lua, 'lua').id, 8));
    for (const rust of ['run', 'read', 'cleanup', 'native_ping', 'version_impl', 'wire_send']) answers[`callers ${rust}`] = names(cg.getCallers(fn(rust, 'rust').id, 8));
    answers['impact run'] = [...new Set([...cg.getImpactRadius(fn('run', 'rust').id, 8).nodes.values()].map((n) => n.name))].sort();
    return {
      nodes: [...new Set(nodes.map(nodeKey))].sort(),
      edges: [...new Set(edges.map((e) => edgeKey(e, byId)))].sort(),
      bridge: edges
        .filter((e) => String(e.metadata?.synthesizedBy ?? '').startsWith('lua-'))
        .map((e) => edgeKey(e, byId))
        .sort(),
      answers,
    };
  } finally {
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetKernelForTests();
  }
}

describe('the LuaJIT → Rust bridge on each extraction path', { timeout: 120_000 }, () => {
  let wasm: Indexed;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['lua', 'rust']);
    wasm = await indexOn('wasm');
  });

  afterAll(() => {
    resetKernelForTests();
  });

  it('builds the bridge from wasm extraction', () => {
    const kinds = wasm.bridge.map((e) => /"synthesizedBy":"([^"]+)"/.exec(e)?.[1]);
    expect(new Set(kinds)).toEqual(new Set(['lua-rust-operation', 'lua-rust-ffi', 'lua-module-member']));
    expect(wasm.bridge.some((e) => e.includes('"transportOnly":true'))).toBe(true);
    expect(wasm.answers['callees run_task']).toEqual(expect.arrayContaining(['run', 'cleanup']));
    expect(wasm.answers['callees run_task']).not.toContain('read');
    expect(wasm.answers['callees read_task']).toEqual(expect.arrayContaining(['read', 'cleanup']));
    expect(wasm.answers['callees read_task']).not.toContain('run');
    expect(wasm.answers['callees derived_task']).toContain('run');
    expect(wasm.answers['callees dynamic_task']).not.toContain('run');
    expect(wasm.answers['callers run']).toEqual(expect.arrayContaining(['run_task', 'derived_task']));
    expect(wasm.answers['callers run']).not.toContain('read_task');
    expect(wasm.answers['callers native_ping']).toContain('ping');
    expect(wasm.answers['callers version_impl']).toContain('version');
    expect(wasm.answers['callers wire_send']).toContain('native');
    expect(wasm.answers['impact run']).not.toContain('read_task');
  });

  it.runIf(kernelAvailable)('builds the same graph from native kernel extraction', async () => {
    const kernel = await indexOn('kernel');
    expect(kernel.nodes).toEqual(wasm.nodes);
    expect(kernel.bridge).toEqual(wasm.bridge);
    expect(kernel.edges).toEqual(wasm.edges);
    expect(kernel.answers).toEqual(wasm.answers);
  });
});
