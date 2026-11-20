/**
 * Explore's Flow keeps a named symbol that a shorter route reaches first (#2970).
 *
 * The named walk kept one route per node, replaced only by a better one of the
 * same length. In the issue's
 *
 *   entry → mid1 → deep → leaf
 *   entry → mid2 → leaf
 *
 * `leaf` was reached first through the unnamed `mid2`, so the route through the
 * named `deep` was turned away for being longer, and `entry deep leaf` got the
 * Flow `entry → mid1 → deep`, without `leaf`. A node now keeps every route no
 * other route to it beats on depth, named symbols and bridge streak together.
 *
 * What stays: the one-unnamed-bridge budget, the deepest-sink choice, and a
 * route never going round a cycle, which a walk that kept routes by named
 * count alone would do: `ping → pong → ping → pong → done` counts both twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

const FILES: Record<string, string> = {
  // The issue's example.
  'src/a.ts': `export function entry() { mid1(); mid2(); }
export function mid1() { deep(); }
export function mid2() { leaf(); }
export function deep() { leaf(); }
export function leaf() { return 1; }
`,
  // A named step past two unnamed ones on the way: still out of reach.
  'src/budget.ts': `export function origin() { relay(); hop(); }
function relay() { linker(); }
function linker() { dest(); }
function hop() { dest(); }
export function dest() { return 1; }
`,
  // Two named functions calling each other on the way to a third.
  'src/cycle.ts': `export function ping(n: number): number { return n > 0 ? pong(n - 1) : done(); }
export function pong(n: number): number { return ping(n); }
export function done(): number { return 0; }
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flow-longer-route-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The lead chain, as names. */
const lead = (query: string): string[] => (resolveNamedSymbolFlow(cg, query).chains[0]?.steps ?? []).map((s) => s.node.name);

describe('a named symbol a shorter route reaches first (#2970)', () => {
  it('stays on the Flow, through the named step', () => {
    expect(lead('entry deep leaf')).toEqual(['entry', 'mid1', 'deep', 'leaf']);
  });

  it("is in codegraph_explore's Flow section", async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'entry deep leaf' });
    const text = res.content?.[0]?.text ?? '';
    const flow = text.slice(text.indexOf('**Flow (call path among the symbols you queried)**'));
    expect(flow).toMatch(
      /^\*\*Flow[^\n]*\n\n1\. entry \(src\/a\.ts:1\)\n\s+↓ calls\n2\. mid1 \(src\/a\.ts:2\)\n\s+↓ calls\n3\. deep \(src\/a\.ts:4\)\n\s+↓ calls\n4\. leaf \(src\/a\.ts:5\)\n\n/,
    );
  });

  it('still reads one unnamed step, and no further', () => {
    expect(lead('origin dest')).toEqual(['origin', 'hop', 'dest']);
    expect(lead('entry leaf')).toEqual(['entry', 'mid2', 'leaf']);
  });

  it('never goes round a cycle', () => {
    // As on main: the deepest route that passes each node once.
    expect(lead('ping pong done')).toEqual(['pong', 'ping', 'done']);
    const chains = resolveNamedSymbolFlow(cg, 'ping pong done', { maxChains: 3 }).chains;
    for (const chain of chains) {
      const ids = chain.steps.map((s) => s.node.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
