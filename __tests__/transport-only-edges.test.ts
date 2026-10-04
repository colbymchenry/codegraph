import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import type { Edge, Node } from '../src/types';
import { GraphTraverser } from '../src/graph/traversal';
import { isTransportEdge } from '../src/graph/transport-edges';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { buildNode } from '../src/ui-server/api/node';
import { buildFileCode } from '../src/ui-server/api/filecode';
import { ToolHandler } from '../src/mcp/tools';

describe('transport hops are boundaries that walks show but never pass through', () => {
  let dir: string;
  let cg: CodeGraph;
  let traverser: GraphTraverser;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-transport-'));
    fs.writeFileSync(path.join(dir, 'graph.ts'), '');
    cg = CodeGraph.initSync(dir);
    traverser = new GraphTraverser(cg['queries']);
    const ids = ['issueCommand', 'readSnapshot', 'dynamicCaller', 'sharedWrapper', 'abiExport',
      'jsonDispatcher', 'commandHandler', 'snapshotHandler', 'loadCatalog', 'cleanup', 'audit'];
    for (const id of ids) {
      const node: Node = { id, name: id, qualifiedName: id, kind: 'function',
        filePath: 'graph.ts', language: 'typescript', startLine: 1, endLine: 1,
        startColumn: 0, endColumn: 1, updatedAt: Date.now() };
      cg['queries'].insertNode(node);
    }
    const operation = { synthesizedBy: 'lua-rust-operation', nativeExport: 'abiExport' };
    const edges: Edge[] = [
      ...['issueCommand', 'readSnapshot', 'dynamicCaller'].map(source => ({ source, target: 'sharedWrapper', kind: 'calls' as const })),
      { source: 'sharedWrapper', target: 'abiExport', kind: 'references', metadata: { transportOnly: true } },
      { source: 'abiExport', target: 'jsonDispatcher', kind: 'calls' },
      { source: 'jsonDispatcher', target: 'commandHandler', kind: 'calls' },
      { source: 'jsonDispatcher', target: 'snapshotHandler', kind: 'calls' },
      { source: 'issueCommand', target: 'commandHandler', kind: 'calls', provenance: 'heuristic', metadata: operation },
      { source: 'readSnapshot', target: 'snapshotHandler', kind: 'calls', provenance: 'heuristic', metadata: operation },
      // Code behind the entry, shared by every operation or called by one handler.
      { source: 'jsonDispatcher', target: 'audit', kind: 'calls' },
      { source: 'commandHandler', target: 'audit', kind: 'calls' },
      // Known wrapper side effects remain real calls, independent of transport.
      { source: 'sharedWrapper', target: 'loadCatalog', kind: 'calls' },
      { source: 'sharedWrapper', target: 'cleanup', kind: 'references' },
    ];
    edges.forEach((edge, i) => cg['queries'].insertEdge({ ...edge, line: i + 1 }));
  });

  afterEach(() => { cg?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('keeps raw ABI evidence and usages inspectable', () => {
    expect(cg.getOutgoingEdges('sharedWrapper').some(e => e.target === 'abiExport')).toBe(true);
    expect(cg.findUsages('abiExport').some(x => x.node.id === 'sharedWrapper')).toBe(true);
  });

  it('shows transport on viewer rails beside the semantic calls', async () => {
    type NodeView = {
      incoming: { items: Array<{ node: { id: string } }>; total: number };
      outgoing: { items: Array<{ node: { id: string } }>; total: number };
    };
    const wrapper = await buildNode(cg, dir, 'sharedWrapper') as NodeView;
    expect(wrapper.outgoing.items.map(x => x.node.id).sort()).toEqual(['abiExport', 'cleanup', 'loadCatalog']);
    expect(wrapper.outgoing.total).toBe(3);
    expect(wrapper.incoming.items.map(x => x.node.id).sort()).toEqual(['dynamicCaller', 'issueCommand', 'readSnapshot']);
    const native = await buildNode(cg, dir, 'abiExport') as NodeView;
    expect(native.incoming.items.map(x => x.node.id)).toEqual(['sharedWrapper']);
    expect(native.incoming.total).toBe(1);
  });

  it('ends forward paths at the entry and starts backward ones only there', () => {
    const callees = cg.getCallees('issueCommand', 10).map(x => x.node.id);
    expect(callees).toEqual(expect.arrayContaining(
      ['commandHandler', 'sharedWrapper', 'loadCatalog', 'cleanup', 'abiExport', 'audit']));
    for (const behind of ['jsonDispatcher', 'snapshotHandler']) expect(callees).not.toContain(behind);
    expect(cg.getCallees('dynamicCaller', 10).map(x => x.node.id)).not.toContain('commandHandler');
    const callers = cg.getCallers('snapshotHandler', 10).map(x => x.node.id);
    expect(callers).toContain('readSnapshot');
    for (const other of ['issueCommand', 'dynamicCaller', 'sharedWrapper']) expect(callers).not.toContain(other);
    expect(cg.getCallers('abiExport', 10).map(x => x.node.id)).toEqual(
      expect.arrayContaining(['sharedWrapper', 'issueCommand', 'readSnapshot', 'dynamicCaller']));
    // Code behind the entry reaches the entry, and its own operation callers.
    const behind = cg.getCallers('audit', 10).map(x => x.node.id);
    expect(behind).toEqual(expect.arrayContaining(['commandHandler', 'jsonDispatcher', 'abiExport', 'issueCommand']));
    for (const transported of ['sharedWrapper', 'dynamicCaller', 'readSnapshot']) expect(behind).not.toContain(transported);
    expect(cg.findPath('issueCommand', 'snapshotHandler')).toBeNull();
    expect(cg.findPath('issueCommand', 'jsonDispatcher')).toBeNull();
    expect(cg.findPath('issueCommand', 'commandHandler')).not.toBeNull();
    expect(cg.findPath('issueCommand', 'cleanup')).not.toBeNull();
    expect(cg.findPath('issueCommand', 'abiExport')?.map(step => step.node.id))
      .toEqual(['issueCommand', 'sharedWrapper', 'abiExport']);
  });

  it('applies the same boundary to BFS, DFS, incoming traversal and impact', () => {
    for (const walk of [traverser.traverseBFS.bind(traverser), traverser.traverseDFS.bind(traverser)]) {
      const forward = walk('issueCommand');
      expect(forward.nodes.has('commandHandler')).toBe(true);
      expect(forward.nodes.has('abiExport')).toBe(true);
      expect(forward.nodes.has('jsonDispatcher')).toBe(false);
      expect(forward.nodes.has('snapshotHandler')).toBe(false);
      expect(forward.nodes.has('cleanup')).toBe(true);
      expect(walk('snapshotHandler', { direction: 'incoming' }).nodes.has('issueCommand')).toBe(false);
      expect(walk('jsonDispatcher', { direction: 'incoming' }).nodes.has('sharedWrapper')).toBe(false);
      expect(walk('abiExport', { direction: 'incoming' }).nodes.has('dynamicCaller')).toBe(true);
      // Within two hops only an expanded export would reach its dispatcher.
      const neighborhood = walk('sharedWrapper', { direction: 'both', maxDepth: 2 });
      expect(neighborhood.nodes.has('abiExport')).toBe(true);
      expect(neighborhood.nodes.has('jsonDispatcher')).toBe(false);
    }
    expect(cg.getImpactRadius('snapshotHandler', 10).nodes.has('issueCommand')).toBe(false);
    expect(cg.getImpactRadius('snapshotHandler', 10).nodes.has('readSnapshot')).toBe(true);
    expect(cg.getImpactRadius('jsonDispatcher', 10).nodes.has('abiExport')).toBe(true);
    expect(cg.getImpactRadius('jsonDispatcher', 10).nodes.has('dynamicCaller')).toBe(false);
    expect(cg.getImpactRadius('abiExport', 10).nodes.has('dynamicCaller')).toBe(true);
    expect(cg.getImpactRadius('loadCatalog', 10).nodes.has('issueCommand')).toBe(true);
  });

  it('keeps named and directed flow consistent with call reachability', () => {
    const directed = (to: string) => resolveNamedSymbolFlow(cg, `issueCommand ${to}`, {
      mode: 'directed', from: 'issueCommand', to, maxHops: 12,
    });
    expect(directed('commandHandler').chains.length).toBeGreaterThan(0);
    expect(directed('snapshotHandler').chains).toHaveLength(0);
    expect(resolveNamedSymbolFlow(cg, 'issueCommand snapshotHandler').chains).toHaveLength(0);
  });

  it('marks transport only with the explicit boolean marker, regardless of edge kind', () => {
    const edge: Edge = { source: 'a', target: 'b', kind: 'calls' };
    expect(isTransportEdge(edge)).toBe(false);
    expect(isTransportEdge({ ...edge, metadata: { transportOnly: false } })).toBe(false);
    expect(isTransportEdge({ ...edge, metadata: { transportOnly: 'true' } })).toBe(false);
    expect(isTransportEdge({ ...edge, metadata: { transportOnly: true } })).toBe(true);
  });
});

describe('transport evidence on public presentation surfaces', { timeout: 60000 }, () => {
  let dir: string;
  let cg: CodeGraph;
  let nativeId: string;
  let exportId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-transport-api-'));
    fs.writeFileSync(path.join(dir, 'native.rs'), `
#[no_mangle]
pub extern "C" fn wire_send(op: &str) {
  match op { "task.run" => run(), _ => () }
}
pub fn run() {}
#[no_mangle]
pub extern "C" fn native_ping() {}
`);
    fs.writeFileSync(path.join(dir, 'caller.lua'), `
local ffi = require("ffi")
local library = ffi.load("native")
local function native(op) return library.wire_send(op) end
function run_task() return native("task.run") end
function ping() return library.native_ping() end
`);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    nativeId = cg.getNodesByName('native').find(n => n.kind === 'function' && n.language === 'lua')!.id;
    exportId = cg.getNodesByName('wire_send').find(n => n.language === 'rust')!.id;
    expect(cg.getOutgoingEdges(nativeId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: exportId, kind: 'references', provenance: 'heuristic',
        metadata: expect.objectContaining({ transportOnly: true, synthesizedBy: 'lua-rust-ffi' }) }),
    ]));
  });

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('labels physical transport in MCP links beside operation links', async () => {
    const response = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'run_task native wire_send',
    });
    expect(response.isError).not.toBe(true);
    const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const operationHop = text.match(/run_task\s+→\s+run\s+\[dynamic: lua rust operation[^\n]*/)?.[0];
    expect(operationHop).toBeDefined();
    expect(operationHop).toContain('task.run');
    expect(operationHop).toContain('wire_send');
    expect(text).toMatch(/native\s+→\s+wire_send\s+\[transport: lua rust ffi via `wire_send`/);
    expect(cg.findUsages(exportId).some(usage => usage.node.id === nativeId)).toBe(true);
  });

  it('keeps file call groups and their displayed counts consistent, transport included', () => {
    const file = buildFileCode(cg, dir, 'caller.lua');
    const names = new Map(cg.getNodesInFile('caller.lua').map(node => [node.id, node.name]));
    const pairs = file.calls.items.map(call => `${names.get(call.ownerId)} -> ${call.relation.node.name}`);
    expect(pairs).toEqual(expect.arrayContaining(['run_task -> native', 'run_task -> run', 'ping -> native_ping', 'native -> wire_send']));
    expect(file.calls.total).toBe(file.calls.items.length);
    // Only run_task → native draws an arc; the ffi import is declared on its own call-site line.
    expect(file.intraFileCalls).toBe(1);
    expect(cg.findUsages(exportId).some(usage => usage.node.id === nativeId)).toBe(true);
  });
});
