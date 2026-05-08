import type { EvalResult } from './types.js';

export const PASS_THRESHOLD = 0.5;

export function scoreSearchNodes(
  caseId: string,
  expectedSymbols: string[],
  results: Array<{ node: { name: string }; score: number }>,
  latencyMs: number
): EvalResult {
  const expectedLower = expectedSymbols.map((s) => s.toLowerCase());
  const resultNames = results.map((r) => r.node.name.toLowerCase());

  const found: string[] = [];
  const missed: string[] = [];
  let firstRank = 0;

  for (let i = 0; i < expectedLower.length; i++) {
    const idx = resultNames.indexOf(expectedLower[i]);
    if (idx !== -1) {
      found.push(expectedSymbols[i]);
      if (firstRank === 0) firstRank = idx + 1;
    } else {
      missed.push(expectedSymbols[i]);
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const mrr = firstRank > 0 ? 1 / firstRank : 0;

  return {
    caseId,
    pass: recall >= PASS_THRESHOLD,
    recall,
    mrr,
    foundSymbols: found,
    missedSymbols: missed,
    latencyMs,
  };
}

export function scoreFindRelevantContext(
  caseId: string,
  expectedSymbols: string[],
  subgraph: { nodes: Map<string, { name: string }>; edges: unknown[]; roots: string[] },
  latencyMs: number
): EvalResult {
  const expectedLower = new Set(expectedSymbols.map((s) => s.toLowerCase()));
  const nodeNames = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    nodeNames.add(node.name.toLowerCase());
  }

  const found: string[] = [];
  const missed: string[] = [];

  for (const sym of expectedSymbols) {
    if (nodeNames.has(sym.toLowerCase())) {
      found.push(sym);
    } else {
      missed.push(sym);
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;

  return {
    caseId,
    pass: recall >= PASS_THRESHOLD,
    recall,
    mrr: 0,
    foundSymbols: found,
    missedSymbols: missed,
    nodeCount,
    edgeCount,
    edgeDensity,
    latencyMs,
  };
}
