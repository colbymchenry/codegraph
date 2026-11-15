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
 * graph from both: every node and edge, the bridge's FFI edges among them, and
 * the callers and callees they answer.
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
  'native/src/lib.rs': `pub struct Router;

fn build() -> Router {
    Router
}

#[no_mangle]
pub extern "C" fn native_ping() {}

#[unsafe(export_name = "native_version")]
pub extern "C" fn version_impl() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn router_new() -> *mut Router {
    Box::into_raw(Box::new(build()))
}

#[no_mangle]
pub unsafe extern "C" fn router_free(router: *mut Router) {
    drop(Box::from_raw(router));
}
`,
  'scripts/bridge.lua': `local ffi = require("ffi")
ffi.cdef[[
  void native_ping(void);
  unsigned int version(void) asm("native_version");
]]
local library = ffi.load("native")
local Bridge = {}

function Bridge.ping()
  return library.native_ping()
end

function Bridge.version()
  return ffi.C.version()
end

return Bridge
`,
  'scripts/cdefs.lua': `local ffi = require("ffi")
ffi.cdef[[ void *router_new(void); void router_free(void *router); ]]
local load
do
  function load(name)
    local ok, lib = pcall(ffi.load, name)
    if ok then return lib end
    return nil, "not found"
  end
end
local clib = load("native")
return {
  clib = clib,
  free = function(router) clib.router_free(router) end,
}
`,
  'scripts/router.lua': `local cdefs = require("cdefs")
local clib = cdefs.clib
local Router = {}

function Router.new()
  return clib.router_new()
end

return Router
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
    for (const lua of ['ping', 'version', 'new']) answers[`callees ${lua}`] = names(cg.getCallees(fn(lua, 'lua').id, 8));
    for (const rust of ['native_ping', 'version_impl', 'router_new', 'router_free', 'build']) answers[`callers ${rust}`] = names(cg.getCallers(fn(rust, 'rust').id, 8));
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
    expect(new Set(wasm.bridge.map((e) => /"synthesizedBy":"([^"]+)"/.exec(e)?.[1]))).toEqual(new Set(['lua-rust-ffi']));
    expect(wasm.answers['callees ping']).toContain('native_ping');
    expect(wasm.answers['callees version']).toContain('version_impl');
    expect(wasm.answers['callees new']).toEqual(expect.arrayContaining(['router_new', 'build']));
    expect(wasm.answers['callers native_ping']).toContain('ping');
    expect(wasm.answers['callers version_impl']).toContain('version');
    expect(wasm.answers['callers router_new']).toContain('new');
    expect(wasm.answers['callers router_free']).toContain('cdefs.lua');
    expect(wasm.answers['callers build']).toEqual(expect.arrayContaining(['router_new', 'new']));
  });

  it.runIf(kernelAvailable)('builds the same graph from native kernel extraction', async () => {
    const kernel = await indexOn('kernel');
    expect(kernel.nodes).toEqual(wasm.nodes);
    expect(kernel.bridge).toEqual(wasm.bridge);
    expect(kernel.edges).toEqual(wasm.edges);
    expect(kernel.answers).toEqual(wasm.answers);
  });
});
