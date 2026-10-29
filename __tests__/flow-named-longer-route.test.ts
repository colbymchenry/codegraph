/**
 * Explore's Flow keeps a named symbol even when a SHORTER route reaches it
 * first (#2970).
 *
 * `walkCalls` used to keep one route per node: once a node was reached, only a
 * better route of the SAME length replaced it. On the issue's shape
 *
 *   entry → mid1 → deep → leaf
 *   entry → mid2 → leaf
 *
 * `leaf` is first reached at depth 2 through the unnamed `mid2`, so the route
 * that actually passes the named `deep` (depth 3, one more named symbol) was
 * rejected for being longer and `leaf` fell off the Flow.
 *
 * The walk now keeps a route per (node, named-count, bridge-streak) STATE, and
 * the chain that visits the MOST named symbols wins — the longer one only
 * breaks a tie. Flow stays a single longest-chain answer, never an all-paths
 * listing, and the one-unnamed-bridge budget is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

const FILES: Record<string, string> = {
  // The issue's reproduction, verbatim.
  'src/a.ts': `export function entry() { mid1(); mid2(); }
export function mid1() { deep(); }
export function mid2() { leaf(); }
export function deep() { leaf(); }
export function leaf() { return 1; }
`,
  // Two chains the query names: one short and fully named, one longer with
  // fewer named symbols (two unnamed bridges). Named coverage must win.
  'src/hops.ts': `export function boot() { load(); }
export function load() { parse(); }
export function parse() { save(); }
export function save() { return 1; }

export function push() { halt(); }
function halt() { spool(); }
export function spool() { yieldRow(); }
function yieldRow() { flush(); }
export function flush() { return 1; }
`,
  // One bridge connects, two consecutive bridges do not: the budget is intact.
  'src/budget.ts': `export function alpha() { middle(); }
function middle() { omega(); }
export function omega() { return 1; }

export function origin() { relay(); }
function relay() { linker(); }
function linker() { dest(); }
export function dest() { return 1; }
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

/** The lead chain, as bare names. */
function leadChain(query: string): string[] {
  const flow = resolveNamedSymbolFlow(cg, query);
  return (flow.chains[0]?.steps ?? []).map((s) => s.node.name);
}

/** The numbered lines of explore's Flow section. */
async function exploreFlow(query: string): Promise<string[]> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  const text = res.content?.[0]?.text ?? '';
  const start = text.indexOf('**Flow (call path among the symbols you queried)**');
  if (start < 0) return [];
  const section = text.slice(start).split(/\n\n(?=\*\*|>)/)[0] ?? '';
  return section.split(/\r?\n/).filter((line) => /^\d+\. /.test(line));
}

describe('a named symbol reached first by a shorter route stays on the Flow (#2970)', () => {
  it('walks through the named deep to reach leaf, one unnamed bridge', () => {
    expect(leadChain('entry deep leaf')).toEqual(['entry', 'mid1', 'deep', 'leaf']);
  });

  it("codegraph_explore's Flow section lists all three named symbols", async () => {
    const lines = await exploreFlow('entry deep leaf');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('entry');
    expect(lines[2]).toContain('deep');
    expect(lines[3]).toContain('leaf');
  });
});

describe('named coverage ranks above raw length', () => {
  it('picks the shorter, fully named chain over a longer chain with fewer names', () => {
    // `boot → load → parse → save` names four; `push → halt → spool → yieldRow
    // → flush` is one hop longer but names only three. Coverage wins.
    expect(leadChain('boot load parse save push spool flush')).toEqual([
      'boot',
      'load',
      'parse',
      'save',
    ]);
  });

  it('leaves a chain with no unnamed intermediate exactly as it was', () => {
    expect(leadChain('boot load parse save')).toEqual(['boot', 'load', 'parse', 'save']);
  });
});

describe('the bridge budget still holds', () => {
  it('connects across one unnamed symbol', () => {
    expect(leadChain('alpha omega')).toEqual(['alpha', 'middle', 'omega']);
  });

  it('does not connect across two consecutive unnamed symbols', () => {
    expect(resolveNamedSymbolFlow(cg, 'origin dest').chains).toHaveLength(0);
  });
});
