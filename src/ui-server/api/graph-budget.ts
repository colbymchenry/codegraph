/** 服务端与查看器保持同一图形计数：程序分支也是节点。 */
export interface WireGraphBudget { nodes: number; edges: number; maxNodes: number; maxEdges: number; exceeded: boolean }
export interface GraphBudgetMetadata { budget?: WireGraphBudget; detailsDeferred?: boolean; reason?: string | null }
export const GRAPH_BUDGET_REASON = '图形超过 400 个节点或 2000 条边，请缩小范围或使用列表继续浏览。';
export function graphBudget(nodes: number, edges: number): WireGraphBudget {
  return { nodes, edges, maxNodes: 400, maxEdges: 2000, exceeded: nodes > 400 || edges > 2000 };
}
export function programBudget(steps: number, links: number, root: readonly unknown[] | undefined): WireGraphBudget {
  let decisions = 0;
  const pending = [...(root ?? [])];
  while (pending.length) {
    const item = pending.pop() as { kind?: string; body?: unknown[]; arms?: { body?: unknown[] }[] };
    if (item.kind === 'fork') decisions++;
    if (item.body) pending.push(...item.body);
    for (const arm of item.arms ?? []) if (arm.body) pending.push(...arm.body);
  }
  return graphBudget(steps + decisions, links + decisions * 2);
}
export function enforceStepsBudget<T extends { steps: unknown[]; links: unknown[]; program: { root: readonly unknown[] } | null }>(payload: T) {
  const budget = programBudget(payload.steps.length, payload.links.length, payload.program?.root);
  return budget.exceeded
    ? { ...payload, steps: [], links: [], program: null, budget, detailsDeferred: true, reason: GRAPH_BUDGET_REASON }
    : { ...payload, budget };
}
export function enforceFlowBudget<T extends { flows: Array<{ hops: Array<{ node: { id: string } }>; boundary: unknown }> }>(payload: T) {
  const nodes = new Set(payload.flows.flatMap(flow => flow.hops.map(hop => hop.node.id))).size + payload.flows.filter(flow => flow.boundary).length;
  const edges = payload.flows.reduce((sum, flow) => sum + flow.hops.length, 0);
  const budget = graphBudget(nodes, edges);
  return budget.exceeded
    ? { ...payload, flows: [], budget, detailsDeferred: true, reason: GRAPH_BUDGET_REASON }
    : { ...payload, budget };
}
