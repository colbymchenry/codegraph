export const GRAPH_LIMITS = { maxNodes: 400, maxEdges: 2000 } as const;
export function graphBudget(nodes: number, edges: number) {
  return { nodes, edges, ...GRAPH_LIMITS, exceeded: nodes > GRAPH_LIMITS.maxNodes || edges > GRAPH_LIMITS.maxEdges };
}
export function oneHop(selected: string | null, edges: readonly { source: string; target: string }[], direction: 'in' | 'out' | 'both') {
  if (!selected) return null;
  const ids = new Set([selected]);
  for (const edge of edges) {
    if (direction !== 'in' && edge.source === selected) ids.add(edge.target);
    if (direction !== 'out' && edge.target === selected) ids.add(edge.source);
  }
  return ids;
}

export function programBudget(steps: number, links: number, root: readonly unknown[] | undefined) {
  let decisions = 0;
  const pending: unknown[] = [...(root ?? [])];
  while (pending.length) {
    const item = pending.pop() as { kind?: string; body?: unknown[]; arms?: { body?: unknown[] }[] };
    if (item.kind === 'fork') decisions++;
    if (item.body) pending.push(...item.body);
    for (const arm of item.arms ?? []) if (arm.body) pending.push(...arm.body);
  }
  return graphBudget(steps + decisions, links + decisions * 2);
}
